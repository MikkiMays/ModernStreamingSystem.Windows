using System.Security.Cryptography;
using System.Text;

namespace Cord.Core;

/// <summary>The configured origin is the security boundary for navigation, API calls and the bridge.</summary>
public sealed record ServerEndpoint
{
    public Uri Origin { get; }
    public string StorageKey => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Origin.AbsoluteUri)))[..24];
    private ServerEndpoint(Uri origin) => Origin = origin;

    public static ServerEndpoint Parse(string value)
    {
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
            || !string.IsNullOrEmpty(uri.UserInfo) || uri.AbsolutePath != "/"
            || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)
            || (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback)))
            throw new ArgumentException("Укажите HTTPS-адрес сервера без пути. HTTP доступен только для localhost.", nameof(value));
        return new ServerEndpoint(new Uri(uri.GetLeftPart(UriPartial.Authority) + "/"));
    }

    public bool Owns(string? value) => Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && string.IsNullOrEmpty(uri.UserInfo) && uri.Scheme == Origin.Scheme
        && uri.IdnHost == Origin.IdnHost && uri.Port == Origin.Port;

    public static bool IsExternalWebLink(Uri uri) => uri.Scheme is "https" or "http" && string.IsNullOrEmpty(uri.UserInfo);
}
