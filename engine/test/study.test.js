import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { descriptive, summarizeStudy, runStudy } from '../src/study.js';
import { generateDataset } from '../src/dataset.js';
import { evaluateDataset } from '../src/evaluation.js';
import { temporary } from './fixtures.mjs';

const protocol = {
  seed: 2026, algorithms: ['Blowfish', 'RC2', 'CAST5'], textBytes: 64,
  referenceKeys: 2, referencePerKey: 1, samples: 2, testsPerAlgorithm: 2, testStartByte: 128
};
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function setup(t, { baseline = true } = {}) {
  const root = temporary(t), protocolFile = path.join(root, 'protocol.json'), planFile = path.join(root, 'plan.json');
  write(protocolFile, protocol);
  const plan = { schema: 1, kind: 'repeated_keys_validation', protocol: 'protocol.json', seeds: [2026, 2027, 2028], concurrency: 2 };
  if (baseline) {
    const data = path.join(root, 'baseline-data'), evaluation = path.join(root, 'baseline-evaluation');
    generateDataset(data, protocol); evaluateDataset(data, evaluation);
    plan.baseline = { seed: 2026, dataset: 'baseline-data', evaluation: 'baseline-evaluation' };
  }
  write(planFile, plan);
  return { root, planFile, plan, output: path.join(root, 'study') };
}

test('estatística é descritiva, desvio amostral e N pequeno ficam explícitos', () => {
  assert.deepEqual(descriptive([]), { n: 0, mean: null, sample_standard_deviation: null, minimum: null, maximum: null });
  assert.equal(descriptive([0.3]).sample_standard_deviation, null);
  const result = descriptive([0.2, 0.4]);
  assert.ok(Math.abs(result.mean - 0.3) < 1e-15);
  assert.ok(Math.abs(result.sample_standard_deviation - Math.sqrt(0.02)) < 1e-15);
  assert.throws(() => descriptive([NaN]));
});

test('estudo congela plano, reutiliza exploratória e executa duas novas sementes em workers', async t => {
  const { root, planFile, output } = setup(t), progress = [];
  const result = await runStudy(planFile, output, { onProgress: event => progress.push(event) });
  assert.equal(result.cells.length, 3);
  assert.deepEqual(result.cells.map(c => c.seed), [2026, 2027, 2028]);
  assert.equal(result.cells[0].role, 'exploratory_reused');
  assert.ok(result.cells.slice(1).every(c => c.role === 'prospective'));
  assert.equal(result.summary.prospective_repetitions.prepared_accuracy.n, 2);
  assert.equal(result.summary.prepared_pooled_descriptive.total, 18);
  assert.equal(result.summary.structural_pooled_descriptive.coverage, 0);
  const frozen = JSON.parse(fs.readFileSync(path.join(output, 'study.plan.json')));
  assert.deepEqual(frozen.original_plan.seeds, [2026, 2027, 2028]);
  assert.equal(frozen.reused_exploratory_seed, 2026);
  assert.equal(frozen.source_hashes['src/study.js'].length, 64);
  assert.ok(result.cells.slice(1).every(c => fs.existsSync(path.join(output, c.evaluation_path, 'results.json'))));
  assert.ok(progress.some(event => event.seed === 2028 && event.status === 'complete'));
  const manifests = result.cells.map(c => JSON.parse(fs.readFileSync(path.join(output, c.dataset_path, 'manifest.json'))));
  const texts = m => m.records.filter(r => r.split === 'test').map(r => r.plaintext_sha256);
  assert.deepEqual(texts(manifests[0]), texts(manifests[1]));
  assert.deepEqual(texts(manifests[1]), texts(manifests[2]));
  assert.notDeepEqual(manifests[1].keys, manifests[2].keys);
  assert.notDeepEqual(manifests[1].records.map(r => r.iv_hex), manifests[2].records.map(r => r.iv_hex));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'results.json'))), result);
  assert.match(fs.readFileSync(path.join(output, 'report.md'), 'utf8'), /não são mensagens independentes/);
  assert.match(result.resource_measurement, /compartilham/);
  await assert.rejects(() => runStudy(planFile, output), /existe/);
  assert.equal(fs.existsSync(path.join(root, 'baseline-evaluation', 'results.json')), true);
});

test('plano sem baseline executa todas as sementes e não inventa observação exploratória', async t => {
  const { planFile, plan, output } = setup(t, { baseline: false });
  plan.seeds = [711, 712]; write(planFile, plan);
  const result = await runStudy(planFile, output, { concurrency: 1 });
  assert.equal(result.cells.length, 2);
  assert.ok(result.cells.every(c => c.role === 'prospective'));
  assert.equal(result.summary.prospective_repetitions.prepared_accuracy.n, 2);
});

test('plano inválido, custo alto e baseline adulterada não iniciam estudo', async t => {
  const { root, planFile, plan, output } = setup(t);
  await assert.rejects(() => runStudy(planFile, output, { concurrency: 0 }), /Concorrência/);
  await assert.rejects(() => runStudy(planFile, output, { concurrency: 5 }), /Concorrência/);
  await assert.rejects(() => runStudy(planFile, output, { onProgress: true }), /onProgress/);
  write(planFile, { ...plan, seeds: [2026, 2026] });
  await assert.rejects(() => runStudy(planFile, output), /sementes/);
  write(planFile, plan);
  const oldProtocol = JSON.parse(fs.readFileSync(path.join(root, 'protocol.json')));
  write(path.join(root, 'protocol.json'), { ...oldProtocol, textBytes: 8192, referenceKeys: 10, referencePerKey: 33, testsPerAlgorithm: 100 });
  await assert.rejects(() => runStudy(planFile, output), /excede/);
  write(path.join(root, 'protocol.json'), oldProtocol);
  const resultsFile = path.join(root, 'baseline-evaluation', 'results.json');
  const result = JSON.parse(fs.readFileSync(resultsFile)); result.dataset.manifest_sha256 = '00'.repeat(32); write(resultsFile, result);
  await assert.rejects(() => runStudy(planFile, output), /manifesto/);
  assert.ok(!fs.existsSync(output));
});

test('agregação rejeita semente, decisão e matriz incompatíveis', async t => {
  const { planFile, output } = setup(t), result = await runStudy(planFile, output);
  const clone = () => structuredClone(result.cells);
  const seed = clone(); seed[1].seed = seed[0].seed;
  assert.throws(() => summarizeStudy(seed), /Sementes/);
  const decision = clone(); decision[1].result.configuration.profile = 'chapter5-experiment2';
  assert.throws(() => summarizeStudy(decision), /incompatíveis/);
  const matrix = clone(); matrix[1].result.prepared.confusion_matrix.Blowfish.RC2 += 1;
  assert.throws(() => summarizeStudy(matrix), /Matriz/);
  const sourceSeed = clone(); sourceSeed[1].result.dataset.seed = 2;
  assert.throws(() => summarizeStudy(sourceSeed), /Semente/);
});
