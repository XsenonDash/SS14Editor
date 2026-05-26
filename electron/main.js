'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 2701;
const READY_RETRIES = 60;   // 60 × 500 ms = 30 s max wait

let mainWindow = null;
let tray = null;
let serverProcess = null;

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
    serverProcess = spawn(binary, ['serve'], {
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
// Poll until the server responds
// ---------------------------------------------------------------------------
function waitForServer(onReady, retriesLeft = READY_RETRIES) {
    const req = http.get(`http://localhost:${PORT}/`, res => {
        res.resume();
        onReady();
    });
    req.setTimeout(400);
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
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 800,
        minHeight: 500,
        title: 'SS14 Editor',
        icon: path.join(__dirname, '..', 'icon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    mainWindow.loadURL(`http://localhost:${PORT}/`);
    mainWindow.on('close', e => {
        // Hide to tray instead of closing unless we are really quitting
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });
}

// ---------------------------------------------------------------------------
// Application menu  (Project | Help)
// ---------------------------------------------------------------------------
function createAppMenu() {
    const template = [
        {
            label: 'Project',
            submenu: [
                {
                    label: 'Open other repository',
                    click: () => {
                        const req = http.request(
                            { hostname: 'localhost', port: PORT, path: '/api/close', method: 'POST' },
                            res => {
                                res.resume();
                                mainWindow.webContents
                                    .executeJavaScript('openOtherRepository()')
                                    .catch(() => mainWindow.reload());
                            }
                        );
                        req.on('error', () => mainWindow.reload());
                        req.end();
                    },
                },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Check for updates',
                    click: () => {
                        if (app.isPackaged) {
                            const { autoUpdater } = require('electron-updater');
                            autoUpdater.checkForUpdates().catch(err => {
                                dialog.showErrorBox('Update check failed', String(err));
                            });
                        } else {
                            dialog.showMessageBox(mainWindow, {
                                type: 'info',
                                title: 'Check for updates',
                                message: 'Running in development mode — no update check available.',
                                buttons: ['OK'],
                            });
                        }
                    },
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
// Auto-update  (only in packaged builds; silent check on startup)
// ---------------------------------------------------------------------------
function setupAutoUpdater() {
    if (!app.isPackaged) return;
    const { autoUpdater } = require('electron-updater');

    autoUpdater.on('update-downloaded', () => {
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            title: 'Update ready',
            message: 'A new version of SS14 Editor has been downloaded.\nRestart to apply the update.',
        }).then(({ response }) => {
            if (response === 0) {
                app.isQuitting = true;
                autoUpdater.quitAndInstall();
            }
        });
    });

    autoUpdater.checkForUpdatesAndNotify();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
    try {
        startServer();
    } catch (err) {
        dialog.showErrorBox('SS14 Editor – startup error', String(err));
        app.quit();
        return;
    }

    waitForServer(() => {
        createWindow();
        createAppMenu();
        createTray();
        setupAutoUpdater();
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
