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
