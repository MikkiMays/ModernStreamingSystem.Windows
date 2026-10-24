/**
 * Уведомления Windows с действиями (T53, R59): упоминания, приглашения, сообщения. Нажатие — в окно и
 * странице `notification.action {id, tag}`. «Не беспокоить» соблюдает сама Windows.
 *
 * Чтобы toast вообще появился, AUMID процесса должен совпадать с AUMID ярлыка в меню «Пуск»
 * (`APP_ID` в `config.ts`, `app.setAppUserModelId` в `windows/main.ts`, `WinShell::SetLnkAUMI` в
 * `build/installer.nsh`). `silent` решает страница: у веба свои звуки событий (`notificationSounds`),
 * и toast со звуком дал бы дубль.
 */
import { Notification } from 'electron';

export interface NotifyRequest {
  title: string;
  body: string;
  tag?: string;
  /** Без системного звука — веб озвучивает событие сам. */
  silent?: boolean;
  actions?: { id: string; text: string }[];
}

/** Показать уведомление; вернуть его, чтобы закрыть позже (`close()`), или `null` — уведомлений нет. */
export function showNotification(request: NotifyRequest, onAction: (id: string, tag: string | undefined) => void): Notification | null {
  if (!Notification.isSupported()) return null;
  const notification = new Notification({
    title: request.title,
    body: request.body,
    silent: request.silent === true,
    ...(request.actions?.length && process.platform !== 'linux' ? { actions: request.actions.map((action) => ({ type: 'button' as const, text: action.text })) } : {}),
  });
  notification.on('click', () => onAction('open', request.tag));
  notification.on('action', (_, index) => onAction(request.actions?.[index]?.id ?? 'open', request.tag));
  notification.show();
  return notification;
}
