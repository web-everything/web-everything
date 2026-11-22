// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runResolvedSideBranchPass, defaultResolvedSideBranchIo, resolvedPushAdmission,
  acquireResolvedPushClaim, checkResolvedPushClaim, releaseResolvedPushClaim, resolvedProtectionBodies,
  enrichResolvedSideBranches } from '../resolved-side-branch-push.mjs';
import { findResolvedSideBranch, resolvedPushBody } from '../resolved-side-branch.mjs';
import { AUTOMATION_LOGINS, buildConcurrentAuthorPauseComment, buildStandDownComment, standDownHead,
  standDownFindingRefs, buildLoadFlakeHoldComment } from '../stand-down.mjs';
import { pushedLoadFlakeFixOwedRearm } from '../load-flake-hold.mjs';
import { rearmPushedFixes } from '../load-flake-reverify.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { runReconcileCiHealDispatch } from '../../operations/ci-heal-pr-dispatch.mjs';
import { runReconcilePass } from '../reconcile-pass.mjs';
import { pushRefusal, acquireFixClaim, releaseFixClaim } from '../fix-procedure.mjs';
import { listFixDispatchClaims } from '../fix-claim-store.mjs';
import { acquireFixDispatchClaim, releaseFixDispatchClaim } from '../fix-dispatch-claim.mjs';

const H = '1'.repeat(40), B = '2'.repeat(40), S = '3'.repeat(40), T = '4'.repeat(40);
const repo = 'web-everything/web-everything', branch = 'lane/topic-fix-7329-alt';
const comment = body => ({ id: 'IC_record', body, author: { login: AUTOMATION_LOGINS[0] }, createdAt: '2026-11-20T00:00:00Z' });
const record = comment(buildConcurrentAuthorPauseComment({ head: H, alt: branch, altSha: S }));
const pr = { number: 7329, state: 'OPEN', headRefName: 'lane/topic', headRefOid: H, baseRefName: 'main', baseRefOid: B,
  isCrossRepository: false, labels: ['review:changes'], comments: [record], statusCheckRollup: [] };
const candidate = { name: branch, sha: S, ancestors: [S, H, B] };
function fixture(overrides = {}) {
  let live = structuredClone(pr);
  const order = [];
  const push = vi.fn(() => { order.push('push'); live.headRefOid = S; });
  const io = { listPrs: vi.fn(() => [structuredClone(pr)]), readPr: vi.fn(() => structuredClone(live)),
    readBranches: vi.fn(() => [candidate]), acquireClaim: vi.fn(() => { order.push('claim'); return { ok: true }; }),
    checkClaim: vi.fn(() => true), releaseClaim: vi.fn(() => order.push('release')),
    admitPush: vi.fn(() => true), appToken: vi.fn(() => 'ghs_app'),
    preparePush: vi.fn(() => { order.push('prepare'); return { push, close: vi.fn() }; }),
    protect: vi.fn(({ bodies }) => { order.push('protect'); live.comments.push(...bodies.map(comment)); }),
    record: vi.fn(() => order.push('record')), log: vi.fn(), ...overrides };
  return { io, push, order, live: () => live };
}
const run = io => runResolvedSideBranchPass({ repo }, io);

describe('Slice A audit guarantees', () => {
  it.each(['main', 'release/protected', 'lane/topic\n', 'lane/../main'])('#1 non-lane/protected destination %s never reaches transport', async headRefName => {
    const f = fixture({ listPrs: () => [{ ...pr, headRefName }] });
    expect((await run(f.io))[0].result).toBe('refused');
    expect(f.io.preparePush).not.toHaveBeenCalled();
    expect(f.push).not.toHaveBeenCalled();
  });
  it.each(['absent', 'foreign-login', 'viewer-only', 'wrong-sha', 'abbreviated', 'wrong-branch', 'unreadable'])('#3 %s producer/repair evidence never authorizes promotion', async variant => {
    let comments = [record];
    if (variant === 'absent') comments = [];
    if (variant === 'unreadable') comments = null;
    if (variant === 'foreign-login') comments = [{ ...record, author: { login: 'attacker' } }];
    if (variant === 'viewer-only') comments = [{ ...record, author: undefined, viewerDidAuthor: true }];
    if (variant === 'wrong-sha') comments = [comment(buildConcurrentAuthorPauseComment({ alt: branch, altSha: T }))];
    if (variant === 'abbreviated') comments = [comment(buildConcurrentAuthorPauseComment({ alt: branch, altSha: S.slice(0, 9) }))];
    if (variant === 'wrong-branch') comments = [comment(buildConcurrentAuthorPauseComment({ alt: branch + '-other', altSha: S }))];
    expect(findResolvedSideBranch({ pr: { ...pr, comments }, branches: [candidate] })).toBeNull();
    const f = fixture({ listPrs: () => [{ ...pr, comments }], readPr: () => ({ ...pr, comments }) });
    await run(f.io);
    expect(f.push).not.toHaveBeenCalled();
  });
  it('#3 a full App-authored --alt/alt-sha record binds exactly this saved tip', () => {
    expect(findResolvedSideBranch({ pr, branches: [candidate] })).toEqual(candidate);
  });
  const admission = () => ({ pr, candidate, policy: { pushBeforeGate: false, invalid: [] },
    verification: { sha: S, status: 'green' }, previousCi: { head: H, checks: [{ name: 'test', conclusion: 'success' }], required: ['test'], firstHeldAt: 1000 },
    timing: { pushAfterCi: true, pushAfterCiMaxMin: 30 }, now: 2000 });
  it.each(['red', 'load-red', 'pending', 'absent', 'other-head'])('#4 pushBeforeGate=false retains %s verification refusal', status => {
    const args = admission(); args.verification = status === 'absent' ? null : { sha: status === 'other-head' ? T : S, status };
    expect(resolvedPushAdmission(args)).toBe(false);
    args.policy.pushBeforeGate = true;
    expect(resolvedPushAdmission(args)).toBe(false);
  });
  it('#4 unknown previous-head CI, a wrong CI head and pending CI retain normal admission', () => {
    const args = admission();
    expect(resolvedPushAdmission(args)).toBe(true);
    for (const previousCi of [null, { ...args.previousCi, head: T }, { ...args.previousCi, checks: [] }])
      expect(resolvedPushAdmission({ ...args, previousCi })).toBe(false);
  });
  it('#4 saved load-flake retries remain owned by the capped worker; neither a green marker nor early-push overrides it', () => {
    const args = admission();
    args.pr = { ...pr, comments: [record, comment(buildLoadFlakeHoldComment({ head: H, alt: branch, altSha: S }))] };
    expect(resolvedPushAdmission(args)).toBe(false);
  });
  it('#4 default admission does not manufacture verification or reset previous-head CI waits', () => {
    const io = defaultResolvedSideBranchIo({ env: {}, log: vi.fn() });
    expect(io.admitPush({ pr, candidate })).toBe(false);
  });
  it('#5 unanswered stand-down and its finding/run subjects stay refused after pushing to the new head', async () => {
    const question = comment(buildStandDownComment({ head: H, reason: 'needs-judgment', findingRefs: [{ runId: 'run-17', key: 'finding-1' }] }));
    const f = fixture({ listPrs: () => [{ ...pr, comments: [record, question] }] });
    f.io.readPr = vi.fn(() => ({ ...f.live(), comments: f.live().comments.includes(question) ? f.live().comments : [...f.live().comments, question] }));
    await run(f.io);
    expect(f.push).toHaveBeenCalledOnce();
    const carried = f.live().comments.find(c => standDownHead(c.body) === S);
    expect(carried).toBeDefined();
    expect(standDownFindingRefs(carried.body)).toEqual([{ runId: 'run-17', key: 'finding-1' }]);
    const plan = planReconcile({ prs: [f.live()], now: Date.now(), standDownHoldsAcrossHeads: { value: false, source: 'test' } });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'stood-down' }));
    expect(f.order.indexOf('protect')).toBeLessThan(f.order.indexOf('push'));
  });
  it('#5 unreadable/unbound legacy question cannot be silently dropped', () => {
    expect(() => resolvedProtectionBodies({ ...pr, comments: [comment('🛑 conveyor fix — stood down, human judgment needed\nlegacy question')] }, candidate)).toThrow(/legacy question/);
  });
  it.each(['missing-directory', 'directory-error', 'corrupt-entry', 'missing-entry'])('#6 %s claim evidence refuses, never reads as an empty store', async variant => {
    const root = mkdtempSync(join(tmpdir(), 'saved-claims-'));
    try {
      let lockRoot = root;
      if (variant === 'missing-directory') lockRoot = join(root, 'absent');
      if (variant === 'directory-error') { lockRoot = join(root, 'file'); writeFileSync(lockRoot, 'not a directory'); }
      if (variant === 'corrupt-entry' || variant === 'missing-entry') {
        mkdirSync(join(root, 'bad'));
        if (variant === 'corrupt-entry') writeFileSync(join(root, 'bad', 'lock.json'), '{');
      }
      expect(() => pushRefusal({ repo, branch: pr.headRefName, lockRoot, strict: true })).toThrow();
      const f = fixture({ acquireClaim: () => acquireResolvedPushClaim({ repo, pr, lockRoot }) });
      await run(f.io);
      expect(f.push).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('#7 real fixing and dispatch claims serialize a racing fixer; release happens after push/record', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'saved-claim-race-'));
    try {
      const held = acquireResolvedPushClaim({ repo, pr, lockRoot });
      expect(held.ok).toBe(true);
      expect(checkResolvedPushClaim({ repo, pr, claim: held })).toBe(true);
      expect(acquireFixClaim({ repo, pr: pr.number, who: 'racing-fixer', branch: pr.headRefName, lockRoot }).ok).toBe(false);
      expect(acquireFixDispatchClaim({ repo: 'we', pr: pr.number, kind: 'fix', owner: 'racer', lockRoot }).ok).toBe(false);
      expect(acquireFixDispatchClaim({ repo: 'we', pr: pr.number, kind: 'ci-heal', owner: 'racer', lockRoot }).ok).toBe(false);
      releaseResolvedPushClaim({ pr, claim: held });
      expect(listFixDispatchClaims(lockRoot, { strict: true })).toEqual([]);
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
    const f = fixture(); await run(f.io);
    expect(f.order).toEqual(['claim', 'prepare', 'protect', 'push', 'record', 'release']);
  });
  it('#7 a lost claim inside the prepared transport prevents the write and releases our claims', async () => {
    const f = fixture();
    f.io.checkClaim.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await run(f.io);
    expect(f.push).not.toHaveBeenCalled();
    expect(f.io.releaseClaim).toHaveBeenCalledOnce();
  });
  it.each(['state', 'headRefOid', 'headRefName', 'baseRefOid', 'baseRefName'])('#8 %s changes during preparation: final live read prevents the push', async key => {
    const f = fixture();
    f.io.preparePush = vi.fn(() => {
      f.live()[key] = key === 'state' ? 'CLOSED' : key.endsWith('Oid') ? T : 'lane/other';
      return { push: f.push };
    });
    await run(f.io);
    expect(f.push).not.toHaveBeenCalled();
    expect(f.io.releaseClaim).toHaveBeenCalledOnce();
  });
  it('#8 prepared writes receive the exact expected old head; no force fallback exists', async () => {
    const f = fixture(); await run(f.io);
    expect(f.push).toHaveBeenCalledWith({ expectedHead: H });
  });
  it.each(['readback', 'record', 'close'])('#9 %s failure AFTER successful push is pushed-unrecorded and retains exact head suppression', async kind => {
    const f = fixture();
    if (kind === 'readback') f.io.readPr = vi.fn(() => { if (f.live().headRefOid === S) throw Error('read failed'); return structuredClone(f.live()); });
    if (kind === 'record') f.io.record = vi.fn(() => { throw Error('record failed'); });
    if (kind === 'close') f.io.preparePush = vi.fn(() => ({ push: f.push, close: () => { throw Error('close failed'); } }));
    const rows = await run(f.io);
    expect(rows.at(-1)).toMatchObject({ result: 'pushed-unrecorded', sha: S });
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.io.releaseClaim).toHaveBeenCalledOnce();
    expect(pushedLoadFlakeFixOwedRearm(f.live())).toMatchObject({ sha: S });
  });
  it('#9 a failed push is never recorded as successful or suppresses the old head via a repair marker', async () => {
    const f = fixture(); f.push.mockImplementation(() => { throw Error('rejected'); });
    expect((await run(f.io))[0].result).toBe('refused');
    expect(f.io.record).not.toHaveBeenCalled();
    expect(pushedLoadFlakeFixOwedRearm(f.live())).toBeNull();
  });
  it('#10 next tick re-arms the repaired head rather than launching a fixer on old findings; later review reopens ordinary planning', async () => {
    const f = fixture(); await run(f.io);
    const next = { ...f.live(), comments: [...f.live().comments, comment('Reviewer: old finding at scripts/x.mjs:1')], resolvedSideBranches: [candidate] };
    const plan = planReconcile({ prs: [next], now: Date.now() });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'load-flake-rearm-owed', sha: S }));
    const io = { readPr: () => next, rearm: vi.fn() };
    expect(await rearmPushedFixes({ prs: [next], slug: repo }, io)).toEqual([{ pr: pr.number, sha: S, result: 'rearmed' }]);
    expect(io.rearm).toHaveBeenCalledOnce();
    expect(pushedLoadFlakeFixOwedRearm({ ...next, comments: [...next.comments, comment('🔁 review — changes requested\nnew findings')] })).toBeNull();
  });
  it('#10 a foreign author cannot forge a pushed-repair suppression or close a valid round', () => {
    const pushed = comment(resolvedPushBody({ head: H, sha: S, branch }));
    expect(pushedLoadFlakeFixOwedRearm({ ...pr, headRefOid: S, comments: [{ ...pushed, author: { login: 'attacker' } }] })).toBeNull();
    expect(pushedLoadFlakeFixOwedRearm({ ...pr, headRefOid: S, comments: [pushed, { ...comment('✅ review — accepted'), author: { login: 'attacker' } }] })).toMatchObject({ sha: S });
  });
  it('#14 scan cursor rotates; an unscanned ninth PR never receives an unreadable hold', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ ...pr, number: i + 1 }));
    const io = { listPrs: () => rows, readBranches: vi.fn(() => []), log: vi.fn() };
    const one = await runResolvedSideBranchPass({ repo }, io);
    expect(one.nextCursor).toBe(9); expect([...one]).toEqual([]);
    await runResolvedSideBranchPass({ repo, cursor: one.nextCursor }, io);
    expect(io.readBranches.mock.calls[8][0].number).toBe(9);
  });
  it.each(['deadline', 'adoption'])('#13 %s yields before expensive reads, retaining the PR cursor', async kind => {
    const f = fixture();
    const rows = await runResolvedSideBranchPass({ repo, now: () => 10, deadlineAt: kind === 'deadline' ? 10 : 100,
      shouldYield: () => kind === 'adoption' }, f.io);
    expect(rows.nextCursor).toBe(pr.number);
    expect(f.io.readBranches).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
  });
  it('#15/#16 actual API producer pins binary/host, scrubs hostile environment and disables personal routing on EVERY call', () => {
    const exec = vi.fn(() => '[]');
    const io = defaultResolvedSideBranchIo({ exec, ghBin: '/usr/bin/gh', env: { PATH: '/attacker', GH_HOST: 'evil.invalid',
      GH_TOKEN: 'ghp_personal', WE_GH_THROTTLE_GH_BIN: '/attacker/gh', WE_GH_THROTTLE_PERSONAL_READS: 'on' }, tokenForRepo: () => 'ghs_app' });
    io.listPrs(repo); io.listPrs(repo);
    expect(exec).toHaveBeenCalledTimes(2);
    for (const [file, args, opts] of exec.mock.calls) {
      expect(file).toBe('gh'); expect(args).toContain('github.com');
      expect(opts.env).toMatchObject({ PATH: '/usr/bin:/bin', GH_HOST: 'github.com', GH_TOKEN: 'ghs_app', GITHUB_TOKEN: 'ghs_app' });
      expect(opts.env.WE_GH_THROTTLE_GH_BIN).toBeUndefined();
      expect(opts.throttle).toMatchObject({ bin: '/usr/bin/gh', personalRoute: false, retries: 0 });
    }
  });
  it('#15/#16 missing pinned binary or rejected App auth refuses without a personal credential retry', () => {
    const exec = vi.fn(() => { throw Error('401'); });
    const io = defaultResolvedSideBranchIo({ exec, ghBin: '/usr/bin/gh', tokenForRepo: () => 'ghs_app' });
    expect(() => io.listPrs(repo)).toThrow(); expect(exec).toHaveBeenCalledOnce();
    const missing = defaultResolvedSideBranchIo({ exec, ghBin: null, tokenForRepo: () => 'ghs_app' });
    expect(() => missing.listPrs(repo)).toThrow(); expect(exec).toHaveBeenCalledOnce();
  });
  it('shared API budget exhaustion refuses before sending the next call and names operator recovery', () => {
    const exec = vi.fn(() => '[]');
    const io = defaultResolvedSideBranchIo({ exec, ghBin: '/usr/bin/gh', maxCalls: 1, tokenForRepo: () => 'ghs_app' });
    io.listPrs(repo);
    expect(() => io.listPrs(repo)).toThrow(/operator inspection/);
    expect(exec).toHaveBeenCalledOnce();
  });
});

it('#11 ci-heal consumes saved-branch holds from the shared reconcile pass without fixer enrichment', async () => {
  const id = value => value;
  const enrichResolvedBranches = vi.fn(rows => enrichResolvedSideBranches(rows, { repo, cursors: new Map(),
    io: { readPr: () => pr, readBranches: () => { throw Error('unreadable saved ref'); } } }));
  const shared = () => runReconcilePass({ repo, readOnly: true, env: {},
    readPrs: () => [pr], readAgents: () => [], enrich: id,
    readRequiredChecks: () => ({ checks: ['test'], source: 'fixture' }), readChecks: () => [],
    enrichMainRed: prs => ({ prs, mainRedWindows: [] }), excuseMergeGateHolds: id,
    enrichAlreadyLanded: id, enrichBaseRef: id, enrichConflictDisposition: id,
    enrichSystemFix: id, enrichEscalationBase: id, enrichFixClaims: id, enrichTimeouts: id,
    enrichReferralHolds: id, enrichReferralAutoResolve: id, enrichLedgerHolds: id,
    enrichRulings: id, enrichScopeBloat: id, enrichCodeQL: id, enrichStandingRulingGrants: id,
    enrichMechanicalRound: id, enrichOwedMainRule: () => {}, enrichResolvedBranches,
    resolveMainSha: () => null, readPriority: () => null, stepLog: () => {},
  });
  const dispatch = vi.fn();
  const result = await runReconcileCiHealDispatch({ repo, reconcile: shared, checkStaleness: () => ({ fresh: true }),
    dispatch, pollAttempts: () => [], flushOwed: () => ({}), flushTimeouts: () => [],
    salvage: () => null, fixLoop: () => null, currentBuild: () => 'fixture', loadItems: () => [] });
  expect(enrichResolvedBranches).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
  expect(result.reconcileRefusalDetails).toContainEqual(expect.objectContaining({ kind: 'resolved-side-branch-unreadable' }));
});

it('#5 a new unanswered question arriving after protection is published refuses the push', async () => {
  const f = fixture();
  const original = f.io.protect;
  f.io.protect = vi.fn(args => {
    original(args);
    f.live().comments.push(comment(buildStandDownComment({ head: H, reason: 'needs-judgment' })));
  });
  const rows = await run(f.io);
  expect(rows[0].result).toBe('refused');
  expect(f.push).not.toHaveBeenCalled();
  expect(f.io.releaseClaim).toHaveBeenCalledOnce();
});
it('#14 a persisted unreadable row is not carried onto an unscanned PR', () => {
  const prs = Array.from({ length: 9 }, (_, i) => ({ ...pr, number: i + 1, resolvedSideBranches: null }));
  const rows = enrichResolvedSideBranches(prs, { repo, cursors: new Map(), io: { readPr: (_r, number) => ({ ...pr, number }), readBranches: () => [] } });
  expect(rows[8]).not.toHaveProperty('resolvedSideBranches');
});
it('oversized scan/API budgets and unknown bounds refuse with an operator fallback', () => {
  for (const maxPrs of [9, -1, NaN]) expect(() => enrichResolvedSideBranches([], { repo, maxPrs })).toThrow(/operator inspection/);
  for (const maxCalls of [129, -1, NaN]) expect(() => defaultResolvedSideBranchIo({ maxCalls })).toThrow(/operator inspection/);
});
