//! Машина состояний сочетаний поверх Raw Input (T27, ADR 0001 §4.2). Получает голые события
//! «клавиша/кнопка нажата или отпущена», отдаёт события зарегистрированных сочетаний `{id, phase}`.
//!
//! Правила — как у `matchesHotkey` в вебе: модификаторы совпадают точно (Ctrl+M не срабатывает на
//! Ctrl+Shift+M). Автоповтор клавиши не даёт второго «нажал». Сочетание «отпущено», когда отпущена
//! его клавиша или любой из его модификаторов, либо когда опрос состояния клавиш (`poll`) показал,
//! что клавиши уже нет, — так push-to-talk не залипает, если Windows не доставила отпускание
//! (UIPI: игра от администратора вышла на передний план посреди удержания).
//!
//! Здесь нет Windows: модуль чистый и проверяется тестами.
use std::collections::HashSet;

use crate::keys::{modifier_of, Modifier, Modifiers, Trigger};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub id: String,
    pub trigger: Trigger,
    pub modifiers: Modifiers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Down,
    Up,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub id: String,
    pub phase: Phase,
}

#[derive(Default)]
pub struct Matcher {
    bindings: Vec<Binding>,
    /// Что физически удерживается: клавиши по виртуальному коду и стороне (E0), кнопки мыши.
    held: HashSet<(Trigger, bool)>,
    modifiers: Modifiers,
    /// Индексы сочетаний, которые сейчас «нажаты».
    active: Vec<usize>,
}

impl Matcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Заменить набор целиком. Всё, что было нажато, отпускается — чтобы push-to-talk не завис,
    /// если веб сменил сочетание посреди удержания.
    pub fn set_bindings(&mut self, bindings: Vec<Binding>) -> Vec<Event> {
        let released = self.release_all();
        self.bindings = bindings;
        released
    }

    pub fn bindings(&self) -> &[Binding] {
        &self.bindings
    }

    /// Есть ли удерживаемые сочетания — пока есть, стоит опрашивать `poll` чаще.
    pub fn holding(&self) -> bool {
        !self.active.is_empty()
    }

    /// Клавиша по виртуальному коду; `extended` — правая сторона (флаг E0), различает Ctrl/Alt.
    pub fn on_key(&mut self, vk: u16, extended: bool, down: bool) -> Vec<Event> {
        if let Some(modifier) = modifier_of(vk) {
            return self.on_modifier(modifier, vk, extended, down);
        }
        self.on_trigger(Trigger::Key(vk), extended, down)
    }

    pub fn on_mouse(&mut self, button: u8, down: bool) -> Vec<Event> {
        self.on_trigger(Trigger::Mouse(button), false, down)
    }

    /// Проверка по состоянию клавиш системы: удерживаемое сочетание, чья клавиша уже отпущена, —
    /// отпускается. `is_down` отвечает за клавиши и кнопки мыши.
    pub fn poll(&mut self, is_down: impl Fn(Trigger) -> bool) -> Vec<Event> {
        let mut events = Vec::new();
        let mut index = 0;
        while index < self.active.len() {
            let binding = &self.bindings[self.active[index]];
            if is_down(binding.trigger) {
                index += 1;
                continue;
            }
            let trigger = binding.trigger;
            events.push(Event { id: binding.id.clone(), phase: Phase::Up });
            self.active.remove(index);
            self.held.retain(|(held, _)| *held != trigger);
        }
        events
    }

    fn on_modifier(&mut self, modifier: Modifier, vk: u16, extended: bool, down: bool) -> Vec<Event> {
        let key = (Trigger::Key(vk), extended);
        if down {
            self.held.insert(key);
        } else {
            self.held.remove(&key);
        }
        // Модификатор удерживается, пока нажата хоть одна его клавиша (левая или правая).
        let still = self.held.iter().any(|(held, _)| matches!(held, Trigger::Key(code) if modifier_of(*code) == Some(modifier)));
        self.modifiers.set(modifier, still);
        if still {
            return Vec::new();
        }
        // Модификатор отпущен — отпускаются сочетания, которым он нужен.
        let mut events = Vec::new();
        let mut index = 0;
        while index < self.active.len() {
            let binding = &self.bindings[self.active[index]];
            if binding.modifiers.has(modifier) {
                events.push(Event { id: binding.id.clone(), phase: Phase::Up });
                self.active.remove(index);
            } else {
                index += 1;
            }
        }
        events
    }

    fn on_trigger(&mut self, trigger: Trigger, extended: bool, down: bool) -> Vec<Event> {
        let key = (trigger, extended);
        let mut events = Vec::new();
        if down {
            // Автоповтор: клавиша уже удерживается — второго «нажал» нет.
            if !self.held.insert(key) {
                return events;
            }
            for (index, binding) in self.bindings.iter().enumerate() {
                if binding.trigger == trigger && binding.modifiers == self.modifiers && !self.active.contains(&index) {
                    self.active.push(index);
                    events.push(Event { id: binding.id.clone(), phase: Phase::Down });
                }
            }
        } else {
            self.held.remove(&key);
            let mut index = 0;
            while index < self.active.len() {
                let binding = &self.bindings[self.active[index]];
                if binding.trigger == trigger {
                    events.push(Event { id: binding.id.clone(), phase: Phase::Up });
                    self.active.remove(index);
                } else {
                    index += 1;
                }
            }
        }
        events
    }

    fn release_all(&mut self) -> Vec<Event> {
        let events = self
            .active
            .iter()
            .map(|index| Event { id: self.bindings[*index].id.clone(), phase: Phase::Up })
            .collect();
        self.active.clear();
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::parse_code;

    fn binding(id: &str, code: &str, ctrl: bool, shift: bool) -> Binding {
        Binding { id: id.into(), trigger: parse_code(code).unwrap(), modifiers: Modifiers { ctrl, alt: false, shift, meta: false } }
    }

    fn down(id: &str) -> Event {
        Event { id: id.into(), phase: Phase::Down }
    }

    fn up(id: &str) -> Event {
        Event { id: id.into(), phase: Phase::Up }
    }

    #[test]
    fn hold_down_and_up_with_exact_modifiers() {
        let mut m = Matcher::new();
        m.set_bindings(vec![binding("ptt", "KeyV", true, false)]);
        assert!(m.on_key(0x11, false, true).is_empty()); // Ctrl
        assert_eq!(m.on_key(0x56, false, true), vec![down("ptt")]);
        assert!(m.holding());
        assert!(m.on_key(0x56, false, true).is_empty(), "автоповтор не даёт второго нажатия");
        assert_eq!(m.on_key(0x56, false, false), vec![up("ptt")]);
        assert!(!m.holding());
        assert!(m.on_key(0x11, false, false).is_empty());
    }

    #[test]
    fn extra_modifier_does_not_match() {
        let mut m = Matcher::new();
        m.set_bindings(vec![binding("mic", "KeyM", true, false)]);
        m.on_key(0x11, false, true);
        m.on_key(0x10, false, true); // Shift лишний
        assert!(m.on_key(0x4D, false, true).is_empty());
        m.on_key(0x4D, false, false);
        m.on_key(0x10, false, false);
        assert_eq!(m.on_key(0x4D, false, true), vec![down("mic")]);
    }

    #[test]
    fn bare_key_and_mouse_button_without_modifiers() {
        let mut m = Matcher::new();
        m.set_bindings(vec![binding("ptt", "Mouse4", false, false), binding("mic", "Space", false, false)]);
        assert_eq!(m.on_mouse(4, true), vec![down("ptt")]);
        assert_eq!(m.on_mouse(4, false), vec![up("ptt")]);
        m.on_key(0x11, false, true);
        assert!(m.on_key(0x20, false, true).is_empty(), "с Ctrl голый пробел не совпадает");
        m.on_key(0x20, false, false);
        m.on_key(0x11, false, false);
        assert_eq!(m.on_key(0x20, false, true), vec![down("mic")]);
    }

    #[test]
    fn releasing_a_required_modifier_releases_the_hold() {
        let mut m = Matcher::new();
        m.set_bindings(vec![binding("ptt", "KeyV", true, true)]);
        m.on_key(0xA2, false, true); // левый Ctrl как VK_LCONTROL
        m.on_key(0x10, false, true);
        assert_eq!(m.on_key(0x56, false, true), vec![down("ptt")]);
        assert_eq!(m.on_key(0x10, false, false), vec![up("ptt")]);
        // Клавиша всё ещё зажата — её отпускание уже ничего не даёт.
        assert!(m.on_key(0x56, false, false).is_empty());
    }

    #[test]
    fn right_and_left_control_count_as_one_modifier() {
        let mut m = Matcher::new();
        m.set_bindings(vec![binding("ptt", "KeyV", true, false)]);
        m.on_key(0x11, false, true); // левый
        m.on_key(0x11, true, true); // правый (E0)
        assert_eq!(m.on_key(0x56, false, true), vec![down("ptt")]);
        assert!(m.on_key(0x11, false, false).is_empty(), "правый ещё держится");
        assert_eq!(m.on_key(0x11, true, false), vec![up("ptt")]);
    }

    #[test]
    fn poll_releases_when_the_system_says_the_key_is_up() {
        let mut m = Matcher::new();
        m.set_bindings(vec![binding("ptt", "KeyV", false, false)]);
        assert_eq!(m.on_key(0x56, false, true), vec![down("ptt")]);
        assert!(m.poll(|_| true).is_empty());
        assert_eq!(m.poll(|_| false), vec![up("ptt")]);
        assert!(!m.holding());
        // После «потерянного» отпускания следующее нажатие снова даёт «нажал».
        assert_eq!(m.on_key(0x56, false, true), vec![down("ptt")]);
    }

    #[test]
    fn replacing_bindings_releases_active_holds() {
        let mut m = Matcher::new();
        m.set_bindings(vec![binding("ptt", "KeyV", false, false)]);
        m.on_key(0x56, false, true);
        assert_eq!(m.set_bindings(vec![binding("mic", "KeyM", false, false)]), vec![up("ptt")]);
        assert_eq!(m.bindings().len(), 1);
        assert!(m.on_key(0x56, false, false).is_empty());
    }

    #[test]
    fn two_bindings_on_the_same_key_differ_by_modifiers() {
        let mut m = Matcher::new();
        m.set_bindings(vec![binding("a", "KeyM", true, false), binding("b", "KeyM", true, true)]);
        m.on_key(0x11, false, true);
        m.on_key(0x10, false, true);
        assert_eq!(m.on_key(0x4D, false, true), vec![down("b")]);
        assert_eq!(m.on_key(0x4D, false, false), vec![up("b")]);
    }
}
