import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyMode, encryptWith, findOpenSSL, loadBlockModules, MODES, CATALOG, cipherInfo } from '../src/crypto.js';
import { generateDataset, validateDataset, normalizeCrypto } from '../src/dataset.js';
import { inspectDataset } from '../src/evaluation.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLES = path.join(ROOT, 'exemplos');
const small = {
  seed: 9,
  textBytes: 256,
  referenceKeys: 2,
  referencePerKey: 2,
  samples: 2,
  testsPerAlgorithm: 2,
  testStartByte: 2_457_600,
};
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazarin-cripto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const nodeBlock = (base, key) => block => {
  const cipher = createCipheriv(base + '-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
};

test('os cinco modos aplicados pelo artefato a uma função de bloco coincidem com o OpenSSL', () => {
  for (const [base, n] of [
    ['bf', 8],
    ['cast5', 8],
    ['aes-128', 16],
    ['camellia-128', 16],
  ]) {
    const key = randomBytes(16),
      plaintext = randomBytes(512),
      iv = randomBytes(n);
    for (const mode of MODES) {
      let expected;
      try {
        expected = encryptWith(
          { source: 'openssl', base },
          { plaintext, key, iv: mode === 'ECB' ? Buffer.alloc(0) : iv, mode },
        );
      } catch {
        assert.equal(mode, 'CTR');
        continue;
      }
      assert.deepEqual(
        applyMode(mode, nodeBlock(base, key), n, plaintext, mode === 'ECB' ? Buffer.alloc(0) : iv),
        expected,
        `${base} ${mode}`,
      );
    }
  }
});

test('OpenSSL do sistema, quando instalado, gera os mesmos bytes que o motor Node', t => {
  const systems = findOpenSSL();
  if (!systems.length) {
    t.skip('nenhum OpenSSL de linha de comando encontrado');
    return;
  }
  const key = randomBytes(16),
    plaintext = randomBytes(1024);
  for (const system of systems)
    for (const [base, mode] of [
      ['bf', 'CBC'],
      ['rc2', 'ECB'],
      ['cast5', 'OFB'],
      ['aes-128', 'CTR'],
    ]) {
      const iv = mode === 'ECB' ? Buffer.alloc(0) : randomBytes(cipherInfo(base, mode).ivBytes);
      const viaNode = encryptWith({ source: 'openssl', base }, { plaintext, key, iv, mode });
      const viaCli = encryptWith(
        { source: 'openssl', base },
        { plaintext, key, iv, mode, backend: { kind: 'openssl', path: system.path } },
      );
      assert.deepEqual(viaCli, viaNode, `${system.path} ${base} ${mode}`);
    }
});

test('catálogo: tamanho de chave e bloco vêm do OpenSSL; CTR só existe para blocos de 128 bits', () => {
  assert.deepEqual(cipherInfo('des', 'CBC'), { name: 'des-cbc', keyBytes: 8, ivBytes: 8, blockBytes: 8 });
  assert.deepEqual(cipherInfo('aes-256', 'ECB'), { name: 'aes-256-ecb', keyBytes: 32, ivBytes: 0, blockBytes: 16 });
  assert.throws(() => cipherInfo('bf', 'CTR'), /indisponível/);
  assert.ok(CATALOG.length >= 10);
});

test('base com chave fixa, IV zero, DES e cifras próprias é gerada, validada e reproduzível', async t => {
  const ciphers = [
    {
      label: 'DES',
      source: 'openssl',
      base: 'des',
      keys: { policy: 'fixa', hex: '0123456789abcdef' },
      iv: { policy: 'zero' },
    },
    {
      label: 'XOR',
      source: 'programa',
      command: `python3 ${path.join(EXAMPLES, 'cifra-xor.py')}`,
      keyBytes: 16,
      ivBytes: 0,
    },
    {
      label: 'Feistel',
      source: 'bloco-js',
      module: path.join(EXAMPLES, 'feistel-fraca.mjs'),
      iv: { policy: 'fixo', hex: '0011223344556677' },
    },
  ];
  await loadBlockModules(ciphers);
  const dir = temporary(t);
  const manifest = generateDataset(path.join(dir, 'a'), { ...small, crypto: { mode: 'CBC', ciphers } });
  assert.deepEqual(manifest.algorithms, ['DES', 'XOR', 'Feistel']);
  assert.deepEqual(
    manifest.crypto.ciphers.map(c => [c.key_bits, c.iv_bits, c.key_policy, c.iv_policy]),
    [
      [64, 64, 'fixa', 'zero'],
      [128, 0, 'derivadas', 'nenhum'],
      [128, 64, 'derivadas', 'fixo'],
    ],
  );
  assert.ok(manifest.keys.filter(k => k.algorithm === 'DES').every(k => k.hex === '0123456789abcdef'));
  assert.ok(manifest.records.filter(r => r.algorithm === 'DES').every(r => r.iv_hex === '0000000000000000'));
  assert.ok(manifest.records.filter(r => r.algorithm === 'XOR').every(r => r.iv_hex === ''));
  assert.deepEqual(validateDataset(path.join(dir, 'a')), manifest);
  const again = generateDataset(path.join(dir, 'b'), { ...small, crypto: { mode: 'CBC', ciphers } });
  assert.deepEqual(again.records, manifest.records);
});

test('ECB com chave fixa forma grupos na investigação estrutural; CBC com IV por arquivo não forma', async t => {
  const dir = temporary(t);
  const fixed = label => ({
    label,
    source: 'openssl',
    base: label === 'Blowfish' ? 'bf' : 'cast5',
    keys: { policy: 'fixa', hex: randomBytes(16).toString('hex') },
  });
  const sizes = { ...small, textBytes: 4096, referencePerKey: 3 };
  generateDataset(path.join(dir, 'ecb'), {
    ...sizes,
    crypto: { mode: 'ECB', ciphers: [fixed('Blowfish'), fixed('CAST5')] },
  });
  generateDataset(path.join(dir, 'cbc'), {
    ...sizes,
    crypto: { mode: 'CBC', ciphers: [fixed('Blowfish'), fixed('CAST5')] },
  });
  assert.ok(inspectDataset(path.join(dir, 'ecb')).structural.groups >= 2);
  assert.equal(inspectDataset(path.join(dir, 'cbc')).structural.groups, 0);
});

test('configurações criptográficas inválidas são recusadas com mensagem clara', async () => {
  const bf = { label: 'Blowfish', source: 'openssl', base: 'bf' },
    rc2 = { label: 'RC2', source: 'openssl', base: 'rc2' };
  for (const [crypto, message] of [
    [{ mode: 'XTS', ciphers: [bf, rc2] }, /Modo/],
    [{ ciphers: [bf] }, /duas cifras/],
    [{ ciphers: [bf, { ...rc2, label: 'blowfish' }] }, /repetidos/],
    [{ ciphers: [bf, { label: 'Z', source: 'openssl', base: 'rc4' }] }, /catálogo/],
    [{ mode: 'CTR', ciphers: [bf, rc2] }, /indisponível/],
    [{ ciphers: [bf, { ...rc2, keys: { policy: 'fixa', hex: 'abc' } }] }, /16 bytes/],
    [
      { ciphers: [bf, { ...rc2, keys: { policy: 'manuais', reference: ['00'.repeat(16)], test: '00'.repeat(16) } }] },
      /2 chaves/,
    ],
    [{ ciphers: [bf, { ...rc2, iv: { policy: 'aleatorio' } }] }, /IV/],
    [{ ciphers: [bf, { label: 'P', source: 'programa', command: '' }] }, /comando/],
    [{ ciphers: [bf, { label: 'B', source: 'bloco-js', module: '/nao/existe.mjs' }] }, /não carregada/],
    [{ backend: { kind: 'openssl' }, ciphers: [bf, rc2] }, /Motor/],
    [{ ciphers: [bf, { label: 'nome com espaço', source: 'openssl', base: 'rc2' }] }, /Nome de cifra/],
  ])
    assert.throws(() => normalizeCrypto(crypto, 2), message);
});

test('programa externo que falha, devolve tamanho errado ou não é determinístico é recusado', t => {
  const dir = temporary(t);
  const run = command =>
    generateDataset(path.join(dir, String(Math.random())), {
      ...small,
      crypto: {
        ciphers: [
          { label: 'Blowfish', source: 'openssl', base: 'bf' },
          { label: 'P', source: 'programa', command, ivBytes: 0 },
        ],
      },
    });
  assert.throws(() => run('exit 3'), /falhou/);
  assert.throws(() => run('head -c 5 #'), /múltiplo de 8/);
  assert.throws(() => run('head -c 32 /dev/urandom #'), /determinística/);
});
