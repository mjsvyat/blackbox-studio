// Вкладка «Полётник (USB)»: сведения о борте, флешка — стереть / скачать / открыть.

import { armingDisableList } from '../../fc/client';
import { T } from '../../i18n/ru';
import { fmtBytes, fmtTime, h } from '../dom';
import { fcCancel, fcConnect, fcDisconnect, fcDownload, fcErase, fcOpenDownloaded, fcPropsOk, fcRefresh, fcSaveDownloaded, lastErase } from '../fcStore';
import { helpBtn } from '../help';
import { state } from '../store';

const MiB = 1024 * 1024;

/** заворот адреса флешки на 64 МиБ (BF PR #15524): есть во всех версиях до 2026.6.1 включительно */
export function hasWrapBug(version: string): boolean {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return true;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (v[0] < 2000) return true; // 4.x
  return v[0] < 2026 || (v[0] === 2026 && (v[1] < 6 || (v[1] === 6 && v[2] <= 1)));
}

function kv(k: string, v: (HTMLElement | string)[] | HTMLElement | string): HTMLElement {
  return h('tr', null, h('th', null, k), h('td', null, v));
}

export function fcView(): HTMLElement {
  const fc = state.fc;
  const root = h('div', null, h('h2', null, T.fc.title, helpBtn('fc-connect')));
  if (fc.support !== 'ok') {
    root.append(h('div', { class: 'panel warn' }, fc.support === 'insecure' ? T.fc.insecure : T.fc.unsupported));
    return root;
  }
  if (fc.msg) root.append(h('div', { class: `panel ${fc.msg.kind === 'ok' ? 'good' : fc.msg.kind}` }, fc.msg.text));

  if (fc.phase !== 'connected' || !fc.info) {
    root.append(h('div', { class: 'panel' },
      h('p', null, T.fc.intro),
      h('button', { class: 'btn primary', disabled: fc.phase === 'connecting', onclick: () => fcConnect() }, fc.phase === 'connecting' ? T.fc.connecting : T.fc.connect)));
    return root;
  }

  const info = fc.info;
  const st = fc.status;
  if (!fc.propsOk && fc.compat?.ok) {
    root.append(h('div', { class: 'panel bad' },
      h('h3', null, T.fc.propsTitle, helpBtn('fc-safety')),
      h('p', null, T.fc.propsText),
      h('button', { class: 'btn primary', onclick: fcPropsOk }, T.fc.propsOk)));
  }

  const stateCell = st
    ? [
        h('span', { class: `badge ${st.armed ? 'red' : ''}` }, st.armed ? T.fc.armed : T.fc.disarmed),
        ...(() => {
          const l = armingDisableList(st.armingDisableFlags, st.armingDisableCount);
          return l.length ? [h('span', { class: 'muted small' }, T.fc.armBlock(l.join(', ')))] : [];
        })(),
        st.rebootRequired ? h('span', { class: 'badge yellow' }, T.fc.rebootReq) : '',
      ]
    : '—';
  root.append(h('div', { class: 'panel' },
    h('table', { class: 'grid kv' }, h('tbody', null,
      kv(T.fc.board, `${info.manufacturerId} ${info.boardName || info.targetName}`.trim() + (info.targetName && info.boardName ? ` (${info.targetName})` : '')),
      kv(T.fc.fw, `${info.variant === 'BTFL' ? 'Betaflight' : info.variant} ${info.versionText || info.version}${info.gitRev ? ` (${info.gitRev})` : ''}`),
      kv(T.fc.api, `${info.api[0]}.${info.api[1]}`),
      kv(T.fc.craft, info.craftName || T.fc.noName),
      kv(T.fc.uid, h('code', null, info.uid || '—')),
      kv(T.fc.state, stateCell))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn small', disabled: !!fc.busy, onclick: () => fcRefresh() }, T.fc.refresh),
      h('button', { class: 'btn small', onclick: () => fcDisconnect() }, T.fc.disconnect),
      h('span', { class: 'muted small' }, fc.linkInfo))));

  if (fc.compat && !fc.compat.ok) {
    root.append(h('div', { class: 'panel bad' }, fc.compat.why === 'variant' ? T.fc.compatVariant(info.variant) : T.fc.compatApi(`${info.api[0]}.${info.api[1]}`)));
    return root;
  }

  // --- флешка ---
  const fl = fc.flash;
  const flash = h('div', { class: 'panel' }, h('h3', null, T.fc.flash, helpBtn('fc-flash')));
  root.append(flash);
  if (!fl) return root;
  if (!fl.supported) {
    flash.append(h('p', null, T.fc.flashNone));
    return root;
  }
  const pct = fl.totalSize ? (fl.usedSize / fl.totalSize) * 100 : 0;
  flash.append(
    h('div', { class: 'meter' }, h('div', { style: `width:${Math.min(100, pct).toFixed(1)}%` })),
    h('p', null, T.fc.used(fmtBytes(fl.usedSize), fmtBytes(fl.totalSize), pct), ' · ', h('span', { class: fl.ready ? '' : 'badge yellow' }, fl.ready ? T.fc.flashReady : T.fc.flashBusy)));
  if (fl.totalSize > 64 * MiB && hasWrapBug(info.version)) flash.append(h('p', { class: 'small', style: 'color:var(--yellow)' }, T.fc.wrapWarn));
  const le = info.uid ? lastErase(info.uid) : null;
  if (le) flash.append(h('p', { class: 'muted small' }, T.fc.lastErase(new Date(le).toLocaleString('ru'))));

  const armed = st?.armed ?? true;
  const busy = !!fc.busy;
  if (fc.busy) {
    const b = fc.busy;
    const el = (Date.now() - b.t0) / 1000;
    let text: string;
    let frac = 0;
    if (b.kind === 'erase') {
      text = T.fc.erasing(b.done / 1000);
      frac = Math.min(0.95, b.done / 30000);
    } else {
      frac = b.total ? b.done / b.total : 0;
      const speed = el > 0 ? b.done / el : 0;
      text = T.fc.downloading(fmtBytes(b.done), fmtBytes(b.total), fmtBytes(speed), speed > 0 ? fmtTime((b.total - b.done) / speed) : '…');
    }
    flash.append(
      h('div', { class: 'meter accent' }, h('div', { style: `width:${(frac * 100).toFixed(1)}%` })),
      h('div', { class: 'row' }, h('span', null, text), fc.retries ? h('span', { class: 'muted small' }, T.fc.retries(fc.retries)) : '',
        h('button', { class: 'btn small', onclick: fcCancel }, b.kind === 'erase' ? T.fc.stopWaiting : T.fc.cancel)));
  } else {
    flash.append(h('div', { class: 'row' },
      h('button', { class: 'btn primary', disabled: !fl.ready || !fl.usedSize, onclick: () => fcDownload(false) }, T.fc.download(fmtBytes(fl.usedSize))),
      helpBtn('fc-download'),
      h('button', { class: 'btn', disabled: !fl.ready, title: T.fc.downloadAllHint, onclick: () => fcDownload(true) }, T.fc.downloadAll(fmtBytes(fl.totalSize))),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', disabled: busy || armed || !fc.propsOk || !fl.ready, title: armed ? T.fc.eraseArmed : '', onclick: () => fcErase() }, T.fc.erase),
      helpBtn('fc-erase')));
  }
  if (fc.download && !busy) {
    flash.append(h('div', { class: 'row', style: 'margin-top:8px' },
      h('span', { class: 'muted' }, `${fc.download.name} · ${fmtBytes(fc.download.size)}`),
      h('button', { class: 'btn small', onclick: () => fcSaveDownloaded() }, T.fc.save),
      h('button', { class: 'btn small', onclick: fcOpenDownloaded }, T.fc.openAgain)));
  }
  return root;
}
