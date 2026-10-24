//! Переднее окно для оверлея (T23, ADR 0001 §4.3; различение игр — R62): на каком мониторе оно,
//! занимает ли весь экран, без рамки ли оно, эксклюзивный ли это полноэкранный Direct3D, чей это
//! процесс (имя exe) и принадлежит ли он дереву процессов Cord. Решения — чистые функции; Windows
//! только снимает замер.
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }
}

/// `WS_CAPTION` и `WS_THICKFRAME` (winuser.h): заголовок и рамка изменения размера.
pub const WS_CAPTION: u32 = 0x00C0_0000;
pub const WS_THICKFRAME: u32 = 0x0004_0000;
/// Заголовок окна в событии — не длиннее этого (символов): для имени игры и поиска источника показа.
pub const TITLE_LIMIT: usize = 80;

/// Замер переднего окна, как его видит Windows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Sample {
    pub hwnd: isize,
    pub pid: u32,
    pub window: Rect,
    pub monitor: Rect,
    pub class: String,
    /// `GWL_STYLE` окна.
    pub style: u32,
    /// Заголовок окна (`GetWindowText` — для чужого процесса Windows отдаёт сохранённый текст, не спрашивая окно).
    pub title: String,
    /// `SHQueryUserNotificationState() == QUNS_RUNNING_D3D_FULL_SCREEN`: впереди эксклюзивный полноэкранный Direct3D.
    pub d3d_fullscreen: bool,
}

/// Событие для оболочки: только когда что-то поменялось.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Change {
    pub hwnd: isize,
    pub pid: u32,
    pub fullscreen: bool,
    pub cord: bool,
    pub monitor: Rect,
    /// Имя исполняемого файла процесса окна (`cs2.exe`); пусто — процесса нет в снимке.
    pub exe: String,
    pub title: String,
    /// Окно без заголовка и рамки ровно по монитору — «без рамки» (borderless) игр.
    pub borderless: bool,
    /// Эксклюзивный полноэкранный режим: окно поверх игры Windows не покажет.
    pub exclusive: bool,
}

/// Процесс из снимка Toolhelp: родитель и имя exe (`szExeFile`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Process {
    pub parent: u32,
    pub exe: String,
}

/// Окно на весь монитор: закрывает его целиком (рамка borderless тоже считается) и это не рабочий
/// стол (`Progman`/`WorkerW`) — тот всегда «во весь экран», а оверлей над ним не нужен.
pub fn is_fullscreen(sample: &Sample) -> bool {
    if is_desktop(sample) {
        return false;
    }
    let w = &sample.window;
    let m = &sample.monitor;
    m.width() > 0 && m.height() > 0 && w.left <= m.left && w.top <= m.top && w.right >= m.right && w.bottom >= m.bottom
}

/// «Без рамки»: ни заголовка, ни рамки изменения размера, и окно ровно по монитору. Так рисуют себя
/// игры в режиме «полноэкранный в окне» — оверлей поверх них виден.
pub fn is_borderless(sample: &Sample) -> bool {
    !is_desktop(sample) && sample.style & (WS_CAPTION | WS_THICKFRAME) == 0 && sample.monitor.width() > 0 && sample.window == sample.monitor
}

fn is_desktop(sample: &Sample) -> bool {
    sample.class == "Progman" || sample.class == "WorkerW"
}

/// Заголовок не длиннее `TITLE_LIMIT` символов, без управляющих символов и пробелов по краям.
pub fn clip_title(raw: &str) -> String {
    let clean: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    clean.trim().chars().take(TITLE_LIMIT).collect::<String>().trim_end().to_string()
}

/// `szExeFile` снимка (UTF-16 до первого нуля) → имя файла; путь, если вдруг пришёл, отрезается.
pub fn exe_name(raw: &[u16]) -> String {
    let end = raw.iter().position(|&unit| unit == 0).unwrap_or(raw.len());
    let name = String::from_utf16_lossy(&raw[..end]);
    name.rsplit(['\\', '/']).next().unwrap_or_default().trim().to_string()
}

/// Потомок ли `pid` процесса `root` (сам `root` — тоже «да»). Карта — `pid → процесс`;
/// защита от колец: не больше 64 шагов.
pub fn is_descendant(processes: &HashMap<u32, Process>, pid: u32, root: u32) -> bool {
    let mut current = pid;
    for _ in 0..64 {
        if current == root {
            return true;
        }
        match processes.get(&current) {
            Some(process) if process.parent != current && process.parent != 0 => current = process.parent,
            _ => return false,
        }
    }
    false
}

/// Жив ли процесс: тот же PID в снимке и с тем же exe (номер мог достаться другому процессу).
pub fn is_alive(processes: &HashMap<u32, Process>, pid: u32, exe: &str) -> bool {
    processes.get(&pid).is_some_and(|process| process.exe.eq_ignore_ascii_case(exe))
}

#[derive(Default)]
pub struct Tracker {
    last: Option<Change>,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Новый замер → изменение, если оно есть. `cord` и `exe` вычисляет вызывающий (по снимку процессов).
    pub fn update(&mut self, sample: &Sample, cord: bool, exe: &str) -> Option<Change> {
        let fullscreen = is_fullscreen(sample);
        let next = Change {
            hwnd: sample.hwnd,
            pid: sample.pid,
            fullscreen,
            cord,
            monitor: sample.monitor,
            exe: exe.to_string(),
            title: clip_title(&sample.title),
            borderless: is_borderless(sample),
            // Эксклюзивный режим — свойство полноэкранного окна впереди, а не всей системы: у Cord и
            // у окна поменьше его не бывает, даже если Windows ещё не сбросила состояние.
            exclusive: sample.d3d_fullscreen && fullscreen && !cord,
        };
        if self.last.as_ref() == Some(&next) {
            return None;
        }
        self.last = Some(next.clone());
        Some(next)
    }

    pub fn reset(&mut self) {
        self.last = None;
    }

    pub fn last_hwnd(&self) -> Option<isize> {
        self.last.as_ref().map(|change| change.hwnd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> Rect {
        Rect { left: 0, top: 0, right: 2560, bottom: 1440 }
    }

    fn sample(class: &str, window: Rect) -> Sample {
        Sample { hwnd: 7, pid: 100, window, monitor: monitor(), class: class.into(), style: 0x1600_0000, title: "Game".into(), d3d_fullscreen: false }
    }

    fn utf16(text: &str) -> Vec<u16> {
        let mut raw: Vec<u16> = text.encode_utf16().collect();
        raw.resize(260, 0);
        raw
    }

    #[test]
    fn fullscreen_when_the_window_covers_the_monitor() {
        assert!(is_fullscreen(&sample("UnityWndClass", monitor())));
        assert!(is_fullscreen(&sample("Game", Rect { left: -8, top: -8, right: 2568, bottom: 1448 })), "рамка за краями");
        assert!(!is_fullscreen(&sample("Chrome_WidgetWin_1", Rect { left: 100, top: 50, right: 1800, bottom: 1000 })));
        assert!(!is_fullscreen(&sample("Progman", monitor())), "рабочий стол — не игра");
        assert!(!is_fullscreen(&sample("WorkerW", monitor())));
    }

    #[test]
    fn borderless_is_a_window_without_caption_and_frame_exactly_on_the_monitor() {
        assert!(is_borderless(&sample("UnrealWindow", monitor())), "WS_POPUP | WS_VISIBLE ровно по монитору");
        let framed = Sample { style: 0x16CF_0000, ..sample("Game", Rect { left: -8, top: -8, right: 2568, bottom: 1448 }) };
        assert!(!is_borderless(&framed), "развёрнутое окно с рамкой — полноэкранное, но не без рамки");
        let captioned = Sample { style: WS_CAPTION, ..sample("Game", monitor()) };
        assert!(!is_borderless(&captioned));
        let resizable = Sample { style: WS_THICKFRAME, ..sample("Game", monitor()) };
        assert!(!is_borderless(&resizable));
        assert!(!is_borderless(&sample("Game", Rect { left: 0, top: 0, right: 1280, bottom: 720 })), "окно поменьше монитора");
        assert!(!is_borderless(&sample("Progman", monitor())), "рабочий стол");
    }

    #[test]
    fn titles_are_clipped_and_cleaned() {
        assert_eq!(clip_title("  Counter-Strike 2  "), "Counter-Strike 2");
        assert_eq!(clip_title("a\tb\nc"), "a b c");
        let long = "Ж".repeat(100);
        assert_eq!(clip_title(&long).chars().count(), TITLE_LIMIT, "по символам, а не по байтам");
        assert_eq!(clip_title(""), "");
    }

    #[test]
    fn exe_names_come_from_the_snapshot_buffer() {
        assert_eq!(exe_name(&utf16("cs2.exe")), "cs2.exe");
        assert_eq!(exe_name(&utf16("Cord.exe")), "Cord.exe");
        assert_eq!(exe_name(&utf16("C:\\Games\\Witcher\\witcher3.exe")), "witcher3.exe", "путь отрезается");
        assert_eq!(exe_name(&utf16("")), "");
        assert_eq!(exe_name(&"игра.exe".encode_utf16().collect::<Vec<_>>()), "игра.exe", "без нуля в конце");
    }

    fn processes() -> HashMap<u32, Process> {
        [(10, 1, "Cord.exe"), (20, 10, "Cord.exe"), (30, 20, "crashpad.exe"), (40, 50, "a.exe"), (50, 40, "b.exe"), (77, 4, "cs2.exe")]
            .into_iter()
            .map(|(pid, parent, exe)| (pid, Process { parent, exe: exe.into() }))
            .collect()
    }

    #[test]
    fn descendant_walks_parents_and_survives_cycles() {
        let map = processes();
        assert!(is_descendant(&map, 30, 10));
        assert!(is_descendant(&map, 10, 10));
        assert!(!is_descendant(&map, 30, 99));
        assert!(!is_descendant(&map, 40, 10), "кольцо родителей не зацикливает");
    }

    #[test]
    fn alive_means_the_same_pid_with_the_same_exe() {
        let map = processes();
        assert!(is_alive(&map, 77, "cs2.exe"));
        assert!(is_alive(&map, 77, "CS2.EXE"), "регистр имени не важен");
        assert!(!is_alive(&map, 77, "dota2.exe"), "номер достался другому процессу");
        assert!(!is_alive(&map, 78, "cs2.exe"));
    }

    #[test]
    fn tracker_reports_only_changes() {
        let mut tracker = Tracker::new();
        let game = sample("Game", monitor());
        let first = tracker.update(&game, false, "game.exe").expect("первый замер — событие");
        assert!(first.fullscreen && !first.cord && first.borderless && !first.exclusive);
        assert_eq!((first.exe.as_str(), first.title.as_str()), ("game.exe", "Game"));
        assert_eq!(tracker.update(&game, false, "game.exe"), None);
        let renamed = Sample { title: "Game — level 2".into(), ..game.clone() };
        assert!(tracker.update(&renamed, false, "game.exe").is_some(), "сменился заголовок — событие");
        let cord = Sample { hwnd: 8, pid: 5, ..game.clone() };
        let change = tracker.update(&cord, true, "Cord.exe").unwrap();
        assert!(change.cord);
        tracker.reset();
        assert!(tracker.update(&cord, true, "Cord.exe").is_some());
    }

    #[test]
    fn exclusive_only_for_a_fullscreen_window_that_is_not_cord() {
        let mut tracker = Tracker::new();
        let d3d = Sample { d3d_fullscreen: true, ..sample("Game", monitor()) };
        assert!(tracker.update(&d3d, false, "game.exe").unwrap().exclusive);
        let small = Sample { window: Rect { left: 0, top: 0, right: 800, bottom: 600 }, ..d3d.clone() };
        assert!(!tracker.update(&small, false, "game.exe").unwrap().exclusive, "окно поменьше монитора");
        assert!(!tracker.update(&d3d, true, "Cord.exe").unwrap().exclusive, "Cord — не игра");
    }
}
