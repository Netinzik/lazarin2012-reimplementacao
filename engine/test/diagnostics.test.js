import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { structuralControls, diagnoseDataset } from '../src/diagnostics.js';
import { generateDataset } from '../src/dataset.js';
import { temporary } from './fixtures.mjs';

test('controle positivo percorre agrupamento, coloração, peso, índice e decisão', () => {
  const controls = structuralControls();
  assert.equal(controls.passed, true);
  assert.equal(controls.positive.groups.length, 2);
  assert.deepEqual(controls.positive.groups.map(g => g.samples.length), [2, 2]);
  assert.equal(controls.positive.prediction.prediction, 'delta_2');
  assert.deepEqual(controls.positive.prediction.scores.delta_1.weights, [2, 1]);
  assert.deepEqual(controls.positive.prediction.scores.delta_2.weights, [1, 1]);
  assert.equal(controls.positive.prediction.status, 'ok');
  assert.ok(controls.positive.groups.every(g => g.members.every(id => !/Blowfish|RC2|CAST5/.test(id))));
});

test('remoção de interseção e clique preservam condições estruturais exatas', () => {
  const controls = structuralControls();
  assert.equal(controls.removal.edge_count, 1);
  assert.deepEqual(controls.removal.ungrouped, ['r0', 'r1']);
  assert.equal(controls.clique.edge_count, 6);
  assert.equal(controls.clique.groups[0].samples.length, 4);
  assert.equal(controls.checks.indexed_intersections_match_literal, true);
});

test('diagnóstico negativo de CBC real e controle de envelope ficam separados', t => {
  const root = temporary(t), data = path.join(root, 'dataset'), output = path.join(root, 'diagnosis');
  const manifest = generateDataset(data, {
    seed: 60601, textBytes: 64, referenceKeys: 2,
    referencePerKey: 1, samples: 2, testsPerAlgorithm: 1
  });
  const before = manifest.records.map(r => fs.readFileSync(path.join(data, r.path)));
  const result = diagnoseDataset(data, output);
  assert.equal(result.controls_passed, true);
  assert.equal(result.observed.files, 6);
  assert.equal(result.observed.occurrences, 48);
  assert.equal(result.observed.distinct_terms, 48);
  assert.equal(result.observed.edges, 0);
  assert.equal(result.observed.groups, 0);
  assert.equal(result.observed.all_unique_implies_no_edges, true);
  assert.equal(result.ideal_model.cross_file_term_pairs, '960');
  assert.equal(result.ideal_model.expected_equal_cross_file_pairs, 960 / 2 ** 64);
  const envelope = result.controls.openssl_envelope;
  assert.equal(envelope.files, 6);
  assert.equal(envelope.baseline.edge_count, 0);
  assert.equal(envelope.with_simulated_envelope.edge_count, 15);
  assert.equal(envelope.with_simulated_envelope.groups.length, 1);
  assert.equal(envelope.with_simulated_envelope.groups[0].samples.length, 6);
  assert.deepEqual(envelope.after_removing_simulated_envelope, envelope.baseline);
  assert.deepEqual(envelope.mixed_algorithm_component, ['Blowfish', 'RC2', 'CAST5']);
  assert.equal(new Set(envelope.payloads.map(p => p.simulated_salt_hex)).size, 6);
  assert.ok(envelope.payloads.every(p => p.payload_sha256 === p.recovered_payload_sha256));
  assert.deepEqual(manifest.records.map(r => fs.readFileSync(path.join(data, r.path))), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'diagnostic.json'))), result);
  assert.match(fs.readFileSync(path.join(output, 'report.md'), 'utf8'), /não prova que os arquivos de 2012/);
  assert.throws(() => diagnoseDataset(data, output), /existe/);
});

test('diagnóstico não grava saídas se o conjunto foi adulterado', t => {
  const root = temporary(t), data = path.join(root, 'dataset'), output = path.join(root, 'diagnosis');
  const manifest = generateDataset(data, {
    seed: 60602, textBytes: 64, referenceKeys: 2,
    referencePerKey: 1, samples: 2, testsPerAlgorithm: 1
  });
  const file = path.join(data, manifest.records[0].path), bytes = fs.readFileSync(file);
  bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => diagnoseDataset(data, output), /alterado|divergente/);
  assert.equal(fs.existsSync(output), false);
});
