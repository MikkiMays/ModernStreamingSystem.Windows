using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace Cord.Windows.Services;

/// <summary>
/// Короткое сообщение Windows о том, что вышло обновление.
///
/// Проверка идёт раз в шесть часов, в том числе когда окно свёрнуто, и строка в боковой
/// панели в этот момент никому не видна. Поэтому уведомление — не украшение, а единственный
/// способ сказать о новой версии тому, кто в приложение сейчас не смотрит.
///
/// Всё здесь — попытка, а не требование. Cord ставится без пакета (<c>WindowsPackageType
/// None</c>), а регистрация уведомлений для такой установки зависит от состояния системы и
/// может отказать. Отказ означает ровно одно: уведомления не будет. Он не должен ни
/// останавливать запуск, ни мешать самому обновлению — плашка в панели остаётся на месте.
///
/// Регистрация снимается при закрытии окна намеренно. Она переживает процесс, и оставленная
/// после выхода превращает нажатие на старое уведомление в запуск второго экземпляра Cord —
/// поведение, которого никто не просил. Пока приложение работает, нажатие обрабатывается
/// внутри процесса и просто выводит окно вперёд.
/// </summary>
public static class Notifications
{
    private static bool _ready;
    private static bool _broken;

    /// <summary>Что делать, если по уведомлению нажали. Ставит окно, пока оно живо.</summary>
    public static Action? Activated { get; set; }

    private static bool Prepare()
    {
        if (_ready) return true;
        if (_broken) return false;
        try
        {
            AppNotificationManager.Default.NotificationInvoked += (_, _) => Activated?.Invoke();
            AppNotificationManager.Default.Register();
            _ready = true;
        }
        catch (Exception)
        {
            _broken = true;
        }
        return _ready;
    }

    public static void Announce(string title, string body)
    {
        if (!Prepare()) return;
        try
        {
            var notification = new AppNotificationBuilder().AddText(title).AddText(body).BuildNotification();
            AppNotificationManager.Default.Show(notification);
        }
        catch (Exception)
        {
            // Показать не удалось — значит, не показали. Приложение продолжает работать.
            _broken = true;
        }
    }

    public static void Release()
    {
        Activated = null;
        if (!_ready) return;
        try { AppNotificationManager.Default.Unregister(); } catch (Exception) { /* Уже снята. */ }
        _ready = false;
    }
}
