// Текст релиза: раздел «## v<версия>» из CHANGELOG.md (до следующего «## »).
// node scripts/release-notes.mjs 1.08.26 > notes.md
import { readFileSync } from 'node:fs';

const v = process.argv[2];
if (!v) throw new Error('нужна версия: node scripts/release-notes.mjs 1.08.26');
const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const start = text.indexOf(`## v${v}`);
if (start < 0) throw new Error(`В CHANGELOG.md нет раздела «## v${v}»`);
const body = text.slice(text.indexOf('\n', start) + 1);
const end = body.search(/^## /m);
process.stdout.write((end < 0 ? body : body.slice(0, end)).trim() + '\n');
