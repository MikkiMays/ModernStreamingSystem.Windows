/**
 * Глобальные сочетания (T27, ADR 0001 §4.2). Два пути:
 *
 * - **Raw Input** (`cord-native`, utility-процесс): любая клавиша и кнопки мыши Mouse3–Mouse5, фаза
 *   «нажал/отпустил» — push-to-talk с отпусканием; клавиша не отбирается у игры. Работает всегда,
 *   пока Cord запущен. Ограничение UIPI: игра от имени администратора не отдаёт ввод Cord без тех
 *   же прав — об этом строка состояния.
 * - **Запасной** — `globalShortcut` (RegisterHotKey): без фазы «отпустил» и без кнопок мыши; как
 *   `MicrophoneHotkey.TryNative` в WinUI, поверх других программ регистрируются только сочетания с
 *   Ctrl или Alt, без клавиши Windows и F12. Включается, когда модуля нет или его процесс упал.
 *
 * Чистая часть (план регистраций, строки состояния) отделена от Electron, чтобы проверяться
 * тестами; `HotkeyRegistry` получает оба бэкенда снаружи.
 */
import type { NativeBinding } from '../native/protocol';
import type { Hotkey, HotkeyBinding } from './bridge/messages';

export interface Registration {
  action: HotkeyBinding['action'];
  mode: HotkeyBinding['mode'];
  /** Ускоритель Electron (запасной путь) или подпись сочетания (Raw Input). */
  accelerator: string;
  key: Hotkey;
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
export const STATUS_GLOBAL_RAW =
  'Работает поверх других программ всегда, пока Cord запущен, с нажатием и отпусканием. В игре, запущенной от имени администратора, сработает, только если так же запущен Cord.';
export const STATUS_TAKEN = 'Сочетание занято другой программой. В окне встречи оно доступно; выберите другое для работы в фоне.';
export const STATUS_DUPLICATE = 'Это сочетание уже назначено другому действию Cord.';

/** Клавиша в виде ускорителя Electron; null — сочетание нельзя регистрировать через globalShortcut. */
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

/** Подпись сочетания для Raw Input: модификаторы точно, любая клавиша или кнопка мыши. */
export function signature(key: Hotkey): string {
  return [key.ctrl && 'ctrl', key.alt && 'alt', key.shift && 'shift', key.meta && 'meta', key.code].filter(Boolean).join('+');
}

/** Что из попрошенного вебом можно поставить в систему и что мешает остальному. */
export function planHotkeys(bindings: readonly HotkeyBinding[], raw = false): HotkeyPlan {
  const registrations: Registration[] = [];
  const notes: HotkeyPlan['notes'] = {};
  const seen = new Set<string>();
  for (const binding of bindings) {
    const combo = raw ? signature(binding.key) : accelerator(binding.key);
    if (!combo) {
      notes[binding.action] = STATUS_WINDOW_ONLY;
      continue;
    }
    if (seen.has(combo)) {
      notes[binding.action] = STATUS_DUPLICATE;
      continue;
    }
    seen.add(combo);
    registrations.push({ action: binding.action, mode: binding.mode, accelerator: combo, key: { ...binding.key } });
  }
  return { registrations, notes };
}

export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Raw Input в utility-процессе: заменить набор целиком; вернуть id тех, что зарегистрировать нельзя. */
export interface RawInputApi {
  set(bindings: NativeBinding[]): Promise<string[]>;
}

export type HotkeyPhase = 'down' | 'up';
export type HotkeyStatus = Record<string, string>;

/**
 * Держит текущие регистрации и меняет их целиком: веб присылает весь набор при каждом
 * изменении, а на время записи нового сочетания — пустой, чтобы нажатие самого сочетания
 * записалось, а не включило микрофон. Бэкенд меняется на ходу (`setRaw`): модуль упал — набор
 * переезжает на globalShortcut, вернулся — обратно.
 */
export class HotkeyRegistry {
  private current: Registration[] = [];
  private last: HotkeyBinding[] = [];
  private raw: RawInputApi | null = null;
  /** Чем зарегистрирован текущий набор. */
  private backend: 'raw' | 'shortcut' = 'shortcut';

  constructor(
    private readonly shortcuts: ShortcutApi,
    private readonly fire: (action: HotkeyBinding['action'], mode: HotkeyBinding['mode'], phase: HotkeyPhase) => void,
  ) {}

  /** Сменить бэкенд Raw Input; если набор уже есть — перерегистрировать и вернуть новое состояние. */
  async setRaw(raw: RawInputApi | null): Promise<HotkeyStatus | null> {
    if (this.raw === raw) return null;
    this.raw = raw;
    return this.last.length ? this.apply(this.last) : null;
  }

  get usingRaw(): boolean {
    return this.raw !== null;
  }

  /** Применить новый набор; вернуть строку состояния по каждому действию. */
  async apply(bindings: readonly HotkeyBinding[]): Promise<HotkeyStatus> {
    this.last = bindings.map((binding) => ({ ...binding, key: { ...binding.key } }));
    this.release();
    if (this.raw) {
      try {
        return await this.applyRaw(this.raw, bindings);
      } catch {
        // Модуль не ответил — набор ставится запасным путём, пока хост не вернётся.
      }
    }
    return this.applyShortcuts(bindings);
  }

  private async applyRaw(raw: RawInputApi, bindings: readonly HotkeyBinding[]): Promise<HotkeyStatus> {
    const plan = planHotkeys(bindings, true);
    const status: HotkeyStatus = { ...plan.notes };
    const rejected = new Set(
      await raw.set(plan.registrations.map((item) => ({ id: item.action, code: item.key.code, ctrl: item.key.ctrl, alt: item.key.alt, shift: item.key.shift, meta: item.key.meta }))),
    );
    this.backend = 'raw';
    for (const registration of plan.registrations) {
      if (rejected.has(registration.action)) {
        status[registration.action] = STATUS_WINDOW_ONLY;
        continue;
      }
      this.current.push(registration);
      status[registration.action] = STATUS_GLOBAL_RAW;
    }
    for (const binding of bindings) status[binding.action] ??= STATUS_WINDOW_ONLY;
    return status;
  }

  private applyShortcuts(bindings: readonly HotkeyBinding[]): HotkeyStatus {
    const plan = planHotkeys(bindings, false);
    const status: HotkeyStatus = { ...plan.notes };
    this.backend = 'shortcut';
    for (const registration of plan.registrations) {
      const ok = this.shortcuts.register(registration.accelerator, () => this.fire(registration.action, registration.mode, 'down'));
      if (ok) {
        this.current.push(registration);
        status[registration.action] = STATUS_GLOBAL;
      } else status[registration.action] = STATUS_TAKEN;
    }
    for (const binding of bindings) status[binding.action] ??= STATUS_WINDOW_ONLY;
    return status;
  }

  /** Событие Raw Input из utility-процесса: `id` — действие. */
  onRawEvent(id: string, phase: HotkeyPhase): void {
    if (this.backend !== 'raw') return;
    const registration = this.current.find((item) => item.action === id);
    if (registration) this.fire(registration.action, registration.mode, phase);
  }

  private release(): void {
    if (this.backend === 'shortcut') for (const item of this.current) this.shortcuts.unregister(item.accelerator);
    this.current = [];
  }

  /** Снять всё (окно закрыто, выход). Raw Input получает пустой набор, если хост жив. */
  clear(): void {
    this.last = [];
    this.release();
    if (this.raw) void this.raw.set([]).catch(() => {});
  }

  get active(): readonly Registration[] {
    return this.current;
  }
}
