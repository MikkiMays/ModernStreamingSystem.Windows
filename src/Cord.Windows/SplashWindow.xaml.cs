using System.Runtime.InteropServices;
using Cord.Core;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation.Peers;

namespace Cord.Windows;

/// <summary>
/// Заставка при запуске (T58), как у Discord: маленькое тёмное окно без рамки по центру экрана —
/// знак Cord и одна строка. Она проверяет, скачивает и ставит обновление; главное окно
/// открывается, только когда ставить нечего, спросить не удалось или человек выбрал «Открыть
/// Cord» после сбоя. Шаги и их порядок — в <see cref="ForcedUpdate.SplashAsync"/>, здесь только окно.
/// </summary>
public sealed partial class SplashWindow : Window
{
    /// <summary>Размер в единицах интерфейса, как у заставки Discord; в пиксели — по масштабу экрана.</summary>
    private const int LogicalWidth = 300;
    private const int LogicalHeight = 360;
    private readonly CancellationTokenSource _lifetime = new();
    /// <summary>Ответ на сбой: true — «Повторить», false — «Открыть Cord».</summary>
    private TaskCompletionSource<bool>? _choice;
    private SplashStage? _stage;
    /// <summary>На экране сбой: запоздалые проценты прошлой попытки его не перекрывают.</summary>
    private bool _failed;
    private bool _closed;

    /// <param name="display">Где показать: при перезапуске ради обновления — там же, где было главное окно.</param>
    public SplashWindow(DisplayArea? display = null, bool validateResourcesOnly = false)
    {
        InitializeComponent();
        if (validateResourcesOnly) return;
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "Cord.ico"));
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.IsResizable = false;
            presenter.IsMaximizable = false;
            presenter.IsMinimizable = false;
            presenter.SetBorderAndTitleBar(false, false);
        }
        var workArea = (display ?? DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Nearest)).WorkArea;
        var scale = Scale(workArea);
        var width = Math.Min(workArea.Width, (int)Math.Round(LogicalWidth * scale));
        var height = Math.Min(workArea.Height, (int)Math.Round(LogicalHeight * scale));
        AppWindow.MoveAndResize(new global::Windows.Graphics.RectInt32(workArea.X + (workArea.Width - width) / 2, workArea.Y + (workArea.Height - height) / 2, width, height));
        // Окно без рамки Windows 11 сама не скругляет — просим. Windows 10 углов не знает и молча откажет.
        var round = RoundCorners;
        _ = DwmSetWindowAttribute(WinRT.Interop.WindowNative.GetWindowHandle(this), CornerPreference, ref round, sizeof(int));
        Closed += (_, _) =>
        {
            _closed = true;
            _lifetime.Cancel();
            _choice?.TrySetResult(false);
        };
    }

    /// <summary>
    /// Заставка от начала до конца. Возвращает, с чем открыть Cord, или null — Cord закрывается:
    /// помощник ставит обновление, или заставку закрыли.
    /// </summary>
    public async Task<SplashResult?> RunAsync(IUpdateSteps updater, string profileRoot)
    {
        while (!_closed)
        {
            SplashResult result;
            try { result = await ForcedUpdate.SplashAsync(updater, new Progress<SplashState>(Show), _lifetime.Token); }
            catch (OperationCanceledException) when (_closed) { return null; }
            catch (Exception e)
            {
                // Что бы ни сломалось в заставке, запереть человека она не может: Cord открывается
                // в этой версии и спросит зеркало снова, а причина остаётся в last-error.txt.
                await RecordErrorAsync(profileRoot, e);
                return _closed ? null : new(SplashOutcome.OpenCord, UpdateVerdict.Unavailable);
            }
            if (result.Error is { } error) await RecordErrorAsync(profileRoot, error);
            if (_closed || result.Outcome == SplashOutcome.Restarting) return null;
            if (result.Outcome == SplashOutcome.OpenCord) return result;
            if (!await ChooseAsync(result.Problem)) return _closed ? null : result;
        }
        return null;
    }

    private void Show(SplashState state)
    {
        if (_failed || _closed) return;
        Status.Text = state.Text;
        Bar.IsIndeterminate = state.Stage != SplashStage.Downloading;
        Bar.Value = state.Percent;
        Bar.Visibility = Visibility.Visible;
        // Экранному диктору — смена шага, а не каждый процент.
        if (_stage != state.Stage) Announce();
        _stage = state.Stage;
    }

    /// <summary>Сбой: причина вместо строки, «Повторить» и «Открыть Cord». Возвращает, повторить ли.</summary>
    private async Task<bool> ChooseAsync(string problem)
    {
        _failed = true;
        _stage = SplashStage.Failed;
        Status.Text = problem;
        Bar.Visibility = Visibility.Collapsed;
        Choice.Visibility = Visibility.Visible;
        Retry.Focus(FocusState.Programmatic);
        Announce();
        _choice = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var retry = await _choice.Task;
        _choice = null;
        if (_closed) return false;
        _failed = false;
        Choice.Visibility = Visibility.Collapsed;
        return retry;
    }

    private void Announce() => FrameworkElementAutomationPeer.FromElement(Status)?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);

    private void Retry_Click(object sender, RoutedEventArgs e) => _choice?.TrySetResult(true);
    private void Open_Click(object sender, RoutedEventArgs e) => _choice?.TrySetResult(false);

    private static async Task RecordErrorAsync(string profileRoot, Exception e)
    {
        try { await File.WriteAllTextAsync(Path.Combine(profileRoot, "last-error.txt"), $"{e.GetType().FullName}\n0x{e.HResult:X8}\n{e.StackTrace}"); }
        catch (Exception logging) when (logging is IOException or UnauthorizedAccessException) { /* Журнал не должен ронять заставку. */ }
    }

    /// <summary>Масштаб экрана, на котором окажется заставка: 1 при 96 dpi.</summary>
    private static double Scale(global::Windows.Graphics.RectInt32 workArea)
    {
        var monitor = MonitorFromPoint(new NativePoint { X = workArea.X + workArea.Width / 2, Y = workArea.Y + workArea.Height / 2 }, NearestMonitor);
        return monitor != 0 && GetDpiForMonitor(monitor, EffectiveDpi, out var dpi, out _) == 0 && dpi > 0 ? dpi / 96.0 : 1;
    }

    private const int CornerPreference = 33; // DWMWA_WINDOW_CORNER_PREFERENCE
    private const int RoundCorners = 2; // DWMWCP_ROUND
    private const uint NearestMonitor = 2; // MONITOR_DEFAULTTONEAREST
    private const int EffectiveDpi = 0; // MDT_EFFECTIVE_DPI
    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(nint window, int attribute, ref int value, int size);
    [DllImport("user32.dll")]
    private static extern nint MonitorFromPoint(NativePoint point, uint flags);
    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(nint monitor, int type, out uint dpiX, out uint dpiY);
}
