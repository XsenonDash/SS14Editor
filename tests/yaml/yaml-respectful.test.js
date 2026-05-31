/**
 * Tests for dumpYamlRespectful — verifies that all comment styles survive
 * a respectful save when the proto that contains them is not dirty.
 *
 * Run from repo root:
 *   node tests/yaml/yaml-respectful.test.js
 *
 * No npm dependencies: uses yaml-lib.js (committed IIFE bundle) + Node builtins.
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
if (!YAML || typeof YAML.parseDocument !== 'function') {
    throw new Error('yaml-lib.js did not expose a usable YAML global');
}

// ── Load yaml.js in a sandbox that has YAML available ────────────────────────
// `state` is intentionally absent → _canonicalizeProto skips field ordering.
const yamlJsSrc = fs.readFileSync(path.join(repoRoot, 'WebUI/js/yaml.js'), 'utf8');
const jsSandbox = { YAML, console };
vm.runInNewContext(yamlJsSrc, jsSandbox);
const { parseYamlDoc, dumpYamlRespectful, dumpYaml, docSetField, docDeleteField,
    dumpYamlRespectfulStructural, relinkProtoAst,
    getProtoCommentBefore, patchProtoCommentInContent,
    getTrailingComment, patchTrailingCommentInContent,
    getFieldInlineComment, setFieldInlineComment,
    getFieldCommentBefore, setFieldCommentBefore,
    getComponentFieldInlineComment, setComponentFieldInlineComment,
    getComponentFieldCommentBefore, setComponentFieldCommentBefore } = jsSandbox;
if (typeof dumpYamlRespectful !== 'function') {
    throw new Error('yaml.js did not expose dumpYamlRespectful');
}

// ── Minimal test runner ───────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✓  ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗  ${name}`);
        console.error(`     ${e.message}`);
        failed++;
    }
}
function assertContains(haystack, needle, label) {
    assert(haystack.includes(needle), `Expected output to contain ${label ?? JSON.stringify(needle)}`);
}
function assertNotContains(haystack, needle, label) {
    assert(!haystack.includes(needle), `Expected output NOT to contain ${label ?? JSON.stringify(needle)}`);
}

// ── All comment styles from the task specification ───────────────────────────
//
//   # outer comment                         ← file-level (before first item)
//   group_abc:    # group_abc comment        ← inline after mapping key
//   # group_xyz outer comment               ← between mapping keys
//   - DOGE       # asset comment            ← inline after sequence value
//   # default group inner comment           ← inside nested sequence
//
// The commented proto (proto1) must come out byte-for-byte identical in the
// output because only proto2 is marked dirty.
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

// ── Tests ─────────────────────────────────────────────────────────────────────

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

test('output contains no double sequence indicator (-- type:)', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    assert(!out.includes('- - type:'), 'double dash must not appear');
    assert(!out.includes('-- type:'),  'double dash (no space) must not appear');
});

test('output is valid YAML with exactly 2 root prototypes', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 7;
    docSetField(doc, [1], 'value', 7);
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 2, 'must still have 2 root entries');
    assert.strictEqual(reparsed[0].id, 'proto1');
    assert.strictEqual(reparsed[1].id, 'proto2');
    assert.strictEqual(reparsed[1].value, 7);
});

test('zero dirty protos → output identical to original text', () => {
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set());
    assert.strictEqual(out, COMMENTED_YAML);
});

test('falls back to dumpYaml when proto count changes (delete)', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n`;
    const { protos, doc } = parseYamlDoc(text);
    protos.splice(0, 1);           // remove proto A → count mismatch
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 1, 'fallback: should have 1 proto');
    assert.strictEqual(reparsed[0].id, 'b');
});

test('clean proto text preserved verbatim (byte-for-byte slice check)', () => {
    // The clean proto's slice in the output must equal the original slice.
    const { protos, doc } = parseYamlDoc(COMMENTED_YAML);
    protos[1].value = 2;
    const out = dumpYamlRespectful(protos, doc, COMMENTED_YAML, new Set([1]));

    // Find the section of the original that belongs to proto1 (from '- type: SomeProto' onwards)
    const p1Start = COMMENTED_YAML.indexOf('- type: SomeProto');
    const p2Start = COMMENTED_YAML.indexOf('- type: OtherProto');
    const proto1Original = COMMENTED_YAML.slice(p1Start, p2Start);

    assertContains(out, proto1Original, 'verbatim proto1 slice');
});

test('internal comments in dirty proto are preserved after docSetField', () => {
    const text = [
        '- type: Entity',
        '  id: penguinA',
        '  components:',
        '  - type: MeleeWeapon',
        '    # too angry to juke',
        '    damage: 5',
        '    # no service',
        '    range: 10',
        '- type: Entity',
        '  id: penguinB',
        '  components: []',
        '',
    ].join('\n');

    const { protos, doc } = parseYamlDoc(text);

    // Mutate the first proto: change 'damage' via docSetField to keep AST in sync.
    protos[0].components[0].damage = 9;
    docSetField(doc, [0, 'components', 0], 'damage', 9);

    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));

    assertContains(out, '# too angry to juke', 'internal comment before damage');
    assertContains(out, '# no service',         'internal comment before range');
    assertContains(out, 'damage: 9',             'mutated damage value');
    assertContains(out, 'range: 10',             'unchanged range value');
    assertContains(out, 'id: penguinB',          'second proto still present');
});

test('internal comments in dirty proto are preserved after docDeleteField', () => {
    const text = [
        '- type: Entity',
        '  id: deleteTest',
        '  # comment before desc',
        '  desc: hello',
        '  # comment before value',
        '  value: 42',
        '',
    ].join('\n');

    const { protos, doc } = parseYamlDoc(text);

    delete protos[0].desc;
    docDeleteField(doc, [0], 'desc');

    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));

    assertNotContains(out, 'desc:',                'deleted field absent');
    assertContains(out, '# comment before value', 'internal comment before value');
    assertContains(out, 'value: 42',               'remaining field present');
});

test('deeply nested field change preserves inter-item comments (grenadepenguin scenario)', () => {
    // Mirrors the real grenadepenguin.yml structure:
    // branches[0].tasks[0].operator.removeKeyOnFinish is changed,
    // but # too angry to juke (commentBefore on tasks[1]) must survive.
    const text = [
        '- type: htnCompound',
        '  id: GrenadePenguinMeleeCombatCompound',
        '  branches:',
        '  - tasks:',
        '    - !type:HTNPrimitiveTask',
        '      operator: !type:MoveToOperator',
        '        removeKeyOnFinish: false',
        '        rangeKey: MeleeRange',
        '    # too angry to juke',
        '    - !type:HTNPrimitiveTask',
        '      operator: !type:MeleeOperator',
        '        targetKey: Target',
        '',
    ].join('\n');

    const { protos, doc } = parseYamlDoc(text);

    // Simulate what the editor does: mutate the JS value and call setFieldValue.
    // The entire branches value is replaced (deep-clone with one scalar changed).
    const newBranches = JSON.parse(JSON.stringify(protos[0].branches));
    newBranches[0].tasks[0].operator.removeKeyOnFinish = true;
    protos[0].branches = newBranches;
    // docSetField must patch branches in-place, preserving the comment.
    docSetField(doc, [0], 'branches', newBranches);

    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));

    assertContains(out, '# too angry to juke',         'inter-task comment preserved');
    assertContains(out, 'removeKeyOnFinish: true',      'mutated scalar reflected');
    assertContains(out, 'rangeKey: MeleeRange',         'unchanged sibling field preserved');
    assertContains(out, 'targetKey: Target',             'second task preserved');
    assertContains(out, '!type:HTNPrimitiveTask',        '!type: tag on task node preserved');
    assertContains(out, '!type:MoveToOperator',          '!type: tag on operator node preserved');
    assertContains(out, '!type:MeleeOperator',           '!type: tag on second operator preserved');
    assertNotContains(out, '!<HTNPrimitiveTask>',        'no verbatim tag form !<...>');
    assertNotContains(out, '!<MoveToOperator>',          'no verbatim tag form !<...>');
});

test('!type: tags are preserved verbatim after docSetField on scalar sibling', () => {
    // Regression: _patchAstNode was setting astNode.tag = '__yamlTag' (the short
    // name) instead of '!type:' + __yamlTag, producing '!<Foo>' verbatim form.
    const text = [
        '- type: htnCompound',
        '  id: tagTest',
        '  branches:',
        '  - tasks:',
        '    - !type:HTNPrimitiveTask',
        '      operator: !type:MoveToOperator',
        '        speed: 1.5',
        '        removeKeyOnFinish: false',
        '',
    ].join('\n');

    const { protos, doc } = parseYamlDoc(text);
    const newBranches = JSON.parse(JSON.stringify(protos[0].branches));
    newBranches[0].tasks[0].operator.removeKeyOnFinish = true;
    protos[0].branches = newBranches;
    docSetField(doc, [0], 'branches', newBranches);

    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));

    assertContains(out, 'removeKeyOnFinish: true',   'scalar mutation applied');
    assertContains(out, '!type:HTNPrimitiveTask',     '!type: tag preserved on task');
    assertContains(out, '!type:MoveToOperator',       '!type: tag preserved on operator');
    assertNotContains(out, '!<HTNPrimitiveTask>',     'no verbatim !<...> form on task');
    assertNotContains(out, '!<MoveToOperator>',       'no verbatim !<...> form on operator');
});

test('sequence items sit at the same indent as their parent key (indentSeq: false)', () => {
    // SS14 convention: sequences are NOT indented relative to their parent.
    // Wrong:  components:\n    - type: Foo   (4 spaces)
    // Right:  components:\n  - type: Foo     (2 spaces, same as parent)
    const text = [
        '- type: Entity',
        '  id: indentTest',
        '  components:',
        '  - type: MeleeWeapon',
        '    damage: 5',
        '',
    ].join('\n');

    const { protos, doc } = parseYamlDoc(text);
    protos[0].components[0].damage = 10;
    docSetField(doc, [0, 'components', 0], 'damage', 10);

    // dumpYamlRespectful: dirty proto re-serialised from AST node.
    const respectful = dumpYamlRespectful(protos, doc, text, new Set([0]));
    // dumpYaml: full rebuild from JS (e.g. after structural changes).
    const full = dumpYaml(protos);

    // Both paths must produce 2-space seq items (indentSeq: false).
    assertContains   (respectful, '\n  - type: MeleeWeapon', 'respectful: 2-space seq item');
    assertNotContains(respectful, '\n    - type: MeleeWeapon', 'respectful: not 4-space seq item');
    assertContains   (full, '\n  - type: MeleeWeapon', 'full: 2-space seq item');
    assertNotContains(full, '\n    - type: MeleeWeapon', 'full: not 4-space seq item');
});


// ════════════════════════════════════════════════════════════════════
//  Comment-interaction coverage tests
//  These exercise every code path the WebUI uses to read/write comments
//  on proto-level fields, component fields, between-proto blocks, and
//  the trailing-file slot — plus the structural-dump WeakMap identity
//  path that backs add/remove/duplicate-id scenarios.
// ════════════════════════════════════════════════════════════════════

// Tiny helper — mirrors `fs` shape just enough for relinkProtoAst.
function makeFs(text) {
    const { protos, doc } = parseYamlDoc(text);
    const fs = { yaml: protos, doc, content: text };
    relinkProtoAst(fs);
    return fs;
}

// ── relinkProtoAst ───────────────────────────────────────────────────

test('relinkProtoAst maps each JS proto to its AST item node', () => {
    const fs = makeFs(`- type: A\n  id: a\n- type: B\n  id: b\n`);
    assert.strictEqual(fs.protoAstRefs.get(fs.yaml[0]), fs.doc.contents.items[0]);
    assert.strictEqual(fs.protoAstRefs.get(fs.yaml[1]), fs.doc.contents.items[1]);
});

test('relinkProtoAst tolerates length mismatch (uses min)', () => {
    const fs = makeFs(`- type: A\n  id: a\n`);
    // Adding a JS proto without re-parsing → WeakMap only links existing ones.
    fs.yaml.push({ type: 'B', id: 'b' });
    relinkProtoAst(fs);
    assert.strictEqual(fs.protoAstRefs.get(fs.yaml[0]), fs.doc.contents.items[0]);
    assert.strictEqual(fs.protoAstRefs.get(fs.yaml[1]), undefined);
});

// ── dumpYamlRespectfulStructural ─────────────────────────────────────

test('structural dump preserves clean bodies when adding a new proto at end', () => {
    const text = `# header\n- type: A\n  id: a\n  v: 1\n- type: B\n  id: b\n  v: 2\n`;
    const fs = makeFs(text);
    fs.yaml.push({ type: 'C', id: 'c', v: 3 });
    const out = dumpYamlRespectfulStructural(fs.yaml, text, fs.doc, fs.protoAstRefs);
    assertContains(out, '# header');
    assertContains(out, 'id: a');
    assertContains(out, 'id: b');
    assertContains(out, 'id: c');
    // Bodies of A and B should be byte-preserved.
    assertContains(out, '- type: A\n  id: a\n  v: 1');
    assertContains(out, '- type: B\n  id: b\n  v: 2');
});

test('structural dump preserves clean bodies when adding a new proto at start', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n`;
    const fs = makeFs(text);
    fs.yaml.unshift({ type: 'Z', id: 'z' });
    const out = dumpYamlRespectfulStructural(fs.yaml, text, fs.doc, fs.protoAstRefs);
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 3);
    assert.strictEqual(reparsed[0].id, 'z');
    assert.strictEqual(reparsed[1].id, 'a');
    assert.strictEqual(reparsed[2].id, 'b');
});

test('structural dump preserves clean bodies when removing a proto', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n- type: C\n  id: c\n`;
    const fs = makeFs(text);
    fs.yaml.splice(1, 1); // remove B
    const out = dumpYamlRespectfulStructural(fs.yaml, text, fs.doc, fs.protoAstRefs);
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 2);
    assert.strictEqual(reparsed[0].id, 'a');
    assert.strictEqual(reparsed[1].id, 'c');
    assertNotContains(out, 'id: b');
});

test('structural dump preserves comments between protos (clean blocks)', () => {
    const text = `- type: A\n  id: a\n# block comment\n- type: B\n  id: b\n`;
    const fs = makeFs(text);
    fs.yaml.push({ type: 'C', id: 'c' });
    const out = dumpYamlRespectfulStructural(fs.yaml, text, fs.doc, fs.protoAstRefs);
    assertContains(out, '# block comment');
    assertContains(out, 'id: c');
});

test('structural dump: duplicate ids never produce duplicate bodies', () => {
    // Regression: id-based slice matching used to emit B's body twice when
    // a new proto with the same id was inserted before B (both resolved to
    // the same slice). WeakMap AST identity eliminates the ambiguity.
    const text = `- type: T\n  id: NewPrototype\n  v: 1\n- type: T\n  id: other\n  v: 2\n`;
    const fs = makeFs(text);
    // Insert a fresh proto at index 0 that happens to also be 'NewPrototype'.
    fs.yaml.unshift({ type: 'T', id: 'NewPrototype', v: 99 });
    const out = dumpYamlRespectfulStructural(fs.yaml, text, fs.doc, fs.protoAstRefs);
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 3, 'must yield exactly 3 protos');
    assert.strictEqual(reparsed[0].v, 99);
    assert.strictEqual(reparsed[1].v, 1);
    assert.strictEqual(reparsed[2].v, 2);
});

test('structural dump: new proto without AST link is serialized fresh', () => {
    const text = `- type: A\n  id: a\n`;
    const fs = makeFs(text);
    fs.yaml.push({ type: 'B', id: 'b', v: 7 });
    const out = dumpYamlRespectfulStructural(fs.yaml, text, fs.doc, fs.protoAstRefs);
    assertContains(out, 'id: b');
    assertContains(out, 'v: 7');
});

// ── Inter-proto comment patch (raw-content) ──────────────────────────

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
    assert.ok(result);
    assertContains   (result.newContent, '# new');
    assertNotContains(result.newContent, '# old');
});

test('patchProtoCommentInContent clears an existing comment when newText is null', () => {
    const text = `- type: A\n  id: a\n# bye\n- type: B\n  id: b\n`;
    const { doc } = parseYamlDoc(text);
    const result = patchProtoCommentInContent(text, doc, 1, null);
    assert.ok(result);
    assertNotContains(result.newContent, '# bye');
    assertContains   (result.newContent, '- type: B');
});

test('patchProtoCommentInContent supports multi-line comments', () => {
    const text = `- type: A\n  id: a\n- type: B\n  id: b\n`;
    const { doc } = parseYamlDoc(text);
    const result = patchProtoCommentInContent(text, doc, 1, 'line one\nline two');
    assert.ok(result);
    assertContains(result.newContent, '# line one');
    assertContains(result.newContent, '# line two');
});

// ── Trailing-file comment ────────────────────────────────────────────

test('getTrailingComment reads an existing trailing block', () => {
    const text = `- type: A\n  id: a\n\n# bye\n# bye2\n`;
    const { doc } = parseYamlDoc(text);
    const out = getTrailingComment(text, doc);
    assert.strictEqual(out, 'bye\nbye2');
});

test('getTrailingComment returns null when nothing follows the last proto', () => {
    const text = `- type: A\n  id: a\n`;
    const { doc } = parseYamlDoc(text);
    assert.strictEqual(getTrailingComment(text, doc), null);
});

test('patchTrailingCommentInContent adds, replaces, and clears the trailing comment', () => {
    const text = `- type: A\n  id: a\n`;
    const { doc } = parseYamlDoc(text);

    // Add.
    const added = patchTrailingCommentInContent(text, doc, 'farewell');
    assert.ok(added);
    assertContains(added.newContent, '# farewell');

    // Replace.
    const replaced = patchTrailingCommentInContent(added.newContent, added.newDoc, 'see ya');
    assert.ok(replaced);
    assertContains   (replaced.newContent, '# see ya');
    assertNotContains(replaced.newContent, '# farewell');

    // Clear.
    const cleared = patchTrailingCommentInContent(replaced.newContent, replaced.newDoc, null);
    assert.ok(cleared);
    assertNotContains(cleared.newContent, '# see ya');
    assertContains   (cleared.newContent, 'id: a');
});

// ── Proto-field inline comments (scalar / single-seq / map / multi-seq) ─

test('field inline comment round-trips on a scalar value', () => {
    const text = `- type: A\n  id: a\n  v: 1\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'v', 'hello'), true);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, 'v: 1 # hello');
    const reparsed = parseYamlDoc(out);
    assert.strictEqual(getFieldInlineComment(reparsed.doc, 0, 'v'), ' hello');
});

test('field inline comment round-trips on a single-item flow sequence', () => {
    const text = `- type: A\n  id: a\n  tags:\n  - solo\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'tags', 'note'), true);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# note');
});

test('field inline comment on a multi-item Seq uses value.commentBefore slot', () => {
    const text = `- type: A\n  id: a\n  tags:\n  - x\n  - y\n`;
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'tags', 'list cmt'), true);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# list cmt');
    assertContains(out, '- x');
    assertContains(out, '- y');
});

test('field inline comment on a Map value uses value.commentBefore slot', () => {
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
    assertContains   (out, 'v: 1');
});

test('setFieldInlineComment returns false for an unknown key', () => {
    const text = `- type: A\n  id: a\n`;
    const { doc } = parseYamlDoc(text);
    assert.strictEqual(setFieldInlineComment(doc, 0, 'nope', 'x'), false);
});

// ── Proto-field commentBefore ────────────────────────────────────────

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
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertNotContains(out, '# before');
});

// ── Component-field comments ─────────────────────────────────────────

test('component-field inline comment round-trips', () => {
    const text = [
        '- type: Entity',
        '  id: e',
        '  components:',
        '  - type: MeleeWeapon',
        '    damage: 5',
        '',
    ].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(
        setComponentFieldInlineComment(doc, 0, 0, 'damage', 'big hits'), true);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, 'damage: 5 # big hits');
});

test('component-field commentBefore round-trips', () => {
    const text = [
        '- type: Entity',
        '  id: e',
        '  components:',
        '  - type: MeleeWeapon',
        '    damage: 5',
        '',
    ].join('\n');
    const { protos, doc } = parseYamlDoc(text);
    assert.strictEqual(
        setComponentFieldCommentBefore(doc, 0, 0, 'damage', 'comment above'), true);
    const got = getComponentFieldCommentBefore(doc, 0, 0, 'damage');
    assert.ok(got && got.includes('comment above'), `got=${JSON.stringify(got)}`);
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assertContains(out, '# comment above');
    assertContains(out, 'damage: 5');
});

test('component-field setters return false when the field is missing', () => {
    const text = `- type: Entity\n  id: e\n  components:\n  - type: X\n`;
    const { doc } = parseYamlDoc(text);
    assert.strictEqual(setComponentFieldInlineComment(doc, 0, 0, 'nope', 'x'), false);
    assert.strictEqual(setComponentFieldCommentBefore(doc, 0, 0, 'nope', 'x'), false);
});

// ── Comments survive structural changes (the integrated scenario) ────

test('comments on clean proto survive while a dirty sibling is rewritten', () => {
    const text = [
        '# file header',
        '- type: A',
        '  id: a',
        '  # before v',
        '  v: 1     # inline v',
        '# between A and B',
        '- type: B',
        '  id: b',
        '  v: 2',
        '',
    ].join('\n');
    const fs = makeFs(text);
    // Mutate B only.
    fs.yaml[1].v = 22;
    docSetField(fs.doc, [1], 'v', 22);
    const out = dumpYamlRespectful(fs.yaml, fs.doc, text, new Set([1]));
    assertContains(out, '# file header');
    assertContains(out, '# before v');
    assertContains(out, '# inline v');
    assertContains(out, '# between A and B');
    assertContains(out, 'v: 22');
});

test('add-proto followed by structural dump keeps existing inline comments', () => {
    const text = `- type: A\n  id: a\n  v: 1 # keep me\n- type: B\n  id: b\n`;
    const fs = makeFs(text);
    fs.yaml.splice(1, 0, { type: 'New', id: 'middle' });
    const out = dumpYamlRespectfulStructural(fs.yaml, text, fs.doc, fs.protoAstRefs);
    assertContains(out, '# keep me');
    assertContains(out, 'id: middle');
    const reparsed = parseYamlDoc(out).protos;
    assert.strictEqual(reparsed.length, 3);
});

test('comment on a !type:Foo seq-item line parses onto item.commentBefore', () => {
    const text = '- type: A\n  id: a\n  behaviors:\n  - !type:Foo # tag cmt\n    field: 1\n';
    const { doc } = parseYamlDoc(text);
    const beh = doc.contents.items[0].items.find(p => p.key.value === 'behaviors').value;
    const item = beh.items[0];
    assert.ok(YAML.isMap(item) && item.tag === '!type:Foo', 'expected tagged Map');
    const cmt = (item.commentBefore || '').trim();
    assert.strictEqual(cmt, 'tag cmt');
    // The inner scalar's trailing comment must NOT also hold the same text
    // (otherwise the comment would render twice after a re-emit).
    assert.ok(!item.items[0].value.comment, `inner scalar should not carry the tag-line cmt; got ${JSON.stringify(item.items[0].value.comment)}`);
});

test('!type:Foo tagged value on a dict pair parses onto value.commentBefore', () => {
    const text = '- type: A\n  id: a\n  shape: !type:PhysShapeCircle # circle cmt\n    radius: 0.5\n';
    const { doc } = parseYamlDoc(text);
    const pair = doc.contents.items[0].items.find(p => p.key.value === 'shape');
    assert.ok(YAML.isMap(pair.value) && pair.value.tag === '!type:PhysShapeCircle');
    const cmt = (pair.value.commentBefore || '').trim();
    assert.strictEqual(cmt, 'circle cmt');
    // getFieldInlineComment must surface that same comment.
    assert.strictEqual(getFieldInlineComment(doc, 0, 'shape'), 'circle cmt');
});

// ── Issue #6: empty components block ─────────────────────────────────────────

test('dumpYaml: entity with components:[] emits no components key', () => {
    const proto = { type: 'entity', id: 'E', name: 'N', components: [] };
    const out = dumpYaml([proto]);
    assert.ok(!out.includes('components'), `dumpYaml emitted components for empty array: ${JSON.stringify(out)}`);
});

test('dumpYamlRespectful: removing last component drops the components key', () => {
    const text = '- type: entity\n  id: E1\n  name: Test\n  components:\n  - type: Foo\n    x: 1\n';
    const { protos, doc } = parseYamlDoc(text);
    protos[0].components.splice(0, 1);
    delete protos[0].components;
    docDeleteField(doc, [0], 'components');
    const out = dumpYamlRespectful(protos, doc, text, new Set([0]));
    assert.ok(!out.includes('components'), `respectful dump still has components: ${JSON.stringify(out)}`);
    assert.ok(out.includes('id: E1'), 'proto identity preserved');
});

test('dumpYaml: entity without components key emits no components key', () => {
    const proto = { type: 'entity', id: 'CEActionZLevelUp', name: 'Move up', description: 'Move up one Z-Level' };
    const out = dumpYaml([proto]);
    assert.ok(!out.includes('components'), `dumpYaml emitted unexpected components: ${JSON.stringify(out)}`);
});


console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
