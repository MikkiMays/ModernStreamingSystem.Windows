namespace Cord.Core;

public sealed record MicrophoneHotkey(string Code, bool Ctrl, bool Alt, bool Shift, bool Meta)
{
    public bool IsValid => Code is not null && (Code.Length == 4 && Code.StartsWith("Key", StringComparison.Ordinal) && Code[3] is >= 'A' and <= 'Z'
        || Code.Length == 6 && Code.StartsWith("Digit", StringComparison.Ordinal) && Code[5] is >= '0' and <= '9'
        || Code == "Space" || Code.StartsWith('F') && int.TryParse(Code.AsSpan(1), out var number) && number is >= 1 and <= 24);

    public bool TryNative(out uint modifiers, out uint virtualKey)
    {
        modifiers = (Alt ? 1u : 0u) | (Ctrl ? 2u : 0u) | (Shift ? 4u : 0u) | 0x4000u;
        virtualKey = 0;
        if (!IsValid || Meta || Code == "F12" || (!Ctrl && !Alt)) return false;
        virtualKey = Code.StartsWith("Key", StringComparison.Ordinal) ? Code[3]
            : Code.StartsWith("Digit", StringComparison.Ordinal) ? Code[5]
            : Code == "Space" ? 0x20u : (uint)(0x70 + int.Parse(Code.AsSpan(1)) - 1);
        return true;
    }
}
