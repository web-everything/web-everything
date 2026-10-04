/**
 * @file breaks/promote-draft-cross-repo.mjs — live break, 2026-09-28 (backlog card 4379, epic #4075,
 * PR #2880 author-continuation). The `promote-draft` pass's default `gh` provider let a cross-repo PR number
 * silently resolve against the WRONG repo.
 *
 * LIVE INCIDENT: the reconcile daemon's promote-draft pass (`we:scripts/operations/promote-draft-pr-dispatch.mjs`
 * → `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#runPromoteDraftDispatchAllRepos`) runs from ONE
 * process rooted in the WE checkout but dispatches for EVERY constellation repo
 * (`we:scripts/lib/for-each-repo.mjs`) — `cwd` never changes between repos, only the `repo` slug threaded
 * through the reconcile plan does. The default provider (`we:scripts/lib/draft-promote-provider.mjs`'s
 * `createDraftPromoteProvider`) called plain `gh pr ready <pr>` with no `--repo`, relying on `gh` inferring the
 * repo from `cwd`'s git remote — always the WE checkout. `plateauapp/plateau-app#187` (a green draft) sat refused
 * ("ready-failed … Command failed: gh pr ready 187") until promoted by hand, because `gh` resolved PR 187
 * against `web-everything/web-everything` instead.
 *
 * FIX: `467349c87` (`we:backlog/4379`) threads `runReconcilePromoteDraftDispatch`'s own already-resolved
 * `repoSlug` through to the provider as an explicit `--repo` — `undefined` (byte-identical) for the WE-default
 * path, the real slug otherwise (`we:scripts/lib/draft-promote-provider.mjs#buildReadyArgs`'s second `repo`
 * argument).
 *
 * WHY THIS BREAK IS NOT JUST THE EXISTING UNIT TESTS: `we:scripts/lib/__tests__/draft-promote-provider.test.mjs`
 * and the "cwd-inferred-repo fix" describe block in
 * `we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs` both pin the exact argv `gh` is called
 * with — but by mocking `runGhSync` (or the injected `exec`) directly, neither ever shells a REAL `gh` process
 * or exercises `gh`'s OWN cwd-inference fallback (`resolveRepoSlug` in `fake-gh-shim.mjs`, matching real `gh`'s
 * `git remote get-url origin` resolution). This scenario is the seam those unit tests cannot see: a real
 * subprocess `gh` invoked FROM the WE checkout's own directory, targeting a PR that lives in a DIFFERENT repo's
 * fake-GitHub store, over the soak harness's own `createFakeGithub`/`fake-gh-shim.mjs` (#3383) — proving the
 * cwd-inference hazard is real, not just an argv-spelling assertion.
 *
 * SCENARIO (no daemon ticking, no `runSoak` world — this is a single dispatch-call reproduction, mirroring
 * `we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs`'s own "real default provider" test but
 * one layer deeper, through a REAL `gh` subprocess):
 *   1. two real bare git origins are built, named by directory exactly like `web-everything/web-everything.git` /
 *      `plateauapp/plateau-app.git` (`we:scripts/operations/__tests__/helpers/real-repo.mjs`'s own "detail (2)"
 *      convention — the fake `gh`'s cwd-inference regex reads the slug off the directory name);
 *   2. `createFakeGithub` (`we:scripts/conveyor/__tests__/helpers/fake-gh.mjs`) registers BOTH repos in one
 *      store; a draft, green-CI PR is opened on the `plateau-app` side only;
 *   3. the REAL `runReconcilePromoteDraftDispatch` runs with `root` = the WE-side clone (so `gh`'s own cwd
 *      inference would resolve `web-everything/web-everything`), `repo: 'plateauapp/plateau-app'`, and NO injected
 *      `provider` — so the REAL default `createDraftPromoteProvider` construction is exercised, shelling the
 *      REAL `gh` (the fake shim) via the REAL `runGhSync` transport, with `reconcile`/`readHeadCheckState`/
 *      `clearAwaitingCi` injected only to skip the (separately-tested, orthogonal) reconcile-plan and stale-CI
 *      machinery.
 *
 * RED  = pre-fix: `gh pr ready <pr>` is called with NO `--repo` from the WE-checkout cwd, the plateau-app PR is
 *        never promoted (still draft), and the dispatch reports a `ready-failed` refusal.
 * GREEN = with the fix: `gh pr ready <pr> --repo plateauapp/plateau-app` is called explicitly, the PR promotes to
 *         ready, and there is no refusal.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createFakeGithub } from '../../__tests__/helpers/fake-gh.mjs';
import { git, writeLocalIdentity, DEFAULT_BRANCH } from '../../../operations/__tests__/helpers/real-repo.mjs';
import { runReconcilePromoteDraftDispatch } from '../../../operations/promote-draft-pr-dispatch.mjs';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

// Slugs come from the ONE authoritative table (`we:scripts/lib/constellation-repos.mjs`, exempted in
// `we:scripts/lib/we-only-checks.json`) rather than local literals, same convention as every other break
// module here that names a real constellation repo (see e.g. `worker-push-during-fix-claim.mjs`).
const WE_SLUG = CONSTELLATION_REPOS.we.slug;
const PLATEAU_SLUG = CONSTELLATION_REPOS['plateau-app'].slug;
const HEAD = 'lane/soak-cross-repo-promote';

/** A real bare origin at `<tmp>/<slug>.git` — the directory-name-carries-the-slug convention
 *  `real-repo.mjs`'s own header documents (detail (2)): both real `gh`'s cwd-inference and this scenario's
 *  fake-gh-shim read the slug off the LAST TWO path segments, never off a URL. */
function bareOriginFor(tmp, slug) {
  const dir = join(tmp, ...slug.split('/'));
  mkdirSync(dirname(dir), { recursive: true });
  git(['init', '--bare', '--quiet', '-b', DEFAULT_BRANCH, `${dir}.git`], { cwd: tmp });
  writeLocalIdentity(`${dir}.git`);
  return `${dir}.git`;
}

/** Clone `origin`, seed `main` with one commit, push — a minimal real checkout to drive plumbing off. */
function cloneAndSeedMain(origin, clonePath) {
  git(['clone', '--quiet', origin, clonePath], { cwd: dirname(clonePath) });
  writeLocalIdentity(clonePath);
  writeFileSync(join(clonePath, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], { cwd: clonePath });
  git(['commit', '--quiet', '-m', 'fixture: initial commit'], { cwd: clonePath });
  git(['push', '--quiet', 'origin', DEFAULT_BRANCH], { cwd: clonePath });
}

function commitBranch(clonePath, branch, files, from = DEFAULT_BRANCH) {
  git(['checkout', '--quiet', '-B', branch, from], { cwd: clonePath });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(clonePath, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(['add', '-A'], { cwd: clonePath });
  git(['commit', '--quiet', '-m', `fixture: ${branch}`], { cwd: clonePath });
  git(['push', '--quiet', 'origin', branch], { cwd: clonePath });
}

/** Run `fn()` with `patch` merged into `process.env` for the duration — restores every touched key exactly,
 *  never a bulk `process.env = …` reassignment (unreliable on that special object). */
function withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  Object.assign(process.env, patch);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

export default {
  id: 'promote-draft-cross-repo',
  title: 'the promote-draft dispatcher\'s default provider omits an explicit --repo, so a cross-repo PR number silently resolves against the wrong constellation repo',
  card: 'we:backlog/4379, live incident plateau-app#187, PR #2880 (lane/promote-draft-cross-repo)',
  fixedBy: {
    sha: '467349c87',
    where: 'lane/promote-draft-cross-repo',
    paths: ['scripts/lib/draft-promote-provider.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs'],
  },
  fixPresent(root) {
    try {
      const dispatch = readFileSync(join(root, 'scripts/operations/promote-draft-pr-dispatch.mjs'), 'utf8');
      const provider = readFileSync(join(root, 'scripts/lib/draft-promote-provider.mjs'), 'utf8');
      return /repoKey === 'we' \? undefined : repoSlug/.test(dispatch)
        && /export function buildReadyArgs\(pr, repo\)/.test(provider);
    } catch { return false; }
  },
  async run({ log = () => {} } = {}) {
    const tmp = mkdtempSync(join(tmpdir(), 'soak-promote-cross-repo-'));
    const violations = [];
    const say = (line) => { log(line); };
    try {
      const weOrigin = bareOriginFor(tmp, WE_SLUG);
      const weClone = join(tmp, 'we-clone');
      cloneAndSeedMain(weOrigin, weClone);

      const plateauOrigin = bareOriginFor(tmp, PLATEAU_SLUG);
      const plateauClone = join(tmp, 'plateau-clone');
      cloneAndSeedMain(plateauOrigin, plateauClone);
      commitBranch(plateauClone, HEAD, { 'soak/cross-repo.txt': 'draft PR content\n' });

      const gh = createFakeGithub({
        root: join(tmp, 'fake-gh-store'),
        repos: [
          { slug: WE_SLUG, originPath: weOrigin, defaultBranch: DEFAULT_BRANCH },
          { slug: PLATEAU_SLUG, originPath: plateauOrigin, defaultBranch: DEFAULT_BRANCH },
        ],
      });
      try {
        const pr = gh.openPr({
          repo: PLATEAU_SLUG, head: HEAD, base: DEFAULT_BRANCH,
          title: 'soak: draft PR that lives in a different constellation repo than the dispatcher\'s own cwd',
          body: 'No backlog item.', isDraft: true,
          checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        });
        say(`setup: plateau-app PR #${pr} (${HEAD}), draft, green — dispatching from WE checkout ${weClone}`);

        const before = gh.pr(PLATEAU_SLUG, pr);
        if (before.isDraft !== true) violations.push({ invariant: 'setup', detail: `PR #${pr} was not opened as a draft` });

        const result = withEnv(gh.env, () => runReconcilePromoteDraftDispatch({
          root: weClone,
          repo: PLATEAU_SLUG,
          reconcile: () => ({
            dispatch: [{ kind: 'promote-draft', prNumber: pr, headRefOid: before.headRefOid }],
            refusals: [],
          }),
          checkStaleness: () => ({}),
          readHeadCheckState: () => ({ state: 'green', why: 'soak: injected green', counts: {} }),
          clearAwaitingCi: () => {},
          // `provider` deliberately OMITTED — the whole point is exercising the REAL default construction.
        }));

        const readyCalls = gh.calls().filter((c) => c.argv[0] === 'pr' && c.argv[1] === 'ready' && c.argv.includes(String(pr)));
        const readyCall = readyCalls[readyCalls.length - 1];
        say(`dispatch result: ${JSON.stringify(result)}; gh calls: ${JSON.stringify(readyCalls.map((c) => c.argv))}`);

        if (!readyCall) {
          violations.push({ invariant: 'no-ready-call', detail: `no promote-draft "ready" call was ever made for PR #${pr} — result: ${JSON.stringify(result)}` });
        } else if (!readyCall.argv.includes('--repo')) {
          violations.push({
            invariant: 'cwd-inferred-repo',
            detail: `the promote-draft "ready" call for PR #${pr} carried no explicit repo flag — it ran from the WE checkout's own cwd (${readyCall.cwd}) while the PR lives in the plateau-app repo — the live we:backlog/4379 defect`,
          });
        } else {
          const repoIdx = readyCall.argv.indexOf('--repo');
          const repoArg = readyCall.argv[repoIdx + 1];
          if (repoArg !== PLATEAU_SLUG) {
            violations.push({ invariant: 'wrong-repo-arg', detail: `the promote-draft "ready" call for PR #${pr} named the wrong repo (${repoArg}), expected the plateau-app repo` });
          }
        }

        const after = gh.pr(PLATEAU_SLUG, pr);
        if (after.isDraft !== false) {
          violations.push({ invariant: 'not-promoted', detail: `plateau-app PR #${pr} is still a draft after the promote-draft dispatch — refusals: ${JSON.stringify(result.refusals)}` });
        }
        const refusal = result.refusals.find((r) => r.pr === pr);
        if (refusal) {
          violations.push({ invariant: 'refused', detail: `the promote-draft dispatch refused PR #${pr}: ${JSON.stringify(refusal)}` });
        }
      } finally {
        gh.cleanup();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return { name: 'break:promote-draft-cross-repo', violations, ticks: [] };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
