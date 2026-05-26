'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 2701;
const READY_RETRIES = 60;   // 60 × 500 ms = 30 s max wait

let mainWindow = null;
let splashWindow = null;
let tray = null;
let serverProcess = null;
let pendingUpdateInfo = null; // available-not-yet-downloaded info, surfaced to renderer

// ---------------------------------------------------------------------------
// Locate the .NET binary
// ---------------------------------------------------------------------------
function getServerBinary() {
    const exe = process.platform === 'win32' ? 'ss14-editor.exe' : 'ss14-editor';

    if (app.isPackaged) {
        // electron-builder copies publish/win-x64 → resources/server/
        return path.join(process.resourcesPath, 'server', exe);
    }

    // Development: the csproj sets OutputPath=bin\ (flat, no framework subfolder)
    const repoRoot = path.join(__dirname, '..');
    const candidates = [
        path.join(repoRoot, 'publish', 'server', exe),
        path.join(repoRoot, 'publish', 'win-x64', exe),
        path.join(repoRoot, 'bin', exe),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error(
        `Cannot find ss14-editor binary.\n` +
        `Run: launch-electron.bat  (or build.bat publish)\n` +
        `Looked in:\n${candidates.join('\n')}`
    );
}

// ---------------------------------------------------------------------------
// Start the .NET HTTP server
// ---------------------------------------------------------------------------
function startServer() {
    const binary = getServerBinary();
    // Spawn with no argv: the server starts in setup mode and the WebUI
    // always shows the project picker. Earlier builds passed `serve`, which
    // made the .NET side walk up the CWD looking for a SS14 root — that
    // auto-loaded random sibling forks and skipped the picker entirely.
    serverProcess = spawn(binary, [], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
    serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
    serverProcess.on('exit', code => {
        console.log(`[server] exited with code ${code}`);
        serverProcess = null;
    });
}

// ---------------------------------------------------------------------------
// Poll until the server responds. Strict: we hit /api/status (not /) because
// "/" returns index.html even before all routes are registered, which would
// let us swap to the editor too early and show a half-loaded page.
// ---------------------------------------------------------------------------
function waitForServer(onReady, retriesLeft = READY_RETRIES) {
    const req = http.get(`http://localhost:${PORT}/api/status`, res => {
        // Drain so the socket can be reused.
        res.resume();
        if (res.statusCode === 200) onReady();
        else {
            setTimeout(() => waitForServer(onReady, retriesLeft - 1), 500);
        }
    });
    req.setTimeout(400, () => req.destroy(new Error('timeout')));
    req.on('error', () => {
        if (retriesLeft <= 0) {
            console.error('[electron] Server did not become ready in time. Quitting.');
            app.quit();
            return;
        }
        setTimeout(() => waitForServer(onReady, retriesLeft - 1), 500);
    });
    req.end();
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
// Inline splash served while the .NET server is still starting up. Kept as a
// `data:` URL so it ships zero extra files. The window appears on screen
// immediately so the user is not staring at a black desktop for 1–3 seconds
// while the self-contained binary unpacks itself.
// The app icon is loaded from the bundled icon.png and base64-encoded at
// startup so we don't need to expose a static-file HTTP server for the
// splash page (the .NET server isn't listening yet).
const SPLASH_ICON_PATH = path.join(__dirname, '..', 'icon.png');
let SPLASH_ICON_B64 = '';
try { SPLASH_ICON_B64 = fs.readFileSync(SPLASH_ICON_PATH).toString('base64'); }
catch { /* missing icon — splash will fall back to a coloured square */ }

const SPLASH_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>SS14 Editor</title>
<style>
  html,body { margin:0; padding:0; height:100%; background:#1e1f22; color:#dbdee1;
    font-family:'Segoe UI','Inter',system-ui,sans-serif; -webkit-app-region:drag; user-select:none; }
  .wrap { height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; }
  .logo { width:72px; height:72px; display:flex; align-items:center; justify-content:center; }
  .logo img { width:100%; height:100%; object-fit:contain; }
  .title { font-size:18px; font-weight:600; letter-spacing:.2px; }
  .sub { font-size:12px; color:#b5bac1; }
  .spinner { width:22px; height:22px; border:2px solid #3a3c42; border-top-color:#5865f2;
    border-radius:50%; animation:spin .9s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style></head><body><div class="wrap">
  <div class="logo">${SPLASH_ICON_B64
    ? `<img src="data:image/png;base64,${SPLASH_ICON_B64}" alt="">`
    : ''}</div>
  <div class="title">SS14 Editor</div>
  <div class="spinner"></div>
  <div class="sub">Starting local server…</div>
</div></body></html>`;

function createSplash() {
    splashWindow = new BrowserWindow({
        width: 380,
        height: 240,
        frame: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        transparent: false,
        backgroundColor: '#1e1f22',
        show: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    splashWindow.setMenuBarVisibility(false);
    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));
    splashWindow.on('closed', () => { splashWindow = null; });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 800,
        minHeight: 500,
        title: 'SS14 Editor',
        icon: path.join(__dirname, '..', 'icon.ico'),
        backgroundColor: '#1e1f22',
        // Hidden until `ready-to-show` fires so the splash stays in front
        // and the user never sees a half-painted, dead-clicks window.
        show: false,
        // Frameless: the WebUI draws its own title bar (Project menu,
        // Update button, minimize / maximize / close controls). Native
        // menu is hidden as well, so the OS-styled strip never flashes in.
        frame: false,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    mainWindow.setMenuBarVisibility(false);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    });

    mainWindow.on('maximize',   () => mainWindow.webContents.send('window-maximized-change', true));
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-maximized-change', false));

    mainWindow.on('close', e => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    // Replay any update-available event that arrived before the renderer
    // finished loading, and push the current maximize state so the header
    // can swap maximize/restore glyphs without an extra round-trip.
    mainWindow.webContents.on('did-finish-load', () => {
        if (pendingUpdateInfo) {
            mainWindow.webContents.send('update-available', pendingUpdateInfo);
        }
        mainWindow.webContents.send('window-maximized-change', mainWindow.isMaximized());
    });
}

// Called once the .NET server is responding to /api/status. Loads the real
// WebUI into the hidden main window; `ready-to-show` then swaps splash → main.
function loadEditorUrl() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadURL(`http://localhost:${PORT}/`);
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------
function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'icon.ico'));

    tray = new Tray(icon);
    tray.setToolTip('SS14 Editor');

    const menu = Menu.buildFromTemplate([
        {
            label: 'Open',
            click: () => { mainWindow.show(); mainWindow.focus(); },
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => { app.isQuitting = true; app.quit(); },
        },
    ]);

    tray.setContextMenu(menu);
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

// ---------------------------------------------------------------------------
// Update checking — manual / opt-in
// ---------------------------------------------------------------------------
// Old behaviour: `autoUpdater.checkForUpdatesAndNotify()` at startup,
// silently downloaded the update and only then surfaced a dialog asking to
// restart. New flow:
//   1. On startup ask GitHub whether a newer release exists (no download).
//   2. If yes, send `update-available` IPC to the renderer. The WebUI shows
//      a bright accent-coloured "Update" button in the header.
//   3. When the user clicks it, the renderer invokes `start-update`. We
//      call `autoUpdater.downloadUpdate()` and, on completion, restart into
//      the installer.
function setupUpdateChecker() {
    if (!app.isPackaged) return;
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppLaunch = false;

    autoUpdater.on('update-available', info => {
        pendingUpdateInfo = { version: info.version };
        if (mainWindow && !mainWindow.webContents.isLoading()) {
            mainWindow.webContents.send('update-available', pendingUpdateInfo);
        }
    });
    autoUpdater.on('update-downloaded', () => {
        app.isQuitting = true;
        autoUpdater.quitAndInstall();
    });
    autoUpdater.on('error', err => {
        console.error('[updater] error:', err);
        if (mainWindow) {
            mainWindow.webContents.send('update-error', { message: String(err) });
        }
    });

    autoUpdater.checkForUpdates().catch(err => {
        console.error('[updater] startup check failed:', err);
    });
}

// IPC: begin downloading the pending update. Resolves when the download
// finishes; the actual install happens via `update-downloaded` →
// `quitAndInstall`, which restarts the app.
ipcMain.handle('start-update', async () => {
    if (!app.isPackaged) {
        return { ok: false, reason: 'Running in development mode — no update available.' };
    }
    const { autoUpdater } = require('electron-updater');
    try {
        await autoUpdater.downloadUpdate();
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: String(err) };
    }
});

// IPC: ask the .NET side to drop the configured project; the WebUI will
// re-show its setup overlay. Replaces the old native menu item.
ipcMain.handle('close-project', async () => {
    return new Promise(resolve => {
        const req = http.request(
            { hostname: 'localhost', port: PORT, path: '/api/close', method: 'POST' },
            res => { res.resume(); res.on('end', () => resolve({ ok: true })); }
        );
        req.on('error', err => resolve({ ok: false, reason: String(err) }));
        req.end();
    });
});

// ---------------------------------------------------------------------------
// Frameless-window controls — the WebUI header sends these because the
// BrowserWindow has `frame: false` (no OS-drawn min/max/close buttons).
// ---------------------------------------------------------------------------
ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.on('window-maximize-toggle', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});
ipcMain.on('window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
    // Strip the native application menu entirely — the custom WebUI header
    // owns Project / Update / window controls.
    Menu.setApplicationMenu(null);

    // 1. Show a dedicated splash window IMMEDIATELY so the user sees
    //    something instead of staring at a black desktop while the .NET
    //    self-contained binary unpacks itself (~1–3 s on cold start).
    createSplash();

    // 2. Create the (hidden) main window so we can start loading content
    //    into it as soon as the server is ready; `ready-to-show` swaps
    //    splash → main only when the page has actually painted.
    createMainWindow();
    createTray();

    // 3. Start the .NET server in parallel.
    try {
        startServer();
    } catch (err) {
        dialog.showErrorBox('SS14 Editor – startup error', String(err));
        app.quit();
        return;
    }

    // 4. Once /api/status responds, load the real WebUI into the hidden
    //    main window. `ready-to-show` (registered in createMainWindow)
    //    handles the visible swap.
    waitForServer(() => {
        loadEditorUrl();
        setupUpdateChecker();
    });
});

app.on('before-quit', () => {
    app.isQuitting = true;
    if (serverProcess) {
        serverProcess.kill();
    }
});

// Keep the app running while the tray is active
app.on('window-all-closed', () => { /* intentionally empty – stay in tray */ });
