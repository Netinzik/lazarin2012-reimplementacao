# Substituição monoalfabética sobre bytes.
# A chave define uma permutação dos 256 valores de byte; cada byte do texto é trocado pelo
# seu correspondente na tabela. Preserva a frequência dos bytes (análise de frequência a quebra).
# A tabela é obtida ordenando os 256 valores por SHA-256(chave || valor).
#
# Uso pelo artefato: python3 exemplos/cifra-substituicao.py <chave-hex> <iv-hex> <modo>
# Chave: qualquer tamanho (padrão 16 bytes). IV e modo são ignorados.
# Conferência manual: um quarto argumento "decifrar" desfaz a cifragem.
import hashlib
import sys

chave = bytes.fromhex(sys.argv[1])
ordem = sorted(range(256), key=lambda x: hashlib.sha256(chave + bytes([x])).digest())
tabela = bytearray(256)
for origem, destino in enumerate(ordem):
    tabela[origem] = destino
if len(sys.argv) > 4 and sys.argv[4] == 'decifrar':
    inversa = bytearray(256)
    for origem, destino in enumerate(tabela):
        inversa[destino] = origem
    tabela = inversa
sys.stdout.buffer.write(sys.stdin.buffer.read().translate(bytes(tabela)))
