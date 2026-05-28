// ======================================================================
//  SS14 Editor – Add / Copy Prototype modal
// ======================================================================
//  The "+ Add Prototype" workflow: pick type → empty vs copy → (if copy)
//  pick source. Also exposes addNewPrototype / copyPrototype helpers.
// ======================================================================

'use strict';

function showAddProtoModal(insertIdx) {
    const overlay = _div('modal-overlay');
    const modal = _div('modal');
    modal.innerHTML = `<div class="modal-header"><h3>Add Prototype</h3><button class="modal-close">\u00d7</button></div>
        <div class="modal-body"></div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const body = modal.querySelector('.modal-body');
    modal.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    // ── Step 1: pick prototype type ──────────────────────────────────
    // List = union of metadata-declared types and types actually present in
    // YAML. The two can diverge when the C# class name doesn't follow the
    // FooPrototype → "foo" convention; using the union ensures the user can
    // always pick a type that has clonable instances on disk.
    function showStepType() {
        modal.querySelector('h3').textContent = 'Add Prototype';
        body.innerHTML = `<input type="text" class="field-input modal-search" placeholder="Search prototype type\u2026" autocomplete="off"><div class="modal-list"></div>`;
        const searchInp = body.querySelector('.modal-search');
        const listEl = body.querySelector('.modal-list');
        const typeSet = new Set();
        if (state.metadata?.prototypes) for (const k of Object.keys(state.metadata.prototypes)) typeSet.add(k);
        if (state.protoIndex) for (const k of Object.keys(state.protoIndex)) typeSet.add(k);
        const types = [...typeSet].sort();
        function renderList(q) {
            listEl.innerHTML = '';
            const filtered = types.filter(t => smartMatch(t, q));
            if (!filtered.length) { listEl.innerHTML = '<div class="dropdown-empty">No types found</div>'; return; }
            for (const t of filtered.slice(0, 100)) {
                const el = _div('modal-list-item');
                el.textContent = t;
                el.addEventListener('click', () => showStepMode(t));
                listEl.appendChild(el);
            }
        }
        renderList('');
        searchInp.addEventListener('input', () => renderList(searchInp.value));
        searchInp.focus();
    }

    // ── Step 2: empty vs copy-from-existing ──────────────────────────
    // Copy is disabled when the picked type has no instances on disk —
    // there's nothing to clone from. Case-insensitive lookup so a
    // metadata-derived key that doesn't exactly match the YAML literal
    // still resolves (matches the server-side Search fallback).
    function showStepMode(type) {
        modal.querySelector('h3').textContent = `Add ${type}`;
        const resolved = findProtoEntries(type);
        const canCopy = resolved.entries.length > 0;
        const copyHint = canCopy
            ? `Pick an existing ${esc(resolved.key)} and clone all its fields.`
            : `No existing <code>${esc(type)}</code> prototypes on disk to clone from.`;
        body.innerHTML = `
            <div class="add-proto-mode-row">
                <button class="add-proto-mode-btn" data-mode="empty">
                    <div class="add-proto-mode-title">Empty prototype</div>
                    <div class="add-proto-mode-hint">Start from a fresh ${esc(type)} with only <code>id</code> set.</div>
                </button>
                <button class="add-proto-mode-btn" data-mode="copy"${canCopy ? '' : ' disabled'}>
                    <div class="add-proto-mode-title">Copy from existing</div>
                    <div class="add-proto-mode-hint">${copyHint}</div>
                </button>
            </div>
            <div class="modal-back-row"><button class="modal-back-btn">\u2190 Back</button></div>`;
        body.querySelector('[data-mode="empty"]').addEventListener('click', () => {
            overlay.remove();
            addNewPrototype(type, insertIdx);
        });
        if (canCopy) {
            body.querySelector('[data-mode="copy"]').addEventListener('click', () => showStepCopy(resolved.key));
        }
        body.querySelector('.modal-back-btn').addEventListener('click', showStepType);
    }

    // ── Step 3: pick source prototype to clone ───────────────────────
    function showStepCopy(type) {
        modal.querySelector('h3').textContent = `Copy ${type}`;
        body.innerHTML = `
            <input type="text" class="field-input modal-search" placeholder="Search ${esc(type)} prototype\u2026" autocomplete="off">
            <div class="modal-list"></div>
            <div class="modal-back-row"><button class="modal-back-btn">\u2190 Back</button></div>`;
        const searchInp = body.querySelector('.modal-search');
        const listEl = body.querySelector('.modal-list');
        body.querySelector('.modal-back-btn').addEventListener('click', () => showStepMode(type));
        let timer;
        async function doSearch(q) {
            try {
                const tokens = String(q || '').trim().split(/\s+/).filter(Boolean);
                const serverHint = tokens[0] || '';
                const res = await api.searchProtos(type, serverHint);
                const refined = tokens.length > 1
                    ? res.filter(r => smartMatch(r.id, q) || smartMatch(r.name || '', q))
                    : res;
                listEl.innerHTML = '';
                if (!refined.length) { listEl.innerHTML = '<div class="dropdown-empty">No prototypes found</div>'; return; }
                for (const r of refined.slice(0, 200)) {
                    const el = _div('modal-list-item');
                    el.textContent = r.id;
                    el.addEventListener('click', () => {
                        overlay.remove();
                        copyPrototype(type, r.id, insertIdx);
                    });
                    listEl.appendChild(el);
                }
            } catch (e) { console.error('[AddProto] search failed:', e); }
        }
        searchInp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => doSearch(searchInp.value), CFG.searchDebounce); });
        searchInp.focus();
        doSearch('');
    }

    showStepType();
}

/**
 * Find proto-index entries for a given type with a case-insensitive
 * fallback. Returns `{ key, entries }` where `key` is the actual index
 * key that matched (so callers can pass it on to /api/search-protos) and
 * `entries` is the matching array (empty when nothing matches).
 */
function findProtoEntries(type) {
    const idx = state.protoIndex || {};
    if (idx[type]?.length) return { key: type, entries: idx[type] };
    const lc = String(type).toLowerCase();
    for (const k of Object.keys(idx)) {
        if (k.toLowerCase() === lc) return { key: k, entries: idx[k] };
    }
    return { key: type, entries: [] };
}

/**
 * Deep-clone an existing prototype into the currently open file. The
 * source proto's YAML is loaded fresh from disk (it may live in a
 * different file than the current one), all keys are copied verbatim,
 * and the id is mutated to a unique name so the new entry doesn't
 * collide with the original.
 */
async function copyPrototype(type, sourceId, insertIdx) {
    const entries = state.protoIndex?.[type] || [];
    const entry = entries.find(e => e.id === sourceId);
    if (!entry?.file) { toast('Source prototype not found in index'); return; }
    let src;
    try {
        // Prefer the in-memory yaml of an open tab so any unsaved edits
        // are honoured; fall back to a disk read otherwise.
        const openFs = state.openFiles.get(entry.file);
        const yaml = openFs?.yaml ?? parseYaml((await api.loadFile(entry.file)).content);
        src = (Array.isArray(yaml) ? yaml : []).find(p => p?.type === type && p?.id === sourceId);
    } catch (e) {
        toast('Failed to read source file: ' + e.message);
        return;
    }
    if (!src) { toast(`Prototype "${sourceId}" not found in ${entry.file}`); return; }
    const fs = state.openFiles.get(state.currentFile);
    if (!fs) return;
    if (!Array.isArray(fs.yaml)) fs.yaml = [];
    const clone = JSON.parse(JSON.stringify(src));
    clone.id = _generateUniqueProtoId(type, sourceId);
    const at = (typeof insertIdx === 'number' && insertIdx >= 0 && insertIdx <= fs.yaml.length)
        ? insertIdx : fs.yaml.length;
    fs.yaml.splice(at, 0, clone);
    fs.structuralChange = true;
    commitChange(fs);
    renderEditor();
    if (at === fs.yaml.length - 1) {
        const area = document.querySelector(`.editor-group[data-group-id="${state.activeGroupId}"] .group-content`);
        if (area) area.scrollTop = area.scrollHeight;
    }
}

function _generateUniqueProtoId(type, base) {
    const entries = state.protoIndex?.[type] || [];
    const used = new Set(entries.map(e => e.id));
    let id = base + 'Copy';
    let n = 1;
    while (used.has(id)) { id = base + 'Copy' + n; n++; }
    return id;
}

function addNewPrototype(type, insertIdx) {
    const fs = state.openFiles.get(state.currentFile);
    if (!fs) return;
    if (!Array.isArray(fs.yaml)) fs.yaml = [];
    const proto = { type, id: 'NewPrototype' };
    // NOTE: we intentionally do NOT seed `proto.parent = ''` here. An empty
    // parent slot would force every new prototype into a half-filled state
    // and dump as `parent: ''` until the user manually clears it. The
    // parent control still works without seeding because the user can click
    // "+ Add item" on the parent bar which commits an empty slot via
    // `onParentChange` — keeping the add-item codepath intact.
    const at = (typeof insertIdx === 'number' && insertIdx >= 0 && insertIdx <= fs.yaml.length)
        ? insertIdx : fs.yaml.length;
    fs.yaml.splice(at, 0, proto);
    fs.structuralChange = true;
    commitChange(fs);
    renderEditor();
    if (at === fs.yaml.length - 1) {
        const area = document.querySelector(`.editor-group[data-group-id="${state.activeGroupId}"] .group-content`);
        if (area) area.scrollTop = area.scrollHeight;
    }
}
