using Microsoft.UI.Xaml;

namespace Cord.Windows;

public partial class App : Application
{
    private Window? _window;
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
            _window = new MainWindow(verifyResources);
            if (verifyResources)
            {
                _window.Close();
                Exit();
                return;
            }
            _window.Activate();
            if (verifyService.Length > 0)
            {
                await ((MainWindow)_window).VerifyServiceAsync(verifyService);
                _window.Close();
                Exit();
            }
        }
        catch (Exception error)
        {
            ReportStartupFailure(error);
            if (verifyResources || verifyService.Length > 0) Environment.Exit(1);
            throw;
        }
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
