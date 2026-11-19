import path from 'node:path';
import { Cryptogram, normalizeCryptoterm, sortTerms } from './terms.js';
import { reliabilityIndexFromWeights, UndefinedIndexError, popcount32 } from './metrics.js';
import { decideScores } from './classification.js';
import { localFile, readJSON, readCiphertext } from './io.js';
export { localFile, readCiphertext } from './io.js';

export class ReferenceModel {
  static fromSamples(candidates) {
    if (!candidates || typeof candidates !== 'object' || Array.isArray(candidates))
      throw new TypeError('Candidatos devem ser um Map ou objeto');
    const entries = candidates instanceof Map ? [...candidates] : Object.entries(candidates);
    if (!entries.length) throw new Error('Base precisa de candidatos');
    const model = new ReferenceModel();
    model.labels = entries.map(([label]) => label);
    if (new Set(model.labels).size !== model.labels.length) throw new Error('Candidato duplicado');
    model.samples = [];
    model.sampleLabels = [];
    for (const [label, input] of entries) {
      if (typeof label !== 'string' || !label.trim() || label === 'SEM_CLASSE') throw new Error('Rótulo inválido');
      const groups = Array.from(input, g => new Set(Array.from(g, normalizeCryptoterm)));
      if (groups.length < 2 || groups.some(g => !g.size)) throw new Error(label + ': exige >=2 amostras não vazias');
      for (const sample of groups) {
        model.samples.push(sample);
        model.sampleLabels.push(label);
      }
    }
    model.memberships = new Map();
    model.samples.forEach((sample, index) => {
      for (const term of sample) {
        if (!model.memberships.has(term)) model.memberships.set(term, []);
        model.memberships.get(term).push(index);
      }
    });
    model.terms = sortTerms(model.memberships.keys());
    model.high = Uint32Array.from(model.terms, t => Number(t >> 32n));
    model.low = Uint32Array.from(model.terms, t => Number(t & 0xffffffffn));
    model.owners = model.terms.map(t => model.memberships.get(t));
    return model;
  }
  static load(manifest) {
    const content = readJSON(manifest);
    if (content.schema !== 1 || content.kind !== 'prepared_reference' || !Array.isArray(content.candidates))
      throw new Error('Referência inválida');
    const candidates = new Map();
    for (const candidate of content.candidates) {
      if (candidates.has(candidate.label)) throw new Error('Candidato duplicado');
      const groups = candidate.samples.map(files => {
        const terms = new Set();
        for (const file of files) {
          const c = Cryptogram.fromBytes(file, readCiphertext(localFile(path.dirname(manifest), file)));
          for (const t of c.terms) terms.add(t);
        }
        return terms;
      });
      candidates.set(candidate.label, groups);
    }
    return ReferenceModel.fromSamples(candidates);
  }
  select(input) {
    const labels = [...input];
    if (new Set(labels).size !== labels.length || labels.some(l => !this.labels.includes(l)))
      throw new Error('Seleção de candidatos inválida');
    return ReferenceModel.fromSamples(
      new Map(labels.map(label => [label, this.samples.filter((_, i) => this.sampleLabels[i] === label)])),
    );
  }
  weights(unknown) {
    if (!unknown.terms.length) throw new Error('Criptograma desconhecido vazio');
    const weights = Array(this.samples.length).fill(0);
    for (const term of unknown.terms) {
      const high = Number(term >> 32n),
        low = Number(term & 0xffffffffn);
      let minimum = 65,
        nearest = [];
      for (let i = 0; i < this.terms.length; i++) {
        const distance = popcount32(high ^ this.high[i]) + popcount32(low ^ this.low[i]);
        if (distance < minimum) {
          minimum = distance;
          nearest = [i];
        } else if (distance === minimum) nearest.push(i);
      }
      for (const index of nearest) for (const sample of this.owners[index]) weights[sample]++;
    }
    if (weights.some(w => !Number.isSafeInteger(w))) throw new RangeError('Peso fora da precisão inteira');
    return weights;
  }
  compare(unknown) {
    const weights = this.weights(unknown);
    return Object.fromEntries(
      this.labels.map(label => {
        const values = weights.filter((_, i) => this.sampleLabels[i] === label);
        let score;
        try {
          const r = reliabilityIndexFromWeights(values);
          score = { ...r, reference_value: 1 - r.value, error: null };
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
      }),
    );
  }
  predict(unknown, decisionType = 3, candidate = null, alpha = 0.1, profile = 'chapter3') {
    return decideScores(this.compare(unknown), { decisionType, candidate, alpha, profile });
  }
}
