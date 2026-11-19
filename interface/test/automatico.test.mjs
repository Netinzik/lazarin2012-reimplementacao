import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LazarinModel } from '../../engine/src/pipeline.js';
import { Cryptogram } from '../../engine/src/terms.js';
import { generateDataset } from '../../engine/src/dataset.js';
import { readCiphertext, localFile } from '../../engine/src/io.js';
import { structuralPredictor } from '../trace.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lazarin-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const figure = () =>
  Object.entries({
    c1: [0, 9],
    c2: [3, 9],
    c3: [6, 3],
    c4: [1, 4],
    c5: [4, 3],
    c6: [7, 13],
    c7: [2, 12],
    c8: [5, 2],
    c9: [8, 15],
    c10: [200, 201],
  }).map(([id, terms]) => Cryptogram.fromTerms(id, terms));

test('cálculo rápido do caminho automático é idêntico ao Algoritmo 2 literal (dados artificiais)', () => {
  const model = LazarinModel.fit(figure());
  const fast = structuralPredictor(model);
  for (const terms of [[0, 1, 255], [9, 3, 12], [15], [201, 200, 4, 4], [1n << 63n, 7]]) {
    const unknown = Cryptogram.fromTerms('x', terms);
    assert.deepEqual(fast(unknown), model.predict(unknown, { decisionType: 3 }));
  }
});

test('cálculo rápido do caminho automático é idêntico ao literal em ECB com chave fixa (grupos reais)', t => {
  const root = path.join(temporary(t), 'base');
  const manifest = generateDataset(root, {
    seed: 5,
    textBytes: 256,
    referenceKeys: 2,
    referencePerKey: 3,
    samples: 2,
    testsPerAlgorithm: 2,
    testStartByte: 2_457_600,
    crypto: {
      mode: 'ECB',
      ciphers: [
        {
          label: 'Blowfish',
          source: 'openssl',
          base: 'bf',
          keys: { policy: 'fixa', hex: '00112233445566778899aabbccddeeff' },
        },
        {
          label: 'CAST5',
          source: 'openssl',
          base: 'cast5',
          keys: { policy: 'fixa', hex: 'ffeeddccbbaa99887766554433221100' },
        },
      ],
    },
  });
  const bytes = r => readCiphertext(localFile(root, r.path));
  const refs = manifest.records.filter(r => r.split === 'reference');
  const model = LazarinModel.fit(refs.map((r, i) => Cryptogram.fromBytes('ref-' + i, bytes(r))));
  assert.equal(model.featureGroups.length, 2, 'ECB com chave fixa forma um grupo por cifra');
  const fast = structuralPredictor(model);
  for (const r of manifest.records.filter(r => r.split === 'test')) {
    const unknown = Cryptogram.fromBytes('teste', bytes(r));
    assert.deepEqual(fast(unknown), model.predict(unknown, { decisionType: 3 }));
  }
});
