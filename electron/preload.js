'use strict';

// Preload runs in an isolated context but can still use Electron's IPC.
// We expose a small, typed surface to the renderer through contextBridge so
// the WebUI can talk to the Electron main process without enabling node
// integration (which would let arbitrary scripts spawn processes).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,

    // ---- Updates -----------------------------------------------------
    /** Subscribe to startup / runtime update-available pushes. */
    onUpdateAvailable(cb) {
        ipcRenderer.on('update-available', (_e, info) => cb(info));
    },
    onUpdateError(cb) {
        ipcRenderer.on('update-error', (_e, info) => cb(info));
    },
    /** Trigger background download of the pending update. */
    startUpdate() {
        return ipcRenderer.invoke('start-update');
    },

    // ---- Project / WebUI handshake -----------------------------------
    /** POST /api/close, then renderer can re-show the project picker. */
    closeProject() {
        return ipcRenderer.invoke('close-project');
    },

    // ---- Frameless-window controls -----------------------------------
    windowMinimize()       { ipcRenderer.send('window-minimize'); },
    windowMaximizeToggle() { ipcRenderer.send('window-maximize-toggle'); },
    windowClose()          { ipcRenderer.send('window-close'); },
    onWindowMaximizedChange(cb) {
        ipcRenderer.on('window-maximized-change', (_e, isMaximized) => cb(!!isMaximized));
    },

    // ---- Shell -------------------------------------------------------
    openExternal(url) { ipcRenderer.send('open-external', url); },
});
