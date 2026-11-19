#!/usr/bin/env node
/**
 * @file check-memory.mjs — memory-management gate (backlog #1517, policy: docs/agent/memory-management.md).
 *
 * Enforces the budget on the agent's always-loaded memory index (`MEMORY.md`): it is injected into every
 * session and the harness SILENTLY TRUNCATES it over the size limit, so a bloated index drops load-bearing
 * rules with no warning. Detail belongs in the on-demand topic files; the index stays a bounded set of
 * one-line pointers.
 *
 * Two modes (mirrors lint-locus-prefix.mjs):
 *   • default (SWEEP) — `npm run check:memory`: read the memory dir, check the budget table + pointer
 *     integrity, exit 2 on any violation. Folded into close-out.
 *   • `--pre` — the PreToolUse(Edit|Write) GATE: reconstruct the PROPOSED post-edit MEMORY.md from the hook
 *     event JSON on stdin and exit 2 (deny the write) if it would breach the size / per-line budget BEFORE
 *     it lands. Fails open on a non-MEMORY.md target or an unparseable event.
 *
 * Memory dir is derived from the repo root (the per-project key is the abs path with '/' → '-'); if it
 * doesn't exist (different machine / layout) the gate is a no-op rather than a failure.
 */
import { hookRoot } from './lib/hook-root.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLineSync } from './lib/write-all-sync.mjs';
import { scrubPublish } from './lib/secret-scrub.mjs';

const ROOT = hookRoot(import.meta.url);

// Budget — keep in sync with docs/agent/memory-management.md.
const MAX_BYTES = 22 * 1024;   // hard ceiling, headroom under the ~24.4 KB harness truncation limit
const WARN_BYTES = 20 * 1024;  // advisory
const MAX_LINE = 200;          // per index line: title + one short hook

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const PROJECT_KEY = ROOT.replace(/\//g, '-');
const USER_MEM_DIR = join(HOME, '.claude', 'projects', PROJECT_KEY, 'memory');
// Repo-local memory dir (committed to git, always present in lane clones): fall back when the
// user-level project memory dir does not exist for this clone path (e.g. lane clones have a
// different PROJECT_KEY that has no harness-written memory dir).
const REPO_MEM_DIR = join(ROOT, '.claude', 'agent-memory');
const MEM_DIR = existsSync(USER_MEM_DIR) ? USER_MEM_DIR : (existsSync(REPO_MEM_DIR) ? REPO_MEM_DIR : USER_MEM_DIR);
const INDEX = join(MEM_DIR, 'MEMORY.md');

/** Size + per-line checks on a MEMORY.md string. Returns an array of violation strings. Exported (#2273)
 *  so the Tier-A golden-corpus snapshot harness can assert a mined MEMORY.md fixture stays inside the
 *  budget this gate enforces, without re-deriving the MAX_BYTES/MAX_LINE constants a second time. */
export function checkBudget(content) {
  const v = [];
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BYTES) v.push(`index is ${(bytes / 1024).toFixed(1)} KB — over the ${(MAX_BYTES / 1024)} KB budget (trim lines / right-home to platform-decisions.md / consolidate a cluster)`);
  const lines = content.split('\n');
  lines.forEach((ln, i) => {
    if (ln.length > MAX_LINE) v.push(`line ${i + 1} is ${ln.length} chars (> ${MAX_LINE}) — shorten the hook, move detail to the topic file: ${ln.slice(0, 60)}…`);
  });
  return { v, bytes };
}

/**
 * Is `file` the always-loaded memory INDEX? Pure + exported so the write-time gate's target match is
 * TESTABLE — it previously lived inline as `/\/memory\/MEMORY\.md$/`, which matched only the user-level
 * spelling. #2266 moved the corpus to `agent-memory-src/` and this predicate did not follow, so the gate
 * has been DEAD for every lane-clone edit — i.e. for the only place memory is allowed to be edited at all
 * (edit-work runs in a lane clone; a lane has a different PROJECT_KEY and no user-level memory dir, which
 * is exactly why MEM_DIR above already grew the REPO_MEM_DIR fallback. The sweep half was made lane-aware;
 * this half was not).
 *
 * ONE corpus, THREE spellings, each of which a hook event can legitimately carry:
 *   • `~/.claude/projects/<key>/memory/MEMORY.md` — the user-level harness dir (a symlink; primary only)
 *   • `<root>/.claude/agent-memory/MEMORY.md`     — the in-repo symlink
 *   • `<root>/agent-memory-src/MEMORY.md`         — the tracked source of truth (what a lane clone edits)
 *
 * Match the SPELLING, never the resolved realpath: the hook event carries the path the tool was called
 * with, and a lane-clone write to `agent-memory-src/MEMORY.md` never traverses a symlink to resolve.
 */
export function isMemoryIndexPath(file) {
  return typeof file === 'string'
    && /(?:^|\/)(?:memory|agent-memory|agent-memory-src)\/MEMORY\.md$/.test(file);
}

/**
 * Is `file` ANY file in the memory corpus — the index, a category sub-index, or a numbered topic file?
 * Same three directory spellings as `isMemoryIndexPath`, widened past `MEMORY.md` to every `*.md` leaf.
 *
 * WHY IT EXISTS (#3015). The memory corpus is COMMITTED and PUSHED, and — unlike the backlog — it has no
 * CLI writer to mirror the gate into: memory topic files are hand-authored with the `Write`/`Edit` tools
 * only. So this PreToolUse hook is the ONLY write-time gate they have, and it had been scoped to the index
 * alone, which is a budget concern, not a leak concern. The BUDGET / tree-shape rules stay index-only (they
 * are about the always-loaded file); the SECRET scrub applies to the whole corpus.
 */
export function isMemoryCorpusPath(file) {
  return typeof file === 'string'
    && /(?:^|\/)(?:memory|agent-memory|agent-memory-src)\/[^/]+\.md$/.test(file);
}

// #2273 — guard the CLI body behind an entry-point check (mirrors scripts/guard-bash.mjs) so importing
// this module for its pure `checkBudget` export (the Tier-A golden-corpus snapshot harness) never also
// runs the sweep / --pre gate / `process.exit(...)` as a side effect of the import.
const IS_CLI = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_CLI) {

// ── --pre: write-time gate on the hook event ────────────────────────────────────────────────
if (process.argv.includes('--pre')) {
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
  const file = ev?.tool_input?.file_path;
  if (!isMemoryCorpusPath(file)) process.exit(0); // not a memory-corpus file
  const isIndex = isMemoryIndexPath(file);
  const ti = ev.tool_input ?? {};
  const onDisk = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let proposed;
  if (ev.tool_name === 'Write' || typeof ti.content === 'string') {
    proposed = ti.content ?? '';
  } else if (ev.tool_name === 'Edit' && typeof ti.old_string === 'string') {
    proposed = onDisk.includes(ti.old_string)
      ? (ti.replace_all ? onDisk.split(ti.old_string).join(ti.new_string ?? '') : onDisk.replace(ti.old_string, ti.new_string ?? ''))
      : (ti.new_string ?? onDisk);
  } else {
    proposed = ti.content ?? ti.new_string ?? onDisk;
  }
  // #3015 — the PUBLISH-SEAM secret gate, on the WHOLE corpus (index + sub-indexes + topic files). Memory
  // files are committed and pushed and have no CLI writer, so this hook is their only write-time gate.
  // `scrubPublish` is corpus-calibrated and deliberately narrower than the learnings append-seam scrub: it
  // does NOT object to code, repo paths, or the `we:`-prefixed citations a grounded memory note requires.
  const leaks = scrubPublish(proposed);
  if (leaks.length) {
    console.error(`check:memory (--pre): this edit would write ${leaks.join('; ')} into the memory corpus (#3015). Memory files are COMMITTED and PUSHED, so a credential in one is a published credential. Remove the value (and rotate it if it was ever real) and describe it in words instead of pasting it.`);
    process.exit(2);
  }
  // Everything below is INDEX-ONLY — the budget exists because MEMORY.md is injected into every session.
  if (!isIndex) process.exit(0);
  const { v } = checkBudget(proposed);
  // Tree-shape gate (write-time): deny NEWLY-introduced leaf links into the always-loaded MEMORY.md map.
  // The default sweep flags absolute presence; here we block only leaf links not already on disk, so
  // pre-existing drift doesn't lock the file and a cleanup edit (which REMOVES leaf links) still passes.
  // This is the write-time twin of the sweep's tree-shape rule — the map links only index-*.md sub-indexes.
  const leafLinks = (s) => {
    const out = new Set(); const re = /\]\(([^)]+\.md)\)/g; let m;
    for (const ln of s.split('\n')) { while ((m = re.exec(ln))) if (!/^index-.*\.md$/.test(m[1])) out.add(m[1]); }
    return out;
  };
  const before = leafLinks(onDisk);
  for (const f of leafLinks(proposed)) {
    if (!before.has(f)) v.push(`would add a leaf link (${f}) to the always-loaded MEMORY.md map — the map links only index-*.md sub-indexes; add this rule as a "- N. Title — hook" line in its category sub-index instead (docs/agent/memory-management.md)`);
  }
  if (!v.length) process.exit(0);
  console.error(`check:memory (--pre): this edit would violate the MEMORY.md index policy (#1517; docs/agent/memory-management.md):\n  - ${v.join('\n  - ')}\nFix before saving — prune/merge an entry, move detail to the topic file, or home the rule in a sub-index.`);
  process.exit(2);
}

// ── default: full sweep ─────────────────────────────────────────────────────────────────────
if (!existsSync(MEM_DIR) || !existsSync(INDEX)) {
  console.log(`check:memory — no memory index at ${INDEX} (n/a); skipping.`);
  process.exit(0);
}

const content = readFileSync(INDEX, 'utf8');
const { v, bytes } = checkBudget(content);

// Pointer integrity across the index TREE: the always-loaded MEMORY.md map + every recall-gated
// `index-<category>.md` sub-index. A leaf is "indexed" if it is linked (markdown) OR referenced by its
// stable number prefix (`- N.`) from any of those index files; a sub-index must itself be linked from
// MEMORY.md (else it's unreachable). This lets the index be a tree (lazy per category) and lets leaf
// lines drop the long filename for a bare `- N.` number (resolved via scripts/memory-resolve.mjs).
const topicFiles = readdirSync(MEM_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
const numberedFiles = new Map(); // "N" -> "N-slug.md"
for (const f of topicFiles) { const m = f.match(/^(\d+)-/); if (m) numberedFiles.set(m[1], f); }
const isSubIndex = (f) => /^index-.*\.md$/.test(f);
const indexSources = ['MEMORY.md', ...topicFiles.filter(isSubIndex)];
const indexed = new Set();
for (const src of indexSources) {
  readFileSync(join(MEM_DIR, src), 'utf8').split('\n').forEach((ln, i) => {
    let m; const lre = /\]\(([^)]+\.md)\)/g;
    while ((m = lre.exec(ln))) {
      indexed.add(m[1]);
      if (!existsSync(join(MEM_DIR, m[1]))) v.push(`${src} line ${i + 1} points to a missing file: ${m[1]}`);
      // Tree shape: the always-loaded MEMORY.md links ONLY category sub-indexes — a leaf link here would
      // regrow the always-loaded surface (the regression the tree exists to prevent).
      if (src === 'MEMORY.md' && !/^index-.*\.md$/.test(m[1]))
        v.push(`MEMORY.md line ${i + 1} links a leaf (${m[1]}) — the map links only index-*.md sub-indexes; put this rule as a "- N. Title — hook" line in its sub-index instead`);
    }
    const nm = ln.match(/^\s*-\s*(\d+)\.\s/);
    if (nm) {
      const file = numberedFiles.get(nm[1]);
      if (file) indexed.add(file);
      else v.push(`${src} line ${i + 1} references #${nm[1]} but no ${nm[1]}-*.md leaf exists`);
    }
  });
}
const orphans = topicFiles.filter((f) => !indexed.has(f));
for (const f of orphans) v.push(`topic file not reachable from any index: ${f} (link it from MEMORY.md, or add a \`- N.\` line in its sub-index)`);

const lineCount = content.split('\n').filter((l) => l.trim()).length;

// Front-A watch metrics (#1880, model-usage watch #1855): corpus skew by type — a redundancy-likelihood
// signal (a type bucket far larger than the others is where dedup/right-home pressure lives).
const TYPES = ['feedback', 'project', 'user', 'reference'];
const skew = Object.fromEntries(TYPES.map((t) => [t, topicFiles.filter((f) => { const s = f.replace(/^\d+-/, ''); return s.startsWith(`${t}_`) || s === `${t}.md`; }).length]));
const metrics = {
  indexBytes: bytes,
  indexKB: +(bytes / 1024).toFixed(1),
  budgetKB: MAX_BYTES / 1024,
  headroomBytes: MAX_BYTES - bytes,
  lineCount,
  topicFiles: topicFiles.length,
  orphanCount: orphans.length,
  orphans,
  corpusSkew: skew,
  violations: v.length,
  ok: v.length === 0,
};

// `--json` (#1880): emit the front-A metrics as one object for the watch to consume, instead of a
// sequence of greps. Still exits non-zero on a violation so it stays a usable gate.
if (process.argv.includes('--json')) {
  writeLineSync(1, JSON.stringify(metrics, null, 2));
  process.exit(v.length ? 2 : 0);
}

console.log(`check:memory — index ${(bytes / 1024).toFixed(1)} KB / ${lineCount} lines / ${topicFiles.length} topic files (budget ${MAX_BYTES / 1024} KB, ≤ ${MAX_LINE} chars/line)`);
console.log(`  corpus: ${TYPES.map((t) => `${skew[t]} ${t}`).join(' · ')}${orphans.length ? ` · ${orphans.length} orphan(s)` : ''}`);

if (v.length) {
  console.error(`\n✗ ${v.length} memory-budget violation(s) (#1517; docs/agent/memory-management.md):\n  - ${v.join('\n  - ')}`);
  process.exit(2);
}
if (bytes > WARN_BYTES) console.warn(`  ⚠ ${(bytes / 1024).toFixed(1)} KB — within budget but past the ${WARN_BYTES / 1024} KB warn line; consider right-homing a project rule.`);
console.log('✓ memory index within budget.');
process.exit(0);

} // IS_CLI
