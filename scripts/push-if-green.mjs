#!/usr/bin/env node
/**
 * push-if-green.mjs — publish a repo's `main` to origin after a green gate (#2073).
 *
 * WHY: nothing in the batch / lane / close flow ever pushed `main`, so `origin/main` silently drifted
 * (observed 185 commits behind local after one parallel batch). The parallel orchestrator round-trips
 * `main` through the remote as throwaway `lane/_base` + `lane/*` refs (which it deletes) and lands merges
 * on the LOCAL primary checkout only; the serial `/batch` and close paths commit locally and (a leftover of
 * the pre-2026-06-29 never-push stance, now lifted) never pushed. Result: GitHub frozen, no off-machine
 * backup, no CI trigger, a fresh clone sees none of it.
 *
 * This is the ONE shared helper both the parallel integrator and the serial/close commit path call to
 * publish `main`. It generalizes the PUSH, not the LANE — lanes stay parallel-only (#2073 out-of-scope note).
 *
 * RULES (#2073):
 *  - Green-gate precondition — push a repo's `main` ONLY when that repo's gate is green. Either this script
 *    runs the gate itself (default), or the caller already ran it and passes `--assume-green` (the parallel
 *    integrator has just run the full per-repo gate on the merged tree — re-running would be wasteful).
 *    Never publish a red state.
 *  - Fast-forward ONLY, never --force. One local `main` serializes all merges (the integrator is a mutex),
 *    so pushes to origin/main are ff appends. A non-ff push (someone else advanced origin) ABORTS — it is
 *    never forced; the drift is recoverable, a later green push resolves it once origin is merged in.
 *  - Per-repo across the constellation (#96): WE + frontierui + plateau-app each push their OWN `main` after
 *    their OWN gated merge. Point `--repo` / cwd at the repo to publish; `--gate` names its gate command.
 *  - Only ever pushes the branch named `main` (or `--branch`), and only when HEAD is on it — never a lane ref,
 *    never a detached HEAD. Honors the standing guards: pushing `main` is allowed (never-push lifted
 *    2026-06-29); this script does NOT create branches or broad-stage.
 *
 * Usage:
 *   node scripts/push-if-green.mjs                       # related-test gate vs fetched origin/main, ff-push if green
 *   node scripts/push-if-green.mjs --repo=~/workspace/frontierui --gate="npm run check:standards"
 *   node scripts/push-if-green.mjs --repo=~/workspace/plateau-app --gate="npm run build"
 *   node scripts/push-if-green.mjs --assume-green        # caller already gated green — skip the gate, just ff-push
 *   node scripts/push-if-green.mjs --sha=<commit>        # gate + publish exactly this ancestor of local main
 *   node scripts/push-if-green.mjs --dry-run             # gate + report the push decision, but do NOT push
 *   node scripts/push-if-green.mjs --json                # machine-readable result
 *
 * Flags:
 *   --repo=<path>     checkout to publish (default: the cwd's git toplevel)
 *   --gate=<cmd>      override the default related-test selection against fetched <remote>/<branch>
 *   --branch=<ref>    the branch to publish (default: "main")
 *   --sha=<commit>    publish this resolved commit from local branch history; skip JIT numbering
 *   --remote=<name>   the remote to push to (default: "origin")
 *   --assume-green    skip running the gate — the caller has already verified green (integrator path)
 *   --dry-run         run the gate + decide, but never push
 *   --json            emit a JSON result object on stdout
 *
 * Nothing to push skips the gate. A blocked/missing default selection refuses with exit 2;
 * supply an explicit affected-test --gate or use CI. Whole-suite verification belongs to CI.
 * Exit codes: 0 = pushed (or nothing-to-push / dry-run OK); 2 = gate red (nothing pushed); 3 = not ff /
 * wrong branch / push failed (nothing pushed). A non-zero exit means origin/<branch> was left UNTOUCHED.
 */
import { execFileSync, execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAllSync } from './lib/write-all-sync.mjs';
import { admittedShellCommand } from './readiness/heavy-admission.mjs';
import { resolvePushDefaultGate } from './lib/verify-lane-gate.mjs';
// Root-cause fix for the 2026-09-08 #3623/#3624 stranding incident — see this module's own header for the
// full story. Split out (PURE-ish/injectable, no top-level side effects) so it stays independently testable
// without importing this CLI file itself (which runs a real gate + `process.exit()` at top-level import).
import { numberPendingHashesBeforePush } from './lib/number-pending-hashes-before-push.mjs';

// ── tiny arg parsing (matches lane-pool.mjs) ────────────────────────────────────────────────────────
const flags = {};
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
}

const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const REPO = resolve(expandHome(flags.repo) || process.cwd());
let GATE = typeof flags.gate === 'string' ? flags.gate : null;
const BRANCH = typeof flags.branch === 'string' ? flags.branch : 'main';
const REMOTE = typeof flags.remote === 'string' ? flags.remote : 'origin';
const ASSUME_GREEN = !!flags['assume-green'];
const DRY_RUN = !!flags['dry-run'];
const AS_JSON = !!flags.json;
const HAS_SHA = Object.hasOwn(flags, 'sha');

// ── git helpers (throw-on-error) ────────────────────────────────────────────────────────────────────
const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (args) => { try { return git(args); } catch { return null; } };

function emit(result, exitCode) {
  if (AS_JSON) writeAllSync(1, JSON.stringify(result) + '\n');
  else {
    const tag = result.pushed ? '✓ pushed' : (result.reason === 'up-to-date' || result.reason === 'nothing-to-push' ? '· nothing to push' : (DRY_RUN && result.gate === 'green' ? '· dry-run (would push)' : '✗ not pushed'));
    process.stderr.write(`push-if-green [${result.repo}] ${tag}: ${result.detail}\n`);
  }
  process.exit(exitCode);
}

// ── 1. Confirm we're on the branch we intend to publish (never push a lane ref / detached HEAD) ───────
const head = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);
if (head !== BRANCH) {
  emit(
    { repo: REPO, pushed: false, gate: 'skipped', reason: 'wrong-branch', detail: `HEAD is "${head}", not "${BRANCH}" — refusing to push (only publishes ${BRANCH} from ${BRANCH}).` },
    3,
  );
}

// Pin an explicit source before gating; reject malformed input and commits outside our branch history.
let sourceSha = null;
if (HAS_SHA) {
  sourceSha = typeof flags.sha === 'string' && flags.sha
    ? tryGit(['rev-parse', '--verify', '--end-of-options', `${flags.sha}^{commit}`]) : null;
  if (!sourceSha) {
    emit({ repo: REPO, pushed: false, gate: 'skipped', reason: 'no-such-sha', detail: `source commit "${flags.sha}" not found — pass --sha=<commit>.` }, 3);
  }
  const branchTip = git(['rev-parse', BRANCH]);
  if (tryGit(['merge-base', '--is-ancestor', sourceSha, branchTip]) === null) {
    emit({ repo: REPO, pushed: false, gate: 'skipped', reason: 'sha-not-on-branch', detail: `source commit ${sourceSha.slice(0, 8)} is NOT an ancestor of local ${BRANCH} (${branchTip.slice(0, 8)}) — refusing to push.` }, 3);
  }
}

// ── 2. Is there anything to push? Compare local BRANCH to remote-tracking, ff-only ────────────────────
let gate = ASSUME_GREEN ? 'assumed-green' : 'skipped';
// Fetch the remote branch WITHOUT modifying the working tree (updates only the remote-tracking ref).
const fetched = tryGit(['fetch', REMOTE, BRANCH, '--quiet']) !== null;
let local = sourceSha ?? git(['rev-parse', BRANCH]);
const remote = tryGit(['rev-parse', `${REMOTE}/${BRANCH}`]);

if (remote && remote === local) {
  emit({ repo: REPO, pushed: false, gate, reason: 'up-to-date', detail: `${REMOTE}/${BRANCH} already matches local ${BRANCH} (${local.slice(0, 8)}).` }, 0);
}

// If origin exists, require the push to be a genuine fast-forward: remote must be an ANCESTOR of local. If
// not, someone else advanced origin/main — do NOT force; abort and report (the drift is recoverable).
if (remote) {
  let isFf = false;
  try { execFileSync('git', ['merge-base', '--is-ancestor', remote, local], { cwd: REPO, stdio: 'ignore' }); isFf = true; } catch { isFf = false; }
  if (!isFf) {
    emit(
      { repo: REPO, pushed: false, gate, reason: 'not-fast-forward', detail: `${REMOTE}/${BRANCH} (${remote.slice(0, 8)}) is NOT an ancestor of local ${BRANCH} (${local.slice(0, 8)}) — refusing non-ff push (never --force). Merge origin/${BRANCH} in, re-gate, then re-run.` },
      3,
    );
  }
}

// ── 3. Green-gate precondition — resolve only when a push is needed, after refreshing its base ────────
if (!ASSUME_GREEN) {
  if (GATE === null) {
    if (!fetched) {
      emit({ repo: REPO, pushed: false, gate: 'red', reason: 'gate-red', detail: `Default push gate blocked: could not fetch ${REMOTE}/${BRANCH}. Restore remote access and retry, or supply an explicit affected-test --gate.` }, 2);
    }
    let scripts;
    try {
      const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
      if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) throw new Error('missing scripts object');
      scripts = Object.keys(pkg.scripts);
    } catch (error) {
      emit({ repo: REPO, pushed: false, gate: 'red', reason: 'gate-red', detail: `Default push gate blocked: cannot read package.json scripts (${error.message}). Restore package metadata or supply an explicit affected-test --gate.` }, 2);
    }
    const resolved = resolvePushDefaultGate({ base: `${REMOTE}/${BRANCH}`, runGit: git, scripts, allowCardOnlySkip: false,
      fileExists: p => existsSync(join(REPO, p)), readRepoFile: p => readFileSync(join(REPO, p), 'utf8') });
    if (resolved.exitCode) {
      emit({ repo: REPO, pushed: false, gate: 'red', reason: 'gate-red', detail: resolved.detail }, resolved.exitCode);
    }
    GATE = resolved.command;
  }
  try {
    // Scoped JSON callers parse stdout as one result; send gate chatter to stderr in this mode.
    // The whole gate chain holds ONE slot in the host admission pool.
    execSync(admittedShellCommand(GATE), { cwd: REPO, stdio: HAS_SHA && AS_JSON ? ['inherit', 2, 2] : 'inherit' });
    gate = 'green';
  } catch {
    emit({ repo: REPO, pushed: false, gate: 'red', reason: 'gate-red', detail: `gate "${GATE}" is RED — ${REMOTE}/${BRANCH} left untouched (a later green push recovers the drift).` }, 2);
  }
}

if (DRY_RUN) {
  emit({ repo: REPO, pushed: false, gate, reason: 'dry-run', detail: `would ff-push local ${BRANCH} (${local.slice(0, 8)}) → ${REMOTE}/${BRANCH}${remote ? ` (from ${remote.slice(0, 8)})` : ' (new remote branch)'}.` }, 0);
}

// ── 3.5. JIT-number any pending hash-keyed backlog item BEFORE publishing (root-cause fix, #3623/#3624) ──
// push-if-green is the ONE shared choke point every write path uses to publish `main` (#2073) — INCLUDING a
// direct commit+push that never went through a lane/PR/drain at all. That is exactly the shape that
// stranded #3623/#3624 for 44-92 minutes on 2026-09-08: two "File #<hash>"/"WE: file backlog item" commits
// landed on `origin/main` by a raw push, so neither `scripts/lane-drain.mjs`'s `finalizeLand` nor
// `scripts/merge-ai-prs.mjs`'s land path — the ONLY two places JIT numbering (#2288) was previously wired to
// fire — ever ran for them; the next drain pass's `numberPendingHashes` sweep (gated on that SAME pass also
// landing a local PR) raced the push and missed them too, and nothing surfaced the miss until a human ran
// `number-stranded` by hand. Numbering HERE, unconditionally, right before every push of `main`, closes the
// gap structurally instead of relying on every caller going through a PR: a hash-keyed backlog item can no
// longer reach `origin/main` without being numbered in the exact same push that lands it. A numbering
// failure REFUSES the push (fail closed) rather than landing an item this script already knows would be
// un-numbered — strictly better than the old best-effort-after-the-fact shape, since nothing reaches origin
// un-numbered in the first place. Skipped in `--dry-run` (no mutation) and for any non-`main` branch.
// A --sha publish owns only the named commit; numbering would leave an extra, unpublished local commit.
if (!DRY_RUN && BRANCH === 'main' && !HAS_SHA) {
  const numbering = await numberPendingHashesBeforePush(REPO);
  if (numbering.attempted && numbering.error) {
    emit(
      { repo: REPO, pushed: false, gate, reason: 'numbering-failed', detail: `pending hash-keyed backlog item(s) could not be JIT-numbered before push (${numbering.error}) — refusing to push (would strand an un-numbered item on ${BRANCH}). Fix the numbering failure, then retry.` },
      3,
    );
  }
  if (numbering.attempted && numbering.committed) {
    local = git(['rev-parse', BRANCH]); // the numbering commit advanced local BRANCH — refresh for accurate reporting below
  }
}

// ── 4. Fast-forward push (explicit refspec; never --force) ────────────────────────────────────────────
const refspec = HAS_SHA ? `${sourceSha}:refs/heads/${BRANCH}` : `${BRANCH}:${BRANCH}`;
try {
  git(['push', REMOTE, refspec]);
} catch (e) {
  emit(
    { repo: REPO, pushed: false, gate, reason: 'push-failed', detail: `git push ${REMOTE} ${refspec} failed (${String(e && e.message || e).split('\n')[0]}) — origin unchanged.` },
    3,
  );
}
emit({ repo: REPO, pushed: true, gate, reason: 'pushed', detail: `ff-pushed local ${BRANCH} (${local.slice(0, 8)}) → ${REMOTE}/${BRANCH}.` }, 0);
