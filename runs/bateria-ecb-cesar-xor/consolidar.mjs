// Consolida a bateria ECB (César e XOR) em RESUMO.md.
//
// 1. Para cada log em logs/, se a sessão citada no log ainda existe em runs/sessoes/, extrai dela
//    um resumo compacto em dados/<log>.json: config.json, estatísticas dos grupos, composição de
//    cada grupo (reajustando o modelo sobre a base) e, por caso, cifra real, previsão e grupo.
// 2. Monta RESUMO.md só a partir de dados/. As sessões completas (com as bases cifradas) não vão
//    para o repositório; os arquivos de dados/ bastam para refazer as tabelas.
//
// A seção "## Leitura" do RESUMO.md, escrita à mão, é preservada.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LazarinModel } from '../../engine/src/pipeline.js';
import { Cryptogram } from '../../engine/src/terms.js';
import { readCiphertext, localFile } from '../../engine/src/io.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATA = path.join(HERE, 'dados');
const pct = x => `${(100 * x).toFixed(1).replace('.', ',')}%`;
const margin = (p, n) => 1.96 * Math.sqrt(p * (1 - p) / n);
const int = s => Number(String(s).replace(/\./g, ''));

function extract(log, text, dir) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const structural = text.match(/Ligações: ([\d.]+) · Grupos: ([\d.]+) · Arquivos isolados: ([\d.]+)/);
  const groups = int(structural[2]);
  const composition = {};
  if (groups >= 2) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'base', 'manifest.json'), 'utf8'));
    const refs = manifest.records.filter(r => r.split === 'reference');
    const model = LazarinModel.fit(refs.map((r, i) =>
      Cryptogram.fromBytes('ref-' + i, readCiphertext(localFile(path.join(dir, 'base'), r.path)))));
    for (const group of model.featureGroups) {
      const counts = {};
      for (const id of group.cryptogram_ids) {
        const label = refs[Number(id.slice(4))].algorithm;
        counts[label] = (counts[label] ?? 0) + 1;
      }
      composition['delta_' + group.group_number] = counts;
    }
  }
  const cases = fs.readdirSync(dir).filter(f => /^caso-\d+\.json$/.test(f)).sort().map(f => {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { file: c.input.source, actual: c.actual, prediction: c.result.prediction ?? null,
      correct: c.correct, group: c.structural?.prediction ?? null };
  });
  return {
    log, session: path.relative(ROOT, dir), config,
    links: int(structural[1]), groups, isolated: int(structural[3]),
    time: text.match(/tempo: ([^\n]+)/)?.[1]?.trim() ?? null,
    composition, cases,
  };
}

fs.mkdirSync(DATA, { recursive: true });
const runs = [];
for (const log of fs.readdirSync(path.join(HERE, 'logs')).filter(f => f.endsWith('.txt') && f !== 'tempo.txt').sort()) {
  const name = log.replace('.txt', '');
  const [scenario] = name.split('-');
  const text = fs.readFileSync(path.join(HERE, 'logs', log), 'utf8');
  const folder = text.match(/Registro desta execução[^:]*: (\S+)/)?.[1];
  const target = path.join(DATA, name + '.json');
  let data = null;
  if (folder && fs.existsSync(path.join(ROOT, folder, 'config.json'))) {
    data = extract(log, text, path.join(ROOT, folder));
    fs.writeFileSync(target, JSON.stringify(data, null, 1) + '\n');
  } else if (fs.existsSync(target)) {
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  }
  if (!data) { runs.push({ name, scenario, error: folder ? `sessão ${folder} não encontrada` : text.trim().split('\n').at(-1) }); continue; }
  const majority = new Map(Object.entries(data.composition)
    .map(([group, counts]) => [group, Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]]));
  runs.push({ ...data, name, scenario, seed: data.config.seed, labels: data.config.settings.candidates, majority });
}

const ok = runs.filter(r => !r.error);
const labels = ok[0]?.labels ?? [];
const autoRight = (r, c) => c.group != null && r.majority.get(c.group) === c.actual;
const lines = ['# Bateria ECB com cifra de César e XOR', '',
  'Cinco cifras em ECB (Blowfish, RC2, CAST5, XOR e César), motor Node, decisão Tipo 3, peso zero perde.',
  'Base por cifra: 10 chaves × 20 arquivos de 8.192 bytes, 5 amostras. Testes: 40 arquivos por cifra (200 por execução).', '',
  '- **Chave fixa:** cada cifra usa a mesma chave na base e nos testes.',
  '- **Chaves diferentes:** 10 chaves na base e uma chave de teste que não aparece na base.',
  '- Acaso com 5 cifras: 20%.', '',
  'Para repetir uma execução: `npm run classificar -- --config runs/bateria-ecb-cesar-xor/configs/<arquivo>.json --sem-menu`.', ''];

lines.push('## Execuções', '', '| Cenário | Semente | Grupos (ligações) | Acertos do método | Caminho automático: grupo da cifra certa | Tempo |', '|---|---|---|---|---|---|');
for (const r of runs) {
  if (r.error) { lines.push(`| ${r.scenario} | — | erro: ${r.error} | | | |`); continue; }
  const correct = r.cases.filter(c => c.correct).length;
  const assigned = r.cases.filter(c => c.group != null);
  const right = assigned.filter(c => autoRight(r, c)).length;
  lines.push(`| ${r.scenario === 'fixa' ? 'chave fixa' : 'chaves diferentes'} | ${r.seed} | ${r.groups} (${r.links.toLocaleString('pt-BR')}) | ${correct}/${r.cases.length} (${pct(correct / r.cases.length)}) | ` +
    (r.groups >= 2 ? `${right}/${assigned.length} (${pct(right / Math.max(1, assigned.length))})` : 'sem grupos') + ` | ${r.time ?? '—'} |`);
}

for (const scenario of ['fixa', 'diferentes']) {
  const group = ok.filter(r => r.scenario === scenario);
  if (!group.length) continue;
  const all = group.flatMap(r => r.cases.map(c => ({ ...c, run: r })));
  const correct = all.filter(c => c.correct).length, p = correct / all.length;
  lines.push('', `## ${scenario === 'fixa' ? 'Chave fixa' : 'Chaves diferentes'} · ${group.length} execuções, ${all.length} arquivos`, '',
    `- Acerto do método (preparado): **${correct}/${all.length} = ${pct(p)}** (margem 95%: ±${(100 * margin(p, all.length)).toFixed(1).replace('.', ',')} p.p.)`);
  const assigned = all.filter(c => c.group != null);
  const right = assigned.filter(c => autoRight(c.run, c)).length;
  if (assigned.length) lines.push(`- Caminho automático (grupo da cifra certa): **${right}/${assigned.length} = ${pct(right / assigned.length)}**`);
  lines.push(`- Sem classe: ${all.filter(c => c.prediction == null).length}`, '',
    '| Cifra real | Método: acertos | Caminho automático: grupo certo |', '|---|---|---|');
  for (const label of labels) {
    const mine = all.filter(c => c.actual === label);
    const hit = mine.filter(c => c.correct).length;
    const mineAuto = mine.filter(c => c.group != null);
    const hitAuto = mineAuto.filter(c => autoRight(c.run, c)).length;
    lines.push(`| ${label} | ${hit}/${mine.length} (${pct(hit / mine.length)}) | ${mineAuto.length ? `${hitAuto}/${mineAuto.length} (${pct(hitAuto / mineAuto.length)})` : '—'} |`);
  }
  lines.push('', 'Matriz de confusão do método (linha = cifra real, coluna = previsão)', '',
    `| | ${labels.join(' | ')} | SEM CLASSE |`, `|---|${labels.map(() => '---').join('|')}|---|`);
  for (const real of labels) {
    const row = all.filter(c => c.actual === real);
    lines.push(`| ${real} | ${labels.map(l => row.filter(c => c.prediction === l).length).join(' | ')} | ${row.filter(c => c.prediction == null).length} |`);
  }
}

lines.push('', '## Arquivos', '',
  '- `configs/`: as 6 configurações (`config.json`), uma por execução.',
  '- `logs/`: a saída de terminal de cada execução; `tempo.txt` tem o início e o fim da bateria.',
  '- `dados/`: resumo compacto de cada sessão (configuração, composição dos grupos e, por arquivo de teste, cifra real, previsão e grupo).',
  '- `consolidar.mjs`: refaz este arquivo a partir de `dados/` (ou das sessões em `runs/sessoes/`, quando existirem).');

const out = path.join(HERE, 'RESUMO.md');
const previous = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
const reading = previous.indexOf('\n## Leitura');
const text = lines.join('\n') + '\n' + (reading >= 0 ? previous.slice(reading) : '');
fs.writeFileSync(out, text.endsWith('\n') ? text : text + '\n');
console.log(lines.join('\n'));
