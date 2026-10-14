// Полётник по USB: состояние вкладки и действия (подключение, стирание, скачивание флешки).
// Протокол — src/fc/. Здесь только связь с интерфейсом.

import { loggingSetup } from '../fc/logging';
import { FcClient, FcError, FcInfo, SerialLink, checkCompat, expectedOf, readValues, rollbackLines, verifyValues } from '../fc/client';
import { reopenLink, requestLink } from '../fc/webSerial';
import { T } from '../i18n/ru';
import { fmtBytes } from './dom';
import type { FcUi } from './fcState';
import { openFile, recordFcWrite, set, state } from './store';

let client: FcClient | null = null;
let downloaded: Blob | null = null;
let abort: AbortController | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
/** ждём перезагрузку полётника (после save / exit) — обрыв USB ожидаем, переподключаемся сами */
let expectReboot = false;
/** после записи и перезагрузки — сверить значения на борту с записанными */
let verifyAfter: { expected: Record<string, string>; kind: 'apply' | 'rollback' } | null = null;

function upd(p: Partial<FcUi>): void {
  set({ fc: { ...state.fc, ...p } });
}

function errText(e: unknown): string {
  const c = e instanceof FcError ? e.code : null;
  if (c === 'timeout') return T.fc.timeout;
  if (c === 'closed') return T.fc.lost(e instanceof Error ? e.message : '');
  if (c === 'armed') return T.fc.eraseArmed;
  if (c === 'battery') return T.fc.battery;
  if (c === 'aborted') return T.fc.aborted;
  if (e instanceof DOMException && e.name === 'SecurityError') return T.fc.securityError;
  return T.fc.error(e instanceof Error ? e.message : String(e));
}

/** подключение — только по нажатию (выбор порта требует жеста пользователя) */
export async function fcConnect(link?: SerialLink & { info?: string }): Promise<void> {
  if (state.fc.phase !== 'idle') return;
  upd({ phase: 'connecting', msg: null });
  let l: SerialLink & { info?: string };
  try {
    l = link ?? (await requestLink());
  } catch (e) {
    const none = e instanceof DOMException && e.name === 'NotFoundError';
    upd({ phase: 'idle', msg: { kind: none ? 'warn' : 'bad', text: none ? T.fc.noPort : errText(e) } });
    return;
  }
  client = new FcClient(l);
  l.onClose((why) => {
    // перехватываем закрытие поверх клиента: и клиент, и интерфейс узнают об обрыве
    if (state.fc.phase === 'idle') return;
    stopPoll();
    client = null;
    if (expectReboot) {
      expectReboot = false;
      upd({ phase: 'idle', status: null });
      void autoReconnect();
      return;
    }
    upd({ phase: 'idle', busy: null, status: null, msg: { kind: 'bad', text: T.fc.lost(why) } });
  });
  try {
    const info = await client.info();
    const compat = checkCompat(info);
    upd({ phase: 'connected', linkInfo: l.info ?? '', info, compat, propsOk: false, retries: 0 });
    if (compat.ok) {
      await fcRefresh();
      startPoll();
    }
  } catch (e) {
    await fcDisconnect();
    upd({ msg: { kind: 'bad', text: errText(e) } });
  }
}

export async function fcDisconnect(): Promise<void> {
  stopPoll();
  abort?.abort();
  const c = client;
  client = null;
  upd({ phase: 'idle', busy: null, status: null, flash: null, info: null, compat: null });
  try {
    await c?.close();
  } catch {
    /* уже закрыт */
  }
}

export async function fcRefresh(): Promise<void> {
  if (!client || state.fc.busy) return;
  try {
    const [status, flash] = [await client.status(), await client.flashSummary()];
    upd({ status, flash });
  } catch (e) {
    upd({ msg: { kind: 'bad', text: errText(e) } });
  }
}

/** опрос «заармлен ли» раз в секунду; перерисовка — только если что-то поменялось */
function startPoll(): void {
  stopPoll();
  poll = setInterval(async () => {
    if (!client || state.fc.busy) return;
    try {
      const st = await client.status();
      const old = state.fc.status;
      if (!old || old.armed !== st.armed || old.armingDisableFlags !== st.armingDisableFlags || old.rebootRequired !== st.rebootRequired) upd({ status: st });
    } catch {
      /* обрыв поймает onClose */
    }
  }, 1000);
}

function stopPoll(): void {
  if (poll) clearInterval(poll);
  poll = null;
}

export function fcPropsOk(): void {
  upd({ propsOk: true });
}

const eraseKey = (uid: string): string => `bb-fc-erased-${uid}`;

export function lastErase(uid: string): number | null {
  try {
    const v = localStorage.getItem(eraseKey(uid));
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export async function fcErase(): Promise<void> {
  const fc = state.fc;
  if (!client || !fc.info || fc.busy || !fc.propsOk) return;
  // подтверждение — явное, с размером того, что пропадёт
  if (!confirm(T.fc.eraseQ(fmtBytes(fc.flash?.usedSize ?? 0)))) return;
  abort = new AbortController();
  upd({ busy: { kind: 'erase', done: 0, total: 0, t0: Date.now() }, msg: null, retries: 0 });
  try {
    const r = await client.eraseFlash(fc.info, { signal: abort.signal, onProgress: (ms) => upd({ busy: { kind: 'erase', done: ms, total: 0, t0: Date.now() - ms } }) });
    try {
      localStorage.setItem(eraseKey(fc.info.uid), String(Date.now()));
    } catch {
      /* приватный режим */
    }
    upd({ busy: null, flash: r.summary, msg: { kind: 'ok', text: T.fc.erased(r.elapsedMs / 1000) } });
  } catch (e) {
    const timeout = e instanceof FcError && e.code === 'timeout';
    upd({ busy: null, msg: { kind: 'bad', text: timeout ? T.fc.eraseTimeout : errText(e) } });
  }
  void fcRefresh();
}

function fileName(info: FcInfo): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const who = (info.craftName || info.boardName || 'blackbox').replace(/[^\w.-]+/g, '_');
  return `${who}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.bbl`;
}

export async function fcDownload(all: boolean): Promise<void> {
  const fc = state.fc;
  if (!client || !fc.info || !fc.flash || fc.busy) return;
  const end = all ? fc.flash.totalSize : fc.flash.usedSize;
  if (!end) {
    upd({ msg: { kind: 'warn', text: T.fc.emptyFlash } });
    return;
  }
  abort = new AbortController();
  const t0 = Date.now();
  const r0 = client.stats.retries;
  let last = 0;
  upd({ busy: { kind: 'download', done: 0, total: end, t0 }, msg: null });
  try {
    const parts = await client.readFlash(0, end, {
      signal: abort.signal,
      onProgress: (done, total) => {
        // перерисовка не чаще 4 раз в секунду
        const now = Date.now();
        if (now - last < 250 && done < total) return;
        last = now;
        upd({ busy: { kind: 'download', done, total, t0 }, retries: client ? client.stats.retries - r0 : 0 });
      },
    });
    downloaded = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
    const name = fileName(fc.info);
    upd({ busy: null, download: { name, size: downloaded.size }, msg: { kind: 'ok', text: T.fc.downloaded(fmtBytes(downloaded.size), (Date.now() - t0) / 1000) } });
    fcOpenDownloaded();
  } catch (e) {
    upd({ busy: null, msg: { kind: e instanceof FcError && e.code === 'aborted' ? 'warn' : 'bad', text: errText(e) } });
  }
}

export function fcCancel(): void {
  abort?.abort();
}

export function fcOpenDownloaded(): void {
  const d = state.fc.download;
  if (!downloaded || !d) return;
  openFile(new File([downloaded], d.name, { type: 'application/octet-stream' }));
  set({ tab: 'file' });
}

/** сохранить копию: File System Access API (Chrome/Edge) или обычное скачивание */
export async function fcSaveDownloaded(): Promise<void> {
  const d = state.fc.download;
  if (!downloaded || !d) return;
  const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }> };
  try {
    if (w.showSaveFilePicker) {
      const fh = await w.showSaveFilePicker({ suggestedName: d.name, types: [{ description: 'Blackbox', accept: { 'application/octet-stream': ['.bbl'] } }] });
      const ws = await fh.createWritable();
      await ws.write(downloaded);
      await ws.close();
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(downloaded);
      a.download = d.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
    upd({ msg: { kind: 'ok', text: T.fc.saved(d.name) } });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    upd({ msg: { kind: 'bad', text: errText(e) } });
  }
}

// ---------------- B4–B5: настройки с борта, применение, откат ----------------

/** код версии как в decoder/header (2026.6.1 → 2026006001, 4.5.2 → 4005002) */
export function fwCodeOf(version: string): number {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
}

/** только dev: эмулятор вместо Web Serial при переподключении */
let reopen: () => Promise<(SerialLink & { info?: string }) | null> = reopenLink;
export function setReopenForDev(f: typeof reopen): void {
  reopen = f;
}

/** после перезагрузки полётника USB появляется снова через 1–3 с — подключаемся к тому же порту */
async function autoReconnect(): Promise<void> {
  upd({ busy: { kind: 'reconnect', done: 0, total: 0, t0: Date.now() } });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (state.fc.phase !== 'idle') return;
    let l: (SerialLink & { info?: string }) | null = null;
    try {
      l = await reopen();
    } catch {
      l = null;
    }
    if (l) {
      const keep = { settings: state.fc.settings, lastApply: state.fc.lastApply, pending: state.fc.pending, applyRows: state.fc.applyRows, msg: state.fc.msg, propsOk: state.fc.propsOk };
      upd({ busy: null });
      await fcConnect(l);
      upd({ ...keep, propsOk: keep.propsOk });
      if (verifyAfter && (state.fc.phase as string) === 'connected') await fcVerify();
      return;
    }
  }
  upd({ busy: null, msg: { kind: 'warn', text: T.fc.reconnectFail } });
}

export async function fcReadSettings(): Promise<void> {
  const fc = state.fc;
  if (!client || !fc.info || fc.busy) return;
  upd({ busy: { kind: 'settings', done: 0, total: 0, t0: Date.now() }, msg: null });
  stopPoll();
  try {
    // 4.5 выходит из CLI только перезагрузкой
    expectReboot = !(fc.info.api[1] >= 47 || fc.info.api[0] > 1);
    const s = await client.readSettings(fc.info);
    const { dump: _dump, ...lite } = s;
    void _dump;
    upd({ busy: null, settings: lite, msg: { kind: 'ok', text: s.rebooted ? T.fc.readRebooted : T.fc.readOk } });
    if (!s.rebooted) {
      expectReboot = false;
      startPoll();
      void fcRefresh();
    }
  } catch (e) {
    expectReboot = false;
    upd({ busy: null, msg: { kind: 'bad', text: errText(e) } });
    if (client) startPoll();
  }
}

/**
 * Из советчика / примерки: «на борт по USB» — показать во вкладке «Полётник». Берутся только
 * параметры, которые меняются относительно лога (from): остальное на борту не трогаем, даже если
 * после полёта его уже поменяли.
 */
/**
 * Подготовить борт к записи лога (как автонастройка у fpvpidtune.com): частота записи ≥ 1.6 кГц
 * (доля циклов PID по текущему циклу), до 4.5 — debug_mode = GYRO_SCALED (гиро до фильтров).
 * Показывается как обычное «применить» — запись по кнопке, откат вернёт как было.
 */
export function fcPrepareLogging(): void {
  const fc = state.fc;
  if (!fc.info || !fc.status) return;
  set({ fc: { ...fc, pending: { to: loggingSetup(fwCodeOf(fc.info.version), fc.status.cycleTimeUs), source: 'logging' }, applyRows: [] } });
}


export function fcPrepare(from: Record<string, number>, to: Record<string, number>, source: string): void {
  const ch: Record<string, number> = {};
  for (const [k, v] of Object.entries(to)) if (from[k] !== v) ch[k] = v;
  upd({ pending: { to: ch, source }, applyRows: [] });
  set({ tab: 'fc' });
}

export function fcDropPending(): void {
  upd({ pending: null, applyRows: [] });
}

export function fcDownloadBackup(text: string, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text.replace(/\r\n/g, '\n')], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** записать строки set … на борт (только по кнопке; подтверждение — здесь) */
export async function fcApply(lines: string[], kind: 'apply' | 'rollback', source: string): Promise<void> {
  const fc = state.fc;
  if (!client || !fc.info || fc.busy || !fc.propsOk || !lines.length) return;
  if (!confirm(kind === 'apply' ? T.fc.applyQ(lines.join('\n')) : T.fc.rollbackQ(lines.join('\n')))) return;
  stopPoll();
  upd({ busy: { kind: 'apply', done: 0, total: lines.length, t0: Date.now() }, applyRows: [], msg: null });
  const rows: { line: string; ok: boolean; error?: string }[] = [];
  try {
    expectReboot = true;
    const r = await client.applySets(fc.info, lines, (i, row) => {
      rows.push(row);
      upd({ applyRows: [...rows], busy: { kind: 'apply', done: i + 1, total: lines.length, t0: fc.busy?.t0 ?? Date.now() } });
    });
    if (r.ok) verifyAfter = { expected: expectedOf(lines), kind };
    const saved = await recordFcWrite(fc.info.uid, { at: r.at, kind, source, ok: r.ok, lines, diffAll: r.diffAll, before: r.before, error: r.error });
    upd({
      busy: null,
      lastApply: r.ok ? r : state.fc.lastApply,
      pending: r.ok && kind === 'apply' ? null : state.fc.pending,
      settings: null,
      msg: r.ok ? { kind: 'ok', text: (kind === 'apply' ? T.fc.applied : T.fc.rolledBack) + (saved ? '' : ` ${T.fc.notLogged}`) } : { kind: 'bad', text: T.fc.applyFailed(r.error ?? '') },
    });
  } catch (e) {
    expectReboot = false;
    upd({ busy: null, msg: { kind: 'bad', text: errText(e) } });
  }
}

/**
 * Сверка после записи (как «Applied and checked» у fpvpidtune.com): после перезагрузки читаем
 * записанные параметры и сравниваем. Расхождение — красное сообщение и кнопка «Откатить»
 * (сами не пишем: любая запись — только по нажатию пользователя).
 */
async function fcVerify(): Promise<void> {
  const v = verifyAfter;
  verifyAfter = null;
  const fc = state.fc;
  if (!v || !client || !fc.info) return;
  stopPoll();
  upd({ busy: { kind: 'settings', done: 0, total: 0, t0: Date.now() } });
  try {
    expectReboot = !(fc.info.api[1] >= 47 || fc.info.api[0] > 1);
    const { values, rebooted } = await readValues(client, fc.info, Object.keys(v.expected));
    const bad = verifyValues(v.expected, values);
    upd({ busy: null, verified: { at: new Date().toISOString(), ok: !bad.length, bad }, msg: bad.length ? { kind: 'bad', text: T.fc.verifyBad(bad.map((b) => `${b.name}: ${b.got ?? '—'} ≠ ${b.want}`).join(', ')) } : { kind: 'ok', text: T.fc.verifyOk(Object.keys(v.expected).length) } });
    if (!rebooted) {
      expectReboot = false;
      startPoll();
    }
  } catch (e) {
    expectReboot = false;
    upd({ busy: null, msg: { kind: 'warn', text: T.fc.verifyFail(errText(e)) } });
    if (client) startPoll();
  }
}

export function fcRollback(): void {
  const r = state.fc.lastApply;
  if (r) void fcApply(rollbackLines(r), 'rollback', 'rollback');
}
