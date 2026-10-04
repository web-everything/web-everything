/**
 * rebase-drop-manifest.mjs — the ONE proven "make a lane PR mergeable by rebasing onto main and dropping
 * the transient `.lane-manifest.json`" plumbing (#2198). Single source of truth, shared by the label
 * lander (`scripts/merge-ai-prs.mjs`, the `/drain`) and the resume finisher (`scripts/lane-resume.mjs land`,
 * #2202).
 *
 * WHY: every lane writes `.lane-manifest.json` to the SAME repo-root path. The first PR lands it on `main`;
 * every OTHER open lane PR then conflicts with `main` on that one shared path (modify/modify, or modify/delete
 * once it is stripped) — so a plain server-side `gh pr merge` lands at most ONE PR before the rest cascade to
 * CONFLICTING (observed 2026-07-03: one landed, ~24 went CONFLICTING on the manifest alone while the real code
 * merged clean). GitHub cannot auto-resolve it.
 *
 * FIX (proven this session): before merging each PR, rebuild its tip onto `main` with the manifest dropped,
 * using pure plumbing with NO branch checkout — so it stays inside the `guard-git-branch` single-branch rule
 * (pushing the rebuilt tip to a `lane/*` ref is already an allowed carve-out):
 *
 *   1. `git merge-tree --write-tree <base> <laneRef>`  → the merged tree (+ conflicted-file info on conflict).
 *   2. if the ONLY conflicted path is the manifest (or the merge is clean): read that tree into a TEMP index
 *      (`GIT_INDEX_FILE`, never touching HEAD/the working tree), `git rm --cached` the manifest,
 *      `git write-tree` → a resolved, manifest-free tree.
 *   3. `git commit-tree <tree> -p <base> -p <laneRef>` — `<base>` is the FIRST parent, so GitHub sees the
 *      branch as up-to-date (not BEHIND) and manifest-free (not CONFLICTING).
 *   4. push that commit to the `lane/*` ref (a fast-forward — the new commit has `<laneRef>` as an ancestor).
 *   → the caller then `gh pr merge`s the now-CLEAN PR.
 *
 * If `merge-tree` reports ANY conflict beyond the manifest, this returns `{ action: 'skip' }` — a real
 * conflict needs a human; the lander never force-resolves code.
 *
 * The orchestrator takes an injected `run(cmd, args, opts) -> { status, stdout, stderr }` so it is
 * unit-testable without a real repo (see `scripts/lib/__tests__/rebase-drop-manifest.test.mjs`).
 */

import { gitRun as gitRunner, ensureFullHistory } from './git-run.mjs';
import { applyCollisionHealToIndex } from './nnn-collision-heal.mjs';
import { refuseHeldPush } from '../conveyor/fix-procedure.mjs';

export const LANE_MANIFEST = '.lane-manifest.json';

/**
 * Parse `git merge-tree --write-tree` output. Pure.
 *   - Success (exit 0): stdout line 1 = the merged tree OID; no conflicts.
 *   - Conflict (exit ≠ 0): line 1 = the tree OID; a "Conflicted file info" block of
 *     `<mode> <object> <stage>\t<path>` lines follows (one line per unmerged stage, so a path repeats),
 *     terminated by a blank line before the informational messages.
 * @returns {{tree:string, clean:boolean, conflictPaths:string[]}} conflictPaths de-duplicated.
 */
export function parseMergeTree(stdout, exitCode) {
  const lines = String(stdout ?? '').split('\n');
  const tree = (lines[0] || '').trim();
  const clean = Number(exitCode) === 0;
  const paths = new Set();
  if (!clean) {
    for (const line of lines.slice(1)) {
      if (line.trim() === '') break; // blank line ends the conflicted-file-info block
      const m = line.match(/^\d{6} [0-9a-f]+ [0-3]\t(.+)$/);
      if (m) paths.add(m[1]);
    }
  }
  return { tree, clean, conflictPaths: [...paths] };
}

/**
 * Decide a merge-tree result's disposition wrt the transient manifest. Pure.
 *   'clean'         — no conflicts (the tip may still be BEHIND; the rebuild fast-forwards it).
 *   'manifest-only' — the ONLY conflicted path is the manifest → drop it and land.
 *   'real'          — a non-manifest path conflicts → a human must resolve; skip.
 * @param {{clean:boolean, conflictPaths:string[]}} parsed
 */
export function manifestConflictDisposition(parsed, manifest = LANE_MANIFEST) {
  if (parsed.clean) return 'clean';
  const paths = parsed.conflictPaths || [];
  if (paths.length === 0) return 'clean'; // exit≠0 but no parseable conflict paths → treat as no-op
  const nonManifest = paths.filter((p) => p !== manifest);
  if (paths.includes(manifest) && nonManifest.length === 0) return 'manifest-only';
  return 'real';
}

/** Guard thresholds (PR #3794). A rebuilt tip may grow a PR's changed-file count by at most this absolute slack... */
export const SCOPE_JUMP_SLACK = 25;
/** ...and may not multiply it by more than this factor. BOTH must be exceeded to refuse (small PRs may legitimately grow). */
export const SCOPE_JUMP_FACTOR = 3;

/**
 * PR #3794 — decide whether a rebuilt tip's changed-file count jumped implausibly far past the PR's previous
 * count (the signature of main's own commits being carried into the PR instead of just its own). Pure.
 * `prev`/`post` are file COUNTS; either being null/0 (unreadable / no baseline) means "cannot judge" -> ok.
 * @returns {{ok:boolean, prev:number|null, post:number|null, reason?:string}}
 */
export function scopeJumpVerdict(prev, post) {
  if (!Number.isFinite(prev) || !Number.isFinite(post) || prev <= 0) return { ok: true, prev, post };
  if (post > prev + SCOPE_JUMP_SLACK && post > prev * SCOPE_JUMP_FACTOR) {
    return { ok: false, prev, post, reason: `the rebuilt tip would change ${post} files against base, but the PR changed ${prev} before the rebase (more than +${SCOPE_JUMP_SLACK} and x${SCOPE_JUMP_FACTOR}) — main's own commits are probably being carried into the PR` };
  }
  return { ok: true, prev, post };
}

/** The default real git runner. #2923 — this used to be a LOCAL `(cmd, args, { env, cwd })` literal that named
 *  neither `input` nor `encoding`, so destructuring silently dropped them. `merge-ai-prs.mjs` imports THIS
 *  symbol and injects it into `rebaseDropContent` / `applyCollisionHealToIndex`, whose write-back passes
 *  `{ input: mergedText }` to `git hash-object -w --stdin` — the stdin vanished, git hashed the empty string
 *  at exit 0, and the drain staged and committed git's empty blob while reporting a successful auto-resolve.
 *  It is now a re-export of the ONE runner (`scripts/lib/git-run.mjs`), so no weaker same-named variant exists
 *  to inject by accident. Callers keep importing `gitRunner` unchanged. */
export { gitRunner };

/**
 * Rebuild a lane PR's tip onto `<base>` with the manifest dropped, via pure plumbing. Does NOT merge (the
 * caller does). Returns one of:
 *   { action:'rebased', newCommit, dropped, base, laneRef } — pushed a manifest-free, up-to-date tip.
 *   { action:'current', newCommit, reason, base, laneRef }  — tip already on base AND manifest-free; no rebuild
 *                                                             (idempotency — nothing minted, nothing pushed).
 *   { action:'skip',  reason, conflictPaths }               — a real (non-manifest) conflict; untouched.
 *   { action:'error', reason }                              — a plumbing step failed.
 *
 * @param {object} o
 * @param {string} o.laneRef            the lane ref name (e.g. `lane/batch-…-2198`) — pushed back to `refs/heads/<laneRef>`.
 * @param {string} [o.base='origin/main']
 * @param {string} [o.remote='origin']
 * @param {string} [o.readRef]          the ref to FEED the merge inputs (defaults to `<remote>/<laneRef>`);
 *                                       in a fresh clone (#2197) the bare `<laneRef>` does not resolve.
 * @param {boolean} [o.fetch=true]      fetch `<laneRef>` from `<remote>` first so `<remote>/<laneRef>` is current (#2231).
 * @param {string} [o.manifest='.lane-manifest.json']
 * @param {string} [o.message]          commit-tree message (defaults to a "drain: rebase … drop manifest" line).
 * @param {string} [o.tmpIndex]         temp index path for GIT_INDEX_FILE (default `.git/rebase-drop-index`).
 * @param {boolean}[o.healCollision=false] #2276 — ALSO renumber a colliding new backlog item in the SAME rebuilt
 *                                       tip (reusing #2222's `applyCollisionHealToIndex`), so the rebuild that
 *                                       already runs to shed the manifest also clears an `ids must be unique` dup
 *                                       against `<base>` — otherwise the rebuilt tip stays red and never merges.
 * @param {string} [o.cwd]              run every git invocation in THIS directory instead of `process.cwd()`
 *                                       (#2263) — routes the plumbing through a SIBLING clone (e.g. `../frontierui`)
 *                                       for a remote-repo candidate, so the local-only rebase-drop can rebuild a
 *                                       non-local lane tip too, given that repo's own clone is provisioned.
 * @param {(cmd:string,args:string[],opts?:object)=>{status:number,stdout:string,stderr:string}} [o.run] injected runner.
 */
export function rebaseDropManifest({
  laneRef,
  base = 'origin/main',
  remote = 'origin',
  readRef,
  fetch = true,
  manifest = LANE_MANIFEST,
  message,
  tmpIndex = '.git/rebase-drop-index',
  healCollision = false,
  cwd,
  run = gitRunner,
} = {}) {
  if (!laneRef) return { action: 'error', reason: 'no laneRef given' };

  // #2231 — in the isolated-clone drain model (#2197) the lane branch exists ONLY as the remote-tracking ref
  // `<remote>/<laneRef>`; the bare `<laneRef>` name does not resolve, so `merge-tree`/`commit-tree` given the
  // bare name fail with "not something we can merge" and the whole auto-rebase is inert. Fetch the lane ref
  // first (so the remote-tracking ref is current), then feed the RESOLVED `<remote>/<laneRef>` to the merge
  // inputs. The PUSH still targets the bare `refs/heads/<laneRef>` (that part was always correct).
  const mergeRef = readRef || `${remote}/${laneRef}`;
  if (fetch) {
    const f = run('git', ['fetch', remote, laneRef], { cwd });
    if (f.status !== 0) return { action: 'error', reason: `fetch ${laneRef} failed (${(f.stderr || '').split('\n')[0]})` };
  }

  const mt = run('git', ['merge-tree', '--write-tree', base, mergeRef], { cwd });
  let parsed = parseMergeTree(mt.stdout, mt.status);
  if (!parsed.tree) {
    const firstErr = (mt.stderr || '').split('\n')[0];
    // #x8pcbf3 (live incident, PR #2752) — FIX AND RETRY, not a bare error: a checkout that is ALREADY a
    // shallow clone inherits that shallow boundary onto any BRAND-NEW ref it fetches (like `laneRef`, just
    // fetched above), unless deepened first. The freshly-fetched ref then lands as its own grafted root commit
    // with no recorded parents, so `merge-tree` finds no common ancestor with `base` and fails `fatal: refusing
    // to merge unrelated histories` — a checkout DEFECT, not a real conflict, but indistinguishable from one by
    // that message alone. Only paid for on this (rare) failure path — the ordinary happy path never runs an
    // extra probe. See `we:scripts/lib/git-run.mjs#ensureFullHistory`'s own header for the full incident and
    // the live before/after evidence gathered against the real branch.
    if (/unrelated histories/i.test(firstErr)) {
      const history = ensureFullHistory(run, { cwd, remote });
      if (history.ok && history.unshallowed) {
        const retryMt = run('git', ['merge-tree', '--write-tree', base, mergeRef], { cwd });
        const retryParsed = parseMergeTree(retryMt.stdout, retryMt.status);
        if (retryParsed.tree) {
          parsed = retryParsed; // the checkout defect is fixed — fall through to ordinary processing below
        } else {
          const retryErr = (retryMt.stderr || '').split('\n')[0];
          return {
            action: 'error',
            reason: `merge-tree produced no tree (${retryErr}) — checkout was shallow, was unshallowed, and the merge STILL failed; `
              + 'this looks like a genuinely unrelated-history pair, not a checkout defect',
          };
        }
      } else {
        const why = history.ok ? 'checkout is not shallow' : `checkout is shallow and could not be unshallowed (${history.reason})`;
        return { action: 'error', reason: `merge-tree produced no tree (${firstErr}) — ${why}` };
      }
    } else {
      return { action: 'error', reason: `merge-tree produced no tree (${firstErr})` };
    }
  }

  const disp = manifestConflictDisposition(parsed, manifest);
  if (disp === 'real') return { action: 'skip', reason: `real conflict beyond ${manifest}`, conflictPaths: parsed.conflictPaths };

  // Build a resolved, manifest-free tree in a TEMP index — never touches HEAD or the working tree.
  const env = { GIT_INDEX_FILE: tmpIndex };
  const read = run('git', ['read-tree', parsed.tree], { env, cwd });
  if (read.status !== 0) return { action: 'error', reason: `read-tree failed (${(read.stderr || '').split('\n')[0]})` };
  // Drop the manifest if present (--ignore-unmatch: a clean merge with no manifest in the tree is fine).
  run('git', ['rm', '--cached', '--ignore-unmatch', manifest], { env, cwd });
  // #2276 — in the SAME rebuilt tip, renumber a colliding new backlog item against `<base>` (reusing #2222's
  // apply-to-index), so a rebuild that already runs to shed the manifest also clears an `ids must be unique`
  // dup. `parsed.tree` (the merged tree) already seeds this index, so the heal reads/stages against it. A heal
  // FAILURE is non-fatal to the manifest drop — the rebuilt tip still lands the manifest fix and the id dup is
  // left to the post-merge heal / a later pass; it never aborts the whole rebuild.
  let healed = [];
  if (healCollision) {
    const h = applyCollisionHealToIndex({ run, env, tree: parsed.tree, base });
    if (h.ok) healed = h.healed;
  }
  const wt = run('git', ['write-tree'], { env, cwd });
  const resolvedTree = String(wt.stdout || '').trim();
  if (wt.status !== 0 || !resolvedTree) return { action: 'error', reason: `write-tree failed (${(wt.stderr || '').split('\n')[0]})` };

  // IDEMPOTENCY SHORT-CIRCUIT (drain re-push churn bug). `rebaseDropManifest` used to ALWAYS `commit-tree` (minting a fresh SHA)
  // and force-push the rebuilt tip — even when the tip is ALREADY rebased on `base` AND already manifest-free.
  // The drain reads `hasManifest` from the PR *body* and fires this every pass, so a green, on-main,
  // manifest-free PR got its head SHA churned every pass → CI restarts → it never stays green long enough to
  // merge (a batch never converged). Skip the rebuild ONLY when BOTH hold: (a) `base` is already an ancestor of
  // the tip (the tip is NOT behind base — a genuinely BEHIND tip has `isAncestor === false` and still gets the
  // real rebase), AND (b) the tip's CURRENT tree already equals the manifest-free `resolvedTree` (a tip still
  // carrying a committed manifest has `curTreeOid !== resolvedTree` — the manifest was removed from resolvedTree
  // — so it still gets rebuilt to drop it). Over-conservative direction: when uncertain, rebuild.
  const curTreeOid = String(run('git', ['rev-parse', `${mergeRef}^{tree}`], { cwd }).stdout || '').trim();
  const isAncestor = run('git', ['merge-base', '--is-ancestor', base, mergeRef], { cwd }).status === 0;
  if (isAncestor && curTreeOid && curTreeOid === resolvedTree) {
    const curCommit = String(run('git', ['rev-parse', mergeRef], { cwd }).stdout || '').trim();
    // Guard: only claim 'current' if we can actually resolve the tip's commit sha; otherwise fall through to
    // the normal rebuild rather than return a bogus result.
    if (curCommit) {
      return { action: 'current', reason: 'tip already up-to-date on base and manifest-free — no rebuild needed', base, laneRef, newCommit: curCommit };
    }
  }

  // PR #3794 — SCOPE-JUMP GUARD: refuse to push a rebuilt tip whose changed-file count (vs `base`) exploded past the
  // PR's count before the rebase, and report it. Counts are read with `git diff --name-only`: BEFORE = the PR's own
  // contribution (`base...mergeRef`, merge-base form); AFTER = `base` vs the resolved tree (what the PR will show once
  // GitHub measures it against `base`). A read that fails or returns nothing means "cannot judge" and never blocks.
  const countFiles = (args) => {
    const r = run('git', ['diff', '--name-only', ...args], { cwd });
    return r.status === 0 ? String(r.stdout || '').split('\n').filter(Boolean).length : null;
  };
  const jump = scopeJumpVerdict(countFiles([`${base}...${mergeRef}`]), countFiles([base, resolvedTree]));
  if (!jump.ok) {
    return { action: 'error', guard: 'scope-jump', prevFiles: jump.prev, postFiles: jump.post, reason: `refusing to push ${laneRef}: ${jump.reason}` };
  }

  const healTag = healed.length ? `, renumber ${healed.map((r) => `#${r.oldNum}→#${r.newNum}`).join('/')}` : '';
  const msg = message || `drain: rebase ${laneRef} onto ${base}, drop transient ${manifest}${healTag}`;
  const ct = run('git', ['commit-tree', resolvedTree, '-p', base, '-p', mergeRef, '-m', msg], { cwd });
  const newCommit = String(ct.stdout || '').trim();
  if (ct.status !== 0 || !newCommit) return { action: 'error', reason: `commit-tree failed (${(ct.stderr || '').split('\n')[0]})` };

  // #4293 — refuse this mechanical push too if another fixer holds the LIVE fix claim on the PR this laneRef
  // belongs to (see `refuseHeldPush`'s own header for why the check lives here, not at each caller — this
  // function alone is reused by `scripts/lane-resume.mjs`, which a caller-side check would miss).
  const refusal = refuseHeldPush({ run, cwd, remote, branch: laneRef });
  if (refusal) return { action: 'error', reason: refusal.message };

  // Fast-forward push (newCommit descends from laneRef) to the guard-safe lane/* ref — no checkout.
  const push = run('git', ['push', remote, `${newCommit}:refs/heads/${laneRef}`], { cwd });
  if (push.status !== 0) return { action: 'error', reason: `push to ${laneRef} failed (${(push.stderr || '').split('\n')[0]})` };

  return { action: 'rebased', newCommit, dropped: disp === 'manifest-only', healed, base, laneRef };
}
