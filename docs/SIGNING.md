# Подпись программы для Windows

Без подписи Windows не знает, кто выпустил exe: «Неизвестный издатель» в окне UAC и синее окно
SmartScreen «Windows защитила ваш компьютер». Подпись сразу убирает «неизвестного издателя»;
SmartScreen затихает, когда у подписанной программы накопится репутация (её скачали и запустили
достаточно раз).

Доверенную подпись выдаёт центр сертификации после проверки личности — сгенерировать её
самостоятельно нельзя. Сборка (`desktop/scripts/build.mjs`, `.github/workflows/release.yml`)
умеет подписывать тремя способами; без настроек всё собирается неподписанным, как раньше.

## Основной путь: SignPath Foundation (бесплатно для open source)

SignPath Foundation бесплатно подписывает открытые проекты: сертификат выдан на фонд, подпись
делается в их облаке из сборки GitHub Actions — ключ ни у кого на руках.

**Что сделать (один раз):**

1. Репозиторий публичный, в нём есть лицензия OSI (у нас — MIT, файл `LICENSE`), в README —
   раздел «Подпись кода и приватность» (уже есть).
2. На GitHub включить двухфакторную аутентификацию (SignPath требует её у мейнтейнеров).
3. Подать заявку: <https://signpath.org> → Apply. Указать репозиторий, что подписываем
   (`BlackboxStudio-Setup-*.exe`, `BlackboxStudio-Portable-*.exe`) и что сборка — GitHub Actions.
4. После одобрения в SignPath:
   - создать проект со slug `blackbox-studio`, политику подписи `release-signing`;
   - конфигурация артефакта (GitHub загружает exe одним zip-архивом):
     ```xml
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file path="*.exe" max-matches="unbounded">
           <authenticode-sign />
         </pe-file>
       </zip-file>
     </artifact-configuration>
     ```
   - подключить GitHub как Trusted Build System для проекта;
   - выпустить API-токен (пользователь CI с правом Submitter).
5. На GitHub: Settings → Secrets and variables → Actions:
   - **Secret** `SIGNPATH_API_TOKEN` — токен;
   - **Variable** `SIGNPATH_ORGANIZATION_ID` — ID организации из SignPath;
   - при других именах — Variables `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`.
6. В README заменить строку о рассмотрении на обязательную формулировку:
   «Free code signing provided by SignPath.io, certificate by SignPath Foundation».

Дальше релиз (Actions → Release → Run workflow) сам отправляет exe на подпись, ждёт её, кладёт
подписанные файлы в релиз и пересчитывает `SHA256SUMS.txt`. Шаг «Проверка подписи» печатает
статус каждого exe, в релизе рядом лежит `signing.txt` — чем подписано. Пока секрета нет, шаги
SignPath пропускаются.

## Другие варианты

| Вариант | Цена (проверить на сайте) | Что нужно |
|---|---|---|
| **Свой сертификат** (Certum Open Source, OV от Sectigo, SSL.com…) | от десятков до сотен € в год | покупка и проверка личности; Secrets `WIN_CSC_LINK` (`.pfx` в base64) и `WIN_CSC_KEY_PASSWORD` |
| **Azure Trusted Signing** | ~10 $ в месяц | аккаунт Azure и проверка личности (не во всех странах для частных лиц); Secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER` |
| **Самоподписанный** (`desktop/scripts/make-dev-cert.ps1 -Trust`) | бесплатно | помогает только на своих компьютерах, где сертификат установлен как доверенный |

Сертификат EV с 2024 года больше не даёт мгновенного доверия SmartScreen — переплачивать за
него не нужно.

## Проверить скачанный файл

```powershell
certutil -hashfile BlackboxStudio-Setup-v1.08.27.exe SHA256
```

Сумма должна совпасть со строкой в `SHA256SUMS.txt` из того же релиза. Подпись — правый клик по
exe → «Свойства» → «Цифровые подписи».
