using Cord.Windows.Services;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;

namespace Cord.Windows;

public partial class App : Application
{
    private Window? _window;
    /// <summary>Один на всё приложение: его делят заставка и главное окно, и он переживает их обоих.</summary>
    private ApplicationUpdater? _updater;
    private string _profileRoot = "";
    public App()
    {
        InitializeComponent();
        UnhandledException += (_, args) => { if (_window is null) ReportStartupFailure(args.Exception); };
    }
    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        var arguments = Environment.GetCommandLineArgs();
        var verifyResources = arguments.Contains("--verify-resources", StringComparer.Ordinal);
        // Адрес приёмки идёт следом за ключом: сервера по умолчанию у Cord нет, и проверке
        // выпуска его называют снаружи — как и всякому другому запуску.
        var service = Array.IndexOf(arguments, "--verify-service");
        var verifyService = service >= 0 && service + 1 < arguments.Length ? arguments[service + 1] : "";
        try
        {
            if (verifyResources)
            {
                // Из публикации обязаны загрузиться обе разметки: заставки и главного окна.
                var splash = new SplashWindow(validateResourcesOnly: true);
                _window = new MainWindow(validateResourcesOnly: true);
                splash.Close();
                _window.Close();
                Exit();
                return;
            }
            _profileRoot = new ProfileStore().Root;
            _updater = new ApplicationUpdater(_profileRoot);
            // Приёмка выпуска идёт тем же путём, что и любой запуск: заставка, потом окно. Копия
            // из публикации не установлена, поэтому заставка сразу уступает место окну.
            var main = await SplashThenMainAsync();
            if (verifyService.Length == 0) return;
            if (main is null) throw new InvalidOperationException("The splash did not open the main window.");
            await main.VerifyServiceAsync(verifyService);
            main.Close();
            Exit();
        }
        catch (Exception error)
        {
            ReportStartupFailure(error);
            if (verifyResources || verifyService.Length > 0) Environment.Exit(1);
            throw;
        }
    }

    /// <summary>
    /// Пока Cord открыт, нашлось обновление, а встречи нет (T58): главное окно уступает место
    /// заставке, и дальше всё как при запуске.
    /// </summary>
    public async void RestartIntoSplash(MainWindow main)
    {
        try { await SplashThenMainAsync(DisplayArea.GetFromWindowId(main.AppWindow.Id, DisplayAreaFallback.Nearest), main.CloseForUpdate); }
        catch (Exception error)
        {
            ReportStartupFailure(error);
            Exit();
        }
    }

    /// <summary>
    /// Сначала заставка (T58), как у Discord: проверка, загрузка, установка. Главное окно и
    /// WebView2 создаются только после неё — когда ставить нечего, спросить не удалось или человек
    /// выбрал «Открыть Cord» после сбоя. Помощник ставит обновление или заставку закрыли — Cord
    /// завершается, и новая версия откроется сама.
    ///
    /// <para>Окна сменяют друг друга внахлёст: новое появляется раньше, чем закрывается прежнее.
    /// Закрытое последнее окно завершает приложение.</para>
    /// </summary>
    /// <param name="display">Где показать заставку: там же, где было главное окно.</param>
    /// <param name="leave">Закрыть прежнее главное окно — когда заставка уже на экране.</param>
    private async Task<MainWindow?> SplashThenMainAsync(DisplayArea? display = null, Action? leave = null)
    {
        var splash = new SplashWindow(display);
        _window = splash;
        splash.Activate();
        leave?.Invoke();
        var result = await splash.RunAsync(_updater!, _profileRoot);
        if (result is null)
        {
            Exit();
            return null;
        }
        var main = new MainWindow(_updater, result);
        _window = main;
        main.Activate();
        splash.Close();
        return main;
    }

    private static void ReportStartupFailure(Exception error)
    {
        try
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cord");
            Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, "startup-error.txt"), $"{error.GetType().FullName}\n0x{error.HResult:X8}\n{error.StackTrace}");
        }
        catch (Exception loggingError) when (loggingError is IOException or UnauthorizedAccessException) { }
    }
}
