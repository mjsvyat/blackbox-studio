// Регрессия по разобранным случаям: каждый cases/INC-xxxx/case.json с regression.checks
// прогоняется полным конвейером (analysis/pipeline.ts). Правка, ломающая старый случай,
// не принимается (CLAUDE.md, «Разбор инцидента», п. 5).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardKnowledge } from '../../src/advisor/advisor';
import { buildContext } from '../../src/analysis/context';
import { adviseLog, analyzeLog, snapshotLog } from '../../src/analysis/pipeline';
import { decodeLog } from '../../src/decoder/decoder';
import { scanFile } from '../../src/decoder/scan';
import { Check, evaluateChecks } from '../../src/incidents/regression';
import { FIXTURES, fileReader, hasFixture, readRange } from '../helpers';

const CASES = path.resolve(__dirname, '../../cases');

interface CaseJson {
  incident: { id: string };
  regression?: {
    log: { file?: string; fixture?: string; logIndex?: number } | null;
    checks: Check[];
    board?: BoardKnowledge;
    oldBehavior?: Record<string, unknown>;
  };
}

function listCases(): { dir: string; json: CaseJson }[] {
  if (!fs.existsSync(CASES)) return [];
  return fs.readdirSync(CASES).filter((d) => fs.existsSync(path.join(CASES, d, 'case.json')))
    .map((d) => ({ dir: path.join(CASES, d), json: JSON.parse(fs.readFileSync(path.join(CASES, d, 'case.json'), 'utf8')) as CaseJson }));
}

async function loadLog(dir: string, ref: NonNullable<NonNullable<CaseJson['regression']>['log']>): Promise<Uint8Array | null> {
  if (ref.file) {
    const p = path.join(dir, ref.file);
    return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
  }
  if (ref.fixture) {
    const f = path.join(FIXTURES, ref.fixture);
    if (!hasFixture(f, 100_000)) return null;
    const r = fileReader(f);
    const st = await scanFile(r);
    r.close();
    const L = st.logs.find((l) => l.index === ref.logIndex)!;
    const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
    return readRange(f, L.start, end - L.start);
  }
  return null;
}

/** нарушения проверок случая; override — пороги советчика (для проверки «старого поведения») */
export async function runCase(dir: string, json: CaseJson, override: Record<string, unknown> = {}): Promise<string[] | null> {
  const reg = json.regression;
  if (!reg?.log) return null;
  const buf = await loadLog(dir, reg.log);
  if (!buf) return null;
  const c = buildContext(decodeLog(buf));
  const a = analyzeLog(c);
  const adv = adviseLog(a, undefined, reg.board, override);
  const snap = snapshotLog(a, adv, { fileName: 'case', logIndex: reg.log.logIndex ?? 0 });
  return evaluateChecks(adv, snap, reg.checks);
}

const cases = listCases();

describe('разобранные случаи не повторяются', () => {
  it('папка cases/ есть и случаи читаются', () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) expect(c.json.incident.id).toMatch(/^INC-\d{4}$/);
  });

  for (const { dir, json } of cases) {
    if (!json.regression?.checks.length) continue;
    it(`${json.incident.id}: проверки проходят на текущих правилах`, async () => {
      const fails = await runCase(dir, json);
      if (fails === null) return; // лога нет (LFS не скачан) — пропуск
      expect(fails).toEqual([]);
    });
    if (json.regression.oldBehavior) {
      it(`${json.incident.id}: на правилах до исправления проверка ловит ошибку`, async () => {
        const fails = await runCase(dir, json, json.regression!.oldBehavior);
        if (fails === null) return;
        expect(fails.length).toBeGreaterThan(0);
      });
    }
  }
});
