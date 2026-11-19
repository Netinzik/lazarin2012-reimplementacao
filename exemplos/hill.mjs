// Cifra de Hill (Lester Hill, 1929) sobre blocos de 8 bytes: c = M · p (mod 256).
// O bloco é um vetor de 8 bytes; M é uma matriz 8×8 invertível módulo 256.
// Para M ser sempre invertível, ela é montada como M = L · U:
//   L: triangular inferior com diagonal 1 (28 bytes da chave abaixo da diagonal);
//   U: triangular superior com diagonal ímpar (8 bytes da diagonal, com o bit 0 forçado,
//      e 28 bytes acima dela).
// det(M) é ímpar, logo M tem inversa mod 256. A cifra é linear: E(a + b) = E(a) + E(b) (mod 256),
// e 8 pares de texto claro e criptograma bastam para recuperar a chave.
//
// O artefato aplica o modo escolhido sobre cifrarBloco. decifrarBloco serve para conferência.
export const nome = 'Hill (matriz 8×8 mod 256)';
export const blocoBytes = 8;
export const chaveBytes = 64;

let ultimaChave = null, ultimaMatriz = null;

function partes(chave) {
  const L = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => (i === j ? 1 : 0)));
  const U = Array.from({ length: 8 }, () => new Array(8).fill(0));
  let k = 0;
  for (let i = 0; i < 8; i++) for (let j = 0; j < i; j++) L[i][j] = chave[k++];
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) U[i][j] = chave[k++];
  for (let i = 0; i < 8; i++) U[i][i] = chave[k++] | 1;
  return { L, U };
}

function matriz(chave) {
  if (ultimaChave && ultimaChave.length === chave.length && ultimaChave.every((b, i) => b === chave[i])) return ultimaMatriz;
  const { L, U } = partes(chave);
  const M = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => {
    let soma = 0;
    for (let t = 0; t < 8; t++) soma += L[i][t] * U[t][j];
    return soma & 255;
  }));
  ultimaChave = Uint8Array.from(chave);
  ultimaMatriz = M;
  return M;
}

export function cifrarBloco(bloco, chave) {
  const M = matriz(chave), saida = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    let soma = 0;
    for (let j = 0; j < 8; j++) soma += M[i][j] * bloco[j];
    saida[i] = soma & 255;
  }
  return saida;
}

// Inverso de um número ímpar módulo 256 (método de Newton: cada passo dobra os bits corretos).
function inverso(a) {
  let x = a;
  for (let i = 0; i < 3; i++) x = (x * (2 - a * x)) & 255;
  return x & 255;
}

export function decifrarBloco(bloco, chave) {
  const { L, U } = partes(chave);
  // c = L · (U · p): resolve L · y = c (diagonal 1) e depois U · p = y (diagonal ímpar).
  const y = new Array(8);
  for (let i = 0; i < 8; i++) {
    let soma = bloco[i];
    for (let j = 0; j < i; j++) soma -= L[i][j] * y[j];
    y[i] = soma & 255;
  }
  const p = new Array(8);
  for (let i = 7; i >= 0; i--) {
    let soma = y[i];
    for (let j = i + 1; j < 8; j++) soma -= U[i][j] * p[j];
    p[i] = ((soma & 255) * inverso(U[i][i])) & 255;
  }
  return Uint8Array.from(p);
}
