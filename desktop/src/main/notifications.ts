/**
 * Уведомления Windows с действиями (T53): упоминания и приглашения. Нажатие — в окно и
 * странице `notification.action {id, tag}`. «Не беспокоить» соблюдает сама Windows.
 */
import { Notification } from 'electron';

export interface NotifyRequest {
  title: string;
  body: string;
  tag?: string;
  actions?: { id: string; text: string }[];
}

export function showNotification(request: NotifyRequest, onAction: (id: string, tag: string | undefined) => void): boolean {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({
    title: request.title,
    body: request.body,
    silent: false,
    ...(request.actions?.length && process.platform !== 'linux' ? { actions: request.actions.map((action) => ({ type: 'button' as const, text: action.text })) } : {}),
  });
  notification.on('click', () => onAction('open', request.tag));
  notification.on('action', (_, index) => onAction(request.actions?.[index]?.id ?? 'open', request.tag));
  notification.show();
  return true;
}
