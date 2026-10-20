/**
 * Глобальные сочетания (T27, ADR 0001 §4.2). Запасной путь — `globalShortcut` (RegisterHotKey):
 * без фазы «отпустил» и без кнопок мыши; push-to-talk с отпусканием ждёт `cord-native`.
 *
 * Правила — как `MicrophoneHotkey.TryNative` в WinUI: поверх других программ регистрируются
 * только сочетания с Ctrl или Alt, без клавиши Windows и F12. Остальные работают в окне
 * встречи — их слушает сам веб. Сочетание, занятое другой программой или другим действием
 * Cord, не регистрируется, и веб получает об этом строку (`hotkeys.status`).
 *
 * Чистая часть (план регистраций, строки состояния) отделена от Electron, чтобы проверяться
 * тестами; `HotkeyRegistry` получает `register`/`unregister` снаружи.
 */
import type { Hotkey, HotkeyBinding } from './bridge/messages';

export interface Registration {
  action: HotkeyBinding['action'];
  mode: HotkeyBinding['mode'];
  accelerator: string;
}

export interface HotkeyPlan {
  registrations: Registration[];
  /** Почему сочетание не пошло в систему — словами для человека, по действию. */
  notes: Partial<Record<HotkeyBinding['action'], string>>;
}

export const STATUS_DISABLED = 'Сочетание отключено';
export const STATUS_WINDOW_ONLY =
  'Работает в окне встречи. Для работы поверх других программ добавьте Ctrl или Alt; клавиши Windows и F12 зарезервированы системой.';
export const STATUS_GLOBAL = 'Работает и поверх других программ во время встречи.';
export const STATUS_TAKEN = 'Сочетание занято другой программой. В окне встречи оно доступно; выберите другое для работы в фоне.';
export const STATUS_DUPLICATE = 'Это сочетание уже назначено другому действию Cord.';

/** Клавиша в виде ускорителя Electron; null — сочетание нельзя регистрировать в системе. */
export function accelerator(key: Hotkey): string | null {
  if (key.meta || key.code === 'F12' || (!key.ctrl && !key.alt)) return null;
  let name: string;
  if (key.code.startsWith('Key')) name = key.code.slice(3);
  else if (key.code.startsWith('Digit')) name = key.code.slice(5);
  else if (key.code === 'Space') name = 'Space';
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key.code)) name = key.code;
  else return null;
  return [key.ctrl && 'Control', key.alt && 'Alt', key.shift && 'Shift', name].filter(Boolean).join('+');
}

/** Что из попрошенного вебом можно поставить в систему и что мешает остальному. */
export function planHotkeys(bindings: readonly HotkeyBinding[]): HotkeyPlan {
  const registrations: Registration[] = [];
  const notes: HotkeyPlan['notes'] = {};
  const seen = new Set<string>();
  for (const binding of bindings) {
    const combo = accelerator(binding.key);
    if (!combo) {
      notes[binding.action] = STATUS_WINDOW_ONLY;
      continue;
    }
    if (seen.has(combo)) {
      notes[binding.action] = STATUS_DUPLICATE;
      continue;
    }
    seen.add(combo);
    registrations.push({ action: binding.action, mode: binding.mode, accelerator: combo });
  }
  return { registrations, notes };
}

export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Держит текущие регистрации и меняет их целиком: веб присылает весь набор при каждом
 * изменении, а на время записи нового сочетания — пустой, чтобы нажатие самого сочетания
 * записалось, а не включило микрофон.
 */
export class HotkeyRegistry {
  private current: Registration[] = [];

  constructor(
    private readonly shortcuts: ShortcutApi,
    private readonly fire: (action: HotkeyBinding['action'], mode: HotkeyBinding['mode']) => void,
  ) {}

  /** Применить новый набор; вернуть строку состояния по каждому действию. */
  apply(bindings: readonly HotkeyBinding[]): Record<string, string> {
    for (const item of this.current) this.shortcuts.unregister(item.accelerator);
    this.current = [];
    const plan = planHotkeys(bindings);
    const status: Record<string, string> = { ...plan.notes };
    for (const registration of plan.registrations) {
      const ok = this.shortcuts.register(registration.accelerator, () => this.fire(registration.action, registration.mode));
      if (ok) {
        this.current.push(registration);
        status[registration.action] = STATUS_GLOBAL;
      } else status[registration.action] = STATUS_TAKEN;
    }
    for (const binding of bindings) status[binding.action] ??= STATUS_WINDOW_ONLY;
    return status;
  }

  clear(): void {
    this.apply([]);
  }

  get active(): readonly Registration[] {
    return this.current;
  }
}
