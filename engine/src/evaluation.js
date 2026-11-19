import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Cryptogram } from './terms.js';
import { LazarinModel } from './pipeline.js';
import { ReferenceModel } from './reference.js';
import { UndefinedIndexError } from './metrics.js';
import { validateDataset } from './dataset.js';
import { localFile, readCiphertext, createOutput, writeJSON } from './io.js';
import { referenceTermStats } from './scale.js';

export const DEFAULT_MAX_COMPARISONS = 200_000_000;
const ABSTAIN = 'SEM_CLASSE';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function guardCost(estimate, { allowExpensive = false, maxComparisons = DEFAULT_MAX_COMPARISONS } = {}) {
  if (!Number.isSafeInteger(estimate) || estimate < 0)
    throw new Error('Estimativa de comparações fora do intervalo seguro');
  if (!Number.isSafeInteger(maxComparisons) || maxComparisons < 1) throw new Error('Limite de comparações inválido');
  if (estimate > maxComparisons && !allowExpensive)
    throw new Error(
      `Estimativa de ${estimate.toLocaleString('en-US')} comparações de Hamming excede o limite de ${maxComparisons.toLocaleString('en-US')}. Use um protocolo menor ou --allow-expensive para executar conscientemente o ensaio maior.`,
    );
}

export function summarize(rows, labels) {
  const columns = [...labels, ABSTAIN];
  const matrix = Object.fromEntries(labels.map(a => [a, Object.fromEntries(columns.map(b => [b, 0]))]));
  const reasons = {};
  for (const row of rows) {
    if (!Object.hasOwn(matrix, row.actual)) throw new Error('Gabarito contém classe fora do recorte');
    const column = row.prediction ?? ABSTAIN;
    if (!Object.hasOwn(matrix[row.actual], column)) throw new Error('Previsão contém classe fora do recorte');
    matrix[row.actual][column]++;
    if (row.prediction === null) reasons[row.status] = (reasons[row.status] ?? 0) + 1;
  }
  const total = rows.length,
    classified = rows.filter(r => r.prediction !== null).length;
  const correct = rows.filter(r => r.prediction === r.actual).length;
  const perClass = Object.fromEntries(
    labels.map(label => {
      const tp = matrix[label][label];
      const predicted = labels.reduce((n, actual) => n + matrix[actual][label], 0);
      const actual = columns.reduce((n, col) => n + matrix[label][col], 0);
      return [
        label,
        {
          true_positive: tp,
          actual,
          predicted,
          precision: predicted ? tp / predicted : null,
          recall: actual ? tp / actual : null,
        },
      ];
    }),
  );
  return {
    total,
    correct,
    errors: classified - correct,
    classified,
    abstained: total - classified,
    accuracy: total ? correct / total : null,
    coverage: total ? classified / total : null,
    accuracy_when_classified: classified ? correct / classified : null,
    abstention_reasons: reasons,
    confusion_matrix: matrix,
    per_class: perClass,
  };
}

function writeRows(file, rows) {
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { flag: 'wx' });
}
const percent = value => (value === null ? 'indefinida' : (100 * value).toFixed(2) + '%');
function reportText(result) {
  const { prepared, structural, dataset, configuration } = result;
  const lines = [
    '# Avaliação do experimento controlado',
    '',
    'Estudo baseado no método de Lazarin (2012). Estes resultados não são uma réplica quantitativa do experimento de 2012.',
    '',
    `- Algoritmos: ${configuration.candidates.join(', ')}. CBC, chaves de 128 bits, blocos de 64 bits.`,
    `- Fonte: Bíblia, SHA-256 ${dataset.source_sha256}.`,
    `- Trechos de ${dataset.text_bytes} bytes; semente ${dataset.seed}; ${dataset.reference_files} arquivos de referência e ${prepared.total} testes.`,
    `- Referência: ${result.reference_terms.occurrences} ocorrências; ${result.reference_terms.distinct} criptotermos distintos medidos.`,
    `- Controle preparado: ${configuration.profile}, decisão Tipo ${configuration.decision_type}, alfa ${configuration.alpha}.`,
    '- Fluxo estrutural: investigação, coloração e decisão Tipo 3 do Capítulo 3. Rótulos só entram na avaliação posterior dos grupos.',
    '',
    '| Medida | Referência preparada | Fluxo estrutural |',
    '|---|---:|---:|',
    `| Acertos / total | ${prepared.correct}/${prepared.total} | ${structural.correct}/${structural.total} |`,
    `| Acurácia global | ${percent(prepared.accuracy)} | ${percent(structural.accuracy)} |`,
    `| Cobertura | ${percent(prepared.coverage)} | ${percent(structural.coverage)} |`,
    `| Acurácia entre classificados | ${percent(prepared.accuracy_when_classified)} | ${percent(structural.accuracy_when_classified)} |`,
    `| Abstenções | ${prepared.abstained} | ${structural.abstained} |`,
    '',
    '## Estrutura encontrada',
    '',
    `Arestas: ${result.structure.edge_count}; grupos: ${result.structure.groups.length}; isolados: ${result.structure.ungrouped_count}.`,
    '',
    '## Motivos sem classificação',
    '',
    'Referência preparada: `' + JSON.stringify(prepared.abstention_reasons) + '`. ',
    'Fluxo estrutural: `' + JSON.stringify(structural.abstention_reasons) + '`. ',
    '',
    '## Matriz de confusão do controle preparado',
    '',
    '| Real / previsto | ' + [...configuration.candidates, ABSTAIN].join(' | ') + ' |',
    '|---|' + [...configuration.candidates, ABSTAIN].map(() => '---:|').join(''),
  ];
  for (const label of configuration.candidates)
    lines.push(
      '| ' +
        label +
        ' | ' +
        [...configuration.candidates, ABSTAIN].map(col => prepared.confusion_matrix[label][col]).join(' | ') +
        ' |',
    );
  lines.push(
    '',
    '## Interpretação',
    '',
    'O índice não é probabilidade de acerto. Não foi adicionada uma margem 49/51 ou regra de sobreposição de desvios.',
    'Amostras preparadas são uma convenção experimental por partição de chaves. Elas não substituem a investigação e a coloração do fluxo automático.',
    'Acurácia e cobertura usam denominadores explícitos. Ausência de estrutura e índice indefinido permanecem separados de empate e rejeição.',
    'Os mesmos textos são usados entre cifras e os casos são pareados. Não há teste de significância nem demonstração automática de generalização.',
    'Tempo e memória dependem da máquina e não são métricas determinísticas do conjunto de dados.',
    '',
    `Tempo total da avaliação: ${result.execution.elapsed_ms.toFixed(1)} ms. Pico RSS observado pelo Node: ${result.execution.max_rss_bytes} bytes.`,
    `Estimativa do controle preparado: ${configuration.estimated_hamming_comparisons} comparações de termos.`,
    '',
    'Detalhes por arquivo: prepared.jsonl e structural.jsonl. Configuração e métricas completas: results.json.',
    '',
  );
  return lines.join('\n');
}

export function evaluateDataset(datasetDir, output, options = {}) {
  const started = performance.now();
  const manifest = validateDataset(datasetDir);
  const validationEnded = performance.now();
  const labels = options.candidates ?? manifest.algorithms;
  if (
    !Array.isArray(labels) ||
    labels.length < 2 ||
    new Set(labels).size !== labels.length ||
    labels.some(label => !manifest.algorithms.includes(label))
  )
    throw new Error('Candidatos inválidos para avaliação');
  const decisionType = options.decisionType ?? 3,
    profile = options.profile ?? 'chapter3',
    alpha = options.alpha ?? 0.1;
  if (![2, 3].includes(decisionType) || (decisionType === 2 && labels.length !== 2))
    throw new Error('Avaliação exige Tipo 3 ou Tipo 2 com dois candidatos');
  if (
    !['chapter3', 'chapter5-experiment2'].includes(profile) ||
    (profile === 'chapter5-experiment2' && decisionType !== 2)
  )
    throw new Error('Perfil incompatível com a decisão');
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error('Alfa inválido');
  const loaded = ReferenceModel.load(path.join(datasetDir, 'reference.json'));
  const model =
    labels.length === loaded.labels.length && labels.every((label, i) => label === loaded.labels[i])
      ? loaded
      : loaded.select(labels);
  const referenceLoaded = performance.now();
  const testRecords = manifest.records.filter(r => r.split === 'test' && labels.includes(r.algorithm));
  const referenceRecords = manifest.records.filter(r => r.split === 'reference' && labels.includes(r.algorithm));
  const estimate = testRecords.reduce((n, r) => n + (r.bytes / 8) * model.terms.length, 0);
  guardCost(estimate, options);
  const cryptograms = referenceRecords.map((r, index) =>
    Cryptogram.fromBytes('ref-' + index, readCiphertext(localFile(datasetDir, r.path))),
  );
  const automatic = LazarinModel.fit(cryptograms);
  const structureBuilt = performance.now();
  const referenceTerms = referenceTermStats(model, referenceRecords);
  const referenceCounted = performance.now();
  createOutput(output);
  const preparedRows = [],
    structuralRows = [];
  let preparedPredictionMs = 0,
    structuralPredictionMs = 0;
  const truthById = new Map(referenceRecords.map((r, index) => ['ref-' + index, r.algorithm]));
  for (let index = 0; index < testRecords.length; index++) {
    const record = testRecords[index];
    const unknown = Cryptogram.fromBytes('teste-' + index, readCiphertext(localFile(datasetDir, record.path)));
    const caseStart = performance.now();
    const preparedResult = model.predict(unknown, decisionType, null, alpha, profile);
    const preparedEnded = performance.now();
    preparedPredictionMs += preparedEnded - caseStart;
    let structuralResult;
    if (automatic.featureGroups.length < 2) {
      structuralResult = {
        prediction: null,
        group_prediction: null,
        scores: {},
        status: 'insufficient_reference_structure',
      };
    } else {
      try {
        const result = automatic.predict(unknown, 3, null, alpha, 'chapter3');
        const groupId = result.prediction;
        let prediction = null,
          status = result.status;
        if (groupId !== null) {
          const group = automatic.featureGroups.find(g => 'delta_' + g.group_number === groupId);
          const trueLabels = new Set(group.cryptogram_ids.map(id => truthById.get(id)));
          if (trueLabels.size === 1) prediction = [...trueLabels][0];
          else status = 'mixed_reference_group';
        }
        structuralResult = { ...result, group_prediction: groupId, prediction, status };
      } catch (error) {
        if (!(error instanceof UndefinedIndexError)) throw error;
        structuralResult = { prediction: null, group_prediction: null, scores: {}, status: 'undefined_index' };
      }
    }
    structuralPredictionMs += performance.now() - preparedEnded;
    preparedRows.push({ id: record.id, path: record.path, actual: record.algorithm, ...preparedResult });
    structuralRows.push({ id: record.id, path: record.path, actual: record.algorithm, ...structuralResult });
    options.onProgress?.({ completed: index + 1, total: testRecords.length, case_ms: performance.now() - caseStart });
  }
  const groups = automatic.featureGroups.map(g => ({
    id: 'delta_' + g.group_number,
    members: g.cryptogram_ids,
    samples: g.samples.map(s => ({ color: s.color, members: s.cryptogram_ids, terms: s.terms.size })),
  }));
  const result = {
    schema: 2,
    kind: 'controlled_bible_evaluation',
    artifact_version: '0.6.0',
    dataset: {
      source_sha256: manifest.corpus.raw_sha256,
      manifest_sha256: sha256(fs.readFileSync(path.join(datasetDir, 'manifest.json'))),
      text_bytes: manifest.config.textBytes,
      seed: manifest.config.seed,
      reference_files: referenceRecords.length,
    },
    configuration: {
      candidates: labels,
      decision_type: decisionType,
      profile,
      alpha,
      estimated_hamming_comparisons: estimate,
      automatic_decision_type: 3,
      automatic_profile: 'chapter3',
    },
    reference_terms: referenceTerms,
    prepared: summarize(preparedRows, labels),
    structural: summarize(structuralRows, labels),
    structure: {
      edge_count: automatic.investigation.intersections.length,
      ungrouped_count: automatic.investigation.ungrouped.length,
      groups,
    },
    execution: {
      elapsed_ms: performance.now() - started,
      max_rss_bytes: process.resourceUsage().maxRSS * 1024,
      phases_ms: {
        validate_dataset: validationEnded - started,
        load_reference: referenceLoaded - validationEnded,
        structural_fit: structureBuilt - referenceLoaded,
        count_reference_terms: referenceCounted - structureBuilt,
        prepared_prediction: preparedPredictionMs,
        structural_prediction: structuralPredictionMs,
      },
      node: process.version,
      openssl: process.versions.openssl,
      platform: process.platform,
      architecture: process.arch,
    },
    interpretation: 'Estudo controlado com chaves iguais; não é réplica exata de 2012. Índice não é probabilidade.',
  };
  writeRows(path.join(output, 'prepared.jsonl'), preparedRows);
  writeRows(path.join(output, 'structural.jsonl'), structuralRows);
  writeJSON(path.join(output, 'results.json'), result);
  fs.writeFileSync(path.join(output, 'report.md'), reportText(result), { flag: 'wx' });
  return result;
}

export function inspectDataset(datasetDir) {
  const manifest = validateDataset(datasetDir);
  const references = manifest.records.filter(r => r.split === 'reference');
  const model = ReferenceModel.load(path.join(datasetDir, 'reference.json'));
  const automatic = LazarinModel.fit(
    references.map((r, index) => Cryptogram.fromBytes('ref-' + index, readCiphertext(localFile(datasetDir, r.path)))),
  );
  return {
    algorithms: manifest.algorithms,
    crypto: manifest.crypto,
    corpus: manifest.corpus,
    config: manifest.config,
    reference_files: references.length,
    test_files: manifest.records.length - references.length,
    reference_terms: referenceTermStats(model, references),
    structural: {
      edges: automatic.investigation.intersections.length,
      groups: automatic.featureGroups.length,
      ungrouped: automatic.investigation.ungrouped.length,
    },
    warning: 'A inspeção estrutural não usa rótulos para formar grupos.',
  };
}
