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
    fs.dirtySinceSave?.add(path[0]);
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
    fs.dirtySinceSave?.add(path[0]);
    state.resolvedCache.clear();
    commitChange(fs);
    scheduleRenderEditor();
}



function commitChange(fs) {
    let nc;
    if (fs.doc && fs.dirtyProtos?.size > 0 &&
        fs.yaml.length === fs.doc.contents?.items?.length) {
        nc = dumpYamlRespectful(fs.yaml, fs.doc, fs.content, fs.dirtyProtos);
    } else if (fs.structuralChange && fs.doc && YAML.isSeq(fs.doc.contents)) {
        nc = dumpYamlRespectfulStructural(fs.yaml, fs.content, fs.doc, fs.protoAstRefs);
    } else {
        nc = dumpYaml(fs.yaml);
    }
    const { doc } = parseYamlDoc(nc);
    fs.doc = doc;
    fs.dirtyProtos = new Set();
    fs.structuralChange = false;
    fs.pushHistory(nc);
    relinkProtoAst(fs);
    state.resolvedCache.clear();
    renderTabs(); scheduleAutosave(fs);
}

// ======================== AUTOSAVE =====================================
//
// Before writing, re-read the current disk content. If the file was edited
// externally (e.g. comments added in VSCode) between the time it was loaded
// here and now, dumpYamlMergeDisk weaves the editor's per-proto changes back
// onto the fresh disk text — external comments survive autosave. Falls back
// to writing `fs.content` verbatim when structural changes make merging
// unsafe (proto added / deleted / reordered).
function scheduleAutosave(fs) {
    if (fs.readOnly) return;
    clearTimeout(fs._saveTimer);
    fs._saveTimer = setTimeout(async () => {
        try {
            let payload = fs.content;
            if (!fs.structuralChange && fs.doc && fs.yaml && fs.dirtySinceSave?.size > 0) {
                try {
                    const disk = await api.loadFile(fs.path);
                    if (disk && typeof disk.content === 'string' && disk.content !== fs.content) {
                        const { doc: diskDoc } = parseYamlDoc(disk.content);
                        const merged = dumpYamlMergeDisk(
                            fs.yaml, fs.doc, disk.content, diskDoc, fs.dirtySinceSave);
                        if (merged != null) payload = merged;
                    }
                } catch (e) {
                    // Re-read failure is non-fatal — fall back to fs.content.
                    console.warn('[Editor] disk re-read failed, saving editor content as-is:', e);
                }
            }
            await api.saveFile(fs.path, payload);
            if (payload !== fs.content) {
                // Keep in-memory state coherent with what we just wrote: re-parse
                // the merged text so future commits use ranges aligned with disk.
                fs.content = payload;
                fs.history[fs.historyIdx] = payload;
                const { doc } = parseYamlDoc(payload);
                fs.doc = doc;
                relinkProtoAst(fs);
            }
            fs.dirtySinceSave.clear();
            fs.structuralChange = false;
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
    fs.dirtySinceSave = new Set();
    fs.structuralChange = false;
    relinkProtoAst(fs);
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
    fs.dirtySinceSave = new Set();
    fs.structuralChange = false;
    relinkProtoAst(fs);
    state.resolvedCache.clear();
    renderEditor(); renderTabs(); scheduleAutosave(fs);
}
