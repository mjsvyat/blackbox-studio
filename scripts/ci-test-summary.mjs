// Сводка тестов для CI: сколько прошло, сколько пропущено и почему.
// Вход — JSON-отчёт vitest (`--reporter=json --outputFile.json=…`), выход — Markdown в
// $GITHUB_STEP_SUMMARY (или в stdout локально) и аннотация ::notice про пропуски.
// Пропуски в CI ожидаемы: большой дамп (Git LFS, 132 МБ) в CI не скачивается, его тесты
// пропускаются через hasFixture(); полный прогон — локально после `git lfs pull`.
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || 'test-results.json';
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const lfsPointer = (() => {
  try {
    return fs.statSync(path.resolve('tests/fixtures/blackbox.txt')).size < 1_000_000;
  } catch {
    return true;
  }
})();

const skipped = new Map();
const failed = [];
for (const t of r.testResults) {
  const rel = path.relative(process.cwd(), t.name);
  for (const a of t.assertionResults) {
    if (a.status === 'failed') failed.push(`${rel} › ${a.fullName}`);
    if (a.status === 'skipped' || a.status === 'pending' || a.status === 'todo') {
      const key = `${rel} › ${a.ancestorTitles[0] ?? '(верхний уровень)'}`;
      skipped.set(key, (skipped.get(key) ?? 0) + 1);
    }
  }
  if (t.status === 'failed' && !t.assertionResults.some((a) => a.status === 'failed')) failed.push(`${rel}: ${t.message.split('\n')[0]}`);
}

const out = [];
out.push(`## Тесты: ${r.success ? '✅ зелёные' : '❌ есть падения'}`);
out.push('');
out.push(`| Всего | Прошло | Упало | Пропущено |`);
out.push(`|---|---|---|---|`);
out.push(`| ${r.numTotalTests} | ${r.numPassedTests} | ${r.numFailedTests} | ${r.numPendingTests + r.numTodoTests} |`);
out.push('');
if (failed.length) {
  out.push('### Упали');
  for (const f of failed) out.push(`- ${f}`);
  out.push('');
}
if (skipped.size) {
  out.push('### Пропущены и почему');
  out.push(
    lfsPointer
      ? 'Большой дамп `tests/fixtures/blackbox.txt` (BF 4.5.2, 132 МБ, Git LFS) в CI не скачивается — бесплатный лимит LFS 1 ГБ/мес. ' +
          'Его тесты пропускаются, а часть (по логам дампа) без файла даже не создаётся. **Полный прогон — локально: `git lfs pull && npm test`.**'
      : 'Пропуски не связаны с большим дампом — проверь `skipIf` в тестах ниже.',
  );
  out.push('');
  for (const [k, n] of skipped) out.push(`- ${k} — ${n}`);
  out.push('');
}
out.push('CI не проверяет: большой дамп, открытие `dist/index.html` через `file://`, работу с полётником по USB — это делается локально перед слиянием (см. CLAUDE.md).');

const md = out.join('\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
else process.stdout.write(md);
const nSkip = r.numPendingTests + r.numTodoTests;
if (nSkip && process.env.GITHUB_ACTIONS) console.log(`::notice title=Пропущено тестов: ${nSkip}::${lfsPointer ? 'Большой дамп (Git LFS) в CI не скачивается. Полный прогон — локально: git lfs pull && npm test' : 'см. сводку'}`);
