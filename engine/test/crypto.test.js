import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { ALGORITHMS, checkCrypto, encryptCBC } from '../src/crypto.js';

const vectors = [
  ['Blowfish', 'f0e1d2c3b4a5968778695a4b3c2d1e0f', 'fedcba9876543210', '93142887ee3be15c'],
  ['RC2', '88bca90e90875a7f0f79c384627bafb2', '0000000000000000', '2269552ab0f85ca6'],
  ['CAST5', '0123456712345678234567893456789a', '0123456789abcdef', '238b4fe5847e44b2'],
];
for (const [algorithm, key, clear, expected] of vectors)
  test(algorithm + ': vetor externo de chave 128 bits', () => {
    assert.equal(
      encryptCBC(algorithm, Buffer.from(clear, 'hex'), Buffer.from(key, 'hex'), Buffer.alloc(8)).toString('hex'),
      expected,
    );
  });

test('todos os backends têm chave 128, bloco e IV de 64 bits', () => {
  const info = checkCrypto();
  assert.deepEqual(info.algorithms, [...ALGORITHMS]);
  assert.equal(info.key_bits, 128);
  assert.equal(info.block_bits, 64);
  assert.equal(info.rc2_effective_key_bits, 128);
});

test('CBC de dois blocos corresponde à aplicação independente do encadeamento', () => {
  const ciphers = { Blowfish: 'bf-cbc', RC2: 'rc2-cbc', CAST5: 'cast5-cbc' };
  const clear = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const key = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const iv = Buffer.from('1020304050607080', 'hex');
  for (const algorithm of ALGORITHMS) {
    const first = encryptCBC(algorithm, clear.subarray(0, 8), key, iv);
    const second = encryptCBC(algorithm, clear.subarray(8), key, first);
    const encrypted = encryptCBC(algorithm, clear, key, iv);
    assert.deepEqual(encrypted, Buffer.concat([first, second]));
    const decipher = createDecipheriv(ciphers[algorithm], key, iv);
    decipher.setAutoPadding(false);
    assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), clear);
    assert.equal(encrypted.length, clear.length);
  }
});

test('rejeita cifras extras, entradas desalinhadas e chaves com tamanhos diferentes', () => {
  const clear = Buffer.alloc(8),
    key = Buffer.alloc(16),
    iv = Buffer.alloc(8);
  assert.throws(() => encryptCBC('DES', clear, key, iv), /não suportado/);
  for (const algorithm of ALGORITHMS) {
    for (const length of [0, 7, 8, 15, 17, 32])
      assert.throws(() => encryptCBC(algorithm, clear, Buffer.alloc(length), iv), /128 bits/);
    for (const length of [0, 1, 7, 9])
      assert.throws(() => encryptCBC(algorithm, Buffer.alloc(length), key, iv), /múltipla/);
    assert.throws(() => encryptCBC(algorithm, clear, key, Buffer.alloc(16)), /IV/);
    assert.throws(() => encryptCBC(algorithm, '12345678', key, iv), /Uint8Array/);
  }
});
