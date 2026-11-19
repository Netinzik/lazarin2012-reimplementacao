import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Cryptogram, edgeWeight, ReferenceModel, readCiphertext, localFile } from '../src/index.js';
import { temporary, rng } from './fixtures.mjs';

test('pesos em lote equivalem ao Algoritmo 2 em 100 casos de 64 bits', () => {
  const random = rng();
  for (let c = 0; c < 100; c++) {
    const universe = Array.from({ length: 24 }, () => (BigInt(random()) << 32n) | BigInt(random()));
    const samples = Array.from({ length: 6 }, () => new Set(Array.from({ length: 12 }, () => universe[random() % universe.length])));
    const m = ReferenceModel.fromSamples({ A: samples.slice(0, 3), B: samples.slice(3) });
    const d = Cryptogram.fromTerms('D', Array.from({ length: 12 }, () => (BigInt(random()) << 32n) | BigInt(random())));
    assert.deepEqual(m.weights(d), samples.map(s => edgeWeight(d, s, m.terms)));
  }
});
test('sobreposição de termos conta em cada amostra e repetições em D', () => {
  const m = ReferenceModel.fromSamples({ A: [[0, 3], [0, 3]], B: [[15], [15]] });
  assert.deepEqual(m.weights(Cryptogram.fromTerms('D', [1, 1])), [4, 4, 0, 0]);
});
test('distância 64 é preservada no lote', () => {
  const max = (1n << 64n) - 1n;
  const m = ReferenceModel.fromSamples({ A: [[max], [max]] });
  assert.deepEqual(m.weights(Cryptogram.fromTerms('D', [0])), [1, 1]);
});
test('índice indefinido impede disputa sem remover candidato', () => {
  const m = ReferenceModel.fromSamples({ A: [[0], [1]], B: [[255], [254]] });
  const r = m.predict(Cryptogram.fromTerms('D', [0]));
  assert.equal(r.status, 'undefined_index');
  assert.equal(r.prediction, null);
  assert.equal(r.scores.B.value, null);
});
test('seleção reconstrói T', () => {
  const m = ReferenceModel.fromSamples({ A: [[0], [1]], B: [[255], [254]] }).select(['A']);
  assert.deepEqual(m.terms, [0n, 1n]);
  assert.deepEqual(m.labels, ['A']);
});
test('referência suporta os três tipos e empate favorece segundo', () => {
  const m = ReferenceModel.fromSamples({ A: [[0], [1]], B: [[0], [1]] });
  const d = Cryptogram.fromTerms('D', [0, 1]);
  assert.equal(m.predict(d, 1, 'A').status, 'not_rejected_h0');
  assert.equal(m.predict(d, 2).prediction, 'B');
  assert.equal(m.predict(d, 3).prediction, 'B');
});
test('leitura de raw, hex e Base64', t => {
  const root = temporary(t), data = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
  for (const encoding of ['raw', 'hex', 'base64']) {
    const file = path.join(root, encoding);
    fs.writeFileSync(file, encoding === 'raw' ? data : data.toString(encoding));
    assert.deepEqual(readCiphertext(file, encoding), data);
  }
});
test('entrada vazia, não alinhada e codificação inválida são rejeitadas', t => {
  const file = path.join(temporary(t), 'data');
  for (const [data, encoding] of [['', 'raw'], ['123', 'raw'], ['???', 'base64'], ['a b', 'hex'], ['zz', 'hex']]) {
    fs.writeFileSync(file, data);
    assert.throws(() => readCiphertext(file, encoding));
  }
});
test('manifesto não escapa da raiz por .. ou symlink', t => {
  const root = temporary(t), inside = path.join(root, 'inside'), outside = path.join(root, 'outside');
  fs.mkdirSync(inside); fs.writeFileSync(outside, Buffer.alloc(8));
  assert.throws(() => localFile(inside, '../outside'), /fora/);
  fs.symlinkSync(outside, path.join(inside, 'link'));
  assert.throws(() => localFile(inside, 'link'), /fora/);
});
test('validação de candidatos e amostras', () => {
  for (const v of [{}, { A: [[1]] }, { A: [[], [1]] }, { SEM_CLASSE: [[1], [2]] }])
    assert.throws(() => ReferenceModel.fromSamples(v));
});
test('candidato duplicado no manifesto é rejeitado', t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'c.bin'), Buffer.alloc(8));
  const item = { label: 'A', samples: [['c.bin'], ['c.bin']] };
  fs.writeFileSync(path.join(root, 'reference.json'), JSON.stringify({ schema: 1, kind: 'prepared_reference', candidates: [item, item] }));
  assert.throws(() => ReferenceModel.load(path.join(root, 'reference.json')), /duplicado/);
});
test('rótulos especiais não alteram protótipos', () => {
  const m = ReferenceModel.fromSamples(new Map([['__proto__', [[0], [1]]], ['constructor', [[0], [1]]]]));
  const r = m.predict(Cryptogram.fromTerms('D', [0, 1]));
  assert.equal(r.prediction, 'constructor');
  assert.equal(Object.hasOwn(r.scores, '__proto__'), true);
});
