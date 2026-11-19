#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from '../src/crypto.js';
import { validateDataset } from '../src/dataset.js';
import { summarize } from '../src/evaluation.js';
import { summarizeStudy } from '../src/study.js';
import { localFile, readJSON, writeJSON } from '../src/io.js';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const MAX_TERMS_TO_COUNT_PER_CELL = 5_000_000;
const CORE = ['metrics', 'reference', 'terms', 'classification', 'structural', 'features', 'pipeline', 'crypto', 'io', 'dataset']
  .map(name => 'src/' + name + '.js');
const equal = (actual, expected, message) => {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message);
};
function rows(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function sourceHashes(frozen) {
  const names = fs.readdirSync(path.join(PROJECT, 'src')).filter(name => name.endsWith('.js')).sort();
  const expected = names.map(name => 'src/' + name);
  equal(Object.keys(frozen.source_hashes ?? {}).sort(), [...expected].sort(), 'Lista congelada de fontes não corresponde ao projeto');
  for (const file of expected)
    if (sha256(fs.readFileSync(path.join(PROJECT, file))) !== frozen.source_hashes[file])
      throw new Error('Hash congelado do código diverge: ' + file);
  return expected.length;
}

function originalInput(studyDir, frozen, which) {
  const protocol = which === 'protocol';
  const expectedHash = protocol ? frozen.protocol_sha256 : frozen.original_plan_sha256;
  const expectedObject = protocol ? frozen.protocol : frozen.original_plan;
  const archive = path.join(studyDir, protocol ? 'study.protocol.json' : 'study.input.json');
  const protocolDir = path.join(PROJECT, 'protocols');
  const candidates = [archive, ...fs.readdirSync(protocolDir).filter(name => name.endsWith('.json'))
    .map(name => path.join(protocolDir, name))];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    if (sha256(bytes) !== expectedHash) continue;
    equal(JSON.parse(bytes), expectedObject, 'Objeto congelado diverge dos bytes do ' + which);
    return path.relative(PROJECT, file);
  }
  throw new Error('Não foi encontrado ' + which + ' original com o hash congelado; preserve study.input.json e study.protocol.json ou os inputs em protocols/');
}

function disjointWindows(records) {
  const intervals = split => [...new Map(records.filter(r => r.split === split).map(record => {
    if (!Number.isSafeInteger(record.plaintext_offset) || record.plaintext_offset < 0 ||
      !Number.isSafeInteger(record.bytes) || record.bytes < 8 || record.bytes % 8 ||
      !Number.isSafeInteger(record.plaintext_offset + record.bytes)) throw new Error('Intervalo claro inválido');
    return [record.plaintext_offset + ':' + record.bytes,
    { start: record.plaintext_offset, end: record.plaintext_offset + record.bytes }];
  })).values()].sort((a, b) => a.start - b.start);
  const reference = intervals('reference'), test = intervals('test');
  for (const list of [reference, test]) for (let i = 1; i < list.length; i++)
    if (list[i].start < list[i - 1].end) throw new Error('Recortes distintos da mesma divisão se sobrepõem');
  let i = 0, j = 0;
  while (i < reference.length && j < test.length) {
    const a = reference[i], b = test[j];
    if (a.start < b.end && b.start < a.end) throw new Error('Há sobreposição de texto claro entre referência e teste');
    if (a.end <= b.start) i++; else j++;
  }
  return { reference_messages: reference.length, test_messages: test.length };
}

function countTerms(datasetDir, manifest) {
  const references = manifest.records.filter(record => record.split === 'reference');
  const occurrences = references.reduce((sum, record) => sum + record.bytes / 8, 0);
  if (!Number.isSafeInteger(occurrences)) throw new Error('Contagem nominal inválida');
  if (occurrences > MAX_TERMS_TO_COUNT_PER_CELL) return {
    independently_counted: false, occurrences,
    reason: 'Referência excede limite explícito de cinco milhões de termos por célula'
  };
  const all = new Set();
  const perAlgorithm = new Map(manifest.algorithms.map(label => [label, new Set()]));
  for (const record of references) {
    const bytes = fs.readFileSync(localFile(datasetDir, record.path));
    for (let offset = 0; offset < bytes.length; offset += 8) {
      const term = bytes.readBigUInt64BE(offset);
      all.add(term); perAlgorithm.get(record.algorithm).add(term);
    }
  }
  return {
    independently_counted: true, occurrences, distinct: all.size,
    repeated_occurrences: occurrences - all.size, all_terms_unique: occurrences === all.size,
    per_algorithm_distinct: Object.fromEntries([...perAlgorithm].map(([label, terms]) => [label, terms.size]))
  };
}

function checkBaselineCore(evaluationPath, frozen) {
  const evidenceFile = path.join(evaluationPath, 'verification.json');
  if (!fs.existsSync(evidenceFile)) throw new Error('Baseline reutilizada sem evidência dos hashes do núcleo');
  const evidence = readJSON(evidenceFile);
  for (const file of CORE)
    if (typeof evidence.source_files?.[file] !== 'string' || evidence.source_files[file] !== frozen.source_hashes[file])
      throw new Error('Núcleo da baseline diverge do código congelado: ' + file);
  return CORE.length;
}

export function verifyStudy(studyDir, { checkCiphertexts = true } = {}) {
  if (typeof checkCiphertexts !== 'boolean') throw new TypeError('checkCiphertexts deve ser booleano');
  const directory = path.resolve(studyDir), result = readJSON(path.join(directory, 'results.json'));
  const frozen = readJSON(path.join(directory, 'study.plan.json'));
  if (result.kind !== 'repeated_keys_validation_results' || frozen.kind !== 'repeated_keys_validation')
    throw new Error('Resultado ou plano não pertence a estudo de repetições');
  const sourceFilesVerified = sourceHashes(frozen);
  const originalPlanSource = originalInput(directory, frozen, 'plan');
  const protocolSource = originalInput(directory, frozen, 'protocol');
  equal(frozen.reused_exploratory_seed, frozen.original_plan.baseline?.seed ?? null,
    'Identificação exploratória diverge do plano original');
  equal(result.concurrency, frozen.concurrency, 'Concorrência registrada diverge do plano congelado');
  equal(result.cells.map(cell => cell.seed), frozen.original_plan.seeds, 'Sementes ou ordem divergem do plano congelado');
  equal(summarizeStudy(result.cells), result.summary, 'Resumo agregado diverge das células');
  const keys = new Set(), ivs = new Set(), cells = [];
  let baselineCoreFiles = 0, commonTests = null, verifiedFiles = 0;
  for (const cell of result.cells) {
    const datasetDir = path.resolve(directory, cell.dataset_path), evaluationDir = path.resolve(directory, cell.evaluation_path);
    const manifestFile = path.join(datasetDir, 'manifest.json');
    const manifest = checkCiphertexts ? validateDataset(datasetDir) : readJSON(manifestFile);
    equal(manifest.config, { ...frozen.protocol, seed: cell.seed }, 'Configuração da célula diverge do protocolo congelado');
    equal(manifest.algorithms, frozen.protocol.algorithms, 'Candidatos da célula divergem do protocolo');
    const reused = cell.seed === frozen.reused_exploratory_seed;
    if (cell.role !== (reused ? 'exploratory_reused' : 'prospective')) throw new Error('Papel da célula diverge do plano');
    if (reused) baselineCoreFiles = checkBaselineCore(evaluationDir, frozen);
    const evaluation = readJSON(path.join(evaluationDir, 'results.json'));
    equal(evaluation, cell.result, 'Avaliação salva diverge da célula agregada');
    const configuration = evaluation.configuration;
    equal(configuration.candidates, manifest.algorithms, 'Candidatos da avaliação divergem do conjunto');
    if (configuration.decision_type !== 3 || configuration.profile !== 'chapter3' || configuration.alpha !== 0.1 ||
      configuration.automatic_decision_type !== 3 || configuration.automatic_profile !== 'chapter3')
      throw new Error('Decisões da avaliação divergem do estudo');
    if (evaluation.dataset.seed !== cell.seed || evaluation.dataset.manifest_sha256 !== sha256(fs.readFileSync(manifestFile)) ||
      evaluation.dataset.source_sha256 !== manifest.corpus.raw_sha256 || evaluation.dataset.text_bytes !== manifest.config.textBytes)
      throw new Error('Identidade da avaliação diverge do conjunto validado');
    const expectedTests = manifest.records.filter(record => record.split === 'test');
    const referenceRecords = manifest.records.filter(record => record.split === 'reference');
    if (expectedTests.length !== manifest.config.testsPerAlgorithm * manifest.algorithms.length ||
      referenceRecords.length !== manifest.config.referenceKeys * manifest.config.referencePerKey * manifest.algorithms.length)
      throw new Error('Quantidade de arquivos diverge da configuração');
    const windows = disjointWindows(manifest.records);
    const tests = expectedTests.map(r => ({
      id: r.id, algorithm: r.algorithm, offset: r.plaintext_offset,
      bytes: r.bytes, plaintext_sha256: r.plaintext_sha256
    }));
    if (commonTests === null) commonTests = tests;
    else equal(tests, commonTests, 'Textos de teste, offsets ou casos mudaram entre sementes');
    const paired = manifest.algorithms.map(algorithm => expectedTests.filter(r => r.algorithm === algorithm)
      .map(r => [r.plaintext_offset, r.bytes, r.plaintext_sha256]));
    for (const texts of paired.slice(1)) equal(texts, paired[0], 'Textos de teste não são pareados entre cifras');
    for (const key of manifest.keys) {
      if (keys.has(key.hex)) throw new Error('Chave bruta repetida entre sementes ou divisões');
      keys.add(key.hex);
    }
    for (const record of manifest.records) {
      if (ivs.has(record.iv_hex)) throw new Error('IV repetido entre sementes ou arquivos');
      ivs.add(record.iv_hex);
      const bytes = fs.readFileSync(localFile(datasetDir, record.path));
      if (bytes.length !== record.bytes || sha256(bytes) !== record.ciphertext_sha256)
        throw new Error('Arquivo cifrado diverge de seu registro: ' + record.path);
      verifiedFiles++;
    }
    for (const kind of ['prepared', 'structural']) {
      const predictions = rows(path.join(evaluationDir, kind + '.jsonl'));
      if (predictions.length !== expectedTests.length || predictions.some((row, index) =>
        row.id !== expectedTests[index].id || row.path !== expectedTests[index].path || row.actual !== expectedTests[index].algorithm))
        throw new Error('Casos, ordem ou gabarito divergem nas previsões ' + kind);
      equal(summarize(predictions, manifest.algorithms), evaluation[kind], 'Resumo diverge das previsões ' + kind);
    }
    const counts = countTerms(datasetDir, manifest);
    if (evaluation.reference_terms.files !== referenceRecords.length || evaluation.reference_terms.occurrences !== counts.occurrences ||
      evaluation.dataset.reference_files !== referenceRecords.length) throw new Error('Contagem de referências diverge do manifesto');
    if (counts.independently_counted) {
      if (evaluation.reference_terms.distinct !== counts.distinct) throw new Error('Termos distintos do modelo divergem da contagem independente');
      for (const label of manifest.algorithms)
        if (evaluation.reference_terms.per_algorithm[label].distinct !== counts.per_algorithm_distinct[label])
          throw new Error('Termos distintos por cifra divergem da contagem independente');
      const expectedCost = expectedTests.reduce((sum, record) => sum + record.bytes / 8, 0) * counts.distinct;
      if (configuration.estimated_hamming_comparisons !== expectedCost) throw new Error('Estimativa de Hamming diverge da contagem independente');
      if (counts.all_terms_unique && (evaluation.structure.edge_count !== 0 || evaluation.structure.groups.length !== 0 ||
        evaluation.structure.ungrouped_count !== referenceRecords.length))
        throw new Error('Estrutura é incompatível com ausência de qualquer termo repetido');
    }
    cells.push({
      seed: cell.seed, role: cell.role, ciphertext_files: manifest.records.length,
      reference_files: referenceRecords.length, test_files: expectedTests.length, ...windows, reference_counts: counts
    });
  }
  sourceHashes(frozen);
  assert.ok(cells.length >= 2);
  return {
    schema: 1, kind: 'post_study_verification', verified_at: new Date().toISOString(),
    verified: true, source_hashes_verified: true, source_files_verified: sourceFilesVerified,
    original_plan_hash_verified: true, protocol_hash_verified: true, original_plan_source: originalPlanSource,
    protocol_source: protocolSource, reciphered: checkCiphertexts, ciphertext_files_verified: verifiedFiles,
    independent_term_count_limit_per_cell: MAX_TERMS_TO_COUNT_PER_CELL,
    same_test_plaintexts_all_seeds: true, reference_test_windows_disjoint: true,
    keys_distinct_across_all_cells: keys.size, ivs_distinct_across_all_cells: ivs.size,
    reused_exploratory_seed: frozen.reused_exploratory_seed,
    prospective_seeds: cells.filter(cell => cell.role === 'prospective').map(cell => cell.seed),
    baseline_core_files_matched: baselineCoreFiles, aggregation_recomputed: true, cells,
    warning: 'Conferência de integridade e consistência da execução controlada. Não prova ausência de defeitos, identidade histórica, independência dos textos repetidos ou generalização.'
  };
}

function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1];
    if (!['--study', '--out'].includes(key) || !value || value.startsWith('--') || options[key])
      throw new Error('Uso: node --openssl-legacy-provider validation/verify-study.mjs --study DIR --out NOVO.json');
    options[key] = value;
  }
  if (!options['--study'] || !options['--out']) throw new Error('Informe --study e --out');
  if (fs.existsSync(path.resolve(options['--out']))) throw new Error('Saída já existe; use outro nome');
  const result = verifyStudy(options['--study']);
  writeJSON(path.resolve(options['--out']), result);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write('Erro: ' + error.message + '\n'); process.exitCode = 1; }
}
