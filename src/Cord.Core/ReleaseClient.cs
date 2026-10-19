using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Cord.Core;

public sealed record CordRelease(Version Version, Uri Package, string Sha256, long Size);

/// <summary>
/// Обновление спрашивается только у зеркала Cord, по описанию выпуска <c>download.json</c> — тому же
/// файлу, что читает страница <c>/download</c>. В нём номер версии и файлы с размером и SHA-256, и
/// ничего больше: ни адресов, ни репозитория. Адрес установщика клиент строит сам — рядом с
/// описанием, в <c>v{версия}/</c> на том же хосте, — поэтому описание не может увести загрузку
/// куда-то ещё. Подделка останавливает обновление, а не ищет другой источник.
/// </summary>
public sealed partial class ReleaseClient(HttpClient http)
{
    public static readonly Uri Manifest = CordDefaults.UpdateMirror;
    /// <summary>Больше установщик Cord не бывает; всё крупнее — не он.</summary>
    private const long SizeLimit = 1024L * 1024 * 1024;
    [GeneratedRegex(@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")]
    private static partial Regex StableVersion();
    [GeneratedRegex(@"^[a-fA-F0-9]{64}$")]
    private static partial Regex Digest();

    /// <summary>
    /// Выпуск новее <paramref name="current"/> — или null, если ставить нечего. Описание, которому
    /// нельзя верить (номер не X.Y.Z, нет установщика, у него чужое имя, нет SHA-256 или размер не
    /// тот), — это <see cref="InvalidDataException"/>, а не «обновлений нет».
    /// </summary>
    public static CordRelease? Parse(string json, Version current, string architecture)
    {
        if (architecture != "x64") return null;
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var number = root.GetProperty("version").GetString() ?? "";
        if (!StableVersion().IsMatch(number) || !Version.TryParse(number, out var version))
            throw new InvalidDataException("Неверный номер версии в описании выпуска.");
        if (!ForcedUpdate.IsUpgrade(version, current)) return null;
        var name = $"Cord-Setup-{version}-x64.exe";
        foreach (var file in root.GetProperty("files").EnumerateArray())
        {
            if (file.GetProperty("kind").GetString() != "installer") continue;
            // Имя идёт в адрес загрузки, поэтому оно обязано быть ровно тем, что публикует выпуск.
            if (file.GetProperty("name").GetString() != name) throw new InvalidDataException("Неверное имя установщика.");
            var hash = file.GetProperty("sha256").GetString() ?? "";
            if (!Digest().IsMatch(hash)) throw new InvalidDataException("Выпуск не содержит проверяемый SHA-256 установщика.");
            var size = file.GetProperty("size").GetInt64();
            if (size <= 0 || size > SizeLimit) throw new InvalidDataException("Неверный размер пакета.");
            return new(version, new Uri(Manifest, $"v{version}/{name}"), hash.ToLowerInvariant(), size);
        }
        throw new InvalidDataException("В выпуске нет установщика.");
    }

    public async Task<CordRelease?> CheckAsync(Version current, string architecture, CancellationToken token)
    {
        using var response = await GetAsync(Manifest, token);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        return Parse(await response.Content.ReadAsStringAsync(token), current, architecture);
    }

    // Redirects are followed explicitly: an HTTPS release must never redirect to HTTP or an unrelated origin.
    private async Task<HttpResponseMessage> GetAsync(Uri uri, CancellationToken token)
    {
        for (var redirects = 0; redirects < 6; redirects++)
        {
            var mirror = uri.IdnHost == Manifest.IdnHost && uri.AbsolutePath.StartsWith("/downloads/windows/", StringComparison.Ordinal) && uri.Query.Length == 0;
            if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || !mirror)
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
