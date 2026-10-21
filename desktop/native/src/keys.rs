//! Клавиши сочетаний: имена DOM (`KeyM`, `Digit1`, `F5`, `Space`) и кнопки мыши (`Mouse3`…`Mouse5`)
//! ↔ виртуальные коды Windows. Чистый модуль без Windows — проверяется тестами на любой платформе.

/// Что нажимают: клавиша (виртуальный код Windows) или кнопка мыши (3 — средняя, 4 и 5 — боковые).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Trigger {
    Key(u16),
    Mouse(u8),
}

/// Модификаторы сочетания — как в модели E03 веба (`ctrl`, `alt`, `shift`, `meta`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

/// Какой модификатор представляет виртуальный код; `None` — обычная клавиша.
pub fn modifier_of(vk: u16) -> Option<Modifier> {
    match vk {
        0x10 | 0xA0 | 0xA1 => Some(Modifier::Shift),
        0x11 | 0xA2 | 0xA3 => Some(Modifier::Ctrl),
        0x12 | 0xA4 | 0xA5 => Some(Modifier::Alt),
        0x5B | 0x5C => Some(Modifier::Meta),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
}

impl Modifiers {
    pub fn has(&self, modifier: Modifier) -> bool {
        match modifier {
            Modifier::Ctrl => self.ctrl,
            Modifier::Alt => self.alt,
            Modifier::Shift => self.shift,
            Modifier::Meta => self.meta,
        }
    }

    pub fn set(&mut self, modifier: Modifier, held: bool) {
        match modifier {
            Modifier::Ctrl => self.ctrl = held,
            Modifier::Alt => self.alt = held,
            Modifier::Shift => self.shift = held,
            Modifier::Meta => self.meta = held,
        }
    }
}

/// Имя клавиши из модели веба → что ловить. `None` — такое сочетание мы не регистрируем
/// (левая и правая кнопки мыши, модификаторы сами по себе, неизвестные имена).
pub fn parse_code(code: &str) -> Option<Trigger> {
    if let Some(letter) = code.strip_prefix("Key") {
        let mut chars = letter.chars();
        return match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_uppercase() => Some(Trigger::Key(c as u16)),
            _ => None,
        };
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        let mut chars = digit.chars();
        return match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_digit() => Some(Trigger::Key(c as u16)),
            _ => None,
        };
    }
    if code == "Space" {
        return Some(Trigger::Key(0x20));
    }
    if let Some(number) = code.strip_prefix('F') {
        return match number.parse::<u16>() {
            Ok(n) if (1..=24).contains(&n) => Some(Trigger::Key(0x70 + n - 1)),
            _ => None,
        };
    }
    if let Some(button) = code.strip_prefix("Mouse") {
        return match button {
            "3" => Some(Trigger::Mouse(3)),
            "4" => Some(Trigger::Mouse(4)),
            "5" => Some(Trigger::Mouse(5)),
            _ => None,
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dom_codes_map_to_virtual_keys() {
        assert_eq!(parse_code("KeyM"), Some(Trigger::Key(0x4D)));
        assert_eq!(parse_code("Digit0"), Some(Trigger::Key(0x30)));
        assert_eq!(parse_code("Space"), Some(Trigger::Key(0x20)));
        assert_eq!(parse_code("F1"), Some(Trigger::Key(0x70)));
        assert_eq!(parse_code("F24"), Some(Trigger::Key(0x87)));
        assert_eq!(parse_code("Mouse4"), Some(Trigger::Mouse(4)));
    }

    #[test]
    fn rejects_what_we_do_not_register() {
        for code in ["Mouse1", "Mouse2", "Mouse6", "F0", "F25", "Keym", "KeyMM", "Digit10", "ControlLeft", "", "Enter"] {
            assert_eq!(parse_code(code), None, "{code}");
        }
    }

    #[test]
    fn modifiers_by_virtual_key_both_sides() {
        assert_eq!(modifier_of(0x11), Some(Modifier::Ctrl));
        assert_eq!(modifier_of(0xA3), Some(Modifier::Ctrl));
        assert_eq!(modifier_of(0xA0), Some(Modifier::Shift));
        assert_eq!(modifier_of(0xA5), Some(Modifier::Alt));
        assert_eq!(modifier_of(0x5C), Some(Modifier::Meta));
        assert_eq!(modifier_of(0x4D), None);
    }
}
