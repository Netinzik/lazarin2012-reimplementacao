import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToUI } from 'node:timers/promises';
import { Cryptogram } from '../engine/src/terms.js';
import { reliabilityIndexFromWeights, UndefinedIndexError, popcount32 } from '../engine/src/metrics.js';
import { decideScores } from '../engine/src/classification.js';

function checkAbort(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Classificação cancelada antes de produzir uma decisão.', {
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

export async function tracePrediction(model, unknown, {
  decisionType = 3,
  candidate = null,
  alpha = 0.1,
  profile = 'chapter3',
  zeroWeight = 'abster',
  chunkSize = 32,
  onProgress = () => { },
  signal,
} = {}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError('chunkSize deve ser um inteiro positivo seguro.');
  }
  if (typeof onProgress !== 'function') {
    throw new TypeError('onProgress deve ser uma função.');
  }
  checkAbort(signal);
  const total = unknown.terms.length;
  if (!total) throw new Error('Criptograma desconhecido vazio');
  const estimatedComparisons = total * model.terms.length;
  if (!Number.isSafeInteger(estimatedComparisons)) {
    throw new RangeError('Estimativa de comparações excedeu a precisão inteira.');
  }
  const started = performance.now();
  const weights = Array(model.samples.length).fill(0);

  for (let offset = 0; offset < total; offset += chunkSize) {
    checkAbort(signal);
    const end = Math.min(offset + chunkSize, total);
    const part = Cryptogram.fromTerms(
      unknown.identifier || 'parte-desconhecida',
      unknown.terms.slice(offset, end),
    );
    const partial = model.weights(part);
    for (let i = 0; i < weights.length; i++) {
      weights[i] += partial[i];
      if (!Number.isSafeInteger(weights[i])) {
        throw new RangeError('Peso fora da precisão inteira');
      }
    }
    onProgress({
      processed: end,
      total,
      comparisons: end * model.terms.length,
      estimatedComparisons,
      elapsedMs: performance.now() - started,
      percent: end / total * 100,
    });
    checkAbort(signal);
    await yieldToUI();
    checkAbort(signal);
  }

  const scores = Object.fromEntries(model.labels.map(label => {
    const values = weights.filter((_, i) => model.sampleLabels[i] === label);
    let score;
    try {
      const result = reliabilityIndexFromWeights(values);
      score = { ...result, reference_value: 1 - result.value, error: null };
    } catch (error) {
      if (!(error instanceof UndefinedIndexError)) throw error;
      score = {
        weights: values,
        mean: 0,
        sample_standard_deviation: 0,
        value: null,
        reference_value: null,
        error: 'zero_mean',
      };
    }
    return [label, score];
  }));
  return decideScores(scores, { decisionType, candidate, alpha, profile, zeroWeight });
}

export function summarizeCandidates(model) {
  const summaries = new Map(model.labels.map(label => {
    const sampleTerms = model.samples
      .filter((_, i) => model.sampleLabels[i] === label)
      .map(sample => sample.size);
    return [label, {
      label,
      sampleCount: sampleTerms.length,
      sampleTerms,
      distinctTerms: 0,
    }];
  }));

  for (const owners of model.memberships.values()) {
    if (owners.length === 1) {
      summaries.get(model.sampleLabels[owners[0]]).distinctTerms++;
    } else {
      const labels = new Set(owners.map(index => model.sampleLabels[index]));
      for (const label of labels) summaries.get(label).distinctTerms++;
    }
  }
  return [...summaries.values()];
}

export function structuralPredictor(model) {
  const terms = [...model.investigation.corpus.terms];
  const index = new Map(terms.map((term, i) => [term, i]));
  const high = Uint32Array.from(terms, t => Number(t >> 32n));
  const low = Uint32Array.from(terms, t => Number(t & 0xffffffffn));
  const excluded = new Uint8Array(terms.length);
  for (const term of model.ungroupedTerms) excluded[index.get(term)] = 1;
  const groups = model.featureGroups.map(group => ({
    key: 'delta_' + group.group_number,
    samples: group.samples.map(sample => Int32Array.from(sample.terms, term => index.get(term))),
  }));
  return (unknown, { zeroWeight = 'abster' } = {}) => {
    const weights = groups.map(g => new Array(g.samples.length).fill(0));
    const distance = new Uint8Array(terms.length), histogram = new Int32Array(65), inSample = new Int32Array(65);
    for (const term of unknown.terms) {
      const h = Number(term >> 32n), l = Number(term & 0xffffffffn);
      histogram.fill(0);
      for (let i = 0; i < terms.length; i++) {
        const d = popcount32(h ^ high[i]) + popcount32(l ^ low[i]);
        distance[i] = d;
        if (!excluded[i]) histogram[d]++;
      }
      for (let g = 0; g < groups.length; g++) {
        const samples = groups[g].samples;
        if (samples.length < 2) continue;
        for (let s = 0; s < samples.length; s++) {
          const sample = samples[s];
          let nearest = 64, edge = 0;
          inSample.fill(0);
          for (let j = 0; j < sample.length; j++) {
            const d = distance[sample[j]];
            if (d < nearest) { nearest = d; edge = 1; } else if (d === nearest) edge++;
            if (!excluded[sample[j]]) inSample[d]++;
          }
          let rest = 64;
          for (let k = 0; k < 64; k++) if (histogram[k] - inSample[k] > 0) { rest = k; break; }
          if (nearest <= rest) weights[g][s] += edge;
        }
      }
    }
    const scores = Object.fromEntries(groups.map((group, g) => {
      if (group.samples.length < 2) return [group.key, { value: null, weights: [], error: 'insufficient_samples' }];
      try {
        const result = reliabilityIndexFromWeights(weights[g]);
        return [group.key, { ...result, reference_value: 1 - result.value, error: null }];
      } catch (error) {
        if (!(error instanceof UndefinedIndexError)) throw error;
        return [group.key, {
          value: null, weights: Array(group.samples.length).fill(0),
          mean: 0, sample_standard_deviation: 0, reference_value: null, error: 'zero_mean'
        }];
      }
    }));
    if (groups.length < 2)
      return {
        decision_type: 3, profile: 'chapter3', candidate_order: Object.keys(scores), scores, prediction: null,
        status: 'insufficient_reference_structure', abstention_reason: 'insufficient_reference_structure',
        pairwise_ties: 0, decision: null, warning: 'Indice nao e probabilidade nem garantia de identificacao.'
      };
    return decideScores(scores, { decisionType: 3, zeroWeight });
  };
}
