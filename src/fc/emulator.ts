// Эмулятор полётника Betaflight для тестов: фейковый последовательный порт, отвечающий как
// msp.c BF 2026.6.1 (форматы ответов — те же, что разбирает client.ts). Умеет портить ответы
// (битая контрольная сумма), терять их, медленно стирать флешку и обрывать связь.
// Как и настоящий BF, команду стирания выполняет даже на заармленном борту — проверка
// «disarmed» обязана быть в клиенте, и тесты это ловят.

import type { SerialLink } from './client';
import { MSP, MspFrame, MspParser, Reader, Writer, encodeV1, encodeV2 } from './msp';

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
}

export class FakeFc implements SerialLink {
  o: Required<Omit<FakeFcOptions, 'flash' | 'versionText' | 'corruptEvery' | 'dropEvery' | 'disconnectAfter'>> & FakeFcOptions;
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
      eraseMs: 50,
      delayMs: 0,
      ...opts,
    };
    this.flash = opts.flash ?? new Uint8Array(1 << 20).fill(0xff);
    this.usedSize = opts.usedSize ?? 0;
    this.parser = new MspParser((f) => this.handle(f), () => {}, () => {}, 192);
  }

  // --- SerialLink ---
  async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('port closed');
    this.parser.push(data);
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
