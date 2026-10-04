// Каждая цифра в UI — с подсказкой: все id подсказок, на которые ссылается код, существуют,
// у каждой подсказки три уровня, все ссылки на глоссарий ведут на статьи. Правило
// безопасности: подсказки, где поднимают D или ослабляют фильтры, предупреждают о моторах.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');
const HELP = path.join(SRC, 'content/help');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const code = walk(SRC).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const helpIds = new Set(fs.readdirSync(HELP).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')));
const glossary = fs.readFileSync(path.join(SRC, 'content/glossary.md'), 'utf8');
const glossIds = new Set([...glossary.matchAll(/\{#([\w-]+)\}/g)].map((m) => m[1]));

describe('подсказки', () => {
  it('все id подсказок из кода существуют', () => {
    const used = new Set<string>();
    for (const m of code.matchAll(/helpBtn\('([\w-]+)'\)/g)) used.add(m[1]);
    for (const m of code.matchAll(/help: '([\w-]+)'/g)) used.add(m[1]);
    const missing = [...used].filter((id) => !helpIds.has(id));
    expect(missing).toEqual([]);
  });

  it('у каждой подсказки «Коротко», «Подробно», «Для тюнера»', () => {
    for (const id of helpIds) {
      const t = fs.readFileSync(path.join(HELP, `${id}.md`), 'utf8');
      for (const sec of ['## Коротко', '## Подробно', '## Для тюнера']) expect(t, `${id}: ${sec}`).toContain(sec);
    }
  });

  it('ссылки [[…|id]] ведут на статьи глоссария', () => {
    const bad: string[] = [];
    for (const id of helpIds) {
      const t = fs.readFileSync(path.join(HELP, `${id}.md`), 'utf8');
      for (const m of t.matchAll(/\[\[([^\]|]+)(?:\|([\w-]+))?\]\]/g)) {
        const ref = m[2] ?? m[1].toLowerCase();
        if (!glossIds.has(ref) && !helpIds.has(ref)) bad.push(`${id}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('подъём D / ослабление фильтров — «20–30 с» и «потрогай моторы»', () => {
    for (const id of ['filter-sandbox', 'pid-gains', 'pid-forecast']) {
      const t = fs.readFileSync(path.join(HELP, `${id}.md`), 'utf8');
      expect(t, id).toMatch(/20–30 с/);
      expect(t, id).toMatch(/потрогай моторы/);
    }
  });
});
