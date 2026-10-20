using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cord.Core;
using Xunit;

/// <summary>
/// T58: при запуске Cord сначала показывает заставку и спрашивает зеркало о версии. Новее —
/// скачивается и ставится, и только потом открывается Cord; та же или старее — заставка сразу
/// уступает место приложению; зеркало молчит или отвечает не тем — Cord открывается как обычно и
/// спросит позже. Сбой загрузки или установки останавливается на заставке с причиной, «Повторить»
/// и «Открыть Cord» — человека не запирают.
/// </summary>
public class ForcedUpdateTests
{
    private static readonly Version Installed = new(0, 7, 7, 0);

    private static string Release(string version, string? sha256 = null, long size = 4, string? name = null) => JsonSerializer.Serialize(new
    {
        version,
        tag = "v" + version,
        publishedAt = "2026-10-20T10:00:00Z",
        files = new[] { new { name = name ?? $"Cord-Setup-{version}-x64.exe", kind = "installer", size, sha256 = sha256 ?? new string('a', 64) } },
    });

    private static HttpClient Mirror(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) => new(new Handler(respond));
    private static HttpClient Mirror(Func<HttpRequestMessage, HttpResponseMessage> respond) => Mirror((request, _) => Task.FromResult(respond(request)));

    private static Task<UpdateCheck> Check(HttpClient http, TimeSpan? budget = null, CancellationToken? token = null) =>
        ForcedUpdate.CheckAsync(new ReleaseClient(http), Installed, "x64", budget ?? ForcedUpdate.StartupBudget, token ?? TestContext.Current.CancellationToken);

    [Fact]
    public async Task ANewerReleaseIsInstalledAtOnce()
    {
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new StringContent(Release("0.7.8")) });
        var check = await Check(http);
        Assert.Equal(UpdateVerdict.Forced, check.Verdict);
        Assert.Equal(new Version(0, 7, 8), check.Release!.Version);
        Assert.Equal(new Uri("https://meet.nikg.tech/downloads/windows/v0.7.8/Cord-Setup-0.7.8-x64.exe"), check.Release.Package);
    }

    /// <summary>Та же версия и любая старая — не повод ничего ставить, тем более откатываться.</summary>
    [Theory]
    [InlineData("0.7.7")]
    [InlineData("0.7.6")]
    [InlineData("0.6.9")]
    [InlineData("0.0.1")]
    public async Task TheSameOrAnOlderReleaseChangesNothing(string version)
    {
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new StringContent(Release(version)) });
        var check = await Check(http);
        Assert.Equal(UpdateVerdict.None, check.Verdict);
        Assert.Null(check.Release);
    }

    [Theory]
    [InlineData("0.7.8", true)]
    [InlineData("0.8.0", true)]
    [InlineData("1.0.0", true)]
    [InlineData("0.7.7", false)]
    [InlineData("0.7.7.9", false)]
    [InlineData("0.7.6", false)]
    [InlineData("0.6.99", false)]
    public void OnlyAnUpgradeIsEverInstalled(string candidate, bool upgrade) =>
        Assert.Equal(upgrade, ForcedUpdate.IsUpgrade(Version.Parse(candidate), Installed));

    [Fact]
    public async Task AnEmptyMirrorStartsNormally()
    {
        using var http = Mirror(_ => new(HttpStatusCode.NotFound));
        Assert.Equal(UpdateVerdict.None, (await Check(http)).Verdict);
    }

    /// <summary>Зеркало лежит, сломано или подменено — Cord всё равно открывается, а спросит позже.</summary>
    [Theory]
    [InlineData("down")]
    [InlineData("500")]
    [InlineData("503")]
    [InlineData("html")]
    [InlineData("empty")]
    [InlineData("foreign")]
    [InlineData("beta")]
    [InlineData("unverifiable")]
    [InlineData("github")]
    public async Task AMirrorThatCannotAnswerStartsNormally(string failure)
    {
        using var http = Mirror(_ => failure switch
        {
            "down" => throw new HttpRequestException("No route to host"),
            "500" => new(HttpStatusCode.InternalServerError),
            "503" => new(HttpStatusCode.ServiceUnavailable),
            "html" => new(HttpStatusCode.OK) { Content = new StringContent("<html>Bad gateway</html>") },
            "empty" => new(HttpStatusCode.OK) { Content = new StringContent("{}") },
            "foreign" => new(HttpStatusCode.OK) { Content = new StringContent(Release("0.7.8", name: "../../setup.exe")) },
            "beta" => new(HttpStatusCode.OK) { Content = new StringContent(Release("0.7.8-beta")) },
            "unverifiable" => new(HttpStatusCode.OK) { Content = new StringContent(Release("0.7.8", sha256: "")) },
            _ => Redirect("https://github.com/cord/releases/latest"),
        });
        var check = await Check(http);
        Assert.Equal(UpdateVerdict.Unavailable, check.Verdict);
        Assert.Null(check.Release);
    }

    /// <summary>Медленная сеть не держит запуск: на ответ у зеркала несколько секунд, не больше.</summary>
    [Fact]
    public async Task ASilentMirrorDoesNotHoldTheStart()
    {
        using var http = Mirror(async (_, token) =>
        {
            await Task.Delay(Timeout.Infinite, token);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        var watch = Stopwatch.StartNew();
        var check = await Check(http, TimeSpan.FromMilliseconds(200));
        Assert.Equal(UpdateVerdict.Unavailable, check.Verdict);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(30), $"The check waited {watch.Elapsed}.");
        Assert.InRange(ForcedUpdate.StartupBudget, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(10));
    }

    /// <summary>Закрытое окно — не сбой зеркала: отмена доходит до вызывающего как отмена.</summary>
    [Fact]
    public async Task ClosingTheWindowIsNotAMirrorFailure()
    {
        using var closing = new CancellationTokenSource();
        using var http = Mirror(async (_, token) =>
        {
            await closing.CancelAsync();
            await Task.Delay(Timeout.Infinite, token);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Check(http, TimeSpan.FromMinutes(1), closing.Token));
    }

    /// <summary>Неответ зеркала переспрашивается скоро, обычная проверка — раз в шесть часов.</summary>
    [Fact]
    public void AnUnansweredCheckIsRetriedSoon()
    {
        Assert.Equal(ForcedUpdate.Period, ForcedUpdate.NextCheck(UpdateVerdict.None));
        Assert.Equal(ForcedUpdate.Period, ForcedUpdate.NextCheck(UpdateVerdict.Forced));
        Assert.Equal(ForcedUpdate.RetrySoon, ForcedUpdate.NextCheck(UpdateVerdict.Unavailable));
        Assert.InRange(ForcedUpdate.RetrySoon, TimeSpan.FromMinutes(1), TimeSpan.FromHours(1));
        Assert.True(ForcedUpdate.RetrySoon < ForcedUpdate.Period);
    }

    /// <summary>Разговор не прерывается, и экран перед входом во встречу — тоже.</summary>
    [Theory]
    [InlineData(true, "room", false)]
    [InlineData(true, null, false)]
    [InlineData(false, "prejoin", false)]
    [InlineData(false, "home", true)]
    [InlineData(false, "room", true)]
    [InlineData(false, null, true)]
    public void AMeetingIsNeverInterrupted(bool inCall, string? page, bool interrupt) =>
        Assert.Equal(interrupt, ForcedUpdate.CanInterrupt(inCall, page));

    [Fact]
    public async Task AVerifiedDownloadIsReadyToInstall()
    {
        var bytes = Encoding.UTF8.GetBytes("cord");
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) });
        await InFolder(async folder =>
        {
            var download = await Download(http, Signed(bytes), folder);
            Assert.True(download.Ok);
            Assert.Equal(bytes, await File.ReadAllBytesAsync(download.Package!, TestContext.Current.CancellationToken));
        });
    }

    /// <summary>Повреждённый пакет не ставится, а человек остаётся в текущей версии с причиной словами.</summary>
    [Fact]
    public async Task AFailedDownloadLetsCordContinue()
    {
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new ByteArrayContent([1, 2, 3, 4]) });
        await InFolder(async folder =>
        {
            var download = await Download(http, Signed(Encoding.UTF8.GetBytes("cord")), folder);
            Assert.False(download.Ok);
            Assert.Null(download.Package);
            Assert.Contains("SHA-256", download.Problem, StringComparison.Ordinal);
            Assert.Empty(Directory.GetFiles(folder));
        });
    }

    [Theory]
    [InlineData("broken")]
    [InlineData("missing")]
    public async Task ALostConnectionDuringDownloadLetsCordContinue(string failure)
    {
        using var http = Mirror(_ => failure == "broken" ? throw new HttpRequestException("Connection reset") : new(HttpStatusCode.NotFound));
        await InFolder(async folder =>
        {
            var download = await Download(http, Signed(Encoding.UTF8.GetBytes("cord")), folder);
            Assert.False(download.Ok);
            Assert.False(string.IsNullOrWhiteSpace(download.Problem));
        });
    }

    /// <summary>Загрузка, которая встала, не держит экран обновления вечно.</summary>
    [Fact]
    public async Task AStalledDownloadIsAbandoned()
    {
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new StreamContent(new Trickle([], stall: true)) });
        await InFolder(async folder =>
        {
            var download = await Download(http, Signed(Encoding.UTF8.GetBytes("cord")), folder, TimeSpan.FromMilliseconds(300));
            Assert.False(download.Ok);
            Assert.Contains("остановилась", download.Problem, StringComparison.Ordinal);
        });
    }

    /// <summary>
    /// Сторож следит за тишиной, а не за длительностью: загрузка идёт дольше срока сторожа, но
    /// каждый байт приходит раньше него — и она доходит до конца. Часы ручные: на занятой машине
    /// настоящие паузы растягиваются как угодно, и проверка гадала бы, а не проверяла.
    /// </summary>
    [Fact]
    public async Task ASlowButLiveDownloadIsNotAbandoned()
    {
        var bytes = Encoding.UTF8.GetBytes("cord-t58");
        var time = new ManualTime();
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new StreamContent(new Trickle(bytes, () => time.Advance(TimeSpan.FromSeconds(6)))) });
        await InFolder(async folder =>
        {
            var reported = new List<double>();
            var download = await Download(http, Signed(bytes), folder, TimeSpan.FromSeconds(10), new Sink(reported.Add), time);
            Assert.True(download.Ok, download.Problem);
            Assert.Equal(1.0, reported[^1]);
            Assert.True(time.Now > TimeSpan.FromSeconds(40), "The download must outlast the watchdog for this test to mean anything.");
        });
    }

    /// <summary>Та же загрузка, но байт опоздал дольше срока сторожа, — она прекращается.</summary>
    [Fact]
    public async Task ASilenceLongerThanTheWatchdogEndsTheDownload()
    {
        var bytes = Encoding.UTF8.GetBytes("cord-t58");
        var time = new ManualTime();
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new StreamContent(new Trickle(bytes, () => time.Advance(TimeSpan.FromSeconds(11)))) });
        await InFolder(async folder =>
        {
            var download = await Download(http, Signed(bytes), folder, TimeSpan.FromSeconds(10), null, time);
            Assert.False(download.Ok);
            Assert.Contains("остановилась", download.Problem, StringComparison.Ordinal);
        });
    }

    private static readonly UpdateCheck Found = new(UpdateVerdict.Forced, new CordRelease(new(0, 7, 8), new Uri("https://meet.nikg.tech/downloads/windows/v0.7.8/Cord-Setup-0.7.8-x64.exe"), new string('a', 64), 4));

    /// <summary>Ставить нечего — заставка сказала одно «Проверяем обновления…» и открывает Cord.</summary>
    [Fact]
    public async Task TheSplashOpensCordWhenThereIsNothingToInstall()
    {
        var steps = new Steps();
        var screen = new Screen();
        var result = await Splash(steps, screen);
        Assert.Equal(SplashOutcome.OpenCord, result.Outcome);
        Assert.Equal(["Проверяем обновления…"], screen.Texts);
        Assert.Equal(["failure", "check"], steps.Calls);
        Assert.Equal(ForcedUpdate.StartupBudget, steps.Budget);
        Assert.Equal(ForcedUpdate.Period, result.NextCheck);
    }

    /// <summary>Зеркало не ответило за отведённые секунды — Cord открывается и спросит снова скоро.</summary>
    [Fact]
    public async Task TheSplashOpensCordWhenTheMirrorCannotAnswer()
    {
        var steps = new Steps { Checks = { new(UpdateVerdict.Unavailable) } };
        var result = await Splash(steps, new Screen());
        Assert.Equal(SplashOutcome.OpenCord, result.Outcome);
        Assert.DoesNotContain("download", steps.Calls);
        Assert.Equal(ForcedUpdate.RetrySoon, result.NextCheck);
    }

    /// <summary>Есть новее: проверка, загрузка с процентами, установка — и Cord закрывается ради неё.</summary>
    [Fact]
    public async Task TheSplashDownloadsInstallsAndRestarts()
    {
        var steps = new Steps { Checks = { Found } };
        var screen = new Screen();
        var result = await Splash(steps, screen);
        Assert.Equal(SplashOutcome.Restarting, result.Outcome);
        Assert.Equal(["Проверяем обновления…", "Загружаем обновление… 0%", "Загружаем обновление… 42%", "Загружаем обновление… 100%", "Устанавливаем…"], screen.Texts);
        Assert.Equal(["failure", "check", "download", "apply"], steps.Calls);
    }

    /// <summary>Загрузка не удалась — заставка останавливается на причине, ставить нечего.</summary>
    [Fact]
    public async Task AFailedDownloadStopsAtTheSplashWithTheReason()
    {
        var steps = new Steps { Checks = { Found }, Download = new(null, "Не удалось скачать обновление. Проверьте соединение.") };
        var result = await Splash(steps, new Screen());
        Assert.Equal(SplashOutcome.Failed, result.Outcome);
        Assert.Equal("Не удалось скачать обновление. Проверьте соединение.", result.Problem);
        Assert.DoesNotContain("apply", steps.Calls);
        Assert.Equal(ForcedUpdate.Period, result.NextCheck);
    }

    /// <summary>
    /// Помощник не запустился или не дождался готовности — причина короткая, исключение остаётся
    /// для журнала, а пакет забывается: «Повторить» скачает его заново, а не споткнётся о тот же файл.
    /// </summary>
    [Theory]
    [InlineData("io")]
    [InlineData("timeout")]
    [InlineData("not-ready")]
    public async Task AnInstallThatCouldNotStartIsDownloadedAgainOnRetry(string failure)
    {
        Exception error = failure switch
        {
            "io" => new IOException("Помощник обновления завершился до готовности."),
            "timeout" => new TaskCanceledException(),
            _ => new InvalidOperationException("Обновление не готово."),
        };
        var steps = new Steps { Checks = { Found }, ApplyError = error };
        var result = await Splash(steps, new Screen());
        Assert.Equal(SplashOutcome.Failed, result.Outcome);
        Assert.Equal("Не удалось запустить установку.", result.Problem);
        Assert.Same(error, result.Error);
        Assert.Equal("discard", steps.Calls[^1]);
    }

    /// <summary>
    /// Прошлая установка не встала — заставка сразу показывает причину и сама второй раз не
    /// ставит: иначе сбой установщика стал бы кругом «обновился — открылся прежним — снова
    /// обновляется». «Повторить» проходит весь путь заново.
    /// </summary>
    [Fact]
    public async Task ALastFailedInstallIsShownNotRepeated()
    {
        var steps = new Steps { Failure = "Обновление не установилось: файлы Cord заняты.", Checks = { Found } };
        var first = await Splash(steps, new Screen());
        Assert.Equal(SplashOutcome.Failed, first.Outcome);
        Assert.Equal("Обновление не установилось: файлы Cord заняты.", first.Problem);
        Assert.Equal(["failure"], steps.Calls);
        var retry = await Splash(steps, new Screen());
        Assert.Equal(SplashOutcome.Restarting, retry.Outcome);
        Assert.Equal(["failure", "failure", "check", "download", "apply"], steps.Calls);
    }

    /// <summary>Закрытая заставка — не сбой обновления: отмена доходит до окна как отмена.</summary>
    [Fact]
    public async Task ClosingTheSplashIsNotAFailure()
    {
        using var early = new CancellationTokenSource();
        await early.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Splash(new Steps { Checks = { Found } }, new Screen(), early.Token));
        using var late = new CancellationTokenSource();
        var installing = new Steps
        {
            Checks = { Found },
            Applying = async () =>
            {
                await late.CancelAsync();
                late.Token.ThrowIfCancellationRequested();
            },
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Splash(installing, new Screen(), late.Token));
        Assert.DoesNotContain("discard", installing.Calls);
    }

    /// <summary>Одна короткая строка, проценты целые и не больше ста, номера версии нет.</summary>
    [Fact]
    public void TheSplashSpeaksInOneShortLineWithoutAVersion()
    {
        Assert.Equal("Проверяем обновления…", new SplashState(SplashStage.Checking).Text);
        Assert.Equal("Загружаем обновление… 99%", new SplashState(SplashStage.Downloading, 0.999).Text);
        Assert.Equal("Загружаем обновление… 100%", new SplashState(SplashStage.Downloading, 1.7).Text);
        Assert.Equal("Загружаем обновление… 0%", new SplashState(SplashStage.Downloading, -1).Text);
        Assert.Equal("Устанавливаем…", new SplashState(SplashStage.Installing).Text);
        Assert.Equal("Нет связи.", new SplashState(SplashStage.Failed, Problem: "Нет связи.").Text);
        Assert.DoesNotContain(new[] { SplashStage.Checking, SplashStage.Installing }, stage => new SplashState(stage).Text.Any(char.IsDigit));
    }

    /// <summary>Итог помощника — словами и коротко; успех — не повод что-то показывать.</summary>
    [Theory]
    [InlineData("""{"ok":true,"stage":"check","code":0,"version":"0.7.8","installed":"0.7.8"}""", null)]
    [InlineData("""{"ok":false,"stage":"install","code":5,"version":"0.7.8"}""", "заняты")]
    [InlineData("""{"ok":false,"stage":"install","code":7}""", "заняты")]
    [InlineData("""{"ok":false,"stage":"install","code":8}""", "перезагрузки")]
    [InlineData("""{"ok":false,"stage":"install","code":2}""", "код 2")]
    [InlineData("""{"ok":false,"stage":"wait","code":null}""", "не закрылся")]
    [InlineData("""{"ok":false,"stage":"verify","code":null}""", "повреждён")]
    [InlineData("""{"ok":false,"stage":"check","code":0,"version":"0.7.8","installed":"0.7.7"}""", "прежняя версия")]
    [InlineData("""{"ok":false,"stage":"close","code":null,"detail":"Access denied"}""", "Обновление не установилось.")]
    [InlineData("<html>", "Обновление не установилось.")]
    public void ALastInstallIsToldInWords(string result, string? expected)
    {
        var failure = ForcedUpdate.InstallFailure(result);
        if (expected is null)
        {
            Assert.Null(failure);
            return;
        }
        Assert.NotNull(failure);
        Assert.StartsWith("Обновление не установилось", failure, StringComparison.Ordinal);
        Assert.Contains(expected, failure, StringComparison.Ordinal);
        // Номер версии показывает только «О программе»; английский текст помощника — журналу.
        Assert.DoesNotContain("0.7", failure, StringComparison.Ordinal);
        Assert.DoesNotContain("Access", failure, StringComparison.Ordinal);
    }

    private static Task<SplashResult> Splash(Steps steps, Screen screen, CancellationToken? token = null) =>
        ForcedUpdate.SplashAsync(steps, screen, token ?? TestContext.Current.CancellationToken);

    /// <summary>Обновлятор понарошку: отвечает заданным и записывает, о чём его просили.</summary>
    private sealed class Steps : IUpdateSteps
    {
        public string? Failure { get; set; }
        /// <summary>Ответы зеркала по очереди; кончились — «новее нет».</summary>
        public List<UpdateCheck> Checks { get; } = [];
        public UpdateDownload Download { get; set; } = new("Cord-Setup-0.7.8-x64.exe");
        public Exception? ApplyError { get; set; }
        public Func<Task>? Applying { get; set; }
        public List<string> Calls { get; } = [];
        public TimeSpan? Budget { get; private set; }

        public string? TakeInstallFailure()
        {
            Calls.Add("failure");
            var failure = Failure;
            Failure = null;
            return failure;
        }

        public Task<UpdateCheck> CheckAsync(TimeSpan budget, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            Calls.Add("check");
            Budget = budget;
            if (Checks.Count == 0) return Task.FromResult(new UpdateCheck(UpdateVerdict.None));
            var check = Checks[0];
            Checks.RemoveAt(0);
            return Task.FromResult(check);
        }

        public Task<UpdateDownload> DownloadAsync(IProgress<double> progress, CancellationToken token)
        {
            Calls.Add("download");
            progress.Report(0.42);
            progress.Report(1.0);
            return Task.FromResult(Download);
        }

        public Task ApplyAsync(CancellationToken token)
        {
            Calls.Add("apply");
            if (Applying is not null) return Applying();
            return ApplyError is null ? Task.CompletedTask : Task.FromException(ApplyError);
        }

        public void DiscardPackage() => Calls.Add("discard");
    }

    /// <summary>Что заставка показала, по порядку.</summary>
    private sealed class Screen : IProgress<SplashState>
    {
        public List<string> Texts { get; } = [];
        public void Report(SplashState value) => Texts.Add(value.Text);
    }

    private static CordRelease Signed(byte[] bytes) =>
        ReleaseClient.Parse(Release("0.7.8", Convert.ToHexStringLower(SHA256.HashData(bytes)), bytes.Length), Installed, "x64")!;

    private static Task<UpdateDownload> Download(HttpClient http, CordRelease release, string folder, TimeSpan? stall = null, IProgress<double>? progress = null, TimeProvider? time = null) =>
        ForcedUpdate.DownloadAsync((relay, token) => new ReleaseClient(http).DownloadAsync(release, folder, relay, token), progress, stall ?? ForcedUpdate.StallLimit, time ?? TimeProvider.System, TestContext.Current.CancellationToken);

    private static async Task InFolder(Func<string, Task> test)
    {
        var folder = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(folder);
        try { await test(folder); }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    private static HttpResponseMessage Redirect(string location)
    {
        var response = new HttpResponseMessage(HttpStatusCode.Redirect);
        response.Headers.Location = new Uri(location);
        return response;
    }

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => respond(request, token);
    }

    private sealed class Sink(Action<double> report) : IProgress<double>
    {
        public void Report(double value) => report(value);
    }

    /// <summary>Часы, которые идут, только когда их двигают. Срабатывание — синхронно, внутри <see cref="Advance"/>.</summary>
    private sealed class ManualTime : TimeProvider
    {
        private readonly Lock _gate = new();
        private readonly List<Alarm> _alarms = [];
        public TimeSpan Now { get; private set; }

        public void Advance(TimeSpan by)
        {
            List<Alarm> due;
            lock (_gate)
            {
                Now += by;
                due = [.. _alarms.Where(alarm => alarm.Due <= Now)];
                foreach (var alarm in due) alarm.Due = null;
            }
            foreach (var alarm in due) alarm.Fire();
        }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var alarm = new Alarm(this, callback, state);
            alarm.Change(dueTime, period);
            return alarm;
        }

        private sealed class Alarm(ManualTime time, TimerCallback callback, object? state) : ITimer
        {
            public TimeSpan? Due { get; set; }
            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                lock (time._gate)
                {
                    Due = dueTime == Timeout.InfiniteTimeSpan ? null : time.Now + dueTime;
                    if (!time._alarms.Contains(this)) time._alarms.Add(this);
                }
                return true;
            }
            public void Fire() => callback(state);
            public void Dispose()
            {
                lock (time._gate) time._alarms.Remove(this);
            }
            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }

    /// <summary>Поток, который отдаёт по байту, перед каждым выполняя <paramref name="pause"/>, — или замолкает совсем.</summary>
    private sealed class Trickle(byte[] bytes, Action? pause = null, bool stall = false) : Stream
    {
        private int _position;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => bytes.Length;
        public override long Position { get => _position; set => throw new NotSupportedException(); }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            if (stall) await Task.Delay(Timeout.Infinite, token);
            if (_position >= bytes.Length || buffer.Length == 0) return 0;
            pause?.Invoke();
            token.ThrowIfCancellationRequested();
            buffer.Span[0] = bytes[_position++];
            return 1;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) => ReadAsync(buffer.AsMemory(offset, count), token).AsTask();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
