using System.Text.Json;

namespace Cord.Core;

/// <summary>Что зеркало ответило на вопрос «есть ли новее».</summary>
public enum UpdateVerdict
{
    /// <summary>Новее нет: стоит последняя версия, или зеркало пустое (404).</summary>
    None,
    /// <summary>Есть новее — ставится сразу, без вопроса и без «позже».</summary>
    Forced,
    /// <summary>Зеркало не ответило вовремя, ответило ошибкой или не тем. Cord открывается как обычно и спросит позже.</summary>
    Unavailable,
}

public sealed record UpdateCheck(UpdateVerdict Verdict, CordRelease? Release = null);

/// <param name="Package">Проверенный установщик на диске; null — загрузка не удалась.</param>
/// <param name="Problem">Почему не удалась — словами, для экрана обновления.</param>
public sealed record UpdateDownload(string? Package, string Problem = "")
{
    public bool Ok => Package is not null;
}

/// <summary>
/// Принудительное обновление (T58): при запуске Cord спрашивает зеркало о версии и, если есть
/// новее, сразу её ставит — без вопроса и без кнопки «позже».
///
/// <para>Принудительное не значит хрупкое. Зеркало, которое молчит, отвечает ошибкой или
/// подсовывает не тот релиз, не мешает открыть приложение: на ответ при запуске у него несколько
/// секунд, а переспросим позже, в фоне. Загрузка, которая сломалась или встала, отпускает
/// человека в текущую версию с причиной словами. Ставится только версия новее установленной —
/// откатов нет, — и только после тех же проверок адреса, размера и SHA-256, что и раньше.</para>
///
/// <para>Здесь — то, что проверяется без окна: вердикт, сроки, сторож загрузки и правило про
/// встречу. Экран обновления и установку ведёт <c>MainWindow</c>.</para>
/// </summary>
public static class ForcedUpdate
{
    /// <summary>Сколько ждать зеркало при запуске. Медленная сеть не должна держать Cord закрытым.</summary>
    public static readonly TimeSpan StartupBudget = TimeSpan.FromSeconds(5);
    /// <summary>Сколько ждать зеркало в фоне и по кнопке: тут никто не стоит перед пустым окном.</summary>
    public static readonly TimeSpan BackgroundBudget = TimeSpan.FromSeconds(15);
    /// <summary>Как часто спрашивать, пока Cord открыт.</summary>
    public static readonly TimeSpan Period = TimeSpan.FromHours(6);
    /// <summary>Когда переспросить зеркало, которое не ответило.</summary>
    public static readonly TimeSpan RetrySoon = TimeSpan.FromMinutes(10);
    /// <summary>Сколько загрузка может молчать, прежде чем её признают вставшей.</summary>
    public static readonly TimeSpan StallLimit = TimeSpan.FromSeconds(60);

    /// <summary>
    /// Есть ли новее — за отведённое время. Отмена извне (окно закрывается) остаётся отменой;
    /// всё остальное, что может случиться с зеркалом, — это <see cref="UpdateVerdict.Unavailable"/>.
    /// </summary>
    public static async Task<UpdateCheck> CheckAsync(ReleaseClient client, Version current, string architecture, TimeSpan budget, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(budget);
        try
        {
            var release = await client.CheckAsync(current, architecture, timeout.Token);
            return release is not null && IsUpgrade(release.Version, current) ? new(UpdateVerdict.Forced, release) : new(UpdateVerdict.None);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            return new(UpdateVerdict.Unavailable);
        }
        catch (Exception e) when (e is HttpRequestException or InvalidDataException or JsonException or KeyNotFoundException or InvalidOperationException or FormatException or IOException)
        {
            return new(UpdateVerdict.Unavailable);
        }
    }

    /// <summary>Новее ли кандидат установленной. Ревизия сборки не считается: версии Cord — X.Y.Z.</summary>
    public static bool IsUpgrade(Version candidate, Version current) => Plain(candidate) > Plain(current);

    private static Version Plain(Version version) => new(version.Major, version.Minor, Math.Max(0, version.Build));

    public static TimeSpan NextCheck(UpdateVerdict verdict) => verdict == UpdateVerdict.Unavailable ? RetrySoon : Period;

    /// <summary>
    /// Можно ли прямо сейчас закрыть Cord ради установки. Разговор — нет, и экран перед входом во
    /// встречу — тоже: человек туда уже идёт. Знаем мы это только от страницы (<c>state</c>,
    /// <c>call-state</c>); пока она ничего не сказала, встречи нет.
    /// </summary>
    public static bool CanInterrupt(bool inCall, string? page) => !inCall && page != "prejoin";

    /// <summary>
    /// Загрузка со сторожем. Сторож следит за тишиной, а не за длительностью: каждая порция байтов
    /// продлевает срок, поэтому медленная, но живая загрузка доходит до конца, а вставшая
    /// заканчивается причиной, а не вечным экраном обновления. <paramref name="time"/> — для
    /// проверки сторожа без гонки с загруженной машиной; в приложении это обычные часы.
    /// </summary>
    public static async Task<UpdateDownload> DownloadAsync(
        Func<IProgress<double>, CancellationToken, Task<string>> download,
        IProgress<double>? progress,
        TimeSpan stall,
        TimeProvider time,
        CancellationToken token)
    {
        using var watchdog = new CancellationTokenSource(stall, time);
        using var closing = token.Register(static source => ((CancellationTokenSource)source!).Cancel(), watchdog);
        var relay = new Relay(value =>
        {
            watchdog.CancelAfter(stall);
            progress?.Report(value);
        });
        try
        {
            return new(await download(relay, watchdog.Token));
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            return new(null, "Загрузка остановилась: сервер обновлений перестал отвечать. Проверьте соединение и повторите.");
        }
        catch (InvalidDataException e)
        {
            // Эти причины уже написаны для человека: подмена адреса, другой размер, не тот SHA-256.
            return new(null, e.Message);
        }
        catch (Exception e) when (e is HttpRequestException or IOException or UnauthorizedAccessException)
        {
            return new(null, "Не удалось скачать обновление. Проверьте соединение и повторите.");
        }
    }

    private sealed class Relay(Action<double> report) : IProgress<double>
    {
        public void Report(double value) => report(value);
    }
}
