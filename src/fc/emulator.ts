// Эмулятор полётника Betaflight для тестов: фейковый последовательный порт, отвечающий как
// msp.c BF 2026.6.1 (форматы ответов — те же, что разбирает client.ts). Умеет портить ответы
// (битая контрольная сумма), терять их, медленно стирать флешку и обрывать связь.
// Как и настоящий BF, команду стирания выполняет даже на заармленном борту — проверка
// «disarmed» обязана быть в клиенте, и тесты это ловят.

import type { SerialLink } from './client';
import { MSP, MspFrame, MspParser, Reader, Writer, encodeV1, encodeV2 } from './msp';
import { paramByName } from '../params/registry';

export interface FakeFcOptions {
  variant?: string;
  api?: [number, number];
  /** байты MSP_FC_VERSION: [26, 6, 1] = 2026.6.1, [4, 5, 2] = 4.5.2 */
  fcVersion?: [number, number, number];
  versionText?: string | null;
  boardId?: string;
  targetName?: string;
  boardName?: string;
  manufacturerId?: string;
  craftName?: string;
  uid?: [number, number, number];
  /** содержимое флешки целиком (totalSize) и сколько занято */
  flash?: Uint8Array;
  usedSize?: number;
  armed?: boolean;
  armingDisableFlags?: number;
  /** напряжение батареи, В (0 — только USB) */
  vbat?: number;
  /** сколько длится стирание, мс */
  eraseMs?: number;
  /** испортить контрольную сумму каждого N-го ответа */
  corruptEvery?: number;
  /** не ответить на каждый N-й запрос */
  dropEvery?: number;
  /** оборвать связь после N ответов */
  disconnectAfter?: number;
  /** задержка ответа, мс */
  delayMs?: number;
  /** настройки для CLI (значения как в `dump all`); по умолчанию — небольшой набор */
  cli?: Record<string, string>;
  /** параметры, на которые `set` отвечает INVALID VALUE (имитация ошибки) */
  cliReject?: string[];
}

/** настройки по умолчанию для эмулятора CLI (часть дефолтов BF 2026.6.1) */
export const FAKE_DEFAULTS: Record<string, string> = {
  craft_name: '-', gyro_lpf2_static_hz: '500', dterm_lpf1_static_hz: '75', dterm_lpf2_static_hz: '150', rpm_filter_q: '500',
  simplified_dterm_filter_multiplier: '100', simplified_gyro_filter_multiplier: '100',
  p_roll: '45', i_roll: '80', d_roll: '30', f_roll: '120', p_pitch: '47', i_pitch: '84', d_pitch: '34', f_pitch: '125',
  rates_type: 'ACTUAL', roll_rc_rate: '7', roll_srate: '67', roll_expo: '0',
};
const PROFILE_KEY = /^(p|i|d|f)_(roll|pitch|yaw)$|^simplified_(?!.*filter)|^d_max|^d_min/;
const RATE_KEY = /^rates_type$|_rc_rate$|_srate$|_expo$|_rate_limit$/;

export class FakeFc implements SerialLink {
  o: Required<Omit<FakeFcOptions, 'flash' | 'versionText' | 'corruptEvery' | 'dropEvery' | 'disconnectAfter' | 'cli' | 'cliReject'>> & FakeFcOptions;
  flash: Uint8Array;
  usedSize: number;
  /** все полученные команды (для проверок безопасности) */
  received: number[] = [];
  private dataCb: (d: Uint8Array) => void = () => {};
  private closeCbs: ((why: string) => void)[] = [];
  private parser: MspParser;
  private replies = 0;
  private requests = 0;
  private erasingUntil = 0;
  closed = false;
  // --- CLI ---
  cliMode = false;
  /** все строки, полученные в CLI (для проверок безопасности) */
  cliReceived: string[] = [];
  /** сохранённые (как в EEPROM) и рабочие настройки */
  saved: Record<string, string>;
  working: Record<string, string>;
  private cliLine = '';
  private hashTimer: ReturnType<typeof setTimeout> | null = null;
  rebooted = false;

  constructor(opts: FakeFcOptions = {}) {
    this.o = {
      variant: 'BTFL',
      api: [1, 48],
      fcVersion: [26, 6, 1],
      boardId: 'S7X2',
      targetName: 'STM32F7X2',
      boardName: 'TMOTORVELOXF7SE',
      manufacturerId: 'TMTR',
      craftName: '',
      uid: [0x0026003a, 0x36325006, 0x2035394d],
      usedSize: 0,
      armed: false,
      armingDisableFlags: 0,
      vbat: 0,
      eraseMs: 50,
      delayMs: 0,
      ...opts,
    };
    this.flash = opts.flash ?? new Uint8Array(1 << 20).fill(0xff);
    this.usedSize = opts.usedSize ?? 0;
    this.saved = { ...FAKE_DEFAULTS, ...(opts.cli ?? {}) };
    this.working = { ...this.saved };
    this.parser = new MspParser((f) => this.handle(f), () => {}, (b) => this.nonMsp(b), 192);
  }

  private send(text: string): void {
    const b = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xff;
    setTimeout(() => {
      if (this.closed) return;
      for (let i = 0; i < b.length; i += 64) this.dataCb(b.subarray(i, i + 64));
    }, this.o.delayMs);
  }

  /** байт вне кадра MSP: '#' → CLI после 100 мс тишины (msp_serial.c), но не на заармленном */
  private nonMsp(b: number): void {
    if (this.o.armed) return; // MSP_SKIP_NON_MSP_DATA
    if (this.hashTimer) clearTimeout(this.hashTimer);
    this.hashTimer = null;
    if (b !== 0x23) return;
    this.hashTimer = setTimeout(() => {
      this.cliMode = true;
      this.cliLine = '';
      this.o.armingDisableFlags |= 1 << 13; // ARMING_DISABLED_CLI
      this.send("\r\nEntering CLI Mode, type 'exit' to reboot, or 'help'\r\n\r\n# ");
    }, 100);
  }

  private cliByte(b: number): void {
    if (b === 0x0a || b === 0x0d) {
      if (!this.cliLine) return;
      const line = this.cliLine.trim();
      this.cliLine = '';
      this.cliReceived.push(line);
      this.send('\r\n');
      this.cliCommand(line);
    } else if (b >= 32 && b <= 126) {
      this.cliLine += String.fromCharCode(b);
      this.send(String.fromCharCode(b)); // эхо в интерактивном режиме
    }
  }

  private reboot(): void {
    this.rebooted = true;
    setTimeout(() => this.disconnect('полётник перезагружается'), 30);
  }

  private section(keys: string[], all: boolean): string {
    const def = FAKE_DEFAULTS;
    const pick = (re: ((k: string) => boolean)) => keys.filter(re).filter((k) => all || this.working[k] !== def[k]).map((k) => `set ${k} = ${this.working[k]}`).join('\r\n');
    const master = pick((k) => !PROFILE_KEY.test(k) && !RATE_KEY.test(k));
    const prof = pick((k) => PROFILE_KEY.test(k));
    const rate = pick((k) => RATE_KEY.test(k));
    return `# version\r\n# Betaflight / STM32F7X2 (S7X2) 2026.6.1\r\n\r\n# start the command batch\r\nbatch start\r\n\r\n# master\r\n${master}\r\n\r\n# profile 0\r\nprofile 0\r\n\r\n${prof}\r\n\r\n# restore original profile selection\r\nprofile 0\r\n\r\n# rateprofile 0\r\nrateprofile 0\r\n\r\n${rate}\r\n\r\n# restore original rateprofile selection\r\nrateprofile 0\r\n\r\n# end the command batch\r\nbatch end\r\n`;
  }

  private cliCommand(line: string): void {
    const prompt = '\r\n# ';
    let m: RegExpMatchArray | null;
    const keys = Object.keys(this.working).sort();
    if (line === 'diff all' || line === 'dump all') return this.send(this.section(keys, line === 'dump all') + prompt);
    if ((m = line.match(/^get (\S+)$/))) {
      const v = this.working[m[1]];
      const p = paramByName.get(m[1]);
      return this.send((v === undefined ? `###ERROR IN get: INVALID NAME: ${m[1]}###\r\n` : `${m[1]} = ${v}\r\n${p ? `Allowed range: ${p.min} - ${p.max}\r\n` : ''}Default value: ${FAKE_DEFAULTS[m[1]] ?? v}\r\n`) + prompt);
    }
    if ((m = line.match(/^set (\S+)\s*=\s*(.+)$/))) {
      const [, name, val] = m;
      if (!(name in this.working)) return this.send(`###ERROR IN set: INVALID NAME: ${name}###\r\n${prompt}`);
      const p = paramByName.get(name);
      const okVal = !this.o.cliReject?.includes(name) && (p?.options ? p.options.some((o) => o.toUpperCase() === val.toUpperCase()) : !p || (Number.isFinite(Number(val)) && Number(val) >= p.min && Number(val) <= p.max));
      if (!okVal) return this.send(`###ERROR IN set: INVALID VALUE###\r\n${p ? `Allowed range: ${p.min} - ${p.max}` : ''}\r\n${prompt}`);
      this.working[name] = p?.options ? val.toUpperCase() : val;
      return this.send(`${name} set to ${this.working[name]}\r\n${prompt}`);
    }
    if (line === 'save') {
      this.saved = { ...this.working };
      this.send('\r\n# saving\r\n');
      return this.reboot();
    }
    if (line === 'exit') {
      this.working = { ...this.saved };
      this.send('\r\n# leaving CLI mode, unsaved changes lost\r\n');
      return this.reboot();
    }
    if (line === 'exit noreboot' && (this.o.api[0] > 1 || this.o.api[1] >= 47)) {
      this.cliMode = false;
      this.send('\r\n# leaving CLI mode, no reboot\r\n');
      return;
    }
    this.send(`###ERROR IN input: UNKNOWN COMMAND, TRY 'HELP'###${prompt}`);
  }

  // --- SerialLink ---
  async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('port closed');
    if (this.cliMode) for (const b of data) this.cliByte(b);
    else this.parser.push(data);
  }
  onData(cb: (d: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: (why: string) => void): void {
    this.closeCbs.push(cb);
  }
  async close(): Promise<void> {
    this.disconnect('closed');
  }

  disconnect(why = 'disconnected'): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(why);
  }

  get erasing(): boolean {
    return Date.now() < this.erasingUntil;
  }

  private handle(f: MspFrame): void {
    if (f.dir !== '<') return;
    this.received.push(f.cmd);
    this.requests++;
    if (this.o.dropEvery && this.requests % this.o.dropEvery === 0) return;
    const reply = this.process(f.cmd, f.payload);
    const frame = f.version === 2 ? encodeV2(f.cmd, reply ?? new Uint8Array(0), reply ? '>' : '!') : encodeV1(f.cmd, reply ?? new Uint8Array(0), reply ? '>' : '!');
    this.replies++;
    if (this.o.corruptEvery && this.replies % this.o.corruptEvery === 0) frame[frame.length - 1] ^= 0x5a;
    const cut = this.o.disconnectAfter !== undefined && this.replies > this.o.disconnectAfter;
    setTimeout(() => {
      if (this.closed) return;
      if (cut) return this.disconnect('USB отключён');
      // как USB CDC: ответ приходит пакетами по 64 байта
      for (let i = 0; i < frame.length; i += 64) this.dataCb(frame.subarray(i, i + 64));
    }, this.o.delayMs);
  }

  /** ответ как в msp.c; null — '!' (команда неизвестна) */
  private process(cmd: number, payload: Uint8Array): Uint8Array | null {
    const o = this.o;
    switch (cmd) {
      case MSP.API_VERSION:
        return new Writer().u8(0).u8(o.api[0]).u8(o.api[1]).done();
      case MSP.FC_VARIANT:
        return new Writer().str(o.variant, 4).done();
      case MSP.FC_VERSION: {
        const w = new Writer().u8(o.fcVersion[0]).u8(o.fcVersion[1]).u8(o.fcVersion[2]);
        // строка версии появилась вместе с календарными версиями (2025.12)
        const text = o.versionText !== undefined ? o.versionText : o.fcVersion[0] >= 25 ? `${2000 + o.fcVersion[0]}.${o.fcVersion[1]}.${o.fcVersion[2]}` : null;
        if (text !== null) w.pstr(text);
        return w.done();
      }
      case MSP.BOARD_INFO:
        return new Writer().str(o.boardId, 4).u16(0).u8(0).u8(1).pstr(o.targetName).pstr(o.boardName).pstr(o.manufacturerId).bytes(new Uint8Array(32)).u8(0).u8(2).u16(8000).u32(0).u8(1).u8(0).done();
      case MSP.BUILD_INFO:
        return new Writer().str('Jun  1 2026', 11).str('12:00:00', 8).str('6dbc421', 7).u8(0).done();
      case MSP.NAME:
        return new Writer().str(o.craftName).done();
      case MSP.ANALOG:
        return new Writer().u8(Math.round(o.vbat * 10)).u16(0).u16(0).u16(0).u16(Math.round(o.vbat * 100)).done();
      case MSP.UID:
        return new Writer().u32(o.uid[0]).u32(o.uid[1]).u32(o.uid[2]).done();
      case MSP.STATUS_EX: {
        const armDis = o.armed ? 0 : o.armingDisableFlags;
        return new Writer().u16(125).u16(0).u16(0x21).u32(o.armed ? 1 : 0).u8(0).u16(123).u8(4).u8(0).u8(0).u8(30).u32(armDis).u8(0).u16(40).u8(4).u8(3).u8(0).done();
      }
      case MSP.DATAFLASH_SUMMARY: {
        const ready = !this.erasing;
        return new Writer().u8(2 | (ready ? 1 : 0)).u32(this.flash.length / 65536).u32(this.flash.length).u32(this.usedSize).done();
      }
      case MSP.DATAFLASH_ERASE:
        // blackboxEraseAll(): без проверки арма (так в BF), асинхронно
        this.erasingUntil = Date.now() + this.o.eraseMs;
        this.flash.fill(0xff);
        this.usedSize = 0;
        return new Uint8Array(0);
      case MSP.DATAFLASH_READ: {
        const r = new Reader(payload);
        const addr = r.u32();
        let len = payload.length >= 6 ? r.u16() : 128;
        const compress = payload.length >= 7 ? r.u8() : 0;
        if (compress) return null; // Huffman эмулятор не делает — клиент его не просит
        len = Math.min(len, 4096, Math.max(0, this.flash.length - addr));
        const data = this.flash.subarray(addr, addr + len);
        return new Writer().u32(addr).u16(data.length).u8(0).bytes(data).done();
      }
      default:
        return null;
    }
  }
}
