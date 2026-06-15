/**
 * Regression guards for the serializer bugs reported June 2026:
 *   1. Editing one field rewrote/reordered the whole prototype (lost "respect").
 *   2. Adding a polymorphic item dropped its `!type:` tag (acceleration.yml).
 *   3. Integer-keyed maps duplicated keys and quoted them (fire_wave.yml).
 *
 * These drive the real serializer (yaml.js) the same way the editor does:
 * parse → docSetField → dumpYamlRespectful, and assert MINIMAL diffs — the
 * property that actually defines respectful editing. Unlike yaml-respectful's
 * comment-substring checks, these assert the dirty proto changed minimally,
 * and run with a populated `state.metadata` so the field-sorting path is live.
 *
 * Run from repo root:  node tests/yaml/regression-respectful.test.js
 * No npm deps: uses yaml-lib.js (committed IIFE bundle) + Node builtins.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const vm     = require('vm');

// ── Load yaml-lib.js (IIFE bundle → sandbox.YAML) ────────────────────────────
const repoRoot   = path.resolve(__dirname, '../..');
const yamlLibSrc = fs.readFileSync(path.join(repoRoot, 'WebUI/js/yaml-lib.js'), 'utf8');
const libSandbox = { console };
vm.runInNewContext(yamlLibSrc, libSandbox);
const YAML = libSandbox.YAML;

// ── Load yaml.js. A mutable `state` is provided so we can toggle metadata
//    (field ordering) on/off and verify respectful editing both ways. ─────────
const yamlJsSrc = fs.readFileSync(path.join(repoRoot, 'WebUI/js/yaml.js'), 'utf8');
const jsSandbox = { YAML, console, state: { metadata: null } };
vm.runInNewContext(yamlJsSrc, jsSandbox);
const { parseYamlDoc, dumpYamlRespectful, docSetField } = jsSandbox;

// ── Minimal test runner ──────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✓  ${name}`); passed++; }
    catch (e) { console.error(`  ✗  ${name}\n     ${e.message}`); failed++; }
}
/** Lines changed between two texts (added+removed, order-insensitive count). */
function changedLines(a, b) {
    const la = a.split('\n'), lb = b.split('\n');
    const setA = new Map(), setB = new Map();
    for (const l of la) setA.set(l, (setA.get(l) || 0) + 1);
    for (const l of lb) setB.set(l, (setB.get(l) || 0) + 1);
    let diff = 0;
    for (const [l, n] of setA) diff += Math.max(0, n - (setB.get(l) || 0));
    for (const [l, n] of setB) diff += Math.max(0, n - (setA.get(l) || 0));
    return diff;
}

// =============================================================================
//  Fix 1 — Respectful editing: one field edit ⇒ minimal diff (no reordering)
// =============================================================================
const MULTI_FIELD = `- type: entity
  id: CEThing
  parent: "BaseThing"
  name: a thing
  description: does stuff
  components:
  - type: Sprite
    sprite: foo.rsi
    color: "#ffffff"
`;

function editScalar(text, protoIdx, tag, value, metadata) {
    jsSandbox.state.metadata = metadata ?? null;
    const { protos, doc } = parseYamlDoc(text);
    let obj = protos[protoIdx];
    obj[tag] = value;
    docSetField(doc, [protoIdx], tag, value);
    return dumpYamlRespectful(protos, doc, text, new Set([protoIdx]));
}

test('single field edit changes exactly one line (no metadata)', () => {
    const out = editScalar(MULTI_FIELD, 0, 'name', 'a renamed thing');
    assert.strictEqual(changedLines(MULTI_FIELD, out), 2, // one line removed + one added
        `expected only the name line to change, got:\n${out}`);
    assert(out.includes('parent: "BaseThing"'), 'unrelated quoted field must be preserved');
});

test('single field edit does NOT reorder fields even with metadata loaded', () => {
    // Metadata deliberately lists fields in a DIFFERENT order than the file,
    // to prove the editor does not reorder existing fields on edit.
    const metadata = { prototypes: { entity: { fields: [
        { tag: 'name' }, { tag: 'description' }, { tag: 'parent' }, { tag: 'components' },
    ] } }, components: {} };
    const out = editScalar(MULTI_FIELD, 0, 'description', 'does other stuff', metadata);
    const idxParent = out.indexOf('parent:');
    const idxName   = out.indexOf('name:');
    assert(idxParent < idxName, `fields were reordered:\n${out}`);
    assert(out.includes('parent: "BaseThing"'), 'quotes on untouched field preserved');
});

// =============================================================================
//  Fix 3 — Integer-keyed maps: no duplication, no quoting (all keys, not 0)
// =============================================================================
const INT_MAP = `- type: entityEffectAnimation
  id: AnimThing
  events:
    0:
    - !type:ShootProjectile
      projectileSpeed: 3
`;

test('adding integer map keys: no duplication, all keys unquoted', () => {
    jsSandbox.state.metadata = null;
    const { protos, doc } = parseYamlDoc(INT_MAP);
    // Simulate the editor adding events keyed "1" and "2" (JS object keys are strings).
    protos[0].events['1'] = [{ __yamlTag: 'AddZVelocity', speed: 12 }];
    protos[0].events['2'] = [{ __yamlTag: 'RestoreStamina', amount: 5 }];
    docSetField(doc, [0], 'events', protos[0].events);
    const out = dumpYamlRespectful(protos, doc, INT_MAP, new Set([0]));

    // No quoted integer keys anywhere.
    assert(!/"\d+":/.test(out), `quoted integer key found:\n${out}`);
    // Each key present exactly once.
    for (const k of ['0', '1', '2']) {
        const occ = (out.match(new RegExp(`^    ${k}:`, 'gm')) || []).length;
        assert.strictEqual(occ, 1, `key ${k} should appear once, found ${occ}:\n${out}`);
    }
    // Re-parses to the right shape.
    const re = parseYamlDoc(out).protos[0].events;
    assert.deepStrictEqual(Object.keys(re).sort(), ['0', '1', '2']);
});

test('editing value under an existing integer key keeps key unquoted & unique', () => {
    jsSandbox.state.metadata = null;
    const { protos, doc } = parseYamlDoc(INT_MAP);
    protos[0].events['0'][0].projectileSpeed = 9;
    docSetField(doc, [0], 'events', protos[0].events);
    const out = dumpYamlRespectful(protos, doc, INT_MAP, new Set([0]));
    assert(!out.includes('"0":'), `key 0 was quoted:\n${out}`);
    assert.strictEqual((out.match(/^    0:/gm) || []).length, 1, `key 0 duplicated:\n${out}`);
    assert(out.includes('projectileSpeed: 9'), 'value updated');
});

// =============================================================================
//  Fix 2 — !type: tag preserved when adding a non-shorthand polymorphic item
//          (serializer side: a {__yamlTag} object must emit its tag)
// =============================================================================
const COND_GROUP = `- type: entity
  id: CEPotion
  components:
  - type: CEDestructionEffect
    effects:
    - !type:ConditionalEffectGroup
      effectTarget: Target
      conditions: []
`;

test('adding a tagged condition emits !type: in output', () => {
    jsSandbox.state.metadata = null;
    const { protos, doc } = parseYamlDoc(COND_GROUP);
    const effects = protos[0].components[0].effects;
    effects[0].conditions = [{ __yamlTag: 'HasStatusEffectCondition', statusEffect: 'CollideFloorTrap' }];
    docSetField(doc, [0], 'components', protos[0].components);
    const out = dumpYamlRespectful(protos, doc, COND_GROUP, new Set([0]));
    assert(out.includes('!type:HasStatusEffectCondition'),
        `!type: tag missing from output:\n${out}`);
});

// =============================================================================
//  Fix 2 (UI gate) — only EntSelector may be written tag-less; every other
//  polymorphic type must keep its !type:. Tests the extracted _canUseShorthand
//  helper from field-controls-collections.js directly.
// =============================================================================
(() => {
    const collSrc = fs.readFileSync(path.join(repoRoot, 'WebUI/js/field-controls-collections.js'), 'utf8');
    const sb = { state: { metadata: null }, console, document: {}, window: {} };
    vm.runInNewContext(collSrc, sb);
    const { _canUseShorthand } = sb;

    // EntSelector: in the allowlist AND uniquely identified by its required `id`.
    sb.state.metadata = {
        dataDefinitions: {
            'Content.Shared.EntityTable.EntitySelectors.EntSelector':
                { fields: [{ tag: 'id', required: true }] },
            'Content.Shared._CE.EntityEffect.Conditions.HasStatusEffectCondition':
                { fields: [{ tag: 'statusEffect', required: true }] },
        },
        polymorphicTypes: {
            'Content.Shared.EntityTable.EntitySelectors.EntityTableSelector':
                ['Content.Shared.EntityTable.EntitySelectors.EntSelector'],
            'Content.Shared._CE.EntityEffect.CEEntityCondition':
                ['Content.Shared._CE.EntityEffect.Conditions.HasStatusEffectCondition'],
        },
    };

    test('EntSelector is allowed as tag-less shorthand', () => {
        assert.strictEqual(_canUseShorthand(
            'Content.Shared.EntityTable.EntitySelectors.EntityTableSelector',
            'Content.Shared.EntityTable.EntitySelectors.EntSelector'), true);
    });
    test('a condition is NEVER tag-less even when uniquely identifiable', () => {
        assert.strictEqual(_canUseShorthand(
            'Content.Shared._CE.EntityEffect.CEEntityCondition',
            'Content.Shared._CE.EntityEffect.Conditions.HasStatusEffectCondition'), false);
    });
})();

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nregression-respectful: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
