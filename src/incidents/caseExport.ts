// Папка случая для разбора Claude (CLAUDE.md, «Разбор инцидента»):
//   cases/INC-0007-hot-motors/
//     case.md        — человеческое описание (тексты — i18n T.case)
//     case.json      — всё машинно: инцидент, сессии, план, метрики, разбор, откат,
//                      заготовка регрессионной проверки
//     before.bbl / after.bbl — байты логов (если файл открыт) или logs.md со смещениями
//     plots/*.png    — ключевые графики (рисует UI)
//     resolution.md  — заполняется при исправлении

import cfg from '../config/analysis.json';
import { AXIS_NAMES, T } from '../i18n/ru';
import type { SessionRecord } from '../sessions/db';
import { AutoAnalysis, Incident, rollbackCli } from './incidents';

export interface CaseInput {
  incident: Incident;
  before: SessionRecord | null;
  after: SessionRecord;
  auto: AutoAnalysis | null;
  /** прошлая удачная сессия для отката */
  good: SessionRecord | null;
  logs?: { before?: Uint8Array; after?: Uint8Array };
  plots?: Record<string, Uint8Array>;
}

export function caseFolderName(inc: Incident): string {
  return `${inc.id}-${inc.symptoms[0] ?? 'other'}`;
}

/** заготовка регрессионной проверки: подозреваемое правило не должно выбираться на «было» */
function regressionStub(x: CaseInput): unknown {
  const top = x.auto?.suspects[0]?.rule.split('@')[0];
  return {
    _comment: T.case.regressionHint,
    log: x.logs?.before ? { file: 'before.bbl' } : x.before ? { ref: { fileName: x.before.snap.source.fileName, logIndex: x.before.snap.source.logIndex, byteStart: x.before.snap.source.byteStart, byteEnd: x.before.snap.source.byteEnd } } : null,
    checks: top ? [{ type: 'not-selected', rule: top }] : [],
  };
}

export function buildCaseFiles(x: CaseInput): Record<string, string | Uint8Array> {
  const { incident: inc, before, after, auto, good } = x;
  const dir = `cases/${caseFolderName(inc)}`;
  const files: Record<string, string | Uint8Array> = {};
  const rb = good ? rollbackCli(after.snap, good.snap) : null;
  files[`${dir}/case.json`] = JSON.stringify({
    format: 'blackbox-studio-case', v: 1, configVersion: cfg.version,
    incident: inc,
    before: before ?? null,
    after,
    lastGood: good ? { id: good.id, source: good.snap.source } : null,
    auto,
    rollback: rb?.lines ?? null,
    regression: regressionStub(x),
  }, null, 1);
  files[`${dir}/case.md`] = caseMd(x, rb?.lines ?? null);
  files[`${dir}/resolution.md`] = T.case.resolutionTemplate(inc.id);
  if (x.logs?.before) files[`${dir}/before.bbl`] = x.logs.before;
  if (x.logs?.after) files[`${dir}/after.bbl`] = x.logs.after;
  if (!x.logs?.before || !x.logs?.after) {
    const ref = (s: SessionRecord | null, name: string): string => (s ? T.case.logRef(name, s.snap.source.fileName, s.snap.source.logIndex, s.snap.source.byteStart, s.snap.source.byteEnd) : '');
    files[`${dir}/logs.md`] = [T.case.logsTitle, ref(before, 'before'), ref(after, 'after')].filter(Boolean).join('\n\n') + '\n';
  }
  for (const [k, v] of Object.entries(x.plots ?? {})) files[`${dir}/plots/${k}`] = v;
  return files;
}

function caseMd(x: CaseInput, rollback: string[] | null): string {
  const { incident: inc, before, after, auto } = x;
  const L: string[] = [];
  const C = T.case;
  L.push(`# ${inc.id}: ${inc.symptoms.map((s) => C.symptom[s]).join(', ')}`, '');
  L.push(`- ${C.created}: ${inc.createdAt}`);
  L.push(`- ${C.severity}: ${inc.severity} / 3${inc.motorTemp !== null ? ` · ${C.motorTemp}: ${C.temp[inc.motorTemp]}` : ''}`);
  if (inc.tLog !== null) L.push(`- ${C.tLog}: ${inc.tLog.toFixed(1)} с`);
  L.push(`- ${C.after}: ${after.snap.source.fileName} №${after.snap.source.logIndex} (${after.snap.source.datetime}, ${after.snap.source.firmware})`);
  if (before) L.push(`- ${C.before}: ${before.snap.source.fileName} №${before.snap.source.logIndex} (${before.snap.source.datetime})`);
  if (inc.media) L.push(`- ${C.media}: ${inc.media}`);
  L.push('', `## ${C.pilotSays}`, '', inc.text || '—', '');
  if (before?.snap.plan) {
    L.push(`## ${C.advised}`, '');
    for (const a of before.snap.advice.filter((v) => v.selected && v.kind === 'tune')) {
      L.push(`- **${a.id} v${a.version}** — ${C.inputs}: ${Object.entries(a.inputs).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      for (const [k, v] of Object.entries(a.changes)) L.push(`  - \`${k}\`: ${a.from[k] ?? '—'} → ${v}`);
    }
    L.push('');
  }
  if (auto) {
    L.push(`## ${C.applied}`, '', C.planState[auto.plan.state] ?? '', '');
    for (const r of auto.plan.rules) L.push(`- ${r.rule}: ${C.planState[r.state]}`);
    if (auto.extraChanged.length) L.push('', `${C.extra}: ${auto.extraChanged.map((k) => `\`${k}\``).join(', ')}`);
    L.push('', `## ${C.comparable}`, '', `${C.overlap}: ${auto.comparability.thrOverlap.toFixed(0)} % (${auto.comparability.status})${auto.comparability.warnings.length ? ` — ${auto.comparability.warnings.join(', ')}` : ''}`, '');
    L.push(`## ${C.metrics}`, '', `| ${C.colMetric} | ${C.was} | ${C.pred} | ${C.now} | |`, '|---|---|---|---|---|');
    for (const r of auto.rows) L.push(`| ${C.metric[r.id] ?? r.id}${r.axis !== undefined ? `, ${AXIS_NAMES[r.axis]}` : ''} | ${fx(r.a, r.digits)} | ${r.pred !== undefined ? fx(r.pred, r.digits) : ''} | ${fx(r.b, r.digits)} | ${r.verdict} |`);
    if (auto.worstPrediction) L.push('', `${C.worstPred}: ${C.metric[auto.worstPrediction.id] ?? auto.worstPrediction.id} — ${auto.worstPrediction.errPct.toFixed(0)} %`);
    L.push('', `## ${C.findings}`, '');
    if (!auto.findings.length) L.push('—');
    for (const f of auto.findings) L.push(`- ${C.sign[f.sign]}${f.axis !== undefined ? ` (${AXIS_NAMES[f.axis]})` : ''}${f.hz !== undefined ? ` ${f.hz} Гц +${f.b} дБ` : f.a !== undefined ? `: ${fx(f.a, 2)} → ${fx(f.b ?? NaN, 2)}` : ''}${f.rules ? `: ${f.rules.join(', ')}` : ''}`);
    L.push('', `## ${C.suspects}`, '');
    if (!auto.suspects.length) L.push(C.noSuspects);
    for (const s of auto.suspects) L.push(`- **${s.rule}** (${C.score} ${s.score}): ${[...s.signs.map((g) => C.sign[g]), ...s.symptoms.map((y) => C.symptom[y])].join(', ') || '—'}`);
  }
  if (rollback?.length) L.push('', `## ${C.rollback}`, '', '```', ...rollback, '```');
  L.push('', `## ${C.howTo}`, '', C.howToText, '');
  return L.join('\n');
}

const fx = (v: number, d: number): string => (Number.isFinite(v) ? v.toFixed(d) : '—');
