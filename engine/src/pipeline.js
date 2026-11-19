import { investigate } from './structural.js';
import { extractFeatures } from './features.js';
import { reliabilityIndex, UndefinedIndexError } from './metrics.js';
import { decideScores } from './classification.js';

export class LazarinModel {
  static fit(cryptograms) {
    const model = new LazarinModel();
    model.investigation = investigate(cryptograms);
    model.featureGroups = extractFeatures(model.investigation);
    return model;
  }
  get ungroupedTerms() {
    return new Set(this.investigation.ungrouped.flatMap(id => this.investigation.corpus.cryptogram(id).terms));
  }
  reliabilityForGroup(unknown, groupNumber) {
    const group = this.featureGroups.find(g => g.group_number === groupNumber);
    if (!group) throw new Error('Grupo inexistente: ' + groupNumber);
    return reliabilityIndex(
      unknown,
      group.samples.map(s => s.terms),
      this.investigation.corpus.terms,
      this.ungroupedTerms,
    );
  }
  compare(unknown) {
    return Object.fromEntries(
      this.featureGroups.map(group => {
        const key = 'delta_' + group.group_number;
        if (group.samples.length < 2) return [key, { value: null, weights: [], error: 'insufficient_samples' }];
        try {
          const r = this.reliabilityForGroup(unknown, group.group_number);
          return [key, { ...r, reference_value: 1 - r.value, error: null }];
        } catch (error) {
          if (!(error instanceof UndefinedIndexError)) throw error;
          return [
            key,
            {
              value: null,
              weights: Array(group.samples.length).fill(0),
              mean: 0,
              sample_standard_deviation: 0,
              reference_value: null,
              error: 'zero_mean',
            },
          ];
        }
      }),
    );
  }
  predict(unknown, options = {}, candidate = null, alpha = 0.1, profile = 'chapter3') {
    if (typeof options === 'number') options = { decisionType: options, candidate, alpha, profile };
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Opções inválidas');
    const decisionType = options.decisionType ?? 3;
    const selectedProfile = options.profile ?? 'chapter3';
    const selectedAlpha = options.alpha ?? 0.1;
    if (![1, 2, 3].includes(decisionType)) throw new RangeError('Decisão deve ser 1, 2 ou 3');
    if (!['chapter3', 'chapter5-experiment2'].includes(selectedProfile))
      throw new Error('Perfil de decisão desconhecido');
    if (selectedProfile === 'chapter5-experiment2' && decisionType !== 2)
      throw new Error('chapter5-experiment2 exige decisão Tipo 2');
    if (!Number.isFinite(selectedAlpha) || selectedAlpha < 0 || selectedAlpha > 1)
      throw new RangeError('alpha deve estar entre 0 e 1');
    const scores = this.compare(unknown);
    const required = decisionType === 1 ? 1 : 2;
    if (this.featureGroups.length < required)
      return {
        decision_type: decisionType,
        profile: selectedProfile,
        candidate_order: Object.keys(scores),
        scores,
        prediction: null,
        status: 'insufficient_reference_structure',
        abstention_reason: 'insufficient_reference_structure',
        pairwise_ties: 0,
        decision: null,
        warning: 'Indice nao e probabilidade nem garantia de identificacao.',
      };
    return decideScores(scores, options);
  }
  classifyType3(unknown) {
    const result = this.predict(unknown, { decisionType: 3 });
    return { ...result, results: result.scores };
  }
}
