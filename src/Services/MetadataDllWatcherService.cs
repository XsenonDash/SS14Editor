using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Content.Editor.Editor;

/// <summary>
/// Watches the project's compiled DLL output directories for changes and fires
/// <see cref="Changed"/> after a debounce window. Used to trigger automatic
/// metadata re-extraction when the user rebuilds the game project.
/// </summary>
internal sealed class MetadataDllWatcherService : IDisposable
{
    private readonly List<FileSystemWatcher> _watchers = new();
    private Timer? _timer;
    private readonly object _lock = new();
    private bool _disposed;

    private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(5);

    public event Action? Changed;

    public MetadataDllWatcherService(IEnumerable<string> binDirs)
    {
        foreach (var dir in binDirs)
        {
            if (!Directory.Exists(dir)) continue;
            var w = new FileSystemWatcher(dir)
            {
                IncludeSubdirectories = false,
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName,
                Filter = "*.dll",
                EnableRaisingEvents = true,
            };
            w.Changed += OnDllEvent;
            w.Created += OnDllEvent;
            w.Error   += (_, e) => Logger.Warn($"DllWatcher error: {e.GetException().Message}");
            _watchers.Add(w);
        }
    }

    private void OnDllEvent(object _, FileSystemEventArgs __)
    {
        lock (_lock)
        {
            if (_disposed) return;
            if (_timer == null)
                _timer = new Timer(_ => Changed?.Invoke(), null, Debounce, Timeout.InfiniteTimeSpan);
            else
                _timer.Change(Debounce, Timeout.InfiniteTimeSpan);
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _disposed = true;
            foreach (var w in _watchers) { try { w.Dispose(); } catch { } }
            _watchers.Clear();
            _timer?.Dispose();
            _timer = null;
        }
    }
}
