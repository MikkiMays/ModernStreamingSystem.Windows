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
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        var verifyResources = Environment.GetCommandLineArgs().Contains("--verify-resources", StringComparer.Ordinal);
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
        }
        catch (Exception error)
        {
            ReportStartupFailure(error);
            if (verifyResources) Environment.Exit(1);
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
