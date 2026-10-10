/**
 * @file scripts/conveyor/fix-context-pack.mjs
 * @description The CONTEXT PACK every fix / ci-heal brief carries (operator go 2026-10-10; study
 *   `fixer-work-efficiency`: a fix round's median 11.5 active minutes spent 2.8 orienting — every round re-ran
 *   `gh pr view --json comments` and ~6 file reads before its first edit, because the finding was not in the 61 KB
 *   brief — and 28% running the same local test files ~3x per round, which the verify gate then ran again).
 *
 * WHAT THE HARNESS STAGES (so the fixer does not have to):
 *   - fix: the authoritative finding comment(s) VERBATIM (latest `🔁 … changes requested`, and the latest advisory
 *     review when it is newer), each `path:line` the finding names with ±N lines of code at the PR head, and the
 *     PR's changed files with their sizes.
 *   - ci-heal: the failing check(s), the failing test lines + the tail of the failed job log, and the changed files.
 *   - both: the `fix.localTests` rule — `proof-only` = run the failing/new test ONCE as the red proof, then let the
 *     verify gate supply the after-run (no repeated local runs).
 *
 * THE BRIEF GETS SMALLER, NOT LARGER: with a pack in place the generic sections it makes redundant (the dispatcher's
 *   own placeholder table, the human `/finish` take-over notes, and — when the finding is not an advisory one — the
 *   advisory-mode steps) are dropped, and the pack's byte budget is capped at the bytes dropped
 *   (`min(fix.contextMaxBytes, removed)`), so a packed brief is never bigger than the plain one.
 *
 * SETTINGS (scripts/settings/fix-context-pack.json, the same layered shape as `we:scripts/lib/policy-cascade.mjs`,
 *   PR #4772 — not merged yet, so resolved here: standard default → tool file → env; the source of each value is
 *   logged once per process inside a daemon):
 *   - `fix.contextPack` true|false            env WE_FIX_CONTEXT_PACK=on|off
 *   - `fix.contextLines` (default 30)          env WE_FIX_CONTEXT_LINES
 *   - `fix.contextMaxBytes` (default 8000)     env WE_FIX_CONTEXT_MAX_BYTES
 *   - `fix.localTests` proof-only|free         env WE_FIX_LOCAL_TESTS
 *   All off (`contextPack: false`, `localTests: free`) = the old brief, byte for byte.
 *
 * Never throws: an unreadable PR leaves the brief exactly as it was (plus the tests rule when that is on).
 */
import { readSettings } from '../lib/settings-files.mjs';
import { isUnderTest } from '../lib/under-test.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

export const CONTEXT_PACK_DEFAULTS = Object.freeze({
  contextPack: true, contextLines: 30, contextMaxBytes: 8000, localTests: 'proof-only',
});
export const LOCAL_TESTS_MODES = Object.freeze(['proof-only', 'free']);

/** The generic brief sections a pack makes redundant. A test pins that each heading exists in its template. */
export const TRIM_SECTIONS = Object.freeze({
  fix: ['## Fill these before spawning', '## Manual take-over'],
  fixNonAdvisory: ['### 2a. Read the advisory finding', '### 7a. Advisory-fix hand-back'],
  fixAdvisory: ['### 7. Re-arm the review'],
  'ci-heal': ['## Fill these before spawning', '## Manual take-over'],
});

const VALID = {
  contextPack: (v) => typeof v === 'boolean',
  contextLines: (v) => Number.isInteger(v) && v >= 0 && v <= 200,
  contextMaxBytes: (v) => Number.isInteger(v) && v >= 0 && v <= 200_000,
  localTests: (v) => LOCAL_TESTS_MODES.includes(v),
};
const ENV = {
  contextPack: ['WE_FIX_CONTEXT_PACK', (s) => (/^(on|true|1)$/i.test(s) ? true : /^(off|false|0)$/i.test(s) ? false : s)],
  contextLines: ['WE_FIX_CONTEXT_LINES', (s) => (/^\d+$/.test(s) ? Number(s) : s)],
  contextMaxBytes: ['WE_FIX_CONTEXT_MAX_BYTES', (s) => (/^\d+$/.test(s) ? Number(s) : s)],
  localTests: ['WE_FIX_LOCAL_TESTS', (s) => s],
};

let loggedSettings = null;

/**
 * Resolve the context-pack settings: standard default → `fix.*` in the settings files → env. An invalid value never
 * overrides a lower layer; it is named in `invalid`. PURE when `settings` is passed.
 * @returns {{value:typeof CONTEXT_PACK_DEFAULTS, sources:Record<string,string>, invalid:string[]}}
 */
export function resolveContextPackSettings({ env = process.env, settings } = {}) {
  let file = settings;
  if (file === undefined) { try { file = readSettings(); } catch { file = {}; } }
  const tool = (file && typeof file.fix === 'object' && file.fix) || {};
  const value = { ...CONTEXT_PACK_DEFAULTS };
  const sources = Object.fromEntries(Object.keys(value).map((k) => [k, 'standard']));
  const invalid = [];
  for (const k of Object.keys(value)) {
    if (tool[k] !== undefined) {
      if (VALID[k](tool[k])) { value[k] = tool[k]; sources[k] = 'tool'; } else invalid.push(`tool.fix.${k}=${JSON.stringify(tool[k])}`);
    }
    const [name, parse] = ENV[k];
    const raw = String(env?.[name] ?? '').trim();
    if (raw) {
      const v = parse(raw);
      if (VALID[k](v)) { value[k] = v; sources[k] = 'env'; } else invalid.push(`env.${name}=${JSON.stringify(raw)}`);
    }
  }
  return { value, sources, invalid };
}

/** The one source-log line for a resolved set (policy-cascade shape). */
export function settingsLogLine({ value, sources, invalid }) {
  const parts = Object.keys(value).map((k) => `${k}=${JSON.stringify(value[k])} (${sources[k]})`);
  return `policy-cascade · fix.contextPack: ${parts.join(', ')}${invalid.length ? ` · invalid ignored: ${invalid.join(', ')}` : ''}`;
}

/** Log the effective set once per process (and again only if it changes); silent under test. */
export function logContextPackSettings(resolved, { log = (l) => console.error(l), env = process.env } = {}) {
  const line = settingsLogLine(resolved);
  if (line === loggedSettings || isUnderTest(env)) return false;
  loggedSettings = line;
  log(line);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Finding extraction (PURE)

const CHANGES_RE = /^\s*🔁\s*(?:human\s+)?review\s+—\s+changes requested/u;
const ADVISORY_RE = /^\s*\*{0,2}⚠️\s*THIS IS AN ADVISORY REVIEW/u;
const REF_RE = /(?<![\w@./-])([\w@.-][\w@.\-/]*\.[A-Za-z0-9]{1,8}):(\d{1,6})(?:-(\d{1,6}))?/g;
const JSON_REF_RE = /"([\w@.-][\w@.\-/]*\.[A-Za-z0-9]{1,8})",\s*(\d{1,6})/g;

/**
 * The authoritative finding comment(s): the latest changes-requested comment, plus the latest advisory review when it
 * is newer (advisory-fix mode). PURE.
 * @param {Array<{body?:string, createdAt?:string, author?:{login?:string}}>} comments
 * @returns {{findings:Array<{kind:'changes'|'advisory', body:string, createdAt:string|null}>, advisory:boolean}}
 */
export function extractFindings(comments = [], { labels = null, isTrusted = () => true } = {}) {
  // The brief's own mode rule: `review:changes` on the PR = ordinary mode (the changes-requested comment is the ask);
  // no `review:changes` but `advisory:changes` = advisory-fix mode (the advisory review is the ask).
  const names = Array.isArray(labels) ? labels.map((l) => (typeof l === 'string' ? l : l?.name)) : null;
  const mode = !names ? null : names.includes('review:changes') ? 'changes' : names.includes('advisory:changes') ? 'advisory' : null;
  let changes = null;
  let advisory = null;
  (comments ?? []).forEach((c, i) => {
    const body = String(c?.body ?? '');
    if (!isTrusted(c)) return; // a look-alike comment from anyone else is never staged as the ask
    if (CHANGES_RE.test(body)) changes = { i, c };
    else if (ADVISORY_RE.test(body)) advisory = { i, c };
  });
  if (mode === 'changes') advisory = null;
  if (mode === 'advisory' && advisory) changes = null;
  const findings = [];
  if (changes) findings.push({ kind: 'changes', body: String(changes.c.body), createdAt: changes.c.createdAt ?? null });
  if (advisory && (!changes || advisory.i > changes.i)) {
    findings.push({ kind: 'advisory', body: String(advisory.c.body), createdAt: advisory.c.createdAt ?? null });
  }
  return { findings, advisory: Boolean(advisory && (!changes || advisory.i > changes.i)) };
}

/**
 * Every `path:line` (or `path:a-b`) a finding names, in order, de-duplicated. A bare name with no `/` counts only when
 * it is one of the PR's changed files. PURE.
 * @returns {Array<{path:string, line:number, end:number}>}
 */
export function extractFileRefs(text, { changedPaths = [], max = 6 } = {}) {
  const changed = new Set(changedPaths);
  const out = [];
  const seen = new Set();
  const push = (path, a, b) => {
    const p = path.replace(/^\.\//, '');
    if (!p.includes('/') && !changed.has(p)) return;
    if (/^https?:/.test(p) || p.includes('//')) return;
    const line = Number(a);
    const end = b ? Math.max(line, Number(b)) : line;
    const key = `${p}:${line}`;
    if (!line || seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, line, end });
  };
  const s = String(text ?? '');
  for (const m of s.matchAll(REF_RE)) push(m[1], m[2], m[3]);
  for (const m of s.matchAll(JSON_REF_RE)) push(m[1], m[2]);
  return out.slice(0, max);
}

/** ±n lines around [line, end], numbered. PURE. */
export function excerptLines(text, line, n, end = line) {
  const lines = String(text ?? '').split('\n');
  const from = Math.max(1, line - n);
  const to = Math.min(lines.length, end + n);
  if (from > lines.length) return '';
  const width = String(to).length;
  const rows = [];
  for (let k = from; k <= to; k++) rows.push(`${String(k).padStart(width)}${k >= line && k <= end ? '>' : ' '} ${lines[k - 1]}`);
  return rows.join('\n');
}

/** Drop whole `#`-sections whose heading line starts with one of `prefixes` (up to the next heading of the same or a
 *  higher level). PURE. @returns {{text:string, removed:string[], removedBytes:number}} */
export function trimBriefSections(brief, prefixes = []) {
  const lines = String(brief).split('\n');
  const keep = [];
  const removed = [];
  let removedBytes = 0;
  let dropLevel = 0;
  let inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) inFence = !inFence;
    const h = !inFence && /^(#{1,6})\s/.exec(l);
    if (h && dropLevel && h[1].length <= dropLevel) dropLevel = 0;
    if (h && !dropLevel) {
      const hit = prefixes.find((p) => l.startsWith(p));
      if (hit) { dropLevel = h[1].length; removed.push(hit); }
    }
    if (dropLevel) removedBytes += Buffer.byteLength(l) + 1; else keep.push(l);
  }
  return { text: keep.join('\n'), removed, removedBytes };
}

const fence = (path) => {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();
  return { mjs: 'js', cjs: 'js', js: 'js', ts: 'ts', md: 'md', json: 'json', sh: 'bash', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml' }[ext] ?? '';
};
const bytes = (s) => Buffer.byteLength(String(s));
function clip(s, max) {
  if (bytes(s) <= max) return s;
  const note = '\n… [truncated by the context pack budget — the full text is on the PR thread]';
  let t = String(s).slice(0, Math.max(0, max - bytes(note)));
  while (bytes(t) + bytes(note) > max && t.length) t = t.slice(0, -64);
  return t + note;
}

/** The fixed local-tests rule (counted inside the pack budget). PURE. */
export function localTestsSection(mode, kind = 'fix') {
  if (mode !== 'proof-only') return '';
  const red = kind === 'ci-heal'
    ? 'If you need a red proof of the CI break, run the failing test file ONCE (`npm run test:unit -- <that file>`).'
    : 'Run the failing (or new) test file ONCE, before the fix, as the red proof (`npm run test:unit -- <that file>`).';
  return [
    '### Local tests — proof-only (`fix.localTests`)',
    '',
    `${red} Do NOT re-run it after the fix, and do not re-run test files after the self-review: the verify gate`,
    'runs the diff-selected tests, and its verdict IS your after-evidence (cite it in the evidence comment in place of',
    'a local after-run). This overrides the "re-run the SAME test" lines below. Run a test file again only to debug a',
    'red verify verdict, never as a green re-check.',
  ].join('\n');
}

function filesSection(files = [], budget) {
  if (!files?.length || budget <= 0) return '';
  const head = `### Changed files (${files.length}, +added −deleted lines)\n\n`;
  const rows = [];
  let used = bytes(head);
  for (const f of files) {
    const r = `- \`${f.path}\` (+${f.additions ?? 0} −${f.deletions ?? 0})`;
    if (used + bytes(r) + 1 > budget - 40) { rows.push(`- … ${files.length - rows.length} more (gh pr view --json files)`); break; }
    rows.push(r);
    used += bytes(r) + 1;
  }
  return head + rows.join('\n');
}

/**
 * Render the FIX context pack within `maxBytes`. Order of priority: the tests rule, the finding text, the code
 * excerpts (each shrunk, then dropped, to fit), the changed files. PURE.
 * @param {{findings:Array<{kind:string, body:string, createdAt:string|null}>, refs:Array<{path:string,line:number,end:number}>,
 *   fileText:(path:string)=>(string|null), files:Array<{path:string,additions?:number,deletions?:number}>, headSha?:string|null,
 *   lines:number, maxBytes:number, localTests:string, removed?:string[]}} input
 * @returns {string} '' when there is nothing to stage
 */
export function renderFixPack({ findings = [], refs = [], fileText = () => null, files = [], headSha = null, lines = 30, maxBytes = 8000, localTests = 'free', removed = [] }) {
  if (!findings.length && !files.length) return '';
  const header = [
    '## Context pack — staged by the harness for this round (read this first)',
    '',
    'The finding, the code it names and the PR\'s file list are already below. Do NOT re-fetch the PR thread',
    '(`gh pr view` of the body or the comment thread) or re-read these excerpts before your first edit; open more of a file only',
    'where the excerpt is not enough.',
    ...(removed.length ? [`Brief sections not in play for this dispatch were removed: ${removed.map((r) => `"${r.replace(/^#+\s*/, '')}"`).join(', ')}.`] : []),
  ].join('\n');
  const tests = localTestsSection(localTests, 'fix');
  let budget = maxBytes - bytes(header) - (tests ? bytes(tests) + 2 : 0) - 4;
  if (budget <= 0) return '';
  const parts = [header];
  for (const f of findings) {
    const title = `### Finding (verbatim — ${f.kind === 'advisory' ? 'latest advisory review' : 'latest changes-requested comment'}${f.createdAt ? `, ${f.createdAt}` : ''})\n\n`;
    const room = Math.min(budget, Math.max(400, Math.floor(budget * (findings.length > 1 ? 0.35 : 0.55))));
    if (room <= bytes(title) + 80) break;
    // Quoted, so the comment's own headings stay inside the finding instead of reading as brief sections.
    const quoted = clip(f.body.trim(), Math.floor((room - bytes(title)) * 0.95)).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    const block = title + quoted;
    parts.push(block);
    budget -= bytes(block) + 2;
  }
  const filesReserve = files.length ? Math.min(1200, Math.floor(budget * 0.25)) : 0;
  let codeBudget = budget - filesReserve;
  const code = [];
  for (const r of refs) {
    const text = fileText(r.path);
    if (text == null) continue;
    for (let n = lines; n >= 3; n = Math.floor(n / 2)) {
      const ex = excerptLines(text, r.line, n, r.end);
      if (!ex) break;
      const block = `#### \`${r.path}:${r.line}${r.end !== r.line ? `-${r.end}` : ''}\` (±${n} lines)\n\n\`\`\`${fence(r.path)}\n${ex}\n\`\`\``;
      if (bytes(block) + 2 <= codeBudget) { code.push(block); codeBudget -= bytes(block) + 2; break; }
    }
  }
  if (code.length) {
    const block = `### Code at the named lines${headSha ? ` (PR head \`${String(headSha).slice(0, 9)}\`)` : ''}\n\n${code.join('\n\n')}`;
    parts.push(block);
    budget -= bytes(block) + 2;
  }
  const fl = filesSection(files, budget);
  if (fl) parts.push(fl);
  if (tests) parts.push(tests);
  return clip(parts.join('\n\n'), maxBytes);
}

/**
 * Render the CI-HEAL context pack: the failing checks, the failing test lines and the failed-log tail, the changed
 * files. PURE. `maxBytes` is a hard cap.
 * @param {{checks:Array<{name:string, link?:string}>, failedTests:string[], logTail:string, files:Array, maxBytes:number,
 *   localTests:string, removed?:string[]}} input
 */
export function renderCiPack({ checks = [], failedTests = [], logTail = '', files = [], maxBytes = 2500, localTests = 'free', removed = [] }) {
  if (!checks.length && !files.length) return '';
  const header = [
    '## Context pack — staged by the harness for this heal (read this first)',
    '',
    'The failing checks, the failing tests and the end of the failed log are below — `gh pr checks` and',
    '`gh run view --log-failed` are already done; re-run them only if this section is empty or cut short.',
    ...(removed.length ? [`Brief sections not in play for this dispatch were removed: ${removed.map((r) => `"${r.replace(/^#+\s*/, '')}"`).join(', ')}.`] : []),
  ].join('\n');
  const tests = localTestsSection(localTests, 'ci-heal');
  let budget = maxBytes - bytes(header) - (tests ? bytes(tests) + 2 : 0) - 4;
  if (budget <= 0) return '';
  const parts = [header];
  if (checks.length) {
    const block = `### Failing checks\n\n${checks.map((c) => `- ${c.name}${c.link ? ` — ${c.link}` : ''}`).join('\n')}`;
    parts.push(clip(block, Math.max(200, Math.floor(budget * 0.25))));
    budget -= bytes(parts.at(-1)) + 2;
  }
  if (failedTests.length) {
    const block = `### Failing tests\n\n${failedTests.map((t) => `- ${t}`).join('\n')}`;
    parts.push(clip(block, Math.max(200, Math.floor(budget * 0.3))));
    budget -= bytes(parts.at(-1)) + 2;
  }
  const filesReserve = files.length ? Math.min(600, Math.floor(budget * 0.25)) : 0;
  if (logTail && budget - filesReserve > 200) {
    const room = budget - filesReserve;
    const lines = String(logTail).split('\n');
    let tail = '';
    for (let k = lines.length - 1; k >= 0; k--) {
      const next = `${lines[k]}\n${tail}`;
      if (bytes(next) + 60 > room) break;
      tail = next;
    }
    if (tail.trim()) {
      const block = `### Failed log (last lines)\n\n\`\`\`\n${tail.trimEnd()}\n\`\`\``;
      parts.push(block);
      budget -= bytes(block) + 2;
    }
  }
  const fl = filesSection(files, budget);
  if (fl) parts.push(fl);
  if (tests) parts.push(tests);
  return clip(parts.join('\n\n'), maxBytes);
}

/** The failing test lines a vitest / node log names (FAIL rows, ×/✗ rows), de-duplicated. PURE. */
export function extractFailedTests(log, max = 12) {
  const out = [];
  for (const raw of String(log ?? '').split('\n')) {
    const l = raw.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').trim();
    if (/^(FAIL|❯ .*\.test\.|×|✗|✕)\s/.test(l) && !out.includes(l)) out.push(l.slice(0, 240));
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The brief transform (PURE given its inputs)

/** Put the pack (and the tests rule) in front of the brief, trimming the sections it makes redundant. PURE.
 *  Both settings off → the brief unchanged. */
export function applyContextPack(brief, { kind = 'fix', settings = CONTEXT_PACK_DEFAULTS, inputs = null, escapeTokens = true } = {}) {
  const { contextPack, contextMaxBytes, contextLines, localTests } = settings;
  const testsOnly = () => {
    const t = localTestsSection(localTests, kind);
    return t ? `${t}\n\n${brief}` : brief;
  };
  if (!contextPack || !inputs) return testsOnly();
  const prefixes = kind === 'ci-heal' ? TRIM_SECTIONS['ci-heal']
    : [...TRIM_SECTIONS.fix, ...(!inputs.findings?.length ? [] : inputs.advisory ? TRIM_SECTIONS.fixAdvisory : TRIM_SECTIONS.fixNonAdvisory)];
  const trimmed = trimBriefSections(brief, prefixes);
  // The brief never grows: the pack's budget is the smaller of the setting and the bytes the trim freed.
  const maxBytes = Math.min(contextMaxBytes, trimmed.removedBytes);
  const pack = kind === 'ci-heal'
    ? renderCiPack({ ...inputs, maxBytes, localTests, removed: trimmed.removed })
    : renderFixPack({ ...inputs, lines: contextLines, maxBytes, localTests, removed: trimmed.removed });
  if (!pack) return testsOnly();
  // The pack is applied to the TEMPLATE, before `fillBrief`: a `{{NAME}}` inside quoted reviewer text or code (a
  // finding on a brief template itself) must stay literal, so a word joiner breaks the token shape.
  return `${escapeTokens ? pack.replace(/\{\{/g, '{\u2060{') : pack}\n\n---\n\n${trimmed.text}`;
}

// ---------------------------------------------------------------------------------------------------------------
// IO (never throws; hermetic under test unless a reader is injected)

const GH_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 32 * 1024 * 1024 };

/** IO: the fix pack's inputs — the complete (paginated) comment thread, one `gh pr view` (files, head, labels), and one
 *  raw-contents read per named file. Only a trusted author's (automation / operator) finding comment is staged. */
export function readFixPackInputs({ repoSlug, pr, exec, maxRefs = 4, readComments = readCompletePrComments, isTrusted = isTrustedMarkerAuthor }) {
  const pv = JSON.parse(String(exec('gh', ['pr', 'view', String(pr), '--repo', repoSlug, '--json', 'files,headRefOid,labels'], GH_OPTS)));
  const comments = readComments(pr, { repo: repoSlug, exec });
  const { findings, advisory } = extractFindings(comments ?? [], { labels: pv.labels ?? null, isTrusted });
  const files = (pv.files ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
  const refs = extractFileRefs(findings.map((f) => f.body).join('\n'), { changedPaths: files.map((f) => f.path), max: maxRefs });
  const cache = new Map();
  const fileText = (path) => {
    if (cache.has(path)) return cache.get(path);
    let t = null;
    try {
      t = String(exec('gh', ['api', '-H', 'Accept: application/vnd.github.raw',
        `repos/${repoSlug}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${pv.headRefOid}`], GH_OPTS));
    } catch { t = null; }
    cache.set(path, t);
    return t;
  };
  for (const r of refs) fileText(r.path); // read once, here, so the PURE render needs no IO
  return { findings, advisory, refs, files, headSha: pv.headRefOid ?? null, fileText: (p) => cache.get(p) ?? null };
}

/** IO: the ci-heal pack's inputs — the failing checks, the first failing job's failed log, the changed files. */
export function readCiPackInputs({ repoSlug, pr, exec }) {
  let checks = [];
  try {
    checks = JSON.parse(String(exec('gh', ['pr', 'checks', String(pr), '--repo', repoSlug, '--json', 'name,bucket,link'], GH_OPTS)));
  } catch (e) {
    // `gh pr checks` exits 8 when a check is failing/pending but still prints the JSON.
    try { checks = JSON.parse(String(e?.stdout ?? '')); } catch { checks = []; }
  }
  const failing = (Array.isArray(checks) ? checks : []).filter((c) => c?.bucket === 'fail').map((c) => ({ name: c.name, link: c.link ?? '' }));
  let logTail = '';
  const job = failing.map((c) => /\/actions\/runs\/\d+\/job\/(\d+)/.exec(c.link)?.[1]).find(Boolean);
  if (job) {
    try {
      const log = String(exec('gh', ['run', 'view', '--job', job, '--log-failed', '--repo', repoSlug], GH_OPTS));
      logTail = log.split('\n').slice(-400).map((l) => l.replace(/^[^\t]*\t[^\t]*\t(?:\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z\s?)?/, '')).join('\n');
    } catch { logTail = ''; }
  }
  let files = [];
  try {
    const pv = JSON.parse(String(exec('gh', ['pr', 'view', String(pr), '--repo', repoSlug, '--json', 'files'], GH_OPTS)));
    files = (pv.files ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
  } catch { files = []; }
  return { checks: failing, failedTests: extractFailedTests(logTail), logTail, files };
}

/**
 * The dispatch-side entry: resolve the settings, read the inputs (only when the pack is on), apply. Never throws —
 * any read failure returns the brief with at most the tests rule added.
 * @param {string} brief the filled brief
 * @param {{kind:'fix'|'ci-heal', repoSlug:string, pr:number, exec:Function, readInputs?:Function, settings?:object, env?:object}} o
 */
export function briefWithContextPack(brief, { kind = 'fix', repoSlug: slug, repo, toSlug, pr, exec, readInputs, settings, env = process.env } = {}) {
  // Hermetic under a test runner: a test that wants the pack injects its settings or its reader.
  if (isUnderTest(env) && !settings && !readInputs) return brief;
  let repoSlug = slug;
  if (!repoSlug && toSlug) { try { repoSlug = toSlug(repo); } catch { repoSlug = null; } }
  let resolved;
  try { resolved = settings ? { value: settings, sources: {}, invalid: [] } : resolveContextPackSettings({ env }); } catch { return brief; }
  if (!settings) { try { logContextPackSettings(resolved, { env }); } catch { /* log is best effort */ } }
  let inputs = null;
  if (resolved.value.contextPack) {
    const read = readInputs ?? (isUnderTest(env) ? null : (o) => (kind === 'ci-heal' ? readCiPackInputs(o) : readFixPackInputs(o)));
    try { inputs = read && (repoSlug || readInputs) ? read({ repoSlug, pr, exec }) : null; } catch { inputs = null; }
  }
  try { return applyContextPack(brief, { kind, settings: resolved.value, inputs }); } catch { return brief; }
}
