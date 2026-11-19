import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exampleCiphers, runWizard } from '../assistente.mjs';
import { buildConfig } from '../base.mjs';
import { validateDecisionSettings, parseArgs, readPlan } from '../cli.mjs';
import { derived } from '../../engine/src/dataset.js';

function scripted(answers) {
  const queue = [...answers],
    asked = [];
  const ask = async (question, fallback) => {
    if (!queue.length) throw new Error('Pergunta sem resposta no roteiro: ' + question);
    const answer = queue.shift();
    asked.push(question);
    return answer === '' ? (fallback ?? '') : answer;
  };
  return { ask, asked, remaining: () => queue.length };
}

test('Enter na primeira pergunta mantém a configuração padrão', async () => {
  const { ask } = scripted(['']);
  assert.equal(await runWizard({ ask, log: () => {}, validateSettings: validateDecisionSettings }), null);
});

test('assistente monta ECB com cifras do catálogo, programa externo, bloco em JS, chaves fixas e trecho escolhido', async () => {
  const script = scripted([
    'n',
    '1',
    '1',
    '1,2',
    's',
    '1',
    'XOR',
    '',
    '',
    '',
    's',
    '2',
    'Feistel',
    '',
    'n',
    'n',
    '1024',
    '2',
    '2',
    '2',
    '3',
    '123',
    '2',
    '',
    '',
    '',
    '',
    '10',
    '',
    '',
    '',
    '',
    's',
  ]);
  const lines = [];
  const plan = await runWizard({
    ask: script.ask,
    log: line => lines.push(line),
    validateSettings: validateDecisionSettings,
  });
  assert.equal(script.remaining(), 0);
  assert.equal(plan.crypto.mode, 'ECB');
  assert.deepEqual(plan.crypto.backend, { kind: 'node' });
  assert.deepEqual(
    plan.crypto.ciphers.map(c => [c.label, c.source]),
    [
      ['Blowfish', 'openssl'],
      ['RC2', 'openssl'],
      ['XOR', 'programa'],
      ['Feistel', 'bloco-js'],
    ],
  );
  assert.equal(plan.crypto.ciphers[2].ivBytes, 0);
  for (const cipher of plan.crypto.ciphers)
    assert.deepEqual(cipher.keys, {
      policy: 'fixa',
      hex: derived(123, `key/${cipher.label}/fixa`, 16).toString('hex'),
    });
  assert.equal(plan.seed, 123);
  assert.equal(plan.testStartByte, 9 * 1024);
  assert.deepEqual(plan.sizes, {
    textBytes: 1024,
    referenceKeys: 2,
    referencePerKey: 2,
    samples: 2,
    testsPerAlgorithm: 3,
  });
  assert.equal(plan.settings.decisionType, 3);
  assert.equal(plan.settings.zeroWeight, 'perde');
  assert.equal(plan.cases, 12);
  assert.ok(lines.some(line => /Sem IV neste modo/.test(line)));
  const { config } = buildConfig({
    seed: plan.seed,
    testStartByte: plan.testStartByte,
    sizes: plan.sizes,
    crypto: plan.crypto,
  });
  assert.deepEqual(config.algorithms, ['Blowfish', 'RC2', 'XOR', 'Feistel']);
  assert.match(config.crypto.ciphers[3].module, /exemplos\/feistel-fraca\.mjs$/);
});

test('assistente adiciona exemplos prontos da pasta exemplos/, vários de uma vez e sem repetir nomes', async () => {
  const examples = exampleCiphers();
  const number = label => String(examples.findIndex(e => e.cipher.label === label) + 1);
  const script = scripted([
    'n',
    '1',
    '1',
    '1',
    '',
    '3',
    [number('Cesar'), number('Afim'), number('TEA'), number('RC5'), number('RC4')].join(','),
    's',
    '3',
    '1,1',
    number('Cesar'),
    'n',
    'n',
    '1024',
    '2',
    '2',
    '2',
    '3',
    '7',
    '1',
    '',
    '',
    '',
    '',
    '',
    's',
  ]);
  const lines = [];
  const plan = await runWizard({
    ask: script.ask,
    log: line => lines.push(line),
    validateSettings: validateDecisionSettings,
  });
  assert.equal(script.remaining(), 0);
  assert.deepEqual(
    plan.crypto.ciphers.map(c => [c.label, c.source]),
    [
      ['Blowfish', 'openssl'],
      ['Cesar', 'programa'],
      ['Afim', 'programa'],
      ['TEA', 'bloco-js'],
      ['RC5', 'bloco-js'],
      ['RC4', 'programa'],
    ],
  );
  const [, cesar, afim, tea] = plan.crypto.ciphers;
  assert.match(cesar.command, /^python3 .*exemplos\/cifra-cesar\.py$/);
  assert.deepEqual([cesar.keyBytes, cesar.ivBytes, afim.keyBytes], [1, 0, 2]);
  assert.match(tea.module, /exemplos\/tea\.mjs$/);
  assert.ok(lines.some(line => line.includes('Cesar já está na lista')));
  assert.ok(lines.some(line => line.includes('Use números da lista')));
  const { config } = buildConfig({
    seed: plan.seed,
    testStartByte: plan.testStartByte,
    sizes: plan.sizes,
    crypto: plan.crypto,
  });
  assert.deepEqual(config.algorithms, ['Blowfish', 'Cesar', 'Afim', 'TEA', 'RC5', 'RC4']);
});

test('respostas inválidas são perguntadas de novo, sem aceitar o valor', async () => {
  const script = scripted([
    'talvez',
    'n',
    '9',
    '1',
    '7',
    '2',
    '0,99',
    '2,2',
    '1,2,3',
    'n',
    '',
    '-5',
    'abc',
    '42',
    '3',
    'zz',
    ...Array(33).fill(''),
    '2',
    'xyz',
    '',
    '',
    '',
    '',
    '',
    '',
    '2',
    '',
    's',
  ]);
  const lines = [];
  const plan = await runWizard({
    ask: script.ask,
    log: line => lines.push(line),
    validateSettings: validateDecisionSettings,
  });
  assert.equal(script.remaining(), 0);
  assert.equal(plan.crypto.mode, 'CBC');
  assert.equal(plan.settings.zeroWeight, 'abster');
  assert.equal(plan.seed, 42);
  assert.deepEqual(
    plan.crypto.ciphers.map(c => c.keys.policy),
    ['manuais', 'manuais', 'manuais'],
  );
  assert.deepEqual(
    plan.crypto.ciphers.map(c => c.iv),
    [
      { policy: 'fixo', hex: derived(42, 'iv/Blowfish/fixo', 8).toString('hex') },
      { policy: 'fixo', hex: derived(42, 'iv/RC2/fixo', 8).toString('hex') },
      { policy: 'fixo', hex: derived(42, 'iv/CAST5/fixo', 8).toString('hex') },
    ],
  );
  assert.equal(plan.crypto.ciphers[0].keys.reference[0], derived(42, 'key/Blowfish/reference/k0', 16).toString('hex'));
  for (const message of [
    'Responda s ou n',
    'Digite um inteiro de 1 a',
    'Use números da lista',
    'semente deve ser',
    'hexadecimais',
  ])
    assert.ok(
      lines.some(line => line.includes(message)),
      message,
    );
});

test('--config não se mistura com escolhas avulsas; config.json com campo estranho é recusado', t => {
  assert.throws(() => parseArgs(['--config', 'x.json', '--semente', '1']), /--config/);
  assert.equal(parseArgs(['--config', 'x.json', '--casos', '5', '--sem-menu']).cases, 5);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazarin-plano-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ seed: 1, extra: true }));
  assert.throws(() => readPlan(file), /extra/);
  fs.writeFileSync(file, JSON.stringify({ seed: 1, testStartByte: 0 }));
  assert.deepEqual(readPlan(file), { seed: 1, testStartByte: 0 });
});
