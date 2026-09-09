using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Cord.Core;
using Xunit;

public class ReleaseTests
{
    private static string Release(string tag = "v0.4.0", bool draft = false, bool prerelease = false, string? digest = null, long size = 4, string? url = null) => JsonSerializer.Serialize(new
    {
        tag_name = tag,
        draft,
        prerelease,
        assets = new[] { new { name = $"Cord-Setup-{tag.TrimStart('v')}-x64.exe", browser_download_url = url ?? $"https://github.com/{ReleaseClient.Repository}/releases/download/{tag}/Cord-Setup-{tag.TrimStart('v')}-x64.exe", size, digest = digest ?? "sha256:" + new string('a', 64) } }
    });
    [Fact]
    public void OnlyNewStableX64ReleaseIsOffered()
    {
        Assert.NotNull(ReleaseClient.Parse(Release(), new(0, 3, 0), "x64"));
        Assert.Null(ReleaseClient.Parse(Release(), new(0, 4, 0, 0), "x64"));
        Assert.Null(ReleaseClient.Parse(Release(), new(0, 3, 0), "arm64"));
        Assert.Null(ReleaseClient.Parse(Release(prerelease: true), new(0, 3, 0), "x64"));
        Assert.Null(ReleaseClient.Parse(Release(draft: true), new(0, 3, 0), "x64"));
        Assert.Null(ReleaseClient.Parse(Release("v0.5.0-beta"), new(0, 3, 0), "x64"));
    }
    [Fact]
    public void RejectsUntrustedAddressAndMissingDigest()
    {
        Assert.Throws<InvalidDataException>(() => ReleaseClient.Parse(Release(url: "https://example.org/setup.exe"), new(0, 3, 0), "x64"));
        Assert.Throws<InvalidDataException>(() => ReleaseClient.Parse(Release(digest: ""), new(0, 3, 0), "x64"));
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
        var release = ReleaseClient.Parse(Release(digest: "sha256:" + expected), new(0, 3, 0), "x64")!;
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
        using var http = new HttpClient(new Handler(_ => { var r = new HttpResponseMessage(HttpStatusCode.Redirect); r.Headers.Location = new Uri("http://github.com/setup"); return r; }));
        await Assert.ThrowsAsync<InvalidDataException>(() => new ReleaseClient(http).CheckAsync(new(0, 3, 0), "x64", default));
    }
}
