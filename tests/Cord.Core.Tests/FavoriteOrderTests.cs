using System.Net;
using System.Text;
using System.Text.Json;
using Cord.Core;
using Xunit;

namespace Cord.Tests;

public sealed class FavoriteOrderTests
{
    [Fact]
    public async Task ListsMoreThanFiveRoomsInServerOrder()
    {
        var rooms = Enumerable.Range(0, 8).Select(i => new FavoriteRoom(Guid.NewGuid().ToString(), $"Комната {i}", "123456789", i, false, true)).ToList();
        using var handler = new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(rooms, CordJson.Default.ListFavoriteRoom), Encoding.UTF8, "application/json")
        }));
        using var http = new HttpClient(handler);
        var actual = await new FavoriteClient(http).ListAsync(ServerEndpoint.Parse("https://meet.example.com"), new string('A', 43), TestContext.Current.CancellationToken);
        Assert.Equal(rooms.Select(r => r.RoomId), actual.Select(r => r.RoomId));
    }

    [Fact]
    public async Task SavesOrderWithProfileAndServerSessionInHeaders()
    {
        var ids = new[] { Guid.NewGuid().ToString(), Guid.NewGuid().ToString() };
        using var handler = new Handler(async request =>
        {
            Assert.Equal(HttpMethod.Put, request.Method);
            Assert.Equal("/api/v1/favorites/order", request.RequestUri!.AbsolutePath);
            Assert.Empty(request.RequestUri.Query);
            Assert.Equal(new string('A', 43), request.Headers.Authorization!.Parameter);
            Assert.Equal("session", request.Headers.GetValues("X-Cord-Session").Single());
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            Assert.Equal(ids, body.RootElement.GetProperty("roomIds").EnumerateArray().Select(v => v.GetString()));
            return new HttpResponseMessage(HttpStatusCode.NoContent);
        });
        using var http = new HttpClient(handler);
        await new FavoriteClient(http).ReorderAsync(ServerEndpoint.Parse("https://meet.example.com"), new string('A', 43), ids, TestContext.Current.CancellationToken, "session");
    }

    [Fact]
    public async Task ConflictRemainsVisibleToCaller()
    {
        using var handler = new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Conflict)));
        using var http = new HttpClient(handler);
        var error = await Assert.ThrowsAsync<HttpRequestException>(() => new FavoriteClient(http).ReorderAsync(
            ServerEndpoint.Parse("https://meet.example.com"), new string('A', 43), [], TestContext.Current.CancellationToken));
        Assert.Equal(HttpStatusCode.Conflict, error.StatusCode);
    }

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => respond(request);
    }
}
