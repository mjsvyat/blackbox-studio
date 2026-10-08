// Blackbox Studio для Windows: окно Electron вокруг того же dist/index.html, что открывается
// двойным кликом в браузере. Логика программы — вся в странице; здесь только окно, меню,
// выбор USB-порта для Web Serial (в браузере его рисует Chrome, в Electron — мы) и запрет
// уходить со страницы (внешние ссылки — в браузер).
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');
const path = require('node:path');
const S = require('./strings.cjs');
const meta = require('../package.json');

const REPO = 'https://github.com/mjsvyat/blackbox-studio';
const VERSION = `v${meta.releaseName}`;
const PAGE = path.join(__dirname, '..', 'app', 'index.html');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function portLabel(p) {
  const name = p.displayName && p.displayName !== p.portName ? `${p.displayName} — ${p.portName}` : p.portName || p.portId;
  return name;
}

function setupSession() {
  const ses = session.defaultSession;
  // Web Serial: разрешение на сам API и на уже выбранные порты (getPorts — переподключение
  // после перезагрузки полётника); что-то кроме USB-порта и буфера обмена странице не нужно
  const allowed = new Set(['serial', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setDevicePermissionHandler((d) => d.deviceType === 'serial');
  ses.on('select-serial-port', (event, ports, wc, callback) => {
    event.preventDefault();
    const parent = BrowserWindow.fromWebContents(wc) ?? win;
    if (!ports.length) {
      void dialog.showMessageBox(parent, { type: 'warning', title: S.pickPortTitle, message: S.noPorts, detail: S.noPortsDetail }).then(() => callback(''));
      return;
    }
    const labels = ports.map(portLabel);
    void dialog
      .showMessageBox(parent, { type: 'question', title: S.pickPortTitle, message: S.pickPort, detail: S.pickPortDetail, buttons: [...labels, S.cancel], cancelId: labels.length, defaultId: 0, noLink: true })
      .then((r) => callback(r.response < ports.length ? ports[r.response].portId : ''));
  });
}

function setupMenu() {
  const tpl = [
    { label: S.menuFile, submenu: [{ label: S.menuQuit, role: 'quit' }] },
    {
      label: S.menuView,
      submenu: [
        { label: S.menuReload, role: 'reload' },
        { type: 'separator' },
        { label: S.menuZoomIn, role: 'zoomIn' },
        { label: S.menuZoomOut, role: 'zoomOut' },
        { label: S.menuZoomReset, role: 'resetZoom' },
        { label: S.menuFullscreen, role: 'togglefullscreen' },
        { type: 'separator' },
        { label: S.menuDevTools, role: 'toggleDevTools' },
      ],
    },
    {
      label: S.menuHelp,
      submenu: [
        { label: S.menuProject, click: () => shell.openExternal(REPO) },
        { label: S.menuReleases, click: () => shell.openExternal(`${REPO}/releases`) },
        { label: S.menuData, click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: S.menuAbout, click: () => dialog.showMessageBox(win, { type: 'info', title: S.menuAbout, message: S.about(VERSION, process.versions.electron, process.versions.chrome), icon: ICON }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1216',
    title: `Blackbox Studio ${VERSION}`,
    icon: ICON,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  // заголовок страницы («Blackbox Studio») не должен затирать версию в заголовке окна
  win.on('page-title-updated', (e) => e.preventDefault());
  // со страницы никуда не уходим: перетащенный файл открывает сама страница (а не окно —
  // навигацией на file://…bbl), ссылки наружу — в браузере
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void win.loadFile(PAGE);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  setupSession();
  setupMenu();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
