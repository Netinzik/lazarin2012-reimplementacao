# Cifras de exemplo

Material de teste para o artefato: 11 cifras, das clássicas às modernas, entregues nas duas formas aceitas como cifra própria (programa externo e função de bloco em JavaScript). Elas servem para ver o que o método reconhece e o que não reconhece. **Nenhuma delas deve ser usada para proteger dados.**

## Catálogo

| Nome | Arquivo | Forma | Chave | O que faz | Ponto fraco |
|---|---|---|---|---|---|
| XOR | `cifra-xor.py` | programa | 16 bytes | XOR de cada byte com a chave repetida | chave curta reutilizada; trocar a chave só muda os criptotermos pela diferença entre as chaves |
| Cesar | `cifra-cesar.py` | programa | 1 byte | soma um deslocamento fixo a cada byte | 256 chaves; o mesmo byte vira sempre o mesmo byte |
| Vigenere | `cifra-vigenere.py` | programa | 16 bytes | soma o byte da chave na mesma posição; a chave se repete | período igual ao tamanho da chave (teste de Kasiski) |
| Afim | `cifra-afim.py` | programa | 2 bytes | `c = a·p + b (mod 256)`, com `a` ímpar | 32.768 chaves; substituição fixa por byte |
| Substituicao | `cifra-substituicao.py` | programa | 16 bytes | troca cada byte por outro, segundo uma permutação dos 256 valores | preserva a frequência de cada byte |
| Transposicao | `transposicao.mjs` | bloco de 8 bytes | 8 bytes | reordena os 8 bytes de cada bloco | não altera os bytes, só a posição deles |
| Hill | `hill.mjs` | bloco de 8 bytes | 64 bytes | multiplica o bloco por uma matriz 8×8 invertível mod 256 | linear: 8 pares de texto claro e criptograma revelam a chave |
| RC4 | `cifra-rc4.py` | programa | 16 bytes (+ IV opcional) | cifra de fluxo de Rivest (1987); com IV, a chave do RC4 é IV ‖ chave, como no WEP | vieses no fluxo; sem IV, todos os arquivos da mesma chave usam o mesmo fluxo |
| TEA | `tea.mjs` | bloco de 8 bytes | 16 bytes | Tiny Encryption Algorithm (Wheeler e Needham, 1994), 64 rodadas de Feistel | chaves equivalentes e ataques de chave relacionada |
| RC5 | `rc5.mjs` | bloco de 8 bytes | 16 bytes | RC5-32/12/16 (Rivest, 1994), com rotações que dependem dos dados | só ataques teóricos (cerca de 2^44 textos escolhidos); na prática, forte |
| Feistel | `feistel-fraca.mjs` | bloco de 8 bytes | 16 bytes | rede de Feistel com só 2 rodadas | poucas rodadas; serve de modelo para escrever a sua |

O arquivo `catalogo.json` lista essas cifras para o assistente. Os nomes ficam sem acento porque viram rótulos nos resultados (letras, números, `-` ou `_`).

### Forma e modo de operação

- **Programa** (`.py`): cifra o arquivo inteiro, byte a byte ou como fluxo, e **ignora o modo** escolhido. Em ECB ou CBC, o resultado é o mesmo. Na César, na afim e na substituição, o mesmo bloco de texto gera sempre o mesmo criptotermo, independentemente da posição; na XOR e na Vigenère, isso acontece quando a posição se repete no período da chave.
- **Bloco** (`.mjs`): o artefato aplica o modo escolhido (ECB, CBC, CFB, OFB ou CTR) sobre a função do bloco. Em ECB, blocos iguais com a mesma chave geram criptotermos iguais; em CBC com IV por arquivo, o encadeamento esconde essas repetições.

## Como usar

### Pelo assistente

```text
npm run classificar
  Usar a configuração padrão? n
  [A] motor, [B] modo, [C] cifras do OpenSSL (Enter = nenhuma)
  Adicionar uma cifra própria ou de exemplo? s
  Tipo da cifra própria: 3  (exemplos prontos da pasta exemplos/)
  Números dos exemplos, separados por vírgula: 2,3,9
```

Cada exemplo escolhido é testado na hora: o assistente cifra um bloco de teste duas vezes e confirma que a cifra é determinística. Dá para combinar exemplos com cifras do OpenSSL e com a sua própria cifra na mesma execução.

### Pelo `config.json`

```json
{
  "crypto": {
    "backend": { "kind": "node" },
    "mode": "ECB",
    "ciphers": [
      { "label": "Blowfish", "source": "openssl", "base": "bf" },
      { "label": "Vigenere", "source": "programa", "command": "python3 exemplos/cifra-vigenere.py", "keyBytes": 4, "ivBytes": 0 },
      { "label": "TEA", "source": "bloco-js", "module": "exemplos/tea.mjs" }
    ]
  }
}
```

No `config.json`, o tamanho da chave dos programas pode mudar. Por exemplo, uma Vigenère com chave de 4 bytes tem período 4. Nas funções de bloco, o tamanho vem do próprio módulo (`chaveBytes`). Um `config.json` completo pode ser obtido de qualquer execução em `runs/sessoes/<sessão>/config.json` ou em `runs/bateria-ecb-cesar-xor/configs/`.

### À mão, no terminal

Os programas seguem o contrato do artefato: `<comando> <chave-hex> <iv-hex> <modo>`, com o texto claro pela entrada padrão. Um quarto argumento `decifrar` desfaz a cifragem. A XOR e o RC4 são a própria inversa e não precisam dele.

```bash
printf 'Haja luz' | python3 exemplos/cifra-vigenere.py 01020304 '' ECB | xxd
printf 'Haja luz' | python3 exemplos/cifra-vigenere.py 01020304 '' ECB | python3 exemplos/cifra-vigenere.py 01020304 '' ECB decifrar
```

As funções de bloco exportam também `decifrarBloco(bloco, chave)`, que o artefato não usa:

```bash
node --input-type=module -e "
import { cifrarBloco, decifrarBloco } from './exemplos/tea.mjs';
const chave = new Uint8Array(16), bloco = new TextEncoder().encode('Haja luz');
const c = cifrarBloco(bloco, chave);
console.log(Buffer.from(c).toString('hex'), new TextDecoder().decode(decifrarBloco(c, chave)));"
```

## Conferência

O arquivo `engine/test/exemplos.test.js`, executado no `npm test`, faz as conferências abaixo:

- **TEA:** vetor de teste com chave e bloco zerados, que gera `41ea3a0a94baa940`.
- **RC5:** os três vetores do artigo de Rivest. O primeiro tem chave e bloco zerados e gera `21a5dbee154b8f6d`.
- **RC4:** os bytes gerados são idênticos aos do RC4 do OpenSSL, com e sem IV.
- **Todas as cifras:** decifrar desfaz cifrar.
- **Transposição:** só reordena os bytes.
- **Hill:** é linear, ou seja, `E(a + b) = E(a) + E(b)`.
- **Catálogo completo:** responde pelo artefato em ECB e CBC e gera uma base válida.

Os exemplos em Python precisam de Python 3.8 ou superior e usam só a biblioteca padrão. Sem `python3`, os testes desses exemplos são pulados.

## Como escrever a sua

As duas formas, com o contrato completo, estão no [README principal](../README.md#cifra-própria). Resumo:

- **Programa externo, em qualquer linguagem:**
  - É chamado como `<comando> <chave-hex> <iv-hex> <modo>` e recebe o texto claro pela entrada padrão.
  - Devolve o criptograma pela saída padrão, com tamanho múltiplo de 8 bytes.
  - Precisa ser determinístico.
- **Função de bloco (`.mjs`):** exporta `blocoBytes`, `chaveBytes` e `cifrarBloco(bloco, chave)`, além do opcional `nome`.

Para a sua cifra aparecer na lista do assistente, acrescente uma linha em `catalogo.json`:

```json
{ "nome": "MinhaCifra", "arquivo": "minha-cifra.py", "chaveBytes": 16, "ivBytes": 0, "familia": "própria", "descricao": "o que ela faz" }
```

Para arquivos `.mjs`, `chaveBytes` e `ivBytes` ficam de fora: vêm do módulo e do modo.
