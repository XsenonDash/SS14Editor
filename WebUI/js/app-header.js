// Custom WebUI application header — wires up the Project dropdown, the
// frameless-window controls (minimize/maximize/close) and the Update button.
// Works inside Electron (preferred path, via window.electronAPI exposed by
// preload.js) and in a plain browser (where window controls and the Update
// button stay hidden and "Open other repository" just resets WebUI state).

(function () {
    'use strict';

    const root = document.getElementById('app-header');
    if (!root) return;

    // -----------------------------------------------------------------
    // Dropdown menus (currently just "Project")
    // -----------------------------------------------------------------
    const menus = Array.from(root.querySelectorAll('.app-header-menu'));

    function closeAll(except) {
        for (const m of menus) {
            if (m !== except) m.classList.remove('open');
        }
    }

    for (const menu of menus) {
        const btn = menu.querySelector('.app-header-menu-btn');
        if (!btn) continue;
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const wasOpen = menu.classList.contains('open');
            closeAll(wasOpen ? null : menu);
            menu.classList.toggle('open', !wasOpen);
        });
        menu.querySelectorAll('.app-header-dropdown-item').forEach(item => {
            item.addEventListener('click', () => closeAll(null));
        });
    }

    document.addEventListener('click', e => {
        if (!root.contains(e.target)) closeAll(null);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeAll(null);
    });

    // -----------------------------------------------------------------
    // Project → Open other repository
    // -----------------------------------------------------------------
    const openOtherBtn = document.getElementById('hdr-open-other');
    if (openOtherBtn) {
        openOtherBtn.addEventListener('click', async () => {
            try {
                if (window.electronAPI && typeof window.electronAPI.closeProject === 'function') {
                    await window.electronAPI.closeProject();
                } else if (window.api && typeof window.api.close === 'function') {
                    await window.api.close();
                }
            } catch (err) {
                console.warn('[app-header] close-project failed:', err);
            }
            if (typeof window.openOtherRepository === 'function') {
                window.openOtherRepository();
            } else if (typeof window.showSetupOverlay === 'function') {
                window.showSetupOverlay();
            }
        });
    }

    // -----------------------------------------------------------------
    // Window controls (frameless BrowserWindow)
    // -----------------------------------------------------------------
    const winControls = document.getElementById('hdr-window-controls');
    if (winControls) {
        if (!window.electronAPI || typeof window.electronAPI.windowMinimize !== 'function') {
            // Not running inside Electron (or preload didn't expose the
            // surface) — there's nothing for these buttons to do.
            winControls.hidden = true;
        } else {
            document.getElementById('hdr-win-min')?.addEventListener('click', () => {
                window.electronAPI.windowMinimize();
            });
            document.getElementById('hdr-win-max')?.addEventListener('click', () => {
                window.electronAPI.windowMaximizeToggle();
            });
            document.getElementById('hdr-win-close')?.addEventListener('click', () => {
                window.electronAPI.windowClose();
            });
            window.electronAPI.onWindowMaximizedChange?.(isMax => {
                document.body.classList.toggle('is-maximized', !!isMax);
            });
        }
    }

    // -----------------------------------------------------------------
    // Update button
    // Visibility rules (per user requirement):
    //   - Hidden by default.
    //   - Shown only when running inside a packaged Electron build AND
    //     the main process pushes `update-available`.
    //   - Always hidden in dev builds — the main process guards this
    //     with `app.isPackaged`, so `update-available` never fires there,
    //     and we also bail out here if `window.electronAPI` is missing.
    // -----------------------------------------------------------------
    const updateBtn = document.getElementById('hdr-update-btn');

    function showSpinner(label) {
        if (!updateBtn) return;
        updateBtn.disabled = true;
        updateBtn.innerHTML =
            '<span class="app-header-update-spinner"></span>' +
            '<span class="app-header-update-label"></span>';
        updateBtn.querySelector('.app-header-update-label').textContent = label;
    }
    function resetUpdateButton(label) {
        if (!updateBtn) return;
        updateBtn.disabled = false;
        updateBtn.innerHTML = '<span class="app-header-update-label"></span>';
        updateBtn.querySelector('.app-header-update-label').textContent = label;
    }

    if (updateBtn && window.electronAPI?.onUpdateAvailable) {
        window.electronAPI.onUpdateAvailable(info => {
            updateBtn.hidden = false;
            updateBtn.title = info?.version ? `Update available — v${info.version}` : 'Update available';
        });
        window.electronAPI.onUpdateError?.(info => {
            window.toast?.(`Update error: ${info?.message || 'unknown'}`, 'error');
            resetUpdateButton('Update');
        });

        updateBtn.addEventListener('click', async () => {
            if (updateBtn.disabled) return;
            showSpinner('Updating...');
            try {
                const result = await window.electronAPI.startUpdate();
                if (result && result.ok === false) {
                    window.toast?.(result.reason || 'Update failed', 'error');
                    resetUpdateButton('Update');
                }
                // On success, electron-updater fires `update-downloaded` and
                // the main process restarts into the installer — nothing
                // further to do here.
            } catch (err) {
                window.toast?.(`Update failed: ${err}`, 'error');
                resetUpdateButton('Update');
            }
        });
    }
})();
