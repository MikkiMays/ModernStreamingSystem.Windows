using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cord.Core;

namespace Cord.Windows.Services;

/// <summary>Per-Windows-user storage. Room profile capabilities are protected by DPAPI, never logged.</summary>
public sealed class ProfileStore
{
    public string Root { get; }
    private readonly SemaphoreSlim _writes = new(1, 1);
    public ProfileStore(string? directory = null)
    {
        Root = Path.GetFullPath(directory ?? Environment.GetEnvironmentVariable("CORD_PROFILE_DIRECTORY") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cord"));
        Directory.CreateDirectory(Root);
    }

    public async Task<DesktopSettings> LoadAsync(CancellationToken token)
    {
        var path = Path.Combine(Root, "settings.json");
        if (!File.Exists(path)) return new();
        try
        {
            await using var stream = File.OpenRead(path);
            var settings = await JsonSerializer.DeserializeAsync(stream, CordJson.Default.DesktopSettings, token);
            if (settings is null) return new();
            ServerEndpoint.Parse(settings.ServerUrl);
            return settings with { Theme = settings.Theme is "light" or "dark" ? settings.Theme : "system" };
        }
        catch (Exception error) when (error is JsonException or ArgumentException) { return new(); }
    }

    public async Task SaveAsync(DesktopSettings settings, CancellationToken token)
    {
        ServerEndpoint.Parse(settings.ServerUrl);
        await _writes.WaitAsync(token);
        try
        {
            var path = Path.Combine(Root, "settings.json");
            var temporary = path + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(settings, CordJson.Default.DesktopSettings), token);
            File.Move(temporary, path, overwrite: true);
        }
        finally { _writes.Release(); }
    }

    public async Task<string> GetCapabilityAsync(ServerEndpoint endpoint, CancellationToken token)
    {
        await _writes.WaitAsync(token);
        try
        {
            var path = Path.Combine(Root, $"profile-{endpoint.StorageKey}.dat");
            var entropy = Encoding.UTF8.GetBytes(endpoint.Origin.AbsoluteUri);
            if (File.Exists(path))
            {
                var encrypted = await File.ReadAllBytesAsync(path, token);
                return Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, entropy, DataProtectionScope.CurrentUser));
            }
            var capability = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(capability), entropy, DataProtectionScope.CurrentUser);
            var temporary = path + ".tmp";
            await File.WriteAllBytesAsync(temporary, bytes, token);
            File.Move(temporary, path, overwrite: false);
            return capability;
        }
        finally { _writes.Release(); }
    }

    public string BrowserProfile(ServerEndpoint endpoint)
    {
        var path = Path.Combine(Root, "WebView2", endpoint.StorageKey);
        Directory.CreateDirectory(path);
        return path;
    }
}
