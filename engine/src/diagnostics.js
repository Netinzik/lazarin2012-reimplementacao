import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Cryptogram } from './terms.js';
import { preprocess, findIntersections } from './structural.js';
import { LazarinModel } from './pipeline.js';
import { inspectDataset } from './evaluation.js';
import { sha256 } from './crypto.js';
import { createOutput, localFile, readJSON, readCiphertext, writeJSON } from './io.js';

const MAGIC = Buffer.from('Salted__', 'ascii');
const SOURCE_CODE = 'https://raw.githubusercontent.com/openssl/openssl/OpenSSL_1_0_1c/apps/enc.c';
const SOURCE_DOCS = 'https://docs.openssl.org/1.0.2/man1/enc/';

function literalIntersections(cryptograms) {
  const sets = cryptograms.map(c => new Set(c.terms));
  const edges = [];
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    const common_terms = new Set([...sets[i]].filter(term => sets[j].has(term)));
    if (common_terms.size) edges.push({
      left: cryptograms[i].identifier,
      right: cryptograms[j].identifier, common_terms
    });
  }
  return edges;
}
function edgeView(edges) {
  return edges.map(e => ({
    left: e.left, right: e.right,
    common_terms_hex: [...e.common_terms].map(t => t.toString(16).padStart(16, '0'))
  }));
}
function modelView(model) {
  return {
    edge_count: model.investigation.intersections.length,
    edges: edgeView(model.investigation.intersections),
    ungrouped: model.investigation.ungrouped,
    groups: model.featureGroups.map(g => ({
      id: 'delta_' + g.group_number,
      members: g.cryptogram_ids, colors: g.color_assignments,
      samples: g.samples.map(s => ({
        color: s.color, members: s.cryptogram_ids,
        distinct_terms: s.terms.size
      }))
    }))
  };
}
function sameEdges(cryptograms) {
  return JSON.stringify(edgeView(findIntersections(preprocess(cryptograms)))) ===
    JSON.stringify(edgeView(literalIntersections(cryptograms)));
}

export function structuralControls() {
  const refs = [Cryptogram.fromTerms('r0', [0, 1]), Cryptogram.fromTerms('r1', [0, 3]),
  Cryptogram.fromTerms('r2', [255, 254]), Cryptogram.fromTerms('r3', [255, 252])];
  const model = LazarinModel.fit(refs);
  const unknown = Cryptogram.fromTerms('controle', [0, 1, 255]);
  const prediction = model.predict(unknown, { decisionType: 3 });
  const positive = modelView(model);
  const reduced = [refs[0], Cryptogram.fromTerms('r1', [3]), refs[2], refs[3]];
  const removal = modelView(LazarinModel.fit(reduced));
  const cliqueRefs = Array.from({ length: 4 }, (_, i) =>
    Cryptogram.fromTerms('v' + i, [0xdeadbeef00000001n, BigInt(i + 1)]));
  const clique = modelView(LazarinModel.fit(cliqueRefs));
  const checks = {
    positive_two_disjoint_components: positive.edge_count === 2 && positive.groups.length === 2 &&
      positive.groups.every(g => g.samples.length === 2) && positive.ungrouped.length === 0,
    positive_end_to_end_prediction: prediction.status === 'ok' && prediction.prediction === 'delta_2' &&
      JSON.stringify(prediction.scores.delta_1.weights) === '[2,1]' &&
      JSON.stringify(prediction.scores.delta_2.weights) === '[1,1]',
    removing_shared_term_removes_only_its_edge: removal.edge_count === 1 && removal.groups.length === 1 &&
      JSON.stringify(removal.ungrouped) === '["r0","r1"]',
    complete_graph_requires_four_colors: clique.edge_count === 6 && clique.groups.length === 1 &&
      clique.groups[0].samples.length === 4,
    indexed_intersections_match_literal: [refs, reduced, cliqueRefs].every(sameEdges)
  };
  return {
    kind: 'artificial_functional_controls', passed: Object.values(checks).every(Boolean), checks,
    positive: { ...positive, prediction }, removal, clique,
    warning: 'Termos construídos para testar o caminho completo; não são evidência de identificação de cifras reais.'
  };
}

function envelopeControl(datasetDir, manifest) {
  const selected = [], perAlgorithm = new Map(manifest.algorithms.map(a => [a, 0]));
  for (const record of manifest.records.filter(r => r.split === 'reference')) {
    if (perAlgorithm.get(record.algorithm) < 2) {
      selected.push(record); perAlgorithm.set(record.algorithm, perAlgorithm.get(record.algorithm) + 1);
    }
  }
  if (selected.length !== manifest.algorithms.length * 2) throw new Error('Controle requer duas referências por cifra');
  const raw = [], prefixed = [], stripped = [], payloads = [];
  for (let i = 0; i < selected.length; i++) {
    const record = selected[i], payload = readCiphertext(localFile(datasetDir, record.path));
    const salt = Buffer.alloc(8); salt.writeBigUInt64BE(BigInt(i + 1));
    const envelope = Buffer.concat([MAGIC, salt, payload]);
    raw.push(Cryptogram.fromBytes('payload-' + i, payload));
    prefixed.push(Cryptogram.fromBytes('payload-' + i, envelope));
    stripped.push(Cryptogram.fromBytes('payload-' + i, envelope.subarray(16)));
    payloads.push({
      id: 'payload-' + i, source_id: record.id, algorithm: record.algorithm,
      payload_sha256: sha256(payload), recovered_payload_sha256: sha256(envelope.subarray(16)),
      simulated_salt_hex: salt.toString('hex')
    });
  }
  const baseline = modelView(LazarinModel.fit(raw));
  const contaminated = modelView(LazarinModel.fit(prefixed));
  const recovered = modelView(LazarinModel.fit(stripped));
  const expectedEdges = selected.length * (selected.length - 1) / 2;
  const contaminatedLabels = [...new Set(payloads.map(p => p.algorithm))];
  const checks = {
    common_header_forces_complete_graph: contaminated.edge_count === expectedEdges,
    one_component_has_all_algorithms: contaminated.groups.length === 1 &&
      contaminated.groups[0].members.length === selected.length && contaminatedLabels.length === manifest.algorithms.length,
    complete_graph_uses_one_color_per_file: contaminated.groups[0]?.samples.length === selected.length,
    removing_envelope_recovers_raw_structure: JSON.stringify(recovered) === JSON.stringify(baseline),
    payload_bytes_preserved: payloads.every(p => p.payload_sha256 === p.recovered_payload_sha256),
    indexed_intersections_match_literal: [raw, prefixed, stripped].every(sameEdges)
  };
  return {
    kind: 'simulated_openssl_envelope_on_real_payloads', passed: Object.values(checks).every(Boolean),
    checks, files: selected.length, magic_ascii: MAGIC.toString('ascii'), magic_hex: MAGIC.toString('hex'),
    simulated_prefix_bytes: 16, distinct_counter_salts: true, payloads,
    baseline, with_simulated_envelope: contaminated, after_removing_simulated_envelope: recovered,
    mixed_algorithm_component: contaminatedLabels,
    sources: [SOURCE_CODE, SOURCE_DOCS],
    warning: 'Hipótese de preparação: cabeçalho comum pode criar grupos mistos. Não prova que os arquivos de 2012 continham esse cabeçalho, não é reprodução de cifração histórica e não altera o protocolo principal.'
  };
}

function reportText(diagnostic) {
  const obs = diagnostic.observed, ideal = diagnostic.ideal_model, controls = diagnostic.controls;
  return [
    '# Diagnóstico do fluxo estrutural automático', '',
    '## Evidência observada no conjunto validado', '',
    `Referência: ${obs.files} arquivos, ${obs.occurrences} ocorrências e ${obs.distinct_terms} termos distintos de 64 bits.`,
    `Repetições globais: ${obs.repeated_occurrences}. Arestas: ${obs.edges}; grupos: ${obs.groups}; isolados: ${obs.ungrouped}.`, '',
    obs.all_unique_implies_no_edges
      ? 'Todos os termos são únicos na referência. Portanto, nenhum par de arquivos pode compartilhar um termo, e o grafo necessariamente não tem arestas. A fase de coloração não recebe componentes conectados; a classificação automática não dispõe de grupos suficientes. Isso decorre dos dados e do critério de igualdade, não de um limiar de Hamming.'
      : 'Existem repetições na referência. A contagem global, sozinha, não determina as interseções: repetições dentro de um mesmo arquivo não criam aresta. Consulte os dados estruturais.', '',
    '## Modelo ideal: explicação condicional, não prova sobre CBC real', '',
    `Sob a hipótese de termos independentes e uniformes em 64 bits, a esperança de pares iguais entre arquivos é ${ideal.expected_equal_cross_file_pairs}.`,
    `Cálculo: ${ideal.cross_file_term_pairs} pares entre arquivos / 2^64. O limite da união para ao menos uma igualdade é ${ideal.union_bound_any_cross_file_match}.`,
    'A independência e a uniformidade são hipóteses de um modelo ideal, não propriedades demonstradas desta amostra ou de todo uso de CBC. A prova de ausência de arestas neste conjunto vem da contagem observada, não dessa aproximação.', '',
    '## Controles funcionais pequenos', '',
    `Dois componentes, duas cores por componente e previsão end-to-end: ${controls.synthetic.passed ? 'aprovados' : 'FALHA'}.`,
    'Retirar o termo compartilhado remove sua aresta; quatro vértices com termo comum formam um clique e usam quatro cores. A busca indexada é comparada a uma implementação literal nos controles.',
    'Esses controles são artificiais e não representam taxas de identificação de cifras reais.', '',
    '## Controle separado de preparação: envelope OpenSSL simulado', '',
    `Foram usadas cópias em memória de ${controls.openssl_envelope.files} payloads reais, duas por cifra. O prefixo simulado contém oito bytes ASCII Salted__ e oito bytes distintos de salt de controle.`,
    `Arestas sem envelope: ${controls.openssl_envelope.baseline.edge_count}; com envelope: ${controls.openssl_envelope.with_simulated_envelope.edge_count}; após retirar os 16 bytes: ${controls.openssl_envelope.after_removing_simulated_envelope.edge_count}.`,
    'O cabeçalho constante conecta todas as cifras em um único componente, demonstrando que uma estrutura pode vir do formato do arquivo e não da cifra. Não é usado como melhoria do classificador e nenhum arquivo original é alterado.',
    'O código do OpenSSL 1.0.1c contém escrita do marcador e do salt quando enc usa senha e salt habilitado. O controle não prova que os arquivos de 2012 continham esse envelope: ainda é necessário confirmar quais bytes eram efetivamente analisados. Não reproduz a derivação de chave, o padding ou a ferramenta antiga.', '',
    `[Código-fonte primário do OpenSSL 1.0.1c](${SOURCE_CODE}); [documentação histórica de enc](${SOURCE_DOCS}).`, '',
    '## Conclusão delimitada', '',
    'A verificação técnica da ausência de grupos é explicada neste protocolo. Isso não demonstra que o agrupamento original falhava, nem confirma a composição dos arquivos históricos. Preparação criptográfica, envelope e amostras da dissertação permanecem questões distintas da correção deste controle.', '',
    'Detalhes, hashes e condições: diagnostic.json.', ''
  ].join('\n');
}

export function diagnoseDataset(datasetDir, output) {
  if (typeof output !== 'string' || !output) throw new TypeError('Saída deve ser um diretório');
  if (fs.existsSync(output)) throw new Error('Diretório já existe; use outro nome: ' + output);
  const started = performance.now();
  const inspection = inspectDataset(datasetDir);
  const manifest = readJSON(path.join(datasetDir, 'manifest.json'));
  const records = manifest.records.filter(r => r.split === 'reference');
  const n = BigInt(inspection.reference_terms.occurrences);
  const allPairs = n * (n - 1n) / 2n;
  const withinPairs = records.reduce((sum, r) => {
    const k = BigInt(r.bytes / 8); return sum + k * (k - 1n) / 2n;
  }, 0n);
  const crossPairs = allPairs - withinPairs;
  const expected = Number(crossPairs) / 2 ** 64;
  const synthetic = structuralControls(), opensslEnvelope = envelopeControl(datasetDir, manifest);
  const result = {
    schema: 1, kind: 'structural_diagnostic', artifact_version: '0.6.0',
    dataset: {
      manifest_sha256: sha256(fs.readFileSync(path.join(datasetDir, 'manifest.json'))),
      source_sha256: manifest.corpus.raw_sha256, seed: manifest.config.seed
    },
    observed: {
      files: inspection.reference_files, occurrences: inspection.reference_terms.occurrences,
      distinct_terms: inspection.reference_terms.distinct,
      repeated_occurrences: inspection.reference_terms.occurrences - inspection.reference_terms.distinct,
      all_unique_implies_no_edges: inspection.reference_terms.occurrences === inspection.reference_terms.distinct,
      edges: inspection.structural.edges, groups: inspection.structural.groups,
      ungrouped: inspection.structural.ungrouped
    },
    reference_terms: inspection.reference_terms,
    ideal_model: {
      term_bits: 64, assumption: 'Termos independentes e uniformes em 64 bits; hipótese ideal, não demonstrada para estes criptogramas CBC.',
      all_term_pairs: allPairs.toString(), within_file_term_pairs: withinPairs.toString(),
      cross_file_term_pairs: crossPairs.toString(), expected_equal_cross_file_pairs: expected,
      union_bound_any_cross_file_match: Math.min(1, expected),
      interpretation: 'Estimativa condicional; ausência observada é provada pela unicidade, não pelo modelo ideal.'
    },
    controls: { synthetic, openssl_envelope: opensslEnvelope },
    controls_passed: synthetic.passed && opensslEnvelope.passed,
    execution: {
      elapsed_ms: performance.now() - started, node: process.version,
      openssl: process.versions.openssl, platform: process.platform, architecture: process.arch
    },
    conclusion: 'Ausência de grupos explicada pelo critério de igualdade e pela unicidade observada. Não confirma a preparação de 2012 e não demonstra eficácia classificatória.'
  };
  if (!result.controls_passed) throw new Error('Falha em controle funcional do diagnóstico');
  createOutput(output);
  writeJSON(path.join(output, 'diagnostic.json'), result);
  fs.writeFileSync(path.join(output, 'report.md'), reportText(result), { flag: 'wx' });
  return result;
}
