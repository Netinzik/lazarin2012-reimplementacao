# Reimplementação do método de Lazarin (2012)

Reimplementação do método descrito na dissertação de Lazarin (IME, 2012) para indicar **qual cifra gerou um arquivo cifrado**, entre candidatos definidos. O método não decifra o arquivo nem descobre a chave: compara padrões de bits do arquivo com uma base de referência.

Tudo é configurável pelo terminal:

- motor de cifragem (Node ou OpenSSL do sistema);
- modo de operação;
- cifras, chaves e IVs;
- tamanho da base e trecho de teste;
- regra de decisão.

Também é possível **testar uma cifra própria**, escrita em qualquer linguagem, para ver se o método reconhece padrões nela. A pasta [`exemplos/`](exemplos/README.md) traz 11 cifras prontas para isso, de César e Vigenère a RC4, TEA e RC5.

## Início rápido

Na pasta do projeto:

```bash
npm test               # confere tudo
npm run classificar    # Enter na primeira pergunta = configuração padrão
```

## Requisitos

- **Node.js 22 ou superior.** O artefato não tem dependências de execução nem acessa a internet: para classificar e testar, não é preciso rodar `pnpm install`.
  - Os comandos ativam `--openssl-legacy-provider`, necessário para Blowfish, RC2, CAST5, DES e IDEA.
  - Funcionam com `npm run <comando>` ou `pnpm <comando>`.
- **Python 3.8 ou superior** (opcional): só para as cifras de exemplo escritas em Python. Usam apenas a biblioteca padrão.
- **OpenSSL de linha de comando** (opcional): só para usar o motor "OpenSSL do sistema".
- **ESLint e Prettier** (só para desenvolvimento): instalados com `pnpm install`, como `devDependencies`.

## Comandos

| Comando               | O que faz                                                                        |
| --------------------- | -------------------------------------------------------------------------------- |
| `npm run classificar` | Abre o assistente de configuração, gera a base e classifica os arquivos de teste |
| `npm run exemplo`     | Exemplo numérico da dissertação (pesos 135 e 226)                                |
| `npm run grupos`      | Caminho automático (grupos e cores) com dados artificiais                        |
| `npm run resultados`  | Avaliação oficial: 5 sementes × 300 testes (Blowfish, RC2 e CAST5 em CBC)        |
| `npm run ambiente`    | Confere Node, OpenSSL embutido e do sistema, cifras e texto-base                 |
| `npm test`            | Todos os testes: interface, núcleo e cifras de exemplo                           |
| `npm run lint`        | ESLint em todo o código JavaScript (`lint:fix` corrige o que for automático)     |
| `npm run format`      | Formata o código e os README com o Prettier (`format:check` só confere)          |

O ESLint usa as regras recomendadas (`eslint.config.js`). O Prettier usa aspas simples e linhas de até 120 caracteres (`.prettierrc.json`). Ficam fora da formatação os dados gerados e conferidos por hash: a Bíblia, os protocolos e o registro da avaliação oficial, além das configurações, logs e dados das baterias (`.prettierignore`).

## O assistente (`npm run classificar`)

A primeira pergunta é se você quer a configuração padrão: Blowfish, RC2 e CAST5 em CBC, motor Node, com semente e trecho sorteados. **Enter aceita.** Respondendo `n`, o assistente pergunta, em ordem:

| Etapa               | Escolha                                                                                                                                         | Padrão                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [A] Motor           | Node.js (OpenSSL embutido) ou OpenSSL do sistema (`/opt/homebrew/bin/openssl`, `/usr/bin/openssl` ou outro caminho)                             | Node                           |
| [B] Modo            | ECB, CBC, CFB, OFB ou CTR (CTR só para cifras de bloco de 128 bits)                                                                             | CBC                            |
| [C] Cifras          | Blowfish, RC2, CAST5, DES, 3DES, IDEA, SEED, AES-128/192/256, Camellia-128/256, SM4, ARIA-128, mais **cifras próprias** ou **exemplos prontos** | Blowfish, RC2, CAST5           |
| [D] Tamanhos        | bytes por arquivo, chaves da base, arquivos por chave, amostras, testes por cifra                                                               | 8.192 · 10 · 50 · 5 · 100      |
| [E] Semente         | número ou Enter para sortear                                                                                                                    | sorteada                       |
| [F] Chaves          | derivadas da semente · uma chave fixa por cifra (base e testes) · digitar cada chave                                                            | derivadas                      |
| [G] IV              | um por arquivo, derivado da semente · fixo por cifra · zero (não aparece em ECB)                                                                | um por arquivo                 |
| [H] Trecho de teste | posição na Bíblia ou Enter para sortear                                                                                                         | sorteado                       |
| [I] Decisão         | candidatos, Tipo 1, 2 ou 3, regra, alfa, regra de peso zero e quantidade de arquivos de teste                                                   | Tipo 3, todos, peso zero perde |

**Peso zero.** Uma cifra pode receber peso zero em todas as amostras, quando nenhum criptotermo da entrada ficou mais perto dela. Nesse caso, o índice `1 − desvio/média` fica indefinido, porque a média é zero. Isso acontece com cifras muito fracas: a XOR ou a César levam todos os pesos, e as outras ficam zeradas.

- **Padrão (`perde`):** a cifra sem peso perde os confrontos, porque não há nenhuma evidência a favor dela.
- **Alternativa (`abster`):** reproduz a fórmula literal e deixa o arquivo sem classe (`--peso-zero abster`).

Nas 6.000 classificações em CBC da validação, esse caso nunca ocorreu.

Ao digitar chaves ou IVs, Enter usa o valor derivado da semente. O tamanho da chave vem do próprio OpenSSL: DES tem 8 bytes, 3DES 24, AES-256 32.

Cada execução salva todas as escolhas em `config.json`, dentro da pasta da sessão. Para repetir exatamente a mesma execução, sem passar pelo assistente:

```bash
npm run classificar -- --config runs/sessoes/<sessão>/config.json
```

O `config.json` também pode ser escrito ou editado à mão. É o jeito mais prático de definir muitas chaves. Há exemplos prontos em `runs/bateria-ecb-cesar-xor/configs/`.

Outras opções (depois de `--`):

- `--padrao`: pula o assistente.
- `--casos 3`: faz um ensaio rápido.
- `--semente N --inicio-teste N`: repete o perfil padrão.
- `--arquivo CAMINHO`: classifica um arquivo externo.
- `--sem-menu`: encerra sem o menu final.

A lista completa aparece em `node interface/cli.mjs help`.

## Cifra própria

O artefato cifra a base e os testes com a cifra própria, junto com as outras escolhidas, e tenta reconhecê-la. Há duas formas de entregar a cifra, além dos exemplos prontos.

### 1. Programa externo, em qualquer linguagem

O artefato chama o comando assim:

```bash
<comando> <chave-hex> <iv-hex> <modo>  < texto-claro  > criptograma
```

- `chave-hex` tem o tamanho informado no assistente (padrão: 16 bytes).
- `iv-hex` tem o tamanho informado; fica vazio quando o tamanho é 0.
- `modo` é o modo escolhido no assistente (ECB, CBC…). O programa pode ignorá-lo, porque é ele quem aplica o próprio modo.
- A saída precisa ser um múltiplo de 8 bytes.
- O programa precisa ser **determinístico**: mesma chave e mesmo IV geram o mesmo criptograma. O artefato confere isso antes de começar e de novo ao validar a base.

Modelo mais simples: [`exemplos/cifra-xor.py`](exemplos/cifra-xor.py). Comando: `python3 exemplos/cifra-xor.py`.

### 2. Função de bloco em JavaScript

Um arquivo `.mjs` que cifra **um bloco**. O artefato aplica o modo escolhido (ECB, CBC, CFB, OFB ou CTR) por cima:

```js
export const nome = 'Minha cifra';
export const blocoBytes = 8;
export const chaveBytes = 16;
export function cifrarBloco(bloco, chave) {
  return new Uint8Array(blocoBytes);
}
```

Modelo: [`exemplos/feistel-fraca.mjs`](exemplos/feistel-fraca.mjs) (Feistel de 2 rodadas). Os cinco modos aplicados pelo artefato foram conferidos contra o OpenSSL: com Blowfish, CAST5, AES e Camellia como função de bloco, os bytes saem idênticos.

### 3. Exemplos prontos

No assistente, na etapa [C]:

1. Responda `s` em "Adicionar uma cifra própria ou de exemplo?".
2. Escolha a opção **3**.
3. Digite os números das cifras, separados por vírgula.

| Nome                                     | Forma                     | Chave                                 | Família         |
| ---------------------------------------- | ------------------------- | ------------------------------------- | --------------- |
| XOR, Cesar, Vigenere, Afim, Substituicao | programa em Python        | 16, 1, 16, 2 e 16 bytes               | clássicas       |
| Transposicao, Hill                       | função de bloco (8 bytes) | 8 e 64 bytes                          | clássicas       |
| RC4                                      | programa em Python        | 16 bytes (+ IV opcional, como no WEP) | moderna (fluxo) |
| TEA, RC5                                 | função de bloco (8 bytes) | 16 bytes                              | modernas        |
| Feistel                                  | função de bloco (8 bytes) | 16 bytes                              | didática        |

O catálogo completo, os pontos fracos de cada cifra, a conferência (vetores de teste do TEA e do RC5, RC4 igual ao do OpenSSL) e o uso à mão estão em [`exemplos/README.md`](exemplos/README.md).

## Etapas mostradas no terminal

1. **Ambiente:** motor, modo e cifras, cada uma conferida com uma cifragem de teste; integridade da Bíblia.
2. **Base de referência:** semente, chaves, IVs e trecho de teste; trechos da Bíblia cifrados e divididos em criptotermos de 8 bytes.
3. **Busca automática de grupos:** liga arquivos que compartilham um criptotermo idêntico. Em CBC não se formam grupos; em ECB com a mesma chave, sim.
4. **Entrada:** arquivo de teste dividido em criptotermos; a cifra real fica oculta.
5. **Pesos:** distância de Hamming entre a entrada e cada amostra da base.
6. **Índice:** `I = 1 − desvio/média` dos pesos e `VR = 1 − I`, por cifra.
7. **Decisão:** regra Tipo 1, 2 ou 3 aplicada aos VR.
8. **Gabarito:** a cifra real é consultada só depois da previsão.

O primeiro arquivo aparece com as 8 etapas; os demais, em uma linha cada, seguidos de um resumo com acertos e matriz de confusão. Quando há grupos, o resumo mostra também a composição de cada grupo e quantos testes o caminho automático levou ao grupo da cifra certa.

O artefato não aprende com os erros. A base é fixa durante a execução, e o gabarito de um arquivo não volta para o modelo antes do arquivo seguinte.

## Experimentos registrados

| Experimento                                                         | Configuração                                                             | Resultado                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Avaliação oficial (`npm run resultados`)                            | Blowfish, RC2 e CAST5 · CBC com IV por arquivo · 5 sementes × 300 testes | 486/1.500 = **32,4%** (escolha fixa: 33,3%); o caminho automático não forma grupos                        |
| [Bateria ECB com César e XOR](runs/bateria-ecb-cesar-xor/RESUMO.md) | Blowfish, RC2, CAST5, XOR e César · ECB · 6 execuções × 200 testes       | mesma chave na base e nos testes: **85,0%** (caminho automático 100%) · chave nova: **25,2%** (acaso 20%) |

Na bateria ECB, o que o método reconhece com a mesma chave é a chave e o modo: o ECB repete criptotermos. Com uma chave que não está na base, a César aparece nos pesos, mas é descartada pelo índice de uniformidade; o caminho automático, por outro lado, acerta 100% dela. A análise completa está no [`RESUMO.md`](runs/bateria-ecb-cesar-xor/RESUMO.md).

## Estrutura

```text
interface/          terminal: assistente (assistente.mjs), geração da base (base.mjs), etapas e menu (cli.mjs),
                    formatação da tela (presenter.mjs), cálculo com barra de progresso (trace.mjs)
interface/test/     testes da interface
engine/src/         núcleo do método: cifragem e modos, termos, grafo, cores, pesos, índice e decisões
engine/test/        testes do núcleo e das cifras de exemplo
engine/data/        Bíblia (Projeto Gutenberg) usada como texto-base, com origem e licença (SOURCES.md)
engine/protocols/   configurações da avaliação oficial
engine/runs/        registro da avaliação oficial: resultados das 5 sementes
engine/validation/  conferência da avaliação oficial
exemplos/           11 cifras de exemplo (programas em Python e funções de bloco), catalogo.json e README.md
runs/bateria-ecb-cesar-xor/
                    bateria ECB: configurações, logs, dados compactos, consolidar.mjs e RESUMO.md
runs/sessoes/       criada a cada execução: terminal.txt, config.json, um JSON por caso e a base cifrada
                    (fora do git: dezenas de MB por execução; o config.json basta para refazer)
eslint.config.js    regras do ESLint
.prettierrc.json    estilo do Prettier (.prettierignore: o que fica fora da formatação)
```

O perfil padrão gera, para a mesma semente e o mesmo trecho, exatamente os mesmos bytes da avaliação oficial. As chaves e os IVs derivados ficam registrados no `manifest.json` da base para permitir repetir o experimento. Não use essa geração para proteger dados reais.
