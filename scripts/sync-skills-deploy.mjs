#!/usr/bin/env node
/**
 * sync-skills-deploy.mjs — #2579.
 *
 * The bug this closes: a fix under `we:skills-src/<skill>/` (the skills SoT, #2265/#2266) lands on `main`
 * but does NOT take effect anywhere the agent reads skills from the user's machine-global
 * `~/.claude/skills/` tree — that copy is a plain, one-time hand-copy, not a symlink and not kept in sync.
 * (This repo's OWN `we:.claude/skills` is already a symlink to `skills-src/`, so it never drifts — only the
 * cross-repo home deploy needs a sync mechanism.) Concretely: this session's
 * `skills-src/closing-session/session-cost.mjs` rate fix merged to `main` but `~/.claude/skills/closing-session`
 * kept serving the old 3x-inflated numbers until it was caught and hand-synced at close.
 *
 * WHAT IT DEPLOYS: by default, only skill dirs that are ALREADY present under the deploy root (so this
 * script never silently makes a WE-repo-specific orchestration skill — batch-backlog-items, drain, jury,
 * pr, … — globally available in an unrelated repo; those stay project-local via the `.claude/skills`
 * symlink). Pass --all to deploy every skills-src/* entry (bootstrapping a new machine, or deliberately
 * promoting a skill to global), or --only=name1,name2 to scope to specific skills.
 *
 * WHAT IT COPIES: per skill, only the files `git` tracks under `skills-src/<skill>/` — never a gitignored
 * runtime/local-state file (batch-backlog-items' claims.json/reservations.json/capacity.json are per-repo
 * orchestrator state, not part of the portable skill definition, and must never leave this repo). Tracked
 * files are added and updated at the deploy target. DELETION IS OPT-IN (`--prune`, #2579 review): the deploy
 * root is the user's own machine-global tree, so a stale file there is reported, never silently destroyed —
 * an automatic `remove` sweep would let a plain `git pull` wipe a user's local notes/overrides inside a
 * same-named skill dir. Stale files ARE surfaced: `formatPlans` prints a `STALE <skill>` line naming each
 * one, `--json` carries them per-skill plus `staleFiles`/`staleSkills` totals, and `--check` exits 1 on
 * them — so opt-in deletion costs visibility of nothing (#2579 review r2: this control was documented
 * before it existed, and `plan.stale` was computed but consumed nowhere).
 *
 * Usage:
 *   node scripts/sync-skills-deploy.mjs                  # sync every skill already deployed at ~/.claude/skills
 *   node scripts/sync-skills-deploy.mjs --all             # also deploy skills-src entries not yet present there
 *   node scripts/sync-skills-deploy.mjs --only=closing-session,drain
 *   node scripts/sync-skills-deploy.mjs --check           # report drift only, write nothing; exit 1 if any found
 *   node scripts/sync-skills-deploy.mjs --dry-run         # print planned actions, write nothing; exit 0
 *   node scripts/sync-skills-deploy.mjs --prune           # ALSO delete deploy-root files no longer tracked in source
 *   node scripts/sync-skills-deploy.mjs --json            # machine-readable summary on stdout
 *
 * WE_SKILLS_DEPLOY_DIR overrides the deploy root (tests / a non-default machine layout).
 *
 * Wired: `npm run skills:sync` / `npm run skills:sync:check` (package.json), and auto-invoked by
 * `.githooks/post-merge` whenever a merge touches `skills-src/` — so a landed skill fix is live without a
 * manual hand-sync.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const SRC_ROOT = path.join(REPO_ROOT, 'skills-src');

export function deployRoot(env = process.env) {
  return env.WE_SKILLS_DEPLOY_DIR
    ? path.resolve(env.WE_SKILLS_DEPLOY_DIR)
    : path.join(os.homedir(), '.claude', 'skills');
}

export function parseArgs(argv) {
  const args = { all: false, check: false, dryRun: false, json: false, prune: false, only: null, roots: [] };
  for (const raw of argv) {
    if (raw.startsWith('--root=')) args.roots.push(raw.slice('--root='.length));
    else if (raw === '--all') args.all = true;
    else if (raw === '--check') args.check = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--json') args.json = true;
    // #2579 review — deletion of stale deploy files is OPT-IN; the post-merge hook never passes it.
    else if (raw === '--prune') args.prune = true;
    else if (raw.startsWith('--only=')) {
      args.only = raw.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else throw new Error(`sync-skills-deploy: unrecognised arg "${raw}"`);
  }
  return args;
}

/** Every file under `dir`, recursively, as paths relative to `dir` (posix-joined). Empty array if `dir` is absent. */
export function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out;
}

/** The files `git` tracks under `srcDir`, as paths relative to `srcDir`. */
export function gitTrackedFiles(srcDir, repoRoot = REPO_ROOT) {
  const relToRepo = path.relative(repoRoot, srcDir);
  const out = execFileSync('git', ['ls-files', '--', relToRepo], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((p) => path.relative(relToRepo, p));
}

/**
 * Pure diff: given the set of tracked-relative-paths for a skill and its src/dest dirs on disk, return the
 * add/update/remove actions that bring dest into sync with src. No git call here (testable with plain tmp dirs).
 */
export function planSkill({ name, srcDir, destDir, trackedRel, prune = false, destRoot = destDir }) {
  const trackedSet = new Set(trackedRel);
  const destExisting = listFilesRecursive(destDir);
  const actions = [];
  for (const rel of trackedRel) {
    const srcFile = path.join(srcDir, rel);
    const destFile = path.join(destDir, rel);
    const srcBuf = fs.readFileSync(srcFile);
    const existed = fs.existsSync(destFile);
    const same = existed && srcBuf.equals(fs.readFileSync(destFile));
    if (!same) actions.push({ type: existed ? 'update' : 'add', rel });
  }
  // #2579 review — DELETION IS OPT-IN (`--prune`), never the default. Previously every file at the deploy
  // target that was not git-tracked in `skills-src/` became an unconditional `remove`, and the post-merge
  // hook applied that plan automatically with no confirmation — so an ordinary `git pull` could silently
  // destroy a user's own files inside a same-named `~/.claude/skills/<skill>/` directory (notes, local
  // overrides, anything a skill wrote at runtime). Syncing the fix does not require deleting; the item's
  // goal ("a merged skill fix is actually live") is met by add/update alone. Stale files are reported by
  // `--check` and removed only when the operator explicitly asks.
  const stale = destExisting.filter((rel) => !trackedSet.has(rel));
  if (prune) for (const rel of stale) actions.push({ type: 'remove', rel });
  return { name, srcDir, destDir, destRoot, actions, stale, pruned: prune, alreadyDeployed: fs.existsSync(destDir) };
}

/**
 * #2579 review — refuse any write/delete whose path escapes `root`.
 *
 * `~/.claude` is a tree people symlink parts of (this repo's own `.claude/skills` is a symlink), and dest
 * paths are built from the SOURCE file list rather than by walking dest — so a symlinked intermediate
 * directory under the deploy root made `mkdirSync(…, {recursive:true})` a no-op on the existing link and
 * `copyFileSync` follow it, writing OUTSIDE the deploy root entirely. Resolve the deepest EXISTING ancestor
 * with `realpathSync` (the target itself usually does not exist yet) and require the result to stay inside
 * the realpath'd root. Fails CLOSED: an unresolvable path is refused, never written.
 *
 * Blocker fix (PR #1024 review) — the containment check MUST be against the deploy ROOT (`plan.destRoot`),
 * never `plan.destDir`. A per-skill `destDir` can itself be a symlink (this repo's own layout: a home
 * `~/.claude/skills/<skill>` entry symlinked straight to a `skills-src/<skill>` dir). Checking a target
 * against `destDir` walks BOTH sides through the same symlink and always reports "contained" — a tautology
 * that let a stale-lane sync overwrite this repo's own `skills-src/drain/SKILL.md` and let `--prune` delete
 * files outside any real deploy tree. Checking against the resolved deploy root instead catches a `destDir`
 * that itself resolves outside where the operator's `~/.claude/skills` (or `WE_SKILLS_DEPLOY_DIR`) really is.
 */
// PR #1024 blocker fix — the hand-rolled symlink walk below follows one `readlinkSync` hop at a time and
// none of those calls goes through the kernel's own bounded path resolution, so the OS's usual ELOOP
// protection never fires: each individual `readlinkSync(probe)` succeeds and returns a perfectly valid
// target, so a 2-node cycle (`a` -> `b`, `b` -> `a`) loops forever. Reproduced live: wired into
// `.githooks/post-merge`, that hang wedges `git pull` / `git merge` indefinitely. Cap the hop count at the
// same order of magnitude as the kernel's own limit (Linux/macOS use 40) and fail with a clear error the
// instant it's exceeded, instead of spinning.
const MAX_SYMLINK_HOPS = 40;

/** Resolve `p` through symlinks as far as it EXISTS, re-appending the not-yet-created tail. Pure-ish (fs reads
 *  only). Used for both sides of the containment compare, since a first deploy creates the root and the leaf. */
function realpathDeepest(p) {
  let probe = path.resolve(p);
  const parts = [];
  let hops = 0;
  for (;;) {
    // #2579 review — probe with `lstat`, NOT `existsSync`. `existsSync` FOLLOWS the link and answers false
    // for a DANGLING symlink, so the walk stepped straight past a broken link without resolving it and
    // returned a path that merely LOOKED contained — while the subsequent `copyFileSync` still followed the
    // link and wrote outside the deploy root. Verified: the guard allowed `dest/nested/x.md` where `nested`
    // was a dangling link to an outside dir. `lstat` sees the link itself, so a dangling link now resolves
    // through `readlink` below and its true target is what gets containment-checked.
    let st = null;
    try { st = fs.lstatSync(probe); } catch { st = null; }
    if (st) {
      if (st.isSymbolicLink()) {
        // PR #1024 blocker fix — bound the walk. A cycle (or a pathologically deep chain) never resolves to
        // a non-symlink, so without this the loop below never terminates.
        hops += 1;
        if (hops > MAX_SYMLINK_HOPS) {
          throw new Error(
            `sync-skills-deploy: symlink cycle (or chain deeper than ${MAX_SYMLINK_HOPS} hops) resolving `
            + `"${p}" — stuck at "${probe}". Refusing to loop forever; fix the symlink(s) under the deploy root.`,
          );
        }
        // Resolve the link by hand (realpathSync throws on a dangling target) and keep walking, so a chain
        // of links is followed to its real destination.
        let target;
        try { target = fs.readlinkSync(probe); } catch { break; }
        probe = path.resolve(path.dirname(probe), target);
        continue;
      }
      break; // a real file/dir — realpath it below
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    parts.unshift(path.basename(probe));
    probe = parent;
  }
  let base = probe;
  try { base = fs.realpathSync(probe); } catch { /* dangling/absent tail — the hand-resolved path stands */ }
  return path.resolve(base, ...parts);
}

export function assertInsideRoot(root, target) {
  // Both sides go through the SAME normalisation — a first deploy legitimately has neither the deploy root
  // nor the leaf on disk yet, so realpath'ing only one side would throw ENOENT (or compare mismatched
  // spellings on a symlinked workspace).
  const realRoot = realpathDeepest(root);
  const resolved = realpathDeepest(target);
  const rel = path.relative(realRoot, resolved);
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error(
      `sync-skills-deploy: refusing to touch "${resolved}" — it resolves outside the deploy root "${realRoot}" `
      + '(a symlinked path under the deploy root would otherwise write through to an unrelated tree).',
    );
  }
  return resolved;
}

/** Apply a plan's actions to disk (add/update copy from src, remove deletes from dest). */
export function applyPlan(plan) {
  const root = plan.destRoot ?? plan.destDir;
  for (const action of plan.actions) {
    // #2579 review / PR #1024 blocker fix — every destructive/creative op is containment-checked against
    // the DEPLOY ROOT (`plan.destRoot`), not the per-skill `plan.destDir` — see the note above `assertInsideRoot`.
    const destFile = assertInsideRoot(root, path.join(plan.destDir, action.rel));
    if (action.type === 'remove') {
      fs.rmSync(destFile, { force: true });
    } else {
      assertInsideRoot(root, path.dirname(destFile));
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(path.join(plan.srcDir, action.rel), destFile);
    }
  }
}

export function listSkillNames(srcRoot = SRC_ROOT) {
  if (!fs.existsSync(srcRoot)) return [];
  return fs.readdirSync(srcRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Build the full set of per-skill plans for a run. Pulls `git ls-files` per skill (the only I/O git call). */
export function buildPlans({ srcRoot = SRC_ROOT, extraRoots = [], destRoot, only = null, all = false, prune = false, repoRoot = null } = {}) {
  if (!repoRoot) repoRoot = fs.existsSync(srcRoot) ? gitToplevel(srcRoot) : REPO_ROOT;
  // SK1: one home per skill. Primary root uses `repoRoot`; each extra root is its own git repo (found via
  // `git rev-parse`; fails closed if it is not one).
  const roots = [{ root: srcRoot, repoRoot }, ...extraRoots.map((r) => ({ root: path.resolve(r), repoRoot: gitToplevel(r) }))];
  const home = new Map(); // name -> { root, repoRoot }
  for (const entry of roots) {
    for (const name of listSkillNames(entry.root)) {
      if (home.has(name)) {
        throw new Error(
          `sync-skills-deploy: skill "${name}" has two homes — ${path.join(home.get(name).root, name)} and `
          + `${path.join(entry.root, name)}. Refusing; delete one.`,
        );
      }
      home.set(name, entry);
    }
  }
  const allNames = [...home.keys()].sort();
  if (only) {
    const unknown = only.filter((n) => !home.has(n));
    if (unknown.length) throw new Error(`sync-skills-deploy: unknown skill(s): ${unknown.join(', ')}`);
  }
  const names = only ?? allNames;
  const plans = [];
  for (const name of names) {
    const entry = home.get(name);
    const srcDir = path.join(entry.root, name);
    const destDir = path.join(destRoot, name);
    const trackedRel = gitTrackedFiles(srcDir, entry.repoRoot);
    // A never-committed skill dir is drift in every mode: it can never deploy, and silence hid it (21:33 ET gap).
    if (trackedRel.length === 0) {
      plans.push({ name, srcDir, destDir, destRoot, actions: [], stale: [], pruned: prune, alreadyDeployed: fs.existsSync(destDir), untracked: true });
      continue;
    }
    if (!only && !all && !fs.existsSync(destDir)) continue; // default: keep already-deployed skills in sync only
    plans.push(planSkill({ name, srcDir, destDir, trackedRel, prune, destRoot }));
  }
  return plans;
}

function gitToplevel(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`sync-skills-deploy: extra root "${dir}" is not inside a git repo; refusing`);
  }
}

/** #2579 review — exported so the OUTPUT contract is unit-testable. The stale-reporting gap existed
 *  precisely because nothing could assert what this function prints. */
export function formatPlans(plans, { checkOnly, dryRun, noun = 'skill' }) {
  const drifted = plans.filter((p) => p.actions.length > 0);
  const untracked = plans.filter((p) => p.untracked);
  // #2579 review — STALE FILES MUST BE REPORTED. Making deletion opt-in (`--prune`) was justified in this
  // file's own header by "stale files are reported by `--check`, never silently destroyed" — but `plan.stale`
  // was computed, returned, and then consumed by NOTHING, so the compensating control did not exist and the
  // header's claim was false. A stale deployed file is real drift: it is a file the deploy tree has that
  // source does not, which is exactly the divergence this tool exists to surface.
  const withStale = plans.filter((p) => (p.stale || []).length > 0 && !p.pruned);
  const lines = [];
  for (const plan of untracked) {
    lines.push(`UNTRACKED ${plan.name}: no git-tracked files at ${plan.srcDir}; commit it or it never deploys`);
  }
  if (drifted.length === 0 && withStale.length === 0 && untracked.length === 0) {
    lines.push(`✓ in sync — ${plans.length} ${noun}(s) checked, no drift`);
  } else {
    const verb = checkOnly ? 'DRIFT' : dryRun ? 'WOULD SYNC' : 'SYNCED';
    for (const plan of drifted) {
      const counts = { add: 0, update: 0, remove: 0 };
      for (const a of plan.actions) counts[a.type] += 1;
      const parts = [];
      if (counts.add) parts.push(`+${counts.add}`);
      if (counts.update) parts.push(`~${counts.update}`);
      if (counts.remove) parts.push(`-${counts.remove}`);
      lines.push(`${verb} ${plan.name}: ${parts.join(' ')} (${plan.destDir})`);
    }
    if (drifted.length) lines.push(`${drifted.length}/${plans.length} ${noun}(s) drifted`);
    for (const plan of withStale) {
      lines.push(
        `STALE ${plan.name}: ${plan.stale.length} file(s) at the deploy target are not tracked in source `
        + `— ${plan.stale.join(', ')} (${plan.destDir}). Not deleted; re-run with --prune to remove them.`,
      );
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const destRoot = deployRoot();
  const srcRoot = process.env.WE_SKILLS_SRC_ROOT ? path.resolve(process.env.WE_SKILLS_SRC_ROOT) : SRC_ROOT;
  if (!fs.existsSync(srcRoot)) throw new Error(`sync-skills-deploy: missing skills-src at ${srcRoot}`);
  // Extra roots: --root=<dir> (repeatable) and WE_SKILLS_EXTRA_ROOTS (path-delimited, e.g. plateau-ops/skills).
  const envRoots = (process.env.WE_SKILLS_EXTRA_ROOTS || '').split(path.delimiter).filter(Boolean);
  const defaultOps = path.join(os.homedir(), 'workspace', 'plateau-ops', 'skills'); // default second home
  const extraRoots = [...(process.env.WE_SKILLS_SRC_ROOT ? [] : [defaultOps]), ...envRoots, ...args.roots]
    .filter((r, i, a) => fs.existsSync(r) && a.indexOf(r) === i);

  const plans = buildPlans({ srcRoot, extraRoots, destRoot, only: args.only, all: args.all, prune: args.prune });
  const drifted = plans.filter((p) => p.actions.length > 0);

  if (!args.check && !args.dryRun) {
    for (const plan of drifted) applyPlan(plan);
  }

  // #2579 review — stale files are drift too (see formatPlans), and `ok` must mean "nothing pending" in
  // EVERY no-write mode, not just `--check`. The old `: true` reported ok:true under `--dry-run --json`
  // while add/update actions were still outstanding, so automation gating on `ok` would conclude the deploy
  // tree was in sync when it was not — reintroducing the silent-stale-deploy bug this item exists to close.
  const stalePending = plans.filter((p) => (p.stale || []).length > 0 && !p.pruned);
  const nothingPending = drifted.length === 0 && stalePending.length === 0 && !plans.some((p) => p.untracked);
  const writesNothing = args.check || args.dryRun;
  if (args.json) {
    process.stdout.write(JSON.stringify({
      ok: writesNothing ? nothingPending : true,
      checked: plans.length,
      drifted: drifted.length,
      staleSkills: stalePending.length,
      staleFiles: stalePending.reduce((n, p) => n + p.stale.length, 0),
      applied: !args.check && !args.dryRun,
      skills: plans.map((p) => ({
        name: p.name, actions: p.actions, stale: p.stale || [], alreadyDeployed: p.alreadyDeployed,
      })),
    }, null, 2) + '\n');
  } else {
    process.stdout.write(formatPlans(plans, { checkOnly: args.check, dryRun: args.dryRun }) + '\n');
  }

  // #2579 review — `--check` exits 1 on ANY pending divergence, stale files included. Keying only on
  // `drifted` meant a deploy tree carrying untracked leftovers reported "no drift" and exited 0.
  if (args.check && !nothingPending) process.exitCode = 1;
}

// #2579 review — build the comparison URL with `pathToFileURL`, never by string-concatenating `file://`.
// A hand-built prefix does not percent-encode, so on any checkout path containing a space or other
// URL-significant character the two strings never matched and the CLI exited 0 having silently done nothing.
//
// #2579 review r2 — `argv[1]` may be ABSENT (`node -e`, `node --eval`, `node -` / stdin), and
// `pathToFileURL(undefined)` THROWS, so merely IMPORTING this module crashed under those launchers. That is
// strictly worse than the string-concat version it replaced, which just produced a non-matching string. The
// tests never caught it because vitest always sets `argv[1]`. Guard the argument, and realpath both sides so
// a symlinked invocation path still matches (`import.meta.url` is already realpath-resolved by Node).
const entryHref = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return null;                       // no script path ⇒ this module was imported, not run
  try { return pathToFileURL(fs.realpathSync(argv1)).href; } catch { /* fall through */ }
  try { return pathToFileURL(argv1).href; } catch { return null; }
})();
if (entryHref && import.meta.url === entryHref) {
  main().catch((err) => {
    const message = /^sync-skills-deploy:/.test(err.message) ? err.message : `sync-skills-deploy: ${err.message}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
