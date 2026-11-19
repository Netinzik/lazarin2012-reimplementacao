# XOR com a chave repetida (Vernam com chave curta e reutilizada).
# Cada byte do texto faz XOR com o byte da chave na mesma posição; a chave se repete.
#
# Uso pelo artefato: python3 exemplos/cifra-xor.py <chave-hex> <iv-hex> <modo>
# Chave: qualquer tamanho (padrão 16 bytes). IV e modo são ignorados.
# Cifrar e decifrar são a mesma operação.
import sys

chave = bytes.fromhex(sys.argv[1])
texto = sys.stdin.buffer.read()
cripto = bytes(b ^ chave[i % len(chave)] for i, b in enumerate(texto))
sys.stdout.buffer.write(cripto)
