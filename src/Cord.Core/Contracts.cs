using System.Text.Json.Serialization;

namespace Cord.Core;

public sealed record FavoriteRoom(string RoomId, string Title, string Code, long SavedAt, bool Closed, bool CanJoin)
{
    public string DisplayCode => Code.Length == 9 ? $"{Code[..3]}-{Code[3..6]}-{Code[6..]}" : Code;
}
/// <summary>A saved server. <see cref="Url"/> is always a normalised origin.</summary>
public sealed record ServerEntry(string Url, string Name = "")
{
    /// <summary>What the user sees in the list: their own label, or the bare host.</summary>
    public string Label => string.IsNullOrWhiteSpace(Name)
        ? (Uri.TryCreate(Url, UriKind.Absolute, out var uri) ? uri.Authority : Url)
        : Name;
}

/// <summary><see cref="ServerUrl"/> is the server in use; <see cref="Servers"/> is the saved list.</summary>
public sealed record DesktopSettings(string ServerUrl = CordDefaults.ServerUrl, string Theme = "system", bool CompactSidebar = false, bool ShowPing = false, bool NotificationSounds = true, IReadOnlyList<ServerEntry>? Servers = null);
public sealed record WebRoom(string RoomId, string Title, string Code);
public sealed record WebMessage(int Version, string Type, string? Page, string? Name, string? Theme, WebRoom? Room, MicrophoneHotkey? Hotkey = null, bool? ShowPing = null, bool? NotificationSounds = null, bool? InCall = null);
public sealed record HostMessage(string Type, string? Page = null, string? RoomId = null, string? Theme = null, int Version = 1, string? Name = null, string? Detail = null, bool? ShowPing = null, bool? NotificationSounds = null);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(List<FavoriteRoom>))]
[JsonSerializable(typeof(List<ServerEntry>))]
[JsonSerializable(typeof(DesktopSettings))]
[JsonSerializable(typeof(WebMessage))]
[JsonSerializable(typeof(HostMessage))]
public partial class CordJson : JsonSerializerContext;
