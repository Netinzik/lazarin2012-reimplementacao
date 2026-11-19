import test from 'node:test';
import assert from 'node:assert/strict';
import { LazarinModel } from '../src/pipeline.js';
import { Cryptogram } from '../src/terms.js';
import { figure } from './fixtures.mjs';

test('fluxo automático registra ausência de estrutura sem inventar candidato', () => {
  const m = LazarinModel.fit([Cryptogram.fromTerms('a', [0]), Cryptogram.fromTerms('b', [1])]);
  const r = m.predict(Cryptogram.fromTerms('D', [0]));
  assert.equal(r.status, 'insufficient_reference_structure');
  assert.equal(r.prediction, null);
  assert.deepEqual(r.scores, {});
});
test('comparação estrutural mantém nomes delta e amostras vindas da coloração', () => {
  const m = LazarinModel.fit(figure());
  const r = m.compare(Cryptogram.fromTerms('D', [0, 3, 15]));
  assert.deepEqual(Object.keys(r), ['delta_1', 'delta_2']);
  assert.equal(r.delta_1.weights.length, 3);
  assert.equal(r.delta_2.weights.length, 2);
  assert.deepEqual(r.delta_1.weights, m.reliabilityForGroup(Cryptogram.fromTerms('D', [0, 3, 15]), 1).weights);
});
test('configuração inválida não é escondida pela ausência de grupos', () => {
  const m = LazarinModel.fit([]), d = Cryptogram.fromTerms('D', [0]);
  assert.throws(() => m.predict(d, { decisionType: 4 }));
  assert.throws(() => m.predict(d, { profile: 'outro' }));
  assert.throws(() => m.predict(d, { alpha: NaN }));
  assert.throws(() => m.predict(d, { profile: 'chapter5-experiment2' }));
});
test('assinatura posicional estrutural equivale às opções nomeadas', () => {
  const m = LazarinModel.fit(figure()), d = Cryptogram.fromTerms('D', [0, 3, 15]);
  assert.deepEqual(m.predict(d, 3, null, .1, 'chapter3'), m.predict(d, { decisionType: 3 }));
});
