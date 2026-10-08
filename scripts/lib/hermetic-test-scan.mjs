/**
 * @file hermetic-test-scan.mjs — the STATIC half of hermetic tests (card xcu4cqf): a per-file ratchet over test and
 * soak-scenario sources that reach a live reader without injecting a fixture.
 *
 * The runtime guard (we:scripts/lib/hermetic-tests.mjs) catches a live access when it happens. This scan catches
 * the SHAPE before it runs, so a new test cannot add one: per-file counts may never grow past
 * we:scripts/hermetic-test-baseline.json, and the baseline must equal a fresh scan (so a fix is recorded and the
 * count only shrinks). Regenerate after an improvement: `node scripts/lib/hermetic-test-scan.mjs --write-baseline`.
 *
 * What it flags (`kind`), on code lines only (comments are prose, not calls):
 *   - `live-reader-uninjected` — a call to a declared live reader (`liveReaders` in
 *     we:scripts/hermetic-tests.settings.json) that does not pass every seam the entry `requires`. The 2026-10-08
 *     incident is exactly this: `adoptOrphanedBuildClaims({...})` without `readDelivery`, so it read gh + origin/main.
 *   - `real-gh-spawn` — the test shells `gh` itself and the file never builds a fake `gh`.
 *   - `real-home-state` — a path built from the real home into `.claude` / `.lanes` / `.operations`.
 *   - `remote-ref-read` — an `origin/…` ref read with the real checkout as cwd.
 *   - `hermetic-opt-out` — the file switches hermetic mode (or the sandbox) off for itself. The only opt-out is
 *     listing the test in `liveSuite.tests`.
 * Files listed in `liveSuite.tests` are skipped: they are allowed to be live, and they never run in a blocking suite.
 *
 * Pure detector ({@link findLiveReads}) + a walk ({@link scanHermeticTests}) the test imports, so the walk is pinned
 * by the test that runs it (the section-19 lesson: a walk copied into a test pins the rule, not the registration).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkBaseline } from './exec-output-guard.mjs';
import { readGit } from './proc-read.mjs';
import { liveSuiteFiles, loadHermeticSettings } from './hermetic-tests.mjs';

export { checkBaseline };
export const BASELINE_PATH = 'scripts/hermetic-test-baseline.json';

/** The detector's own tests carry the patterns as fixtures. */
const SELF = new Set(['scripts/lib/__tests__/hermetic-test-scan.test.mjs', 'scripts/lib/__tests__/hermetic-tests.test.mjs']);

/** Test sources and soak scenarios (scenarios are not `*.test.*` files but they ARE the test body). */
export function isHermeticScanSource(file) {
  if (SELF.has(file) || /(?:^|\/)node_modules\//.test(file)) return false;
  if (/\.test\.(?:mjs|js|ts|tsx)$/.test(file)) return true;
  return /^scripts\/conveyor\/soak\/breaks\/[^/]+\.mjs$/.test(file);
}

function codeLines(content) {
  const out = [];
  let inBlock = false;
  content.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      inBlock = false; line = line.slice(end + 2);
    }
    line = line.replace(/\/\*.*?\*\//g, '');
    const open = line.indexOf('/*');
    if (open !== -1 && !/['"`].*\/\*/.test(line.slice(0, open + 2))) { inBlock = true; line = line.slice(0, open); }
    if (/^\s*\/\//.test(line)) return;
    out.push({ line: i + 1, text: line.replace(/\s\/\/\s.*$/, '') });
  });
  return out;
}

/** The balanced `(...)` argument text starting at `openIdx` (the index of `(`), or the rest of the text. */
function callArgs(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return text.slice(openIdx + 1);
}

/** Is index `idx` of a line inside a string literal (a detector fixture, not a call)? Quote-parity approximation. */
function inString(text, idx) {
  let q = null;
  for (let i = 0; i < idx; i += 1) {
    const c = text[i];
    if (c === '\\') { i += 1; continue; }
    if (q) { if (c === q) q = null; } else if (c === "'" || c === '"' || c === '`') q = c;
  }
  return q !== null;
}
const codeMatch = (re, text) => { const m = re.exec(text); return m && !inString(text, m.index) ? m : null; };

const GH_SPAWN = /\b(?:execFileSync|execFile|spawnSync|spawn|execRead|execFileSyncThrottled)\(\s*['"`]gh['"`]|\bexecSync\(\s*['"`]gh\s|\breadGh(?:Json)?\(/;
const FAKE_GH = /fake[-_ ]?gh|fakeGh|['"`]gh['"`]\s*\)\s*,|join\([^)]*['"`]gh['"`]\)|GH_FIXTURE_ENV|WE_HERMETIC_GH/i;
const HOME_REF = /\bhomedir\(\)|process\.env\.HOME\b/;
const HOME_STATE = /['"`/]\.(?:claude|lanes|operations)\b|daemon-self-sync-state/;
const REMOTE_REF = /['"`](?:origin\/[\w./-]+(?::[^'"`]*)?|refs\/remotes\/[^'"`]*)['"`]/;
const REAL_CWD = /cwd:\s*(?:ROOT|REPO_ROOT|repoRoot|REPO|process\.cwd\(\))\b/;
/** A path-equality assertion computes a default, it does not read it. */
const ASSERTION = /\bexpect\(.*\)\.(?:toBe|toEqual|toStrictEqual|toContain|toMatch)\(/;
const OPT_OUT = /WE_TEST_(?:HERMETIC|SANDBOX)['"`]?\s*\]?\s*[:=]\s*['"`]0['"`]/;

/**
 * @param {string} content file text
 * @param {{liveReaders?: {call:string, requires:string[]}[]}} settings
 * @returns {{line:number, kind:string, text:string}[]}
 */
export function findLiveReads(content, settings = {}) {
  const lines = codeLines(content);
  const code = lines.map((l) => l.text).join('\n');
  const lineStarts = []; let pos = 0;
  for (const l of lines) { lineStarts.push({ pos, line: l.line }); pos += l.text.length + 1; }
  const lineAt = (idx) => { let n = lines[0]?.line ?? 1; for (const s of lineStarts) { if (s.pos > idx) break; n = s.line; } return n; };
  const found = [];
  const ghInjected = FAKE_GH.test(content);
  for (const { line, text } of lines) {
    const t = text.trim();
    const gh = codeMatch(GH_SPAWN, text);
    if (gh && !ghInjected && !(/^readGh/.test(gh[0].replace(/^\W+/, '')) && /\bexec\s*:/.test(text))) found.push({ line, kind: 'real-gh-spawn', text: t });
    if (HOME_REF.test(text) && HOME_STATE.test(text) && !ASSERTION.test(text)) found.push({ line, kind: 'real-home-state', text: t });
    if (REMOTE_REF.test(text) && REAL_CWD.test(text)) found.push({ line, kind: 'remote-ref-read', text: t });
    if (codeMatch(OPT_OUT, text)) found.push({ line, kind: 'hermetic-opt-out', text: t });
  }
  for (const reader of settings.liveReaders || []) {
    const re = new RegExp(`\\b${reader.call}\\s*\\(`, 'g');
    for (const m of code.matchAll(re)) {
      const before = code.slice(Math.max(0, m.index - 30), m.index);
      if (/(?:function|import|export|\{)\s*$/.test(before) || /\bas\s*$/.test(before)) continue; // a declaration or import, not a call
      const args = callArgs(code, m.index + m[0].length - 1);
      if (!args.trim()) { found.push({ line: lineAt(m.index), kind: 'live-reader-uninjected', text: `${reader.call}() — injects none of ${reader.requires.join(', ')}` }); continue; }
      const missing = reader.requires.filter((k) => !new RegExp(`(?:^|[\\s{,])${k}\\s*[:,}(]`).test(args));
      if (missing.length) found.push({ line: lineAt(m.index), kind: 'live-reader-uninjected', text: `${reader.call}(…) — missing ${missing.join(', ')}` });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Walk the tracked test + scenario sources and count findings per file.
 * @param {string} root repo root
 * @param {{files?: string[], read?: (f:string)=>string, listFiles?: ()=>string[]}} [io]
 */
export function scanHermeticTests(root, io = {}) {
  const settings = loadHermeticSettings(root);
  const live = new Set(liveSuiteFiles(settings));
  const list = io.files || (io.listFiles ? io.listFiles() : listTrackedTests(root));
  const read = io.read || ((f) => readFileSync(resolve(root, f), 'utf8'));
  const counts = {}; const findings = {};
  for (const file of list.filter(isHermeticScanSource).filter((f) => !live.has(f)).sort()) {
    let text;
    try { text = read(file); } catch { continue; }
    const hits = findLiveReads(text, settings);
    if (hits.length) { counts[file] = hits.length; findings[file] = hits; }
  }
  return { counts, findings };
}

function listTrackedTests(root) {
  return readGit(['ls-files', '-z'], { cwd: root }).split('\0').filter(Boolean);
}

/** Ratchet verdict against the committed baseline: regressions fail, improvements must be written back. */
export function checkHermeticBaseline(root, io = {}) {
  const { counts, findings } = scanHermeticTests(root, io);
  const baseline = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), 'utf8'));
  return { counts, findings, baseline, ...checkBaseline(counts, baseline) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') !== '--write-baseline') throw new Error('Usage: node scripts/lib/hermetic-test-scan.mjs --write-baseline');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { counts } = scanHermeticTests(root);
  writeFileSync(resolve(root, BASELINE_PATH), `${JSON.stringify(counts, null, 2)}\n`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${total} live-read sites in ${Object.keys(counts).length} test files (baseline written)`);
}
