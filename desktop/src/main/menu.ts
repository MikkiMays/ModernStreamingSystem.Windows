/**
 * Контекстное меню (T42, ADR 0001 §4.5). Своего меню по ПКМ в Electron нет вовсе: в полях ввода
 * — «Вырезать / Копировать / Вставить / Выделить всё» и подсказки орфографии; на выделенном
 * тексте — «Копировать»; в остальных местах — ничего: веб открывает своё меню (E02, T40).
 * Ни «Проверить», ни «Сохранить как», ни «Поиск» взяться неоткуда.
 */
import { Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';

export function installContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5))
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      if (params.misspelledWord) items.push({ type: 'separator' });
      items.push(
        { label: 'Вырезать', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Копировать', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Вставить', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Выделить всё', role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      items.push({ label: 'Копировать', role: 'copy' });
    }
    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup();
  });
}
