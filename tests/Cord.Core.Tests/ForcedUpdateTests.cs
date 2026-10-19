using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cord.Core;
using Xunit;

/// <summary>
/// T58: при запуске Cord спрашивает зеркало о версии. Новее — ставится сразу; та же или старее —
/// ничего не происходит; зеркало молчит или отвечает не тем — Cord запускается как обычно и
/// спросит позже. Сбой загрузки отпускает человека в текущую версию, а не запирает на экране
/// обновления.
/// </summary>
public class ForcedUpdateTests
{
    private static readonly Version Installed = new(0, 7, 6, 0);

    private static string Release(string tag, string? digest = null, long size = 4, string? url = null) => JsonSerializer.Serialize(new
    {
        repository = ReleaseClient.Repository,
        tag_name = tag,
        draft = false,
        prerelease = false,
        assets = new[] { new { name = $"Cord-Setup-{tag.TrimStart('v')}-x64.exe", browser_download_url = url ?? $"https://github.com/{ReleaseClient.Repository}/releases/download/{tag}/Cord-Setup-{tag.TrimStart('v')}-x64.exe", size, digest = digest ?? "sha256:" + new string('a', 64) } }
    });

    private static HttpClient Mirror(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond) => new(new Handler(respond));
    private static HttpClient Mirror(Func<HttpRequestMessage, HttpResponseMessage> respond) => Mirror((request, _) => Task.FromResult(respond(request)));

    private static Task<UpdateCheck> Check(HttpClient http, TimeSpan? budget = null, CancellationToken? token = null) =>
        ForcedUpdate.CheckAsync(new ReleaseClient(http), Installed, "x64", budget ?? ForcedUpdate.StartupBudget, token ?? TestContext.Current.CancellationToken);

    [Fact]
    public async Task ANewerReleaseIsInstalledAtOnce()
    {
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new StringContent(Release("v0.7.7")) });
        var check = await Check(http);
        Assert.Equal(UpdateVerdict.Forced, check.Verdict);
        Assert.Equal(new Version(0, 7, 7), check.Release!.Version);
        Assert.Equal(new Uri("https://meet.nikg.tech/downloads/windows/v0.7.7/Cord-Setup-0.7.7-x64.exe"), check.Release.Package);
    }

    /// <summary>Та же версия и любая старая — не повод ничего ставить, тем более откатываться.</summary>
    [Theory]
    [InlineData("v0.7.6")]
    [InlineData("v0.7.5")]
    [InlineData("v0.6.9")]
    [InlineData("v0.0.1")]
    public async Task TheSameOrAnOlderReleaseChangesNothing(string tag)
    {
        using var http = Mirror(_ => new(HttpStatusCode.OK) { Content = new StringContent(Release(tag)) });
        var check = await Check(http);
        Assert.Equal(UpdateVerdict.None, check.Verdict);
        Assert.Null(check.Release);
    }

    [Theory]
    [InlineData("0.7.7", true)]
    [InlineData("0.8.0", true)]
    [InlineData("1.0.0", true)]
    [InlineData("0.7.6", false)]
    [InlineData("0.7.6.9", false)]
    [InlineData("0.7.5", false)]
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
            "foreign" => new(HttpStatusCode.OK) { Content = new StringContent(Release("v0.7.7", url: "https://example.org/setup.exe")) },
            _ => Redirect($"https://github.com/{ReleaseClient.Repository}/releases/latest"),
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

    private static CordRelease Signed(byte[] bytes) =>
        ReleaseClient.ParseMirror(Release("v0.7.7", "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes)), bytes.Length), Installed, "x64")!;

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
