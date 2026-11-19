#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cryptogram } from './terms.js';
import { reliabilityIndexFromWeights } from './metrics.js';
import { ReferenceModel } from './reference.js';
import { loadBible, generateDataset, validateDataset } from './dataset.js';
import { checkCrypto } from './crypto.js';
import { evaluateDataset, inspectDataset, guardCost } from './evaluation.js';
import { readJSON, readCiphertext, jsonText } from './io.js';
import { benchmarkDataset } from './scale.js';
import { diagnoseDataset } from './diagnostics.js';
import { runStudy } from './study.js';

const project = fileURLToPath(new URL('..', import.meta.url));
const HELP = `Método de Lazarin (2012), laboratório JavaScript 0.6.0

Uso: node --openssl-legacy-provider src/cli.js COMANDO [opções]

  doctor                       Confere Node, cifras e integridade da Bíblia
  index-example                Índice dos pesos publicados 135 e 226
  demo [--out PASTA]            Gera e avalia um ensaio pequeno com a Bíblia
  generate --out PASTA [--protocol ARQUIVO.json]
  verify --dataset PASTA        Confere dados, recortes e recifração
  inspect --dataset PASTA       Mostra o conjunto e a estrutura encontrada
  benchmark --dataset PASTA --out PASTA [--per-algorithm 1]
                               Mede 1 a 10 casos por cifra, sem alegar eficácia
  diagnose --dataset PASTA --out PASTA
                               Diagnóstico estrutural e controles pequenos
  study --plan ARQUIVO.json --out PASTA [--concurrency 1..4]
        [--allow-expensive]    Repetições por sementes, com plano congelado
  evaluate --dataset PASTA --out PASTA [--candidates Blowfish,RC2]
           [--decision 2|3] [--profile chapter3|chapter5-experiment2]
           [--alpha 0.1] [--allow-expensive] [--max-comparisons N]
  classify --reference ARQUIVO.json --file ARQUIVO
           [--encoding raw|hex|base64] [--candidates Blowfish,RC2]
           [--decision 1|2|3] [--candidate RC2]
           [--profile chapter3|chapter5-experiment2] [--alpha 0.1]
           [--allow-expensive] [--max-comparisons N]

Blowfish, RC2 e CAST5 usam chaves de 128 bits e blocos de 64 bits em CBC.
O índice não é uma probabilidade. Este é um estudo controlado, não uma réplica exata de 2012.
`;

const allowed = {
  doctor: [],
  'index-example': [],
  demo: ['out'],
  generate: ['out', 'protocol'],
  verify: ['dataset'],
  inspect: ['dataset'],
  benchmark: ['dataset', 'out', 'per-algorithm'],
  diagnose: ['dataset', 'out'],
  study: ['plan', 'out', 'concurrency', 'allow-expensive'],
  evaluate: ['dataset', 'out', 'candidates', 'decision', 'profile', 'alpha', 'allow-expensive', 'max-comparisons'],
  classify: [
    'reference',
    'file',
    'encoding',
    'candidates',
    'decision',
    'candidate',
    'profile',
    'alpha',
    'allow-expensive',
    'max-comparisons',
  ],
};
function parse(argv) {
  const [command = 'help', ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') return { command: 'help', args: {} };
  if (!Object.hasOwn(allowed, command)) throw new Error('Comando desconhecido: ' + command);
  const args = {};
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--help') return { command: 'help', args: {} };
    const flag = rest[index];
    if (!flag.startsWith('--')) throw new Error('Argumento inesperado: ' + flag);
    const key = flag.slice(2);
    if (!allowed[command].includes(key) || Object.hasOwn(args, key))
      throw new Error('Opção desconhecida ou repetida: ' + flag);
    if (key === 'allow-expensive') args[key] = true;
    else {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error('Falta o valor de ' + flag);
      args[key] = value;
    }
  }
  return { command, args };
}
function required(args, key) {
  if (!args[key]) throw new Error('Informe --' + key);
  return path.resolve(args[key]);
}
function number(args, key, fallback) {
  if (args[key] === undefined) return fallback;
  if (args[key].trim() === '' || !Number.isFinite(Number(args[key]))) throw new Error('Número inválido em --' + key);
  return Number(args[key]);
}
function options(args) {
  return {
    candidates: args.candidates?.split(','),
    decisionType: number(args, 'decision', 3),
    alpha: number(args, 'alpha', 0.1),
    profile: args.profile ?? 'chapter3',
    allowExpensive: args['allow-expensive'] ?? false,
    ...(args['max-comparisons'] === undefined ? {} : { maxComparisons: number(args, 'max-comparisons') }),
  };
}
function output(value) {
  process.stdout.write(jsonText(value));
}

async function main() {
  const { command, args } = parse(process.argv.slice(2));
  if (command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'index-example') {
    output({
      ...reliabilityIndexFromWeights([135, 226]),
      expected_rounded: 0.643508493,
      note: 'Reproduz a fórmula a partir dos pesos publicados, não todos os dados da Figura 3.4.',
    });
  } else if (command === 'doctor') {
    const crypto = checkCrypto();
    const { metadata } = loadBible();
    output({ node: process.version, openssl: process.versions.openssl, crypto, corpus: metadata, status: 'ok' });
  } else if (command === 'generate') {
    const config = readJSON(args.protocol ? path.resolve(args.protocol) : path.join(project, 'protocols/quick.json'));
    const manifest = generateDataset(required(args, 'out'), config);
    output({
      output: path.resolve(args.out),
      algorithms: manifest.algorithms,
      records: manifest.records.length,
      config: manifest.config,
      crypto: manifest.crypto,
    });
  } else if (command === 'verify') {
    const manifest = validateDataset(required(args, 'dataset'));
    output({
      status: 'ok',
      records_verified: manifest.records.length,
      algorithms: manifest.algorithms,
      message: 'Hashes, recortes, chaves, IVs, referência e recifração conferidos.',
    });
  } else if (command === 'inspect') {
    output(inspectDataset(required(args, 'dataset')));
  } else if (command === 'benchmark') {
    output(
      benchmarkDataset(required(args, 'dataset'), required(args, 'out'), {
        perAlgorithm: number(args, 'per-algorithm', 1),
        onProgress: ({ completed, total }) => process.stderr.write(`Medição ${completed}/${total}\n`),
      }),
    );
  } else if (command === 'diagnose') {
    const result = diagnoseDataset(required(args, 'dataset'), required(args, 'out'));
    output({
      output: path.resolve(args.out),
      observed: result.observed,
      controls_passed: result.controls_passed,
      conclusion: result.conclusion,
    });
  } else if (command === 'study') {
    const result = await runStudy(required(args, 'plan'), required(args, 'out'), {
      allowExpensive: args['allow-expensive'] ?? false,
      concurrency: number(args, 'concurrency', undefined),
      onProgress: event =>
        process.stderr.write(
          `Semente ${event.seed}: ${event.completed}/${event.total}${event.status === 'complete' ? ' concluída' : ''}\n`,
        ),
    });
    output({
      output: path.resolve(args.out),
      seeds: result.summary.seeds,
      summary: result.summary,
      wall_elapsed_ms: result.wall_elapsed_ms,
      resource_measurement: result.resource_measurement,
    });
  } else if (command === 'evaluate') {
    const result = evaluateDataset(required(args, 'dataset'), required(args, 'out'), {
      ...options(args),
      onProgress: ({ completed, total }) => {
        if (completed % 10 === 0 || completed === total) process.stderr.write(`Avaliados ${completed}/${total}\n`);
      },
    });
    output({
      output: path.resolve(args.out),
      prepared: result.prepared,
      structural: result.structural,
      execution: result.execution,
    });
  } else if (command === 'classify') {
    let model = ReferenceModel.load(required(args, 'reference'));
    const opt = options(args);
    if (opt.candidates) model = model.select(opt.candidates);
    const data = readCiphertext(required(args, 'file'), args.encoding ?? 'raw');
    const unknown = Cryptogram.fromBytes('arquivo-desconhecido', data);
    guardCost(unknown.terms.length * model.terms.length, opt);
    output(model.predict(unknown, opt.decisionType, args.candidate ?? null, opt.alpha, opt.profile));
  } else if (command === 'demo') {
    const destination = args.out
      ? path.resolve(args.out)
      : path.resolve('runs', 'demo-' + new Date().toISOString().replace(/[:.]/g, '-'));
    if (fs.existsSync(destination)) throw new Error('Diretório já existe: ' + destination);
    fs.mkdirSync(destination, { recursive: true });
    generateDataset(path.join(destination, 'dataset'), readJSON(path.join(project, 'protocols/quick.json')));
    const result = evaluateDataset(path.join(destination, 'dataset'), path.join(destination, 'results'));
    output({
      output: destination,
      report: path.join(destination, 'results/report.md'),
      prepared: result.prepared,
      structural: result.structural,
      note: 'Demonstração pequena, sem alegação de superioridade ao estudo original.',
    });
  }
}
try {
  await main();
} catch (error) {
  process.stderr.write('Erro: ' + error.message + '\n');
  process.exitCode = 1;
}
