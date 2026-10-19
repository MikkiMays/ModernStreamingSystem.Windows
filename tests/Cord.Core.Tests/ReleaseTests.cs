using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cord.Core;
using Xunit;

/// <summary>
/// Описание выпуска на зеркале — <c>download.json</c>, тот же файл, что читает страница
/// <c>/download</c>: номер версии и файлы с размером и SHA-256. Адресов в нём нет, и клиент их не
/// берёт: установщик лежит рядом, в <c>v{версия}/</c> на том же хосте.
/// </summary>
public class ReleaseTests
{
    private static string Manifest(string version = "0.4.0", string? sha256 = null, long size = 4, string? installer = null, bool portable = true, bool withInstaller = true, string kind = "installer")
    {
        var files = new List<object>();
        if (portable) files.Add(new { name = "Cord-win-x64.zip", kind = "portable", size = 94192018L, sha256 = new string('b', 64) });
        if (withInstaller) files.Add(new { name = installer ?? $"Cord-Setup-{version}-x64.exe", kind, size, sha256 = sha256 ?? new string('a', 64) });
        return JsonSerializer.Serialize(new { version, tag = "v" + version, publishedAt = "2026-10-20T10:00:00Z", files });
    }

    [Fact]
    public void OnlyANewerX64InstallerIsOffered()
    {
        Assert.NotNull(ReleaseClient.Parse(Manifest(), new(0, 3, 0), "x64"));
        Assert.Null(ReleaseClient.Parse(Manifest(), new(0, 4, 0, 0), "x64"));
        Assert.Null(ReleaseClient.Parse(Manifest("0.3.9"), new(0, 4, 0), "x64"));
        Assert.Null(ReleaseClient.Parse(Manifest(), new(0, 3, 0), "arm64"));
    }

    /// <summary>Установщик берётся с того же зеркала, рядом с описанием; переносимый архив не ставится.</summary>
    [Fact]
    public void TheInstallerComesFromTheMirrorFolderOfItsVersion()
    {
        var release = ReleaseClient.Parse(Manifest(sha256: new string('A', 64), size: 324239526), new(0, 3, 0), "x64")!;
        Assert.Equal(new Version(0, 4, 0), release.Version);
        Assert.Equal(new Uri("https://meet.nikg.tech/downloads/windows/v0.4.0/Cord-Setup-0.4.0-x64.exe"), release.Package);
        Assert.Equal(new string('a', 64), release.Sha256);
        Assert.Equal(324239526, release.Size);
    }

    /// <summary>Номер версии — только X.Y.Z: всё остальное — не наш выпуск, а не «обновлений нет».</summary>
    [Theory]
    [InlineData("0.5.0-beta")]
    [InlineData("v0.5.0")]
    [InlineData("0.5")]
    [InlineData("00.5.0")]
    [InlineData("")]
    public void AVersionThatIsNotXyzIsRejected(string version) =>
        Assert.Throws<InvalidDataException>(() => ReleaseClient.Parse(Manifest(version), new(0, 3, 0), "x64"));

    /// <summary>Без проверяемых размера и SHA-256, с чужим именем или вовсе без установщика выпуск не ставится.</summary>
    [Theory]
    [InlineData("sha-missing")]
    [InlineData("sha-short")]
    [InlineData("sha-prefixed")]
    [InlineData("size-zero")]
    [InlineData("size-huge")]
    [InlineData("name-traversal")]
    [InlineData("name-other-version")]
    [InlineData("no-installer")]
    public void AnInstallerThatCannotBeVerifiedIsRejected(string defect)
    {
        var manifest = defect switch
        {
            "sha-missing" => Manifest(sha256: ""),
            "sha-short" => Manifest(sha256: new string('a', 63)),
            "sha-prefixed" => Manifest(sha256: "sha256:" + new string('a', 64)),
            "size-zero" => Manifest(size: 0),
            "size-huge" => Manifest(size: 1024L * 1024 * 1024 + 1),
            "name-traversal" => Manifest(installer: "../../Cord-Setup-0.4.0-x64.exe"),
            "name-other-version" => Manifest(installer: "Cord-Setup-0.3.0-x64.exe"),
            _ => Manifest(withInstaller: false),
        };
        Assert.Throws<InvalidDataException>(() => ReleaseClient.Parse(manifest, new(0, 3, 0), "x64"));
    }

    /// <summary>Переносимый архив под видом установщика не проходит: ставится только запись installer.</summary>
    [Fact]
    public void OnlyTheInstallerEntryIsEverInstalled() =>
        Assert.Throws<InvalidDataException>(() => ReleaseClient.Parse(Manifest(portable: false, kind: "portable"), new(0, 3, 0), "x64"));

    /// <summary>
    /// Обновления идут только с сервера Cord, по описанию без ссылок на GitHub. Учётных данных в
    /// запросе нет.
    /// </summary>
    [Fact]
    public async Task OnlyTheCordManifestIsAskedWithoutCredentials()
    {
        var requested = new List<Uri>();
        using var http = new HttpClient(new Handler(request =>
        {
            requested.Add(request.RequestUri!);
            Assert.Null(request.Headers.Authorization);
            return new(HttpStatusCode.OK) { Content = new StringContent(Manifest()) };
        }));
        var release = await new ReleaseClient(http).CheckAsync(new(0, 3, 0), "x64", default);
        Assert.Equal([new Uri("https://meet.nikg.tech/downloads/windows/download.json")], requested);
        Assert.Equal(CordDefaults.UpdateMirror, ReleaseClient.Manifest);
        Assert.Equal(new Uri("https://meet.nikg.tech/downloads/windows/v0.4.0/Cord-Setup-0.4.0-x64.exe"), release!.Package);
    }

    /// <summary>Лишние поля описания — даже со ссылкой — ничего не решают: адрес пакета строит клиент.</summary>
    [Fact]
    public void AnAddressInsideTheManifestIsIgnored()
    {
        var manifest = Manifest().Replace("\"files\"", "\"url\":\"https://github.com/someone/else/setup.exe\",\"files\"", StringComparison.Ordinal);
        Assert.Equal("meet.nikg.tech", ReleaseClient.Parse(manifest, new(0, 3, 0), "x64")!.Package.Host);
    }

    /// <summary>Пустое зеркало — это «обновлений нет», а не ошибка, которую видит человек.</summary>
    [Fact]
    public async Task AnEmptyMirrorMeansNoUpdate()
    {
        using var http = new HttpClient(new Handler(_ => new(HttpStatusCode.NotFound)));
        Assert.Null(await new ReleaseClient(http).CheckAsync(new(0, 3, 0), "x64", default));
    }

    /// <summary>Подделанное описание останавливает обновление, другого источника клиент не ищет.</summary>
    [Fact]
    public async Task ARejectedReleaseStopsTheUpdate()
    {
        var requested = new List<Uri>();
        using var http = new HttpClient(new Handler(request =>
        {
            requested.Add(request.RequestUri!);
            return new(HttpStatusCode.OK) { Content = new StringContent(Manifest(installer: "../setup.exe")) };
        }));
        await Assert.ThrowsAsync<InvalidDataException>(() => new ReleaseClient(http).CheckAsync(new(0, 3, 0), "x64", default));
        Assert.Equal([ReleaseClient.Manifest], requested);
    }

    /// <summary>Даже перенаправление с зеркала не уводит загрузку на GitHub.</summary>
    [Fact]
    public async Task GitHubIsNeverContacted()
    {
        using var http = new HttpClient(new Handler(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.Redirect);
            response.Headers.Location = new Uri("https://github.com/cord/releases/latest");
            return response;
        }));
        await Assert.ThrowsAsync<InvalidDataException>(() => new ReleaseClient(http).CheckAsync(new(0, 3, 0), "x64", default));
    }

    /// <summary>Перенаправление внутри <c>/downloads/windows/</c> того же хоста — можно, за его пределы — нет.</summary>
    [Theory]
    [InlineData("https://meet.nikg.tech/downloads/windows/v0.4.0/download.json", true)]
    [InlineData("https://meet.nikg.tech/uploads/download.json", false)]
    [InlineData("https://cdn.nikg.tech/downloads/windows/download.json", false)]
    public async Task ARedirectStaysInsideTheMirrorFolder(string location, bool followed)
    {
        using var http = new HttpClient(new Handler(request =>
        {
            if (request.RequestUri == ReleaseClient.Manifest)
            {
                var response = new HttpResponseMessage(HttpStatusCode.Redirect);
                response.Headers.Location = new Uri(location);
                return response;
            }
            return new(HttpStatusCode.OK) { Content = new StringContent(Manifest()) };
        }));
        var check = new ReleaseClient(http).CheckAsync(new(0, 3, 0), "x64", default);
        if (followed) Assert.NotNull(await check);
        else await Assert.ThrowsAsync<InvalidDataException>(() => check);
    }

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(respond(request));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task OnlyVerifiedPackageIsMadeAvailable(bool intact)
    {
        var bytes = Encoding.UTF8.GetBytes("cord");
        var expected = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var release = ReleaseClient.Parse(Manifest(sha256: expected), new(0, 3, 0), "x64")!;
        using var http = new HttpClient(new Handler(_ => new(HttpStatusCode.OK) { Content = new ByteArrayContent(intact ? bytes : [1, 2]) }));
        var folder = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        try
        {
            var client = new ReleaseClient(http);
            if (intact) Assert.Equal(bytes, await File.ReadAllBytesAsync(await client.DownloadAsync(release, folder, null, default)));
            else { await Assert.ThrowsAsync<InvalidDataException>(() => client.DownloadAsync(release, folder, null, default)); Assert.Empty(Directory.GetFiles(folder)); }
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [Fact]
    public async Task RejectsInsecureRedirect()
    {
        using var http = new HttpClient(new Handler(_ => { var r = new HttpResponseMessage(HttpStatusCode.Redirect); r.Headers.Location = new Uri("http://meet.nikg.tech/downloads/windows/download.json"); return r; }));
        await Assert.ThrowsAsync<InvalidDataException>(() => new ReleaseClient(http).CheckAsync(new(0, 3, 0), "x64", default));
    }
}
