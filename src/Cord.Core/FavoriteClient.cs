using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace Cord.Core;

public sealed class FavoriteClient(HttpClient http)
{
    public async Task<IReadOnlyList<FavoriteRoom>> ListAsync(ServerEndpoint endpoint, string profile, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(endpoint.Origin, "api/v1/favorites"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", profile);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        var favorites = await response.Content.ReadFromJsonAsync(CordJson.Default.ListFavoriteRoom, cancellationToken).ConfigureAwait(false) ?? [];
        // Fail closed on malformed server data. Favorites never contain media or host credentials.
        if (favorites.Count > 5 || favorites.Any(f => f is null || !Guid.TryParseExact(f.RoomId, "D", out _) || string.IsNullOrWhiteSpace(f.Title) || f.Title.Length > 80 || f.Code is null || f.Code.Length != 9 || f.Code.Any(c => !char.IsAsciiDigit(c))))
            throw new InvalidDataException("Сервер вернул некорректный список комнат.");
        return favorites;
    }
}
