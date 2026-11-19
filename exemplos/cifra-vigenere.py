# Cifra de Vigenère (Bellaso, 1553; atribuída a Vigenère), byte a byte.
# Cada byte é somado (mod 256) ao byte da chave na mesma posição; a chave se repete.
# É uma César com um deslocamento diferente por posição: o período é o tamanho da chave.
#
# Uso pelo artefato: python3 exemplos/cifra-vigenere.py <chave-hex> <iv-hex> <modo>
# Chave: qualquer tamanho (padrão 16 bytes). IV e modo são ignorados.
# Conferência manual: um quarto argumento "decifrar" desfaz a cifragem.
import sys

chave = bytes.fromhex(sys.argv[1]) or b'\x03'
sinal = -1 if len(sys.argv) > 4 and sys.argv[4] == 'decifrar' else 1
texto = sys.stdin.buffer.read()
cripto = bytes((b + sinal * chave[i % len(chave)]) % 256 for i, b in enumerate(texto))
sys.stdout.buffer.write(cripto)
