import { Cryptogram, normalizeCryptoterm } from './terms.js';

export function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
export function hammingDistance(a, b) {
  const x = normalizeCryptoterm(a) ^ normalizeCryptoterm(b);
  return popcount32(Number(x & 0xffffffffn)) + popcount32(Number(x >> 32n));
}
const unknownTerms = d => d instanceof Cryptogram ? d.terms : Array.from(d, normalizeCryptoterm);

export function edgeWeight(unknown, sampleTerms, allTerms, ungroupedTerms = []) {
  const sample = new Set(Array.from(sampleTerms, normalizeCryptoterm));
  if (!sample.size) throw new Error('tau deve conter ao menos um criptotermo');
  const excluded = new Set(Array.from(ungroupedTerms, normalizeCryptoterm));
  const competitors = [...new Set(Array.from(allTerms, normalizeCryptoterm))]
    .filter(t => !sample.has(t) && !excluded.has(t));
  let weight = 0;
  for (const d of unknownTerms(unknown)) {
    let distD = 64, distT = 64, edge = 0;
    for (const t of sample) {
      const distance = hammingDistance(d, t);
      if (distance < distD) { distD = distance; edge = 1; }
      else if (distance === distD) edge++;
    }
    for (const t of competitors) distT = Math.min(distT, hammingDistance(d, t));
    if (distD <= distT) weight += edge;
  }
  if (!Number.isSafeInteger(weight)) throw new RangeError('Peso excedeu precisão inteira de Number');
  return weight;
}
export const peso = edgeWeight;

export function accurateSum(values) {
  const partials = [];
  for (let x of values) {
    let i = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y, lo = y - (hi - x);
      if (lo) partials[i++] = lo;
      x = hi;
    }
    partials.length = i;
    partials.push(x);
  }
  return partials.reduceRight((a, b) => a + b, 0);
}
export class UndefinedIndexError extends Error {
  constructor() { super('Índice indefinido: média dos pesos zero'); this.code = 'zero_mean'; }
}
export function reliabilityIndexFromWeights(input) {
  const weights = [...input];
  if (weights.length < 2) throw new RangeError('Índice exige ao menos duas amostras');
  if (weights.some(w => typeof w !== 'number' || !Number.isFinite(w) || w < 0))
    throw new TypeError('Pesos devem ser números finitos e não negativos');
  const mean = accurateSum(weights) / weights.length;
  if (mean === 0) throw new UndefinedIndexError();
  const variance = accurateSum(weights.map(w => (w - mean) ** 2)) / (weights.length - 1);
  const sample_standard_deviation = Math.sqrt(variance);
  const value = 1 - sample_standard_deviation / mean;
  if (![mean, sample_standard_deviation, value].every(Number.isFinite))
    throw new RangeError('Cálculo excedeu o intervalo numérico');
  return { weights, mean, sample_standard_deviation, value };
}
export function reliabilityIndex(unknown, samples, allTerms, ungroupedTerms = []) {
  const d = unknownTerms(unknown), all = [...allTerms], excluded = [...ungroupedTerms];
  return reliabilityIndexFromWeights(Array.from(samples, sample => edgeWeight(d, sample, all, excluded)));
}
