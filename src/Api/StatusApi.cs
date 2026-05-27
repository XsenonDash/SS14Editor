using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
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
    /// the chosen path. Routes to IFileOpenDialog on Windows, zenity/kdialog
    /// on Linux, and osascript on macOS. If no graphical picker is available
    /// the endpoint returns an empty path so the WebUI falls back to its
    /// manual text-entry form (which is the documented fallback already in
    /// the project-picker UI).
    /// </summary>
    private async Task HandleBrowseFolderAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        string? selected;
        try
        {
            selected = await Task.Run(() => CrossPlatformFolderPicker.Pick("Select your SS14 project folder"));
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

    // -----------------------------------------------------------------------
    // Recent projects: persisted on disk under %LOCALAPPDATA%/ss14-editor/
    // so the list survives localStorage being wiped, the user switching
    // between the Electron app and a browser, or a fresh reinstall that
    // preserves AppData. GET returns the list, POST {path} prepends.
    // -----------------------------------------------------------------------
    private static string RecentProjectsFile()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var dir = Path.Combine(appData, "ss14-editor");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "recent-projects.json");
    }

    private static readonly SemaphoreSlim _recentGate = new(1, 1);
    private const int RecentProjectsLimit = 10;

    private async Task HandleRecentProjectsAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        var file = RecentProjectsFile();

        if (string.Equals(req.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase))
        {
            await _recentGate.WaitAsync();
            try
            {
                var list = ReadRecent(file);
                await HttpJson.WriteAsync(res, new { items = list });
            }
            finally { _recentGate.Release(); }
            return;
        }

        if (string.Equals(req.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase))
        {
            var doc = await HttpJson.ReadBodyAsync(req);

            // POST {path, remove:true} removes; POST {path} prepends; POST {clear:true} wipes.
            string? path = doc.TryGetProperty("path", out var pe) ? pe.GetString() : null;
            bool remove = doc.TryGetProperty("remove", out var re) && re.ValueKind == System.Text.Json.JsonValueKind.True;
            bool clear  = doc.TryGetProperty("clear",  out var ce) && ce.ValueKind == System.Text.Json.JsonValueKind.True;

            await _recentGate.WaitAsync();
            try
            {
                var list = clear ? new System.Collections.Generic.List<RecentProject>() : ReadRecent(file);

                if (!clear)
                {
                    if (string.IsNullOrWhiteSpace(path))
                    {
                        await HttpJson.WriteErrorAsync(res, 400, "Missing 'path'");
                        return;
                    }
                    list.RemoveAll(x => string.Equals(x.path, path, StringComparison.OrdinalIgnoreCase));
                    if (!remove)
                    {
                        list.Insert(0, new RecentProject { path = path!, lastUsed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
                        if (list.Count > RecentProjectsLimit) list.RemoveRange(RecentProjectsLimit, list.Count - RecentProjectsLimit);
                    }
                }

                WriteRecent(file, list);
                await HttpJson.WriteAsync(res, new { items = list });
            }
            finally { _recentGate.Release(); }
            return;
        }

        await HttpJson.WriteErrorAsync(res, 405, "Method not allowed");
    }

    private sealed class RecentProject
    {
        public string path { get; set; } = string.Empty;
        public long lastUsed { get; set; }
    }

    private static System.Collections.Generic.List<RecentProject> ReadRecent(string file)
    {
        if (!File.Exists(file)) return new();
        try
        {
            var json = File.ReadAllText(file);
            var list = System.Text.Json.JsonSerializer.Deserialize<System.Collections.Generic.List<RecentProject>>(json);
            return list ?? new();
        }
        catch { return new(); }
    }

    private static void WriteRecent(string file, System.Collections.Generic.List<RecentProject> list)
    {
        try
        {
            var json = System.Text.Json.JsonSerializer.Serialize(list);
            File.WriteAllText(file, json);
        }
        catch (Exception ex)
        {
            Logger.Warn($"Failed to write recent projects: {ex.Message}");
        }
    }
}
