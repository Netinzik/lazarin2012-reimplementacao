import test from 'node:test';
import assert from 'node:assert/strict';
import { decideScores } from '../src/classification.js';

const defined = value => ({ value, weights: [1, 2], error: null });
const zero = { value: null, weights: [0, 0], error: 'zero_mean' };

test('padrão do núcleo continua se abstendo quando falta um índice', () => {
  const result = decideScores({ A: zero, B: defined(0.9), C: defined(0.8) }, { decisionType: 3 });
  assert.equal(result.prediction, null);
  assert.equal(result.abstention_reason, 'undefined_index');
});

test('sem peso perde: no Tipo 3, a única cifra com peso vence todos os confrontos', () => {
  const result = decideScores({ A: zero, B: zero, XOR: defined(0.95) }, { decisionType: 3, zeroWeight: 'perde' });
  assert.equal(result.prediction, 'XOR');
  assert.deepEqual(result.zero_weight_candidates, ['A', 'B']);
  assert.deepEqual(result.decision.edge_weights, { A: 0, B: 0, XOR: 2 });
  assert.equal(
    result.decision.pairwise_decisions.find(p => p.candidate_j === 'A' && p.candidate_k === 'B').winner,
    null,
  );
});

test('sem peso perde: com duas cifras definidas, elas disputam entre si pela regra normal', () => {
  const result = decideScores({ A: zero, B: defined(0.9), C: defined(0.95) }, { decisionType: 3, zeroWeight: 'perde' });
  assert.equal(result.prediction, 'C');
  assert.deepEqual(result.decision.edge_weights, { A: 0, B: 1, C: 2 });
});

test('sem peso perde: Tipo 1 rejeita a hipótese sem peso; Tipo 2 escolhe a cifra com peso', () => {
  const t1 = decideScores({ A: zero, B: defined(0.9) }, { decisionType: 1, candidate: 'A', zeroWeight: 'perde' });
  assert.equal(t1.prediction, null);
  assert.equal(t1.abstention_reason, 'rejected_h0');
  assert.equal(t1.decision.zero_weight, true);
  assert.equal(decideScores({ A: zero, B: defined(0.9) }, { decisionType: 2, zeroWeight: 'perde' }).prediction, 'B');
  const limiar = { decisionType: 2, profile: 'chapter5-experiment2', alpha: 0.1, zeroWeight: 'perde' };
  assert.equal(decideScores({ A: zero, B: defined(0.95) }, limiar).prediction, 'B');
  assert.equal(decideScores({ A: zero, B: defined(0.5) }, limiar).abstention_reason, 'threshold_rejection');
});

test('sem peso perde: se todas ficam sem peso, a regra se abstém; valor inválido é recusado', () => {
  assert.equal(
    decideScores({ A: zero, B: zero }, { decisionType: 3, zeroWeight: 'perde' }).abstention_reason,
    'undefined_index',
  );
  assert.throws(() => decideScores({ A: defined(0.9), B: defined(0.8) }, { zeroWeight: 'talvez' }), /zeroWeight/);
});
