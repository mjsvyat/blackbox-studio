// Отчёт в один HTML-файл (стили и графики внутри, без интернета): по снимку сессии —
// открытого лога или сохранённой; с блоком сравнения, если дана пара «было / стало».

import cfg from '../config/analysis.json';
import { AXIS_NAMES, T } from '../i18n/ru';
import { cliDiff, cliValue } from '../params/registry';
import { MetricRow, metricRows, planCheck } from '../sessions/compare';
import type { SessionSnapshot } from '../sessions/snapshot';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fx = (v: number | null | undefined, d: number): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const COLORS: Record<string, string> = { green: '#2a9d4b', yellow: '#d4a017', red: '#d1453b', grey: '#999' };
const KEY_PARAMS = ['rates_type', 'p_roll', 'i_roll', 'd_roll', 'f_roll', 'p_pitch', 'i_pitch', 'd_pitch', 'f_pitch', 'simplified_master_multiplier', 'simplified_gyro_filter_multiplier', 'simplified_dterm_filter_multiplier', 'dyn_notch_count', 'dyn_notch_min_hz', 'dyn_notch_max_hz', 'rpm_filter_harmonics', 'rpm_filter_q', 'gyro_lpf1_dyn_min_hz', 'gyro_lpf2_static_hz', 'dterm_lpf1_static_hz', 'dterm_lpf2_static_hz'];

const CSS = `body{font:14px/1.45 system-ui,sans-serif;color:#1d2330;background:#fff;max-width:1000px;margin:24px auto;padding:0 16px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;font-size:13px}
th{color:#666;font-weight:600}.muted{color:#666;font-size:12px}.card{border:1px solid #ddd;border-top:4px solid;border-radius:8px;padding:8px 10px;margin:6px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}code,pre{background:#f4f5f7;border-radius:4px}pre{padding:8px;overflow:auto}
img{max-width:100%;border:1px solid #eee;border-radius:6px;margin:4px 0}.badge{font-size:11px;border:1px solid #ccc;border-radius:4px;padding:0 5px;margin-left:6px}
@media print{h2{break-after:avoid}img{break-inside:avoid}}`;

function header(s: SessionSnapshot): string {
  const src = s.source;
  return `<p>${T.rep.source}: <b>${esc(src.fileName)} №${src.logIndex}</b> · ${esc(src.datetime.slice(0, 19).replace('T', ' '))} · ${esc(src.firmware)} · ${esc(src.board)}<br>
${T.rep.flight}: ${fx(s.flight.seconds, 0)} с из ${fx(src.durationS, 0)} с · лог ${fx(src.fs, 0)} Гц</p>`;
}

function body(s: SessionSnapshot, images: Record<string, string>): string {
  const out: string[] = [];
  out.push(`<h2>${T.rep.cards}</h2><div class="grid">${s.cards.map((c) => `<div class="card" style="border-top-color:${COLORS[c.status] ?? '#999'}"><b>${esc(T.card[c.id as keyof typeof T.card] ?? c.id)}</b> <span class="muted">${esc(T.status[c.status] ?? '')}</span><div>${esc(c.phrase)}</div></div>`).join('')}</div>`);
  out.push(`<h2>${T.rep.noise}</h2><table><tr><th>${T.rep.colAxis}</th><th>${T.rep.colUnfilt}</th><th>${T.rep.colFilt}</th><th>${T.rep.colD}</th></tr>${s.noise.axes.map((a, i) => `<tr><td>${AXIS_NAMES[i]}</td><td>${fx(a.rmsUnfilt, 1)}</td><td>${fx(a.rmsFilt, 2)}</td><td>${fx(a.rmsDterm, 1)}</td></tr>`).join('')}</table>`);
  if (s.filters) out.push(`<h2>${T.rep.filters}</h2><p>${esc(T.rep.filtersLine(s.filters.delay100, s.filters.delayD100, s.filters.match.map((m) => `${fx(m, 0)} %`).join(' / ')))}</p>`);
  if (s.pid) out.push(`<h2>${T.rep.pid}</h2><table><tr><th>${T.rep.colAxis}</th><th>${T.rep.colOs}</th><th>${T.rep.colDelay}</th><th>${T.rep.colSettle}</th><th>${T.rep.colTrust}</th></tr>${s.pid.axes.map((a, i) => `<tr><td>${AXIS_NAMES[i]}</td><td>${fx(a.overshootPct, 0)}</td><td>${fx(a.delayMs, 1)}</td><td>${fx(a.settle, 2)}</td><td>${a.enough ? T.rep.trustOk : T.rep.trustLow}</td></tr>`).join('')}</table>`);
  out.push(`<h2>${T.rep.advice}</h2>`);
  if (!s.advice.length) out.push(`<p>${T.rep.noAdvice}</p>`);
  for (const a of s.advice) {
    const t = T.adv.rules[a.id];
    out.push(`<div class="card" style="border-top-color:${COLORS[a.severity === 'info' ? 'grey' : a.severity]}"><b>${esc(t?.title ?? a.id)}</b><span class="badge">${a.id} v${a.version}</span>${a.selected && a.kind === 'tune' ? `<span class="badge">${T.rep.selected}</span>` : ''}
<div>${esc(t ? t.seen(a.inputs) : '')}</div><div class="muted">${esc(t ? t.change(a.inputs) : '')}</div>
${Object.keys(a.changes).length ? `<div class="muted">${Object.entries(a.changes).map(([k, v]) => `<code>${k}</code> ${a.from[k] !== undefined ? cliValue(k, a.from[k]) : '—'} → <b>${cliValue(k, v)}</b>`).join(', ')}</div>` : ''}</div>`);
  }
  if (s.plan) {
    const cli = cliDiff(s.plan.from, s.plan.to, s.source.fwCode);
    out.push(`<h3>${T.rep.plan}</h3><pre>${esc(cli.lines.join('\n'))}</pre>`);
  }
  out.push(`<h2>${T.rep.settings}</h2><table>${KEY_PARAMS.filter((k) => s.cli[k] !== undefined).map((k) => `<tr><td><code>${k}</code></td><td>${cliValue(k, s.cli[k])}</td></tr>`).join('')}</table>`);
  const imgs = Object.entries(images);
  if (imgs.length) out.push(`<h2>${T.rep.plots}</h2>${imgs.map(([k, v]) => `<img alt="${esc(k)}" src="${v}">`).join('')}`);
  return out.join('\n');
}

function compareBlock(a: SessionSnapshot, b: SessionSnapshot): string {
  const rows: MetricRow[] = metricRows(a, b);
  const pc = planCheck(a, b);
  const v = (r: MetricRow): string => T.ses.verdict[r.verdict] ?? '';
  return `<h2>${T.rep.compareTitle}</h2><p>${esc(T.ses.planAll[pc.state] ?? '')}</p>
<table><tr><th>${T.ses.colMetric}</th><th>${T.ses.was}</th><th>${T.ses.pred}</th><th>${T.ses.now}</th><th></th></tr>
${rows.map((r) => `<tr><td>${esc(T.ses.m[r.id] ?? r.id)}${r.axis !== undefined ? `, ${AXIS_NAMES[r.axis]}` : ''}</td><td>${fx(r.a, r.digits)}</td><td><i>${r.pred !== undefined ? fx(r.pred, r.digits) : ''}</i></td><td><b>${fx(r.b, r.digits)}</b></td><td>${v(r)}</td></tr>`).join('')}</table>`;
}

export function reportHtml(s: SessionSnapshot, images: Record<string, string>, before?: SessionSnapshot): string {
  const title = T.rep.title(s.source.craft || s.source.board);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<h1>${esc(title)}</h1>${header(s)}
${before ? compareBlock(before, s) : ''}
${body(s, images)}
<p class="muted">${esc(T.rep.footer(cfg.version))}</p></body></html>`;
}
