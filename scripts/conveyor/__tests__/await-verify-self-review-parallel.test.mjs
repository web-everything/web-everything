/**
 * fix.selfReviewParallel (card xloi1c0; operator go 2026-10-10 ~11:40 ET): the fixer's self-review runs concurrently
 * with the verify gate and the push-before-gate early push. Pinned here:
 *   - concurrency: the early push and the verify wait proceed while the review is pending;
 *   - a green verdict is withheld (no resume, no hand-back) until the review returns;
 *   - must-fix → a NEW commit, re-marked under the same claim, pushed early and verified as the new head;
 *   - the claim is released (fix-end) only once verify is green AND the review returned.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAwaitVerifyPass, formatAwaitVerifyLines, AWAIT_VERIFY_LIMITS } from '../await-verify-pass.mjs';
import { main, selfReviewHold, selfReviewKey, readSelfReview, writeSelfReview } from '../await-verify.mjs';
import { acquireFixClaim, fixEnd, readLiveFixClaim, selfReviewReleaseRefusal } from '../fix-procedure.mjs';
import { resolveSelfReviewPolicy, formatSelfReviewPolicyLine, FIX_SELF_REVIEW_PARALLEL_ENV } from '../../lib/fix-push-policy.mjs';

const SHA = '65a382e81413952ab11e5448e36f01bb7ce4c332';
const SHA2 = 'b96574995e22b8d8087d4a28b7ba7615d4ec8c73';
const TREE = 'f'.repeat(64);
const T0 = Date.parse('2026-10-10T15:45:00.000Z');
const TTL = 150 * 60_000;
const SESSION = '0c5f3830-1522-49ab-8f20-e4108ccc926b';
const REPO = 'web-everything/web-everything';
const rec = (over = {}) => ({
  v: 1, sessionId: SESSION, who: 'fix-4115', repo: REPO, pr: 4115, sha: SHA, requestedAt: new Date(T0).toISOString(),
  attempt: 1, lane: '/lanes/lane-5', ref: 'lane/item-68b', kind: 'fix', ...over,
});
const marker = (status, sha = SHA) => ({ sha, status, startedAt: new Date(T0).toISOString(), treeHash: TREE, exitCode: status === 'green' ? 0 : status === 'red' ? 1 : null });
const ON = { pushBeforeGate: true, source: 'standard', invalid: [] };

/** In-memory harness: await store, self-review store, a fake remote branch, and a timeline of events. */
function harness() {
  const store = new Map([[SESSION, rec()]]);
  const sr = { value: null };
  const calls = { push: [], resume: [] };
  const state = { marker: marker('running'), lane: { head: SHA, dirty: false, treeHash: TREE }, remote: null, events: [] };
  const io = {
    pushPolicy: () => ON,
    readSelfReview: () => sr.value,
    listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
    writeRecord: (r) => { store.set(r.sessionId, r); return { ok: true }; },
    clearRecord: (key) => { store.delete(key); },
    laneState: () => state.lane,
    readMarker: () => state.marker,
    rerequest: () => ({ ok: true, status: 'requested' }),
    push: (a) => { calls.push.push(a); state.remote = a.sha; state.events.push(`push ${a.sha.slice(0, 8)}`); return { ok: true }; },
    listSessions: () => [{ sessionId: SESSION, name: 'fix-4115', cwd: '/scratch', status: 'idle' }],
    resume: (a) => { calls.resume.push(a); state.events.push(`resume ${/GREEN/.test(a.prompt) ? 'green' : 'other'}`); return { resumed: true }; },
  };
  return { io, store, sr, calls, state };
}
const pass = (h, at = 30_000) => runAwaitVerifyPass({ io: h.io, nowMs: T0 + at, ttlMs: TTL, loggedPolicyLine: { value: null } });
const pending = (over = {}) => ({ v: 1, repo: REPO, pr: 4115, sessionId: SESSION, who: 'fix-4115', state: 'pending', sha: SHA, startedAt: new Date(T0 + 5_000).toISOString(), ...over });

describe('self-review in parallel with verify: concurrency', () => {
  it('the early push and the verify wait proceed while the review is pending; a green is withheld until it returns clean', async () => {
    const h = harness();
    h.sr.value = pending();
    await pass(h, 10_000); // verify running, review running: the early push still goes out (overlap)
    expect(h.calls.push).toHaveLength(1);
    expect(h.calls.resume).toEqual([]);

    h.state.marker = marker('green');
    const held = await pass(h, 60_000);
    expect(h.calls.resume).toEqual([]); // no green resume → no hand-back, claim stays held
    expect(h.calls.push).toHaveLength(1); // no second push either
    expect(formatAwaitVerifyLines(held).some((l) => /self-review-hold .*self-review pending since .*→ verify green; push \+ resume withheld/.test(l))).toBe(true);
    await pass(h, 90_000); // still pending: a quiet wait, logged once
    expect(h.calls.resume).toEqual([]);

    h.sr.value = { ...h.sr.value, state: 'clean', returnedAt: new Date(T0 + 120_000).toISOString() };
    const released = await pass(h, 125_000);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toMatch(/Verify is GREEN/);
    expect(h.calls.resume[0].prompt).not.toMatch(/has not reported/);
    expect(formatAwaitVerifyLines(released).some((l) => /pushed; self-review clean \(started 2026-10-10T15:45:05.000Z, returned 2026-10-10T15:47:00.000Z\)/.test(l))).toBe(true);
    expect(h.state.events).toEqual(['push 65a382e8', 'push 65a382e8', 'resume green']);
  });

  it('a review that returned clean BEFORE the verdict never delays the green', async () => {
    const h = harness();
    h.sr.value = pending({ state: 'clean', returnedAt: new Date(T0 + 20_000).toISOString() });
    h.state.marker = marker('green');
    await pass(h);
    expect(h.calls.resume).toHaveLength(1);
  });

  it('a red verdict is NOT withheld: the fixer repairs while the review keeps running', async () => {
    const h = harness();
    h.sr.value = pending();
    h.state.marker = { ...marker('red'), failureDetails: { tests: [{ file: 'a.test.mjs', name: 'x' }] } };
    await pass(h);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toMatch(/Verify is RED/);
  });

  it('another session\'s open review never holds this round', async () => {
    const h = harness();
    h.sr.value = pending({ sessionId: 'someone-else', who: 'fix-old' });
    h.state.marker = marker('green');
    await pass(h);
    expect(h.calls.resume).toHaveLength(1);
  });

  it('is bounded: past selfReviewMaxMs the green proceeds with a finish-the-review instruction', async () => {
    const h = harness();
    h.sr.value = pending();
    h.state.marker = marker('green');
    const over = AWAIT_VERIFY_LIMITS.selfReviewMaxMs + 10_000;
    const { rows } = await pass(h, over);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toMatch(/has not reported .*Do not hand back yet/s);
    expect(formatAwaitVerifyLines({ rows }).some((l) => /OVERDUE/.test(l))).toBe(true);
  });
});

describe('self-review must-fix → a second push under the same claim', () => {
  it('holds the green on the reviewed sha, then early-pushes and verifies the repair head', async () => {
    const h = harness();
    h.sr.value = pending();
    await pass(h, 10_000);
    expect(h.state.remote).toBe(SHA);

    // The review returns must-fix while verify on SHA is still running; then verify on SHA goes green.
    h.sr.value = { ...h.sr.value, state: 'must-fix', returnedAt: new Date(T0 + 60_000).toISOString() };
    h.state.marker = marker('green');
    await pass(h, 70_000);
    expect(h.calls.resume).toEqual([]); // the reviewed sha is never handed back

    // The fixer commits SHA2 and re-marks (same attempt): the record now names the repair head.
    h.store.set(SESSION, rec({ sha: SHA2, requestedAt: new Date(T0 + 120_000).toISOString() }));
    h.sr.value = { ...h.sr.value, state: 'repaired', repairSha: SHA2 };
    h.state.lane = { head: SHA2, dirty: false, treeHash: TREE };
    h.state.marker = marker('running', SHA2);
    await pass(h, 130_000);
    expect(h.state.remote).toBe(SHA2); // pushed again, early, under the same claim
    expect(h.calls.push.map((p) => p.sessionId)).toEqual([SESSION, SESSION]);

    h.state.marker = marker('green', SHA2);
    await pass(h, 400_000);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toMatch(new RegExp(`sha ${SHA2}.*Verify is GREEN`, 's'));
  });

  it('selfReviewHold: must-fix holds only the reviewed sha; pending holds any sha; repaired/clean never hold', () => {
    const who = { sessionId: SESSION, who: 'fix-4115' };
    expect(selfReviewHold(pending(), { ...who, sha: SHA2 })).toMatch(/pending/);
    expect(selfReviewHold(pending({ state: 'must-fix' }), { ...who, sha: SHA })).toMatch(/must-fix/);
    expect(selfReviewHold(pending({ state: 'must-fix' }), { ...who, sha: SHA2 })).toBeNull();
    expect(selfReviewHold(pending({ state: 'must-fix' }), who)).toMatch(/must-fix/); // fix-end: no sha → still held
    expect(selfReviewHold(pending({ state: 'repaired' }), who)).toBeNull();
    expect(selfReviewHold(pending({ state: 'clean' }), who)).toBeNull();
    expect(selfReviewHold(pending(), { sessionId: 'other', who: 'fix-4115' })).toBeNull();
  });
});

describe('the self-review CLI', () => {
  const mem = () => {
    const m = { sr: null, awaitRec: null };
    return {
      m,
      deps: {
        env: { CLAUDE_CODE_SESSION_ID: SESSION }, now: () => T0,
        exec: (cmd, args) => {
          const a = args.slice(2);
          if (a[0] === 'rev-parse' && a[1] === 'HEAD') return `${m.head ?? SHA}\n`;
          if (a[0] === 'rev-parse' && a[1] === '--show-toplevel') return '/lanes/lane-5\n';
          if (a[0] === 'status') return '';
          throw new Error(`unexpected git ${a.join(' ')}`);
        },
        write: () => ({ ok: true }), read: () => null, clear: () => ({ cleared: true }),
        writeStore: (r) => { m.awaitRec = r; return { ok: true }; }, readStore: () => m.awaitRec, clearStore: () => ({ cleared: true }),
        readSelfReviewFn: () => m.sr, writeSelfReviewFn: (r) => { m.sr = r; return { ok: true }; },
        selfReviewPolicy: () => ({ selfReviewParallel: true, source: 'standard', invalid: [] }),
        out: (l) => { m.out = l; }, err: (l) => { m.err = l; },
      },
    };
  };
  const args = ['--repo=web-everything/web-everything', '--pr=4115', '--who=fix-4115'];

  it('start → pending for HEAD (parallel); clean/must-fix only from pending, only by the same session', () => {
    const { m, deps } = mem();
    expect(main(['self-review', 'start', ...args], deps)).toBe(0);
    expect(JSON.parse(m.out)).toMatchObject({ mode: 'parallel', state: 'pending', sha: SHA, sessionId: SESSION });
    expect(main(['self-review', 'clean', ...args], { ...deps, env: { CLAUDE_CODE_SESSION_ID: 'other' } })).toBe(2);
    expect(main(['self-review', 'must-fix', ...args, '--note=variant row 3 uncovered'], deps)).toBe(0);
    expect(m.sr).toMatchObject({ state: 'must-fix', note: 'variant row 3 uncovered', returnedAt: new Date(T0).toISOString() });
    expect(main(['self-review', 'clean', ...args], deps)).toBe(2); // already returned
  });

  it('start exits 3 (blocking) when the setting is off, and records nothing', () => {
    const { m, deps } = mem();
    const code = main(['self-review', 'start', ...args], { ...deps, selfReviewPolicy: () => ({ selfReviewParallel: false, source: 'env', invalid: [] }) });
    expect(code).toBe(3);
    expect(JSON.parse(m.out)).toMatchObject({ mode: 'blocking' });
    expect(m.sr).toBeNull();
  });

  it('marking the repair commit (a new sha) flips must-fix → repaired; re-marking the reviewed sha does not', () => {
    const { m, deps } = mem();
    main(['self-review', 'start', ...args], deps);
    main(['self-review', 'must-fix', ...args], deps);
    const mark = ['mark', '--repo=web-everything/web-everything', '--pr=4115', '--who=fix-4115', '--ref=lane/item-68b', '--kind=fix', '--attempt=1'];
    expect(main(mark, deps)).toBe(0);
    expect(m.sr.state).toBe('must-fix');
    m.head = SHA2;
    expect(main(mark, deps)).toBe(0);
    expect(m.sr).toMatchObject({ state: 'repaired', repairSha: SHA2 });
  });

  it('the store round-trips under a repo-key filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'self-review-'));
    try {
      expect(selfReviewKey({ repo: REPO, pr: 4115 })).toBe('we-4115');
      expect(writeSelfReview(pending(), { dir })).toMatchObject({ ok: true, key: 'we-4115' });
      expect(readSelfReview({ repo: 'we', pr: 4115 }, { dir })).toMatchObject({ state: 'pending', sha: SHA });
      expect(writeSelfReview({ ...pending(), state: 'bogus' }, { dir })).toMatchObject({ ok: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('claim release requires BOTH verify green and the self-review returned', () => {
  const labels = () => ({ ensureLabel() {}, setLabels() {}, postComment() {} });
  const gh = async () => JSON.stringify({ headRefOid: SHA });
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'fix-claim-sr-'));
    const a = acquireFixClaim({ repo: 'we', pr: 4115, who: 'fix-4115', sessionId: SESSION, branch: 'lane/item-68b', lockRoot: root, nowMs: Date.now() });
    expect(a.ok).toBe(true);
    return root;
  };
  const end = (root, selfReview, completion, cleared = []) => fixEnd({
    repo: 'we', pr: 4115, who: 'fix-4115', sessionId: SESSION, gh, labels: labels(), lockRoot: root,
    readSelfReview: async () => selfReview, readCompletion: async () => completion, clearSelfReview: (r) => cleared.push(r),
  });
  const done = (outcome) => ({ status: 'done', outcome, sessionId: SESSION, updatedAt: new Date().toISOString() });

  it('a hand-back fix-end is refused while the review is pending or must-fix; the claim stays held', async () => {
    const root = setup();
    try {
      expect(await end(root, pending(), done('re-armed'))).toMatchObject({ ok: false, reason: expect.stringMatching(/^self-review-open: self-review pending/) });
      expect(await end(root, pending({ state: 'must-fix' }), null)).toMatchObject({ ok: false, reason: expect.stringMatching(/must-fix/) });
      expect(readLiveFixClaim({ repo: 'we', pr: 4115, lockRoot: root })).not.toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('releases once the review returned clean, and clears the record', async () => {
    const root = setup();
    try {
      const cleared = [];
      expect(await end(root, pending({ state: 'clean', returnedAt: new Date().toISOString() }), done('re-armed'), cleared)).toMatchObject({ ok: true });
      expect(cleared).toEqual([{ repo: 'we', pr: 4115 }]);
      expect(readLiveFixClaim({ repo: 'we', pr: 4115, lockRoot: root })).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a non-hand-back exit (gate-red) still releases: its stand-down keeps the PR held', async () => {
    const root = setup();
    try {
      expect(await end(root, pending(), done('gate-red'))).toMatchObject({ ok: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('no self-review record is today\'s flow', async () => {
    const root = setup();
    try { expect(await end(root, null, null)).toMatchObject({ ok: true }); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('selfReviewReleaseRefusal: a completion of another session never counts as this session\'s exit', () => {
    const r = selfReviewReleaseRefusal({ selfReview: pending(), completion: { ...done('gate-red'), sessionId: 'other' }, sessionId: SESSION, who: 'fix-4115', hold: selfReviewHold });
    expect(r).toMatch(/self-review-open/);
  });
});

describe('fix.selfReviewParallel — the policy cascade', () => {
  it('standard default ON; env wins; invalid ignored and reported', () => {
    expect(resolveSelfReviewPolicy({})).toEqual({ selfReviewParallel: true, source: 'standard', invalid: [] });
    expect(resolveSelfReviewPolicy({ tool: { selfReviewParallel: false } })).toMatchObject({ selfReviewParallel: false, source: 'tool' });
    expect(resolveSelfReviewPolicy({ tool: { selfReviewParallel: false }, env: { [FIX_SELF_REVIEW_PARALLEL_ENV]: 'on' } })).toMatchObject({ selfReviewParallel: true, source: 'env' });
    const p = resolveSelfReviewPolicy({ platform: { selfReviewParallel: 'x' } });
    expect(formatSelfReviewPolicyLine(p)).toBe('fix-self-review-policy: selfReviewParallel=true (standard); ignored invalid platform.selfReviewParallel="x"');
  });
});
