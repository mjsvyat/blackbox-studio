// Константы формата блэкбокса Betaflight (Data version 2).
// Источник: blackbox-tools / Blackbox Explorer + bb-tools/bbdec.js.

export const ENC = {
  SVB: 0,
  UVB: 1,
  NEG14: 3,
  TAG8_8SVB: 6,
  TAG2_3S32: 7,
  TAG8_4S16: 8,
  NULL: 9,
  TAG2_3SVAR: 10,
} as const;

export const PRED = {
  ZERO: 0,
  PREVIOUS: 1,
  STRAIGHT_LINE: 2,
  AVERAGE_2: 3,
  MINTHROTTLE: 4,
  MOTOR_0: 5,
  INC: 6,
  HOME_COORD: 7,
  C1500: 8,
  VBATREF: 9,
  LAST_MAIN_TIME: 10,
  MINMOTOR: 11,
} as const;

export const LOG_START_MARKER = 'H Product:Blackbox flight data recorder';

export const DISARM_REASONS = [
  'ARMING_DISABLED', 'FAILSAFE', 'THROTTLE_TIMEOUT', 'STICKS', 'SWITCH', 'CRASH_PROTECTION',
  'RUNAWAY_TAKEOFF', 'GPS_RESCUE', 'SERIAL_IO', 'SYSTEM',
];

// Betaflight пишет в S-кадр и в событие FLIGHTMODE rcModeActivationMask — битовую
// маску BOX-идентификаторов. Порядок совпадает с bb-tools (проверено на 4.5.2).
export const FLIGHT_MODES = [
  'ARM', 'ANGLE', 'HORIZON', 'MAG', 'BARO', 'GPSHOME', 'GPSHOLD', 'HEADFREE', 'CHIRP',
  'PASSTHRU', 'RANGEFINDER', 'FAILSAFE', 'GPSRESCUE', 'ANTIGRAVITY', 'HEADADJ', 'CAMSTAB', 'BEEPERON',
  'LEDLOW', 'CALIB', 'OSD', 'TELEMETRY', 'SERVO1', 'SERVO2', 'SERVO3', 'BLACKBOX', 'AIRMODE', '3D',
  'FPVANGLEMIX', 'BLACKBOXERASE', 'CAMERA1', 'CAMERA2', 'CAMERA3',
];
/**
 * Имена битов flightModeFlags по версии прошивки. BF пишет туда rcModeActivationMask — маску по
 * boxId_e СВОЕЙ версии (blackbox.c: memcpy(&slow->flightModeFlags, &rcModeActivationMask, …)),
 * а FLIGHT_MODES выше — порядок BF 3.x (как в bb-tools; декодер оставляет его ради паритета с
 * bbdec.js). Для анализа — эти таблицы, сверены с fc/rc_modes.h тегов 4.3.2, 4.4.3, 4.5.2,
 * 2025.12.1, 2026.6.1: в 4.5.2 HEADFREE = 4, GPSRESCUE = 7; в 2026.6.1 HEADFREE = 5, CHIRP = 6,
 * GPSRESCUE = 10.
 */
const MODES_4_3 = [
  'ARM', 'ANGLE', 'HORIZON', 'MAG', 'HEADFREE', 'PASSTHRU', 'FAILSAFE', 'GPSRESCUE', 'ANTIGRAVITY', 'HEADADJ', 'CAMSTAB', 'BEEPERON', 'LEDLOW', 'CALIB', 'OSD', 'TELEMETRY', 'SERVO1', 'SERVO2', 'SERVO3', 'BLACKBOX', 'AIRMODE', '3D', 'FPVANGLEMIX', 'BLACKBOXERASE', 'CAMERA1', 'CAMERA2', 'CAMERA3', 'FLIPOVERAFTERCRASH', 'PREARM', 'BEEPGPSCOUNT', 'VTXPITMODE', 'PARALYZE', 'USER1', 'USER2', 'USER3', 'USER4', 'PIDAUDIO', 'ACROTRAINER', 'VTXCONTROLDISABLE', 'LAUNCHCONTROL', 'MSPOVERRIDE', 'STICKCOMMANDDISABLE', 'BEEPERMUTE', 'READY', 'LAPTIMERRESET',
];
const MODES_2025_12 = [
  'ARM', 'ANGLE', 'HORIZON', 'MAG', 'ALTHOLD', 'HEADFREE', 'CHIRP', 'PASSTHRU', 'FAILSAFE', 'POSHOLD', 'GPSRESCUE', 'ANTIGRAVITY', 'HEADADJ', 'CAMSTAB', 'BEEPERON', 'LEDLOW', 'CALIB', 'OSD', 'TELEMETRY', 'SERVO1', 'SERVO2', 'SERVO3', 'BLACKBOX', 'AIRMODE', '3D', 'FPVANGLEMIX', 'BLACKBOXERASE', 'CAMERA1', 'CAMERA2', 'CAMERA3', 'CRASHFLIP', 'PREARM', 'BEEPGPSCOUNT', 'VTXPITMODE', 'PARALYZE', 'USER1', 'USER2', 'USER3', 'USER4', 'PIDAUDIO', 'ACROTRAINER', 'VTXCONTROLDISABLE', 'LAUNCHCONTROL', 'MSPOVERRIDE', 'STICKCOMMANDDISABLE', 'BEEPERMUTE', 'READY', 'LAPTIMERRESET',
];
const MODES_2026_6 = [
  'ARM', 'ANGLE', 'HORIZON', 'MAG', 'ALTHOLD', 'HEADFREE', 'CHIRP', 'PASSTHRU', 'FAILSAFE', 'POSHOLD', 'GPSRESCUE', 'AUTOPILOT', 'ANTIGRAVITY', 'HEADADJ', 'CAMSTAB', 'BEEPERON', 'LEDLOW', 'CALIB', 'OSD', 'TELEMETRY', 'SERVO1', 'SERVO2', 'SERVO3', 'BLACKBOX', 'AIRMODE', '3D', 'FPVANGLEMIX', 'BLACKBOXERASE', 'CAMERA1', 'CAMERA2', 'CAMERA3', 'CRASHFLIP', 'PREARM', 'BEEPGPSCOUNT', 'VTXPITMODE', 'PARALYZE', 'USER1', 'USER2', 'USER3', 'USER4', 'PIDAUDIO', 'ACROTRAINER', 'VTXCONTROLDISABLE', 'LAUNCHCONTROL', 'MSPOVERRIDE', 'STICKCOMMANDDISABLE', 'BEEPERMUTE', 'READY', 'LAPTIMERRESET', 'WPCAPTURE',
];

export function flightModeNames(fwCode: number): string[] {
  if (fwCode >= 2_026_006_000) return MODES_2026_6;
  if (fwCode >= 2_025_012_000) return MODES_2025_12;
  if (fwCode >= 4_003_000) return MODES_4_3;
  return FLIGHT_MODES;
}

export const STATE_FLAGS = ['GPS_FIX_HOME', 'GPS_FIX', 'CALIBRATE_MAG', 'SMALL_ANGLE', 'FIXED_WING'];
export const FAILSAFE_PHASES = ['IDLE', 'RX_LOSS_DETECTED', 'LANDING', 'LANDED', 'RX_LOSS_MONITORING', 'RX_LOSS_RECOVERED', 'GPS_RESCUE'];

export const EVENT = {
  SYNC_BEEP: 0,
  INFLIGHT_ADJUSTMENT: 13,
  LOGGING_RESUME: 14,
  DISARM: 15,
  FLIGHT_MODE: 30,
  LOG_END: 255,
} as const;

export function bitNames(v: number, names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) if (v & (1 << i)) out.push(names[i]);
  return out;
}
