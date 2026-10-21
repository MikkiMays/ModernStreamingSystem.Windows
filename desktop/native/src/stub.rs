//! Не Windows: модуль собирается, чтобы `cargo check`/`cargo test` шли на Linux, но каждая
//! функция честно отказывает. Оболочка на таких машинах модуль и не грузит.
use napi::{Error, Result, Status};

use crate::{matcher, AudioCallback, ForegroundCallback, HotkeyCallback};

fn unsupported() -> Error {
    Error::new(Status::GenericFailure, "cord-native: только Windows")
}

pub fn start_input(_callback: HotkeyCallback) -> Result<()> {
    Err(unsupported())
}

pub fn set_bindings(_bindings: Vec<matcher::Binding>) -> Result<()> {
    Err(unsupported())
}

pub fn stop_input() -> Result<()> {
    Ok(())
}

pub fn watch_foreground(_root_pid: u32, _interval_ms: u32, _callback: ForegroundCallback) -> Result<()> {
    Err(unsupported())
}

pub fn stop_foreground() -> Result<()> {
    Ok(())
}

pub fn start_audio(_pid: u32, _include: bool, _callback: AudioCallback) -> Result<u32> {
    Err(unsupported())
}

pub fn stop_audio(_session: u32) -> Result<()> {
    Ok(())
}

pub fn window_process(_hwnd: isize) -> Option<u32> {
    None
}
