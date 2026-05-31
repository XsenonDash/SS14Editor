// ======================================================================
//  SS14 Editor – YAML helpers (eemeli/yaml v2)
// ======================================================================

'use strict';

// ──────────────────────────────────────────────────────────────────────
//  AST → JS  (respects !type:Foo tags → { __yamlTag: 'Foo', ... })
// ──────────────────────────────────────────────────────────────────────
function _nodeToJs(node) {
    if (node == null) return null;
    if (YAML.isAlias(node)) return _nodeToJs(node.resolve());
    if (YAML.isScalar(node)) {
        if (node.tag && node.tag.startsWith('!type:')) {
            return { __yamlTag: node.tag.slice(6) };
        }
        return node.value;
    }
    if (YAML.isMap(node)) {
        const obj = {};
        if (node.tag && node.tag.startsWith('!type:')) {
            obj.__yamlTag = node.tag.slice(6);
        }
        for (const pair of node.items) {
            const k = YAML.isScalar(pair.key) ? pair.key.value : String(pair.key);
            if (k != null) obj[String(k)] = _nodeToJs(pair.value);
        }
        return obj;
    }
    if (YAML.isSeq(node)) {
        return node.items.map(_nodeToJs);
    }
    return null;
}

// ──────────────────────────────────────────────────────────────────────
//  JS → AST  (respects __yamlTag → !type:Foo tags)
// ──────────────────────────────────────────────────────────────────────
function _jsToNode(val, doc) {
    if (val === null || val === undefined) {
        return doc.createNode(null);
    }
    if (typeof val !== 'object') {
        return doc.createNode(val);
    }
    if (Array.isArray(val)) {
        const seq = doc.createNode([]);
        seq.flow = false;
        seq.items = val.map(item => _jsToNode(item, doc));
        return seq;
    }
    const tag = val.__yamlTag ? '!type:' + val.__yamlTag : null;
    const keys = Object.keys(val).filter(k => k !== '__yamlTag');
    if (tag && keys.length === 0) {
        // Parameterless polymorphic item → bare tagged scalar (`!type:Foo`).
        // Parsed bare tags have value="" + type=PLAIN; match that exactly so
        // _normalizeScalarStyles never re-quotes the empty-string value.
        const scalar = doc.createNode('');
        scalar.type = 'PLAIN';
        scalar.tag = tag;
        return scalar;
    }
    const map = doc.createNode({});
    map.items = keys.map(k =>
        new YAML.Pair(doc.createNode(k), _jsToNode(val[k], doc))
    );
    if (tag) map.tag = tag;
    return map;
}

function parseYaml(text) {
    try {
        const doc = YAML.parseDocument(text, { logLevel: 'error' });
        if (!doc.contents) return [];
        return YAML.isSeq(doc.contents)
            ? doc.contents.items.map(_nodeToJs)
            : [_nodeToJs(doc.contents)];
    } catch (e) {
        console.error('YAML parse error', e);
        return [];
    }
}

/**
 * Parse YAML text and return both the JS proto array AND the Document
 * object (for the respectful save path).  Returns { protos, doc }.
 */
function parseYamlDoc(text) {
    try {
        const doc = YAML.parseDocument(text, { logLevel: 'error' });
        const protos = doc.contents && YAML.isSeq(doc.contents)
            ? doc.contents.items.map(_nodeToJs)
            : [];
        return { protos, doc };
    } catch (e) {
        console.error('YAML parse error', e);
        return { protos: [], doc: null };
    }
}

/**
 * Parse a single arbitrary YAML value (mapping, sequence, or scalar).
 * Used for the raw-YAML textarea widget in field controls.
 */
function parseYamlValue(text) {
    try {
        const doc = YAML.parseDocument(text, { logLevel: 'error' });
        return doc.contents ? _nodeToJs(doc.contents) : null;
    } catch (e) {
        console.error('YAML parse error', e);
        return undefined;
    }
}

// ──────────────────────────────────────────────────────────────────────
//  Key ordering helpers
// ──────────────────────────────────────────────────────────────────────

// `type` and `id` are the structural YAML discriminators every prototype
// must carry — they always come first.  Everything else (parent, abstract,
// name, description, …) is taken from the metadata field order so the YAML
// matches the redactor's visual layout exactly.
const _PROTO_STRUCTURAL_HEAD = ['type', 'id'];

/**
 * Returns a copy of `obj` whose keys are in metadata-defined order so the
 * serialized YAML matches the visual layout of the redactor, not the
 * accidental order in which the user happened to override fields.
 */
function _orderKeys(obj, fieldOrder, structuralHead) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const seen = new Set();
    const out = {};
    if (obj.__yamlTag !== undefined) { out.__yamlTag = obj.__yamlTag; seen.add('__yamlTag'); }
    if (structuralHead) {
        for (const k of structuralHead) {
            if (Object.prototype.hasOwnProperty.call(obj, k) && !seen.has(k)) {
                out[k] = obj[k]; seen.add(k);
            }
        }
    }
    if (fieldOrder) {
        for (const tag of fieldOrder) {
            if (Object.prototype.hasOwnProperty.call(obj, tag) && !seen.has(tag)) {
                out[tag] = obj[tag]; seen.add(tag);
            }
        }
    }
    for (const k of Object.keys(obj)) {
        if (!seen.has(k)) out[k] = obj[k];
    }
    return out;
}

function _fieldOrderFor(meta) {
    if (!meta?.fields) return null;
    return meta.fields.map(f => f.tag);
}

function _canonicalizeProto(proto) {
    if (!proto || typeof proto !== 'object') return proto;
    const type = proto.type;
    const metaProto = (typeof state !== 'undefined' && state.metadata?.prototypes?.[type]) || null;
    const fieldOrder = _fieldOrderFor(metaProto);
    const ordered = _orderKeys(proto, fieldOrder, _PROTO_STRUCTURAL_HEAD);
    if (Array.isArray(ordered.components)) {
        if (ordered.components.length === 0) {
            delete ordered.components;
        } else {
            ordered.components = ordered.components.map(c => _canonicalizeComponent(c));
        }
    }
    return ordered;
}

function _canonicalizeComponent(comp) {
    if (!comp || typeof comp !== 'object') return comp;
    const compType = comp.type;
    const metaComp = (typeof state !== 'undefined' && state.metadata?.components?.[compType]) || null;
    const fieldOrder = _fieldOrderFor(metaComp);
    return _orderKeys(comp, fieldOrder, ['type']);
}

// ──────────────────────────────────────────────────────────────────────
//  Stringify helpers
// ──────────────────────────────────────────────────────────────────────
const _DUMP_OPTS = { indent: 2, lineWidth: -1, singleQuote: null, indentSeq: false };

// eemeli/yaml cannot produce bare tagged scalars (‘!type:Foo’ with no value);
// it always appends "" for empty-string scalar values.  Post-process the
// serialized text to restore the canonical SS14 form.
function _stripBareTagQuotes(yaml) {
    return yaml.replace(/(!type:\S+) ""/g, '$1');
}
// Canonical sort order for well-known SS14 prototype field names.
// Fields absent from this map retain their insertion order, placed after all
// known fields.  Lower value → earlier in output.
const _FIELD_PRIORITY = {
    // entity / recipe top-level
    type: 0, id: 1, parent: 2, name: 3, description: 4, suffix: 5, categories: 6, components: 7,
    // effect parameters (ApplyStatusEffectStack, etc.)
    statusEffect: 10, amount: 11, max: 12,
    // area-effect / selector parameters
    range: 13, whitelist: 14, effects: 15,
    // polymorphic target / spawn fields
    effectTarget: 16, spawns: 17, distance: 18,
    // Sprite / layer fields
    drawdepth: 20, layers: 21, state: 22, color: 23,
    // animation / slot fields
    anim: 25, animations: 26, effectSlots: 27,
};

// Recursively sort map pairs by canonical priority (stable: equal-priority
// pairs keep insertion order).  Applied before every proto serialization so
// that field write-order in the editor does not affect YAML output order.
function _sortMapFields(node) {
    if (!node || typeof node !== 'object') return;
    if (YAML.isMap(node)) {
        node.items.sort((a, b) => {
            const ka = YAML.isScalar(a.key) ? String(a.key.value) : '';
            const kb = YAML.isScalar(b.key) ? String(b.key.value) : '';
            return (_FIELD_PRIORITY[ka] ?? Infinity) - (_FIELD_PRIORITY[kb] ?? Infinity);
        });
        for (const pair of node.items) {
            if (YAML.isPair(pair)) _sortMapFields(pair.value);
        }
    } else if (YAML.isSeq(node)) {
        for (const item of node.items) _sortMapFields(item);
    }
}
function _dumpSingleProto(proto) {
    const doc = new YAML.Document();
    const seq = doc.createNode([]);
    const protoNode = _jsToNode(_canonicalizeProto(proto), doc);
    _sortAstProtoNode(protoNode);
    seq.add(protoNode);
    doc.contents = seq;
    return _stripBareTagQuotes(doc.toString(_DUMP_OPTS));
}

/**
 * Full serialize: rebuild YAML text from scratch (no comment preservation).
 * Used for structural changes (add / delete / reorder prototype).
 */
function dumpYaml(data) {
    if (Array.isArray(data)) {
        return data.map(item => _dumpSingleProto(item).trimEnd()).join('\n\n') + '\n';
    }
    const doc = new YAML.Document();
    doc.contents = _jsToNode(data, doc);
    return doc.toString(_DUMP_OPTS);
}

/**
 * Respectful serialize: keeps original text (including comments) for
 * untouched prototypes; re-serializes only the dirty ones.
 *
 * Falls back to dumpYaml() if the prototype count changed (structural
 * change) or if positional range data is missing.
 *
 * IMPORTANT: in eemeli/yaml, items[i].range[0] points to the start of the
 * VALUE node AFTER the '- ' indicator.  We scan back to include the '- '
 * so gaps contain only blank lines and clean items include their '- '.
 */
function dumpYamlRespectful(yamlArray, doc, originalText, dirtyIndices) {
    if (!doc || !YAML.isSeq(doc.contents) ||
        yamlArray.length !== doc.contents.items.length) {
        return dumpYaml(yamlArray);
    }
    const items = doc.contents.items;
    const parts = [];
    let pos = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.range) return dumpYaml(yamlArray); // safety: no range info
        const [nodeStart, , nodeEnd] = item.range;
        // Scan back from the value-node start to find the '-' sequence indicator.
        // items[i].range[0] is after '- ', so the gap between items otherwise
        // includes the '-' and would double it when a dirty item is re-serialized.
        const itemStart = _seqEntryStart(originalText, nodeStart);
        // Text between end of previous item (or start of file) and this item
        // (blank lines, inter-item comments, leading file comments, etc.)
        parts.push(originalText.slice(pos, itemStart));
        if (dirtyIndices.has(i)) {
            // Normalize scalar styles before serializing so that scalars
            // that were quoted in the source (e.g. parent: "BaseMob") are
            // re-emitted without unnecessary quotes after any edit.
            _normalizeScalarStyles(items[i]);
            // Serialize from the (mutated) AST node so internal comments
            // (commentBefore on child nodes) are preserved even when field
            // values were changed via docSetField / docDeleteField.
            parts.push(_dumpSingleProtoFromNode(items[i]));
        } else {
            // Slice from '-' to nodeEnd (inclusive of trailing newline)
            parts.push(originalText.slice(itemStart, nodeEnd));
        }
        pos = nodeEnd;
    }
    // Trailing content after the last item (trailing newline, etc.)
    parts.push(originalText.slice(pos));
    return parts.join('');
}

/**
 * Serialize a single proto from its YAML AST node (preserving internal
 * comments, tags, and structure) as a block-sequence entry ("- type: …").
 *
 * The top-level spaceBefore / commentBefore on the node belong to the
 * inter-proto gap already emitted by dumpYamlRespectful via text-slicing,
 * so we suppress them here to avoid duplication.
 */
function _forceBlockStyle(node) {
    if (!node || typeof node !== 'object') return;
    if (YAML.isSeq(node) || YAML.isMap(node)) node.flow = false;
    if (YAML.isSeq(node)) {
        for (const item of node.items) _forceBlockStyle(item);
    } else if (YAML.isMap(node)) {
        for (const pair of node.items) {
            if (YAML.isPair(pair)) _forceBlockStyle(pair.value);
        }
    }
}

/**
 * Recursively clear the `style` property on all Scalar nodes so that
 * eemeli/yaml re-determines the quoting style from the value.
 * Applied to dirty proto AST nodes before serialization to ensure that
 * scalars originally quoted in the source (e.g. parent: "BaseMob") are
 * not preserved with unnecessary quotes.
 * Values that genuinely require quoting (e.g. "true", "#ff0000") will
 * be re-quoted automatically by the serializer.
 */
function _normalizeScalarStyles(node) {
    if (!node || typeof node !== 'object') return;
    if (YAML.isScalar(node)) {
        // Bare-tag scalars (empty value + custom tag, e.g. !type:Delete) must
        // keep PLAIN type — clearing it causes eemeli/yaml to re-quote the
        // empty string as "" instead of leaving it as a bare tag.
        if (!(node.value === '' && node.tag)) node.type = undefined;
        return;
    }
    if (YAML.isSeq(node)) { for (const item of node.items) _normalizeScalarStyles(item); }
    else if (YAML.isMap(node)) {
        for (const pair of node.items) {
            if (YAML.isPair(pair)) {
                _normalizeScalarStyles(pair.key);
                _normalizeScalarStyles(pair.value);
            }
        }
    }
}

/**
 * Sort the pairs of a YAML Map AST node by an explicit field order list.
 * structuralHead fields come first, then fieldOrder fields, then any
 * remaining fields in their original relative order (stable).
 */
function _sortAstMapByOrder(mapNode, fieldOrder, structuralHead) {
    if (!mapNode || !YAML.isMap(mapNode)) return;
    const order = [];
    if (structuralHead) for (const k of structuralHead) if (!order.includes(k)) order.push(k);
    if (fieldOrder)     for (const k of fieldOrder)     if (!order.includes(k)) order.push(k);
    if (order.length === 0) return;
    mapNode.items.sort((a, b) => {
        const ka = YAML.isScalar(a.key) ? String(a.key.value) : '';
        const kb = YAML.isScalar(b.key) ? String(b.key.value) : '';
        const ia = order.indexOf(ka);
        const ib = order.indexOf(kb);
        return (ia >= 0 ? ia : Infinity) - (ib >= 0 ? ib : Infinity);
    });
}

/**
 * Sort the AST pairs of a proto map node (and its component sub-nodes) by
 * DLL-metadata field order so that the serialized YAML matches the visual
 * layout of the redactor.  Falls back to _sortMapFields (static
 * _FIELD_PRIORITY) when metadata is not loaded.
 */
function _sortAstProtoNode(protoNode) {
    if (!protoNode || !YAML.isMap(protoNode)) return;
    const typePair  = protoNode.items.find(p => YAML.isScalar(p.key) && p.key.value === 'type');
    const protoType = typePair && YAML.isScalar(typePair.value) ? String(typePair.value.value) : null;
    const metaProto = (typeof state !== 'undefined' && protoType && state.metadata?.prototypes?.[protoType]) || null;
    const protoFieldOrder = _fieldOrderFor(metaProto);
    if (!protoFieldOrder) {
        _sortMapFields(protoNode);
        return;
    }
    _sortAstMapByOrder(protoNode, protoFieldOrder, _PROTO_STRUCTURAL_HEAD);
    const compsPair = protoNode.items.find(p => YAML.isScalar(p.key) && p.key.value === 'components');
    if (!compsPair || !YAML.isSeq(compsPair.value)) return;
    for (const compNode of compsPair.value.items) {
        if (!YAML.isMap(compNode)) continue;
        const cTypePair   = compNode.items.find(p => YAML.isScalar(p.key) && p.key.value === 'type');
        const cType       = cTypePair && YAML.isScalar(cTypePair.value) ? String(cTypePair.value.value) : null;
        const metaComp    = (typeof state !== 'undefined' && cType && state.metadata?.components?.[cType]) || null;
        const cFieldOrder = _fieldOrderFor(metaComp);
        if (cFieldOrder) {
            _sortAstMapByOrder(compNode, cFieldOrder, ['type']);
        } else {
            _sortMapFields(compNode);
        }
    }
}

function _dumpSingleProtoFromNode(node) {
    _sortAstProtoNode(node);
    _forceBlockStyle(node);
    const origSpace   = node.spaceBefore;
    const origComment = node.commentBefore;
    node.spaceBefore   = false;
    node.commentBefore = undefined;
    try {
        const tmpDoc = new YAML.Document();
        const seq = tmpDoc.createNode([]);
        seq.add(node);
        tmpDoc.contents = seq;
        return _stripBareTagQuotes(tmpDoc.toString(_DUMP_OPTS));
    } finally {
        node.spaceBefore   = origSpace;
        node.commentBefore = origComment;
    }
}

/**
 * Recursively patch an existing YAML AST node in-place to match a new JS
 * value, preserving all commentBefore / comment annotations on child nodes.
 *
 * Handles structural mismatches (scalar ↔ map, etc.) by falling back to
 * full replacement for that subtree only.
 */
// Returns the expected YAML tag string for a JS value, or undefined.
function _expectedTag(jsVal) {
    return jsVal?.__yamlTag ? '!type:' + jsVal.__yamlTag : undefined;
}

/**
 * Stable, fast-ish deep comparison key used purely for "is this AST item
 * the same value as that new JS item?" matching during Seq patching. Two
 * values that produce the same string are considered equivalent for the
 * purpose of preserving comments across reorders / removals.
 */
function _seqMatchKey(jsVal) {
    if (jsVal === null || jsVal === undefined) return 'n';
    const t = typeof jsVal;
    if (t === 'string') return 's:' + jsVal;
    if (t === 'number') return 'f:' + jsVal;
    if (t === 'boolean') return 'b:' + (jsVal ? 1 : 0);
    if (Array.isArray(jsVal)) return 'a:[' + jsVal.map(_seqMatchKey).join(',') + ']';
    if (t === 'object') {
        const keys = Object.keys(jsVal).filter(k => !k.startsWith('__')).sort();
        const tag = jsVal.__yamlTag ? '!' + jsVal.__yamlTag : '';
        return 'o' + tag + ':{' + keys.map(k => k + '=' + _seqMatchKey(jsVal[k])).join(',') + '}';
    }
    return '?';
}

function _astNodeMatchKey(node) {
    if (node === null || node === undefined) return 'n';
    if (YAML.isScalar(node)) {
        const v = node.value;
        // Bare-tag scalar (!type:Foo with empty value) — match the same key as
        // _seqMatchKey would produce for {__yamlTag:'Foo'} so that comment-
        // preserving match-by-value works across round-trips.
        if (v === '' && node.tag && node.tag.startsWith('!type:'))
            return 'o!' + node.tag.slice(6) + ':{}'; 
        if (v === null || v === undefined) return 'n';
        if (typeof v === 'string') return 's:' + v;
        if (typeof v === 'number') return 'f:' + v;
        if (typeof v === 'boolean') return 'b:' + (v ? 1 : 0);
        return '?';
    }
    if (YAML.isSeq(node)) return 'a:[' + node.items.map(_astNodeMatchKey).join(',') + ']';
    if (YAML.isMap(node)) {
        const pairs = node.items.map(p => {
            const k = YAML.isScalar(p.key) ? p.key.value : '?';
            return [String(k), _astNodeMatchKey(p.value)];
        });
        pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        const tag = node.tag ? node.tag.replace(/^!type:/, '!') : '';
        return 'o' + tag + ':{' + pairs.map(p => p[0] + '=' + p[1]).join(',') + '}';
    }
    return '?';
}

/**
 * Patch a YAML Seq AST node in-place to match a new JS array, preserving
 * per-item comments (commentBefore / comment on each item) across reorder,
 * removal, and insertion. The naive zip-by-position approach loses comment
 * identity whenever items shift — a reorder rewires comments onto the wrong
 * values. Strategy:
 *
 *   1. Same length AND no positional value changes → no-op.
 *   2. Same length AND exactly one positional value differs → positional
 *      edit at that index (preserves all comments, including the edited
 *      item's own commentBefore).
 *   3. Otherwise, attempt match-by-value: assign each new JS item to a
 *      unique unused old AST node with the same _seqMatchKey. If a clean
 *      mapping exists (allowing for fresh additions/removals), use it;
 *      this preserves comments through reorders and partial edits.
 *   4. Fall back to the previous zip-by-position behaviour for messy
 *      cases (multiple simultaneous edits without permutation).
 */
function _patchSeq(astNode, jsValue, doc) {
    const oldItems = [...astNode.items];
    const oldKeys = oldItems.map(_astNodeMatchKey);
    const newKeys = jsValue.map(_seqMatchKey);

    // (1) / (2): same-length fast paths.
    if (oldItems.length === jsValue.length) {
        let diffs = 0; let diffIdx = -1;
        for (let i = 0; i < oldItems.length; i++) {
            if (oldKeys[i] !== newKeys[i]) { diffs++; diffIdx = i; if (diffs > 1) break; }
        }
        if (diffs === 0) return;
        if (diffs === 1) {
            _patchSeqItemAt(astNode, diffIdx, jsValue[diffIdx], doc);
            for (let i = 0; i < astNode.items.length; i++) {
                const s = astNode.items[i];
                if (i !== diffIdx && YAML.isScalar(s) && !(s.value === '' && s.tag))
                    s.type = undefined;
            }
            return;
        }
    }

    // (3): match-by-value. Greedy: for each new item, take the first unused
    // old item with the same key.
    const used = new Set();
    const mapping = new Array(jsValue.length);
    let reused = 0;
    for (let i = 0; i < jsValue.length; i++) {
        const want = newKeys[i];
        const found = oldKeys.findIndex((k, j) => !used.has(j) && k === want);
        if (found >= 0) { used.add(found); mapping[i] = found; reused++; }
        else { mapping[i] = -1; }
    }
    // Use match-by-value when at least one item was reused, so comments
    // ride along with their values across reorders, removals, and partial
    // edits. (Pure same-length single-edit is already handled above; pure
    // identical is the no-op fast path.)
    if (reused > 0) {
        const newItems = new Array(jsValue.length);
        for (let i = 0; i < jsValue.length; i++) {
            if (mapping[i] >= 0) {
                const reusedNode = oldItems[mapping[i]];
                // If the JS value differs (shouldn't, since keys matched) patch
                // it; otherwise leave the node alone so comments stay intact.
                const want = newKeys[i];
                if (_astNodeMatchKey(reusedNode) !== want) {
                    _patchSeqItemAt({ items: newItems }, i, jsValue[i], doc, reusedNode);
                } else {
                    if (YAML.isScalar(reusedNode) && !(reusedNode.value === '' && reusedNode.tag))
                        reusedNode.type = undefined;
                    newItems[i] = reusedNode;
                }
            } else {
                newItems[i] = _jsToNode(jsValue[i], doc);
            }
        }
        astNode.items.length = 0;
        astNode.items.push(...newItems);
        return;
    }

    // (4): fallback — original zip-by-position behaviour.
    const minLen = Math.min(astNode.items.length, jsValue.length);
    for (let i = 0; i < minLen; i++) _patchSeqItemAt(astNode, i, jsValue[i], doc);
    for (let i = minLen; i < jsValue.length; i++) astNode.add(_jsToNode(jsValue[i], doc));
    astNode.items.splice(jsValue.length);
    for (const item of astNode.items) {
        if (YAML.isScalar(item) && !(item.value === '' && item.tag)) item.type = undefined;
    }
}

// Patch (or replace) the item at index `i` of `astNode.items` to represent
// `jsItem`. When the existing node is structurally compatible, patch it
// in-place so its commentBefore / comment annotations survive. Pass
// `forceNode` to slot an explicit AST node (used by the match-by-value
// path to recycle a node from a different index).
function _patchSeqItemAt(astNode, i, jsItem, doc, forceNode) {
    const item = forceNode !== undefined ? forceNode : astNode.items[i];
    const jsIsObj = jsItem !== null && typeof jsItem === 'object' && !Array.isArray(jsItem);
    const jsIsArr = Array.isArray(jsItem);
    if (item !== undefined) {
        if (YAML.isScalar(item) && !jsIsObj && !jsIsArr) {
            if (item.value !== jsItem) item.type = undefined;
            item.value = jsItem; astNode.items[i] = item; return;
        }
        if (YAML.isMap(item) && jsIsObj && item.tag === _expectedTag(jsItem)) {
            _patchAstNode(item, jsItem, doc); astNode.items[i] = item; return;
        }
        if (YAML.isSeq(item) && jsIsArr) { _patchAstNode(item, jsItem, doc); astNode.items[i] = item; return; }
    }
    astNode.items[i] = _jsToNode(jsItem, doc);
}

/**
 * Recursively patch an existing YAML AST node in-place to match a new JS
 * value, preserving all commentBefore / comment annotations on child nodes.
 *
 * Callers MUST ensure the YAML tag of `astNode` already matches the new
 * value before calling (see docSetField / the Map/Seq branches below).
 * This function never modifies a node's tag — type changes always fall
 * back to full _jsToNode replacement so the tag is set correctly.
 */
function _patchAstNode(astNode, jsValue, doc) {
    if (YAML.isScalar(astNode)) {
        if (astNode.value !== jsValue) astNode.type = undefined;
        astNode.value = jsValue;
        return;
    }

    if (YAML.isMap(astNode) && jsValue !== null && typeof jsValue === 'object' && !Array.isArray(jsValue)) {
        const jsKeys = Object.keys(jsValue).filter(k => !k.startsWith('__'));
        const jsKeySet = new Set(jsKeys);

        // Delete keys absent from the new value.
        const existingKeys = astNode.items.map(p => p.key?.value).filter(k => typeof k === 'string');
        for (const k of existingKeys) {
            if (!jsKeySet.has(k)) astNode.delete(k);
        }

        for (const k of jsKeys) {
            const childNode = astNode.get(k, true); // keepScalar → raw AST node
            const jsVal = jsValue[k];
            const jsIsObj = jsVal !== null && typeof jsVal === 'object' && !Array.isArray(jsVal);
            const jsIsArr = Array.isArray(jsVal);
            if (childNode !== undefined) {
                if (YAML.isScalar(childNode) && !jsIsObj && !jsIsArr) { childNode.value = jsVal; continue; }
                // For Map children, only patch in-place when the YAML tag matches;
                // a tag change means a type change → full replacement preserves correctness.
                if (YAML.isMap(childNode) && jsIsObj && childNode.tag === _expectedTag(jsVal)) {
                    _patchAstNode(childNode, jsVal, doc); continue;
                }
                if (YAML.isSeq(childNode) && jsIsArr) { _patchAstNode(childNode, jsVal, doc); continue; }
            }
            // Missing key, structural mismatch, or YAML-tag mismatch: full replacement.
            astNode.set(k, _jsToNode(jsVal, doc));
        }
        return;
    }

    if (YAML.isSeq(astNode) && Array.isArray(jsValue)) {
        _patchSeq(astNode, jsValue, doc);
        return;
    }
    // Alias / unhandled node type: no-op.
}

/**
 * Apply a field-set mutation to the YAML AST document so that internal
 * comments are preserved when dumpYamlRespectful re-serializes the proto.
 * path follows the same convention as setFieldValue (starts with protoIdx).
 *
 * For complex (object / array) values the existing AST subtree is patched
 * in-place via _patchAstNode, which preserves all commentBefore / comment
 * annotations on child nodes even when deeply nested values change.
 *
 * Returns false on failure (commitChange falls back to dumpYaml).
 */
function docSetField(doc, path, tag, value) {
    if (!doc || !YAML.isDocument(doc)) return false;
    try {
        if (value !== null && typeof value === 'object') {
            const existingNode = doc.getIn([...path, tag], true);
            // For Seq values, always patch in-place (sequences carry no !type: tag).
            if (YAML.isSeq(existingNode) && Array.isArray(value)) {
                _patchAstNode(existingNode, value, doc);
                return true;
            }
            // For Map values, only patch in-place when the YAML tag matches;
            // a type change must go through _jsToNode so the tag is written correctly.
            if (YAML.isMap(existingNode) && !Array.isArray(value) &&
                existingNode.tag === _expectedTag(value)) {
                _patchAstNode(existingNode, value, doc);
                return true;
            }
        } else {
            // Primitive (scalar) value: patch the existing scalar node in-place
            // so any inline comment stored on it (pair.value.comment) is preserved.
            const existingNode = doc.getIn([...path, tag], true);
            if (YAML.isScalar(existingNode)) {
                _patchAstNode(existingNode, value, doc);
                return true;
            }
        }
        doc.setIn([...path, tag], _jsToNode(value, doc));
        return true;
    } catch {
        return false;
    }
}

/**
 * Apply a field-delete mutation to the YAML AST document.
 */
function docDeleteField(doc, path, tag) {
    if (!doc || !YAML.isDocument(doc)) return false;
    try {
        doc.deleteIn([...path, tag]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Scan backwards from a value-node start offset to find the '-' sequence
 * indicator that introduces the block-sequence entry.
 */
function _seqEntryStart(text, nodeRangeStart) {
    let i = nodeRangeStart - 1;
    while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
    if (i >= 0 && text[i] === '-') return i;
    return nodeRangeStart; // fallback (should not happen in a block sequence)
}


/**
 * Merge editor edits with the latest on-disk content so external edits
 * (comments, formatting tweaks) made in another editor are preserved
 * when autosave fires.
 *
 * For each proto index:
 *   - if dirtySinceSave contains it -> re-serialize from the editor's
 *     AST node (the user's edit wins for that proto's content),
 *   - otherwise -> slice the raw text from diskContent (preserves any
 *     external comments / whitespace verbatim).
 *
 * Returns the merged text, or 
ull to signal "cannot merge - caller
 * should fall back to writing the editor's own content" (e.g. structural
 * drift, missing range info).
 */
function dumpYamlMergeDisk(editorYaml, editorDoc, diskContent, diskDoc, dirtySinceSave) {
    if (!diskDoc || !YAML.isSeq(diskDoc.contents)) return null;
    if (!editorDoc || !YAML.isSeq(editorDoc.contents)) return null;
    const diskItems   = diskDoc.contents.items;
    const editorItems = editorDoc.contents.items;
    if (diskItems.length !== editorYaml.length) return null;
    if (editorItems.length !== editorYaml.length) return null;
    const parts = [];
    let pos = 0;
    for (let i = 0; i < diskItems.length; i++) {
        const item = diskItems[i];
        if (!item.range) return null;
        const nodeStart = item.range[0];
        const nodeEnd   = item.range[2];
        const itemStart = _seqEntryStart(diskContent, nodeStart);
        parts.push(diskContent.slice(pos, itemStart));
        if (dirtySinceSave.has(i)) {
            parts.push(_dumpSingleProtoFromNode(editorItems[i]));
        } else {
            parts.push(diskContent.slice(itemStart, nodeEnd));
        }
        pos = nodeEnd;
    }
    parts.push(diskContent.slice(pos));
    return parts.join('');
}

/**
 * Structural-respectful serialize: handles add, delete, and reorder of
 * prototypes while keeping existing comments intact.
 *
 * Matches old protos to new ones by id. For each proto present in both
 * old and new, its original raw text (including any comment immediately
 * before the '-') is sliced verbatim from oldText. Newly-added protos
 * (no matching id in old) are serialized fresh. Deleted protos and their
 * associated comments are dropped.
 *
 * Content before the very first '-' (file-level header comments) is
 * always preserved as the file preamble.
 *
 * Falls back to dumpYaml() when range data is missing.
 *
 * `protoAstRefs` is a WeakMap mapping each pre-existing JS proto object in
 * `newYaml` to its corresponding AST item node in `oldDoc.contents.items`.
 * Newly-inserted protos (e.g. via addNewPrototype) are absent from the map
 * and serialized fresh. AST-identity matching is the SINGLE source of truth
 * here — id-based matching was deeply ambiguous (two protos can legally
 * share an id like the default 'NewPrototype' before the user renames them,
 * causing the same body to be emitted twice and producing a duplicate proto
 * in the saved file). Callers must keep `fs.protoAstRefs` in sync with
 * `fs.yaml` ↔ `fs.doc.contents.items` after every parse / commit.
 */
function dumpYamlRespectfulStructural(newYaml, oldText, oldDoc, protoAstRefs) {
    if (!oldDoc || !YAML.isSeq(oldDoc.contents)) return dumpYaml(newYaml);
    const items = oldDoc.contents.items;
    if (!items.length) return dumpYaml(newYaml);

    // Extract (prefix, body, astItem, origIdx) for each old proto.
    const slices = [];
    let pos = 0;
    for (let j = 0; j < items.length; j++) {
        const item = items[j];
        if (!item.range) return dumpYaml(newYaml);
        const nodeStart = item.range[0];
        const nodeEnd   = item.range[2];
        const itemStart = _seqEntryStart(oldText, nodeStart);
        slices.push({
            prefix  : oldText.slice(pos, itemStart),
            body    : oldText.slice(itemStart, nodeEnd),
            astItem : item,
            origIdx : j,
        });
        pos = nodeEnd;
    }
    const trailer = oldText.slice(pos);
    // Content before any proto (file-level header comments, etc.)
    const fileHeader = slices[0].prefix;

    // AST-item -> slice. Consumed entries are removed so even a same-id
    // duplicate inserted by the user can't accidentally reuse another
    // slice's body — only the slice whose AST node the JS proto was
    // originally linked to (via protoAstRefs) can match.
    const byAst = new Map(slices.map(s => [s.astItem, s]));

    const parts = [fileHeader];
    for (let i = 0; i < newYaml.length; i++) {
        const proto = newYaml[i];
        const ast = protoAstRefs ? protoAstRefs.get(proto) : null;
        const old = ast ? byAst.get(ast) : undefined;
        if (old) {
            byAst.delete(ast);
            if (i > 0) {
                // Use the proto's original prefix as separator, UNLESS it
                // was originally the first proto (prefix == fileHeader,
                // already emitted above) - use a plain newline in that case.
                parts.push(old.origIdx === 0 ? '\n' : (old.prefix || '\n'));
            }
            parts.push(old.body);
        } else {
            // New proto (or AST-link missing): serialize fresh with a standard
            // blank-line gap.
            if (i > 0) parts.push('\n');
            parts.push(_dumpSingleProto(proto).trimEnd() + '\n');
        }
    }
    parts.push(trailer || '\n');
    return parts.join('');
}

/**
 * Rebuild `fs.protoAstRefs` from the current `fs.yaml` ↔ `fs.doc` pairing.
 * Must be called after every parse / commit so the mapping reflects the
 * fresh AST nodes that just came out of parseYamlDoc. Pre-existing JS
 * proto objects retain identity across in-place field edits, so the map
 * survives until the user does a structural mutation (which is exactly
 * when dumpYamlRespectfulStructural needs it).
 */
function relinkProtoAst(fs) {
    fs.protoAstRefs = new WeakMap();
    const items = fs.doc?.contents?.items;
    if (!Array.isArray(items) || !Array.isArray(fs.yaml)) return;
    const n = Math.min(items.length, fs.yaml.length);
    for (let i = 0; i < n; i++) {
        const proto = fs.yaml[i];
        if (proto && typeof proto === 'object') fs.protoAstRefs.set(proto, items[i]);
    }
}

// ──────────────────────────────────────────────────────────────────────
//  Comment read / write helpers (eemeli/yaml commentBefore on AST nodes)
// ──────────────────────────────────────────────────────────────────────

/** Returns the commentBefore text for the proto at idx, or null. */
function getProtoCommentBefore(doc, idx) {
    return doc?.contents?.items?.[idx]?.commentBefore ?? null;
}

// yaml-lib stringify emits `commentBefore` / `comment` verbatim after `#`,
// so a missing leading space produces `#text` instead of `# text`. Every
// comment-writer goes through this helper so on-disk output is consistent.
function _normCmt(t) {
    if (t === null || t === undefined || t === '') return undefined;
    return (t.startsWith(' ') || t.startsWith('\t') || t.startsWith('\n')) ? t : ' ' + t;
}

/**
 * Patch the comment before proto idx directly in the raw content string.
 * Returns { newContent, newDoc } or null when range info is absent.
 *
 * dumpYamlRespectful text-slices inter-proto gaps from the original content,
 * so proto-level comments must be edited in the raw text rather than the AST.
 */
function patchProtoCommentInContent(content, doc, idx, newText) {
    const items = doc?.contents?.items;
    if (!items || !items[idx]?.range) return null;
    const [nodeStart] = items[idx].range;
    const itemStart = _seqEntryStart(content, nodeStart);
    const prevEnd = idx > 0 ? (items[idx - 1].range?.[2] ?? 0) : 0;
    const gapText = content.slice(prevEnd, itemStart);
    const blankLines = gapText.match(/^(\n*)/)?.[1] ?? '\n\n';
    const newComment = newText
        ? newText.split('\n').map(l => '# ' + l).join('\n') + '\n'
        : '';
    const newContent = content.slice(0, prevEnd) + blankLines + newComment + content.slice(itemStart);
    const { doc: newDoc } = parseYamlDoc(newContent);
    return { newContent, newDoc };
}

/** Returns the commentBefore text for field key inside proto protoIdx, or null. */
function getFieldCommentBefore(doc, protoIdx, key) {
    const item = doc?.contents?.items?.[protoIdx];
    if (!YAML.isMap(item)) return null;
    const pair = item.items.find(p => YAML.isScalar(p.key) && p.key.value === key);
    return pair?.key?.commentBefore ?? null;
}

/**
 * Set or clear commentBefore for a field key inside proto protoIdx in the AST.
 * The proto must be marked dirty so _dumpSingleProtoFromNode re-serializes it
 * (which preserves inner-pair comments while stripping the top-level commentBefore).
 */
function setFieldCommentBefore(doc, protoIdx, key, newText) {
    const item = doc?.contents?.items?.[protoIdx];
    if (!YAML.isMap(item)) return false;
    const pair = item.items.find(p => YAML.isScalar(p.key) && p.key.value === key);
    if (!pair?.key) return false;
    pair.key.commentBefore = _normCmt(newText);
    return true;
}

/**
 * Returns the inline/trailing comment for a field value, or null.
 * Handles three common shapes:
 *   key: value                 # comment   → pair.value.comment
 *   key:                                  → pair.key.comment
 *     - thing # comment        → pair.value.items[0].comment (single-item Seq)
 */
function getFieldInlineComment(doc, protoIdx, key) {
    const item = doc?.contents?.items?.[protoIdx];
    if (!YAML.isMap(item)) return null;
    const pair = item.items.find(p => YAML.isScalar(p.key) && p.key.value === key);
    if (!pair) return null;
    return _pairInlineComment(pair);
}
function _pairInlineComment(pair) {
    if (YAML.isScalar(pair.value)) return pair.value.comment ?? null;
    if (YAML.isSeq(pair.value) && pair.value.items?.length === 1 && YAML.isScalar(pair.value.items[0])) {
        return pair.value.items[0].comment ?? pair.key?.comment ?? pair.value.commentBefore?.trim() ?? null;
    }
    // Non-scalar value (multi-item Seq, Map). yaml lib doesn't reliably
    // round-trip `pair.key.comment` for block-style sequences, so we also
    // accept `pair.value.commentBefore` (renders as a "# cmt" line after
    // the key and before the value's first item — visually adjacent).
    return pair.value?.commentBefore?.trim() ?? pair.key?.comment ?? null;
}

/**
 * Set or clear the inline/trailing comment for a field value.
 * Returns false if the key is not present in the proto map.
 */
function setFieldInlineComment(doc, protoIdx, key, newText) {
    const item = doc?.contents?.items?.[protoIdx];
    if (!YAML.isMap(item)) return false;
    const pair = item.items.find(p => YAML.isScalar(p.key) && p.key.value === key);
    if (!pair) return false;
    return _setPairInlineComment(pair, newText);
}
function _setPairInlineComment(pair, newText) {
    const norm = _normCmt(newText);
    if (YAML.isScalar(pair.value)) {
        pair.value.comment = norm;
    } else if (YAML.isSeq(pair.value) && pair.value.items?.length === 1 && YAML.isScalar(pair.value.items[0])) {
        pair.value.items[0].comment = norm;
    } else if (pair.value) {
        // Multi-item Seq or Map: use `value.commentBefore` (round-trips
        // reliably). Clear any stale `pair.key.comment` to avoid the
        // comment getting duplicated on re-serialize.
        pair.value.commentBefore = norm;
        if (pair.key) pair.key.comment = undefined;
    } else if (pair.key) {
        pair.key.comment = norm;
    } else {
        return false;
    }
    return true;
}

// ──────────────────────────────────────────────────────────────────────
//  Component-field comments (one extra level of nesting):
//  proto.components is a Seq of Maps, each has a `type` and field pairs.
// ──────────────────────────────────────────────────────────────────────
function _resolveComponentMap(doc, protoIdx, compIdx) {
    const proto = doc?.contents?.items?.[protoIdx];
    if (!YAML.isMap(proto)) return null;
    const compsPair = proto.items.find(p => YAML.isScalar(p.key) && p.key.value === 'components');
    if (!compsPair || !YAML.isSeq(compsPair.value)) return null;
    const comp = compsPair.value.items?.[compIdx];
    return YAML.isMap(comp) ? comp : null;
}
function _findPair(map, key) {
    return map?.items?.find(p => YAML.isScalar(p.key) && p.key.value === key) ?? null;
}
function getComponentFieldInlineComment(doc, protoIdx, compIdx, key) {
    const m = _resolveComponentMap(doc, protoIdx, compIdx);
    if (!m) return null;
    const pair = _findPair(m, key);
    return pair ? _pairInlineComment(pair) : null;
}
function setComponentFieldInlineComment(doc, protoIdx, compIdx, key, newText) {
    const m = _resolveComponentMap(doc, protoIdx, compIdx);
    if (!m) return false;
    const pair = _findPair(m, key);
    return pair ? _setPairInlineComment(pair, newText) : false;
}
function getComponentFieldCommentBefore(doc, protoIdx, compIdx, key) {
    const m = _resolveComponentMap(doc, protoIdx, compIdx);
    if (!m) return null;
    const pair = _findPair(m, key);
    return pair?.key?.commentBefore ?? null;
}
function setComponentFieldCommentBefore(doc, protoIdx, compIdx, key, newText) {
    const m = _resolveComponentMap(doc, protoIdx, compIdx);
    if (!m) return false;
    const pair = _findPair(m, key);
    if (!pair?.key) return false;
    pair.key.commentBefore = _normCmt(newText);
    return true;
}

// ──────────────────────────────────────────────────────────────────────
//  Trailing file-level comment (after the last proto).
//  Patched on raw content for the same reason as patchProtoCommentInContent:
//  dumpYamlRespectful text-slices that region from the original file.
// ──────────────────────────────────────────────────────────────────────
function getTrailingComment(content, doc) {
    const items = doc?.contents?.items ?? [];
    if (!items.length) return null;
    const lastEnd = items[items.length - 1].range?.[2] ?? items[items.length - 1].range?.[1] ?? 0;
    const tail = content.slice(lastEnd);
    const lines = tail.split('\n').map(l => l.trim()).filter(l => l.startsWith('#'));
    if (!lines.length) return null;
    return lines.map(l => l.replace(/^#\s?/, '')).join('\n');
}
function patchTrailingCommentInContent(content, doc, newText) {
    const items = doc?.contents?.items ?? [];
    if (!items.length) return null;
    const lastEnd = items[items.length - 1].range?.[2] ?? items[items.length - 1].range?.[1] ?? 0;
    const before = content.slice(0, lastEnd);
    const tail = content.slice(lastEnd);
    // Strip existing trailing comment block: keep leading whitespace, drop
    // any consecutive comment-only lines, then preserve everything after.
    const lines = tail.split('\n');
    let i = 0;
    // First skip blank lines into a separator we keep.
    while (i < lines.length && lines[i].trim() === '') i++;
    let firstCmt = i;
    while (i < lines.length && lines[i].trim().startsWith('#')) i++;
    // Keep blank lines before the existing comment block (if any).
    const head = lines.slice(0, firstCmt).join('\n');
    const rest = lines.slice(i).join('\n');
    let injected = '';
    if (newText) {
        const sep = head ? '' : '\n';
        injected = sep + newText.split('\n').map(l => '# ' + l).join('\n');
    }
    const newTail = head + injected + (rest ? (newText && !head ? '\n' : '\n') + rest : (newText ? '\n' : ''));
    const newContent = before + newTail;
    const { doc: newDoc } = parseYamlDoc(newContent);
    return { newContent, newDoc };
}