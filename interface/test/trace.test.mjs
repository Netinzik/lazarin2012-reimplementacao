import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldToUI } from 'node:timers/promises';
import { ReferenceModel } from '../../engine/src/reference.js';
import { Cryptogram } from '../../engine/src/terms.js';
import { tracePrediction, summarizeCandidates } from '../trace.mjs';

const MAX = (1n << 64n) - 1n;
const HIGH = 1n << 63n;

function sharedModel() {
  return ReferenceModel.fromSamples(
    new Map([
      [
        'A',
        [
          [0n, 1n, HIGH | 3n],
          [0n, 3n, MAX],
        ],
      ],
      [
        'B',
        [
          [2n, 4n, HIGH],
          [2n, 5n, MAX],
        ],
      ],
      [
        'C',
        [
          [255n, HIGH | 1n],
          [254n, 253n],
        ],
      ],
    ]),
  );
}
function sharedUnknown() {
  return Cryptogram.fromTerms('desconhecido', [0n, 0n, 1n, 4n, 255n, HIGH, MAX, HIGH | 1n]);
}

test('trace preserva resultado completo com repetições, termos compartilhados e 64 bits', async () => {
  const model = sharedModel(),
    unknown = sharedUnknown();
  const expected = model.predict(unknown);
  for (const chunkSize of [1, 2, 3, 32, 100]) {
    assert.deepEqual(await tracePrediction(model, unknown, { chunkSize }), expected);
  }
});

test('trace preserva Tipos 1 e 2 e perfil experimental para diferentes alfas', async () => {
  const unknown = sharedUnknown();
  for (const alpha of [0, 0.1, 1]) {
    const full = sharedModel();
    for (const candidate of full.labels) {
      assert.deepEqual(
        await tracePrediction(full, unknown, { decisionType: 1, candidate, alpha, chunkSize: 2 }),
        full.predict(unknown, 1, candidate, alpha),
      );
    }
    const pair = full.select(['A', 'B']);
    for (const profile of ['chapter3', 'chapter5-experiment2']) {
      assert.deepEqual(
        await tracePrediction(pair, unknown, { decisionType: 2, alpha, profile, chunkSize: 3 }),
        pair.predict(unknown, 2, null, alpha, profile),
      );
    }
  }
});

test('trace mantém índice indefinido e não remove candidato de média zero', async () => {
  const model = ReferenceModel.fromSamples({ A: [[0n], [0n]], B: [[MAX], [MAX]] });
  const unknown = Cryptogram.fromTerms('repetido', [0n, 0n]);
  const result = await tracePrediction(model, unknown, { chunkSize: 1 });
  assert.deepEqual(result, model.predict(unknown));
  assert.equal(result.status, 'undefined_index');
  assert.equal(result.scores.B.value, null);
  assert.equal(result.scores.B.error, 'zero_mean');
  assert.deepEqual(
    await tracePrediction(model, unknown, { decisionType: 1, candidate: 'A', chunkSize: 1 }),
    model.predict(unknown, 1, 'A'),
  );
});

test('trace não trunca índice negativo e conserva o erro de decisão inválida', async () => {
  const model = ReferenceModel.fromSamples({ A: [[0n], [1n], [2n]], B: [[MAX], [MAX - 1n]] });
  const unknown = Cryptogram.fromTerms('unitario', [0n]);
  const result = await tracePrediction(model, unknown, { decisionType: 1, candidate: 'A', alpha: 1 });
  assert.deepEqual(result, model.predict(unknown, 1, 'A', 1));
  assert.ok(result.scores.A.value < 0);
  await assert.rejects(tracePrediction(model, unknown, { decisionType: 2, profile: 'desconhecido' }), /Perfil/);
});

test('trace preserva desempate e ordem inclusive rótulos numéricos', async () => {
  const model = ReferenceModel.fromSamples(
    new Map([
      ['10', [[0n], [0n]]],
      ['2', [[0n], [0n]]],
      ['__proto__', [[0n], [0n]]],
    ]),
  );
  const unknown = Cryptogram.fromTerms('empate', [0n, 0n]);
  assert.deepEqual(await tracePrediction(model, unknown, { chunkSize: 1 }), model.predict(unknown));
  const pair = model.select(['10', '2']);
  for (const profile of ['chapter3', 'chapter5-experiment2']) {
    assert.deepEqual(
      await tracePrediction(pair, unknown, { decisionType: 2, profile, chunkSize: 1 }),
      pair.predict(unknown, 2, null, 0.1, profile),
    );
  }
});

test('progresso relata chunks e contagens nominais sem perder a última parte', async () => {
  const model = sharedModel();
  const unknown = Cryptogram.fromTerms('cinco', [0n, 1n, 4n, 255n, MAX]);
  const progress = [],
    chunkLengths = [];
  const original = model.weights.bind(model);
  model.weights = part => {
    chunkLengths.push(part.terms.length);
    return original(part);
  };
  await tracePrediction(model, unknown, { chunkSize: 2, onProgress: event => progress.push(event) });
  assert.deepEqual(chunkLengths, [2, 2, 1]);
  assert.deepEqual(
    progress.map(p => p.processed),
    [2, 4, 5],
  );
  assert.deepEqual(
    progress.map(p => p.percent),
    [40, 80, 100],
  );
  for (const event of progress) {
    assert.deepEqual(Object.keys(event), [
      'processed',
      'total',
      'comparisons',
      'estimatedComparisons',
      'elapsedMs',
      'percent',
    ]);
    assert.equal(event.total, 5);
    assert.equal(event.comparisons, event.processed * model.terms.length);
    assert.equal(event.estimatedComparisons, 5 * model.terms.length);
    assert.ok(event.elapsedMs >= 0);
  }
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].elapsedMs >= progress[i - 1].elapsedMs);
});

test('trace cede o event loop entre partes para permitir atualização da interface', async () => {
  const model = sharedModel();
  const ticks = [];
  let ticked = false;
  setImmediate(() => {
    ticked = true;
  });
  await tracePrediction(model, sharedUnknown(), {
    chunkSize: 1,
    onProgress: () => ticks.push(ticked),
  });
  assert.equal(ticks[0], false);
  assert.equal(ticks.at(-1), true);
});

test('cancelamento prévio não calcula pesos nem publica progresso', async () => {
  const controller = new AbortController();
  controller.abort('pedido do usuário');
  const model = sharedModel();
  model.weights = () => assert.fail('Não deve calcular depois de cancelado.');
  await assert.rejects(
    tracePrediction(model, sharedUnknown(), {
      signal: controller.signal,
      onProgress: () => assert.fail('Sem progresso.'),
    }),
    error => error.name === 'AbortError' && error.code === 'ABORT_ERR' && error.cause === 'pedido do usuário',
  );
});

test('cancelamento durante progresso interrompe antes do próximo chunk', async () => {
  const model = sharedModel(),
    controller = new AbortController(),
    progress = [];
  await assert.rejects(
    tracePrediction(model, sharedUnknown(), {
      chunkSize: 2,
      signal: controller.signal,
      onProgress: event => {
        progress.push(event);
        controller.abort();
      },
    }),
    { name: 'AbortError', code: 'ABORT_ERR' },
  );
  assert.equal(progress.length, 1);
  assert.equal(progress[0].processed, 2);
});

test('cancelamento agendado é observado no yield e nenhum resultado parcial vira decisão', async () => {
  const model = sharedModel(),
    controller = new AbortController(),
    progress = [];
  setImmediate(() => controller.abort());
  await assert.rejects(
    tracePrediction(model, sharedUnknown(), {
      chunkSize: 1,
      signal: controller.signal,
      onProgress: event => progress.push(event),
    }),
    { name: 'AbortError' },
  );
  assert.equal(progress.length, 1);
  await yieldToUI();
});

test('trace rejeita tamanho de chunk, callback ou desconhecido vazio inválidos', async () => {
  const model = sharedModel(),
    unknown = sharedUnknown();
  for (const chunkSize of [0, -1, 1.5, NaN, Infinity, '2', null]) {
    await assert.rejects(tracePrediction(model, unknown, { chunkSize }), RangeError);
  }
  await assert.rejects(tracePrediction(model, unknown, { onProgress: null }), TypeError);
  const empty = Cryptogram.fromTerms('vazio', []);
  assert.throws(() => model.predict(empty), /Criptograma desconhecido vazio/);
  await assert.rejects(tracePrediction(model, empty), /Criptograma desconhecido vazio/);
});

test('summarizeCandidates conta união por cifra sem duplicar termos entre suas amostras', () => {
  const model = ReferenceModel.fromSamples(
    new Map([
      [
        'A',
        [
          [0n, 1n, 1n],
          [1n, 2n],
        ],
      ],
      [
        'B',
        [
          [1n, 3n],
          [3n, 4n],
        ],
      ],
    ]),
  );
  assert.deepEqual(summarizeCandidates(model), [
    { label: 'A', sampleCount: 2, sampleTerms: [2, 2], distinctTerms: 3 },
    { label: 'B', sampleCount: 2, sampleTerms: [2, 2], distinctTerms: 3 },
  ]);
  assert.equal(model.terms.length, 5);
});

test('summarizeCandidates mantém ordem e 64 bits, inclusive termo de várias cifras', () => {
  const model = ReferenceModel.fromSamples(
    new Map([
      ['10', [[HIGH, MAX], [MAX]]],
      ['2', [[MAX], [1n]]],
    ]),
  );
  assert.deepEqual(summarizeCandidates(model), [
    { label: '10', sampleCount: 2, sampleTerms: [2, 1], distinctTerms: 2 },
    { label: '2', sampleCount: 2, sampleTerms: [1, 1], distinctTerms: 2 },
  ]);
  assert.deepEqual(summarizeCandidates(model.select(['2'])), [
    { label: '2', sampleCount: 2, sampleTerms: [1, 1], distinctTerms: 2 },
  ]);
});
