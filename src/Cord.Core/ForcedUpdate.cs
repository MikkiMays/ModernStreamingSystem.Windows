using System.ComponentModel;
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
/// <param name="Problem">Почему не удалась — словами, для заставки.</param>
public sealed record UpdateDownload(string? Package, string Problem = "")
{
    public bool Ok => Package is not null;
}

/// <summary>Что делает заставка прямо сейчас.</summary>
public enum SplashStage
{
    Checking,
    Downloading,
    Installing,
    /// <summary>Не вышло: причина словами, «Повторить» и «Открыть Cord».</summary>
    Failed,
}

/// <summary>Одна строка заставки — и полоса под ней, пока идёт загрузка. Номера версии здесь нет.</summary>
/// <param name="Progress">Доля скачанного, от 0 до 1.</param>
public sealed record SplashState(SplashStage Stage, double Progress = 0, string Problem = "")
{
    /// <summary>Целые проценты, с округлением вниз: 100 — только когда пришёл последний байт.</summary>
    public int Percent => (int)Math.Clamp(Math.Floor(Progress * 100), 0, 100);

    public string Text => Stage switch
    {
        SplashStage.Checking => "Проверяем обновления…",
        SplashStage.Downloading => $"Загружаем обновление… {Percent}%",
        SplashStage.Installing => "Устанавливаем…",
        _ => Problem,
    };
}

/// <summary>Чем кончилась заставка.</summary>
public enum SplashOutcome
{
    /// <summary>Ставить нечего или спросить не удалось — открыть Cord.</summary>
    OpenCord,
    /// <summary>Помощник готов: Cord закрывается, установщик работает, новая версия откроется сама.</summary>
    Restarting,
    /// <summary>Загрузка или установка не удалась — дальше решает человек.</summary>
    Failed,
}

/// <param name="Verdict">Что ответило зеркало; по нему главное окно решает, когда спросить снова.</param>
/// <param name="Problem">Причина сбоя — словами, коротко.</param>
/// <param name="Error">Исключение за сбоем установки — для <c>last-error.txt</c>, не для человека.</param>
public sealed record SplashResult(SplashOutcome Outcome, UpdateVerdict Verdict, string Problem = "", Exception? Error = null)
{
    /// <summary>Когда главному окну спросить зеркало в первый раз: заставка только что спрашивала.</summary>
    public TimeSpan NextCheck => ForcedUpdate.NextCheck(Verdict);
}

/// <summary>
/// Шаги, которые заставка просит у обновлятора. В приложении это <c>ApplicationUpdater</c>
/// (реестр, файлы, PowerShell), в тестах — подделка.
/// </summary>
public interface IUpdateSteps
{
    /// <summary>Почему не встала прошлая установка — один раз; null, если встала или её не было.</summary>
    string? TakeInstallFailure();
    Task<UpdateCheck> CheckAsync(TimeSpan budget, CancellationToken token);
    Task<UpdateDownload> DownloadAsync(IProgress<double> progress, CancellationToken token);
    /// <summary>Запустить помощника установки и дождаться его готовности. После этого Cord обязан закрыться.</summary>
    Task ApplyAsync(CancellationToken token);
    /// <summary>Забыть скачанный пакет, чтобы «Повторить» скачал его заново.</summary>
    void DiscardPackage();
}

/// <summary>
/// Обновление при запуске (T58), как у Discord: сначала маленькая заставка — проверка, загрузка,
/// установка, — и только потом Cord. Кнопки «позже» нет: новая версия ставится каждому при
/// открытии.
///
/// <para>Обязательное не значит хрупкое. Зеркало, которое молчит, отвечает ошибкой или
/// подсовывает не тот выпуск, не мешает открыть приложение: на ответ при запуске у него
/// несколько секунд, а переспросим позже, в фоне. Загрузка, которая сломалась или встала, и
/// установка, которая не запустилась, останавливаются на заставке с причиной, «Повторить» и
/// «Открыть Cord». Ставится только версия новее установленной — откатов нет, — и только после
/// проверок адреса, размера и SHA-256.</para>
///
/// <para>Здесь — то, что проверяется без окна: вердикт, сроки, сторож загрузки, шаги заставки,
/// итог помощника и правило про встречу. Окно заставки — <c>SplashWindow</c>, порядок окон —
/// <c>App</c>.</para>
/// </summary>
public static class ForcedUpdate
{
    /// <summary>Сколько ждать зеркало на заставке. Медленная сеть не должна держать Cord закрытым.</summary>
    public static readonly TimeSpan StartupBudget = TimeSpan.FromSeconds(5);
    /// <summary>Сколько ждать зеркало, пока Cord открыт: тут никто не стоит перед заставкой.</summary>
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
    /// Можно ли прямо сейчас закрыть главное окно ради заставки обновления. Разговор — нет, и экран
    /// перед входом во встречу — тоже: человек туда уже идёт. Знаем мы это только от страницы
    /// (<c>state</c>, <c>call-state</c>); пока она ничего не сказала, встречи нет.
    /// </summary>
    public static bool CanInterrupt(bool inCall, string? page) => !inCall && page != "prejoin";

    /// <summary>
    /// Шаги заставки по порядку: итог прошлой установки, вопрос к зеркалу, загрузка, установка.
    /// Возвращает, открыть ли Cord, закрыть ли его ради установки или показать сбой. Отмена
    /// (заставку закрыли) остаётся отменой.
    /// </summary>
    public static async Task<SplashResult> SplashAsync(IUpdateSteps steps, IProgress<SplashState> show, CancellationToken token)
    {
        // Прошлая установка не встала — заново сами не начинаем: иначе сбой установщика стал бы
        // кругом «обновился — открылся прежним — снова обновляется». Решает человек.
        if (steps.TakeInstallFailure() is { } failure) return new(SplashOutcome.Failed, UpdateVerdict.Forced, failure);
        show.Report(new(SplashStage.Checking));
        var check = await steps.CheckAsync(StartupBudget, token);
        if (check.Verdict != UpdateVerdict.Forced) return new(SplashOutcome.OpenCord, check.Verdict);
        show.Report(new(SplashStage.Downloading));
        var download = await steps.DownloadAsync(new Relay(value => show.Report(new(SplashStage.Downloading, value))), token);
        if (!download.Ok) return new(SplashOutcome.Failed, UpdateVerdict.Forced, download.Problem);
        show.Report(new(SplashStage.Installing));
        try
        {
            await steps.ApplyAsync(token);
            return new(SplashOutcome.Restarting, UpdateVerdict.Forced);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException or Win32Exception
            || e is OperationCanceledException && !token.IsCancellationRequested)
        {
            // Пакет мог испортиться на диске (его держал или забрал антивирус): «Повторить» скачает
            // его заново, а не споткнётся о тот же файл.
            steps.DiscardPackage();
            return new(SplashOutcome.Failed, UpdateVerdict.Forced, "Не удалось запустить установку.", e);
        }
    }

    /// <summary>
    /// Итог помощника установки (<c>result.json</c>, его пишет <c>Update.ps1</c>) — словами для
    /// заставки: null, если установка встала, иначе короткая причина. Номеров версий и английского
    /// текста помощника здесь нет: они остаются в самом файле и в <c>update.log</c>.
    /// </summary>
    public static string? InstallFailure(string result)
    {
        try
        {
            using var document = JsonDocument.Parse(result);
            var root = document.RootElement;
            if (root.GetProperty("ok").GetBoolean()) return null;
            var stage = root.TryGetProperty("stage", out var named) && named.ValueKind == JsonValueKind.String ? named.GetString() : null;
            int? code = root.TryGetProperty("code", out var number) && number.ValueKind == JsonValueKind.Number && number.TryGetInt32(out var value) ? value : null;
            // Коды — это коды Inno Setup: 4, 5 и 7 — файлы заняты, 8 — нужна перезагрузка.
            return (stage, code) switch
            {
                ("wait", _) => "Обновление не установилось: прежний Cord не закрылся.",
                ("install", 4 or 5 or 7) => "Обновление не установилось: файлы Cord заняты. Закройте все окна Cord и повторите.",
                ("install", 8) => "Обновление не установилось: Windows ждёт перезагрузки.",
                ("install", { } other) => $"Обновление не установилось: установщик вернул код {other}.",
                ("check", _) => "Обновление не установилось: на диске осталась прежняя версия.",
                ("verify", _) => "Обновление не установилось: скачанный пакет повреждён.",
                _ => "Обновление не установилось.",
            };
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return "Обновление не установилось.";
        }
    }

    /// <summary>
    /// Загрузка со сторожем. Сторож следит за тишиной, а не за длительностью: каждая порция байтов
    /// продлевает срок, поэтому медленная, но живая загрузка доходит до конца, а вставшая
    /// заканчивается причиной, а не вечной заставкой. <paramref name="time"/> — для
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
            return new(null, "Загрузка остановилась: сервер обновлений не отвечает.");
        }
        catch (InvalidDataException e)
        {
            // Эти причины уже написаны для человека: подмена адреса, другой размер, не тот SHA-256.
            return new(null, e.Message);
        }
        catch (Exception e) when (e is HttpRequestException or IOException or UnauthorizedAccessException)
        {
            return new(null, "Не удалось скачать обновление. Проверьте соединение.");
        }
    }

    private sealed class Relay(Action<double> report) : IProgress<double>
    {
        public void Report(double value) => report(value);
    }
}
