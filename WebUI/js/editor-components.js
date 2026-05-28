// ======================================================================
//  SS14 Editor – Components Section
// ======================================================================
//  Per-prototype components: block, the add-component modal,
//  individual compCard widgets, and component localization (copying an
//  inherited component to local YAML on first edit).
// ======================================================================

'use strict';

function buildComponentsSection(proto, protoIdx, inherited, filePath) {
    const sec = _div('components-section');
    sec.innerHTML = `<div class="components-header"><span>components</span><button class="add-component-btn" title="Add component">+</button></div>`;
    sec.querySelector('.add-component-btn').addEventListener('click', () => showAddComponentModal(proto, protoIdx, filePath));

    const localComps = proto.components || [];
    const inhComps   = inherited.components || [];
    // The components-section behaves like a single "row" at the proto-body
    // level: it carries `field-local` when this prototype actually defines
    // local components, otherwise `inherited`. That puts it on the same
    // visibility codepath as every other row inside `.proto-body`
    // (collapsed cards hide non-`.field-local` children uniformly).
    sec.classList.add(localComps.length > 0 ? 'field-local' : 'inherited');
    // Reset button: drop the whole local `components:` block, falling back
    // to the inherited list. Same affordance as the per-field reset (↺).
    if (localComps.length > 0) {
        const reset = _el('button');
        reset.className = 'field-reset-btn';
        reset.textContent = '↺';
        reset.title = 'Reset components (revert to inherited)';
        reset.addEventListener('click', e => {
            e.stopPropagation();
            const fs = state.openFiles.get(filePath);
            if (!fs || !fs.yaml[protoIdx]) return;
            delete fs.yaml[protoIdx].components;
            if (fs.doc) docDeleteField(fs.doc, [protoIdx], 'components');
            fs.dirtyProtos?.add(protoIdx); fs.dirtySinceSave?.add(protoIdx);
            state.resolvedCache.clear(); state.protoLookup = null;
            commitChange(fs); renderEditor();
        });
        sec.querySelector('.components-header').appendChild(reset);
    }
    const localMap = new Map();
    localComps.forEach((c, i) => { if (c && c.type) localMap.set(c.type, { data: c, idx: i }); });
    const inhMap = new Map();
    for (const c of inhComps) { if (c && c.type && !localMap.has(c.type)) inhMap.set(c.type, c); }

    // Sort local components: handlers with a numeric `priority` field come
    // first (ascending), rest follow alphabetically by type name.
    const sortedLocal = [...localMap.entries()].sort(([aType], [bType]) => {
        const aPri = ComponentHandlerRegistry?.get?.(aType)?.priority ?? Infinity;
        const bPri = ComponentHandlerRegistry?.get?.(bType)?.priority ?? Infinity;
        if (aPri !== bPri) return aPri - bPri;
        return aType.localeCompare(bType);
    });

    sec.dataset.protoIdx = String(protoIdx);
    sec.dataset.filePath = filePath ?? '';

    // DnD drop handling: reorders local components in the YAML array.
    sec.addEventListener('dragover', e => {
        const target = e.target.closest('.component-card.comp-local');
        if (!target || !target.dataset.compIdx) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        sec.querySelectorAll('.component-card').forEach(c => c.classList.remove('drop-target'));
        target.classList.add('drop-target');
    });
    sec.addEventListener('dragleave', e => {
        if (!sec.contains(e.relatedTarget)) {
            sec.querySelectorAll('.component-card').forEach(c => c.classList.remove('drop-target'));
        }
    });
    sec.addEventListener('drop', e => {
        sec.querySelectorAll('.component-card').forEach(c => c.classList.remove('drop-target', 'dragging'));
        const target = e.target.closest('.component-card.comp-local');
        if (!target || !target.dataset.compIdx) return;
        const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const to   = parseInt(target.dataset.compIdx, 10);
        if (Number.isNaN(from) || Number.isNaN(to) || from === to) return;
        e.preventDefault();
        const fp = sec.dataset.filePath || state.currentFile;
        const pi = parseInt(sec.dataset.protoIdx, 10);
        const fs = state.openFiles.get(fp);
        if (!fs || !fs.yaml[pi]?.components) return;
        const comps = fs.yaml[pi].components;
        const [moved] = comps.splice(from, 1);
        comps.splice(to > from ? to - 1 : to, 0, moved);
        fs.structuralChange = true;
        fs.dirtyProtos?.add(pi); fs.dirtySinceSave?.add(pi);
        commitChange(fs); renderEditor();
    });

    for (const [ct, { data, idx }] of sortedLocal) sec.appendChild(compCard(ct, data, false, protoIdx, idx, inherited, undefined, filePath));
    for (const [ct, data]          of inhMap)       sec.appendChild(compCard(ct, data, true,  protoIdx, -1, inherited, undefined, filePath));
    return sec;
}

function showAddComponentModal(proto, protoIdx, filePath) {
    const existing = new Set((proto.components || []).map(c => c?.type).filter(Boolean));
    if (proto.parent) {
        const inh = resolveInheritance(proto.type, proto.parent);
        if (inh?.components) for (const c of inh.components) { if (c?.type) existing.add(c.type); }
    }
    pickComponentType(existing, (t) => {
        const fs = state.openFiles.get(filePath ?? state.currentFile);
        if (!fs || !fs.yaml[protoIdx]) return;
        if (!fs.yaml[protoIdx].components) fs.yaml[protoIdx].components = [];
        fs.yaml[protoIdx].components.push({ type: t });
        if (fs.doc) docSetField(fs.doc, [protoIdx], 'components', fs.yaml[protoIdx].components);
        fs.dirtyProtos?.add(protoIdx); fs.dirtySinceSave?.add(protoIdx);
        commitChange(fs); renderEditor();
    });
}

/**
 * Generic component-type picker modal. Used by the prototype components:
 * block AND by the ComponentRegistry field control. `excludeSet` is a
 * Set of component-type strings that should not appear in the list
 * (already-present components). `onPick(type)` is invoked when the user
 * selects a row.
 */
function pickComponentType(excludeSet, onPick) {
    const overlay = _div('modal-overlay');
    const modal = _div('modal');
    modal.innerHTML = `<div class="modal-header"><h3>Add Component</h3><button class="modal-close">\u00d7</button></div>
        <div class="modal-body">
            <input type="text" class="field-input modal-search" placeholder="Search component\u2026" autocomplete="off">
            <div class="modal-list"></div>
        </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const searchInp = modal.querySelector('.modal-search');
    const listEl = modal.querySelector('.modal-list');
    const types = state.metadata?.components ? Object.keys(state.metadata.components).sort().filter(t => !excludeSet.has(t)) : [];

    function renderList(q) {
        listEl.innerHTML = '';
        const filtered = types.filter(t => smartMatch(t, q));
        if (!filtered.length) { listEl.innerHTML = '<div class="dropdown-empty">No components found</div>'; return; }
        for (const t of filtered.slice(0, 100)) {
            const el = _div('modal-list-item');
            el.textContent = t;
            const summary = state.metadata?.components?.[t]?.summary;
            if (summary) el.title = summary;
            el.addEventListener('click', () => { overlay.remove(); onPick(t); });
            listEl.appendChild(el);
        }
    }
    renderList('');
    searchInp.addEventListener('input', () => renderList(searchInp.value));
    searchInp.focus();
    modal.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

/** Copy an inherited component to local YAML so it can be edited. Returns new compIdx. */
function localizeComponent(protoIdx, compType, filePath) {
    const fs = state.openFiles.get(filePath ?? state.currentFile);
    if (!fs || !fs.yaml[protoIdx]) return -1;
    if (!fs.yaml[protoIdx].components) fs.yaml[protoIdx].components = [];
    // Check if already localized
    const existing = fs.yaml[protoIdx].components.findIndex(c => c && c.type === compType);
    if (existing >= 0) return existing;
    fs.yaml[protoIdx].components.push({ type: compType });
    return fs.yaml[protoIdx].components.length - 1;
}

function compCard(compType, data, isInh, protoIdx, compIdx, inherited, ctx, filePath) {
    // `ctx` (optional) decouples this card from prototype state so it can
    // also be used by the ComponentRegistry field control. When provided,
    // it intercepts mutations: { write(tag, value), reset(tag), remove(),
    // localize() -> newIdx }. Inheritance UI is suppressed in ctx mode
    // because a ComponentRegistry has no parent chain.
    if (ctx) isInh = false;
    // Default to collapsed for every component (inherited or local). Only
    // overridden field rows show until the user expands via the eye icon.
    const startCollapsed = true;
    // A local component that ALSO exists in the inherited chain is an
    // override – the `×` action effectively *resets* it to the inherited
    // value rather than truly deleting it. Surface that distinction in
    // the icon/tooltip so the design matches plain field rows (↺ for
    // override-reset, × for outright remove).
    const isOverride = !isInh && !ctx && Array.isArray(inherited?.components)
        && inherited.components.some(c => c && c.type === compType);
    const card = _div('component-card' + (startCollapsed ? ' collapsed' : '') + (isInh ? ' inherited' : ' comp-local'));
    card.dataset.compType = compType;
    if (!isInh && compIdx >= 0) card.dataset.compIdx = String(compIdx);
    const cMeta = state.metadata?.components?.[compType];
    const hdr = _div('component-header');
    const compTipParts = [];
    if (cMeta?.summary) compTipParts.push(cMeta.summary);
    if (cMeta?.className) compTipParts.push(`class: ${cMeta.className}`);
    hdr.innerHTML = `<span class="comp-type-label">- type: </span><span class="component-type" title="${esc(compTipParts.join('\n'))}">${esc(compType)}</span>`;
    // For local components prepend either a lock icon (priority/pinned) or a
    // drag handle (regular reorderable).  The handle goes before the
    // "- type: " label so the visual order is: [icon] - type: ComponentName.
    if (!isInh && !ctx && compIdx >= 0) {
        const isPriority = Number.isFinite(ComponentHandlerRegistry?.get?.(compType)?.priority);
        if (isPriority) {
            const lk = _div('comp-lock-handle');
            lk.textContent = '\uD83D\uDD12';
            lk.title = 'Priority component – always sorted first';
            hdr.insertAdjacentElement('afterbegin', lk);
        } else {
            const dh = _div('comp-drag-handle');
            dh.textContent = '⋮⋮';
            dh.draggable = true;
            dh.title = 'Drag to reorder';
            dh.addEventListener('dragstart', e => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(compIdx));
                card.classList.add('dragging');
            });
            dh.addEventListener('dragend', () => card.classList.remove('dragging'));
            hdr.insertAdjacentElement('afterbegin', dh);
        }
    }
    // Eye-icon collapse toggle, right after the component name. The reset
    // / remove button (when present) appears AFTER the eye, matching the
    // field-row pattern "label: data [eye] [reset/delete]".
    hdr.appendChild(buildCollapseBtn(() => card));
    if (!isInh && compIdx >= 0) {
        const rmBtn = _el('button');
        rmBtn.className = 'field-reset-btn comp-remove-btn';
        if (isOverride) {
            rmBtn.title = 'Reset to inherited value';
            rmBtn.textContent = '↺';
        } else {
            rmBtn.title = 'Remove component';
            rmBtn.textContent = '×';
        }
        rmBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (ctx) { ctx.remove(); return; }
            const fs = state.openFiles.get(filePath ?? state.currentFile);
            if (fs && fs.yaml[protoIdx]?.components) {
                fs.yaml[protoIdx].components.splice(compIdx, 1);
                if (fs.doc) docSetField(fs.doc, [protoIdx], 'components', fs.yaml[protoIdx].components);
                fs.dirtyProtos?.add(protoIdx); fs.dirtySinceSave?.add(protoIdx);
                commitChange(fs); renderEditor();
            }
        });
        hdr.appendChild(rmBtn);
    }
    hdr.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        const items = [];
        if (cMeta?.className) items.push({ label: `Open .cs source of "${cMeta.className.split('.').pop()}"`, action: () => api.openSource(cMeta.className) });
        if (!isInh && compIdx >= 0) {
            items.push('---', { label: isOverride ? 'Reset to inherited' : 'Remove component', danger: !isOverride, action: () => {
                if (ctx) { ctx.remove(); return; }
                const fs = state.openFiles.get(filePath ?? state.currentFile);
                if (fs && fs.yaml[protoIdx]?.components) {
                    fs.yaml[protoIdx].components.splice(compIdx, 1);
                    if (fs.doc) docSetField(fs.doc, [protoIdx], 'components', fs.yaml[protoIdx].components);
                    fs.dirtyProtos?.add(protoIdx); fs.dirtySinceSave?.add(protoIdx);
                    commitChange(fs); renderEditor();
                }
            }});
        }
        items.push('---');
        items.push({ label: 'Collapse all components', action: () => collapseAllComponents(true) });
        items.push({ label: 'Expand all components', action: () => collapseAllComponents(false) });
        if (items.length) showContextMenu(e.clientX, e.clientY, items);
    });
    card.appendChild(hdr);

    // Inline comment for the `- type: X  # cmt` line (and chat-bubble when none).
    if (!isInh && compIdx >= 0 && filePath) {
        attachInlineComment(hdr, commentTargetForCompField(filePath, protoIdx, compIdx, 'type'));
    }

    const body = _div('component-body');
    const renderedTags = new Set(['type']);

    // Find inherited component data for this specific component type
    let inhCompData = {};
    if (inherited && inherited.components) {
        const inhC = (Array.isArray(inherited.components) ? inherited.components : [])
            .find(c => c && c.type === compType);
        if (inhC) inhCompData = inhC;
    }

    // For inherited components, editing any field "localizes" the component first
    function compOnChange(tag, nv) {
        if (ctx) { ctx.write(tag, nv); return; }
        if (isInh) {
            const newIdx = localizeComponent(protoIdx, compType, filePath);
            if (newIdx < 0) return;
            setFieldValue([protoIdx, 'components', newIdx], tag, nv, filePath);
        } else {
            setFieldValue([protoIdx, 'components', compIdx], tag, nv, filePath);
        }
    }
    function compOnReset(tag) {
        if (ctx) { ctx.reset(tag); return; }
        if (!isInh && compIdx >= 0) deleteField([protoIdx, 'components', compIdx], tag, filePath);
    }

    // Look up a "special" handler for this component type (e.g. Sprite).
    // Handlers now run for inherited cards too so that preview widgets
    // (decorateHeader) are always shown. Field overrides on inherited
    // cards are still interactive: compOnChange auto-localizes on first edit.
    const handler = (typeof ComponentHandlerRegistry !== 'undefined')
        ? ComponentHandlerRegistry.get(compType) : null;
    // Merge inherited + local data so the handler sees the effective values
    // even when fields (e.g. "sprite") live only in a parent prototype.
    const effectiveCompData = { ...inhCompData, ...data };
    const handlerCtx = handler ? {
        compType, compData: effectiveCompData, protoIdx, compIdx, filePath,
        compOnChange, compOnReset, isInh,
    } : null;
    if (handler) ComponentHandlerRegistry.pushContext(handler, handlerCtx);

    if (cMeta) {
        for (const f of cMeta.fields) {
            renderedTags.add(f.tag);

            let source, value;
            if (isInh) {
                source = 'inherited';
                value = data[f.tag];
            } else if (Object.prototype.hasOwnProperty.call(data, f.tag)) {
                source = 'local';
                value = data[f.tag];
            } else if (inhCompData[f.tag] !== undefined) {
                source = 'inherited';
                value = inhCompData[f.tag];
            } else {
                source = 'default';
                value = f.default;
            }

            const onReset = (!isInh && source === 'local') ? () => compOnReset(f.tag) : null;
            const cBefore = isInh ? null : buildComponentFieldCommentBefore(filePath, protoIdx, compIdx, f.tag);
            if (cBefore) body.appendChild(cBefore);
            const cRow = fieldRow(f.tag, f, value, source, nv => compOnChange(f.tag, nv), onReset);
            // Per-field override: handler returns a replacement HTMLElement
            // that takes over the .field-control-wrap slot. We pass the
            // current value plus a write-through callback so the handler
            // doesn't need to know whether the component is localized yet.
            const override = handler?.fieldOverrides?.[f.tag];
            if (override) {
                const wrap = cRow.querySelector('.field-control-wrap');
                if (wrap) {
                    const replacement = override(f, value, nv => compOnChange(f.tag, nv), handlerCtx);
                    if (replacement) {
                        wrap.innerHTML = '';
                        wrap.appendChild(replacement);
                    }
                }
            }
            body.appendChild(cRow);
            if (!isInh) {
                attachComponentFieldComment(cRow, filePath, protoIdx, compIdx, f.tag);
                attachSeqItemCommentsForComponentField(cRow, filePath, protoIdx, compIdx, f.tag);
                attachMapEntryCommentsForComponentField(cRow, filePath, protoIdx, compIdx, f.tag);
                attachTupleElementCommentsForComponentField(cRow, filePath, protoIdx, compIdx, f.tag);
                attachDataDefFieldCommentsForComponentField(cRow, filePath, protoIdx, compIdx, f.tag);
            }
        }
    }

    // Extra fields in YAML not in metadata
    for (const [k, v] of Object.entries(data)) {
        if (k === 'type' || k.startsWith('__') || renderedTags.has(k)) continue;
        const source = isInh ? 'inherited' : 'local';
        const onReset = (!isInh) ? () => compOnReset(k) : null;
        const cBefore = isInh ? null : buildComponentFieldCommentBefore(filePath, protoIdx, compIdx, k);
        if (cBefore) body.appendChild(cBefore);
        const eRow = genericRow(k, v, source, nv => compOnChange(k, nv), onReset);
        body.appendChild(eRow);
        if (!isInh) {
            attachComponentFieldComment(eRow, filePath, protoIdx, compIdx, k);
            attachSeqItemCommentsForComponentField(eRow, filePath, protoIdx, compIdx, k);
            attachMapEntryCommentsForComponentField(eRow, filePath, protoIdx, compIdx, k);
            attachTupleElementCommentsForComponentField(eRow, filePath, protoIdx, compIdx, k);
            attachDataDefFieldCommentsForComponentField(eRow, filePath, protoIdx, compIdx, k);
        }
    }

    card.appendChild(body);

    // Handler hook: decorate the card AFTER body is populated, so the
    // handler can read field elements (e.g. to attach change listeners)
    // and prepend preview widgets above the body. We then pop the render
    // stack frame; nested dataDefCtrl calls finished resolving before
    // this point.
    if (handler) {
        try { handler.decorateHeader?.(card, hdr, effectiveCompData, cMeta, handlerCtx); }
        catch (e) { console.error('[component handler]', compType, e); }
        ComponentHandlerRegistry.popContext();
    }
    return card;
}

function collapseAllComponents(collapse) {
    document.querySelectorAll('.group-content .component-card').forEach(card => {
        card.classList.toggle('collapsed', collapse);
    });
}
