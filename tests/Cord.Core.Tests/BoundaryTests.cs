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

    private sealed class StubHttp(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(response(request));
    }
}
