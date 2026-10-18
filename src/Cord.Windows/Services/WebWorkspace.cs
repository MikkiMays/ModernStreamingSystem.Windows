using System.Text.Json;
using Cord.Core;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;

namespace Cord.Windows.Services;

/// <summary>One media engine per window, isolated to the configured server origin.</summary>
public sealed class WebWorkspace(
    ServerEndpoint endpoint,
    ProfileStore profiles,
    string theme = "system",
    bool showPing = false,
    bool notificationSounds = true,
    ServerSession? session = null,
    bool autoConnect = true) : IDisposable
{
    public ServerEndpoint Endpoint { get; } = endpoint;
    /// <summary>The handshake this workspace was opened with; renewed by the window, not the page.</summary>
    public ServerSession? Session { get; set; } = session;
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
        // Cord's cues are the point of the notification sounds setting, and a browser will not
        // play anything until the page itself has been clicked. In our own window there is no
        // question of whose page this is, so the gesture requirement is lifted — otherwise a
        // meeting joined automatically from a favourite would open in silence.
        var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
            null,
            profiles.BrowserProfile(Endpoint),
            new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required",
                // Подписи того немногого, что остаётся от меню по правой кнопке, — по-русски, как
                // и всё приложение, а не на языке системы.
                Language = "ru-RU",
            });
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
        core.ContextMenuRequested += ContextMenuRequested;
        core.DownloadStarting += (_, e) =>
        {
            var uri = e.DownloadOperation.Uri;
            if (!Endpoint.Owns(uri) && !(uri.StartsWith("blob:", StringComparison.Ordinal) && Endpoint.Owns(uri[5..]))) e.Cancel = true;
        };
        core.ProcessFailed += (_, _) => Failed?.Invoke(this, "Медиадвижок остановился. Откройте пространство повторно, чтобы войти в комнату.");
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            BridgeProtocol.Bootstrap(Endpoint, Capability, theme, showPing, notificationSounds, Session, autoConnect));
        if (!_disposed) core.Navigate(Endpoint.Origin.AbsoluteUri);
    }

    public void Post(HostMessage message)
    {
        if (!_disposed && View.CoreWebView2 is { } core && Endpoint.Owns(core.Source))
            core.PostWebMessageAsJson(JsonSerializer.Serialize(message, CordJson.Default.HostMessage));
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
    /// <summary>
    /// Правая кнопка — это Cord, а не Edge: «Проверить», «Сохранить как», «Поиск в Bing» и
    /// «Назад» в приложении бессмысленны. В поле ввода остаётся правка текста, на выделении —
    /// «Копировать», везде остальное меню не появляется вовсе. Своё меню страница открывает сама
    /// (`contextmenu` с `preventDefault`), и тогда это событие не приходит.
    /// </summary>
    private static void ContextMenuRequested(CoreWebView2 sender, CoreWebView2ContextMenuRequestedEventArgs args)
    {
        var target = args.ContextMenuTarget;
        var allowed = target.IsEditable ? EditingCommands : target.HasSelection ? CopyCommand : null;
        if (allowed is null)
        {
            args.Handled = true;
            return;
        }
        var items = args.MenuItems;
        for (var index = items.Count - 1; index >= 0; index--)
        {
            if (items[index].Kind != CoreWebView2ContextMenuItemKind.Command || !allowed.Contains(items[index].Name))
                items.RemoveAt(index);
        }
        if (items.Count == 0) args.Handled = true;
    }

    private static readonly HashSet<string> EditingCommands =
        new(StringComparer.Ordinal) { "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll" };
    private static readonly HashSet<string> CopyCommand = new(StringComparer.Ordinal) { "copy" };

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
