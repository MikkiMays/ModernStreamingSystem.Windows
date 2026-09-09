using System.Text.Json;

namespace Cord.Core;

public static class BridgeProtocol
{
    public static WebMessage? Read(ServerEndpoint endpoint, string source, string json)
    {
        if (!endpoint.Owns(source) || json.Length > 8192) return null;
        try
        {
            var message = JsonSerializer.Deserialize(json, CordJson.Default.WebMessage);
            if (message is not { Version: 1 } || message.Type is not ("state" or "favorites.changed" or "close-ready" or "hotkey.configure")) return null;
            if (message.Type == "state" && message.Page is not ("home" or "prejoin" or "room")) return null;
            if (message.Name?.Length > 40 || message.Room?.Title?.Length > 80) return null;
            if (message.Room is { } room && (!Guid.TryParseExact(room.RoomId, "D", out _) || string.IsNullOrWhiteSpace(room.Title) || room.Code is null || room.Code.Length != 9 || room.Code.Any(c => !char.IsAsciiDigit(c)))) return null;
            if (message.Hotkey is not null && !message.Hotkey.IsValid) return null;
            return message;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>No host objects, file access or executable commands are exposed to the page.</summary>
    public static string Bootstrap(ServerEndpoint endpoint, string profile, string theme = "system")
    {
        if (profile.Length != 43 || profile.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
            throw new ArgumentException("Invalid profile capability", nameof(profile));
        var origin = JsonSerializer.Serialize(endpoint.Origin.GetLeftPart(UriPartial.Authority));
        var capability = JsonSerializer.Serialize(profile);
        var appearance = JsonSerializer.Serialize(theme is "light" or "dark" ? theme : "system");
        return $$"""
            (() => {
              if (window === window.top && location.origin === {{origin}}) {
                localStorage.setItem('cord:profile:v1', {{capability}});
                localStorage.setItem('cord:theme', {{appearance}});
                document.documentElement.dataset.desktop = 'true';
              }
            })();
            """;
    }
}
