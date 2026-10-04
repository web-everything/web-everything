#!/usr/bin/env node
/**
 * guard-prototype-tracker.mjs — the "can't forget" enforcement for epic #3383's own tracker card
 * (`backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md`).
 *
 * WHY A HOOK, NOT A DOCUMENTED CONVENTION. Per the "hookable vs judgment" rule (#51): whether a push targets
 * a declared #3383 POC branch, and whether the tracker's most recent `## Session update` entry is stale
 * relative to that push, are both fully script-decidable — a path/date test, not a judgment call. A skill
 * that a session must remember to invoke is exactly the failure mode this file exists to close: skill
 * discovery is not durable (the operator's own words, filed against this build), and a fresh subagent picking
 * up mid-task on this epic has no reason to have read the skill unless something FORCES it to.
 *
 * TWO MODES, ONE FILE, mirroring the session's two natural checkpoints:
 *
 *   `--session-start` — wired as a SECOND `SessionStart` hook entry in `.claude/settings.json` (alongside
 *   `bootstrap-session.mjs`, which stays untouched — it is Plateau's generic, portable bootstrap and this
 *   check is #3383-specific, so it does not belong there). Prints a highly visible reminder, EVERY session,
 *   the moment a checkout's current branch is a declared #3383 POC branch (`we:scripts/lib/poc-branches.mjs`).
 *   Never blocks startup — SessionStart hooks report, they do not gate.
 *
 *   (default) — a git `pre-push` hook, wired in `.githooks/pre-push` alongside `guard-git-push.mjs`, mirroring
 *   its exact stdin-payload contract (one line per pushed ref: `<localRef> <localSha> <remoteRef>
 *   <remoteSha>`). Fires on EVERY push to a declared #3383 POC branch, regardless of how it was invoked (the
 *   Bash-tool guard only sees an AGENT-TYPED `git push`; this also catches a script's internal push, exactly
 *   the gap `guard-git-push.mjs`'s own header describes for the `main`-push lock). BLOCKS (exit 1) when the
 *   tracker's latest logged session-update date is more than {@link FRESH_DAYS} day(s) old AND this push's own
 *   diff does not touch the tracker file itself — i.e. real work is about to leave the branch with the
 *   tracker never having been told. Sanctioned override: `PROTOTYPE_TRACKER_PUSH_OK=1` (mirrors
 *   `MAIN_PUSH_OK`/`LANE_GUARD_OFF`).
 *
 * WHY DAY-GRANULARITY, NOT PER-PUSH. The branch's own doctrine (rule 4,
 * `we:skills-src/mechanical-delivery-doctrine/SKILL.md`) has sessions push straight to this branch, no PR, no
 * ceremony — often many small pushes inside one session. Requiring EVERY push to touch the tracker would
 * itself become the exact "false-deny footgun" class this repo's other guards explicitly warn about
 * (`#2986`/`#2994`) — most pushes are mid-session, before there is a session update worth writing yet. Gating
 * on CALENDAR-DAY staleness instead catches the failure that actually happened three times in this epic's own
 * history per its tracker (see its "Escalation, 2026-09-04" entries): a whole session's worth of real work
 * landing with no session-update ever written. One full day of slack, so same-day pushes after a session
 * update was written that day never trip it, and a push that itself carries the tracker update always passes.
 *
 * The decision functions are PURE (no git, no fs) so they are unit-tested without a real repo —
 * `__tests__/guard-prototype-tracker.test.mjs` — mirroring `guard-git-push.mjs`'s own split.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry, normalizeBranchRef, branchesForRepo } from './lib/poc-branches.mjs';
import { findTrackerPath, parseTracker } from './lib/prototype-tracker-data.mjs';
import { localToday } from './lib/local-date.mjs';

/** How many whole calendar days a tracker's latest entry may age before an untouching push is blocked. */
export const FRESH_DAYS = 1;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE CORE
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The declared #3383 POC branches — the ones this guard protects. PURE over an already-read registry (mirrors
 * `we:scripts/lib/poc-branches.mjs`'s own read/decide split). Filters on `owner === epicNum` rather than
 * hard-coding branch names, so a second #3383 POC branch registered later is covered automatically (doctrine:
 * "N of them may stand at once").
 * @param {{branches: object[]}} registry
 * @param {string} [epicNum]
 * @returns {string[]}
 */
export function protectedBranchNames(registry, epicNum = '3383') {
  return branchesForRepo(registry).filter((b) => b.owner === epicNum).map((b) => b.branch);
}

/**
 * Which pushed refs (from a pre-push stdin payload) target a protected branch. PURE — mirrors
 * `guard-git-push.mjs#mainPushRefs` exactly, generalized to a branch LIST instead of one name.
 * @param {string} stdin raw pre-push payload
 * @param {string[]} branches protected branch names (bare, e.g. `lane/mechanical-dispatcher`)
 * @returns {Array<{localRef: string, localSha: string, remoteRef: string, remoteSha: string, branch: string}>}
 */
export function protectedPushLines(stdin, branches) {
  const wanted = new Set((branches ?? []).map(normalizeBranchRef));
  const matched = [];
  for (const line of String(stdin || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    const name = normalizeBranchRef(remoteRef.replace(/^refs\/heads\//, ''));
    if (wanted.has(name)) matched.push({ localRef, localSha, remoteRef, remoteSha, branch: name });
  }
  return matched;
}

/** Whole calendar days between two `YYYY-MM-DD` strings (`b - a`). PURE, UTC-based (both are already
 *  date-only local-calendar stamps — see `we:scripts/lib/local-date.mjs` — so UTC arithmetic on them never
 *  crosses a real zone boundary, it just counts days). */
export function daysBetween(a, b) {
  const toUtc = (d) => Date.UTC(...String(d).split('-').map(Number));
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/**
 * The block/allow decision for a pre-push event. PURE. Returns a reason string to BLOCK, else `null`.
 * @param {object} o
 * @param {Array<{branch:string}>} o.matchedLines pushed refs that target a protected branch (empty ⇒ allow)
 * @param {string|null} o.trackerLatestDate the tracker's latest `## Session update` date, or `null` if
 *   unknown/unparseable (⇒ allow — never block on something this guard could not determine)
 * @param {string} o.todayDate `YYYY-MM-DD`, "now" in the operator's local day
 * @param {boolean} o.touchesTracker does THIS push's own diff include the tracker file?
 * @param {boolean} [o.isNewBranchPush] the remote ref did not exist before this push (⇒ allow — nothing to
 *   diff against, and a first-time push of a declared branch is not the "forgot to update it" failure mode)
 * @param {boolean} [o.override] `PROTOTYPE_TRACKER_PUSH_OK=1` was set
 * @param {number} [o.freshDays]
 * @returns {string|null}
 */
export function staleTrackerPushDecision({
  matchedLines, trackerLatestDate, todayDate, touchesTracker, isNewBranchPush = false, override = false,
  freshDays = FRESH_DAYS,
} = {}) {
  if (override) return null;
  if (!matchedLines || !matchedLines.length) return null;
  if (touchesTracker) return null;
  if (isNewBranchPush) return null;
  if (!trackerLatestDate) return null; // can't determine ⇒ never block on uncertainty
  const age = daysBetween(trackerLatestDate, todayDate);
  if (age <= freshDays) return null;
  const branches = [...new Set(matchedLines.map((l) => l.branch))].join(', ');
  return (
    `pre-push BLOCKED — pushing to declared #3383 POC branch(es) [${branches}], but ` +
    `backlog/3383-*.md's latest session-update entry is dated ${trackerLatestDate} (${age} days old) and this ` +
    `push does not touch that file. Epic #3383's tracker must stay current for every session that does real ` +
    `work on this branch (see we:skills-src/prototype-tracker/SKILL.md). Run the prototype-tracker skill (or ` +
    `\`node scripts/prototype-tracker.mjs append-note --summary="..." \` piping the note body on stdin) to add ` +
    `this session's update, commit it, then push again. Sanctioned override (rare): PROTOTYPE_TRACKER_PUSH_OK=1.`
  );
}

/**
 * The SessionStart reminder text, or `null` when the current branch is not a protected one. PURE.
 * @param {string} currentBranch
 * @param {string[]} branches protected branch names
 * @returns {string|null}
 */
export function sessionStartReminder(currentBranch, branches) {
  const here = normalizeBranchRef(currentBranch || '');
  if (!here || !(branches ?? []).map(normalizeBranchRef).includes(here)) return null;
  return (
    `━━ epic #3383 prototype tracker ━━\n` +
    `This checkout is on "${here}", a declared #3383 POC branch. Keep ` +
    `backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md current: add a session-update ` +
    `entry before you push real work (skill: we:skills-src/prototype-tracker/SKILL.md, or ` +
    `\`node scripts/prototype-tracker.mjs append-note …\`). This is ENFORCED, not just a reminder — a push to ` +
    `this branch whose tracker entry is more than ${FRESH_DAYS} day(s) stale and whose own diff doesn't touch ` +
    `the tracker file is BLOCKED by the repo's pre-push hook (guard-prototype-tracker.mjs).\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// IO SHELL
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const WE_ROOT = resolve(HERE, '..');
const ALL_ZEROS = '0'.repeat(40);

function defaultGit(args, opts) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: WE_ROOT, ...opts });
}

function runSessionStart({ out = (s) => process.stdout.write(s), git = defaultGit } = {}) {
  try {
    const registry = readRegistry({ path: join(WE_ROOT, 'scripts', 'lib', 'poc-branches.json') });
    const branches = protectedBranchNames(registry);
    if (!branches.length) return 0;
    const currentBranch = git(['branch', '--show-current']).trim();
    const msg = sessionStartReminder(currentBranch, branches);
    if (msg) out(`${msg}\n`);
  } catch { /* SessionStart must never fail a session over a reporting step */ }
  return 0;
}

function runPrePush({
  stdin = readStdinSafe(), env = process.env, git = defaultGit, out = (s) => process.stderr.write(s),
} = {}) {
  try {
    if (env.PROTOTYPE_TRACKER_PUSH_OK === '1') return 0;
    const registry = readRegistry({ path: join(WE_ROOT, 'scripts', 'lib', 'poc-branches.json') });
    const branches = protectedBranchNames(registry);
    if (!branches.length) return 0;
    const matchedLines = protectedPushLines(stdin, branches);
    if (!matchedLines.length) return 0;

    const trackerAbsPath = findTrackerPath({ backlogDir: join(WE_ROOT, 'backlog') });
    if (!trackerAbsPath) return 0; // no tracker on disk ⇒ nothing to enforce, fail open
    const trackerRelPath = relative(WE_ROOT, trackerAbsPath);

    const line = matchedLines[0]; // one declared branch pushed at a time is the normal case
    const isNewBranchPush = line.remoteSha === ALL_ZEROS;
    let touchesTracker = true; // fail-open default when the diff can't be computed
    let trackerLatestDate = null;
    if (!isNewBranchPush) {
      try {
        const diff = git(['diff', '--name-only', line.remoteSha, line.localSha]).split('\n').map((s) => s.trim()).filter(Boolean);
        touchesTracker = diff.includes(trackerRelPath);
      } catch { touchesTracker = true; }
    }
    try {
      const text = git(['show', `${line.localSha}:${trackerRelPath}`]);
      trackerLatestDate = parseTracker(text).latestDate;
    } catch { trackerLatestDate = null; }

    const reason = staleTrackerPushDecision({
      matchedLines, trackerLatestDate, todayDate: localToday(), touchesTracker, isNewBranchPush,
      override: env.PROTOTYPE_TRACKER_PUSH_OK === '1',
    });
    if (reason) { out(`${reason}\n`); return 1; }
    return 0;
  } catch {
    return 0; // fail-OPEN: a guard bug must never block every push to this branch
  }
}

function readStdinSafe() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  process.exitCode = process.argv.includes('--session-start') ? runSessionStart() : runPrePush();
}
