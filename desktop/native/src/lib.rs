//! `cord-native` — нативный модуль клиента Cord для Windows (ADR 0001 §4.6). Загружается только в
//! utility-процессе оболочки (`src/native/host.ts`), наружу — узкие функции:
//!
//! - `startInput`/`setBindings`/`stopInput` — Raw Input: сочетания клавиш и кнопок мыши с фазой
//!   «нажал/отпустил», без хуков и без отбора клавиши у игры (§4.2);
//! - `startAudio`/`stopAudio` — process loopback: звук одного приложения или всей системы, кроме
//!   дерева процессов Cord (§4.1);
//! - `watchForeground`/`stopForeground` — переднее окно, его монитор и полноэкранность для оверлея,
//!   без открытия процесса игры (§4.3);
//! - `windowProcess`, `currentProcess` — PID по HWND источника `window:<hwnd>:0` и свой PID;
//! - `boostProcess` — приоритет своих процессов во встрече: EcoQoS выкл., `ABOVE_NORMAL` (R01–R03).
//!
//! Чистая логика (`keys`, `matcher`, `pcm`, `foreground`, `boost`) собирается и проверяется на любой
//! платформе; Windows-часть — `win/*`. На остальных платформах функции отвечают отказом, а
//! `platformSupported()` — `false`.
#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Status;
use napi_derive::napi;

pub mod boost;
pub mod foreground;
pub mod keys;
pub mod matcher;
pub mod pcm;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as platform;
#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
use stub as platform;

/// Сочетание из `hotkeys.configure` веба: имя клавиши DOM или `Mouse3`…`Mouse5`, модификаторы.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct Binding {
    pub id: String,
    pub code: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

/// `{id, phase: 'down' | 'up'}` — единственное, что уходит из модуля про клавиши.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct HotkeyEvent {
    pub id: String,
    pub phase: String,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Переднее окно сменилось: PID, полноэкранность, принадлежность Cord, монитор (физические пиксели).
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ForegroundEvent {
    pub hwnd: f64,
    pub pid: u32,
    pub fullscreen: bool,
    pub cord: bool,
    pub monitor: MonitorRect,
}

/// `mode: 'include'` — звук дерева процессов `pid`; `'exclude'` — всё, кроме него.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioOptions {
    pub pid: u32,
    pub mode: String,
}

/// `state: 'pcm'` с порцией float32 (480 кадров × 2 канала, 48 кГц), `'ended'` или `'error'` с причиной.
#[napi(object)]
pub struct AudioEvent {
    pub state: String,
    pub pcm: Option<Float32Array>,
    pub reason: Option<String>,
}

pub type HotkeyCallback = ThreadsafeFunction<HotkeyEvent, (), HotkeyEvent, Status, false>;
pub type ForegroundCallback = ThreadsafeFunction<ForegroundEvent, (), ForegroundEvent, Status, false>;
pub type AudioCallback = ThreadsafeFunction<AudioEvent, (), AudioEvent, Status, false>;

impl From<foreground::Change> for ForegroundEvent {
    fn from(change: foreground::Change) -> Self {
        Self {
            hwnd: change.hwnd as f64,
            pid: change.pid,
            fullscreen: change.fullscreen,
            cord: change.cord,
            monitor: MonitorRect {
                x: change.monitor.left,
                y: change.monitor.top,
                width: change.monitor.width(),
                height: change.monitor.height(),
            },
        }
    }
}

/// Сочетания веба → сочетания машины состояний; возвращает те, что разобрать не удалось.
pub fn parse_bindings(bindings: &[Binding]) -> (Vec<matcher::Binding>, Vec<String>) {
    let mut parsed = Vec::new();
    let mut rejected = Vec::new();
    for binding in bindings {
        match keys::parse_code(&binding.code) {
            Some(trigger) => parsed.push(matcher::Binding {
                id: binding.id.clone(),
                trigger,
                modifiers: keys::Modifiers { ctrl: binding.ctrl, alt: binding.alt, shift: binding.shift, meta: binding.meta },
            }),
            None => rejected.push(binding.id.clone()),
        }
    }
    (parsed, rejected)
}

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn platform_supported() -> bool {
    cfg!(windows)
}

/// Поднять скрытое окно-приёмник Raw Input в своём потоке. Повторный вызов — без последствий.
#[napi]
pub fn start_input(callback: HotkeyCallback) -> Result<()> {
    platform::start_input(callback)
}

/// Заменить набор сочетаний целиком; вернуть id тех, что зарегистрировать нельзя.
#[napi]
pub fn set_bindings(bindings: Vec<Binding>) -> Result<Vec<String>> {
    let (parsed, rejected) = parse_bindings(&bindings);
    platform::set_bindings(parsed)?;
    Ok(rejected)
}

#[napi]
pub fn stop_input() -> Result<()> {
    platform::stop_input()
}

/// Следить за передним окном: событие при каждой смене окна, монитора или полноэкранности.
/// `root_pid` — главный процесс Cord: его дерево считается «своим».
#[napi]
pub fn watch_foreground(root_pid: u32, interval_ms: u32, callback: ForegroundCallback) -> Result<()> {
    platform::watch_foreground(root_pid, interval_ms.clamp(100, 2000), callback)
}

#[napi]
pub fn stop_foreground() -> Result<()> {
    platform::stop_foreground()
}

/// Захват звука процесса: вернуть номер сеанса. Порции идут в `callback` с потока захвата.
#[napi]
pub fn start_audio(options: AudioOptions, callback: AudioCallback) -> Result<u32> {
    let include = match options.mode.as_str() {
        "include" => true,
        "exclude" => false,
        other => return Err(Error::new(Status::InvalidArg, format!("неизвестный режим звука: {other}"))),
    };
    platform::start_audio(options.pid, include, callback)
}

#[napi]
pub fn stop_audio(session: u32) -> Result<()> {
    platform::stop_audio(session)
}

/// PID процесса окна по HWND (источник `window:<hwnd>:0`); `null` — окна нет.
#[napi]
pub fn window_process(hwnd: f64) -> Option<u32> {
    if !hwnd.is_finite() || hwnd < 0.0 {
        return None;
    }
    platform::window_process(hwnd as isize)
}

#[napi]
pub fn current_process() -> u32 {
    std::process::id()
}

/// Поднять (`on`) или вернуть приоритет своего процесса на время встречи (R01–R03): EcoQoS и
/// загрубление таймера выключены, класс `ABOVE_NORMAL`. Ошибка — с причиной (процесса нет и т. п.).
#[napi]
pub fn boost_process(pid: u32, on: bool) -> Result<()> {
    platform::set_boost(pid, on).map_err(|reason| Error::new(Status::GenericFailure, reason))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_bindings_are_parsed_and_the_rest_reported() {
        let list = vec![
            Binding { id: "ptt".into(), code: "Mouse4".into(), ctrl: false, alt: false, shift: false, meta: false },
            Binding { id: "mic.toggle".into(), code: "KeyM".into(), ctrl: true, alt: false, shift: true, meta: false },
            Binding { id: "deafen".into(), code: "Mouse1".into(), ctrl: false, alt: false, shift: false, meta: false },
        ];
        let (parsed, rejected) = parse_bindings(&list);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].modifiers, keys::Modifiers { ctrl: true, alt: false, shift: true, meta: false });
        assert_eq!(rejected, vec!["deafen".to_string()]);
    }

    #[test]
    fn foreground_change_becomes_an_event_with_monitor_size() {
        let event: ForegroundEvent = foreground::Change {
            hwnd: 42,
            pid: 7,
            fullscreen: true,
            cord: false,
            monitor: foreground::Rect { left: 2560, top: 0, right: 4480, bottom: 1080 },
        }
        .into();
        assert_eq!(event.hwnd, 42.0);
        assert_eq!((event.monitor.x, event.monitor.width, event.monitor.height), (2560, 1920, 1080));
    }
}
