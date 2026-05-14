// Tests for tools/check-map.js. Run via `node tools/check-map.test.js`,
// chained from `npm test`.
//
// Mirrors test.js's discipline: red-then-green. The "marker bleed" case
// here was a real bug — adjacent bindings could share one marker because
// the lookback window wasn't bounded by the previous top-level statement.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { analyze, fix, parseMapBlock, mapEntryLine } = require('./check-map.js');

const CLI = path.join(__dirname, 'check-map.js');

// ── analyze: marker scoping ─────────────────────────────────────────────

test('analyze: each binding gets its own marker when present', () => {
    const html = `<html><script>
/* [SEC:JS:UTIL:FOO] */
const foo = 1;
/* [SEC:JS:UTIL:BAR] */
const bar = 2;
</script></html>`;
    const { bindings, missing } = analyze(html);
    assert.equal(bindings.length, 2);
    assert.equal(missing.length, 0);
    assert.equal(bindings[0].marker, '[SEC:JS:UTIL:FOO]');
    assert.equal(bindings[1].marker, '[SEC:JS:UTIL:BAR]');
});

test('analyze: a marker on binding A does NOT bleed to adjacent binding B', () => {
    // The whole point of the check: a brand-new top-level binding inserted
    // next to an existing one should be flagged, not silently inherit.
    const html = `<html><script>
/* [SEC:JS:UTIL:FOO] */
const foo = 1;
const bar = 2;
</script></html>`;
    const { missing } = analyze(html);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'bar');
});

test('analyze: HTML comment marker before <script> labels the FIRST binding', () => {
    // Maintainer's pattern: <!-- [SEC:JS:CORE] -->\n<script> labels the
    // section. The first binding inside the script may legitimately rely
    // on that outside-the-tag marker.
    const html = `<html>
<!-- [SEC:JS:CORE] -->
<script>
const APP_VERSION = "1.0";
</script></html>`;
    const { missing } = analyze(html);
    assert.equal(missing.length, 0);
});

test('analyze: HTML comment marker before <script> does NOT label the second binding', () => {
    // Same pattern, but a second binding is added — it must not silently
    // inherit the section header marker. Otherwise drift sneaks in.
    const html = `<html>
<!-- [SEC:JS:CORE] -->
<script>
const APP_VERSION = "1.0";
const SECRET_FLAG = true;
</script></html>`;
    const { missing } = analyze(html);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'SECRET_FLAG');
});

test('analyze: <script src=...> external scripts are skipped', () => {
    const html = `<html>
<script src="vendor.js"></script>
<script>
/* [SEC:JS:CORE] */
const x = 1;
</script></html>`;
    const { bindings } = analyze(html);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].name, 'x');
});

test('analyze: function and class declarations are detected, not just var/let/const', () => {
    const html = `<html><script>
/* [SEC:JS:UTIL:F] */
function f() { return 1; }
/* [SEC:JS:UTIL:C] */
class C { method() {} }
</script></html>`;
    const { bindings, missing } = analyze(html);
    assert.equal(bindings.length, 2);
    assert.equal(missing.length, 0);
    assert.equal(bindings[0].name, 'f');
    assert.equal(bindings[1].name, 'C');
});

test('analyze: top-level non-binding statements are ignored', () => {
    // ExpressionStatements, IfStatements, etc. are not bindings — the
    // check is about declared identifiers, not arbitrary code.
    const html = `<html><script>
window.foo = 1;
if (true) { console.log('ok'); }
/* [SEC:JS:UTIL:BAR] */
const bar = 2;
</script></html>`;
    const { bindings } = analyze(html);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].name, 'bar');
});

test('analyze: marker scope persists across <script> blocks (no cross-block bleed)', () => {
    // Two adjacent script blocks. The first declares `foo` (with marker).
    // The second declares `bar` with no marker of its own. `bar` must NOT
    // inherit foo's marker just because the second script's top-level body
    // starts fresh.
    const html = `<html><script>
/* [SEC:JS:UTIL:FOO] */
const foo = 1;
</script>
<script>
const bar = 2;
</script></html>`;
    const { missing } = analyze(html);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'bar');
});

test('analyze: bindings inside an IIFE are nested, not top-level — skipped', () => {
    // The first inline script in index.html wraps most of its logic in
    // (function initElectronKoboldUI() { ... })(); — those nested decls
    // are not top-level relative to the script body.
    const html = `<html><script>
(function init() {
    let nested = 1;
    function alsoNested() {}
})();
/* [SEC:JS:UTIL:OUTER] */
const outer = 2;
</script></html>`;
    const { bindings } = analyze(html);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].name, 'outer');
});

// ── fix: placeholder insertion ──────────────────────────────────────────

test('fix: inserts [SEC:JS:TODO:<Name>] above each missing binding', () => {
    const html = `<html><script>
const foo = 1;
const bar = 2;
</script></html>`;
    const { missing } = analyze(html);
    const out = fix(html, missing);
    // Both bindings now have a TODO marker above them.
    assert.match(out, /\[SEC:JS:TODO:foo\][^\n]*\nconst foo/);
    assert.match(out, /\[SEC:JS:TODO:bar\][^\n]*\nconst bar/);
    // After fixing, analyze sees zero missing.
    assert.equal(analyze(out).missing.length, 0);
});

test('fix: preserves indentation of the binding line', () => {
    const html = `<html><script>
        const foo = 1;
</script></html>`;
    const { missing } = analyze(html);
    const out = fix(html, missing);
    // Inserted comment carries the same 8-space indent as `        const foo`.
    assert.match(out, /\n        \/\* \[SEC:JS:TODO:foo\][^\n]*\*\/\n        const foo/);
});

test('fix: applying twice is idempotent — no duplicate markers', () => {
    const html = `<html><script>
const foo = 1;
</script></html>`;
    const once = fix(html, analyze(html).missing);
    const twice = fix(once, analyze(once).missing);
    assert.equal(once, twice);
});

test('fix: matches the source\'s line endings (CRLF stays CRLF)', () => {
    // index.html is CRLF; --fix used to insert plain \n lines, leaving the
    // shipped artifact with mixed endings. Now it should match the host.
    const html = '<html><script>\r\nconst foo = 1;\r\n</script></html>';
    const out = fix(html, analyze(html).missing);
    const bareLF = (out.match(/(?<!\r)\n/g) || []).length;
    assert.equal(bareLF, 0, 'no bare LF lines should be introduced into a CRLF file');
});

test('fix: matches the source\'s line endings (LF stays LF)', () => {
    const html = '<html><script>\nconst foo = 1;\n</script></html>';
    const out = fix(html, analyze(html).missing);
    const crlf = (out.match(/\r\n/g) || []).length;
    assert.equal(crlf, 0, 'no CRLF should be introduced into an LF file');
});

// ── multi-declarator + module sourceType ────────────────────────────────

test('analyze: multi-declarator records every declarator under the shared marker', () => {
    // const A = 1, B = 2 introduces both A and B as top-level bindings.
    // The marker above the const line covers both — they share absStart
    // and scopeStart, so they share the same nearest preceding marker.
    const html = `<html><script>
/* [SEC:JS:UTIL:AB] */
const A = 1, B = 2;
</script></html>`;
    const { bindings, missing } = analyze(html);
    assert.equal(bindings.length, 2);
    assert.deepEqual(bindings.map(b => b.name), ['A', 'B']);
    assert.equal(missing.length, 0);
    assert.equal(bindings[0].marker, '[SEC:JS:UTIL:AB]');
    assert.equal(bindings[1].marker, '[SEC:JS:UTIL:AB]');
});

test('analyze: multi-declarator without a marker reports every declarator missing', () => {
    const html = `<html><script>
const A = 1, B = 2;
</script></html>`;
    const { missing } = analyze(html);
    assert.equal(missing.length, 2);
    assert.deepEqual(missing.map(m => m.name), ['A', 'B']);
});

test('fix: multi-declarator statement gets one marker, not one per declarator', () => {
    const html = `<html><script>
const A = 1, B = 2;
</script></html>`;
    const out = fix(html, analyze(html).missing);
    const inserted = (out.match(/\[SEC:JS:TODO:/g) || []).length;
    assert.equal(inserted, 1, 'one statement should yield one marker');
    assert.equal(analyze(out).missing.length, 0);
});

test('analyze: <script type="module"> parses with module sourceType', () => {
    // Without sourceType:'module' acorn throws on top-level `import`.
    // The check should detect the type attribute and parse accordingly.
    const html = `<html><script type="module">
import { x } from './x.js';
/* [SEC:JS:UTIL:FOO] */
const foo = 1;
</script></html>`;
    const { bindings, missing } = analyze(html);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].name, 'foo');
    assert.equal(missing.length, 0);
});

test('analyze: <script type="module"> imports are not treated as bindings', () => {
    // ImportDeclaration is a top-level statement but does not introduce a
    // local const/let/var/function/class, so it should not require its
    // own [SEC:...] marker. The maintainer's convention puts markers on
    // local declarations, not on imports.
    const html = `<html><script type="module">
import { x, y } from './x.js';
import defaultThing from './y.js';
</script></html>`;
    const { bindings, missing } = analyze(html);
    assert.equal(bindings.length, 0);
    assert.equal(missing.length, 0);
});

// ── fix: same-line / inline-script edge cases ───────────────────────────

test('fix: same-line <script>const X = 1;</script> inserts inside the script, not before <html>', () => {
    // Previously the lineStart calculation found no preceding newline and
    // landed at offset 0, prepending the comment ABOVE the <html> tag —
    // visible as page text and leaving the marker outside its <script>
    // scope, so analyze re-runs would still see the binding as orphaned
    // (until the marker happened to fall inside the lookback window).
    const html = '<html><script>const X = 1;</script></html>';
    const out = fix(html, analyze(html).missing);
    // The marker must be inside the <script> block, before `const X`.
    assert.match(out, /<script>[\s\S]*\[SEC:JS:TODO:X\][\s\S]*const X/);
    // And no comment should appear outside the <script>...</script> pair.
    const beforeScript = out.slice(0, out.indexOf('<script>'));
    assert.ok(!/\[SEC:/.test(beforeScript), 'no SEC marker before <html><script>');
    // The fixed source must analyze clean.
    assert.equal(analyze(out).missing.length, 0);
});

test('fix: binding sharing a line with a prior statement still gets a marker on its own line', () => {
    // `foo();const X = 1;` — X's lineStart is right after the script open,
    // not the start of `const`. Insertion should land in front of `const`
    // with a fresh line, not stomp the foo() call.
    const html = '<html><script>\nfoo();const X = 1;\n</script></html>';
    const out = fix(html, analyze(html).missing);
    assert.match(out, /foo\(\);/);
    assert.match(out, /\[SEC:JS:TODO:X\][\s\S]*const X/);
    assert.equal(analyze(out).missing.length, 0);
});

// ── CLI: --stdin guard ──────────────────────────────────────────────────

test('CLI: --stdin with empty input exits 2 (catches silent pipe failure)', () => {
    // The pre-commit hook pipes `git show :index.html | check-map.js --stdin`.
    // Plain sh has no pipefail, so a failed `git show` produces empty stdin
    // and check-map would otherwise see "0 bindings, 0 missing" and exit 0,
    // silently bypassing enforcement. Refuse zero-binding stdin to close it.
    const res = spawnSync(process.execPath, [CLI, '--stdin'], { input: '', encoding: 'utf8' });
    assert.equal(res.status, 2, `expected exit 2 on empty stdin, got ${res.status}`);
    assert.match(res.stderr, /zero top-level bindings/i);
});

test('CLI: --stdin with valid covered input exits 0', () => {
    const html = `<html><script>
/* [SEC:JS:UTIL:FOO] */
const foo = 1;
</script></html>`;
    const res = spawnSync(process.execPath, [CLI, '--stdin'], { input: html, encoding: 'utf8' });
    assert.equal(res.status, 0);
});

test('CLI: --stdin with missing-marker input exits 1', () => {
    const html = `<html><script>
const foo = 1;
</script></html>`;
    const res = spawnSync(process.execPath, [CLI, '--stdin'], { input: html, encoding: 'utf8' });
    assert.equal(res.status, 1);
});

// ── TECHNICAL MAP coverage ──────────────────────────────────────────────

// A small fixture that includes a TECHNICAL MAP block in the maintainer's
// format. The block lists [SEC:JS:UTIL:FOO] but not [SEC:JS:UTIL:BAR].
const HTML_WITH_MAP = `<!DOCTYPE html>
<!--
    =================================================================================================
    [FILE:TEST] - test fixture
    =================================================================================================
    TECHNICAL MAP: Use these unique IDs for instant navigation (Search for the bracketed ID).

    [SEC:JS:UTIL:FOO]       - FooService
    =================================================================================================
-->
<html><script>
/* [SEC:JS:UTIL:FOO] */
const foo = 1;
/* [SEC:JS:UTIL:BAR] */
const bar = 2;
</script></html>`;

test('analyze: binding with inline marker but no MAP entry is reported missing', () => {
    const { bindings, missing } = analyze(HTML_WITH_MAP);
    assert.equal(bindings.length, 2);
    // foo has both inline + MAP; bar has inline but no MAP entry
    assert.equal(bindings[0].inMap, true);
    assert.equal(bindings[1].inMap, false);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'bar');
});

test('analyze: MAP enforcement is skipped when no MAP block is present', () => {
    // Most existing test fixtures lack a MAP block; bindings with an
    // inline marker should still be considered covered.
    const html = `<html><script>
/* [SEC:JS:UTIL:FOO] */
const foo = 1;
</script></html>`;
    const { missing, mapPresent } = analyze(html);
    assert.equal(mapPresent, false);
    assert.equal(missing.length, 0);
});

test('fix: appends MAP entry for an inline marker that\'s missing from MAP', () => {
    const out = fix(HTML_WITH_MAP, analyze(HTML_WITH_MAP).missing);
    // The new entry should appear inside the MAP block, before the
    // closing `===` separator.
    const mapBlock = out.match(/<!--[\s\S]*?-->/)[0];
    assert.match(mapBlock, /\[SEC:JS:UTIL:BAR\][\s\S]*bar/);
    // And the file should re-analyze clean.
    assert.equal(analyze(out).missing.length, 0);
});

test('fix: when both inline and MAP missing, both get added in one pass', () => {
    const html = `<!DOCTYPE html>
<!--
    ============
    TECHNICAL MAP: ids...

    [SEC:JS:UTIL:FOO]       - FooService
    ============
-->
<html><script>
/* [SEC:JS:UTIL:FOO] */
const foo = 1;
const bar = 2;
</script></html>`;
    const out = fix(html, analyze(html).missing);
    // Inline TODO for bar inserted
    assert.match(out, /\[SEC:JS:TODO:bar\][\s\S]*const bar/);
    // MAP entry for the same TODO marker added
    const mapBlock = out.match(/<!--[\s\S]*?-->/)[0];
    assert.match(mapBlock, /\[SEC:JS:TODO:bar\]\s+- bar/);
    // Clean on re-analyze
    assert.equal(analyze(out).missing.length, 0);
});

test('fix: idempotent on a fully covered file', () => {
    // Re-running fix on the already-fixed output produces no change.
    const once = fix(HTML_WITH_MAP, analyze(HTML_WITH_MAP).missing);
    const twice = fix(once, analyze(once).missing);
    assert.equal(once, twice);
});

test('fix: MAP insertion preserves CRLF line endings', () => {
    const html = HTML_WITH_MAP.replace(/\n/g, '\r\n');
    const out = fix(html, analyze(html).missing);
    const bareLF = (out.match(/(?<!\r)\n/g) || []).length;
    assert.equal(bareLF, 0, 'no bare LF should be introduced into a CRLF source');
});

test('mapEntryLine: short markers padded to width 24', () => {
    // Matches the maintainer's existing format: 4-space indent + marker
    // padded to width 24 + " - " + description.
    const line = mapEntryLine('[SEC:JS:CTRL:FOO]', 'Foo');
    assert.equal(line, '    [SEC:JS:CTRL:FOO]       - Foo');
});

test('mapEntryLine: long markers fall back to single space', () => {
    // A long [SEC:JS:TODO:LongName] marker can't be padded to width 24;
    // a single space separates it from the dash.
    const line = mapEntryLine('[SEC:JS:TODO:LongMarkerName]', 'LongMarkerName');
    assert.equal(line, '    [SEC:JS:TODO:LongMarkerName] - LongMarkerName');
});

test('parseMapBlock: returns null when no TECHNICAL MAP block is present', () => {
    const html = `<html><script>const x = 1;</script></html>`;
    assert.equal(parseMapBlock(html), null);
});

test('parseMapBlock: extracts the set of [SEC:...] markers from the block', () => {
    const info = parseMapBlock(HTML_WITH_MAP);
    assert.notEqual(info, null);
    assert.equal(info.markers.has('[SEC:JS:UTIL:FOO]'), true);
    assert.equal(info.markers.has('[SEC:JS:UTIL:BAR]'), false);
});
