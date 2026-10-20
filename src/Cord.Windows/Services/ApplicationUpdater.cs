using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Cord.Core;
using Microsoft.Win32;

namespace Cord.Windows.Services;

/// <summary>
/// Обновлятор установленной копии: спросить зеркало, скачать, запустить помощника установки. Один
/// на всё приложение — его делят заставка и главное окно. Шаги и их порядок — в
/// <see cref="ForcedUpdate.SplashAsync"/>.
/// </summary>
public sealed class ApplicationUpdater(string profileRoot) : IUpdateSteps, IDisposable
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
    /// <summary>
    /// Есть ли новее — за <paramref name="budget"/>. Не установленная копия (портативная, сборка
    /// разработчика) не обновляется вовсе: ей «новее нет». Уже скачанный пакет — это ответ сам по
    /// себе, второй раз зеркало о нём не спрашиваем.
    /// </summary>
    public async Task<UpdateCheck> CheckAsync(TimeSpan budget, CancellationToken token)
    {
        if (!Installed) return new(UpdateVerdict.None);
        if (Package is not null && Available is not null) return new(UpdateVerdict.Forced, Available);
        var check = await ForcedUpdate.CheckAsync(new ReleaseClient(_http), Version, "x64", budget, token);
        // Неответ зеркала не стирает то, что оно уже сказало раньше.
        if (check.Verdict != UpdateVerdict.Unavailable) Available = check.Release;
        return check;
    }
    public async Task<UpdateDownload> DownloadAsync(IProgress<double> progress, CancellationToken token)
    {
        var release = Available ?? throw new InvalidOperationException("Обновление не найдено.");
        var download = await ForcedUpdate.DownloadAsync(
            (relay, cancel) => new ReleaseClient(_http).DownloadAsync(release, _directory, relay, cancel), progress, ForcedUpdate.StallLimit, TimeProvider.System, token);
        Package = download.Package;
        return download;
    }
    /// <summary>Забыть скачанный пакет, чтобы следующая попытка скачала его заново.</summary>
    public void DiscardPackage() => Package = null;
    /// <summary>
    /// Чем кончилась прошлая установка — один раз, при первом запуске после неё. Итог пишет
    /// помощник (<c>result.json</c>); прочитанный он остаётся рядом, в <c>result-last.json</c>,
    /// вместе с ожидаемой и найденной на диске версией и хвостом журнала установщика.
    /// </summary>
    public string? TakeInstallFailure()
    {
        var path = Path.Combine(_directory, "result.json");
        if (!File.Exists(path)) return null;
        string result;
        try { result = File.ReadAllText(path); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return "Обновление не установилось."; }
        try { File.Move(path, Path.Combine(_directory, "result-last.json"), true); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* Прочитанное покажем и так; файл переложит следующий запуск. */ }
        return ForcedUpdate.InstallFailure(result);
    }
    /// <summary>
    /// Запустить помощника (<c>Update.ps1</c>) и дождаться, пока он сверит пакет и будет готов.
    /// Дальше Cord обязан закрыться: помощник ждёт этого, ставит молча и открывает новую версию.
    /// </summary>
    public async Task ApplyAsync(CancellationToken token)
    {
        if (!Installed || Package is null || Available is null) throw new InvalidOperationException("Обновление не готово.");
        // Откатов нет: что бы ни лежало в папке обновлений, ставится только версия новее этой.
        if (!ForcedUpdate.IsUpgrade(Available.Version, Version)) throw new InvalidOperationException("Cord ставит только версию новее установленной.");
        Directory.CreateDirectory(_directory);
        var script = Path.Combine(_directory, "apply.ps1");
        var plan = Path.Combine(_directory, "plan.json");
        var ready = Path.Combine(_directory, "ready-" + Guid.NewGuid().ToString("N"));
        using var resource = typeof(ApplicationUpdater).Assembly.GetManifestResourceStream("Cord.Update.ps1") ?? throw new IOException("Помощник обновления отсутствует.");
        using var reader = new StreamReader(resource);
        await File.WriteAllTextAsync(script, await reader.ReadToEndAsync(token), token);
        await File.WriteAllTextAsync(plan, JsonSerializer.Serialize(new UpdatePlan(Environment.ProcessId, Package, Available.Sha256, AppContext.BaseDirectory, _directory, ready, Available.Version.ToString(3)), UpdaterJson.Default.UpdatePlan), token);
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"))
        { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = _directory };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-PlanFile", plan }) start.ArgumentList.Add(arg);
        using var helper = Process.Start(start) ?? throw new IOException("Не удалось запустить обновление.");
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            // Помощник сначала сверяет SHA-256 трёхсот мегабайт, а свежий файл в это время читает
            // антивирус: десяти секунд на медленном диске не хватало, и обновление «не запускалось».
            timeout.CancelAfter(TimeSpan.FromSeconds(45));
            while (!File.Exists(ready))
            {
                if (helper.HasExited) throw new IOException("Помощник обновления завершился до готовности.");
                await Task.Delay(100, timeout.Token);
            }
        }
        catch { if (!helper.HasExited) helper.Kill(); throw; }
        finally { if (File.Exists(ready)) File.Delete(ready); }
    }
    public void Dispose() => _http.Dispose();
}
/// <param name="Version">Какая версия должна оказаться на диске: помощник сверяет её с файлом, а не верит коду выхода.</param>
public sealed record UpdatePlan(int ProcessId, string Package, string Sha256, string InstallDirectory, string UpdateDirectory, string ReadyFile, string Version);
[System.Text.Json.Serialization.JsonSerializable(typeof(UpdatePlan))]
internal partial class UpdaterJson : System.Text.Json.Serialization.JsonSerializerContext;
