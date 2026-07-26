# Низкоуровневый клавиатурный хук (WH_KEYBOARD_LL) для глобального push-to-talk
# на ПРАВЫЙ Shift (VK_RSHIFT=0xA1). Клавишу НЕ глотаем — всегда CallNextHookEx.
# Печатает в stdout: HOOK_READY при старте, RSHIFT_DOWN / RSHIFT_UP по событиям.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class RShiftHook
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN     = 0x0100;
    private const int WM_KEYUP       = 0x0101;
    private const int WM_SYSKEYDOWN  = 0x0104;
    private const int WM_SYSKEYUP    = 0x0105;
    private const int VK_RSHIFT      = 0xA1;

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    // Делегат держим в static-поле — иначе GC соберёт его и хук упадёт.
    private static LowLevelKeyboardProc _proc = HookCallback;
    private static IntPtr _hookID = IntPtr.Zero;
    private static bool _isDown = false;

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            if (data.vkCode == VK_RSHIFT)
            {
                int msg = (int)wParam;
                if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
                {
                    if (!_isDown)
                    {
                        _isDown = true;
                        Console.Out.WriteLine("RSHIFT_DOWN");
                        Console.Out.Flush();
                    }
                }
                else if (msg == WM_KEYUP || msg == WM_SYSKEYUP)
                {
                    _isDown = false;
                    Console.Out.WriteLine("RSHIFT_UP");
                    Console.Out.Flush();
                }
            }
        }
        // Клавишу НЕ глотаем — пропускаем дальше по цепочке.
        return CallNextHookEx(_hookID, nCode, wParam, lParam);
    }

    public static void Install()
    {
        _hookID = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
        if (_hookID == IntPtr.Zero)
        {
            throw new Exception("SetWindowsHookEx failed: " + Marshal.GetLastWin32Error());
        }
    }

    public static void Uninstall()
    {
        if (_hookID != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_hookID);
            _hookID = IntPtr.Zero;
        }
    }
}
'@

[RShiftHook]::Install()

# LL-хуку нужен message pump на установившем потоке — без него колбэк не зовётся.
Add-Type -AssemblyName System.Windows.Forms

Write-Output "HOOK_READY"
[Console]::Out.Flush()

try {
    [System.Windows.Forms.Application]::Run()
}
finally {
    [RShiftHook]::Uninstall()
}
