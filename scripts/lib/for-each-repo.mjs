import { safePoint, SafePointRestart, SafePointAbort } from './daemon-self-sync.mjs';
/**
 * @file scripts/lib/for-each-repo.mjs
 * @description `forEachRepo` — the shared per-repo loop, extracted from
 *   we:skills-src/conveyor/review-daemon.mjs's own `runReviewTickAllRepos` (multi-repo slice 2,
 *   we:backlog/x1rr9rh-multi-repo-slice-2-fix-daemon-loops-every-repo.md; the ratified
 *   `#conveyor-multi-repo-model` rule — see we:reports/2026-09-23-conveyor-multi-repo-gap-map.md).
 *
 * Runs `fn(repo)` once per repo, isolating ONE repo's failure from the rest — a plateau-app `gh` outage (or a
 * rate limit, or a repo with nothing owed) must never stop WE's own tick, the same "one bad entry never aborts
 * the rest" discipline every mechanical pass in this codebase already applies one level down (per-PR). Every
 * caller gets the SAME per-repo shape back: `{repo, result}` on success, `{repo, error}` (a one-line message)
 * on a throw — so a daemon's own aggregation logic never re-derives that isolation itself.
 *
 * DELIBERATELY IO-FREE — no `node:` imports, no side effects beyond calling `fn`. Several read-only-declared
 * operations (`scripts/operations/gate-health-io.mjs`, the `operator-queue.mjs`/`dispatch-eligibility.mjs`
 * chain) are asserted by a STATIC import-graph guard (`scripts/operations/__tests__/import-graph.mjs`, used by
 * `gate-health.test.mjs`/`http-adapter.test.mjs` and others) to reach ZERO `node:` built-ins anywhere in their
 * module graph. Keeping this helper in its own tiny file, rather than folding it into `./repo-profile.mjs`
 * (which already imports `node:fs`/`node:os`/`node:path`/`node:url` for `gateFor`'s real IO), means any future
 * read-only consumer can import `forEachRepo` for its own per-repo iteration without inheriting an IO
 * capability it is asserted never to have — the same reasoning `repo-profile.mjs`'s own header gives for
 * splitting itself out of `constellation-repos.mjs` in the first place.
 * @param {string[]} repos - the repos to iterate (e.g. `CONSTELLATION_REPOS` slugs).
 * @param {(repo: string) => *} fn - called once per repo; its return value or thrown error is captured, never
 *   rethrown.
 * @returns {Array<{repo: string, result: *}|{repo: string, error: string}>}
 */
export function forEachRepo(repos, fn) {
  const out = [];
  for (const repo of repos) {
    try {
      out.push({ repo, result: fn(repo) });
    } catch (e) {
      if (e instanceof SafePointRestart || e instanceof SafePointAbort) throw e;
      out.push({ repo, error: String((e && e.message) || e).split('\n')[0] });
    }
  }
  return out;
}

/** Sequential: the previous repo's dispatch and writes have finished before yielding. */
export async function forEachRepoAtSafePoints(repos, fn, label = 'repo') {
  const out = [];
  for (const repo of repos) {
    try { out.push({ repo, result: await fn(repo) }); }
    catch (error) {
      if (error instanceof SafePointRestart || error instanceof SafePointAbort) throw error;
      out.push({ repo, error: String(error?.message ?? error).split('\n')[0] });
    }
    await safePoint(`${label}:${repo}`);
  }
  return out;
}
