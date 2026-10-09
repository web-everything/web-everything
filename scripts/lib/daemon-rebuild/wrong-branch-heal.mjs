/** @file scripts/lib/daemon-rebuild/wrong-branch-heal.mjs — self-heal a daemon clone left on a known store branch.
 *
 * WHY (live 2026-10-09 06:52 ET): the verdict-ledger git store's writer ran `checkout -B ops/review-requests` in
 * the review daemon's OWN clone (not in its scratch worktree). The clone's tree became the ledger branch (no
 * `skills-src/`), the daemon died on MODULE_NOT_FOUND, and every rebuild refused `not-on-main` for ~1.5 h.
 *
 * THE RULE (pure, {@link planWrongBranchHeal}): heal ONLY when the clone sits on a branch named in the
 * `wrongBranchHeal.branches` setting AND every tracked change is under a `wrongBranchHeal.pathPrefixes` prefix
 * (store files). Anything else — an unknown branch, a detached HEAD, a change outside the store paths, no local
 * `main` — still refuses, exactly as before. Untracked files are never touched (a checkout that would overwrite
 * one fails, and the heal refuses).
 *
 * THE HEAL ({@link healWrongBranch}): save the tracked changes as a commit under a named ref
 * (`refs/we/wrong-branch-heal/<ts>`, via `stash create`, so nothing is lost), drop them from the tree, and switch
 * back to the local `main` (non-forced). The store's next append re-derives its rows from its own tip, so the
 * saved changes are an audit copy, not a pending write.
 */
import { readFileSync } from 'node:fs';
import { daemonRebuildSettingsPath } from './skip-unrelated.mjs';

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

/**
 * Pure: may this clone state be healed back to main?
 * @param {{branch: string|null, changedPaths: string[]|null, hasMain: boolean, settings: {branches: string[], pathPrefixes: string[]}}} o
 * @returns {{heal: true} | {heal: false, reason: string, detail?: object}}
 */
export function planWrongBranchHeal({ branch, changedPaths, hasMain, settings }) {
  if (!branch) return { heal: false, reason: 'detached-or-unreadable-head' };
  if (branch === 'main') return { heal: false, reason: 'already-on-main' };
  if (!settings.branches.includes(branch)) return { heal: false, reason: 'branch-not-allowlisted', detail: { branch } };
  if (!hasMain) return { heal: false, reason: 'no-local-main' };
  if (changedPaths === null) return { heal: false, reason: 'status-unreadable' };
  const foreign = changedPaths.filter((p) => !settings.pathPrefixes.some((pre) => p.startsWith(pre)));
  if (foreign.length) return { heal: false, reason: 'non-store-changes', detail: { foreign: foreign.slice(0, 10) } };
  return { heal: true };
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
 * @param {{git: Function, settings?: object, now?: () => number}} o  `git(args)` → `{status, stdout}`
 * @returns {{healed: true, from: string, savedRef: string|null} | {healed: false, reason: string, detail?: object}}
 */
export function healWrongBranch({ git, settings = resolveWrongBranchHealSettings(), now = Date.now }) {
  const out = (r) => String(r?.stdout ?? '').trim();
  const head = git(['symbolic-ref', '--short', 'HEAD']);
  const branch = head.status === 0 ? out(head) : null;
  const hasMain = git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).status === 0;
  const st = git(['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const changedPaths = st.status === 0 ? parseTrackedChanges(st.stdout) : null;
  const plan = planWrongBranchHeal({ branch, changedPaths, hasMain, settings });
  if (!plan.heal) return { healed: false, reason: plan.reason, ...(plan.detail ? { detail: plan.detail } : {}) };

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
  // NOT forced: an untracked file the switch would overwrite makes it fail, and we refuse instead of clobbering.
  const sw = git(['checkout', '--quiet', 'main']);
  if (sw.status !== 0) return { healed: false, reason: 'switch-failed', detail: { savedRef, stderr: String(sw.stderr ?? '').slice(0, 300) } };
  return { healed: true, from: branch, savedRef };
}
