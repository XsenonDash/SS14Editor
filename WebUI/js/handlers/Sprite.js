// ======================================================================
//  SS14 Prototype Editor – Sprite component handler
// ======================================================================
//  Three layers of customisation on top of the generic component card:
//
//    1. decorateHeader — composite preview of the entity's final sprite
//       built by stacking every visible layer in YAML order at native
//       pixel sizes (layers can come from different RSIs / sizes).
//
//    2. fieldOverrides — replace specific top-level Sprite fields with
//       smarter pickers:
//        • drawdepth → enum dropdown (uses metadata.enumConstants
//          populated from [ConstantsFor(typeof(DrawDepthTag))] enums)
//        • sprite    → ResPath input restricted to .rsi directories
//        • state     → text input + dropdown listing states of the
//                      component-level RSI (with thumbnails)
//
//    3. dataDefFieldOverrides — apply the same sprite/state pickers to
//       every PrototypeLayerData entry inside the `layers` list, so
//       per-layer overrides also get autocomplete. The `state` picker
//       resolves its RSI from the layer's own `sprite` first, falling
//       back to the component-level RSI when the layer doesn't override.
// ======================================================================

'use strict';

(function () {
    if (typeof ComponentHandlerRegistry === 'undefined') return;

    // ───────────────────────────────── helpers ─────────────────────────────────

    const DRAW_DEPTH_TAG = 'Robust.Shared.GameObjects.DrawDepth';
    const PROTO_LAYER_DATA = 'Robust.Shared.GameObjects.PrototypeLayerData';

    // ───────────────────── value parsers ─────────────────────
    // Conservative parsers for SS14 YAML→JS forms: Vector2, Angle, Color.

    function parseVec2(val) {
        if (val == null) return null;
        if (typeof val === 'string') {
            // SS14 serialises Vector2 as "X Y" or "X,Y" (with or without spaces).
            const p = val.trim().split(/[\s,]+/).filter(s => s.length > 0);
            if (p.length >= 2) return { x: parseFloat(p[0]) || 0, y: parseFloat(p[1]) || 0 };
            const n = parseFloat(val);
            return Number.isFinite(n) ? { x: n, y: n } : null;
        }
        if (typeof val === 'number') return { x: val, y: val };
        if (typeof val === 'object' && !Array.isArray(val))
            return { x: Number(val.x ?? val.X ?? 0), y: Number(val.y ?? val.Y ?? 0) };
        return null;
    }

    // Angle.Theta in RobustToolbox is stored in radians.
    // YAML can surface as a plain number, "1.5rad", "90deg", or {theta: 1.5}.
    function angleToRad(val) {
        if (val == null) return null;
        // SS14 AngleSerializer writes plain numbers as degrees.
        if (typeof val === 'number') return val * Math.PI / 180;
        if (typeof val === 'string') {
            const t = val.trim();
            if (t.endsWith('deg')) return parseFloat(t) * Math.PI / 180;
            if (t.endsWith('rad')) return parseFloat(t);
            const n = parseFloat(t);
            return Number.isFinite(n) ? n * Math.PI / 180 : null;
        }
        if (typeof val === 'object' && !Array.isArray(val)) {
            // {theta} stores radians (the internal Angle.Theta property).
            if (val.theta != null) return Number(val.theta);
            if (val.rad   != null) return Number(val.rad);
            if (val.deg   != null) return Number(val.deg) * Math.PI / 180;
        }
        return null;
    }

    // SS14 Color is 0-1 float components or a CSS hex/name string.
    function colorToCss(val) {
        if (val == null) return null;
        if (typeof val === 'string') return val;
        if (typeof val === 'object' && !Array.isArray(val)) {
            const r = Math.round((val.r ?? val.R ?? 1) * 255);
            const g = Math.round((val.g ?? val.G ?? 1) * 255);
            const b = Math.round((val.b ?? val.B ?? 1) * 255);
            const a = val.a ?? val.A ?? 1;
            return `rgba(${r},${g},${b},${a})`;
        }
        return null;
    }

    // Parses a CSS color string (hex #rrggbb / #rrggbbaa, or rgb/rgba())
    // into [r,g,b,a] where each channel is 0–255.  Returns null on failure.
    function parseCssColor(css) {
        if (!css) return null;
        const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(css);
        if (hex) return [
            parseInt(hex[1], 16), parseInt(hex[2], 16),
            parseInt(hex[3], 16), hex[4] ? parseInt(hex[4], 16) : 255,
        ];
        const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(css);
        if (rgb) return [
            Math.round(parseFloat(rgb[1])), Math.round(parseFloat(rgb[2])),
            Math.round(parseFloat(rgb[3])), rgb[4] != null ? Math.round(parseFloat(rgb[4]) * 255) : 255,
        ];
        return null;
    }

    // Component-wise multiply of two CSS color strings (R×R/255, G×G/255 …).
    // Used to combine the entity-level tint with a per-layer tint, matching
    // what SS14's SpriteSystem does in the shader.
    function multiplyColors(a, b) {
        if (!a && !b) return null;
        if (!a) return b;
        if (!b) return a;
        const ca = parseCssColor(a), cb = parseCssColor(b);
        if (!ca || !cb) return a;
        const r = Math.round(ca[0] * cb[0] / 255);
        const g = Math.round(ca[1] * cb[1] / 255);
        const bl = Math.round(ca[2] * cb[2] / 255);
        const al = Math.round(ca[3] * cb[3] / 255);
        return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${bl.toString(16).padStart(2,'0')}${al.toString(16).padStart(2,'0')}`;
    }

    // Pull the effective list of layers, including any inherited Sprite.
    // We deliberately don't try to merge with inheritance here — the card
    // already shows the effective `data` object (local || inherited), and
    // the preview just renders what the editor would write out.
    function visibleLayers(data) {
        const layers = Array.isArray(data?.layers) ? data.layers : [];
        const defaultRsi = data?.sprite ?? null;
        const out = [];
        for (const layer of layers) {
            if (!layer) continue;
            if (layer.visible === false) continue;
            const rsi = layer.sprite ?? defaultRsi;
            const state = layer.state ?? null;
            if (!rsi || !state) continue;
            out.push({
                rsi, state,
                scale: layer.scale, offset: layer.offset,
                color: layer.color, rotation: layer.rotation,
            });
        }
        // Top-level sprite+state with no `layers:` is itself a single layer.
        // Component-level `offset` shifts the entity's world-space position —
        // not the layer pixels — so it is intentionally not forwarded here.
        if (out.length === 0 && data?.sprite && data?.state) {
            out.push({
                rsi: data.sprite, state: data.state,
                scale: data.scale,
                color: data.color, rotation: data.rotation,
            });
        }
        return out;
    }

    // Build a composite preview that stacks all visible layers at their native
    // pixel sizes. Component-level scale/rotation are applied to the whole
    // container; per-layer offset/scale/rotation/color are applied individually.
    async function buildCompositePreview(container, layers, compData) {
        container.innerHTML = '';
        container.style.transform = '';

        if (compData?.visible === false) {
            const ph = document.createElement('span');
            ph.className = 'sprite-preview-empty';
            ph.textContent = '(sprite hidden)';
            container.appendChild(ph);
            return;
        }
        if (layers.length === 0) {
            const ph = document.createElement('span');
            ph.className = 'sprite-preview-empty';
            ph.textContent = '(no visible layers)';
            container.appendChild(ph);
            return;
        }

        const sizes = await Promise.all(layers.map(async l => {
            try {
                const meta = await SpriteView.loadMeta(l.rsi);
                return { w: meta?.size?.x || 32, h: meta?.size?.y || 32 };
            } catch { return { w: 32, h: 32 }; }
        }));

        const maxW = Math.max(...sizes.map(s => s.w));
        const maxH = Math.max(...sizes.map(s => s.h));
        // Base scale: render at 2× native pixel size, capped so the largest
        // layer fits in 192px.  Does NOT include component-level scale yet.
        const UPSCALE = 2;
        const scale = Math.min(UPSCALE, 192 / Math.max(maxW, maxH));

        // Component-level scale baked directly into display sizes so the
        // container grows to match — CSS scale on the holder would clip.
        const cs = parseVec2(compData?.scale);
        const csx = cs ? Math.abs(cs.x) : 1;
        const csy = cs ? Math.abs(cs.y) : 1;

        // Per-layer display rects in a coordinate system whose origin is the
        // entity centre.  1 world unit = 32 RSI px; CSS Y+ down, SS14 Y+ up.
        const layerRects = layers.map((l, i) => {
            const lw = Math.round(sizes[i].w * scale * csx);
            const lh = Math.round(sizes[i].h * scale * csy);
            const off = parseVec2(l.offset);
            const ox = off ? Math.round(off.x * 32 * scale * csx) : 0;
            const oy = off ? Math.round(-off.y * 32 * scale * csy) : 0;
            // Per-layer scale stretches the visual bounds around the offset pivot.
            const ls = parseVec2(l.scale);
            const lsx = ls ? Math.abs(ls.x) : 1;
            const lsy = ls ? Math.abs(ls.y) : 1;
            return { lw, lh, ox, oy, lsx, lsy };
        });

        // Nominal area covers at least the largest layer centred at origin.
        const nomW = Math.round(maxW * scale * csx);
        const nomH = Math.round(maxH * scale * csy);
        let xMin = -nomW / 2, xMax = nomW / 2;
        let yMin = -nomH / 2, yMax = nomH / 2;
        for (const r of layerRects) {
            const visW = r.lw * r.lsx;
            const visH = r.lh * r.lsy;
            xMin = Math.min(xMin, r.ox - visW / 2);
            xMax = Math.max(xMax, r.ox + visW / 2);
            yMin = Math.min(yMin, r.oy - visH / 2);
            yMax = Math.max(yMax, r.oy + visH / 2);
        }
        // Cap to avoid absurdly large previews.
        const dispW = Math.min(Math.ceil(xMax - xMin), 384);
        const dispH = Math.min(Math.ceil(yMax - yMin), 384);
        // Maps entity-centre coordinates to CSS top-left origin.
        const originX = Math.floor(-xMin);
        const originY = Math.floor(-yMin);

        container.style.position = 'relative';
        container.style.width  = dispW + 'px';
        container.style.height = dispH + 'px';
        container.style.overflow = 'hidden';

        // Component-level rotation on the inner holder; scale is handled by
        // the container/layer sizing above so no CSS scale transform is needed.
        const layersHolder = document.createElement('div');
        layersHolder.style.cssText = 'position:absolute;inset:0';
        const cr = angleToRad(compData?.rotation);
        if (cr != null && cr !== 0) {
            layersHolder.style.transform = `rotate(${(cr * 180 / Math.PI).toFixed(2)}deg)`;
            layersHolder.style.transformOrigin = 'center';
        }
        container.appendChild(layersHolder);

        // Component-level color: used as fallback for layers with no color set.
        const compColorCss = colorToCss(compData?.color);

        layers.forEach((l, i) => {
            const { lw, lh, ox, oy } = layerRects[i];
            const layerBox = document.createElement('div');
            layerBox.style.position = 'absolute';
            // Offset is baked into position so transformOrigin:center lands on
            // the layer's pivot point (entity_centre + offset), matching SS14.
            layerBox.style.left   = Math.round(originX + ox - lw / 2) + 'px';
            layerBox.style.top    = Math.round(originY + oy - lh / 2) + 'px';
            layerBox.style.width  = lw + 'px';
            layerBox.style.height = lh + 'px';

            // Per-layer rotate then scale; no translate needed.
            const xforms = [];
            const rot = angleToRad(l.rotation);
            if (rot != null && rot !== 0) xforms.push(`rotate(${(rot * 180 / Math.PI).toFixed(2)}deg)`);
            const ls = parseVec2(l.scale);
            if (ls) xforms.push(`scale(${ls.x}, ${ls.y})`);
            if (xforms.length) { layerBox.style.transform = xforms.join(' '); layerBox.style.transformOrigin = 'center'; }

            layersHolder.appendChild(layerBox);

            // Color tint: component-level color multiplies with the per-layer
            // color, matching how SS14's shader stacks both tints.  If only
            // one is set the other acts as identity (white = no change).
            const effectiveColor = multiplyColors(compColorCss, colorToCss(l.color));
            try { SpriteView.create(layerBox, l.rsi, l.state, { size: Math.max(lw, lh), color: effectiveColor ?? undefined }); }
            catch { /* rsi/state missing */ }
        });
    }

    // ──────────────────────────── shared field controls ────────────────────────────

    // RSI-only ResPath picker. Mirrors spriteSpecifierCtrl's resPath setup
    // but emits the picked path as a bare string instead of a mapping.
    function rsiPathCtrl(value, onChange) {
        const w = document.createElement('div');
        w.className = 'field-control';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'field-input';
        inp.placeholder = 'Path/to/sprite.rsi';
        inp.value = typeof value === 'string' ? value : '';
        inp.autocomplete = 'off';
        w.appendChild(inp);

        const emit = () => onChange(inp.value.trim() || null);
        inp.addEventListener('change', emit);

        // Reuse the shared picker. `dirIsTerminal` stops the autocomplete
        // from descending into `.rsi` (which is a directory on disk but a
        // single pickable unit in YAML), and `hideFiles` keeps non-RSI
        // image files out of the dropdown.
        if (typeof resPathAutocomplete === 'function') {
            resPathAutocomplete(inp, {
                hideFiles: true,
                previewRsi: true,
                dirIsTerminal: name => name.endsWith('.rsi'),
                onPick(v) { inp.value = v; emit(); },
            });
        }
        return w;
    }

    // State picker bound to a caller-supplied RSI accessor. The accessor
    // is a function so layer overrides can resolve a fresh value every
    // render (sprite may change while the user types).
    function stateCtrl(value, getRsi, onChange) {
        const w = document.createElement('div');
        w.className = 'field-control sprite-specifier-ctrl';

        const stateRow = document.createElement('div');
        stateRow.className = 'sprite-field-row';
        const stateInp = document.createElement('input');
        stateInp.type = 'text';
        stateInp.className = 'field-input sprite-input';
        stateInp.placeholder = 'State name';
        stateInp.autocomplete = 'off';
        stateInp.value = typeof value === 'string' ? value : '';
        stateRow.appendChild(stateInp);
        w.appendChild(stateRow);

        const dd = document.createElement('div');
        dd.className = 'sprite-state-dropdown';
        stateRow.appendChild(dd);

        let suppressFocus = false;
        const emit = () => onChange(stateInp.value.trim() || null);

        async function refresh() {
            dd.innerHTML = '';
            const rsi = getRsi();
            if (!rsi || !rsi.endsWith?.('.rsi')) return;
            try {
                const meta = await SpriteView.loadMeta(rsi);
                if (!meta?.states?.length) return;
                const q = stateInp.value;
                const filtered = q
                    ? meta.states.filter(s => smartMatch(s.name, q))
                    : meta.states;
                if (!filtered.length) return;
                dd.classList.add('visible');
                for (const s of filtered) {
                    const opt = document.createElement('div');
                    opt.className = 'dropdown-item sprite-state-option';
                    const thumb = document.createElement('div');
                    thumb.className = 'sprite-state-thumb';
                    try { SpriteView.create(thumb, rsi, s.name, { size: 24 }); } catch { /* missing */ }
                    const lbl = document.createElement('span');
                    lbl.className = 'sprite-state-name';
                    lbl.textContent = s.name;
                    opt.append(thumb, lbl);
                    if (s.name === stateInp.value) opt.classList.add('selected');
                    opt.addEventListener('mousedown', e => {
                        e.preventDefault();
                        suppressFocus = true;
                        stateInp.value = s.name;
                        dd.classList.remove('visible');
                        emit();
                    });
                    dd.appendChild(opt);
                }
            } catch { /* RSI missing */ }
        }

        stateInp.addEventListener('focus', () => {
            if (suppressFocus) { suppressFocus = false; return; }
            refresh();
        });
        stateInp.addEventListener('input', refresh);
        stateInp.addEventListener('blur', () => setTimeout(() => dd.classList.remove('visible'), 180));
        stateInp.addEventListener('change', emit);
        return w;
    }

    // ──────────────────────────── handler ────────────────────────────

    ComponentHandlerRegistry.register('Sprite', {
        // Lower number = higher priority in the component list UI.
        priority: 0,

        decorateHeader(card, hdr, data /* , cMeta, ctx */) {
            // Insert the preview as the first element of the body so it
            // shows regardless of whether the card is collapsed (the
            // header collapses everything except itself).
            let body = card.querySelector('.component-body');
            if (!body) return;
            let preview = body.querySelector(':scope > .sprite-composite-preview');
            if (!preview) {
                preview = document.createElement('div');
                preview.className = 'sprite-composite-preview';
                body.insertBefore(preview, body.firstChild);
            }
            buildCompositePreview(preview, visibleLayers(data), data);
        },

        fieldOverrides: {
            drawdepth(meta, value, onChange /* , ctx */) {
                const entries = state.metadata?.enumConstants?.[DRAW_DEPTH_TAG] || [];
                if (entries.length === 0) return null; // fall back to int
                const sel = document.createElement('select');
                sel.className = 'field-control field-select';
                for (const e of entries) {
                    const opt = document.createElement('option');
                    opt.value = String(e.value);
                    opt.textContent = `${e.name} (${e.value})`;
                    sel.appendChild(opt);
                }
                // YAML stores the name string ("BelowMobs") via ConstantSerializer;
                // also handle legacy numeric values in case someone set one manually.
                let cur = null;
                if (typeof value === 'number') {
                    cur = value;
                } else if (typeof value === 'string') {
                    const byName = entries.find(e => e.name === value);
                    cur = byName ? byName.value : (Number.isFinite(Number(value)) ? Number(value) : null);
                }
                if (cur !== null && Number.isFinite(cur)) sel.value = String(cur);
                // Write back as a name string so the YAML matches ConstantSerializer output.
                sel.addEventListener('change', () => {
                    const entry = entries.find(e => String(e.value) === sel.value);
                    onChange(entry ? entry.name : Number(sel.value));
                });
                return sel;
            },

            sprite(meta, value, onChange /* , ctx */) {
                return rsiPathCtrl(value, onChange);
            },

            state(meta, value, onChange, ctx) {
                return stateCtrl(value, () => ctx?.compData?.sprite ?? null, onChange);
            },
        },

        dataDefFieldOverrides: {
            [PROTO_LAYER_DATA]: {
                sprite(meta, value, onChange /* , ctx */) {
                    return rsiPathCtrl(value, onChange);
                },
                // Layer's state list resolves against its own `sprite` if
                // present, otherwise the parent component's `sprite`.
                state(meta, value, onChange, ctx) {
                    return stateCtrl(value,
                        () => ctx?.parentObj?.sprite ?? ctx?.compData?.sprite ?? null,
                        onChange);
                },
            },
        },
    });
})();
