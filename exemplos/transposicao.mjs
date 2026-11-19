// Transposição em bloco de 8 bytes (transposição colunar clássica aplicada a cada bloco).
// A chave define a ordem de leitura das posições: as posições são ordenadas pelo byte da chave
// (empate: a posição menor primeiro). Os bytes do bloco são só reordenados, nunca alterados,
// então a frequência dos bytes do texto continua visível no criptograma.
// Chave com todos os bytes iguais = permutação identidade (chave fraca).
//
// O artefato aplica o modo escolhido (ECB, CBC, CFB, OFB ou CTR) sobre cifrarBloco.
// decifrarBloco não é usada pelo artefato; serve para conferência.
export const nome = 'Transposição (bloco de 8 bytes)';
export const blocoBytes = 8;
export const chaveBytes = 8;

function ordem(chave) {
  return [...Array(8).keys()].sort((a, b) => chave[a] - chave[b] || a - b);
}

export function cifrarBloco(bloco, chave) {
  const posicoes = ordem(chave);
  return Uint8Array.from(posicoes, p => bloco[p]);
}

export function decifrarBloco(bloco, chave) {
  const posicoes = ordem(chave), saida = new Uint8Array(8);
  posicoes.forEach((p, i) => { saida[p] = bloco[i]; });
  return saida;
}
