import fs from 'node:fs';
import { randomInt } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { normalizeCrypto } from '../engine/src/dataset.js';

export const CORPUS_BODY_BYTES = 5_103_443;
export const SIZE_KEYS = Object.freeze([
  'textBytes',
  'referenceKeys',
  'referencePerKey',
  'samples',
  'testsPerAlgorithm',
]);

export const BASE_CONFIG = Object.freeze({
  algorithms: Object.freeze(['Blowfish', 'RC2', 'CAST5']),
  textBytes: 8192,
  referenceKeys: 10,
  referencePerKey: 50,
  samples: 5,
  testsPerAlgorithm: 100,
});

export function testStartRange(base = BASE_CONFIG) {
  const referenceBytes = base.referenceKeys * base.referencePerKey * base.textBytes;
  const testBytes = base.testsPerAlgorithm * base.textBytes;
  if (referenceBytes + testBytes > CORPUS_BODY_BYTES) throw new RangeError('A base não cabe no texto da Bíblia.');
  const max = Math.floor((CORPUS_BODY_BYTES - testBytes) / base.textBytes) * base.textBytes;
  return { step: base.textBytes, max, positions: max / base.textBytes + 1, testBytes };
}

export function resolveSizes(sizes = {}) {
  const base = { ...BASE_CONFIG };
  for (const key of SIZE_KEYS) {
    if (sizes[key] === undefined) continue;
    if (!Number.isSafeInteger(sizes[key]) || sizes[key] < 1) throw new RangeError(`Tamanho inválido: ${key}`);
    base[key] = sizes[key];
  }
  if (base.textBytes % 8) throw new RangeError('O tamanho do arquivo deve ser múltiplo de 8 bytes.');
  if (base.samples < 2 || base.referenceKeys % base.samples)
    throw new RangeError('As amostras devem ser ao menos 2 e dividir o número de chaves da base.');
  testStartRange(base);
  return base;
}

export function buildConfig({ seed, testStartByte, sizes, crypto } = {}) {
  const base = resolveSizes(sizes);
  const range = testStartRange(base);
  const drawn = { seed: seed === undefined, testStartByte: testStartByte === undefined };
  const chosenSeed = drawn.seed ? randomInt(1, 1_000_000_000) : seed;
  const chosenStart = drawn.testStartByte ? randomInt(0, range.positions) * range.step : testStartByte;
  if (!Number.isSafeInteger(chosenSeed) || chosenSeed < 0)
    throw new RangeError('A semente deve ser um inteiro não negativo.');
  if (!Number.isSafeInteger(chosenStart) || chosenStart < 0 || chosenStart > range.max || chosenStart % range.step)
    throw new RangeError(`O início do trecho de teste deve ser múltiplo de ${range.step} entre 0 e ${range.max}.`);
  const config = {
    seed: chosenSeed,
    algorithms: crypto ? crypto.ciphers.map(cipher => cipher.label) : [...BASE_CONFIG.algorithms],
    textBytes: base.textBytes,
    referenceKeys: base.referenceKeys,
    referencePerKey: base.referencePerKey,
    samples: base.samples,
    testsPerAlgorithm: base.testsPerAlgorithm,
    ...(crypto ? { crypto: normalizeCrypto(crypto, base.referenceKeys) } : {}),
    testStartByte: chosenStart,
  };
  return { config, drawn, range };
}

export function baseSummary(config) {
  const referencePerAlgorithm = config.referenceKeys * config.referencePerKey;
  const referenceFiles = referencePerAlgorithm * config.algorithms.length;
  const testFiles = config.testsPerAlgorithm * config.algorithms.length;
  return {
    referencePerAlgorithm,
    referenceFiles,
    testFiles,
    totalFiles: referenceFiles + testFiles,
    termsPerFile: config.textBytes / 8,
    referenceTerms: (referenceFiles * config.textBytes) / 8,
  };
}

function abortError() {
  const error = new Error('Operação cancelada antes de concluir a base.');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

export function prepareDataset({ directory, config, onStage = () => {}, signal } = {}) {
  if (typeof directory !== 'string' || !directory.trim())
    return Promise.reject(new TypeError('Informe a pasta da base.'));
  if (!config || typeof config !== 'object') return Promise.reject(new TypeError('Informe a configuração da base.'));
  if (typeof onStage !== 'function') return Promise.reject(new TypeError('onStage deve ser uma função.'));
  if (signal?.aborted) return Promise.reject(abortError());
  if (fs.existsSync(directory))
    return Promise.reject(new Error('A pasta da base já existe; nenhuma base é sobrescrita: ' + directory));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./base-worker.mjs', import.meta.url), {
      execArgv: [],
      workerData: { directory, config },
    });
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate().catch(() => {});
      reject(error);
    };
    const onAbort = () => fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', message => {
      if (settled) return;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (message.type === 'stage') onStage(message.event);
      else if (message.type === 'failure') {
        const error = new Error(message.error.message);
        error.name = message.error.name ?? 'Error';
        fail(error);
      } else if (message.type === 'result') {
        settled = true;
        cleanup();
        resolve({ directory, manifest: message.manifest, inspection: message.inspection });
      }
    });
    worker.once('error', fail);
    worker.once('exit', code => {
      if (!settled) fail(new Error(`A geração da base terminou sem resultado (código ${code}).`));
    });
  });
}
