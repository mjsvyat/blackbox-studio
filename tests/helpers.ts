import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ByteReader } from '../src/decoder/scan';

// Тестовые данные лежат в репозитории: tests/fixtures/ (большой дамп — через Git LFS).
export const FIXTURES = path.resolve(__dirname, 'fixtures');
export const SMALL_DUMP = path.join(FIXTURES, 'blackbox-2026-09-06.txt');
export const BIG_DUMP = path.join(FIXTURES, 'blackbox.txt');

/**
 * Есть ли настоящий файл. Если LFS не скачан, на месте дампа лежит текстовый указатель
 * (~130 байт) — такие тесты пропускаем, а не падаем.
 */
export function hasFixture(file: string, minBytes = 1_000_000): boolean {
  try {
    return fs.statSync(file).size >= minBytes;
  } catch {
    return false;
  }
}

/** ByteReader поверх файла на диске: читаем кусками, без загрузки всего дампа */
export function fileReader(file: string): ByteReader & { close(): void } {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    async read(offset, length) {
      const b = Buffer.alloc(length);
      fs.readSync(fd, b, 0, length, offset);
      return new Uint8Array(b.buffer, b.byteOffset, length);
    },
    close: () => fs.closeSync(fd),
  };
}

export function readRange(file: string, start: number, len: number): Uint8Array {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(len);
  fs.readSync(fd, b, 0, len, start);
  fs.closeSync(fd);
  return new Uint8Array(b.buffer, b.byteOffset, len);
}

/** эталон — рабочий bb-tools/bbdec.js пользователя (копия в tests/fixtures/legacy) */
export function legacyDecoder(): { decodeLog: (buf: Buffer, s: number, e: number, o: object) => any } {
  const req = createRequire(__filename);
  return req(path.join(FIXTURES, 'legacy', 'bbdec.cjs'));
}
