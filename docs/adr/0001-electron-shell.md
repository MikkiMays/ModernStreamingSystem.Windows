# ADR 0001 — оболочка Cord для Windows на Electron

- **Статус:** предложено (E01, этап A), 19.10.2026. Технология — решение владельца (T53, `DECISIONS.md` П1); этот ADR решает, **как** строить, и что доказывает прототип.
- **Изменено 20.10.2026** (решение владельца по T58): обновление — заставкой при запуске, как у Discord (§5.1); обратной совместимости со старыми клиентами нет — ни прокладки моста v1 (§3.2), ни переходного Inno-выпуска (§7.2).
- **Область:** новый клиент Windows вместо WinUI 3 + WebView2 (`src/Cord.Windows`, 0.7.x).
- **Версии на дату решения:** Electron 44.9 (stable), electron-builder 26.15 (27 — alpha), electron-updater 6.8, @napi-rs/cli 3.10, livekit-client 2.23. Electron поддерживает три последних мажора с циклом ~8 недель, поэтому мажор обновляем не реже раза в 16 недель ([timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)).

## Коротко для владельца

**Что даёт Electron по сравнению с WebView2.** Cord везёт свой Chromium, как Discord, и больше не зависит от Edge, стоящего в Windows.

- По ПКМ браузерного меню нет вообще — только наше (T42).
- Экран и окно захватываются тем же механизмом Windows (Windows.Graphics.Capture), но источник выбирает наш интерфейс, а не браузерный диалог.
- Есть окно поверх игр для оверлея.
- Из коробки: кнопки на миниатюре в панели задач, значок поверх иконки, список переходов, уведомления с кнопками, запрет сна в звонке, Mica.
- Интерфейс встречи, как и сейчас, приходит с сервера Cord: исправления доходят без переустановки.

**Что сделаем своими модулями.** Небольшой нативный модуль на Rust (`cord-native`):

1. push-to-talk с отпусканием клавиши и кнопками мыши поверх игр — `globalShortcut` в Electron «отпускания» не знает;
2. звук только показываемого приложения или «весь звук, кроме Cord» — чтобы участники не слышали в демонстрации себя;
3. чтение старого профиля под DPAPI — избранное переезжает без потерь;
4. для оверлея — где сейчас игра и на каком мониторе. Процесса игры модуль не касается.

**Чего не делаем:** не внедряемся в игры (DirectX-хуки) — с этим конфликтуют античиты, включая FACEIT.

**Цена:**

- установщик ожидается ~90–120 МБ — **меньше** нынешних ~300 МБ (внутри них WebView2 и .NET);
- память в покое ~130–200 МБ, как у приложений класса Discord;
- точные цифры даст прототип (§10).

**Обновления:** только с сервера Cord, подписанные, небольшими кусками. При запуске — маленькая заставка, как у Discord: проверка, загрузка, установка, и только потом окно. Перехода со старого клиента нет: Electron ставится с `/download`, профиль, избранное и серверы читаются из прежних файлов.

## Сводка решений

| # | Вопрос | Решение |
|---|---|---|
| 1 | Где код | `desktop/` в корне `ModernStreamingSystem.Windows`; WinUI в `src/` живёт до замены |
| 2 | Интерфейс | React-клиент **с сервера Cord** (как сейчас) + локальные страницы `cord-app://` (загрузка, офлайн, оверлей) |
| 2 | Безопасность | `sandbox`, `contextIsolation`, без Node в рендерере, узкий preload, каждый IPC проверяет origin, навигация только в origin сервера, fuses |
| 3 | Мост | `window.cordDesktop` (протокол 2, флаги возможностей); прокладки `window.chrome.webview` нет — веб выходит вместе с клиентом |
| 4 | Захват | `getDisplayMedia` → `setDisplayMediaRequestHandler` + своё окно выбора; звук приложения — WASAPI process loopback в `cord-native` |
| 4 | Клавиши | Raw Input (`RIDEV_INPUTSINK`) в `cord-native`: keydown/keyup, мышь; `globalShortcut` — запасной путь |
| 4 | Оверлей | Прозрачное окно поверх всех, клики проходят сквозь него, из захвата исключено; без инъекций |
| 5 | Обновления | Заставка при запуске (§5.1); electron-updater, generic-провайдер на `/downloads/windows/desktop/`; Ed25519-подпись манифеста + sha512 + Authenticode (когда будет сертификат); дельты по blockmap |
| 6 | Установщик | NSIS из electron-builder, мастер со своими страницами; не Squirrel и не свой загрузчик (таблица §6) |
| 7 | Переход | Те же DPAPI-файлы читаются как есть; переходного выпуска нет — Electron ставится с `/download` |
| 8 | Каталог | Подписанный JWS (EdDSA/Ed25519) из ядра: `servers[]` = id, name, country (ISO 3166-1 alpha-2), url, order; ключи вшиты в клиент |
| 9 | CI | `desktop.yml` на windows-2022, артефакт хранится 1 день, подпись — через секреты (без них — неподписанная сборка) |

## 1. Где живёт код

**Подтверждаю:** новый каталог `desktop/` в корне `ModernStreamingSystem.Windows`.

- Здесь уже лежит всё, что относится к выпуску под Windows: CI на windows-2022, секреты подписи `CORD_SIGN_*`, `scripts/test-installer.ps1`, заметки выпусков, договорённость с зеркалом `/downloads/windows/`.
- **Репозиторий ядра** не подходит: его CI (Java и веб) и так упирается в квоту артефактов, секреты подписи Windows там не нужны, ритм выпусков другой.
- **Отдельный репозиторий** — это второй CI, вторые секреты и второй журнал выпусков ради одного клиента.
- **Общий контракт с вебом** живёт в ядре: `contracts/desktop-bridge.v2.schema.json` и `contracts/server-catalog.v1.schema.json`. В `desktop/` лежит копия, тест сверяет её хэш — так же, как `BridgeProtocol.cs` сейчас повторяет список веба.

```
desktop/
  package.json, package-lock.json, electron-builder.yml, tsconfig.json
  src/main/      окна, мост, обновление, каталог, перенос, разрешения, трей, панель задач
  src/preload/   server.ts (узкий API), shell.ts (локальные страницы)
  src/shell/     cord-app:// — заставка обновления, загрузка (E16/П14), офлайн, окно выбора источника, оверлей (Vite)
  native/        cord-native: Rust + napi-rs (клавиши, звук, DPAPI, окна)
  build/         installer.nsh, картинки мастера (E16), иконки, тексты по языкам
  test/          vitest (модули), Playwright _electron (e2e на раннере)
```

`src/Cord.*` и `windows.yml` не трогаем, пока новый клиент не прошёл приёмку (E01-B, п. 11).

## 2. Процессы и безопасность

### 2.1 Процессы

| Процесс | Что внутри | Доступ |
|---|---|---|
| main (Node) | Окна, трей, маршрутизатор моста с проверками, обновление, каталог, настройки, перенос, обработчики разрешений | Полный; страниц не исполняет |
| utility `native` ([utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)) | `cord-native.node`: Raw Input, process loopback, DPAPI, переднее окно | Только через MessagePort от main. Если упал — функции отключаются, main перезапускает процесс |
| renderer «сервер» | React-клиент `https://<сервер>/` | `sandbox: true`, без Node, preload `server.ts` |
| renderer «оболочка» | `cord-app://shell/…`: заставка обновления, загрузка, офлайн, ошибка, выбор источника | `sandbox: true`, preload `shell.ts` |
| renderer «оверлей» | `cord-app://overlay/` | `sandbox: true`, только получает состояние |
| GPU, сеть, аудио | Служебные процессы Chromium | — |

Нативный модуль вынесен в utility-процесс по трём причинам:

1. в рендерере с песочницей его не загрузить;
2. Raw Input даёт одному процессу одно окно-приёмник на класс устройств, а в процессе browser им уже пользуется Chromium;
3. падение нативного кода не должно ронять звонок.

**Главное окно** — одно `BrowserWindow` на сессию `persist:cord`. Хранилища серверов и так разделены по same-origin, а одна сессия позволяет менять сервер обычной навигацией. Настройки:

- `titleBarStyle: 'hidden'` + `titleBarOverlay` (36 px, цвета по теме); шапку с маркой (T01) рисует веб в режиме приложения (Window Controls Overlay, `app-region: drag`);
- `backgroundMaterial: 'mica'`;
- `backgroundThrottling: false` — свёрнутое окно в звонке не замедляет таймеры;
- `autoplayPolicy: 'no-user-gesture-required'` вместо нынешнего ключа WebView2.

**Старт:** сначала заставка обновления (§5.1) — отдельное маленькое окно; главное окно создаётся только после неё. Затем локальная `cord-app://shell/loading` (упакованный компонент загрузки E16) → в фоне рукопожатие (`POST /api/v1/session`, пароль из DPAPI) → `loadURL(origin)`. **Смена сервера:** подтверждение выхода из встречи → загрузка → новый origin.

### 2.2 Откуда грузить интерфейс

| | С сервера Cord (как сейчас) | Упакованный в приложение |
|---|---|---|
| Исправления интерфейса | Приходят с выкладкой сервера, без переустановки | Только новым выпуском клиента |
| Совместимость веба и ядра | Одна версия: выкатываются вместе | Клиент 1.2 против ядра 1.5 и наоборот — нужна матрица версий API |
| Проверка `Origin` в ядре | Работает как есть: ядро принимает только свой origin | Ядру пришлось бы разрешить `cord-app://` — ослабить защиту для всех |
| Старт без сети | Своя страница «нет связи» из оболочки; повторный старт быстрый (хэшированные бандлы в HTTP-кэше Chromium) | Интерфейс откроется, но без сервера встречи всё равно нет |
| Каталог серверов (П4) | У каждого сервера свой веб — естественно | Один интерфейс на серверы с разными версиями ядра |

**Решение:** интерфейс встречи — с сервера. Упакована только оболочка (заставка обновления, загрузка, офлайн, ошибки, выбор источника, оверлей). Для разговора офлайн-старт ничего не даёт, а расхождение веба и ядра стоит дорого.

### 2.3 Настройки безопасности

По [контрольному списку Electron](https://www.electronjs.org/docs/latest/tutorial/security):

| Мера | Как |
|---|---|
| Изоляция | `contextIsolation`, `sandbox`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `webviewTag: false`; `devTools: false` в выпуске (диагностическая сборка — отдельным флагом) |
| Узкий мост | `contextBridge.exposeInMainWorld('cordDesktop', …)`: только функции с данными — никакого `ipcRenderer`, путей, `shell` ([context-bridge](https://www.electronjs.org/docs/latest/api/context-bridge)) |
| Проверка IPC | Каждый `ipcMain.handle/on` проверяет `event.senderFrame`: верхний кадр, `origin` = выбранный сервер (или `cord-app://shell` для своего списка вызовов), JSON ≤ 16 КиБ, схема как в `BridgeProtocol.Read` (UUID комнаты, код из 9 цифр, аватар `data:image/` ≤ 4 КиБ, имя ≤ 40) |
| Навигация | `will-navigate`, `will-frame-navigate`, `will-redirect` — только origin сервера (схема, хост, порт, как `ServerEndpoint.Owns`) и `about:blank`; `setWindowOpenHandler` → `deny`; внешняя `https`-ссылка по жесту — `shell.openExternal` после проверки схемы; `will-attach-webview` → запрет |
| Разрешения | `setPermissionRequestHandler` и `setPermissionCheckHandler`: только origin сервера и только `media` (камера/микрофон по `details.mediaTypes`, свой диалог при первом запросе), `display-capture`, `notifications`, `fullscreen`, `clipboard-sanitized-write`. Остальное (геолокация, MIDI, HID, USB, serial, `openExternal`) — запрет; `setDevicePermissionHandler` → `false` |
| Загрузки | `will-download` — только с origin сервера или его `blob:`, как сейчас |
| TLS | `certificate-error` не переопределяется никогда; HTTP — только loopback (как `ServerEndpoint.Parse`) |
| CSP | Сервер отдаёт свой заголовок (`infra/Caddyfile`: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; … frame-ancestors 'none'`). Main проверяет в `webRequest.onHeadersReceived`, что заголовок у главного документа есть, иначе подставляет базовый. Для `cord-app://` — строгий CSP в ответе `protocol.handle` (`default-src 'self'; script-src 'self'; connect-src 'none'`), схема зарегистрирована как `standard, secure` |
| Fuses | `runAsNode: false`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`, `enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true`, `enableCookieEncryption: true`, `grantFileProtocolExtraPrivileges: false` ([fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)) |
| Один экземпляр | `requestSingleInstanceLock`; `cord://` и пункты списка переходов приходят через `second-instance` |

## 3. Мост: `window.cordDesktop`

### 3.1 API

```ts
interface CordDesktop {
  readonly protocol: { major: 2; minor: number };      // мажор меняется только при несовместимости
  readonly features: readonly string[];                // 'ptt', 'capture.app-audio', 'overlay', 'thumbar', …
  readonly app: { version: string; arch: 'x64' };
  readonly bootstrap: Bootstrap;                       // то же, что писал BridgeProtocol.Bootstrap
  send(type: PageMessage, payload?: object): void;     // страница → оболочка
  invoke(method: PageCall, payload?: object): Promise<unknown>; // запрос/ответ
  on(type: HostMessage, listener: (data: object) => void): () => void; // оболочка → страница
}
```

- Веб проверяет **флаги возможностей**, а не номера версий. Неизвестные типы отбрасываются и пишутся в журнал.
- `bootstrap` preload получает один раз на документ (`ipcRenderer.sendSync`, несколько КБ) и пишет его в те же ключи, что и WinUI, — веб читает их и здесь:
  - `localStorage`: `cord:profile:v1`, `cord:theme`, `cord:preferences:v1`, `cord:servers:v1`;
  - `sessionStorage`: `cord:session:v1` и `:fresh`;
  - `dataset.desktop`.
- Секрет профиля отдаётся только тому origin, которому принадлежит (отдельный файл на origin, как сейчас).

### 3.2 Прокладки v1 нет

Решение владельца 20.10.2026: клиентов ещё нет, и совместимость со старыми не нужна. Preload не подставляет `window.chrome.webview`, а веб, который о `window.cordDesktop` не знает, в Electron просто не видит оболочку. Веб переходит на мост v2 в том же выпуске, что и клиент: `core/desktop.ts` берёт `window.cordDesktop ?? window.chrome?.webview` (второе — для WinUI, пока он жив), 10 проверок `window.chrome?.webview` заменяются на `isDesktop()`.

### 3.3 Сообщения

| WinUI, v1 (страница → оболочка) | v2 | Назначение |
|---|---|---|
| `state` | `state` | Страница, имя, аватар, комната → трей, список переходов, заголовок |
| `call-state` | `call.state` (+ `mic`, `camera`, `screen`, `room`) | Кнопки на миниатюре, значок поверх иконки, `powerSaveBlocker`, оверлей |
| `hotkey.configure` | `hotkeys.configure` | Действия `mic.toggle`, `ptt`, `deafen`, `overlay.toggle`; режим `toggle`/`hold`; клавиши и кнопки мыши (модель — E03) |
| `favorites.changed` | `favorites.changed` | Закреплённые комнаты в списке переходов |
| `preferences.changed`, `server.autoconnect` | без изменений | Настройки приложения |
| `servers.open` | `servers.open` | Список серверов (каталог) |
| `session.expired` | `invoke('session.renew')` → токен | Запрос/ответ вместо пары сообщений |
| `close-ready` | `close.ready` | Закрытие в звонке (ждём ≤ 2,5 с, как сейчас) |
| `update.version`, `update.check`, `update.apply` | `invoke('update.status')`, `update.check`, `update.apply` | «О программе» |
| — | `invoke('capture.sources')`, `capture.select` | Своё окно выбора источника и режим звука (§4.1) |
| — | `overlay.state` | Участники и кто говорит (≤ 10 Гц), без аватаров |
| — | `notify`, `attention`, `progress`, `badge` | Уведомление с действиями, мигание кнопки, прогресс файла, значок непрочитанного |

| WinUI, v1 (оболочка → страница) | v2 | Назначение |
|---|---|---|
| `microphone.toggle` | `hotkey` `{action, phase: 'down'\|'up'}` | Push-to-talk требует фазы |
| `hotkey.status` | `hotkeys.status` | Что удалось зарегистрировать |
| `navigate`, `theme.changed`, `preferences.changed`, `settings.open`, `favorite.settings`, `favorites.changed`, `profile.changed`, `network.changed`, `close-request`, `update.status`, `session.token` | те же имена через `on()` | Смысл прежний |
| — | `thumbar` `{action: mic\|camera\|leave}`, `deeplink` `{room}`, `notification.action`, `power` `{suspend\|resume\|lock}`, `capture.ended` | Новые возможности |

## 4. Нативные возможности

### 4.1 Захват экрана, окна, игры и звука

**Что даёт Electron.** Веб вызывает `getDisplayMedia`, а main отвечает в `session.setDisplayMediaRequestHandler` источником из `desktopCapturer.getSources` ([session](https://www.electronjs.org/docs/latest/api/session), [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)). На Windows захватом в Chromium занимается `WgcCapturerWin` (Windows.Graphics.Capture). В текущем [`webrtc_features.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/webrtc/webrtc_features.cc) флагов «разрешить WGC» уже нет — остались только `WebRtcWgcRequireBorder` (рамка, по умолчанию выкл.) и `WebRtcAllowWgcUsingTexture`. Значит, WGC — путь по умолчанию; прототип это подтверждает. Кодирует WebRTC Chromium, аппаратно через Media Foundation, если GPU умеет.

**Своё окно выбора** рисует веб по дизайну E16, как в Discord:

1. `invoke('capture.sources')` — экраны и окна с миниатюрами (≤ 320 px) и иконками; видит только origin сервера.
2. `capture.select {id, audio: 'none'|'app'|'system-except-cord'}` — выбор живёт 10 с, только для этого кадра и при жесте пользователя.
3. Веб вызывает `getDisplayMedia`, и обработчик в main отдаёт именно этот источник.

Публикация в LiveKit — по правилам качества E05 (П2: потолок 1080p60, кадр целевого качества раньше показа).

**Свой WGC-модуль не пишем.** Кадры 1080p60 (≈ 480 МБ/с) пришлось бы гнать между процессами в WebRTC браузера, а Chromium делает это внутри себя. Вернёмся к нему, только если прототип покажет < 55 fps или не захватит игру в borderless.

**Звук.** Electron умеет только `audio: 'loopback'` / `'loopbackWithMute'`, то есть весь звук системы. Туда попадают и голоса комнаты, которые играет сам Cord, — участники услышат себя. Поэтому:

| Режим | Как | Где |
|---|---|---|
| Звук приложения (показ окна) | WASAPI process loopback, `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` для PID окна (HWND из id источника `window:<hwnd>:0` → `GetWindowThreadProcessId`) | `cord-native` |
| Весь звук, кроме Cord (показ экрана) | Тот же API, `EXCLUDE_TARGET_PROCESS_TREE` для дерева процессов Cord (аудиосервис Chromium — дочерний) | `cord-native` |
| Без звука | — | — |

- **Версии Windows.** Документированный минимум [AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params) — build 20348, но на деле API работает с Windows 10 2004 (19041): так им пользуется OBS ([Application Audio Capture](https://obsproject.com/kb/application-audio-capture-guide)). Наш `MinVersion` уже 10.0.19041.
- **Если активация не удалась** — показ идёт без звука, с подсказкой. Системный звук с эхом не включаем.
- **Дорога звука:** PCM 48 кГц / 10 мс → MessagePort (utility → renderer, [message-ports](https://www.electronjs.org/docs/latest/tutorial/message-ports)) → AudioWorklet → `MediaStreamAudioDestinationNode` → дорожка `ScreenShareAudio` в LiveKit. Это ~384 КБ/с, задержка ~10–20 мс.
- **Проверить в прототипе** экспериментальное ограничение `restrictOwnAudio` (LiveKit его уже пробрасывает): если Chromium в Electron 44 исполняет его на Windows, режим «кроме Cord» получится без своего кода.

### 4.2 Глобальные клавиши и push-to-talk

[`globalShortcut`](https://www.electronjs.org/docs/latest/api/global-shortcut) — это `RegisterHotKey`: нет keyup, нет кнопок мыши, а сочетание **отбирается** у остальных программ, включая игру ([RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)).

| Вариант | keyup/мышь | Отбирает клавишу | Лицензия | Решение |
|---|---|---|---|---|
| `globalShortcut` | нет | да | MIT | Запасной путь для `mic.toggle` с Ctrl/Alt (как сейчас), если `cord-native` недоступен |
| `uiohook-napi` (WH_KEYBOARD_LL / WH_MOUSE_LL) | да | нет | Привязка MIT, внутри статический libuiohook — **LGPL-3.0** ([npm](https://www.npmjs.com/package/uiohook-napi)) | Нет: LGPL в закрытом продукте требует давать перелинковку; в JS уходит поток **всех** нажатий |
| Свой модуль: Raw Input, `RIDEV_INPUTSINK` ([RAWINPUTDEVICE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)) | да | нет | Наш код (napi-rs — MIT, windows-rs — MIT/Apache-2.0) | **Да.** Скрытое окно в своём потоке utility-процесса; наружу — только события зарегистрированных сочетаний `{id, phase}`. Без хуков, без задержки системному вводу |
| Свой WH_KEYBOARD_LL | да | нет | наш | Только если Raw Input где-то не доходит (решает прототип) |

Ограничение UIPI: если игра запущена от администратора, а Cord — нет, Windows не доставит ему ввод, пока игра на переднем плане. Так же ведёт себя Discord — пишем в подсказке настройки. Клавиши работают всегда, пока включены (T27); модель сочетаний общая с E03.

### 4.3 Оверлей в играх (T23)

Отдельное `BrowserWindow` на `cord-app://overlay/` ([BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)):

- `transparent`, `frame: false`, `focusable: false`, `skipTaskbar`;
- `setAlwaysOnTop(true, 'screen-saver')`;
- `setIgnoreMouseEvents(true)` — клики проходят в игру;
- `setContentProtection(true)` — на Windows 10 2004+ это `WDA_EXCLUDEFROMCAPTURE`: в нашу же демонстрацию оверлей не попадает.

Список участников стоит в левом верхнем углу монитора, где переднее окно занимает весь экран. Это определяет `cord-native` через `GetForegroundWindow` + `MonitorFromWindow`, **не открывая** процесс игры. Говорящие подсвечены градацией E04; данные приходят из `overlay.state` не чаще 10 Гц.

**Чего нет:** DLL в процессе игры, хуков DirectX/Present, `OpenProcess` на игру, чтения её памяти. На этот же класс перешёл Discord: новый оверлей больше не лезет в игру и «не злит античиты» ([Discord, 2025](https://discord.com/blog/player-release-q12025)).

**Ограничения:**

- в эксклюзивном полноэкранном режиме DirectX окно поверх не видно; оконный режим и borderless работают (T23 это и просит);
- внешние ESP-читы тоже рисуют прозрачными окнами, поэтому отдельный античит может такое окно прятать — проверка с FACEIT (CS2) обязательна в приёмке E01-B;
- по умолчанию оверлей **выключен**: включается переключателем и клавишей, виден только в звонке.

### 4.4 Мягкое взаимодействие с Windows (T53)

Всё — штатный Electron, без своего кода, с переключателями в настройках (E03) ([windows-taskbar](https://www.electronjs.org/docs/latest/tutorial/windows-taskbar), [Notification](https://www.electronjs.org/docs/latest/api/notification)).

| Возможность | API | По умолчанию |
|---|---|---|
| Кнопки на миниатюре: микрофон, камера, завершить | `win.setThumbarButtons` (≤ 7) | вкл. в звонке |
| Значок поверх иконки: «во встрече», «микрофон выкл.» | `win.setOverlayIcon` | вкл. |
| Список переходов: «Новая встреча», последние и закреплённые комнаты | `app.setJumpList` → `cord://room/<код>` | вкл. |
| Уведомления с кнопками и ответом | `Notification` (`actions`, `reply`), `Notification.handleActivation` | вкл. для упоминаний и приглашений |
| Мигание кнопки окна при упоминании | `win.flashFrame` | вкл., если окно не в фокусе |
| «Не беспокоить» / Focus Assist | соблюдает сама Windows | — |
| Mica/Acrylic, тема, акцент | `backgroundMaterial`, `nativeTheme`, `systemPreferences.getAccentColor` | Mica вкл. (Windows 11 22H2+) |
| Запрет сна | `powerSaveBlocker.start('prevent-display-sleep')` | вкл. в звонке и при показе экрана |
| Медиаклавиши и SMTC (музыка, кинозал) | Media Session API в вебе — Chromium сам связывает его с SMTC; `globalShortcut` на медиаклавиши не ставим, чтобы не отбирать их у плееров | вкл. |
| Прогресс загрузки файла чата | `win.setProgressBar` | вкл. |
| Трей: микрофон, выйти, закрыть | `Tray` | вкл. |
| Автозапуск | `app.setLoginItemSettings` | **выкл.** |
| Deep links `cord://` | `setAsDefaultProtocolClient` + запись в HKCU установщиком | вкл. |

### 4.5 Контекстное меню (T42)

Своего меню по ПКМ в Electron нет вовсе. Обрабатываем `webContents.on('context-menu')`:

- **в полях ввода** — «Вырезать / Копировать / Вставить / Выделить всё» на языке интерфейса и подсказки орфографии (`params.dictionarySuggestions`, на Windows — системная проверка);
- **на выделенном тексте** — «Копировать»;
- **в остальных местах** — ничего: веб открывает своё меню (E02, T40).

«Проверить», «Сохранить как», «Поиск» взяться неоткуда.

### 4.6 Состав `cord-native`

Rust + [napi-rs](https://napi.rs). N-API — сборка одна на все версии Electron. Модуль загружается только в utility-процессе:

- `hotkeys` — Raw Input;
- `audio` — process loopback include/exclude;
- `dpapi` — `CryptProtectData`/`CryptUnprotectData` с энтропией, CurrentUser;
- `windows` — переднее окно, монитор, полноэкранность, PID по HWND;
- `net` — `NotifyAddrChange` для `network.changed` (как нынешний `NetworkAddressChanged`).

Каждая функция объявляет себя во `features`. Если её нет, веб показывает понятный отказ и не ломается.

## 5. Обновления — только с серверов Cord

**Канал.** electron-updater, `NsisUpdater`, `provider: generic`, `url: https://<главный>/downloads/windows/desktop/` ([auto-update](https://www.electron.build/features/auto-update)).

- Адрес **вшит при сборке** и не следует за выбранным сервером встреч — правило `CordDefaults.cs`: «вход в чужую комнату не должен решать, какой исполняемый файл поставится».
- Боевой адрес — хост нынешнего зеркала (после переезда он укажет на новый сервер); сборки прототипа ходят на `cord.nikg.tech`.
- Встроенный `autoUpdater` Electron (Squirrel) не используем.

**Без GitHub:**

- в `package.json` нет `repository` и `homepage` — иначе electron-builder сам выберет GitHub-провайдер, а `homepage` впишет в `HelpLink` и `URLInfoAbout` карточки Windows (видно в шаблоне `installer.nsh`);
- в `electron-builder.yml` явно `publish: generic`.

**Зеркало.**

- В `desktop/` лежат `latest.yml`, `Cord-Setup-X.Y.Z.exe` и `.exe.blockmap`. `download.json` в корне — описание для страницы `/download` и для WinUI, пока он жив; Electron его не читает.
- `publish-windows-release.py` получает режим `desktop`. Как и сейчас: сверяет sha512 и подпись, пишет файлы, `latest.yml` меняет последним, держит `--keep 2` (предыдущий выпуск нужен для дельт).

**Проверка, по слоям:**

1. **Ed25519-подпись манифеста** ключом из вшитого списка `[текущий, следующий]` — ключ меняется без «дня X». В electron-builder 27 это встроено и отказывает при неверной подписи ([signed update manifests](https://www.electron.build/features/signed-update-manifests)). Пока 27 в alpha, на 26.x работает свой провайдер-наследник generic: проверяет `latest.yml.sig` через `node:crypto`.
2. **sha512 и размер** установщика — встроено в electron-updater.
3. **Authenticode** (`win.verifyUpdateCodeSignature`, `publisherName`) — когда владелец даст сертификат. Без него electron-updater проверку пропускает (fail-open), поэтому слой 1 обязателен.
4. Только HTTPS без переопределения сертификатов; провайдер отвергает URL файлов вне origin канала.

**Дельты** — blockmap NSIS: качаются только изменившиеся блоки, при сбое updater сам переходит на полную загрузку. Правка JS и ресурсов — единицы МБ; смена мажора Electron — почти весь установщик (§10).

**Поведение** — как в `docs/updating.md`: заставка при запуске (§5.1):

- проверка — на заставке, раньше главного окна, и раз в 6 ч, пока Cord открыт;
- в звонке не качаем и не ставим;
- отказ установщика виден на следующем запуске: `app.getVersion()` сверяется с ожидаемой, причина — строкой на заставке.

### 5.1 Заставка обновления при запуске (T58)

Владелец, 19.10.2026: «при запуске корда проверять его версию и если есть новая, то принудительно начинай обновление. Версию отображать только в разделе "О программе"». 20.10.2026: «Нужно как в дискорде сделать, сначала микро плашка при открытии приложения, где проверка обновления, обновление, если оно есть, и только после этого открывать приложение. То есть вообще не нужно соблюдать обратную совместимость». WinUI делает это с 0.7.8 (`docs/updating.md`, `Cord.Core/ForcedUpdate.cs`, `SplashWindow`); Electron обязан вести себя **так же**:

- **Сначала заставка.** В `app.whenReady()` первым создаётся маленькое окно — `BrowserWindow` 300×360, `frame: false`, `resizable: false`, `roundedCorners: true`, тёмный фон, по центру экрана — со страницей `cord-app://shell/splash`: знак Cord и одна строка. Главное окно и страница сервера создаются **только после неё**; заставка закрывается, когда главное окно показано.
- **Строки:** «Проверяем обновления…» (`checkForUpdates()`, срок ответа — 5 с) → «Загружаем обновление… 42%» с тонкой полосой (`downloadUpdate()`, событие `download-progress`) → «Устанавливаем…» → `quitAndInstall(true, true)` — тихо и с перезапуском. Плашки «Перезапустить» и `autoInstallOnAppQuit` как основного пути нет.
- **Не ломать запуск:** зеркало молчит, 5xx, 404, неверный или неподписанный манифест — заставка открывает Cord, а он переспросит через 10 минут. Откатов нет (`allowDowngrade: false`).
- **Не запирать:** сбой загрузки, проверки или установки — короткая строка на заставке, «Повторить» и ссылка «Открыть Cord»; загрузка, молчащая дольше минуты, считается вставшей. Отказ установщика (после перезапуска `app.getVersion()` старее ожидаемой, записанной перед `quitAndInstall`) заставка показывает и сама не повторяет — иначе вечный круг.
- **Пока Cord открыт:** проверка раз в 6 ч. Нашлось и встречи нет (`state` / `call.state` с `inCall: false`, экран `prejoin` — тоже встреча) — главное окно уступает место заставке, дальше как при запуске. Во встрече — ждать её конца или следующего запуска; не качать.
- **Версия:** номер — только в «О программе». Ни заставка, ни окно, ни трей, ни подсказка значка, ни уведомления его не показывают; версия файла, карточка Windows и имя установщика остаются.
- **Совместимости нет:** ни прокладки моста v1 (§3.2), ни Inno-обёртки для перехода с WinUI (§7.2).
- Источник — только зеркало Cord (§5), проверки — все слои §5.

## 6. Установщик (T54, T15, П15)

| | **NSIS (electron-builder)** | Squirrel.Windows | Свой загрузчик |
|---|---|---|---|
| Вид | Мастер MUI2: картинки боковой панели и шапки по E16, свои страницы через `include` (`customWelcomePage`, `customPageAfterChangeDir`, `customFinishPage`, `customUninstallPage`) | Заставка-GIF без страниц, ставит молча (как Discord) | Любой, хоть анимация E16 |
| Язык при установке (П9) | `multiLanguageInstaller` + `displayLanguageSelector`, 8 языков | Нет | Сами |
| Ярлык на столе, галочка вкл. (T15) | Своя галочка (include), выбор в HKCU, учитывается при обновлении | Ярлык всегда, без выбора | Сами |
| Ссылки в карточке Windows | Пишутся только из `uninstallUrl*`/`homepage`: не задаём — их нет | Нет | Сами |
| Обновление | electron-updater: тихий `/S --updated`, дельты blockmap, подпись манифеста | Свой `Update.exe`, дельты nupkg, мягкая подмена при перезапуске | Сами |
| Удаление | Деинсталлятор со своей страницей («удалить мои настройки», по умолчанию нет) | Молчаливое, остаются хвосты | Сами |
| Права, путь | Для пользователя, без UAC, `%LOCALAPPDATA%\Programs\Cord` — **тот же путь, что у Inno** | Только `%LOCALAPPDATA%\<app>\app-X.Y.Z`, две копии при обновлении | Сами |
| Размер | ≈ приложение в 7z, ~90–120 МБ | Так же + nupkg | Так же + загрузчик |
| Поддержка | Основная цель electron-builder | В electron-builder «maintained, but deprecated» ([squirrel-windows](https://www.electron.build/squirrel-windows)) | Вся наша |

**Решение: NSIS** с `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true` ([nsis](https://www.electron.build/nsis)). Состав мастера:

- **приветствие** — человеческое описание Cord как продукта: что это, что ставится, куда, как обновляется; без «сервер выбираете вы»;
- **галочка «Создать ярлык на рабочем столе»**, включена (`createDesktopShortcut: false` + своя логика);
- `runAfterFinish`, `uninstallDisplayName: "Cord"`, издатель «Cord», `deleteAppDataOnUninstall: false`; `VersionInfo*` в том же тоне.

Тест CI читает ключ удаления в HKCU и падает на любом из значений `HelpLink`, `URLInfoAbout`, `URLUpdateInfo`, `Readme`. Анимированный установщик «как у Discord» возможен позже — своим загрузчиком поверх того же NSIS (тихая установка с прогрессом), без смены механизма обновлений.

## 7. Перенос со старого клиента

### 7.1 Данные

| Что | Где в WinUI | В Electron |
|---|---|---|
| Секрет профиля (избранное) | `%LOCALAPPDATA%\Cord\profile-<key>.dat`, DPAPI CurrentUser, энтропия = origin | Читается **как есть** через `cord-native.dpapi`: те же файлы и формат, `<key>` = первые 24 hex SHA-256 от `https://host/`. Откат на WinUI возможен |
| Пароль сервера | `server-<key>.dat`, энтропия `server-password:` + origin | Так же |
| Избранное (до 10) | На сервере по секрету профиля | Переезжает само: секрет тот же |
| `settings.json`: сервер, тема, пинг, звуки, список серверов | `%LOCALAPPDATA%\Cord\settings.json` | Читается в `%LOCALAPPDATA%\Cord\desktop\settings.json`, старый файл не меняется. Серверы сопоставляются с каталогом по origin (П4): совпавшие сохраняют пароль и избранное, ручные из списка пропадают, но остаются на диске |
| Имя, аватар, устройства, качество, клавиша микрофона | `localStorage` (`cord:preferences:v1`, `cord:name`) в `WebView2\<key>\EBWebView\Default` | Однократно: копия каталога → `session.fromPath(копия)` → для каждого origin служебная страница через `protocol.handle` **без сети** → ключи `cord:*` → `bootstrap`. Не вышло — значения по умолчанию, имя вводится заново |
| Разрешения камеры и микрофона | Профиль WebView2 | Не переносятся; при первом запросе — свой диалог |

`userData` Electron — `%LOCALAPPDATA%\Cord\desktop` (не Roaming по умолчанию), всё Cord лежит под одним корнем. Старые файлы новый клиент не удаляет.

### 7.2 Переходного выпуска нет

Решение владельца 20.10.2026: клиентов, кроме стенда, ещё нет, и совместимость со старыми не нужна. Inno-обёртки, которую понял бы обновлятор WinUI 0.7.x, нет, и WinUI сам в Electron не переходит.

- Electron ставится установщиком NSIS со страницы `/download`. Он ставит в тот же `%LOCALAPPDATA%\Programs\Cord`, поэтому WinUI-копию сначала удаляют из «Установленных приложений»: деинсталлятор Inno профиль в `%LOCALAPPDATA%\Cord` не трогает.
- Профиль, избранное, серверы и настройки Electron читает из прежних файлов (§7.1) — они и есть то, что нельзя потерять.
- После выхода Electron зеркало WinUI (`download.json`) больше не обновляется; 0.3.0 и старше и portable ZIP ставят новый клиент так же, вручную.
- `test-installer.ps1` для Electron проверяет установку поверх профиля WinUI: DPAPI-файлы целы и читаются, карточка одна и без ссылок. Отдельно — откат: WinUI 0.7.x поверх снова читает те же файлы.

## 8. Каталог серверов (T05, П4)

Ядро отдаёт `GET /api/v1/catalog` — статичный файл, подписанный **офлайн** скриптом владельца. Закрытого ключа на серверах нет, поэтому скомпрометированный сервер не добавит в каталог чужой адрес.

Формат — JWS в JSON-сериализации (RFC 7515), `alg: EdDSA` (Ed25519, RFC 8037). Подписываются точные байты `payload`, так что канонизация JSON не нужна. Проверка доступна в JDK 15+, `node:crypto` и WebCrypto Ed25519 в Chromium.

```json
{ "payload": "<base64url(JSON ниже)>",
  "signatures": [{ "protected": "<base64url({\"alg\":\"EdDSA\",\"kid\":\"<sha256 SPKI>\"})>", "signature": "<base64url>" }] }

{ "format": "cord.servers/1", "seq": 42,
  "issuedAt": "2026-10-19T12:00:00Z", "expiresAt": "2026-12-19T12:00:00Z",
  "servers": [
    { "id": "nl-1", "name": { "ru": "Нидерланды", "en": "Netherlands" }, "country": "NL",
      "url": "https://cord.nikg.tech/", "order": 10, "default": true }
  ] }
```

**Поля:**

- `id` — `[a-z0-9-]{1,32}`, не меняется;
- `name` — по языкам П9, `ru` обязателен, ≤ 40 символов;
- `country` — ISO 3166-1 alpha-2, заглавными; по нему выбирается круглый SVG-флаг (лицензию набора E01-B проверит и запишет в `THIRD-PARTY-*.md`);
- `url` — `https`-origin с путём `/`, разбор как в `ServerEndpoint.Parse`;
- `order` — по возрастанию;
- `default: true` — ровно у одного.

**Клиент:**

- **Подпись** — любым ключом из вшитого списка `[текущий, следующий]`; список вшит и в клиент, и в веб (`contracts/`).
- **Защита от отката** — `seq` не меньше последнего виденного.
- **Срок** — `expiresAt` плюс 30 дней льготы. Неверный или просроченный каталог не принимается: остаётся последний хороший. В установщик вшит подписанный снимок для первого старта без сети.
- **Первый старт** ничего не спрашивает: берётся сервер с наименьшим пингом среди `default` и соседей, иначе `default`.
- **Пинг** — медиана трёх `HEAD /api/v1/health`, справа в строке.
- Ручного добавления, поля адреса и deep link «добавить сервер» нет.

Схема — `contracts/server-catalog.v1.schema.json`; веб (`web/src/core/servers.ts`) читает тот же формат.

## 9. Сборка и релиз в CI

Новый workflow `desktop.yml` на `windows-2022`, `paths: desktop/**`; `windows.yml` не трогаем.

1. Checkout и `setup-node`, действия закреплены по SHA. Node 24, `npm ci` по lock-файлу.
2. Rust из образа раннера, версия закреплена в `rust-toolchain.toml`. `napi build --release` → `cord-native.win32-x64-msvc.node` (в `asarUnpack`).
3. Типы, линтер, vitest: валидаторы моста (случаи из `BoundaryTests` переносятся), подписи каталога и манифеста, перенос DPAPI на настоящем Windows.
4. `electron-builder --win nsis --publish never`.
   - Подпись: `CSC_LINK`/`CSC_KEY_PASSWORD` из `CORD_SIGN_PFX_BASE64`/`CORD_SIGN_PASSWORD`, метка времени из `CORD_SIGN_TIMESTAMP_URL`. Подписываются exe, деинсталлятор, установщик и `.node` ([code signing](https://www.electron.build/features/code-signing/code-signing-win)).
   - Ключ манифеста: `ELECTRON_BUILDER_UPDATE_SIGN_KEY` (27) или свой `sign-manifest.mjs` (26).
   - Пустые секреты = неподписанная сборка, как `sign.ps1` сейчас. Сертификат — шаг владельца (`OWNER-ACTIONS.md`); до него остаётся SmartScreen.
5. Проверки установщика: тихая установка, карточка без ссылок, ярлык по галочке, обновление N−1 → N по blockmap с локального зеркала, удаление.
6. e2e (Playwright `_electron`) против стенда `https://cord.nikg.tech/`, не старого прода: окно и шапка, загрузка → сервер, звонок двух клиентов, показ тестового окна 1080p60 с `getStats` у зрителя, клавиша через `SendInput` → `hotkey down/up`, ПКМ без браузерных пунктов, окно оверлея, кнопки миниатюры. Прогон пишется на видео.
7. `upload-artifact`: только установщик, `.blockmap`, `latest.yml(.sig)`, `metrics.json` и видео e2e; `retention-days: 1`, `continue-on-error: true` (решение E00 о квоте). Распакованную сборку не грузим — нынешние ~420 МБ на 14 дней квоту и съели.
8. Выпуск — на пуше в `main`, как в `windows.yml`. `cancel-in-progress: false` на `main`: два пуша подряд убивают выкладку. В зеркало — через приватный релиз и `publish-windows-release.py`; у CI доступа к серверу нет.

Повторяющиеся шаги «собрать → поставить → прогнать e2e → снять цифры» оформить скиллом (E01, «Грабли»).

## 10. Цифры прототипа

| Метрика | Как меряем (CI, `metrics.json`) | Ориентир из открытых данных | Порог |
|---|---|---|---|
| Размер установщика | `Get-Item Cord-Setup-*.exe` | Hello World на Electron — 85 МБ ([tech-insider](https://tech-insider.org/tauri-vs-electron-2026/)); нынешний Inno ~300 МБ (`docs/updating.md`) | ≤ 130 МБ |
| Размер на диске | Размер `%LOCALAPPDATA%\Programs\Cord` | Пакет ~323 МБ ([Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)) | ≤ 400 МБ |
| Память в покое (главная) | Сумма `PrivateMemorySize64` всех `Cord.exe` + `app.getAppMetrics()` через 60 с | 128 МБ (Better Stack), 168 МБ на одно окно (tech-insider) | ≤ 250 МБ |
| Память в звонке с показом 1080p60 | То же: 2 участника, 60 с показа | Открытых чисел нет — меряем | записать |
| Холодный старт | `process.getCreationTime()` → `ready-to-show` (заставка) и → `state:home` от веба, 5 запусков | 273 мс (Better Stack), 1 420 мс (tech-insider) до первого окна | Заставка ≤ 1 с, главная ≤ 3 с |
| fps захвата | Зритель: `inbound-rtp.framesPerSecond`, `frameWidth/Height`, `framesDropped` за 60 с. Автор: `encoderImplementation`, `qualityLimitationReason`. Тестовое окно — canvas 60 fps со счётчиком кадров | Предел LiveKit по умолчанию — `h1080fps30`; 60 fps — наш запрос (П2) | Медиана ≥ 55 fps при 1920×1080 |
| Задержка клавиши | `SendInput` → `hotkey` в рендерере | — | ≤ 30 мс |
| Объём дельты | Байты загрузки N−1 → N из журнала updater | Единицы МБ для правок JS | записать |

На раннере GitHub нет GPU: кодирование программное, отрисовка — WARP. Поэтому fps и память из CI — **нижняя граница**. Окончательные цифры снимаются на машине владельца тем же скриптом `metrics` и вписываются сюда.

## Риски и открытые вопросы

- Подписанные манифесты есть только в electron-builder 27 (alpha); до его выхода — свой провайдер (§5).
- Перенос `localStorage` из WebView2 зависит от совместимости LevelDB разных версий Chromium. Если не выйдет — значения по умолчанию; секрет профиля и избранное не страдают.
- Оверлей: эксклюзивный полноэкранный режим и поведение FACEIT проверяются только на живой машине.
- Push-to-talk в играх, запущенных от администратора, без повышения прав Cord не работает (UIPI).
- Без сертификата: SmartScreen при установке и выключенная проверка Authenticode в updater. Целостность держат Ed25519 и sha512.
- Мажор Electron — раз в ≤ 16 недель. Каждый — почти полная загрузка и прогон e2e.

## Источники

**Electron.** [security](https://www.electronjs.org/docs/latest/tutorial/security) · [context-bridge](https://www.electronjs.org/docs/latest/api/context-bridge) · [session](https://www.electronjs.org/docs/latest/api/session) · [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer) · [globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut) · [windows-taskbar](https://www.electronjs.org/docs/latest/tutorial/windows-taskbar) · [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) · [Notification](https://www.electronjs.org/docs/latest/api/notification) · [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) · [MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports) · [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) · [timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) · [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

Про `safeStorage`: на Windows он держит свой ключ под DPAPI в `Local State` и чужие DPAPI-блобы с энтропией не читает — отсюда `cord-native.dpapi`.

**electron-builder и electron-updater.** [NSIS](https://www.electron.build/nsis) · [auto-update](https://www.electron.build/features/auto-update) · [signed update manifests](https://www.electron.build/features/signed-update-manifests) · [Squirrel.Windows](https://www.electron.build/squirrel-windows) · [code signing](https://www.electron.build/features/code-signing/code-signing-win) · [fuses](https://www.electron.build/tutorials/adding-electron-fuses). Документация получена через context7 (`/electron/electron`, `/electron-userland/electron-builder`).

**Microsoft.** [Windows.Graphics.Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) · [process loopback](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params) · [Application Loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) · [RAWINPUTDEVICE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice) · [RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey).

**Chromium.** [webrtc_features.cc](https://chromium.googlesource.com/chromium/src/+/main/media/webrtc/webrtc_features.cc).

**Discord.**

- [Переход на 64 бита](https://discord.com/blog/how-discord-seamlessly-upgraded-millions-of-users-to-64-bit-architecture): Electron, нативные модули (голос) вне ограничений памяти Chromium, свой обновлятор с полными и дельта-пакетами.
- [Голос на WebRTC](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc): один нативный медиадвижок C++ на десктопе.
- [Новый оверлей](https://discord.com/blog/player-release-q12025): без внедрения в игру.
- Установщик Discord — Squirrel.Windows (`Update.exe`, `%LOCALAPPDATA%\Discord\app-*`).

Cord берёт у Discord модель «Electron + веб-интерфейс + узкие нативные модули + оверлей без инъекций». Свой медиадвижок не берёт: медиа у Cord живёт в WebRTC браузера и LiveKit (E05).

**Прочее.** OBS: [Application Audio Capture](https://obsproject.com/kb/application-audio-capture-guide) · замеры: [tech-insider, 2026](https://tech-insider.org/tauri-vs-electron-2026/), [Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/).
