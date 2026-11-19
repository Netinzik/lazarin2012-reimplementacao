import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { generateDataset } from '../engine/src/dataset.js';
import { inspectDataset } from '../engine/src/evaluation.js';
import { loadBlockModules } from '../engine/src/crypto.js';

if (isMainThread || !parentPort) throw new Error('Este módulo deve ser iniciado como worker da interface.');
const stage = (name, extra = {}) => parentPort.postMessage({ type: 'stage', event: { stage: name, ...extra } });
try {
  const { directory, config } = workerData;
  await loadBlockModules(config.crypto?.ciphers);
  stage('generation-start');
  const manifest = generateDataset(directory, config);
  stage('generation-complete', { files: manifest.records.length });
  stage('validation-start');
  const inspection = inspectDataset(directory);
  stage('validation-complete');
  parentPort.postMessage({ type: 'result', manifest, inspection });
} catch (error) {
  parentPort.postMessage({ type: 'failure', error: { name: error.name, message: error.message } });
  process.exitCode = 1;
} finally {
  parentPort.close();
}
