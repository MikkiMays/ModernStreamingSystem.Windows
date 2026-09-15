using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Cord.Core;

/// <summary>
/// The door to a server, opened natively.
///
/// <para>The page inside WebView2 cannot do this for more than one server: the core refuses a
/// foreign <c>Origin</c>, so a browser can only ever ask the server that served it. The native
/// client has no such limit, which is why the list of servers, the password and the handshake
/// live here and the page is simply handed the result.</para>
///
/// <para>The password never reaches the page. It is kept by <c>ProfileStore</c> encrypted for
/// this Windows user, and what crosses the bridge is a short-lived token.</para>
/// </summary>
public sealed class ServerAccessClient(HttpClient http)
{
    public async Task<ServerDescription> DescribeAsync(ServerEndpoint endpoint, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync(new Uri(endpoint.Origin, "api/v1/capabilities"), cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        var described = await response.Content.ReadFromJsonAsync(CordJson.Default.ServerDescription, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("Сервер не назвал себя.");
        if (described.Name.Length > 60) throw new InvalidDataException("Сервер вернул слишком длинное имя.");
        return described;
    }

    public async Task<ServerSession> ConnectAsync(ServerEndpoint endpoint, string password, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(endpoint.Origin, "api/v1/session"))
        {
            Content = JsonContent.Create(new Dictionary<string, string> { ["password"] = password }, CordJson.Default.DictionaryStringString),
        };
        using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
            throw new ServerRefusedException("Сервер не принял пароль. Проверьте его у того, кто дал адрес.");
        if (response.StatusCode == HttpStatusCode.TooManyRequests)
            throw new ServerRefusedException("Слишком много попыток подряд. Подождите минуту и повторите.");
        if (response.StatusCode == HttpStatusCode.NotFound)
            throw new ServerRefusedException("По этому адресу отвечает не Cord: нужного API там нет.");
        response.EnsureSuccessStatusCode();
        var session = await response.Content.ReadFromJsonAsync(CordJson.Default.ServerSession, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("Сервер не выдал сессию.");
        if (string.IsNullOrEmpty(session.Token) || session.Token.Length > 200 || session.Token.Any(c => char.IsControl(c) || c == '"'))
            throw new InvalidDataException("Сервер вернул непригодную сессию.");
        return session;
    }

    /// <summary>
    /// Connects and says, in one sentence, what happened. Everything a person can act on —
    /// wrong password, wrong address, server still starting — has to be distinguishable here,
    /// because "не удалось" sends people to restart things that were never broken.
    /// </summary>
    public async Task<ConnectionResult> TryConnectAsync(string url, string password, CancellationToken cancellationToken)
    {
        ServerEndpoint endpoint;
        try { endpoint = ServerEndpoint.Parse(url); }
        catch (ArgumentException e) { return new(false, e.Message.Split(" (Parameter")[0]); }
        try
        {
            return new(true, "", await ConnectAsync(endpoint, password, cancellationToken).ConfigureAwait(false));
        }
        catch (ServerRefusedException e) { return new(false, e.Message); }
        catch (InvalidDataException e) { return new(false, e.Message); }
        catch (HttpRequestException e)
        {
            return new(false, e.StatusCode is { } status
                ? $"Сервер ответил ошибкой {(int)status}. Возможно, он ещё запускается."
                : e.InnerException is System.Security.Authentication.AuthenticationException
                    ? "Сертификат сервера не принят. Для самоподписанного сертификата откройте адрес в браузере и примите предупреждение."
                    : "Не удалось связаться с сервером. Проверьте адрес и соединение.");
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new(false, "Сервер не ответил вовремя. Проверьте адрес и соединение.");
        }
    }
}

/// <summary>The server answered, and the answer was no. Distinct from "could not be reached".</summary>
public sealed class ServerRefusedException(string message) : Exception(message);
