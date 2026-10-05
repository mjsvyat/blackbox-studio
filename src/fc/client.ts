// Клиент полётника по MSP: чтение сведений, сводка/стирание/чтение флешки.
// Безопасность (ТЗ, раздел B):
//  - посылаются ТОЛЬКО команды из списков ниже; моторные (MSP_SET_MOTOR, DShot-команды,
//    passthrough, перезагрузка в загрузчик и т. п.) не посылаются никогда — их кодов здесь нет;
//  - любая запись (сейчас — только стирание флешки) — после свежей проверки «не заармлен»
//    (MSP_STATUS_EX, бит ARM) прямо перед командой; вызывается только по нажатию пользователя;
//  - неподдерживаемая прошивка (не Betaflight, API < 1.46) — ничего не пишем.
// Форматы ответов — по src/main/msp/msp.c BF 2026.6.1 (ссылки в PLAN.md).

import { MSP, MspFrame, MspParser, Reader, Writer, encodeV2 } from './msp';

/** канал до полётника: Web Serial в браузере, эмулятор в тестах */
export interface SerialLink {
  write(data: Uint8Array): Promise<void>;
  /** все входящие байты */
  onData(cb: (data: Uint8Array) => void): void;
  /** канал закрыт (кабель выдернут, перезагрузка полётника); слушателей может быть несколько */
  onClose(cb: (reason: string) => void): void;
  close(): Promise<void>;
}

/** команды чтения — безопасны всегда */
export const READ_CMDS = new Set<number>([MSP.API_VERSION, MSP.FC_VARIANT, MSP.FC_VERSION, MSP.BOARD_INFO, MSP.BUILD_INFO, MSP.NAME, MSP.STATUS_EX, MSP.UID, MSP.DATAFLASH_SUMMARY, MSP.DATAFLASH_READ]);
/** команды записи — только disarmed и только по кнопке */
export const WRITE_CMDS = new Set<number>([MSP.DATAFLASH_ERASE]);

export const MIN_API: [number, number] = [1, 46];

export class FcError extends Error {
  constructor(
    public code: 'timeout' | 'crc' | 'rejected' | 'closed' | 'armed' | 'unsupported' | 'forbidden' | 'aborted' | 'busy' | 'noflash',
    msg: string,
  ) {
    super(msg);
  }
}

export interface FcInfo {
  api: [number, number];
  variant: string;
  /** «2026.6.1» или «4.5.2» */
  version: string;
  versionText: string;
  boardId: string;
  targetName: string;
  boardName: string;
  manufacturerId: string;
  craftName: string;
  /** как DeviceUID в заголовке лога: %08x%08x%08x */
  uid: string;
  buildDate: string;
  gitRev: string;
}

export interface FcStatus {
  armed: boolean;
  /** причины, по которым арм сейчас запрещён (битовая маска armingDisableFlags) */
  armingDisableFlags: number;
  armingDisableCount: number;
  rebootRequired: boolean;
  cpuLoad: number;
  pidProfile: number;
  rateProfile: number;
  cycleTimeUs: number;
}

export interface FlashSummary {
  supported: boolean;
  ready: boolean;
  sectors: number;
  totalSize: number;
  usedSize: number;
}

export interface Compat {
  ok: boolean;
  /** причина отказа — для UI */
  why: 'variant' | 'api' | null;
}

export function checkCompat(info: Pick<FcInfo, 'variant' | 'api'>): Compat {
  if (info.variant !== 'BTFL') return { ok: false, why: 'variant' };
  const [a, b] = info.api;
  if (a < MIN_API[0] || (a === MIN_API[0] && b < MIN_API[1])) return { ok: false, why: 'api' };
  return { ok: true, why: null };
}

export interface RequestOpts {
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hex8 = (v: number): string => v.toString(16).padStart(8, '0');

export class FcClient {
  private parser: MspParser;
  private waiting: { cmd: number; resolve: (f: MspFrame) => void; reject: (e: FcError) => void } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed: string | null = null;
  /** счётчики для UI и тестов */
  stats = { crcErrors: 0, timeouts: 0, retries: 0, sent: [] as number[] };

  constructor(private link: SerialLink) {
    this.parser = new MspParser(
      (f) => this.frame(f),
      (kind) => {
        if (kind === 'crc') this.stats.crcErrors++;
        // битый ответ — ждущий запрос повторится по таймауту, но не ждём его зря
        if (this.waiting) {
          const w = this.waiting;
          this.waiting = null;
          w.reject(new FcError('crc', 'crc'));
        }
      },
    );
    link.onData((d) => this.parser.push(d));
    link.onClose((why) => {
      this.closed = why;
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w.reject(new FcError('closed', why));
      }
    });
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  private frame(f: MspFrame): void {
    if (f.dir === '<') return; // эхо своих команд (не бывает на USB, но на всякий случай)
    const w = this.waiting;
    if (!w || f.cmd !== w.cmd) return; // запоздалый ответ на прошлый (повторённый) запрос
    this.waiting = null;
    if (f.dir === '!') w.reject(new FcError('rejected', `MSP ${f.cmd}: команда не выполнена`));
    else w.resolve(f);
  }

  /** один обмен «запрос → ответ», запросы строго по очереди */
  private exchange(cmd: number, payload: Uint8Array, timeoutMs: number): Promise<MspFrame> {
    return new Promise<MspFrame>((resolve, reject) => {
      if (this.closed) return reject(new FcError('closed', this.closed));
      const t = setTimeout(() => {
        if (this.waiting?.cmd === cmd) {
          this.waiting = null;
          this.stats.timeouts++;
          reject(new FcError('timeout', `MSP ${cmd}: нет ответа за ${timeoutMs} мс`));
        }
      }, timeoutMs);
      this.waiting = {
        cmd,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
      this.stats.sent.push(cmd);
      this.link.write(encodeV2(cmd, payload)).catch((e) => {
        clearTimeout(t);
        this.waiting = null;
        reject(new FcError('closed', String(e)));
      });
    });
  }

  /** запрос с повтором при таймауте/битой контрольной сумме; только команды из списков */
  request(cmd: number, payload: Uint8Array = new Uint8Array(0), o: RequestOpts = {}): Promise<Uint8Array> {
    if (!READ_CMDS.has(cmd) && !WRITE_CMDS.has(cmd)) return Promise.reject(new FcError('forbidden', `MSP ${cmd} не входит в список разрешённых`));
    const run = async (): Promise<Uint8Array> => {
      const retries = o.retries ?? 2;
      for (let attempt = 0; ; attempt++) {
        try {
          // после сбоя — пауза и сброс разбора: хвост битого ответа не должен склеиться с новым
          if (attempt) {
            await sleep(20);
            this.parser.reset();
          }
          return (await this.exchange(cmd, payload, o.timeoutMs ?? 1000)).payload;
        } catch (e) {
          const err = e as FcError;
          // запись не повторяем вслепую: команда могла дойти
          if ((err.code !== 'timeout' && err.code !== 'crc') || attempt >= retries || WRITE_CMDS.has(cmd)) throw err;
          this.stats.retries++;
        }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async info(): Promise<FcInfo> {
    const api = new Reader(await this.request(MSP.API_VERSION));
    api.u8();
    const apiV: [number, number] = [api.u8(), api.u8()];
    const variant = new Reader(await this.request(MSP.FC_VARIANT)).str(4);
    const base = { api: apiV, variant };
    const empty: FcInfo = { ...base, version: '?', versionText: '', boardId: '', targetName: '', boardName: '', manufacturerId: '', craftName: '', uid: '', buildDate: '', gitRev: '' };
    // у чужой прошивки дальше ничего не спрашиваем
    if (!checkCompat(base).ok) return empty;
    const v = new Reader(await this.request(MSP.FC_VERSION));
    const [y, m, p] = [v.u8(), v.u8(), v.u8()];
    // с 2025.12 первая цифра — год с 2000 (FC_CALVER_BASE_YEAR), раньше — major (4.5.2)
    const version = y >= 25 ? `${2000 + y}.${m}.${p}` : `${y}.${m}.${p}`;
    const versionText = v.left ? v.pstr() : version;
    const bi = new Reader(await this.request(MSP.BOARD_INFO));
    const boardId = bi.str(4);
    bi.u16(); // hardware revision
    bi.u8(); // fc type
    bi.u8(); // capabilities
    const targetName = bi.pstr();
    const boardName = bi.pstr();
    const manufacturerId = bi.pstr();
    const craftName = String.fromCharCode(...(await this.request(MSP.NAME))).replace(/\0+$/, '');
    const u = new Reader(await this.request(MSP.UID));
    const uid = hex8(u.u32()) + hex8(u.u32()) + hex8(u.u32());
    const b = new Reader(await this.request(MSP.BUILD_INFO));
    const buildDate = `${b.str(11)} ${b.str(8)}`;
    const gitRev = b.str(7);
    return { ...base, version, versionText, boardId, targetName, boardName, manufacturerId, craftName, uid, buildDate, gitRev };
  }

  async status(): Promise<FcStatus> {
    const r = new Reader(await this.request(MSP.STATUS_EX));
    const cycleTimeUs = r.u16();
    r.u16(); // i2c errors
    r.u16(); // sensors
    // флаги режимов в порядке активных боксов; BOXARM = 0 активен всегда → бит 0 (msp_box.c)
    const modes = r.u32();
    const pidProfile = r.u8();
    const cpuLoad = r.u16() / 10;
    r.u8(); // число PID-профилей
    const rateProfile = r.u8();
    const extra = r.u8() & 0x0f;
    r.bytes(extra);
    const armingDisableCount = r.u8();
    const armingDisableFlags = r.u32();
    const rebootRequired = (r.u8() & 1) === 1;
    return { armed: (modes & 1) === 1, armingDisableFlags, armingDisableCount, rebootRequired, cpuLoad, pidProfile, rateProfile, cycleTimeUs };
  }

  async flashSummary(): Promise<FlashSummary> {
    const r = new Reader(await this.request(MSP.DATAFLASH_SUMMARY));
    const flags = r.u8();
    return { ready: (flags & 1) === 1, supported: (flags & 2) === 2, sectors: r.u32(), totalSize: r.u32(), usedSize: r.u32() };
  }

  /** свежая проверка перед записью: совместимость и «не заармлен» */
  async assertCanWrite(info: Pick<FcInfo, 'variant' | 'api'>): Promise<void> {
    if (!checkCompat(info).ok) throw new FcError('unsupported', 'unsupported');
    const st = await this.status();
    if (st.armed) throw new FcError('armed', 'armed');
  }

  /**
   * Стереть флешку. Полётник стирает асинхронно (flashfsEraseCompletely); пока стирает,
   * в сводке нет флага «готова». Опрос сводки до готовности или таймаута.
   */
  async eraseFlash(info: Pick<FcInfo, 'variant' | 'api'>, o: { onProgress?: (elapsedMs: number) => void; signal?: AbortSignal; timeoutMs?: number; pollMs?: number } = {}): Promise<{ elapsedMs: number; summary: FlashSummary }> {
    const s0 = await this.flashSummary();
    if (!s0.supported) throw new FcError('noflash', 'noflash');
    await this.assertCanWrite(info);
    const t0 = Date.now();
    await this.request(MSP.DATAFLASH_ERASE, new Uint8Array(0), { timeoutMs: 3000 });
    const timeout = o.timeoutMs ?? 180_000;
    for (;;) {
      // отмена прерывает только ожидание — само стирание в полётнике остановить нельзя
      if (o.signal?.aborted) throw new FcError('aborted', 'aborted');
      await sleep(o.pollMs ?? 500);
      const el = Date.now() - t0;
      o.onProgress?.(el);
      let s: FlashSummary;
      try {
        s = await this.flashSummary();
      } catch (e) {
        // во время стирания полётник может отвечать с задержкой — это не ошибка
        if ((e as FcError).code === 'timeout' || (e as FcError).code === 'crc') continue;
        throw e;
      }
      if (s.ready && s.usedSize === 0) return { elapsedMs: el, summary: s };
      if (el > timeout) throw new FcError('timeout', 'erase timeout');
    }
  }

  /**
   * Прочитать флешку [start, end) кусками до 4096 байт (выходной буфер полётника 4096 + 16),
   * без сжатия (флаг compression = 0). Битый/потерянный кусок — повтор того же адреса.
   */
  async readFlash(start: number, end: number, o: { chunk?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal; retries?: number; timeoutMs?: number } = {}): Promise<Uint8Array[]> {
    const parts: Uint8Array[] = [];
    const chunk = Math.min(o.chunk ?? 4096, 4096);
    let addr = start;
    while (addr < end) {
      if (o.signal?.aborted) throw new FcError('aborted', 'aborted');
      const want = Math.min(chunk, end - addr);
      const req = new Writer().u32(addr).u16(want).u8(0).done();
      let got: Uint8Array | null = null;
      for (let attempt = 0; got === null; attempt++) {
        const p = await this.request(MSP.DATAFLASH_READ, req, { timeoutMs: o.timeoutMs ?? 2000, retries: o.retries ?? 5 });
        const r = new Reader(p);
        const a = r.u32();
        const len = r.u16();
        const comp = r.u8();
        if (comp !== 0) throw new FcError('unsupported', 'compressed');
        if (a !== addr || r.left < len) {
          // ответ не на тот адрес (запоздалый) — спросить ещё раз
          if (attempt >= (o.retries ?? 5)) throw new FcError('crc', 'address mismatch');
          this.stats.retries++;
          continue;
        }
        got = r.bytes(len).slice();
      }
      if (!got.length) break; // конец тома
      parts.push(got);
      addr += got.length;
      o.onProgress?.(addr - start, end - start);
    }
    return parts;
  }

  async close(): Promise<void> {
    await this.link.close();
  }
}

/**
 * Имена флагов запрета арма (runtime_config.h, armingDisableFlags_e). Биты 0–24 одинаковы в 4.5.2
 * и 2026.6.1; последний бит (count − 1) — всегда ARM_SWITCH (в 4.5.2 это бит 25, в 2026.6.1 — 29).
 */
export const ARMING_DISABLE_NAMES = [
  'NO_GYRO', 'FAILSAFE', 'RX_FAILSAFE', 'NOT_DISARMED', 'BOXFAILSAFE', 'RUNAWAY_TAKEOFF', 'CRASH_DETECTED', 'THROTTLE',
  'ANGLE', 'BOOT_GRACE_TIME', 'NOPREARM', 'LOAD', 'CALIBRATING', 'CLI', 'CMS_MENU', 'BST', 'MSP', 'PARALYZE', 'GPS',
  'RESC', 'DSHOT_TELEM', 'REBOOT_REQUIRED', 'DSHOT_BITBANG', 'ACC_CALIBRATION', 'MOTOR_PROTOCOL', 'CRASHFLIP',
  'ALTHOLD', 'POSHOLD', 'AUTOPILOT', 'ARM_SWITCH',
];

export function armingDisableList(flags: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(count, 32); i++) if (flags & (1 << i)) out.push(i === count - 1 ? 'ARM_SWITCH' : ARMING_DISABLE_NAMES[i] ?? `bit${i}`);
  return out;
}
