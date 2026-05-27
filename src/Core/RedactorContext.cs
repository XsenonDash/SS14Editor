using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Content.Editor.Editor;

/// <summary>
/// Shared runtime context passed to <see cref="ApiRouter"/> and its services.
///
/// LIFECYCLE / THREADING — read this before editing!
/// ===================================================
/// Multiple HTTP requests run in parallel. When the user switches projects
/// (via /api/configure or /api/close), the global <c>ApiRouter._ctx</c> is
/// swapped, but in-flight handlers may still be reading the *old* context.
/// Disposing it immediately would crash them with ObjectDisposedException.
///
/// We solve this with reference counting:
///   * Construction starts the ref count at 1 ("owner reference" held by ApiRouter).
///   * <see cref="ApiRouter.DispatchAsync"/> calls <see cref="TryAddRef"/>
///     before invoking a handler and <see cref="Release"/> in the finally.
///   * On project switch, <c>ApiRouter</c> calls <see cref="Dispose"/> on the
///     old context. Dispose only decrements the owner reference; the actual
///     cleanup (<see cref="FileWatcher"/>, <see cref="Events"/>) runs after
///     every leased reference has been released.
///
/// DO NOT call FileWatcher.Dispose() or Events.Dispose() directly from outside.
/// DO NOT add new long-lived fields without cleaning them up in DisposeCore().
/// </summary>
internal sealed class EditorContext : IDisposable
{
    public required string SolutionRoot { get; init; }
    public required string EditorDir { get; init; }
    public required string PrototypesDir { get; init; }
    public required string ResourcesDir { get; init; }
    public required string TexturesDir { get; init; }
    public required string AudioDir { get; init; }
    public required string EnginePrototypesDir { get; init; }
    public required ProtoIndexService ProtoIndex { get; init; }
    public required SourceLocator SourceLocator { get; init; }
    public required EventStreamService Events { get; init; }
    public required FileWatcherService FileWatcher { get; init; }
    public required MetadataDllWatcherService DllWatcher { get; init; }

    private int _refs = 1;
    private int _disposed; // 0 = alive, 1 = cleanup ran

    // ----- File-tree snapshot cache --------------------------------------
    // /api/tree used to walk the whole prototypes directory on every request,
    // which can take seconds on large forks. We cache the assembled list and
    // invalidate from the FSW handler (created / deleted / renamed) and from
    // folder-mutating endpoints (rename-folder / delete-folder / create-folder).
    // The cached value is intentionally an immutable reference: handlers return
    // it directly to JsonSerializer without copying. Never mutate the list
    // returned by GetTreeSnapshot().
    private readonly object _treeCacheLock = new();
    private List<FileTreeNode>? _treeCache;

    public List<FileTreeNode> GetTreeSnapshot()
    {
        lock (_treeCacheLock)
        {
            if (_treeCache != null) return _treeCache;
            var tree = FileTreeService.Build(PrototypesDir);
            if (Directory.Exists(EnginePrototypesDir))
            {
                var engineTree = FileTreeService.Build(EnginePrototypesDir, "", ProtoIndexService.EnginePrefix);
                FileTreeService.MarkReadOnly(engineTree);
                tree.Add(new FileTreeNode
                {
                    Name = "⚙ Engine (read-only)",
                    Path = "__engine__",
                    IsDir = true,
                    ReadOnly = true,
                    Children = engineTree,
                });
            }
            _treeCache = tree;
            return tree;
        }
    }

    public void InvalidateTree()
    {
        lock (_treeCacheLock) { _treeCache = null; }
    }

    /// <summary>
    /// Atomically increments the reference count if the context is still alive.
    /// Returns <c>false</c> if the owner reference has already been released.
    /// Callers that get <c>true</c> MUST call <see cref="Release"/> exactly once.
    /// </summary>
    internal bool TryAddRef()
    {
        while (true)
        {
            var cur = Volatile.Read(ref _refs);
            if (cur == 0) return false;
            if (Interlocked.CompareExchange(ref _refs, cur + 1, cur) == cur)
                return true;
        }
    }

    /// <summary>Drops one reference. Runs cleanup when the last reference is gone.</summary>
    internal void Release()
    {
        if (Interlocked.Decrement(ref _refs) == 0)
            DisposeCore();
    }

    /// <summary>Drops the owner reference. Cleanup is deferred until in-flight leases release.</summary>
    public void Dispose() => Release();

    private void DisposeCore()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { FileWatcher.Dispose(); } catch (Exception ex) { Logger.Warn($"FileWatcher dispose failed: {ex.Message}"); }
        try { DllWatcher.Dispose(); } catch (Exception ex) { Logger.Warn($"DllWatcher dispose failed: {ex.Message}"); }
        try { Events.Dispose(); } catch (Exception ex) { Logger.Warn($"Events dispose failed: {ex.Message}"); }
    }
}
