// Выпуск версии: одна версия на весь проект (корень и desktop/), раздел в CHANGELOG — иначе
// workflow Release упадёт уже на Windows-раннере.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/version';

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('версия программы', () => {
  const root = json('../package.json');
  const desk = json('../desktop/package.json');

  it('корень и desktop/ совпадают; releaseName — та же версия с ведущим нулём', () => {
    expect(desk.version).toBe(root.version);
    expect(desk.releaseName).toBe(root.releaseName);
    expect(root.releaseName.split('.').map(Number)).toEqual(root.version.split('.').map(Number));
  });

  it('в CHANGELOG.md есть раздел этой версии', () => {
    expect(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')).toContain(`## v${root.releaseName}\n`);
  });

  it('версия подставляется в сборку (vite define)', () => {
    expect(APP_VERSION).toBe(`v${root.releaseName}`);
  });
});
