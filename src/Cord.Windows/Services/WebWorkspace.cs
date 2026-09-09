using System.Text.Json;
using Cord.Core;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;

namespace Cord.Windows.Services;

/// <summary>One media engine per window, isolated to the configured server origin.</summary>
public sealed class WebWorkspace(ServerEndpoint endpoint, ProfileStore profiles, string theme = "system") : IDisposable
{
    public ServerEndpoint Endpoint { get; } = endpoint;
    public WebView2 View { get; } = new() { DefaultBackgroundColor = global::Windows.UI.Color.FromArgb(255, 247, 249, 252) };
    public string Capability { get; private set; } = "";
    public event EventHandler<WebMessage>? MessageReceived;
    public event EventHandler<string>? Failed;
    public event EventHandler? Loaded;
    public event EventHandler<bool>? FullScreenChanged;
    public Func<string, Task<bool>> RequestPermission { get; set; } = _ => Task.FromResult(false);
    private bool _disposed;

    public async Task InitializeAsync(CancellationToken token)
    {
        Capability = await profiles.GetCapabilityAsync(Endpoint, token);
        var environment = await CoreWebView2Environment.CreateWithOptionsAsync(null, profiles.BrowserProfile(Endpoint), new CoreWebView2EnvironmentOptions());
        token.ThrowIfCancellationRequested();
        if (_disposed) return;
        await View.EnsureCoreWebView2Async(environment);
        if (_disposed) return;
        var core = View.CoreWebView2;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultScriptDialogsEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsZoomControlEnabled = true;
        core.NavigationStarting += (_, e) => { if (!Endpoint.Owns(e.Uri)) e.Cancel = true; };
        core.FrameNavigationStarting += (_, e) => { if (!Endpoint.Owns(e.Uri) && e.Uri != "about:blank") e.Cancel = true; };
        core.NavigationCompleted += (_, e) =>
        {
            if (e.IsSuccess) Loaded?.Invoke(this, EventArgs.Empty);
            else Failed?.Invoke(this, "Не удалось открыть сервер. Проверьте адрес и соединение.");
        };
        core.WebMessageReceived += (_, e) =>
        {
            var message = BridgeProtocol.Read(Endpoint, e.Source, e.WebMessageAsJson);
            if (message is not null) MessageReceived?.Invoke(this, message);
        };
        core.NewWindowRequested += OpenExternal;
        core.ContainsFullScreenElementChanged += (_, _) =>
        {
            if (!_disposed) FullScreenChanged?.Invoke(this, core.ContainsFullScreenElement);
        };
        core.PermissionRequested += PermissionRequested;
        core.DownloadStarting += (_, e) =>
        {
            var uri = e.DownloadOperation.Uri;
            if (!Endpoint.Owns(uri) && !(uri.StartsWith("blob:", StringComparison.Ordinal) && Endpoint.Owns(uri[5..]))) e.Cancel = true;
        };
        core.ProcessFailed += (_, _) => Failed?.Invoke(this, "Медиадвижок остановился. Откройте пространство повторно, чтобы войти в комнату.");
        await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeProtocol.Bootstrap(Endpoint, Capability, theme));
        if (!_disposed) core.Navigate(Endpoint.Origin.AbsoluteUri);
    }

    public void Post(HostMessage message)
    {
        if (!_disposed && View.CoreWebView2 is { } core && Endpoint.Owns(core.Source))
            core.PostWebMessageAsJson(JsonSerializer.Serialize(message, CordJson.Default.HostMessage));
    }

    public async Task ResetDevicePermissionsAsync()
    {
        if (_disposed || View.CoreWebView2 is not { } core) return;
        foreach (var kind in new[] { CoreWebView2PermissionKind.Camera, CoreWebView2PermissionKind.Microphone })
            await core.Profile.SetPermissionStateAsync(kind, Endpoint.Origin.GetLeftPart(UriPartial.Authority), CoreWebView2PermissionState.Default);
    }

    private async void PermissionRequested(CoreWebView2 sender, CoreWebView2PermissionRequestedEventArgs args)
    {
        using var deferral = args.GetDeferral();
        try
        {
            args.State = CoreWebView2PermissionState.Deny;
            if (_disposed || !Endpoint.Owns(args.Uri)) return;
            var device = args.PermissionKind switch
            {
                CoreWebView2PermissionKind.Camera => "камере",
                CoreWebView2PermissionKind.Microphone => "микрофону",
                _ => null
            };
            if (device is null) return;
            if (await RequestPermission(device)) args.State = CoreWebView2PermissionState.Allow;
            args.SavesInProfile = args.State == CoreWebView2PermissionState.Allow;
        }
        catch (Exception) { args.State = CoreWebView2PermissionState.Deny; }
        finally { deferral.Complete(); }
    }
    private async void OpenExternal(CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        if (!args.IsUserInitiated || !Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) || !ServerEndpoint.IsExternalWebLink(uri)) return;
        try { await global::Windows.System.Launcher.LaunchUriAsync(uri); }
        catch (Exception) { Failed?.Invoke(this, "Не удалось открыть ссылку в браузере."); }
    }
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        View.Close();
    }
}
