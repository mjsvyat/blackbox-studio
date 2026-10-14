// PDF-инструкция из docs/dev/instrukciya.html: печать через Chrome/Edge без окна (CDP), без зависимостей.
// node scripts/build-instruction.mjs → docs/Blackbox-Studio-instrukciya.pdf
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const src = path.join(root, 'docs/dev/instrukciya.html');
const out = path.join(root, 'docs/Blackbox-Studio-instrukciya.pdf');
const browsers = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const exe = browsers.find((b) => fs.existsSync(b));
if (!exe) throw new Error('Нужен Chrome или Edge (или переменная CHROME с путём к нему)');

const port = 9700 + Math.floor(Math.random() * 200);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'bbs-pdf-'));
const ch = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try { const p = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { /* ждём браузер */ }
  if (!ws) await sleep(150);
}
if (ws.readyState !== 1) await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Page.navigate', { url: pathToFileURL(src).href });
await sleep(2500);
const r = await send('Page.printToPDF', {
  printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font:8px Segoe UI,Arial;color:#8a93a3;padding:0 16mm;display:flex;justify-content:space-between"><span>Blackbox Studio — инструкция</span><span class="pageNumber"></span></div>',
});
fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'));
ws.close();
ch.kill();
console.log('PDF:', path.relative(root, out), Math.round(fs.statSync(out).size / 1024), 'КиБ');
