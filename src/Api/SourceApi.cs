using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading.Tasks;

namespace Content.Editor.Editor;

internal sealed partial class ApiRouter
{
    private async Task HandleOpenInExplorerAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var ctx = ScopedCtx;
        var relPath = req.QueryString["path"];
        if (string.IsNullOrEmpty(relPath))
        {
            await HttpJson.WriteErrorAsync(res, 400, "Missing 'path' query parameter");
            return;
        }
        var fullPath = PathSecurity.Resolve(ctx.PrototypesDir, relPath);
        if (fullPath == null)
        {
            await HttpJson.WriteErrorAsync(res, 403, "Access denied");
            return;
        }
        var target = File.Exists(fullPath) ? fullPath : Path.GetDirectoryName(fullPath) ?? fullPath;
        try
        {
            if (OperatingSystem.IsWindows())
                Process.Start("explorer.exe", $"/select,\"{target}\"");
            else if (OperatingSystem.IsMacOS())
                Process.Start("open", $"-R \"{target}\"");
            else
                Process.Start("xdg-open", Path.GetDirectoryName(target) ?? target);
        }
        catch (Exception ex)
        {
            await HttpJson.WriteErrorAsync(res, 500, $"Failed to open file manager: {ex.Message}");
            return;
        }
        await HttpJson.WriteAsync(res, new { success = true });
    }

    private async Task HandleOpenDefaultAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var ctx = ScopedCtx;
        var relPath = req.QueryString["path"];
        if (string.IsNullOrEmpty(relPath))
        {
            await HttpJson.WriteErrorAsync(res, 400, "Missing 'path' query parameter");
            return;
        }
        var fullPath = PathSecurity.Resolve(ctx.PrototypesDir, relPath);
        if (fullPath == null)
        {
            await HttpJson.WriteErrorAsync(res, 403, "Access denied");
            return;
        }
        if (!File.Exists(fullPath))
        {
            await HttpJson.WriteErrorAsync(res, 404, "File not found");
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo { FileName = fullPath, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            await HttpJson.WriteErrorAsync(res, 500, $"Failed to open file: {ex.Message}");
            return;
        }
        await HttpJson.WriteAsync(res, new { success = true });
    }

    private async Task HandleOpenSourceAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var ctx = ScopedCtx;
        var className = req.QueryString["class"];
        if (string.IsNullOrEmpty(className))
        {
            await HttpJson.WriteErrorAsync(res, 400, "Missing 'class' query parameter");
            return;
        }
        var found = ctx.SourceLocator.Find(className);
        if (found == null)
        {
            await HttpJson.WriteErrorAsync(res, 404, "Source file not found");
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo { FileName = found, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            await HttpJson.WriteErrorAsync(res, 500, $"Failed to open source: {ex.Message}");
            return;
        }
        await HttpJson.WriteAsync(res, new { success = true, path = found });
    }
}
