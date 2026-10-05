// Экспорт кампании одним файлом (A5): HTML-отчёт для чтения + все данные кампании в JSON внутри
// (<script type="application/json" id="bb-campaign">) — приложить к разбору в новой сессии Claude.
// Самодостаточный: стили внутри, никаких внешних ссылок (как report.ts).

import cfg from '../config/analysis.json';
import { Campaign, iterations } from '../campaigns/campaign';
import { Accuracy, Proposal, accuracy, historyEntry, proposeThresholds } from '../campaigns/learning';
import type { Incident } from '../incidents/incidents';
import { T } from '../i18n/ru';
import { cliValue } from '../params/registry';
import type { Project, SessionRecord } from '../sessions/db';

export const CAMPAIGN_FORMAT = 'blackbox-studio/campaign';
export const CAMPAIGN_EXPORT_VERSION = 1;

export interface CampaignExport {
  format: typeof CAMPAIGN_FORMAT;
  v: number;
  exportedAt: string;
  configVersion: string;
  cls: string;
  project: Pick<Project, 'id' | 'name' | 'uid' | 'craftName' | 'profile'>;
  campaign: Campaign;
  /** сессии кампании (полные снимки) */
  sessions: SessionRecord[];
  incidents: Incident[];
  accuracy: Accuracy;
  proposals: (Proposal & { history: Record<string, unknown> })[];
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fx = (v: number | null | undefined, d: number): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const when = (dt: string): string => (dt || '').slice(0, 16).replace('T', ' ');
const show = (v: number | string[]): string => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));
const mean = (v: number[]): number => { const f = v.filter(Number.isFinite); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN; };

const CSS = `body{font:14px/1.45 system-ui,sans-serif;color:#1d2330;background:#fff;max-width:1100px;margin:24px auto;padding:0 16px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}h3{font-size:15px;margin:14px 0 4px}
table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;font-size:13px;vertical-align:top}
th{color:#666;font-weight:600}.muted{color:#666;font-size:12px}.card{border:1px solid #ddd;border-left:4px solid #d4a017;border-radius:8px;padding:8px 12px;margin:8px 0}
.warn{color:#d1453b}.good{color:#2a9d4b}code,pre{background:#f4f5f7;border-radius:4px}pre{padding:8px;overflow:auto;font-size:12px}
@media (prefers-color-scheme:dark){body{background:#14171c;color:#dde2ea}code,pre{background:#222831}td,th{border-color:#2a303a}h2{border-color:#2a303a}.muted,th{color:#9aa3b0}}`;

/** собрать данные экспорта (то же, что видит вкладка «Кампания») */
export function campaignExport(c: Campaign, project: Project, sessions: SessionRecord[], incidents: Incident[], cls: string): CampaignExport {
  const own = sessions.filter((s) => s.projectId === c.projectId);
  const inCamp = own.filter((s) => c.sessionIds.includes(s.id));
  const incs = incidents.filter((i) => i.projectId === c.projectId);
  const title = c.title || T.camp.goals[c.goal];
  return {
    format: CAMPAIGN_FORMAT,
    v: CAMPAIGN_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    configVersion: cfg.version,
    cls,
    project: { id: project.id, name: project.name, uid: project.uid, craftName: project.craftName, profile: project.profile },
    campaign: c,
    sessions: inCamp,
    incidents: incs.filter((i) => c.sessionIds.includes(i.sessionId) || c.sessionIds.includes(i.beforeId ?? '')),
    accuracy: accuracy(inCamp, incs),
    proposals: proposeThresholds(c, own, incs, cls).map((p) => ({ ...p, history: historyEntry(p, title, cfg.version) })),
  };
}

/** JSON внутри <script>: «</script>» и «<!--» в строках не должны закрыть блок */
const scriptJson = (x: unknown): string => JSON.stringify(x).replace(/</g, '\\u003c');

export function campaignHtml(x: CampaignExport): string {
  const c = x.campaign;
  const L = T.learn;
  const title = L.repTitle(c.title || T.camp.goals[c.goal]);
  const its = iterations(c, x.sessions);
  const out: string[] = [];
  out.push(`<p>${esc(L.repBoard(x.project.name, x.cls, T.camp.goals[c.goal], its.length))}</p>`);
  if (c.notes) out.push(`<p>${esc(c.notes)}</p>`);

  // итерации
  out.push(`<h2>${L.repIters}</h2><table><tr><th>${L.colNo}</th><th>${L.colWhen}</th><th>${L.colProposed}</th><th>${L.colPlan}</th><th>${L.colOs}</th><th>${L.colDterm}</th><th>${L.colNoise}</th><th>${L.colTemp}</th><th>${L.colFeel}</th></tr>`);
  for (const it of its) {
    const s = it.session.snap;
    const os = mean((s.pid?.axes ?? []).slice(0, 2).map((a) => (a.enough ? a.overshootPct : NaN)));
    const dt = Math.max(...s.noise.axes.slice(0, 2).map((a) => a.rmsDterm ?? NaN));
    const nf = Math.max(...s.noise.axes.map((a) => a.rmsFilt));
    const prop = it.proposed ? `<code>${esc(it.proposed.rules.join(', '))}</code><br>${Object.entries(it.proposed.to).map(([k, v]) => `<code>set ${esc(k)} = ${esc(String(cliValue(k, v)))}</code>`).join('<br>')}` : '—';
    const t = it.mark?.motorTemp;
    out.push(`<tr><td>${it.n}</td><td>${esc(when(s.source.datetime))}<br><span class="muted">${esc(s.source.fileName)} №${s.source.logIndex}</span></td><td>${prop}</td><td>${it.applied ? esc(T.camp.planState[it.applied.state]) : '—'}</td><td>${fx(os, 0)}</td><td>${fx(dt, 1)}</td><td>${fx(nf, 2)}</td><td>${t === null || t === undefined ? '—' : esc(T.camp.temps[t])}</td><td>${esc(it.mark?.feel ?? '')}</td></tr>`);
  }
  out.push('</table>');

  // точность
  const A = x.accuracy;
  out.push(`<h2>${L.accTitle}</h2><p class="muted">${esc(L.accIntro)} ${esc(L.pairs(A.pairs))}</p>`);
  out.push(`<h3>${L.metricsTitle}</h3>`);
  out.push(A.metrics.length
    ? `<table><tr><th>${L.colMetric}</th><th>${L.colN}</th><th>${L.colHit}</th><th>${L.colErr}</th></tr>${A.metrics.map((m) => `<tr><td>${esc(T.ses.m[m.id] ?? m.id)}</td><td>${m.n}</td><td>${m.inBand} / ${m.n}</td><td>${fx(m.meanErrPct, 0)} %</td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(L.noPred)}</p>`);
  out.push(`<h3>${L.rulesTitle}</h3>`);
  out.push(A.rules.length
    ? `<table><tr><th>${L.colRule}</th><th>${L.colApplied}</th><th>${L.colBetter}</th><th>${L.colWorse}</th><th>${L.colSame}</th><th>${L.colInc}</th></tr>${A.rules.map((r) => `<tr><td><code>${esc(r.rule)}</code>${r.caution ? ` <span class="warn">${L.caution}</span>` : ''}</td><td>${r.applied}</td><td class="good">${r.better}</td><td class="warn">${r.worse}</td><td>${r.same}</td><td>${esc(r.incidents.join(', ') || '—')}</td></tr>`).join('')}</table>`
    : `<p class="muted">${esc(L.noRules)}</p>`);

  // предложения
  out.push(`<h2>${L.propTitle}</h2><p class="muted">${esc(L.propIntro)}</p>`);
  if (!x.proposals.length) out.push(`<p class="muted">${esc(L.propNone(cfg.learning.minEvidence))}</p>`);
  for (const p of x.proposals) out.push(proposalHtml(p));
  out.push(`<h3>${L.howTitle}</h3><ol>${L.how.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`);
  out.push(`<p class="muted">${esc(L.repJson)}</p>`);

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<h1>${esc(title)}</h1>
${out.join('\n')}
<p class="muted">${esc(L.repFooter(x.configVersion, when(x.exportedAt)))}</p>
<script type="application/json" id="bb-campaign">${scriptJson(x)}</script>
</body></html>`;
}

function evRow(e: Proposal['evidence'][number]): string {
  return `<tr><td>${esc(when(e.when))}</td><td>${esc(e.file)}</td><td>${fx(e.value, 1)}</td><td>${e.motorTemp === null ? '—' : esc(T.camp.temps[e.motorTemp] ?? '')}</td></tr>`;
}

function proposalHtml(p: CampaignExport['proposals'][number]): string {
  const L = T.learn;
  const t = L.prop[p.id];
  const why = p.id === 'rule-disable' ? t.why(p.evidence.length, p.rules[0]) : t.why(p.evidence.length, p.was as number, p.now as number);
  const tbl = (rows: Proposal['evidence']): string => `<table><tr><th>${L.colWhen}</th><th></th><th>${esc(t.value)}</th><th>${L.colTemp}</th></tr>${rows.map(evRow).join('')}</table>`;
  return `<div class="card"><b>${esc(t.title)}</b>
<p>${esc(why)}</p>
<div>${L.path}: <code>${esc(p.path)}</code> · ${esc(L.wasNow(show(p.was), show(p.now)))}</div>
<h3>${L.evidence}</h3>${tbl(p.evidence)}
<h3>${L.affected}</h3>${p.affected.length ? tbl(p.affected) : `<p class="muted">${L.affectedNone}</p>`}
<div class="muted">${L.rules}: ${esc(p.rules.join(', '))}${p.incidents.length ? ` · ${L.incidents}: ${esc(p.incidents.join(', '))}` : ''}</div>
<h3>${L.history}</h3><pre>${esc(JSON.stringify(p.history, null, 2))}</pre></div>`;
}

/** прочитать данные из экспортированного HTML (для тестов и будущего импорта) */
export function readCampaignHtml(html: string): CampaignExport | null {
  const m = /<script type="application\/json" id="bb-campaign">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  const x = JSON.parse(m[1]) as CampaignExport;
  return x.format === CAMPAIGN_FORMAT ? x : null;
}
