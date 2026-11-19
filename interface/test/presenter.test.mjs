import test from 'node:test';
import assert from 'node:assert/strict';
import {
  text, decimal, short, listJoin, formatTermsPreview, ruleShort, renderReferenceList, renderPreparedReference,
  renderStructuralStep, renderInput, renderScores, renderDecision, renderVerdict, renderControl, renderStudyResults,
  duration, renderCompactCase, renderBatchSummary,
} from '../presenter.mjs';
import { structuralControls } from '../../engine/src/diagnostics.js';

const summary = [
  { label: 'Blowfish', sampleCount: 2, sampleTerms: [12, 12], distinctTerms: 24 },
  { label: 'RC2', sampleCount: 2, sampleTerms: [12, 12], distinctTerms: 24 },
];
function basicResult() {
  return {
    decision_type: 2, profile: 'chapter3', candidate_order: ['Blowfish', 'RC2'],
    scores: {
      Blowfish: {
        weights: [135, 226], mean: 180.5,
        sample_standard_deviation: 64.34671708797582,
        value: 0.6435084925873915, reference_value: 0.3564915074126085, error: null
      },
      RC2: {
        weights: [4, 4], mean: 4, sample_standard_deviation: 0,
        value: 1, reference_value: 0, error: null
      },
    },
    prediction: 'RC2', status: 'ok', abstention_reason: null,
    decision: {
      candidate_j: 'Blowfish', reference_j: 0.3564915074126085,
      candidate_k: 'RC2', reference_k: 0, winner: 'RC2'
    },
  };
}

test('números seguem o formato brasileiro e indefinido nunca vira zero', () => {
  assert.equal(decimal(0.6435084925873915), '0,6435');
  assert.equal(decimal(180.5, 2), '180,50');
  assert.equal(decimal(null), 'indefinido');
  assert.equal(decimal(undefined), '—');
  assert.equal(decimal(NaN), 'inválido (NaN)');
  assert.equal(short(0.1), '0,1');
  assert.equal(short(1), '1');
  assert.equal(listJoin(['Blowfish', 'RC2', 'CAST5'], 'ou'), 'Blowfish, RC2 ou CAST5');
});

test('prévia mostra criptotermos de 8 bytes em hex, sem alterar a entrada', () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.equal(formatTermsPreview(bytes, 2), '0001020304050607  08090a0b0c0d0e0f  … (+2)');
  assert.equal(formatTermsPreview(bytes, 4), '0001020304050607  08090a0b0c0d0e0f  1011121314151617  18191a1b1c1d1e1f');
  assert.equal(formatTermsPreview(new Uint8Array(3)), '(nenhum criptotermo)');
  assert.equal(bytes[31], 31);
  assert.throws(() => formatTermsPreview('0001'), /Buffer\/Uint8Array/);
  for (const limit of [-1, 0.5, NaN]) assert.throws(() => formatTermsPreview(bytes, limit), /shown/);
});

test('entrada mostra tamanho, criptotermos e esconde o gabarito; desalinhada não é corrigida', () => {
  const output = renderInput(Buffer.alloc(16));
  assert.match(output, /16 bytes → 2 criptotermos de 8 bytes/);
  assert.match(output, /escondida até o passo \[8\]/);
  assert.match(renderInput(Buffer.alloc(3)), /não é múltiplo de 8/);
  assert.match(renderInput(Buffer.alloc(8), { hidden: false }), /Arquivo externo: não há gabarito/);
});

test('amostras preparadas são listadas por cifra, sem virar "grupo RC2"', () => {
  const lines = renderReferenceList(summary).join('\n');
  assert.match(lines, /RC2 +2 amostras de 12 termos · 24 distintos/);
  assert.doesNotMatch(lines, /grupo RC2|grupo Blowfish/i);
  assert.match(renderReferenceList([{ label: 'A', sampleCount: 2, sampleTerms: [3, 5], distinctTerms: 8 }]).join(''),
    /2 amostras \(3, 5 termos\)/);
  assert.match(renderReferenceList([]).join(''), /Nenhuma amostra/);
  assert.throws(() => renderReferenceList({}), /lista/);
  assert.throws(() => renderReferenceList([{ label: '' }]), /label/);
  assert.match(renderPreparedReference(summary, { keys: 10, samples: 5 }), /Sem grupos automáticos.*\n.*10 chaves.*5 amostras/);
  assert.match(renderPreparedReference(summary, { reorganizedFor: ['Blowfish', 'RC2'] }), /reorganizada para Blowfish e RC2/);
});

test('estrutura sem ligações explica a ausência de grupos sem inventar nomes de cifra', () => {
  const output = renderStructuralStep({ edges: 0, groups: 0, ungrouped: 60 });
  assert.match(output, /criptotermo IDÊNTICO/);
  assert.match(output, /Ligações: 0 · Grupos: 0 · Arquivos isolados: 60/);
  assert.match(output, /Nenhum criptotermo se repete/);
  assert.match(renderStructuralStep({ edge_count: 2, groups: [['a', 'b'], ['c', 'd']], ungrouped: [] }),
    /2 grupos, nomeados delta_1.*não são nomes de cifras/);
  assert.throws(() => renderStructuralStep(null), /objeto/);
});

test('tabela preserva pesos, média, desvio, I e VR, sem porcentagem', () => {
  const input = basicResult();
  const before = structuredClone(input);
  const output = renderScores(input);
  assert.match(output, /Blowfish +135, 226 +180,50 +64,347 +0,6435 +0,3565/);
  assert.match(output, /RC2 +4, 4 +4,00 +0,000 +1,0000 +0,0000/);
  assert.match(output, /não é probabilidade de acerto/);
  assert.doesNotMatch(output, /%|\x1b/);
  assert.deepEqual(input, before);
});

test('índice indefinido e negativo são exibidos como calculados, sem truncar', () => {
  const output = renderScores({
    scores: {
      RC2: { weights: [0, 0], mean: 0, sample_standard_deviation: 0, value: null, reference_value: null, error: 'zero_mean' },
      A: { weights: [0, 2], value: -0.41421356237309515 },
    }
  });
  assert.match(output, /RC2 +0, 0 +0,00 +0,000 +indefinido +indefinido/);
  assert.match(output, /média dos pesos é zero; o índice fica indefinido/);
  assert.match(output, /-0,4142 +1,4142/);
  assert.match(renderScores({}), /Nenhum peso/);
});

test('Tipo 1 rejeita com VR > alfa e não trata não rejeição como confirmação', () => {
  const rejected = renderDecision({
    decision_type: 1, profile: 'chapter3', prediction: null, status: 'rejected_h0',
    decision: { reference_value: 0.4482, alpha: 0.1, reject_h0: true }
  }, { hypothesis: 'RC2' });
  assert.match(rejected, /VR de RC2 = 0,4482 > alfa 0,1 → hipótese rejeitada/);
  assert.match(rejected, /PREVISÃO: SEM CLASSE \(hipótese rejeitada\)/);
  const kept = renderDecision({
    decision_type: 1, profile: 'chapter3', prediction: 'RC2', status: 'not_rejected_h0',
    decision: { reference_value: 0.05, alpha: 0.1, reject_h0: false }
  }, { hypothesis: 'RC2' });
  assert.match(kept, /≤ alfa 0,1 → hipótese não rejeitada/);
  assert.match(kept, /isso não a confirma/);
});

test('Tipo 2 básico escolhe o menor VR e explica o desempate pelo segundo', () => {
  assert.match(renderDecision(basicResult()), /Blowfish × RC2 +0,3565 vs 0,0000 +→ RC2/);
  const tie = renderDecision({
    decision_type: 2, profile: 'chapter3', prediction: 'B',
    decision: { candidate_j: 'A', reference_j: 0.1, candidate_k: 'B', reference_k: 0.1, winner: 'B' }
  });
  assert.match(tie, /→ B \(empate: vale o segundo da ordem\)/);
});

test('valores diferentes nunca aparecem iguais por causa do arredondamento', () => {
  const output = renderDecision({
    decision_type: 2, profile: 'chapter3', prediction: 'A',
    decision: { candidate_j: 'A', reference_j: 0.123441, candidate_k: 'B', reference_k: 0.123449, winner: 'A' }
  });
  assert.match(output, /0,12344 vs 0,12345/);
});

test('regra com limiar: os dois VR acima de alfa ficam sem classe; sem margem de proximidade', () => {
  const output = renderDecision({
    decision_type: 2, profile: 'chapter5-experiment2',
    prediction: null, status: 'threshold_rejection', abstention_reason: 'threshold_rejection',
    decision: {
      candidate_j: 'A', reference_j: 0.51, candidate_k: 'B', reference_k: 0.49,
      winner: null, alpha: 0.1, threshold_rejected: true, equal_reference_values: false, reason: 'threshold_rejection'
    }
  });
  assert.match(output, /A +VR 0,5100 > alfa 0,1/);
  assert.match(output, /os dois VR passaram do limiar/);
  assert.match(output, /PREVISÃO: SEM CLASSE/);
  assert.doesNotMatch(output, /probabilidade|margem/);
  const accepted = renderDecision({
    decision_type: 2, profile: 'chapter5-experiment2', prediction: 'A', status: 'ok',
    decision: {
      candidate_j: 'A', reference_j: 0.26, candidate_k: 'B', reference_k: 0.34,
      winner: 'A', alpha: 1, threshold_rejected: false, equal_reference_values: false, reason: null
    }
  });
  assert.match(accepted, /≤ alfa 1/);
  assert.match(accepted, /A × B +0,2600 vs 0,3400 +→ A/);
  assert.match(accepted, /PREVISÃO: A$/m);
});

test('Tipo 3 mostra todos os confrontos e o placar; empate no placar fica sem classe', () => {
  const output = renderDecision({
    decision_type: 3, profile: 'chapter3', prediction: 'C', status: 'ok',
    decision: {
      winner: 'C', edge_weights: { A: 0, B: 1, C: 2 }, pairwise_decisions: [
        { candidate_j: 'A', reference_j: 0.3, candidate_k: 'B', reference_k: 0.2, winner: 'B' },
        { candidate_j: 'A', reference_j: 0.3, candidate_k: 'C', reference_k: 0.1, winner: 'C' },
        { candidate_j: 'B', reference_j: 0.2, candidate_k: 'C', reference_k: 0.1, winner: 'C' },
      ]
    }
  });
  assert.equal((output.match(/ × /g) ?? []).length, 3);
  assert.match(output, /Vitórias: C 2 · B 1 · A 0/);
  assert.match(output, /▶ PREVISÃO: C/);
  const tied = renderDecision({
    decision_type: 3, prediction: null, status: 'tied_graph', abstention_reason: 'tied_graph',
    decision: { winner: null, edge_weights: { A: 1, B: 1 }, pairwise_decisions: [] }
  });
  assert.match(tied, /SEM CLASSE \(empate no número de vitórias\)/);
});

test('sem decisão registrada, o motivo é preservado e nenhuma classe é inventada', () => {
  const output = renderDecision({
    decision_type: 3, prediction: null, status: 'undefined_index',
    abstention_reason: 'undefined_index', decision: null
  });
  assert.match(output, /Não houve comparação: índice indefinido/);
  assert.match(output, /SEM CLASSE/);
  assert.doesNotMatch(output, /Blowfish|RC2|CAST5|Vitórias/);
});

test('gabarito só aparece quando fornecido e revela erro mesmo com status ok', () => {
  const external = renderVerdict({ ...basicResult(), actual: 'RC2' });
  assert.match(external, /Arquivo externo: origem desconhecida/);
  assert.doesNotMatch(external, /ACERTO|ERRO/);
  assert.match(renderVerdict(basicResult(), { actual: 'Blowfish' }), /Cifra real: Blowfish → ✗ ERRO \(previsto: RC2\)/);
  assert.match(renderVerdict(basicResult(), { actual: 'RC2' }), /✓ ACERTO/);
  assert.match(renderVerdict({ prediction: null }, { actual: 'RC2' }), /sem previsão, nada a conferir/);
  assert.match(renderVerdict(basicResult(), { actual: 'CAST5', candidates: ['Blowfish', 'RC2'] }),
    /CAST5 não estava entre os candidatos/);
  assert.throws(() => renderVerdict(basicResult(), { actual: '' }), /gabarito/);
});

test('cabeçalho da regra mostra alfa só quando a regra o usa', () => {
  assert.equal(ruleShort({ decisionType: 3, profile: 'chapter3', alpha: 0.1, candidates: ['A', 'B'] }), 'Tipo 3 · A, B');
  assert.equal(ruleShort({ decisionType: 2, profile: 'chapter5-experiment2', alpha: 0.1, candidates: ['A', 'B'] }),
    'Tipo 2 com limiar · alfa 0,1 · A, B');
  assert.equal(ruleShort({ decisionType: 1, profile: 'chapter3', alpha: 0.5, candidate: 'A', candidates: ['A', 'B'] }),
    'Tipo 1 · hipótese A · alfa 0,5 · A, B');
});

test('nomes importados não injetam sequências de controle no terminal', () => {
  assert.equal(text('\x1b[31matenção\x1b[0m\ntexto'), 'atenção texto');
  const output = renderScores({ scores: { '\x1b[32mA\x1b[0m': { weights: [1, 1], mean: 1, sample_standard_deviation: 0, value: 1 } } });
  assert.doesNotMatch(output, /\x1b|\x00/);
});

test('contratos inválidos são rejeitados', () => {
  for (const fn of [renderScores, renderDecision, renderVerdict]) assert.throws(() => fn(null), /objeto/);
  assert.throws(() => renderInput('abc'), /Buffer\/Uint8Array/);
  assert.match(renderScores({ scores: { X: { value: NaN, mean: Infinity } } }), /inválido \(Infinity\).*inválido \(NaN\)/);
});

test('controle artificial mostra ligações, grupos, cores, pesos e decisão delta sem nome de cifra', () => {
  const output = renderControl(structuralControls(), {
    files: [['r0', [0, 1]], ['r1', [0, 3]], ['r2', [255, 254]], ['r3', [255, 252]]], unknown: [0, 1, 255]
  });
  assert.match(output, /r0 — r1 \(termo 0 em comum\) · r2 — r3 \(termo 255 em comum\)/);
  assert.match(output, /delta_1 = \{r0, r1\} · delta_2 = \{r2, r3\}/);
  assert.match(output, /delta_1: cor 0 = \{r0\} · cor 1 = \{r1\}/);
  assert.match(output, /delta_1 +2, 1 /);
  assert.match(output, /delta_2 +1, 1 /);
  assert.match(output, /▶ PREVISÃO: delta_2/);
  assert.match(output, /Verificações automáticas deste controle: 5\/5 ✓/);
  assert.doesNotMatch(output, /Blowfish|RC2|CAST5/);
});

test('resultados da avaliação mostram cada semente, média, matriz e comparação com escolha fixa', () => {
  const cell = (seed, correct) => ({
    seed, result: {
      dataset: { text_bytes: 8192 }, configuration: { candidates: ['A', 'B'] },
      reference_terms: { files: 10, occurrences: 1000 },
      prepared: { correct, total: 4, accuracy: correct / 4 }, structural: { classified: 0 }
    }
  });
  const output = renderStudyResults({
    cells: [cell(1, 2), cell(2, 1)], summary: {
      all_repetitions: { prepared_accuracy: { mean: 0.375, sample_standard_deviation: 0.1767766952966369 } },
      prepared_pooled_descriptive: {
        correct: 3, total: 8,
        confusion_matrix: { A: { A: 2, B: 2, SEM_CLASSE: 0 }, B: { A: 3, B: 1, SEM_CLASSE: 0 } }
      }
    }
  });
  assert.match(output, /1 +2\/4 +50,00% +0 classificados/);
  assert.match(output, /Total: 3\/8 · média 37,50% · desvio 17,68 p\.p\./);
  assert.match(output, /A +2 +2/);
  assert.doesNotMatch(output, /SEM_CLASSE/);
  assert.match(output, /acertaria 4\/8 \(50,00%\)/);
  assert.throws(() => renderStudyResults({}), /sem execuções/);
});

test('duração aparece em segundos ou minutos', () => {
  assert.equal(duration(3.24), '3,2 s');
  assert.equal(duration(964), '16 min 4 s');
  assert.equal(duration(NaN), '—');
});

test('linha da bateria mostra real, previsto, marca e placar acumulado incluindo o arquivo atual', () => {
  const outcomes = [{ actual: 'A', prediction: 'A' }, { actual: 'B', prediction: 'A' }];
  assert.equal(renderCompactCase({ position: 2, total: 300, actual: 'B', prediction: 'A', outcomes }),
    '      2/300  real B         previsto A           ✗  acertos 1/2 (50,0%)');
  assert.match(renderCompactCase({
    position: 3, total: 300, actual: 'B', prediction: null,
    outcomes: [...outcomes, { actual: 'B', prediction: null }]
  }), /previsto SEM CLASSE  —  acertos 1\/3/);
});

test('resumo da bateria conta acertos, sem classe, matriz e escolha fixa; parcial é identificado', () => {
  const outcomes = [
    { actual: 'A', prediction: 'A' }, { actual: 'A', prediction: 'B' },
    { actual: 'B', prediction: 'B' }, { actual: 'B', prediction: null },
  ];
  const output = renderBatchSummary(outcomes, {
    labels: ['A', 'B'], context: 'semente 7 · Tipo 3 · A, B',
    total: 4, seconds: 964, structuralGroups: 0
  });
  assert.match(output, /RESUMO DA BATERIA · semente 7 · Tipo 3 · A, B/);
  assert.match(output, /Arquivos classificados: 4 de 4 · tempo: 16 min 4 s/);
  assert.match(output, /Acertos: 2\/4 \(50,00%\) · sem classe: 1/);
  assert.match(output, /A +B +SEM CLASSE/);
  assert.match(output, /A +1 +1 +0/);
  assert.match(output, /B +0 +1 +1/);
  assert.match(output, /acertaria 2\/4 \(50,00%\)/);
  assert.match(output, /Caminho automático: sem grupos/);
  assert.match(renderBatchSummary(outcomes.slice(0, 2), { labels: ['A', 'B'], total: 300 }), /RESUMO PARCIAL \(interrompido\)/);
  assert.throws(() => renderBatchSummary([]), /sem arquivos/);
});
