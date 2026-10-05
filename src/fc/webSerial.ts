// Web Serial → SerialLink. Chrome/Edge (89+), только безопасный контекст. Проверено в Chromium 141:
// на file:// navigator.serial есть и isSecureContext = true; если браузер всё же откажет
// (SecurityError при выборе порта) — UI говорит «через npm run dev (localhost)».

import type { SerialLink } from './client';

// Минимальные типы Web Serial (в lib.dom TypeScript их нет)
interface WSerialPort {
  open(o: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  addEventListener(t: 'disconnect', cb: () => void): void;
}
interface WSerial {
  requestPort(o?: { filters?: { usbVendorId?: number }[] }): Promise<WSerialPort>;
  getPorts(): Promise<WSerialPort[]>;
}

export type SerialSupport = 'ok' | 'insecure' | 'unsupported';

export function serialSupport(): SerialSupport {
  if (typeof navigator === 'undefined') return 'unsupported';
  if (!('serial' in navigator)) return typeof isSecureContext !== 'undefined' && !isSecureContext ? 'insecure' : 'unsupported';
  return 'ok';
}

function serial(): WSerial {
  return (navigator as unknown as { serial: WSerial }).serial;
}

/** выбор порта пользователем (нужно нажатие) и открытие */
export async function requestLink(): Promise<SerialLink & { info: string }> {
  const port = await serial().requestPort();
  return openPort(port);
}

async function openPort(port: WSerialPort): Promise<SerialLink & { info: string }> {
  // USB CDC скорость игнорирует; 115200 — как у конфигуратора
  await port.open({ baudRate: 115200, bufferSize: 65536 });
  let dataCb: (d: Uint8Array) => void = () => {};
  const closeCbs: ((why: string) => void)[] = [];
  let closed = false;
  const writer = port.writable!.getWriter();
  const reader = port.readable!.getReader();
  const finish = (why: string): void => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb(why);
  };
  port.addEventListener('disconnect', () => finish('disconnected'));
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) dataCb(value);
      }
    } catch (e) {
      finish(String(e));
      return;
    }
    finish('closed');
  })();
  const i = port.getInfo();
  return {
    info: i.usbVendorId !== undefined ? `USB ${i.usbVendorId.toString(16).padStart(4, '0')}:${(i.usbProductId ?? 0).toString(16).padStart(4, '0')}` : 'serial',
    write: (d) => writer.write(d),
    onData: (cb) => {
      dataCb = cb;
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
    close: async () => {
      try {
        await reader.cancel();
      } catch {
        /* уже закрыт */
      }
      reader.releaseLock();
      writer.releaseLock();
      try {
        await port.close();
      } catch {
        /* уже закрыт */
      }
      finish('closed');
    },
  };
}
