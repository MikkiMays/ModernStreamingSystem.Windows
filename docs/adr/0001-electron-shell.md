# ADR 0001 — оболочка Cord для Windows на Electron

- **Статус:** предложено (E01, этап A), 19.10.2026. Технология — решение владельца (T53, `DECISIONS.md` П1); этот ADR решает, **как** строить, и что доказывает прототип.
- **Изменено 20.10.2026** (решение владельца по T58): обновление — заставкой при запуске, как у Discord (§5.1); обратной совместимости со старыми клиентами нет — ни прокладки моста v1 (§3.2), ни переходного Inno-выпуска (§7.2).
- **Изменено 20.10.2026** (E01-B2): `capture.select` — запрос с ответом (`invoke`), а не сообщение: веб ждёт ответа до `getDisplayMedia` (§4.1); переключатели §4.4 — `invoke('app.settings', патч)` и событие `app.settings`, флаги `app.settings`, `tray`, `sleep`, `autostart`, а `capture.system-audio`, `thumbar`, `badge`, `autostart` объявляются только в Windows; каталог (§8) — JWKS `contracts/catalog-keys.json`, подписанный снимок `src/shell/catalog.jws`, последний хороший — `userData/catalog.jws`; `metrics.json` (§10) — `scripts/test-installer.ps1 -Metrics`.
- **Изменено 21.10.2026** (E01-B3, `cord-native`): модуль построен — Raw Input (§4.2), process loopback (§4.1), переднее окно (§4.3); состав §4.6 — как собрано (`dpapi` не нужен по В-2, `net` не делался); дорога звука — `MediaStreamTrackGenerator` в preload и элемент `#cord-desktop-capture-audio` на странице, а не AudioWorklet в вебе (§4.1); флаги `ptt` и `capture.app-audio` объявляются только с загруженным модулем; событие `capture.audio` (§3.3); сборка — `cargo build` без `@napi-rs/cli` (§9).
- **Изменено 21.10.2026** (ревью 1.0.3, R57–R64): крестик прячет окно в трей, пока есть значок (`close-policy.ts`, §4.4); значок трея — `dist/shell/tray.ico` (`tray-icon.ts`); AUMID процесса = `appId` установщика (`APP_ID`, §4.4), ярлык рабочего стола с AUMID; событие `window.state` и `silent` у `notify` (§3.3); оверлей включён по умолчанию и не показывается без сведений о переднем окне (§4.3, `settingsRev: 2`); установщик — окно выбора языка, язык уходит приложению (`Bootstrap.language`), `ManifestDPIAware`, картинки 2× (§6); ключи Chromium `disable-renderer-backgrounding`, `disable-backgrounding-occluded-windows` (§2.1).
- **Изменено 24.10.2026** (ревью 1.0.3, WD2 ч. 1 — R22, R60, R01–R03, R103, R105, R107): состояние сочетаний — кодом, а не фразой (§4.2, §3.3); второго окна выбора показа у оболочки нет (§4.1); EcoQoS выкл. и `ABOVE_NORMAL` своим процессам во встрече (`process.boost`, §2.1; с 1.0.7 — `HIGH` всё время), поток захвата звука в MMCSS «Pro Audio», порции звука показа по часам из запаса в preload (§4.1); RED для Opus с двумя копиями (`force-fieldtrials`, §2.1); меню трея как у Телемоста на восьми языках, `state.language`, `chat.open`, переключатель `notifications` (§3.3, §4.4); установщик «одним окном» (§6).
- **Изменено 25.10.2026** (ревью 1.0.3, WD2 ч. 2 — R62, R63, R93, R104): `cord-native` различает игры — exe, заголовок, «без рамки», эксклюзивный режим (§4.3, §4.6); реестр игр `games.ts` и мост `games.*`, `game.active` (§3.3); виджет говорящих — окно во весь монитор игры, состав через main, уровни по порту мимо main, замок `overlay.lock` без хука мыши (§4.3); «Показать игру» — уведомление Windows и карточка в оверлее, `golive` (§4.3); мини-окно звонка `cord-app://mini` (§4.4).
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
  src/shell/     cord-app:// — заставка обновления, загрузка (E16/П14), офлайн, серверы, оверлей
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
| renderer «оболочка» | `cord-app://shell/…`: заставка обновления, загрузка, офлайн, серверы | `sandbox: true`, preload `shell.ts` |
| renderer «оверлей» | `cord-app://overlay/` | `sandbox: true`, только получает состояние |
| GPU, сеть, аудио | Служебные процессы Chromium | — |

Нативный модуль вынесен в utility-процесс по трём причинам:

1. в рендерере с песочницей его не загрузить;
2. Raw Input даёт одному процессу одно окно-приёмник на класс устройств, а в процессе browser им уже пользуется Chromium;
3. падение нативного кода не должно ронять звонок.

**Главное окно** — одно `BrowserWindow` на сессию `persist:cord`. Хранилища серверов и так разделены по same-origin, а одна сессия позволяет менять сервер обычной навигацией. Настройки:

- `titleBarStyle: 'hidden'` + `titleBarOverlay` (56 px с 1.0.10 — высота шапки встречи; до того 36; высота уходит странице в `bootstrap.titlebarHeight`; цвета по теме); шапку с маркой (T01) рисует веб в режиме приложения (Window Controls Overlay, `app-region: drag`);
- `backgroundMaterial: 'mica'`;
- `backgroundThrottling: false` — свёрнутое окно в звонке не замедляет таймеры; плюс ключи Chromium `disable-renderer-backgrounding` и `disable-backgrounding-occluded-windows` (R01–R03): окна оболочки и воркеры не усыпляются, когда Cord спрятан в трей или накрыт игрой; полевой опыт `force-fieldtrials=WebRTC-Audio-Red-For-Opus/Enabled-2/` (R107) — RED для Opus с двумя копиями: на пачках потерь заглушка NetEq меньше примерно на 45 % при ~1,5× полосе речи (замер голоса в ядре, `MEDIA-DIAGNOSIS.md` §10); браузер такого не умеет. Все полевые опыты — одним ключом через «/», второй `force-fieldtrials` перебил бы первый;
- `autoplayPolicy: 'no-user-gesture-required'` вместо нынешнего ключа WebView2;
- **приоритет (R01–R03, `boost-plan.ts`)**: Windows 11 переводит фоновые процессы в EcoQoS («режим эффективности») и загрубляет им таймер, а Cord часто фоновый — спрятан в трей или накрыт игрой. Всё время, пока Cord запущен (с 1.0.7; владелец 24.10.2026: «у корда должен быть приоритет высокий на виндовс»), `cord-native` (`process.boost {pids, on}` → `boostProcess`) снимает EcoQoS (`PROCESS_POWER_THROTTLING_EXECUTION_SPEED`, на Windows 11 и `IGNORE_TIMER_RESOLUTION`) и ставит `HIGH_PRIORITY_CLASS` (не `REALTIME`: тот отнимает процессор у ввода и диска и требует прав администратора) трём своим процессам: главному, рендереру главного окна (`webContents.getOSProcessId()`) и аудиосервису Chromium (`type: 'Utility'`, служба `audio.mojom.AudioService` из `app.getAppMetrics()`); класс возвращается к обычному только у процесса, который перестал быть целью, и только если его поднимали мы. План пересчитывается при каждом состоянии звонка и раз в 10 с (аудиосервис Chromium запускается лениво, рендерер сменяется при перезагрузке страницы), возвращаются только живые процессы Cord. Вне встречи процессы Cord почти не работают, и высокий класс ничего не отнимает у игр.

**Старт:** сначала заставка обновления (§5.1) — отдельное маленькое окно; главное окно создаётся только после неё. Затем локальная `cord-app://shell/loading` (упакованный компонент загрузки E16) → в фоне рукопожатие (`POST /api/v1/session`, пароль из DPAPI) → `loadURL(origin)`. **Смена сервера:** подтверждение выхода из встречи → загрузка → новый origin.

### 2.2 Откуда грузить интерфейс

| | С сервера Cord (как сейчас) | Упакованный в приложение |
|---|---|---|
| Исправления интерфейса | Приходят с выкладкой сервера, без переустановки | Только новым выпуском клиента |
| Совместимость веба и ядра | Одна версия: выкатываются вместе | Клиент 1.2 против ядра 1.5 и наоборот — нужна матрица версий API |
| Проверка `Origin` в ядре | Работает как есть: ядро принимает только свой origin | Ядру пришлось бы разрешить `cord-app://` — ослабить защиту для всех |
| Старт без сети | Своя страница «нет связи» из оболочки; повторный старт быстрый (хэшированные бандлы в HTTP-кэше Chromium) | Интерфейс откроется, но без сервера встречи всё равно нет |
| Каталог серверов (П4) | У каждого сервера свой веб — естественно | Один интерфейс на серверы с разными версиями ядра |

**Решение:** интерфейс встречи — с сервера. Упакована только оболочка (заставка обновления, загрузка, офлайн, ошибки, серверы, оверлей). Для разговора офлайн-старт ничего не даёт, а расхождение веба и ядра стоит дорого.

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
| `state` | `state` (+ необязательный `language` — один из восьми языков Cord) | Страница, имя, аватар, комната → трей, список переходов, заголовок; `language` — язык трея и диалогов оболочки (R103), незнакомый пропускается, сообщение принимается |
| `call-state` | `call.state` (+ `mic`, `camera`, `screen`, `room`) | Кнопки на миниатюре, значок поверх иконки, `powerSaveBlocker`, оверлей |
| `hotkey.configure` | `hotkeys.configure` | Действия `mic.toggle`, `ptt`, `deafen`, `overlay.toggle`; режим `toggle`/`hold`; клавиши и кнопки мыши (модель — E03) |
| `favorites.changed` | `favorites.changed` | Закреплённые комнаты в списке переходов |
| `preferences.changed`, `server.autoconnect` | без изменений | Настройки приложения |
| `servers.open` | `servers.open` | Список серверов (каталог) |
| `session.expired` | `invoke('session.renew')` → токен | Запрос/ответ вместо пары сообщений |
| `close-ready` | `close.ready` | Закрытие в звонке (ждём ≤ 2,5 с, как сейчас) |
| `update.version`, `update.check`, `update.apply` | `invoke('update.status')`, `update.check`, `update.apply` | «О программе» |
| — | `invoke('capture.sources')`, `invoke('capture.select')` | Своё окно выбора источника и режим звука (§4.1) |
| — | `invoke('app.settings', патч)` | Переключатели §4.4 в настройках веба (раздел «Windows», E03): трей, кнопки миниатюры, значок, мигание, запрет сна, оверлей, автозапуск, уведомления (`notifications`, R103) |
| — | `overlay.state` | Участники и кто говорит (≤ 10 Гц), без аватаров — веб до R63; новый шлёт `overlay.roster` и `overlay.levels` |
| — | `overlay.roster` | Кто во встрече (R63): `{participants: [{id, name, avatar, muted}]}` ≤ 25, аватар `data:image/` ≤ 4 КиБ, сообщение ≤ 128 КиБ (свой предел) — виджету в игре и мини-окну; при смене состава |
| — | `send('overlay.levels')` | Уровни голоса `[id, ступень, уровень]` ≤ 25, до 30 Гц (R63). В main не идёт: preload кладёт их в порты `MessageChannelMain` окон оверлея и мини-окна (`cord:levels-port`) |
| — | `mini.state` | Мини-окно звонка (R93): название встречи, свой id, микрофон, камера, показ, непрочитанные, сколько людей, связь со звуком (`status`: `connecting` / `connected` / `recovering`, `remaining` — секунд ожидания); пока страница его не прислала, мини-окна нет; без `status` (веб до него) связь считается идущей |
| — | `invoke('games.list' \| 'games.set' \| 'games.forget' \| 'games.pick')` | Реестр игр (R62): ответ `{games, active}`; `set {exe, enabled}` — оверлей над игрой, `forget {exe}` — убрать и не регистрировать самой, `pick` — выбор exe в окне Windows |
| — | `notify`, `attention`, `progress`, `badge` | Уведомление с действиями, мигание кнопки, прогресс файла, значок непрочитанного |

| WinUI, v1 (оболочка → страница) | v2 | Назначение |
|---|---|---|
| `microphone.toggle` | `hotkey` `{action, phase: 'down'\|'up'}` | Push-to-talk требует фазы |
| `hotkey.status` | `hotkeys.status` `{status: {<действие>: <код>}}` | Что удалось зарегистрировать — кодом (`global`, `global-raw`, `taken`, `duplicate`, `window-only`, R22, §4.2) |
| `navigate`, `theme.changed`, `preferences.changed`, `settings.open`, `favorite.settings`, `favorites.changed`, `profile.changed`, `network.changed`, `close-request`, `update.status`, `session.token` | те же имена через `on()` | Смысл прежний |
| — | `thumbar` `{action: mic\|camera\|leave}`, `deeplink` `{room}`, `notification.action`, `power` `{suspend\|resume\|lock}`, `capture.ended` | Новые возможности |
| — | `app.settings` | Значения переключателей §4.4, когда их сменила сама оболочка (клавиша `overlay.toggle`, «Уведомления» в меню трея) |
| — | `chat.open` | «Чат · N» в меню трея (R103): открыть чат встречи. Веб без поддержки пропускает (окно встречи всё равно выходит вперёд) |
| — | `games.changed` `{games, active}`, `game.active` `{game}` | Реестр игр сменился; игра «сейчас» — впереди или была впереди до Cord, пока жив её процесс (R62) |
| — | `mini.action` `{id}` | Нажатие в мини-окне (R93): `mic`, `camera`, `leave` — без подъёма окна; `screen`, `people`, `chat`, `settings` — окно Cord выходит вперёд |
| — | `golive` `{id, name}` | «Показать игру» (R104): источник окна игры `window:<hwnd>:0`; оболочка дала странице жест (`executeJavaScript('0', true)`), веб начинает показ без окна выбора |
| — | `capture.audio` `{state: ready\|failed\|ended, mode, reason?}` | Звук приложения / системы кроме Cord (§4.1): дорожка готова в `#cord-desktop-capture-audio`, не вышло (`unavailable`, `not-a-window`, текст ошибки активации) или закончилась. Новый подписчик получает текущее состояние сразу |
| — | `window.state` `{focused, visible}` | Окно в фокусе / видно (спрятано в трей, свёрнуто): веб шлёт `notify` только когда человек не смотрит (R59). `notify` принимает `silent: true` — без системного звука, событие озвучивает веб |

## 4. Нативные возможности

### 4.1 Захват экрана, окна, игры и звука

**Что даёт Electron.** Веб вызывает `getDisplayMedia`, а main отвечает в `session.setDisplayMediaRequestHandler` источником из `desktopCapturer.getSources` ([session](https://www.electronjs.org/docs/latest/api/session), [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)). На Windows захватом в Chromium занимается `WgcCapturerWin` (Windows.Graphics.Capture). В текущем [`webrtc_features.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/webrtc/webrtc_features.cc) флагов «разрешить WGC» уже нет — остались только `WebRtcWgcRequireBorder` (рамка, по умолчанию выкл.) и `WebRtcAllowWgcUsingTexture`. Значит, WGC — путь по умолчанию; прототип это подтверждает. Кодирует WebRTC Chromium, аппаратно через Media Foundation, если GPU умеет.

**Своё окно выбора** рисует веб по дизайну E16, как в Discord:

1. `invoke('capture.sources')` — экраны и окна с миниатюрами (≤ 320 px) и иконками; видит только origin сервера.
2. `invoke('capture.select', {id, audio: 'none'|'system'|'app'|'system-except-cord'})` — выбор живёт 10 с, только для этого кадра и при жесте пользователя; веб ждёт ответа и только потом зовёт `getDisplayMedia`.
3. Веб вызывает `getDisplayMedia`, и обработчик в main отдаёт именно этот источник.

**Второго окна выбора у оболочки нет (R60).** До 1.0.6 обработчик без `capture.select` открывал своё окно `cord-app://shell/picker` — дубль веба, только по-русски (X1). Его больше нет (`picker.*`, `openPicker`/`finishPicker`, вызовы `capture.pick`/`capture.cancel` удалены): без выбора веба обработчик отвечает `callback({})`, и показа не будет — как и без выбора человека. Окно выбора и настройки показа (вкладки, SD/HD, режим, звук) — только в вебе (`CapturePicker.tsx`, веб-часть R60).

Публикация в LiveKit — по правилам качества E05 (П2: потолок 1080p60, кадр целевого качества раньше показа).

**Свой WGC-модуль не пишем.** Кадры 1080p60 (≈ 480 МБ/с) пришлось бы гнать между процессами в WebRTC браузера, а Chromium делает это внутри себя. Вернёмся к нему, только если прототип покажет < 55 fps или не захватит игру в borderless.

**Звук.** Electron умеет только `audio: 'loopback'` / `'loopbackWithMute'`, то есть весь звук системы. Туда попадают и голоса комнаты, которые играет сам Cord, — участники услышат себя. Поэтому:

| Режим | Как | Где |
|---|---|---|
| Звук приложения (показ окна) | WASAPI process loopback, `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` для PID окна (HWND из id источника `window:<hwnd>:0` → `GetWindowThreadProcessId`) | `cord-native` |
| Весь звук, кроме Cord (показ экрана) | Тот же API, `EXCLUDE_TARGET_PROCESS_TREE` для дерева процессов Cord (аудиосервис Chromium — дочерний) | `cord-native` |
| Без звука | — | — |

- **Версии Windows.** Документированный минимум [AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params) — build 20348, но на деле API работает с Windows 10 2004 (19041): так им пользуется OBS ([Application Audio Capture](https://obsproject.com/kb/application-audio-capture-guide)). Наш `MinVersion` уже 10.0.19041.
- **Если активация не удалась** — показ идёт без звука, с подсказкой (`capture.audio {state: 'failed', reason}`). Системный звук с эхом не включаем.
- **Дорога звука (как собрано, E01-B3):** PCM float32 48 кГц / 10 мс (480 кадров × 2 канала) → `MessageChannelMain`: порт из utility-процесса прямо в preload главного окна ([message-ports](https://www.electronjs.org/docs/latest/tutorial/message-ports)), main порт не трогает → preload собирает `MediaStreamTrackGenerator` (`AudioData` с меткой по счётчику кадров) и кладёт дорожку в скрытый `<audio id="cord-desktop-capture-audio" muted>` → веб читает `element.srcObject.getAudioTracks()[0]` — DOM один на изолированный мир preload и мир страницы, объект `MediaStream` общий (проверено в Electron 44: страница видит `instanceof MediaStream`, дорожка `live`, тон слышен в `AnalyserNode`) → `publishTrack(track, {source: ScreenShareAudio})`. Это ~384 КБ/с, задержка ~10–20 мс. AudioWorklet в вебе не нужен: CSP сервера (`script-src 'self'`) не пустил бы модуль воркера из `cord-app://` или `blob:`, а `MediaStreamTrackGenerator` — просто API Chromium без загрузки кода. Пока приложение молчит, модуль подкладывает тишину по часам (`pcm::Pacer`), чтобы дорожка не рвалась. Поток захвата — в MMCSS «Pro Audio» (`AvSetMmThreadCharacteristicsW`, R01–R03): под нагрузкой игры планировщик будит его вовремя. В preload порции идут в генератор не по приходу, а по часам из запаса в две (`PcmQueue`, +20 мс): пачка от потока захвата не уходит в сеть пачкой пакетов; запас кончился — копится заново, разросся — первой выбрасывается тишина, сверх 60 мс лишнее уходит сразу. Веб останавливает дорожку (`track.stop()`) — preload сообщает main, тот гасит захват.
- **Порядок для веба:** `invoke('capture.select', {id, audio: 'app' | 'system-except-cord'})` → `getDisplayMedia` (оболочка отдаёт только видео) → `on('capture.audio')` → `ready` → взять дорожку из элемента и опубликовать рядом с видео; `failed` — показать подсказку «показ без звука». Звук приложения — только для источника-окна (`window:<hwnd>:0` → PID дерева процессов окна); для экрана — «Система кроме Cord».
- **`restrictOwnAudio`** (LiveKit его уже пробрасывает): веб просит его у `getDisplayMedia`; исполняет ли его Chromium в Electron 44 на Windows для `loopback`, проверяется на живой машине — если да, режим «кроме Cord» без своего кода остаётся запасным. Для дорожки из `cord-native` проверка `ownAudioLeaks` в вебе не нужна: эха там нет по построению.

### 4.2 Глобальные клавиши и push-to-talk

[`globalShortcut`](https://www.electronjs.org/docs/latest/api/global-shortcut) — это `RegisterHotKey`: нет keyup, нет кнопок мыши, а сочетание **отбирается** у остальных программ, включая игру ([RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)).

| Вариант | keyup/мышь | Отбирает клавишу | Лицензия | Решение |
|---|---|---|---|---|
| `globalShortcut` | нет | да | MIT | Запасной путь для `mic.toggle` с Ctrl/Alt (как сейчас), если `cord-native` недоступен |
| `uiohook-napi` (WH_KEYBOARD_LL / WH_MOUSE_LL) | да | нет | Привязка MIT, внутри статический libuiohook — **LGPL-3.0** ([npm](https://www.npmjs.com/package/uiohook-napi)) | Нет: LGPL в закрытом продукте требует давать перелинковку; в JS уходит поток **всех** нажатий |
| Свой модуль: Raw Input, `RIDEV_INPUTSINK` ([RAWINPUTDEVICE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)) | да | нет | Наш код (napi-rs — MIT, windows-rs — MIT/Apache-2.0) | **Да.** Скрытое окно в своём потоке utility-процесса; наружу — только события зарегистрированных сочетаний `{id, phase}`. Без хуков, без задержки системному вводу |
| Свой WH_KEYBOARD_LL | да | нет | наш | Только если Raw Input где-то не доходит (решает прототип) |

Ограничение UIPI: если игра запущена от администратора, а Cord — нет, Windows не доставит ему ввод, пока игра на переднем плане. Так же ведёт себя Discord — пишем в подсказке настройки. Клавиши работают всегда, пока включены (T27); модель сочетаний общая с E03.

**Как собрано (E01-B3, `native/src/win/input.rs`, `matcher.rs`).** Скрытое окно (`WS_OVERLAPPED`, не message-only — иначе `RIDEV_INPUTSINK` не работает) в потоке `cord-native-input` utility-процесса; `RegisterRawInputDevices` на клавиатуру (usage 1/6) и мышь (1/2) с `RIDEV_INPUTSINK`. Машина состояний: модификаторы совпадают точно (как `matchesHotkey` в вебе), автоповтор не даёт второго «нажал», сочетание отпускается по клавише, по любому своему модификатору и по опросу `GetAsyncKeyState` раз в 50 мс, пока что-то удерживается, — страховка от залипшего push-to-talk, когда UIPI не доставила отпускание. Коды — имена DOM (`KeyM`, `Digit1`, `F1`…`F24`, `Space`) и `Mouse3`–`Mouse5` (средняя и боковые кнопки; левая и правая не регистрируются). Наружу — `{id, phase}`; main превращает в `hotkey {action, phase: down|up}`. Нет модуля или его процесс упал — набор переезжает на `globalShortcut` (без отпускания и без мыши), вернулся — обратно, веб получает новый `hotkeys.status`.

**Состояние — кодом, а не фразой (R22, X1).** `hotkeys.status {status: {<действие>: <код>}}`, коды — `global` (globalShortcut), `global-raw` (Raw Input), `taken` (занято другой программой), `duplicate` (уже у другого действия Cord), `window-only` (в систему не ставится) — `HOTKEY_STATUS_CODES` в `hotkeys.ts`. Слова берёт веб из своего каталога на языке интерфейса (`hotkeyStatusText`) и говорит только о том, что мешает; «работает поверх других программ» — норма, плашки о ней нет. До 1.0.6 оболочка слала русские фразы — веб 1.0.4+ их не показывает.

### 4.3 Оверлей в играх (T23)

Отдельное `BrowserWindow` на `cord-app://overlay/` ([BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)):

- `transparent`, `frame: false`, `focusable: false`, `skipTaskbar`;
- `setAlwaysOnTop(true, 'screen-saver')`;
- `setIgnoreMouseEvents(true)` — клики проходят в игру;
- `setContentProtection(true)` — на Windows 10 2004+ это `WDA_EXCLUDEFROMCAPTURE`: в нашу же демонстрацию оверлей не попадает.

Окно оверлея — во весь монитор игры; виджет говорящих — в выбранном углу (ниже, R63). Монитор и игру определяет `cord-native` через `GetForegroundWindow` + `MonitorFromWindow` и снимок процессов, **не открывая** процесс игры. Говорящие подсвечены градацией E04.

**Чего нет:** DLL в процессе игры, хуков DirectX/Present, `OpenProcess` на игру, чтения её памяти. На этот же класс перешёл Discord: новый оверлей больше не лезет в игру и «не злит античиты» ([Discord, 2025](https://discord.com/blog/player-release-q12025)).

**Ограничения:**

- в эксклюзивном полноэкранном режиме DirectX окно поверх не видно; оконный режим и borderless работают (T23 это и просит);
- внешние ESP-читы тоже рисуют прозрачными окнами, поэтому отдельный античит может такое окно прятать — проверка с FACEIT (CS2) обязательна в приёмке E01-B;
- по умолчанию оверлей **включён** (R61, `settingsRev: 2` включает его и тем, у кого 1.0.x записала `false`); выключается переключателем и клавишей, виден только в звонке;
- без сведений о переднем окне (нет `cord-native`, модуль упал) оверлей не показывается вовсе — иначе он ложился поверх самого Cord.

**Как собрано (E01-B3, `overlay-policy.ts`, `native/src/foreground.rs`).** Utility-процесс раз в 300 мс (таймер того же скрытого окна) снимает `GetForegroundWindow` → `GetWindowThreadProcessId`, `GetWindowRect`, `MonitorFromWindow` + `GetMonitorInfo`, `GetClassName`; «во весь экран» — окно накрывает монитор целиком (рамка borderless за краями тоже), кроме рабочего стола (`Progman`/`WorkerW`); «своё» — PID в дереве главного процесса Cord по снимку Toolhelp (`CreateToolhelp32Snapshot`, без `OpenProcess`; карта не чаще раза в 5 с и только при смене окна). Событие уходит только при изменении. Решение в main — по реестру игр (ниже, R62): до 1.0.8 оверлей вставал над любым окном во весь монитор; монитор — `screen.screenToDipPoint` → `getDisplayNearestPoint`; без модуля — не виден.

**Игры (R62, `games.ts`, `games-known.json`).** `cord-native` к переднему окну добавляет имя exe (снимок Toolhelp `szExeFile`; снимок заново и тогда, когда процесса окна в нём нет, — не чаще раза в секунду), заголовок (≤ 80 символов, `GetWindowText` для чужого окна сообщений ему не шлёт), «без рамки» (`GWL_STYLE` без `WS_CAPTION`/`WS_THICKFRAME` и окно ровно по монитору) и эксклюзивный режим (`SHQueryUserNotificationState() == QUNS_RUNNING_D3D_FULL_SCREEN` — спрашивается только у полноэкранного чужого окна). Игрой окно становится, если это не Cord, не стоп-лист (оболочка Windows, браузеры, плееры, офис, мессенджеры, лаунчеры, OBS) и оно «без рамки», в эксклюзивном режиме или его exe — в `games-known.json` (213 exe). Просто «во весь экран» — не признак: так выглядит любое развёрнутое окно при скрытой панели задач. Реестр — `settings.games` (`{exe, name, enabled, firstSeen, lastSeen}`, ≤ 100), «Забыть» кладёт exe в `ignoredGames`, «Добавить игру» возвращает. **Оверлей виден ⇔ звонок ∧ включён ∧ о переднем окне известно ∧ это не Cord ∧ игра из реестра с включённым переключателем ∧ не эксклюзивный режим** (`overlay-policy.ts`); в эксклюзивном — одно уведомление «включите режим без рамки» на игру за сеанс.

**Виджет говорящих (R63, `windows/overlay.ts`, `shell/overlay.*`).** Окно — во весь монитор игры (`display.bounds` дисплея её монитора), `paintWhenInitiallyHidden`, `backgroundThrottling: false`, создаётся скрытым при начале встречи. Состав — `overlay.roster` через main (main проверяет `data:`-аватары), уровни — `overlay.levels` по порту прямо из preload страницы встречи (до 30 Гц; в вебе измеритель — `AudioWorklet`, он идёт и когда Cord спрятан). Карточки 32/40/56, кольцо по ступени `--voice-1..4` (`transform`/`opacity`, 90 мс на вход, 320 на угасание), вход 160 мс, уход 120 мс, сдвиг FLIP, порядок — по встрече, значок выключенного микрофона, «+N» после двенадцати; `prefers-reduced-motion` — без движения. Угол, размер, имена (всегда / когда говорит / никогда), прозрачность 30–100 % и смещение после перетаскивания — `settings.overlay` (`app.settings` не только булев). **Замок** — `overlay.lock` (по умолчанию `Shift+\``, Raw Input, клавиша у игры не отбирается): разблокированный оверлей берёт мышь (`setIgnoreMouseEvents(false)`, вуаль и пунктир вокруг виджета), клавиатуру — никогда (`focusable: false`); заблокированный — `setIgnoreMouseEvents(true)` **без** `forward`: пересылку движения мыши Electron в Windows делает глобальным хуком `WH_MOUSE_LL` — задержка каждому движению в игре и повод для античита. Спрятался — снова заблокирован.

**«Показать игру» (R104, `game-notice.ts`).** Раз на игру за сеанс во встрече, если оверлей над ней включён: уведомление Windows «Cord работает поверх <игра>: оверлей — Shift+`» с кнопкой «Показать игру» и карточка в оверлее (её видно и при «Не беспокоить» в играх, кнопка нажимается разблокированным оверлеем); нажали одно — второе закрылось. Нажатие: источник окна игры по HWND переднего окна (иначе по заголовку) из `desktopCapturer.getSources`, жест странице и `golive {id, name}` — веб показывает окно в режиме «Плавность» 60 fps со звуком игры. Окно Cord вперёд не выходит. Веб, который не шлёт `overlay.roster` (до R63), предложения не получает — он бы его не исполнил.

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
| Трей — меню как у Телемоста (R103, `tray-menu.ts`): состояние («● Во встрече · <название>» / «○ Не во встрече»), во встрече — «Вернуться во встречу», «Новая встреча» (во встрече — с вопросом: веб выйдет из текущей), во встрече — «Чат · N» (`badge`, `chat.open`) и «Микрофон» галочкой, «Уведомления» галочкой (`settings.notifications`: выключены — `notify` не показывается), «Настройки» (`settings.open`), «Выйти из Cord» (во встрече — с вопросом, затем `close-request`). Подсказка значка — то же состояние, с микрофоном; щелчок и двойной щелчок открывают окно. Тексты — свой каталог на восьми языках (`shell-text.ts`, X1), язык — `state.language` страницы, затем выбор в установщике, затем язык Windows. **Крестик прячет окно в трей**, встреча продолжается (R57, `close-policy.ts`); закрывается по-настоящему при «Выйти», `before-quit`, `session-end` или без значка. Значок — `dist/shell/tray.ico` (16–48 BMP + 256 PNG), не прочитался — трея нет (R58). Первое прятание — баллон «Cord работает в трее» один раз | `Tray`, `Menu` (`checkbox`), `displayBalloon`, `dialog.showMessageBox` | вкл. |
| Мини-окно звонка (R93, `windows/mini.ts`, `mini-policy.ts`, `shell/mini.*`): во встрече, когда главное окно спрятано, свёрнуто или его закрыло другое окно на том же мониторе (`window.state` + переднее окно), — через 400 мс; не над оверлеем, не над окном во весь экран, не когда впереди своё окно Cord. Компактное (220: показ, тот, кто говорил последним, «+N»; микрофон, показ, «ещё») и развёрнутое (260: своя плитка, микрофон, камера, показ, участники, чат с непрочитанными, настройки звука, красная «Выйти из встречи»). Поверх окон (`floating`), без фокуса, без захвата (`setContentProtection`), таскается за полосу, место помнится; «—» прячет до возврата в Cord. Плитки — лицо и кольцо говорящего, видео камер нет: картинку из окна встречи в другое окно без перекодирования не передать | `BrowserWindow` (`focusable: false`), `MessageChannelMain` | вкл. |
| AppUserModelID процесса = `appId` установщика (`APP_ID = tech.cord.desktop`): уведомления и группировка окон (R59) | `app.setAppUserModelId`, `WinShell::SetLnkAUMI` | — |
| Автозапуск | `app.setLoginItemSettings` | **выкл.** |
| Deep links `cord://` | `setAsDefaultProtocolClient` + запись в HKCU установщиком | вкл. |

### 4.5 Контекстное меню (T42)

Своего меню по ПКМ в Electron нет вовсе. Обрабатываем `webContents.on('context-menu')`:

- **в полях ввода** — «Вырезать / Копировать / Вставить / Выделить всё» на языке интерфейса и подсказки орфографии (`params.dictionarySuggestions`, на Windows — системная проверка);
- **на выделенном тексте** — «Копировать»;
- **в остальных местах** — ничего: веб открывает своё меню (E02, T40).

«Проверить», «Сохранить как», «Поиск» взяться неоткуда.

### 4.6 Состав `cord-native`

Rust + [napi-rs](https://napi.rs). N-API — сборка одна на все версии Electron. Модуль загружается только в utility-процессе. **Как собрано (E01-B3, `desktop/native/`, крейт `cord-native`, `windows` 0.62, `napi` 3):**

- `startInput`/`setBindings`/`stopInput` — Raw Input (§4.2);
- `startAudio`/`stopAudio` — process loopback include/exclude (§4.1), поток захвата на сеанс, COM MTA;
- `watchForeground`/`stopForeground`, `windowProcess`, `currentProcess` — переднее окно, монитор, полноэкранность, «без рамки», эксклюзивный режим, exe и заголовок, PID по HWND (§4.3, R62);
- `processAlive(pid, exe)` — жива ли игра «сейчас» (тот же PID с тем же exe в снимке Toolhelp, без `OpenProcess`);
- `boostProcess(pid, on)` — приоритет своих процессов: EcoQoS выкл., `HIGH` (§2.1); решения — в чистом `boost.rs`;
- `dpapi` — **не нужен**: пароль сервера оболочка не хранит (В-2), секрет профиля шифрует `safeStorage`;
- `net` — не делался: `network.changed` пока не нужен вебу (`navigator.onLine` в странице).

Чистая логика (`keys`, `matcher`, `pcm`, `foreground`, `boost`) собирается и проверяется `cargo test` на любой платформе; Windows-часть — `src/win/*` за `cfg(windows)`, на остальных — заглушки с отказом. JS: `src/native/host.ts` (utility-процесс, `process.parentPort`, запросы с номерами, события, порт PCM; `CORD_NATIVE_FAKE=1` — подмена для дымового прогона без Windows), `src/main/native/client.ts` (запуск, `ready`, перезапуск через 2 с не чаще трёх раз за 10 минут). Флаги `ptt` и `capture.app-audio` объявляются только с загруженным модулем (`featuresFor(platform, native)`); без него веб показывает понятный отказ и не ломается.

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

**Решение: NSIS**, `perMachine: false` ([nsis](https://www.electron.build/nsis)). С 1.0.6 (R105, референс n04 — установщик Телемоста) — **«одним окном»**, `oneClick: true`: окно выбора языка, затем маленькое окно с полосой (SpiderBanner, значок `installerHeaderIcon`) — и Cord запускается сам (`runAfterFinish`). Два нажатия; страниц приветствия, папки, ярлыков и финиша нет. До 1.0.6 был мастер MUI2 (`oneClick: false`, свои страницы, галочка ярлыка) — от него остались только язык и DPI.

- **окно выбора языка** (R64) — `MUI_LANGDLL_DISPLAY` из `customInit` (не в тихом режиме), выбор в `HKCU\Software\Cord\InstallerLanguage`; LCID пишется в `…\Language`, оболочка читает его при первом запуске (`language.ts`) и отдаёт вебу `Bootstrap.language` — один раз на origin; деинсталлятор берёт тот же язык;
- **`ManifestDPIAware`** — окно языка и окно с полосой не мылятся на 125–200 %;
- **папка** — всегда `%LOCALAPPDATA%\Programs\Cord`: в режиме «одним окном» electron-builder назвал бы её по имени пакета (`cord-desktop`), поэтому `customInit` ставит свежую установку в `Programs\Cord`; обновление идёт туда, где стоит (`InstallLocation`);
- **ярлыки** — на рабочем столе и в «Пуск» всегда (`createDesktopShortcut: true`, AUMID ставит electron-builder); при обновлении он их не трогает (`--keep-shortcuts`). Переход с ≤ 1.0.5: прежний деинсталлятор при обновлении удаляет ярлык рабочего стола, поэтому `customInstall` один раз возвращает его тем, у кого стояла старая галочка (`DesktopShortcut = 1`), и убирает это значение;
- надпись над полосой и вопрос деинсталлятора — стандартные тексты electron-builder (`installing`, `areYouSureToUninstall`) на языке мастера; свой текст один — описание в карточке (`Comments`, восемь языков);
- `uninstallDisplayName: "Cord"`, издатель «Cord», `deleteAppDataOnUninstall: false`; `VersionInfo*` в том же тоне.

`test-installer.ps1` в CI: тихая установка ≤ 20 с (порог R105 — предупреждение, `metrics.json` → `installSeconds`), папка `Programs\Cord`, ярлыки с AUMID; с `-Screenshots` — обычный запуск со снимками окна языка и окна с полосой в артефакт; с `-Previous` — обновление поверх настоящего 1.0.5 (`--updated /S --force-run`, как `quitAndInstall(true, true)`): папка, ярлыки с AUMID, язык, `DesktopShortcut`, сборка на диске, запуск, одна запись удаления — `metrics.json` → `update`, неудача — сбой.

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
2. Rust из образа раннера, версия закреплена в `native/rust-toolchain.toml` (1.99.1). `cargo test` (чистая логика) и `cargo build --release` → `scripts/build-native.mjs` копирует `cord_native.dll` в `dist/native/cord-native.win32-x64-msvc.node` (в `asarUnpack`); `@napi-rs/cli` не нужен. Кэш `~/.cargo/registry` и `native/target` — `actions/cache`. Дымовой прогон грузит модуль в utility-процессе и проверяет флаги `ptt`/`capture.app-audio`; `test-installer.ps1` — файл в `app.asar.unpacked` и строку «native: загружен» в журнале установленного Cord.
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
