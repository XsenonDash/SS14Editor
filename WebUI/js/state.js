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
    }
}
