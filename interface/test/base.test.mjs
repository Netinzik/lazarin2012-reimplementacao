import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_CONFIG, buildConfig, baseSummary, testStartRange, prepareDataset } from '../base.mjs';
import { inspectDataset } from '../../engine/src/evaluation.js';

const tiny = {
  seed: 7,
  algorithms: ['Blowfish', 'RC2', 'CAST5'],
  textBytes: 32,
  referenceKeys: 2,
  referencePerKey: 1,
  samples: 2,
  testsPerAlgorithm: 1,
  testStartByte: 64,
};

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lazarin-base-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('base gigante: 1.500 arquivos de referência, 300 testes e 1.536.000 criptotermos', () => {
  const { config } = buildConfig({ seed: 1, testStartByte: 0 });
  const summary = baseSummary(config);
  assert.equal(summary.referenceFiles, 1500);
  assert.equal(summary.referencePerAlgorithm, 500);
  assert.equal(summary.testFiles, 300);
  assert.equal(summary.referenceTerms, 1_536_000);
  assert.deepEqual(config.algorithms, ['Blowfish', 'RC2', 'CAST5']);
  config.algorithms.pop();
  assert.equal(BASE_CONFIG.algorithms.length, 3);
});

test('trecho de teste pode começar em 523 posições alinhadas a 8.192 bytes', () => {
  const range = testStartRange();
  assert.equal(range.step, 8192);
  assert.equal(range.max, 4_276_224);
  assert.equal(range.positions, 523);
});

test('sem semente e sem início, ambos são sorteados dentro dos limites e registrados como sorteados', () => {
  const draws = Array.from({ length: 20 }, () => buildConfig());
  for (const { config, drawn, range } of draws) {
    assert.deepEqual(drawn, { seed: true, testStartByte: true });
    assert.ok(Number.isSafeInteger(config.seed) && config.seed >= 1);
    assert.equal(config.testStartByte % range.step, 0);
    assert.ok(config.testStartByte >= 0 && config.testStartByte <= range.max);
  }
  assert.ok(new Set(draws.map(d => d.config.seed)).size > 1);
});

test('semente e início informados são usados exatamente, permitindo repetir uma execução', () => {
  const { config, drawn } = buildConfig({ seed: 48213977, testStartByte: 2_457_600 });
  assert.equal(config.seed, 48213977);
  assert.equal(config.testStartByte, 2_457_600);
  assert.deepEqual(drawn, { seed: false, testStartByte: false });
  assert.deepEqual(buildConfig({ seed: 48213977, testStartByte: 2_457_600 }).config, config);
});

test('início desalinhado, negativo ou além do texto é recusado', () => {
  assert.throws(() => buildConfig({ seed: 1, testStartByte: 100 }), /múltiplo de 8192/);
  assert.throws(() => buildConfig({ seed: 1, testStartByte: -8192 }), /múltiplo/);
  assert.throws(() => buildConfig({ seed: 1, testStartByte: 4_276_224 + 8192 }), /múltiplo/);
  assert.throws(() => buildConfig({ seed: -1, testStartByte: 0 }), /semente/);
});

test('a base é gerada em worker, validada e inspecionada sem grupos inventados', async t => {
  const directory = path.join(temporary(t), 'base'),
    events = [];
  const result = await prepareDataset({ directory, config: tiny, onStage: e => events.push(e.stage) });
  assert.equal(result.manifest.records.length, 9);
  assert.equal(result.inspection.reference_files, 6);
  assert.equal(result.inspection.test_files, 3);
  assert.deepEqual(result.inspection, inspectDataset(directory));
  assert.deepEqual(events, ['generation-start', 'generation-complete', 'validation-start', 'validation-complete']);
});

test('mesma configuração gera bytes idênticos; outra semente gera bytes diferentes', async t => {
  const root = temporary(t);
  const a = await prepareDataset({ directory: path.join(root, 'a'), config: tiny });
  const b = await prepareDataset({ directory: path.join(root, 'b'), config: { ...tiny } });
  const c = await prepareDataset({ directory: path.join(root, 'c'), config: { ...tiny, seed: 8 } });
  const file = a.manifest.records[0].path;
  assert.deepEqual(fs.readFileSync(path.join(a.directory, file)), fs.readFileSync(path.join(b.directory, file)));
  assert.notDeepEqual(fs.readFileSync(path.join(a.directory, file)), fs.readFileSync(path.join(c.directory, file)));
});

test('pasta existente nunca é sobrescrita; cancelamento prévio não cria nada', async t => {
  const root = temporary(t);
  const existing = path.join(root, 'existe');
  fs.mkdirSync(existing);
  await assert.rejects(prepareDataset({ directory: existing, config: tiny }), /nenhuma base é sobrescrita/);
  const controller = new AbortController();
  controller.abort();
  const untouched = path.join(root, 'nao-criar');
  await assert.rejects(prepareDataset({ directory: untouched, config: tiny, signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(fs.existsSync(untouched), false);
});

test('cancelamento durante a geração interrompe e erros de contrato são explícitos', async t => {
  const root = temporary(t),
    controller = new AbortController();
  await assert.rejects(
    prepareDataset({
      directory: path.join(root, 'base'),
      config: tiny,
      signal: controller.signal,
      onStage: stage => {
        if (stage.stage === 'generation-start') controller.abort();
      },
    }),
    { name: 'AbortError' },
  );
  await assert.rejects(prepareDataset({ directory: '', config: tiny }), /pasta/);
  await assert.rejects(prepareDataset({ directory: path.join(root, 'x') }), /configuração/);
  await assert.rejects(prepareDataset({ directory: path.join(root, 'y'), config: tiny, onStage: 'texto' }), /onStage/);
  await assert.rejects(
    prepareDataset({ directory: path.join(root, 'z'), config: { ...tiny, textBytes: 12 } }),
    /múltiplo/,
  );
});
