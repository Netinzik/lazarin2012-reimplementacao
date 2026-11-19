// Feistel fraca: rede de Feistel com só 2 rodadas, bloco de 64 bits e chave de 128 bits
// (só os primeiros 64 bits são usados). Função de rodada: rotação de (metade + subchave).
// Com 2 rodadas, a metade direita do criptograma depende da esquerda do texto de forma quase linear.
// Não é uma cifra conhecida: serve de modelo para escrever a sua.
//
// O artefato aplica o modo escolhido (ECB, CBC, CFB, OFB ou CTR) sobre cifrarBloco.
// decifrarBloco não é usada pelo artefato; serve para conferência.
export const nome = 'Feistel fraca (2 rodadas)';
export const blocoBytes = 8;
export const chaveBytes = 16;

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rodada = (metade, chave, r) => rotl((metade + new DataView(chave.buffer, chave.byteOffset, 16).getUint32(4 * r)) >>> 0, 3);

function saida(esquerda, direita) {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, esquerda);
  view.setUint32(4, direita);
  return bytes;
}

export function cifrarBloco(bloco, chave) {
  const entrada = new DataView(bloco.buffer, bloco.byteOffset, 8);
  let esquerda = entrada.getUint32(0), direita = entrada.getUint32(4);
  for (let r = 0; r < 2; r++) [esquerda, direita] = [direita, (esquerda ^ rodada(direita, chave, r)) >>> 0];
  return saida(esquerda, direita);
}

export function decifrarBloco(bloco, chave) {
  const entrada = new DataView(bloco.buffer, bloco.byteOffset, 8);
  let esquerda = entrada.getUint32(0), direita = entrada.getUint32(4);
  for (let r = 1; r >= 0; r--) [esquerda, direita] = [(direita ^ rodada(esquerda, chave, r)) >>> 0, esquerda];
  return saida(esquerda, direita);
}
