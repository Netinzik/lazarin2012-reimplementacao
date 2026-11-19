// TEA, Tiny Encryption Algorithm (Wheeler e Needham, 1994).
// Rede de Feistel com 32 ciclos (64 rodadas), bloco de 64 bits e chave de 128 bits.
// Fraquezas conhecidas: chaves equivalentes (cada chave tem 3 equivalentes, então a chave
// efetiva tem 126 bits) e ataques de chave relacionada; foi substituída pela XTEA.
// Palavras em big-endian, como no código de referência.
// Vetor de teste (conferido em engine/test/exemplos.test.js): chave e bloco zerados → 41ea3a0a94baa940.
//
// O artefato aplica o modo escolhido sobre cifrarBloco. decifrarBloco serve para conferência.
export const nome = 'TEA (Wheeler e Needham, 1994)';
export const blocoBytes = 8;
export const chaveBytes = 16;

const DELTA = 0x9e3779b9;

function palavras(bytes, n) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 4 * n);
  return Array.from({ length: n }, (_, i) => view.getUint32(4 * i));
}

function bloco(v0, v1) {
  const saida = new Uint8Array(8),
    view = new DataView(saida.buffer);
  view.setUint32(0, v0);
  view.setUint32(4, v1);
  return saida;
}

export function cifrarBloco(entrada, chave) {
  let [v0, v1] = palavras(entrada, 2),
    soma = 0;
  const [k0, k1, k2, k3] = palavras(chave, 4);
  for (let i = 0; i < 32; i++) {
    soma = (soma + DELTA) >>> 0;
    v0 = (v0 + ((((v1 << 4) + k0) ^ (v1 + soma) ^ ((v1 >>> 5) + k1)) | 0)) >>> 0;
    v1 = (v1 + ((((v0 << 4) + k2) ^ (v0 + soma) ^ ((v0 >>> 5) + k3)) | 0)) >>> 0;
  }
  return bloco(v0, v1);
}

export function decifrarBloco(entrada, chave) {
  let [v0, v1] = palavras(entrada, 2),
    soma = (DELTA * 32) >>> 0;
  const [k0, k1, k2, k3] = palavras(chave, 4);
  for (let i = 0; i < 32; i++) {
    v1 = (v1 - ((((v0 << 4) + k2) ^ (v0 + soma) ^ ((v0 >>> 5) + k3)) | 0)) >>> 0;
    v0 = (v0 - ((((v1 << 4) + k0) ^ (v1 + soma) ^ ((v1 >>> 5) + k1)) | 0)) >>> 0;
    soma = (soma - DELTA) >>> 0;
  }
  return bloco(v0, v1);
}
