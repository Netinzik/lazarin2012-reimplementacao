import { Cryptogram } from '../src/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function figure() {
  const values = {
    c1: [0, 9], c2: [3, 9], c3: [6, 3], c4: [1, 4],
    c5: [4, 3], c6: [7, 13], c7: [2, 12], c8: [5, 2], c9: [8, 15]
  };
  return Object.entries(values).map(([id, terms]) => Cryptogram.fromTerms(id, terms));
}
export function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazarin-js-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
export function rng(seed = 771) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
}
