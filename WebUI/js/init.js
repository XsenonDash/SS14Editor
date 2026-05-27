// ======================================================================
//  SS14 Prototype Editor – Initialization & Keyboard Shortcuts
// ======================================================================

'use strict';

// ======================== REFRESH ======================================
async function refreshAll() {
    try {
        const [tree] = await Promise.all([api.loadTree(), api.refreshIndex()]);
        state.fileTree = tree;
        state.protoIndex = await api.loadProtoIndex();
        state.resolvedCache.clear();
        await refreshGitStatus();
        const treeEl = document.getElementById('file-tree');
        renderFileTree(state.fileTree, treeEl, document.getElementById('file-search').value);
        renderTabs();
    } catch (e) {
        console.error('[Init] Refresh failed:', e);
        toast(`Refresh error: ${e.message}`, 'error');
    }
}

// Pull the latest git status and re-paint the tree + tabs. Best-effort: any
// failure (no git, not a repo) just clears the highlighting silently.
async function refreshGitStatus() {
    try {
        state.gitStatus = await api.gitStatus();
    } catch (e) {
        console.warn('[Git] status fetch failed:', e);
        state.gitStatus = null;
        return;
    }
    repaintGitDecorations();
}

// Debounced git-status refresh; many SSE events can land in a row (a bulk
// `git checkout` touches dozens of files), no point running `git status`
// once per event.
let _gitRefreshTimer = null;
function scheduleGitRefresh(delay = 250) {
    clearTimeout(_gitRefreshTimer);
    _gitRefreshTimer = setTimeout(refreshGitStatus, delay);
}

function repaintGitDecorations() {
    const treeEl = document.getElementById('file-tree');
    if (treeEl && state.fileTree) {
        const q = document.getElementById('file-search').value;
        renderFileTree(state.fileTree, treeEl, q);
    }
    renderTabs();
}

// ======================== KEYBOARD =====================================
document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        const fs = state.openFiles.get(state.currentFile);
        if (fs) {
            clearTimeout(fs._saveTimer);
            api.saveFile(fs.path, fs.content).then(async () => {
                fs.modified = false; renderTabs(); toast('Saved', 'success');
                scheduleGitRefresh(100);
            }).catch(e => {
                console.error('[Keyboard] Manual save failed:', e);
                toast(`Save error: ${e.message}`, 'error');
            });
        }
    }
});

// ======================== FILE WATCHER (SSE) ============================
// The server pushes "file-change" events over an SSE channel; we react by
// reloading any open file whose external timestamp changed and the user hasn't
// modified locally. Falls back silently if EventSource is unavailable.
function startFileEventStream() {
    if (typeof EventSource === 'undefined') {
        console.warn('[FileWatcher] EventSource unavailable; live reload disabled.');
        return;
    }
    let backoff = 1000;
    function connect() {
        const es = new EventSource('/api/events');
        es.onopen = () => { backoff = 1000; };
        es.onmessage = async (ev) => {
            let payload;
            try { payload = JSON.parse(ev.data); } catch { return; }
            if (!payload || payload.type !== 'file-change') return;
            // Any file change (ours or external) can shift git status: schedule
            // a refresh so tree + tabs re-colour.
            scheduleGitRefresh();
            const path = payload.path;
            if (!path) return;
            const fs = state.openFiles.get(path);
            if (!fs) return;
            if (payload.kind === 'deleted') {
                toast(`${path.split('/').pop()} was deleted externally`, 'warning');
                return;
            }
            if (fs.modified) {
                toast(`${path.split('/').pop()} changed externally (local edits kept)`, 'warning');
                return;
            }
            try {
                const { content } = await api.loadFile(path);
                // Identical content (e.g. self-write echo that slipped past the
                // server-side suppress window) — do nothing, keep cursor & UI.
                if (content === fs.content) return;
                fs.content = content;
                const { protos, doc } = parseYamlDoc(content);
                fs.yaml = protos;
                fs.doc = doc;
                fs.dirtyProtos = new Set();
                fs.dirtySinceSave = new Set();
                fs.structuralChange = false;
                fs.history = [content];
                fs.historyIdx = 0;
                relinkProtoAst(fs);
                state.resolvedCache.clear();
                // Re-render every group whose active tab is this file.
                state.groups.filter(g => g.activeTab === path).forEach(g => renderEditor(g.id));
                toast(`Reloaded: ${path.split('/').pop()}`, 'info');
            } catch (e) {
                console.error('[FileWatcher] Reload failed:', path, e);
            }
        };
        es.onerror = () => {
            es.close();
            // Reconnect with capped exponential backoff.
            backoff = Math.min(backoff * 2, 30000);
            setTimeout(connect, backoff);
        };
    }
    connect();
}

// ======================== INIT =========================================
// NOTE: `init()` is defined here but INVOKED at the bottom of this file
// (see the trailing `init();` call). It must run after the `const HISTORY_KEY`
// / `let _historyCache` declarations below — calling it as an IIFE here
// would hit a temporal-dead-zone ReferenceError inside `showSetupOverlay()
// → loadHistorySync()`, which silently rejects the async IIFE and leaves
// the setup overlay's Browse/Open buttons with no event listeners attached.
async function init() {
    console.log('[Editor] Initializing...');

    // Show the setup overlay SYNCHRONOUSLY before we await any network call.
    // Otherwise the renderer paints the empty editor shell first, then the
    // overlay pops in once `api.status()` resolves — which looks broken
    // (the user sees a non-functional editor for a few hundred ms).
    // `showSetupOverlay()` wires up all input listeners synchronously; if
    // we discover below that a project is already configured we just hide
    // the overlay again before loading editor data.
    showSetupOverlay();

    let status;
    try { status = await api.status(); }
    catch (e) { status = { configured: false }; }

    const versionEl = document.getElementById('status-bar-version');
    if (versionEl && status.version) versionEl.textContent = 'v' + status.version;

    if (!status.configured) {
        // Overlay is already visible — nothing more to do until the user
        // picks a project and `tryOpen` calls `loadEditorData()`.
        // Open changelog in the background so something useful is visible.
        window.openChangelogTab?.();
        return;
    }

    // Project is already configured (rare in Electron, common when running
    // the .NET server directly with `serve <path>`): hide the overlay we
    // pre-displayed and load editor data.
    const overlay = document.getElementById('setup-overlay');
    if (overlay) overlay.style.display = 'none';
    await loadEditorData();
}

// ======================== OPEN OTHER REPO =============================
function openOtherRepository() {
    state.openFiles.clear();
    state.parentFileCache.clear();
    state.resolvedCache.clear();
    state.fileTree   = null;
    state.protoIndex = null;
    state.metadata   = null;
    state.currentFile = null;
    state.gitStatus  = null;
    state.groups     = [{ id: 'g1', tabs: [], activeTab: null }];
    state.activeGroupId = 'g1';

    // Clone interactive setup elements to strip accumulated event listeners
    // before showSetupOverlay() re-attaches them.
    ['setup-open-btn', 'setup-browse-btn', 'setup-path'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.replaceWith(el.cloneNode(true));
    });

    showSetupOverlay();
}

// ======================== SETUP OVERLAY ================================
// Recent projects are persisted on the server at
// %LOCALAPPDATA%/ss14-editor/recent-projects.json (see HandleRecentProjectsAsync
// in src/Api/StatusApi.cs). The on-disk file is the source of truth — it
// survives localStorage being wiped (Electron data:URL splash → localhost
// navigation can isolate storage), browser cache clears, and reinstalls
// that keep AppData. localStorage is kept as a synchronous fallback cache
// so the list renders instantly while the server fetch is in flight.
const HISTORY_KEY = 'ss14-editor-history';
let _historyCache = null;

function loadHistorySync() {
    if (_historyCache) return _historyCache;
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch { return []; }
}

function cacheHistory(h) {
    _historyCache = h;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /* quota */ }
}

async function loadHistory() {
    try {
        const r = await api.getRecentProjects();
        const items = Array.isArray(r?.items) ? r.items : [];
        // First run after upgrade: migrate localStorage entries into the server.
        if (items.length === 0) {
            const local = loadHistorySync();
            if (local.length > 0) {
                for (let i = local.length - 1; i >= 0; i--) {
                    try { await api.addRecentProject(local[i].path); } catch { /* ignore */ }
                }
                const r2 = await api.getRecentProjects();
                const items2 = Array.isArray(r2?.items) ? r2.items : [];
                cacheHistory(items2);
                return items2;
            }
        }
        cacheHistory(items);
        return items;
    } catch (e) {
        console.warn('[history] server fetch failed, using localStorage', e);
        return loadHistorySync();
    }
}

async function addToHistory(path) {
    try {
        const r = await api.addRecentProject(path);
        if (Array.isArray(r?.items)) cacheHistory(r.items);
    } catch (e) {
        console.warn('[history] server add failed', e);
        const h = loadHistorySync().filter(e => e.path !== path);
        h.unshift({ path, lastUsed: Date.now() });
        cacheHistory(h.slice(0, 10));
    }
}

async function removeFromHistory(path) {
    try {
        const r = await api.removeRecentProject(path);
        if (Array.isArray(r?.items)) cacheHistory(r.items);
    } catch (e) {
        console.warn('[history] server remove failed', e);
        cacheHistory(loadHistorySync().filter(e => e.path !== path));
    }
}

async function renderHistoryList(input, tryOpen) {
    const histEl = document.getElementById('setup-history');
    if (!histEl) return;

    const draw = (h) => {
        histEl.innerHTML = '';
        if (!h || h.length === 0) return;

        const label = document.createElement('div');
        label.className = 'setup-history-label';
        label.textContent = 'Recent projects';
        histEl.appendChild(label);

        h.forEach(({ path }) => {
            const item = document.createElement('div');
            item.className = 'setup-history-item';

            const text = document.createElement('span');
            text.className = 'setup-history-path';
            const bdi = document.createElement('bdi');
            bdi.textContent = path;
            text.appendChild(bdi);
            text.title = path;
            text.addEventListener('click', () => {
                input.value = path;
                tryOpen();
            });

            const remove = document.createElement('button');
            remove.className = 'setup-history-remove';
            remove.textContent = '×';
            remove.title = 'Remove from history';
            remove.addEventListener('click', async e => {
                e.stopPropagation();
                await removeFromHistory(path);
                renderHistoryList(input, tryOpen);
            });

            item.appendChild(text);
            item.appendChild(remove);
            histEl.appendChild(item);
        });
    };

    // Render cached list immediately for snappy UX, then refresh from server.
    draw(loadHistorySync());
    const fresh = await loadHistory();
    draw(fresh);
}

function showSetupOverlay() {
    const overlay = document.getElementById('setup-overlay');
    overlay.style.display = 'flex';

    const statusEl = document.getElementById('setup-status');
    const btn = document.getElementById('setup-open-btn');
    const browseBtn = document.getElementById('setup-browse-btn');
    const input = document.getElementById('setup-path');

    // Pre-fill with the most recent path from the synchronous cache so the
    // input isn't empty for a frame; the async render below corrects it if
    // the server-side list differs.
    const cached = loadHistorySync();
    if (cached.length > 0) input.value = cached[0].path;
    loadHistory().then(h => {
        if (h.length > 0 && !input.value) input.value = h[0].path;
    });

    function setStatusLoading(msg) {
        statusEl.className = 'setup-status loading';
        statusEl.innerHTML = '';
        const spin = document.createElement('span');
        spin.className = 'setup-spinner';
        const txt = document.createElement('span');
        txt.textContent = msg;
        statusEl.appendChild(spin);
        statusEl.appendChild(txt);
    }
    function setStatusError(msg) {
        statusEl.className = 'setup-status error';
        statusEl.textContent = msg;
    }
    function clearStatus() {
        statusEl.className = 'setup-status';
        statusEl.textContent = '';
    }

    async function tryOpen() {
        const path = input.value.trim();
        if (!path) return;

        btn.disabled = true;
        if (browseBtn) browseBtn.disabled = true;
        setStatusLoading('Checking project and extracting metadata…');

        try {
            const result = await api.configure(path);
            if (result.success) {
                await addToHistory(path);
                overlay.style.display = 'none';
                clearStatus();
                toast(`Project opened: ${result.prototypes} prototypes (${result.typeCount} types)`, 'success');
                await loadEditorData();
            } else {
                setStatusError(result.error || 'Unknown error');
            }
        } catch (e) {
            setStatusError(e.message);
        } finally {
            btn.disabled = false;
            if (browseBtn) browseBtn.disabled = false;
        }
    }

    async function browseForFolder() {
        try {
            browseBtn.disabled = true;
            const { path } = await api.browseFolder();
            if (path) {
                input.value = path;
                input.focus();
            }
        } catch (e) {
            setStatusError(e.message);
        } finally {
            browseBtn.disabled = false;
        }
    }

    renderHistoryList(input, tryOpen);
    btn.addEventListener('click', tryOpen);
    if (browseBtn) browseBtn.addEventListener('click', browseForFolder);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryOpen(); });
    input.focus();
}

// ======================== LOAD EDITOR DATA =============================
async function loadEditorData() {
    toast('Loading…', 'info');
    const results = await Promise.allSettled([
        api.loadMetadata().then(m => { state.metadata = m; console.log('[Init] Metadata loaded:', Object.keys(m.prototypes || {}).length, 'prototypes,', Object.keys(m.components || {}).length, 'components'); }),
        api.loadTree().then(t => { state.fileTree = t; console.log('[Init] File tree loaded'); }),
        api.loadProtoIndex().then(i => { state.protoIndex = i; console.log('[Init] Proto index loaded:', Object.values(i).reduce((s, a) => s + a.length, 0), 'entries'); }),
        api.gitStatus().then(g => { state.gitStatus = g; if (g && g.available) console.log('[Init] Git status loaded:', Object.keys(g.files || {}).length, 'changed files'); }).catch(() => { state.gitStatus = null; }),
    ]);
    if (!state.metadata)   state.metadata   = { prototypes: {}, components: {} };
    if (!state.protoIndex) state.protoIndex = {};

    const treeEl = document.getElementById('file-tree');
    if (state.fileTree) renderFileTree(state.fileTree, treeEl);

    // Bind UI event listeners only once (guard against re-calling loadEditorData)
    if (!loadEditorData._listenersAttached) {
        loadEditorData._listenersAttached = true;
        let _searchTimer;
        document.getElementById('file-search').addEventListener('input', e => {
            clearTimeout(_searchTimer);
            const q = e.target.value;
            _searchTimer = setTimeout(() => renderFileTree(state.fileTree || [], treeEl, q), CFG.searchDebounce);
        });

        // Activity bar: clicking active button toggles sidebar; clicking another switches panel.
        const appEl = document.getElementById('app');
        document.querySelectorAll('.activity-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const isAlreadyActive = btn.classList.contains('active');
                if (isAlreadyActive) {
                    // Toggle collapse — same button = hide/show sidebar.
                    appEl.classList.toggle('sidebar-hidden');
                } else {
                    // Different panel — always show sidebar and switch panel.
                    appEl.classList.remove('sidebar-hidden');
                    document.querySelectorAll('.activity-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('active'));
                    btn.classList.add('active');
                    const panelEl = document.getElementById(`panel-${btn.dataset.panel}`);
                    if (panelEl) panelEl.classList.add('active');
                }
            });
        });

        // Sidebar resize: drag the divider to change --sidebar-w.
        const resizer = document.getElementById('sidebar-resizer');
        const sidebar = document.getElementById('sidebar');
        const savedW = localStorage.getItem('sidebarW');
        if (savedW) document.documentElement.style.setProperty('--sidebar-w', savedW);

        let _resizing = false, _resizeStartX = 0, _resizeStartW = 0;
        resizer.addEventListener('mousedown', e => {
            _resizing = true;
            _resizeStartX = e.clientX;
            _resizeStartW = sidebar.getBoundingClientRect().width;
            resizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!_resizing) return;
            const newW = Math.max(140, Math.min(600, _resizeStartW + (e.clientX - _resizeStartX)));
            document.documentElement.style.setProperty('--sidebar-w', newW + 'px');
        });
        document.addEventListener('mouseup', () => {
            if (!_resizing) return;
            _resizing = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            const finalW = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim();
            localStorage.setItem('sidebarW', finalW);
        });

        // Start file change push channel (SSE)
        startFileEventStream();
    }

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
        console.warn('[Init] Some data unavailable:', failed.map(r => r.reason));
        toast('Some data unavailable – build the project first', 'warning');
    } else {
        console.log('[Editor] Ready');
        toast('Ready', 'success');
    }
    // Open changelog tab once on first load (not on re-configure).
    if (!loadEditorData._changelogOpened) {
        loadEditorData._changelogOpened = true;
        window.openChangelogTab?.();
    }
}

// All function/const/let declarations above are now in scope — safe to run.
init();
