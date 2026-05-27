// ======================================================================
//  SS14 Prototype Editor – Render & Collapse
// ======================================================================
//  Re-renders the right pane, restores focus/scroll/collapse state after
//  rebuilds, and owns the proto-card collapse toggle widget.
// ======================================================================

'use strict';

// renderEditor() rebuilds the whole right pane.  This is intentionally
// blunt — the editor is rarely the bottleneck — but rapid mutations
// (color pickers, sliders, batched undo) used to trigger many renders
// per frame.  scheduleRenderEditor() coalesces those into one rAF tick.
let _renderScheduled = false;
function scheduleRenderEditor() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
        _renderScheduled = false;
        renderEditor();
    });
}

function renderEditor(groupId) {
    const gid = groupId ?? state.activeGroupId;
    const group = state.groups?.find(g => g.id === gid);
    const filePath = group?.activeTab ?? null;
    const groupEl = document.querySelector(`.editor-group[data-group-id="${gid}"]`);
    const area = groupEl?.querySelector('.group-content');
    if (!area) return;
    if (!filePath) {
        area.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div>
            <h2>SS14 Prototype Editor</h2>
            <p>Open a YAML file from the sidebar to start editing prototypes visually.</p>
            <p class="hint">Ctrl+S — force save</p></div>`;
        return;
    }
    const fs = state.openFiles.get(filePath);
    if (!fs) return;
    if (fs.loading) {
        area.innerHTML = `<div class="editor-loading"><div class="editor-spinner"></div><div class="editor-loading-label">Loading ${esc(filePath.split('/').pop())}\u2026</div></div>`;
        return;
    }
    if (fs.isChangelog) {
        const html = (typeof renderMarkdown === 'function')
            ? renderMarkdown(fs.changelogText ?? '')
            : esc(fs.changelogText ?? '');
        area.innerHTML = `<div class="markdown-view">${html}</div>`;
        return;
    }
    const protos = fs.yaml;
    if (!Array.isArray(protos) || protos.length === 0) {
        area.innerHTML = '<div class="empty-state"><p>No prototypes found in this file.</p></div>';
        area.appendChild(buildInterProtoToolbar(filePath, 0, 0));
        return;
    }

    // Pre-load parent files then build cards
    preloadParents(protos).then(() => {
        state.resolvedCache.clear();

        // Save collapse state, scroll position, and focused field before re-render.
        const collapseState = saveCollapseState(area);
        const savedScroll = area.scrollTop;
        // Track the focused input/select so we can restore focus after rebuild.
        const focusedEl = document.activeElement;
        let focusKey = null;
        let focusSelStart = null, focusSelEnd = null;
        if (focusedEl && area.contains(focusedEl)) {
            // Build a stable key from the nearest proto-card's id, the
            // optional containing component's type, and the field-row key.
            // Without the component type, two components in the same proto
            // that expose the same field name (e.g. `description`) would
            // collide and focus would jump to the first match, eating the
            // user's keystrokes in the second card.
            const protoCard = focusedEl.closest('.proto-card');
            const protoId = protoCard?.dataset?.protoId ?? '';
            const compCard = focusedEl.closest('.component-card');
            const compType = compCard?.dataset?.compType ?? '';
            const fieldRow = focusedEl.closest('[data-field-key]');
            const fieldKey = fieldRow?.dataset?.fieldKey ?? '';
            if (fieldKey) {
                focusKey = `${protoId}::${compType}::${fieldKey}`;
            }
            if (focusedEl.selectionStart !== undefined) {
                focusSelStart = focusedEl.selectionStart;
                focusSelEnd   = focusedEl.selectionEnd;
            }
        }

        area.innerHTML = '';
        for (let i = 0; i < protos.length; i++) {
            // Inter-proto toolbar BEFORE this proto (also acts as the very-top toolbar
            // when i === 0). The comment block (if any) is rendered after the toolbar
            // so it visually sits between the toolbar and the card it belongs to.
            area.appendChild(buildInterProtoToolbar(filePath, i, protos.length));
            const pcb = buildProtoCommentBlock(filePath, i);
            if (pcb) area.appendChild(pcb);
            try {
                area.appendChild(buildCard(protos[i], i, filePath));
            } catch (e) {
                console.error('[Editor] Error building card:', protos[i]?.id || i, e);
                const errCard = _div('proto-card proto-error');
                errCard.innerHTML = `<div class="proto-header"><span class="proto-type-badge">${esc(protos[i]?.type || '?')}</span><span class="proto-id-text">${esc(protos[i]?.id || '?')}</span></div><div class="proto-body" style="color:var(--warning);padding:8px">${esc(e.message)}</div>`;
                area.appendChild(errCard);
            }
        }
        // Trailing toolbar (add + trailing-comment) after the last proto.
        area.appendChild(buildInterProtoToolbar(filePath, protos.length, protos.length));
        const trailing = buildTrailingCommentBlock(filePath);
        if (trailing) area.appendChild(trailing);

        // Restore collapse state and scroll position
        restoreCollapseState(area, collapseState);
        area.scrollTop = savedScroll;
        // Restore focus to the same field (identified by protoId::compType::fieldKey).
        if (focusKey) {
            const [protoId, compType, fieldKey] = focusKey.split('::');
            const card = protoId
                ? area.querySelector(`.proto-card[data-proto-id="${CSS.escape(protoId)}"]`)
                : area;
            const scope = compType
                ? (card ?? area).querySelector(`.component-card[data-comp-type="${CSS.escape(compType)}"]`)
                : (card ?? area);
            const newFocus = (scope ?? card ?? area).querySelector(`[data-field-key="${CSS.escape(fieldKey)}"]`);
            if (newFocus) {
                const inp = newFocus.querySelector('input, select, textarea') ?? newFocus;
                if (inp && (inp.tagName === 'INPUT' || inp.tagName === 'SELECT' || inp.tagName === 'TEXTAREA')) {
                    inp.focus({ preventScroll: true });
                    if (focusSelStart !== null && inp.setSelectionRange) {
                        try { inp.setSelectionRange(focusSelStart, focusSelEnd); } catch {}
                    }
                }
            }
        }
    }).catch(e => {
        console.error('[Editor] preloadParents failed:', e);
        area.innerHTML = `<div class="empty-state"><p style="color:var(--warning)">Render error: ${esc(e.message)}</p></div>`;
    });
}

function buildAddProtoFooter() {
    const footer = _div('add-proto-footer');
    const btn = _el('button'); btn.className = 'add-proto-btn'; btn.textContent = '+ Add Prototype';
    btn.addEventListener('click', () => showAddProtoModal());
    footer.appendChild(btn);
    return footer;
}

// Eye-icon collapse/expand toggle. The button visually swaps icon via the
// `.collapsed` class on its nearest ancestor card (proto-card or
// component-card). Hover-only visibility is handled in CSS.
function buildCollapseBtn(getCard) {
    const btn = _el('button');
    btn.className = 'collapse-btn';
    btn.type = 'button';
    btn.title = 'Show only overridden fields';
    btn.setAttribute('aria-label', 'Toggle field visibility');
    btn.innerHTML = `
        <svg class="icon-open" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
        <svg class="icon-closed" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`;
    btn.addEventListener('click', e => {
        e.stopPropagation();
        const card = getCard();
        if (!card) return;
        card.classList.toggle('collapsed');
        btn.title = card.classList.contains('collapsed')
            ? 'Show all fields'
            : 'Show only overridden fields';
    });
    return btn;
}

// ======================== COLLAPSE / EXPAND ALL ========================
// Collapse state is keyed by *prototype id* and *component type*, not by
// index — adding / removing / reordering a component must not bleed the
// expanded/collapsed flag onto an unrelated card.
function saveCollapseState(area) {
    const state = { protos: {}, comps: {} };
    area.querySelectorAll('.proto-card').forEach(card => {
        const pid = card.dataset.protoId || card.querySelector('.proto-id-text')?.textContent || '';
        if (!pid) return;
        state.protos[pid] = card.classList.contains('collapsed');
        state.comps[pid] = {};
        card.querySelectorAll('.component-card').forEach(comp => {
            const ct = comp.querySelector('.component-type')?.textContent || '';
            if (!ct) return;
            state.comps[pid][ct] = comp.classList.contains('collapsed');
        });
    });
    return state;
}

function restoreCollapseState(area, saved) {
    area.querySelectorAll('.proto-card').forEach(card => {
        const pid = card.dataset.protoId || card.querySelector('.proto-id-text')?.textContent || '';
        if (!pid) return;
        if (saved.protos[pid] !== undefined) {
            card.classList.toggle('collapsed', saved.protos[pid]);
        }
        const cm = saved.comps[pid];
        if (cm) {
            card.querySelectorAll('.component-card').forEach(comp => {
                const ct = comp.querySelector('.component-type')?.textContent || '';
                if (!ct) return;
                if (cm[ct] !== undefined) {
                    comp.classList.toggle('collapsed', cm[ct]);
                }
            });
        }
    });
}

function collapseAllProtos(collapse) {
    document.querySelectorAll('.group-content .proto-card').forEach(card => {
        card.classList.toggle('collapsed', collapse);
    });
}

// Editor area context menu for collapse/expand all — delegated on #editor-groups.
document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('editor-groups');
    if (container) {
        container.addEventListener('contextmenu', e => {
            if (!e.target.closest('.group-content')) return;
            if (e.target.closest('.proto-card, .field-row, .component-card, .add-proto-footer, .inter-proto-toolbar, .yaml-comment-block, .yaml-comment-editor')) return;
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY, [
                { label: 'Collapse all prototypes', action: () => collapseAllProtos(true) },
                { label: 'Expand all prototypes', action: () => collapseAllProtos(false) },
            ]);
        });
    }
});
