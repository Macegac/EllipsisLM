// Single-file-friendly test runner for EllipsisLM.
//
// Strategy: index.html is the single source of truth. Rather than splitting it
// into modules, this runner extracts named code blocks (`const NAME = { ... };`)
// from the inline <script> by line markers, evaluates each in a fresh vm
// sandbox, and asserts against the resulting object. UTILITY is pure (no DOM /
// network), so no stubs are needed.
//
// Run: node test.js   (or: npm test)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

// Values built inside the vm sandbox have prototypes from a different realm,
// so node:assert/strict's prototype check fails on otherwise-identical objects.
// Round-trip through JSON to compare by structure only.
function deepEq(actual, expected, msg) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
}

const HTML_PATH = path.join(__dirname, 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// Extract a top-level service block declared as `        const NAME = {` and
// closed by the next line that is exactly `        };` (8-space indent). Every
// service in this file (UTILITY, APIService, StateManager, etc.) follows that
// convention, so the cheap line-anchored close is reliable.
function extractBlock(name) {
    // index.html ships with CRLF line endings; split on either to keep the
    // anchored markers exact.
    const lines = HTML.split(/\r?\n/);
    const start = lines.findIndex(l => l === `        const ${name} = {`);
    if (start === -1) throw new Error(`extractBlock: could not find 'const ${name} = {'`);
    const end = lines.indexOf('        };', start + 1);
    if (end === -1) throw new Error(`extractBlock: could not find close '        };' after ${name}`);
    return lines.slice(start, end + 1).join('\n');
}

function loadUtility() {
    const block = extractBlock('UTILITY');
    // The block declares `const UTILITY = {...};`. Append the bare identifier so
    // vm.runInNewContext returns it as the completion value.
    return vm.runInNewContext(block + '\nUTILITY', {});
}

const UTILITY = loadUtility();

// ─── toStringArray ────────────────────────────────────────────────────────

test('toStringArray: nullish input returns empty array', () => {
    deepEq(UTILITY.toStringArray(null), []);
    deepEq(UTILITY.toStringArray(undefined), []);
});

test('toStringArray: comma string splits and trims', () => {
    deepEq(UTILITY.toStringArray('warrior, dwarf , gruff'), ['warrior', 'dwarf', 'gruff']);
});

test('toStringArray: array of mixed values is cleaned', () => {
    deepEq(UTILITY.toStringArray(['  a', 'b', '', null, 'c ']), ['a', 'b', 'c']);
});

test('toStringArray: bare scalar wraps to single-element array', () => {
    deepEq(UTILITY.toStringArray('solo'), ['solo']);
    deepEq(UTILITY.toStringArray(42), ['42']);
});

test('toStringArray: object input returns empty array (defensive)', () => {
    deepEq(UTILITY.toStringArray({ tags: 'no' }), []);
});

// ─── normalizeStoryShape ──────────────────────────────────────────────────

test('normalizeStoryShape: coerces story.tags string into array', () => {
    const story = { tags: 'fantasy, dwarf' };
    UTILITY.normalizeStoryShape(story);
    deepEq(story.tags, ['fantasy', 'dwarf']);
});

test('normalizeStoryShape: coerces nested character.tags string into array', () => {
    const story = { characters: [{ name: 'Thorne', tags: 'jolly, dwarven' }] };
    UTILITY.normalizeStoryShape(story);
    deepEq(story.characters[0].tags, ['jolly', 'dwarven']);
});

test('normalizeStoryShape: missing array fields default to []', () => {
    const story = {};
    UTILITY.normalizeStoryShape(story);
    for (const k of ['tags', 'characters', 'scenarios', 'static_entries', 'dynamic_entries', 'narratives']) {
        assert.ok(Array.isArray(story[k]), `expected ${k} to be an array`);
    }
});

test('normalizeStoryShape: tolerates null / non-object input without throwing', () => {
    assert.doesNotThrow(() => UTILITY.normalizeStoryShape(null));
    assert.doesNotThrow(() => UTILITY.normalizeStoryShape(undefined));
    assert.doesNotThrow(() => UTILITY.normalizeStoryShape('not a story'));
});

test('normalizeStoryShape: ensures per-character extra_portraits and dynamic_knowledge are arrays', () => {
    const story = { characters: [{ name: 'X' }] };
    UTILITY.normalizeStoryShape(story);
    assert.ok(Array.isArray(story.characters[0].extra_portraits));
    assert.ok(Array.isArray(story.characters[0].dynamic_knowledge));
});

// ─── extractStructuredHeadings (the case-mismatch bug) ────────────────────

test('extractStructuredHeadings: result is exposed under both original case and lowercase', () => {
    const sample = `### Model Instructions
Speak softly.

### Tags
warrior, dwarf

### Color Hex
#71717a`;
    const r = UTILITY.extractStructuredHeadings(sample, ['Model Instructions', 'Tags', 'Color Hex']);
    assert.equal(r['Model Instructions'], 'Speak softly.');
    assert.equal(r['model instructions'], 'Speak softly.');
    assert.equal(r['Tags'], 'warrior, dwarf');
    assert.equal(r['tags'], 'warrior, dwarf');
    assert.equal(r['Color Hex'], '#71717a');
});

test('extractStructuredHeadings: missing heading returns empty string', () => {
    const r = UTILITY.extractStructuredHeadings('### Tags\na, b', ['Tags', 'Color Hex']);
    assert.equal(r['Color Hex'], '');
    assert.equal(r['color hex'], '');
});

test('extractStructuredHeadings: empty / null input returns empty object', () => {
    deepEq(UTILITY.extractStructuredHeadings('', ['Foo']), {});
    deepEq(UTILITY.extractStructuredHeadings(null, ['Foo']), {});
});

// ─── extractDelimitedList ─────────────────────────────────────────────────

test('extractDelimitedList: null/empty input returns empty array', () => {
    deepEq(UTILITY.extractDelimitedList(null), []);
    deepEq(UTILITY.extractDelimitedList(''), []);
});

test('extractDelimitedList: parses pipe-delimited rows by keys', () => {
    const text = `- Thorne | Innkeeper | jovial dwarf
- Mira | User | curious traveler`;
    const r = UTILITY.extractDelimitedList(text, '|', ['name', 'role', 'archetype']);
    assert.equal(r.length, 2);
    assert.equal(r[0].name, 'Thorne');
    assert.equal(r[0].role, 'Innkeeper');
    assert.equal(r[0].archetype, 'jovial dwarf');
    assert.equal(r[1].name, 'Mira');
});

test('extractDelimitedList: missing trailing fields default to empty string', () => {
    const r = UTILITY.extractDelimitedList('- Solo', '|', ['name', 'role', 'archetype']);
    assert.equal(r[0].name, 'Solo');
    assert.equal(r[0].role, '');
    assert.equal(r[0].archetype, '');
});

test('extractDelimitedList: bare list (no delimiter) returns trimmed strings', () => {
    const r = UTILITY.extractDelimitedList('- Locations\n- Factions\n- History');
    deepEq(r, ['Locations', 'Factions', 'History']);
});

// ─── extractAndParseJSON ──────────────────────────────────────────────────

test('extractAndParseJSON: null/empty input returns null', () => {
    assert.equal(UTILITY.extractAndParseJSON(null), null);
    assert.equal(UTILITY.extractAndParseJSON(''), null);
});

test('extractAndParseJSON: strips ```json fences', () => {
    const r = UTILITY.extractAndParseJSON('```json\n{"name":"x"}\n```');
    deepEq(r, { name: 'x' });
});

test('extractAndParseJSON: recovers from trailing prose', () => {
    const r = UTILITY.extractAndParseJSON('Sure thing! {"ok": true} (let me know if you need more)');
    deepEq(r, { ok: true });
});

test('extractAndParseJSON: tolerates trailing commas', () => {
    const r = UTILITY.extractAndParseJSON('{"a": 1, "b": 2,}');
    deepEq(r, { a: 1, b: 2 });
});

// ─── stripThinking ────────────────────────────────────────────────────────

test('stripThinking: removes <think>...</think> blocks', () => {
    const r = UTILITY.stripThinking('hello <think>internal monologue</think> world');
    assert.equal(r, 'hello  world');
});

test('stripThinking: removes [REASONING]...[/REASONING] blocks', () => {
    const r = UTILITY.stripThinking('foo [REASONING]secret[/REASONING] bar');
    assert.equal(r, 'foo  bar');
});

test('stripThinking: passes through non-strings unchanged', () => {
    assert.equal(UTILITY.stripThinking(null), null);
    assert.equal(UTILITY.stripThinking(undefined), undefined);
});
