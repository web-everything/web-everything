/**
 * @file scripts/lib/draft-promote-provider.mjs
 * @description THE PROVIDER PORT for the `promote-draft` effect (draft-first PRs, operator-approved
 *   2026-09-27) — the one `gh` call `scripts/operations/promote-draft-pr-dispatch.mjs` needs
 *   (`gh pr ready <pr>`), behind an injectable seam, mirroring `we:scripts/lib/forge-land-provider.mjs`'s own
 *   precedent (pure argv builder + injectable `exec`, so the exec itself is testable with no `gh` on PATH).
 *
 * WHY ITS OWN FILE, NOT A METHOD ON `forge-land-provider.mjs` — that port's own header declares itself the
 * SOLE ROUTE for `pr-land.mjs` only ("nothing outside `pr-land.mjs` should import this file directly").
 * `promote-draft-pr-dispatch.mjs` is a DIFFERENT mutating arc (the reconcile daemon un-drafting a PR, never
 * pr-land itself, which never merges or un-drafts anything post-open) — giving it a second, equally narrow
 * port keeps that sole-route invariant intact for both rather than widening `forge-land-provider.mjs`'s own.
 *
 * DEFAULT `exec` IS THROTTLED, same as `forge-land-provider.mjs` — `we:scripts/lib/gh-throttle.mjs#runGhSync`
 * gives this the shared concurrency cap + rate-limit backoff for free.
 *
 * IMPURE by construction in `createDraftPromoteProvider`; the module itself is pure.
 *
 * FIXED (we:backlog/x4ua3v8, live 2026-09-28): the daemon that drives this (`we:skills-src/conveyor/
 * reconcile-fix-dispatch-daemon.mjs#runPromoteDraftDispatchAllRepos`) runs from ONE process rooted in the WE
 * checkout but dispatches for EVERY constellation repo (`we:scripts/lib/for-each-repo.mjs`) — `cwd` never
 * changes between repos, only the `repo` slug threaded through the reconcile plan does. Relying on `gh`
 * inferring the repo from `cwd`'s git remote (the ORIGINAL convention here, copied from `createGhLandProvider`
 * — see that file's own header for why it is safe THERE: `pr-land.mjs`'s `cwd` is always a checkout of the
 * repo it is landing into) silently resolved every non-WE PR number against web-everything instead. Confirmed
 * live: `plateauapp/plateau-app#187` sat refused ("ready-failed … Command failed: gh pr ready 187") until
 * promoted by hand. Fix: an explicit `repo` (the gh `owner/name` slug) threaded through construction, appended
 * as `--repo <repo>` — mirrors `we:scripts/lib/review-label-provider.mjs`'s `GH_ARGV`, which never relied on
 * `cwd` inference in the first place. `repo` stays OPTIONAL (undefined omits `--repo`) so the byte-identical
 * WE default path (and every pre-existing unit test) is untouched.
 */

import { runGhSync } from './gh-throttle.mjs';

/** Build the `gh pr ready <pr>` args, optionally pinned to an explicit repo via `--repo` (owner/name slug).
 *  Pure. `gh pr ready` is idempotent server-side — GitHub no-ops (never errors) a PR that is already
 *  non-draft, so this never needs a pre-check of its own. `repo` omitted (undefined/null) leaves `gh` to infer
 *  the repo from `cwd`'s git remote, same as before this fix — only a caller that KNOWS which repo the PR
 *  belongs to (the multi-repo daemon path) opts into the explicit flag. */
export function buildReadyArgs(pr, repo) {
  const args = ['pr', 'ready', String(pr)];
  if (repo) args.push('--repo', repo);
  return args;
}

/**
 * The `gh` provider for this one effect. `cwd` bound at construction (mirrors `createGhLandProvider`'s own
 * `cwd`-at-construction convention). `repo` (the gh `owner/name` slug) is ALSO bound at construction, optional —
 * when given, every `ready()` call passes `--repo <repo>` explicitly rather than relying on `cwd` inference (see
 * the file header's we:backlog/x4ua3v8 fix note); when omitted, behavior is byte-identical to before the fix.
 * @param {{cwd?: string, repo?: string, exec?: Function}} [o]
 */
export function createDraftPromoteProvider({
  cwd,
  repo,
  exec = (args) => runGhSync(args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'pr-ready' },
  }).trim(),
} = {}) {
  return {
    name: 'gh',
    /** Un-draft `pr`. Returns the (usually empty) trimmed stdout, same convention as every other read/write
     *  method on `forge-land-provider.mjs`'s port. */
    ready(pr) {
      return exec(buildReadyArgs(pr, repo));
    },
  };
}
