#!/usr/bin/env node
/**
 * backlog-renumber-collisions.mjs — the merge-time NEW-ITEM id-collision renumber (#2071).
 *
 * The CLI half of scripts/backlog/renumber-collisions.mjs (the pure core). Parallel `/workflow` lanes
 * partition edits to existing files but NOT id allocation for newly-created items: two lanes branching
 * from the same base both compute `max(existing)+1` and can't see each other's not-yet-existing file,
 * so when both land they collide on `#NNN`. The disjointness checker is blind to it (the new file's path
 * is in no lane's write-set at partition time); it surfaces only at the standards gate (`ids must be
 * unique`) and as an 11ty output conflict, AFTER both landed on main.
 *
 * This detects that collision on the merged tree and, per the sanctioned "newer yields" rule (backlog
 * NNN ids are immutable), YIELDS the later-landing colliding new item to the next free id — done as a
 * REFILE (fs write of the new file + fs unlink of the old), NOT a `git mv` (which guard-bash blocks as
 * an illegal renumber; the fs write from THIS sanctioned script bypasses the SHELL guard). It then
 * rewrites every inbound reference to the yielded id — `#NNN` short-refs, `/backlog/NNN[/-]` URLs,
 * `parent:`/`blockedBy:` frontmatter edges — across the whole corpus, so no link is left dangling.
 *
 * Which of two colliding files is the "later-landing" one is decided by git: each file's landing ordinal
 * is the commit time of the FIRST commit that introduced it on the current branch (`git log --diff-filter=A
 * --follow`), higher = later. When git can't attribute a file (uncommitted, or --no-git), ordinal 0 falls
 * back to a slug-lexicographic tie-break so the choice stays deterministic.
 *
 * BOUNDARIES (#2071): only NEW-item collisions. An id present in the batch base (`--base-ref` or
 * `--base-nums`) is a pre-existing item — a base id appearing twice is a real EDIT conflict git already
 * flagged, never an allocation race — and is NEVER yielded or reused. Idempotent: no collision ⇒ no-op.
 *
 * Usage:
 *   node scripts/backlog-renumber-collisions.mjs [--base-ref=lane/_base-<slug>] [--base-nums=2068,2070]
 *                                                [--dry-run] [--no-git] [--json]
 *   --base-ref   a git ref whose backlog/*.md ids are the batch base (never yielded/reused). Preferred:
 *                the parallel run's `lane/_base-<slug>` ref carries exactly the pre-batch id set.
 *   --base-nums  explicit comma-separated base ids (alternative to --base-ref, e.g. in a test).
 *   --dry-run    print the plan; write nothing.
 *   --no-git     skip git ordinal derivation (slug tie-break only) — for a non-git tree / test.
 *   --json       machine-readable result.
 * Exit 0 whether or not it renumbered (a no-op is success); non-zero only on an internal error.
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRenumber, parseBacklogFilename, findCollisions } from './backlog/renumber-collisions.mjs';
import { collisionNumberingConstraints, reserveCollisionNumbers } from './lib/card-number-allocator.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'backlog');
const RED = '\x1b[31m', GRN = '\x1b[32m', YEL = '\x1b[33m', DIM = '\x1b[2m', BLD = '\x1b[1m', RST = '\x1b[0m';

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes('--json');
const DRY = argv.includes('--dry-run');
const NO_GIT = argv.includes('--no-git');
const flag = (name) => { const m = argv.find((a) => a.startsWith(`--${name}=`)); return m ? m.slice(name.length + 3) : undefined; };

/** Every `backlog/NNN-slug.md` basename currently on disk. */
function backlogFilenames() {
  return readdirSync(DIR).filter((f) => f.endsWith('.md') && parseBacklogFilename(f));
}

/**
 * Landing ordinal per file = the commit time (unix seconds) of the FIRST commit that added it on the
 * current branch. Higher = later-landing → the one that yields. Derived in ONE `git log` pass over the
 * backlog dir (add-diffs only), so it costs one git call regardless of file count. A file git can't
 * attribute (uncommitted) keeps ordinal 0 and defers to the core's slug tie-break.
 */
function gitOrdinals() {
  const ord = new Map();
  if (NO_GIT) return ord;
  try {
    // For each add-commit, print its unix time then the added paths. We walk oldest→newest so a later
    // re-add can't lower an earlier ordinal; first-seen wins per file (the true introduction).
    const out = execFileSync(
      'git',
      ['log', '--reverse', '--diff-filter=A', '--format=@%ct', '--name-only', '--', 'backlog/'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    let t = 0;
    for (const line of out.split('\n')) {
      if (line.startsWith('@')) { t = Number(line.slice(1)) || 0; continue; }
      const m = line.match(/^backlog\/(.+\.md)$/);
      if (m && !ord.has(m[1])) ord.set(m[1], t);
    }
  } catch {
    // Not a git tree / git unavailable → all ordinals 0 (slug tie-break). Not an error.
  }
  return ord;
}

/** Base ids: from --base-nums (explicit) or the backlog ids present at --base-ref (a git ref). */
function baseNums() {
  const explicit = flag('base-nums');
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean);
  const ref = flag('base-ref');
  if (!ref) return [];
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', ref, '--', 'backlog/'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const nums = [];
    for (const line of out.split('\0')) {
      const m = line.match(/^backlog\/(\d+)-[^/]+\.md$/);
      if (m) nums.push(m[1]);
    }
    return nums;
  } catch {
    process.stderr.write(`${YEL}⚠ could not read base ids from ref "${ref}" (${DIM}not found?${RST}${YEL}) — proceeding with no base guard.${RST}\n`);
    return [];
  }
}

/** #2213 — backlog basenames PUBLISHED on the branch being landed onto (`--onto-ref`). Those files are
 *  immutable keepers, so a colliding NEW file (not among them) yields — never a live main item. */
function ontoNames() {
  const ref = flag('onto-ref');
  if (!ref) return [];
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', ref, '--', 'backlog/'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').map((l) => l.match(/^backlog\/(\d+-[^/]+\.md)$/)?.[1]).filter(Boolean);
  } catch {
    process.stderr.write(`${YEL}⚠ could not read published ids from onto-ref "${ref}" (${DIM}not found?${RST}${YEL}) — proceeding with the ordinal heuristic.${RST}\n`);
    return [];
  }
}

function main() {
  const names = backlogFilenames();
  const ordinals = gitOrdinals();
  const files = names.map((name) => ({
    name,
    text: readFileSync(join(DIR, name), 'utf8'),
    ordinal: ordinals.get(name) ?? 0,
  }));
  const base = baseNums();
  const onto = ontoNames();
  const baseSet = new Set(base);
  const ontoSet = new Set(onto);
  // Match the planner's published/base guards without allocating a provisional
  // number: a local max+1 could be exhausted even when a remote gap is usable.
  const needsNumber = findCollisions(files).some(({ num, files: group }) => {
    const hasPublished = group.some(({ name }) => ontoSet.has(name));
    return hasPublished ? group.some(({ name }) => !ontoSet.has(name)) : !baseSet.has(num);
  });
  if (!needsNumber) {
    if (JSON_MODE) process.stdout.write(JSON.stringify({ renumbered: [], writes: 0, deletes: 0, noop: true }) + '\n');
    else process.stdout.write(`${GRN}✓${RST} No new-item id collision on the merged tree — no-op.\n`);
    return 0;
  }
  const numberingGit = (args, options = {}) => execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options,
  });
  const constraints = collisionNumberingConstraints(numberingGit);
  const plan = planRenumber(files, { baseNums: base, ontoNames: onto, ...constraints });

  if (DRY) {
    if (JSON_MODE) process.stdout.write(JSON.stringify({ dryRun: true, ...planSummary(plan) }) + '\n');
    else process.stdout.write(`${BLD}Renumber plan (dry-run — nothing written):${RST}\n${plan.summary}\n`);
    return 0;
  }

  reserveCollisionNumbers(plan, numberingGit, constraints.reservationRemote);

  // Execute the refile: write every touched/new file, then unlink each yielded old file. fs ops — the
  // guard-bash `git mv`/`rm` block is on SHELL commands, not this sanctioned script's fs writes.
  // #2546 — last-line data-loss backstop: `planRenumber` already asserts every write is content-preserving,
  // but validate the whole write set is non-empty BEFORE touching disk (a pre-pass, so the abort is truly
  // "nothing written" — never a partial refile) even if a future plan path slips a corrupt/empty write past.
  for (const w of plan.writes) {
    if (!w.text || w.text.length === 0) {
      throw new Error(`refusing to blank ${w.name} — empty rewrite content (data loss). No file written. (#2546)`);
    }
  }
  for (const w of plan.writes) writeFileSync(join(DIR, w.name), w.text);
  for (const d of plan.deletes) {
    // Only unlink the old yielded file if its new file was actually written (never orphan-delete).
    const wrote = plan.collisions.find((c) => c.oldName === d);
    if (wrote && plan.writes.some((w) => w.name === wrote.newName)) unlinkSync(join(DIR, d));
  }

  if (JSON_MODE) process.stdout.write(JSON.stringify(planSummary(plan)) + '\n');
  else {
    process.stdout.write(`${BLD}Renumbered ${plan.collisions.length} collided new item(s):${RST}\n${plan.summary}\n`);
    process.stdout.write(`${DIM}${plan.writes.length} file(s) rewritten, ${plan.deletes.length} old file(s) removed. Re-run the standards gate to confirm green.${RST}\n`);
  }
  return 0;
}

function planSummary(plan) {
  return {
    renumbered: plan.collisions.map((c) => ({ oldNum: c.oldNum, newNum: c.newNum, oldName: c.oldName, newName: c.newName })),
    writes: plan.writes.length,
    deletes: plan.deletes.length,
    // #2312 — the EXPLICIT `backlog/*.md` basenames this run touched (every write + delete), so a caller that
    // commits the heal on-disk (pr-land.mjs's `runHeal`) can scope its `git add` pathspec to exactly these
    // paths instead of a bare `git diff --name-only` — which would sweep in ANY OTHER dirty tracked file the
    // checkout happens to carry (a concurrent session's in-flight work in the same primary checkout, #2301).
    writePaths: plan.writes.map((w) => w.name),
    deletePaths: plan.deletes.slice(),
    noop: false,
  };
}

try {
  process.exitCode = main();
} catch (e) {
  process.stderr.write(`${RED}✗ renumber-collisions failed:${RST} ${e && e.message ? e.message : e}\n`);
  process.exit(2);
}
