// EllipsisLM test runner.
// =====================================================================
// HOW IT WORKS
//
//   index.html is the only source of truth — there is no build step and
//   nothing gets split into modules. To test code that lives inside the
//   inline <script>, this runner:
//
//     1. Reads index.html as plain text.
//     2. Extracts the `const UTILITY = { ... };` block via line markers
//        (start: `        const UTILITY = {`, end: next `        };`).
//     3. Evals that block in a fresh Node `vm` sandbox and pulls out
//        the resulting UTILITY object.
//     4. Runs assertions against UTILITY's methods.
//
//   UTILITY's helpers are pure JS (no DOM, no fetch, no localStorage),
//   so the vm sandbox needs no stubs.
//
// HOW TO RUN
//
//   npm test          (or: node test.js)
//
//   Zero dependencies. Uses Node's built-in `node:test` and `node:assert`.
//
// HOW TO ADD A TEST
//
//   Find the section comment for the helper you're testing (e.g.
//   `── parseSearchQuery ──`) and add a `test('description', () => {...})`
//   alongside the existing ones. Use `deepEq(actual, expected)` for arrays
//   and objects (it strips the vm-sandbox prototype before comparing);
//   use `assert.equal` / `assert.ok` for primitives.
//
//   Discipline: when fixing a bug, write a failing red test first, then
//   the source fix that turns it green. See `.agents/rules/instructions.md`.
//
// WHAT'S NOT TESTED HERE
//
//   - DOM-bound helpers (escapeHTML, safeImageSet, ...)        — need a DOM stub.
//   - Blob / FileReader helpers (base64ToBlob, ...)            — Node lacks these natively.
//   - localStorage / IndexedDB code (DBService, StateManager)  — needs storage stubs.
//   - Provider HTTP code (callOpenRouter, ...)                 — needs fetch mocks.
//   - End-to-end Architect runs                                — would need a headless browser.
//
//   These were skipped intentionally. Adding them later doesn't require
//   redoing this layer — just add a sibling test file or extend this one.

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

test('extractDelimitedList: parses unbulleted pipe rows (LLM-followed prompt format)', () => {
    // Several prompts (auto-knowledge, archivist, stat tracker, relationship matrix)
    // ask the LLM for "Title | Content" rows with no bullet markers.
    const text = `Old Mill | A creaking watermill on the edge of town.
Red Guard | The captain's elite unit.`;
    const r = UTILITY.extractDelimitedList(text, '|', ['title', 'content']);
    assert.equal(r.length, 2);
    assert.equal(r[0].title, 'Old Mill');
    assert.equal(r[0].content, 'A creaking watermill on the edge of town.');
    assert.equal(r[1].title, 'Red Guard');
});

test('extractDelimitedList: skips intro/prose lines that lack the delimiter', () => {
    // Intro chatter from the LLM should be filtered when a delimiter is required.
    const text = `Sure! Here are the entries:
Old Mill | A creaking watermill.
Red Guard | The captain's elite unit.`;
    const r = UTILITY.extractDelimitedList(text, '|', ['title', 'content']);
    assert.equal(r.length, 2);
    assert.equal(r[0].title, 'Old Mill');
});

test('extractDelimitedList: comma-separated single line in bare-list mode', () => {
    // The in-story scenario prompt asks the LLM for "comma-separated list of topics"
    // on a single line. Without bullet markers, the old gate dropped everything.
    const r = UTILITY.extractDelimitedList('The Old Mill, The Red Guard, The Great Fire');
    deepEq(r, ['The Old Mill', 'The Red Guard', 'The Great Fire']);
});

test('extractDelimitedList: stat-row format (name|delta) parses cleanly', () => {
    // analyzeTurn prompt explicitly asks for `<stat_name>|<delta>` rows.
    const r = UTILITY.extractDelimitedList('Health|-5\nMorale|+10', '|', ['name', 'delta']);
    assert.equal(r.length, 2);
    assert.equal(r[0].name, 'Health');
    assert.equal(r[0].delta, '-5');
    assert.equal(r[1].name, 'Morale');
    assert.equal(r[1].delta, '+10');
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

// ─── hex color math ───────────────────────────────────────────────────────

test('hexToRgba: converts 7-char hex with alpha', () => {
    assert.equal(UTILITY.hexToRgba('#ff8000', 0.5), 'rgba(255,128,0,0.5)');
});

test('hexToRgba: converts 4-char shorthand hex', () => {
    assert.equal(UTILITY.hexToRgba('#abc', 1), 'rgba(170,187,204,1)');
});

test('darkenHex: darkening by 0% returns the same color', () => {
    assert.equal(UTILITY.darkenHex('#808080', 0), '#808080');
});

test('darkenHex: darkening clamps at black for large percentages', () => {
    assert.equal(UTILITY.darkenHex('#000000', 50), '#000000');
});

test('darkenHex: 50% reduces channel values toward zero', () => {
    // 0xff − round(2.55 × 50) = 255 − 127 = 128 = 0x80.
    // (2.55 × 50 is 127.4999… in IEEE-754, not 127.5, so Math.round rounds down.)
    assert.equal(UTILITY.darkenHex('#ffffff', 50), '#808080');
});

// ─── compileTriggerRegex ──────────────────────────────────────────────────

test('compileTriggerRegex: empty keyword returns never-match regex', () => {
    const r = UTILITY.compileTriggerRegex('');
    assert.equal(r.test('anything at all'), false);
});

test('compileTriggerRegex: matches whole word case-insensitively', () => {
    const r = UTILITY.compileTriggerRegex('dragon');
    assert.equal(r.test('A Dragon roars.'), true);
    assert.equal(r.test('DRAGONFRUIT is healthy'), false, 'must not mid-word match');
});

test('compileTriggerRegex: escapes regex specials in the keyword', () => {
    const r = UTILITY.compileTriggerRegex('a.b');
    assert.equal(r.test('a.b'), true);
    assert.equal(r.test('axb'), false, 'literal . must not match arbitrary char');
});

// ─── parseLoreTrigger ─────────────────────────────────────────────────────

test('parseLoreTrigger: empty string returns no groups, zero chance', () => {
    deepEq(UTILITY.parseLoreTrigger(''), { groups: [], chance: 0, chanceOperator: 'OR' });
    deepEq(UTILITY.parseLoreTrigger(null), { groups: [], chance: 0, chanceOperator: 'OR' });
});

test('parseLoreTrigger: comma-separated keywords become OR groups', () => {
    const r = UTILITY.parseLoreTrigger('dragon, sword');
    assert.equal(r.groups.length, 2);
    assert.equal(r.groups[0].type, 'OR');
    deepEq(r.groups[0].keywords, ['dragon']);
    deepEq(r.groups[1].keywords, ['sword']);
});

test('parseLoreTrigger: AND keyword becomes AND group with multiple keywords', () => {
    const r = UTILITY.parseLoreTrigger('dragon AND fire');
    assert.equal(r.groups[0].type, 'AND');
    deepEq(r.groups[0].keywords, ['dragon', 'fire']);
});

test('parseLoreTrigger: XOR with two keywords becomes XOR group', () => {
    const r = UTILITY.parseLoreTrigger('day XOR night');
    assert.equal(r.groups[0].type, 'XOR');
    deepEq(r.groups[0].keywords, ['day', 'night']);
});

test('parseLoreTrigger: extracts standalone chance percentage', () => {
    const r = UTILITY.parseLoreTrigger('dragon, 30%');
    assert.equal(r.chance, 30);
    assert.equal(r.chanceOperator, 'OR');
    // Chance percent is consumed from the trigger string, so the only group is `dragon`.
    assert.equal(r.groups.length, 1);
    deepEq(r.groups[0].keywords, ['dragon']);
});

test('parseLoreTrigger: AND-prefixed chance switches operator', () => {
    const r = UTILITY.parseLoreTrigger('dragon, AND 50%');
    assert.equal(r.chance, 50);
    assert.equal(r.chanceOperator, 'AND');
});

test('parseLoreTrigger: AND/XOR operators are case-insensitive', () => {
    const lower = UTILITY.parseLoreTrigger('dragon and fire');
    assert.equal(lower.groups[0].type, 'AND');
    deepEq(lower.groups[0].keywords, ['dragon', 'fire']);

    const mixed = UTILITY.parseLoreTrigger('day Xor night');
    assert.equal(mixed.groups[0].type, 'XOR');
    deepEq(mixed.groups[0].keywords, ['day', 'night']);
});

// ─── testLoreEntries (deterministic with chance=0) ────────────────────────

test('testLoreEntries: triggers entry whose keyword appears in content', () => {
    const entries = [
        { id: 'e1', triggers: 'dragon', content: 'lore about dragons' },
        { id: 'e2', triggers: 'sword', content: 'lore about swords' }
    ];
    const r = UTILITY.testLoreEntries('A red dragon swoops in.', entries);
    assert.equal(r && r.id, 'e1');
});

test('testLoreEntries: returns null when nothing matches and chance is 0', () => {
    const entries = [{ id: 'e1', triggers: 'unicorn', content: '...' }];
    assert.equal(UTILITY.testLoreEntries('A dragon swoops in.', entries), null);
});

test('testLoreEntries: AND group requires all keywords present', () => {
    const entries = [{ id: 'e1', triggers: 'dragon AND fire', content: '...' }];
    assert.equal(UTILITY.testLoreEntries('the dragon roars', entries), null, 'only one of the AND keywords');
    const r = UTILITY.testLoreEntries('the dragon breathes fire', entries);
    assert.equal(r && r.id, 'e1');
});

// ─── createDefaultMapGrid ─────────────────────────────────────────────────

test('createDefaultMapGrid: returns an 8x8 grid with empty content', () => {
    const grid = UTILITY.createDefaultMapGrid();
    assert.equal(grid.length, 64);
    assert.equal(grid[0].coords.x, 0);
    assert.equal(grid[0].coords.y, 0);
    assert.equal(grid[63].coords.x, 7);
    assert.equal(grid[63].coords.y, 7);
    assert.equal(grid[0].name, '');
    assert.ok(Array.isArray(grid[0].local_static_entries));
});

// ─── findPath ─────────────────────────────────────────────────────────────

test('findPath: same start and end returns single-cell path', () => {
    const grid = UTILITY.createDefaultMapGrid();
    const path = UTILITY.findPath(grid, { x: 2, y: 2 }, { x: 2, y: 2 });
    assert.equal(path.length, 1);
    assert.equal(path[0].x, 2);
    assert.equal(path[0].y, 2);
});

test('findPath: orthogonal adjacent cells produce length-2 path', () => {
    const grid = UTILITY.createDefaultMapGrid();
    const path = UTILITY.findPath(grid, { x: 0, y: 0 }, { x: 0, y: 1 });
    assert.equal(path.length, 2);
    deepEq(path[0], { x: 0, y: 0 });
    deepEq(path[1], { x: 0, y: 1 });
});

test('findPath: returns Manhattan-distance + 1 length on open grid', () => {
    const grid = UTILITY.createDefaultMapGrid();
    const path = UTILITY.findPath(grid, { x: 0, y: 0 }, { x: 3, y: 4 });
    // Manhattan distance is 7 steps, path includes start cell -> 8 nodes.
    assert.equal(path.length, 8);
});

test('findPath: returns empty array when start coords missing from grid', () => {
    const grid = UTILITY.createDefaultMapGrid();
    deepEq(UTILITY.findPath(grid, { x: 99, y: 99 }, { x: 0, y: 0 }), []);
});

// ─── weightedChoice ───────────────────────────────────────────────────────

test('weightedChoice: empty input returns null', () => {
    assert.equal(UTILITY.weightedChoice([], []), null);
});

test('weightedChoice: mismatched lengths returns null', () => {
    assert.equal(UTILITY.weightedChoice(['a', 'b'], [1]), null);
});

test('weightedChoice: single-element list always returns that element', () => {
    assert.equal(UTILITY.weightedChoice(['only'], [1]), 'only');
});

test('weightedChoice: zero total weight still returns one of the items', () => {
    const out = UTILITY.weightedChoice(['a', 'b', 'c'], [0, 0, 0]);
    assert.ok(['a', 'b', 'c'].includes(out));
});

// ─── parseSearchQuery ─────────────────────────────────────────────────────

test('parseSearchQuery: empty query reports isEmpty=true', () => {
    deepEq(UTILITY.parseSearchQuery(''), { isEmpty: true });
    deepEq(UTILITY.parseSearchQuery('   '), { isEmpty: true });
    deepEq(UTILITY.parseSearchQuery(null), { isEmpty: true });
});

test('parseSearchQuery: regex form /pattern/flags', () => {
    const r = UTILITY.parseSearchQuery('/dragon.*fire/i');
    assert.equal(r.isRegex, true);
    assert.ok(r.regex.test('dragon breathes fire'));
});

test('parseSearchQuery: invalid regex falls back to text-token parsing', () => {
    const r = UTILITY.parseSearchQuery('/[unclosed/');
    assert.equal(r.isRegex, false);
    assert.ok(Array.isArray(r.tokens));
});

test('parseSearchQuery: tokenizes negation, phrases, and field prefixes', () => {
    const r = UTILITY.parseSearchQuery('dragon -boring "fire breath" tag:adventure');
    assert.equal(r.isRegex, false);
    deepEq(r.tokens, [
        { text: 'dragon',     isNegative: false, isPhrase: false, field: null  },
        { text: 'boring',     isNegative: true,  isPhrase: false, field: null  },
        { text: 'fire breath', isNegative: false, isPhrase: true, field: null  },
        { text: 'adventure',  isNegative: false, isPhrase: false, field: 'tag' }
    ]);
});

// ─── matchStory ───────────────────────────────────────────────────────────

test('matchStory: empty query matches every story', () => {
    const story = { id: '1', name: 'Test', search_index: 'whatever' };
    assert.equal(UTILITY.matchStory(story, { isEmpty: true }), true);
});

test('matchStory: regex query tests against search_index then name', () => {
    const story = { id: '1', name: 'Dragon Tale', search_index: '' };
    const q = UTILITY.parseSearchQuery('/dragon/i');
    assert.equal(UTILITY.matchStory(story, q), true);
});

test('matchStory: regex with global flag must work on every story (no lastIndex carryover)', () => {
    // /pattern/g sets lastIndex on RegExp.prototype.test; reusing the same
    // regex across stories without resetting causes stateful false negatives.
    const stories = [
        { id: '1', name: 'A', search_index: 'dragon' },
        { id: '2', name: 'B', search_index: 'dragon' },
        { id: '3', name: 'C', search_index: 'dragon' }
    ];
    const q = UTILITY.parseSearchQuery('/dragon/g');
    for (const s of stories) {
        assert.equal(UTILITY.matchStory(s, q), true, `story ${s.id} should match`);
    }
});

test('matchStory: positive token must appear in search_index', () => {
    const story = { id: '1', name: 'Tale', search_index: 'a story about a dragon' };
    const q = UTILITY.parseSearchQuery('dragon');
    assert.equal(UTILITY.matchStory(story, q), true);
    const q2 = UTILITY.parseSearchQuery('elephant');
    assert.equal(UTILITY.matchStory(story, q2), false);
});

test('matchStory: negative token excludes stories containing it', () => {
    const story = { id: '1', name: 'Tale', search_index: 'boring dragon story' };
    const q = UTILITY.parseSearchQuery('-boring');
    assert.equal(UTILITY.matchStory(story, q), false);
});

test('matchStory: tag: field matches story tags and character tags', () => {
    const story = {
        id: '1',
        name: 'Tale',
        tags: ['epic'],
        characters: [{ tags: ['mage'] }],
        search_index: ''
    };
    assert.equal(UTILITY.matchStory(story, UTILITY.parseSearchQuery('tag:epic')), true);
    assert.equal(UTILITY.matchStory(story, UTILITY.parseSearchQuery('tag:mage')), true);
    assert.equal(UTILITY.matchStory(story, UTILITY.parseSearchQuery('tag:noir')), false);
});

test('matchStory: character: field matches character names', () => {
    const story = { id: '1', name: 'X', characters: [{ name: 'Thorne' }, { name: 'Mira' }], search_index: '' };
    assert.equal(UTILITY.matchStory(story, UTILITY.parseSearchQuery('char:thorne')), true);
    assert.equal(UTILITY.matchStory(story, UTILITY.parseSearchQuery('char:zog')), false);
});
