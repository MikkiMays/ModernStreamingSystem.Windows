//! Переднее окно для оверлея (T23, ADR 0001 §4.3): на каком мониторе оно, занимает ли весь экран,
//! принадлежит ли дереву процессов Cord. Решения — чистые функции; Windows только снимает замер.
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

/// Замер переднего окна, как его видит Windows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Sample {
    pub hwnd: isize,
    pub pid: u32,
    pub window: Rect,
    pub monitor: Rect,
    pub class: String,
}

/// Событие для оболочки: только когда что-то поменялось.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Change {
    pub hwnd: isize,
    pub pid: u32,
    pub fullscreen: bool,
    pub cord: bool,
    pub monitor: Rect,
}

/// Окно на весь монитор: закрывает его целиком (рамка borderless тоже считается) и это не рабочий
/// стол (`Progman`/`WorkerW`) — тот всегда «во весь экран», а оверлей над ним не нужен.
pub fn is_fullscreen(sample: &Sample) -> bool {
    if sample.class == "Progman" || sample.class == "WorkerW" {
        return false;
    }
    let w = &sample.window;
    let m = &sample.monitor;
    m.width() > 0 && m.height() > 0 && w.left <= m.left && w.top <= m.top && w.right >= m.right && w.bottom >= m.bottom
}

/// Потомок ли `pid` процесса `root` (сам `root` — тоже «да»). Карта — `pid → родитель`;
/// защита от колец: не больше 64 шагов.
pub fn is_descendant(parents: &HashMap<u32, u32>, pid: u32, root: u32) -> bool {
    let mut current = pid;
    for _ in 0..64 {
        if current == root {
            return true;
        }
        match parents.get(&current) {
            Some(parent) if *parent != current && *parent != 0 => current = *parent,
            _ => return false,
        }
    }
    false
}

#[derive(Default)]
pub struct Tracker {
    last: Option<Change>,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Новый замер → изменение, если оно есть. `cord` вычисляет вызывающий (по дереву процессов).
    pub fn update(&mut self, sample: &Sample, cord: bool) -> Option<Change> {
        let next = Change { hwnd: sample.hwnd, pid: sample.pid, fullscreen: is_fullscreen(sample), cord, monitor: sample.monitor };
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
        Sample { hwnd: 7, pid: 100, window, monitor: monitor(), class: class.into() }
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
    fn descendant_walks_parents_and_survives_cycles() {
        let parents: HashMap<u32, u32> = [(10, 1), (20, 10), (30, 20), (40, 50), (50, 40)].into_iter().collect();
        assert!(is_descendant(&parents, 30, 10));
        assert!(is_descendant(&parents, 10, 10));
        assert!(!is_descendant(&parents, 30, 99));
        assert!(!is_descendant(&parents, 40, 10), "кольцо родителей не зацикливает");
    }

    #[test]
    fn tracker_reports_only_changes() {
        let mut tracker = Tracker::new();
        let game = sample("Game", monitor());
        let first = tracker.update(&game, false).expect("первый замер — событие");
        assert!(first.fullscreen && !first.cord);
        assert_eq!(tracker.update(&game, false), None);
        let cord = Sample { hwnd: 8, pid: 5, ..game.clone() };
        let change = tracker.update(&cord, true).unwrap();
        assert!(change.cord);
        tracker.reset();
        assert!(tracker.update(&cord, true).is_some());
    }
}
