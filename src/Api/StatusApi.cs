using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading.Tasks;

namespace Content.Editor.Editor;

internal sealed partial class ApiRouter
{
    private Task HandleStatusAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion ?? "0.0.0-dev";
        // Strip SourceLink build metadata (e.g. +abc1234)
        var plus = version.IndexOf('+');
        if (plus >= 0) version = version[..plus];

        var ctx = _ctx;
        if (ctx == null)
            return HttpJson.WriteAsync(res, new { configured = false, version });

        return HttpJson.WriteAsync(res, new
        {
            configured = true,
            version,
            projectPath = ctx.SolutionRoot,
            prototypes = ctx.ProtoIndex.TotalCount,
            typeCount = ctx.ProtoIndex.TypeCount,
        });
    }

    private async Task HandleConfigureAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var doc = await HttpJson.ReadBodyAsync(req);
        if (!doc.TryGetProperty("projectPath", out var pathEl))
        {
            await HttpJson.WriteErrorAsync(res, 400, "Missing 'projectPath'");
            return;
        }

        var projectPath = pathEl.GetString()?.Trim();
        if (string.IsNullOrEmpty(projectPath) || !Directory.Exists(projectPath))
        {
            await HttpJson.WriteErrorAsync(res, 400, "Directory not found");
            return;
        }

        var prototypesDir = Path.Combine(projectPath, "Resources", "Prototypes");
        if (!Directory.Exists(prototypesDir))
        {
            await HttpJson.WriteErrorAsync(res, 400,
                "Not a valid SS14 project: Resources/Prototypes folder not found. " +
                "Make sure you selected the project root (the folder containing Resources/, Content.Server/, etc.).");
            return;
        }

        var binServer = Path.Combine(projectPath, "bin", "Content.Server");
        var binClient = Path.Combine(projectPath, "bin", "Content.Client");
        if (!Directory.Exists(binServer) && !Directory.Exists(binClient))
        {
            await HttpJson.WriteErrorAsync(res, 400,
                "Project has not been built yet. Run 'dotnet build' in the project folder first, then try again.");
            return;
        }

        // Serialize the heavy work and offload it from the HttpListener thread
        // so the UI doesn't time out and a second configure can't race us.
        await _configureGate.WaitAsync();
        EditorContext? newCtx = null;
        try
        {
            await Task.Run(() =>
            {
                Logger.Info($"Extracting metadata for: {projectPath}");
                MetadataExtractor.Extract(projectPath, EditorServer.ProjectDataDir(projectPath));

                newCtx = EditorServer.BuildContext(projectPath);
                var captured = newCtx;
                captured.FileWatcher.Changed += evt =>
                {
                    var rel = evt.RelativePath;
                    switch (evt.Kind)
                    {
                        case FileChangeKind.Deleted:
                            captured.ProtoIndex.RefreshFile(evt.FullPath, rel);
                            captured.InvalidateTree();
                            captured.Events.Broadcast(new { type = "tree-change" });
                            break;
                        case FileChangeKind.Created:
                            captured.InvalidateTree();
                            captured.Events.Broadcast(new { type = "tree-change" });
                            if (File.Exists(evt.FullPath))
                                captured.ProtoIndex.RefreshFile(evt.FullPath, rel);
                            break;
                        case FileChangeKind.Changed:
                            // Content change doesn't move/add/remove tree nodes,
                            // only re-scan the index for that file.
                            if (File.Exists(evt.FullPath))
                                captured.ProtoIndex.RefreshFile(evt.FullPath, rel);
                            break;
                    }
                    captured.Events.Broadcast(new { type = "file-change", kind = evt.Kind.ToString().ToLowerInvariant(), path = rel });
                };

                Logger.Info("Building prototype index...");
                captured.ProtoIndex.Rebuild();
                Logger.Info($"Indexed {captured.ProtoIndex.TotalCount} prototypes across {captured.ProtoIndex.TypeCount} types");
                captured.FileWatcher.Start();
            });
        }
        catch (Exception ex)
        {
            newCtx?.Dispose();
            _configureGate.Release();
            await HttpJson.WriteErrorAsync(res, 500, $"Failed to configure project: {ex.Message}");
            return;
        }

        // Atomic swap; old context is disposed when its lease count drops to zero.
        SwapContext(newCtx);
        _configureGate.Release();

        Logger.Info($"Project configured: {projectPath}");
        await HttpJson.WriteAsync(res, new
        {
            success = true,
            projectPath,
            prototypes = newCtx!.ProtoIndex.TotalCount,
            typeCount = newCtx.ProtoIndex.TypeCount,
        });
    }

    /// <summary>
    /// Opens a native folder-picker dialog on the user's machine and returns
    /// the chosen path. Windows-only — uses PowerShell + WinForms so we don't
    /// need to pull WinForms into the main project's TFM. The dialog runs in
    /// a short-lived child process that prints exactly one line (the selected
    /// path, or empty on cancel). Server-side endpoint only makes sense when
    /// the editor is being used locally on the same machine that runs the
    /// browser, which is the only supported topology.
    /// </summary>
    private async Task HandleBrowseFolderAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        if (!OperatingSystem.IsWindows())
        {
            await HttpJson.WriteErrorAsync(res, 501, "Native folder picker is only available on Windows.");
            return;
        }

        string? selected;
        try
        {
            selected = await Task.Run(() => ModernFolderPicker.Pick("Select your SS14 project folder"));
        }
        catch (Exception ex)
        {
            await HttpJson.WriteErrorAsync(res, 500, $"Failed to open folder picker: {ex.Message}");
            return;
        }

        await HttpJson.WriteAsync(res, new { path = selected ?? string.Empty });
    }

    private Task HandleCloseAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        SwapContext(null);
        return HttpJson.WriteAsync(res, new { ok = true });
    }
}
