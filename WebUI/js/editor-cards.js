// ======================================================================
//  SS14 Prototype Editor – Proto Card
// ======================================================================
//  buildCard() renders one prototype-card (header, drag-drop reorder,
//  id/abstract/parent rows, metadata-driven fields, custom fields,
//  inherited-only fields, and the components section).
// ======================================================================

'use strict';

function buildCard(proto, idx, filePath) {
    // Default to collapsed: only overridden (.field-local) rows are visible
    // out of the box; expand reveals every field. Per-card collapse state
    // is preserved across re-renders by save/restoreCollapseState.
    const card = _div('proto-card collapsed');
    const type = proto.type || 'unknown';
    const id   = proto.id   || '(no id)';
    const meta = state.metadata?.prototypes?.[type];
    const inheriting = meta?.inheriting ?? false;
    const hasAbstractField = !!meta?.fields?.some(f => f.isAbstract);
    const isAbstract = !!proto.abstract;

    // Apply abstract styling
    if (isAbstract) card.classList.add('proto-abstract');

    // Single-line proto identity bar: drag handle, type, delete, collapse-eye.
    // All other proto-level fields (id, abstract, parent) render as regular
    // field rows in the body so they obey the same collapse/override rules
    // as everything else parsed from the prototype.
    const hdr = _div('proto-header');
    hdr.innerHTML = `<div class="proto-type-line">
            <span class="proto-drag-handle" draggable="true" title="Drag to reorder">\u22ee\u22ee</span>
            <span class="proto-type-badge" title="${esc(meta?.summary || '')}">${esc(type)}</span>
            <button class="delete-proto-btn" title="Delete prototype">×</button>
        </div>`;
    // Abstract row — only rendered for proto types whose metadata actually
    // declares an abstract field. Built via the standard bool fieldRow so
    // spacing and styling match every other bool field in the editor.
    // Stored for later appending into the body.
    let absRow = null;
    if (hasAbstractField) {
        const absSource = isAbstract ? 'local' : 'default';
        const absMeta = { fieldKind: 'boolean', tag: 'abstract' };
        const onAbsChange = checked => {
            if (checked) setFieldValue([idx], 'abstract', true, filePath);
            else deleteField([idx], 'abstract', filePath);
            state.resolvedCache.clear(); state.protoLookup = null;
            renderEditor();
        };
        const onAbsReset = absSource === 'local'
            ? () => { deleteField([idx], 'abstract', filePath); }
            : null;
        absRow = fieldRow('abstract', absMeta, isAbstract, absSource, onAbsChange, onAbsReset);
        absRow.classList.add('proto-abstract-row');
    }

    // ID rename on double-click — span lives in the body now, so we have to
    // resolve it after the body is built. The handler is attached below
    // after `idRow` is created.

    hdr.querySelector('.delete-proto-btn').addEventListener('click', e => {
        e.stopPropagation();
        if (!confirm(`Delete prototype "${id}"?`)) return;
        const fs = state.openFiles.get(filePath);
        if (fs && fs.yaml) {
            fs.yaml.splice(idx, 1);
            fs.structuralChange = true;
            commitChange(fs);
            renderEditor();
        }
    });
    // Eye-icon collapse toggle, inserted just before the × delete button so
    // it sits glued next to the type name (never floated to the right edge).
    const protoTypeLine = hdr.querySelector('.proto-type-line');
    const protoDeleteBtn = protoTypeLine.querySelector('.delete-proto-btn');
    protoTypeLine.insertBefore(buildCollapseBtn(() => card), protoDeleteBtn);
    hdr.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        const items = [
            { label: 'Collapse / Expand', action: () => hdr.querySelector('.collapse-btn').click() },
            { label: '# Add / edit comment before', action: () => {
                const area = document.querySelector(`.editor-group[data-group-id="${state.activeGroupId}"] .group-content`);
                const existing = area?.querySelector(`.yaml-comment-block[data-proto-comment-idx="${idx}"]`)
                    || (area?.querySelector(`.proto-card[data-proto-idx="${idx}"]`)?.previousElementSibling?.classList?.contains('yaml-comment-block')
                        ? area.querySelector(`.proto-card[data-proto-idx="${idx}"]`).previousElementSibling : null);
                if (existing) {
                    existing.querySelector('.yaml-comment-view--editable')?.click();
                } else {
                    const card = area?.querySelector(`.proto-card[data-proto-idx="${idx}"]`);
                    let toolbar = card?.previousElementSibling;
                    if (toolbar?.classList.contains('yaml-comment-block')) toolbar = toolbar.previousElementSibling;
                    if (toolbar?.classList.contains('inter-proto-toolbar')) {
                        toolbar.querySelector('.inter-proto-btn--comment')?.click();
                    }
                }
            }},
        ];
        if (meta?.className) items.push({ label: 'Open .cs source', action: () => api.openSource(meta.className) });
        items.push('---', { label: 'Delete prototype', danger: true, action: () => hdr.querySelector('.delete-proto-btn').click() });
        showContextMenu(e.clientX, e.clientY, items);
    });
    card.appendChild(hdr);

    // Inline comment for the proto header line (`- type: entity  # cmt`).
    // Attach to the proto-type-line (a flex ROW) — NOT to hdr (which is a
    // flex column, so appended children stack as new lines, breaking layout).
    attachInlineComment(protoTypeLine, commentTargetForProtoField(filePath, idx, 'type'));

    // ── Drag-drop reorder ────────────────────────────────────────────
    // The handle is the only draggable surface so that text-selection in
    // inputs still works normally. Drop targets are the sibling cards.
    card.dataset.protoIdx = String(idx);
    card.dataset.protoId = String(id);
    card.dataset.protoType = String(type);
    const dragHandle = hdr.querySelector('.proto-drag-handle');
    dragHandle.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-proto-idx', String(idx));
        // Some browsers require a text/plain fallback or dragstart is rejected.
        e.dataTransfer.setData('text/plain', String(idx));
        card.classList.add('dragging');
    });
    dragHandle.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', e => {
        if (!e.dataTransfer.types.includes('application/x-proto-idx')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', e => {
        if (e.target === card) card.classList.remove('drop-target');
    });
    card.addEventListener('drop', e => {
        card.classList.remove('drop-target');
        if (!e.dataTransfer.types.includes('application/x-proto-idx')) return;
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData('application/x-proto-idx'), 10);
        const to = idx;
        if (Number.isNaN(from) || from === to) return;
        const fs = state.openFiles.get(filePath);
        if (!fs || !Array.isArray(fs.yaml) || from < 0 || from >= fs.yaml.length) return;
        const [moved] = fs.yaml.splice(from, 1);
        fs.yaml.splice(to, 0, moved);
        fs.structuralChange = true;
        commitChange(fs);
        renderEditor();
    });

    // Parent field, rendered as a regular fieldRow in the body (same as
    // every other proto-level field) so collapse + override semantics work
    // uniformly.
    let parentRow = null;
    if (inheriting) {
        // Normalize parent value to always be an array for the list control.
        // Critical: an empty string is treated as a single in-progress slot,
        // NOT as "no parent". This is what makes "+ Add item" work – clicking
        // it persists `proto.parent = ''` (via onParentChange below), the card
        // re-renders, and the slot survives as an empty protoId search row
        // for the user to fill in instead of vanishing.
        let parentVal = proto.parent;
        if (parentVal == null) parentVal = [];
        else if (!Array.isArray(parentVal)) parentVal = [parentVal];

        const parentMeta = {
            fieldKind: 'list', tag: 'parent',
            element: { kind: 'protoId', fullType: 'protoId', protoTypeArg: type },
            required: false
        };
        const parentSource = proto.parent !== undefined ? 'local' : 'default';
        const onParentChange = v => {
            // Preserve empty-string slots so "+ Add item" doesn't immediately
            // erase itself (listCtrl now commits on add so PrototypeLayerData
            // and friends persist – an empty parent slot is a valid in-progress
            // state that the user fills in next).
            const arr = Array.isArray(v) ? v.filter(x => x != null) : [];
            if (arr.length === 0) deleteField([idx], 'parent', filePath);
            else if (arr.length === 1) setFieldValue([idx], 'parent', arr[0], filePath);
            else setFieldValue([idx], 'parent', arr, filePath);
        };
        const onParentReset = parentSource === 'local' ? () => deleteField([idx], 'parent', filePath) : null;
        parentRow = fieldRow('parent', parentMeta, parentVal, parentSource, onParentChange, onParentReset);
    }

    // body
    const body = _div('proto-body');

    // Proto-level fields rendered as regular field rows so collapse / override
    // semantics are identical to the metadata-driven fields below.
    // 1. ID row — uses the same fieldRow codepath as every other field so
    //    indentation, override-bar, and reset slot all line up. The id is
    //    mandatory: editing it clears the resolved-inheritance cache because
    //    other prototypes may reference it as a parent.
    // Helper: render a key's commentBefore (if any) above the row, then
    // the row itself, then attach the chat-bubble button + any trailing
    // inline-comment span to the row.  Only does anything when fs.doc has
    // the field present (matches the YAML pair).
    const appendFieldWithComments = (row, fieldKey) => {
        const before = buildFieldCommentBefore(filePath, idx, fieldKey);
        if (before) body.appendChild(before);
        body.appendChild(row);
        attachFieldComment(row, filePath, idx, fieldKey);
        // If the field value is a Seq, wire comment-targets on each list-item
        // so users can add per-item comments (parent: [- A # ..., - B # ...]).
        attachSeqItemCommentsForField(row, filePath, idx, fieldKey);
        // Same for Map-valued fields: each `key: value` row gets its own
        // inline-comment surface.
        attachMapEntryCommentsForField(row, filePath, idx, fieldKey);
        // Tuple elements (Seq form only) and dataDef inner fields, one
        // level deep each — see attachTupleElementCommentsForField and
        // attachDataDefFieldCommentsForField for the exact scope.
        attachTupleElementCommentsForField(row, filePath, idx, fieldKey);
        attachDataDefFieldCommentsForField(row, filePath, idx, fieldKey);
    };

    const idMeta = { fieldKind: 'string', tag: 'id', required: true };
    const onIdChange = v => {
        const fs = state.openFiles.get(filePath);
        if (!fs || !fs.yaml[idx]) return;
        const newId = String(v ?? '').trim();
        if (!newId || newId === fs.yaml[idx].id) return;
        setFieldValue([idx], 'id', newId, filePath);
    };
    appendFieldWithComments(fieldRow('id', idMeta, String(id), 'local', onIdChange, null), 'id');
    // 2. Abstract row (only when meta declares the field).
    if (absRow) appendFieldWithComments(absRow, 'abstract');
    // 3. Parent row (only for inheriting prototypes).
    if (parentRow) appendFieldWithComments(parentRow, 'parent');

    // Resolve inherited values
    let inherited = {};
    if (inheriting && proto.parent) inherited = resolveInheritance(type, proto.parent);

    // Render ALL metadata fields with override tracking
    const renderedTags = new Set(['type']);
    if (meta) {
        for (const f of meta.fields) {
            if (f.isId || f.isAbstract || f.isParent) { renderedTags.add(f.tag); continue; } // rendered in header/sub-header
            if (f.tag === 'components') { renderedTags.add('components'); continue; }
            renderedTags.add(f.tag);

            const { value, source } = getFieldValue(proto, f.tag, inherited, f.default);

            const onReset = source === 'local' ? () => deleteField([idx], f.tag, filePath) : null;
            const row = fieldRow(f.tag, f, value, source, v => setFieldValue([idx], f.tag, v, filePath), onReset);
            appendFieldWithComments(row, f.tag);
        }
    }

    // Extra fields not in metadata (custom user fields in YAML)
    for (const [k, v] of Object.entries(proto)) {
        if (k.startsWith('__') || renderedTags.has(k)) continue;
        const source = 'local'; // if in proto, it's local
        const row = genericRow(k, v, source, nv => setFieldValue([idx], k, nv, filePath), () => deleteField([idx], k, filePath));
        appendFieldWithComments(row, k);
    }

    // Inherited-only fields not yet shown
    for (const [k, v] of Object.entries(inherited)) {
        if (['type', 'id', 'parent', 'abstract', 'components'].includes(k)) continue;
        if (renderedTags.has(k) || proto[k] !== undefined) continue;
        body.appendChild(genericRow(k, v, 'inherited', nv => setFieldValue([idx], k, nv, filePath), null));
    }

    // Components section
    if (type === 'entity' || proto.components) {
        const cs = buildComponentsSection(proto, idx, inherited, filePath);
        if (cs) body.appendChild(cs);
    }

    card.appendChild(body);

    // Context menu on editor area: collapse / expand all (per-field comment
    // options live on the field-comment-btn's own right-click handler).
    body.addEventListener('contextmenu', e => {
        if (e.target.closest('.field-row, .component-card, .component-header, .yaml-comment-block, .field-comment-btn, .field-inline-comment')) return;
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
            { label: 'Collapse all prototypes', action: () => collapseAllProtos(true) },
            { label: 'Expand all prototypes', action: () => collapseAllProtos(false) },
        ]);
    });

    return card;
}
