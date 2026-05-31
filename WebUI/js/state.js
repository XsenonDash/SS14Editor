// ======================================================================
//  SS14 Editor – State Management
// ======================================================================

'use strict';

const state = {
    metadata   : null,
    fileTree   : null,
    protoIndex : null,
    openFiles  : new Map(),
    currentFile: null,
    resolvedCache: new Map(),
    protoLookup: null,            // lazily-built Map<type:id → proto object> for O(1) resolveProto
    fileProtoIds: null,           // lazily-built Map<file_path → string[]> of lowercase proto IDs per file
    parentFileCache: new Map(),   // filePath → parsed yaml array (for inheritance lookup)
    expandedDirs: new Set(),      // tree directory paths that are currently expanded (preserved across re-renders)
    gitStatus  : null,            // { available, files: { 'rel/path.yml': 'new'|'modified'|'deleted'|'renamed'|'conflict' } }

    // Editor groups: each group owns an ordered tab list and a visible active tab.
    // state.openFiles is shared across all groups (file data is loaded once).
    groups      : [{ id: 'g1', tabs: [], activeTab: null }],
    activeGroupId: 'g1',
};

class FileState {
    constructor(path, content) {
        this.path           = path;
        this.content        = content;
        this.yaml           = null;
        this.doc            = null;
        this.modified       = false;
        this._saveTimer     = null;
        this.dirtyProtos    = new Set();
        this.dirtySinceSave = new Set();
        this._undoStack          = [];   // string[] — past content snapshots
        this._redoStack          = [];   // string[] — future content snapshots
        this._lastSnapshotTime   = 0;    // ms timestamp of last pushed snapshot
        this._lastSnapshotProtoIdx = undefined; // proto index of last pushed snapshot
        // Persistent collapse state — survives undo/redo because it is UI state,
        // not YAML content. Shape: { protos: {[pid]: bool}, comps: {[pid]: {[ct]: bool}}, datadefs: {[path]: bool} }
        this._collapseState = { protos: {}, comps: {}, datadefs: {} };
    }
}
