using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Cord.Core;
using Microsoft.Win32;

namespace Cord.Windows.Services;

public sealed class ApplicationUpdater(string profileRoot) : IDisposable
{
    private readonly HttpClient _http = new(new SocketsHttpHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(20) };
    private readonly string _directory = Path.Combine(profileRoot, "updates");
    public static Version Version => typeof(ApplicationUpdater).Assembly.GetName().Version ?? new Version(0, 0, 0);
    public static string DisplayVersion => $"{Version.Major}.{Version.Minor}.{Version.Build}";
    public CordRelease? Available { get; private set; }
    public string? Package { get; private set; }
    public bool Installed
    {
        get
        {
            if (RuntimeInformation.ProcessArchitecture != Architecture.X64) return false;
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{E43CC1FC-827B-4F55-A8E8-C746D4BAE102}_is1");
            return key?.GetValue("InstallLocation") is string location &&
                Path.GetFullPath(location).TrimEnd(Path.DirectorySeparatorChar).Equals(Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
        }
    }
    public async Task CheckAsync(CancellationToken token)
    {
        if (!Installed || Package is not null) return;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        Available = await new ReleaseClient(_http).CheckAsync(Version, "x64", timeout.Token);
    }
    public async Task DownloadAsync(IProgress<double> progress, CancellationToken token)
    {
        var release = Available ?? throw new InvalidOperationException("Обновление не найдено.");
        Package = await new ReleaseClient(_http).DownloadAsync(release, _directory, progress, token);
    }
    public string? LastResult()
    {
        var path = Path.Combine(_directory, "result.json");
        if (!File.Exists(path)) return null;
        try
        {
            using var result = JsonDocument.Parse(File.ReadAllText(path));
            File.Delete(path);
            return result.RootElement.GetProperty("ok").GetBoolean() ? null : "Не удалось применить обновление. Повторите попытку. Подробности — в журнале обновления.";
        }
        catch (Exception e) when (e is IOException or JsonException) { return "Не удалось прочитать результат обновления."; }
    }
    public async Task<bool> ApplyAsync(CancellationToken token, Func<bool> canApply)
    {
        if (!Installed || Package is null || Available is null) throw new InvalidOperationException("Обновление не готово.");
        Directory.CreateDirectory(_directory);
        var script = Path.Combine(_directory, "apply.ps1");
        var plan = Path.Combine(_directory, "plan.json");
        var ready = Path.Combine(_directory, "ready-" + Guid.NewGuid().ToString("N"));
        using var resource = typeof(ApplicationUpdater).Assembly.GetManifestResourceStream("Cord.Update.ps1") ?? throw new IOException("Помощник обновления отсутствует.");
        using var reader = new StreamReader(resource);
        await File.WriteAllTextAsync(script, await reader.ReadToEndAsync(token), token);
        await File.WriteAllTextAsync(plan, JsonSerializer.Serialize(new UpdatePlan(Environment.ProcessId, Package, Available.Sha256, AppContext.BaseDirectory, _directory, ready), UpdaterJson.Default.UpdatePlan), token);
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"))
        { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = _directory };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-PlanFile", plan }) start.ArgumentList.Add(arg);
        if (!canApply()) return false;
        using var helper = Process.Start(start) ?? throw new IOException("Не удалось запустить обновление.");
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            while (!File.Exists(ready))
            {
                if (helper.HasExited) throw new IOException("Помощник обновления завершился до готовности.");
                await Task.Delay(100, timeout.Token);
            }
            if (canApply()) return true;
            if (!helper.HasExited) helper.Kill();
            return false;
        }
        catch { if (!helper.HasExited) helper.Kill(); throw; }
        finally { if (File.Exists(ready)) File.Delete(ready); }
    }
    public void Dispose() => _http.Dispose();
}
public sealed record UpdatePlan(int ProcessId, string Package, string Sha256, string InstallDirectory, string UpdateDirectory, string ReadyFile);
[System.Text.Json.Serialization.JsonSerializable(typeof(UpdatePlan))]
internal partial class UpdaterJson : System.Text.Json.Serialization.JsonSerializerContext;
