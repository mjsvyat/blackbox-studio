// Полётник по USB: состояние вкладки и действия (подключение, стирание, скачивание флешки).
// Протокол — src/fc/. Здесь только связь с интерфейсом.

import { FcClient, FcError, FcInfo, SerialLink, checkCompat } from '../fc/client';
import { requestLink } from '../fc/webSerial';
import { T } from '../i18n/ru';
import { fmtBytes } from './dom';
import type { FcUi } from './fcState';
import { openFile, set, state } from './store';

let client: FcClient | null = null;
let downloaded: Blob | null = null;
let abort: AbortController | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

function upd(p: Partial<FcUi>): void {
  set({ fc: { ...state.fc, ...p } });
}

function errText(e: unknown): string {
  const c = e instanceof FcError ? e.code : null;
  if (c === 'timeout') return T.fc.timeout;
  if (c === 'closed') return T.fc.lost(e instanceof Error ? e.message : '');
  if (c === 'armed') return T.fc.eraseArmed;
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
