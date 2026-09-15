using System.Text.Json.Serialization;

namespace Cord.Core;

public sealed record FavoriteRoom(string RoomId, string Title, string Code, long SavedAt, bool Closed, bool CanJoin)
{
    public string DisplayCode => Code.Length == 9 ? $"{Code[..3]}-{Code[3..6]}-{Code[6..]}" : Code;
}
/// <summary>
/// A saved server. <see cref="Url"/> is always a normalised origin. The password is not here:
/// it lives beside the profile capability, encrypted for this Windows user, because settings
/// travel in plain JSON.
/// </summary>
public sealed record ServerEntry(string Url, string Name = "", bool AutoConnect = true)
{
    /// <summary>What the user sees in the list: their own label, or the bare host.</summary>
    public string Label => string.IsNullOrWhiteSpace(Name)
        ? (Uri.TryCreate(Url, UriKind.Absolute, out var uri) ? uri.Authority : Url)
        : Name;
}

/// <summary><see cref="ServerUrl"/> is the server in use; <see cref="Servers"/> is the saved list.</summary>
public sealed record DesktopSettings(string ServerUrl = CordDefaults.ServerUrl, string Theme = "system", bool CompactSidebar = false, bool ShowPing = false, bool NotificationSounds = true, IReadOnlyList<ServerEntry>? Servers = null);
public sealed record WebRoom(string RoomId, string Title, string Code);
public sealed record WebMessage(int Version, string Type, string? Page, string? Name, string? Theme, WebRoom? Room, MicrophoneHotkey? Hotkey = null, bool? ShowPing = null, bool? NotificationSounds = null, bool? InCall = null, string? Avatar = null, bool? AutoConnect = null);
public sealed record HostMessage(string Type, string? Page = null, string? RoomId = null, string? Theme = null, int Version = 1, string? Name = null, string? Detail = null, bool? ShowPing = null, bool? NotificationSounds = null, string? Token = null, long? ExpiresAt = null, string? ServerName = null, string? Tab = null);

/// <summary>What a server says about itself before anyone has authenticated.</summary>
public sealed record ServerDescription(string Name, bool PasswordRequired, int MaxParticipants);
/// <summary>The result of the handshake: proof that this client may use the server.</summary>
public sealed record ServerSession(string Token, long ExpiresAt, string Name, bool PasswordRequired);
/// <summary>An attempt, reduced to what a person needs to see: it worked, or why it did not.</summary>
public sealed record ConnectionResult(bool Ok, string Detail, ServerSession? Session = null);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(List<FavoriteRoom>))]
[JsonSerializable(typeof(List<ServerEntry>))]
[JsonSerializable(typeof(DesktopSettings))]
[JsonSerializable(typeof(WebMessage))]
[JsonSerializable(typeof(HostMessage))]
[JsonSerializable(typeof(ServerDescription))]
[JsonSerializable(typeof(ServerSession))]
[JsonSerializable(typeof(Dictionary<string, string>))]
public partial class CordJson : JsonSerializerContext;
