//! Дорога звука (ADR 0001 §4.1): PCM float32, 48 кГц, стерео, порциями по 10 мс (480 кадров).
//! `Chunker` режет пакеты WASAPI на ровные порции; `Pacer` подкладывает тишину, когда приложение
//! молчит и устройство не присылает пакетов, — чтобы дорожка жила ровно, а не рвалась паузами.
//! Чистый модуль без Windows.

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
pub const CHUNK_FRAMES: usize = 480;
pub const CHUNK_SAMPLES: usize = CHUNK_FRAMES * CHANNELS;

#[derive(Default)]
pub struct Chunker {
    pending: Vec<f32>,
}

impl Chunker {
    pub fn new() -> Self {
        Self { pending: Vec::with_capacity(CHUNK_SAMPLES * 4) }
    }

    /// Положить перемежённые кадры (`frames × 2` чисел).
    pub fn push(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
    }

    pub fn push_silence(&mut self, frames: usize) {
        self.pending.resize(self.pending.len() + frames * CHANNELS, 0.0);
    }

    /// Все полные порции по 480 кадров; остаток ждёт следующего пакета.
    pub fn drain(&mut self) -> Vec<Vec<f32>> {
        let mut chunks = Vec::new();
        while self.pending.len() >= CHUNK_SAMPLES {
            let rest = self.pending.split_off(CHUNK_SAMPLES);
            chunks.push(std::mem::replace(&mut self.pending, rest));
        }
        chunks
    }

    pub fn pending_frames(&self) -> usize {
        self.pending.len() / CHANNELS
    }
}

/// Тишина по часам: пока пакетов нет дольше `idle_ms`, порции тишины идут раз в 10 мс по стенному
/// времени. Пока звук идёт, счёт ведёт устройство, и дрейф часов ничего не ломает.
pub struct Pacer {
    idle_ms: u64,
    last_packet_ms: u64,
    last_emit_ms: u64,
}

impl Pacer {
    pub const MAX_BURST: u64 = 10;

    pub fn new(now_ms: u64, idle_ms: u64) -> Self {
        Self { idle_ms, last_packet_ms: now_ms, last_emit_ms: now_ms }
    }

    /// Пришёл настоящий пакет (или тишина от устройства) — часы тишины сбрасываются.
    pub fn on_packet(&mut self, now_ms: u64) {
        self.last_packet_ms = now_ms;
        self.last_emit_ms = now_ms;
    }

    /// Сколько порций тишины выдать сейчас: 0, пока устройство не молчит дольше `idle_ms`;
    /// дальше — по одной на каждые 10 мс, не больше `MAX_BURST` за раз.
    pub fn tick(&mut self, now_ms: u64) -> usize {
        if now_ms.saturating_sub(self.last_packet_ms) < self.idle_ms {
            return 0;
        }
        let due = now_ms.saturating_sub(self.last_emit_ms) / 10;
        let count = due.min(Self::MAX_BURST);
        self.last_emit_ms += count * 10;
        count as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunker_cuts_exact_10ms_pieces_and_keeps_the_rest() {
        let mut chunker = Chunker::new();
        chunker.push(&vec![0.5; 700 * CHANNELS]);
        let chunks = chunker.drain();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), CHUNK_SAMPLES);
        assert_eq!(chunker.pending_frames(), 220);
        chunker.push_silence(260);
        let chunks = chunker.drain();
        assert_eq!(chunks.len(), 1);
        assert_eq!(&chunks[0][..440], &[0.5; 440][..]);
        assert_eq!(&chunks[0][440..], &[0.0; CHUNK_SAMPLES - 440][..]);
        assert_eq!(chunker.pending_frames(), 0);
    }

    #[test]
    fn pacer_stays_quiet_while_packets_flow() {
        let mut pacer = Pacer::new(0, 30);
        for now in (10..=200).step_by(10) {
            pacer.on_packet(now);
            assert_eq!(pacer.tick(now + 3), 0, "в {now} мс");
        }
    }

    #[test]
    fn pacer_fills_idle_time_at_10ms_cadence() {
        let mut pacer = Pacer::new(0, 30);
        pacer.on_packet(100);
        assert_eq!(pacer.tick(120), 0, "пауза короче порога");
        assert_eq!(pacer.tick(135), 3, "35 мс тишины — три порции");
        assert_eq!(pacer.tick(140), 1);
        assert_eq!(pacer.tick(141), 0);
        // Долгий простой (поток спал) — не больше десяти порций за раз.
        assert_eq!(pacer.tick(1000), Pacer::MAX_BURST as usize);
        // Пакет вернулся — тишина больше не нужна.
        pacer.on_packet(1005);
        assert_eq!(pacer.tick(1012), 0);
    }
}
