import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadBible, generateDataset, validateDataset, DEFAULT_SOURCE, BIBLE_SHA256 } from '../src/dataset.js';
import { sha256 } from '../src/crypto.js';

const config = { seed: 2026, textBytes: 64, referenceKeys: 2, referencePerKey: 1, samples: 2, testsPerAlgorithm: 2 };
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lazarin-controlled-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function changeManifest(root, edit) {
  const file = path.join(root, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  edit(manifest); fs.writeFileSync(file, JSON.stringify(manifest));
}

test('fonte fixa inicia no verso de Gênesis e termina no verso final de Apocalipse', () => {
  const { raw, body, metadata } = loadBible();
  assert.equal(sha256(raw), BIBLE_SHA256);
  assert.ok(body.toString('utf8').startsWith('1 No [1] principio creou [2] Deus os céus e a terra.'));
  assert.ok(body.toString('utf8').endsWith('21 A graça de nosso [22] Senhor Jesus Christo _seja_ com todos vós. Amen.'));
  assert.deepEqual(raw.subarray(metadata.body_start_byte, metadata.body_end_byte_exclusive), body);
  assert.ok(!body.includes(Buffer.from('PROJECT GUTENBERG')));
  assert.ok(body.includes(Buffer.from('\r\n')));
  assert.equal(metadata.original_2012_corpus_confirmed, false);
});

test('qualquer alteração na fonte é rejeitada antes de gerar uma saída', t => {
  const dir = temporary(t), source = path.join(dir, 'source.txt'), output = path.join(dir, 'dataset');
  const sourceBytes = fs.readFileSync(DEFAULT_SOURCE); sourceBytes[0] ^= 1; fs.writeFileSync(source, sourceBytes);
  assert.throws(() => generateDataset(output, { ...config, source }), /SHA-256/);
  assert.ok(!fs.existsSync(output));
});

test('geração reproduzível possui três cifras de 128 bits e recortes pareados/disjuntos', t => {
  const dir = temporary(t), a = path.join(dir, 'a'), b = path.join(dir, 'b');
  const first = generateDataset(a, config), second = generateDataset(b, config);
  assert.deepEqual(first, second);
  assert.deepEqual(validateDataset(a), first);
  assert.equal(first.records.length, 12);
  assert.equal(first.crypto.key_bits, 128); assert.equal(first.crypto.rc2_effective_key_bits, 128);
  assert.equal(first.crypto.padding, 'none_aligned_input');
  assert.ok(first.keys.every(key => key.hex.length === 32));
  const refs = first.records.filter(r => r.split === 'reference');
  const tests = first.records.filter(r => r.split === 'test');
  const refOffsets = new Set(refs.map(r => r.plaintext_offset));
  assert.ok(tests.every(r => !refOffsets.has(r.plaintext_offset)));
  for (const index of [0, 1]) {
    const paired = first.algorithms.map(algorithm => tests.filter(r => r.algorithm === algorithm)[index]);
    assert.equal(new Set(paired.map(r => r.plaintext_sha256)).size, 1);
    assert.equal(new Set(paired.map(r => r.ciphertext_sha256)).size, 3);
  }
  for (const record of first.records)
    assert.deepEqual(fs.readFileSync(path.join(a, record.path)), fs.readFileSync(path.join(b, record.path)));
  assert.equal(first.selection.sample_assignment_is_graph_coloring, false);
});

test('semente diferente mantém os textos e muda chaves, IVs e ciphertexts', t => {
  const dir = temporary(t);
  const a = generateDataset(path.join(dir, 'a'), config);
  const b = generateDataset(path.join(dir, 'b'), { ...config, seed: 2027 });
  assert.deepEqual(a.records.map(r => r.plaintext_sha256), b.records.map(r => r.plaintext_sha256));
  assert.notDeepEqual(a.keys, b.keys);
  assert.notDeepEqual(a.records.map(r => r.iv_hex), b.records.map(r => r.iv_hex));
  assert.notDeepEqual(a.records.map(r => r.ciphertext_sha256), b.records.map(r => r.ciphertext_sha256));
});

test('holdout fixo preserva todos os criptogramas de teste ao ampliar a referência', t => {
  const dir = temporary(t), a = path.join(dir, 'small'), b = path.join(dir, 'large');
  const original = generateDataset(a, config);
  const enlarged = generateDataset(b, {
    ...config, referencePerKey: 4,
    testStartByte: config.referenceKeys * config.referencePerKey * config.textBytes
  });
  const originalTests = original.records.filter(r => r.split === 'test');
  const enlargedTests = enlarged.records.filter(r => r.split === 'test');
  assert.deepEqual(originalTests, enlargedTests);
  for (const record of originalTests)
    assert.deepEqual(fs.readFileSync(path.join(a, record.path)), fs.readFileSync(path.join(b, record.path)));
  const testOffsets = new Set(enlargedTests.map(r => r.plaintext_offset));
  assert.ok(enlarged.records.filter(r => r.split === 'reference').every(r => !testOffsets.has(r.plaintext_offset)));
  assert.equal(enlarged.selection.test_start_byte_relative_to_body, 128);
  assert.deepEqual(validateDataset(b), enlarged);
});

test('janela fixa valida alinhamento, fim e identidade do manifesto', t => {
  const dir = temporary(t);
  for (const testStartByte of [-1, 1, 8, 1.5, Number.MAX_SAFE_INTEGER, null])
    assert.throws(() => generateDataset(path.join(dir, 'bad-' + testStartByte), { ...config, testStartByte }));
  assert.throws(() => generateDataset(path.join(dir, 'outside'), { ...config, testStartByte: 10_000_000 * 64 }), /insuficiente/);
  const root = path.join(dir, 'good'); generateDataset(root, { ...config, testStartByte: 128 });
  changeManifest(root, m => { m.config.testStartByte = 256; });
  assert.throws(() => validateDataset(root), /divergent/);
});

test('dois candidatos podem ser selecionados sem trocar seu tamanho de chave', t => {
  const root = path.join(temporary(t), 'dataset');
  const manifest = generateDataset(root, { ...config, algorithms: ['Blowfish', 'RC2'] });
  assert.equal(manifest.records.length, 8); assert.deepEqual(validateDataset(root), manifest);
});

test('saída existente não é sobrescrita', t => {
  const output = path.join(temporary(t), 'dataset'); generateDataset(output, config);
  const original = fs.readFileSync(path.join(output, 'manifest.json'));
  assert.throws(() => generateDataset(output, config), /já existe/);
  assert.deepEqual(fs.readFileSync(path.join(output, 'manifest.json')), original);
});

test('configurações inválidas são rejeitadas sem escrita', t => {
  const dir = temporary(t);
  const variants = [{ seed: -1 }, { seed: 1.5 }, { textBytes: 9 }, { textBytes: 0 },
  { referenceKeys: 3 }, { samples: 1 }, { testsPerAlgorithm: 0 }, { referencePerKey: -1 },
  { algorithms: ['Blowfish', 'DES'] }, { algorithms: ['RC2', 'RC2'] }, { algorithms: ['RC2'] },
  { algorithms: [] }, { unexpected: true }, { textBytes: Number.MAX_SAFE_INTEGER - 7 }];
  for (let i = 0; i < variants.length; i++) {
    const output = path.join(dir, 'invalid-' + i);
    assert.throws(() => generateDataset(output, { ...config, ...variants[i] }));
    assert.ok(!fs.existsSync(output));
  }
});

test('validação detecta ciphertext e gabarito adulterados', t => {
  const dir = temporary(t), a = path.join(dir, 'a'), b = path.join(dir, 'b');
  const manifest = generateDataset(a, config); generateDataset(b, config);
  const target = path.join(a, manifest.records[0].path), bytes = fs.readFileSync(target); bytes[0] ^= 1; fs.writeFileSync(target, bytes);
  assert.throws(() => validateDataset(a), /Ciphertext alterado/);
  changeManifest(b, m => { m.records[0].algorithm = 'CAST5'; });
  assert.throws(() => validateDataset(b), /Registros/);
});

test('validação detecta mudanças em chave, IV, offset, hash e número de bits', t => {
  const dir = temporary(t);
  const edits = [m => { m.keys[0].hex = '00'.repeat(16); }, m => { m.records[0].iv_hex = '00'.repeat(8); },
  m => { m.records[0].plaintext_offset += 8; }, m => { m.records[0].ciphertext_sha256 = '00'.repeat(32); },
  m => { m.crypto.key_bits = 256; }, m => { m.corpus.body_start_byte += 1; },
  m => { m.records[0].path = '../outside.bin'; }, m => { m.records.push(m.records[0]); }];
  for (let i = 0; i < edits.length; i++) {
    const root = path.join(dir, 'tampered-' + i); generateDataset(root, config); changeManifest(root, edits[i]);
    assert.throws(() => validateDataset(root));
  }
});

test('validação detecta partição de amostras alterada', t => {
  const root = path.join(temporary(t), 'dataset'); generateDataset(root, config);
  const file = path.join(root, 'reference.json'), reference = JSON.parse(fs.readFileSync(file));
  reference.candidates[0].samples[0].push(reference.candidates[0].samples[1][0]);
  fs.writeFileSync(file, JSON.stringify(reference)); assert.throws(() => validateDataset(root), /Amostras/);
});

test('caminhos simbólicos fora da raiz são rejeitados', t => {
  const dir = temporary(t), root = path.join(dir, 'dataset'), manifest = generateDataset(root, config);
  const target = path.join(root, manifest.records[0].path), outside = path.join(dir, 'outside.bin');
  fs.copyFileSync(target, outside); fs.unlinkSync(target); fs.symlinkSync(outside, target);
  assert.throws(() => validateDataset(root), /fora/);
});
