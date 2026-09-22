using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace Cord.Core;

public sealed class FavoriteClient(HttpClient http)
{
    /// <param name="session">
    /// The server session, when the server is closed by a password. The profile capability says
    /// whose favourites these are; the session says this client is allowed on the server at all.
    /// </param>
    public async Task<IReadOnlyList<FavoriteRoom>> ListAsync(ServerEndpoint endpoint, string profile, CancellationToken cancellationToken, string? session = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(endpoint.Origin, "api/v1/favorites"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", profile);
        if (!string.IsNullOrEmpty(session)) request.Headers.Add("X-Cord-Session", session);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        var favorites = await response.Content.ReadFromJsonAsync(CordJson.Default.ListFavoriteRoom, cancellationToken).ConfigureAwait(false) ?? [];
        // Fail closed on malformed server data. Favorites never contain media or host credentials.
        if (favorites.Any(f => f is null || !Guid.TryParseExact(f.RoomId, "D", out _) || string.IsNullOrWhiteSpace(f.Title) || f.Title.Length > 80 || f.Code is null || f.Code.Length != 9 || f.Code.Any(c => !char.IsAsciiDigit(c))))
            throw new InvalidDataException("Сервер вернул некорректный список комнат.");
        return favorites;
    }

    public async Task ReorderAsync(ServerEndpoint endpoint, string profile, IReadOnlyList<string> roomIds, CancellationToken cancellationToken, string? session = null)
    {
        if (roomIds.Any(id => !Guid.TryParseExact(id, "D", out _)) || roomIds.Distinct(StringComparer.Ordinal).Count() != roomIds.Count)
            throw new ArgumentException("Список комнат содержит некорректные или повторяющиеся комнаты.", nameof(roomIds));
        using var request = new HttpRequestMessage(HttpMethod.Put, new Uri(endpoint.Origin, "api/v1/favorites/order"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", profile);
        if (!string.IsNullOrEmpty(session)) request.Headers.Add("X-Cord-Session", session);
        request.Content = JsonContent.Create(new FavoriteOrder(roomIds.ToArray()), CordJson.Default.FavoriteOrder);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
    }

}
