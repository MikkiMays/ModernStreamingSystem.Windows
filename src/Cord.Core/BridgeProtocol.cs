using System.Text.Json;

namespace Cord.Core;

public static class BridgeProtocol
{
    /// <summary>A picture of a face at 64 pixels, as the page encodes it, and nothing else.</summary>
    public const int AvatarLimit = 4096;

    public static WebMessage? Read(ServerEndpoint endpoint, string source, string json)
    {
        // The state message carries the profile picture, which is a small data URI: one
        // message is now a few kilobytes rather than a few hundred bytes.
        if (!endpoint.Owns(source) || json.Length > 16384) return null;
        try
        {
            var message = JsonSerializer.Deserialize(json, CordJson.Default.WebMessage);
            if (message is not { Version: 1 } || message.Type is not ("state" or "favorites.changed" or "close-ready" or "hotkey.configure" or "preferences.changed" or "call-state" or "servers.open" or "session.expired" or "server.autoconnect" or "update.version" or "update.check" or "update.apply")) return null;
            if (message.Type == "state" && message.Page is not ("home" or "prejoin" or "room")) return null;
            if (message.Name?.Length > 40 || message.Room?.Title?.Length > 80) return null;
            // No picture is an empty string, not an absent field; only a non-empty one is checked.
            if (message.Avatar is { Length: > 0 } avatar && (avatar.Length > AvatarLimit || !avatar.StartsWith("data:image/", StringComparison.Ordinal))) return null;
            if (message.Room is { } room && (!Guid.TryParseExact(room.RoomId, "D", out _) || string.IsNullOrWhiteSpace(room.Title) || room.Code is null || room.Code.Length != 9 || room.Code.Any(c => !char.IsAsciiDigit(c)))) return null;
            if (message.Hotkey is not null && !message.Hotkey.IsValid) return null;
            return message;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>No host objects, file access or executable commands are exposed to the page.</summary>
    public static string Bootstrap(
        ServerEndpoint endpoint,
        string profile,
        string theme = "system",
        bool showPing = false,
        bool notificationSounds = true,
        ServerSession? session = null,
        bool autoConnect = true)
    {
        if (profile.Length != 43 || profile.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
            throw new ArgumentException("Invalid profile capability", nameof(profile));
        var origin = JsonSerializer.Serialize(endpoint.Origin.GetLeftPart(UriPartial.Authority));
        var capability = JsonSerializer.Serialize(profile);
        var appearance = JsonSerializer.Serialize(theme is "light" or "dark" ? theme : "system");
        var ping = showPing ? "true" : "false";
        var sounds = notificationSounds ? "true" : "false";
        // The application already shook hands with the server, so the page must not show its own
        // connect screen. It is handed the session — never the password, which stays encrypted
        // on this machine — in the same store the page would have put it in itself.
        // The mark next to it says this connection was just made, so the page can sound the
        // connect cue it did not perform itself. It is consumed once and removed.
        var connection = session is null || session.Token.Length == 0
            ? "sessionStorage.removeItem('cord:session:v1'); sessionStorage.removeItem('cord:session:fresh');"
            : $"sessionStorage.setItem('cord:session:v1', {JsonSerializer.Serialize(JsonSerializer.Serialize(session, CordJson.Default.ServerSession))}); sessionStorage.setItem('cord:session:fresh', '1');";
        // The two stores have to agree at startup. These preferences used to reach the page
        // only when the settings dialog was reopened, so a fresh launch showed whatever the
        // page had saved for itself and the desktop checkbox looked like it did nothing.
        // Merge rather than replace: the same entry holds the name, devices and quality.
        // Automatic connection is the application's setting — it decides whether the server is
        // opened without asking. The page shows the same switch, so it is handed the value it
        // would otherwise guess, and says so back through `server.autoconnect`.
        var automatic = autoConnect ? "true" : "false";
        return $$"""
            (() => {
              if (window === window.top && location.origin === {{origin}}) {
                localStorage.setItem('cord:profile:v1', {{capability}});
                localStorage.setItem('cord:theme', {{appearance}});
                let saved = {};
                try { saved = JSON.parse(localStorage.getItem('cord:preferences:v1')) || {}; } catch {}
                if (typeof saved !== 'object' || saved === null) saved = {};
                saved.showPing = {{ping}};
                saved.notificationSounds = {{sounds}};
                localStorage.setItem('cord:preferences:v1', JSON.stringify(saved));
                let server = {};
                try { server = JSON.parse(localStorage.getItem('cord:servers:v1')) || {}; } catch {}
                if (Array.isArray(server)) server = server[0] || {};
                if (typeof server !== 'object' || server === null) server = {};
                server.url = location.origin + '/';
                server.autoConnect = {{automatic}};
                localStorage.setItem('cord:servers:v1', JSON.stringify(server));
                {{connection}}
                document.documentElement.dataset.desktop = 'true';
              }
            })();
            """;
    }
}
