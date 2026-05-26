// ======================================================================
//  SS14 Prototype Editor – Mutation, Autosave, Undo/Redo
// ======================================================================
//  setFieldValue / deleteField are the single chokepoints every editor
//  mutation routes through, so collapse-state preservation, dirty-flag
//  tracking, autosave debouncing, and undo/redo all hang off them.
// ======================================================================

'use strict';

// Unified field update: works for proto fields, component fields, and datadef fields.
// `path` is an array of keys to reach the target object, e.g.:
//   proto field:     [protoIdx]               → fs.yaml[protoIdx]
//   component field: [protoIdx, 'components', compIdx] → fs.yaml[protoIdx].components[compIdx]
function setFieldValue(path, tag, value, filePath) {
    const fs = state.openFiles.get(filePath ?? state.currentFile);
    if (!fs) return;
    let obj = fs.yaml;
    for (const key of path) { obj = obj?.[key]; }
    if (!obj) return;
    obj[tag] = value;
    if (fs.doc) docSetField(fs.doc, path, tag, value);
    fs.dirtyProtos?.add(path[0]);
    state.resolvedCache.clear();
    commitChange(fs);
    scheduleRenderEditor();
}

function deleteField(path, tag, filePath) {
    const fs = state.openFiles.get(filePath ?? state.currentFile);
    if (!fs) return;
    let obj = fs.yaml;
    for (const key of path) { obj = obj?.[key]; }
    if (!obj) return;
    delete obj[tag];
    if (fs.doc) docDeleteField(fs.doc, path, tag);
    fs.dirtyProtos?.add(path[0]);
    state.resolvedCache.clear();
    commitChange(fs);
    scheduleRenderEditor();
}



function commitChange(fs) {
    let nc;
    if (fs.doc && fs.dirtyProtos?.size > 0 &&
        fs.yaml.length === fs.doc.contents?.items?.length) {
        nc = dumpYamlRespectful(fs.yaml, fs.doc, fs.content, fs.dirtyProtos);
    } else {
        nc = dumpYaml(fs.yaml);
    }
    const { doc } = parseYamlDoc(nc);
    fs.doc = doc;
    fs.dirtyProtos = new Set();
    state.resolvedCache.clear();
    fs.pushHistory(nc); renderTabs(); scheduleAutosave(fs);
}

// ======================== AUTOSAVE =====================================
function scheduleAutosave(fs) {
    if (fs.readOnly) return;
    clearTimeout(fs._saveTimer);
    fs._saveTimer = setTimeout(async () => {
        try {
            await api.saveFile(fs.path, fs.content);
            fs.modified = false; renderTabs(); toast('Saved', 'success');
            // Refresh git decorations so the tree + tabs colour the file as
            // modified. The Ctrl+S handler does the same — autosave used to
            // skip it, leaving the tree stale until the next SSE event.
            scheduleGitRefresh(100);
        }
        catch (e) {
            console.error('[Editor] Save failed:', fs.path, e);
            toast(`Save failed: ${e.message}`, 'error');
        }
    }, CFG.autosaveDelay);
}

// ======================== UNDO / REDO ==================================
function handleUndo() {
    const fs = state.openFiles.get(state.currentFile);
    if (!fs || !fs.undo()) return;
    const { protos, doc } = parseYamlDoc(fs.content);
    fs.yaml = protos;
    fs.doc = doc;
    fs.dirtyProtos = new Set();
    state.resolvedCache.clear();
    renderEditor(); renderTabs(); scheduleAutosave(fs);
}

function handleRedo() {
    const fs = state.openFiles.get(state.currentFile);
    if (!fs || !fs.redo()) return;
    const { protos, doc } = parseYamlDoc(fs.content);
    fs.yaml = protos;
    fs.doc = doc;
    fs.dirtyProtos = new Set();
    state.resolvedCache.clear();
    renderEditor(); renderTabs(); scheduleAutosave(fs);
}
