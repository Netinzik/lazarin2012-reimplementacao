import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Cryptogram, MAX_CRYPTOTERM, normalizeCryptoterm, splitBytes, hammingDistance,
  preprocess, investigate, findIntersections, extractFeatures, LazarinModel,
  edgeWeight, reliabilityIndex, reliabilityIndexFromWeights, UndefinedIndexError,
  type1Decision, type2Decision, type3Decision,
} from '../src/index.js';
import { figure } from './fixtures.mjs';

test('blocos de oito bytes preservam os 64 bits', () => {
  assert.deepEqual(splitBytes(Buffer.from('ffffffffffffffff0000000000000001', 'hex')), [MAX_CRYPTOTERM, 1n]);
});
test('sobra é rejeitada sem padding', () => assert.throws(() => splitBytes(Buffer.alloc(9))));
test('D preserva ocorrências repetidas', () => assert.deepEqual(Cryptogram.fromTerms('D', [1, 1]).terms, [1n, 1n]));
test('normalização suporta BigInt, inteiro seguro, bytes e string de 64 bits', () => {
  for (const v of [1n, 1, Buffer.from('0000000000000001', 'hex'), '1'.padStart(64, '0')])
    assert.equal(normalizeCryptoterm(v), 1n);
});
test('representações inválidas e inteiros inseguros são rejeitados', () => {
  for (const v of [true, -1, 1.5, 2 ** 53, 1n << 64n, NaN, '1', Buffer.alloc(7)])
    assert.throws(() => normalizeCryptoterm(v));
});
test('bit mais alto não é perdido em Hamming', () => {
  assert.equal(hammingDistance(1n << 63n, 0n), 1);
  assert.equal(hammingDistance(MAX_CRYPTOTERM, 0n), 64);
});
test('Hamming conhecido', () => assert.equal(hammingDistance(0b1010, 0b0011), 2));
test('O contém uma relação por par criptograma/termo', () => {
  const corpus = preprocess([Cryptogram.fromTerms('a', [1, 1, 2])]);
  assert.equal(corpus.occurrences.length, 2);
  assert.equal(corpus.terms.size, 2);
});
test('identificadores duplicados são rejeitados', () => assert.throws(() => preprocess([
  Cryptogram.fromTerms('a', [1]), Cryptogram.fromTerms('a', [2]),
])));
test('interseções reproduzem a Figura 3.2', () => {
  const edges = findIntersections(preprocess(figure()));
  assert.deepEqual(edges.map(e => [e.left, e.right]), [
    ['c1', 'c2'], ['c2', 'c3'], ['c2', 'c5'], ['c3', 'c5'], ['c4', 'c5'], ['c7', 'c8'],
  ]);
});
test('componentes e isolados reproduzem a Figura 3.2', () => {
  const result = investigate(figure());
  assert.deepEqual(result.ungrouped, ['c6', 'c9']);
  assert.deepEqual(result.groups, [['c1', 'c2', 'c3', 'c4', 'c5'], ['c7', 'c8']]);
});
test('classes da Figura 3.3, preservando o termo omitido no desenho', () => {
  const group = extractFeatures(investigate(figure()))[0];
  assert.deepEqual(group.samples.map(s => s.cryptogram_ids), [['c1', 'c3', 'c4'], ['c2'], ['c5']]);
  assert.deepEqual([...group.samples[0].terms].sort(), [0n, 1n, 3n, 4n, 6n, 9n]);
});
test('coloração não atribui a mesma cor a adjacentes', () => {
  const inv = investigate(figure()), groups = extractFeatures(inv);
  for (const g of groups) for (const e of inv.intersections)
    if (g.cryptogram_ids.includes(e.left) && g.cryptogram_ids.includes(e.right))
      assert.notEqual(g.colorOf(e.left), g.colorOf(e.right));
});
test('pipeline executa investigação e extração', () => {
  const m = LazarinModel.fit(figure());
  assert.equal(m.featureGroups.length, 2);
  assert.deepEqual(m.ungroupedTerms, new Set([7n, 13n, 8n, 15n]));
});
test('pipeline chama o peso literal para cada amostra', () => {
  const m = LazarinModel.fit(figure()), d = Cryptogram.fromTerms('D', [0, 3, 15]);
  const r = m.reliabilityForGroup(d, 1);
  assert.deepEqual(r.weights, m.featureGroups[0].samples.map(s =>
    edgeWeight(d, s.terms, m.investigation.corpus.terms, m.ungroupedTerms)));
});
test('grupo inexistente é rejeitado', () => assert.throws(() => LazarinModel.fit(figure()).reliabilityForGroup([1], 99)));
test('peso conta todos os mínimos empatados na amostra', () => assert.equal(edgeWeight([1], [0, 3], [0, 3]), 2));
test('competidor mais próximo impede contribuição', () => assert.equal(edgeWeight([0], [3], [0, 3]), 0));
test('empate com competidor favorece tau pelo <=', () => assert.equal(edgeWeight([1], [0], [0, 3]), 1));
test('repetições em D repetem a contribuição', () => assert.equal(edgeWeight([1, 1], [0, 3], [0, 3]), 4));
test('delta_0 não compete', () => assert.equal(edgeWeight([0], [3], [0, 3], [0]), 1));
test('amostra vazia é rejeitada', () => assert.throws(() => edgeWeight([1], [], [1])));
test('135 e 226 reproduzem o índice da dissertação', () => {
  const r = reliabilityIndexFromWeights([135, 226]);
  assert.equal(r.mean, 180.5);
  assert.ok(Math.abs(r.value - 0.643508493) < 5e-10);
});
test('média zero gera erro explícito', () => assert.throws(() => reliabilityIndexFromWeights([0, 0]), UndefinedIndexError));
test('índice exige duas amostras', () => assert.throws(() => reliabilityIndexFromWeights([1])));
test('índice negativo não é truncado', () => assert.ok(reliabilityIndexFromWeights([0, 1]).value < 0));
test('pesos negativos e não finitos são rejeitados', () => {
  for (const v of [-1, NaN, Infinity, '2']) assert.throws(() => reliabilityIndexFromWeights([1, v]));
});
test('geradores são materializados uma vez', () => {
  function* g(values) { yield* values; }
  assert.deepEqual(reliabilityIndex(g([0, 1]), [g([0]), g([1])], g([0, 1]), g([])).weights, [1, 1]);
});
test('Tipo 1 usa VR > alpha', () => {
  assert.equal(type1Decision(0.9, 0.05).reject_h0, true);
  assert.equal(type1Decision(1, 0).reject_h0, false);
});
test('Tipo 2 escolhe menor VR', () => assert.equal(type2Decision('A', 0.9, 'B', 0.6).winner, 'A'));
test('Tipo 2 empate escolhe k', () => assert.equal(type2Decision('A', 0.8, 'B', 0.8).winner, 'B'));
test('Tipo 3 soma vitórias por pares', () => {
  const r = type3Decision(new Map([['A', 0.9], ['B', 0.8], ['C', 0.7]]));
  assert.equal(r.winner, 'A');
  assert.deepEqual(r.edge_weights, { A: 2, B: 1, C: 0 });
  assert.equal(r.pairwise_decisions.length, 3);
});
test('decisões rejeitam NaN e configurações inválidas', () => {
  assert.throws(() => type1Decision(NaN, 0.05));
  assert.throws(() => type1Decision(1, -0.1));
  assert.throws(() => type3Decision({ A: 1 }));
});
test('Map preserva ordem inclusive de rótulos numéricos', () =>
  assert.equal(type3Decision(new Map([['2', 0.8], ['1', 0.8]])).winner, '1'));
