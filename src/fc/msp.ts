// MSP — протокол конфигуратора Betaflight. Сверено с исходниками BF 2026.6.1 (и 4.5.2 для
// совместимости), ссылки — в PLAN.md, раздел «B: полётник по USB»:
//   src/main/msp/msp_protocol.h — коды команд, API_VERSION 1.48 (2026.6), 1.47 (2025.12), 1.46 (4.5);
//   src/main/msp/msp_serial.c   — кадры v1 ('$M', XOR, jumbo при size = 255) и v2 ('$X', CRC8 DVB-S2,
//                                 длина u16), '!' вместо '>' — команда не выполнена;
//                                 входной буфер полётника 192 байта, выходной — 4096 + 16.
// Здесь только кадры и разбор; что можно посылать — client.ts.

export const MSP = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  BUILD_INFO: 5,
  NAME: 10,
  DATAFLASH_SUMMARY: 70,
  DATAFLASH_READ: 71,
  DATAFLASH_ERASE: 72,
  STATUS_EX: 150,
  UID: 160,
} as const;

/** MSPv2 crc8 DVB-S2 (poly 0xD5), как crc8_dvb_s2() в common/crc.c */
export function crc8DvbS2(crc: number, b: number): number {
  crc ^= b;
  for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
  return crc;
}

export type Dir = '<' | '>' | '!';

/** кадр MSPv2 native: '$' 'X' dir flags cmd(u16) size(u16) payload crc8 */
export function encodeV2(cmd: number, payload: Uint8Array = new Uint8Array(0), dir: Dir = '<', flags = 0): Uint8Array {
  const n = payload.length;
  const out = new Uint8Array(9 + n);
  out.set([0x24, 0x58, dir.charCodeAt(0), flags, cmd & 0xff, cmd >> 8, n & 0xff, n >> 8], 0);
  out.set(payload, 8);
  let c = 0;
  for (let i = 3; i < 8 + n; i++) c = crc8DvbS2(c, out[i]);
  out[8 + n] = c;
  return out;
}

/** кадр MSPv1: '$' 'M' dir size cmd payload xor; payload ≥ 255 — jumbo (size = 255, затем u16) */
export function encodeV1(cmd: number, payload: Uint8Array = new Uint8Array(0), dir: Dir = '<'): Uint8Array {
  const n = payload.length;
  const jumbo = n >= 255;
  const hdr = jumbo ? [0x24, 0x4d, dir.charCodeAt(0), 255, cmd, n & 0xff, n >> 8] : [0x24, 0x4d, dir.charCodeAt(0), n, cmd];
  const out = new Uint8Array(hdr.length + n + 1);
  out.set(hdr, 0);
  out.set(payload, hdr.length);
  let c = 0;
  for (let i = 3; i < hdr.length + n; i++) c ^= out[i];
  out[out.length - 1] = c;
  return out;
}

export interface MspFrame {
  version: 1 | 2;
  dir: Dir;
  cmd: number;
  flags: number;
  payload: Uint8Array;
}

/**
 * Потоковый разбор кадров (любой версии, любого направления). Байты вне кадров (текст CLI,
 * мусор) отдаются в onText. Битая контрольная сумма → onError('crc'), кадр выбрасывается.
 */
export class MspParser {
  private st = 0;
  /** заголовок кадра (после направления) */
  private hdr: number[] = [];
  private pl = new Uint8Array(0);
  private pos = 0;
  private sum = 0;
  private version: 1 | 2 = 1;
  private dir: Dir = '>';
  private cmd = 0;
  private flags = 0;
  constructor(
    private onFrame: (f: MspFrame) => void,
    private onError: (kind: 'crc' | 'format') => void = () => {},
    private onText: (b: number) => void = () => {},
    /** предел длины полезной нагрузки (защита от мусора, принятого за заголовок) */
    private maxPayload = 65535,
  ) {}

  reset(): void {
    this.st = 0;
  }

  push(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      // быстрый путь: полезная нагрузка копируется кусками
      if (this.st === 3 && this.pos < this.pl.length) {
        const n = Math.min(this.pl.length - this.pos, data.length - i);
        const chunk = data.subarray(i, i + n);
        this.pl.set(chunk, this.pos);
        if (this.version === 1) for (let k = 0; k < n; k++) this.sum ^= chunk[k];
        else for (let k = 0; k < n; k++) this.sum = crc8DvbS2(this.sum, chunk[k]);
        this.pos += n;
        i += n - 1;
        continue;
      }
      this.byte(data[i]);
    }
  }

  private fail(kind: 'crc' | 'format'): void {
    this.st = 0;
    this.onError(kind);
  }

  private byte(b: number): void {
    switch (this.st) {
      case 0: // '$'
        if (b === 0x24) this.st = 1;
        else this.onText(b);
        return;
      case 1: // 'M' | 'X'
        if (b === 0x4d || b === 0x58) {
          this.version = b === 0x4d ? 1 : 2;
          this.st = 2;
        } else {
          this.onText(0x24);
          this.st = 0;
          this.byte(b);
        }
        return;
      case 2: // направление
        if (b === 0x3c || b === 0x3e || b === 0x21) {
          this.dir = String.fromCharCode(b) as Dir;
          this.hdr = [];
          this.sum = 0;
          this.st = 4;
        } else this.fail('format');
        return;
      case 4: {
        // заголовок: v1 — size cmd [u16 jumbo], v2 — flags cmd(u16) size(u16)
        const h = this.hdr;
        h.push(b);
        this.sum = this.version === 1 ? this.sum ^ b : crc8DvbS2(this.sum, b);
        if (this.version === 1) {
          if (h.length === 2 && h[0] !== 255) this.start(h[1], 0, h[0]);
          else if (h.length === 4) this.start(h[1], 0, h[2] | (h[3] << 8));
        } else if (h.length === 5) this.start(h[1] | (h[2] << 8), h[0], h[3] | (h[4] << 8));
        return;
      }
      case 3: // контрольная сумма (полезная нагрузка уже набрана в push)
        this.st = 0;
        if (b !== this.sum) return this.fail('crc');
        this.onFrame({ version: this.version, dir: this.dir, cmd: this.cmd, flags: this.flags, payload: this.pl });
        return;
    }
  }

  private start(cmd: number, flags: number, size: number): void {
    if (size > this.maxPayload) return this.fail('format');
    this.cmd = cmd;
    this.flags = flags;
    this.pl = new Uint8Array(size);
    this.pos = 0;
    this.st = 3;
  }
}

/** чтение полезной нагрузки little-endian */
export class Reader {
  off = 0;
  constructor(private b: Uint8Array) {}
  get left(): number {
    return this.b.length - this.off;
  }
  u8(): number {
    return this.off < this.b.length ? this.b[this.off++] : 0;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  bytes(n: number): Uint8Array {
    const r = this.b.subarray(this.off, Math.min(this.b.length, this.off + n));
    this.off += n;
    return r;
  }
  str(n: number): string {
    return String.fromCharCode(...this.bytes(n)).replace(/\0+$/, '');
  }
  /** строка с длиной впереди (sbufWritePString) */
  pstr(): string {
    return this.str(this.u8());
  }
  rest(): Uint8Array {
    return this.bytes(this.left);
  }
}

export class Writer {
  private a: number[] = [];
  u8(v: number): this {
    this.a.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  str(s: string, n = s.length): this {
    for (let i = 0; i < n; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0);
    return this;
  }
  pstr(s: string): this {
    return this.u8(s.length).str(s);
  }
  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.a.push(b[i]);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.a);
  }
}
