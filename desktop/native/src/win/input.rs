//! Скрытое окно в своём потоке: приёмник Raw Input (`RIDEV_INPUTSINK` — ввод приходит и когда Cord
//! не на переднем плане) и таймеры — опрос переднего окна для оверлея и страховка отпускания
//! push-to-talk через `GetAsyncKeyState` (UIPI: Windows не доставит отпускание, если игра от
//! администратора вышла на передний план посреди удержания).
//!
//! Никаких хуков (`WH_KEYBOARD_LL`) и никакой задержки системному вводу: Raw Input — копия событий,
//! клавиша остаётся у игры.
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{LazyLock, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Error, Result, Status};
use windows::core::w;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::Input::{GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowThreadProcessId, KillTimer, PostMessageW, PostQuitMessage, RegisterClassW, SetTimer, TranslateMessage, MSG, WINDOW_EX_STYLE,
    WM_CLOSE, WM_DESTROY, WM_INPUT, WM_TIMER, WNDCLASSW, WS_OVERLAPPED,
};

use crate::foreground::{self, is_descendant, Sample, Tracker};
use crate::keys::Trigger;
use crate::matcher::{Matcher, Phase};
use crate::{ForegroundCallback, ForegroundEvent, HotkeyCallback, HotkeyEvent};

const TIMER_FOREGROUND: usize = 1;
const TIMER_HOLD: usize = 2;
const HOLD_POLL_MS: u32 = 50;
const PARENTS_TTL: Duration = Duration::from_secs(5);

/// Флаги `RAWKEYBOARD.Flags` и `RAWMOUSE.usButtonFlags` (winuser.h).
const RI_KEY_BREAK: u16 = 0x01;
const RI_KEY_E0: u16 = 0x02;
const RI_MOUSE_MIDDLE_DOWN: u16 = 0x0010;
const RI_MOUSE_MIDDLE_UP: u16 = 0x0020;
const RI_MOUSE_BUTTON_4_DOWN: u16 = 0x0040;
const RI_MOUSE_BUTTON_4_UP: u16 = 0x0080;
const RI_MOUSE_BUTTON_5_DOWN: u16 = 0x0100;
const RI_MOUSE_BUTTON_5_UP: u16 = 0x0200;

struct ForegroundWatch {
    callback: ForegroundCallback,
    root_pid: u32,
    interval_ms: u32,
    tracker: Tracker,
    parents: HashMap<u32, u32>,
    parents_at: Option<Instant>,
}

#[derive(Default)]
struct Shared {
    matcher: Matcher,
    hotkeys: Option<HotkeyCallback>,
    foreground: Option<ForegroundWatch>,
    hwnd: isize,
    thread: Option<JoinHandle<()>>,
    hold_timer: bool,
}

static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(|| Mutex::new(Shared::default()));

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn failure(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

pub fn start_input(callback: HotkeyCallback) -> Result<()> {
    let mut state = shared();
    state.hotkeys = Some(callback);
    ensure_thread(&mut state)
}

pub fn set_bindings(bindings: Vec<crate::matcher::Binding>) -> Result<()> {
    let mut state = shared();
    let released = state.matcher.set_bindings(bindings);
    emit_hotkeys(&mut state, released);
    update_hold_timer(&mut state);
    Ok(())
}

pub fn stop_input() -> Result<()> {
    let mut state = shared();
    let released = state.matcher.set_bindings(Vec::new());
    emit_hotkeys(&mut state, released);
    state.hotkeys = None;
    stop_thread_if_idle(&mut state);
    Ok(())
}

pub fn watch_foreground(root_pid: u32, interval_ms: u32, callback: ForegroundCallback) -> Result<()> {
    let mut state = shared();
    state.foreground = Some(ForegroundWatch { callback, root_pid, interval_ms, tracker: Tracker::new(), parents: HashMap::new(), parents_at: None });
    ensure_thread(&mut state)?;
    let hwnd = HWND(state.hwnd as *mut c_void);
    // SAFETY: окно живо, пока поток работает; таймер с тем же id просто перезапускается.
    unsafe {
        SetTimer(Some(hwnd), TIMER_FOREGROUND, interval_ms, None);
    }
    Ok(())
}

pub fn stop_foreground() -> Result<()> {
    let mut state = shared();
    if state.foreground.take().is_some() && state.hwnd != 0 {
        // SAFETY: см. watch_foreground.
        unsafe {
            let _ = KillTimer(Some(HWND(state.hwnd as *mut c_void)), TIMER_FOREGROUND);
        }
    }
    stop_thread_if_idle(&mut state);
    Ok(())
}

fn ensure_thread(state: &mut Shared) -> Result<()> {
    if state.thread.is_some() {
        return Ok(());
    }
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<std::result::Result<isize, String>>();
    let thread = std::thread::Builder::new()
        .name("cord-native-input".into())
        .spawn(move || run_thread(ready_tx))
        .map_err(|error| failure(format!("поток ввода: {error}")))?;
    match ready_rx.recv() {
        Ok(Ok(hwnd)) => {
            state.hwnd = hwnd;
            state.thread = Some(thread);
            Ok(())
        }
        Ok(Err(message)) => {
            let _ = thread.join();
            Err(failure(message))
        }
        Err(_) => {
            let _ = thread.join();
            Err(failure("поток ввода не ответил"))
        }
    }
}

fn stop_thread_if_idle(state: &mut Shared) {
    if state.hotkeys.is_some() || state.foreground.is_some() {
        return;
    }
    if state.hwnd != 0 {
        // SAFETY: WM_CLOSE обрабатывается в потоке окна и завершает цикл сообщений.
        unsafe {
            let _ = PostMessageW(Some(HWND(state.hwnd as *mut c_void)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        state.hwnd = 0;
    }
    if let Some(thread) = state.thread.take() {
        let _ = thread.join();
    }
}

fn run_thread(ready: std::sync::mpsc::Sender<std::result::Result<isize, String>>) {
    // SAFETY: классическая регистрация класса и окна; все дескрипторы живут в этом потоке.
    unsafe {
        let instance = match GetModuleHandleW(None) {
            Ok(module) => HINSTANCE(module.0),
            Err(error) => {
                let _ = ready.send(Err(format!("GetModuleHandle: {error}")));
                return;
            }
        };
        let class_name = w!("CordNativeInput");
        let class = WNDCLASSW { lpfnWndProc: Some(window_proc), hInstance: instance, lpszClassName: class_name, ..Default::default() };
        // Повторная регистрация того же класса возвращает 0 — это не ошибка.
        RegisterClassW(&class);
        let hwnd = match CreateWindowExW(WINDOW_EX_STYLE(0), class_name, w!("Cord input"), WS_OVERLAPPED, 0, 0, 0, 0, None, None, Some(instance), None) {
            Ok(hwnd) => hwnd,
            Err(error) => {
                let _ = ready.send(Err(format!("CreateWindowEx: {error}")));
                return;
            }
        };
        let devices = [
            RAWINPUTDEVICE { usUsagePage: 0x01, usUsage: 0x06, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd },
            RAWINPUTDEVICE { usUsagePage: 0x01, usUsage: 0x02, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd },
        ];
        if let Err(error) = RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32) {
            let _ = DestroyWindow(hwnd);
            let _ = ready.send(Err(format!("RegisterRawInputDevices: {error}")));
            return;
        }
        let _ = ready.send(Ok(hwnd.0 as isize));
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_INPUT => {
            on_raw_input(hwnd, lparam);
            // SAFETY: после WM_INPUT система ждёт DefWindowProc для очистки.
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        WM_TIMER => {
            match wparam.0 {
                TIMER_FOREGROUND => on_foreground_tick(),
                TIMER_HOLD => on_hold_tick(),
                _ => {}
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            // SAFETY: окно принадлежит этому потоку.
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            // SAFETY: завершает цикл GetMessage этого потока.
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        // SAFETY: прочие сообщения — системе.
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn on_raw_input(hwnd: HWND, lparam: LPARAM) {
    let mut buffer = [0u8; 128];
    let mut size = buffer.len() as u32;
    let header = std::mem::size_of::<RAWINPUTHEADER>() as u32;
    // SAFETY: буфер достаточен для RAWINPUT клавиатуры и мыши (≤ 48 байт); иначе функция вернёт u32::MAX.
    let got = unsafe { GetRawInputData(HRAWINPUT(lparam.0 as *mut c_void), RID_INPUT, Some(buffer.as_mut_ptr() as *mut c_void), &mut size, header) };
    if got == u32::MAX || (got as usize) < std::mem::size_of::<RAWINPUTHEADER>() {
        return;
    }
    // SAFETY: заполнено системой; читаем только по типу из заголовка.
    let raw = unsafe { &*(buffer.as_ptr() as *const RAWINPUT) };
    let mut state = shared();
    let events = if raw.header.dwType == RIM_TYPEKEYBOARD.0 {
        // SAFETY: тип — клавиатура.
        let keyboard = unsafe { raw.data.keyboard };
        if keyboard.VKey == 0 || keyboard.VKey == 0xFF {
            return;
        }
        let down = keyboard.Flags & RI_KEY_BREAK == 0;
        let extended = keyboard.Flags & RI_KEY_E0 != 0;
        state.matcher.on_key(keyboard.VKey, extended, down)
    } else if raw.header.dwType == RIM_TYPEMOUSE.0 {
        // SAFETY: тип — мышь; флаги кнопок лежат в анонимном объединении.
        let flags = unsafe { raw.data.mouse.Anonymous.Anonymous.usButtonFlags };
        let mut events = Vec::new();
        for (down_flag, up_flag, button) in [
            (RI_MOUSE_MIDDLE_DOWN, RI_MOUSE_MIDDLE_UP, 3u8),
            (RI_MOUSE_BUTTON_4_DOWN, RI_MOUSE_BUTTON_4_UP, 4u8),
            (RI_MOUSE_BUTTON_5_DOWN, RI_MOUSE_BUTTON_5_UP, 5u8),
        ] {
            if flags & down_flag != 0 {
                events.extend(state.matcher.on_mouse(button, true));
            }
            if flags & up_flag != 0 {
                events.extend(state.matcher.on_mouse(button, false));
            }
        }
        events
    } else {
        return;
    };
    let _ = hwnd;
    emit_hotkeys(&mut state, events);
    update_hold_timer(&mut state);
}

fn emit_hotkeys(state: &mut Shared, events: Vec<crate::matcher::Event>) {
    let Some(callback) = state.hotkeys.as_ref() else {
        return;
    };
    for event in events {
        let phase = match event.phase {
            Phase::Down => "down",
            Phase::Up => "up",
        };
        callback.call(HotkeyEvent { id: event.id, phase: phase.into() }, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Пока что-то удерживается — опрашивать состояние клавиш каждые 50 мс.
fn update_hold_timer(state: &mut Shared) {
    let want = state.matcher.holding();
    if want == state.hold_timer || state.hwnd == 0 {
        return;
    }
    let hwnd = HWND(state.hwnd as *mut c_void);
    // SAFETY: таймеры окна этого модуля.
    unsafe {
        if want {
            SetTimer(Some(hwnd), TIMER_HOLD, HOLD_POLL_MS, None);
        } else {
            let _ = KillTimer(Some(hwnd), TIMER_HOLD);
        }
    }
    state.hold_timer = want;
}

fn trigger_is_down(trigger: Trigger) -> bool {
    let vk = match trigger {
        Trigger::Key(vk) => vk as i32,
        Trigger::Mouse(3) => 0x04, // VK_MBUTTON
        Trigger::Mouse(4) => 0x05, // VK_XBUTTON1
        Trigger::Mouse(5) => 0x06, // VK_XBUTTON2
        Trigger::Mouse(_) => return false,
    };
    // SAFETY: чтение состояния клавиши; UIPI его не блокирует.
    unsafe { GetAsyncKeyState(vk) as u16 & 0x8000 != 0 }
}

fn on_hold_tick() {
    let mut state = shared();
    let events = state.matcher.poll(trigger_is_down);
    emit_hotkeys(&mut state, events);
    update_hold_timer(&mut state);
}

fn sample_foreground() -> Option<Sample> {
    // SAFETY: только чтение сведений об окне; процесс игры не открывается.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut window = RECT::default();
        if GetWindowRect(hwnd, &mut window).is_err() {
            return None;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let mut class = [0u16; 64];
        let length = GetClassNameW(hwnd, &mut class) as usize;
        Some(Sample {
            hwnd: hwnd.0 as isize,
            pid,
            window: rect(window),
            monitor: rect(info.rcMonitor),
            class: String::from_utf16_lossy(&class[..length.min(class.len())]),
        })
    }
}

fn rect(value: RECT) -> foreground::Rect {
    foreground::Rect { left: value.left, top: value.top, right: value.right, bottom: value.bottom }
}

fn on_foreground_tick() {
    let Some(sample) = sample_foreground() else {
        return;
    };
    let mut state = shared();
    let Some(watch) = state.foreground.as_mut() else {
        return;
    };
    let _ = watch.interval_ms;
    // Карта процессов — не чаще раза в 5 с, и только когда окно сменилось.
    let changed_window = watch.tracker_hwnd() != Some(sample.hwnd);
    let stale = watch.parents_at.map(|at| at.elapsed() > PARENTS_TTL).unwrap_or(true);
    if changed_window && stale {
        watch.parents = super::process::parent_map();
        watch.parents_at = Some(Instant::now());
    }
    let cord = sample.pid != 0 && is_descendant(&watch.parents, sample.pid, watch.root_pid);
    if let Some(change) = watch.tracker.update(&sample, cord) {
        watch.callback.call(ForegroundEvent::from(change), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

impl ForegroundWatch {
    fn tracker_hwnd(&self) -> Option<isize> {
        self.tracker.last_hwnd()
    }
}
