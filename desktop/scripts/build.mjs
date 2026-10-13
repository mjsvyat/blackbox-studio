// Сборка Windows-программы: dist/index.html (собирается в корне: npm run build) → desktop/app,
// затем electron-builder → desktop/release:
//   BlackboxStudio-Setup-v<версия>.exe    — установщик (ярлыки, удаление через «Приложения»)
//   BlackboxStudio-Portable-v<версия>.exe — без установки, запуск с флешки
//   BlackboxStudio-v<версия>-web.html     — тот же интерфейс одним файлом для браузера
//   SHA256SUMS.txt
// Версия — одна на весь проект: корневой package.json (version — semver, releaseName — как
// пишется в релизе: 1.08.26). Флаг --prepare-only — только скопировать страницу (npm start).
//
// Подпись exe (docs/SIGNING.md) — по переменным окружения, без них сборка неподписанная:
//   CSC_LINK + CSC_KEY_PASSWORD — файл .pfx (путь или base64): купленный сертификат или
//     самоподписанный для своих компьютеров (desktop/scripts/make-dev-cert.ps1);
//   AZURE_SIGN_ENDPOINT + AZURE_SIGN_ACCOUNT + AZURE_SIGN_PROFILE + AZURE_SIGN_PUBLISHER (+ AZURE_TENANT_ID,
//     AZURE_CLIENT_ID, AZURE_CLIENT_SECRET) — Azure Trusted Signing (облачная подпись, ключ не покидает Azure).
import { Arch, build, Platform } from 'electron-builder';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desk = join(here, '..');
const root = join(desk, '..');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deskPkg = JSON.parse(readFileSync(join(desk, 'package.json'), 'utf8'));
const { version, releaseName } = rootPkg;
if (!version || !releaseName) throw new Error('В корневом package.json нужны version и releaseName');
if (deskPkg.version !== version || deskPkg.releaseName !== releaseName) {
  throw new Error(`Версия desktop/package.json (${deskPkg.version} / ${deskPkg.releaseName}) не совпадает с корневой (${version} / ${releaseName})`);
}

const page = join(root, 'dist', 'index.html');
if (!existsSync(page)) throw new Error('Нет dist/index.html — сначала в корне: npm run build');
mkdirSync(join(desk, 'app'), { recursive: true });
copyFileSync(page, join(desk, 'app', 'index.html'));
if (process.argv.includes('--prepare-only')) process.exit(0);

const out = join(desk, 'release');
const env = process.env;
const azure = env.AZURE_SIGN_ENDPOINT && env.AZURE_SIGN_ACCOUNT && env.AZURE_SIGN_PROFILE && env.AZURE_SIGN_PUBLISHER
  ? { publisherName: env.AZURE_SIGN_PUBLISHER, endpoint: env.AZURE_SIGN_ENDPOINT, codeSigningAccountName: env.AZURE_SIGN_ACCOUNT, certificateProfileName: env.AZURE_SIGN_PROFILE }
  : null;
const signing = azure ? 'Azure Trusted Signing' : env.CSC_LINK || env.WIN_CSC_LINK ? 'сертификат .pfx (CSC_LINK)' : null;
console.log(signing ? `Подпись exe: ${signing}` : 'Подпись exe: нет (CSC_LINK / AZURE_SIGN_* не заданы) — Windows покажет «Неизвестный издатель»');
const onWindows = process.platform === 'win32';
await build({
  projectDir: desk,
  targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64),
  config: {
    appId: 'io.github.mjsvyat.blackboxstudio',
    productName: 'Blackbox Studio',
    copyright: `© ${new Date().getFullYear()} mjsvyat`,
    directories: { output: out, buildResources: 'build' },
    files: ['src/**', 'app/**', 'build/icon.png', 'package.json'],
    asar: true,
    electronLanguages: ['ru', 'en-US'],
    win: {
      icon: 'build/icon.png',
      // иконка и версия в exe ставятся rcedit — на Linux для этого нужен Wine; релиз
      // собирается на Windows (GitHub Actions), локальная Linux-сборка — только для проверки
      signAndEditExecutable: onWindows,
      ...(azure ? { azureSignOptions: azure } : {}),
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Blackbox Studio',
      installerLanguages: ['ru_RU'],
      language: '1049',
      // сессии, кампании и борта живут в папке данных — при удалении программы их не трогаем
      deleteAppDataOnUninstall: false,
      artifactName: `BlackboxStudio-Setup-v${releaseName}.exe`,
    },
    portable: { artifactName: `BlackboxStudio-Portable-v${releaseName}.exe` },
    publish: null,
  },
});

copyFileSync(page, join(out, `BlackboxStudio-v${releaseName}-web.html`));
const files = readdirSync(out).filter((f) => /\.(exe|html)$/.test(f) && f.includes(`v${releaseName}`)).sort();
const sums = files.map((f) => `${createHash('sha256').update(readFileSync(join(out, f))).digest('hex')}  ${f}`).join('\n') + '\n';
writeFileSync(join(out, 'SHA256SUMS.txt'), sums);
writeFileSync(join(out, 'signing.txt'), `${signing ?? 'не подписано'}\n`);
console.log(`\nГотово (v${releaseName}):\n${sums}`);
