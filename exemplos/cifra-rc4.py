# RC4 (Rivest, 1987): cifra de fluxo usada em WEP, WPA-TKIP e TLS até ser proibida (RFC 7465).
# Gera um fluxo pseudoaleatório a partir da chave e faz XOR com o texto.
# Fraquezas conhecidas: vieses nos primeiros bytes do fluxo e, sem IV, o mesmo fluxo para
# todos os arquivos cifrados com a mesma chave.
#
# Uso pelo artefato: python3 exemplos/cifra-rc4.py <chave-hex> <iv-hex> <modo>
# Chave: 1 a 256 bytes (padrão 16). Com IV, a chave do RC4 é IV || chave, como no WEP.
# O modo é ignorado. Cifrar e decifrar são a mesma operação.
# Conferido contra o RC4 do OpenSSL nos testes (engine/test/exemplos.test.js).
import sys

chave = bytes.fromhex(sys.argv[2]) + bytes.fromhex(sys.argv[1])
S = list(range(256))
j = 0
for i in range(256):
    j = (j + S[i] + chave[i % len(chave)]) % 256
    S[i], S[j] = S[j], S[i]

texto = sys.stdin.buffer.read()
cripto = bytearray(len(texto))
i = j = 0
for n, b in enumerate(texto):
    i = (i + 1) % 256
    j = (j + S[i]) % 256
    S[i], S[j] = S[j], S[i]
    cripto[n] = b ^ S[(S[i] + S[j]) % 256]
sys.stdout.buffer.write(bytes(cripto))
