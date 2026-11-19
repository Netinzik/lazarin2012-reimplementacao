#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { BASE_CONFIG, SIZE_KEYS, buildConfig, baseSummary, prepareDataset } from './base.mjs';
import { runWizard, describeBackend, cipherLine } from './assistente.mjs';
import { tracePrediction, summarizeCandidates, structuralPredictor } from './trace.mjs';
import {
  LINE,
  DOUBLE_LINE,
  integer,
  short,
  listJoin,
  ruleShort,
  duration,
  renderInput,
  renderScores,
  renderDecision,
  groupComposition,
  describeComposition,
  renderAutomaticSummary,
  renderVerdict,
  renderStructuralStep,
  renderPreparedReference,
  renderControl,
  renderStudyResults,
  renderCompactCase,
  renderBatchSummary,
} from './presenter.mjs';
import { ReferenceModel } from '../engine/src/reference.js';
import { Cryptogram } from '../engine/src/terms.js';
import { checkCrypto, findOpenSSL, loadBlockModules, probeCipher } from '../engine/src/crypto.js';
import { loadBible, cipherSizes } from '../engine/src/dataset.js';
import { structuralControls } from '../engine/src/diagnostics.js';
import { LazarinModel } from '../engine/src/pipeline.js';
import { readCiphertext, localFile } from '../engine/src/io.js';

export const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_LABELS = [...BASE_CONFIG.algorithms];
const STUDY_DIR = path.join('engine', 'runs', 'validacao-5-sementes');
const CONTROL_FILES = [
  ['r0', [0, 1]],
  ['r1', [0, 3]],
  ['r2', [255, 254]],
  ['r3', [255, 252]],
];
const CONTROL_UNKNOWN = [0, 1, 255];

const HELP = `Reimplementação do método de Lazarin (2012) · classificação de criptogramas

Comandos:
  npm run classificar     Abre o assistente (motor, modo, cifras, chaves, IV, tamanhos, decisão), gera a base e classifica
  npm run exemplo         Exemplo numérico da dissertação (pesos 135 e 226)
  npm run grupos          Caminho automático (grupos e cores) com dados artificiais
  npm run resultados      Resultados da avaliação oficial (5 sementes)
  npm run ambiente        Confere Node, OpenSSL e cifras disponíveis
  npm test                Todos os testes

Opções de classificar (depois de "--"):
  --config ARQUIVO.json         Repete uma execução com todas as escolhas salvas (config.json da sessão)
  --padrao                      Pula o assistente: Blowfish, RC2 e CAST5 em CBC, semente e trecho sorteados
  --semente N                   Repete uma execução: usa esta semente em vez de sortear
  --inicio-teste N              Repete uma execução: usa este início do trecho de teste em vez de sortear
  --casos N                     Quantos arquivos de teste classificar (padrão: todos)
  --candidatos Blowfish,RC2     Cifras candidatas
  --decisao 1|2|3               Tipo de decisão (padrão 3)
  --regra chapter3|chapter5-experiment2
  --alpha 0.1                   Limiar dos Tipos 1 e 2 com limiar
  --hipotese RC2                Hipótese do Tipo 1
  --peso-zero perde|abster      Cifra com peso zero em todas as amostras: perde os confrontos (padrão) ou a regra se abstém
  --arquivo CAMINHO             Classifica um arquivo externo (bytes brutos, múltiplo de 8)
  --sem-menu                    Não abre o menu no final
`;

export function validateDecisionSettings(settings, labels = DEFAULT_LABELS) {
  const { candidates, decisionType, candidate, alpha, profile, zeroWeight = 'perde' } = settings;
  if (
    !Array.isArray(candidates) ||
    !candidates.length ||
    new Set(candidates).size !== candidates.length ||
    candidates.some(c => !labels.includes(c))
  )
    throw new Error(`Candidatos inválidos ou repetidos (use: ${labels.join(', ')}).`);
  if (![1, 2, 3].includes(decisionType)) throw new Error('Decisão deve ser 1, 2 ou 3.');
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new Error('Alfa deve estar entre 0 e 1.');
  if (!['chapter3', 'chapter5-experiment2'].includes(profile)) throw new Error('Regra desconhecida.');
  if (decisionType === 2 && candidates.length !== 2) throw new Error('Tipo 2 exige exatamente dois candidatos.');
  if (decisionType === 3 && candidates.length < 2) throw new Error('Tipo 3 exige ao menos dois candidatos.');
  if (decisionType === 1 && !candidates.includes(candidate))
    throw new Error('A hipótese deve estar entre os candidatos.');
  if (profile === 'chapter5-experiment2' && decisionType !== 2) throw new Error('A regra com limiar exige Tipo 2.');
  if (!['perde', 'abster'].includes(zeroWeight)) throw new Error('Regra de peso zero deve ser perde ou abster.');
  return { candidates, decisionType, candidate, alpha, profile, zeroWeight };
}

export function parseArgs(argv) {
  const args = argv.filter(arg => arg !== '--');
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'classificar';
  if (!['classificar', 'grupos', 'resultados', 'ambiente', 'help'].includes(command))
    throw new Error('Comando desconhecido: ' + command);
  const allowed = new Set([
    'semente',
    'inicio-teste',
    'casos',
    'candidatos',
    'decisao',
    'hipotese',
    'alpha',
    'regra',
    'sem-menu',
    'arquivo',
    'help',
    'config',
    'padrao',
    'peso-zero',
  ]);
  const flags = {};
  while (args.length) {
    const flag = args.shift();
    if (!flag?.startsWith('--') || !allowed.has(flag.slice(2)) || Object.hasOwn(flags, flag.slice(2)))
      throw new Error('Opção desconhecida ou repetida: ' + flag);
    const key = flag.slice(2);
    if (['sem-menu', 'help', 'padrao'].includes(key)) flags[key] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('Falta valor para ' + flag);
      flags[key] = value;
    }
  }
  if (command === 'help' || flags.help) return { command: 'help' };
  const integerFlag = (key, fallback) => {
    if (flags[key] === undefined) return fallback;
    const n = Number(flags[key]);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('Inteiro não negativo inválido: --' + key);
    return n;
  };
  const fixed = [
    'semente',
    'inicio-teste',
    'candidatos',
    'decisao',
    'hipotese',
    'alpha',
    'regra',
    'arquivo',
    'peso-zero',
  ];
  if (flags.config && fixed.some(key => flags[key] !== undefined))
    throw new Error('Com --config, as escolhas vêm do arquivo; use só --casos e --sem-menu junto.');
  const candidates = (flags.candidatos ?? DEFAULT_LABELS.join(',')).split(',').map(s => s.trim());
  const settings = validateDecisionSettings({
    candidates,
    decisionType: integerFlag('decisao', 3),
    candidate: flags.hipotese ?? 'RC2',
    alpha: flags.alpha === undefined ? 0.1 : Number(flags.alpha),
    profile: flags.regra ?? 'chapter3',
    zeroWeight: flags['peso-zero'] ?? 'perde',
  });
  const cases = integerFlag('casos');
  if (cases !== undefined && cases < 1) throw new Error('--casos deve ser ao menos 1.');
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    command,
    settings,
    cases,
    seed: integerFlag('semente'),
    testStartByte: integerFlag('inicio-teste'),
    interactive: !flags['sem-menu'] && terminal,
    wizard: terminal && !flags.padrao && !flags.config && !fixed.some(key => flags[key] !== undefined),
    configFile: flags.config ? path.resolve(flags.config) : null,
    file: flags.arquivo ? path.resolve(flags.arquivo) : null,
  };
}

export function orderedTests(manifest, labels = manifest.algorithms) {
  const groups = labels.map(label => manifest.records.filter(r => r.split === 'test' && r.algorithm === label));
  const ordered = [];
  for (let i = 0; i < Math.max(0, ...groups.map(g => g.length)); i++)
    for (const group of groups) if (group[i]) ordered.push(group[i]);
  return ordered;
}

export function textPreview(body, start, length = 72) {
  const raw = new TextDecoder('utf-8').decode(body.subarray(start, start + length * 3));
  const clean = raw.replace(/^�+/, '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? clean.slice(0, length).trimEnd() + '…' : clean;
}

export function replayCommand(config) {
  return `npm run classificar -- --semente ${config.seed} --inicio-teste ${config.testStartByte}`;
}

export function replayConfigCommand(file) {
  return `npm run classificar -- --config ${file}`;
}

export function isClassic(config) {
  return !config.crypto && SIZE_KEYS.every(key => config[key] === BASE_CONFIG[key]);
}

export function readPlan(file) {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Não foi possível ler ${file}: ${error.message}`, { cause: error });
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('config.json inválido.');
  const unknown = Object.keys(plan).filter(
    key => !['seed', 'testStartByte', 'sizes', 'crypto', 'settings', 'cases'].includes(key),
  );
  if (unknown.length) throw new Error('Campos desconhecidos no config.json: ' + unknown.join(', '));
  if (plan.cases !== undefined && (!Number.isSafeInteger(plan.cases) || plan.cases < 1))
    throw new Error('cases deve ser inteiro ≥ 1.');
  return plan;
}

const POLICY_TEXT = {
  keys: {
    derivadas: 'derivadas da semente',
    fixa: 'uma chave fixa por cifra, a mesma na base e nos testes',
    manuais: 'digitadas',
  },
  iv: {
    'por-arquivo': 'um IV por arquivo, derivado da semente',
    fixo: 'um IV fixo por cifra',
    zero: 'IV zero',
    nenhum: 'sem IV',
  },
};

export function policyLines(config) {
  const ciphers = config.crypto.ciphers;
  const summary = (kind, pick) => {
    const values = [...new Set(ciphers.map(pick))];
    return values.length === 1
      ? POLICY_TEXT[kind][values[0]]
      : ciphers.map(c => `${c.label}: ${POLICY_TEXT[kind][pick(c)]}`).join(' · ');
  };
  return {
    keys: summary('keys', c => c.keys.policy),
    iv: summary('iv', c => c.iv.policy),
    testKey: ciphers.every(c => c.keys.policy === 'fixa') ? 'com a mesma chave da base' : 'com chave própria',
  };
}

const seconds = s => `${s.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
const parseNumber = value => Number(String(value).trim().replace(',', '.'));

function createOutput(folderName) {
  let folder = null,
    transcript = null;
  if (folderName) {
    folder = path.join(KIT_ROOT, 'runs', 'sessoes', folderName);
    fs.mkdirSync(folder, { recursive: true });
    transcript = path.join(folder, 'terminal.txt');
    fs.writeFileSync(transcript, '', { flag: 'wx' });
  }
  const live = Boolean(process.stdout.isTTY);
  let width = 0;
  const output = {
    folder,
    log(message = '') {
      const value = String(message);
      console.log(value);
      if (transcript) fs.appendFileSync(transcript, value + '\n');
    },
    record(message) {
      if (transcript) fs.appendFileSync(transcript, String(message) + '\n');
    },
    update(message) {
      if (!live) return;
      process.stdout.write('\r' + message.padEnd(width));
      width = Math.max(width, message.length);
    },
    clear() {
      if (live && width) process.stdout.write('\r' + ' '.repeat(width) + '\r');
      width = 0;
    },
    done(message) {
      output.clear();
      output.log(message);
    },
  };
  return output;
}

const bar = (percent, size = 16) => {
  const filled = Math.round((percent / 100) * size);
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)} ${String(Math.floor(percent)).padStart(3)}%`;
};

function progressLine(p, final = false) {
  const elapsed = p.elapsedMs / 1000;
  const eta = !final && p.processed ? (elapsed * (p.total - p.processed)) / p.processed : null;
  return (
    `    ${bar(p.percent)} · ${integer(p.processed)}/${integer(p.total)} criptotermos · ${seconds(elapsed)}` +
    (eta === null ? '' : ` · restam ~${seconds(eta)}`)
  );
}

function batchProgressLine({ position, total, eta }, p) {
  return (
    `    ${String(position).padStart(String(total).length)}/${total}  ${bar(p.percent, 12)}` +
    (eta ? ` · bateria: restam ~${duration(eta)}` : '')
  );
}

function banner(out, title, subtitle = []) {
  out.log(DOUBLE_LINE);
  out.log(`  ${title}`);
  out.log(DOUBLE_LINE);
  for (const line of subtitle) out.log(`  ${line}`);
}

function environmentStep(out, config = null) {
  const bible = loadBible();
  out.log('');
  out.log('[1] AMBIENTE');
  if (!config?.crypto) {
    const crypto = checkCrypto();
    out.log(
      `    Node ${process.version} · OpenSSL ${process.versions.openssl} · ${listJoin(crypto.algorithms)} disponíveis`,
    );
    out.log('    Modo CBC · chave de 128 bits · bloco de 64 bits');
  } else {
    const { backend, mode, ciphers } = config.crypto;
    out.log(`    Node ${process.version} · motor de cifragem: ${describeBackend(backend)}`);
    out.log(`    Modo ${mode} · ${ciphers.length} cifras, cada uma conferida com uma cifragem de teste:`);
    for (const cipher of ciphers) {
      probeCipher(cipher, mode, backend, cipherSizes(cipher, mode));
      out.log(`      ✓ ${cipherLine(cipher, mode)}`);
    }
  }
  out.log('    Texto-base (Bíblia, Projeto Gutenberg) conferido por SHA-256 ✓');
  return bible;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') {
    console.log(HELP);
    return;
  }
  if (options.command === 'grupos') {
    console.log(renderControl(structuralControls(), { files: CONTROL_FILES, unknown: CONTROL_UNKNOWN }));
    return;
  }
  if (options.command === 'resultados') {
    console.log(
      renderStudyResults(JSON.parse(fs.readFileSync(path.join(KIT_ROOT, STUDY_DIR, 'results.json'), 'utf8'))),
    );
    return;
  }
  if (options.command === 'ambiente') {
    const out = createOutput(null);
    banner(out, 'MÉTODO DE LAZARIN (2012) · Conferência do ambiente');
    environmentStep(out);
    const systems = findOpenSSL();
    out.log(
      systems.length
        ? `    OpenSSL do sistema: ${systems.map(s => `${s.path} (${s.version.split(' (')[0]})`).join(' · ')}`
        : '    OpenSSL do sistema: não encontrado (o motor Node continua disponível)',
    );
    out.log('    Tudo pronto ✓');
    return;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Interrompido pelo usuário.'));
  process.once('SIGINT', cancel);
  let rl,
    heartbeat,
    out = null;
  const wizardLines = [];
  try {
    let plan = null;
    if (options.configFile) plan = readPlan(options.configFile);
    else if (options.wizard) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', cancel);
      const say = line => {
        console.log(line);
        wizardLines.push(line);
      };
      const ask = (question, fallback) =>
        rl
          .question(`  ${question}${fallback === undefined || fallback === '' ? ' ' : ` [${fallback}] `}`, {
            signal: controller.signal,
          })
          .then(answer => {
            const value = answer.trim() || (fallback ?? '');
            wizardLines.push(`  ${question} → ${value === '' ? '(Enter)' : value}`);
            return value;
          });
      plan = await runWizard({ ask, log: say, validateSettings: validateDecisionSettings });
    }
    plan ??= {
      seed: options.seed,
      testStartByte: options.testStartByte,
      settings: options.settings,
      cases: options.cases,
    };
    if (options.configFile && options.cases !== undefined) plan.cases = options.cases;
    if (plan.crypto) await loadBlockModules(plan.crypto.ciphers);
    const { config, drawn, range } = buildConfig({
      seed: plan.seed,
      testStartByte: plan.testStartByte,
      sizes: plan.sizes,
      crypto: plan.crypto,
    });
    if (plan.seedDrawn) drawn.seed = true;
    let settings = validateDecisionSettings(
      plan.settings ?? {
        candidates: [...config.algorithms],
        decisionType: 3,
        candidate: config.algorithms[0],
        alpha: 0.1,
        profile: 'chapter3',
        zeroWeight: 'perde',
      },
      config.algorithms,
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    out = createOutput(`${stamp}-semente-${config.seed}`);
    for (const line of wizardLines) out.record(line);
    const log = out.log;
    banner(out, 'MÉTODO DE LAZARIN (2012) · Classificação de criptogramas', [
      `Pergunta: qual destas cifras gerou o arquivo? ${listJoin(settings.candidates, 'ou')}`,
      'O método não decifra o arquivo nem descobre a chave: compara padrões de bits.',
    ]);
    const bible = environmentStep(out, config);

    const summary = baseSummary(config);
    const testEnd = config.testStartByte + range.testBytes - 1;
    log('');
    log('[2] BASE DE REFERÊNCIA · gerada agora a partir da Bíblia');
    const policies = config.crypto ? policyLines(config) : null;
    log(
      `    Semente ${drawn.seed ? 'sorteada' : 'informada'}: ${config.seed} → define as chaves e os IVs ${config.crypto ? 'derivados' : 'de todas as cifras'}`,
    );
    if (policies) {
      log(`    Chaves: ${policies.keys}`);
      log(`    IVs: ${policies.iv}`);
    }
    log(
      `    Trecho de teste ${drawn.testStartByte ? 'sorteado' : 'informado'}: bytes ${integer(config.testStartByte)} a ${integer(testEnd)} do texto bíblico` +
        ` (posição ${integer(config.testStartByte / range.step + 1)} de ${integer(range.positions)})`,
    );
    log(
      `    Início do trecho de teste (texto claro, só para ilustrar): "${textPreview(bible.body, config.testStartByte)}"`,
    );
    log(
      `    O restante do texto forma a base: ${integer(summary.referenceFiles)} arquivos de ${integer(config.textBytes)} bytes ` +
        `(${integer(summary.referencePerAlgorithm)} por cifra, ${config.referenceKeys} chaves)`,
    );
    log(
      `    Testes: ${integer(summary.testFiles)} arquivos (${config.testsPerAlgorithm} por cifra), ${policies?.testKey ?? 'com chave própria'}, fora da base`,
    );

    const datasetDir = path.join(out.folder, 'base');
    const start = performance.now();
    let phase = 'Gerando os arquivos cifrados',
      phaseStart = start;
    heartbeat = setInterval(() => out.update(`    ${phase}… ${seconds((performance.now() - phaseStart) / 1000)}`), 250);
    let dataset;
    try {
      dataset = await prepareDataset({
        directory: datasetDir,
        config,
        signal: controller.signal,
        onStage: event => {
          if (event.stage === 'generation-complete')
            out.done(
              `    ${integer(event.files)} arquivos cifrados gerados ✓ (${seconds((performance.now() - phaseStart) / 1000)})`,
            );
          else if (event.stage === 'validation-start') {
            phase = 'Validando: recifrando cada arquivo e conferindo hashes';
            phaseStart = performance.now();
          }
        },
      });
    } finally {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    out.done(
      `    Validação: arquivos recifrados e conferidos com os hashes registrados ✓ (${seconds((performance.now() - phaseStart) / 1000)})`,
    );
    const inspection = dataset.inspection;
    log(
      `    Cada arquivo é dividido em criptotermos de 8 bytes: ${integer(inspection.reference_terms.occurrences)} na base, ` +
        `${integer(inspection.reference_terms.distinct)} distintos`,
    );
    log('');
    log(renderStructuralStep(inspection.structural));

    let baseModel,
      selectedModel,
      lastKey,
      structuralModel,
      groupContents = null,
      fresh = true,
      cursor = 0,
      lastRecord = null,
      caseCount = 0;
    const loadReference = () => {
      const key = settings.candidates.join(',');
      if (selectedModel && lastKey === key) return;
      baseModel ??= ReferenceModel.load(path.join(dataset.directory, 'reference.json'));
      selectedModel =
        settings.candidates.length === baseModel.labels.length &&
        settings.candidates.every((v, i) => v === baseModel.labels[i])
          ? baseModel
          : baseModel.select(settings.candidates);
      const reorganized = !fresh;
      lastKey = key;
      fresh = false;
      if (reorganized) log('');
      log(
        renderPreparedReference(summarizeCandidates(selectedModel), {
          keys: config.referenceKeys,
          samples: config.samples,
          hasGroups: inspection.structural.groups >= 2,
          reorganizedFor: reorganized ? settings.candidates : null,
        }),
      );
    };

    const automaticFor = unknown => {
      if (inspection.structural.groups < 2)
        return { ...inspection.structural, status: 'insufficient_reference_structure', prediction: null };
      if (!structuralModel) {
        const refs = dataset.manifest.records.filter(r => r.split === 'reference');
        const fitted = LazarinModel.fit(
          refs.map((r, i) => Cryptogram.fromBytes('ref-' + i, readCiphertext(localFile(dataset.directory, r.path)))),
        );
        structuralModel = structuralPredictor(fitted);
        groupContents = groupComposition(fitted, refs);
      }
      return { ...inspection.structural, ...structuralModel(unknown, { zeroWeight: settings.zeroWeight }) };
    };

    const classify = async (record, compact = null) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      loadReference();
      const input = options.file ?? localFile(dataset.directory, record.path);
      const bytes = readCiphertext(input),
        unknown = Cryptogram.fromBytes('entrada-sem-rotulo', bytes);
      const comparisons = unknown.terms.length * selectedModel.terms.length;
      let prediction;
      if (compact) {
        prediction = await tracePrediction(selectedModel, unknown, {
          ...settings,
          signal: controller.signal,
          onProgress: p => out.update(batchProgressLine(compact, p)),
        });
      } else {
        const allTests = options.file ? [] : orderedTests(dataset.manifest);
        const title = options.file
          ? 'ARQUIVO EXTERNO'
          : `ARQUIVO DE TESTE ${allTests.indexOf(record) + 1} de ${allTests.length}`;
        log('');
        log(LINE);
        log(`  ${title} · ${ruleShort(settings)}`);
        log(LINE);
        log(renderInput(bytes, { hidden: !options.file }));
        log('');
        log('[5] PESOS · distância de Hamming = quantos bits diferem entre dois criptotermos');
        log('    Cada criptotermo da entrada procura o termo mais próximo dentro de cada amostra.');
        log('    Se ele estiver tão perto quanto o melhor termo do resto da base, a amostra soma pontos.');
        log(
          `    Comparações: ${integer(unknown.terms.length)} × ${integer(selectedModel.terms.length)} = ${integer(comparisons)}`,
        );
        let last = null;
        prediction = await tracePrediction(selectedModel, unknown, {
          ...settings,
          signal: controller.signal,
          onProgress: p => {
            last = p;
            out.update(progressLine(p));
          },
        });
        out.done(progressLine(last, true));
        log('');
        log(renderScores(prediction));
        log('');
        log(renderDecision(prediction, { hypothesis: settings.candidate }));
      }
      const structural = automaticFor(unknown);
      if (!compact && structural.groups >= 2)
        log(`    Caminho automático: ${structural.prediction ?? 'SEM CLASSE'} (grupo do método, não nome de cifra)`);
      const automatic = structural.groups >= 2 ? (structural.prediction ?? null) : undefined;
      const actual = options.file ? null : record.algorithm;
      if (!compact) {
        log('');
        log(renderVerdict(prediction, { actual, candidates: settings.candidates }));
        if (automatic && groupContents?.has(automatic))
          log(
            `    Caminho automático: ${automatic} → na base, esse grupo tem arquivos de ${describeComposition(groupContents.get(automatic))}`,
          );
      }
      caseCount++;
      const resultFile = path.join(out.folder, `caso-${String(caseCount).padStart(4, '0')}.json`);
      fs.writeFileSync(
        resultFile,
        JSON.stringify(
          {
            engine_version: '0.6.0',
            config,
            settings,
            input: {
              sha256: createHash('sha256').update(bytes).digest('hex'),
              bytes: bytes.length,
              source: options.file ?? path.join('base', record.path),
            },
            result: prediction,
            structural,
            actual,
            correct: actual === null || prediction.prediction === null ? null : actual === prediction.prediction,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      if (!compact) log(`    Caso salvo em ${path.relative(KIT_ROOT, resultFile)}`);
      lastRecord = record;
      return {
        actual,
        prediction: prediction.prediction,
        ...(automatic === undefined ? {} : { automatic }),
        ...(prediction.prediction == null ? { abstention: prediction.abstention_reason ?? prediction.status } : {}),
      };
    };

    const tests = () => orderedTests(dataset.manifest, settings.candidates);
    loadReference();
    const batchSize = options.file ? 1 : Math.min(plan.cases ?? Infinity, tests().length);
    const labelWidth = Math.max(8, ...config.algorithms.map(label => label.length));
    const savedConfig = path.join(out.folder, 'config.json');
    const generated = dataset.manifest.config;
    fs.writeFileSync(
      savedConfig,
      JSON.stringify(
        {
          seed: generated.seed,
          testStartByte: generated.testStartByte,
          sizes: Object.fromEntries(SIZE_KEYS.map(key => [key, generated[key]])),
          ...(generated.crypto ? { crypto: generated.crypto } : {}),
          settings,
          cases: batchSize,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    const outcomes = [];
    const compactMode = batchSize > 3;
    const batchStart = performance.now();
    try {
      for (let i = 0; i < batchSize; i++) {
        const record = options.file ? null : tests()[cursor++];
        if (compactMode && i === 0) {
          log('');
          log(`Bateria de ${batchSize} arquivos: o primeiro aparece com as 8 etapas; os demais, uma linha cada.`);
        }
        if (compactMode && i > 0) {
          if (i === 1) {
            log('');
            log(LINE);
            log(`  ARQUIVOS 2 A ${batchSize} · mesmas 8 etapas, uma linha por arquivo · ${ruleShort(settings)}`);
            log(LINE);
          }
          const elapsed = (performance.now() - batchStart) / 1000;
          const outcome = await classify(record, {
            position: i + 1,
            total: batchSize,
            eta: (elapsed / i) * (batchSize - i),
          });
          outcomes.push(outcome);
          out.done(renderCompactCase({ position: i + 1, total: batchSize, ...outcome, outcomes, labelWidth }));
        } else outcomes.push(await classify(record));
      }
    } finally {
      if (batchSize > 1 && outcomes.length) {
        out.clear();
        log('');
        log(
          renderBatchSummary(outcomes, {
            labels: settings.candidates,
            context: `semente ${config.seed} · ${ruleShort(settings)}`,
            total: batchSize,
            seconds: (performance.now() - batchStart) / 1000,
            structuralGroups: inspection.structural.groups,
          }),
        );
        if (groupContents) log(renderAutomaticSummary(outcomes, groupContents));
      }
      log('');
      log(
        `  Registro desta execução (terminal, casos, base cifrada e config.json): ${path.relative(KIT_ROOT, out.folder)}`,
      );
      log('  Para repetir exatamente esta execução (todas as escolhas estão no config.json):');
      log(`    ${replayConfigCommand(path.relative(KIT_ROOT, savedConfig))}`);
      if (isClassic(config) && !options.file) log(`    ou, só com a semente e o trecho: ${replayCommand(config)}`);
    }
    if (!options.interactive) return;

    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', cancel);
    }
    const ask = (question, fallback) =>
      rl
        .question(`  ${question}${fallback === undefined ? ' ' : ` [${fallback}] `}`, { signal: controller.signal })
        .then(answer => answer.trim() || fallback);
    while (!controller.signal.aborted) {
      log('');
      log('O que fazer agora?');
      log('  1  Repetir o último arquivo (útil depois de mudar a regra)');
      log('  2  Próximo arquivo de teste');
      log('  3  Mudar a regra de decisão (candidatos, tipo, alfa)');
      log('  4  Ver o caminho automático funcionando com dados artificiais');
      log('  5  Ver os resultados da avaliação oficial (5 sementes)');
      log('  0  Sair');
      const choice = await ask('Escolha:', '0');
      out.record(`Escolha: ${choice}`);
      if (choice === '0') break;
      try {
        if (choice === '1') await classify(lastRecord ?? tests()[0]);
        else if (choice === '2') {
          if (options.file) log('Com --arquivo a entrada é fixa. Use 1 para repetir.');
          else {
            const available = tests();
            await classify(available[cursor++ % available.length]);
          }
        } else if (choice === '3') {
          const candidates = String(await ask('Candidatos, separados por vírgula:', settings.candidates.join(',')))
            .split(',')
            .map(s => s.trim());
          const decisionType = parseNumber(
            await ask(
              'Tipo de decisão (1 = testa uma hipótese · 2 = duas cifras · 3 = todos os pares):',
              settings.decisionType,
            ),
          );
          let profile = 'chapter3',
            alpha = settings.alpha,
            candidate = settings.candidate;
          if (decisionType === 2)
            profile = await ask(
              'Regra do Tipo 2 (chapter3 = menor VR · chapter5-experiment2 = com limiar alfa):',
              settings.profile,
            );
          if (decisionType === 1)
            candidate = await ask(
              'Hipótese a testar:',
              candidates.includes(settings.candidate) ? settings.candidate : candidates[0],
            );
          if (decisionType === 1 || profile === 'chapter5-experiment2')
            alpha = parseNumber(await ask('Alfa (0 a 1):', short(settings.alpha)));
          const zeroWeight = await ask(
            'Cifra com peso zero em todas as amostras (perde = perde os confrontos · abster = a regra se abstém):',
            settings.zeroWeight,
          );
          settings = validateDecisionSettings(
            { candidates, decisionType, profile, alpha, candidate, zeroWeight },
            config.algorithms,
          );
          log(`Regra definida: ${ruleShort(settings)}. Escolha 1 para recalcular o mesmo arquivo.`);
        } else if (choice === '4') {
          log('');
          log(renderControl(structuralControls(), { files: CONTROL_FILES, unknown: CONTROL_UNKNOWN }));
        } else if (choice === '5') {
          log('');
          log(renderStudyResults(JSON.parse(fs.readFileSync(path.join(KIT_ROOT, STUDY_DIR, 'results.json'), 'utf8'))));
        } else log('Opção desconhecida.');
      } catch (error) {
        if (controller.signal.aborted) throw error;
        log('Não foi possível: ' + error.message);
      }
    }
    log('');
    log(`Sessão encerrada. Registro em ${path.relative(KIT_ROOT, out.folder)}`);
  } catch (error) {
    out?.record('[ERRO] ' + error.message);
    throw error;
  } finally {
    clearInterval(heartbeat);
    rl?.close();
    process.removeListener('SIGINT', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    if (process.stdout.isTTY) process.stdout.write('\n');
    console.error('[ERRO] ' + error.message);
    process.exitCode = error.name === 'AbortError' ? 130 : 1;
  });
}
