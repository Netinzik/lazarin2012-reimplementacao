import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  ALGORITHMS, CATALOG, LABEL_PATTERN, MODES, blockModule, checkCrypto, cipherInfo, encryptCBC, encryptWith, opensslName,
  opensslVersion, probeCipher, sha256
} from './crypto.js';
import { createOutput, localFile, readJSON, writeJSON } from './io.js';

export const DEFAULT_SOURCE = fileURLToPath(new URL('../data/sources/pg62383.txt', import.meta.url));
export const BIBLE_SHA256 = 'bf9c6053bfb441d117a2a128d4edec9fbe935f415bc8f7bf4e1f3f9121790215';
const START = '1 No [1] principio creou [2] Deus os céus e a terra.';
const END = '21 A graça de nosso [22] Senhor Jesus Christo _seja_ com todos vós. Amen.';
const KEYS = ['seed', 'algorithms', 'textBytes', 'referenceKeys', 'referencePerKey', 'samples', 'testsPerAlgorithm'];
const CRYPTO = Object.freeze({
  key_bits: 128, block_bits: 64, iv_bits: 64, mode: 'CBC',
  padding: 'none_aligned_input', rc2_effective_key_bits: 128,
  key_generation: 'SHA256 domain-separated deterministic public laboratory keys, first 16 bytes',
  iv_generation: 'SHA256 domain-separated per-file deterministic laboratory IV, first 8 bytes',
  iv_in_ciphertext: false
});

export function loadBible(source = DEFAULT_SOURCE) {
  if (typeof source !== 'string' || !source) throw new TypeError('Fonte deve ser um caminho');
  const raw = fs.readFileSync(source);
  if (sha256(raw) !== BIBLE_SHA256) throw new Error('SHA-256 da Bíblia diferente da fonte fixada no protocolo');
  const start = raw.indexOf(Buffer.from(START));
  const endStart = raw.indexOf(Buffer.from(END), start);
  if (start < 0 || endStart <= start || raw.indexOf(Buffer.from(START), start + 1) !== -1)
    throw new Error('Marcadores únicos do corpo bíblico não encontrados');
  const end = endStart + Buffer.byteLength(END);
  const body = raw.subarray(start, end);
  return {
    raw, body, metadata: {
      ebook: 62383, language: 'Portuguese',
      title: 'A Biblia Sagrada, Contendo o Velho e o Novo Testamento', translator: "João Ferreira d'Almeida",
      edition_title_page: 'Lisboa, 1911, edição revista e corrigida',
      source: 'data/sources/pg62383.txt', url: 'https://www.gutenberg.org/ebooks/62383',
      raw_sha256: BIBLE_SHA256, raw_bytes: raw.length, body_sha256: sha256(body), body_bytes: body.length,
      body_start_byte: start, body_end_byte_exclusive: end, start_marker: START, end_marker: END,
      preparation: 'raw UTF-8 byte slices, internal headings/notes and CRLF preserved, no text normalization',
      original_2012_corpus_confirmed: false
    }
  };
}

function configuration(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Configuração inválida');
  if (Object.keys(options).some(key => !KEYS.includes(key) && !['source', 'testStartByte', 'crypto'].includes(key))) throw new Error('Parâmetro desconhecido');
  const defaults = {
    seed: 2026, algorithms: [...ALGORITHMS], textBytes: 512,
    referenceKeys: 10, referencePerKey: 2, samples: 5, testsPerAlgorithm: 5
  };
  const config = Object.fromEntries(KEYS.map(key => [key, options[key] ?? defaults[key]]));
  for (const key of KEYS.filter(key => key !== 'algorithms'))
    if (!Number.isSafeInteger(config[key])) throw new Error(key + ' deve ser inteiro seguro');
  if (config.seed < 0) throw new Error('Semente deve ser não negativa');
  if (config.samples < 2 || config.referenceKeys < config.samples || config.referenceKeys % config.samples)
    throw new Error('Exige >=2 amostras e chaves de referência divisíveis pelo número de amostras');
  if (options.crypto !== undefined) {
    config.crypto = normalizeCrypto(options.crypto, config.referenceKeys);
    const labels = config.crypto.ciphers.map(cipher => cipher.label);
    if (options.algorithms !== undefined && JSON.stringify(options.algorithms) !== JSON.stringify(labels))
      throw new Error('algorithms deve repetir os rótulos das cifras configuradas');
    config.algorithms = labels;
  }
  if (!Array.isArray(config.algorithms) || config.algorithms.length < 2 ||
    (!config.crypto && config.algorithms.some(algorithm => !ALGORITHMS.includes(algorithm))) ||
    new Set(config.algorithms).size !== config.algorithms.length) throw new Error('Lista de algoritmos inválida');
  config.algorithms = [...config.algorithms];
  if (config.textBytes < 8 || config.textBytes % 8) throw new Error('textBytes deve ser múltiplo positivo de oito');
  if (config.referencePerKey < 1 || config.testsPerAlgorithm < 1) throw new Error('Quantidades devem ser positivas');
  const messages = config.referenceKeys * config.referencePerKey + config.testsPerAlgorithm;
  if (!Number.isSafeInteger(messages * config.textBytes)) throw new Error('Configuração excede precisão inteira');
  if (Object.hasOwn(options, 'testStartByte')) {
    if (!Number.isSafeInteger(options.testStartByte) || options.testStartByte < 0 ||
      options.testStartByte % config.textBytes ||
      !Number.isSafeInteger(options.testStartByte + config.testsPerAlgorithm * config.textBytes))
      throw new Error('testStartByte deve ser inteiro não negativo alinhado a textBytes e ter fim seguro');
    config.testStartByte = options.testStartByte;
  }
  return config;
}

export function derived(seed, domain, bytes) {
  const blocks = [];
  for (let i = 0; blocks.length * 32 < bytes; i++)
    blocks.push(createHash('sha256').update('lazarin-controlled-bible-v1\0' + seed + '\0' + domain + (i ? '\0' + i : '')).digest());
  return Buffer.concat(blocks).subarray(0, bytes);
}

const hexOf = (value, bytes, what) => {
  const hex = typeof value === 'string' ? value.trim().toLowerCase().replace(/^0x/, '') : '';
  if (!/^[0-9a-f]*$/.test(hex) || hex.length !== bytes * 2) throw new Error(`${what} deve ter ${bytes} bytes (${bytes * 2} dígitos hex)`);
  return hex;
};

export function cipherSizes(cipher, mode) {
  if (cipher.source === 'openssl') { const info = cipherInfo(cipher.base, mode); return { keyBytes: info.keyBytes, ivBytes: info.ivBytes, blockBytes: info.blockBytes }; }
  if (cipher.source === 'bloco-js') { const m = blockModule(cipher.module); return { keyBytes: m.keyBytes, ivBytes: mode === 'ECB' ? 0 : m.blockBytes, blockBytes: m.blockBytes }; }
  return { keyBytes: cipher.keyBytes, ivBytes: cipher.ivBytes, blockBytes: null };
}

function normalizeCipher(cipher, mode, referenceKeys) {
  if (!cipher || typeof cipher !== 'object') throw new TypeError('Cifra inválida');
  if (typeof cipher.label !== 'string' || !LABEL_PATTERN.test(cipher.label))
    throw new Error('Nome de cifra inválido (letras, números, - ou _; até 24 caracteres): ' + cipher.label);
  let spec;
  if (cipher.source === 'openssl') {
    if (!CATALOG.some(entry => entry.base === cipher.base)) throw new Error('Cifra OpenSSL fora do catálogo: ' + cipher.base);
    spec = { label: cipher.label, source: 'openssl', base: cipher.base };
  } else if (cipher.source === 'programa') {
    if (typeof cipher.command !== 'string' || !cipher.command.trim() || /[\n\r]/.test(cipher.command))
      throw new Error('Informe o comando do programa da cifra ' + cipher.label);
    const keyBytes = cipher.keyBytes ?? 16, ivBytes = cipher.ivBytes ?? 8;
    if (!Number.isSafeInteger(keyBytes) || keyBytes < 1 || keyBytes > 256 || !Number.isSafeInteger(ivBytes) || ivBytes < 0 || ivBytes > 256)
      throw new Error('Tamanhos de chave (1 a 256) ou IV (0 a 256) inválidos para ' + cipher.label);
    spec = { label: cipher.label, source: 'programa', command: cipher.command.trim(), keyBytes, ivBytes };
  } else if (cipher.source === 'bloco-js') {
    if (typeof cipher.module !== 'string' || !cipher.module) throw new Error('Informe o arquivo .mjs da cifra ' + cipher.label);
    spec = { label: cipher.label, source: 'bloco-js', module: path.resolve(cipher.module) };
  } else throw new Error('Origem de cifra deve ser openssl, programa ou bloco-js: ' + cipher.label);
  const { keyBytes, ivBytes } = cipherSizes(spec, mode);
  const keys = cipher.keys ?? { policy: 'derivadas' };
  if (keys.policy === 'derivadas') spec.keys = { policy: 'derivadas' };
  else if (keys.policy === 'fixa') spec.keys = { policy: 'fixa', hex: hexOf(keys.hex, keyBytes, 'Chave de ' + cipher.label) };
  else if (keys.policy === 'manuais') {
    if (!Array.isArray(keys.reference) || keys.reference.length !== referenceKeys)
      throw new Error(`Informe ${referenceKeys} chaves da base para ${cipher.label}`);
    spec.keys = {
      policy: 'manuais', reference: keys.reference.map((hex, i) => hexOf(hex, keyBytes, `Chave k${i} de ${cipher.label}`)),
      test: hexOf(keys.test, keyBytes, 'Chave de teste de ' + cipher.label)
    };
  } else throw new Error('Política de chaves deve ser derivadas, fixa ou manuais');
  const iv = ivBytes ? cipher.iv ?? { policy: 'por-arquivo' } : { policy: 'nenhum' };
  if (!ivBytes || iv.policy === 'por-arquivo' || iv.policy === 'zero') spec.iv = { policy: ivBytes ? iv.policy : 'nenhum' };
  else if (iv.policy === 'fixo') spec.iv = { policy: 'fixo', hex: hexOf(iv.hex, ivBytes, 'IV de ' + cipher.label) };
  else throw new Error('Política de IV deve ser por-arquivo, fixo ou zero');
  return spec;
}

export function normalizeCrypto(crypto, referenceKeys) {
  if (!crypto || typeof crypto !== 'object' || Array.isArray(crypto)) throw new TypeError('Configuração criptográfica inválida');
  if (Object.keys(crypto).some(key => !['backend', 'mode', 'ciphers'].includes(key))) throw new Error('Parâmetro criptográfico desconhecido');
  const mode = crypto.mode ?? 'CBC';
  if (!MODES.includes(mode)) throw new Error('Modo deve ser ' + MODES.join(', '));
  const input = crypto.backend ?? { kind: 'node' };
  let backend;
  if (input.kind === 'node') backend = { kind: 'node' };
  else if (input.kind === 'openssl' && typeof input.path === 'string' && input.path) backend = { kind: 'openssl', path: input.path };
  else throw new Error('Motor deve ser node ou openssl (com caminho do executável)');
  if (!Array.isArray(crypto.ciphers) || crypto.ciphers.length < 2) throw new Error('Escolha ao menos duas cifras');
  const ciphers = crypto.ciphers.map(cipher => normalizeCipher(cipher, mode, referenceKeys));
  if (new Set(ciphers.map(c => c.label.toLowerCase())).size !== ciphers.length) throw new Error('Nomes de cifra repetidos');
  return { backend, mode, ciphers };
}

export function describeCrypto(crypto) {
  return {
    mode: crypto.mode, padding: 'none_aligned_input',
    backend: crypto.backend.kind === 'openssl'
      ? { kind: 'openssl', path: crypto.backend.path, version: opensslVersion(crypto.backend.path) }
      : { kind: 'node', openssl: process.versions.openssl },
    ciphers: crypto.ciphers.map(cipher => {
      const sizes = cipherSizes(cipher, crypto.mode);
      return {
        label: cipher.label, source: cipher.source,
        ...(cipher.source === 'openssl' ? { openssl_name: opensslName(cipher.base, crypto.mode) } : {}),
        ...(cipher.source === 'programa' ? { command: cipher.command } : {}),
        ...(cipher.source === 'bloco-js' ? { module: cipher.module, block_bits: sizes.blockBytes * 8 } : {}),
        key_bits: sizes.keyBytes * 8, iv_bits: sizes.ivBytes * 8, key_policy: cipher.keys.policy, iv_policy: cipher.iv.policy
      };
    }),
    key_generation: 'derivadas: SHA256 domain-separated a partir da semente; fixa/manuais: valores informados',
    iv_generation: 'por-arquivo: SHA256 domain-separated por arquivo; fixo: valor informado; zero; nenhum (sem IV)'
  };
}

function checkCustomCrypto(crypto) {
  for (const cipher of crypto.ciphers) probeCipher(cipher, crypto.mode, crypto.backend, cipherSizes(cipher, crypto.mode));
}

function keyFor(config, cipher, keyId, split, keyIndex, bytes) {
  if (!cipher || cipher.keys.policy === 'derivadas') return derived(config.seed, 'key/' + keyId, bytes);
  if (cipher.keys.policy === 'fixa') return Buffer.from(cipher.keys.hex, 'hex');
  return Buffer.from(split === 'reference' ? cipher.keys.reference[keyIndex] : cipher.keys.test, 'hex');
}

function ivFor(config, cipher, id, bytes) {
  if (!cipher || cipher.iv.policy === 'por-arquivo') return derived(config.seed, 'iv/' + id, bytes);
  if (cipher.iv.policy === 'fixo') return Buffer.from(cipher.iv.hex, 'hex');
  return Buffer.alloc(cipher.iv.policy === 'zero' ? bytes : 0);
}

function makePlan(config, bible) {
  const referenceCount = config.referenceKeys * config.referencePerKey;
  const total = referenceCount + config.testsPerAlgorithm;
  if (total * config.textBytes > bible.body.length) throw new Error('Corpo bíblico insuficiente para os recortes disjuntos');
  const testStart = config.testStartByte ?? referenceCount * config.textBytes;
  const testEnd = testStart + config.testsPerAlgorithm * config.textBytes;
  if (testEnd > bible.body.length) throw new Error('Corpo bíblico insuficiente para a janela de teste');
  const offsets = [];
  for (let offset = 0; offsets.length < referenceCount; offset += config.textBytes) {
    if (offset === testStart) offset = testEnd;
    if (offset + config.textBytes > bible.body.length) throw new Error('Corpo bíblico insuficiente para a referência fora da janela de teste');
    offsets.push(offset);
  }
  for (let index = 0; index < config.testsPerAlgorithm; index++) offsets.push(testStart + index * config.textBytes);
  const plaintexts = offsets.map(offset => bible.body.subarray(offset, offset + config.textBytes));
  const plaintextHashes = plaintexts.map(sha256);
  if (new Set(plaintextHashes).size !== total) throw new Error('Recortes de texto claro duplicados no protocolo');
  const keys = [], records = [], files = [], candidates = [];
  const custom = config.crypto;
  for (const algorithm of config.algorithms) {
    const cipher = custom?.ciphers.find(c => c.label === algorithm) ?? null;
    const sizes = cipher ? cipherSizes(cipher, custom.mode) : { keyBytes: 16, ivBytes: 8 };
    const samples = Array.from({ length: config.samples }, () => []);
    for (const split of ['reference', 'test']) {
      const countKeys = split === 'reference' ? config.referenceKeys : 1;
      for (let keyIndex = 0; keyIndex < countKeys; keyIndex++) {
        const keyId = `${algorithm}/${split}/k${keyIndex}`;
        const key = keyFor(config, cipher, keyId, split, keyIndex, sizes.keyBytes);
        keys.push({ id: keyId, algorithm, split, hex: key.toString('hex') });
        const countFiles = split === 'reference' ? config.referencePerKey : config.testsPerAlgorithm;
        for (let j = 0; j < countFiles; j++) {
          const selectionIndex = split === 'reference' ? keyIndex * config.referencePerKey + j : referenceCount + j;
          const id = `${keyId}/f${j}`;
          const relative = `${split}/${algorithm}/k${keyIndex}-f${String(j).padStart(4, '0')}.bin`;
          const iv = ivFor(config, cipher, id, sizes.ivBytes);
          const plaintext = plaintexts[selectionIndex];
          const ciphertext = cipher ? encryptWith(cipher, { plaintext, key, iv, mode: custom.mode, backend: custom.backend })
            : encryptCBC(algorithm, plaintext, key, iv);
          const sampleIndex = split === 'reference' ? keyIndex % config.samples : null;
          if (sampleIndex !== null) samples[sampleIndex].push(relative);
          records.push({
            id, path: relative, split, algorithm, key_id: keyId, iv_hex: iv.toString('hex'),
            plaintext_offset: bible.metadata.body_start_byte + offsets[selectionIndex],
            plaintext_sha256: plaintextHashes[selectionIndex], ciphertext_sha256: sha256(ciphertext),
            bytes: ciphertext.length, sample_index: sampleIndex
          });
          files.push({ path: relative, bytes: ciphertext });
        }
      }
    }
    candidates.push({ label: algorithm, samples });
  }
  if (!custom && new Set(keys.map(key => key.hex)).size !== keys.length) throw new Error('Colisão nas chaves de laboratório');
  if (!custom && new Set(records.map(record => record.iv_hex)).size !== records.length) throw new Error('Colisão nos IVs de laboratório');
  return { keys, records, files, reference: { schema: 1, kind: 'prepared_reference', candidates } };
}

function selectionMetadata(config) {
  return {
    scheme: Object.hasOwn(config, 'testStartByte')
      ? 'same non-overlapping plaintext slices per algorithm; reference skips fixed test window'
      : 'same non-overlapping plaintext slices per algorithm; reference first, test after',
    reference_messages: config.referenceKeys * config.referencePerKey, test_messages: config.testsPerAlgorithm,
    paired_across_algorithms: true, prepared_sample_assignment: 'reference key index modulo number of samples',
    sample_assignment_is_graph_coloring: false,
    ...(Object.hasOwn(config, 'testStartByte') ? { test_start_byte_relative_to_body: config.testStartByte } : {})
  };
}

export function generateDataset(output, options = {}) {
  if (typeof output !== 'string' || !output) throw new TypeError('Saída deve ser um diretório');
  if (fs.existsSync(output)) throw new Error('Diretório já existe; escolha uma saída nova: ' + output);
  const config = configuration(options), bible = loadBible(options.source ?? DEFAULT_SOURCE);
  if (config.crypto) checkCustomCrypto(config.crypto); else checkCrypto();
  const plan = makePlan(config, bible);
  const manifest = {
    schema: 2, kind: 'controlled_bible_dataset', config, algorithms: config.algorithms,
    crypto: config.crypto ? describeCrypto(config.crypto) : CRYPTO, corpus: bible.metadata, keys: plan.keys, records: plan.records,
    selection: selectionMetadata(config),
    notice: 'Experimento controlado do grupo, não réplica exata de 2012. Chaves públicas e IVs determinísticos apenas para laboratório.'
  };
  createOutput(output);
  for (const file of plan.files) {
    const destination = path.join(output, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.bytes, { flag: 'wx' });
  }
  writeJSON(path.join(output, 'reference.json'), plan.reference);
  writeJSON(path.join(output, 'manifest.json'), manifest);
  return manifest;
}

export function validateDataset(root) {
  const manifest = readJSON(path.join(root, 'manifest.json'));
  if (manifest.schema !== 2 || manifest.kind !== 'controlled_bible_dataset') throw new Error('Manifesto inválido');
  const config = configuration(manifest.config), bible = loadBible();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(manifest.config, config) || !same(manifest.algorithms, config.algorithms) ||
    !same(manifest.crypto, config.crypto ? describeCrypto(config.crypto) : CRYPTO))
    throw new Error('Parâmetros criptográficos ou configuração divergentes');
  if (!same(manifest.corpus, bible.metadata)) throw new Error('Proveniência ou recorte bíblico divergente');
  if (!config.crypto) checkCrypto();
  const plan = makePlan(config, bible);
  if (!same(manifest.keys, plan.keys)) throw new Error('Chaves de referência/teste divergentes');
  if (!same(manifest.records, plan.records)) throw new Error('Registros, IVs, offsets ou hashes divergentes');
  const expectedSelection = selectionMetadata(config);
  if (!same(manifest.selection, expectedSelection)) throw new Error('Particionamento divergente');
  for (const file of plan.files) {
    const actual = fs.readFileSync(localFile(root, file.path));
    if (!actual.equals(file.bytes)) throw new Error('Ciphertext alterado ou cifração não reproduzida (a cifra é determinística?): ' + file.path);
  }
  if (!same(readJSON(path.join(root, 'reference.json')), plan.reference)) throw new Error('Amostras da referência divergentes');
  return manifest;
}
