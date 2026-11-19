import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runStudy } from '../src/study.js';
import { generateDataset } from '../src/dataset.js';
import { evaluateDataset } from '../src/evaluation.js';
import { sha256 } from '../src/crypto.js';
import { verifyStudy } from '../validation/verify-study.mjs';
import { temporary } from './fixtures.mjs';

async function fixture(t, { baseline = false } = {}) {
  const root = temporary(t),
    protocolFile = path.join(root, 'protocol.json'),
    planFile = path.join(root, 'plan.json');
  fs.writeFileSync(
    protocolFile,
    JSON.stringify({
      seed: 901,
      algorithms: ['Blowfish', 'RC2', 'CAST5'],
      textBytes: 64,
      referenceKeys: 2,
      referencePerKey: 1,
      samples: 2,
      testsPerAlgorithm: 2,
      testStartByte: 128,
    }),
  );
  const plan = {
    schema: 1,
    kind: 'repeated_keys_validation',
    protocol: 'protocol.json',
    seeds: [901, 902],
    concurrency: 2,
  };
  if (baseline) {
    const data = path.join(root, 'baseline-data'),
      evaluation = path.join(root, 'baseline-evaluation');
    generateDataset(data, JSON.parse(fs.readFileSync(protocolFile)));
    evaluateDataset(data, evaluation);
    const source_files = Object.fromEntries(
      [
        'metrics',
        'reference',
        'terms',
        'classification',
        'structural',
        'features',
        'pipeline',
        'crypto',
        'io',
        'dataset',
      ].map(name => [
        'src/' + name + '.js',
        sha256(fs.readFileSync(new URL('../src/' + name + '.js', import.meta.url))),
      ]),
    );
    fs.writeFileSync(path.join(evaluation, 'verification.json'), JSON.stringify({ source_files }));
    plan.baseline = { seed: 901, dataset: 'baseline-data', evaluation: 'baseline-evaluation' };
  }
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const output = path.join(root, 'study');
  await runStudy(planFile, output);
  fs.copyFileSync(planFile, path.join(output, 'study.input.json'));
  fs.copyFileSync(protocolFile, path.join(output, 'study.protocol.json'));
  return { root, output };
}
function edit(file, change) {
  const data = JSON.parse(fs.readFileSync(file));
  change(data);
  fs.writeFileSync(file, JSON.stringify(data));
}

test('verificação pós-estudo confere fontes, dados, previsões, agregação e termos independentemente', async t => {
  const { output } = await fixture(t),
    result = verifyStudy(output);
  assert.equal(result.verified, true);
  assert.equal(result.reciphered, true);
  assert.equal(result.source_files_verified, 16);
  assert.equal(result.ciphertext_files_verified, 24);
  assert.equal(result.keys_distinct_across_all_cells, 18);
  assert.equal(result.ivs_distinct_across_all_cells, 24);
  assert.equal(result.same_test_plaintexts_all_seeds, true);
  assert.equal(result.reference_test_windows_disjoint, true);
  assert.deepEqual(result.prospective_seeds, [901, 902]);
  assert.equal(result.reused_exploratory_seed, null);
  assert.equal(result.baseline_core_files_matched, 0);
  for (const cell of result.cells) {
    assert.equal(cell.reference_counts.distinct, 48);
    assert.equal(cell.reference_counts.occurrences, 48);
    assert.equal(cell.reference_counts.independently_counted, true);
    assert.equal(cell.reference_counts.all_terms_unique, true);
  }
  assert.match(result.warning, /Não prova/);
  assert.equal(verifyStudy(output, { checkCiphertexts: false }).reciphered, false);
  assert.throws(() => verifyStudy(output, { checkCiphertexts: 'false' }), /booleano/);
});

test('resumo agregado adulterado é rejeitado', async t => {
  const { output } = await fixture(t);
  edit(path.join(output, 'results.json'), value => {
    value.summary.all_repetitions.prepared_accuracy.mean = 99;
  });
  assert.throws(() => verifyStudy(output), /Resumo agregado/);
});

test('hash congelado adulterado é rejeitado sem alterar fontes reais', async t => {
  const { output } = await fixture(t);
  edit(path.join(output, 'study.plan.json'), value => {
    value.source_hashes['src/metrics.js'] = '00'.repeat(32);
  });
  assert.throws(() => verifyStudy(output), /Hash congelado/);
});

test('identificação exploratória congelada não pode contrariar o plano original', async t => {
  const { output } = await fixture(t);
  edit(path.join(output, 'study.plan.json'), value => {
    value.reused_exploratory_seed = 901;
  });
  assert.throws(() => verifyStudy(output), /Identificação exploratória/);
});

test('cópia de input com hash diferente não certifica plano original', async t => {
  const { output } = await fixture(t);
  fs.appendFileSync(path.join(output, 'study.input.json'), ' ');
  assert.throws(() => verifyStudy(output), /plan original com o hash/);
});

test('previsão adulterada é detectada contra resumo e registros', async t => {
  const { output } = await fixture(t),
    file = path.join(output, 'seed-901/evaluation/prepared.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  lines[0].actual = 'CAST5';
  fs.writeFileSync(file, lines.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.throws(() => verifyStudy(output), /gabarito/);
});

test('resultado da célula adulterado é detectado contra avaliação salva', async t => {
  const { output } = await fixture(t);
  edit(path.join(output, 'seed-901/evaluation/results.json'), value => {
    value.execution.elapsed_ms += 1;
  });
  assert.throws(() => verifyStudy(output), /Avaliação salva/);
});

test('baseline reutilizada exige equivalência dos hashes do núcleo, não da interface ou metadados', async t => {
  const { root, output } = await fixture(t, { baseline: true }),
    result = verifyStudy(output);
  assert.equal(result.baseline_core_files_matched, 10);
  assert.equal(result.reused_exploratory_seed, 901);
  assert.deepEqual(result.prospective_seeds, [902]);
  edit(path.join(root, 'baseline-evaluation/verification.json'), value => {
    value.source_files['src/metrics.js'] = '00'.repeat(32);
  });
  assert.throws(() => verifyStudy(output), /Núcleo da baseline/);
});

test('CLI é independente do cwd e recusa sobrescrever sua evidência', async t => {
  const { root, output } = await fixture(t),
    evidence = path.join(root, 'checked.json');
  const script = fileURLToPath(new URL('../validation/verify-study.mjs', import.meta.url));
  const invoke = () =>
    spawnSync(process.execPath, ['--openssl-legacy-provider', script, '--study', output, '--out', evidence], {
      cwd: root,
      encoding: 'utf8',
    });
  const success = invoke();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).verified, true);
  assert.equal(JSON.parse(fs.readFileSync(evidence)).verified, true);
  const duplicate = invoke();
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Saída já existe/);
});
