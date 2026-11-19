import fs from 'node:fs';
import path from 'node:path';

export function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function jsonText(value) {
  return (
    JSON.stringify(
      value,
      (_, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v instanceof Set) return [...v];
        if (v instanceof Map) return Object.fromEntries(v);
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('JSON contém número não finito');
        return v;
      },
      2,
    ) + '\n'
  );
}
export function writeJSON(file, data) {
  fs.writeFileSync(file, jsonText(data), { flag: 'wx' });
}
export function createOutput(directory) {
  if (fs.existsSync(directory)) throw new Error('Diretório já existe; use outro nome: ' + directory);
  fs.mkdirSync(path.dirname(path.resolve(directory)), { recursive: true });
  fs.mkdirSync(directory);
}
export function localFile(root, relative) {
  if (typeof relative !== 'string') throw new TypeError('Caminho inválido no manifesto');
  const base = fs.realpathSync(root);
  const target = fs.realpathSync(path.resolve(base, relative));
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    throw new Error('Caminho fora do diretório do manifesto');
  return target;
}
export function readCiphertext(file, encoding = 'raw') {
  let bytes = fs.readFileSync(file);
  if (encoding !== 'raw') {
    const text = bytes.toString('utf8').trim();
    if (encoding === 'hex') {
      if (!/^(?:[0-9a-fA-F]{2}[ \t\r\n\f\v]*)+$/.test(text)) throw new Error('Hexadecimal inválido');
      bytes = Buffer.from(text.replace(/[ \t\r\n\f\v]/g, ''), 'hex');
    } else if (encoding === 'base64') {
      const compact = text.replace(/[ \t\r\n\f\v]/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact))
        throw new Error('Base64 inválido');
      bytes = Buffer.from(compact, 'base64');
      if (bytes.toString('base64') !== compact) throw new Error('Base64 não canônico');
    } else throw new Error('Encoding deve ser raw, hex ou base64');
  }
  if (!bytes.length || bytes.length % 8) throw new Error('Ciphertext deve ser não vazio e múltiplo de 8 bytes');
  return bytes;
}
