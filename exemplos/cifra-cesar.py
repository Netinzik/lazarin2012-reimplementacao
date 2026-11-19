# Cifra de César, byte a byte: cada byte é somado (mod 256) a um deslocamento fixo.
# Só existem 256 chaves; o mesmo byte de texto vira sempre o mesmo byte cifrado.
#
# Uso pelo artefato: python3 exemplos/cifra-cesar.py <chave-hex> <iv-hex> <modo>
# Chave: 1 byte (o deslocamento); com 00, usa 3, como na cifra original. IV e modo são ignorados.
# Conferência manual: um quarto argumento "decifrar" desfaz a cifragem.
import sys

chave = bytes.fromhex(sys.argv[1])
deslocamento = chave[0] if chave and chave[0] else 3
if len(sys.argv) > 4 and sys.argv[4] == 'decifrar':
    deslocamento = -deslocamento
texto = sys.stdin.buffer.read()
cripto = bytes((b + deslocamento) % 256 for b in texto)
sys.stdout.buffer.write(cripto)
