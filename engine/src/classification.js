function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Índice deve ser finito');
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value === 'SEM_CLASSE')
    throw new TypeError('Rótulo deve ser texto não vazio e não reservado');
}
function significance(alpha) {
  finite(alpha);
  if (alpha < 0 || alpha > 1) throw new RangeError('alpha deve estar entre 0 e 1');
}
function entriesOf(value) {
  if (value instanceof Map) return [...value];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Candidatos devem ser um Map ou objeto de rótulos');
  return Object.entries(value);
}
function validateEntries(entries) {
  const seen = new Set();
  for (const [candidate] of entries) {
    label(candidate);
    if (seen.has(candidate)) throw new Error('Candidato duplicado');
    seen.add(candidate);
  }
}
export function type1Decision(confidence, alpha) {
  finite(confidence);
  significance(alpha);
  const reference_value = 1 - confidence;
  return { confidence, reference_value, alpha, reject_h0: reference_value > alpha };
}
export function type2Decision(candidate_j, confidence_j, candidate_k, confidence_k) {
  label(candidate_j);
  label(candidate_k);
  if (candidate_j === candidate_k) throw new Error('Tipo 2 exige candidatos distintos');
  finite(confidence_j);
  finite(confidence_k);
  const reference_j = 1 - confidence_j,
    reference_k = 1 - confidence_k;
  return {
    candidate_j,
    candidate_k,
    reference_j,
    reference_k,
    winner: reference_j < reference_k ? candidate_j : candidate_k,
  };
}
export function type3Decision(confidences) {
  const entries = entriesOf(confidences);
  validateEntries(entries);
  if (entries.length < 2) throw new RangeError('Tipo 3 exige ao menos dois candidatos');
  const weights = new Map(entries.map(([label]) => [label, 0])),
    pairwise_decisions = [];
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const decision = type2Decision(entries[i][0], entries[i][1], entries[j][0], entries[j][1]);
      pairwise_decisions.push(decision);
      weights.set(decision.winner, weights.get(decision.winner) + 1);
    }
  const greatest = Math.max(...weights.values());
  const leaders = [...weights].filter(([, w]) => w === greatest).map(([label]) => label);
  return {
    winner: leaders.length === 1 ? leaders[0] : null,
    edge_weights: Object.fromEntries(weights),
    pairwise_decisions,
  };
}

export function experimentalPairDecision(candidate_j, confidence_j, candidate_k, confidence_k, alpha = 0.1) {
  significance(alpha);
  const decision = type2Decision(candidate_j, confidence_j, candidate_k, confidence_k);
  const equal_reference_values = decision.reference_j === decision.reference_k;
  const threshold_rejected = decision.reference_j > alpha && decision.reference_k > alpha;
  const reason = equal_reference_values ? 'equal_reference_values' : threshold_rejected ? 'threshold_rejection' : null;
  return {
    ...decision,
    alpha,
    equal_reference_values,
    threshold_rejected,
    winner: reason ? null : decision.winner,
    reason,
  };
}

function zeroWeightDecision(result, values, labels, { decisionType, alpha, profile }) {
  const vr = name => (values.get(name) === null ? null : 1 - values.get(name));
  const missing = labels.filter(name => values.get(name) === null);
  result.zero_weight_candidates = missing;
  const pair = (j, k) => {
    if (values.get(j) !== null && values.get(k) !== null) return type2Decision(j, values.get(j), k, values.get(k));
    const winner = values.get(j) === null && values.get(k) === null ? null : values.get(j) === null ? k : j;
    return { candidate_j: j, candidate_k: k, reference_j: vr(j), reference_k: vr(k), winner, zero_weight: true };
  };
  if (decisionType === 1) {
    result.decision = { confidence: null, reference_value: null, alpha, reject_h0: true, zero_weight: true };
    result.status = 'rejected_h0';
    result.abstention_reason = 'rejected_h0';
  } else if (decisionType === 2) {
    const [j, k] = labels,
      decision = pair(j, k);
    if (profile === 'chapter5-experiment2') {
      const defined = decision.winner === null ? null : vr(decision.winner);
      const threshold_rejected = defined === null || defined > alpha;
      result.decision = {
        ...decision,
        alpha,
        equal_reference_values: false,
        threshold_rejected,
        winner: threshold_rejected ? null : decision.winner,
        reason: threshold_rejected ? 'threshold_rejection' : null,
      };
    } else result.decision = decision;
    result.prediction = result.decision.winner;
    if (result.prediction === null) {
      result.status = result.decision.reason ?? 'undefined_index';
      result.abstention_reason = result.status;
    }
  } else {
    const wins = new Map(labels.map(label => [label, 0])),
      pairwise_decisions = [];
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++) {
        const decision = pair(labels[i], labels[j]);
        pairwise_decisions.push(decision);
        if (decision.winner !== null) wins.set(decision.winner, wins.get(decision.winner) + 1);
      }
    const greatest = Math.max(...wins.values());
    const leaders = [...wins].filter(([, w]) => w === greatest).map(([label]) => label);
    result.decision = {
      winner: leaders.length === 1 ? leaders[0] : null,
      edge_weights: Object.fromEntries(wins),
      pairwise_decisions,
    };
    result.prediction = result.decision.winner;
    result.pairwise_ties = pairwise_decisions.filter(d => !d.zero_weight && d.reference_j === d.reference_k).length;
    if (result.prediction === null) {
      result.status = 'tied_graph';
      result.abstention_reason = 'tied_graph';
    }
  }
  return result;
}

export function decideScores(
  scores,
  { decisionType = 3, candidate = null, alpha = 0.1, profile = 'chapter3', zeroWeight = 'abster' } = {},
) {
  const entries = entriesOf(scores);
  validateEntries(entries);
  const labels = entries.map(([name]) => name);
  if (![1, 2, 3].includes(decisionType)) throw new RangeError('Decisão deve ser 1, 2 ou 3');
  if (!['chapter3', 'chapter5-experiment2'].includes(profile)) throw new Error('Perfil de decisão desconhecido');
  significance(alpha);
  if (profile === 'chapter5-experiment2' && decisionType !== 2)
    throw new Error('chapter5-experiment2 exige decisão Tipo 2');
  if (decisionType === 1 && !labels.includes(candidate)) throw new Error('Tipo 1 exige candidato existente');
  if (decisionType === 2 && entries.length !== 2) throw new Error('Tipo 2 exige dois candidatos');
  if (decisionType === 3 && entries.length < 2) throw new Error('Tipo 3 exige ao menos dois candidatos');
  if (!['abster', 'perde'].includes(zeroWeight)) throw new Error('zeroWeight deve ser abster ou perde');
  const values = new Map();
  for (const [name, score] of entries) {
    if (!score || typeof score !== 'object' || !Object.hasOwn(score, 'value'))
      throw new TypeError('Cada candidato exige um objeto com value');
    if (score.value !== null) finite(score.value);
    values.set(name, score.value);
  }
  const result = {
    decision_type: decisionType,
    profile,
    candidate_order: labels,
    scores: Object.fromEntries(entries),
    prediction: null,
    status: 'ok',
    abstention_reason: null,
    pairwise_ties: 0,
    decision: null,
    warning: 'Indice nao e probabilidade nem garantia de identificacao.',
  };
  const relevant = decisionType === 1 ? [candidate] : labels;
  const missing = relevant.filter(name => values.get(name) === null);
  if (missing.length && zeroWeight === 'perde' && (decisionType === 1 || missing.length < relevant.length)) {
    result.zero_weight_rule = 'perde';
    return zeroWeightDecision(result, values, labels, { decisionType, alpha, profile });
  }
  if (missing.length) {
    result.status = 'undefined_index';
    result.abstention_reason = 'undefined_index';
    return result;
  }
  if (decisionType === 1) {
    result.decision = type1Decision(values.get(candidate), alpha);
    result.prediction = result.decision.reject_h0 ? null : candidate;
    result.status = result.decision.reject_h0 ? 'rejected_h0' : 'not_rejected_h0';
    result.abstention_reason = result.decision.reject_h0 ? 'rejected_h0' : null;
  } else if (decisionType === 2) {
    const [j, k] = labels;
    result.decision =
      profile === 'chapter5-experiment2'
        ? experimentalPairDecision(j, values.get(j), k, values.get(k), alpha)
        : type2Decision(j, values.get(j), k, values.get(k));
    result.prediction = result.decision.winner;
    result.pairwise_ties = Number(result.decision.reference_j === result.decision.reference_k);
    if (result.prediction === null) {
      result.status = result.decision.reason;
      result.abstention_reason = result.decision.reason;
    }
  } else {
    result.decision = type3Decision(values);
    result.prediction = result.decision.winner;
    result.pairwise_ties = result.decision.pairwise_decisions.filter(d => d.reference_j === d.reference_k).length;
    if (result.prediction === null) {
      result.status = 'tied_graph';
      result.abstention_reason = 'tied_graph';
    }
  }
  return result;
}
