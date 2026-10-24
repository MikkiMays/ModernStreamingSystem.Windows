//! Windows: Raw Input и переднее окно — один скрытый поток с окном и циклом сообщений (`input`),
//! process loopback — поток захвата на сеанс (`audio`), дерево процессов — Toolhelp (`process`).
mod audio;
mod input;
mod process;

pub use audio::{start_audio, stop_audio};
pub use input::{set_bindings, start_input, stop_foreground, stop_input, watch_foreground};
pub use process::{process_alive, set_boost, window_process};
