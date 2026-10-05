/**
 * @file scripts/conveyor/__tests__/fix-procedure.test.mjs — the fix procedure (operator-approved 2026-09-27,
 *   live incident PR #2811).
 * @description Proves the four halves of the procedure:
 *   1. the per-PR FIX CLAIM (`fix-procedure.mjs`) — take / refuse / heartbeat / release, on the #2789 store;
 *   2. while a claim is live: the planner refuses every dispatch (`fix-claimed`, including `promote-draft`), a
 *      dispatcher refuses to spawn, a push by anyone else is refused (`pushRefusal`, `guard-bash.mjs#reason`),
 *      and the status tagger reads `fixing`;
 *   3. stand-down semantics — a concurrent-author stop is a PAUSE (re-arms on the next head or after quiet),
 *      the legacy #2811 comment is reclassified, and a re-armed dispatch row carries the saved alt branch;
 *   4. the fix daemon's claim-refresh sweep no longer throws on a `fixing` claim (it used to mint a session slug
 *      for the unknown kind).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  acquireFixClaim, releaseFixClaim, heartbeatFixClaim, readLiveFixClaim, pushRefusal, isClaimHolder,
  fixBegin, fixEnd, withAltBranchHint, repoKeyFromRemoteUrl, repoKeyForCheckout, DEFAULT_FIX_CLAIM_TTL_MINUTES,
  FIX_BEGIN_MARKER, FIX_END_MARKER, FIXING_LABEL, STOOD_DOWN_LABEL, parseGitPush, resolvePushDestination,
  fixBeginRefusalMessage, refuseHeldPush, parseGitPushes, resolvePushDestinations, pushTargetUnreliable,
  isInfraStallCompletion,
} from '../fix-procedure.mjs';
import { FIX_END_INFRA_STALL_PREFIX } from '../../lib/ruling-ledger.mjs';
import { acquireFixDispatchClaim, refreshLiveFixDispatchClaims, releaseSessionFixDispatchClaims, readFixDispatchClaim } from '../fix-dispatch-claim.mjs';
import { fixDispatchClaimRoot } from '../fix-claim-store.mjs';
import {
  STAND_DOWN_MARKER, CONCURRENT_AUTHOR_PAUSE_MARKER, buildConcurrentAuthorPauseComment, concurrentAuthorPauses,
  countTerminalStandDowns, countStandDownComments, parseAltBranch, buildStandDownComment,
  isConcurrentAuthorStandDownBody, LEGACY_CONCURRENT_AUTHOR_CUTOFF,
} from '../stand-down.mjs';
import { planReconcile, countUnresolvedStandDowns, CONCURRENT_AUTHOR_QUIET_MS } from '../reconcile-core.mjs';
import { enrichPrsWithFixClaims } from '../reconcile-pass.mjs';
import { deriveReviewStatus, tagReviewStatus, applyReviewStatus } from '../review-status-tag.mjs';
import { dispatchFix } from '../reconcile-fix-dispatch.mjs';
import { dispatchCiHeal } from '../../operations/ci-heal-pr-dispatch.mjs';
import { runReconcilePromoteDraftDispatch } from '../../operations/promote-draft-pr-dispatch.mjs';
import { DISPATCH_EFFECT } from '../../operations/dispatch-lane.mjs';
import { reason as guardReason, decide as guardDecide, computeFixClaimCtx } from '../../guard-bash.mjs';
import { execFileSync } from 'node:child_process';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fix-procedure-test-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const T0 = Date.parse('2026-09-27T15:00:00.000Z');
const MIN = 60_000;
const AUTOMATION = { login: 'web-everything' };
const BRANCH = 'lane/run-rating-slice1-mechanical-grade';

/** PR #2811's REAL stand-down comment body, verbatim from the live thread (2026-09-27T15:45:27Z). */
const LIVE_2811_STAND_DOWN = [
  STAND_DOWN_MARKER,
  '',
  'conveyor fix agent stopped rather than guessing: a genuine same-line conflict with `main` blocked the repair. concurrent author pushed overlapping fixes (60f0f3d57) mid-repair; remaining fixes saved on lane/run-rating-slice1-fix-2811-alt (3b24fcc18) for cherry-pick',
  '',
  'The PR was left EXACTLY as the reviewer left it — no label was changed, the review was not re-armed, and nothing was re-pushed. This comment is the durable record that a fixer *deliberately stood down* here, which is what tells the reconciler apart from a fixer that simply died.',
].join('\n');

describe('the fix claim', () => {
  it('a second fixer is refused while the first holds it; the holder re-begins reentrantly', () => {
    const a = acquireFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', why: 'address review', branch: BRANCH, lockRoot: root, nowMs: T0 });
    expect(a).toMatchObject({ ok: true });
    const b = acquireFixClaim({ repo: 'web-everything/web-everything', pr: 2811, who: 'rubric-worker', lockRoot: root, nowMs: T0 + MIN });
    expect(b).toMatchObject({ ok: false, reason: 'held', heldBy: 'fixer:fix-2811' });
    expect(acquireFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', token: a.token, lockRoot: root, nowMs: T0 + 2 * MIN })).toMatchObject({ ok: true, reason: 'own' });
    // the reentrant re-begin kept the branch it was first given
    expect(readLiveFixClaim({ repo: 'we', pr: 2811, lockRoot: root, nowMs: T0 + 2 * MIN }).meta.branch).toBe(BRANCH);
  });

  it('expires on its TTL unless heartbeat-refreshed, and only the holder may release it', () => {
    acquireFixClaim({ repo: 'we', pr: 7, who: 'w', lockRoot: root, nowMs: T0 });
    const late = T0 + (DEFAULT_FIX_CLAIM_TTL_MINUTES + 1) * MIN;
    expect(readLiveFixClaim({ repo: 'we', pr: 7, lockRoot: root, nowMs: late })).toBeNull();
    const { token } = acquireFixClaim({ repo: 'we', pr: 8, who: 'w', lockRoot: root, nowMs: T0 });
    expect(heartbeatFixClaim({ repo: 'we', pr: 8, who: 'w', token, lockRoot: root, nowMs: late - MIN })).toEqual({ refreshed: true });
    expect(readLiveFixClaim({ repo: 'we', pr: 8, lockRoot: root, nowMs: late })).not.toBeNull();
    expect(releaseFixClaim({ repo: 'we', pr: 8, who: 'someone-else', token, lockRoot: root })).toMatchObject({ released: false, reason: 'not-owner' });
    expect(releaseFixClaim({ repo: 'we', pr: 8, who: 'w', token, lockRoot: root })).toMatchObject({ released: true });
  });

  it('a worker is refused while the daemon\'s own dispatched fixer (fix-<pr>) holds the spawn claim — that fixer itself is not', () => {
    acquireFixDispatchClaim({ repo: 'we', pr: 2811, kind: 'fix', owner: 'daemon:1', lockRoot: root, nowMs: T0 });
    expect(acquireFixClaim({ repo: 'we', pr: 2811, who: 'rubric-worker', lockRoot: root, nowMs: T0 + MIN }))
      .toMatchObject({ ok: false, reason: 'dispatched-fixer', heldBy: 'fix-2811' });
    expect(acquireFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ ok: true });
  });
});

describe('pushes while a claim is live', () => {
  beforeEach(() => {
    acquireFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', sessionId: 'sess-fixer', branch: BRANCH, lockRoot: root, nowMs: T0 });
  });
  // `dispatchFix` reads the claim at the REAL clock, so its case takes a claim stamped now.
  const claimNow = () => acquireFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', lockRoot: root, nowMs: Date.now() });

  it('refuses anyone else\'s push to the claimed branch, allows the holder (by session, or by WE_FIX_WHO for a session-less claim)', () => {
    const worker = pushRefusal({ repo: 'we', branch: `refs/heads/${BRANCH}`, sessionId: 'sess-worker', lockRoot: root, nowMs: T0 + MIN });
    expect(worker).toMatchObject({ refused: true, pr: 2811, holder: 'fix-2811' });
    expect(worker.message).toMatch(/fix-2811 holds the fix claim on PR #2811/);
    expect(pushRefusal({ repo: 'we', branch: BRANCH, sessionId: 'sess-fixer', lockRoot: root, nowMs: T0 + MIN })).toBeNull();
    expect(pushRefusal({ repo: 'we', branch: 'lane/other', sessionId: 'sess-worker', lockRoot: root, nowMs: T0 + MIN })).toBeNull();
    expect(pushRefusal({ repo: 'frontierui', branch: BRANCH, sessionId: 'sess-worker', lockRoot: root, nowMs: T0 + MIN })).toBeNull();
    // A claim taken with no session id (a non-Claude worker) is held by its `who` PLUS the token fix-begin minted.
    const w = acquireFixClaim({ repo: 'we', pr: 2900, who: 'rubric-worker', branch: 'lane/worker-owned', lockRoot: root, nowMs: T0 });
    expect(pushRefusal({ repo: 'we', branch: 'lane/worker-owned', who: 'rubric-worker', token: w.token, lockRoot: root, nowMs: T0 + MIN })).toBeNull();
    expect(pushRefusal({ repo: 'we', branch: 'lane/worker-owned', who: 'someone-else', token: w.token, lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ refused: true });
  });

  // Review finding round 2 (PR #2821): a session-less claim was held by the public `who` alone, so a SECOND worker
  // passing the same conventional `--who` was treated as the holder. fix-begin now mints a per-claim token.
  it('a session-less claim is bound to the token fix-begin minted: a second worker with the same `who` is refused', () => {
    const first = acquireFixClaim({ repo: 'we', pr: 2900, who: 'finisher', branch: 'lane/worker-owned', lockRoot: root, nowMs: T0 });
    expect(first).toMatchObject({ ok: true });
    expect(first.token).toMatch(/^[0-9a-f]{32,}$/);
    // The token never lands in the claim store in the clear (the store is readable by every local process).
    expect(JSON.stringify(readLiveFixClaim({ repo: 'we', pr: 2900, lockRoot: root, nowMs: T0 }))).not.toContain(first.token);
    const second = { who: 'finisher' }; // same public who, no token (or a wrong one)
    expect(pushRefusal({ repo: 'we', branch: 'lane/worker-owned', ...second, lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ refused: true });
    expect(pushRefusal({ repo: 'we', branch: 'lane/worker-owned', ...second, token: 'f'.repeat(32), lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ refused: true });
    expect(acquireFixClaim({ repo: 'we', pr: 2900, ...second, lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ ok: false, reason: 'token-mismatch' });
    expect(heartbeatFixClaim({ repo: 'we', pr: 2900, ...second, lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ refreshed: false, reason: 'token-mismatch' });
    expect(releaseFixClaim({ repo: 'we', pr: 2900, ...second, lockRoot: root })).toMatchObject({ released: false, reason: 'token-mismatch' });
    // The first worker keeps every right with its token.
    const mine = { who: 'finisher', token: first.token };
    expect(pushRefusal({ repo: 'we', branch: 'lane/worker-owned', ...mine, lockRoot: root, nowMs: T0 + MIN })).toBeNull();
    expect(acquireFixClaim({ repo: 'we', pr: 2900, ...mine, lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ ok: true, reason: 'own' });
    expect(heartbeatFixClaim({ repo: 'we', pr: 2900, ...mine, lockRoot: root, nowMs: T0 + MIN })).toEqual({ refreshed: true });
    expect(releaseFixClaim({ repo: 'we', pr: 2900, ...mine, lockRoot: root })).toMatchObject({ released: true });
  });

  it('a session-bound claim is never rebound, pushed, heartbeat or released by a caller that only knows the public `who`', () => {
    // `who` is printed on the PR thread (`**Who:** \`fix-2811\``) — an impostor session re-uses it verbatim.
    const impostor = { who: 'fix-2811', sessionId: 'sess-impostor' };
    expect(acquireFixClaim({ repo: 'we', pr: 2811, ...impostor, branch: BRANCH, lockRoot: root, nowMs: T0 + MIN }))
      .toMatchObject({ ok: false, reason: 'session-mismatch' });
    expect(pushRefusal({ repo: 'we', branch: BRANCH, ...impostor, lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ refused: true });
    expect(pushRefusal({ repo: 'we', branch: BRANCH, who: 'fix-2811', lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ refused: true });
    expect(heartbeatFixClaim({ repo: 'we', pr: 2811, ...impostor, lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ refreshed: false, reason: 'session-mismatch' });
    expect(releaseFixClaim({ repo: 'we', pr: 2811, ...impostor, lockRoot: root })).toMatchObject({ released: false, reason: 'session-mismatch' });
    // The claim is untouched: still bound to the original session, which keeps every right.
    expect(readLiveFixClaim({ repo: 'we', pr: 2811, lockRoot: root, nowMs: T0 + MIN }).meta.sessionId).toBe('sess-fixer');
    expect(pushRefusal({ repo: 'we', branch: BRANCH, sessionId: 'sess-fixer', lockRoot: root, nowMs: T0 + MIN })).toBeNull();
    expect(acquireFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', sessionId: 'sess-fixer', lockRoot: root, nowMs: T0 + MIN })).toMatchObject({ ok: true, reason: 'own' });
    expect(heartbeatFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', sessionId: 'sess-fixer', lockRoot: root, nowMs: T0 + MIN })).toEqual({ refreshed: true });
    expect(releaseFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', sessionId: 'sess-fixer', lockRoot: root })).toMatchObject({ released: true });
  });

  it('the ci-heal dispatcher refuses to spawn while a fix claim is live (claimRoot threaded to the claim read)', async () => {
    claimNow();
    const spawned = [];
    const r = await dispatchCiHeal(
      { itemNum: null, pr: 2811, laneRef: BRANCH, scope: ['we:x'], lane: 3, headRefOid: 'a'.repeat(40) },
      { readBrief: () => '# {{PR_NUM}}', claimRoot: root, sinks: { [DISPATCH_EFFECT]: async (p) => { spawned.push(p); return { handle: 'x' }; } } },
    );
    expect(r).toMatchObject({ held: true, reason: 'fix-claimed', heldBy: 'fix-2811' });
    expect(spawned).toHaveLength(0);
  });

  it('guard-bash denies a raw `git push` to the claimed lane ref (fixClaimedBranches from the IO shell)', () => {
    const fixClaimedBranches = [{ branch: BRANCH, message: 'push refused: fix-2811 holds the fix claim' }];
    expect(guardReason(`git push origin HEAD:refs/heads/${BRANCH}`, { fixClaimedBranches })).toMatch(/fix-2811 holds the fix claim/);
    expect(guardReason(`git push --force-with-lease origin HEAD:${BRANCH}`, { fixClaimedBranches })).toMatch(/fix-2811/);
    expect(guardReason('git push origin HEAD:refs/heads/lane/unrelated', { fixClaimedBranches })).toBeNull();
    expect(guardReason(`git push origin HEAD:refs/heads/${BRANCH}`)).toBeNull(); // inert without the IO shell's list
    // Review finding round 2: a bare `git push` names no lane ref. Plain, it is already denied by the #2203
    // main-push rule; with that rule's `MAIN_PUSH_OK=1` override it reached the fix-claim arm with NO target.
    // The IO shell now resolves the implicit target (`pushTargets`).
    expect(guardReason('git push', { fixClaimedBranches, pushTargets: [BRANCH] })).toMatch(/direct push to `main` is blocked/);
    expect(guardReason('MAIN_PUSH_OK=1 git push', { fixClaimedBranches, pushTargets: [BRANCH] })).toMatch(/fix-2811/);
    expect(guardReason('MAIN_PUSH_OK=1 git push --force-with-lease origin', { fixClaimedBranches, pushTargets: [BRANCH] })).toMatch(/fix-2811/);
    expect(guardReason('MAIN_PUSH_OK=1 git push', { fixClaimedBranches, pushTargets: ['lane/unrelated'] })).toBeNull();
  });

  it('parseGitPush reads the remote and refspecs of a push, whatever its options', () => {
    expect(parseGitPush('git push')).toEqual({ remote: null, refspecs: [], all: false, dir: null });
    expect(parseGitPush(`git push origin HEAD:refs/heads/${BRANCH}`)).toEqual({ remote: 'origin', refspecs: [`HEAD:refs/heads/${BRANCH}`], all: false, dir: null });
    expect(parseGitPush('git push -u --force-with-lease=x -o ci.skip upstream +main:lane/a lane/b')).toEqual({ remote: 'upstream', refspecs: ['+main:lane/a', 'lane/b'], all: false, dir: null });
    expect(parseGitPush('cd /x && git -C /y push --repo=we-remote && echo ok')).toEqual({ remote: 'we-remote', refspecs: [], all: false, dir: '/y' });
    expect(parseGitPush('git -c a=b -C "/my lanes/l5" push --all origin')).toEqual({ remote: 'origin', refspecs: [], all: true, dir: '/my lanes/l5' });
    expect(parseGitPush('git status')).toBeNull();
  });

  // Self-review (round-2 repair): `git -C <dir> push` / `git -c k=v push` skipped the arm entirely, and `--all` /
  // `--mirror` / a glob refspec pushed every branch while resolving to the current one only.
  it('guard-bash reads `git -C <dir> push` and `git -c k=v push`, and a `*` target matches every claimed branch', () => {
    const fixClaimedBranches = [{ branch: BRANCH, message: 'push refused: fix-2811 holds the fix claim' }];
    expect(guardReason(`git -C /tmp/lane push origin HEAD:refs/heads/${BRANCH}`, { fixClaimedBranches })).toMatch(/fix-2811/);
    expect(guardReason(`git -c a=b push origin HEAD:${BRANCH}`, { fixClaimedBranches })).toMatch(/fix-2811/);
    expect(guardReason('MAIN_PUSH_OK=1 git -C ../l5 push', { fixClaimedBranches, pushTargets: [BRANCH] })).toMatch(/fix-2811/);
    expect(guardReason('MAIN_PUSH_OK=1 git push --all origin', { fixClaimedBranches, pushTargets: ['*'] })).toMatch(/fix-2811/);
    expect(guardReason('git -C /tmp/lane push origin HEAD:refs/heads/lane/unrelated', { fixClaimedBranches })).toBeNull();
  });

  // Review findings round 2 (PR #2821): the raw-push hook used `origin` for the repo (not the remote pushed to),
  // and missed a bare `git push` whose target is implicit. resolvePushDestination answers both from the command.
  it('resolvePushDestination: the repo of the remote actually pushed to, and the implicit target of a bare push', () => {
    const git = (map) => (cmd, args) => {
      const k = args.join(' ');
      if (k in map) return map[k];
      throw new Error(`no ${k}`);
    };
    const urls = {
      'remote get-url origin': 'git@github.com:frontier-ui/frontierui.git\n',
      'remote get-url we': 'https://github.com/web-everything/web-everything.git\n',
    };
    // A frontierui checkout pushing an explicit lane ref to its `we` remote is a WE push.
    expect(resolvePushDestination(`git push we HEAD:refs/heads/${BRANCH}`, { cwd: '/lane', exec: git(urls) }))
      .toEqual({ repoKey: 'we', branches: [BRANCH] });
    // A URL remote is read directly.
    expect(resolvePushDestination(`git push https://github.com/web-everything/web-everything.git HEAD:${BRANCH}`, { cwd: '/lane', exec: git(urls) }))
      .toEqual({ repoKey: 'we', branches: [BRANCH] });
    // A bare push: the branch's push remote and its push/upstream ref are the target (fail-closed: all candidates).
    const bare = git({
      ...urls,
      'symbolic-ref -q --short HEAD': `${BRANCH}\n`,
      [`config --get branch.${BRANCH}.pushRemote`]: 'we\n',
      'rev-parse --abbrev-ref --symbolic-full-name @{push}': `we/${BRANCH}\n`,
    });
    expect(resolvePushDestination('git push', { cwd: '/lane', exec: bare })).toEqual({ repoKey: 'we', branches: [BRANCH] });
    // A lane clone's local `main` tracking a lane ref: the upstream ref is the target, not `main`'s own name only.
    const tracking = git({
      ...urls,
      'symbolic-ref -q --short HEAD': 'main\n',
      'config --get branch.main.remote': 'we\n',
      'config --get branch.main.merge': `refs/heads/${BRANCH}\n`,
    });
    expect(resolvePushDestination('git push', { cwd: '/lane', exec: tracking })).toEqual({ repoKey: 'we', branches: ['main', BRANCH] });
    expect(resolvePushDestination('git push we HEAD', { cwd: '/lane', exec: tracking })).toEqual({ repoKey: 'we', branches: ['main', BRANCH] });
    expect(resolvePushDestination('git log', { cwd: '/lane', exec: tracking })).toBeNull();
    // --all / --mirror / a glob refspec: every branch (fail-closed).
    expect(resolvePushDestination('git push --all we', { cwd: '/lane', exec: tracking })).toEqual({ repoKey: 'we', branches: ['*'] });
    expect(resolvePushDestination('git push we refs/heads/lane/*:refs/heads/lane/*', { cwd: '/lane', exec: tracking })).toEqual({ repoKey: 'we', branches: ['*'] });
    // `git -C <dir>`: resolved in THAT checkout, not the hook's cwd.
    const seen = [];
    const inDir = (cmd, args, opts) => { seen.push(opts.cwd); return tracking(cmd, args); };
    expect(resolvePushDestination('git -C ../other push', { cwd: '/w/lane', exec: inDir })).toEqual({ repoKey: 'we', branches: ['main', BRANCH] });
    expect(new Set(seen)).toEqual(new Set(['/w/other']));
  });

  // Destination matrix (#4326 item 4): every potentially updated claimed branch must be named.
  describe('resolvePushDestination: push.default / remote.<name>.push', () => {
    const urls = { 'remote get-url we': 'https://github.com/web-everything/web-everything.git\n' };
    const repoCfg = (extra) => (cmd, args) => {
      const map = { ...urls, 'symbolic-ref -q --short HEAD': 'lane/mine\n', 'config --get branch.lane/mine.remote': 'we\n', ...extra };
      const k = args.join(' ');
      if (k in map) return map[k];
      throw new Error(`no ${k}`);
    };
    const cases = [
      ['push.default=matching', { 'config --get push.default': 'matching\n' }, 'git push', ['*', 'lane/mine']],
      // remote.<name>.push overrides push.default, so matching must not widen a configured specific refspec
      ['remote.we.push specific + push.default=matching', { 'config --get push.default': 'matching\n', 'config --get-all remote.we.push': 'HEAD:refs/heads/lane/ok\n' }, 'git push', ['lane/mine', 'lane/ok']],
      ['push.default=matching, remote-only push', { 'config --get push.default': 'matching\n' }, 'git push we', ['*', 'lane/mine']],
      ['remote.we.push glob', { 'config --get-all remote.we.push': 'refs/heads/*:refs/heads/*\n' }, 'git push', ['*', 'lane/mine']],
      ['remote.we.push single refspec', { 'config --get-all remote.we.push': 'HEAD:refs/heads/lane/claimed\n' }, 'git push', ['lane/mine', 'lane/claimed']],
      ['push.default=current', { 'config --get push.default': 'current\n' }, 'git push', ['lane/mine']],
      ['push.default=upstream', { 'config --get push.default': 'upstream\n', 'config --get branch.lane/mine.merge': 'refs/heads/lane/claimed\n' }, 'git push', ['lane/mine', 'lane/claimed']],
      ['push.default=simple', { 'config --get push.default': 'simple\n' }, 'git push', ['lane/mine']],
      // matching never widens an EXPLICIT HEAD refspec
      ['matching + explicit HEAD refspec', { 'config --get push.default': 'matching\n' }, 'git push we HEAD', ['lane/mine']],
    ];
    for (const [name, cfg, cmd, branches] of cases) {
      it(name, () => {
        const got = resolvePushDestination(cmd, { cwd: '/lane', exec: repoCfg(cfg) });
        expect(got.repoKey).toBe('we');
        expect([...got.branches].sort()).toEqual([...branches].sort());
      });
    }
  });

  // #4326 items 3 + 5 — the REAL decide()/reason() against real throwaway git repos and a real claim store.
  describe('the hook against real repos (computeFixClaimCtx -> decide)', () => {
    const WE_URL = 'https://github.com/web-everything/web-everything.git';
    const mkRepo = (url = WE_URL) => {
      const dir = mkdtempSync(join(tmpdir(), 'fix-push-repo-'));
      const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
      g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
      g('commit', '-q', '--allow-empty', '-m', 'init'); g('remote', 'add', 'origin', url);
      g('branch', 'lane/claimed'); g('branch', 'lane/ok');
      return dir;
    };
    const dirs = [];
    const repo = (url) => { const d = mkRepo(url); dirs.push(d); return d; };
    afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
    const verdict = async (cmd, cwd, caller = { sessionId: 'sess-worker' }) => {
      const ctx = await computeFixClaimCtx(cmd, { caller, cwd, deps: { lockRoot: root } });
      return guardDecide(cmd, { cwd, ...ctx });
    };
    const claim = (repoKey, pr, branch) => acquireFixClaim({ repo: repoKey, pr, who: `fix-${pr}`, sessionId: 'sess-fixer', branch, lockRoot: root, nowMs: Date.now() });

    it('`git checkout <claimed> && MAIN_PUSH_OK=1 git push` is refused while a foreign claim is live', async () => {
      claim('we', 4326, 'lane/claimed');
      const dir = repo();
      expect(await verdict('git checkout lane/claimed && MAIN_PUSH_OK=1 git push', dir)).toMatch(/fix-4326 holds the fix claim/);
      expect(await verdict('git switch lane/claimed && MAIN_PUSH_OK=1 git push', dir)).toMatch(/fix-4326/);
    });
    it('a plain bare push from an unclaimed own lane stays allowed with a claim live elsewhere', async () => {
      claim('we', 4326, 'lane/claimed');
      const dir = repo();
      execFileSync('git', ['checkout', '-q', 'lane/ok'], { cwd: dir });
      expect(await verdict('MAIN_PUSH_OK=1 git push', dir)).toBeNull();
    });
    it('no claim held: the checkout-then-push is allowed', async () => {
      const dir = repo();
      expect(await verdict('git checkout lane/claimed && MAIN_PUSH_OK=1 git push', dir)).toBeNull();
    });
    it('the claim HOLDER may still push', async () => {
      claim('we', 4326, 'lane/claimed');
      const dir = repo();
      expect(await verdict('git checkout lane/claimed && MAIN_PUSH_OK=1 git push', dir, { sessionId: 'sess-fixer' })).toBeNull();
    });
    it('reason() alone, ctx pinned: an unreliable push is refused, a reliable one is not', () => {
      const claimed = [{ branch: BRANCH, message: 'push refused: fix-2811 holds the fix claim' }];
      expect(guardReason('MAIN_PUSH_OK=1 git push', { fixPushes: [{ repoKey: 'we', targets: ['lane/other'], claimed, unreliable: true }] })).toMatch(/fix-2811/);
      expect(guardReason('MAIN_PUSH_OK=1 git push', { fixPushes: [{ repoKey: 'we', targets: ['lane/other'], claimed, unreliable: false }] })).toBeNull();
    });
    it('two pushes to different repos, claim only on the second destination -> refused; no claim -> allowed', async () => {
      const a = repo(WE_URL);
      const b = repo('https://github.com/frontier-ui/frontierui.git');
      const cmd = `git -C ${a} push origin lane/ok && git -C ${b} push origin lane/claimed`;
      expect(await verdict(cmd, a)).toBeNull();
      claim('frontierui', 77, 'lane/claimed');
      expect(await verdict(cmd, a)).toMatch(/fix-77 holds the fix claim/);
      // the claim is in repo B only: the same branch pushed to repo A is fine
      expect(await verdict(`git -C ${a} push origin lane/claimed`, a)).toBeNull();
    });
    it('two pushes in ONE repo: an innocent first push no longer hides a claimed second', async () => {
      claim('we', 4326, 'lane/claimed');
      const a = repo();
      expect(await verdict('git push origin lane/ok && git push origin lane/claimed', a)).toMatch(/fix-4326/);
    });
    // PR #3172 review — parity: every spelling `canonicalGitOp` reads as a push is parsed, so the claim is enforced.
    const GLOBAL_FLAG_PUSHES = [
      'git --no-pager push origin lane/claimed',
      'git --git-dir=.git push origin lane/claimed',
      'git --work-tree=. push origin lane/claimed',
      'git -C . --no-pager push origin lane/claimed',
      '/usr/bin/git --no-pager push origin lane/claimed',
      'env GIT_TRACE=0 git --no-pager push origin lane/claimed',
      'sudo git -c core.x=1 push origin lane/claimed',
    ];
    for (const cmd of GLOBAL_FLAG_PUSHES) {
      it(`refuses a claimed push spelled with global flags: ${cmd}`, async () => {
        claim('we', 4326, 'lane/claimed');
        const dir = repo();
        expect(parseGitPushes(cmd).length).toBe(1);
        expect(await verdict(`MAIN_PUSH_OK=1 ${cmd}`, dir)).toMatch(/fix-4326/);
      });
    }
    it('an echoed "git push" in a later segment does not block a valid earlier push', async () => {
      claim('we', 4326, 'lane/claimed');
      const dir = repo();
      execFileSync('git', ['checkout', '-q', 'lane/claimed'], { cwd: dir });
      expect(await verdict('git push origin lane/ok && echo "git push"', dir)).toBeNull();
      // and the real claimed push is still refused when it is the real one
      expect(await verdict('git push origin lane/claimed && echo "git push"', dir)).toMatch(/fix-4326/);
    });
    it('a leading or mid-command cd fails closed, for bare AND explicit pushes', async () => {
      claim('we', 4326, 'lane/claimed');
      const dir = repo();
      expect(pushTargetUnreliable(parseGitPushes('cd foo && git push')[0])).toBe(true);
      expect(await verdict('cd foo && MAIN_PUSH_OK=1 git push', dir)).toMatch(/fix-4326/);
      expect(await verdict('cd foo && MAIN_PUSH_OK=1 git push origin lane/claimed', dir)).toMatch(/fix-4326/);
      expect(await verdict('echo x; cd foo && MAIN_PUSH_OK=1 git push origin lane/claimed', dir)).toMatch(/fix-4326/);
      // an explicit push to an unclaimed branch after a cd is still allowed
      expect(await verdict('cd foo && MAIN_PUSH_OK=1 git push origin lane/ok', dir)).toBeNull();
    });
    it('other HEAD-changing spellings make an implicit push unreliable', () => {
      for (const c of ['gh pr checkout 123 && git push', 'git worktree add ../w x && git push', 'git -C x checkout y && git push', 'gh co 1 && git push origin HEAD']) {
        expect(pushTargetUnreliable(parseGitPushes(c)[0]), c).toBe(true);
      }
      expect(pushTargetUnreliable(parseGitPushes('gh pr checkout 123 && git push origin lane/ok')[0])).toBe(false);
    });
    it('parseGitPushes reads every push with its own -C dir', () => {
      expect(parseGitPushes('git -C /a push origin x && git -C /b push up y').map(({ before, ...p }) => p)).toEqual([
        { remote: 'origin', refspecs: ['x'], all: false, dir: '/a', retarget: false },
        { remote: 'up', refspecs: ['y'], all: false, dir: '/b', retarget: false },
      ]);
      expect(parseGitPushes('git status')).toEqual([]);
      expect(pushTargetUnreliable(parseGitPushes('git checkout x && git push')[0])).toBe(true);
      expect(pushTargetUnreliable(parseGitPushes('git checkout x && git push origin HEAD:refs/heads/lane/x')[0])).toBe(false);
      expect(pushTargetUnreliable(parseGitPushes('git push')[0])).toBe(false);
    });
  });

  it('the dispatcher refuses to spawn a fixer while any fix claim is live', () => {
    claimNow();
    const spawned = [];
    const r = dispatchFix(
      { itemNum: null, pr: 2811, laneRef: BRANCH, scope: ['we:x'], lane: 3, headRefOid: 'a'.repeat(40) },
      { root: '/repo', readBrief: () => '# {{PR_NUM}}', claimRoot: root, spawnAgent: () => { spawned.push(1); return ''; } },
    );
    expect(r).toMatchObject({ held: true, reason: 'fix-claimed', heldBy: 'fix-2811' });
    expect(spawned).toHaveLength(0);
  });

  it('the status tagger reads `fixing` for a claim held by a non-daemon worker', () => {
    expect(deriveReviewStatus({ pr: 2811, agents: [], fixClaim: { meta: { who: 'rubric-worker' } } })).toEqual({ role: 'fix', state: 'fixing' });
  });

  it('isClaimHolder: a session-bound claim needs its session id; a session-less claim needs its who', () => {
    const e = readLiveFixClaim({ repo: 'we', pr: 2811, lockRoot: root, nowMs: T0 });
    expect(isClaimHolder(e, { sessionId: 'sess-fixer' })).toBe(true);
    expect(isClaimHolder(e, { who: 'fix-2811' })).toBe(false);
    expect(isClaimHolder(e, { who: 'fix-2811', sessionId: 'sess-other' })).toBe(false);
    expect(isClaimHolder(e, {})).toBe(false);
    const sessionless = { meta: { who: 'rubric-worker', sessionId: null } };
    expect(isClaimHolder(sessionless, { who: 'rubric-worker' })).toBe(true);
    expect(isClaimHolder(sessionless, { who: 'other' })).toBe(false);
  });
});

describe('planReconcile — a live fix claim refuses every dispatch', () => {
  const pr = (over = {}) => ({
    number: 2811, state: 'OPEN', headRefName: BRANCH, headRefOid: '60f0f3d5764f63b4b150ef5a7c5a8b7c40730010',
    labels: [{ name: 'review:pending' }], mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }], comments: [], ...over,
  });

  it('a green draft is NOT promoted and no review is dispatched while the claim is held; after release it is promoted', () => {
    const claimed = planReconcile({ prs: [pr({ isDraft: true, fixClaim: { who: 'fix-2811', why: 'address review' } })], agents: [], now: T0 });
    expect(claimed.dispatch).toEqual([]);
    expect(claimed.refusals).toEqual([expect.objectContaining({ prNumber: 2811, kind: 'fix-claimed', who: 'fix-2811' })]);
    const released = planReconcile({ prs: [pr({ isDraft: true })], agents: [], now: T0 });
    expect(released.dispatch).toEqual([expect.objectContaining({ prNumber: 2811, kind: 'promote-draft' })]);
  });

  it('enrichPrsWithFixClaims attaches the claim off the store (and nothing when there is none)', () => {
    acquireFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', why: 'w', lockRoot: root, nowMs: Date.now() });
    const readClaim = (o) => readLiveFixClaim({ ...o, lockRoot: root });
    const [a, b] = enrichPrsWithFixClaims([{ number: 2811 }, { number: 9 }], { repo: 'we', readClaim });
    expect(a.fixClaim).toMatchObject({ who: 'fix-2811', why: 'w' });
    expect(b.fixClaim).toBeUndefined();
  });
});

describe('stand-down semantics — a concurrent author is a pause, not a burial', () => {
  const HEAD = '60f0f3d5764f63b4b150ef5a7c5a8b7c40730010';
  const pr = (comments, over = {}) => ({
    number: 2811, state: 'OPEN', headRefName: BRANCH, headRefOid: HEAD,
    labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
    comments: [{ body: '🔁 review — changes requested\n\nthe gap enumeration drops lead-in time', author: AUTOMATION }, ...comments],
    ...over,
  });

  it('the LIVE #2811 stand-down is reclassified: not terminal for any counter, parsed as a pause with its alt branch', () => {
    const comments = [{ body: LIVE_2811_STAND_DOWN, author: AUTOMATION, createdAt: '2026-09-27T15:45:27Z' }];
    expect(countUnresolvedStandDowns(comments)).toBe(0);
    expect(countTerminalStandDowns(comments)).toBe(0);
    expect(countStandDownComments(comments)).toBe(0);
    expect(concurrentAuthorPauses(comments)).toEqual([
      { createdAt: '2026-09-27T15:45:27Z', head: null, legacy: true, alt: { branch: 'lane/run-rating-slice1-fix-2811-alt', sha: '3b24fcc18' } },
    ]);
  });

  // Review finding round 2 (PR #2821): the legacy prose rule is bounded — only a trailer-less body POSTED BEFORE the
  // cutoff is read that way. The same text with no timestamp, or posted after the cutoff, stays terminal.
  it('the legacy reclassification is bounded to pre-cutoff, trailer-less bodies', () => {
    const at = (createdAt) => [{ body: LIVE_2811_STAND_DOWN, author: AUTOMATION, createdAt }];
    expect(countTerminalStandDowns(at(LEGACY_CONCURRENT_AUTHOR_CUTOFF))).toBe(1);
    expect(countTerminalStandDowns(at('2026-12-01T00:00:00Z'))).toBe(1);
    expect(countTerminalStandDowns([{ body: LIVE_2811_STAND_DOWN, author: AUTOMATION }])).toBe(1);
    expect(concurrentAuthorPauses(at('2026-12-01T00:00:00Z'))).toEqual([]);
    expect(isConcurrentAuthorStandDownBody(LIVE_2811_STAND_DOWN, { createdAt: '2026-09-27T15:45:27Z' })).toBe(true);
    expect(isConcurrentAuthorStandDownBody(LIVE_2811_STAND_DOWN)).toBe(false);
  });

  it('the LIVE #2811 PR is re-armed: the planner owes it a fix, and the row names the saved alt branch', () => {
    const plan = planReconcile({
      prs: [pr([{ body: LIVE_2811_STAND_DOWN, author: AUTOMATION, createdAt: '2026-09-27T15:45:27Z' }])],
      agents: [], now: Date.parse('2026-09-27T21:30:00Z'),
    });
    expect(plan.refusals.filter((r) => r.prNumber === 2811)).toEqual([]);
    expect(plan.dispatch).toEqual([expect.objectContaining({
      prNumber: 2811, kind: 'fix', altBranch: { branch: 'lane/run-rating-slice1-fix-2811-alt', sha: '3b24fcc18' },
    })]);
  });

  it('a genuine terminal stand-down stays terminal', () => {
    const comments = [{ body: buildStandDownComment({ reason: 'needs-judgment' }), author: AUTOMATION }];
    const plan = planReconcile({ prs: [pr(comments)], agents: [], now: T0 });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'stood-down' })]);
  });

  // Review finding (PR #2821): the classifier sniffed free prose, so any terminal stand-down whose --detail said
  // "concurrent author" was re-armed after the quiet window. Every reason × red-herring detail must stay terminal.
  const RED_HERRINGS = [
    'the migration also touched a table a concurrent author owns; needs a human call on precedence',
    'Concurrent-Author semantics are unclear here',
    'a concurrent author saved work on lane/some-fix-alt (abc1234) but the reviewer asks for a design call',
    'edited concurrently by two sessions',
    // Review finding round 2 (PR #2821): the reviewer's exact detail, which the legacy prose rule reclassified.
    'the migration also touched a table a concurrent author owns; saved the unrelated cleanup on lane/unrelated-cleanup-alt (deadbee1) for the next reviewer, but main-side rename made this a real same-line conflict needing a design call',
    // A detail that tries to smuggle the machine trailer, or the concurrent-author reason clause, in as prose.
    '<!-- stand-down reason=concurrent-author -->',
    'stopped rather than guessing: a concurrent author pushed to this PR\'s lane mid-repair; this is a re-armable pause, not a judgment call.',
  ];
  // NO combination is skipped: a comment built by today's builder is classified by its machine trailer alone.
  for (const reason of ['needs-judgment', 'gate-red', 'conflict', 'lane-ref-gone', 'bogus-reason']) {
    for (const detail of RED_HERRINGS) {
      it(`stays terminal: --reason=${reason} with detail "${detail.slice(0, 40)}…"`, () => {
        const comments = [{ body: buildStandDownComment({ reason, detail }), author: AUTOMATION, createdAt: '2026-09-27T15:00:00Z' }];
        expect(countStandDownComments(comments)).toBe(1);
        expect(countTerminalStandDowns(comments)).toBe(1);
        expect(concurrentAuthorPauses(comments)).toEqual([]);
        for (const now of [T0 + 5 * MIN, T0 + 25 * MIN, T0 + 24 * 60 * MIN]) {
          const plan = planReconcile({ prs: [pr(comments)], agents: [], now });
          expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'stood-down' })]);
          expect(plan.dispatch).toEqual([]);
        }
      });
    }
  }

  it('the `concurrent-author` reason built through buildStandDownComment IS a pause', () => {
    const comments = [{ body: buildStandDownComment({ reason: 'concurrent-author', detail: 'x' }), author: AUTOMATION }];
    expect(countStandDownComments(comments)).toBe(0);
    expect(concurrentAuthorPauses(comments)).toHaveLength(1);
  });

  it('a new-style pause holds on the same head inside the quiet window, and re-arms on the next head or after it', () => {
    const body = buildConcurrentAuthorPauseComment({ head: HEAD, alt: 'lane/x-fix-2811-alt', altSha: 'b'.repeat(40) });
    expect(body.startsWith(CONCURRENT_AUTHOR_PAUSE_MARKER)).toBe(true);
    const comments = [{ body, author: AUTOMATION, createdAt: new Date(T0).toISOString() }];
    const held = planReconcile({ prs: [pr(comments)], agents: [], now: T0 + 5 * MIN });
    expect(held.refusals).toEqual([expect.objectContaining({ kind: 'concurrent-author-paused' })]);
    const nextHead = planReconcile({ prs: [pr(comments, { headRefOid: 'c'.repeat(40) })], agents: [], now: T0 + 5 * MIN });
    expect(nextHead.dispatch).toEqual([expect.objectContaining({ kind: 'fix', altBranch: { branch: 'lane/x-fix-2811-alt', sha: 'b'.repeat(40) } })]);
    const quiet = planReconcile({ prs: [pr(comments)], agents: [], now: T0 + CONCURRENT_AUTHOR_QUIET_MS + MIN });
    expect(quiet.dispatch).toEqual([expect.objectContaining({ kind: 'fix' })]);
  });

  it('a pause from an untrusted login is ignored (#3383 authorship rule)', () => {
    const body = buildConcurrentAuthorPauseComment({ head: HEAD });
    expect(concurrentAuthorPauses([{ body, author: { login: 'drive-by' } }])).toEqual([]);
  });

  it('parseAltBranch reads the saved branch and sha out of free text', () => {
    expect(parseAltBranch('saved on lane/a-b-fix-9-alt (`3b24fcc18`, rebased)')).toEqual({ branch: 'lane/a-b-fix-9-alt', sha: '3b24fcc18' });
    expect(parseAltBranch('nothing saved')).toBeNull();
  });

  it('withAltBranchHint tells the next fixer to start from the saved branch (and is a no-op without one)', () => {
    expect(withAltBranchHint('P', null)).toBe('P');
    const out = withAltBranchHint('P', { branch: 'lane/run-rating-slice1-fix-2811-alt', sha: '3b24fcc18' });
    expect(out).toMatch(/git fetch origin lane\/run-rating-slice1-fix-2811-alt/);
    expect(out).toMatch(/3b24fcc18/);
  });
});

describe('PR #3990 review — a permission-wall turn is an infra stall, not a fixer miss', () => {
  const rec = (outcome, over = {}) => ({ status: 'done', outcome, sessionId: 'sess-1', updatedAt: '2026-10-05T12:00:00.000Z', ...over });

  it.each(['blocked-on-infra', 'blocked-on-permission'])('isInfraStallCompletion recognises %s', (outcome) => {
    expect(isInfraStallCompletion(rec(outcome), { sessionId: 'sess-1' })).toBe(true);
  });

  it.each(['re-armed', 'gate-red', 'escalated-needs-judgment', null])('...and still refuses %s', (outcome) => {
    expect(isInfraStallCompletion(rec(outcome), { sessionId: 'sess-1' })).toBe(false);
  });

  it('a blocked-on-permission record of ANOTHER session never counts', () => {
    expect(isInfraStallCompletion(rec('blocked-on-permission'), { sessionId: 'sess-2' })).toBe(false);
  });

  it('fix-end of a blocked-on-permission turn carries the mark the ladder prefix-matches, so fixerReturnsAfter does not count a miss', async () => {
    const comments = [];
    const labels = { ensureLabel() {}, setLabels() {}, postComment: (_r, _p, body) => comments.push(body) };
    const gh = async (args) => (args[1] === 'view' ? JSON.stringify({ headRefOid: 'a'.repeat(40) }) : '');
    const r = await fixBegin({ repo: 'we', pr: 3990, who: 'fix-3990', sessionId: 'sess-3990', gh, labels, lockRoot: root, nowMs: T0 });
    const end = await fixEnd({
      repo: 'we', pr: 3990, who: 'fix-3990', sessionId: 'sess-3990', token: r.token, gh, labels, lockRoot: root,
      readCompletion: async () => rec('blocked-on-permission', { sessionId: 'sess-3990' }),
    });
    expect(end).toMatchObject({ ok: true, infraStall: true });
    const endComment = comments.find((c) => c.startsWith(FIX_END_MARKER));
    expect(endComment).toContain(FIX_END_INFRA_STALL_PREFIX);
  });
});

describe('fixBegin / fixEnd — the IO shell', () => {
  const fakeGh = (view) => {
    const calls = [];
    const gh = async (args) => { calls.push(args); return args[1] === 'view' ? JSON.stringify(view) : ''; };
    return { gh, calls };
  };
  const fakeLabels = () => {
    const log = [];
    return {
      log,
      ensureLabel: (repo, name) => log.push(['ensure', name]),
      setLabels: (repo, pr, spec) => log.push(['set', spec]),
      postComment: (repo, pr, body) => log.push(['comment', body.split('\n')[0]]),
    };
  };

  it('fix-begin DEFAULT (operator ruling 2026-09-27, draft-only-on-withdrawal): claim → NO draft → fixing label (stood-down removed) → marker; token-bound for a session-less caller; fix-end never relies on draft-first promotion', async () => {
    const { gh, calls } = fakeGh({ headRefName: BRANCH, headRefOid: 'a'.repeat(40), isDraft: false, state: 'OPEN', labels: [{ name: STOOD_DOWN_LABEL }] });
    const labels = fakeLabels();
    // A session-less caller (sessionId: null): fix-begin hands it the claim's token, which fix-end then needs.
    const r = await fixBegin({ repo: 'we', pr: 2811, who: 'fix-2811', why: 'address review', sessionId: null, token: null, gh, labels, lockRoot: root, nowMs: T0 });
    expect(r).toMatchObject({ ok: true, branch: BRANCH, draft: false, reason: null, steps: ['label', 'comment'] });
    expect(calls.filter((a) => a[1] === 'ready')).toHaveLength(0); // default never drafts
    expect(r.token).toMatch(/^[0-9a-f]{48}$/);
    expect(await fixEnd({ repo: 'we', pr: 2811, who: 'fix-2811', sessionId: null, token: null, gh, labels: fakeLabels(), lockRoot: root }))
      .toMatchObject({ ok: false, reason: 'token-mismatch' });
    expect(labels.log).toContainEqual(['set', { add: FIXING_LABEL, remove: [STOOD_DOWN_LABEL] }]);
    expect(labels.log).toContainEqual(['comment', FIX_BEGIN_MARKER]);

    const other = await fixBegin({ repo: 'we', pr: 2811, who: 'rubric-worker', sessionId: null, token: null, gh, labels: fakeLabels(), lockRoot: root, nowMs: T0 + MIN });
    expect(other).toMatchObject({ ok: false, reason: 'held' });

    const end = await fixEnd({ repo: 'we', pr: 2811, who: 'fix-2811', sessionId: null, token: r.token, gh, labels, lockRoot: root });
    expect(end).toMatchObject({ ok: true, draft: false });
    expect(calls.filter((a) => a[1] === 'ready')).toHaveLength(0); // never drafted, so fix-end has nothing to un-draft
    expect(labels.log).toContainEqual(['set', { remove: [FIXING_LABEL] }]);
    expect(labels.log).toContainEqual(['comment', FIX_END_MARKER]);
    expect(readLiveFixClaim({ repo: 'we', pr: 2811, lockRoot: root, nowMs: T0 + 2 * MIN })).toBeNull();
  });

  it('fix-begin --draft --reason=scope-change: claim → `gh pr ready --undo` → draft-scope-change label → marker; fix-end leaves it draft (relies on draft-first promotion)', async () => {
    const { gh, calls } = fakeGh({ headRefName: BRANCH, headRefOid: 'a'.repeat(40), isDraft: false, state: 'OPEN', labels: [] });
    const labels = fakeLabels();
    const r = await fixBegin({ repo: 'we', pr: 2812, who: 'fix-2812', why: 'scope changed mid-review', sessionId: 'sess-2812', draft: true, reason: 'scope-change', gh, labels, lockRoot: root, nowMs: T0 });
    expect(r).toMatchObject({ ok: true, draft: true, reason: 'scope-change', steps: ['draft', 'label', 'comment'] });
    expect(calls).toContainEqual(['pr', 'ready', '2812', '--repo', 'web-everything/web-everything', '--undo']);
    expect(labels.log).toContainEqual(['set', { add: 'review-status:draft-scope-change', remove: [] }]);

    const end = await fixEnd({ repo: 'we', pr: 2812, who: 'fix-2812', sessionId: 'sess-2812', gh, labels, lockRoot: root });
    expect(end).toMatchObject({ ok: true, draft: true, reason: 'scope-change' });
    expect(calls.filter((a) => a[1] === 'ready')).toHaveLength(1); // fix-end never un-drafts
    expect(labels.log).toContainEqual(['set', { remove: ['review-status:draft-scope-change'] }]);
  });

  it('fix-begin --draft --reason=withdrawn is mutually exclusive with the ordinary fixing label (removed on switch)', async () => {
    const { gh } = fakeGh({ headRefName: BRANCH, headRefOid: 'a'.repeat(40), isDraft: false, state: 'OPEN', labels: [{ name: FIXING_LABEL }] });
    const labels = fakeLabels();
    const r = await fixBegin({ repo: 'we', pr: 2813, who: 'fix-2813', draft: true, reason: 'withdrawn', gh, labels, lockRoot: root, nowMs: T0 });
    expect(r).toMatchObject({ ok: true, draft: true, reason: 'withdrawn' });
    expect(labels.log).toContainEqual(['set', { add: 'review-status:draft-withdrawn', remove: [FIXING_LABEL] }]);
  });

  it('reentrant draft-then-plain fix-begin replaces the draft meta (never merged forward): status reads fixing, fix-end drops only the fixing label', async () => {
    const view = { headRefName: BRANCH, headRefOid: 'a'.repeat(40), isDraft: false, state: 'OPEN', labels: [] };
    const { gh, calls } = fakeGh(view);
    const labels = fakeLabels();
    const who = 'fix-4453a';
    const sessionId = 'sess-4453a';
    const first = await fixBegin({ repo: 'we', pr: 4453, who, sessionId, draft: true, reason: 'scope-change', gh, labels, lockRoot: root, nowMs: T0 });
    expect(first).toMatchObject({ ok: true, draft: true, reason: 'scope-change', reentrant: false });
    // the PR is now draft and carries the draft label; the same fixer re-begins WITHOUT --draft
    Object.assign(view, { isDraft: true, labels: [{ name: 'review-status:draft-scope-change' }] });
    labels.log.length = 0;
    const second = await fixBegin({ repo: 'we', pr: 4453, who, sessionId, gh, labels, lockRoot: root, nowMs: T0 + MIN });
    expect(second).toMatchObject({ ok: true, reentrant: true, draft: false, reason: null });
    expect(labels.log.filter(([k]) => k === 'comment')).toHaveLength(0); // reentrant: no second marker comment
    expect(labels.log).toContainEqual(['set', { add: FIXING_LABEL, remove: ['review-status:draft-scope-change'] }]);

    const entry = readLiveFixClaim({ repo: 'we', pr: 4453, lockRoot: root, nowMs: T0 + 2 * MIN });
    expect(entry.meta).toMatchObject({ draft: false, reason: null });
    expect(deriveReviewStatus({ pr: 4453, fixClaim: entry })).toMatchObject({ role: 'fix', state: 'fixing' });

    labels.log.length = 0;
    const end = await fixEnd({ repo: 'we', pr: 4453, who, sessionId, gh, labels, lockRoot: root });
    expect(end).toMatchObject({ ok: true, draft: false, reason: null });
    expect(labels.log).toContainEqual(['set', { remove: [FIXING_LABEL] }]);
    expect(calls.filter((a) => a[1] === 'ready')).toHaveLength(1); // only the first begin drafted; nothing un-drafts
  });

  it('reentrant explicit draft reacquire fix-begin: the newer draft intent wins in meta + status, and fix-end drops the matching label', async () => {
    const view = { headRefName: BRANCH, headRefOid: 'a'.repeat(40), isDraft: false, state: 'OPEN', labels: [] };
    const { gh, calls } = fakeGh(view);
    const labels = fakeLabels();
    const who = 'fix-4453b';
    const sessionId = 'sess-4453b';
    const first = await fixBegin({ repo: 'we', pr: 4454, who, sessionId, gh, labels, lockRoot: root, nowMs: T0 });
    expect(first).toMatchObject({ ok: true, draft: false, reentrant: false });
    expect(readLiveFixClaim({ repo: 'we', pr: 4454, lockRoot: root, nowMs: T0 }).meta).toMatchObject({ draft: false, reason: null });

    view.labels = [{ name: FIXING_LABEL }];
    labels.log.length = 0;
    const second = await fixBegin({ repo: 'we', pr: 4454, who, sessionId, draft: true, reason: 'withdrawn', gh, labels, lockRoot: root, nowMs: T0 + MIN });
    expect(second).toMatchObject({ ok: true, reentrant: true, draft: true, reason: 'withdrawn' });
    expect(labels.log).toContainEqual(['set', { add: 'review-status:draft-withdrawn', remove: [FIXING_LABEL] }]);
    expect(calls.filter((a) => a[1] === 'ready' && a.includes('--undo'))).toHaveLength(1);

    const entry = readLiveFixClaim({ repo: 'we', pr: 4454, lockRoot: root, nowMs: T0 + 2 * MIN });
    expect(entry.meta).toMatchObject({ draft: true, reason: 'withdrawn' });
    expect(deriveReviewStatus({ pr: 4454, fixClaim: entry })).toMatchObject({ role: 'fix', state: 'draft-withdrawn' });

    labels.log.length = 0;
    const end = await fixEnd({ repo: 'we', pr: 4454, who, sessionId, gh, labels, lockRoot: root });
    expect(end).toMatchObject({ ok: true, draft: true, reason: 'withdrawn' });
    expect(labels.log).toContainEqual(['set', { remove: ['review-status:draft-withdrawn'] }]);
    expect(labels.log).not.toContainEqual(['set', { remove: [FIXING_LABEL] }]);
  });

  it('fix-begin refuses --draft with no valid --reason, and --reason with no --draft — before any IO', async () => {
    const { gh, calls } = fakeGh({ headRefName: BRANCH, isDraft: false, state: 'OPEN' });
    const noReason = await fixBegin({ repo: 'we', pr: 9001, who: 'w', draft: true, gh, labels: fakeLabels(), lockRoot: root, nowMs: T0 });
    expect(noReason).toMatchObject({ ok: false, reason: 'draft-reason-required' });
    const badReason = await fixBegin({ repo: 'we', pr: 9001, who: 'w', draft: true, reason: 'because', gh, labels: fakeLabels(), lockRoot: root, nowMs: T0 });
    expect(badReason).toMatchObject({ ok: false, reason: 'draft-reason-required' });
    const reasonNoDraft = await fixBegin({ repo: 'we', pr: 9001, who: 'w', reason: 'scope-change', gh, labels: fakeLabels(), lockRoot: root, nowMs: T0 });
    expect(reasonNoDraft).toMatchObject({ ok: false, reason: 'reason-without-draft' });
    expect(calls).toHaveLength(0); // refused before the `gh pr view` read
    expect(readLiveFixClaim({ repo: 'we', pr: 9001, lockRoot: root, nowMs: T0 })).toBeNull();
  });

  it('fix-begin --draft releases the claim and fails when the PR cannot be turned back to draft', async () => {
    const gh = async (args) => { if (args[1] === 'ready') throw new Error('gh: boom'); return JSON.stringify({ headRefName: BRANCH, isDraft: false, state: 'OPEN' }); };
    const r = await fixBegin({ repo: 'we', pr: 5, who: 'w', draft: true, reason: 'withdrawn', gh, labels: fakeLabels(), lockRoot: root, nowMs: T0 });
    expect(r).toMatchObject({ ok: false, reason: 'draft-failed' });
    expect(readLiveFixClaim({ repo: 'we', pr: 5, lockRoot: root, nowMs: T0 })).toBeNull();
  });

  it('a plain (no-draft) fix-begin never converts an already-ready PR, and never un-drafts an already-draft one either', async () => {
    const { gh, calls } = fakeGh({ headRefName: BRANCH, isDraft: true, state: 'OPEN', labels: [] });
    const r = await fixBegin({ repo: 'we', pr: 6, who: 'w', gh, labels: fakeLabels(), lockRoot: root, nowMs: T0 });
    expect(r).toMatchObject({ ok: true, draft: false });
    expect(calls.filter((a) => a[1] === 'ready')).toHaveLength(0); // no-draft fix-begin never touches the draft bit either way
  });
});

describe('the fix daemon\'s refresh sweep and a `fixing` claim', () => {
  it('does not throw on a fixing claim, and refreshes it while a session named `who` is live', () => {
    acquireFixClaim({ repo: 'we', pr: 2811, who: 'rubric-worker', lockRoot: root, nowMs: T0 });
    const agents = [{ name: 'rubric-worker', state: 'working' }];
    const r = refreshLiveFixDispatchClaims({ lockRoot: root, listAgentsAll: () => agents, hungInfoFor: () => null, nowIso: () => new Date(T0 + MIN).toISOString() });
    expect(r.refreshed).toEqual([expect.objectContaining({ pr: 2811, kind: 'fixing' })]);
    const none = refreshLiveFixDispatchClaims({ lockRoot: root, listAgentsAll: () => [], hungInfoFor: () => null, nowIso: () => new Date(T0 + MIN).toISOString() });
    expect(none.refreshed).toEqual([]);
  });
});

describe('repoKeyFromRemoteUrl', () => {
  it('maps ssh and https remotes; unknown repos are null', () => {
    expect(repoKeyFromRemoteUrl('git@github.com:web-everything/web-everything.git')).toBe('we');
    expect(repoKeyFromRemoteUrl('https://github.com/frontier-ui/frontierui')).toBe('frontierui');
    expect(repoKeyFromRemoteUrl('git@github.com:someone/else.git')).toBeNull();
  });

  it('repoKeyForCheckout reads the URL of the remote it is told to (pr-land passes its --remote), from a checkout PATH', () => {
    const calls = [];
    const exec = (cmd, args, o) => { calls.push([args.at(-1), o.cwd]); return args.at(-1) === 'upstream' ? 'git@github.com:frontier-ui/frontierui.git\n' : 'git@github.com:web-everything/web-everything.git\n'; };
    expect(repoKeyForCheckout('/lanes/x', { exec })).toBe('we');
    expect(repoKeyForCheckout('/lanes/x', { remote: 'upstream', exec })).toBe('frontierui');
    expect(calls).toEqual([['origin', '/lanes/x'], ['upstream', '/lanes/x']]);
  });
});

// #4293 — the push-claim check the shared rebase/heal plumbing (and review-prep-io.mjs) call through, given
// their OWN injected git `run`. `refuseHeldPush` takes no `lockRoot`/`nowMs`/identity overrides of its own (it
// forwards to `pushRefusal`'s/`callerIdentity`'s real defaults, exactly like production callers get for free) —
// so these tests steer it the SAME way `rebase-drop-manifest.test.mjs`'s sibling #4293 suite does: override
// `WE_COORDINATION_ROOT` (the env seam `fixDispatchClaimRoot()` already reads) instead of passing `lockRoot`,
// and acquire the fixture claim at real `Date.now()` so it is fresh against `pushRefusal`'s own real clock.
// `pushRefusal`/`callerIdentity` are already proven above; this covers the two things unique to this wrapper:
// deriving the repo off the injected `run` (never a subprocess of its own), and the fail-closed degrade a
// scrutiny round flagged as undefended — a `remote get-url` that fails, or throws outright, must still refuse a
// live claim (repo:null matches ANY repo) rather than skip the check or throw.
describe('refuseHeldPush — the injected-run push-claim check (#4293)', () => {
  let claimRoot;
  const priorRoot = process.env.WE_COORDINATION_ROOT;
  beforeEach(() => {
    claimRoot = mkdtempSync(join(tmpdir(), 'we-fix-claim-'));
    process.env.WE_COORDINATION_ROOT = claimRoot;
    // a WORKER (session-less) claim — held by `who` + a minted token, never this test's own ambient
    // CLAUDE_CODE_SESSION_ID, so `refuseHeldPush`'s default caller identity is never the holder by accident.
    // `lockRoot` must be the FULL claims dir (`fixDispatchClaimRoot()`, evaluated AFTER the env override above),
    // the same value `refuseHeldPush`'s own default (`pushRefusal`'s `lockRoot = fixDispatchClaimRoot()`) reads.
    acquireFixClaim({ repo: 'we', pr: 2811, who: 'fix-2811', why: 'address review', branch: BRANCH, lockRoot: fixDispatchClaimRoot() });
  });
  afterEach(() => {
    rmSync(claimRoot, { recursive: true, force: true });
    if (priorRoot === undefined) delete process.env.WE_COORDINATION_ROOT; else process.env.WE_COORDINATION_ROOT = priorRoot;
  });

  const scriptedRun = (remoteResult) => (cmd, args) => {
    if (args[0] === 'remote') {
      if (remoteResult === 'throw') throw new Error('git: not a repository');
      return remoteResult;
    }
    return { status: 0, stdout: '' };
  };

  it('resolves the repo off the injected run (never a subprocess of its own) and refuses a live claim', () => {
    const run = scriptedRun({ status: 0, stdout: 'git@github.com:web-everything/web-everything.git\n' });
    const remoteCalls = [];
    const spied = (cmd, args, opts) => { if (args[0] === 'remote') remoteCalls.push(args); return run(cmd, args, opts); };
    const refusal = refuseHeldPush({ run: spied, remote: 'origin', branch: BRANCH });
    expect(refusal).toMatchObject({ refused: true, pr: 2811, holder: 'fix-2811' });
    // the repo came from the injected `run`, not a real `execFileSync` — one call, through the same seam.
    expect(remoteCalls).toEqual([['remote', 'get-url', 'origin']]);
  });

  it('a repo the run resolves to a DIFFERENT constellation repo is unaffected by this claim', () => {
    const run = scriptedRun({ status: 0, stdout: 'git@github.com:frontier-ui/frontierui.git\n' });
    expect(refuseHeldPush({ run, remote: 'origin', branch: BRANCH })).toBeNull();
  });

  it('FAIL-CLOSED: `remote get-url` exiting non-zero degrades to repo:null (any-repo match) and still refuses', () => {
    const run = scriptedRun({ status: 1, stdout: '', stderr: 'fatal: No such remote' });
    const refusal = refuseHeldPush({ run, remote: 'origin', branch: BRANCH });
    expect(refusal).toMatchObject({ refused: true, pr: 2811, holder: 'fix-2811' });
  });

  it('FAIL-CLOSED: `remote get-url` THROWING degrades to repo:null (any-repo match) and never throws itself', () => {
    const run = scriptedRun('throw');
    expect(() => refuseHeldPush({ run, remote: 'origin', branch: BRANCH })).not.toThrow();
    const refusal = refuseHeldPush({ run, remote: 'origin', branch: BRANCH });
    expect(refusal).toMatchObject({ refused: true, pr: 2811, holder: 'fix-2811' });
  });

  it('no live claim on the branch → null, whether or not the repo resolves', () => {
    const run = scriptedRun({ status: 0, stdout: 'git@github.com:web-everything/web-everything.git\n' });
    expect(refuseHeldPush({ run, remote: 'origin', branch: 'lane/no-claim-here' })).toBeNull();
  });
});

describe('the CLI and its documented invocations name the repo', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CLI = join(HERE, '..', 'fix-procedure.mjs');
  const WE = join(HERE, '..', '..', '..') + sep;

  it('fix-begin / fix-end / fix-heartbeat / fix-status refuse to run without --repo (never default to `we`)', () => {
    for (const cmd of ['fix-begin', 'fix-end', 'fix-heartbeat', 'fix-status']) {
      // PATH holds only node: on a regressed tree the CLI must never reach a real `gh` and touch a live PR.
      const env = { ...process.env, WE_COORDINATION_ROOT: root, PATH: dirname(process.execPath) };
      const r = spawnSync(process.execPath, [CLI, cmd, '999999', '--who=x'], { encoding: 'utf8', env });
      expect(r.status, cmd).toBe(1);
      expect(r.stderr).toMatch(/needs --repo=/);
    }
  });

  it('every fix-begin / fix-end / fix-heartbeat command in skills-src passes --repo', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (d.name.endsWith('.md')) {
          // Join wrapped lines so a command split across a markdown line break is read whole.
          const text = readFileSync(p, 'utf8').replace(/\s*\n\s*/g, ' ');
          for (const m of text.matchAll(/fix-procedure\.mjs"?\s+(fix-(?:begin|end|heartbeat))\s+\S+([^`\n]*)/g)) {
            if (!/--repo=/.test(m[2])) offenders.push(`${p.slice(WE.length)}: ${m[0].slice(0, 90)}`);
          }
        }
      }
    };
    walk(join(WE, 'skills-src'));
    expect(offenders).toEqual([]);
  });
});


it('xul2kwr synthetic #3432 soak: withdrawal survives expiry and stale plans until fix-end', async () => {
  const repo = 'web-everything/web-everything';
  const held = 'review-status:draft-withdrawn';
  let nowMs = T0;
  const pr = { number: 3432, state: 'OPEN', isDraft: true, headRefName: BRANCH,
    headRefOid: 'a'.repeat(40), labels: [], comments: [], mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] };
  const effects = [];
  const labels = {
    readLabels: () => pr.labels,
    ensureLabel: () => {}, postComment: () => {},
    setLabels: (_repo, _pr, { add, remove = [] }) => {
      pr.labels = pr.labels.filter(l => !remove.includes(l));
      if (add && !pr.labels.includes(add)) pr.labels.push(add);
    },
  };
  const gh = async args => {
    if (args[1] === 'view') return JSON.stringify(pr);
    throw new Error('unexpected gh write');
  };
  const readClaim = o => readLiveFixClaim({ ...o, lockRoot: root, nowMs });
  const plan = () => planReconcile({
    prs: enrichPrsWithFixClaims([pr], { repo: 'we', readClaim }), agents: [], now: nowMs,
  });
  const stale = plan();
  expect(stale.dispatch.map(d => d.kind)).toEqual(['promote-draft']);
  const begin = await fixBegin({ repo: 'we', pr: 3432, who: 'fix-3432', sessionId: 'synthetic',
    draft: true, reason: 'withdrawn', gh, labels, lockRoot: root, nowMs });
  expect(begin.ok).toBe(true);
  expect(pr.labels).toContain(held);
  expect(plan().refusals[0].kind).toBe('fix-claimed');
  const execute = snapshot => runReconcilePromoteDraftDispatch({
    root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
    reconcile: () => snapshot,
    readHeadCheckState: () => ({ state: 'green' }), readPrLabels: () => pr.labels,
    provider: { ready: n => { effects.push(['ready', n]); pr.isDraft = false; } },
    clearAwaitingCi: args => { effects.push(['clear', args.pr]); applyReviewStatus({ ...args, provider: labels }); },
  });
  expect(execute(stale).refusals[0].kind).toBe('draft-withdrawn');
  const trace = [];
  for (let tick = 0; tick < 20; tick++) {
    nowMs = T0 + (DEFAULT_FIX_CLAIM_TTL_MINUTES + 1 + tick) * MIN;
    expect(readClaim({ repo: 'we', pr: 3432 })).toBeNull();
    tagReviewStatus({ pr: 3432, repo, provider: labels, agents: [], isDraft: pr.isDraft, readFixClaim: readClaim });
    applyReviewStatus({ pr: 3432, repo, provider: labels, state: tick % 2 ? null : 'reviewing' });
    const planned = plan();
    expect(planned.dispatch).toEqual([]);
    expect(planned.refusals[0]).toMatchObject({ kind: 'draft', why: expect.stringContaining('withdrawn') });
    expect(execute(planned).dispatched).toEqual([]);
    expect(execute(stale).refusals[0].kind).toBe('draft-withdrawn');
    expect(pr.labels).toEqual([held]);
    expect(pr.isDraft).toBe(true);
    expect(effects).toEqual([]);
    trace.push({ tick, draft: pr.isDraft, labels: [...pr.labels], planned: [], refusal: 'draft', executor: 'draft-withdrawn' });
  }
  expect(await fixEnd({ repo: 'we', pr: 3432, who: 'fix-3432', sessionId: 'synthetic', gh, labels, lockRoot: root }))
    .toMatchObject({ ok: true, reason: 'withdrawn' });
  expect(pr.labels).not.toContain(held);
  tagReviewStatus({ pr: 3432, repo, provider: labels, agents: [], isDraft: true, readFixClaim: readClaim });
  expect(pr.labels).toEqual(['review-status:awaiting-ci']);
  expect(execute(plan()).dispatched).toEqual([{ pr: 3432, kind: 'promote-draft' }]);
  expect(effects).toEqual([['ready', 3432], ['clear', 3432]]);
  expect(pr.isDraft).toBe(false);
  expect(pr.labels).toEqual([]);
  console.info('xul2kwr synthetic replay', JSON.stringify({ ticks: trace.length, first: trace[0], last: trace.at(-1), effectsAfterRelease: effects }));
});


describe('a stood-down fixer frees its dispatch claim at once (#3311)', () => {
  const seed = (lockRoot, extra = {}) => acquireFixDispatchClaim({ repo: 'we', pr: 3311, owner: 'daemon:1', nowMs: T0, lockRoot, ...extra });
  it('replays #3311: daemon claim blocks split; stand-down frees it inside the TTL', () => {
    seed(root);
    expect(acquireFixClaim({ repo: 'we', pr: 3311, who: 'split-3311', lockRoot: root, nowMs: T0 + MIN }))
      .toMatchObject({ ok: false, reason: 'dispatched-fixer', dispatchKind: 'fix' });
    expect(releaseSessionFixDispatchClaims({ repo: 'we', pr: 3311, who: 'fix-3311', lockRoot: root }).released)
      .toEqual([{ kind: 'fix', owner: 'daemon:1' }]);
    expect(acquireFixClaim({ repo: 'we', pr: 3311, who: 'split-3311', lockRoot: root, nowMs: T0 + 2 * MIN }).ok).toBe(true);
  });
  it.each(['fix-9999', 'split-3311', undefined])('leaves mismatched who %s alone', (who) => {
    seed(root);
    expect(releaseSessionFixDispatchClaims({ repo: 'we', pr: 3311, who, lockRoot: root }).released).toEqual([]);
    expect(readFixDispatchClaim({ repo: 'we', pr: 3311, lockRoot: root })).not.toBeNull();
  });
  it('releases only its own kind and never the fixing claim', () => {
    seed(root); seed(root, { kind: 'ci-heal' }); seed(root, { kind: 'fixing' });
    expect(releaseSessionFixDispatchClaims({ repo: 'we', pr: 3311, who: 'ci-heal-3311', lockRoot: root }).released)
      .toEqual([{ kind: 'ci-heal', owner: 'daemon:1' }]);
    for (const kind of ['fix', 'fixing']) expect(readFixDispatchClaim({ repo: 'we', pr: 3311, kind, lockRoot: root })).not.toBeNull();
    seed(root, { kind: 'ci-heal' });
    releaseSessionFixDispatchClaims({ repo: 'we', pr: 3311, who: 'fix-3311', lockRoot: root });
    expect(readFixDispatchClaim({ repo: 'we', pr: 3311, kind: 'ci-heal', lockRoot: root })).not.toBeNull();
  });
  it('scopes by repo', () => {
    seed(root, { repo: 'frontierui' });
    expect(releaseSessionFixDispatchClaims({ repo: 'we', pr: 3311, who: 'fix-3311', lockRoot: root }).released).toEqual([]);
    expect(readFixDispatchClaim({ repo: 'frontierui', pr: 3311, lockRoot: root })).not.toBeNull();
  });
  it('soaks 20 refresh ticks with the stood-down session still listed live', () => {
    seed(root);
    releaseSessionFixDispatchClaims({ repo: 'we', pr: 3311, who: 'fix-3311', lockRoot: root });
    for (let tick = 1; tick <= 20; tick += 1) {
      const nowMs = T0 + tick * 15_000;
      const sweep = refreshLiveFixDispatchClaims({ lockRoot: root,
        listAgentsAll: () => [{ name: 'fix-3311', state: 'working' }], hungInfoFor: () => null,
        nowIso: () => new Date(nowMs).toISOString() });
      expect(sweep.refreshed).toEqual([]);
      expect(readFixDispatchClaim({ repo: 'we', pr: 3311, lockRoot: root })).toBeNull();
      const next = acquireFixClaim({ repo: 'we', pr: 3311, who: 'split-3311', lockRoot: root, nowMs });
      expect(next.ok).toBe(true);
      expect(releaseFixClaim({ repo: 'we', pr: 3311, who: 'split-3311', token: next.token, lockRoot: root }).released).toBe(true);
    }
  });
  it('fixBeginRefusalMessage names the reason and the holder', () => {
    const message = fixBeginRefusalMessage({ pr: 3311, reason: 'dispatched-fixer', heldBy: 'fix-3311', dispatchKind: 'fix' });
    for (const part of ['dispatched-fixer', 'fix-3311', 'TTL', 'daemon fix']) expect(message).toContain(part);
    expect(fixBeginRefusalMessage({ pr: 3311, reason: 'held', heldBy: 'other' })).toContain('held — held by other');
  });
});
