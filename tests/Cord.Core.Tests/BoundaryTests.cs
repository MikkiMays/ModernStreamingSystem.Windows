using System.Net;
using System.Text;
using Cord.Core;
using Cord.Windows.Services;
using Xunit;

namespace Cord.Tests;

public sealed class BoundaryTests
{
    [Theory]
    [InlineData("https://meet.example.com")]
    [InlineData("http://localhost:5173/")]
    [InlineData("http://127.0.0.1:5173/")]
    public void AcceptsExplicitServerOrigins(string value) => Assert.True(ServerEndpoint.Parse(value).Owns(value + "/room/a"));

    [Theory]
    [InlineData("http://meet.example.com")]
    [InlineData("https://meet.example.com/join/123")]
    [InlineData("https://token@meet.example.com")]
    [InlineData("file:///C:/private.txt")]
    [InlineData("https://meet.example.com/?token=secret")]
    [InlineData("javascript:alert(1)")]
    public void RejectsInsecureOrAmbiguousOrigins(string value) => Assert.Throws<ArgumentException>(() => ServerEndpoint.Parse(value));

    [Theory]
    [InlineData("https://meet.example.com.evil.test/")]
    [InlineData("http://meet.example.com/")]
    [InlineData("https://meet.example.com:444/")]
    [InlineData("https://user@meet.example.com/")]
    public void OriginComparisonIncludesSchemeHostAndPort(string value) => Assert.False(ServerEndpoint.Parse("https://meet.example.com").Owns(value));

    [Fact]
    public void MicrophoneHotkeyValidatesBridgeAndNativeModifiers()
    {
        var endpoint = ServerEndpoint.Parse("https://meet.nikg.tech");
        var allowed = BridgeProtocol.Read(endpoint, endpoint.Origin.AbsoluteUri,
            """{"version":1,"type":"hotkey.configure","hotkey":{"code":"KeyM","ctrl":true,"alt":false,"shift":true,"meta":false}}""");
        Assert.NotNull(allowed?.Hotkey);
        Assert.True(allowed.Hotkey.TryNative(out var modifiers, out var key));
        Assert.Equal(0x4006u, modifiers);
        Assert.Equal(0x4du, key);
        Assert.False(new MicrophoneHotkey("KeyM", false, false, false, false).TryNative(out _, out _));
        Assert.False(new MicrophoneHotkey("F12", true, false, false, false).TryNative(out _, out _));
        Assert.False(new MicrophoneHotkey("KeyM", false, false, false, true).TryNative(out _, out _));
        Assert.Null(BridgeProtocol.Read(endpoint, endpoint.Origin.AbsoluteUri,
            """{"version":1,"type":"hotkey.configure","hotkey":{"code":"Escape","ctrl":true}}"""));
        Assert.Null(BridgeProtocol.Read(endpoint, "https://another.example",
            """{"version":1,"type":"hotkey.configure","hotkey":{"code":"KeyM","ctrl":true}}"""));
    }

    [Fact]
    public void RejectsSpoofedBridgeCommandsAndMalformedMessages()
    {
        var endpoint = ServerEndpoint.Parse("https://meet.example.com");
        Assert.Null(BridgeProtocol.Read(endpoint, "https://evil.test", """{"version":1,"type":"favorites.changed"}"""));
        Assert.Null(BridgeProtocol.Read(endpoint, endpoint.Origin.AbsoluteUri, """{"version":1,"type":"execute","command":"anything"}"""));
        Assert.Null(BridgeProtocol.Read(endpoint, endpoint.Origin.AbsoluteUri, """{"version":2,"type":"close-ready"}"""));
        Assert.Null(BridgeProtocol.Read(endpoint, endpoint.Origin.AbsoluteUri, """{"version":1,"type":"state","page":"room","room":{"roomId":null,"title":null,"code":null}}"""));
        Assert.Null(BridgeProtocol.Read(endpoint, endpoint.Origin.AbsoluteUri, "{"));
        Assert.NotNull(BridgeProtocol.Read(endpoint, endpoint.Origin.AbsoluteUri, """{"version":1,"type":"state","page":"home"}"""));
    }

    /// <summary>
    /// The profile picture crosses the bridge because the page owns it and the sidebar shows it.
    /// Having no picture is an ordinary state and must not cost the whole message; anything that
    /// is not a small image is not a picture.
    /// </summary>
    [Fact]
    public void ProfilePictureCrossesTheBridgeOnlyAsASmallImage()
    {
        var endpoint = ServerEndpoint.Parse("https://meet.example.com");
        var origin = endpoint.Origin.AbsoluteUri;
        string state(string avatar) => $$"""{"version":1,"type":"state","page":"home","avatar":{{avatar}}}""";
        Assert.Equal(
            "data:image/webp;base64,AAAA",
            BridgeProtocol.Read(endpoint, origin, state("\"data:image/webp;base64,AAAA\""))?.Avatar);
        Assert.NotNull(BridgeProtocol.Read(endpoint, origin, state("\"\"")));
        Assert.NotNull(BridgeProtocol.Read(endpoint, origin, state("null")));
        Assert.Null(BridgeProtocol.Read(endpoint, origin, state("\"https://evil.test/track.png\"")));
        Assert.Null(BridgeProtocol.Read(
            endpoint, origin, state($"\"data:image/webp;base64,{new string('A', BridgeProtocol.AvatarLimit)}\"")));
        Assert.Null(BridgeProtocol.Read(endpoint, origin, state($"\"{new string('A', 20000)}\"")));
    }

    /// <summary>
    /// Automatic connection belongs to the application — it decides whether the server is opened
    /// without asking — but the switch is on the settings page, so it has to travel both ways.
    /// </summary>
    [Fact]
    public void AutomaticConnectionTravelsBothWaysAcrossTheBridge()
    {
        var endpoint = ServerEndpoint.Parse("https://meet.example.com");
        var message = BridgeProtocol.Read(
            endpoint, endpoint.Origin.AbsoluteUri, """{"version":1,"type":"server.autoconnect","autoConnect":false}""");
        Assert.Equal("server.autoconnect", message?.Type);
        Assert.False(message!.AutoConnect);
        var profile = new string('A', 43);
        Assert.Contains("server.autoConnect = false", BridgeProtocol.Bootstrap(endpoint, profile, autoConnect: false), StringComparison.Ordinal);
        Assert.Contains("server.autoConnect = true", BridgeProtocol.Bootstrap(endpoint, profile), StringComparison.Ordinal);
    }

    [Fact]
    public async Task NativeClientUsesTheSameFavoriteContractAndNeverQueryStringCredentials()
    {
        using var handler = new StubHttp(request =>
        {
            Assert.Equal("/api/v1/favorites", request.RequestUri!.AbsolutePath);
            Assert.Empty(request.RequestUri.Query);
            Assert.Equal("Bearer", request.Headers.Authorization?.Scheme);
            Assert.Equal(new string('A', 43), request.Headers.Authorization?.Parameter);
            return new(HttpStatusCode.OK) { Content = new StringContent("""[{"roomId":"11111111-1111-1111-1111-111111111111","title":"Наш вечер","code":"123456789","savedAt":1,"closed":false,"canJoin":true}]""", Encoding.UTF8, "application/json") };
        });
        using var http = new HttpClient(handler);
        var rooms = await new FavoriteClient(http).ListAsync(ServerEndpoint.Parse("https://meet.example.com"), new string('A', 43), TestContext.Current.CancellationToken);
        Assert.Equal("123-456-789", Assert.Single(rooms).DisplayCode);
    }

    [Fact]
    public async Task AFreshInstallationHasNoServerAndKeepsWhatWasSavedWithoutOne()
    {
        // Свежая установка ничего не знает о серверах, и это состояние обязано пережить запись:
        // сервер добавляют до того, как к нему подключились, а вместе с ним сохраняются тема и
        // список. Раньше пустой адрес ронял разбор, и сохранённое возвращалось умолчаниями.
        var root = Path.Combine(Path.GetTempPath(), "Cord.Tests", Guid.NewGuid().ToString("N"));
        try
        {
            var token = TestContext.Current.CancellationToken;
            var store = new ProfileStore(root);
            var fresh = await store.LoadAsync(token);
            Assert.Equal("", fresh.ServerUrl);
            Assert.Empty(fresh.Servers!);

            var added = ServerList.Add([], "https://first.example.com", "Первый");
            await store.SaveAsync(new DesktopSettings("", "dark", Servers: added), token);
            var reopened = await new ProfileStore(root).LoadAsync(token);
            Assert.Equal("", reopened.ServerUrl);
            Assert.Equal("dark", reopened.Theme);
            Assert.Equal("https://first.example.com/", Assert.Single(reopened.Servers!).Url);
        }
        finally
        {
            var allowed = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "Cord.Tests")) + Path.DirectorySeparatorChar;
            if (Path.GetFullPath(root).StartsWith(allowed, StringComparison.OrdinalIgnoreCase)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ProfilePersistsAcrossRestartsAndKeepsServersIsolated()
    {
        var root = Path.Combine(Path.GetTempPath(), "Cord.Tests", Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ProfileStore(root);
            var a = ServerEndpoint.Parse("https://a.example.com");
            var b = ServerEndpoint.Parse("https://b.example.com");
            var token = TestContext.Current.CancellationToken;
            var capability = await store.GetCapabilityAsync(a, token);
            Assert.Equal(43, capability.Length);
            Assert.Equal(capability, await new ProfileStore(root).GetCapabilityAsync(a, token));
            Assert.NotEqual(capability, await store.GetCapabilityAsync(b, token));
            var encrypted = await File.ReadAllBytesAsync(Path.Combine(root, $"profile-{a.StorageKey}.dat"), token);
            Assert.DoesNotContain(capability, Encoding.UTF8.GetString(encrypted));
            await store.SaveAsync(new DesktopSettings(a.Origin.AbsoluteUri, "dark", true), token);
            Assert.Equal("dark", (await new ProfileStore(root).LoadAsync(token)).Theme);
        }
        finally
        {
            var allowed = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "Cord.Tests")) + Path.DirectorySeparatorChar;
            if (Path.GetFullPath(root).StartsWith(allowed, StringComparison.OrdinalIgnoreCase)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void TheHostHandsThePageASessionAndNeverThePassword()
    {
        var endpoint = ServerEndpoint.Parse("https://meet.example.com");
        var profile = new string('A', 43);
        var session = new ServerSession("1800000000.signature", 1800000000, "Наш Cord", true);
        var withSession = BridgeProtocol.Bootstrap(endpoint, profile, "dark", false, true, session);
        Assert.Contains("cord:session:v1", withSession, StringComparison.Ordinal);
        Assert.Contains("1800000000.signature", withSession, StringComparison.Ordinal);
        // The page did not perform this connection, so it is told that one just happened and
        // can sound the cue. The mark is only ever set alongside a real session.
        Assert.Contains("sessionStorage.setItem('cord:session:fresh', '1')", withSession, StringComparison.Ordinal);
        // Bootstrap has no parameter for the password at all, and what it does carry is a value
        // inside a JavaScript string literal: a server that names itself with a quote must not
        // be able to end that literal and continue as code.
        var hostile = new ServerSession("1800000000.s", 1800000000, "');fetch('https://evil.test", true);
        Assert.DoesNotContain("');fetch(", BridgeProtocol.Bootstrap(endpoint, profile, "dark", false, true, hostile), StringComparison.Ordinal);
        var without = BridgeProtocol.Bootstrap(endpoint, profile);
        Assert.Contains("sessionStorage.removeItem('cord:session:v1')", without, StringComparison.Ordinal);
        Assert.DoesNotContain("setItem('cord:session:v1'", without, StringComparison.Ordinal);
        Assert.DoesNotContain("setItem('cord:session:fresh'", without, StringComparison.Ordinal);
    }

    [Fact]
    public void TheBridgeCarriesTheTwoNewRequestsAndNothingElse()
    {
        var endpoint = ServerEndpoint.Parse("https://meet.example.com");
        var origin = endpoint.Origin.AbsoluteUri;
        Assert.Equal("servers.open", BridgeProtocol.Read(endpoint, origin, """{"version":1,"type":"servers.open"}""")?.Type);
        Assert.Equal("session.expired", BridgeProtocol.Read(endpoint, origin, """{"version":1,"type":"session.expired"}""")?.Type);
        Assert.Null(BridgeProtocol.Read(endpoint, "https://evil.test", """{"version":1,"type":"servers.open"}"""));
        Assert.Null(BridgeProtocol.Read(endpoint, origin, """{"version":1,"type":"session.token"}"""));
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, "не принял пароль")]
    [InlineData(HttpStatusCode.TooManyRequests, "Слишком много попыток")]
    [InlineData(HttpStatusCode.BadGateway, "ещё запускается")]
    public async Task EveryRefusalSaysSomethingAPersonCanActOn(HttpStatusCode status, string expected)
    {
        using var handler = new StubHttp(_ => new(status));
        using var http = new HttpClient(handler);
        var result = await new ServerAccessClient(http).TryConnectAsync("https://meet.example.com", "wrong", TestContext.Current.CancellationToken);
        Assert.False(result.Ok);
        Assert.Contains(expected, result.Detail, StringComparison.Ordinal);
        Assert.Null(result.Session);
    }

    /// <summary>
    /// A Cord older than the handshake has no /session at all. Refusing to open it would mean a
    /// new client cannot talk to a server nobody has updated yet, which is not a decision this
    /// client gets to make. A 404 from something that is not Cord still has to look different.
    /// </summary>
    [Fact]
    public async Task AServerWithNoDoorIsWalkedIntoAndAnythingElseWithA404IsNot()
    {
        using var older = new StubHttp(request => request.RequestUri!.AbsolutePath == "/api/v1/session"
            ? new(HttpStatusCode.NotFound)
            : new(HttpStatusCode.OK) { Content = new StringContent("""{"name":"Старый Cord","passwordRequired":false,"maxParticipants":10}""", Encoding.UTF8, "application/json") });
        using var olderClient = new HttpClient(older);
        var walked = await new ServerAccessClient(olderClient).TryConnectAsync("https://meet.example.com", "", TestContext.Current.CancellationToken);
        Assert.True(walked.Ok, walked.Detail);
        Assert.Equal("", walked.Session!.Token);
        Assert.Equal("Старый Cord", walked.Session.Name);
        // An empty pass is not a pass: the page must not be handed one.
        Assert.Contains("removeItem('cord:session:v1')", BridgeProtocol.Bootstrap(ServerEndpoint.Parse("https://meet.example.com"), new string('A', 43), "system", false, true, walked.Session), StringComparison.Ordinal);

        using var stranger = new StubHttp(_ => new(HttpStatusCode.NotFound));
        using var strangerClient = new HttpClient(stranger);
        var refused = await new ServerAccessClient(strangerClient).TryConnectAsync("https://meet.example.com", "", TestContext.Current.CancellationToken);
        Assert.False(refused.Ok);
        Assert.Contains("отвечает не Cord", refused.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnAddressThatCannotBeAServerIsRefusedBeforeAnythingIsSent()
    {
        var sent = false;
        using var handler = new StubHttp(_ => { sent = true; return new(HttpStatusCode.OK); });
        using var http = new HttpClient(handler);
        var result = await new ServerAccessClient(http).TryConnectAsync("http://meet.example.com", "", TestContext.Current.CancellationToken);
        Assert.False(result.Ok);
        Assert.False(sent);
        Assert.Contains("HTTPS", result.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AHandshakeSendsThePasswordInTheBodyAndReturnsTheSession()
    {
        string? body = null;
        using var handler = new StubHttp(request =>
        {
            Assert.Equal("/api/v1/session", request.RequestUri!.AbsolutePath);
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Empty(request.RequestUri.Query);
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new(HttpStatusCode.OK) { Content = new StringContent("""{"token":"1800000000.s","expiresAt":1800000000,"name":"Наш Cord","passwordRequired":true}""", Encoding.UTF8, "application/json") };
        });
        using var http = new HttpClient(handler);
        var result = await new ServerAccessClient(http).TryConnectAsync("https://meet.example.com", "тайна", TestContext.Current.CancellationToken);
        Assert.True(result.Ok, result.Detail);
        Assert.Equal("Наш Cord", result.Session!.Name);
        Assert.Equal("тайна", System.Text.Json.JsonDocument.Parse(body!).RootElement.GetProperty("password").GetString());
    }

    [Fact]
    public async Task AServerPasswordIsKeptEncryptedAndSeparatelyForEachServer()
    {
        var root = Path.Combine(Path.GetTempPath(), "Cord.Tests", Guid.NewGuid().ToString("N"));
        try
        {
            var store = new ProfileStore(root);
            var a = ServerEndpoint.Parse("https://a.example.com");
            var b = ServerEndpoint.Parse("https://b.example.com");
            var token = TestContext.Current.CancellationToken;
            Assert.Equal("", await store.GetPasswordAsync(a, token));
            await store.SavePasswordAsync(a, "очень тайно", token);
            Assert.Equal("очень тайно", await new ProfileStore(root).GetPasswordAsync(a, token));
            Assert.Equal("", await store.GetPasswordAsync(b, token));
            var stored = await File.ReadAllBytesAsync(Path.Combine(root, $"server-{a.StorageKey}.dat"), token);
            Assert.DoesNotContain("очень тайно", Encoding.UTF8.GetString(stored), StringComparison.Ordinal);
            // Settings travel between machines in plain text; the password must not be in them.
            await store.SaveAsync(new DesktopSettings(a.Origin.AbsoluteUri), token);
            Assert.DoesNotContain("очень тайно", await File.ReadAllTextAsync(Path.Combine(root, "settings.json"), token), StringComparison.Ordinal);
            await store.SavePasswordAsync(a, "", token);
            Assert.Equal("", await new ProfileStore(root).GetPasswordAsync(a, token));
        }
        finally
        {
            var allowed = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "Cord.Tests")) + Path.DirectorySeparatorChar;
            if (Path.GetFullPath(root).StartsWith(allowed, StringComparison.OrdinalIgnoreCase)) Directory.Delete(root, recursive: true);
        }
    }

    private sealed class StubHttp(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(response(request));
    }
}
