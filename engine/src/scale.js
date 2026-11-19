import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { sha256 } from './crypto.js';
import { validateDataset } from './dataset.js';
import { ReferenceModel } from './reference.js';
import { Cryptogram } from './terms.js';
import { createOutput, localFile, readCiphertext, writeJSON } from './io.js';

export function referenceTermStats(model, referenceRecords) {
  const byLabel = new Map(model.labels.map(label => [label, { files: 0, occurrences: 0, distinct: 0, samples: [] }]));
  model.samples.forEach((sample, index) => {
    const group = byLabel.get(model.sampleLabels[index]);
    group.samples.push({ sample_index: group.samples.length, files: 0, occurrences: 0, distinct: sample.size });
  });
  for (const owners of model.memberships.values()) {
    if (owners.length === 1) byLabel.get(model.sampleLabels[owners[0]]).distinct++;
    else for (const label of new Set(owners.map(index => model.sampleLabels[index]))) byLabel.get(label).distinct++;
  }
  let files = 0,
    occurrences = 0;
  for (const record of referenceRecords) {
    const group = byLabel.get(record.algorithm);
    if (!group) throw new Error('Registro de referência contém algoritmo ausente do modelo');
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 8 || record.bytes % 8)
      throw new Error('Registro de referência possui tamanho inválido');
    const sample = group.samples[record.sample_index];
    if (!sample || !Number.isSafeInteger(record.sample_index) || record.sample_index < 0)
      throw new Error('Registro de referência possui amostra inválida');
    files++;
    occurrences += record.bytes / 8;
    group.files++;
    group.occurrences += record.bytes / 8;
    sample.files++;
    sample.occurrences += record.bytes / 8;
  }
  if (!Number.isSafeInteger(occurrences)) throw new Error('Contagem excede a precisão inteira');
  return { files, occurrences, distinct: model.terms.length, per_algorithm: Object.fromEntries(byLabel) };
}

export function benchmarkDataset(datasetDir, output, { perAlgorithm = 1, onProgress } = {}) {
  if (!Number.isSafeInteger(perAlgorithm) || perAlgorithm < 1 || perAlgorithm > 10)
    throw new Error('perAlgorithm deve ser inteiro entre 1 e 10');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress deve ser função');
  if (typeof output !== 'string' || !output) throw new TypeError('Saída deve ser um diretório');
  if (fs.existsSync(output)) throw new Error('Diretório já existe; use outro nome: ' + output);
  const started = performance.now();
  const manifest = validateDataset(datasetDir);
  const model = ReferenceModel.load(path.join(datasetDir, 'reference.json'));
  const referenceRecords = manifest.records.filter(record => record.split === 'reference');
  const fullTests = manifest.records.filter(record => record.split === 'test');
  const reference_stats = referenceTermStats(model, referenceRecords);
  const selected = [],
    counts = new Map(manifest.algorithms.map(label => [label, 0]));
  for (const record of fullTests) {
    if (counts.get(record.algorithm) < perAlgorithm) {
      selected.push(record);
      counts.set(record.algorithm, counts.get(record.algorithm) + 1);
    }
  }
  if ([...counts.values()].some(count => count !== perAlgorithm))
    throw new Error('Conjunto não possui casos suficientes por algoritmo para este benchmark');
  const estimated_full_hamming_comparisons =
    fullTests.reduce((n, record) => n + record.bytes / 8, 0) * model.terms.length;
  if (!Number.isSafeInteger(estimated_full_hamming_comparisons)) throw new Error('Estimativa excede precisão inteira');
  const setup_ms = performance.now() - started;
  const cases = [];
  let measured_predict_ms = 0,
    measuredComparisons = 0;
  for (const record of selected) {
    const unknown = Cryptogram.fromBytes(
      'benchmark-' + cases.length,
      readCiphertext(localFile(datasetDir, record.path)),
    );
    const before = performance.now();
    const result = model.predict(unknown, 3, null, 0.1, 'chapter3');
    const case_ms = performance.now() - before;
    measured_predict_ms += case_ms;
    measuredComparisons += unknown.terms.length * model.terms.length;
    cases.push({ id: record.id, case_ms, result });
    onProgress?.({ completed: cases.length, total: selected.length, case_ms });
  }
  const estimated_full_predict_ms = (measured_predict_ms * estimated_full_hamming_comparisons) / measuredComparisons;
  const result = {
    schema: 1,
    kind: 'limited_cost_benchmark',
    version: '0.6.0',
    dataset: {
      manifest_sha256: sha256(fs.readFileSync(path.join(datasetDir, 'manifest.json'))),
      source_sha256: manifest.corpus.raw_sha256,
      text_bytes: manifest.config.textBytes,
      seed: manifest.config.seed,
    },
    configuration: {
      candidates: manifest.algorithms,
      per_algorithm: perAlgorithm,
      measured_files: selected.length,
      full_test_files: fullTests.length,
      decision_type: 3,
      profile: 'chapter3',
      alpha: 0.1,
      warmup_files: 0,
      structural_pipeline_measured: false,
    },
    reference_stats,
    cases,
    setup_ms,
    measured_predict_ms,
    estimated_full_hamming_comparisons,
    estimated_full_predict_ms,
    estimated_full_total_ms: setup_ms + estimated_full_predict_ms,
    execution: {
      node: process.version,
      openssl: process.versions.openssl,
      platform: process.platform,
      architecture: process.arch,
      max_rss_bytes: process.resourceUsage().maxRSS * 1024,
    },
    warning:
      'Estimativa de custo do controle preparado, não medida de eficácia. Extrapola os casos escolhidos sem warm-up; não mede investigação/coloração e não garante tempo total da avaliação completa. Não demonstra fidelidade por duração.',
  };
  createOutput(output);
  writeJSON(path.join(output, 'benchmark.json'), result);
  return result;
}
