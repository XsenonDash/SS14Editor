/**
 * Ultra-test: builds CEConsumablePotionAcceleration from scratch,
 * step by step, through the same helpers the editor uses when the user
 * interacts with the UI.  Only at the very end are all invariants checked.
 *
 * After the build scenario the file also contains the full regression
 * suite absorbed from yaml-respectful.test.js.
 *
 * Run from repo root:
 *   node tests/yaml/potion-ultra.test.js
 *
 * No npm dependencies.
 */
'use strict';

const assert = require('assert');
const path   = require('path');
const nodeFs = require('fs');
const vm     = require('vm');

// -- Load yaml-lib.js ---------------------------------------------------------
const repoRoot   = path.resolve(__dirname, '../..');
const yamlLibSrc = nodeFs.readFileSync(path.join(repoRoot, 'WebUI/js/yaml-lib.js'), 'utf8');
const libSandbox = { console };
vm.runInNewContext(yamlLibSrc, libSandbox);
const YAML = libSandbox.YAML;
if (!YAML || typeof YAML.parseDocument !== 'function')
    throw new Error('yaml-lib.js did not expose a usable YAML global');

// -- Load yaml.js -------------------------------------------------------------
const yamlJsSrc = nodeFs.readFileSync(path.join(repoRoot, 'WebUI/js/yaml.js'), 'utf8');
const jsSandbox = { YAML, console };
vm.runInNewContext(yamlJsSrc, jsSandbox);
const {
    parseYamlDoc, dumpYamlRespectful, dumpYaml, docSetField, docDeleteField,
    dumpYamlRespectfulStructural, relinkProtoAst,
    getProtoCommentBefore, patchProtoCommentInContent,
    getTrailingComment, patchTrailingCommentInContent,
    getFieldInlineComment, setFieldInlineComment,
    getFieldCommentBefore, setFieldCommentBefore,
    getComponentFieldInlineComment, setComponentFieldInlineComment,
    getComponentFieldCommentBefore, setComponentFieldCommentBefore,
} = jsSandbox;
if (typeof dumpYamlRespectful !== 'function')
    throw new Error('yaml.js did not expose dumpYamlRespectful');

// -- Minimal test runner ------------------------------------------------------
let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  OK  ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}`); console.error(`     ${e.message}`); failed++; }
}
function assertContains(haystack, needle, label) {
    assert(haystack.includes(needle), `Expected output to contain ${label ?? JSON.stringify(needle)}`);
}
function assertNotContains(haystack, needle, label) {
    assert(!haystack.includes(needle), `Expected output NOT to contain ${label ?? JSON.stringify(needle)}`);
}

// ============================================================================
//  EDITOR MODULES — load real implementations from WebUI/js/
//
//  state.js + editor-mutate.js + editor-add.js + editor-components.js are
//  concatenated into one vm run so `const state` from state.js is in scope
//  for all editor functions.  UI side-effects are replaced with no-ops.
// ============================================================================

// Stubs for globals the editor modules reference but never call on test paths.
jsSandbox.document             = { querySelector: () => null };
jsSandbox.Date                 = Date;
jsSandbox.resolveInheritance   = () => null;
jsSandbox.pickComponentType    = () => {};
jsSandbox.smartMatch           = () => true;
jsSandbox.ComponentHandlerRegistry = null;

const _editorSrc = [
    'state.js', 'editor-mutate.js', 'editor-add.js', 'editor-components.js',
].map(f => nodeFs.readFileSync(path.join(repoRoot, 'WebUI/js', f), 'utf8')).join('\n;\n')
  // Override UI side-effects AFTER the module code (overrides the real function declarations).
  + '\n; scheduleAutosave = function(){}; renderTabs = function(){};'
  + ' scheduleRenderEditor = function(){}; renderEditor = function(){};'
  + '\n; var _state = state; var _FileState = FileState;';

vm.runInNewContext(_editorSrc, jsSandbox);

const { commitChange, setFieldValue, deleteField, _addNewProto, _addComponent } = jsSandbox;
const _state     = jsSandbox._state;
const _FileState = jsSandbox._FileState;
if (typeof commitChange !== 'function')
    throw new Error('editor-mutate.js did not expose commitChange');

// ============================================================================
//  EDITOR TEST HELPERS
// ============================================================================

const _TEST_FILE = '__test__';

/** Create a full FileState instance (matches the real class from state.js). */
function createFs() {
    const fs = new _FileState(_TEST_FILE, '');
    // Ensure fields used by commitChange that FileState may leave undefined.
    fs.structuralChange = false;
    fs.protoAstRefs     = null;
    return fs;
}

/** Register fs as the active file so setFieldValue / deleteField can find it. */
function _withFs(fs) {
    _state.currentFile = _TEST_FILE;
    _state.openFiles.set(_TEST_FILE, fs);
}

function addProto(fs, type) {
    _withFs(fs);
    _addNewProto(fs, type);
}

function setField(fs, p, tag, value) {
    _withFs(fs);
    setFieldValue(p, tag, value, _TEST_FILE);
}

function deleteField_(fs, p, tag) {
    _withFs(fs);
    deleteField(p, tag, _TEST_FILE);
}

function addComponent(fs, protoIdx, compType) {
    _addComponent(fs, protoIdx, compType);
}

function markDirtyAndCommit(fs, protoIdx) {
    _withFs(fs);
    fs.dirtyProtos.add(protoIdx);
    commitChange(fs);
}

function applyProtoBefore(fs, protoIdx, text) {
    const result = patchProtoCommentInContent(fs.content, fs.doc, protoIdx, text);
    if (!result) throw new Error('patchProtoCommentInContent returned null for index ' + protoIdx);
    fs.content = result.newContent;
    fs.doc     = result.newDoc;
    relinkProtoAst(fs);
}

function applyTrailing(fs, text) {
    const result = patchTrailingCommentInContent(fs.content, fs.doc, text);
    if (!result) throw new Error('patchTrailingCommentInContent returned null');
    fs.content = result.newContent;
    fs.doc     = result.newDoc;
    relinkProtoAst(fs);
}

// ============================================================================
//  SCENARIO: Build CEConsumablePotionAcceleration from scratch
//
//  The ideal end-state is embedded verbatim below as REFERENCE_YAML.
//  We simulate the exact sequence of editor actions that produce it, then
//  compare the serialized output against the reference byte-for-byte.
// ============================================================================

// The expected serialized output — includes all 6 comment types in
// different positions to verify every comment channel end-to-end.
//
// Comment types present:
//   (A) proto block comment     — patchProtoCommentInContent
//   (B) trailing file comment   — patchTrailingCommentInContent
//   (C) field inline comment    — setFieldInlineComment           (on `id`)
//   (D) field commentBefore     — setFieldCommentBefore           (on `parent`)
//   (E) comp field inline comment on scalar  — setComponentFieldInlineComment (Sprite.drawdepth)
//   (F) comp field commentBefore on seq key  — setComponentFieldCommentBefore (CEConsumable.effects)
//   (G) comp field inline comment on seq → commentBefore on 1st item
//                               — setComponentFieldInlineComment  (CEDestructionEffect.effects)
//   (H) comp field commentBefore on map key  — setComponentFieldCommentBefore (CEWeapon.animations)
const REFERENCE_YAML = `\
# acceleration potion — CE consumable
- type: entity
  id: CEConsumablePotionAcceleration # unique proto ID
  # parents: base shape + star visual
  parent:
  - CEConsumablePotionBase
  - CEPotionStar
  name: acceleration potion
  description: Increases your movement speed for a short duration.
  suffix: Test
  categories:
  - ForkFiltered
  - HideSpawnMenu
  components:
  - type: Sprite
    drawdepth: 10 # above mobs
    layers:
    - state: icon
    - state: fill
      color: "#f2c83f"
  - type: CEConsumable
    # on-drink effects
    effects:
    - !type:ApplyStatusEffectStack
      statusEffect: CEStatusEffectAcceleration
      amount: 6
      max: 10
    - !type:SpawnEntity
      spawns:
      - CEEffectHealingGeneric
  - type: CEDestructionEffect
    effects:
    # on-break effects
    - !type:AreaEffect
      range: 1
      whitelist:
        components:
        - CEMobState
      effects:
      - !type:ApplyStatusEffectStack
        statusEffect: CEStatusEffectAcceleration
        amount: 3
        max: 10
      - !type:SpawnEntity
        spawns:
        - CEEffectHealingGeneric
      - !type:Delete
    - !type:SpawnEntity
      effectTarget: User
      spawns:
      - CEEffectAreaHealingEffect
  - type: CEWeapon
    # melee animations
    animations:
      Primary:
      - anim: Punch1
      Secondary:
      - anim: Punch2
    effectSlots:
      Test1:
      - !type:CleanDebuffs
      Test2:
      - !type:Dash
        effectTarget: User
        distance: 12

# end of acceleration potion
`;

console.log('\n-- Build scenario ---------------------------------------------------');

// Fields are intentionally written OUT of canonical order throughout the build.
// _sortMapFields (applied on every serialization) must reorder them to match
// REFERENCE_YAML.  Only comment-API tests (STEP 09-16) keep detailed
// assertions; structure tests rely solely on the FINAL exact comparison.

test('STEP 01 - addProto("entity")', () => {
    globalThis._potionFs = createFs();
    const fs = globalThis._potionFs;
    addProto(fs, 'entity');
    assert.strictEqual(fs.yaml.length, 1);
});

test('STEP 02 - setField id', () => {
    setField(globalThis._potionFs, [0], 'id', 'CEConsumablePotionAcceleration');
});

test('STEP 03 - setField parent', () => {
    setField(globalThis._potionFs, [0], 'parent', ['CEConsumablePotionBase', 'CEPotionStar']);
});

// Fields written in shuffled order: suffix → categories → name → description
// (reference order: name → description → suffix → categories)
test('STEP 04 - setField top-level scalars (shuffled order)', () => {
    const fs = globalThis._potionFs;
    setField(fs, [0], 'suffix',      'Test');
    setField(fs, [0], 'categories',  ['ForkFiltered', 'HideSpawnMenu']);
    setField(fs, [0], 'name',        'acceleration potion');
    setField(fs, [0], 'description', 'Increases your movement speed for a short duration.');
});

// Sprite: layers before drawdepth (reference: drawdepth first)
test('STEP 05 - Sprite component (shuffled: layers before drawdepth)', () => {
    const fs = globalThis._potionFs;
    addComponent(fs, 0, 'Sprite');
    setField(fs, [0, 'components', 0], 'layers', [
        { state: 'icon' },
        { state: 'fill', color: '#f2c83f' },
    ]);
    setField(fs, [0, 'components', 0], 'drawdepth', 10);
});

// ApplyStatusEffectStack: max → amount → statusEffect (ref: statusEffect → amount → max)
test('STEP 06 - CEConsumable effects (shuffled: max→amount→statusEffect in ASSE)', () => {
    const fs = globalThis._potionFs;
    addComponent(fs, 0, 'CEConsumable');
    setField(fs, [0, 'components', 1], 'effects', [
        { __yamlTag: 'ApplyStatusEffectStack', max: 10, amount: 6, statusEffect: 'CEStatusEffectAcceleration' },
        { __yamlTag: 'SpawnEntity', spawns: ['CEEffectHealingGeneric'] },
    ]);
});

// AreaEffect: effects → whitelist → range (ref: range → whitelist → effects)
// Inner ASSE: max → amount → statusEffect; outer SpawnEntity: spawns → effectTarget
test('STEP 07 - CEDestructionEffect (shuffled: effects→whitelist→range, spawns→effectTarget)', () => {
    const fs = globalThis._potionFs;
    addComponent(fs, 0, 'CEDestructionEffect');
    setField(fs, [0, 'components', 2], 'effects', [
        {
            __yamlTag: 'AreaEffect',
            effects: [
                { __yamlTag: 'ApplyStatusEffectStack', max: 10, amount: 3, statusEffect: 'CEStatusEffectAcceleration' },
                { __yamlTag: 'SpawnEntity', spawns: ['CEEffectHealingGeneric'] },
                { __yamlTag: 'Delete' },
            ],
            whitelist: { components: ['CEMobState'] },
            range: 1,
        },
        { __yamlTag: 'SpawnEntity', spawns: ['CEEffectAreaHealingEffect'], effectTarget: 'User' },
    ]);
});

// Dash: distance → effectTarget (ref: effectTarget → distance)
// effectSlots before animations (ref: animations → effectSlots)
test('STEP 08 - CEWeapon (shuffled: effectSlots→animations, distance→effectTarget in Dash)', () => {
    const fs = globalThis._potionFs;
    addComponent(fs, 0, 'CEWeapon');
    setField(fs, [0, 'components', 3], 'effectSlots', {
        Test1: [{ __yamlTag: 'CleanDebuffs' }],
        Test2: [{ __yamlTag: 'Dash', distance: 12, effectTarget: 'User' }],
    });
    setField(fs, [0, 'components', 3], 'animations', {
        Primary:   [{ anim: 'Punch1' }],
        Secondary: [{ anim: 'Punch2' }],
    });
});

// -- Add all comment types --------------------------------------------------------

test('STEP 09 - proto block comment (type A)', () => {
    const fs = globalThis._potionFs;
    applyProtoBefore(fs, 0, 'acceleration potion — CE consumable');
    assertContains(fs.content, '# acceleration potion — CE consumable');
    const cmtPos   = fs.content.indexOf('# acceleration potion');
    const protoPos = fs.content.indexOf('- type: entity');
    assert.ok(cmtPos < protoPos, 'block comment must precede the proto entry');
    assert.strictEqual(getProtoCommentBefore(fs.doc, 0).trim(), 'acceleration potion — CE consumable');
});

test('STEP 10 - trailing file comment (type B)', () => {
    const fs = globalThis._potionFs;
    applyTrailing(fs, 'end of acceleration potion');
    assertContains(fs.content, '# end of acceleration potion');
    const protoEnd  = fs.content.lastIndexOf('distance: 12');
    const trailPos  = fs.content.lastIndexOf('# end of acceleration potion');
    assert.ok(trailPos > protoEnd, 'trailing comment must follow the proto body');
    assert.strictEqual(getTrailingComment(fs.content, fs.doc), 'end of acceleration potion');
});

test('STEP 11 - field inline comment on `id` (type C)', () => {
    const fs = globalThis._potionFs;
    const ok = setFieldInlineComment(fs.doc, 0, 'id', 'unique proto ID');
    assert.ok(ok, 'setFieldInlineComment must return true for existing key');
    markDirtyAndCommit(fs, 0);
    assertContains(fs.content, 'id: CEConsumablePotionAcceleration # unique proto ID');
    assert.strictEqual(getFieldInlineComment(fs.doc, 0, 'id').trim(), 'unique proto ID');
});

test('STEP 12 - field commentBefore on `parent` (type D)', () => {
    const fs = globalThis._potionFs;
    const ok = setFieldCommentBefore(fs.doc, 0, 'parent', 'parents: base shape + star visual');
    assert.ok(ok, 'setFieldCommentBefore must return true for existing key');
    markDirtyAndCommit(fs, 0);
    assertContains(fs.content, '  # parents: base shape + star visual\n  parent:');
    assert.strictEqual(getFieldCommentBefore(fs.doc, 0, 'parent').trim(), 'parents: base shape + star visual');
});

test('STEP 13 - component field inline comment on scalar (Sprite.drawdepth, type E)', () => {
    const fs = globalThis._potionFs;
    const ok = setComponentFieldInlineComment(fs.doc, 0, 0, 'drawdepth', 'above mobs');
    assert.ok(ok, 'setComponentFieldInlineComment must return true');
    markDirtyAndCommit(fs, 0);
    assertContains(fs.content, 'drawdepth: 10 # above mobs');
    assert.strictEqual(getComponentFieldInlineComment(fs.doc, 0, 0, 'drawdepth').trim(), 'above mobs');
});

test('STEP 14 - component field commentBefore on seq key (CEConsumable.effects, type F)', () => {
    const fs = globalThis._potionFs;
    const ok = setComponentFieldCommentBefore(fs.doc, 0, 1, 'effects', 'on-drink effects');
    assert.ok(ok, 'setComponentFieldCommentBefore must return true');
    markDirtyAndCommit(fs, 0);
    assertContains(fs.content, '    # on-drink effects\n    effects:');
    assert.strictEqual(getComponentFieldCommentBefore(fs.doc, 0, 1, 'effects').trim(), 'on-drink effects');
});

test('STEP 15 - comp field inline comment on seq → commentBefore on 1st item (CEDestructionEffect.effects, type G)', () => {
    const fs = globalThis._potionFs;
    const ok = setComponentFieldInlineComment(fs.doc, 0, 2, 'effects', 'on-break effects');
    assert.ok(ok, 'setComponentFieldInlineComment must return true');
    markDirtyAndCommit(fs, 0);
    // For sequence values the comment lands as commentBefore on the first item
    assertContains(fs.content, '    effects:\n    # on-break effects\n    - !type:AreaEffect');
    assert.strictEqual(getComponentFieldInlineComment(fs.doc, 0, 2, 'effects').trim(), 'on-break effects');
});

test('STEP 16 - component field commentBefore on map key (CEWeapon.animations, type H)', () => {
    const fs = globalThis._potionFs;
    const ok = setComponentFieldCommentBefore(fs.doc, 0, 3, 'animations', 'melee animations');
    assert.ok(ok, 'setComponentFieldCommentBefore must return true');
    markDirtyAndCommit(fs, 0);
    assertContains(fs.content, '    # melee animations\n    animations:');
    assert.strictEqual(getComponentFieldCommentBefore(fs.doc, 0, 3, 'animations').trim(), 'melee animations');
});

// -- Final comparison against reference YAML ----------------------------------

test('FINAL - output matches REFERENCE_YAML exactly', () => {
    assert.strictEqual(
        globalThis._potionFs.content.trim(),
        REFERENCE_YAML.trim(),
        'Serialized output does not match the reference YAML'
    );
});

// ============================================================================
//  REGRESSION SUITE (absorbed from yaml-respectful.test.js)
// ============================================================================
console.log('\n-- Regression suite -------------------------------------------------');

function makeFs(text) {
    const { protos, doc } = parseYamlDoc(text);
    const fso = { yaml: protos, doc, content: text };
    relinkProtoAst(fso);
    return fso;
}

const COMMENTED_YAML = `# outer comment
- type: SomeProto
  id: proto1
  asset_groups:
    group_abc:    # group_abc comment
      - BTC
      - ETH
      - SOL
    # group_xyz outer comment
    group_xyz:
      - DOGE       # asset comment
      - PEPE
    default:
      # default group inner comment
      - 1INCH
      - ATOM
      - BNB
      - LINK
      - XRP
- type: OtherProto
  id: proto2
  value: 1
`;

test('file-level outer comment is preserved', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    assertContains(out, '# outer comment');
});

test('inline mapping-key comment is preserved (group_abc)', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    assertContains(out, 'group_abc:    # group_abc comment');
});

test('between-key comment is preserved (group_xyz outer)', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    assertContains(out, '# group_xyz outer comment');
});

test('inline sequence-value comment is preserved (DOGE)', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    assertContains(out, '- DOGE       # asset comment');
});

test('nested-sequence inner comment is preserved (default group)', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    assertContains(out, '# default group inner comment');
});

test('dirty proto value is updated correctly', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 99;
    docSetField(doc, [1], 'value', 99);
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    assertContains(out, 'value: 99');
    assert(!out.includes('value: 1'), 'old value must not appear');
});

test('output contains no double sequence indicator', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    assert(!out.includes('- - type:'),  'double dash must not appear');
    assert(!out.includes('-- type:'),   'double dash (no space) must not appear');
});

test('output is valid YAML with exactly 2 root prototypes', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 7;
    docSetField(doc, [1], 'value', 7);
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 2);
    assert.strictEqual(reparsed[0].id, 'proto1');
    assert.strictEqual(reparsed[1].id, 'proto2');
    assert.strictEqual(reparsed[1].value, 7);
});

test('zero dirty protos -> output identical to original text', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set());
    assert.strictEqual(out, COMMENTED_YAML);
});

test('falls back to dumpYaml when proto count changes (delete)', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n`;
    const { protos, doc } = parseYamlDoc(text);
    protos.splice(0, 1);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 1);
    assert.strictEqual(reparsed[0].id, 'b');
});

test('clean proto text preserved verbatim (slice check)', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    const p1Start = COMMENTED_YAML.indexOf('- type: SomeProto');
    const p2Start = COMMENTED_YAML.indexOf('- type: OtherProto');
    const proto1Original = COMMENTED_YAML.slice(p1Start, p2Start);
    assertContains(out, proto1Original);
});

test('internal comments in dirty proto preserved after docSetField', () => {
    const text = [
        '- type: Entity', '  id: penguinA', '  components:',
        '  - type: MeleeWeapon', '    # too angry to juke', '    damage: 5',
        '    # no service', '    range: 10',
        '- type: Entity', '  id: penguinB', '  components: []', '',
    ].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    protos[0].components[0].damage = 9;
    docSetField(doc, [0, 'components', 0], 'damage', 9);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# too angry to juke');
    assertContains(out, '# no service');
    assertContains(out, 'damage: 9');
    assertContains(out, 'range: 10');
    assertContains(out, 'id: penguinB');
});

test('internal comments in dirty proto preserved after docDeleteField', () => {
    const text = [
        '- type: Entity', '  id: deleteTest',
        '  # comment before desc', '  desc: hello',
        '  # comment before value', '  value: 42', '',
    ].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    delete protos[0].desc;
    docDeleteField(doc, [0], 'desc');
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertNotContains(out, 'desc:');
    assertContains(out, '# comment before value');
    assertContains(out, 'value: 42');
});

test('deeply nested field change preserves inter-item comments (grenadepenguin)', () => {
    const text = [
        '- type: htnCompound', '  id: GrenadePenguinMeleeCombatCompound',
        '  branches:', '  - tasks:',
        '    - !type:HTNPrimitiveTask', '      operator: !type:MoveToOperator',
        '        removeKeyOnFinish: false', '        rangeKey: MeleeRange',
        '    # too angry to juke', '    - !type:HTNPrimitiveTask',
        '      operator: !type:MeleeOperator', '        targetKey: Target', '',
    ].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    const nb = JSON.parse(JSON.stringify(protos[0].branches));
    nb[0].tasks[0].operator.removeKeyOnFinish = true;
    protos[0].branches = nb;
    docSetField(doc, [0], 'branches', nb);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# too angry to juke');
    assertContains(out, 'removeKeyOnFinish: true');
    assertContains(out, '!type:HTNPrimitiveTask');
    assertContains(out, '!type:MoveToOperator');
    assertNotContains(out, '!<HTNPrimitiveTask>');
    assertNotContains(out, '!<MoveToOperator>');
});

test('!type: tags preserved verbatim after docSetField on scalar sibling', () => {
    const text = [
        '- type: htnCompound', '  id: tagTest', '  branches:', '  - tasks:',
        '    - !type:HTNPrimitiveTask', '      operator: !type:MoveToOperator',
        '        speed: 1.5', '        removeKeyOnFinish: false', '',
    ].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    const nb = JSON.parse(JSON.stringify(protos[0].branches));
    nb[0].tasks[0].operator.removeKeyOnFinish = true;
    protos[0].branches = nb;
    docSetField(doc, [0], 'branches', nb);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, 'removeKeyOnFinish: true');
    assertContains(out, '!type:HTNPrimitiveTask');
    assertNotContains(out, '!<HTNPrimitiveTask>');
});

test('sequence items sit at same indent as parent key (indentSeq: false)', () => {
    const text = [
        '- type: Entity', '  id: indentTest', '  components:',
        '  - type: MeleeWeapon', '    damage: 5', '',
    ].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    protos[0].components[0].damage = 10;
    docSetField(doc, [0, 'components', 0], 'damage', 10);
    const respectful = dumpYamlRespectful(protos, doc, text, new Set([0]));
    const full = dumpYaml(protos);
    assertContains(respectful, '\n  - type: MeleeWeapon');
    assertNotContains(respectful, '\n    - type: MeleeWeapon');
    assertContains(full, '\n  - type: MeleeWeapon');
    assertNotContains(full, '\n    - type: MeleeWeapon');
});

// -- relinkProtoAst -----------------------------------------------------------

test('relinkProtoAst maps each JS proto to its AST item node', () => {
    const fso = makeFs(`- type: A\n  id: a\n- type: B\n  id: b\n`);
    assert.strictEqual(fso.protoAstRefs.get(fso.yaml[0]), fso.doc.contents.items[0]);
    assert.strictEqual(fso.protoAstRefs.get(fso.yaml[1]), fso.doc.contents.items[1]);
});

test('relinkProtoAst tolerates length mismatch (uses min)', () => {
    const fso = makeFs(`- type: A\n  id: a\n`);
    fso.yaml.push({ type: 'B', id: 'b' });
    relinkProtoAst(fso);
    assert.strictEqual(fso.protoAstRefs.get(fso.yaml[0]), fso.doc.contents.items[0]);
    assert.strictEqual(fso.protoAstRefs.get(fso.yaml[1]), undefined);
});

// -- dumpYamlRespectfulStructural ---------------------------------------------

test('structural dump preserves clean bodies when adding a new proto at end', () => {
    const text = `# header\n- type: A\n  id: a\n  v: 1\n- type: B\n  id: b\n  v: 2\n`;
    const fso = makeFs(text);
    fso.yaml.push({ type: 'C', id: 'c', v: 3 });
    const out = dumpYamlRespectfulStructural(fso.yaml, text, fso.doc, fso.protoAstRefs);
    assertContains(out, '# header');
    assertContains(out, '- type: A\n  id: a\n  v: 1');
    assertContains(out, '- type: B\n  id: b\n  v: 2');
    assertContains(out, 'id: c');
});

test('structural dump preserves clean bodies when adding a new proto at start', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n`;
    const fso = makeFs(text);
    fso.yaml.unshift({ type: 'Z', id: 'z' });
    const out = dumpYamlRespectfulStructural(fso.yaml, text, fso.doc, fso.protoAstRefs);
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 3);
    assert.strictEqual(reparsed[0].id, 'z');
    assert.strictEqual(reparsed[1].id, 'a');
    assert.strictEqual(reparsed[2].id, 'b');
});

test('structural dump preserves clean bodies when removing a proto', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n- type: C\n  id: c\n`;
    const fso = makeFs(text);
    fso.yaml.splice(1, 1);
    const out = dumpYamlRespectfulStructural(fso.yaml, text, fso.doc, fso.protoAstRefs);
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 2);
    assert.strictEqual(reparsed[0].id, 'a');
    assert.strictEqual(reparsed[1].id, 'c');
    assertNotContains(out, 'id: b');
});

test('structural dump preserves comments between protos (clean blocks)', () => {
    const text = `- type: A\n  id: a\n# block comment\n- type: B\n  id: b\n`;
    const fso = makeFs(text);
    fso.yaml.push({ type: 'C', id: 'c' });
    const out = dumpYamlRespectfulStructural(fso.yaml, text, fso.doc, fso.protoAstRefs);
    assertContains(out, '# block comment');
    assertContains(out, 'id: c');
});

test('structural dump: duplicate ids never produce duplicate bodies', () => {
    const text = `- type: T\n  id: NewPrototype\n  v: 1\n- type: T\n  id: other\n  v: 2\n`;
    const fso = makeFs(text);
    fso.yaml.unshift({ type: 'T', id: 'NewPrototype', v: 99 });
    const out = dumpYamlRespectfulStructural(fso.yaml, text, fso.doc, fso.protoAstRefs);
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 3);
    assert.strictEqual(reparsed[0].v, 99);
    assert.strictEqual(reparsed[1].v, 1);
    assert.strictEqual(reparsed[2].v, 2);
});

test('structural dump: new proto without AST link is serialized fresh', () => {
    const text = `- type: A\n  id: a\n`;
    const fso = makeFs(text);
    fso.yaml.push({ type: 'B', id: 'b', v: 7 });
    const out = dumpYamlRespectfulStructural(fso.yaml, text, fso.doc, fso.protoAstRefs);
    assertContains(out, 'id: b');
    assertContains(out, 'v: 7');
});

// -- Inter-proto comment patch ------------------------------------------------

test('patchProtoCommentInContent adds a fresh comment before a proto', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n`;
    const { doc } = parseYamlDoc(text);
    const result = patchProtoCommentInContent(text, doc, 1, 'hello world');
    assert.ok(result);
    assertContains(result.newContent, '# hello world');
    assertContains(result.newContent, '- type: B');
    const got = getProtoCommentBefore(result.newDoc, 1);
    assert.ok(got && got.includes('hello world'), `got=${JSON.stringify(got)}`);
});

test('patchProtoCommentInContent replaces an existing comment', () => {
    const text = `- type: A\n  id: a\n# old\n- type: B\n  id: b\n`;
    const { doc } = parseYamlDoc(text);
    const result = patchProtoCommentInContent(text, doc, 1, 'new');
    assertContains(result.newContent, '# new');
    assertNotContains(result.newContent, '# old');
});

test('patchProtoCommentInContent clears an existing comment when newText is null', () => {
    const text = `- type: A\n  id: a\n# bye\n- type: B\n  id: b\n`;
    const { doc } = parseYamlDoc(text);
    const result = patchProtoCommentInContent(text, doc, 1, null);
    assertNotContains(result.newContent, '# bye');
    assertContains(result.newContent, '- type: B');
});

test('patchProtoCommentInContent supports multi-line comments', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n`;
    const { doc } = parseYamlDoc(text);
    const result = patchProtoCommentInContent(text, doc, 1, 'line one\nline two');
    assertContains(result.newContent, '# line one');
    assertContains(result.newContent, '# line two');
});

// -- Trailing-file comment ----------------------------------------------------

test('getTrailingComment reads an existing trailing block', () => {
    const text = `- type: A\n  id: a\n\n# bye\n# bye2\n`;
    const { doc } = parseYamlDoc(text);
    assert.strictEqual(getTrailingComment(text, doc), 'bye\nbye2');
});

test('getTrailingComment returns null when nothing follows the last proto', () => {
    const text = `- type: A\n  id: a\n`;
    const { doc } = parseYamlDoc(text);
    assert.strictEqual(getTrailingComment(text, doc), null);
});

test('patchTrailingCommentInContent adds, replaces, and clears the trailing comment', () => {
    const text = `- type: A\n  id: a\n`;
    const { doc } = parseYamlDoc(text);
    const added    = patchTrailingCommentInContent(text,                doc,          'farewell');
    const replaced = patchTrailingCommentInContent(added.newContent,    added.newDoc,    'see ya');
    const cleared  = patchTrailingCommentInContent(replaced.newContent, replaced.newDoc, null);
    assertContains(added.newContent, '# farewell');
    assertContains(replaced.newContent, '# see ya');
    assertNotContains(replaced.newContent, '# farewell');
    assertNotContains(cleared.newContent, '# see ya');
    assertContains(cleared.newContent, 'id: a');
});

// -- Proto-field inline comments ----------------------------------------------

test('field inline comment round-trips on a scalar value', () => {
    const text = `- type: A\n  id: a\n  v: 1\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'v', 'hello'), true);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, 'v: 1 # hello');
    assert.strictEqual(getFieldInlineComment(parseYamlDoc(out).doc, 0, 'v'), ' hello');
});

test('field inline comment round-trips on a single-item seq', () => {
    const text = `- type: A\n  id: a\n  tags:\n  - solo\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'tags', 'note'), true);
    assertContains(dumpYamlRespectful(protos, doc, text, new Set([0])), '# note');
});

test('field inline comment on multi-item Seq uses value.commentBefore slot', () => {
    const text = `- type: A\n  id: a\n  tags:\n  - x\n  - y\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'tags', 'list cmt'), true);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# list cmt');
    assertContains(out, '- x');
});

test('field inline comment on Map value uses value.commentBefore slot', () => {
    const text = `- type: A\n  id: a\n  attrs:\n    k: v\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'attrs', 'map cmt'), true);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# map cmt');
    assertContains(out, 'k: v');
});

test('setFieldInlineComment(null) clears a previously-set inline comment', () => {
    const text = `- type: A\n  id: a\n  v: 1 # bye\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'v', null), true);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertNotContains(out, '# bye');
    assertContains(out, 'v: 1');
});

test('setFieldInlineComment returns false for an unknown key', () => {
    const { doc } = parseYamlDoc(`- type: A\n  id: a\n`);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'nope', 'x'), false);
});

// -- Proto-field commentBefore ------------------------------------------------

test('setFieldCommentBefore writes and getFieldCommentBefore reads', () => {
    const text = `- type: A\n  id: a\n  v: 1\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldCommentBefore(doc, 0, 'v', 'above'), true);
    const got = getFieldCommentBefore(doc, 0, 'v');
    assert.ok(got && got.includes('above'), `got=${JSON.stringify(got)}`);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# above');
    assertContains(out, 'v: 1');
});

test('setFieldCommentBefore(null) clears a commentBefore', () => {
    const text = `- type: A\n  id: a\n  # before\n  v: 1\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldCommentBefore(doc, 0, 'v', null), true);
    assertNotContains(dumpYamlRespectful(protos, doc, text, new Set([0])), '# before');
});

// -- Component-field comments -------------------------------------------------

test('component-field inline comment round-trips', () => {
    const text = ['- type: Entity', '  id: e', '  components:',
        '  - type: MeleeWeapon', '    damage: 5', ''].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setComponentFieldInlineComment(doc, 0, 0, 'damage', 'big hits'), true);
    assertContains(dumpYamlRespectful(protos, doc, text, new Set([0])), 'damage: 5 # big hits');
});

test('component-field commentBefore round-trips', () => {
    const text = ['- type: Entity', '  id: e', '  components:',
        '  - type: MeleeWeapon', '    damage: 5', ''].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setComponentFieldCommentBefore(doc, 0, 0, 'damage', 'comment above'), true);
    const got = getComponentFieldCommentBefore(doc, 0, 0, 'damage');
    assert.ok(got && got.includes('comment above'), `got=${JSON.stringify(got)}`);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# comment above');
    assertContains(out, 'damage: 5');
});

test('component-field setters return false when field is missing', () => {
    const { doc } = parseYamlDoc(`- type: Entity\n  id: e\n  components:\n  - type: X\n`);
    assert.strictEqual(setComponentFieldInlineComment(doc, 0, 0, 'nope', 'x'), false);
    assert.strictEqual(setComponentFieldCommentBefore(doc, 0, 0, 'nope', 'x'), false);
});

// -- Comments survive structural changes --------------------------------------

test('comments on clean proto survive while dirty sibling is rewritten', () => {
    const text = [
        '# file header', '- type: A', '  id: a', '  # before v',
        '  v: 1     # inline v', '# between A and B', '- type: B', '  id: b', '  v: 2', '',
    ].join('\n');
    const fso = makeFs(text);
    fso.yaml[1].v = 22;
    docSetField(fso.doc, [1], 'v', 22);
    const out = dumpYamlRespectful(fso.yaml, fso.doc, text, new Set([1]));
    assertContains(out, '# file header');
    assertContains(out, '# before v');
    assertContains(out, '# inline v');
    assertContains(out, '# between A and B');
    assertContains(out, 'v: 22');
});

test('add-proto followed by structural dump keeps existing inline comments', () => {
    const text = `- type: A\n  id: a\n  v: 1 # keep me\n- type: B\n  id: b\n`;
    const fso = makeFs(text);
    fso.yaml.splice(1, 0, { type: 'New', id: 'middle' });
    const out = dumpYamlRespectfulStructural(fso.yaml, text, fso.doc, fso.protoAstRefs);
    assertContains(out, '# keep me');
    assertContains(out, 'id: middle');
    assert.strictEqual(parseYamlDoc(out).protos.length, 3);
});

test('comment on a !type:Foo seq-item line parses onto item.commentBefore', () => {
    const text = '- type: A\n  id: a\n  behaviors:\n  - !type:Foo # tag cmt\n    field: 1\n';
    const { doc } = parseYamlDoc(text);
    const beh = doc.contents.items[0].items.find(p => p.key.value === 'behaviors').value;
    const item = beh.items[0];
    assert.ok(YAML.isMap(item) && item.tag === '!type:Foo', 'expected tagged Map');
    assert.strictEqual((item.commentBefore || '').trim(), 'tag cmt');
    assert.ok(!item.items[0].value.comment,
        `inner scalar should not carry the tag-line cmt; got ${JSON.stringify(item.items[0].value.comment)}`);
});

test('!type:Foo tagged value on a dict pair parses onto value.commentBefore', () => {
    const text = '- type: A\n  id: a\n  shape: !type:PhysShapeCircle # circle cmt\n    radius: 0.5\n';
    const { doc } = parseYamlDoc(text);
    const pair = doc.contents.items[0].items.find(p => p.key.value === 'shape');
    assert.ok(YAML.isMap(pair.value) && pair.value.tag === '!type:PhysShapeCircle');
    assert.strictEqual((pair.value.commentBefore || '').trim(), 'circle cmt');
    assert.strictEqual(getFieldInlineComment(doc, 0, 'shape'), 'circle cmt');
});

// -- Parent quoting edge cases ------------------------------------------------

test('quoted parent in source is unquoted when proto is dirty', () => {
    const text = `- type: entity\n  id: X\n  parent:\n  - "A"\n  - B\n  v: 1\n`;
    const { protos, doc } = parseYamlDoc(text);
    protos[0].v = 2;
    docSetField(doc, [0], 'v', 2);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertNotContains(out, '"A"', 'quoted parent must be unquoted after dirty');
    assertContains(out, '- A');
    assertContains(out, '- B');
});

test('single quoted scalar parent is unquoted after mutation', () => {
    const text = `- type: entity\n  id: X\n  parent: "BaseMob"\n  v: 1\n`;
    const { protos, doc } = parseYamlDoc(text);
    protos[0].v = 2;
    docSetField(doc, [0], 'v', 2);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertNotContains(out, '"BaseMob"');
    assertContains(out, 'parent: BaseMob');
});

test('hex color value remains quoted after parent edit', () => {
    const text = `- type: entity\n  id: X\n  parent:\n  - A\n  layers:\n  - color: "#abc"\n`;
    const { protos, doc } = parseYamlDoc(text);
    protos[0].parent = ['A', 'B'];
    docSetField(doc, [0], 'parent', ['A', 'B']);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '"#abc"', 'hex color must remain quoted');
    assertNotContains(out, '"A"');
    assertNotContains(out, '"B"');
});

// ============================================================================
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
