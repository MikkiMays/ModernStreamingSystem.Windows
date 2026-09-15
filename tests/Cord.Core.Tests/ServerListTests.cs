using Cord.Core;
using Xunit;

namespace Cord.Tests;

public sealed class ServerListTests
{
    [Fact]
    public void SettingsWrittenBeforeTheListExistedKeepTheirServer()
    {
        var servers = ServerList.Normalize(null, "https://meet.example.com");
        Assert.Equal(["https://meet.example.com/"], servers.Select(entry => entry.Url));
    }

    [Fact]
    public void ActiveServerSurvivesEvenWhenItWasNeverSaved()
    {
        var saved = new ServerEntry[] { new("https://a.example.com/"), new("https://b.example.com/") };
        var servers = ServerList.Normalize(saved, "https://c.example.com");
        Assert.Equal("https://c.example.com/", servers[0].Url);
        Assert.Equal(3, servers.Count);
    }

    [Fact]
    public void OneServerCannotBecomeTwoProfilesThroughSpelling()
    {
        var saved = new ServerEntry[] { new("https://meet.example.com"), new("https://meet.example.com/") };
        var servers = ServerList.Normalize(saved, "https://meet.example.com/");
        Assert.Single(servers);
    }

    [Fact]
    public void UnusableEntriesAreDropped()
    {
        var saved = new ServerEntry[]
        {
            new("http://meet.example.com/"),      // not a secure context
            new("https://meet.example.com/join"), // carries a path
            new("not a url"),
            new("https://good.example.com/"),
        };
        var servers = ServerList.Normalize(saved, "https://good.example.com/");
        Assert.Equal(["https://good.example.com/"], servers.Select(entry => entry.Url));
    }

    [Fact]
    public void RenamingKeepsThePositionTheUserArranged()
    {
        var saved = new ServerEntry[] { new("https://a.example.com/"), new("https://b.example.com/", "B") };
        var servers = ServerList.Add(saved, "https://b.example.com", "Работа");
        Assert.Equal(2, servers.Count);
        Assert.Equal("https://b.example.com/", servers[1].Url);
        Assert.Equal("Работа", servers[1].Name);
    }

    [Fact]
    public void NewServersArriveAtTheFrontAndTheListIsBounded()
    {
        IReadOnlyList<ServerEntry> servers = [];
        for (var index = 0; index < ServerList.Max + 5; index++)
            servers = ServerList.Add(servers, $"https://host{index}.example.com");
        Assert.Equal(ServerList.Max, servers.Count);
        Assert.Equal($"https://host{ServerList.Max + 4}.example.com/", servers[0].Url);
    }

    [Fact]
    public void RemovingUsesTheOriginRatherThanTheTypedSpelling()
    {
        var saved = new ServerEntry[] { new("https://a.example.com/"), new("https://b.example.com/") };
        Assert.Single(ServerList.Remove(saved, "https://b.example.com"));
    }

    [Fact]
    public void AddressesWithoutASecureContextAreRejectedOutright() =>
        Assert.Throws<ArgumentException>(() => ServerList.Add([], "http://203.0.113.10"));

    [Fact]
    public void BareAddressesAreAcceptedSoServersNeedNoDomain()
    {
        var servers = ServerList.Add([], "https://203.0.113.10");
        Assert.Equal("https://203.0.113.10/", servers[0].Url);
        Assert.Equal("203.0.113.10", servers[0].Label);
    }

    [Fact]
    public void TheLabelFallsBackToTheHostIncludingANonStandardPort()
    {
        var servers = ServerList.Add([], "https://meet.example.com:8443", "  ");
        Assert.Equal("meet.example.com:8443", servers[0].Label);
    }

    [Fact]
    public void AutomaticConnectionIsRememberedPerServer()
    {
        var servers = ServerList.Add([], "https://a.example.com", "A", autoConnect: false);
        servers = ServerList.Add(servers, "https://b.example.com", "B");
        Assert.False(servers.First(entry => entry.Url == "https://a.example.com/").AutoConnect);
        Assert.True(servers.First(entry => entry.Url == "https://b.example.com/").AutoConnect);
        // A settings file rewritten by normalisation must not quietly turn the choice back on.
        var normalized = ServerList.Normalize(servers, "https://a.example.com/");
        Assert.False(normalized.First(entry => entry.Url == "https://a.example.com/").AutoConnect);
    }

    [Fact]
    public void ASettingsFileFromBeforeTheChoiceExistedConnectsAsItAlwaysDid()
    {
        // Older builds had no such field, so the server they opened on startup is the one they
        // must keep opening. Off by default would look like the application forgot the server.
        Assert.True(ServerList.Normalize(null, "https://meet.example.com")[0].AutoConnect);
    }
}
