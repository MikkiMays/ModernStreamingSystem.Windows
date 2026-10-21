//! Процессы без `OpenProcess`: PID по окну и карта «кто чей родитель» из снимка Toolhelp.
use std::collections::HashMap;
use std::ffi::c_void;

use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

pub fn window_process(hwnd: isize) -> Option<u32> {
    let handle = HWND(hwnd as *mut c_void);
    let mut pid = 0u32;
    // SAFETY: HWND — просто число; при чужом или мёртвом окне функция вернёт 0.
    let thread = unsafe { GetWindowThreadProcessId(handle, Some(&mut pid)) };
    (thread != 0 && pid != 0).then_some(pid)
}

/// `pid → родитель` для всех процессов. Пустая карта — снимок не удался (Cord тогда «не свой»).
pub fn parent_map() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    // SAFETY: обычная последовательность Toolhelp; дескриптор закрывается ниже.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return map;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    map
}
