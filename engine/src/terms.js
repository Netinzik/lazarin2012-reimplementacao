export const CRYPTOTERM_BITS = 64;
export const MAX_CRYPTOTERM = (1n << 64n) - 1n;

export function normalizeCryptoterm(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Use BigInt para inteiros acima de 2^53 - 1');
    value = BigInt(value);
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.byteLength !== 8) throw new RangeError('Criptotermo deve ter 8 bytes');
    value = Buffer.from(value).readBigUInt64BE();
  } else if (typeof value === 'string') {
    if (!/^[01]{64}$/.test(value)) throw new TypeError('String de criptotermo deve conter 64 bits');
    value = BigInt('0b' + value);
  }
  if (typeof value !== 'bigint') throw new TypeError('Criptotermo deve ser BigInt, inteiro seguro, bytes ou 64 bits');
  if (value < 0n || value > MAX_CRYPTOTERM) throw new RangeError('Criptotermo fora de 64 bits');
  return value;
}

export function splitBytes(data) {
  if (!(data instanceof Uint8Array)) throw new TypeError('Entrada deve ser Buffer/Uint8Array');
  if (data.byteLength % 8) throw new RangeError('Criptograma deve ser múltiplo de 8 bytes; sem padding');
  const buffer = Buffer.from(data);
  const terms = [];
  for (let offset = 0; offset < buffer.length; offset += 8) terms.push(buffer.readBigUInt64BE(offset));
  return terms;
}

export class Cryptogram {
  constructor(identifier, terms) {
    if (typeof identifier !== 'string' || !identifier) throw new TypeError('Identificador inválido');
    this.identifier = identifier;
    this.terms = Object.freeze(Array.from(terms, normalizeCryptoterm));
    Object.freeze(this);
  }
  static fromTerms(identifier, terms) { return new Cryptogram(identifier, terms); }
  static fromBytes(identifier, data) { return new Cryptogram(identifier, splitBytes(data)); }
}
export const sortTerms = (terms) => [...terms].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
