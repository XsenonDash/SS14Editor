// ======================================================================
//  SS14 Prototype Redactor – Tabs
// ======================================================================

'use strict';

function renderTabs() {
    const box = document.getElementById('tabs');
    box.innerHTML = '';
    for (const [path, fs] of state.openFiles) {
        const tab = document.createElement('div');
        const gitClass = (typeof gitClassForFile === 'function') ? gitClassForFile(path) : '';
        tab.className = `tab${path === state.currentFile ? ' active' : ''}${gitClass}`;
        tab.dataset.path = path;
        const shortName = path.split('/').pop() + (fs.modified ? ' •' : '');
        tab.innerHTML = `<span class="tab-name">${esc(shortName)}</span><button class="tab-close">×</button>`;
        tab.querySelector('.tab-name').addEventListener('click', () => switchTab(path));
        tab.querySelector('.tab-close').addEventListener('click', e => { e.stopPropagation(); closeTab(path); });
        tab.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); closeTab(path); } });
        tab.addEventListener('contextmenu', e => {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, [
                { label: 'Close', action: () => closeTab(path) },
                { label: 'Close Others', action: () => closeOtherTabs(path) },
                { label: 'Close All', action: () => closeAllTabs() },
                '---',
                { label: 'Open with Default Editor', action: () => api.openDefault(path) },
                { label: 'Open in Explorer', action: () => api.openInExplorer(path) },
                { label: 'Copy Path', action: () => { navigator.clipboard.writeText(path).catch(()=>{}); toast('Copied', 'info'); } },
                '---',
                { label: 'Rename…', action: () => promptRenameFile(path) },
            ]);
        });
        box.appendChild(tab);
    }
}

async function openFile(path) {
    if (state.openFiles.has(path)) {
        state.currentFile = path;
        renderTabs(); renderEditor();
        return;
    }

    // Insert a placeholder FileState so the tab + a spinner appear instantly;
    // large files (parsing, preloadParents) can otherwise stall the UI for
    // several seconds with no feedback.
    const placeholder = new FileState(path, '');
    placeholder.loading = true;
    placeholder.yaml = [];
    state.openFiles.set(path, placeholder);
    state.currentFile = path;
    renderTabs(); renderEditor();

    try {
        const resp = await api.loadFile(path);
        if (!state.openFiles.has(path) || state.openFiles.get(path) !== placeholder) return;
        placeholder.content    = resp.content;
        placeholder.history    = [resp.content];
        placeholder.historyIdx = 0;
        placeholder.yaml       = parseYaml(resp.content);
        placeholder.readOnly   = !!resp.readOnly || path.startsWith('__engine__/');
        placeholder.loading    = false;
        try {
            const stamps = await api.fileStamps([path]);
            if (stamps[path]) state.fileStamps.set(path, stamps[path]);
        } catch {}
        if (state.currentFile === path) { renderTabs(); renderEditor(); }
    } catch (e) {
        console.error('[Tabs] Open file failed:', path, e);
        toast(`Open failed: ${e.message}`, 'error');
        if (state.openFiles.get(path) === placeholder) {
            state.openFiles.delete(path);
            if (state.currentFile === path) {
                const k = [...state.openFiles.keys()];
                state.currentFile = k.length ? k[k.length - 1] : null;
            }
            renderTabs(); renderEditor();
        }
    }
}

function switchTab(path) { if (!state.openFiles.has(path)) return; state.currentFile = path; renderTabs(); renderEditor(); }

function closeTab(path) {
    state.openFiles.delete(path);
    if (state.currentFile === path) { const k = [...state.openFiles.keys()]; state.currentFile = k.length ? k[k.length - 1] : null; }
    renderTabs(); renderEditor();
}

function closeOtherTabs(keep) {
    for (const p of [...state.openFiles.keys()]) if (p !== keep) state.openFiles.delete(p);
    state.currentFile = keep; renderTabs(); renderEditor();
}

function closeAllTabs() { state.openFiles.clear(); state.currentFile = null; renderTabs(); renderEditor(); }

// ======================== HORIZONTAL SCROLL ON WHEEL ====================
document.getElementById('tabs').addEventListener('wheel', e => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    e.currentTarget.scrollLeft += e.deltaY;
}, { passive: false });
