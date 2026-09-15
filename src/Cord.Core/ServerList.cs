namespace Cord.Core;

/// <summary>
/// The saved servers, kept in the order the user arranged them. Entries are keyed by origin,
/// which is the same boundary <see cref="ServerEndpoint"/> enforces for navigation and storage,
/// so two spellings of one server can never become two profiles.
/// </summary>
public static class ServerList
{
    public const int Max = 20;

    /// <summary>
    /// Drops unparseable and duplicate entries and guarantees the active server is present.
    /// Settings written by an older build carry no list at all, so one is derived from the
    /// single address it did store.
    /// </summary>
    public static IReadOnlyList<ServerEntry> Normalize(
        IReadOnlyList<ServerEntry>? servers,
        string active)
    {
        var result = new List<ServerEntry>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var entry in servers ?? [])
        {
            if (result.Count >= Max) break;
            if (Origin(entry.Url) is not { } origin || !seen.Add(origin)) continue;
            result.Add(new ServerEntry(origin, Trim(entry.Name), entry.AutoConnect));
        }

        // The server currently in use must stay reachable even if it was never saved, and
        // even if the saved list is already full.
        if (Origin(active) is { } current && !seen.Contains(current))
        {
            if (result.Count >= Max) result.RemoveAt(result.Count - 1);
            result.Insert(0, new ServerEntry(current));
        }
        return result;
    }

    /// <summary>Adds a server, or updates it if that origin is already saved.</summary>
    public static IReadOnlyList<ServerEntry> Add(
        IReadOnlyList<ServerEntry> servers,
        string url,
        string name = "",
        bool autoConnect = true)
    {
        if (Origin(url) is not { } origin) throw new ArgumentException("Неверный адрес сервера", nameof(url));
        var result = servers.ToList();
        // Renaming a saved server must not shuffle the list the user arranged.
        var existing = result.FindIndex(entry => entry.Url == origin);
        if (existing >= 0)
        {
            result[existing] = new ServerEntry(origin, Trim(name), autoConnect);
            return result;
        }
        result.Insert(0, new ServerEntry(origin, Trim(name), autoConnect));
        if (result.Count > Max) result.RemoveRange(Max, result.Count - Max);
        return result;
    }

    public static IReadOnlyList<ServerEntry> Remove(IReadOnlyList<ServerEntry> servers, string url) =>
        Origin(url) is { } origin
            ? servers.Where(entry => entry.Url != origin).ToList()
            : servers;

    private static string Trim(string name) =>
        name.Trim().Length > 60 ? name.Trim()[..60] : name.Trim();

    private static string? Origin(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return null;
        try { return ServerEndpoint.Parse(url).Origin.AbsoluteUri; }
        catch (ArgumentException) { return null; }
    }
}
