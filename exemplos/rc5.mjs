// RC5-32/12/16 (Rivest, 1994): palavras de 32 bits, 12 rodadas, chave de 16 bytes.
// Bloco de 64 bits. A característica marcante são as rotações que dependem dos dados.
// Com 12 rodadas, há ataques diferenciais teóricos (Biryukov e Kushilevitz, 1998) que exigem
// cerca de 2^44 textos escolhidos.
// Palavras em little-endian, como na especificação (RFC 2040).
// Vetores de teste do artigo original (conferidos em engine/test/exemplos.test.js):
//   chave 00…00, bloco 0000000000000000 → 21a5dbee154b8f6d
//   chave 915f4619be41b2516355a50110a9ce91, bloco 21a5dbee154b8f6d → f7c013ac5b2b8952
//
// O artefato aplica o modo escolhido sobre cifrarBloco. decifrarBloco serve para conferência.
export const nome = 'RC5-32/12/16 (Rivest, 1994)';
export const blocoBytes = 8;
export const chaveBytes = 16;

const RODADAS = 12,
  P32 = 0xb7e15163,
  Q32 = 0x9e3779b9;
const rotl = (x, n) => {
  n &= 31;
  return ((x << n) | (x >>> (32 - n))) >>> 0;
};
const rotr = (x, n) => {
  n &= 31;
  return ((x >>> n) | (x << (32 - n))) >>> 0;
};

let ultimaChave = null,
  ultimoS = null;

function expandir(chave) {
  if (ultimaChave && ultimaChave.length === chave.length && ultimaChave.every((b, i) => b === chave[i])) return ultimoS;
  const c = Math.max(1, Math.ceil(chave.length / 4)),
    L = new Array(c).fill(0);
  for (let i = chave.length - 1; i >= 0; i--) L[Math.floor(i / 4)] = ((L[Math.floor(i / 4)] << 8) + chave[i]) >>> 0;
  const t = 2 * RODADAS + 2,
    S = new Array(t);
  S[0] = P32;
  for (let i = 1; i < t; i++) S[i] = (S[i - 1] + Q32) >>> 0;
  let A = 0,
    B = 0,
    i = 0,
    j = 0;
  for (let k = 0; k < 3 * Math.max(t, c); k++) {
    A = S[i] = rotl((S[i] + A + B) >>> 0, 3);
    B = L[j] = rotl((L[j] + A + B) >>> 0, (A + B) >>> 0);
    i = (i + 1) % t;
    j = (j + 1) % c;
  }
  ultimaChave = Uint8Array.from(chave);
  ultimoS = S;
  return S;
}

function palavras(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  return [view.getUint32(0, true), view.getUint32(4, true)];
}

function bloco(A, B) {
  const saida = new Uint8Array(8),
    view = new DataView(saida.buffer);
  view.setUint32(0, A, true);
  view.setUint32(4, B, true);
  return saida;
}

export function cifrarBloco(entrada, chave) {
  const S = expandir(chave);
  let [A, B] = palavras(entrada);
  A = (A + S[0]) >>> 0;
  B = (B + S[1]) >>> 0;
  for (let i = 1; i <= RODADAS; i++) {
    A = (rotl((A ^ B) >>> 0, B) + S[2 * i]) >>> 0;
    B = (rotl((B ^ A) >>> 0, A) + S[2 * i + 1]) >>> 0;
  }
  return bloco(A, B);
}

export function decifrarBloco(entrada, chave) {
  const S = expandir(chave);
  let [A, B] = palavras(entrada);
  for (let i = RODADAS; i >= 1; i--) {
    B = (rotr((B - S[2 * i + 1]) >>> 0, A) ^ A) >>> 0;
    A = (rotr((A - S[2 * i]) >>> 0, B) ^ B) >>> 0;
  }
  return bloco((A - S[0]) >>> 0, (B - S[1]) >>> 0);
}
