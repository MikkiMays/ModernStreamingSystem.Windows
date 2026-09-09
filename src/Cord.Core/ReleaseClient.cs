using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cord.Core;

public sealed record CordRelease(Version Version, Uri Package, string Sha256, long Size);

/// <summary>Only stable x64 installers from Cord's fixed upstream release repository are accepted.</summary>
public sealed partial class ReleaseClient(HttpClient http)
{
    public const string Repository = "MikkiMays/ModernStreamingSystem.Windows";
    public static readonly Uri Latest = new($"https://api.github.com/repos/{Repository}/releases/latest");
    [GeneratedRegex(@"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")]
    private static partial Regex StableVersion();
    [GeneratedRegex(@"^[a-fA-F0-9]{64}$")]
    private static partial Regex Digest();

    public static CordRelease? Parse(string json, Version current, string architecture)
    {
        if (architecture != "x64") return null;
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.GetProperty("draft").GetBoolean() || root.GetProperty("prerelease").GetBoolean()) return null;
        var tag = root.GetProperty("tag_name").GetString() ?? "";
        if (!StableVersion().IsMatch(tag) || !Version.TryParse(tag.TrimStart('v'), out var version) || version <= new Version(current.Major, current.Minor, Math.Max(0, current.Build))) return null;
        var name = $"Cord-Setup-{version}-x64.exe";
        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            if (asset.GetProperty("name").GetString() != name) continue;
            var url = asset.GetProperty("browser_download_url").GetString();
            var expected = $"https://github.com/{Repository}/releases/download/{tag}/{name}";
            if (url != expected) throw new InvalidDataException("Неверный адрес пакета обновления.");
            var hash = asset.TryGetProperty("digest", out var digest) ? digest.GetString() ?? "" : "";
            if (!hash.StartsWith("sha256:", StringComparison.Ordinal) || !Digest().IsMatch(hash[7..]))
                throw new InvalidDataException("Релиз не содержит проверяемый SHA-256 установщика.");
            var size = asset.GetProperty("size").GetInt64();
            if (size <= 0 || size > 1024L * 1024 * 1024) throw new InvalidDataException("Неверный размер пакета.");
            return new(version, new Uri(url), hash[7..].ToLowerInvariant(), size);
        }
        return null;
    }

    public async Task<CordRelease?> CheckAsync(Version current, string architecture, CancellationToken token)
    {
        using var response = await GetAsync(Latest, token);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return Parse(await response.Content.ReadAsStringAsync(token), current, architecture);
    }

    // Redirects are followed explicitly: an HTTPS release must never redirect to HTTP or an unrelated origin.
    private async Task<HttpResponseMessage> GetAsync(Uri uri, CancellationToken token)
    {
        for (var redirects = 0; redirects < 6; redirects++)
        {
            if (uri.Scheme != "https" || !new[] { "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com" }.Contains(uri.IdnHost))
                throw new InvalidDataException("Недопустимый адрес загрузки.");
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.UserAgent.ParseAdd("Cord-Windows-Updater/1.0");
            var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
            if ((int)response.StatusCode is not (301 or 302 or 303 or 307 or 308)) return response;
            var next = response.Headers.Location;
            response.Dispose();
            if (next is null) throw new InvalidDataException("Пустое перенаправление.");
            uri = new Uri(uri, next);
        }
        throw new InvalidDataException("Слишком много перенаправлений.");
    }

    public async Task<string> DownloadAsync(CordRelease release, string directory, IProgress<double>? progress, CancellationToken token)
    {
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"Cord-Setup-{release.Version}-x64.exe");
        var partial = path + ".partial";
        try
        {
            using var response = await GetAsync(release.Package, token);
            response.EnsureSuccessStatusCode();
            await using var input = await response.Content.ReadAsStreamAsync(token);
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long total = 0;
            var buffer = new byte[128 * 1024];
            await using (var output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, buffer.Length, true))
            {
                int read;
                while ((read = await input.ReadAsync(buffer, token)) > 0)
                {
                    total += read;
                    if (total > release.Size) throw new InvalidDataException("Размер пакета изменился.");
                    hash.AppendData(buffer, 0, read);
                    await output.WriteAsync(buffer.AsMemory(0, read), token);
                    progress?.Report((double)total / release.Size);
                }
                await output.FlushAsync(token);
            }
            if (total != release.Size || !Convert.ToHexStringLower(hash.GetHashAndReset()).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Пакет повреждён: SHA-256 не совпадает. Повторите загрузку.");
            File.Move(partial, path, true);
            return path;
        }
        finally { if (File.Exists(partial)) File.Delete(partial); }
    }
}
