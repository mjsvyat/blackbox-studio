import './ui/styles.css';
import { T } from './i18n/ru';
import { clear, fmtTime, h } from './ui/dom';
import { helpBtn, openGlossary } from './ui/help';
import { AppState, exportReport, openFile, openLog, set, state, subscribe } from './ui/store';
import { fileView } from './ui/views/file';
import { flightView, motorsView } from './ui/views/flight';
import { noiseView } from './ui/views/noise';
import { summaryView } from './ui/views/summary';
import { filtersView } from './ui/views/filters';
import { ratesView } from './ui/views/rates';
import { pidView } from './ui/views/pid';
import { tuningView } from './ui/views/tuning';
import { sessionsView } from './ui/views/sessions';
import { fcView } from './ui/views/fc';
import { campaignView } from './ui/views/campaign';

const TABS: { id: string; title: string; stage?: number; needsLog: boolean; plan?: string[] }[] = [
  { id: 'file', title: T.tabs.file, needsLog: false },
  { id: 'summary', title: T.tabs.summary, needsLog: true },
  { id: 'noise', title: T.tabs.noise, needsLog: true },
  { id: 'filters', title: T.tabs.filters, needsLog: true },
  { id: 'pid', title: T.tabs.pid, needsLog: true },
  { id: 'rates', title: T.tabs.rates, needsLog: true },
  { id: 'motors', title: T.tabs.motors, needsLog: true },
  { id: 'flight', title: T.tabs.flight, needsLog: true },
  { id: 'tuning', title: T.tabs.tuning, needsLog: true },
  { id: 'compare', title: T.tabs.compare, needsLog: false },
  { id: 'campaign', title: T.tabs.campaign, needsLog: false },
  { id: 'fc', title: T.tabs.fc, needsLog: false },
];

const app = document.getElementById('app')!;
const main = h('main');
const progressBar = h('div', { class: 'progress' }, h('div', { style: 'width:0' }));
const progressLabel = h('div', { class: 'progress-label', style: 'display:none' });
const fileInput = h('input', { type: 'file', accept: '.bbl,.bfl,.txt,.BBL,.BFL,.TXT', style: 'display:none' }) as HTMLInputElement;
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) openFile(f);
  fileInput.value = '';
});

// тема
const savedTheme = (() => { try { return localStorage.getItem('bb-theme'); } catch { return null; } })();
document.documentElement.dataset.theme = savedTheme === 'light' ? 'light' : 'dark';
function toggleTheme(): void {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('bb-theme', t); } catch { /* приватный режим */ }
  render(); // графики берут цвета из CSS-переменных при построении
}

const topbar = h('div', { class: 'topbar' });
const tabsBar = h('nav', { class: 'tabs' });
app.append(progressBar, progressLabel, topbar, tabsBar, main, fileInput);

function renderTopbar(): void {
  clear(topbar);
  const st = state.structure;
  const usable = st ? st.logs.filter((l) => l.duplicateOf === null && l.headerOk) : [];
  const sel = usable.length > 1
    ? h('select', { class: 'btn', onchange: (e: Event) => openLog(Number((e.target as HTMLSelectElement).value)) },
        h('option', { value: '', disabled: true, selected: !state.info }, '— лог —'),
        usable.map((l) => h('option', { value: l.index, selected: state.info?.index === l.index },
          `№${l.index} · ${l.datetime.slice(0, 16).replace('T', ' ')} · ${l.durationS !== null ? fmtTime(l.durationS) : '?'}${l.empty ? ' (пустой)' : ''}`)))
    : null;
  topbar.append(
    h('h1', null, T.appTitle),
    h('button', { class: 'btn primary', onclick: () => fileInput.click() }, T.openFile),
    h('span', { class: 'file-name' }, state.fileName ?? T.noFile),
    sel ?? "",
    h('span', { class: 'spacer' }),
    h('button', { class: `btn small ${state.fc.phase === 'connected' ? 'primary' : ''}`, onclick: () => set({ tab: 'fc' }) }, T.fc.open),
    state.info ? h('button', { class: 'btn small', onclick: () => exportReport() }, T.rep.button) : '',
    h('button', { class: 'btn small', onclick: openGlossary }, T.help.glossary),
    h('button', { class: 'btn small', onclick: toggleTheme }, document.documentElement.dataset.theme === 'dark' ? T.themeLight : T.themeDark),
  );
}

function renderTabs(): void {
  clear(tabsBar);
  if (!state.structure) return;
  for (const t of TABS) {
    const disabled = t.needsLog && !state.info;
    tabsBar.append(h('button', {
      class: `tab ${state.tab === t.id ? 'active' : ''} ${t.stage ? 'later' : ''}`,
      disabled,
      title: t.stage ? T.stageLater(t.stage) : '',
      onclick: () => set({ tab: t.id }),
    }, t.title));
  }
}

let disposers: (() => void)[] = [];
const track = (d: () => void): void => { disposers.push(d); };

function render(): void {
  disposers.forEach((d) => d());
  disposers = [];
  renderTopbar();
  renderTabs();
  clear(main);
  if (state.error) main.append(h('div', { class: 'panel bad' }, h('b', null, 'Ошибка: '), state.error));
  if (!state.structure) {
    // сохранённые сессии можно смотреть и без открытого файла
    if (state.tab === 'compare') main.append(sessionsView(track));
    else if (state.tab === 'fc') main.append(fcView());
    else if (state.tab === 'campaign') main.append(campaignView(track));
    else main.append(dropZone());
    return;
  }
  const tab = TABS.find((t) => t.id === state.tab) ?? TABS[0];
  if (tab.needsLog && !state.info) {
    main.append(fileView(render));
    return;
  }
  switch (tab.id) {
    case 'file': main.append(fileView(render)); break;
    case 'summary': main.append(summaryView()); break;
    case 'noise': main.append(noiseView(track)); break;
    case 'filters': main.append(filtersView(track)); break;
    case 'rates': main.append(ratesView(track)); break;
    case 'pid': main.append(pidView(track)); break;
    case 'tuning': main.append(tuningView()); break;
    case 'compare': main.append(sessionsView(track)); break;
    case 'flight': main.append(flightView(track)); break;
    case 'motors': main.append(motorsView(track)); break;
    case 'fc': main.append(fcView()); break;
    case 'campaign': main.append(campaignView(track)); break;
    default:
      main.append(h('div', { class: 'placeholder' },
        h('h2', { style: 'justify-content:center' }, tab.title, helpBtn(`card-${tab.id === 'filters' ? 'filters' : 'pid'}`)),
        h('p', null, T.stageLater(tab.stage ?? 0), '. Что здесь будет:'),
        h('ul', null, (tab.plan ?? []).map((p) => h('li', null, p)))));
  }
}

function dropZone(): HTMLElement {
  const z = h('div', { class: 'drop' },
    h('h2', { style: 'justify-content:center' }, T.appTitle),
    h('p', null, T.dropHint),
    h('button', { class: 'btn primary', onclick: () => fileInput.click() }, T.openFile),
    h('div', { class: 'row', style: 'margin-top:12px;justify-content:center' },
      h('button', { class: 'btn small', onclick: () => set({ tab: 'compare' }) }, T.ses.title),
      h('button', { class: 'btn small', onclick: () => set({ tab: 'campaign' }) }, T.camp.title),
      h('button', { class: 'btn small', onclick: () => set({ tab: 'fc' }) }, T.fc.open)));
  return z;
}

// перетаскивание файла на всё окно
window.addEventListener('dragover', (e) => { e.preventDefault(); document.querySelector('.drop')?.classList.add('over'); });
window.addEventListener('dragleave', () => document.querySelector('.drop')?.classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

function renderProgress(): void {
  const p = state.progress;
  const bar = progressBar.firstElementChild as HTMLElement;
  if (!p) {
    bar.style.width = '0';
    progressLabel.style.display = 'none';
    return;
  }
  bar.style.width = `${Math.round(p.fraction * 100)}%`;
  progressLabel.style.display = 'block';
  progressLabel.textContent = `${p.stage || T.loading} · ${Math.round(p.fraction * 100)} %`;
}

const RERENDER: (keyof AppState)[] = ['structure', 'info', 'analysis', 'tab', 'noiseAxis', 'noiseSource', 'error', 'fileName', 'filters', 'filterAxis', 'rates', 'ratesWhy', 'pid', 'advice', 'projects', 'sessions', 'dbPersistent', 'cmpA', 'cmpB', 'cmpAxis', 'sessionsBusy', 'sessionsMsg', 'incidents', 'incidentForm', 'rollbackFor', 'fc', 'boardAsk', 'campaigns', 'campaignId', 'openSnap', 'videoTick'];
subscribe((_s, changed) => {
  if (changed.has('progress')) renderProgress();
  if (RERENDER.some((k) => changed.has(k))) {
    // смена диапазона анализа не должна сбрасывать прокрутку на графиках
    const y = window.scrollY;
    render();
    if (changed.size === 1 && changed.has('analysis')) window.scrollTo(0, y);
  }
});

render();

// Только dev-сервер: эмулятор полётника для проверки вкладки «Полётник» без железа
// (`await __bbFakeFc({ usedSize: … })` в консоли). В сборку dist не попадает.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__bbFakeFc = async (o: Record<string, unknown> = {}) => {
    const { FakeFc } = await import('./fc/emulator');
    const { fcConnect, fcPrepare, setReopenForDev } = await import('./ui/fcStore');
    (window as unknown as Record<string, unknown>).__bbFcPrepare = fcPrepare;
    let fc = new FakeFc({ delayMs: 2, eraseMs: 3000, ...o });
    // «перезагрузка»: новый эмулятор с сохранёнными настройками старого
    setReopenForDev(async () => {
      if (!fc.closed) return null;
      fc = new FakeFc({ delayMs: 2, eraseMs: 3000, ...o, cli: fc.saved, armingDisableFlags: 0 });
      (window as unknown as Record<string, unknown>).__fc = fc;
      return Object.assign(fc, { info: 'эмулятор' });
    });
    set({ tab: 'fc' });
    await fcConnect(Object.assign(fc, { info: 'эмулятор' }));
    return fc;
  };
}
