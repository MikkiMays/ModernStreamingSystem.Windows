namespace Cord.Core;

/// <summary>
/// Everything that ties a build of Cord to one operator. A fork changes these two values
/// and nothing else: the rest of the client is server-agnostic.
/// </summary>
public static class CordDefaults
{
    /// <summary>The server a fresh installation starts on. Users may add or replace it.</summary>
    public const string ServerUrl = "https://meet.nikg.tech/";

    /// <summary>
    /// Where the client looks for its own updates. This deliberately does NOT follow the
    /// selected meeting server: joining someone's room must never let that server decide
    /// which executable this machine installs.
    /// </summary>
    public static readonly Uri UpdateMirror =
        new("https://meet.nikg.tech/downloads/windows/latest.json");
}
