// Состояние вкладки «Полётник» (отдельно от fcStore.ts, чтобы store.ts не импортировал действия).

import type { ApplyResult, BoardSettings, Compat, FcInfo, FcStatus, FlashSummary } from '../fc/client';
import { SerialSupport, serialSupport } from '../fc/webSerial';

export interface FcUi {
  support: SerialSupport;
  phase: 'idle' | 'connecting' | 'connected';
  linkInfo: string;
  info: FcInfo | null;
  compat: Compat | null;
  status: FcStatus | null;
  flash: FlashSummary | null;
  /** подтверждение «пропы сняты» в этом подключении */
  propsOk: boolean;
  busy: null | { kind: 'erase' | 'download' | 'settings' | 'apply' | 'reconnect'; done: number; total: number; t0: number };
  msg: { kind: 'ok' | 'bad' | 'warn'; text: string } | null;
  /** последнее скачанное: имя и размер (сами байты — в downloaded) */
  download: { name: string; size: number } | null;
  retries: number;
  /** B4: настройки, прочитанные с борта (без dump — он большой) */
  settings: Omit<BoardSettings, 'dump'> | null;
  /** B5: что предложено применить (из советчика или примерки): CLI-значения и откуда */
  pending: { to: Record<string, number>; source: string } | null;
  /** построчный ход применения */
  applyRows: { line: string; ok: boolean; error?: string }[];
  /** последнее применение (для отката); хранится и в сессии борта */
  lastApply: ApplyResult | null;
  /** сверка после последней записи: что на борту не совпало */
  verified?: { at: string; ok: boolean; bad: { name: string; want: string; got: string | null }[] } | null;
}

export const initialFc = (): FcUi => ({
  support: serialSupport(),
  phase: 'idle',
  linkInfo: '',
  info: null,
  compat: null,
  status: null,
  flash: null,
  propsOk: false,
  busy: null,
  msg: null,
  download: null,
  retries: 0,
  settings: null,
  pending: null,
  applyRows: [],
  lastApply: null,
});

