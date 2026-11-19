import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, orderedTests, validateDecisionSettings, textPreview, replayCommand, replayConfigCommand, isClassic } from '../cli.mjs';
import { buildConfig } from '../base.mjs';

test('padrão: classificar todos os arquivos, sem semente nem início informados (serão sorteados)', () => {
  const result = parseArgs([]);
  assert.equal(result.command, 'classificar');
  assert.equal(result.cases, undefined);
  assert.equal(result.seed, undefined);
  assert.equal(result.testStartByte, undefined);
  assert.deepEqual(result.settings.candidates, ['Blowfish', 'RC2', 'CAST5']);
  assert.equal(result.settings.decisionType, 3);
});

test('semente, início do trecho e regra são lidos para repetir uma execução', () => {
  const result = parseArgs(['--semente', '48213977', '--inicio-teste', '2457600', '--sem-menu', '--casos', '3',
    '--candidatos', 'Blowfish,RC2', '--decisao', '2', '--regra', 'chapter5-experiment2', '--alpha', '0.3']);
  assert.equal(result.seed, 48213977);
  assert.equal(result.testStartByte, 2457600);
  assert.equal(result.cases, 3);
  assert.equal(result.interactive, false);
  assert.equal(result.settings.profile, 'chapter5-experiment2');
  assert.equal(result.settings.alpha, .3);
});

test('opções removidas, inválidas ou repetidas são recusadas antes de gerar dados', () => {
  for (const argv of [['--perfil', 'pequeno'], ['--bytes', '512'], ['--confirmar-longo'], ['--probabilidade', '90'],
  ['--alpha', 'NaN'], ['--chunk', '0'], ['--casos', '0'], ['--casos', '-1'], ['--decisao', '2'], ['--padrao', '--padrao'],
  ['--semente', '-1'], ['--sem-menu', '--sem-menu'], ['apresentar']])
    assert.throws(() => parseArgs(argv));
  assert.throws(() => validateDecisionSettings({ candidates: ['RC2', 'RC2'], decisionType: 2, alpha: .1, profile: 'chapter3' }));
  assert.throws(() => validateDecisionSettings({ candidates: ['XOR', 'RC2'], decisionType: 2, alpha: .1, profile: 'chapter3' }), /XOR|use/);
  assert.equal(validateDecisionSettings({ candidates: ['XOR', 'AES-128'], decisionType: 2, alpha: .1, profile: 'chapter3' },
    ['XOR', 'AES-128']).decisionType, 2);
});

test('help não exige configuração', () => {
  assert.deepEqual(parseArgs(['--help']), { command: 'help' });
  assert.equal(parseArgs(['ambiente']).command, 'ambiente');
  assert.equal(parseArgs(['grupos']).command, 'grupos');
  assert.throws(() => parseArgs(['doctor']));
});

test('seleção de testes é pareada por algoritmo e não depende de acerto', () => {
  const manifest = {
    algorithms: ['A', 'B'], records: [
      { split: 'reference', algorithm: 'A', id: 'ref' },
      { split: 'test', algorithm: 'A', id: 'a0' }, { split: 'test', algorithm: 'A', id: 'a1' },
      { split: 'test', algorithm: 'B', id: 'b0' }, { split: 'test', algorithm: 'B', id: 'b1' },
    ]
  };
  assert.deepEqual(orderedTests(manifest).map(x => x.id), ['a0', 'b0', 'a1', 'b1']);
  assert.deepEqual(orderedTests(manifest, ['B']).map(x => x.id), ['b0', 'b1']);
});

test('padrao, semente e --config desligam o assistente; config.json gera o comando de repetição', () => {
  for (const argv of [['--padrao'], ['--semente', '5'], ['--config', 'a.json'], ['--candidatos', 'RC2,CAST5', '--decisao', '2']])
    assert.equal(parseArgs(argv).wizard, false);
  assert.equal(replayConfigCommand('runs/sessoes/x/config.json'), 'npm run classificar -- --config runs/sessoes/x/config.json');
  assert.equal(isClassic(buildConfig({ seed: 1, testStartByte: 0 }).config), true);
  assert.equal(isClassic(buildConfig({ seed: 1, testStartByte: 0, sizes: { testsPerAlgorithm: 10 } }).config), false);
});

test('prévia do texto claro limpa quebras e caracteres cortados; comando de repetição traz semente e início', () => {
  const utf8 = Buffer.concat([Buffer.from([0xA9]), Buffer.from('E disse Deus:\n  Haja luz; e houve luz.')]);
  assert.equal(textPreview(utf8, 0), 'E disse Deus: Haja luz; e houve luz.');
  assert.equal(textPreview(utf8, 0, 10), 'E disse De…');
  assert.equal(replayCommand({ seed: 5, testStartByte: 8192 }), 'npm run classificar -- --semente 5 --inicio-teste 8192');
  const viaPnpm = parseArgs(['classificar', '--', '--semente', '5', '--inicio-teste', '8192']);
  assert.equal(viaPnpm.seed, 5);
  assert.equal(viaPnpm.testStartByte, 8192);
});
