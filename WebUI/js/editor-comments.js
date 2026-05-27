// ======================================================================
//  SS14 Prototype Editor – YAML Comment Visualization & Editing
// ======================================================================
//  Unified architecture: every comment surface (inline-on-field, before-field,
//  between-protos, trailing-file, future deep collection items) is rendered
//  through one component pair:
//
//    CommentTarget   – { getInline, setInline, getBefore, setBefore,
//                        markDirty, softRefresh }   plain object describing
//                        WHERE the comment lives in the YAML AST.
//    attachInlineComment(row, target)   – appends inline-comment view + delete
//                        button + chat-bubble (mutually exclusive) to a row.
//    buildCommentBlock(target, kind)    – returns a standalone comment block
//                        (used for proto-level, trailing-file, before-field).
//
//  All editors use the same in-place behaviour: click the comment text → it
//  turns INTO a textarea (no popup), Enter saves & closes, Esc cancels,
//  blur saves. Before mutating, the textarea is blurred so the render-loop's
//  focus-restoration code does NOT pick up a sibling field-row input.
// ======================================================================

'use strict';

// 14×14 icons — match the visual size of the × in .item-remove-btn so the
// chat-bubble button is the same height as the surrounding action buttons.
const COMMENT_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
</svg>`;
const PLUS_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
</svg>`;

// ──────────────────────────────────────────────────────────────────────
//  Comment-line view + in-place edit primitive
// ──────────────────────────────────────────────────────────────────────
function _renderCommentLines(text) {
    const wrap = _div('yaml-comment-view');
    for (const line of String(text).split('\n')) {
        const lineEl = _div('yaml-comment-line');
        const hash = _el('span');
        hash.className = 'yaml-comment-hash';
        hash.textContent = '#';
        const txt = _el('span');
        txt.className = 'yaml-comment-text';
        txt.textContent = ' ' + line;
        lineEl.appendChild(hash);
        lineEl.appendChild(txt);
        wrap.appendChild(lineEl);
    }
    return wrap;
}

/** Replace `viewEl` inside its parent with a textarea editing `initialText`.
 *  onSave receives the trimmed text (null when empty).
 *  onCancel restores `viewEl` (called for Esc and blur-without-change). */
function _editInPlace(viewEl, initialText, onSave, onCancel) {
    const parent = viewEl.parentNode;
    if (!parent) return;
    const ta = _el('textarea');
    ta.className = 'yaml-comment-inplace';
    ta.value = initialText || '';
    ta.spellcheck = false;
    ta.rows = Math.max(1, ta.value.split('\n').length);
    parent.replaceChild(ta, viewEl);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);

    let done = false;
    function finish(save) {
        if (done) return;
        done = true;
        // Always blur before triggering re-render — the render-loop restores
        // focus to whichever field-row contains document.activeElement, and
        // we don't want to refocus a sibling input.
        if (document.activeElement === ta) ta.blur();
        const newText = ta.value.trim() || null;
        const changed = (newText || '') !== (initialText || '');
        if (save && changed) {
            onSave(newText);
        } else {
            // Restore view in-place (no commit, no re-render).
            if (ta.parentNode) ta.parentNode.replaceChild(viewEl, ta);
            onCancel?.();
        }
    }
    ta.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    });
    ta.addEventListener('blur', () => finish(true));
}

/** Create an empty placeholder + immediately start editing it.
 *  On cancel/empty, calls onAbort (which usually restores the chat-bubble). */
function _editInPlaceFresh(parent, onSave, onAbort, opts = {}) {
    const ta = _el('textarea');
    ta.className = 'yaml-comment-inplace yaml-comment-inplace--new';
    if (opts.placeholder) ta.placeholder = opts.placeholder;
    ta.spellcheck = false;
    ta.rows = 1;
    parent.appendChild(ta);
    setTimeout(() => ta.focus(), 0);
    let done = false;
    function finish(save) {
        if (done) return;
        done = true;
        if (document.activeElement === ta) ta.blur();
        const text = ta.value.trim();
        if (save && text) onSave(text);
        else { ta.remove(); onAbort?.(); }
    }
    ta.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    });
    ta.addEventListener('blur', () => finish(true));
    return ta;
}

// ──────────────────────────────────────────────────────────────────────
//  CommentTarget factories — the only thing different between contexts is
//  HOW the comment is read/written and what counts as "dirty".
// ──────────────────────────────────────────────────────────────────────

function _makeProtoFieldDirty(fs, protoIdx) {
    fs.dirtyProtos?.add(protoIdx);
    fs.dirtySinceSave?.add(protoIdx);
    commitChange(fs);
    scheduleRenderEditor();
}

/** Field-pair (`key: value`) inside a Map node. Works for proto-level
 *  fields, component fields, and any nested map pair. */
function commentTargetForPair(filePath, protoIdx, pair) {
    return {
        getInline: () => pair ? _pairInlineComment(pair) : null,
        setInline: (t) => { if (pair) _setPairInlineComment(pair, t); },
        getBefore: () => pair?.key?.commentBefore ?? null,
        setBefore: (t) => { if (pair?.key) pair.key.commentBefore = t ? (t.startsWith(' ') ? t : ' ' + t) : undefined; },
        markDirty: () => { const fs = state.openFiles.get(filePath); if (fs) _makeProtoFieldDirty(fs, protoIdx); },
    };
}

/** Single-pair inside a Map seq-item — `- key: value` shorthand. Used to
 *  detect the common SS14 shape where a comment after the value (e.g.
 *  `- category: Breathing # cmt`) actually lives on the inner scalar's
 *  trailing comment, not on the seq item itself. Returning the pair lets
 *  the seq-item target read/write through that scalar. */
function _innerSinglePair(item) {
    if (item && YAML.isMap(item) && item.items?.length === 1) return item.items[0];
    return null;
}

/** A scalar/map/seq item inside a sequence (one level deeper than a pair).
 *  yaml-lib v2 has THREE places a comment for a seq item can land:
 *
 *    1. `parentSeq.commentBefore`  — a free-floating `# cmt` between the
 *       key colon and the first item (`order:\n  # cmt\n  - x`). Only
 *       attached to items[0] in our model.
 *    2. `item.commentBefore`       — `# cmt` line just above this item
 *       (`- a\n  # cmt\n  - b` → b.commentBefore).
 *    3. inner scalar trailing      — `- k: v # cmt` parses with the
 *       comment on the inner pair's value scalar. Round-trips cleanly
 *       so we prefer this slot when the item is a single-pair Map.
 *
 *  Falls back to `item.comment` (trailing on scalar items) for completeness.
 *
 *  `parentSeq` is non-null only for items[0]; the caller wires the rest
 *  with `parentSeq=null` so each item still owns its own comment. */
function commentTargetForSeqItem(filePath, protoIdx, item, parentSeq = null) {
    // Tagged Map items (`- !type:Foo\n  field: 1`) belong with the tag
    // line conceptually — the comment must live on the *item* node,
    // not on its inner scalar, otherwise editing moves a `# cmt` from
    // the `!type:Foo` line down to the first field row.
    const isTaggedMap = item && YAML.isMap(item) && typeof item.tag === 'string' && item.tag.startsWith('!type:');
    return {
        getInline: () => {
            if (parentSeq?.commentBefore?.trim()) return parentSeq.commentBefore.trim();
            if (item?.commentBefore?.trim()) return item.commentBefore.trim();
            if (!isTaggedMap) {
                const innerP = _innerSinglePair(item);
                if (innerP && YAML.isScalar(innerP.value) && innerP.value.comment)
                    return innerP.value.comment.trim();
            }
            if (typeof item?.comment === 'string' && item.comment.trim())
                return item.comment.trim();
            return null;
        },
        setInline: (t) => {
            if (!item) return;
            const val = t ? ' ' + t : undefined;
            // Clear all 3 slots first so we never end up with duplicates.
            if (parentSeq) parentSeq.commentBefore = undefined;
            item.commentBefore = undefined;
            item.comment = undefined;
            const innerP = _innerSinglePair(item);
            if (innerP && YAML.isScalar(innerP.value)) innerP.value.comment = undefined;

            if (val === undefined) return;
            // Tagged-Map items: keep the comment on the item node so it
            // stays attached to the `!type:Foo` line (yaml-lib may render
            // it on the preceding indent, but it never migrates to a field).
            if (isTaggedMap) { item.commentBefore = val; return; }
            // Prefer the inner-scalar trailing slot for `- k: v` items so the
            // saved YAML reads `- k: v # cmt` — matches the source style most
            // SS14 prototypes use. Otherwise fall back to commentBefore (the
            // only slot that round-trips reliably for non-scalar seq items).
            if (innerP && YAML.isScalar(innerP.value)) { innerP.value.comment = val; return; }
            item.commentBefore = val;
        },
        getBefore: () => parentSeq?.commentBefore?.trim() ?? item?.commentBefore?.trim() ?? null,
        setBefore: (t) => {
            if (!item) return;
            const val = t ? ' ' + t : undefined;
            if (parentSeq) parentSeq.commentBefore = undefined;
            item.commentBefore = val;
        },
        markDirty: () => { const fs = state.openFiles.get(filePath); if (fs) _makeProtoFieldDirty(fs, protoIdx); },
    };
}

// ── Resolvers from logical paths to AST nodes ──────────────────────────
function _resolveProtoFieldPair(doc, protoIdx, key) {
    const item = doc?.contents?.items?.[protoIdx];
    if (!YAML.isMap(item)) return null;
    return item.items.find(p => YAML.isScalar(p.key) && p.key.value === key) ?? null;
}
function _resolveCompFieldPair(doc, protoIdx, compIdx, key) {
    const map = _resolveComponentMap(doc, protoIdx, compIdx);
    if (!map) return null;
    return map.items.find(p => YAML.isScalar(p.key) && p.key.value === key) ?? null;
}

/** Top-level proto field. */
function commentTargetForProtoField(filePath, protoIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    const pair = fs?.doc ? _resolveProtoFieldPair(fs.doc, protoIdx, fieldKey) : null;
    return pair ? commentTargetForPair(filePath, protoIdx, pair) : null;
}
/** Component field. */
function commentTargetForCompField(filePath, protoIdx, compIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    const pair = fs?.doc ? _resolveCompFieldPair(fs.doc, protoIdx, compIdx, fieldKey) : null;
    return pair ? commentTargetForPair(filePath, protoIdx, pair) : null;
}

// ── Inter-proto (before a proto in the file) — uses raw-content patch ─
function commentTargetForBetweenProtos(filePath, insertIdx) {
    return {
        getInline: () => null,
        setInline: () => {},
        getBefore: () => {
            const fs = state.openFiles.get(filePath);
            return fs?.doc ? getProtoCommentBefore(fs.doc, insertIdx) : null;
        },
        setBefore: (t) => {
            const fs = state.openFiles.get(filePath);
            if (!fs?.doc) return;
            const result = patchProtoCommentInContent(fs.content, fs.doc, insertIdx, t);
            if (result) _applyRawContentPatch(fs, result);
        },
        markDirty: () => { /* setBefore already commits */ },
    };
}
function commentTargetForTrailingFile(filePath) {
    return {
        getInline: () => null,
        setInline: () => {},
        getBefore: () => {
            const fs = state.openFiles.get(filePath);
            return (fs?.doc && fs.content) ? getTrailingComment(fs.content, fs.doc) : null;
        },
        setBefore: (t) => {
            const fs = state.openFiles.get(filePath);
            if (!fs?.doc) return;
            const result = patchTrailingCommentInContent(fs.content, fs.doc, t);
            if (result) _applyRawContentPatch(fs, result);
        },
        markDirty: () => { /* setBefore already commits */ },
    };
}

function _applyRawContentPatch(fs, result) {
    fs.content = result.newContent;
    fs.doc = result.newDoc;
    fs.dirtySinceSave = new Set();
    relinkProtoAst(fs);
    fs.modified = true;
    renderTabs();
    scheduleAutosave(fs);
    scheduleRenderEditor();
}

// ──────────────────────────────────────────────────────────────────────
//  attachInlineComment — appends inline-comment surface to a field row.
//  Mutually exclusive UI: comment exists ⇒ view + delete; otherwise ⇒
//  chat-bubble button. Editing happens IN PLACE on the view itself.
// ──────────────────────────────────────────────────────────────────────
function attachInlineComment(row, target) {
    if (!target) return;
    if (target.placement === 'block-above') { _attachBlockCommentAboveRow(row, target); return; }
    const inlineText = target.getInline();

    if (inlineText) {
        const host = _div('field-inline-comment yaml-comment-host');
        const view = _renderCommentLines(inlineText);
        view.classList.add('yaml-comment-view--editable');
        view.title = 'Click to edit (Enter = save, Esc = cancel)';
        host.appendChild(view);
        view.addEventListener('click', e => {
            e.stopPropagation();
            _editInPlace(view, inlineText,
                newText => { target.setInline(newText); target.markDirty(); },
                null);
        });
        row.appendChild(host);

        const delBtn = _el('button');
        delBtn.type = 'button';
        delBtn.className = 'field-comment-delete-btn';
        delBtn.textContent = '×';
        delBtn.title = 'Delete comment';
        delBtn.addEventListener('click', e => {
            e.stopPropagation();
            target.setInline(null);
            target.markDirty();
        });
        row.appendChild(delBtn);
        return;
    }

    // No comment yet — chat-bubble that morphs into an empty textarea.
    const btn = _el('button');
    btn.type = 'button';
    btn.className = 'field-comment-btn';
    btn.title = 'Add comment';
    btn.innerHTML = COMMENT_ICON_SVG;
    btn.addEventListener('click', e => {
        e.stopPropagation();
        const host = _div('field-inline-comment field-inline-comment--editing');
        btn.replaceWith(host);
        _editInPlaceFresh(host,
            text => { target.setInline(text); target.markDirty(); },
            () => host.replaceWith(btn),
            { placeholder: 'comment…' });
    });
    btn.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
            { label: 'Add inline comment', action: () => btn.click() },
            { label: 'Add comment above',  action: () => _startBeforeEdit(row, target) },
        ]);
    });
    row.appendChild(btn);
}

// commentBefore for a field-row → renders a standalone block ABOVE the row.
function buildFieldCommentBefore(filePath, protoIdx, fieldKey) {
    const target = commentTargetForProtoField(filePath, protoIdx, fieldKey);
    if (!target) return null;
    const text = target.getBefore();
    if (!text) return null;
    return _buildCommentBlock(text, target, 'field');
}
function buildComponentFieldCommentBefore(filePath, protoIdx, compIdx, fieldKey) {
    const target = commentTargetForCompField(filePath, protoIdx, compIdx, fieldKey);
    if (!target) return null;
    const text = target.getBefore();
    if (!text) return null;
    return _buildCommentBlock(text, target, 'field');
}

function _startBeforeEdit(row, target) {
    // Insert a temporary editor right before the row.
    const parent = row.parentNode;
    if (!parent) return;
    const host = _div('yaml-comment-block yaml-comment-block--field yaml-comment-block--editing');
    parent.insertBefore(host, row);
    _editInPlaceFresh(host,
        text => { target.setBefore(text); target.markDirty(); },
        () => host.remove(),
        { placeholder: 'comment above…' });
}

// ──────────────────────────────────────────────────────────────────────
//  Standalone comment blocks (between protos, before fields, file trailing).
//  All three share the SAME pattern: click → in-place edit, hover → delete.
// ──────────────────────────────────────────────────────────────────────
function _buildCommentBlock(text, target, kind) {
    // kind = 'proto' | 'field' | 'trailing'
    const block = _div(`yaml-comment-block yaml-comment-block--${kind}`);
    const host = _div('yaml-comment-host');
    const view = _renderCommentLines(text);
    view.classList.add('yaml-comment-view--editable');
    view.title = 'Click to edit (Enter = save, Esc = cancel)';
    host.appendChild(view);
    block.appendChild(host);
    view.addEventListener('click', e => {
        e.stopPropagation();
        _editInPlace(view, text,
            newText => { target.setBefore(newText); target.markDirty(); },
            null);
    });
    const delBtn = _el('button');
    delBtn.type = 'button';
    delBtn.className = 'field-comment-delete-btn yaml-comment-block-del';
    delBtn.textContent = '×';
    delBtn.title = 'Delete comment';
    delBtn.addEventListener('click', e => {
        e.stopPropagation();
        target.setBefore(null);
        target.markDirty();
    });
    block.appendChild(delBtn);
    return block;
}

function buildProtoCommentBlock(filePath, protoIdx) {
    const target = commentTargetForBetweenProtos(filePath, protoIdx);
    const text = target.getBefore();
    if (!text) return null;
    const block = _buildCommentBlock(text, target, 'proto');
    _wireProtoCommentDrag(block, filePath, protoIdx, text);
    return block;
}

// ─────────────────────────────────────────────────────────────────────
//  Drag-and-drop for inter-proto comment blocks.
//  Drag a free-floating comment to any inter-proto-toolbar slot to
//  move it there. Implemented as raw-content patches (same machinery
//  used by setBefore) so the file's commentBefore on the AST proto
//  node tracks the new position; the structural dump is not involved.
//  Dropping back onto the same slot is a no-op.
// ─────────────────────────────────────────────────────────────────────
const _PROTO_COMMENT_MIME = 'application/x-proto-comment';

function _wireProtoCommentDrag(block, filePath, srcInsertIdx, text) {
    block.draggable = true;
    block.classList.add('yaml-comment-block--draggable');
    block.addEventListener('dragstart', e => {
        // Don't trigger drag when the user is mid-edit on the comment.
        if (e.target.closest('.yaml-comment-view--editing') ||
            e.target.tagName === 'TEXTAREA') { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'move';
        const payload = JSON.stringify({ filePath, src: srcInsertIdx, text });
        e.dataTransfer.setData(_PROTO_COMMENT_MIME, payload);
        e.dataTransfer.setData('text/plain', text);
        block.classList.add('dragging');
        document.querySelectorAll('.editor-area').forEach(a =>
            a.classList.add('dragging-proto-comment'));
    });
    block.addEventListener('dragend', () => {
        block.classList.remove('dragging');
        document.querySelectorAll('.editor-area').forEach(a =>
            a.classList.remove('dragging-proto-comment'));
    });
}

// Called by buildInterProtoToolbar to register the toolbar as a drop slot.
function _wireInterProtoToolbarDrop(bar, filePath, insertIdx) {
    bar.addEventListener('dragover', e => {
        if (!e.dataTransfer.types.includes(_PROTO_COMMENT_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        bar.classList.add('drop-target');
    });
    bar.addEventListener('dragleave', () => bar.classList.remove('drop-target'));
    bar.addEventListener('drop', e => {
        bar.classList.remove('drop-target');
        const raw = e.dataTransfer.getData(_PROTO_COMMENT_MIME);
        if (!raw) return;
        e.preventDefault();
        let payload;
        try { payload = JSON.parse(raw); } catch { return; }
        if (payload.filePath !== filePath) return;
        // Moving to the same slot (or to the slot directly after — visually
        // identical since the block sits below the toolbar at insertIdx) is
        // a no-op.
        if (payload.src === insertIdx) return;
        // Clear source, then write target. Both go through the raw-content
        // patch path so we don't disturb other comments or proto bodies.
        const fs = state.openFiles.get(filePath);
        if (!fs?.doc) return;
        commentTargetForBetweenProtos(filePath, payload.src).setBefore(null);
        // After the clear, fs.doc has been re-parsed; insertIdx still refers
        // to the same logical slot (commentBefore is a property of the
        // proto-item AST node, not a positional ghost).
        commentTargetForBetweenProtos(filePath, insertIdx).setBefore(payload.text);
    });
}

function buildTrailingCommentBlock(filePath) {
    const target = commentTargetForTrailingFile(filePath);
    const text = target.getBefore();
    if (!text) return null;
    return _buildCommentBlock(text, target, 'trailing');
}

// Backwards-compat shim — old callers may still reference this name.
function writeProtoComment(filePath, protoIdx, newText) {
    commentTargetForBetweenProtos(filePath, protoIdx).setBefore(newText);
}

// ──────────────────────────────────────────────────────────────────────
//  Public wrappers that other modules call from cards / component bodies.
// ──────────────────────────────────────────────────────────────────────
function attachFieldComment(row, filePath, protoIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    const pair = fs?.doc ? _resolveProtoFieldPair(fs.doc, protoIdx, fieldKey) : null;
    if (!pair) return;
    _attachPairCommentAuto(row, filePath, protoIdx, pair);
}
function attachComponentFieldComment(row, filePath, protoIdx, compIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    const pair = fs?.doc ? _resolveCompFieldPair(fs.doc, protoIdx, compIdx, fieldKey) : null;
    if (!pair) return;
    _attachPairCommentAuto(row, filePath, protoIdx, pair);
}

// Picks inline-vs-block placement based on the pair's value kind:
//   scalar / single-scalar Seq → inline at end of row (same flex line).
//   Map / DataDef (object)     → block BELOW the row (full-width). The
//                                 row-level "+ Add comment" surface is
//                                 always rendered here, because map / object
//                                 fields render as collapsible vertical
//                                 blocks — the empty button sits cleanly
//                                 on the label line, not visually adjacent
//                                 to any child entry.
//   Multi-item Seq / Tuple     → block BELOW the row, but only when text
//                                 already exists. The empty + button is
//                                 suppressed here: list items are laid out
//                                 horizontally next to the row and a row-
//                                 level + button looked like a "+1" ghost
//                                 button bolted onto the first item.
function _attachPairCommentAuto(row, filePath, protoIdx, pair) {
    const target = commentTargetForPair(filePath, protoIdx, pair);
    const isSimple = YAML.isScalar(pair.value)
        || (YAML.isSeq(pair.value) && pair.value.items?.length === 1 && YAML.isScalar(pair.value.items[0]));
    if (isSimple) { attachInlineComment(row, target); return; }
    if (YAML.isMap(pair.value)) { _attachBlockCommentAfterRow(row, target); return; }
    if (target.getInline()) _attachBlockCommentAfterRow(row, target);
}

// Render the inline-comment for non-scalar field values as a yaml-comment-block
// inserted as the row's next sibling (a full-width line below the field).
function _attachBlockCommentAfterRow(row, target) {
    const wrappedTarget = {
        getBefore: target.getInline,
        setBefore: target.setInline,
        markDirty: target.markDirty,
    };
    const text = target.getInline();
    if (text) {
        const block = _buildCommentBlock(text, wrappedTarget, 'field');
        row.parentNode?.insertBefore(block, row.nextSibling);
        return;
    }
    const btn = _el('button');
    btn.type = 'button';
    btn.className = 'field-comment-btn';
    btn.title = 'Add comment';
    btn.innerHTML = COMMENT_ICON_SVG;
    btn.addEventListener('click', e => {
        e.stopPropagation();
        const host = _div('yaml-comment-block yaml-comment-block--field yaml-comment-block--editing');
        row.parentNode?.insertBefore(host, row.nextSibling);
        _editInPlaceFresh(host,
            t => { target.setInline(t); target.markDirty(); },
            () => host.remove(),
            { placeholder: 'comment…' });
    });
    row.appendChild(btn);
}

// Mirror of _attachBlockCommentAfterRow but inserts the block ABOVE the row
// (used for sequence items where the comment belongs to "this item" but
// yaml-native semantics put it on the previous line as commentBefore).
function _attachBlockCommentAboveRow(row, target) {
    const wrappedTarget = {
        getBefore: target.getInline,
        setBefore: target.setInline,
        markDirty: target.markDirty,
    };
    const text = target.getInline();
    if (text) {
        const block = _buildCommentBlock(text, wrappedTarget, 'field');
        block.classList.add('yaml-comment-block--seq-item');
        row.parentNode?.insertBefore(block, row);
        return;
    }
    const btn = _el('button');
    btn.type = 'button';
    btn.className = 'field-comment-btn';
    btn.title = 'Add comment above this item';
    btn.innerHTML = COMMENT_ICON_SVG;
    btn.addEventListener('click', e => {
        e.stopPropagation();
        const host = _div('yaml-comment-block yaml-comment-block--field yaml-comment-block--seq-item yaml-comment-block--editing');
        row.parentNode?.insertBefore(host, row);
        _editInPlaceFresh(host,
            t => { target.setInline(t); target.markDirty(); },
            () => host.remove(),
            { placeholder: 'comment for this item…' });
    });
    row.appendChild(btn);
}

// ──────────────────────────────────────────────────────────────────────
//  Sequence-item comment wiring (Yaml: `key: [- A # cmt, - B # cmt]`).
//  Called after the field-row is in the DOM; finds each .list-item that
//  the listCtrl rendered and attaches a per-item CommentTarget pointing
//  to seq.items[i].
//  This is the "after-render DOM walk" pattern — it lets every collection
//  editor support comments without refactoring its signature.
// ──────────────────────────────────────────────────────────────────────
function attachSeqItemCommentsForField(row, filePath, protoIdx, fieldKey) {
    const pair = _resolveProtoFieldForSeq(filePath, protoIdx, fieldKey);
    if (!pair) return;
    _wireSeqItems(row, filePath, protoIdx, pair.value);
}
function attachSeqItemCommentsForComponentField(row, filePath, protoIdx, compIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    if (!fs?.doc) return;
    const pair = _resolveCompFieldPair(fs.doc, protoIdx, compIdx, fieldKey);
    if (!pair || !YAML.isSeq(pair.value)) return;
    _wireSeqItems(row, filePath, protoIdx, pair.value);
}
function _resolveProtoFieldForSeq(filePath, protoIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    if (!fs?.doc) return null;
    const pair = _resolveProtoFieldPair(fs.doc, protoIdx, fieldKey);
    return pair && YAML.isSeq(pair.value) ? pair : null;
}
function _wireSeqItems(row, filePath, protoIdx, seq) {
    // Scope to the FIRST .list-editor in tree order — that's the outermost
    // one for this field. Nested .list-editor instances (lists-inside-lists,
    // or lists inside map values rendered as block) live deeper in the
    // tree and have their own seq AST nodes; zipping them against THIS
    // seq.items would mis-index and was the cause of the "comments only
    // appear on half the items" bug.
    _wireSeqItemsIn(_firstChildEditor(row, ['list-editor']), filePath, protoIdx, seq);
}
function _wireSeqItemsIn(editor, filePath, protoIdx, seq) {
    if (!editor) return;
    const itemEls = editor.querySelectorAll(':scope > .list-item');
    const items = seq.items || [];
    const n = Math.min(itemEls.length, items.length);
    for (let i = 0; i < n; i++) {
        const item = items[i];
        if (!item) continue;
        // For the first item only, also surface a comment that yaml-lib
        // stored on the seq itself (`order:\n  # м\n  - first` lands on
        // `seq.commentBefore`, not on items[0].commentBefore).
        const target = commentTargetForSeqItem(filePath, protoIdx, item, i === 0 ? seq : null);
        attachInlineComment(itemEls[i], target);
    }
}

// BFS through descendants to find the first element having any of the given
// CSS class names. Returns null when none is found. Used to scope a query
// to the OUTERMOST collection editor of a given kind inside `host`, without
// caring whether it's wrapped in a `.field-control` div or not.
function _firstChildEditor(host, classNames) {
    if (!host) return null;
    const stack = [host];
    while (stack.length) {
        const cur = stack.shift();
        for (const ch of cur.children) {
            for (const c of classNames) if (ch.classList.contains(c)) return ch;
            stack.push(ch);
        }
    }
    return null;
}

/**
 * Recursively wire comment surfaces inside dict / datadef values one level
 * deeper. Called from `_wireMapEntriesIn` and `_wireDataDefFieldsIn` after
 * the immediate-level wiring, so each nested Map / Seq value also gets
 * per-entry / per-element comment surfaces.
 *
 * Scope: only dispatches on Map (→ dict / datadef) and Seq (→ list / tuple).
 * Scalar leaves stop the recursion. Single-pair Map items inside a Seq are
 * not recursed into to avoid double-attaching a comment surface that the
 * seq-item target already owns (yaml stores the inline comment on the inner
 * scalar in that case — see `commentTargetForSeqItem`).
 */
function _wireValueRecursively(host, filePath, protoIdx, node) {
    if (!host || !node) return;
    if (YAML.isMap(node)) {
        const dd = _firstChildEditor(host, ['datadef-body']);
        if (dd) { _wireDataDefFieldsIn(dd, filePath, protoIdx, node); return; }
        const m = _firstChildEditor(host, ['map-editor']);
        if (m) _wireMapEntriesIn(m, filePath, protoIdx, node);
    } else if (YAML.isSeq(node)) {
        const t = _firstChildEditor(host, ['tuple-editor']);
        if (t) { _wireTupleElementsIn(t, filePath, protoIdx, node); return; }
        const l = _firstChildEditor(host, ['list-editor']);
        if (l) _wireSeqItemsIn(l, filePath, protoIdx, node);
    }
}

// ──────────────────────────────────────────────────────────────────────
//  Map-entry comment wiring (Yaml: `key1: v1 # cmt`).
//  Mirror of seq-item wiring but for `.map-editor > .map-entry` rows.
//  Comments attach to the entry's key/value pair so they round-trip as
//  the usual inline pair comment (same path used by attachFieldComment).
//  For block-form entries (.map-entry--block) the surface is the inner
//  .map-entry-header, so the comment sits next to the × remove button
//  rather than under the value control.
// ──────────────────────────────────────────────────────────────────────
function attachMapEntryCommentsForField(row, filePath, protoIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    if (!fs?.doc) return;
    const pair = _resolveProtoFieldPair(fs.doc, protoIdx, fieldKey);
    if (!pair || !YAML.isMap(pair.value)) return;
    _wireMapEntries(row, filePath, protoIdx, pair.value);
}
function attachMapEntryCommentsForComponentField(row, filePath, protoIdx, compIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    if (!fs?.doc) return;
    const pair = _resolveCompFieldPair(fs.doc, protoIdx, compIdx, fieldKey);
    if (!pair || !YAML.isMap(pair.value)) return;
    _wireMapEntries(row, filePath, protoIdx, pair.value);
}
function _wireMapEntries(row, filePath, protoIdx, mapNode) {
    // Scope to outermost .map-editor (see _wireSeqItems for rationale).
    _wireMapEntriesIn(_firstChildEditor(row, ['map-editor']), filePath, protoIdx, mapNode);
}
function _wireMapEntriesIn(editor, filePath, protoIdx, mapNode) {
    if (!editor) return;
    const entryEls = editor.querySelectorAll(':scope > .map-entry');
    const pairs = mapNode.items || [];
    for (let i = 0; i < entryEls.length && i < pairs.length; i++) {
        const pair = pairs[i];
        if (!pair) continue;
        const entryEl = entryEls[i];
        const surface = entryEl.classList.contains('map-entry--block')
            ? (entryEl.querySelector(':scope > .map-entry-header') || entryEl)
            : entryEl;
        attachInlineComment(surface, commentTargetForPair(filePath, protoIdx, pair));
        // Recurse: dict-of-dict, dict-of-datadef, dict-of-list all get
        // per-entry comment surfaces one level deeper as well.
        const valHost = entryEl.querySelector(':scope > .map-entry-content') || entryEl;
        _wireValueRecursively(valHost, filePath, protoIdx, pair.value);
    }
}

// ──────────────────────────────────────────────────────────────────────
//  Tuple-element comment wiring — N-tuple seq form only. The 2-tuple
//  mapping form has a single pair and is already covered by the row's
//  attachFieldComment, so it is intentionally skipped here.
// ──────────────────────────────────────────────────────────────────────
function attachTupleElementCommentsForField(row, filePath, protoIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    if (!fs?.doc) return;
    const pair = _resolveProtoFieldPair(fs.doc, protoIdx, fieldKey);
    if (!pair || !YAML.isSeq(pair.value)) return;
    _wireTupleElements(row, filePath, protoIdx, pair.value);
}
function attachTupleElementCommentsForComponentField(row, filePath, protoIdx, compIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    if (!fs?.doc) return;
    const pair = _resolveCompFieldPair(fs.doc, protoIdx, compIdx, fieldKey);
    if (!pair || !YAML.isSeq(pair.value)) return;
    _wireTupleElements(row, filePath, protoIdx, pair.value);
}
function _wireTupleElements(row, filePath, protoIdx, seq) {
    // Scope to outermost .tuple-editor (see _wireSeqItems for rationale).
    _wireTupleElementsIn(_firstChildEditor(row, ['tuple-editor']), filePath, protoIdx, seq);
}
function _wireTupleElementsIn(editor, filePath, protoIdx, seq) {
    if (!editor) return;
    const slotEls = editor.querySelectorAll(':scope > .tuple-element');
    for (let i = 0; i < slotEls.length && i < seq.items.length; i++) {
        const item = seq.items[i];
        if (!item) continue;
        const target = commentTargetForSeqItem(filePath, protoIdx, item, i === 0 ? seq : null);
        attachInlineComment(slotEls[i], target);
    }
}

// ──────────────────────────────────────────────────────────────────────
//  DataDef inner-field comment wiring. The dataDef's inner fields are
//  rendered as fieldRows inside `.datadef-body`. Each fieldRow stamps
//  `data-field-key=<tag>`, so we zip them by tag against the pairs inside
//  the dataDef's backing Map. Nested dataDefs / lists / maps inside this
//  dataDef ARE recursed into via _wireValueRecursively.
// ──────────────────────────────────────────────────────────────────────
function attachDataDefFieldCommentsForField(row, filePath, protoIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    if (!fs?.doc) return;
    const pair = _resolveProtoFieldPair(fs.doc, protoIdx, fieldKey);
    if (!pair || !YAML.isMap(pair.value)) return;
    _wireDataDefFields(row, filePath, protoIdx, pair.value);
}
function attachDataDefFieldCommentsForComponentField(row, filePath, protoIdx, compIdx, fieldKey) {
    const fs = state.openFiles.get(filePath);
    if (!fs?.doc) return;
    const pair = _resolveCompFieldPair(fs.doc, protoIdx, compIdx, fieldKey);
    if (!pair || !YAML.isMap(pair.value)) return;
    _wireDataDefFields(row, filePath, protoIdx, pair.value);
}
function _wireDataDefFields(row, filePath, protoIdx, mapNode) {
    // Scope to the outermost .datadef-body for this field (see _wireSeqItems).
    _wireDataDefFieldsIn(_firstChildEditor(row, ['datadef-body']), filePath, protoIdx, mapNode);
}
function _wireDataDefFieldsIn(body, filePath, protoIdx, mapNode) {
    if (!body) return;
    const fieldEls = body.querySelectorAll(':scope > .field-row[data-field-key]');
    const pairs = mapNode.items || [];
    for (const el of fieldEls) {
        const key = el.dataset.fieldKey;
        const pair = pairs.find(p => YAML.isScalar(p.key) && p.key.value === key);
        if (!pair) continue;
        attachInlineComment(el, commentTargetForPair(filePath, protoIdx, pair));
        // Recurse: datadef-of-datadef, datadef-of-dict, datadef-of-list
        // get per-entry comment surfaces one level deeper as well.
        _wireValueRecursively(el, filePath, protoIdx, pair.value);
    }
}

// ──────────────────────────────────────────────────────────────────────
//  Inter-proto toolbar [+ #]
// ──────────────────────────────────────────────────────────────────────
function buildInterProtoToolbar(filePath, insertIdx, protosLength) {
    const bar = _div('inter-proto-toolbar');
    bar.dataset.insertIdx = String(insertIdx);
    const isTrailing = insertIdx >= protosLength;

    const addBtn = _el('button');
    addBtn.type = 'button';
    addBtn.className = 'inter-proto-btn inter-proto-btn--add';
    addBtn.title = 'Add prototype here';
    addBtn.innerHTML = PLUS_ICON_SVG;
    addBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (typeof showAddProtoModal === 'function') showAddProtoModal(insertIdx);
    });
    bar.appendChild(addBtn);

    const cmtBtn = _el('button');
    cmtBtn.type = 'button';
    cmtBtn.className = 'inter-proto-btn inter-proto-btn--comment';
    cmtBtn.title = isTrailing ? 'Add comment at end of file' : 'Add comment here';
    cmtBtn.innerHTML = COMMENT_ICON_SVG;
    cmtBtn.addEventListener('click', e => {
        e.stopPropagation();
        const target = isTrailing
            ? commentTargetForTrailingFile(filePath)
            : commentTargetForBetweenProtos(filePath, insertIdx);
        // If a comment already exists at this spot, focus its edit-in-place.
        const existing = isTrailing
            ? bar.parentElement?.querySelector('.yaml-comment-block--trailing .yaml-comment-view--editable')
            : (bar.nextElementSibling?.classList?.contains('yaml-comment-block')
                ? bar.nextElementSibling.querySelector('.yaml-comment-view--editable') : null);
        if (existing) { existing.click(); return; }
        // Otherwise insert a fresh editor right where the comment would go.
        const parent = bar.parentElement;
        if (!parent) return;
        const host = _div(`yaml-comment-block yaml-comment-block--${isTrailing ? 'trailing' : 'proto'} yaml-comment-block--editing`);
        parent.insertBefore(host, isTrailing ? bar.nextSibling : bar.nextSibling);
        _editInPlaceFresh(host,
            text => { target.setBefore(text); target.markDirty(); },
            () => host.remove(),
            { placeholder: 'comment…' });
    });
    bar.appendChild(cmtBtn);

    if (!isTrailing) _wireInterProtoToolbarDrop(bar, filePath, insertIdx);

    return bar;
}
