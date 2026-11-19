# Cifra afim, byte a byte: c = (a·p + b) mod 256.
# Generaliza a César (a = 1). "a" precisa ser ímpar para ter inverso mod 256; por isso o
# programa força o bit menos significativo. Há só 128 × 256 = 32.768 chaves distintas.
#
# Uso pelo artefato: python3 exemplos/cifra-afim.py <chave-hex> <iv-hex> <modo>
# Chave: 2 bytes (a, b). IV e modo são ignorados.
# Conferência manual: um quarto argumento "decifrar" desfaz a cifragem.
import sys

chave = bytes.fromhex(sys.argv[1]).ljust(2, b'\x00')
a, b = chave[0] | 1, chave[1]
if len(sys.argv) > 4 and sys.argv[4] == 'decifrar':
    inverso = pow(a, -1, 256)
    tabela = bytes((inverso * (x - b)) % 256 for x in range(256))
else:
    tabela = bytes((a * x + b) % 256 for x in range(256))
sys.stdout.buffer.write(sys.stdin.buffer.read().translate(tabela))
