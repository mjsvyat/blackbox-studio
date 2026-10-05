// Состояние вкладки «Полётник» (отдельно от fcStore.ts, чтобы store.ts не импортировал действия).

import type { Compat, FcInfo, FcStatus, FlashSummary } from '../fc/client';
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
  busy: null | { kind: 'erase' | 'download'; done: number; total: number; t0: number };
  msg: { kind: 'ok' | 'bad' | 'warn'; text: string } | null;
  /** последнее скачанное: имя и размер (сами байты — в downloaded) */
  download: { name: string; size: number } | null;
  retries: number;
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
});

