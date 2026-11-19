import test from 'node:test';
import assert from 'node:assert/strict';
import { Cryptogram } from '../src/terms.js';
import { preprocess, findIntersections, investigate } from '../src/structural.js';

function literal(corpus) {
  const result = [], sets = corpus.cryptograms.map(c => new Set(c.terms));
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    const common_terms = new Set([...sets[i]].filter(t => sets[j].has(t)));
    if (common_terms.size) result.push({ left: corpus.ordered_ids[i], right: corpus.ordered_ids[j], common_terms });
  }
  return result;
}
const ordered = edges => edges.map(e => [e.left, e.right, [...e.common_terms]]);

test('interseção indexada equivale à literal em 150 bases aleatórias reproduzíveis', () => {
  let state = 0x12345678;
  const next = limit => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
  for (let run = 0; run < 150; run++) {
    const cryptograms = Array.from({ length: next(18) }, (_, i) =>
      Cryptogram.fromTerms('arquivo-' + i, Array.from({ length: next(24) }, () =>
        BigInt(next(27)) | (run % 2 ? (1n << 63n) : 0n))));
    const corpus = preprocess(cryptograms);
    assert.deepEqual(ordered(findIntersections(corpus)), ordered(literal(corpus)), 'base ' + run);
  }
});

test('repetições internas não duplicam membros, arestas ou termos comuns', () => {
  const corpus = preprocess([
    Cryptogram.fromTerms('a', [7, 7, 3, 7, 3]),
    Cryptogram.fromTerms('b', [3, 3, 7, 7]),
    Cryptogram.fromTerms('c', [7, 7, 3]),
  ]);
  assert.deepEqual(ordered(findIntersections(corpus)), [
    ['a', 'b', [7n, 3n]], ['a', 'c', [7n, 3n]], ['b', 'c', [3n, 7n]],
  ]);
});

test('termo compartilhado por muitos vértices produz todos e somente seus pares', () => {
  const corpus = preprocess(Array.from({ length: 25 }, (_, i) =>
    Cryptogram.fromTerms('c' + i, [999n, BigInt(i)])));
  const edges = findIntersections(corpus);
  assert.equal(edges.length, 25 * 24 / 2);
  assert.deepEqual(ordered(edges), ordered(literal(corpus)));
});

test('ordem de arestas não depende da primeira descoberta de uma interseção', () => {
  const corpus = preprocess([
    Cryptogram.fromTerms('esquerdo', [8, 4, 2]),
    Cryptogram.fromTerms('segundo', [2, 4]),
    Cryptogram.fromTerms('terceiro', [8, 2]),
    Cryptogram.fromTerms('quarto', [4, 8]),
  ]);
  assert.deepEqual(ordered(findIntersections(corpus)), [
    ['esquerdo', 'segundo', [4n, 2n]],
    ['esquerdo', 'terceiro', [8n, 2n]],
    ['esquerdo', 'quarto', [8n, 4n]],
    ['segundo', 'terceiro', [2n]],
    ['segundo', 'quarto', [4n]],
    ['terceiro', 'quarto', [8n]],
  ]);
});

test('indexação usa posições, sem interpretar identificadores especiais aceitos por preprocess', () => {
  const corpus = preprocess(['', '__proto__', 'constructor', '01', '1', 'a/b'].map(identifier =>
    ({ identifier, terms: [3n, 2n, 3n] })));
  assert.deepEqual(ordered(findIntersections(corpus)), ordered(literal(corpus)));
});

test('termos fornecidos como geradores são consumidos uma única vez', () => {
  function* terms(values) { yield* values; }
  const corpus = {
    cryptograms: [{ terms: terms([3n, 2n]) }, { terms: terms([2n, 3n]) }],
    ordered_ids: ['a', 'b']
  };
  assert.deepEqual(ordered(findIntersections(corpus)), [['a', 'b', [3n, 2n]]]);
});

test('mil arquivos esparsos não ganham interseções artificiais', () => {
  const cryptograms = Array.from({ length: 1000 }, (_, i) =>
    Cryptogram.fromTerms('sparse-' + i, Array.from({ length: 64 }, (_, j) => BigInt(i * 64 + j))));
  const result = investigate(cryptograms);
  assert.deepEqual(result.intersections, []);
  assert.deepEqual(result.groups, []);
  assert.equal(result.ungrouped.length, 1000);
});
