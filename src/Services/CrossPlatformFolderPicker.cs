using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.Versioning;

namespace Content.Editor.Editor;

/// <summary>
/// OS-agnostic folder picker. Delegates to the modern Vista+ IFileOpenDialog
/// on Windows, and shells out to `zenity` / `kdialog` on Linux or `osascript`
/// on macOS. Returns null on user-cancel or when no graphical picker is
/// available (in which case the WebUI falls back to the manual-entry field).
/// </summary>
internal static class CrossPlatformFolderPicker
{
    public static string? Pick(string title)
    {
        if (OperatingSystem.IsWindows())
            return PickWindows(title);
        if (OperatingSystem.IsLinux())
            return PickLinux(title);
        if (OperatingSystem.IsMacOS())
            return PickMacOs(title);
        return null;
    }

    [SupportedOSPlatform("windows")]
    private static string? PickWindows(string title) => ModernFolderPicker.Pick(title);

    private static string? PickLinux(string title)
    {
        // zenity --file-selection --directory --title="..."
        var z = TryRun("zenity", $"--file-selection --directory --title={ShellQuote(title)}");
        if (z is not null) return z;
        // kdialog --getexistingdirectory ~ --title "..."
        var k = TryRun("kdialog", $"--getexistingdirectory ~ --title {ShellQuote(title)}");
        return k;
    }

    private static string? PickMacOs(string title)
    {
        var script = $"POSIX path of (choose folder with prompt \"{title.Replace("\"", "\\\"")}\")";
        return TryRun("osascript", $"-e {ShellQuote(script)}");
    }

    private static string? TryRun(string exe, string args)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = args,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            if (p is null) return null;
            var stdout = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            if (p.ExitCode != 0) return null;
            var path = stdout.Trim();
            return string.IsNullOrEmpty(path) ? null : path;
        }
        catch (Exception)
        {
            // exe not on PATH, permission denied, etc.
            return null;
        }
    }

    private static string ShellQuote(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}
