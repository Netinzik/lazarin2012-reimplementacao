import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, LABEL_PATTERN, MODES, cipherInfo, findOpenSSL, loadBlockModule, opensslVersion, probeCipher } from '../engine/src/crypto.js';
import { cipherSizes, derived } from '../engine/src/dataset.js';
import { BASE_CONFIG, SIZE_KEYS, resolveSizes, testStartRange } from './base.mjs';

const integer = n => Number(n).toLocaleString('pt-BR');
const MODE_HELP = {
  ECB: 'cada bloco é cifrado sozinho (blocos iguais → criptotermos iguais)',
  CBC: 'cada bloco é misturado ao bloco cifrado anterior; usa IV',
  CFB: 'a cifra gera um fluxo a partir do bloco cifrado anterior; usa IV',
  OFB: 'a cifra gera um fluxo independente do texto; usa IV',
  CTR: 'a cifra gera um fluxo a partir de um contador; usa IV (só cifras de bloco de 128 bits)',
};
const SIZE_LABELS = {
  textBytes: 'Bytes por arquivo (múltiplo de 8)',
  referenceKeys: 'Chaves da base por cifra',
  referencePerKey: 'Arquivos por chave na base',
  samples: 'Amostras por cifra (precisa dividir o número de chaves)',
  testsPerAlgorithm: 'Arquivos de teste por cifra',
};

export function describeBackend(backend, systems = []) {
  if (backend.kind === 'node') return `Node.js (OpenSSL ${process.versions.openssl} embutido)`;
  let version = systems.find(s => s.path === backend.path)?.version;
  try { version ??= opensslVersion(backend.path); } catch { }
  return `OpenSSL do sistema: ${backend.path}${version ? ` (${version.split(' (')[0]})` : ''}`;
}

const EXAMPLES_DIR = fileURLToPath(new URL('../exemplos/', import.meta.url));
const shellPath = file => /^[\w./-]+$/.test(file) ? file : `'${file.replace(/'/g, `'\\''`)}'`;

// Cifras de exemplo listadas em exemplos/catalogo.json, já no formato de cifra própria.
export function exampleCiphers() {
  let catalog;
  try { catalog = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, 'catalogo.json'), 'utf8')); } catch { return []; }
  return catalog.map(entry => {
    const file = path.relative(process.cwd(), path.join(EXAMPLES_DIR, entry.arquivo)) || entry.arquivo;
    const cipher = entry.arquivo.endsWith('.mjs')
      ? { label: entry.nome, source: 'bloco-js', module: file }
      : { label: entry.nome, source: 'programa', command: `python3 ${shellPath(file)}`, keyBytes: entry.chaveBytes, ivBytes: entry.ivBytes ?? 0 };
    return { cipher, family: entry.familia ?? '', description: entry.descricao ?? '' };
  });
}

export function cipherLine(cipher, mode) {
  const sizes = cipherSizes(cipher, mode);
  const bits = n => `${integer(n * 8)} bits`;
  const origin = cipher.source === 'programa' ? `programa externo: ${cipher.command}`
    : cipher.source === 'bloco-js' ? `função de bloco em JS: ${cipher.module}` : null;
  const parts = [`chave ${bits(sizes.keyBytes)}`];
  if (sizes.blockBytes) parts.push(`bloco ${bits(sizes.blockBytes)}`);
  parts.push(sizes.ivBytes ? `IV ${bits(sizes.ivBytes)}` : 'sem IV');
  return `${cipher.label} (${parts.join(', ')}${origin ? ` · ${origin}` : ''})`;
}

export async function runWizard({ ask, log, validateSettings }) {
  const yesNo = async (question, fallback) => {
    for (; ;) {
      const answer = String(await ask(`${question} (s/n)`, fallback ? 's' : 'n')).trim().toLowerCase();
      if (['s', 'sim', 'y'].includes(answer)) return true;
      if (['n', 'nao', 'não', 'no'].includes(answer)) return false;
      log('    Responda s ou n.');
    }
  };
  const number = async (question, fallback, min, max) => {
    for (; ;) {
      const value = Number(String(await ask(question, fallback === undefined ? undefined : String(fallback))).trim());
      if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
      log(`    Digite um inteiro de ${integer(min)} a ${integer(max)}.`);
    }
  };
  const choose = async (question, options, fallback = 1) => {
    options.forEach((option, i) => log(`      ${String(i + 1).padStart(2)}  ${option}`));
    return (await number(question, fallback, 1, options.length)) - 1;
  };
  const hex = async (question, bytes, fallback) => {
    for (; ;) {
      const value = String(await ask(`${question} (${bytes} bytes = ${bytes * 2} hex)`, fallback)).trim().toLowerCase().replace(/^0x/, '');
      if (/^[0-9a-f]*$/.test(value) && value.length === bytes * 2) return value;
      log(`    Digite exatamente ${bytes * 2} dígitos hexadecimais (0-9, a-f).`);
    }
  };

  log('');
  log('CONFIGURAÇÃO DA EXECUÇÃO · Enter aceita o valor entre colchetes');
  if (await yesNo('Usar a configuração padrão (Blowfish, RC2 e CAST5 · CBC · motor Node · semente e trecho sorteados)?', true))
    return null;

  for (; ;) {
    log('');
    log('[A] MOTOR DE CIFRAGEM · quem executa Blowfish, AES etc.');
    const systems = findOpenSSL();
    const engines = [{ kind: 'node' }, ...systems.map(s => ({ kind: 'openssl', path: s.path })), { kind: 'outro' }];
    const engineIndex = await choose('Motor:', engines.map(e => e.kind === 'outro' ? 'Outro executável do OpenSSL (digitar o caminho)'
      : describeBackend(e, systems)));
    let backend = engines[engineIndex];
    while (backend.kind === 'outro') {
      const file = String(await ask('Caminho do executável openssl:', '/usr/bin/openssl')).trim();
      try {
        const version = opensslVersion(file);
        probeCipher({ label: 'teste', source: 'openssl', base: 'aes-128' }, 'CBC', { kind: 'openssl', path: file }, { keyBytes: 16, ivBytes: 16 });
        backend = { kind: 'openssl', path: file };
        systems.push({ path: file, version });
        log(`    ✓ ${version}`);
      } catch (error) { log('    Não funcionou: ' + error.message); }
    }

    log('');
    log('[B] MODO DE OPERAÇÃO');
    const mode = MODES[await choose('Modo:', MODES.map(m => `${m.padEnd(4)} ${MODE_HELP[m]}`), MODES.indexOf('CBC') + 1)];

    log('');
    log(`[C] CIFRAS · disponíveis em ${mode} com ${describeBackend(backend, systems)}`);
    const available = [];
    for (const entry of CATALOG) {
      const cipher = { label: entry.label, source: 'openssl', base: entry.base };
      try {
        const info = cipherInfo(entry.base, mode);
        if (backend.kind === 'openssl') probeCipher(cipher, mode, backend, info);
        available.push({ cipher, info });
      } catch { }
    }
    available.forEach(({ cipher, info }, i) => log(`      ${String(i + 1).padStart(2)}  ${cipher.label.padEnd(13)} chave ${info.keyBytes * 8} bits · bloco ${info.blockBytes * 8} bits`));
    const classic = ['Blowfish', 'RC2', 'CAST5'].map(l => available.findIndex(a => a.cipher.label === l) + 1).filter(Boolean);
    let ciphers;
    for (; ;) {
      const answer = String(await ask('Números das cifras, separados por vírgula (Enter = nenhuma, só cifras próprias):',
        (classic.length ? classic : [1, 2]).join(','))).trim();
      const picks = answer ? answer.split(',').map(x => Number(x.trim())) : [];
      if (picks.every(n => Number.isSafeInteger(n) && n >= 1 && n <= available.length) && new Set(picks).size === picks.length) {
        ciphers = picks.map(n => ({ ...available[n - 1].cipher }));
        break;
      }
      log('    Use números da lista, sem repetir.');
    }
    let custom = 0;
    while (await yesNo(ciphers.length < 2 ? `Faltam cifras (mínimo 2). Adicionar uma cifra própria ou de exemplo?`
      : 'Adicionar uma cifra própria ou de exemplo?', ciphers.length < 2)) {
      custom++;
      const kind = await choose('Tipo da cifra própria:', [
        'Programa externo, em qualquer linguagem (recebe chave e IV; texto claro pela entrada padrão)',
        'Função de bloco em JavaScript (.mjs); o artefato aplica o modo escolhido',
        'Exemplos prontos da pasta exemplos/ (XOR, César, Vigenère, Hill, RC4, TEA, RC5…)',
      ]);
      if (kind === 2) {
        custom--;
        const examples = exampleCiphers();
        if (!examples.length) { log('    Nenhum exemplo encontrado em exemplos/catalogo.json.'); continue; }
        examples.forEach(({ cipher, family, description }, i) =>
          log(`      ${String(i + 1).padStart(2)}  ${cipher.label.padEnd(13)} ${family.padEnd(9)} ${description}`));
        let picks;
        for (; ;) {
          const answer = String(await ask('Números dos exemplos, separados por vírgula:', '1')).trim();
          picks = answer.split(',').map(x => Number(x.trim()));
          if (picks.every(n => Number.isSafeInteger(n) && n >= 1 && n <= examples.length) && new Set(picks).size === picks.length) break;
          log('    Use números da lista, sem repetir.');
        }
        for (const n of picks) {
          const cipher = { ...examples[n - 1].cipher };
          if (ciphers.some(c => c.label.toLowerCase() === cipher.label.toLowerCase())) { log(`    ${cipher.label} já está na lista.`); continue; }
          try {
            if (cipher.source === 'bloco-js') await loadBlockModule(cipher.module);
            const sample = probeCipher(cipher, mode, backend, cipherSizes(cipher, mode));
            log(`    ✓ ${cipherLine(cipher, mode)} · respondeu e é determinística (32 bytes → ${sample.length} bytes)`);
            ciphers.push(cipher);
          } catch (error) { log(`    ${cipher.label} não funcionou: ${error.message}`); }
        }
        continue;
      }
      let label;
      for (; ;) {
        label = String(await ask('Nome da cifra (aparece nos resultados):', kind === 0 ? `Programa${custom}` : `Bloco${custom}`)).trim();
        if (LABEL_PATTERN.test(label) && !ciphers.some(c => c.label.toLowerCase() === label.toLowerCase())) break;
        log('    Use letras, números, - ou _ (até 24), sem repetir um nome já escolhido.');
      }
      for (; ;) {
        try {
          let cipher;
          if (kind === 0) {
            const command = String(await ask('Comando que executa a cifra:', 'python3 exemplos/cifra-xor.py')).trim();
            const keyBytes = await number('Tamanho da chave em bytes:', 16, 1, 256);
            const ivBytes = await number('Tamanho do IV em bytes (0 = sem IV):', mode === 'ECB' ? 0 : 8, 0, 256);
            cipher = { label, source: 'programa', command, keyBytes, ivBytes };
          } else {
            const module = String(await ask('Arquivo .mjs da cifra de bloco:', 'exemplos/feistel-fraca.mjs')).trim();
            await loadBlockModule(module);
            cipher = { label, source: 'bloco-js', module };
          }
          const sizes = cipherSizes(cipher, mode);
          const sample = probeCipher(cipher, mode, backend, sizes);
          log(`    ✓ ${cipherLine(cipher, mode)} · respondeu e é determinística (32 bytes → ${sample.length} bytes)`);
          ciphers.push(cipher);
          break;
        } catch (error) {
          log('    Não funcionou: ' + error.message);
          if (!await yesNo('Tentar de novo?', true)) { custom--; break; }
        }
      }
    }
    if (ciphers.length < 2) { log('    São necessárias ao menos duas cifras. Recomeçando a configuração.'); continue; }

    log('');
    log('[D] TAMANHO DA BASE');
    let sizes = {};
    const blockSizes = ciphers.map(c => cipherSizes(c, mode).blockBytes).filter(Boolean);
    const needsBlocks = mode === 'ECB' || mode === 'CBC';
    const fitsBlocks = s => !needsBlocks || blockSizes.every(b => s.textBytes % b === 0);
    if (!await yesNo(`Manter ${integer(BASE_CONFIG.textBytes)} bytes por arquivo · ${BASE_CONFIG.referenceKeys} chaves × ${BASE_CONFIG.referencePerKey} arquivos por cifra · ` +
      `${BASE_CONFIG.samples} amostras · ${BASE_CONFIG.testsPerAlgorithm} testes por cifra?`, true)) {
      for (; ;) {
        for (const key of SIZE_KEYS) sizes[key] = await number(`${SIZE_LABELS[key]}:`, BASE_CONFIG[key], 1, 10_000_000);
        try {
          const resolved = resolveSizes(sizes);
          if (!fitsBlocks(resolved)) throw new RangeError(`Em ${mode}, o tamanho do arquivo precisa ser múltiplo do bloco das cifras (${[...new Set(blockSizes)].join(', ')} bytes).`);
          break;
        } catch (error) { log('    ' + error.message + ' A Bíblia tem 5.103.443 bytes para a base e os testes.'); }
      }
    } else if (!fitsBlocks(BASE_CONFIG)) log('    Atenção: o tamanho padrão não é múltiplo do bloco de alguma cifra.');
    const base = resolveSizes(sizes);

    log('');
    log('[E] SEMENTE · gera as chaves e os IVs derivados');
    let seed, seedDrawn = false;
    for (; ;) {
      const answer = String(await ask('Semente (Enter = sortear):', '')).trim();
      if (!answer) { seed = randomInt(1, 1_000_000_000); seedDrawn = true; log(`    Semente sorteada: ${seed}`); break; }
      if (Number.isSafeInteger(Number(answer)) && Number(answer) >= 0) { seed = Number(answer); break; }
      log('    A semente deve ser um inteiro não negativo.');
    }

    log('');
    log('[F] CHAVES');
    const keyPolicy = await choose('Chaves:', [
      `Derivadas da semente: ${base.referenceKeys} por cifra na base + 1 de teste, todas diferentes`,
      'Uma chave fixa por cifra, a mesma na base e nos testes (digitada)',
      `Digitar cada chave: ${base.referenceKeys} da base + 1 de teste, por cifra`,
    ]);
    for (const cipher of ciphers) {
      const bytes = cipherSizes(cipher, mode).keyBytes;
      if (keyPolicy === 1)
        cipher.keys = { policy: 'fixa', hex: await hex(`Chave de ${cipher.label}`, bytes, derived(seed, `key/${cipher.label}/fixa`, bytes).toString('hex')) };
      else if (keyPolicy === 2) {
        log(`    ${cipher.label}: Enter em cada uma usa a chave derivada da semente`);
        const reference = [];
        for (let i = 0; i < base.referenceKeys; i++)
          reference.push(await hex(`${cipher.label} · chave k${i} da base`, bytes, derived(seed, `key/${cipher.label}/reference/k${i}`, bytes).toString('hex')));
        const test = await hex(`${cipher.label} · chave de teste`, bytes, derived(seed, `key/${cipher.label}/test/k0`, bytes).toString('hex'));
        cipher.keys = { policy: 'manuais', reference, test };
      }
    }

    const withIV = ciphers.filter(c => cipherSizes(c, mode).ivBytes > 0);
    if (withIV.length) {
      log('');
      log('[G] IV (vetor de inicialização)');
      const ivPolicy = await choose('IV:', ['Um IV por arquivo, derivado da semente', 'IV fixo por cifra, o mesmo em todos os arquivos (digitado)', 'IV zero em todos os arquivos']);
      for (const cipher of withIV) {
        const bytes = cipherSizes(cipher, mode).ivBytes;
        if (ivPolicy === 1) cipher.iv = { policy: 'fixo', hex: await hex(`IV de ${cipher.label}`, bytes, derived(seed, `iv/${cipher.label}/fixo`, bytes).toString('hex')) };
        else if (ivPolicy === 2) cipher.iv = { policy: 'zero' };
      }
    } else log('    Sem IV neste modo.');

    log('');
    log('[H] TRECHO DE TESTE · parte da Bíblia que vira os arquivos de teste (fora da base)');
    const range = testStartRange(base);
    let testStartByte;
    for (; ;) {
      const answer = String(await ask(`Posição de 1 a ${integer(range.positions)} (Enter = sortear):`, '')).trim();
      if (!answer) break;
      const position = Number(answer);
      if (Number.isSafeInteger(position) && position >= 1 && position <= range.positions) { testStartByte = (position - 1) * range.step; break; }
      log(`    Digite um inteiro de 1 a ${integer(range.positions)}.`);
    }

    log('');
    log('[I] DECISÃO');
    const labels = ciphers.map(c => c.label);
    let settings;
    for (; ;) {
      const candidates = String(await ask('Cifras candidatas, separadas por vírgula:', labels.join(','))).split(',').map(s => s.trim()).filter(Boolean);
      const decisionType = await number('Tipo de decisão (1 = testa uma hipótese · 2 = duas cifras · 3 = todos os pares):', candidates.length === 2 ? 2 : 3, 1, 3);
      let profile = 'chapter3', alpha = 0.1, candidate = candidates[0];
      if (decisionType === 2)
        profile = String(await ask('Regra do Tipo 2 (chapter3 = menor VR · chapter5-experiment2 = com limiar alfa):', 'chapter3')).trim();
      if (decisionType === 1) candidate = String(await ask('Hipótese a testar:', candidates[0])).trim();
      if (decisionType === 1 || profile === 'chapter5-experiment2')
        alpha = Number(String(await ask('Alfa (0 a 1):', '0,1')).trim().replace(',', '.'));
      const zeroWeight = ['perde', 'abster'][await choose('Se uma cifra ficar com peso zero em todas as amostras (índice indefinido):', [
        'Ela perde os confrontos (sem nenhuma evidência a favor dela)',
        'A regra se abstém (SEM CLASSE), como na fórmula literal',
      ])];
      try { settings = validateSettings({ candidates, decisionType, profile, alpha, candidate, zeroWeight }, labels); break; }
      catch (error) { log('    ' + error.message); }
    }
    const maxCases = base.testsPerAlgorithm * settings.candidates.length;
    const cases = await number(`Quantos arquivos de teste classificar (1 a ${integer(maxCases)}):`, maxCases, 1, maxCases);

    const crypto = { backend, mode, ciphers };
    log('');
    log('RESUMO DA CONFIGURAÇÃO');
    log(`    Motor: ${describeBackend(backend, systems)} · modo ${mode}`);
    for (const cipher of ciphers) log(`    ${cipherLine(cipher, mode)}`);
    log(`    Base: ${integer(base.textBytes)} bytes por arquivo · ${base.referenceKeys} chaves × ${base.referencePerKey} arquivos por cifra · ` +
      `${base.samples} amostras · ${base.testsPerAlgorithm} testes por cifra`);
    log(`    Semente ${seed} (${seedDrawn ? 'sorteada' : 'informada'}) · chaves ${['derivadas da semente', 'fixas', 'digitadas'][keyPolicy]}` +
      (testStartByte === undefined ? ' · trecho de teste sorteado' : ` · trecho de teste na posição ${testStartByte / range.step + 1}`));
    log(`    Decisão: Tipo ${settings.decisionType} · ${settings.candidates.join(', ')} · ${integer(cases)} arquivos · ` +
      `peso zero: ${settings.zeroWeight === 'perde' ? 'perde os confrontos' : 'a regra se abstém'}`);
    if (await yesNo('Confirmar e iniciar?', true))
      return { sizes: Object.fromEntries(SIZE_KEYS.map(key => [key, base[key]])), crypto, seed, seedDrawn, testStartByte, settings, cases };
    log('    Recomeçando a configuração.');
  }
}
