using System.Net.NetworkInformation;
using Cord.Core;
using Cord.Windows.Services;
using Cord.Windows.ViewModels;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Ellipse = Microsoft.UI.Xaml.Shapes.Ellipse;

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
    /// <summary>Версия, о которой уже сказали. Второй раз о том же не напоминаем.</summary>
    private Version? _announcedUpdate;
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
    private readonly TaskCompletionSource _shown = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private ContentDialog? _openDialog;
    /// <summary>The handshake with the current server. Null means we are not on a server yet.</summary>
    private ServerSession? _session;
    private string _password = "";
    private bool _renewing;
    /// <summary>The data URI currently shown, so the same picture is decoded only once.</summary>
    private string _avatar = "";

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
        Activated += (_, _) =>
        {
            _shown.TrySetResult();
            if (_workspace?.Capability.Length == 43 && !_closed) Run(RefreshFavoritesAsync);
        };
        NetworkChange.NetworkAddressChanged += NetworkChanged;
        Run(InitializeAsync);
    }

    private async Task InitializeAsync()
    {
        _settings = await _profiles.LoadAsync(_lifetime.Token);
        ApplyTheme(_settings.Theme);
        UpdateSidebar();
        // The server comes first. Until it has answered there are no favourites to show and no
        // room to join, so showing the workspace would only be a shell around nothing. Someone
        // who closes that screen without connecting has asked to leave, and the button says so.
        if (!await EnsureConnectionAsync())
        {
            Model.Loading = false;
            _closing = true;
            Close();
            return;
        }
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
        if (workspace.Endpoint.Origin.AbsoluteUri != ServerEndpoint.Parse(CordDefaults.ServerUrl).Origin.AbsoluteUri)
            throw new InvalidOperationException("A fresh installation must use the production service.");
        using var response = await _http.GetAsync(new Uri(workspace.Endpoint.Origin, "api/v1/capabilities"), _lifetime.Token);
        response.EnsureSuccessStatusCode();
        using var capabilities = System.Text.Json.JsonDocument.Parse(await response.Content.ReadAsStringAsync(_lifetime.Token));
        if (capabilities.RootElement.GetProperty("maxParticipants").GetInt32() != 10)
            throw new InvalidOperationException("Unexpected production capabilities.");
        var rendered = await workspace.View.CoreWebView2.ExecuteScriptAsync("Boolean(document.querySelector('.desktop-home'))");
        if (rendered != "true") throw new InvalidOperationException("The shared desktop interface was not rendered.");
        await new FavoriteClient(_http).ListAsync(workspace.Endpoint, workspace.Capability, _lifetime.Token, _session?.Token);
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
            var entry = _settings.Servers?.FirstOrDefault(server => server.Url == endpoint.Origin.AbsoluteUri);
            var workspace = new WebWorkspace(endpoint, _profiles, _settings.Theme, _settings.ShowPing, _settings.NotificationSounds, _session, entry?.AutoConnect != false)
            {
                RequestPermission = RequestPermissionAsync,
            };
            _workspace = workspace;
            workspace.MessageReceived += WebMessageReceived;
            workspace.Failed += (_, message) => { Model.Loading = false; Model.Report(message); };
            workspace.Loaded += (_, _) => { Model.Loading = false; workspace.Post(new("theme.changed", Theme: _settings.Theme)); };
            workspace.FullScreenChanged += (sender, fullScreen) => { if (sender == _workspace) SetMediaFullScreen(fullScreen); };
            WorkspaceHost.Content = workspace.View;
            Model.ServerLabel = ServerName(endpoint);
            await workspace.InitializeAsync(_lifetime.Token);
            await RefreshFavoritesAsync();
        }
        finally { _switching = false; }
    }

    /// <summary>What to call the server in the sidebar: its own name, or its bare host.</summary>
    private string ServerName(ServerEndpoint endpoint) =>
        _session?.Name is { Length: > 0 } named ? named
        : endpoint.Origin.IsLoopback ? "Локальный сервер"
        : endpoint.Origin.IdnHost;

    private async Task RefreshFavoritesAsync()
    {
        var workspace = _workspace;
        if (workspace?.Capability.Length != 43 || _closed) return;
        var revision = ++_favoriteRevision;
        try
        {
            var rooms = await new FavoriteClient(_http).ListAsync(workspace.Endpoint, workspace.Capability, _lifetime.Token, _session?.Token);
            if (workspace == _workspace && revision == _favoriteRevision && !_closed)
            {
                Model.ReplaceFavorites(rooms);
                // One refresh that did not arrive used to rename the server «Ожидаем сервер»
                // for the rest of the visit, including the whole of a meeting that was working
                // perfectly. A refresh that did arrive is the answer to that.
                Model.ServerLabel = ServerName(workspace.Endpoint);
            }
        }
        catch (HttpRequestException e) when (e.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            // The session lapsed. Renewing is ours to do; the page is told about the new one.
            await RenewSessionAsync();
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            // A conversation in progress is proof that the server is answering; a favourites
            // list that did not arrive says nothing about it and must not say otherwise.
            if (!_closed && revision == _favoriteRevision && !Model.InCall) Model.ServerLabel = "Ожидаем сервер";
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
                ShowAvatar(message.Avatar ?? "");
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
            case "server.autoconnect":
                if (message.AutoConnect is { } automatic)
                {
                    var origin = ServerEndpoint.Parse(_settings.ServerUrl).Origin.AbsoluteUri;
                    var current = _settings.Servers?.FirstOrDefault(server => server.Url == origin);
                    _settings = _settings with { Servers = ServerList.Add(_settings.Servers ?? [], origin, current?.Name ?? "", automatic) };
                    Run(() => _profiles.SaveAsync(_settings, _lifetime.Token));
                }
                break;
            case "favorites.changed": Run(RefreshFavoritesAsync); break;
            case "servers.open": Run(() => ShowServersAsync()); break;
            case "session.expired": Run(RenewSessionAsync); break;
            // Страница о файлах приложения ничего не знает: она умеет только попросить
            // проверить и показать ответ. Раздел «О программе» в вебе и в приложении — один,
            // и кнопка в нём должна делать что-то и там, и там.
            case "update.version": PostUpdateStatus(); break;
            case "update.check": Run(async () => { await CheckUpdateAsync(); PostUpdateStatus(); }); break;
            case "update.apply": Run(DownloadUpdateAsync); break;
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
            _openDialog = dialog;
            return await dialog.ShowAsync();
        }
        finally
        {
            _openDialog = null;
            _dialogs.Release();
        }
    }
    /// <summary>WinUI shows one dialog at a time, so a step that needs another closes this one first.</summary>
    private void CloseOpenDialog() => _openDialog?.Hide();

    /// <summary>
    /// Connects to the saved server, and asks only when it cannot. An address with automatic
    /// connection on and a remembered password needs no screen at all; anything else opens the
    /// server list, which is also where a first-time user picks where they are going.
    /// </summary>
    private async Task<bool> EnsureConnectionAsync()
    {
        Model.ServerLabel = "Подключаемся…";
        var endpoint = ServerEndpoint.Parse(_settings.ServerUrl);
        var entry = _settings.Servers?.FirstOrDefault(server => server.Url == endpoint.Origin.AbsoluteUri);
        if (entry?.AutoConnect != false)
        {
            var password = await _profiles.GetPasswordAsync(endpoint, _lifetime.Token);
            var result = await new ServerAccessClient(_http).TryConnectAsync(endpoint.Origin.AbsoluteUri, password, _lifetime.Token);
            if (result is { Ok: true, Session: { } session })
            {
                _session = session;
                _password = password;
                return true;
            }
            Model.Loading = false;
            return await ShowServersAsync(result.Detail);
        }
        Model.Loading = false;
        return await ShowServersAsync("");
    }

    /// <summary>
    /// The list of servers with the one blue button that adds to it, a gear on every row, and
    /// the way in. Editing an entry needs its own dialog and WinUI shows one at a time, so the
    /// picker closes, the editor runs, and the picker comes back — which is also why this is a
    /// loop rather than a single call.
    /// </summary>
    private async Task<bool> ShowServersAsync(string complaint = "")
    {
        string? preselect = null;
        while (true)
        {
            var choice = await PickServerAsync(complaint, preselect);
            complaint = "";
            preselect = null;
            if (choice.Adding || choice.Edit is not null)
            {
                // A server just written down is the one you meant to use, so it comes back
                // already chosen rather than making you find it in the list.
                preselect = await EditServerAsync(choice.Edit);
                continue;
            }
            // Moving to the server happens after the dialog has closed. Leaving a meeting first
            // asks its own question, and WinUI will not show that question over this one — it
            // would wait for a dialog that is waiting for it.
            if (choice.Connect is null || choice.Session is null) return _session is not null;
            if (await ApplyServerAsync(choice.Connect, choice.Password, choice.Automatic, choice.Session)) return true;
            complaint = "Переход отменён: вы остались во встрече на прежнем сервере.";
        }
    }

    private sealed record ServerChoice(
        ServerEntry? Connect = null,
        ServerSession? Session = null,
        string Password = "",
        bool Automatic = true,
        ServerEntry? Edit = null,
        bool Adding = false);

    private async Task<ServerChoice> PickServerAsync(string complaint, string? preselect = null)
    {
        await _shown.Task;
        var servers = (_settings.Servers ?? []).ToList();
        var current = preselect ?? ServerEndpoint.Parse(_settings.ServerUrl).Origin.AbsoluteUri;
        var chosen = servers.FirstOrDefault(server => server.Url == current) ?? servers.FirstOrDefault();
        ServerEntry? edit = null;
        var adding = false;
        var health = new Dictionary<string, Ellipse>(StringComparer.Ordinal);
        var picks = new Dictionary<string, Button>(StringComparer.Ordinal);
        // Что уже известно про каждый сервер. Без этой памяти любая перерисовка списка
        // начинала бы с серого: цвет жил только на самом кружке, а кружок — недолго.
        var known = new Dictionary<string, bool>(StringComparer.Ordinal);

        var password = new PasswordBox { Header = "Пароль сервера", PlaceholderText = "Если сервер закрыт паролем", MaxLength = 200 };
        var automatic = new CheckBox { Content = "Подключаться к этому серверу при запуске" };
        var status = new TextBlock { FontSize = 12, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
        var reason = new TextBlock { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
        var detail = new Expander { Header = "Подробности", Content = reason, Visibility = Visibility.Collapsed, HorizontalAlignment = HorizontalAlignment.Stretch };
        var rows = new StackPanel { Spacing = 4 };

        var add = new Button
        {
            Content = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 8,
                Children = { new FontIcon { Glyph = "\uE710", FontSize = 13 }, new TextBlock { Text = "Добавить сервер" } },
            },
            Padding = new Thickness(12, 8, 14, 8),
            CornerRadius = new CornerRadius(10),
            HorizontalAlignment = HorizontalAlignment.Left,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
        };
        add.Click += (_, _) => { adding = true; CloseOpenDialog(); };

        // With nothing saved there is nothing to choose between, so the only thing on screen is
        // the one action that can lead anywhere.
        var empty = servers.Count == 0;
        var invite = new Button
        {
            Content = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 10,
                Children = { new FontIcon { Glyph = "\uE710", FontSize = 15 }, new TextBlock { Text = "Добавить сервер", FontWeight = Microsoft.UI.Text.FontWeights.SemiBold } },
            },
            Height = 52,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Center,
            CornerRadius = new CornerRadius(12),
            Background = (Brush)Application.Current.Resources["CordAccent"],
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            BorderThickness = new Thickness(0),
        };
        invite.Click += (_, _) => { adding = true; CloseOpenDialog(); };

        // Выделение — это цвет подложки, а не новый список.
        //
        // ЗАЧЕМ ОТДЕЛЬНО. Раньше нажатие на сервер пересобирало список целиком, и вместе с
        // ним — кружки состояния. Новые кружки рождались серыми, а опрос к этому моменту уже
        // прошёл, и красить было нечего: цвет пропадал у всех сразу и больше не возвращался.
        // Снаружи это выглядело как «точка гаснет, когда выбираешь сервер».
        void Highlight()
        {
            foreach (var (url, pick) in picks)
                pick.Background = new SolidColorBrush(url == chosen?.Url
                    ? global::Windows.UI.Color.FromArgb(56, 0x46, 0x74, 0xF3)
                    : Microsoft.UI.Colors.Transparent);
        }

        void Select(ServerEntry? entry)
        {
            chosen = entry;
            automatic.IsChecked = entry?.AutoConnect != false;
            Highlight();
        }

        void BuildRows()
        {
            rows.Children.Clear();
            health.Clear();
            picks.Clear();
            foreach (var server in servers)
            {
                var row = new Grid { ColumnSpacing = 4 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var dot = new Ellipse
                {
                    Width = 8,
                    Height = 8,
                    VerticalAlignment = VerticalAlignment.Center,
                    // Серый — только пока о сервере ничего не спрашивали. Всё, что уже
                    // известно, кружок показывает с первого кадра, а не после нового опроса.
                    Fill = new SolidColorBrush(known.TryGetValue(server.Url, out var live) ? (live ? Alive : Dead) : Unknown),
                    Opacity = 0.7,
                };
                health[server.Url] = dot;
                var title = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { new TextBlock { Text = server.Label, TextTrimming = TextTrimming.CharacterEllipsis, FontSize = 14 }, dot } };
                var pick = new Button
                {
                    HorizontalAlignment = HorizontalAlignment.Stretch,
                    HorizontalContentAlignment = HorizontalAlignment.Left,
                    Padding = new Thickness(12, 10, 12, 10),
                    CornerRadius = new CornerRadius(14),
                    BorderThickness = new Thickness(0),
                    Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                    Content = new StackPanel
                    {
                        Spacing = 2,
                        Children = { title, new TextBlock { Text = Host(server.Url), FontSize = 11, Opacity = Muted } },
                    },
                };
                picks[server.Url] = pick;
                var captured = server;
                pick.Click += (_, _) => Select(captured);
                var gear = new Button
                {
                    Content = new FontIcon { Glyph = "\uE713", FontSize = 14 },
                    Width = 36,
                    Height = 36,
                    Padding = new Thickness(0),
                    VerticalAlignment = VerticalAlignment.Center,
                    Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                    BorderThickness = new Thickness(0),
                };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(gear, $"Изменить «{server.Label}»");
                ToolTipService.SetToolTip(gear, "Изменить или удалить");
                gear.Click += (_, _) => { edit = captured; CloseOpenDialog(); };
                Grid.SetColumn(gear, 1);
                row.Children.Add(pick);
                row.Children.Add(gear);
                rows.Children.Add(row);
            }
        }
        BuildRows();
        Select(chosen);
        // The password for the server we are already on is the one Windows is keeping; any
        // other entry starts empty until its own is loaded by the editor.
        if (chosen?.Url == current)
            password.Password = await _profiles.GetPasswordAsync(ServerEndpoint.Parse(current), _lifetime.Token);

        void Report(ConnectionResult result)
        {
            status.Text = result.Ok ? "Подключено!" : "Не подключено";
            status.Opacity = 1;
            status.Foreground = new SolidColorBrush(result.Ok ? Alive : Dead);
            reason.Text = result.Detail;
            detail.Visibility = result.Ok ? Visibility.Collapsed : Visibility.Visible;
            detail.IsExpanded = false;
        }
        if (complaint.Length > 0) Report(new ConnectionResult(false, complaint));

        var content = new StackPanel { Spacing = 14, MinWidth = 380 };
        if (empty)
        {
            content.Children.Add(invite);
            content.Children.Add(Note("Cord подключается к серверу, на котором идут встречи. Адрес даёт тот, кто его поднял."));
        }
        else
        {
            content.Children.Add(Group("Серверы"));
            content.Children.Add(new ScrollViewer { Content = rows, MaxHeight = 240, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled });
            content.Children.Add(add);
            content.Children.Add(password);
            content.Children.Add(automatic);
            content.Children.Add(status);
            content.Children.Add(detail);
        }

        ServerSession? opened = null;
        var dialog = new ContentDialog
        {
            Title = "Подключение к серверу",
            Content = new ScrollViewer { Content = content, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, MaxHeight = 560 },
            PrimaryButtonText = empty ? "" : "Подключиться",
            CloseButtonText = _session is null ? "Выйти" : "Закрыть",
            DefaultButton = empty ? ContentDialogButton.Close : ContentDialogButton.Primary,
        };
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            args.Cancel = true;
            if (chosen is null) return;
            var deferral = args.GetDeferral();
            try
            {
                status.Text = "Подключаемся…";
                Neutral(status);
                detail.Visibility = Visibility.Collapsed;
                var result = await new ServerAccessClient(_http).TryConnectAsync(chosen.Url, password.Password, _lifetime.Token);
                Report(result);
                // The dialog closes on a connection and on nothing else: a refusal keeps the
                // reason under the button, which is where it can be acted on.
                opened = result.Session;
                args.Cancel = !result.Ok;
            }
            catch (OperationCanceledException) { }
            finally { deferral.Complete(); }
        };
        using var probes = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        var probing = ProbeServersAsync(servers, health, known, probes.Token);
        await DialogAsync(dialog);
        await probes.CancelAsync();
        await probing;
        return new ServerChoice(opened is null ? null : chosen, opened, password.Password, automatic.IsChecked == true, edit, adding);
    }

    /// <summary>
    /// Lights the dot beside every saved server, and keeps it lit for as long as the picker is
    /// open. The native client can ask all of them, which a browser cannot: the core refuses a
    /// foreign origin. Failures are the answer here, not an error — a server that does not
    /// respond is exactly what the dot is for.
    /// </summary>
    /// <remarks>
    /// Опрашиваются все сразу. Обход по очереди означал, что последний сервер в списке ждёт
    /// таймаутов всех предыдущих, — при паре недоступных адресов «сразу» превращалось в
    /// десятки секунд ожидания серого кружка.
    ///
    /// Повторяется, пока открыто окно: состояние сервера — это не свойство списка, а то, что
    /// верно прямо сейчас, и за минуту выбора оно успевает измениться.
    ///
    /// Словари трогает только поток интерфейса: ни одно ожидание здесь не отпускает контекст
    /// синхронизации, поэтому параллельны запросы, а не записи.
    /// </remarks>
    private async Task ProbeServersAsync(
        IReadOnlyList<ServerEntry> servers,
        Dictionary<string, Ellipse> health,
        Dictionary<string, bool> known,
        CancellationToken token)
    {
        if (servers.Count == 0) return;
        var client = new ServerAccessClient(_http);
        try
        {
            while (!token.IsCancellationRequested && !_closed)
            {
                await Task.WhenAll(servers.Select(async server =>
                {
                    var alive = false;
                    try
                    {
                        await client.DescribeAsync(ServerEndpoint.Parse(server.Url), token);
                        alive = true;
                    }
                    catch (OperationCanceledException) { return; }
                    catch (Exception e) when (e is HttpRequestException or InvalidDataException or ArgumentException or System.Text.Json.JsonException) { }
                    if (_closed) return;
                    known[server.Url] = alive;
                    if (health.TryGetValue(server.Url, out var dot)) dot.Fill = new SolidColorBrush(alive ? Alive : Dead);
                }));
                await Task.Delay(Recheck, token);
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>
    /// Add or change one server. It writes the entry down and nothing more: connecting is the
    /// picker's job, and an address can be saved while the server behind it is still being set
    /// up. Returns the origin that was written, so the picker can select it.
    /// </summary>
    private async Task<string?> EditServerAsync(ServerEntry? entry)
    {
        var servers = (_settings.Servers ?? []).ToList();
        var address = new TextBox { Header = "Адрес сервера", Text = entry?.Url ?? "", PlaceholderText = "https://meet.example.com", IsSpellCheckEnabled = false };
        var label = new TextBox { Header = "Название сервера", Text = entry?.Name ?? "", PlaceholderText = "Как называть его в списке", MaxLength = 60 };
        var password = new PasswordBox { Header = "Пароль", MaxLength = 200, PlaceholderText = "Если сервер закрыт паролем" };
        if (entry is not null)
            password.Password = await _profiles.GetPasswordAsync(ServerEndpoint.Parse(entry.Url), _lifetime.Token);
        var automatic = new CheckBox { Content = "Подключаться автоматически при запуске", IsChecked = entry?.AutoConnect != false };
        var error = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = new SolidColorBrush(Dead) };
        var content = new StackPanel { Spacing = 14, MinWidth = 380 };
        content.Children.Add(label);
        content.Children.Add(address);
        content.Children.Add(password);
        content.Children.Add(automatic);
        content.Children.Add(error);
        content.Children.Add(Note("Проверять сейчас ничего не нужно: подключение произойдёт, когда вы выберете сервер в списке."));

        // The active server has to stay in the list: removing the ground you are standing on
        // would leave the application with nowhere to go.
        var removable = entry is not null && entry.Url != ServerEndpoint.Parse(_settings.ServerUrl).Origin.AbsoluteUri;
        var dialog = new ContentDialog
        {
            Title = entry is null ? "Новый сервер" : "Сервер",
            Content = content,
            PrimaryButtonText = entry is null ? "Добавить" : "Сохранить",
            SecondaryButtonText = removable ? "Удалить" : "",
            CloseButtonText = "Закрыть",
            DefaultButton = ContentDialogButton.Primary,
        };
        dialog.PrimaryButtonClick += (_, args) =>
        {
            try { ServerEndpoint.Parse(address.Text); }
            catch (ArgumentException e) { error.Text = e.Message.Split(" (Parameter")[0]; args.Cancel = true; }
        };
        var outcome = await DialogAsync(dialog);
        if (outcome == ContentDialogResult.Secondary && entry is not null)
        {
            _settings = _settings with { Servers = ServerList.Remove(servers, entry.Url) };
            await _profiles.SaveAsync(_settings, _lifetime.Token);
            await _profiles.SavePasswordAsync(ServerEndpoint.Parse(entry.Url), "", _lifetime.Token);
            return null;
        }
        if (outcome != ContentDialogResult.Primary) return null;
        var endpoint = ServerEndpoint.Parse(address.Text);
        // Renaming an entry to a different address leaves the old one behind, which would be a
        // duplicate of a server nobody asked to keep.
        if (entry is not null && entry.Url != endpoint.Origin.AbsoluteUri)
            servers = ServerList.Remove(servers, entry.Url).ToList();
        _settings = _settings with
        {
            Servers = ServerList.Add(servers, endpoint.Origin.AbsoluteUri, label.Text, automatic.IsChecked == true),
        };
        await _profiles.SaveAsync(_settings, _lifetime.Token);
        await _profiles.SavePasswordAsync(endpoint, password.Password, _lifetime.Token);
        return endpoint.Origin.AbsoluteUri;
    }

    /// <summary>Moves the application onto a server: saves it, then reopens the workspace there.</summary>
    private async Task<bool> ApplyServerAsync(ServerEntry entry, string password, bool automatic, ServerSession session)
    {
        var endpoint = ServerEndpoint.Parse(entry.Url);
        var changed = _workspace is not null && _workspace.Endpoint.Origin.AbsoluteUri != endpoint.Origin.AbsoluteUri;
        if (changed && Model.InCall && !await ConfirmLeaveAsync()) return false;
        if (changed && Model.InCall) await LeaveWebAsync();
        _session = session;
        _password = password;
        _settings = _settings with
        {
            ServerUrl = endpoint.Origin.AbsoluteUri,
            Servers = ServerList.Add(_settings.Servers ?? [], endpoint.Origin.AbsoluteUri, entry.Name, automatic),
        };
        await _profiles.SaveAsync(_settings, _lifetime.Token);
        await _profiles.SavePasswordAsync(endpoint, password, _lifetime.Token);
        if (changed)
        {
            Model.InCall = false;
            Model.ReplaceFavorites([]);
            await OpenWorkspaceAsync();
        }
        else if (_workspace is not null) PostSession();
        return true;
    }

    /// <summary>A server with no door has nothing to hand over, and an empty pass is not one.</summary>
    private void PostSession()
    {
        if (_session is not { Token.Length: > 0 }) return;
        _workspace?.Post(new("session.token", Token: _session.Token, ExpiresAt: _session.ExpiresAt, ServerName: _session.Name));
    }

    /// <summary>
    /// A lapsed session is repaired here, with the password Windows is keeping for us, and the
    /// page is handed the new one. It never learns the password and never has to ask for it.
    /// </summary>
    private async Task RenewSessionAsync()
    {
        if (_renewing || _closed || _workspace is null) return;
        _renewing = true;
        try
        {
            var result = await new ServerAccessClient(_http).TryConnectAsync(_workspace.Endpoint.Origin.AbsoluteUri, _password, _lifetime.Token);
            if (result is { Ok: true, Session: { } session })
            {
                _session = session;
                if (_workspace is not null) _workspace.Session = session;
                PostSession();
            }
            else if (!Model.InCall) Model.Report(result.Detail);
        }
        finally { _renewing = false; }
    }

    private static string Host(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.Authority : url;

    /// <summary>
    /// Shows the profile picture the page sent with its state.
    ///
    /// <para>The picture is the page's: it is stored there, per server, and sent to the room
    /// from there. The shell keeps no copy and owns no second way to change it — it decodes the
    /// data URI it was given, once per distinct value, and shows it. A picture in a format this
    /// Windows cannot decode simply leaves the placeholder in place.</para>
    /// </summary>
    private async void ShowAvatar(string dataUri)
    {
        if (dataUri == _avatar) return;
        _avatar = dataUri;
        var comma = dataUri.IndexOf(',');
        if (comma < 0 || !dataUri.StartsWith("data:image/", StringComparison.Ordinal) || !dataUri[..comma].EndsWith(";base64", StringComparison.Ordinal))
        {
            Model.Avatar = null;
            return;
        }
        try
        {
            var bytes = Convert.FromBase64String(dataUri[(comma + 1)..]);
            using var stream = new global::Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.AsBuffer(bytes));
            stream.Seek(0);
            var image = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage { DecodePixelWidth = 72, DecodePixelHeight = 72 };
            // A format Windows has no codec for fails here rather than throwing, and the
            // placeholder is the right answer to that.
            image.ImageFailed += (_, _) => { if (!_closed && _avatar == dataUri) Model.Avatar = null; };
            await image.SetSourceAsync(stream);
            if (!_closed && _avatar == dataUri) Model.Avatar = image;
        }
        catch (Exception e) when (e is FormatException or ArgumentException or System.Runtime.InteropServices.COMException)
        {
            if (_avatar == dataUri) Model.Avatar = null;
        }
    }

    /// <summary>Opens the settings, which are the page's — see <see cref="Settings_Click"/>.</summary>
    private Task OpenSettingsAsync()
    {
        _workspace?.Post(new("settings.open", Tab: "audio"));
        return Task.CompletedTask;
    }

    /// <summary>
    /// Secondary text is dimmed, not coloured.
    ///
    /// <para>The obvious way — <c>Application.Current.Resources["TextFillColorSecondaryBrush"]</c>
    /// — resolves the theme dictionaries against the <em>application's</em> theme, while these
    /// dialogs render with the theme chosen inside Cord. When the two disagree it hands back the
    /// light brush for a dark dialog, which is black text on black. Opacity inherits whatever
    /// foreground the element tree actually has, so it has nothing to disagree with.</para>
    /// </summary>
    private const double Muted = 0.72;
    private const double Faint = 0.58;
    private static void Neutral(TextBlock text)
    {
        text.ClearValue(TextBlock.ForegroundProperty);
        text.Opacity = Muted;
    }
    /// <summary>Как часто перепроверять серверы, пока открыто окно подключения.</summary>
    private static readonly TimeSpan Recheck = TimeSpan.FromSeconds(5);
    /// <summary>Fixed colours, readable on both themes, for states that mean the same in both.</summary>
    private static readonly global::Windows.UI.Color Alive = global::Windows.UI.Color.FromArgb(255, 54, 178, 118);
    private static readonly global::Windows.UI.Color Dead = global::Windows.UI.Color.FromArgb(255, 226, 92, 92);
    private static readonly global::Windows.UI.Color Unknown = global::Windows.UI.Color.FromArgb(255, 140, 146, 160);

    private static TextBlock Group(string title) => new()
    {
        Text = title.ToUpperInvariant(),
        FontSize = 11,
        CharacterSpacing = 90,
        Margin = new Thickness(0, 12, 0, 0),
        FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
        Opacity = Muted,
    };
    private static TextBlock Note(string text) => new()
    {
        Text = text,
        TextWrapping = TextWrapping.Wrap,
        FontSize = 12,
        Opacity = Faint,
    };
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
        _updateTimer?.Dispose(); _updater?.Dispose(); Notifications.Release();
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
            foreach (var (text, action) in new (string, Func<Task>)[] { ("Главная", () => NavigateAsync("home")), ("Новая встреча", () => NavigateAsync("create")), ("Настройки", OpenSettingsAsync), ("Серверы", () => ShowServersAsync()) })
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
    /// <summary>Что оболочка знает про обновление — в том виде, в каком это покажет страница.</summary>
    private void PostUpdateStatus() =>
        _workspace?.Post(new("update.status", Name: ApplicationUpdater.DisplayVersion, Detail: Model.UpdateStatus, Available: Model.UpdateAvailable));

    private async Task CheckUpdateAsync()
    {
        if (_updater is null || Model.UpdateBusy || _closed) return;
        try
        {
            await _updater.CheckAsync(_lifetime.Token);
            Model.UpdateAvailable = _updater.Available is not null;
            if (Model.UpdateAvailable)
            {
                Model.UpdateButton = "Обновить";
                Model.UpdateStatus = "Доступна версия " + _updater.Available!.Version;
                // Проверка идёт раз в шесть часов, в том числе когда окно свёрнуто, и строка
                // в боковой панели в этот момент никому не видна. Уведомление показывается
                // один раз на версию: напоминать о том же самом каждые шесть часов — травля.
                if (_announcedUpdate != _updater.Available.Version)
                {
                    _announcedUpdate = _updater.Available.Version;
                    Notifications.Activated = () => DispatcherQueue.TryEnqueue(Activate);
                    Notifications.Announce("Обновление Cord", $"Доступна версия {_updater.Available.Version}. Откройте Cord, чтобы установить.");
                }
            }
            else Model.UpdateStatus = "Установлена последняя версия";
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
    private void CheckUpdate_Click(object sender, RoutedEventArgs e) =>
        Run(async () =>
        {
            Model.UpdateStatus = "Проверяем обновления…";
            await CheckUpdateAsync();
            PostUpdateStatus();
        });
    private void FavoriteSettings_Click(object sender, RoutedEventArgs e) { if (sender is Button { Tag: string id }) _workspace?.Post(new("favorite.settings", RoomId: id)); }
    private void Home_Click(object sender, RoutedEventArgs e) => Run(() => NavigateAsync("home"));
    private void Create_Click(object sender, RoutedEventArgs e) => Run(() => NavigateAsync("create"));
    private void Favorite_Click(object sender, RoutedEventArgs e) { if (sender is Button { Tag: string id }) Run(() => NavigateAsync("favorite", id)); }
    private void Refresh_Click(object sender, RoutedEventArgs e) => Run(RefreshFavoritesAsync);
    /// <summary>
    /// Settings are the page's, all of them.
    ///
    /// <para>There used to be a second, native settings dialog here holding a copy of the name,
    /// two switches and the theme — a smaller screen next to the real one, which knew nothing
    /// about devices, sound processing, video quality, keys or diagnostics. Both entries now
    /// open the settings that have all of it; the sidebar button lands on sound, the profile
    /// block on the profile, because that is where the picture is.</para>
    /// </summary>
    private void Settings_Click(object sender, RoutedEventArgs e) => _workspace?.Post(new("settings.open", Tab: "audio"));
    private void Profile_Click(object sender, RoutedEventArgs e) => _workspace?.Post(new("settings.open", Tab: "profile"));
    private void Servers_Click(object sender, RoutedEventArgs e) => Run(() => ShowServersAsync());
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
