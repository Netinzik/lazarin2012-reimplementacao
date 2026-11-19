import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LABEL_PATTERN, loadBlockModules, probeCipher } from '../src/crypto.js';
import { cipherSizes, generateDataset, validateDataset } from '../src/dataset.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLES = path.join(ROOT, 'exemplos');
const catalog = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'catalogo.json'), 'utf8'));
const NO_PYTHON = spawnSync('python3', ['--version']).status === 0 ? false : 'python3 não encontrado';
const hex = b => Buffer.from(b).toString('hex');
const bytes = s => Uint8Array.from(Buffer.from(s, 'hex'));
const load = file => import(pathToFileURL(path.join(EXAMPLES, file)).href);
const programs = catalog.filter(e => e.arquivo.endsWith('.py'));
const blocks = catalog.filter(e => e.arquivo.endsWith('.mjs'));

function python(file, key, iv, input, extra = []) {
  const run = spawnSync('python3', [path.join(EXAMPLES, file), hex(key), hex(iv), 'ECB', ...extra], { input });
  assert.equal(run.status, 0, `${file}: ${run.stderr}`);
  return run.stdout;
}

function spec(entry) {
  const file = path.join(EXAMPLES, entry.arquivo);
  return entry.arquivo.endsWith('.mjs')
    ? { label: entry.nome, source: 'bloco-js', module: file }
    : {
        label: entry.nome,
        source: 'programa',
        command: `python3 '${file}'`,
        keyBytes: entry.chaveBytes,
        ivBytes: entry.ivBytes,
      };
}

test('catálogo de exemplos: cada entrada aponta para um arquivo da pasta, com nome válido e único', () => {
  assert.equal(new Set(catalog.map(e => e.nome.toLowerCase())).size, catalog.length);
  assert.equal(new Set(catalog.map(e => e.arquivo)).size, catalog.length);
  for (const entry of catalog) {
    assert.ok(/\.(py|mjs)$/.test(entry.arquivo) && fs.existsSync(path.join(EXAMPLES, entry.arquivo)), entry.arquivo);
    assert.match(entry.nome, LABEL_PATTERN);
    assert.ok(entry.descricao && entry.familia, entry.nome);
    if (entry.arquivo.endsWith('.py'))
      assert.ok(Number.isSafeInteger(entry.chaveBytes) && entry.chaveBytes >= 1, entry.nome);
  }
  assert.ok(catalog.length >= 10);
});

test('vetores de teste publicados: TEA e RC5-32/12/16 (artigo de Rivest)', async () => {
  const tea = await load('tea.mjs'),
    rc5 = await load('rc5.mjs');
  assert.equal(hex(tea.cifrarBloco(new Uint8Array(8), new Uint8Array(16))), '41ea3a0a94baa940');
  for (const [key, plain, cipher] of [
    ['00000000000000000000000000000000', '0000000000000000', '21a5dbee154b8f6d'],
    ['915f4619be41b2516355a50110a9ce91', '21a5dbee154b8f6d', 'f7c013ac5b2b8952'],
    ['783348e75aeb0f2fd7b169bb8dc16787', 'f7c013ac5b2b8952', '2f42b3b70369fc92'],
  ])
    assert.equal(hex(rc5.cifrarBloco(bytes(plain), bytes(key))), cipher);
});

test(
  'RC4 em Python gera os mesmos bytes que o RC4 do OpenSSL, com e sem IV (IV || chave, como no WEP)',
  { skip: NO_PYTHON },
  () => {
    const key = randomBytes(16),
      iv = randomBytes(8),
      data = randomBytes(3000);
    for (const [opensslKey, ivUsed] of [
      [key, Buffer.alloc(0)],
      [Buffer.concat([iv, key]), iv],
    ]) {
      const cipher = createCipheriv('rc4', opensslKey, null);
      assert.deepEqual(python('cifra-rc4.py', key, ivUsed, data), Buffer.concat([cipher.update(data), cipher.final()]));
    }
  },
);

test('cifras de bloco: decifrarBloco desfaz cifrarBloco; transposição só reordena; Hill é linear', async () => {
  for (const entry of blocks) {
    const m = await load(entry.arquivo);
    assert.equal(m.blocoBytes, 8, entry.nome);
    for (let i = 0; i < 300; i++) {
      const key = randomBytes(m.chaveBytes),
        block = randomBytes(8);
      const encrypted = m.cifrarBloco(Uint8Array.from(block), Uint8Array.from(key));
      assert.equal(hex(m.decifrarBloco(encrypted, Uint8Array.from(key))), hex(block), entry.nome);
    }
  }
  const transposition = await load('transposicao.mjs'),
    hill = await load('hill.mjs');
  const key = randomBytes(8),
    block = randomBytes(8);
  assert.deepEqual([...transposition.cifrarBloco(block, key)].sort(), [...block].sort());
  assert.equal(hex(transposition.cifrarBloco(block, Buffer.alloc(8, 7))), hex(block));
  const hillKey = randomBytes(64),
    a = randomBytes(8),
    b = randomBytes(8);
  const sum = Uint8Array.from(a, (x, i) => (x + b[i]) & 255);
  const ea = hill.cifrarBloco(a, hillKey),
    eb = hill.cifrarBloco(b, hillKey);
  assert.deepEqual(
    hill.cifrarBloco(sum, hillKey),
    Uint8Array.from(ea, (x, i) => (x + eb[i]) & 255),
  );
});

test(
  'programas: o argumento "decifrar" desfaz a cifragem; XOR e RC4 são a própria inversa',
  { skip: NO_PYTHON },
  () => {
    const data = randomBytes(2048);
    for (const entry of programs) {
      const key = randomBytes(entry.chaveBytes),
        iv = Buffer.alloc(0);
      const encrypted = python(entry.arquivo, key, iv, data);
      assert.equal(encrypted.length, data.length, entry.nome);
      assert.notDeepEqual(encrypted, data, entry.nome);
      const inverse = ['XOR', 'RC4'].includes(entry.nome) ? [] : ['decifrar'];
      assert.deepEqual(python(entry.arquivo, key, iv, encrypted, inverse), data, entry.nome);
    }
    assert.deepEqual(
      python('cifra-cesar.py', Buffer.from([0]), Buffer.alloc(0), Buffer.from('ABC')),
      Buffer.from('DEF'),
    );
  },
);

test('todos os exemplos respondem pelo artefato em ECB e CBC e geram uma base válida', { skip: NO_PYTHON }, async t => {
  const ciphers = catalog.map(spec);
  await loadBlockModules(ciphers);
  for (const cipher of ciphers)
    for (const mode of ['ECB', 'CBC']) {
      const output = probeCipher(cipher, mode, { kind: 'node' }, cipherSizes(cipher, mode));
      assert.equal(output.length, 32, `${cipher.label} ${mode}`);
    }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazarin-exemplos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifest = generateDataset(path.join(dir, 'base'), {
    seed: 3,
    textBytes: 256,
    referenceKeys: 2,
    referencePerKey: 2,
    samples: 2,
    testsPerAlgorithm: 1,
    testStartByte: 2_457_600,
    crypto: { mode: 'ECB', ciphers },
  });
  assert.deepEqual(
    manifest.algorithms,
    catalog.map(e => e.nome),
  );
  assert.deepEqual(validateDataset(path.join(dir, 'base')), manifest);
});
