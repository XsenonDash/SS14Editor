using System;
using System.Collections.Generic;
using System.Net;
using System.Threading;
using System.Threading.Tasks;

namespace Content.Editor.Editor;

/// <summary>
/// Thin dispatcher: looks up <c>/api/*</c> path in the route table and
/// delegates to handler methods. The handler methods themselves live in
/// partial-class files grouped by domain (see <c>src/Api/*Api.cs</c>).
///
/// CONTEXT LIFETIME — read this before editing!
/// ============================================
/// The global <see cref="_ctx"/> can be swapped at any time by
/// <c>/api/configure</c> or <c>/api/close</c>. In-flight handlers must not
/// observe a half-disposed context. We use two mechanisms:
///
/// 1. <see cref="EditorContext"/> is reference-counted. <see cref="DispatchAsync"/>
///    leases the snapshot before invoking the handler; the lease is released
///    in <c>finally</c>. The owner reference is dropped during swap. Disposal
///    only happens after every lease has been released.
///
/// 2. Handlers access the leased context via <see cref="ScopedCtx"/>, NOT
///    by reading <c>_ctx</c> directly. The <see cref="AsyncLocal{T}"/> flow
///    carries the leased reference through async continuations so the handler
///    always sees the same context it was dispatched with — even if the
///    global field has been swapped in the meantime.
///
/// 3. Swaps are serialized with <see cref="_swapLock"/> so two concurrent
///    /api/configure calls cannot leak a context.
///
/// AI / human contributors: do NOT introduce new <c>_ctx!</c> reads inside
/// handlers. Use <see cref="ScopedCtx"/>.
/// </summary>
internal sealed partial class ApiRouter
{
    private volatile EditorContext? _ctx;
    private readonly object _swapLock = new();
    private static readonly AsyncLocal<EditorContext?> _scoped = new();
    private readonly Dictionary<string, Func<HttpListenerRequest, HttpListenerResponse, Task>> _routes;

    /// <summary>
    /// The leased <see cref="EditorContext"/> for the current request.
    /// Set by <see cref="DispatchAsync"/>; throws if read outside a request scope.
    /// </summary>
    private EditorContext ScopedCtx =>
        _scoped.Value ?? throw new InvalidOperationException(
            "ScopedCtx accessed outside an active request handler. " +
            "Handlers must be invoked through DispatchAsync, which leases the context.");

    /// <summary>
    /// Serializes the heavy work in <c>HandleConfigureAsync</c> (metadata
    /// extraction + index build) so two concurrent /api/configure calls don't
    /// race and leak a built-but-discarded context.
    /// </summary>
    private readonly SemaphoreSlim _configureGate = new(1, 1);

    /// <summary>Endpoints that work even when no project is configured yet.</summary>
    private static readonly HashSet<string> AlwaysAllowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "/api/status",
        "/api/configure",
        "/api/browse-folder",
        "/api/close",
        "/api/recent-projects",
    };

    public ApiRouter(EditorContext? initialCtx)
    {
        _ctx = initialCtx;
        _routes = new(StringComparer.OrdinalIgnoreCase)
        {
            // Status / setup (StatusApi.cs)
            ["/api/status"] = HandleStatusAsync,
            ["/api/configure"] = HandleConfigureAsync,
            ["/api/browse-folder"] = HandleBrowseFolderAsync,
            ["/api/close"] = HandleCloseAsync,
            ["/api/recent-projects"] = HandleRecentProjectsAsync,

            // Tree + prototype index (TreeApi.cs)
            ["/api/tree"] = HandleTreeAsync,
            ["/api/metadata"] = HandleMetadataAsync,
            ["/api/proto-index"] = HandleProtoIndexAsync,
            ["/api/search-protos"] = HandleSearchProtosAsync,
            ["/api/refresh-index"] = HandleRefreshIndexAsync,
            ["/api/git-status"] = HandleGitStatusAsync,

            // File CRUD (FileApi.cs)
            ["/api/file"] = HandleFileAsync,
            ["/api/rename-file"] = HandleRenameFileAsync,
            ["/api/delete-file"] = HandleDeleteFileAsync,
            ["/api/create-file"] = HandleCreateFileAsync,

            // Folder CRUD (FolderApi.cs)
            ["/api/create-folder"] = HandleCreateFolderAsync,
            ["/api/rename-folder"] = HandleRenameFolderAsync,
            ["/api/delete-folder"] = HandleDeleteFolderAsync,

            // Assets (AssetApi.cs)
            ["/api/texture"] = HandleTextureAsync,
            ["/api/texture-browse"] = HandleTextureBrowseAsync,
            ["/api/audio"] = HandleAudioAsync,
            ["/api/audio-browse"] = HandleAudioBrowseAsync,
            ["/api/resource"] = HandleResourceAsync,
            ["/api/res-browse"] = HandleResourceBrowseAsync,

            // OS integration (SourceApi.cs)
            ["/api/open-in-explorer"] = HandleOpenInExplorerAsync,
            ["/api/open-default"] = HandleOpenDefaultAsync,
            ["/api/open-source"] = HandleOpenSourceAsync,

            // SSE (EventsApi.cs)
            ["/api/events"] = HandleEventsAsync,
        };
    }

    public async Task<bool> DispatchAsync(string path, HttpListenerRequest req, HttpListenerResponse res)
    {
        res.ContentType = "application/json; charset=utf-8";
        if (!_routes.TryGetValue(path, out var handler))
        {
            Logger.Error($"Unknown API endpoint: {path}");
            await HttpJson.WriteErrorAsync(res, 404, "Unknown API endpoint");
            return false;
        }

        var isEvents = path.Equals("/api/events", StringComparison.OrdinalIgnoreCase);

        // AlwaysAllowed endpoints (status / configure / browse / close) run
        // without a lease — they may be called while no project is configured,
        // and configure/close are the routines that *do* the swap themselves.
        if (AlwaysAllowed.Contains(path))
        {
            await handler(req, res);
            return isEvents;
        }

        // Snapshot + lease the current context so the handler keeps a valid
        // reference even if a concurrent configure/close swaps the global field.
        var snapshot = _ctx;
        if (snapshot == null || !snapshot.TryAddRef())
        {
            await HttpJson.WriteErrorAsync(res, 503, "No project configured. Open the editor in your browser and select a project folder.");
            return false;
        }

        _scoped.Value = snapshot;
        try
        {
            await handler(req, res);
            return isEvents;
        }
        finally
        {
            _scoped.Value = null;
            snapshot.Release();
        }
    }

    /// <summary>
    /// Atomically replaces the global context. The previous context's owner
    /// reference is dropped; actual cleanup happens once every in-flight lease
    /// is released. Pass <c>null</c> to enter "no project" mode.
    /// </summary>
    private void SwapContext(EditorContext? newCtx)
    {
        EditorContext? old;
        lock (_swapLock)
        {
            old = _ctx;
            _ctx = newCtx;
        }
        old?.Dispose();
    }
}
