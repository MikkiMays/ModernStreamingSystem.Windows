using System.Text.Json.Serialization;

namespace Cord.Core;

public sealed record FavoriteRoom(string RoomId, string Title, string Code, long SavedAt, bool Closed, bool CanJoin)
{
    public string DisplayCode => Code.Length == 9 ? $"{Code[..3]}-{Code[3..6]}-{Code[6..]}" : Code;
}
public sealed record DesktopSettings(string ServerUrl = "https://meet.nikg.tech/", string Theme = "system", bool CompactSidebar = false);
public sealed record WebRoom(string RoomId, string Title, string Code);
public sealed record WebMessage(int Version, string Type, string? Page, string? Name, string? Theme, WebRoom? Room, MicrophoneHotkey? Hotkey = null);
public sealed record HostMessage(string Type, string? Page = null, string? RoomId = null, string? Theme = null, int Version = 1, string? Name = null, string? Detail = null);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(List<FavoriteRoom>))]
[JsonSerializable(typeof(DesktopSettings))]
[JsonSerializable(typeof(WebMessage))]
[JsonSerializable(typeof(HostMessage))]
public partial class CordJson : JsonSerializerContext;
