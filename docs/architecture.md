# Архитектура Windows-клиента

Клиент — Electron со своим Chromium (`desktop/`). Окно, трей, обновления и всё, что требует Windows, делает
оболочка; встреча — тот же React-клиент, что и в браузере, он приходит с сервера Cord. Почему так и как
устроено каждое решение — [ADR 0001](adr/0001-electron-shell.md); здесь — карта.

```mermaid
flowchart LR
  M[main: окна, трей, мост, обновление, каталог] -->|MessagePort| N[utility: cord-native — клавиши, звук приложения, окна]
  M --> S[renderer «сервер»: React-клиент https://сервер/]
  M --> L[renderer «оболочка»: cord-app:// — заставка, загрузка, серверы, оверлей, мини-окно]
  S <-->|window.cordDesktop, протокол 2| M
  S <-->|HTTPS / WSS| A[Ядро Cord]
  S <-->|WebRTC| K[LiveKit SFU]
  M -->|electron-updater, подпись Ed25519| U[/downloads/windows/desktop/ на зеркале]
  M -->|GET /api/v1/catalog, JWS Ed25519| A
```

## Процессы

| Процесс | Что делает | Доступ |
| --- | --- | --- |
| main (Node) | Окна, трей, маршрутизатор моста с проверкой origin, обновление, каталог серверов, общие настройки (`shared-preferences.json`, секреты — `safeStorage`) | полный; страниц не исполняет |
| utility `native` | `cord-native.node` (Rust): Raw Input для push-to-talk, WASAPI process loopback для звука приложения, переднее окно для оверлея, приоритет процессов | только через MessagePort от main; упал — функции выключаются, main перезапускает |
| renderer «сервер» | React-клиент сервера | `sandbox`, `contextIsolation`, без Node, preload `server.ts` |
| renderer «оболочка» | `cord-app://`: заставка обновления, загрузка, офлайн, серверы, оверлей, мини-окно звонка | `sandbox`, preload `shell.ts` |

Навигация главного окна — только в origin выбранного сервера; каждый вызов моста проверяет, откуда он.

## Мост `window.cordDesktop`

Узкий API для страницы сервера: захват экрана и окон своим выбором источника, глобальные клавиши,
оверлей и мини-окно, состояние звонка для трея и панели задач, общие настройки (`prefs.shared`, с 1.1.0),
сведения о GPU для выбора кодека (`app.gpu`, `codec.av1hw`, с 1.1.0). Контракт — в репозитории ядра:
`contracts/desktop-bridge.v2.schema.json`; копия в `desktop/` сверяется тестом по хэшу.

## Серверы и настройки

Список серверов — подписанный каталог ядра (`GET /api/v1/catalog`, JWS Ed25519, ключи вшиты в
`desktop/build/catalog-keys.json`); своих адресов окно серверов не принимает. Настройки общие для всех
серверов, у сервера своё — только комнаты и избранное (ADR §3.4).

## Обновления и установщик

Обновления — только с зеркала Cord, адрес вшит при сборке: [updating.md](updating.md). Установщик —
NSIS из electron-builder: [installer.md](installer.md).

## Где код

| Каталог | Что |
| --- | --- |
| `desktop/src/main` | main-процесс: окна, мост, обновление, каталог, трей, оверлей, мини-окно, захват, кодеки |
| `desktop/src/preload` | `server.ts`, `shell.ts` |
| `desktop/src/shell` | страницы `cord-app://` |
| `desktop/native` | `cord-native` (Rust + napi-rs) |
| `desktop/build` | установщик, иконки, ключи обновлений и каталога |
| `desktop/test` | vitest и Playwright `_electron` |

Прежний клиент на WinUI 3 + WebView2 (`src/`, выпуски 0.x) удалён 01.11.2026; его история — в Git и в
`docs/releases/0.*.md`.
