using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Content.Editor.Editor;

/// <summary>
/// Watches the prototypes directory for external changes (file edits, renames,
/// deletions, folder operations) and emits debounced change events.
/// </summary>
/// <remarks>
/// File-system watchers commonly fire several events for a single logical save.
/// Events are coalesced per-path within a short window to avoid spamming
/// connected clients and re-indexing the same file repeatedly.
/// </remarks>
internal sealed class FileWatcherService : IDisposable
{
    private readonly string _root;
    private readonly FileSystemWatcher _watcher;
    // _pending is guarded by _pendingLock. We do NOT use ConcurrentDictionary
    // here because the Schedule/Fire interleaving needs atomicity larger than
    // a single dictionary operation: Fire removes the entry then disposes the
    // timer, while a concurrent Schedule may still be holding a reference and
    // about to call Timer.Change() on it. Without the lock, the Change() call
    // would throw ObjectDisposedException on the disposed instance.
    private readonly Dictionary<string, Timer> _pending = new();
    private readonly object _pendingLock = new();
    private readonly ConcurrentDictionary<string, DateTime> _suppress = new();
    private bool _disposed;
    private static readonly TimeSpan DebounceDelay = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan SuppressWindow = TimeSpan.FromSeconds(5);

    public event Action<FileChangeEvent>? Changed;

    public FileWatcherService(string prototypesDir)
    {
        _root = Path.GetFullPath(prototypesDir);
        _watcher = new FileSystemWatcher(_root)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.DirectoryName,
            EnableRaisingEvents = false,
        };
        _watcher.Filters.Add("*.yml");
        _watcher.Filters.Add("*.yaml");
        _watcher.Changed += (_, e) => Schedule(e.FullPath, FileChangeKind.Changed);
        _watcher.Created += (_, e) => Schedule(e.FullPath, FileChangeKind.Created);
        _watcher.Deleted += (_, e) => Schedule(e.FullPath, FileChangeKind.Deleted);
        _watcher.Renamed += (_, e) =>
        {
            Schedule(e.OldFullPath, FileChangeKind.Deleted);
            Schedule(e.FullPath, FileChangeKind.Created);
        };
        _watcher.Error += (_, e) =>
            Logger.Error($"FileWatcher error: {e.GetException().Message}");
    }

    public void Start() => _watcher.EnableRaisingEvents = true;

    /// <summary>
    /// Tells the watcher to ignore the next change event for the supplied
    /// path. Called immediately after the editor itself writes to a file so
    /// connected clients don't receive a self-induced "external change" notice.
    /// </summary>
    public void SuppressNext(string fullPath)
    {
        _suppress[Path.GetFullPath(fullPath)] = DateTime.UtcNow;
    }

    private void Schedule(string fullPath, FileChangeKind kind)
    {
        var canonical = Path.GetFullPath(fullPath);
        // Editor's own writes call SuppressNext(). One incoming FSW event for
        // that path is consumed here so the WebUI doesn't see a self-induced
        // "external change" toast. Subsequent FSW events for the same path
        // (e.g. a real external edit later) are NOT blocked because the stamp
        // is removed after the first match.
        if (_suppress.TryGetValue(canonical, out var suppressedAt))
        {
            _suppress.TryRemove(canonical, out _);
            if (DateTime.UtcNow - suppressedAt < SuppressWindow)
                return;
        }

        lock (_pendingLock)
        {
            if (_disposed) return;
            if (_pending.TryGetValue(canonical, out var existing))
            {
                // Still owned by the dictionary, safe to reschedule.
                existing.Change(DebounceDelay, Timeout.InfiniteTimeSpan);
            }
            else
            {
                _pending[canonical] = new Timer(_ => Fire(canonical, kind), null, DebounceDelay, Timeout.InfiniteTimeSpan);
            }
        }
    }

    private void Fire(string fullPath, FileChangeKind kind)
    {
        Timer? timer;
        lock (_pendingLock)
        {
            if (!_pending.Remove(fullPath, out timer)) return;
        }
        timer.Dispose();

        string rel;
        try
        {
            rel = Path.GetRelativePath(_root, fullPath).Replace('\\', '/');
        }
        catch
        {
            return;
        }
        if (rel.StartsWith("..", StringComparison.Ordinal))
            return;

        try
        {
            Changed?.Invoke(new FileChangeEvent(kind, rel, fullPath));
        }
        catch (Exception ex)
        {
            Logger.Error($"FileWatcher listener error: {ex.Message}");
        }
    }

    public void Dispose()
    {
        _watcher.EnableRaisingEvents = false;
        _watcher.Dispose();
        lock (_pendingLock)
        {
            _disposed = true;
            foreach (var (_, timer) in _pending) timer.Dispose();
            _pending.Clear();
        }
    }
}

internal enum FileChangeKind
{
    Created,
    Changed,
    Deleted,
}

internal readonly record struct FileChangeEvent(FileChangeKind Kind, string RelativePath, string FullPath);
