import test from 'node:test';
import assert from 'node:assert/strict';
import { decideScores, experimentalPairDecision, type2Decision, type3Decision } from '../src/classification.js';
import { Cryptogram } from '../src/terms.js';
import { ReferenceModel } from '../src/reference.js';

const scores = (a, b) => ({ A: { value: a }, B: { value: b } });

test('índices 0,49 e 0,51: Tipo 2 básico escolhe B; experimento rejeita por limiar', () => {
  assert.equal(type2Decision('A', 0.49, 'B', 0.51).winner, 'B');
  const r = experimentalPairDecision('A', 0.49, 'B', 0.51);
  assert.equal(r.winner, null);
  assert.equal(r.reason, 'threshold_rejection');
});
test('índices ainda mais próximos não criam margem artificial de abstenção', () => {
  const r = experimentalPairDecision('A', 0.95, 'B', 0.96);
  assert.equal(r.winner, 'B');
  assert.equal(r.reason, null);
});
test('empate exato difere entre Capítulo 3 e experimento 2', () => {
  assert.equal(decideScores(scores(0.95, 0.95), { decisionType: 2 }).prediction, 'B');
  const r = decideScores(scores(0.95, 0.95), { decisionType: 2, profile: 'chapter5-experiment2' });
  assert.equal(r.prediction, null);
  assert.equal(r.status, 'equal_reference_values');
  assert.equal(r.pairwise_ties, 1);
});
test('igualdade e rejeição simultâneas são registradas sem mudar a decisão', () => {
  const r = experimentalPairDecision('A', 0.2, 'B', 0.2);
  assert.equal(r.reason, 'equal_reference_values');
  assert.equal(r.equal_reference_values, true);
  assert.equal(r.threshold_rejected, true);
});
test('fronteira usa > literalmente, sem tolerância inventada', () => {
  const alpha = 1 - 0.9;
  const r = experimentalPairDecision('A', 0.9, 'B', 0.8, alpha);
  assert.equal(r.reference_j, alpha);
  assert.equal(r.winner, 'A');
  assert.equal(r.threshold_rejected, false);
  assert.equal(experimentalPairDecision('A', 0.9, 'B', 0.95, 0.1).winner, 'B');
});
test('alpha zero aceita VR zero; duas referências positivas rejeitam', () => {
  assert.equal(experimentalPairDecision('A', 1, 'B', 0.9, 0).winner, 'A');
  assert.equal(experimentalPairDecision('A', 0.95, 'B', 0.96, 0).reason, 'threshold_rejection');
});
test('índices não são normalizados para somar um nem limitados a [0,1]', () => {
  const r = decideScores(scores(-0.5, 1), { decisionType: 2 });
  assert.equal(r.scores.A.value, -0.5);
  assert.equal(r.decision.reference_j, 1.5);
  assert.equal(r.prediction, 'B');
});
test('Tipo 1 usa somente o índice do candidato explicitamente escolhido', () => {
  const r = decideScores(scores(1, null), { decisionType: 1, candidate: 'A', alpha: 0 });
  assert.equal(r.prediction, 'A');
  assert.equal(r.status, 'not_rejected_h0');
});
test('índice indefinido não remove candidato da disputa', () => {
  const r = decideScores(scores(0.95, null));
  assert.equal(r.prediction, null);
  assert.equal(r.status, 'undefined_index');
  assert.deepEqual(r.candidate_order, ['A', 'B']);
});
test('perfil experimental não é aplicado a Tipo 1 nem Tipo 3', () => {
  for (const decisionType of [1, 3])
    assert.throws(
      () => decideScores(scores(0.95, 0.96), { decisionType, candidate: 'A', profile: 'chapter5-experiment2' }),
      /Tipo 2/,
    );
});
test('configurações e resultados malformados são erros, não abstenções', () => {
  for (const input of [null, [], 'A']) assert.throws(() => decideScores(input));
  for (const input of [
    { A: { value: NaN }, B: { value: 0.9 } },
    { A: {}, B: { value: 1 } },
  ])
    assert.throws(() => decideScores(input));
  assert.throws(() => decideScores(scores(0.9, 0.8), { profile: 'typo' }));
  assert.throws(() => decideScores(scores(0.9, 0.8), { decisionType: 4 }));
  assert.throws(() => decideScores(scores(0.9, 0.8), { alpha: -1 }));
  assert.throws(() => decideScores(scores(0.9, 0.8), { decisionType: 1, candidate: 'C' }));
  assert.throws(() => decideScores({ A: { value: 1 } }, { decisionType: 2 }));
});
test('candidatos inválidos são rejeitados inclusive em pares diretos', () => {
  for (const value of ['', ' ', 1, 'SEM_CLASSE']) assert.throws(() => type2Decision(value, 0.8, 'B', 0.7));
  assert.throws(() => type2Decision('A', 0.8, 'A', 0.7));
  assert.throws(() => type3Decision({ A: 0.8, B: NaN }));
});
test('ordem declarada de Map preserva desempate, inclusive rótulos numéricos', () => {
  const r = decideScores(
    new Map([
      ['2', { value: 0.95 }],
      ['1', { value: 0.95 }],
    ]),
    { decisionType: 2 },
  );
  assert.deepEqual(r.candidate_order, ['2', '1']);
  assert.equal(r.prediction, '1');
});
test('ReferenceModel encaminha o perfil sem alterar pesos ou índices', () => {
  const m = ReferenceModel.fromSamples({ A: [[0], [1]], B: [[0], [1]] });
  const d = Cryptogram.fromTerms('D', [0, 1]);
  const basic = m.predict(d, 2),
    experiment = m.predict(d, 2, null, 0.1, 'chapter5-experiment2');
  assert.deepEqual(basic.scores, experiment.scores);
  assert.equal(basic.prediction, 'B');
  assert.equal(experiment.prediction, null);
  assert.equal(experiment.status, 'equal_reference_values');
});
