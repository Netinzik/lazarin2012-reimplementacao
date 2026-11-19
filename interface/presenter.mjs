export const LINE = '─'.repeat(64);
export const DOUBLE_LINE = '═'.repeat(64);

const REASONS = Object.freeze({
  insufficient_reference_structure: 'a base não formou grupos suficientes',
  undefined_index: 'índice indefinido: a média dos pesos é zero',
  zero_mean: 'a média dos pesos é zero',
  rejected_h0: 'hipótese rejeitada',
  equal_reference_values: 'os dois VR são iguais',
  threshold_rejection: 'os dois VR passaram do limiar alfa',
  tied_graph: 'empate no número de vitórias',
  mixed_reference_group: 'o grupo mistura cifras',
});

export function text(value) {
  return String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function integer(value) {
  return Number.isSafeInteger(value) ? value.toLocaleString('pt-BR') : text(value);
}

export function decimal(value, digits = 4) {
  if (value === null) return 'indefinido';
  if (value === undefined) return '—';
  if (typeof value !== 'number' || !Number.isFinite(value)) return `inválido (${text(value)})`;
  return value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function short(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return text(value);
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 6 });
}

export function percent(ratio, digits = 2) {
  return typeof ratio === 'number' && Number.isFinite(ratio) ? `${decimal(ratio * 100, digits)}%` : decimal(ratio);
}

export function listJoin(items, conjunction = 'e') {
  const names = items.map(text);
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)}`;
}

function reason(code) {
  if (code === null || code === undefined || code === '') return null;
  const key = text(code);
  return REASONS[key] ?? key;
}

function entries(value) {
  if (value instanceof Map) return [...value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value);
}

function count(value) {
  if (Array.isArray(value)) return value.length;
  if (value instanceof Set) return value.size;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function vrOf(score) {
  if (!score || typeof score !== 'object') return undefined;
  if (score.reference_value !== undefined) return score.reference_value;
  if (typeof score.value === 'number' && Number.isFinite(score.value)) return 1 - score.value;
  return score.value;
}

function pairDigits(a, b, base = 4) {
  if (typeof a !== 'number' || typeof b !== 'number' || a === b) return base;
  let digits = base;
  while (digits < 15 && decimal(a, digits) === decimal(b, digits)) digits++;
  return digits;
}

function formatTable(rows, rightAligned) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => String(row[col]).length)));
  return rows.map(row => row.map((cell, col) =>
    rightAligned[col] ? String(cell).padStart(widths[col]) : String(cell).padEnd(widths[col])).join('   ').trimEnd());
}

export function formatTermsPreview(buffer, shown = 3) {
  if (!(buffer instanceof Uint8Array)) throw new TypeError('A prévia exige Buffer/Uint8Array.');
  if (!Number.isSafeInteger(shown) || shown < 0) throw new RangeError('shown deve ser inteiro não negativo.');
  const total = Math.floor(buffer.byteLength / 8);
  if (!total) return '(nenhum criptotermo)';
  const terms = [];
  for (let i = 0; i < Math.min(shown, total); i++)
    terms.push(Buffer.from(buffer.subarray(i * 8, i * 8 + 8)).toString('hex'));
  const rest = total - terms.length;
  return [...terms, ...(rest ? [`… (+${integer(rest)})`] : [])].join('  ');
}

export function ruleShort({ decisionType, profile, alpha, candidate, candidates = [], zeroWeight }) {
  const names = candidates.map(text).join(', ') + (zeroWeight === 'abster' ? ' · peso zero: abster' : '');
  if (decisionType === 1) return `Tipo 1 · hipótese ${text(candidate)} · alfa ${short(alpha)} · ${names}`;
  if (decisionType === 2 && profile === 'chapter5-experiment2') return `Tipo 2 com limiar · alfa ${short(alpha)} · ${names}`;
  return `Tipo ${text(decisionType)} · ${names}`;
}

function ruleDescription(type, profile, hypothesis) {
  if (type === 1) return `Tipo 1 · testa a hipótese "é ${text(hypothesis ?? '?')}" · rejeita se VR > alfa`;
  if (type === 2 && profile === 'chapter5-experiment2') return 'Tipo 2 com limiar (cap. 5) · sem classe se os dois VR > alfa';
  if (type === 2) return 'Tipo 2 · duas cifras · vence o menor VR';
  if (type === 3) return 'Tipo 3 · cada par se enfrenta · vence o menor VR';
  return 'regra não reconhecida';
}

export function renderReferenceList(summary = [], indent = '       ') {
  if (!Array.isArray(summary)) throw new TypeError('O resumo de referência deve ser uma lista.');
  if (!summary.length) return [`${indent}Nenhuma amostra informada.`];
  for (const item of summary)
    if (!item || typeof item !== 'object' || typeof item.label !== 'string' || !item.label.trim())
      throw new TypeError('Cada candidato exige um label não vazio.');
  const width = Math.max(...summary.map(item => text(item.label).length));
  return summary.map(item => {
    const sizes = Array.isArray(item.sampleTerms) ? item.sampleTerms : [];
    const uniform = sizes.length > 0 && sizes.every(size => size === sizes[0]);
    const samples = uniform
      ? `${integer(item.sampleCount)} amostras de ${integer(sizes[0])} termos`
      : `${integer(item.sampleCount)} amostras (${sizes.map(integer).join(', ')} termos)`;
    return `${indent}${text(item.label).padEnd(width)}   ${samples} · ${integer(item.distinctTerms)} distintos`;
  });
}

export function renderPreparedReference(summary, { keys, samples, hasGroups = false, reorganizedFor = null } = {}) {
  const lines = [];
  if (reorganizedFor) {
    lines.push(`    Base reorganizada para ${listJoin(reorganizedFor)}; o universo de comparação muda junto.`);
  } else {
    lines.push(hasGroups ? '    → A base também é organizada por cifra:' : '    → Sem grupos automáticos, a base é organizada por cifra:');
    if (keys && samples) lines.push(`      as ${integer(keys)} chaves de cada cifra são divididas em ${integer(samples)} amostras.`);
  }
  lines.push(...renderReferenceList(summary));
  return lines.join('\n');
}

export function renderStructuralStep(structural, { step = 3 } = {}) {
  if (!structural || typeof structural !== 'object') throw new TypeError('A informação estrutural deve ser um objeto.');
  const edges = count(structural.edges ?? structural.edge_count);
  const groups = count(structural.groups);
  const isolated = count(structural.ungrouped ?? structural.ungrouped_count);
  const lines = [
    `[${step}] BUSCA AUTOMÁTICA DE GRUPOS · investigação estrutural`,
    '    Regra: dois arquivos se ligam quando têm um criptotermo IDÊNTICO.',
    `    Ligações: ${integer(edges)} · Grupos: ${integer(groups)} · Arquivos isolados: ${integer(isolated)}`,
  ];
  if (edges === 0) lines.push('    → Nenhum criptotermo se repete entre arquivos, então não se formam grupos.');
  else if (groups !== null && groups < 2) lines.push(`    → Só ${integer(groups)} grupo: a decisão automática precisa de pelo menos 2.`);
  else lines.push(`    → ${integer(groups)} grupos, nomeados delta_1, delta_2… (não são nomes de cifras).`);
  return lines.join('\n');
}

export function renderInput(bytes, { hidden = true, step = 4 } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('A entrada exige Buffer/Uint8Array.');
  const size = bytes.byteLength;
  const lines = [`[${step}] ENTRADA`];
  if (size === 0) lines.push('    Entrada vazia: não há criptotermos.');
  else if (size % 8) lines.push(`    ${integer(size)} bytes: não é múltiplo de 8, então não se divide em criptotermos.`);
  else lines.push(`    ${integer(size)} bytes → ${integer(size / 8)} criptotermos de 8 bytes (64 bits)`);
  if (size >= 8) lines.push(`    Primeiros criptotermos (hex): ${formatTermsPreview(bytes)}`);
  lines.push(hidden ? '    A cifra verdadeira fica escondida até o passo [8].' : '    Arquivo externo: não há gabarito para conferir.');
  return lines.join('\n');
}

export function renderScores(result, { step = 6, label = 'Cifra' } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('O resultado deve ser um objeto.');
  const lines = [`[${step}] ÍNDICE · I = 1 − desvio/média dos pesos · VR = 1 − I`];
  const rows = entries(result.scores);
  if (!rows.length) {
    lines.push('    Nenhum peso ou índice foi calculado.');
    return lines.join('\n');
  }
  const table = [[label, 'Pesos das amostras', 'Média', 'Desvio', 'I', 'VR']];
  const notes = [];
  for (const [name, score] of rows) {
    if (!score || typeof score !== 'object') {
      table.push([text(name), `inválido (${text(score)})`, '', '', '', '']);
      continue;
    }
    const weights = Array.isArray(score.weights)
      ? score.weights.map(w => typeof w === 'number' && Number.isFinite(w) ? String(w) : text(w)).join(', ') : '—';
    table.push([text(name), weights, decimal(score.mean, 2), decimal(score.sample_standard_deviation, 3),
    decimal(score.value), decimal(vrOf(score))]);
    if (score.error) notes.push(`    ${text(name)}: ${reason(score.error)}; o índice fica indefinido.`);
  }
  lines.push(...formatTable(table, [false, false, true, true, true, true]).map(line => `    ${line}`));
  lines.push(...notes);
  lines.push('    Pesos parecidos entre as amostras → desvio pequeno → I alto → VR baixo.');
  lines.push('    I mede a uniformidade dos pesos; não é probabilidade de acerto.');
  return lines.join('\n');
}

function pairLines(pairs) {
  const label = pair => `${text(pair.candidate_j ?? '?')} × ${text(pair.candidate_k ?? '?')}`;
  const width = Math.max(...pairs.map(pair => label(pair).length));
  return pairs.map(pair => {
    const digits = pairDigits(pair.reference_j, pair.reference_k);
    const tie = pair.zero_weight
      ? (pair.winner == null ? ' (as duas sem peso)' : ' (sem peso perde)')
      : pair.reference_j === pair.reference_k ? ' (empate: vale o segundo da ordem)' : '';
    return `    ${label(pair).padEnd(width)}   ${decimal(pair.reference_j, digits)} vs ${decimal(pair.reference_k, digits)}` +
      `  → ${pair.winner == null ? 'nenhum' : text(pair.winner)}${tie}`;
  });
}

export function renderDecision(result, { step = 7, hypothesis = null } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('O resultado deve ser um objeto.');
  const type = result.decision_type, profile = result.profile, decision = result.decision;
  const lines = [`[${step}] DECISÃO · ${ruleDescription(type, profile, hypothesis)}`];
  let why = null;
  if (!decision) {
    why = reason(result.abstention_reason ?? result.status) ?? 'nenhuma decisão registrada';
    lines.push(`    Não houve comparação: ${why}.`);
  } else if (type === 1 && decision.zero_weight) {
    lines.push(`    ${text(hypothesis ?? '?')} ficou com peso zero em todas as amostras → hipótese rejeitada (sem nenhuma evidência)`);
    why = 'hipótese rejeitada';
  } else if (type === 1) {
    const rejected = decision.reject_h0 === true;
    lines.push(`    VR de ${text(hypothesis ?? result.prediction ?? '?')} = ${decimal(decision.reference_value)} ` +
      `${rejected ? '>' : '≤'} alfa ${short(decision.alpha)} → hipótese ${rejected ? 'rejeitada' : 'não rejeitada'}`);
    why = rejected ? 'hipótese rejeitada' : 'hipótese não rejeitada; isso não a confirma';
  } else if (type === 2 && profile === 'chapter5-experiment2') {
    const width = Math.max(text(decision.candidate_j).length, text(decision.candidate_k).length);
    const digits = pairDigits(decision.reference_j, decision.reference_k);
    for (const [name, vr] of [[decision.candidate_j, decision.reference_j], [decision.candidate_k, decision.reference_k]])
      lines.push(`    ${text(name).padEnd(width)}   VR ${decimal(vr, digits)} ${vr > decision.alpha ? '>' : '≤'} alfa ${short(decision.alpha)}`);
    if (decision.equal_reference_values) lines.push('    → os dois VR são iguais: a regra não classifica.');
    else if (decision.threshold_rejected) lines.push('    → os dois VR passaram do limiar: a regra não classifica.');
    else {
      lines.push('    → pelo menos um VR está dentro do limiar: vence o menor VR.');
      lines.push(...pairLines([{ ...decision, winner: result.prediction }]));
    }
    why = reason(decision.reason);
  } else if (type === 2) {
    lines.push(...pairLines([decision]));
  } else if (type === 3) {
    const pairs = Array.isArray(decision.pairwise_decisions) ? decision.pairwise_decisions : [];
    if (pairs.length) lines.push(...pairLines(pairs));
    const wins = entries(decision.edge_weights).sort((a, b) => b[1] - a[1]);
    if (wins.length) lines.push(`    Vitórias: ${wins.map(([name, total]) => `${text(name)} ${integer(total)}`).join(' · ')}`);
    if (result.prediction == null) why = reason(result.abstention_reason ?? 'tied_graph');
  } else {
    lines.push('    Regra de decisão não reconhecida.');
  }
  if (Array.isArray(result.zero_weight_candidates) && result.zero_weight_candidates.length && type !== 1)
    lines.push(`    Sem peso (perdem os confrontos): ${listJoin(result.zero_weight_candidates)}`);
  lines.push('');
  lines.push(`    ▶ PREVISÃO: ${result.prediction == null ? 'SEM CLASSE' : text(result.prediction)}${why ? ` (${why})` : ''}`);
  return lines.join('\n');
}

export function renderVerdict(result, { actual = null, candidates = null, step = 8 } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('O resultado deve ser um objeto.');
  if (actual !== null && (typeof actual !== 'string' || !actual.trim())) throw new TypeError('O gabarito deve ser uma string não vazia ou null.');
  if (actual === null) return `[${step}] GABARITO\n    Arquivo externo: origem desconhecida; não há como conferir.`;
  const lines = [`[${step}] GABARITO · consultado só depois da previsão`];
  const prediction = result.prediction;
  if (prediction == null) lines.push(`    Cifra real: ${text(actual)} → sem previsão, nada a conferir`);
  else if (prediction === actual) lines.push(`    Cifra real: ${text(actual)} → ✓ ACERTO`);
  else lines.push(`    Cifra real: ${text(actual)} → ✗ ERRO (previsto: ${text(prediction)})`);
  if (Array.isArray(candidates) && !candidates.includes(actual))
    lines.push(`    ${text(actual)} não estava entre os candidatos escolhidos; a regra não tinha como acertar.`);
  return lines.join('\n');
}

export function duration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${decimal(seconds, 1)} s`;
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

function tally(outcomes) {
  const done = outcomes.length;
  const correct = outcomes.filter(o => o.prediction != null && o.prediction === o.actual).length;
  const unclassified = outcomes.filter(o => o.prediction == null).length;
  return { done, correct, unclassified };
}

export function renderCompactCase({ position, total, actual, prediction, outcomes, labelWidth = 8 }) {
  const { done, correct } = tally(outcomes);
  const mark = prediction == null ? '—' : prediction === actual ? '✓' : '✗';
  const width = String(total).length;
  return `    ${String(position).padStart(width)}/${total}  real ${text(actual ?? '?').padEnd(labelWidth)}  ` +
    `previsto ${(prediction == null ? 'SEM CLASSE' : text(prediction)).padEnd(Math.max(10, labelWidth))}  ${mark}  ` +
    `acertos ${correct}/${done} (${percent(correct / done, 1)})`;
}

export function renderBatchSummary(outcomes, { labels = [], context, seconds, structuralGroups = null, total } = {}) {
  if (!Array.isArray(outcomes) || !outcomes.length) throw new Error('Bateria sem arquivos classificados.');
  const { done, correct, unclassified } = tally(outcomes);
  const interrupted = Number.isSafeInteger(total) && done < total;
  const lines = [DOUBLE_LINE,
    `  ${interrupted ? 'RESUMO PARCIAL (interrompido)' : 'RESUMO DA BATERIA'}${context ? ` · ${text(context)}` : ''}`,
    DOUBLE_LINE,
    `  Arquivos classificados: ${integer(done)}${Number.isSafeInteger(total) ? ` de ${integer(total)}` : ''}${seconds === undefined ? '' : ` · tempo: ${duration(seconds)}`}`,
    `  Acertos: ${integer(correct)}/${integer(done)} (${percent(correct / done)}) · sem classe: ${integer(unclassified)}`];
  const rows = [...new Set(outcomes.map(o => o.actual))];
  const columns = [...labels.map(text), ...(unclassified ? ['SEM CLASSE'] : [])];
  const cell = (row, col) => outcomes.filter(o => o.actual === row &&
    (col === 'SEM CLASSE' ? o.prediction == null : o.prediction === col)).length;
  if (columns.length) {
    lines.push('', '  Matriz de confusão · linha = cifra real, coluna = previsão');
    const table = [['', ...columns], ...rows.map(row => [text(row), ...columns.map(col => integer(cell(row, col)))])];
    lines.push(...formatTable(table, [false, ...columns.map(() => true)]).map(line => `  ${line}`));
  }
  const reasons = new Map();
  for (const o of outcomes) if (o.prediction == null && o.abstention) reasons.set(o.abstention, (reasons.get(o.abstention) ?? 0) + 1);
  for (const [code, n] of reasons) lines.push(`  Sem classe por ${reason(code)}: ${integer(n)}` +
    (code === 'undefined_index' ? ' (todos os pesos foram para uma parte das cifras; as demais ficaram com peso zero)' : ''));
  const largest = Math.max(...rows.map(row => outcomes.filter(o => o.actual === row).length));
  lines.push('', `  Comparação: escolher sempre a mesma cifra acertaria ${integer(largest)}/${integer(done)} (${percent(largest / done)}).`);
  if (structuralGroups !== null && structuralGroups < 2)
    lines.push('  Caminho automático: sem grupos, nenhum arquivo classificado por ele.');
  return lines.join('\n');
}

export function renderControl(controls, { files, unknown }) {
  const terms = new Map(files);
  const positive = controls.positive, prediction = positive.prediction;
  const lines = [DOUBLE_LINE, '  CAMINHO AUTOMÁTICO COM DADOS ARTIFICIAIS', DOUBLE_LINE,
    '  Dados construídos à mão para que existam criptotermos repetidos (não são cifras reais).',
    '  Cada número representa um criptotermo inteiro de 64 bits.', ''];
  lines.push(`[1] ARQUIVOS    ${files.map(([id, values]) => `${id} = [${values.join(', ')}]`).join('   ')}`);
  const edges = [];
  for (const group of positive.groups) {
    for (let i = 0; i < group.members.length; i++) for (let j = i + 1; j < group.members.length; j++) {
      const [a, b] = [group.members[i], group.members[j]];
      const common = (terms.get(a) ?? []).filter(term => (terms.get(b) ?? []).includes(term));
      if (common.length) edges.push(`${a} — ${b} (termo ${common.join(', ')} em comum)`);
    }
  }
  lines.push(`[2] LIGAÇÕES    ${edges.join(' · ')}`);
  lines.push(`[3] GRUPOS      ${positive.groups.map(g => `${g.id} = {${g.members.join(', ')}}`).join(' · ')}`);
  lines.push('[4] CORES       arquivos ligados recebem cores diferentes; cada cor vira uma amostra');
  for (const group of positive.groups)
    lines.push(`                ${group.id}: ${group.samples.map(s => `cor ${s.color} = {${s.members.join(', ')}}`).join(' · ')}`);
  lines.push(`[5] ENTRADA     [${unknown.join(', ')}]`);
  lines.push('', renderScores(prediction, { step: 6, label: 'Grupo' }));
  lines.push('', renderDecision(prediction, { step: 7 }));
  const checks = Object.values(controls.checks ?? {});
  lines.push('', `    ${text(prediction.prediction ?? 'SEM CLASSE')} é um grupo encontrado pelo método, não o nome de uma cifra.`);
  lines.push(`    Verificações automáticas deste controle: ${checks.filter(Boolean).length}/${checks.length} ${controls.passed ? '✓' : '✗'}`);
  return lines.join('\n');
}

export function renderStudyResults(results) {
  const cells = Array.isArray(results?.cells) ? results.cells : [];
  if (!cells.length) throw new Error('Resultados da avaliação sem execuções registradas.');
  const first = cells[0].result;
  const summary = results.summary ?? {};
  const pooled = summary.prepared_pooled_descriptive ?? {};
  const accuracy = summary.all_repetitions?.prepared_accuracy ?? {};
  const lines = [DOUBLE_LINE, '  RESULTADOS DA AVALIAÇÃO OFICIAL (5 sementes)', DOUBLE_LINE,
    `  Base: ${integer(first.reference_terms.occurrences)} criptotermos (${integer(first.reference_terms.files)} arquivos de ${integer(first.dataset.text_bytes)} bytes)`,
    `  Testes: ${integer(first.prepared.total)} arquivos por semente · regra Tipo 3 · ${listJoin(first.configuration.candidates)}`,
    '  Cada semente troca as chaves e os IVs; os trechos da Bíblia são os mesmos.', ''];
  const table = [['Semente', 'Acertos', 'Acurácia', 'Caminho automático']];
  for (const cell of cells) {
    const p = cell.result.prepared, s = cell.result.structural;
    table.push([String(cell.seed), `${integer(p.correct)}/${integer(p.total)}`, percent(p.accuracy),
    `${integer(s.classified)} classificados`]);
  }
  lines.push(...formatTable(table, [false, true, true, false]).map(line => `  ${line}`));
  lines.push(`  Total: ${integer(pooled.correct)}/${integer(pooled.total)} · média ${percent(accuracy.mean)} · desvio ${decimal((accuracy.sample_standard_deviation ?? NaN) * 100, 2)} p.p.`);
  const matrix = pooled.confusion_matrix;
  if (matrix) {
    const labels = Object.keys(matrix);
    const columns = [...labels];
    if (labels.some(row => matrix[row].SEM_CLASSE)) columns.push('SEM_CLASSE');
    lines.push('', '  Matriz de confusão (todas as sementes) · linha = cifra real, coluna = previsão');
    const rows = [['', ...columns], ...labels.map(row => [row, ...columns.map(col => integer(matrix[row][col] ?? 0))])];
    lines.push(...formatTable(rows, [false, ...columns.map(() => true)]).map(line => `  ${line}`));
    const largest = Math.max(...labels.map(row => Object.values(matrix[row]).reduce((a, b) => a + b, 0)));
    lines.push('', `  Comparação: escolher sempre a mesma cifra acertaria ${integer(largest)}/${integer(pooled.total)} (${percent(largest / pooled.total)}).`);
  }
  lines.push('  Conclusão: neste cenário (CBC com IV por arquivo), o método não mostrou vantagem');
  lines.push('  sobre essa escolha fixa, e o caminho automático não formou grupos.');
  return lines.join('\n');
}

export function groupComposition(model, references) {
  return new Map(model.featureGroups.map(group => {
    const counts = new Map();
    for (const id of group.cryptogram_ids) {
      const label = references[Number(String(id).replace(/^ref-/, ''))]?.algorithm ?? '?';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return ['delta_' + group.group_number, new Map([...counts].sort((a, b) => b[1] - a[1]))];
  }));
}

export const describeComposition = counts => [...counts].map(([label, n]) => `${text(label)} (${integer(n)})`).join(', ');

export function renderAutomaticSummary(outcomes, groups, limit = 12) {
  const lines = ['', '  Caminho automático · grupos formados sem olhar os rótulos (cifra real da base consultada só agora)'];
  const entries = [...groups];
  for (const [key, counts] of entries.slice(0, limit)) lines.push(`    ${key.padEnd(9)} ${describeComposition(counts)}`);
  if (entries.length > limit) lines.push(`    … e mais ${integer(entries.length - limit)} grupos`);
  const assigned = outcomes.filter(o => o.automatic);
  const majority = key => [...(groups.get(key) ?? new Map())][0]?.[0];
  const right = assigned.filter(o => majority(o.automatic) === o.actual).length;
  lines.push(`  Testes com grupo previsto: ${integer(assigned.length)} de ${integer(outcomes.length)}` +
    (assigned.length ? ` · o grupo previsto é, na maioria, da cifra certa em ${integer(right)} (${percent(right / assigned.length)})` : ''));
  return lines.join('\n');
}
