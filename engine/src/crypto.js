import { createCipheriv, createHash, getCipherInfo, getCiphers } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALGORITHMS = Object.freeze(['Blowfish', 'RC2', 'CAST5']);
const CIPHERS = Object.freeze({ Blowfish: 'bf-cbc', RC2: 'rc2-cbc', CAST5: 'cast5-cbc' });
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function checkCrypto() {
  const available = new Set(getCiphers());
  const missing = ALGORITHMS.filter(name => !available.has(CIPHERS[name]));
  if (missing.length) throw new Error('Cifras legadas indisponíveis: ' + missing.join(', ') +
    '. Execute com node --openssl-legacy-provider ou use os comandos npm do projeto.');
  for (const algorithm of ALGORITHMS) {
    const info = getCipherInfo(CIPHERS[algorithm]);
    if (!info || info.keyLength !== 16 || info.blockSize !== 8 || info.ivLength !== 8)
      throw new Error('Backend incompatível com o perfil de chave/bloco: ' + algorithm);
  }
  return {
    algorithms: [...ALGORITHMS], key_bits: 128, block_bits: 64, iv_bits: 64,
    mode: 'CBC', rc2_effective_key_bits: 128, openssl: process.versions.openssl
  };
}

export function encryptCBC(algorithm, plaintext, key, iv) {
  if (!ALGORITHMS.includes(algorithm)) throw new TypeError('Algoritmo não suportado: ' + algorithm);
  for (const [name, value] of [['mensagem', plaintext], ['chave', key], ['IV', iv]])
    if (!(value instanceof Uint8Array)) throw new TypeError(name + ' deve ser Buffer/Uint8Array');
  if (!plaintext.byteLength || plaintext.byteLength % 8)
    throw new RangeError('Mensagem deve ser não vazia e múltipla de 8 bytes');
  if (key.byteLength !== 16) throw new RangeError('Todos os algoritmos exigem chave de 16 bytes (128 bits)');
  if (iv.byteLength !== 8) throw new RangeError('IV deve ter 8 bytes (64 bits)');
  checkCrypto();
  const cipher = createCipheriv(CIPHERS[algorithm], Buffer.from(key), Buffer.from(iv));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export const MODES = Object.freeze(['ECB', 'CBC', 'CFB', 'OFB', 'CTR']);
export const CATALOG = Object.freeze([
  ['Blowfish', 'bf'], ['RC2', 'rc2'], ['CAST5', 'cast5'], ['DES', 'des'], ['3DES', 'des-ede3'], ['IDEA', 'idea'],
  ['SEED', 'seed'], ['AES-128', 'aes-128'], ['AES-192', 'aes-192'], ['AES-256', 'aes-256'],
  ['Camellia-128', 'camellia-128'], ['Camellia-256', 'camellia-256'], ['SM4', 'sm4'], ['ARIA-128', 'aria-128'],
].map(([label, base]) => Object.freeze({ label, base })));
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;

export const opensslName = (base, mode) => `${base}-${mode.toLowerCase()}`;

export function cipherInfo(base, mode) {
  if (!MODES.includes(mode)) throw new Error('Modo desconhecido: ' + mode);
  const name = opensslName(base, mode);
  const info = getCiphers().includes(name) ? getCipherInfo(name) : null;
  if (!info) throw new Error(`Combinação indisponível: ${base} em ${mode}`);
  return { name, keyBytes: info.keyLength, ivBytes: info.ivLength ?? 0, blockBytes: getCipherInfo(opensslName(base, 'ECB')).blockSize };
}

const versions = new Map();
export function opensslVersion(binary) {
  if (!versions.has(binary)) {
    const run = spawnSync(binary, ['version'], { encoding: 'utf8' });
    if (run.error || run.status !== 0) throw new Error('OpenSSL não encontrado ou não executável: ' + binary);
    versions.set(binary, run.stdout.trim());
  }
  return versions.get(binary);
}

export function findOpenSSL() {
  const found = [];
  for (const candidate of ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl', '/bin/openssl']) {
    try {
      const real = fs.realpathSync(candidate);
      if (found.some(item => item.real === real)) continue;
      found.push({ path: candidate, real, version: opensslVersion(candidate) });
    } catch { }
  }
  return found.map(({ path, version }) => ({ path, version }));
}

function opensslArgs(binary, name, key, iv) {
  const providers = /^OpenSSL 3/.test(opensslVersion(binary)) ? ['-provider', 'legacy', '-provider', 'default'] : [];
  return ['enc', '-' + name, '-K', Buffer.from(key).toString('hex'), ...(iv.length ? ['-iv', Buffer.from(iv).toString('hex')] : []),
    '-nopad', ...providers];
}

function runOpenSSL(binary, name, plaintext, key, iv) {
  const run = spawnSync(binary, opensslArgs(binary, name, key, iv), { input: plaintext, maxBuffer: 1 << 28 });
  if (run.error || run.status !== 0)
    throw new Error(`OpenSSL (${binary}) falhou em ${name}: ${String(run.stderr || run.error?.message || '').trim().split('\n')[0]}`);
  return run.stdout;
}

const blockModules = new Map();

export async function loadBlockModule(file) {
  const absolute = path.resolve(file);
  if (!blockModules.has(absolute)) {
    if (!fs.existsSync(absolute)) throw new Error('Arquivo da cifra de bloco não encontrado: ' + absolute);
    const module = await import(pathToFileURL(absolute).href + '?t=' + fs.statSync(absolute).mtimeMs);
    const blockBytes = module.blocoBytes, keyBytes = module.chaveBytes;
    if (!Number.isSafeInteger(blockBytes) || blockBytes < 1 || !Number.isSafeInteger(keyBytes) || keyBytes < 1)
      throw new Error('O módulo deve exportar blocoBytes e chaveBytes (inteiros positivos): ' + absolute);
    if (typeof module.cifrarBloco !== 'function') throw new Error('O módulo deve exportar a função cifrarBloco(bloco, chave): ' + absolute);
    blockModules.set(absolute, { blockBytes, keyBytes, encryptBlock: module.cifrarBloco, name: module.nome ?? null });
  }
  return blockModules.get(absolute);
}

export async function loadBlockModules(ciphers = []) {
  for (const cipher of ciphers) if (cipher.source === 'bloco-js') await loadBlockModule(cipher.module);
}

export function blockModule(file) {
  const loaded = blockModules.get(path.resolve(file));
  if (!loaded) throw new Error('Cifra de bloco em JS não carregada (use loadBlockModules antes): ' + file);
  return loaded;
}

const xor = (a, b) => { const out = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]; return out; };

function increment(counter) {
  const next = Buffer.from(counter);
  for (let i = next.length - 1; i >= 0; i--) { next[i] = (next[i] + 1) & 255; if (next[i]) break; }
  return next;
}

export function applyMode(mode, encryptBlock, blockBytes, plaintext, iv = Buffer.alloc(0)) {
  if (!MODES.includes(mode)) throw new Error('Modo desconhecido: ' + mode);
  const n = blockBytes, data = Buffer.from(plaintext);
  if ((mode === 'ECB' || mode === 'CBC') && data.length % n) throw new RangeError(`Mensagem deve ser múltipla do bloco (${n} bytes) em ${mode}`);
  if (mode !== 'ECB' && iv.length !== n) throw new RangeError(`IV deve ter ${n} bytes em ${mode}`);
  const E = block => {
    const result = Buffer.from(encryptBlock(Uint8Array.from(block)));
    if (result.length !== n) throw new Error(`cifrarBloco devolveu ${result.length} bytes; esperado ${n}`);
    return result;
  };
  const out = [];
  let state = Buffer.from(iv);
  for (let offset = 0; offset < data.length; offset += n) {
    const block = data.subarray(offset, offset + n);
    if (mode === 'ECB') out.push(E(block));
    else if (mode === 'CBC') { state = E(xor(block, state)); out.push(state); }
    else if (mode === 'CFB') { const c = xor(block, E(state)); out.push(c); state = c; }
    else if (mode === 'OFB') { state = E(state); out.push(xor(block, state)); }
    else { out.push(xor(block, E(state))); state = increment(state); }
  }
  return Buffer.concat(out);
}

export function encryptWith(spec, { plaintext, key, iv, mode, backend = { kind: 'node' } }) {
  if (spec.source === 'openssl') {
    const name = opensslName(spec.base, mode);
    if (backend.kind === 'openssl') return runOpenSSL(backend.path, name, plaintext, key, iv);
    const cipher = createCipheriv(name, Buffer.from(key), iv.length ? Buffer.from(iv) : null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
  }
  if (spec.source === 'bloco-js') {
    const module = blockModule(spec.module);
    return applyMode(mode, block => module.encryptBlock(block, Uint8Array.from(key)), module.blockBytes, plaintext, iv);
  }
  if (spec.source === 'programa') {
    const run = spawnSync('/bin/sh', ['-c', spec.command + ' "$@"', 'cifra-propria',
      Buffer.from(key).toString('hex'), Buffer.from(iv).toString('hex'), mode], { input: plaintext, maxBuffer: 1 << 28 });
    if (run.error || run.status !== 0)
      throw new Error(`O programa da cifra ${spec.label} falhou (código ${run.status}): ${String(run.stderr || run.error?.message || '').trim().split('\n')[0]}`);
    if (!run.stdout.length || run.stdout.length % 8)
      throw new Error(`O programa da cifra ${spec.label} devolveu ${run.stdout.length} bytes; o criptograma deve ser múltiplo de 8 bytes`);
    return run.stdout;
  }
  throw new Error('Origem de cifra desconhecida: ' + spec.source);
}

export function probeCipher(spec, mode, backend, sizes) {
  const plaintext = Buffer.alloc(32, 0x41);
  const key = Buffer.alloc(sizes.keyBytes, 1), iv = Buffer.alloc(sizes.ivBytes, 2);
  const first = encryptWith(spec, { plaintext, key, iv, mode, backend });
  const second = encryptWith(spec, { plaintext, key, iv, mode, backend });
  if (!first.equals(second)) throw new Error(`A cifra ${spec.label} não é determinística: mesma chave e IV geraram criptogramas diferentes`);
  return first;
}
