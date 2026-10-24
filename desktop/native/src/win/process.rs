//! Процессы: PID по окну и карта «кто чей родитель и как называется его exe» из снимка Toolhelp —
//! без `OpenProcess` (различение игр, R62: имя exe — `szExeFile` снимка, процесс игры не открывается);
//! приоритет своих процессов во встрече (`set_boost`, R01–R03) — `OpenProcess` только на свои
//! дочерние процессы Cord того же пользователя (`PROCESS_SET_INFORMATION`), чужие не открываются.
use std::collections::HashMap;
use std::ffi::c_void;

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{
    GetPriorityClass, OpenProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation, PROCESS_CREATION_FLAGS, PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use crate::boost::{priority_after, throttling_attempts};
use crate::foreground::{exe_name, Process};

pub fn window_process(hwnd: isize) -> Option<u32> {
    let handle = HWND(hwnd as *mut c_void);
    let mut pid = 0u32;
    // SAFETY: HWND — просто число; при чужом или мёртвом окне функция вернёт 0.
    let thread = unsafe { GetWindowThreadProcessId(handle, Some(&mut pid)) };
    (thread != 0 && pid != 0).then_some(pid)
}

/// `pid → (родитель, exe)` для всех процессов. Пустая карта — снимок не удался (Cord тогда «не свой»,
/// а у окна нет имени exe — игрой оно не считается).
pub fn process_map() -> HashMap<u32, Process> {
    let mut map = HashMap::new();
    // SAFETY: обычная последовательность Toolhelp; дескриптор закрывается ниже.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return map;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                map.insert(entry.th32ProcessID, Process { parent: entry.th32ParentProcessID, exe: exe_name(&entry.szExeFile) });
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    map
}

/// Жив ли процесс: тот же PID с тем же exe в свежем снимке (`foreground::is_alive`).
pub fn process_alive(pid: u32, exe: &str) -> bool {
    crate::foreground::is_alive(&process_map(), pid, exe)
}

/// Поднять (`on`) — EcoQoS и загрубление таймера выключены, класс `HIGH`; вернуть —
/// троттлингом снова распоряжается система, класс возвращается к обычному, если его поднимали мы.
/// EcoQoS не удалось (старая Windows) — не повод отказываться от приоритета; ошибка — только если
/// процесс не открылся или не вышло ни то, ни другое.
pub fn set_boost(pid: u32, on: bool) -> Result<(), String> {
    // SAFETY: дескриптор процесса закрывается ниже; структура живёт до конца вызова.
    unsafe {
        let process = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|error| format!("OpenProcess {pid}: {error}"))?;
        let result = apply_boost(process, on);
        let _ = CloseHandle(process);
        result
    }
}

fn apply_boost(process: HANDLE, on: bool) -> Result<(), String> {
    let mut throttling = Err(String::from("нет попыток"));
    for &(control, state) in throttling_attempts(on) {
        let info = PROCESS_POWER_THROTTLING_STATE { Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION, ControlMask: control, StateMask: state };
        // SAFETY: указатель на структуру и её размер — как требует ProcessPowerThrottling.
        throttling = unsafe { SetProcessInformation(process, ProcessPowerThrottling, &info as *const _ as *const c_void, std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32) }.map_err(|error| format!("EcoQoS: {error}"));
        if throttling.is_ok() {
            break;
        }
    }
    // SAFETY: дескриптор открыт с PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION.
    let current = unsafe { GetPriorityClass(process) };
    let priority = match priority_after(current, on) {
        // SAFETY: тот же дескриптор, класс — одна из констант PRIORITY_CLASS.
        Some(class) => unsafe { SetPriorityClass(process, PROCESS_CREATION_FLAGS(class)) }.map_err(|error| format!("приоритет: {error}")),
        None => Ok(()),
    };
    match (throttling, priority) {
        (Err(eco), Err(class)) => Err(format!("{eco}; {class}")),
        _ => Ok(()),
    }
}
