using System.Runtime.InteropServices;
using Cord.Core;

namespace Cord.Windows.Services;

/// <summary>Registered only during calls; never intercepts arbitrary keyboard input.</summary>
public sealed class GlobalMicrophoneHotkey : IDisposable
{
    private const int Identifier = 0x434f;
    private readonly nint _window;
    private readonly SubclassProc _callback;
    private readonly Action _toggle;
    private bool _disposed;
    private bool _hooked;

    public GlobalMicrophoneHotkey(nint window, Action toggle)
    {
        _window = window;
        _toggle = toggle;
        _callback = Receive;
        _hooked = SetWindowSubclass(window, _callback, Identifier, 0);
    }
    public string Configure(MicrophoneHotkey? key)
    {
        if (_disposed) return "Сочетание отключено";
        UnregisterHotKey(_window, Identifier);
        if (key is null) return "Сочетание отключено";
        if (!key.TryNative(out var modifiers, out var virtualKey)) return "Работает в окне встречи. Для работы поверх других программ добавьте Ctrl или Alt; клавиши Windows и F12 зарезервированы системой.";
        return _hooked && RegisterHotKey(_window, Identifier, modifiers, virtualKey)
            ? "Работает и поверх других программ во время встречи."
            : "Сочетание занято другой программой. В окне встречи оно доступно; выберите другое для работы в фоне.";
    }
    private nint Receive(nint window, uint message, nuint wParam, nint lParam, nuint subclassId, nuint reference)
    {
        if (message == 0x0312 && wParam == Identifier && !_disposed)
        {
            _toggle();
            return 0;
        }
        return DefSubclassProc(window, message, wParam, lParam);
    }
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        UnregisterHotKey(_window, Identifier);
        if (_hooked) RemoveWindowSubclass(_window, _callback, Identifier);
        _hooked = false;
        GC.KeepAlive(_callback);
    }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate nint SubclassProc(nint window, uint message, nuint wParam, nint lParam, nuint subclassId, nuint reference);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint virtualKey);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnregisterHotKey(nint window, int id);
    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowSubclass(nint window, SubclassProc callback, nuint id, nuint reference);
    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RemoveWindowSubclass(nint window, SubclassProc callback, nuint id);
    [DllImport("comctl32.dll")]
    private static extern nint DefSubclassProc(nint window, uint message, nuint wParam, nint lParam);
}
