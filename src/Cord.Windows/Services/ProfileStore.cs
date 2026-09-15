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
        if (!File.Exists(path)) return Normalized(new());
        try
        {
            await using var stream = File.OpenRead(path);
            var settings = await JsonSerializer.DeserializeAsync(stream, CordJson.Default.DesktopSettings, token);
            if (settings is null) return Normalized(new());
            ServerEndpoint.Parse(settings.ServerUrl);
            return Normalized(settings with { Theme = settings.Theme is "light" or "dark" ? settings.Theme : "system" });
        }
        catch (Exception error) when (error is JsonException or ArgumentException) { return Normalized(new()); }
    }

    /// <summary>Settings written before the server list existed carry only a single address.</summary>
    private static DesktopSettings Normalized(DesktopSettings settings) =>
        settings with { Servers = ServerList.Normalize(settings.Servers, settings.ServerUrl) };

    public async Task SaveAsync(DesktopSettings settings, CancellationToken token)
    {
        ServerEndpoint.Parse(settings.ServerUrl);
        settings = Normalized(settings);
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

    /// <summary>
    /// The server password, if this device chose to remember one. Protected the same way as the
    /// profile capability and for the same reason: settings.json is plain text a person may copy
    /// between machines, and a password does not belong in it.
    /// </summary>
    public async Task<string> GetPasswordAsync(ServerEndpoint endpoint, CancellationToken token)
    {
        var path = PasswordPath(endpoint);
        if (!File.Exists(path)) return "";
        await _writes.WaitAsync(token);
        try
        {
            var encrypted = await File.ReadAllBytesAsync(path, token);
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, Entropy(endpoint), DataProtectionScope.CurrentUser));
        }
        catch (Exception error) when (error is CryptographicException or IOException)
        {
            // A password that cannot be read is a password we do not have; asking again is the
            // correct behaviour, and refusing to start would not be.
            return "";
        }
        finally { _writes.Release(); }
    }

    public async Task SavePasswordAsync(ServerEndpoint endpoint, string password, CancellationToken token)
    {
        var path = PasswordPath(endpoint);
        await _writes.WaitAsync(token);
        try
        {
            if (string.IsNullOrEmpty(password))
            {
                File.Delete(path);
                return;
            }
            var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(password), Entropy(endpoint), DataProtectionScope.CurrentUser);
            var temporary = path + ".tmp";
            await File.WriteAllBytesAsync(temporary, bytes, token);
            File.Move(temporary, path, overwrite: true);
        }
        catch (IOException) { /* Remembering a password is a convenience, never a failure. */ }
        finally { _writes.Release(); }
    }

    private string PasswordPath(ServerEndpoint endpoint) => Path.Combine(Root, $"server-{endpoint.StorageKey}.dat");
    private static byte[] Entropy(ServerEndpoint endpoint) => Encoding.UTF8.GetBytes("server-password:" + endpoint.Origin.AbsoluteUri);

    public string BrowserProfile(ServerEndpoint endpoint)
    {
        var path = Path.Combine(Root, "WebView2", endpoint.StorageKey);
        Directory.CreateDirectory(path);
        return path;
    }
}
