/**
 * Крестик главного окна (R57, ADR 0001 §4.4): как у Discord, закрытие окна прячет Cord в трей,
 * а встреча продолжается. Выход — «Выйти» в меню трея, завершение сеанса Windows или обновление.
 *
 * Переключатель один — «Значок в трее»: есть значок, куда спрятаться, — прячемся; значка нет
 * (выключен или не создался) — закрытие окна завершает приложение, как раньше. Здесь нет
 * Electron: решения проверяются тестами, `windows/main.ts` и `index.ts` их только исполняют.
 */

export type CloseAction = 'hide' | 'close';

export interface CloseContext {
  /** Значок в трее на месте: переключатель включён и `Tray` создался. */
  tray: boolean;
  /** Выход уже идёт: «Выйти», `before-quit`, перезапуск в заставку обновления. */
  quitting: boolean;
  /** Windows выключается, перезагружается или сеанс завершается (`session-end`). */
  sessionEnding: boolean;
}

export function decideClose(context: CloseContext): CloseAction {
  if (context.quitting || context.sessionEnding || !context.tray) return 'close';
  return 'hide';
}

export type StartMode = 'show' | 'hide' | 'minimize';

/** Запуск вместе с Windows (`--hidden`): в трей, если он есть; иначе — свёрнутым в панель задач. */
export function startMode(options: { hiddenFlag: boolean; tray: boolean }): StartMode {
  if (!options.hiddenFlag) return 'show';
  return options.tray ? 'hide' : 'minimize';
}
