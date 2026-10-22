/**
 * @file scripts/lib/drain-unknown-mergeability.mjs
 * @description What a GitHub `mergeable: UNKNOWN` actually means for the drain, before it is ever reported as a skip.
 *
 * Live 2026-10-21 (web-everything#5798, also #5796, #5797, #5743, #5789, #5794 — 34 PRs / 41 skip lines in 48 h):
 * GitHub never computes `mergeable` for a PR that is IN its merge queue, nor for a MERGED / CLOSED one (a REST GET
 * keeps returning `null`/`unknown`). The drain classified all of them `unknown-mergeability` and logged a skip for
 * the whole time GitHub's own queue held them, then once more after GitHub had merged them. So:
 *  - MERGED / CLOSED          → a terminal status (`landed` / `closed`), not a skip; the follow-up runs elsewhere.
 *  - OPEN and in the queue    → status `in-merge-queue`, not a skip; GitHub owns mergeability while it is queued.
 *  - OPEN, not queued, UNKNOWN → the existing bounded re-read, then a LOCAL `git merge-tree --write-tree` check of
 *    the pinned head against the base. Only a clean local check lets the classifier treat it as mergeable; a
 *    conflict says CONFLICTING; an unreadable check keeps the UNKNOWN refusal. Never merges on UNKNOWN alone.
 * Pure helpers + an injected-IO local check (`run(cmd, args, {cwd})` → `{status, stdout, stderr}`).
 */

/** Terminal / queue statuses a verdict can carry; a verdict with one of these is not a skip. */
export const NON_SKIP_STATUSES = Object.freeze(['landed', 'closed', 'in-merge-queue']);

/** Is this verdict a not-a-skip status (queued / landed / closed)? Pure. */
export function isNonSkipStatus(v) {
  return !!v && NON_SKIP_STATUSES.includes(v.status);
}

/**
 * The status a fresh PR read implies before any mergeability rule runs, or null. Pure.
 * `state` is gh's OPEN/CLOSED/MERGED (absent on a listing row → null); `isInMergeQueue` is attached by the fresh read.
 */
export function prLifecycleStatus(pr) {
  const state = String(pr?.state || '').toUpperCase();
  if (state === 'MERGED') return { status: 'landed', reason: 'landed: already merged on GitHub — its numbering/resolve/regen follow-up runs on the landed path; not a skip' };
  if (state === 'CLOSED') return { status: 'closed', reason: 'closed: the PR was closed without merging — dropped from the pass; not a skip' };
  if (pr?.isInMergeQueue === true) return { status: 'in-merge-queue', reason: 'in-merge-queue: already in GitHub\'s merge queue — GitHub owns mergeability while it is queued (it reads UNKNOWN there); not a skip' };
  return null;
}

/** Is this an OPEN, not-queued PR whose GitHub mergeability is still UNKNOWN — the only case the local check runs for? Pure. */
export function needsLocalMergeCheck(pr) {
  if (!pr) return false;
  const state = String(pr.state || 'OPEN').toUpperCase();
  return state === 'OPEN' && pr.isInMergeQueue !== true && String(pr.mergeable || 'UNKNOWN').toUpperCase() === 'UNKNOWN'
    && String(pr.mergeStateStatus || 'UNKNOWN').toUpperCase() === 'UNKNOWN'; // both unknown: a known merge state is GitHub's answer
}

/**
 * Local conflict check of `headSha` against `origin/<base>`. Fetches `refs/pull/<num>/head` and the base, confirms the
 * fetched tip IS the pinned head, then `git merge-tree --write-tree` (exit 0 = clean, 1 = conflicts, else error).
 * @returns {{clean:true}|{conflict:true, files:string[]}|{error:string}}
 */
export function localMergeTreeCheck({ run, cwd, num, base, headSha }) {
  if (!cwd || !num || !base || !/^[0-9a-f]{40}$/.test(String(headSha || ''))) return { error: 'local merge check needs a clone, PR number, base and pinned 40-hex head' };
  const git = (args) => run('git', args, { cwd });
  const fb = git(['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  if (fb.status !== 0) return { error: `base fetch failed: ${String(fb.stderr || '').trim().split('\n').pop()}` };
  // The PR head alone in its own fetch, so FETCH_HEAD is unambiguously the PR tip.
  const f = git(['fetch', '--no-tags', '--quiet', 'origin', `refs/pull/${num}/head`]);
  if (f.status !== 0) return { error: `fetch failed: ${String(f.stderr || '').trim().split('\n').pop()}` };
  const tip = git(['rev-parse', 'FETCH_HEAD']);
  if (tip.status !== 0 || String(tip.stdout || '').trim() !== headSha) return { error: `fetched PR head ${String(tip.stdout || '').trim().slice(0, 9) || '?'} is not the pinned head ${headSha.slice(0, 9)}` };
  const mt = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', `origin/${base}`, headSha]);
  if (mt.status === 0) return { clean: true };
  if (mt.status === 1) return { conflict: true, files: String(mt.stdout || '').split('\n').slice(1).map((s) => s.trim()).filter(Boolean) };
  return { error: `merge-tree failed (exit ${mt.status}): ${String(mt.stderr || '').trim().split('\n').pop()}` };
}

/**
 * Apply a local check's answer to a still-UNKNOWN PR read (mutates and returns `pr`). Clean → MERGEABLE (merge state
 * left UNKNOWN), tagged `mergeabilityFrom: 'local-merge-tree'`; conflict → CONFLICTING; error →
 * unchanged (the UNKNOWN refusal stands). Pure apart from the mutation.
 */
export function applyLocalMergeCheck(pr, check) {
  if (!pr || !check) return pr;
  if (check.clean) {
    // Only conflict freedom is proven: the merge state stays as GitHub said (UNKNOWN), so the classifier still runs
    // its branch-protection checks (reviewDecision, required checks) before it may relieve that state.
    pr.mergeable = 'MERGEABLE';
    pr.mergeabilityFrom = 'local-merge-tree';
  } else if (check.conflict) {
    pr.mergeable = 'CONFLICTING';
    pr.mergeabilityFrom = 'local-merge-tree';
    pr.localConflictFiles = check.files || [];
  } else if (check.error) {
    pr.localMergeCheckError = check.error;
  }
  return pr;
}
