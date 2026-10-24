//! Приоритет своих процессов (R01–R03, ADR 0001 §2.1): EcoQoS выключен, класс `HIGH` — всё время,
//! пока Cord запущен (владелец 24.10.2026: «у корда должен быть приоритет высокий на виндовс»).
//! `REALTIME` не ставится никогда: он отнимает процессор у самой системы (ввод, диск) и требует прав
//! администратора. Здесь — чистые решения без Windows: какие маски `PROCESS_POWER_THROTTLING_STATE`
//! пробовать и какой класс приоритета ставить; `win/process.rs` только исполняет их.

/// `PROCESS_POWER_THROTTLING_EXECUTION_SPEED` — EcoQoS, «режим эффективности» (Windows 10 1709+).
pub const EXECUTION_SPEED: u32 = 0x1;
/// `PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION` — Windows 11: у свёрнутого или накрытого окна
/// система загрубляет таймер до 15,6 мс, не глядя на `timeBeginPeriod` (звук, WebRTC).
pub const IGNORE_TIMER_RESOLUTION: u32 = 0x4;

pub const IDLE_PRIORITY_CLASS: u32 = 0x40;
pub const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x4000;
pub const NORMAL_PRIORITY_CLASS: u32 = 0x20;
pub const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x8000;
pub const HIGH_PRIORITY_CLASS: u32 = 0x80;

/// Маски `(ControlMask, StateMask)` по порядку попыток. Поднять: оба флага «выключено» (бит в
/// `ControlMask`, нуль в `StateMask`), а Windows 10, которая второго флага не знает и отвечает
/// `ERROR_INVALID_PARAMETER`, — только EcoQoS. Вернуть: `ControlMask = 0` — решает система.
pub fn throttling_attempts(on: bool) -> &'static [(u32, u32)] {
    if on {
        &[(EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION, 0), (EXECUTION_SPEED, 0)]
    } else {
        &[(0, 0)]
    }
}

/// Новый класс приоритета или `None` — не трогать. До `HIGH` поднимается любой класс ниже него;
/// `HIGH` и `REALTIME` не трогаются (уже высокий — или выбор человека). Возвращается к обычному
/// только `HIGH`, и только у процессов, которые поднимали мы (`boost-plan.ts` помнит их).
pub fn priority_after(current: u32, on: bool) -> Option<u32> {
    match (on, current) {
        (true, IDLE_PRIORITY_CLASS | BELOW_NORMAL_PRIORITY_CLASS | NORMAL_PRIORITY_CLASS | ABOVE_NORMAL_PRIORITY_CLASS) => Some(HIGH_PRIORITY_CLASS),
        (false, HIGH_PRIORITY_CLASS) => Some(NORMAL_PRIORITY_CLASS),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REALTIME_PRIORITY_CLASS: u32 = 0x100;

    #[test]
    fn boost_turns_both_throttles_off_and_falls_back_to_ecoqos_only() {
        assert_eq!(throttling_attempts(true), &[(0x5, 0), (0x1, 0)]);
        assert_eq!(throttling_attempts(false), &[(0, 0)]);
    }

    #[test]
    fn priority_is_raised_to_high_from_anything_below_and_given_back_only_from_high() {
        assert_eq!(priority_after(NORMAL_PRIORITY_CLASS, true), Some(HIGH_PRIORITY_CLASS));
        assert_eq!(priority_after(IDLE_PRIORITY_CLASS, true), Some(HIGH_PRIORITY_CLASS));
        assert_eq!(priority_after(BELOW_NORMAL_PRIORITY_CLASS, true), Some(HIGH_PRIORITY_CLASS));
        assert_eq!(priority_after(ABOVE_NORMAL_PRIORITY_CLASS, true), Some(HIGH_PRIORITY_CLASS));
        assert_eq!(priority_after(HIGH_PRIORITY_CLASS, true), None);
        assert_eq!(priority_after(REALTIME_PRIORITY_CLASS, true), None);
        assert_eq!(priority_after(HIGH_PRIORITY_CLASS, false), Some(NORMAL_PRIORITY_CLASS));
        assert_eq!(priority_after(ABOVE_NORMAL_PRIORITY_CLASS, false), None);
        assert_eq!(priority_after(REALTIME_PRIORITY_CLASS, false), None);
        assert_eq!(priority_after(NORMAL_PRIORITY_CLASS, false), None);
    }
}
