// Протокол полётника (MSP) на эмуляторе: кадры, сведения о борте, стирание и чтение флешки,
// сбои связи, безопасность (ничего моторного, запись только disarmed).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MSP, MspFrame, MspParser, crc8DvbS2, encodeV1, encodeV2 } from '../src/fc/msp';
import { FcClient, FcError, READ_CMDS, WRITE_CMDS, armingDisableList, checkCompat, rollbackLines } from '../src/fc/client';
import { boardNumbers, cliAllowed, effectiveValues, headerVsBoard, parseConfig, setResult } from '../src/fc/cli';
import { FakeFc } from '../src/fc/emulator';
import { PARAMS, paramByName } from '../src/params/registry';
import { gainsToCli, simplifiedToCli } from '../src/pid/gains';
import { scanFile } from '../src/decoder/scan';
import { SMALL_DUMP, hasFixture } from './helpers';

const bytes = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

describe('кадры MSP', () => {
  it('CRC8 DVB-S2: контрольное значение «123456789» → 0xBC', () => {
    expect(bytes('123456789').reduce((c, b) => crc8DvbS2(c, b), 0)).toBe(0xbc);
  });

  it('v1-запрос MSP_API_VERSION — как его шлёт конфигуратор: 24 4D 3C 00 01 01', () => {
    expect([...encodeV1(MSP.API_VERSION)]).toEqual([0x24, 0x4d, 0x3c, 0x00, 0x01, 0x01]);
  });

  it('v2-кадр: заголовок $X<, флаги, команда и длина u16 little-endian', () => {
    const f = encodeV2(0x3010, Uint8Array.from([1, 2, 3]));
    expect([...f.subarray(0, 8)]).toEqual([0x24, 0x58, 0x3c, 0, 0x10, 0x30, 3, 0]);
    let c = 0;
    for (const b of f.subarray(3, f.length - 1)) c = crc8DvbS2(c, b);
    expect(f[f.length - 1]).toBe(c);
  });

  it('разбор: v1, v1 jumbo, v2, побайтно, с текстом между кадрами и битой суммой', () => {
    const got: MspFrame[] = [];
    const errs: string[] = [];
    const text: number[] = [];
    const p = new MspParser((f) => got.push(f), (e) => errs.push(e), (b) => text.push(b));
    const big = Uint8Array.from({ length: 4103 }, (_, i) => i * 7);
    const bad = encodeV2(5, Uint8Array.from([9, 9]), '>');
    bad[bad.length - 1] ^= 1;
    const stream = [...bytes('# \r\n'), ...encodeV1(1, Uint8Array.from([0, 1, 48]), '>'), ...encodeV1(71, big, '>'), ...bad, ...encodeV2(71, big, '>'), ...encodeV2(72, new Uint8Array(0), '!')];
    for (const b of stream) p.push(Uint8Array.of(b));
    expect(String.fromCharCode(...text)).toBe('# \r\n');
    expect(errs).toEqual(['crc']);
    expect(got.map((f) => [f.version, f.cmd, f.dir, f.payload.length])).toEqual([[1, 1, '>', 3], [1, 71, '>', 4103], [2, 71, '>', 4103], [2, 72, '!', 0]]);
    expect([...got[2].payload]).toEqual([...big]);
  });
});

describe('полётник на эмуляторе', () => {
  it('сведения о борте 2026.6.1: плата, версия, UID как DeviceUID в логе, статус', async () => {
    const fc = new FakeFc({ craftName: 'VELOX', armingDisableFlags: (1 << 13) | (1 << 29) });
    const c = new FcClient(fc);
    const info = await c.info();
    expect(info).toMatchObject({ api: [1, 48], variant: 'BTFL', version: '2026.6.1', boardId: 'S7X2', boardName: 'TMOTORVELOXF7SE', manufacturerId: 'TMTR', craftName: 'VELOX', uid: '0026003a363250062035394d' });
    expect(checkCompat(info).ok).toBe(true);
    const st = await c.status();
    expect(st.armed).toBe(false);
    expect(armingDisableList(st.armingDisableFlags, st.armingDisableCount)).toEqual(['CLI', 'ARM_SWITCH']);
    expect(await c.flashSummary()).toEqual({ supported: true, ready: true, sectors: 16, totalSize: 1 << 20, usedSize: 0 });
  });

  it('4.5.2 (API 1.46) поддерживается; INAV и API 1.45 — нет, и дальше их не спрашиваем', async () => {
    const old = await new FcClient(new FakeFc({ api: [1, 46], fcVersion: [4, 5, 2] })).info();
    expect(old.version).toBe('4.5.2');
    expect(checkCompat(old).ok).toBe(true);
    for (const o of [{ variant: 'INAV' }, { api: [1, 45] as [number, number] }]) {
      const fc = new FakeFc(o);
      const c = new FcClient(fc);
      const info = await c.info();
      expect(checkCompat(info).ok).toBe(false);
      expect(fc.received).toEqual([MSP.API_VERSION, MSP.FC_VARIANT]);
      await expect(c.eraseFlash(info)).rejects.toMatchObject({ code: 'unsupported' });
      expect(fc.received).not.toContain(MSP.DATAFLASH_ERASE);
    }
  });

  it('медленное стирание: прогресс, ожидание готовности, флешка пустая', async () => {
    const fc = new FakeFc({ usedSize: 4096, eraseMs: 400 });
    fc.flash.fill(0x11, 0, 4096);
    const c = new FcClient(fc);
    const info = await c.info();
    const ticks: number[] = [];
    const r = await c.eraseFlash(info, { onProgress: (ms) => ticks.push(ms), pollMs: 50 });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(400);
    expect(ticks.length).toBeGreaterThan(4);
    expect(r.summary).toMatchObject({ ready: true, usedSize: 0 });
    expect(fc.flash[0]).toBe(0xff);
  });

  it('заармлен — стирание не посылается вообще (BF стёр бы и на лету)', async () => {
    const fc = new FakeFc({ armed: true, usedSize: 100 });
    const c = new FcClient(fc);
    const info = await c.info();
    await expect(c.eraseFlash(info)).rejects.toMatchObject({ code: 'armed' });
    expect(fc.received).not.toContain(MSP.DATAFLASH_ERASE);
    expect(fc.usedSize).toBe(100);
  });

  it('чтение флешки: битые и потерянные ответы повторяются, данные совпадают байт в байт', async () => {
    const flash = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31 + (i >> 9)) & 0xff);
    const fc = new FakeFc({ flash, usedSize: 250_001, corruptEvery: 7, dropEvery: 11 });
    const c = new FcClient(fc);
    const prog: number[] = [];
    const parts = await c.readFlash(0, 250_001, { onProgress: (d) => prog.push(d), timeoutMs: 150 });
    const out = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
    expect(out.length).toBe(250_001);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(flash.subarray(0, 250_001)))).toBe(0);
    expect(c.stats.crcErrors).toBeGreaterThan(5);
    expect(c.stats.timeouts).toBeGreaterThan(3);
    expect(prog.at(-1)).toBe(250_001);
  }, 60_000);

  it('отмена и обрыв связи — понятная ошибка, а не зависание', async () => {
    const fc = new FakeFc({ flash: new Uint8Array(200_000), usedSize: 200_000 });
    const c = new FcClient(fc);
    const ac = new AbortController();
    await expect(c.readFlash(0, 200_000, { onProgress: (d) => d > 20_000 && ac.abort(), signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
    const fc2 = new FakeFc({ flash: new Uint8Array(200_000), usedSize: 200_000, disconnectAfter: 10 });
    const c2 = new FcClient(fc2);
    await expect(c2.readFlash(0, 200_000)).rejects.toMatchObject({ code: 'closed' });
    expect(c2.isClosed).toBe(true);
    await expect(c2.status()).rejects.toBeInstanceOf(FcError);
  });

  it.skipIf(!hasFixture(SMALL_DUMP))('скачанный с «флешки» дамп открывается: те же 5 логов', async () => {
    const dump = new Uint8Array(fs.readFileSync(SMALL_DUMP));
    const flash = new Uint8Array(4 << 20).fill(0xff);
    flash.set(dump);
    const c = new FcClient(new FakeFc({ flash, usedSize: dump.length }));
    const s = await c.flashSummary();
    const parts = await c.readFlash(0, s.usedSize);
    const got = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
    expect(Buffer.compare(Buffer.from(got), Buffer.from(dump))).toBe(0);
    const st = await scanFile({ size: got.length, read: async (o, l) => got.subarray(o, o + l) });
    expect(st.logs.length).toBe(5);
  }, 60_000);
});

describe('безопасность', () => {
  // коды из msp_protocol.h / msp_protocol_v2_betaflight.h BF 2026.6.1
  const MOTOR_OR_DANGEROUS = { MSP_SET_MOTOR: 214, MSP2_SEND_DSHOT_COMMAND: 0x3003, MSP_SET_PASSTHROUGH: 245, MSP_SET_RAW_RC: 200, MSP_REBOOT: 68, MSP_SET_ARMING_DISABLED: 99, MSP_EEPROM_WRITE: 250, MSP_SET_MOTOR_CONFIG: 222, MSP_SET_MOTOR_3D_CONFIG: 217 };

  it('в списках разрешённых команд нет моторных и записывающих настройки', () => {
    for (const code of Object.values(MOTOR_OR_DANGEROUS)) {
      expect(READ_CMDS.has(code)).toBe(false);
      expect(WRITE_CMDS.has(code)).toBe(false);
    }
    expect([...WRITE_CMDS]).toEqual([MSP.DATAFLASH_ERASE]);
  });

  it('попытка послать неразрешённую команду отклоняется, в порт ничего не уходит', async () => {
    const fc = new FakeFc();
    const c = new FcClient(fc);
    for (const code of Object.values(MOTOR_OR_DANGEROUS)) await expect(c.request(code)).rejects.toMatchObject({ code: 'forbidden' });
    expect(fc.received).toEqual([]);
  });
});

describe('CLI: настройки с борта и применение (B4–B5)', () => {
  it('разбор dump all: секции профилей, активный профиль, перечисления — числами', () => {
    const t = '# master\r\nset gyro_lpf2_static_hz = 500\r\n# profile 0\r\nprofile 0\r\nset d_roll = 30\r\n# profile 1\r\nprofile 1\r\nset d_roll = 44\r\n# restore original profile selection\r\nprofile 1\r\nrateprofile 0\r\nset rates_type = ACTUAL\r\n';
    const v = effectiveValues(parseConfig(t), 1, 0);
    expect(v).toMatchObject({ gyro_lpf2_static_hz: '500', d_roll: '44', rates_type: 'ACTUAL' });
    const n = boardNumbers(v);
    expect(n.d_roll).toBe(44);
    expect(n.rates_type).toBe(3);
    expect(headerVsBoard({ d_roll: 40, gyro_lpf2_static_hz: 500 }, n)).toEqual([{ key: 'd_roll', log: 40, board: 44 }]);
    expect(setResult('###ERROR IN set: INVALID VALUE###\r\nAllowed range: 0 - 250\r\n', 'd_roll')).toEqual({ ok: false, error: '###ERROR IN set: INVALID VALUE### Allowed range: 0 - 250' });
  });

  it('прочитать настройки 2026.6.1: diff all + dump all, выход без перезагрузки (запрет арма CLI остаётся)', async () => {
    const fc = new FakeFc({ cli: { d_roll: '44' } });
    const c = new FcClient(fc);
    const info = await c.info();
    const s = await c.readSettings(info);
    expect(s.rebooted).toBe(false);
    expect(s.values.d_roll).toBe('44');
    expect(s.diffAll).toContain('set d_roll = 44');
    expect(s.diffAll).not.toContain('set p_roll'); // дефолт в diff не попадает
    expect(fc.cliReceived).toEqual(['diff all', 'dump all', 'exit noreboot']);
    const st = await c.status(); // MSP снова работает
    expect(armingDisableList(st.armingDisableFlags, st.armingDisableCount)).toContain('CLI');
  });

  it('4.5.2 (нет exit noreboot): после чтения полётник перезагружается', async () => {
    const fc = new FakeFc({ api: [1, 46], fcVersion: [4, 5, 2] });
    const c = new FcClient(fc);
    const s = await c.readSettings(await c.info());
    expect(s.rebooted).toBe(true);
    expect(fc.cliReceived.at(-1)).toBe('exit');
  });

  it('применить: бэкап «до», прежние значения, построчная проверка, save; откат возвращает как было', async () => {
    const fc = new FakeFc();
    const c = new FcClient(fc);
    const info = await c.info();
    const rows: boolean[] = [];
    const r = await c.applySets(info, ['set d_roll = 33', 'set dterm_lpf1_static_hz = 70', 'save'], (_, x) => rows.push(x.ok));
    expect(r.ok).toBe(true);
    expect(rows).toEqual([true, true]);
    expect(r.before).toEqual({ d_roll: '30', dterm_lpf1_static_hz: '75' });
    expect(r.diffAll).toContain('# master');
    expect(fc.saved).toMatchObject({ d_roll: '33', dterm_lpf1_static_hz: '70' });
    expect(fc.cliReceived).toEqual(['diff all', 'get d_roll', 'get dterm_lpf1_static_hz', 'set d_roll = 33', 'set dterm_lpf1_static_hz = 70', 'save']);
    expect(fc.rebooted).toBe(true);
    // полётник перезагрузился — подключаемся заново и откатываем
    const fc2 = new FakeFc({ cli: fc.saved });
    const c2 = new FcClient(fc2);
    const back = await c2.applySets(await c2.info(), rollbackLines(r));
    expect(back.ok).toBe(true);
    expect(fc2.saved).toMatchObject({ d_roll: '30', dterm_lpf1_static_hz: '75' });
  });

  it('ошибка в строке — стоп, без save: перезагрузка отбрасывает уже поставленное', async () => {
    const fc = new FakeFc({ cliReject: ['dterm_lpf1_static_hz'] });
    const c = new FcClient(fc);
    const r = await c.applySets(await c.info(), ['set d_roll = 33', 'set dterm_lpf1_static_hz = 70', 'set p_roll = 50']);
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.ok)).toEqual([true, false]);
    expect(r.error).toMatch(/INVALID VALUE/);
    expect(fc.cliReceived).not.toContain('save');
    expect(fc.cliReceived).not.toContain('set p_roll = 50');
    expect(fc.cliReceived.at(-1)).toBe('exit');
    expect(fc.saved.d_roll).toBe('30');
  });

  it('параметр не из справочника — отказ до входа в CLI', async () => {
    const fc = new FakeFc();
    const c = new FcClient(fc);
    await expect(c.applySets(await c.info(), ['set no_such_param = 1'])).rejects.toMatchObject({ code: 'forbidden' });
    expect(fc.cliMode).toBe(false);
    expect(fc.cliReceived).toEqual([]);
  });

  it('параметр из справочника, которого нет в этой сборке (chirp без USE_CHIRP), — ничего не меняется', async () => {
    const fc = new FakeFc();
    const c = new FcClient(fc);
    const r = await c.applySets(await c.info(), ['set d_roll = 33', 'set chirp_time_seconds = 20']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/chirp_time_seconds/);
    expect(fc.cliReceived.filter((l) => l.startsWith('set'))).toEqual([]);
    expect(fc.saved.d_roll).toBe('30');
  });

  it('заармлен — в CLI не входим вообще', async () => {
    const fc = new FakeFc({ armed: true });
    const c = new FcClient(fc);
    const info = await c.info();
    await expect(c.applySets(info, ['set d_roll = 33'])).rejects.toMatchObject({ code: 'armed' });
    await expect(c.readSettings(info)).rejects.toMatchObject({ code: 'armed' });
    expect(fc.cliMode).toBe(false);
    expect(fc.cliReceived).toEqual([]);
  });

  it('белый список CLI: моторы, загрузчик, defaults, склейки — нельзя', async () => {
    for (const l of ['motor 0 1500', 'dshotprog 0 1', 'bl', 'dfu', 'defaults', 'defaults nosave', 'set d_roll = 30; save', 'set d_roll=30', 'resource MOTOR 1 A08', 'flash_erase', 'mixer QUADX', 'set craft_name = a b'])
      expect(cliAllowed(l), l).toBe(false);
    for (const l of ['set d_roll = 30', 'set rates_type = ACTUAL', 'get d_roll', 'diff all', 'dump all', 'save', 'exit', 'exit noreboot']) expect(cliAllowed(l), l).toBe(true);
    const fc = new FakeFc();
    const c = new FcClient(fc);
    await expect(c.applySets(await c.info(), ['motor 0 1500'])).rejects.toMatchObject({ code: 'forbidden' });
    expect(fc.cliMode).toBe(false);
  });

  it('белый список CLI: set — только параметры справочника и значения своего типа', async () => {
    // параметры вне справочника — даже безобидные на вид — не пишем
    for (const l of ['set motor_pwm_protocol = DSHOT600', 'set mixer_type = LEGACY', 'set dshot_bidir = OFF', 'set motor_poles = 12', 'set craft_name = test', 'set serialrx_provider = CRSF', 'set blackbox_sample_rate = 1/2'])
      expect(cliAllowed(l), l).toBe(false);
    // значение не своего типа
    for (const l of ['set gyro_lpf1_type = FOO', 'set rates_type = 3', 'set d_roll = ON', 'set d_roll = 1e3'])
      expect(cliAllowed(l), l).toBe(false);
    // регистр слова перечисления не важен; отрицательные и дробные числа — да
    for (const l of ['set gyro_lpf1_type = pt1', 'set simplified_pids_mode = RPY', 'set p_roll = 45', 'set roll_expo = 0'])
      expect(cliAllowed(l), l).toBe(true);
    // get — только чтение, разрешён и для параметров вне справочника
    expect(cliAllowed('get motor_pwm_protocol')).toBe(true);
    // applySets не входит в CLI, если хоть одна строка вне справочника
    const fc = new FakeFc();
    const c = new FcClient(fc);
    await expect(c.applySets(await c.info(), ['set d_roll = 30', 'set motor_pwm_protocol = DSHOT150'])).rejects.toMatchObject({ code: 'forbidden' });
    expect(fc.cliMode).toBe(false);
    expect(fc.cliReceived).toEqual([]);
  });

  it('всё, что умеют генерировать советчик, песочницы и перенос, проходит белый список', () => {
    const names = new Set<string>([
      ...Object.keys(gainsToCli({ P: [45, 47, 45], I: [80, 84, 80], D: [30, 34, 0], F: [120, 125, 120], dExtra: [40, 46, 0], dExtraKind: 'd_max' })),
      ...Object.keys(gainsToCli({ P: [45, 47, 45], I: [80, 84, 80], D: [30, 34, 0], F: [120, 125, 120], dExtra: [40, 46, 0], dExtraKind: 'd_min' })),
      ...Object.keys(simplifiedToCli({ mode: 2, master: 100, pi: 100, i: 100, d: 100, dExtra: 100, ff: 100, pitchD: 100, pitchPi: 100 }, 'simplified_d_max_gain')),
      ...Object.keys(simplifiedToCli({ mode: 2, master: 100, pi: 100, i: 100, d: 100, dExtra: 100, ff: 100, pitchD: 100, pitchPi: 100 }, 'simplified_dmax_gain')),
      ...PARAMS.map((p) => p.name),
    ]);
    for (const n of names) {
      const def = paramByName.get(n);
      expect(def, n).toBeDefined();
      const v = def!.options ? def!.options[0] : String(def!.def);
      expect(cliAllowed(`set ${n} = ${v}`), n).toBe(true);
    }
  });
});
