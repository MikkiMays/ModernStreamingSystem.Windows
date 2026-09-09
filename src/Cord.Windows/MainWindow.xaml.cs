using System.Net.NetworkInformation;
using Cord.Core;
using Cord.Windows.Services;
using Cord.Windows.ViewModels;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cord.Windows;

public sealed partial class MainWindow : Window
{
    public ShellViewModel Model { get; } = new();
    private readonly ProfileStore _profiles = new();
    private readonly HttpClient _http = new(new SocketsHttpHandler { AllowAutoRedirect = false, PooledConnectionLifetime = TimeSpan.FromMinutes(2) }) { Timeout = TimeSpan.FromSeconds(8) };
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _dialogs = new(1, 1);
    private ApplicationUpdater? _updater;
    private System.Threading.Timer? _updateTimer;
    private bool _applyingUpdate;
    private DesktopSettings _settings = new();
    private WebWorkspace? _workspace;
    private GlobalMicrophoneHotkey? _microphoneHotkey;
    private MicrophoneHotkey? _requestedHotkey;
    private TaskCompletionSource? _closeReady;
    private bool _closing;
    private bool _closed;
    private bool _switching;
    private int _favoriteRevision;
    private System.Threading.Timer? _networkTimer;
    private AppWindowPresenter? _windowedPresenter;
    private bool _viewReady;
    private readonly TaskCompletionSource _homeReady = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public MainWindow(bool validateResourcesOnly = false)
    {
        InitializeComponent();
        _viewReady = true;
        if (validateResourcesOnly) return;
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(DragRegion);
        _microphoneHotkey = new GlobalMicrophoneHotkey(WinRT.Interop.WindowNative.GetWindowHandle(this), () =>
        {
            if (Model.InCall && !_closed) _workspace?.Post(new("microphone.toggle"));
        });
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "Cord.ico"));
        SystemBackdrop = new MicaBackdrop();
        var workArea = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Nearest).WorkArea;
        var width = Math.Min(1420, Math.Max(320, workArea.Width - 48));
        var height = Math.Min(920, Math.Max(320, workArea.Height - 48));
        AppWindow.MoveAndResize(new global::Windows.Graphics.RectInt32(workArea.X + (workArea.Width - width) / 2, workArea.Y + (workArea.Height - height) / 2, width, height));
        AppWindow.Closing += Window_Closing;
        Closed += Window_Closed;
        Activated += (_, _) => { if (_workspace?.Capability.Length == 43 && !_closed) Run(RefreshFavoritesAsync); };
        NetworkChange.NetworkAddressChanged += NetworkChanged;
        Run(InitializeAsync);
    }

    private async Task InitializeAsync()
    {
        _settings = await _profiles.LoadAsync(_lifetime.Token);
        ApplyTheme(_settings.Theme);
        UpdateSidebar();
        await OpenWorkspaceAsync();
        _updater = new ApplicationUpdater(_profiles.Root);
        if (_updater.LastResult() is { } error) Model.Report(error);
        Run(CheckUpdateAsync);
        _updateTimer = new System.Threading.Timer(_ => DispatcherQueue.TryEnqueue(() => Run(CheckUpdateAsync)), null, TimeSpan.FromHours(6), TimeSpan.FromHours(6));
    }

    /// <summary>Release acceptance: real WebView2, trusted origin, React bridge and native API.</summary>
    public async Task VerifyServiceAsync()
    {
        await _homeReady.Task.WaitAsync(TimeSpan.FromSeconds(45));
        var workspace = _workspace ?? throw new InvalidOperationException("The web workspace did not initialize.");
        if (workspace.Endpoint.Origin.AbsoluteUri != "https://meet.nikg.tech/")
            throw new InvalidOperationException("A fresh installation must use the production service.");
        using var response = await _http.GetAsync(new Uri(workspace.Endpoint.Origin, "api/v1/capabilities"), _lifetime.Token);
        response.EnsureSuccessStatusCode();
        using var capabilities = System.Text.Json.JsonDocument.Parse(await response.Content.ReadAsStringAsync(_lifetime.Token));
        if (capabilities.RootElement.GetProperty("maxParticipants").GetInt32() != 10)
            throw new InvalidOperationException("Unexpected production capabilities.");
        var rendered = await workspace.View.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.desktop-home'))");
        if (rendered != "true") throw new InvalidOperationException("The shared desktop interface was not rendered.");
        await new FavoriteClient(_http).ListAsync(workspace.Endpoint, workspace.Capability, _lifetime.Token);
        var size = AppWindow.Size;
        var position = AppWindow.Position;
        var webView = workspace.View.CoreWebView2;
        SetMediaFullScreen(true);
        await Task.Delay(250, _lifetime.Token);
        if (TitlebarHost.Visibility != Visibility.Collapsed || NavigationSplit.IsPaneOpen || WorkspaceFrame.BorderThickness.Left != 0)
            throw new InvalidOperationException("Fullscreen did not hide the native shell.");
        SetMediaFullScreen(false);
        await Task.Delay(250, _lifetime.Token);
        if (AppWindow.Size.Width != size.Width || AppWindow.Size.Height != size.Height || AppWindow.Position.X != position.X || AppWindow.Position.Y != position.Y || TitlebarHost.Visibility != Visibility.Visible)
            throw new InvalidOperationException("Fullscreen did not restore the window bounds.");
        if (workspace != _workspace || webView != workspace.View.CoreWebView2 || WorkspaceHost.Content != workspace.View)
            throw new InvalidOperationException("Fullscreen replaced the running WebView.");
    }

    private async Task OpenWorkspaceAsync()
    {
        if (_switching || _closed) return;
        _switching = true;
        Model.Loading = true;
        Model.HasError = false;
        try
        {
            SetMediaFullScreen(false);
            _microphoneHotkey?.Configure(null);
            _requestedHotkey = null;
            _workspace?.Dispose();
            var endpoint = ServerEndpoint.Parse(_settings.ServerUrl);
            var workspace = new WebWorkspace(endpoint, _profiles, _settings.Theme) { RequestPermission = RequestPermissionAsync };
            _workspace = workspace;
            workspace.MessageReceived += WebMessageReceived;
            workspace.Failed += (_, message) => { Model.Loading = false; Model.Report(message); };
            workspace.Loaded += (_, _) => { Model.Loading = false; workspace.Post(new("theme.changed", Theme: _settings.Theme)); };
            workspace.FullScreenChanged += (sender, fullScreen) => { if (sender == _workspace) SetMediaFullScreen(fullScreen); };
            WorkspaceHost.Content = workspace.View;
            Model.ServerLabel = endpoint.Origin.IsLoopback ? "Локальный сервер" : endpoint.Origin.IdnHost;
            await workspace.InitializeAsync(_lifetime.Token);
            await RefreshFavoritesAsync();
        }
        finally { _switching = false; }
    }

    private async Task RefreshFavoritesAsync()
    {
        var workspace = _workspace;
        if (workspace?.Capability.Length != 43 || _closed) return;
        var revision = ++_favoriteRevision;
        try
        {
            var rooms = await new FavoriteClient(_http).ListAsync(workspace.Endpoint, workspace.Capability, _lifetime.Token);
            if (workspace == _workspace && revision == _favoriteRevision && !_closed) Model.ReplaceFavorites(rooms);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            if (!_closed && revision == _favoriteRevision) Model.ServerLabel = "Ожидаем сервер";
        }
    }

    private void WebMessageReceived(object? sender, WebMessage message)
    {
        if (sender != _workspace || _closed) return;
        switch (message.Type)
        {
            case "state":
                if (message.Page == "home") _homeReady.TrySetResult();
                Model.InCall = message.InCall ?? message.Page == "room";
                _workspace?.Post(new("preferences.changed", ShowPing: _settings.ShowPing, NotificationSounds: _settings.NotificationSounds));
                _microphoneHotkey?.Configure(Model.InCall ? _requestedHotkey : null);
                Model.Status = message.Room?.Title ?? (message.Page == "prejoin" ? "Перед разговором" : "На одной волне");
                Model.Name = string.IsNullOrWhiteSpace(message.Name) ? "Ваше пространство" : message.Name;
                if (message.Theme is "light" or "dark" or "system")
                {
                    ApplyTheme(message.Theme);
                    if (message.Theme != _settings.Theme)
                    {
                        _settings = _settings with { Theme = message.Theme };
                        Run(() => _profiles.SaveAsync(_settings, _lifetime.Token));
                    }
                }
                Title = "Cord";
                if (!Model.InCall) Run(ApplyUpdateIfReadyAsync);
                break;
            case "call-state":
                if (message.InCall is { } inCall) Model.InCall = inCall;
                if (!Model.InCall) Run(ApplyUpdateIfReadyAsync);
                break;
            case "preferences.changed":
                _settings = _settings with { ShowPing = message.ShowPing ?? _settings.ShowPing, NotificationSounds = message.NotificationSounds ?? _settings.NotificationSounds };
                Run(() => _profiles.SaveAsync(_settings, _lifetime.Token));
                break;
            case "hotkey.configure":
                _requestedHotkey = message.Hotkey;
                var status = _microphoneHotkey?.Configure(Model.InCall ? _requestedHotkey : null);
                _workspace?.Post(new("hotkey.status", Detail: status));
                break;
            case "favorites.changed": Run(RefreshFavoritesAsync); break;
            case "close-ready": _closeReady?.TrySetResult(); break;
        }
    }

    private async Task NavigateAsync(string page, string? roomId = null)
    {
        if (_workspace is null) return;
        if (Model.InCall && !await ConfirmLeaveAsync()) return;
        _workspace.Post(new("navigate", page, roomId));
    }
    private async Task<bool> ConfirmLeaveAsync() => await DialogAsync(new ContentDialog
    {
        Title = "Выйти из текущей встречи?",
        Content = "Вы сможете вернуться по коду или из избранного. Остальные участники продолжат разговор.",
        PrimaryButtonText = "Выйти",
        CloseButtonText = "Остаться",
        DefaultButton = ContentDialogButton.Close
    }) == ContentDialogResult.Primary;
    private async Task<bool> RequestPermissionAsync(string device) => await DialogAsync(new ContentDialog
    {
        Title = $"Разрешить доступ к {device}?",
        Content = "Вы включили устройство в Cord. В диагностике проверка останется локальной; во встрече устройство будет передавать звук или видео участникам.",
        PrimaryButtonText = "Разрешить",
        CloseButtonText = "Не сейчас",
        DefaultButton = ContentDialogButton.Primary
    }) == ContentDialogResult.Primary;
    private async Task<ContentDialogResult> DialogAsync(ContentDialog dialog)
    {
        await _dialogs.WaitAsync(_lifetime.Token);
        try
        {
            if (_closed) return ContentDialogResult.None;
            dialog.XamlRoot = Root.XamlRoot;
            dialog.RequestedTheme = Root.RequestedTheme;
            return await dialog.ShowAsync();
        }
        finally { _dialogs.Release(); }
    }

    private async Task ShowSettingsAsync()
    {
        var address = new TextBox { Header = "Адрес вашего сервера", Text = _settings.ServerUrl, PlaceholderText = "https://meet.example.com", MinWidth = 320 };
        var theme = new ComboBox { Header = "Оформление", HorizontalAlignment = HorizontalAlignment.Stretch };
        theme.Items.Add("Как в системе"); theme.Items.Add("Светлое"); theme.Items.Add("Тёмное");
        theme.SelectedIndex = _settings.Theme == "light" ? 1 : _settings.Theme == "dark" ? 2 : 0;
        var note = new TextBlock { Text = "Один адрес для Windows, браузера и телефона. Имя, избранное и устройства сохраняются отдельно для каждого сервера.", TextWrapping = TextWrapping.Wrap, FontSize = 13 };
        var error = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = new SolidColorBrush(global::Windows.UI.Color.FromArgb(255, 210, 70, 70)) };
        var content = new StackPanel { Spacing = 18, MaxWidth = 420 };
        content.Children.Add(address); content.Children.Add(theme); content.Children.Add(note); content.Children.Add(error);
        var name = new TextBox { Header = "Имя по умолчанию", Text = Model.Name == "Ваше пространство" ? "" : Model.Name, MaxLength = 40 };
        content.Children.Insert(0, name);
        var sounds = new ToggleSwitch { Header = "Звуки уведомлений", IsOn = _settings.NotificationSounds };
        var ping = new ToggleSwitch { Header = "Показывать задержку / PING", IsOn = _settings.ShowPing };
        content.Children.Add(sounds); content.Children.Add(ping);
        var dialog = new ContentDialog { Title = "Ваше пространство", Content = content, PrimaryButtonText = "Сохранить", CloseButtonText = "Отмена", DefaultButton = ContentDialogButton.Primary };
        dialog.PrimaryButtonClick += (_, args) =>
        {
            try { ServerEndpoint.Parse(address.Text); }
            catch (ArgumentException e) { error.Text = e.Message.Split(" (Parameter")[0]; args.Cancel = true; }
        };
        if (await DialogAsync(dialog) != ContentDialogResult.Primary) return;
        var endpoint = ServerEndpoint.Parse(address.Text);
        bool changed = endpoint.Origin.AbsoluteUri != ServerEndpoint.Parse(_settings.ServerUrl).Origin.AbsoluteUri;
        if (changed && Model.InCall && !await ConfirmLeaveAsync()) return;
        if (changed && Model.InCall) await LeaveWebAsync();
        _settings = _settings with { ShowPing = ping.IsOn, NotificationSounds = sounds.IsOn, ServerUrl = endpoint.Origin.AbsoluteUri, Theme = theme.SelectedIndex == 1 ? "light" : theme.SelectedIndex == 2 ? "dark" : "system" };
        await _profiles.SaveAsync(_settings, _lifetime.Token);
        ApplyTheme(_settings.Theme);
        if (changed) { Model.InCall = false; Model.ReplaceFavorites([]); await OpenWorkspaceAsync(); }
        else
        {
            _workspace?.Post(new("theme.changed", Theme: _settings.Theme));
            _workspace?.Post(new("profile.changed", Name: name.Text.Trim()));
            _workspace?.Post(new("preferences.changed", ShowPing: _settings.ShowPing, NotificationSounds: _settings.NotificationSounds));
        }
    }
    private void ApplyTheme(string theme)
    {
        Root.RequestedTheme = theme == "dark" ? ElementTheme.Dark : theme == "light" ? ElementTheme.Light : ElementTheme.Default;
        AppWindow.TitleBar.ButtonBackgroundColor = global::Windows.UI.Color.FromArgb(0, 0, 0, 0);
        AppWindow.TitleBar.ButtonInactiveBackgroundColor = global::Windows.UI.Color.FromArgb(0, 0, 0, 0);
    }
    private void NetworkChanged(object? sender, EventArgs e)
    {
        _networkTimer?.Dispose();
        _networkTimer = new System.Threading.Timer(_ => DispatcherQueue.TryEnqueue(() =>
        {
            if (_closed) return;
            _workspace?.Post(new("network.changed"));
            Run(RefreshFavoritesAsync);
        }), null, 500, Timeout.Infinite);
    }
    private async Task LeaveWebAsync()
    {
        if (_workspace is null) return;
        _closeReady = new(TaskCreationOptions.RunContinuationsAsynchronously);
        _workspace.Post(new("close-request"));
        await Task.WhenAny(_closeReady.Task, Task.Delay(2500, _lifetime.Token));
    }
    private void Window_Closing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_closing || !Model.InCall) return;
        args.Cancel = true; _closing = true;
        Run(async () => { await LeaveWebAsync(); Close(); });
    }
    private void Window_Closed(object sender, WindowEventArgs args)
    {
        _closed = true;
        NetworkChange.NetworkAddressChanged -= NetworkChanged;
        _microphoneHotkey?.Dispose();
        _updateTimer?.Dispose(); _updater?.Dispose();
        _networkTimer?.Dispose(); _lifetime.Cancel(); _workspace?.Dispose(); _http.Dispose();
    }
    private void UpdateSidebar()
    {
        if (!_viewReady) return;
        var visible = _windowedPresenter is null && !_settings.CompactSidebar && (Root.ActualWidth == 0 || Root.ActualWidth >= 1000);
        // SplitView animates the pane with the native theme and respects Windows animation settings.
        // The same WebView2 stays mounted, preserving the media connection during the transition.
        NavigationSplit.IsPaneOpen = visible;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(PaneToggle, visible ? "Скрыть боковую панель" : "Показать боковую панель");
        ToolTipService.SetToolTip(PaneToggle, visible ? "Скрыть боковую панель" : "Показать боковую панель");
    }
    private void SetMediaFullScreen(bool active)
    {
        if (_closed || active == (_windowedPresenter is not null)) return;
        if (active)
        {
            _windowedPresenter = AppWindow.Presenter;
            AppWindow.SetPresenter(AppWindowPresenterKind.FullScreen);
        }
        else
        {
            AppWindow.SetPresenter(_windowedPresenter!);
            _windowedPresenter = null;
        }
        TitlebarRow.Height = new GridLength(active ? 0 : 52);
        TitlebarHost.Visibility = active ? Visibility.Collapsed : Visibility.Visible;
        WorkspaceFrame.Margin = active ? new Thickness(0) : new Thickness(0, 0, 12, 12);
        WorkspaceFrame.BorderThickness = new Thickness(active ? 0 : 1);
        WorkspaceFrame.CornerRadius = new CornerRadius(active ? 0 : 16);
        UpdateSidebar();
    }
    private void Root_SizeChanged(object sender, SizeChangedEventArgs e) => UpdateSidebar();
    private void PaneToggle_Click(object sender, RoutedEventArgs e)
    {
        if (Root.ActualWidth < 1000)
        {
            var menu = new MenuFlyout();
            foreach (var (text, action) in new (string, Func<Task>)[] { ("Главная", () => NavigateAsync("home")), ("Новая встреча", () => NavigateAsync("create")), ("Настройки", ShowSettingsAsync) })
            {
                var item = new MenuFlyoutItem { Text = text }; item.Click += (_, _) => Run(action); menu.Items.Add(item);
            }
            foreach (var room in Model.Favorites)
            {
                var item = new MenuFlyoutItem { Text = room.Title, IsEnabled = room.CanJoin }; item.Click += (_, _) => Run(() => NavigateAsync("favorite", room.RoomId)); menu.Items.Add(item);
            }
            menu.ShowAt(PaneToggle); return;
        }
        _settings = _settings with { CompactSidebar = !_settings.CompactSidebar };
        UpdateSidebar(); Run(() => _profiles.SaveAsync(_settings, _lifetime.Token));
    }
    private async Task CheckUpdateAsync()
    {
        if (_updater is null || Model.UpdateBusy || _closed) return;
        try
        {
            await _updater.CheckAsync(_lifetime.Token);
            Model.UpdateAvailable = _updater.Available is not null;
            if (Model.UpdateAvailable) { Model.UpdateButton = "Обновить"; Model.UpdateStatus = "Доступна версия " + _updater.Available!.Version; }
        }
        catch (Exception e) when (e is HttpRequestException or IOException or OperationCanceledException or System.Text.Json.JsonException)
        {
            if (!_closed) { Model.UpdateStatus = "Не удалось проверить обновления"; Model.UpdateAvailable = true; Model.UpdateButton = "Повторить"; }
        }
    }
    private async Task DownloadUpdateAsync()
    {
        if (_updater is null || Model.UpdateBusy) return;
        if (_updater.Available is null) { await CheckUpdateAsync(); return; }
        Model.UpdateBusy = true;
        Model.UpdateAvailable = false;
        try
        {
            Model.UpdateStatus = "Скачиваем обновление…";
            await _updater.DownloadAsync(new Progress<double>(value => Model.UpdateProgress = value * 100), _lifetime.Token);
            Model.UpdateStatus = Model.InCall ? "Обновим после завершения встречи" : "Применяем обновление…";
            await ApplyUpdateIfReadyAsync();
        }
        catch (Exception e) when (e is HttpRequestException or IOException or OperationCanceledException)
        {
            if (!_closed) { Model.UpdateStatus = e is InvalidDataException ? e.Message : "Загрузка не завершена. Повторите попытку."; Model.UpdateAvailable = true; Model.UpdateButton = "Повторить"; }
        }
        finally { Model.UpdateBusy = false; }
    }
    private async Task ApplyUpdateIfReadyAsync()
    {
        if (_closed || _applyingUpdate || Model.InCall || _updater?.Package is null) return;
        _applyingUpdate = true;
        try { if (await _updater.ApplyAsync(_lifetime.Token, () => !Model.InCall && !_closed)) { _closing = true; Close(); } else _applyingUpdate = false; }
        catch { _applyingUpdate = false; Model.UpdateStatus = "Не удалось запустить обновление"; Model.UpdateAvailable = true; throw; }
    }
    private void Update_Click(object sender, RoutedEventArgs e) => Run(DownloadUpdateAsync);
    private void FavoriteSettings_Click(object sender, RoutedEventArgs e) { if (sender is Button { Tag: string id }) _workspace?.Post(new("favorite.settings", RoomId: id)); }
    private void Home_Click(object sender, RoutedEventArgs e) => Run(() => NavigateAsync("home"));
    private void Create_Click(object sender, RoutedEventArgs e) => Run(() => NavigateAsync("create"));
    private void Favorite_Click(object sender, RoutedEventArgs e) { if (sender is Button { Tag: string id }) Run(() => NavigateAsync("favorite", id)); }
    private void Refresh_Click(object sender, RoutedEventArgs e) => Run(RefreshFavoritesAsync);
    private void Settings_Click(object sender, RoutedEventArgs e) => Run(ShowSettingsAsync);
    private void Retry_Click(object sender, RoutedEventArgs e) => Run(async () => { if (!Model.InCall || await ConfirmLeaveAsync()) { await LeaveWebAsync(); Model.InCall = false; await OpenWorkspaceAsync(); } });
    private async void Run(Func<Task> action)
    {
        try { await action(); }
        catch (OperationCanceledException) when (_closed) { }
        catch (Exception e)
        {
            if (_closed) return;
            Model.Loading = false;
            Model.Report(e is ArgumentException ? e.Message : "Не удалось выполнить действие. Проверьте сервер и установленный WebView2 Runtime.");
            try { await File.WriteAllTextAsync(Path.Combine(_profiles.Root, "last-error.txt"), $"{e.GetType().FullName}\n0x{e.HResult:X8}\n{e.StackTrace}"); }
            catch (IOException) { /* Error reporting must not crash the window. */ }
        }
    }
}
