import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateDataset } from '../src/dataset.js';
import { evaluateDataset, inspectDataset, summarize, guardCost } from '../src/evaluation.js';
import { temporary } from './fixtures.mjs';

test('métricas mantêm denominadores e abstenções explícitos', () => {
  const result = summarize(
    [
      { actual: 'A', prediction: 'A', status: 'ok' },
      { actual: 'A', prediction: 'B', status: 'ok' },
      { actual: 'B', prediction: null, status: 'undefined_index' },
    ],
    ['A', 'B'],
  );
  assert.equal(result.accuracy, 1 / 3);
  assert.equal(result.coverage, 2 / 3);
  assert.equal(result.accuracy_when_classified, 1 / 2);
  assert.deepEqual(result.abstention_reasons, { undefined_index: 1 });
  assert.equal(summarize([{ actual: 'A', prediction: null, status: 'x' }], ['A']).accuracy_when_classified, null);
});
test('custo alto exige opção explícita e limites inválidos são rejeitados', () => {
  assert.throws(() => guardCost(201_000_000), /excede/);
  assert.doesNotThrow(() => guardCost(201_000_000, { allowExpensive: true }));
  assert.throws(() => guardCost(1, { maxComparisons: NaN }));
});
test('avaliação real gera rastros, matriz e relato dos dois caminhos', t => {
  const root = temporary(t),
    data = path.join(root, 'data'),
    results = path.join(root, 'results');
  generateDataset(data, {
    seed: 811,
    textBytes: 64,
    referenceKeys: 2,
    referencePerKey: 1,
    samples: 2,
    testsPerAlgorithm: 2,
  });
  const result = evaluateDataset(data, results);
  assert.equal(result.prepared.total, 6);
  assert.equal(result.structural.total, 6);
  assert.equal(result.prepared.correct + result.prepared.errors + result.prepared.abstained, 6);
  assert.equal(result.structure.edge_count, 0);
  assert.equal(result.reference_terms.files, 6);
  assert.equal(result.reference_terms.occurrences, 48);
  assert.equal(result.reference_terms.distinct, 48);
  assert.ok(result.execution.phases_ms.prepared_prediction >= 0);
  assert.equal(result.structural.coverage, 0);
  assert.deepEqual(result.structural.abstention_reasons, { insufficient_reference_structure: 6 });
  assert.equal(fs.readFileSync(path.join(results, 'prepared.jsonl'), 'utf8').trim().split('\n').length, 6);
  assert.match(fs.readFileSync(path.join(results, 'report.md'), 'utf8'), /não são uma réplica/);
  assert.equal(inspectDataset(data).test_files, 6);
  assert.throws(() => evaluateDataset(data, results), /existe/);
});
test('perfil do experimento 2 funciona somente em avaliação de dois candidatos', t => {
  const root = temporary(t),
    data = path.join(root, 'data');
  generateDataset(data, {
    seed: 18,
    textBytes: 64,
    referenceKeys: 2,
    referencePerKey: 1,
    samples: 2,
    testsPerAlgorithm: 1,
  });
  const result = evaluateDataset(data, path.join(root, 'pair'), {
    candidates: ['Blowfish', 'RC2'],
    decisionType: 2,
    profile: 'chapter5-experiment2',
  });
  assert.equal(result.prepared.total, 2);
  assert.equal(result.configuration.profile, 'chapter5-experiment2');
  assert.throws(
    () => evaluateDataset(data, path.join(root, 'invalid'), { profile: 'chapter5-experiment2' }),
    /incompatível/,
  );
});
test('CLI reproduz índice, valida opções e rejeita caminho ausente', () => {
  const cli = new URL('../src/cli.js', import.meta.url);
  const invoke = (...args) =>
    spawnSync(process.execPath, ['--openssl-legacy-provider', fileURLToPath(cli), ...args], { encoding: 'utf8' });
  const example = invoke('index-example');
  assert.equal(example.status, 0, example.stderr);
  assert.ok(Math.abs(JSON.parse(example.stdout).value - 0.643508493) < 5e-10);
  assert.notEqual(invoke('generate', '--nonsense', 'x').status, 0);
  assert.notEqual(invoke('classify', '--reference', 'missing', '--file', 'missing').status, 0);
  assert.equal(invoke('help').status, 0);
});

test('CLI gera, verifica, inspeciona, classifica e avalia em caminho com espaços', t => {
  const root = temporary(t),
    data = path.join(root, 'dados com espaços'),
    out = path.join(root, 'resultado');
  const protocol = path.join(root, 'protocolo.json');
  fs.writeFileSync(
    protocol,
    JSON.stringify({
      textBytes: 64,
      referenceKeys: 2,
      referencePerKey: 1,
      samples: 2,
      testsPerAlgorithm: 1,
    }),
  );
  const cli = new URL('../src/cli.js', import.meta.url);
  const invoke = (...args) => {
    const r = spawnSync(process.execPath, ['--openssl-legacy-provider', fileURLToPath(cli), ...args], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(invoke('generate', '--protocol', protocol, '--out', data).records, 9);
  assert.equal(invoke('verify', '--dataset', data).status, 'ok');
  const inspected = invoke('inspect', '--dataset', data);
  assert.equal(inspected.test_files, 3);
  assert.equal(inspected.reference_terms.distinct, 48);
  const manifest = JSON.parse(fs.readFileSync(path.join(data, 'manifest.json')));
  const target = manifest.records.find(r => r.split === 'test');
  const single = invoke(
    'classify',
    '--reference',
    path.join(data, 'reference.json'),
    '--file',
    path.join(data, target.path),
  );
  const evaluated = invoke('evaluate', '--dataset', data, '--out', out);
  assert.equal(evaluated.prepared.total, 3);
  const rows = fs.readFileSync(path.join(out, 'prepared.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(single.prediction, rows.find(r => r.id === target.id).prediction);
  const benchmark = invoke(
    'benchmark',
    '--dataset',
    data,
    '--out',
    path.join(root, 'benchmark'),
    '--per-algorithm',
    '1',
  );
  assert.equal(benchmark.cases.length, 3);
  for (const measured of benchmark.cases)
    assert.deepEqual(
      measured.result,
      Object.fromEntries(
        Object.entries(rows.find(r => r.id === measured.id)).filter(([key]) => !['id', 'path', 'actual'].includes(key)),
      ),
    );
  const diagnosis = invoke('diagnose', '--dataset', data, '--out', path.join(root, 'diagnosis'));
  assert.equal(diagnosis.controls_passed, true);
  assert.equal(diagnosis.observed.edges, 0);
  const completeProtocol = path.join(root, 'complete-protocol.json');
  fs.writeFileSync(completeProtocol, JSON.stringify(manifest.config));
  const studyPlan = path.join(root, 'study-plan.json');
  fs.writeFileSync(
    studyPlan,
    JSON.stringify({
      schema: 1,
      kind: 'repeated_keys_validation',
      protocol: 'complete-protocol.json',
      seeds: [881, 882],
      concurrency: 1,
    }),
  );
  const study = invoke('study', '--plan', studyPlan, '--out', path.join(root, 'study'), '--concurrency', '1');
  assert.deepEqual(study.seeds, [881, 882]);
  assert.equal(study.summary.prepared_pooled_descriptive.total, 6);
  assert.equal(study.summary.prospective_repetitions.prepared_accuracy.n, 2);
});
