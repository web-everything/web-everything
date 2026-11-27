/** @file scripts/lib/daemon-rebuild/wrong-branch-heal.mjs — self-heal a daemon clone left on a known store branch.
 *
 * WHY (live 2026-10-09 06:52 ET): the verdict-ledger git store's writer ran `checkout -B ops/review-requests` in
 * the review daemon's OWN clone (not in its scratch worktree). The clone's tree became the ledger branch (no
 * `skills-src/`), the daemon died on MODULE_NOT_FOUND, and every rebuild refused `not-on-main` for ~1.5 h.
 *
 * THE RULE (pure, {@link planWrongBranchHeal}): heal ONLY when the clone sits on a branch named in the
 * `wrongBranchHeal.branches` setting AND every tracked change is under a `wrongBranchHeal.pathPrefixes` prefix
 * (store files). Anything else — an unknown branch, a change outside the store paths, no local
 * `main` — still refuses, exactly as before. Untracked files are never touched (a checkout that would overwrite
 * one fails, and the heal refuses).
 *
 * DETACHED CASE (2026-10-11, extended DAEMON-CLONE-DETACHED-HEAL, 2026-11-27): a clone detached at local main
 * heals as before; a clone detached elsewhere heals only when local main equals the adopted smoke-passed
 * head and the detached HEAD is reachable from origin/main, with the old HEAD saved under a named ref first;
 * every unknown refuses. A clean detach exactly at main needs no adoption/reachability evidence or saved ref.
 * Off-main refusal order: in-progress/unreadable git dir; unreadable HEAD; missing main; unreadable status;
 * tracked changes; invalid (non-40-hex) head/main/adopted SHA or main != adopted; unreadable reachability;
 * unreachable (foreign) commit. Reachability uses the concrete HEAD SHA and the local origin/main ref,
 * never a fetch. Re-read HEAD, main, tracked status and operation markers immediately before each write,
 * under prepare's clone write lock. Changed/unreadable HEAD or main refuses as detached-state-changed.
 * Save create-only at refs/we/wrong-branch-heal/<ts>-<sha9> (zero old SHA); save failure stops before checkout.
 * Checkout is non-forced with --no-overwrite-ignore: even ignored untracked collisions refuse. A failed
 * switch retains the saved ref in detail.savedRef for operator recovery; no refusal tries another heal path.
 *
 * IN-PROGRESS OPERATIONS (red-team, PR #4964): a paused interactive rebase (`break`, `edit`, a stopped pick) leaves
 * HEAD detached on a clean tree, indistinguishable from a stray detach by SHA and status alone. Moving HEAD
 * under a rebase, cherry-pick/revert sequence, bisect or merge corrupts the pending operation, so any such
 * marker in the git dir refuses the heal on BOTH paths (an unreadable git dir refuses too).
 *
 * THE HEAL ({@link healWrongBranch}): save the tracked changes as a commit under a named ref
 * (`refs/we/wrong-branch-heal/<ts>`, via `stash create`, so nothing is lost), drop them from the tree, and switch
 * back to the local `main` (non-forced). The store's next append re-derives its rows from its own tip, so the
 * saved changes are an audit copy, not a pending write.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { daemonRebuildSettingsPath } from './skip-unrelated.mjs';
import { FULL_SHA_RE } from './shared.mjs';

export const WRONG_BRANCH_HEAL_DEFAULTS = Object.freeze({
  branches: Object.freeze(['ops/review-requests']),
  pathPrefixes: Object.freeze(['verdict-ledger/']),
});

/** `wrongBranchHeal` from daemon-rebuild-settings.json; anything missing or malformed keeps the defaults. */
export function resolveWrongBranchHealSettings({ path = daemonRebuildSettingsPath(), read = (p) => readFileSync(p, 'utf8') } = {}) {
  const strs = (v) => (Array.isArray(v) && v.every((s) => typeof s === 'string' && s) ? v : null);
  try {
    const raw = JSON.parse(read(path))?.wrongBranchHeal ?? {};
    return {
      branches: strs(raw.branches) ?? [...WRONG_BRANCH_HEAL_DEFAULTS.branches],
      pathPrefixes: strs(raw.pathPrefixes) ?? [...WRONG_BRANCH_HEAL_DEFAULTS.pathPrefixes],
    };
  } catch {
    return { branches: [...WRONG_BRANCH_HEAL_DEFAULTS.branches], pathPrefixes: [...WRONG_BRANCH_HEAL_DEFAULTS.pathPrefixes] };
  }
}

/** Files/dirs in the git dir that mean a multi-step git operation is paused or running (per-worktree). */
export const IN_PROGRESS_MARKERS = Object.freeze(['rebase-merge', 'rebase-apply', 'sequencer', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD', 'BISECT_LOG', 'BISECT_START', 'index.lock']);

/**
 * IO: markers of an in-progress operation (or a live git process, `index.lock`) in the clone's git dir.
 * `null` when the git dir or any marker cannot be read: only ENOENT counts as absent, so a permission error
 * or a git dir that is not a directory fails closed instead of reading as "nothing in progress".
 */
export function readInProgress(git) {
  const gd = git(['rev-parse', '--absolute-git-dir']);
  const gitDir = gd.status === 0 ? String(gd.stdout ?? '').trim() : '';
  if (!gitDir) return null;
  const found = [];
  for (const m of IN_PROGRESS_MARKERS) {
    try { lstatSync(join(gitDir, m)); found.push(m); } catch (e) { if (e?.code !== 'ENOENT') return null; }
  }
  return found;
}

/**
 * Pure: may this clone state be healed back to main?
 * `inProgress`: markers found in the git dir (`[]` none, `null` git dir unreadable; omitted = not checked).
 * @param {{branch: string|null, headSha?: string|null, mainSha?: string|null, adoptedHead?: string|null, headReachability?: 'reachable'|'unreachable'|'unreadable', changedPaths: string[]|null, hasMain: boolean, settings: {branches: string[], pathPrefixes: string[]}, inProgress?: string[]|null}} o
 * @returns {{heal: true, savedRefNeeded: boolean} | {heal: false, reason: string, detail?: object}}
 */
export function planWrongBranchHeal({ branch, headSha, mainSha, adoptedHead, headReachability, changedPaths, hasMain, settings, inProgress = [] }) {
  if (inProgress === null) return { heal: false, reason: 'git-dir-unreadable' };
  if (inProgress.length) return { heal: false, reason: 'operation-in-progress', detail: { operations: [...inProgress] } };
  if (!branch) {
    if (!headSha) return { heal: false, reason: 'detached-or-unreadable-head' };
    if (!hasMain || !mainSha) return { heal: false, reason: 'no-local-main' };
    if (changedPaths === null) return { heal: false, reason: 'status-unreadable' };
    if (changedPaths.length) return { heal: false, reason: 'detached-with-changes' };
    if (headSha === mainSha) return { heal: true, savedRefNeeded: false };
    if (![adoptedHead, mainSha, headSha].every(sha => typeof sha === 'string' && FULL_SHA_RE.test(sha)) || mainSha !== adoptedHead) {
      return { heal: false, reason: 'detached-not-adopted' };
    }
    if (!['reachable', 'unreachable'].includes(headReachability)) return { heal: false, reason: 'detached-reachability-unreadable' };
    if (headReachability === 'unreachable') return { heal: false, reason: 'detached-foreign-commit' };
    return { heal: true, savedRefNeeded: true };
  }
  if (branch === 'main') return { heal: false, reason: 'already-on-main' };
  if (!settings.branches.includes(branch)) return { heal: false, reason: 'branch-not-allowlisted', detail: { branch } };
  if (!hasMain) return { heal: false, reason: 'no-local-main' };
  if (changedPaths === null) return { heal: false, reason: 'status-unreadable' };
  const foreign = changedPaths.filter((p) => !settings.pathPrefixes.some((pre) => p.startsWith(pre)));
  if (foreign.length) return { heal: false, reason: 'non-store-changes', detail: { foreign: foreign.slice(0, 10) } };
  return { heal: true, savedRefNeeded: false };
}

/** Tracked changed paths (staged or not, both sides of a rename) from `status --porcelain -z`, or null. */
export function parseTrackedChanges(stdout) {
  const out = [];
  const parts = String(stdout ?? '').split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    const xy = rec.slice(0, 2);
    out.push(rec.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') { i += 1; if (parts[i]) out.push(parts[i]); }
  }
  return out;
}

/**
 * IO: read the clone's state, apply the rule, and heal when it allows. Never throws.
 * @param {{git: Function, adoptedHead?: string|null, settings?: object, now?: () => number}} o  `git(args)` → `{status, stdout}`
 * @returns {{healed: true, from: string, savedRef: string|null} | {healed: false, reason: string, detail?: object}}
 */
export function healWrongBranch({ git, adoptedHead = null, settings = resolveWrongBranchHealSettings(), now = Date.now }) {
  const out = (r) => String(r?.stdout ?? '').trim();
  const head = git(['symbolic-ref', '--short', 'HEAD']);
  const branch = head.status === 0 ? out(head) : null;
  const main = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']);
  const hasMain = main.status === 0;
  const mainSha = hasMain ? out(main) : null;
  const detachedHead = !branch ? git(['rev-parse', '--verify', '--quiet', 'HEAD']) : null;
  const headSha = detachedHead?.status === 0 ? out(detachedHead) : null;
  const inProgress = readInProgress(git);
  const st = git(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const changedPaths = st.status === 0 && typeof st.stdout === 'string' ? parseTrackedChanges(st.stdout) : null;
  let headReachability = 'unreadable';
  if (!branch && headSha !== mainSha && FULL_SHA_RE.test(headSha)) {
    try {
      const reachable = git(['merge-base', '--is-ancestor', headSha, 'refs/remotes/origin/main']);
      headReachability = reachable?.status === 0 ? 'reachable' : reachable?.status === 1 ? 'unreachable' : 'unreadable';
    } catch { headReachability = 'unreadable'; }
  }
  const plan = planWrongBranchHeal({ branch, headSha, mainSha, adoptedHead, headReachability, changedPaths, hasMain, settings, inProgress });
  if (!plan.heal) return { healed: false, reason: plan.reason, ...(plan.detail ? { detail: plan.detail } : {}) };

  if (plan.savedRefNeeded) {
    // Only this path moves a detached tree. Re-check each proof before BOTH the save and the switch.
    const reverify = () => {
      let field = 'headSha';
      try {
        const liveHead = git(['rev-parse', '--verify', '--quiet', 'HEAD']);
        if (liveHead?.status !== 0 || out(liveHead) !== headSha) return { healed: false, reason: 'detached-state-changed', detail: { field } };
        field = 'mainSha';
        const liveMain = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']);
        if (liveMain?.status !== 0 || out(liveMain) !== mainSha) return { healed: false, reason: 'detached-state-changed', detail: { field } };
        field = 'status';
        const liveStatus = git(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
        if (liveStatus?.status !== 0 || typeof liveStatus.stdout !== 'string') return { healed: false, reason: 'status-unreadable' };
        if (parseTrackedChanges(liveStatus.stdout).length) return { healed: false, reason: 'detached-with-changes' };
        field = 'gitDir';
        const operations = readInProgress(git);
        if (operations === null) return { healed: false, reason: 'git-dir-unreadable' };
        if (operations.length) return { healed: false, reason: 'operation-in-progress', detail: { operations } };
        return null;
      } catch {
        return { healed: false, reason: field === 'status' ? 'status-unreadable' : field === 'gitDir' ? 'git-dir-unreadable' : 'detached-state-changed', detail: { field } };
      }
    };
    const changed = reverify();
    if (changed) return changed;
    let savedRef;
    try {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) return { healed: false, reason: 'save-failed' };
      savedRef = `refs/we/wrong-branch-heal/${timestamp}-${headSha.slice(0, 9)}`;
      const saved = git(['update-ref', savedRef, headSha, '0000000000000000000000000000000000000000']);
      if (saved?.status !== 0) return { healed: false, reason: 'save-failed' };
    } catch { return { healed: false, reason: 'save-failed' }; }
    const changedBeforeSwitch = reverify();
    if (changedBeforeSwitch) return { ...changedBeforeSwitch, detail: { ...changedBeforeSwitch.detail, savedRef } };
    try {
      const sw = git(['checkout', '--quiet', '--no-overwrite-ignore', 'main']);
      if (sw?.status !== 0) return { healed: false, reason: 'switch-failed', detail: { savedRef, stderr: String(sw?.stderr ?? '').slice(0, 300) } };
    } catch { return { healed: false, reason: 'switch-failed', detail: { savedRef } }; }
    return { healed: true, from: `(detached at ${headSha.slice(0, 9)})`, savedRef };
  }

  // Re-read right before the first mutation: an operation may have started since the plan was read.
  const again = planWrongBranchHeal({ branch, headSha, mainSha, changedPaths, hasMain, settings, inProgress: readInProgress(git) });
  if (!again.heal) return { healed: false, reason: again.reason, ...(again.detail ? { detail: again.detail } : {}) };

  let savedRef = null;
  if (changedPaths.length) {
    const created = git(['stash', 'create', `wrong-branch-heal: tracked changes on ${branch}`]);
    const sha = out(created);
    if (created.status !== 0 || !sha) return { healed: false, reason: 'save-failed' };
    savedRef = `refs/we/wrong-branch-heal/${now()}`;
    if (git(['update-ref', '-m', `wrong-branch-heal from ${branch}`, savedRef, sha]).status !== 0) {
      return { healed: false, reason: 'save-failed' };
    }
    // Only tracked store files change here (the rule proved it); untracked files are untouched by reset.
    if (git(['reset', '--hard', '--quiet', 'HEAD']).status !== 0) return { healed: false, reason: 'reset-failed', detail: { savedRef } };
  }
  const last = readInProgress(git);
  if (last === null || last.length) return { healed: false, reason: last ? 'operation-in-progress' : 'git-dir-unreadable', ...(last ? { detail: { operations: last, savedRef } } : { detail: { savedRef } }) };
  // NOT forced: an untracked file the switch would overwrite makes it fail, and we refuse instead of clobbering.
  const sw = git(['checkout', '--quiet', 'main']);
  if (sw.status !== 0) return { healed: false, reason: 'switch-failed', detail: { savedRef, stderr: String(sw.stderr ?? '').slice(0, 300) } };
  return { healed: true, from: branch || `(detached at ${headSha.slice(0, 9)})`, savedRef };
}
