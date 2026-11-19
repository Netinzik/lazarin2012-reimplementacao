import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { generateDataset, validateDataset } from './dataset.js';
import { evaluateDataset, guardCost, summarize } from './evaluation.js';
import { sha256 } from './crypto.js';
import { createOutput, readJSON, writeJSON } from './io.js';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const WARNING =
  'Repetições criptográficas dos mesmos textos claros: não são mensagens independentes. Agregação descritiva, sem teste de significância, garantia de generalização ou réplica histórica exata.';

export function descriptive(values) {
  if (!Array.isArray(values) || values.some(v => typeof v !== 'number' || !Number.isFinite(v)))
    throw new Error('Valores descritivos devem ser números finitos');
  if (!values.length) return { n: 0, mean: null, sample_standard_deviation: null, minimum: null, maximum: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    n: values.length,
    mean,
    sample_standard_deviation:
      values.length > 1
        ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))
        : null,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
}

function pooled(cells, key, labels) {
  const columns = [...labels, 'SEM_CLASSE'];
  const matrix = Object.fromEntries(labels.map(a => [a, Object.fromEntries(columns.map(b => [b, 0]))]));
  let total = 0,
    correct = 0,
    classified = 0,
    abstained = 0;
  for (const cell of cells) {
    const summary = cell.result[key];
    for (const value of [summary.total, summary.correct, summary.classified, summary.abstained])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Contagem de avaliação inválida');
    if (summary.classified + summary.abstained !== summary.total || summary.correct > summary.classified)
      throw new Error('Denominadores de avaliação inconsistentes');
    let matrixTotal = 0,
      matrixCorrect = 0,
      matrixAbstained = 0;
    for (const a of labels)
      for (const b of columns) {
        const value = summary.confusion_matrix?.[a]?.[b];
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Matriz de confusão inválida');
        matrix[a][b] += value;
        matrixTotal += value;
        if (a === b) matrixCorrect += value;
        if (b === 'SEM_CLASSE') matrixAbstained += value;
      }
    if (matrixTotal !== summary.total || matrixCorrect !== summary.correct || matrixAbstained !== summary.abstained)
      throw new Error('Matriz diverge das contagens da avaliação');
    total += summary.total;
    correct += summary.correct;
    classified += summary.classified;
    abstained += summary.abstained;
  }
  return {
    total,
    correct,
    classified,
    abstained,
    accuracy: total ? correct / total : null,
    coverage: total ? classified / total : null,
    accuracy_when_classified: classified ? correct / classified : null,
    confusion_matrix: matrix,
    warning: 'Totais agrupados apenas descritivos; as mensagens claras se repetem entre sementes.',
  };
}

export function summarizeStudy(cells) {
  if (!Array.isArray(cells) || cells.length < 2) throw new Error('Estudo exige ao menos duas sementes');
  if (
    new Set(cells.map(c => c.seed)).size !== cells.length ||
    cells.some(c => !Number.isSafeInteger(c.seed) || c.seed < 0)
  )
    throw new Error('Sementes devem ser distintas e não negativas');
  const labels = cells[0].result.configuration.candidates;
  for (const cell of cells) {
    const c = cell.result.configuration;
    if (
      !isDeepStrictEqual(c.candidates, labels) ||
      c.decision_type !== 3 ||
      c.profile !== 'chapter3' ||
      c.alpha !== 0.1
    )
      throw new Error('Avaliações usam candidatos ou decisões incompatíveis');
    if (cell.result.dataset.seed !== cell.seed) throw new Error('Semente do resultado diverge da célula');
  }
  const stats = selected => ({
    prepared_accuracy: descriptive(selected.map(c => c.result.prepared.accuracy)),
    prepared_coverage: descriptive(selected.map(c => c.result.prepared.coverage)),
    structural_accuracy: descriptive(selected.map(c => c.result.structural.accuracy)),
    structural_coverage: descriptive(selected.map(c => c.result.structural.coverage)),
  });
  return {
    seeds: cells.map(c => c.seed),
    all_repetitions: stats(cells),
    prospective_repetitions: stats(cells.filter(c => c.role === 'prospective')),
    prepared_pooled_descriptive: pooled(cells, 'prepared', labels),
    structural_pooled_descriptive: pooled(cells, 'structural', labels),
    warning: WARNING,
  };
}

function planInput(planFile, concurrency) {
  const plan = readJSON(planFile),
    base = path.dirname(path.resolve(planFile));
  if (plan.schema !== 1 || plan.kind !== 'repeated_keys_validation') throw new Error('Plano de repetição inválido');
  if (
    !Array.isArray(plan.seeds) ||
    plan.seeds.length < 2 ||
    new Set(plan.seeds).size !== plan.seeds.length ||
    plan.seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0)
  )
    throw new Error('Plano exige sementes distintas e não negativas');
  const workers = concurrency ?? plan.concurrency ?? 4;
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 4)
    throw new Error('Concorrência deve ser inteiro de 1 a 4');
  if (typeof plan.protocol !== 'string' || !plan.protocol) throw new Error('Plano exige protocolo');
  const protocolFile = path.resolve(base, plan.protocol),
    protocol = readJSON(protocolFile);
  if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) throw new Error('Protocolo inválido');
  if (
    plan.baseline &&
    (!plan.seeds.includes(plan.baseline.seed) ||
      typeof plan.baseline.dataset !== 'string' ||
      typeof plan.baseline.evaluation !== 'string')
  )
    throw new Error('Baseline incompatível com o plano');
  return { plan, protocolFile, protocol, base, workers };
}

function readRows(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function checkedBaseline(input, output) {
  if (!input.plan.baseline) return null;
  const baseline = input.plan.baseline;
  const datasetPath = path.resolve(input.base, baseline.dataset),
    evaluationPath = path.resolve(input.base, baseline.evaluation);
  const manifest = validateDataset(datasetPath),
    result = readJSON(path.join(evaluationPath, 'results.json'));
  if (!isDeepStrictEqual(manifest.config, { ...input.protocol, seed: baseline.seed }))
    throw new Error('Configuração da baseline diverge do protocolo');
  if (
    result.dataset.manifest_sha256 !== sha256(fs.readFileSync(path.join(datasetPath, 'manifest.json'))) ||
    result.dataset.source_sha256 !== manifest.corpus.raw_sha256 ||
    result.dataset.seed !== baseline.seed
  )
    throw new Error('Baseline não corresponde ao manifesto validado');
  const expected = manifest.records.filter(r => r.split === 'test');
  for (const file of ['prepared.jsonl', 'structural.jsonl']) {
    const rows = readRows(path.join(evaluationPath, file));
    if (
      rows.length !== expected.length ||
      rows.some((row, i) => row.id !== expected[i].id || row.actual !== expected[i].algorithm)
    )
      throw new Error('Gabarito ou casos da baseline divergem do conjunto');
    const key = file.startsWith('prepared') ? 'prepared' : 'structural';
    if (!isDeepStrictEqual(result[key], summarize(rows, manifest.algorithms)))
      throw new Error('Resumo da baseline diverge das previsões registradas');
  }
  const cell = {
    seed: baseline.seed,
    role: 'exploratory_reused',
    dataset_path: path.relative(output, datasetPath),
    evaluation_path: path.relative(output, evaluationPath),
    result,
  };
  const decision = result.configuration;
  if (
    !isDeepStrictEqual(decision.candidates, manifest.algorithms) ||
    decision.decision_type !== 3 ||
    decision.profile !== 'chapter3' ||
    decision.alpha !== 0.1
  )
    throw new Error('Decisão da baseline incompatível');
  pooled([cell], 'prepared', manifest.algorithms);
  pooled([cell], 'structural', manifest.algorithms);
  return cell;
}

function reportText(result) {
  const percent = n => (n === null ? 'indefinida' : (100 * n).toFixed(2) + '%');
  const lines = [
    '# Repetições por sementes, chaves e IVs',
    '',
    'Plano congelado antes das novas execuções. A semente exploratória reutilizada é identificada abaixo; seu resultado já era conhecido.',
    '',
    '| Semente | Papel | Referência distinta | Acertos preparados | Acurácia preparada | Cobertura estrutural |',
    '|---|---|---:|---:|---:|---:|',
  ];
  for (const cell of result.cells)
    lines.push(
      `| ${cell.seed} | ${cell.role} | ${cell.result.reference_terms.distinct} | ${cell.result.prepared.correct}/${cell.result.prepared.total} | ${percent(cell.result.prepared.accuracy)} | ${percent(cell.result.structural.coverage)} |`,
    );
  lines.push(
    '',
    '## Resumo descritivo por execução',
    '',
    `Média da acurácia preparada nas ${result.summary.all_repetitions.prepared_accuracy.n} repetições: ${percent(result.summary.all_repetitions.prepared_accuracy.mean)}.`,
    `Desvio-padrão amostral entre repetições: ${percent(result.summary.all_repetitions.prepared_accuracy.sample_standard_deviation)} (pontos percentuais na escala percentual).`,
    `Novas repetições prospectivas: ${result.summary.prospective_repetitions.prepared_accuracy.n}; média ${percent(result.summary.prospective_repetitions.prepared_accuracy.mean)}.`,
    '',
    '## Limites',
    '',
    WARNING,
    'Os mesmos textos claros são mantidos entre sementes; variam chaves e IVs de laboratório. Uma tabela com 1.500 classificações não equivale a 1.500 mensagens claras independentes.',
    'A referência preparada é um controle por partição de chaves e não substitui agrupamento e coloração automáticos.',
    'Não foi escolhido o melhor resultado como conclusão. Não há teste binomial ingênuo sobre todos os arquivos, nem inferência de superioridade sobre a dissertação.',
    'Tempos das novas células refletem execução concorrente e não são diretamente comparáveis ao benchmark isolado.',
    'As threads compartilham o processo Node: o RSS informado nas células é pico do processo compartilhado, não pico individual da semente.',
    '',
    'Plano e hashes iniciais: study.plan.json. Evidências por semente: células listadas em results.json.',
    '',
  );
  return lines.join('\n');
}

export async function runStudy(planFile, output, { allowExpensive = false, concurrency, onProgress } = {}) {
  if (typeof output !== 'string' || !output) throw new Error('Saída deve ser diretório novo');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new Error('onProgress deve ser função');
  if (fs.existsSync(output)) throw new Error('Diretório já existe; use outro nome');
  const input = planInput(planFile, concurrency),
    started = performance.now();
  const nominalReference =
    (input.protocol.referenceKeys *
      input.protocol.referencePerKey *
      input.protocol.algorithms.length *
      input.protocol.textBytes) /
    8;
  const nominalTests =
    (input.protocol.testsPerAlgorithm * input.protocol.algorithms.length * input.protocol.textBytes) / 8;
  guardCost(nominalReference * nominalTests, { allowExpensive });
  const baseline = checkedBaseline(input, output);
  const sourceFiles = fs
    .readdirSync(path.join(PROJECT, 'src'))
    .filter(f => f.endsWith('.js'))
    .sort();
  const sourceHashes = Object.fromEntries(
    sourceFiles.map(f => ['src/' + f, sha256(fs.readFileSync(path.join(PROJECT, 'src', f)))]),
  );
  createOutput(output);
  writeJSON(path.join(output, 'study.plan.json'), {
    schema: 1,
    kind: input.plan.kind,
    frozen_at: new Date().toISOString(),
    original_plan: input.plan,
    original_plan_sha256: sha256(fs.readFileSync(planFile)),
    protocol: input.protocol,
    protocol_sha256: sha256(fs.readFileSync(input.protocolFile)),
    concurrency: input.workers,
    source_hashes: sourceHashes,
    environment: {
      node: process.version,
      openssl: process.versions.openssl,
      platform: process.platform,
      architecture: process.arch,
    },
    reused_exploratory_seed: baseline?.seed ?? null,
    warning: WARNING,
  });
  const cells = baseline ? [baseline] : [],
    pending = input.plan.seeds.filter(seed => seed !== baseline?.seed),
    active = new Set();
  let next = 0;
  async function consume() {
    while (next < pending.length) {
      const seed = pending[next++],
        cellPath = path.join(output, 'seed-' + seed);
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./study.js', import.meta.url), {
          execArgv: [],
          workerData: { kind: 'lazarin_study_cell', seed, protocol: input.protocol, output: cellPath },
        });
        active.add(worker);
        let completed = false,
          finishedResult;
        worker.on('message', message => {
          try {
            if (message.kind === 'progress') onProgress?.({ seed, ...message.progress });
            else if (message.kind === 'complete') {
              completed = true;
              finishedResult = message.result;
            } else if (message.kind === 'failed') reject(new Error(`Semente ${seed}: ${message.message}`));
          } catch (error) {
            reject(error);
          }
        });
        worker.on('error', reject);
        worker.on('exit', code => {
          active.delete(worker);
          if (!completed || code !== 0)
            reject(new Error(`Worker da semente ${seed} terminou sem resultado (código ${code})`));
          else resolve(finishedResult);
        });
      });
      const cell = {
        seed,
        role: 'prospective',
        dataset_path: path.relative(output, path.join(cellPath, 'dataset')),
        evaluation_path: path.relative(output, path.join(cellPath, 'evaluation')),
        result,
      };
      cells.push(cell);
      writeJSON(path.join(output, 'seed-' + seed + '.completed.json'), cell);
      onProgress?.({ seed, status: 'complete', completed: result.prepared.total, total: result.prepared.total });
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(input.workers, pending.length) }, consume));
  } catch (error) {
    await Promise.all([...active].map(worker => worker.terminate()));
    throw error;
  }
  cells.sort((a, b) => input.plan.seeds.indexOf(a.seed) - input.plan.seeds.indexOf(b.seed));
  const result = {
    schema: 1,
    kind: 'repeated_keys_validation_results',
    artifact_version: '0.6.0',
    cells,
    summary: summarizeStudy(cells),
    wall_elapsed_ms: performance.now() - started,
    concurrency: input.workers,
    resource_measurement:
      'Workers compartilham o processo Node: max_rss_bytes nas células é pico do processo compartilhado, não pico individual de cada semente.',
    warning: WARNING,
  };
  writeJSON(path.join(output, 'results.json'), result);
  fs.writeFileSync(path.join(output, 'report.md'), reportText(result), { flag: 'wx' });
  return result;
}

if (!isMainThread && workerData?.kind === 'lazarin_study_cell') {
  try {
    createOutput(workerData.output);
    const dataset = path.join(workerData.output, 'dataset'),
      evaluation = path.join(workerData.output, 'evaluation');
    generateDataset(dataset, { ...workerData.protocol, seed: workerData.seed });
    const result = evaluateDataset(dataset, evaluation, {
      allowExpensive: true,
      decisionType: 3,
      profile: 'chapter3',
      alpha: 0.1,
      onProgress: progress => {
        if (progress.completed % 10 === 0 || progress.completed === progress.total)
          parentPort.postMessage({ kind: 'progress', progress });
      },
    });
    parentPort.postMessage({ kind: 'complete', result });
  } catch (error) {
    parentPort.postMessage({ kind: 'failed', message: error.message });
  }
  parentPort.close();
}
