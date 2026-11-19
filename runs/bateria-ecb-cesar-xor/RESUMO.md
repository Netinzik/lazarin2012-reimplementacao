# Bateria ECB com cifra de César e XOR

Cinco cifras em ECB (Blowfish, RC2, CAST5, XOR e César), motor Node, decisão Tipo 3, peso zero perde.
Base por cifra: 10 chaves × 20 arquivos de 8.192 bytes, 5 amostras. Testes: 40 arquivos por cifra (200 por execução).

- **Chave fixa:** cada cifra usa a mesma chave na base e nos testes.
- **Chaves diferentes:** 10 chaves na base e uma chave de teste que não aparece na base.
- Acaso com 5 cifras: 20%.

Para repetir uma execução: `npm run classificar -- --config runs/bateria-ecb-cesar-xor/configs/<arquivo>.json --sem-menu`.

## Execuções

| Cenário | Semente | Grupos (ligações) | Acertos do método | Caminho automático: grupo da cifra certa | Tempo |
|---|---|---|---|---|---|
| chaves diferentes | 101 | 50 (9.500) | 42/200 (21,0%) | 89/200 (44,5%) | 28 min 10 s |
| chaves diferentes | 202 | 50 (9.500) | 32/200 (16,0%) | 90/200 (45,0%) | 28 min 8 s |
| chaves diferentes | 303 | 49 (9.900) | 77/200 (38,5%) | 78/200 (39,0%) | 28 min 29 s |
| chave fixa | 101 | 5 (99.468) | 165/200 (82,5%) | 200/200 (100,0%) | 24 min 45 s |
| chave fixa | 202 | 5 (99.468) | 168/200 (84,0%) | 200/200 (100,0%) | 24 min 54 s |
| chave fixa | 303 | 5 (99.468) | 177/200 (88,5%) | 200/200 (100,0%) | 24 min 48 s |

## Chave fixa · 3 execuções, 600 arquivos

- Acerto do método (preparado): **510/600 = 85,0%** (margem 95%: ±2,9 p.p.)
- Caminho automático (grupo da cifra certa): **600/600 = 100,0%**
- Sem classe: 0

| Cifra real | Método: acertos | Caminho automático: grupo certo |
|---|---|---|
| Blowfish | 98/120 (81,7%) | 120/120 (100,0%) |
| RC2 | 87/120 (72,5%) | 120/120 (100,0%) |
| CAST5 | 85/120 (70,8%) | 120/120 (100,0%) |
| XOR | 120/120 (100,0%) | 120/120 (100,0%) |
| Cesar | 120/120 (100,0%) | 120/120 (100,0%) |

Matriz de confusão do método (linha = cifra real, coluna = previsão)

| | Blowfish | RC2 | CAST5 | XOR | Cesar | SEM CLASSE |
|---|---|---|---|---|---|---|
| Blowfish | 98 | 6 | 14 | 0 | 2 | 0 |
| RC2 | 14 | 87 | 13 | 3 | 3 | 0 |
| CAST5 | 14 | 19 | 85 | 0 | 2 | 0 |
| XOR | 0 | 0 | 0 | 120 | 0 | 0 |
| Cesar | 0 | 0 | 0 | 0 | 120 | 0 |

## Chaves diferentes · 3 execuções, 600 arquivos

- Acerto do método (preparado): **151/600 = 25,2%** (margem 95%: ±3,5 p.p.)
- Caminho automático (grupo da cifra certa): **257/600 = 42,8%**
- Sem classe: 0

| Cifra real | Método: acertos | Caminho automático: grupo certo |
|---|---|---|
| Blowfish | 39/120 (32,5%) | 33/120 (27,5%) |
| RC2 | 36/120 (30,0%) | 48/120 (40,0%) |
| CAST5 | 44/120 (36,7%) | 42/120 (35,0%) |
| XOR | 0/120 (0,0%) | 14/120 (11,7%) |
| Cesar | 32/120 (26,7%) | 120/120 (100,0%) |

Matriz de confusão do método (linha = cifra real, coluna = previsão)

| | Blowfish | RC2 | CAST5 | XOR | Cesar | SEM CLASSE |
|---|---|---|---|---|---|---|
| Blowfish | 39 | 32 | 33 | 10 | 6 | 0 |
| RC2 | 29 | 36 | 39 | 11 | 5 | 0 |
| CAST5 | 33 | 29 | 44 | 12 | 2 | 0 |
| XOR | 46 | 35 | 39 | 0 | 0 | 0 |
| Cesar | 24 | 43 | 21 | 0 | 32 | 0 |

## Arquivos

- `configs/`: as 6 configurações (`config.json`), uma por execução.
- `logs/`: a saída de terminal de cada execução; `tempo.txt` tem o início e o fim da bateria.
- `dados/`: resumo compacto de cada sessão (configuração, composição dos grupos e, por arquivo de teste, cifra real, previsão e grupo).
- `consolidar.mjs`: refaz este arquivo a partir de `dados/` (ou das sessões em `runs/sessoes/`, quando existirem).

## Leitura

- **ECB com a mesma chave na base e nos testes:** o método acerta 85% (acaso: 20%) e o caminho automático acerta 100%. A busca automática forma exatamente 5 grupos, um por cifra, sem olhar os rótulos. Até Blowfish, RC2 e CAST5 são reconhecidas (71% a 82%). O ECB é determinístico: o mesmo bloco de texto com a mesma chave gera sempre o mesmo criptotermo, e o texto de teste repete blocos que já estão na base. O que o método reconhece aqui é a chave e o modo, não uma "assinatura" do algoritmo. XOR e César: 100%.
- **ECB com chaves que não estão na base:** o método cai para 25,2%, perto do acaso.
  - **César:** o método enxerga, mas a regra descarta. Uma amostra da César recebe cerca de 1.100 pontos (a chave da base com deslocamento mais parecido), muito mais que qualquer outra cifra. Como o índice mede uniformidade (`I = 1 − desvio/média`), essa concentração dá VR ≈ 2 e a César perde todos os confrontos. Já o caminho automático, que compara por grupo, leva 100% dos testes da César ao grupo certo.
  - **XOR:** não é reconhecida (0%). Com outra chave, cada criptotermo muda pela diferença entre as chaves, e as cifras fortes acabam oferecendo vizinhos mais próximos. A XOR recebe menos peso que as outras.
- **Conclusão:** a fraqueza de uma cifra própria aparece quando a base contém material cifrado com a mesma chave, ou quando a cifra preserva a estrutura do texto, como a César no caminho automático. Com chave desconhecida, a regra de uniformidade do índice pode esconder o padrão mesmo quando os pesos o mostram.

O `consolidar.mjs` regenera as tabelas acima desta seção e preserva esta leitura.
