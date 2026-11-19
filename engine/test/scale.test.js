import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ReferenceModel } from '../src/reference.js';
import { generateDataset } from '../src/dataset.js';
import { referenceTermStats, benchmarkDataset } from '../src/scale.js';
import { temporary } from './fixtures.mjs';

test('contagens separam ocorrências, união distinta e amostras sobrepostas', () => {
  const model = ReferenceModel.fromSamples({ A: [[1, 2], [2, 3]], B: [[2, 4], [4, 5]] });
  const records = [
    { algorithm: 'A', bytes: 24, sample_index: 0 },
    { algorithm: 'A', bytes: 16, sample_index: 1 },
    { algorithm: 'B', bytes: 16, sample_index: 0 },
    { algorithm: 'B', bytes: 16, sample_index: 1 }
  ];
  const result = referenceTermStats(model, records);
  assert.equal(result.files, 4);
  assert.equal(result.occurrences, 9);
  assert.equal(result.distinct, 5);
  assert.equal(result.per_algorithm.A.distinct, 3);
  assert.equal(result.per_algorithm.B.distinct, 3);
  assert.deepEqual(result.per_algorithm.A.samples, [
    { sample_index: 0, files: 1, occurrences: 3, distinct: 2 },
    { sample_index: 1, files: 1, occurrences: 2, distinct: 2 }
  ]);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('contagens não duplicam termos em várias amostras da mesma cifra', () => {
  const model = ReferenceModel.fromSamples({ A: [[1], [1], [1]], B: [[1], [2]] });
  const records = [0, 1, 2].map(sample_index => ({ algorithm: 'A', bytes: 8, sample_index }));
  records.push({ algorithm: 'B', bytes: 8, sample_index: 0 }, { algorithm: 'B', bytes: 8, sample_index: 1 });
  const result = referenceTermStats(model, records);
  assert.equal(result.distinct, 2);
  assert.equal(result.per_algorithm.A.distinct, 1);
  assert.equal(result.per_algorithm.B.distinct, 2);
  assert.equal(result.occurrences, 5);
});

test('registros malformados não geram contagens plausíveis incorretas', () => {
  const model = ReferenceModel.fromSamples({ A: [[1], [2]] });
  assert.throws(() => referenceTermStats(model, [{ algorithm: 'B', bytes: 8, sample_index: 0 }]), /algoritmo/);
  assert.throws(() => referenceTermStats(model, [{ algorithm: 'A', bytes: 7, sample_index: 0 }]), /tamanho/);
  assert.throws(() => referenceTermStats(model, [{ algorithm: 'A', bytes: 8, sample_index: 2 }]), /amostra/);
});

test('benchmark limitado registra casos, estimativa e ambiente sem alegar eficácia', t => {
  const root = temporary(t), dataset = path.join(root, 'dataset'), output = path.join(root, 'benchmark');
  generateDataset(dataset, {
    seed: 777, textBytes: 64, referenceKeys: 2, referencePerKey: 1,
    samples: 2, testsPerAlgorithm: 2
  });
  const progress = [];
  const result = benchmarkDataset(dataset, output, { onProgress: item => progress.push(item) });
  assert.equal(result.configuration.measured_files, 3);
  assert.equal(result.configuration.full_test_files, 6);
  assert.equal(result.configuration.warmup_files, 0);
  assert.equal(result.configuration.structural_pipeline_measured, false);
  assert.equal(result.reference_stats.files, 6);
  assert.equal(result.reference_stats.occurrences, 48);
  assert.equal(result.reference_stats.distinct, 48);
  assert.equal(result.cases.length, 3);
  assert.equal(result.estimated_full_hamming_comparisons, 6 * 8 * 48);
  assert.ok(result.setup_ms >= 0 && result.measured_predict_ms >= 0);
  assert.equal(result.estimated_full_predict_ms, result.measured_predict_ms * 2);
  assert.equal(result.estimated_full_total_ms, result.setup_ms + result.estimated_full_predict_ms);
  assert.equal(progress.length, 3);
  assert.equal(progress.at(-1).completed, 3);
  assert.ok(result.cases.every(row => row.case_ms >= 0 && row.result.decision_type === 3 && !Object.hasOwn(row, 'actual')));
  assert.equal(result.dataset.manifest_sha256.length, 64);
  assert.equal(result.execution.node, process.version);
  assert.match(result.warning, /não medida de eficácia/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'benchmark.json'), 'utf8')), result);
  assert.throws(() => benchmarkDataset(dataset, output), /existe/);
});

test('quantidade de benchmark é explícita, limitada e exige casos disponíveis', t => {
  const root = temporary(t), dataset = path.join(root, 'dataset');
  generateDataset(dataset, {
    seed: 778, textBytes: 64, referenceKeys: 2, referencePerKey: 1,
    samples: 2, testsPerAlgorithm: 2
  });
  for (const perAlgorithm of [0, -1, 1.5, 11, NaN, Infinity, '1'])
    assert.throws(() => benchmarkDataset(dataset, path.join(root, 'invalid'), { perAlgorithm }), /perAlgorithm/);
  assert.throws(() => benchmarkDataset(dataset, path.join(root, 'too-many'), { perAlgorithm: 3 }), /casos suficientes/);
  assert.ok(!fs.existsSync(path.join(root, 'too-many')));
  assert.throws(() => benchmarkDataset(dataset, path.join(root, 'invalid'), { onProgress: true }), /onProgress/);
  const all = benchmarkDataset(dataset, path.join(root, 'all'), { perAlgorithm: 2 });
  assert.equal(all.cases.length, 6);
  assert.equal(all.estimated_full_predict_ms, all.measured_predict_ms);
});
