#!/usr/bin/env node
// Verify the [SEC:...] section-map schema in index.html. Every top-level JS
// binding inside an inline <script> block must have a [SEC:...] marker in
// the comment lines immediately above it (within ~15 lines, and after the
// previous top-level statement — so two adjacent bindings can't share one
// marker). instructions.md already requires this; this script enforces it
// on every CI run.
//
// Usage:
//   node tools/check-map.js           check index.html; exit non-zero on drift
//   node tools/check-map.js --fix     insert TODO markers above any binding
//                                     that is missing one, then exit 0
//   node tools/check-map.js --stdin   check source read from stdin (used by
//                                     the pre-commit hook to check the
//                                     staged blob without touching the
//                                     working tree); --fix is rejected here
//                                     since stdin has no path to rewrite

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

// Permissive enough to match both the maintainer's all-caps convention
// (e.g. [SEC:JS:CTRL:NAR]) and the mixed-case TODO placeholders this
// script may insert (e.g. [SEC:JS:TODO:NarrativeController]).
const MARKER_RE = /\[SEC:[A-Za-z][A-Za-z0-9_:]*\]/g;
const LOOKBACK_BYTES = 600; // ~15 lines of indented JSDoc/HTML comments

// Walk every top-level binding in every inline <script> block and tag each
// with the nearest preceding [SEC:...] marker, scoped so a single marker
// can only be claimed by one binding (the next one after it). Returns
// { bindings: [{ name, absStart, line, marker }], missing: [...subset] }.
function analyze(source) {
    // 1. Locate inline <script> blocks (skip <script src="...">). Detect
    //    <script type="module"> so acorn parses it with the matching
    //    sourceType — otherwise top-level `import`/`export` would crash CI
    //    the moment the maintainer adds a module script.
    const scriptBlocks = [];
    const openRe = /<script(\s[^>]*)?>/g;
    let m;
    while ((m = openRe.exec(source)) !== null) {
        const attrs = m[1] || '';
        if (/\bsrc\s*=/i.test(attrs)) continue;
        const sourceType = /\btype\s*=\s*["']module["']/i.test(attrs) ? 'module' : 'script';
        const contentStart = m.index + m[0].length;
        const closeIdx = source.indexOf('</script>', contentStart);
        if (closeIdx === -1) throw new Error(`Unclosed <script> at offset ${m.index}`);
        scriptBlocks.push({ contentStart, contentEnd: closeIdx, sourceType });
        openRe.lastIndex = closeIdx;
    }

    // 2. Walk each block's top-level body for binding declarations. Track
    //    each binding's absolute start AND the previous top-level statement's
    //    end, so we can scope the marker lookback (see step 3). The floor
    //    persists across <script> blocks: the very first binding in the file
    //    starts at floor=0 (so it can see HTML markers above the script);
    //    subsequent bindings — including the first in a later script block —
    //    are floored at the previous top-level statement's end, so a marker
    //    can only label one binding.
    const bindings = [];
    let prevAbsEnd = 0;
    for (const blk of scriptBlocks) {
        const js = source.slice(blk.contentStart, blk.contentEnd);
        let ast;
        try {
            ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: blk.sourceType, allowReturnOutsideFunction: true });
        } catch (e) {
            throw new Error(`acorn failed on <script> at ${blk.contentStart}: ${e.message}`);
        }
        for (const node of ast.body) {
            const absStart = blk.contentStart + node.start;
            const absEnd = blk.contentStart + node.end;
            // A multi-declarator statement (const A = 1, B = 2;) introduces
            // every declarator as a top-level binding; record them all so
            // the check doesn't silently miss B. They share absStart and
            // scopeStart, so they share the marker above the statement.
            // Destructuring (const {x, y} = obj) deliberately not handled —
            // no instances in index.html and the maintainer's marker
            // convention is per-statement anyway.
            const names = [];
            if (node.type === 'VariableDeclaration') {
                for (const d of node.declarations) if (d.id?.name) names.push(d.id.name);
            } else if (node.type === 'FunctionDeclaration' && node.id?.name) {
                names.push(node.id.name);
            } else if (node.type === 'ClassDeclaration' && node.id?.name) {
                names.push(node.id.name);
            }
            for (const name of names) bindings.push({ name, absStart, scopeStart: prevAbsEnd });
            prevAbsEnd = absEnd;
        }
    }

    // 3. For each binding, look back up to LOOKBACK_BYTES for the nearest
    //    [SEC:...] marker — but stop at the previous top-level statement's
    //    end so two adjacent bindings can't both claim the same marker.
    function lineOf(offset) {
        return source.slice(0, offset).split('\n').length;
    }
    function nearestMarkerBefore(absStart, scopeStart) {
        const lo = Math.max(scopeStart, absStart - LOOKBACK_BYTES);
        const back = source.slice(lo, absStart);
        const ms = [...back.matchAll(MARKER_RE)];
        return ms.length ? ms[ms.length - 1][0] : null;
    }

    const tagged = bindings.map(b => ({
        name: b.name,
        absStart: b.absStart,
        line: lineOf(b.absStart),
        marker: nearestMarkerBefore(b.absStart, b.scopeStart),
    }));
    return { bindings: tagged, missing: tagged.filter(b => !b.marker) };
}

// Insert a TODO placeholder above each missing binding. Returns the rewritten
// source. Edits applied highest-offset-first so earlier offsets stay valid.
// Inserted lines match the source's dominant line ending — CRLF if the file
// is mostly CRLF (as index.html is), LF otherwise — so --fix doesn't leave
// mixed endings in the shipped artifact.
function fix(source, missing) {
    const crlf = (source.match(/\r\n/g) || []).length;
    const lfOnly = (source.match(/(?<!\r)\n/g) || []).length;
    const eol = crlf >= lfOnly ? '\r\n' : '\n';
    // Dedupe by absStart: a multi-declarator statement (const A, B;) gets
    // one marker above the const line, not one per declarator.
    const byOffset = new Map();
    for (const b of missing) if (!byOffset.has(b.absStart)) byOffset.set(b.absStart, b);
    let out = source;
    for (const b of [...byOffset.values()].sort((a, b) => b.absStart - a.absStart)) {
        const lineStart = out.lastIndexOf('\n', b.absStart - 1) + 1;
        const prefix = out.slice(lineStart, b.absStart);
        const marker = `[SEC:JS:TODO:${b.name}]`;
        // Normal case: the binding sits on its own line, preceded only by
        // whitespace. Use that indentation and insert above the line.
        // Edge case: the binding shares a line with the <script> open tag
        // or with a preceding statement (e.g. `<script>const X = 1;` or
        // `foo();const X = 1;`). lineStart would be 0 / mid-statement and
        // naive insertion would drop a /* ... */ comment outside the
        // script block — visible as page text. Detect that and instead
        // insert immediately before the binding with explicit newlines.
        if (/^\s*$/.test(prefix)) {
            const insertion = `${prefix}/* ${marker} -- recategorize and add to the TECHNICAL MAP at the top of the file. */${eol}`;
            out = out.slice(0, lineStart) + insertion + out.slice(lineStart);
        } else {
            const insertion = `${eol}/* ${marker} -- recategorize and add to the TECHNICAL MAP at the top of the file. */${eol}`;
            out = out.slice(0, b.absStart) + insertion + out.slice(b.absStart);
        }
    }
    return out;
}

module.exports = { analyze, fix, MARKER_RE, LOOKBACK_BYTES };

// CLI entry point.
if (require.main === module) {
    const SRC = path.resolve(__dirname, '..', 'index.html');
    const FIX = process.argv.includes('--fix');
    const STDIN = process.argv.includes('--stdin');
    if (FIX && STDIN) {
        console.error('check-map: --fix and --stdin are mutually exclusive (stdin has no path to write back to).');
        process.exit(2);
    }
    const source = STDIN
        ? fs.readFileSync(0, 'utf8')   // fd 0 = stdin
        : fs.readFileSync(SRC, 'utf8');

    let result;
    try {
        result = analyze(source);
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    const { bindings, missing } = result;

    // --stdin guard: if the input parsed cleanly but contains zero top-level
    // bindings, the upstream pipeline almost certainly fed us empty input
    // (e.g. `git show :index.html` failed silently — sh has no pipefail).
    // Without this, the hook would let a "0 bindings, 0 missing" result
    // through and bypass enforcement. The real index.html has 32 bindings,
    // so zero is a reliable corruption signal in --stdin mode.
    if (STDIN && bindings.length === 0) {
        console.error('check-map: --stdin received input with zero top-level bindings; refusing to certify (likely an empty pipe from git show or similar).');
        process.exit(2);
    }

    console.log(`Bindings: ${bindings.length}  |  with marker: ${bindings.length - missing.length}  |  missing: ${missing.length}`);
    if (missing.length) {
        console.log('\nBindings without a [SEC:...] marker:');
        for (const b of missing) console.log(`  ${String(b.line).padStart(6)}  ${b.name}`);
    }

    if (FIX && missing.length) {
        fs.writeFileSync(SRC, fix(source, missing));
        console.log(`\n--fix: inserted ${missing.length} placeholder marker(s) of the form [SEC:JS:TODO:<Name>].`);
        console.log('Recategorize each one (e.g. SRV / UTIL / CTRL / STATE) and add the new ID to the TECHNICAL MAP block at the top of index.html.');
        process.exit(0);
    }

    process.exit(missing.length ? 1 : 0);
}
