/**
 * fix.pushBeforeGate (operator go 2026-10-10): the harness pushes a fixer's marked commit BEFORE the local verify
 * verdict, while the fix claim stays held until green. The claim-side refusals are pinned at the end against the
 * real reconcile planner, ci-heal admission and drain classifier.
 */
import { describe, it, expect } from 'vitest';
import { runAwaitVerifyPass, isEarlyPushOwed, buildAwaitVerifyResumePrompt, formatAwaitVerifyLines, AWAIT_VERIFY_LIMITS, pushShaFromScratch } from '../await-verify-pass.mjs';
import { planReconcile as planReconcileWithTiming } from '../reconcile-core.mjs';
// This historical fixture exercises the serial policy; new defaults have their own timing suite.
const planReconcile = options => planReconcileWithTiming({ reviewTiming: { startAfter: 'ci-green' }, fixTiming: { joinCiAndReview: false }, ...options });
import { classifyPr, attachLiveFixClaim } from '../../merge-ai-prs.mjs';
import { dispatchCiHeal } from '../../operations/ci-heal-pr-dispatch.mjs';

const SHA = '65a382e81413952ab11e5448e36f01bb7ce4c332';
const SHA2 = 'b96574995e22b8d8087d4a28b7ba7615d4ec8c73';
const TREE = 'f'.repeat(64);
const T0 = Date.parse('2026-10-10T14:05:00.000Z');
const TTL = 150 * 60_000;
const SESSION = '0c5f3830-1522-49ab-8f20-e4108ccc926b';
const rec = (over = {}) => ({
  v: 1, sessionId: SESSION, who: 'fix-4115', repo: 'web-everything/web-everything',
  pr: 4115, sha: SHA, requestedAt: new Date(T0).toISOString(), attempt: 1,
  lane: '/lanes/lane-5', ref: 'lane/item-68b', kind: 'fix', ...over,
});
const marker = (status, over = {}) => ({ sha: SHA, status, startedAt: new Date(T0).toISOString(), treeHash: TREE, exitCode: status === 'green' ? 0 : status === 'red' ? 1 : null, ...over });
const ON = { pushBeforeGate: true, source: 'standard', invalid: [] };
const OFF = { pushBeforeGate: false, source: 'tool', invalid: [] };

/** In-memory harness (same shape as await-verify-pass.test.mjs) with a fake remote branch and a claim flag. */
function harness({ records = [rec()], policy = ON } = {}) {
  const store = new Map(records.map((r) => [r.sessionId, r]));
  const calls = { push: [], resume: [], rerequest: [] };
  const state = { marker: marker('running'), lane: { head: SHA, dirty: false, treeHash: TREE }, remote: null, claimHeld: true, events: [] };
  const io = {
    pushPolicy: () => policy,
    listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
    writeRecord: (r) => { store.set(r.sessionId, r); return { ok: true }; },
    clearRecord: (key) => { store.delete(key); },
    laneState: () => state.lane,
    readMarker: () => state.marker,
    rerequest: (l) => { calls.rerequest.push(l); return { ok: true, status: 'requested' }; },
    push: (a) => { calls.push.push(a); state.remote = a.sha; state.events.push(`push ${a.sha.slice(0, 8)}`); return { ok: true }; },
    listSessions: () => [{ sessionId: SESSION, name: 'fix-4115', cwd: '/scratch', state: 'done' }],
    // The fixer's green hand-back is what releases the claim (fix-end); a red resume never does.
    resume: (a) => { calls.resume.push(a); if (/GREEN/.test(a.prompt)) { state.claimHeld = false; state.events.push('claim released'); } return { resumed: true }; },
  };
  return { io, store, calls, state };
}
const pass = (h, over = {}) => runAwaitVerifyPass({ io: h.io, nowMs: T0 + 30_000, ttlMs: TTL, loggedPolicyLine: { value: null }, ...over });

describe('pushShaFromScratch: first-attempt no-op evidence', () => {
  function push({ flag = '=', failure, remote = SHA } = {}) {
    let attempts = 0;
    const exec = (cmd, args) => {
      expect(cmd).toBe('git');
      if (args.includes('init') || args.includes('fetch')) return '';
      if (args.includes('push')) {
        expect(args).toContain('--porcelain');
        attempts += 1;
        if (attempts === 1 && failure) throw Object.assign(new Error(failure), { stderr: failure });
        return `To remote\n${flag}\trefs/source:refs/heads/x\t${flag === '=' ? '[up to date]' : '[new branch]'}\nDone\n`;
      }
      if (args.includes('rev-parse')) return remote;
      if (args.includes('merge-base')) {
        if (args.at(-2) === remote) throw new Error('not an ancestor');
        return ''; // sha is an ancestor of the remote: contains
      }
      if (args.includes('ls-remote')) return `${remote}\trefs/heads/x\n`;
      throw new Error(`unexpected git argv: ${args.join(' ')}`);
    };
    const result = pushShaFromScratch({ laneGitDir: '/unused', url: 'https://example.test/repo', sha: SHA, ref: 'x', exec,
      sleep: () => {}, tuning: { attempts: 2, baseMs: 1, capMs: 1 } });
    return { result, attempts };
  }

  it('marks upToDate only for a first-attempt = porcelain status', () => {
    expect(push()).toEqual({ result: { remote: SHA, upToDate: true }, attempts: 1 });
  });
  it.each(['*', ' '])('does not mark a normal %s push upToDate', (flag) => {
    expect(push({ flag })).toEqual({ result: { remote: SHA }, attempts: 1 });
  });
  it.each([['equal', SHA], ['contains', SHA2]])('keeps lost-response %s reconciliation as alreadyThere without upToDate', (_state, remote) => {
    expect(push({ failure: 'unknown push response', remote })).toEqual({ result: { remote, alreadyThere: true }, attempts: 1 });
  });
  it('does not mark a retry upToDate after a transient failure even when it prints =', () => {
    expect(push({ failure: 'fatal: The requested URL returned error: 502' })).toEqual({ result: { remote: SHA }, attempts: 2 });
  });
});

describe('push-before-gate: the early push', () => {
  it('pushes the marked sha while verify is still running, keeps the record waiting, logs the push time', async () => {
    const h = harness();
    const { rows } = await pass(h);
    expect(h.calls.push).toEqual([expect.objectContaining({ sha: SHA, ref: 'lane/item-68b', sessionId: SESSION })]);
    expect(h.calls.resume).toEqual([]);
    expect(h.store.get(SESSION).earlyPush.upToDate).toBeUndefined();
    expect(h.store.get(SESSION).earlyPush).toMatchObject({ sha: SHA, ok: true, done: true, at: new Date(T0 + 30_000).toISOString() });
    const lines = formatAwaitVerifyLines({ rows });
    expect(lines[0]).toBe('await-verify: fix-push-policy: pushBeforeGate=true (standard)');
    expect(lines.some((l) => /early-push \(push-before-gate \(standard\)\) → sent 65a382e8 to lane\/item-68b at 2026-10-10T14:05:30.000Z, before the verify verdict; fix claim still held/.test(l))).toBe(true);
  });
  it.each(['wait', 'rerequest'])('resumes once for evidence when an early push reports upToDate (%s)', async (action) => {
    const h = harness();
    if (action === 'rerequest') h.state.marker = null;
    h.io.push = (a) => { h.calls.push.push(a); return { ok: true, upToDate: true }; };
    const { rows } = await pass(h);
    expect(h.calls.push).toHaveLength(1);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toContain('## Fix evidence');
    expect(h.calls.resume[0].prompt).toContain(SHA);
    expect(rows).toContainEqual(expect.objectContaining({ action: 'resume', reason: 'no-new-commit' }));
    expect(h.calls.rerequest).toEqual([]);
    expect(h.store.size).toBe(0);
    await pass(h);
    expect(h.calls.resume).toHaveLength(1);
  });
  it('keeps waiting when a landed push loses its success persist and the next tick reports upToDate', async () => {
    const h = harness();
    const writeRecord = h.io.writeRecord;
    h.io.writeRecord = (r) => r.earlyPush?.ok ? { ok: false } : writeRecord(r);
    await pass(h);
    expect(h.state.remote).toBe(SHA);
    expect(h.store.get(SESSION).earlyPush).toEqual({ sha: SHA, attempts: 1, done: false });
    expect(h.calls.resume).toEqual([]);

    h.io.writeRecord = writeRecord;
    h.io.push = (a) => { h.calls.push.push(a); return { ok: true, upToDate: true }; };
    const { rows } = await pass(h);
    expect(h.calls.push).toHaveLength(2);
    expect(h.store.get(SESSION).earlyPush).toMatchObject({ attempts: 2, ok: true, done: true });
    expect(h.store.get(SESSION).earlyPush.upToDate).toBeUndefined();
    expect(h.calls.resume).toEqual([]);
    expect(rows).toContainEqual(expect.objectContaining({ action: 'wait' }));
  });
  it('keeps waiting for verify on repair attempt 2 even when its first push reports upToDate', async () => {
    const h = harness({ records: [rec({ attempt: 2 })] });
    h.io.push = (a) => { h.calls.push.push(a); return { ok: true, upToDate: true }; };
    const { rows } = await pass(h);
    expect(h.store.get(SESSION).earlyPush).toMatchObject({ attempts: 1, upToDate: true });
    expect(h.calls.resume).toEqual([]);
    expect(rows).toContainEqual(expect.objectContaining({ action: 'wait' }));
  });
  it.each([undefined, 2])('keeps waiting for persisted upToDate evidence with early-push attempts=%s', async (attempts) => {
    const h = harness({ records: [rec({ earlyPush: { sha: SHA, attempts, ok: true, done: true, upToDate: true } })] });
    const { rows } = await pass(h);
    expect(h.calls.push).toEqual([]);
    expect(h.calls.resume).toEqual([]);
    expect(h.store.has(SESSION)).toBe(true);
    expect(rows).toContainEqual(expect.objectContaining({ action: 'wait' }));
  });
  it('keeps the green path when the push was upToDate', async () => {
    const h = harness({ records: [rec({ attempt: 1, earlyPush: { sha: SHA, attempts: 1, done: true, ok: true, upToDate: true } })] });
    h.state.marker = marker('green');
    h.io.push = (a) => { h.calls.push.push(a); return { ok: true, upToDate: true }; };
    const { rows } = await pass(h);
    expect(h.calls.push).toHaveLength(1);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toContain('Verify is GREEN');
    expect(h.calls.resume[0].prompt).not.toContain('Do NOT re-mark');
    expect(rows).toContainEqual(expect.objectContaining({ action: 'push', reason: 'green' }));
    expect(h.store.size).toBe(0);
  });
  it('preserves a pending resume even when the push was upToDate', async () => {
    const h = harness({ records: [rec({ attempt: 1, earlyPush: { sha: SHA, attempts: 1, done: true, ok: true, upToDate: true }, pendingResume: { kind: 'red' } })] });
    const { rows } = await pass(h);
    expect(h.calls.push).toEqual([]);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toContain('Verify is RED');
    expect(rows).toContainEqual(expect.objectContaining({ action: 'resume', reason: 'pending-resume', result: 'resumed:red' }));
    expect(h.store.size).toBe(0);
  });
  it('keeps the red verdict resume when the push was upToDate', async () => {
    const h = harness({ records: [rec({ attempt: 1, earlyPush: { sha: SHA, attempts: 1, done: true, ok: true, upToDate: true } })] });
    h.state.marker = marker('red');
    const { rows } = await pass(h);
    expect(h.calls.push).toEqual([]);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toContain('Verify is RED');
    expect(rows).toContainEqual(expect.objectContaining({ action: 'resume', reason: 'red', result: 'resumed:red' }));
    expect(rows).not.toContainEqual(expect.objectContaining({ reason: 'no-new-commit' }));
    expect(h.store.size).toBe(0);
  });
  it('does not resume for an upToDate result belonging to another sha', async () => {
    const h = harness({ policy: OFF, records: [rec({ attempt: 1, earlyPush: { sha: SHA2, attempts: 1, ok: true, done: true, upToDate: true } })] });
    await pass(h);
    expect(h.calls.resume).toEqual([]);
    expect(h.store.has(SESSION)).toBe(true);
  });
  it('keeps waiting for legacy alreadyThere evidence from failure reconciliation', async () => {
    const h = harness({ records: [rec({ earlyPush: { sha: SHA, ok: true, done: true, alreadyThere: true } })] });
    await pass(h);
    expect(h.calls.resume).toEqual([]);
    expect(h.store.has(SESSION)).toBe(true);
  });
  it('no-new-commit prompt directs the fixer to post durable evidence and finish', () => {
    const prompt = buildAwaitVerifyResumePrompt({ kind: 'no-new-commit', record: rec() });
    expect(prompt).toMatch(/^\[harness verify verdict/);
    for (const text of ['already had this exact sha when the harness tried to push it (upToDate)', 'Do NOT re-mark',
      'standalone heading `## Fix evidence`', `Head: ${SHA}`, '<!-- addresses-operator-send-back: <id> -->',
      'per open operator send-back you addressed', 'file:line citations', 'hand-back', 'completion report', 'fix-end']) {
      expect(prompt).toContain(text);
    }
  });
  it('pushes once per sha: the next tick only waits', async () => {
    const h = harness();
    await pass(h);
    await pass(h);
    expect(h.calls.push).toHaveLength(1);
  });
  it('a transient failure retries on later ticks, bounded; a refusal is not retried early', async () => {
    const h = harness();
    h.io.push = (a) => { h.calls.push.push(a); return { ok: false, transient: true, reason: '502' }; };
    for (let i = 0; i < 6; i += 1) await pass(h);
    expect(h.calls.push).toHaveLength(AWAIT_VERIFY_LIMITS.maxRetries + 1);
    const r = harness();
    r.io.push = (a) => { r.calls.push.push(a); return { ok: false, reason: 'claim not held by this session' }; };
    await pass(r); await pass(r);
    expect(r.calls.push).toHaveLength(1);
  });
  it('never pushes early for a known red, a dirty/moved lane, a ci-heal/delivery record, or with the setting off', () => {
    const owed = (record, action, policy = ON) => isEarlyPushOwed({ record, decision: { action }, policy });
    expect(owed(rec(), 'wait')).toBe(true);
    expect(owed(rec(), 'rerequest')).toBe(true);
    expect(owed(rec(), 'resume')).toBe(false); // red / moved / dirty all classify `resume`
    expect(owed(rec(), 'push')).toBe(false);   // green: the normal push path
    expect(owed(rec({ kind: 'ci-heal' }), 'wait')).toBe(false);
    expect(owed(rec({ kind: 'delivery', pr: undefined, item: 7 }), 'wait')).toBe(false);
    expect(owed(rec(), 'wait', OFF)).toBe(false);
    expect(owed(rec(), 'wait', null)).toBe(false);
  });
});

describe('push-before-gate: red → fix → push → green releases once', () => {
  it('walks the whole round', async () => {
    const h = harness();
    await pass(h); // early push of attempt 1
    h.state.marker = marker('red', { failureDetails: { tests: [{ file: 'a.test.mjs', name: 'x' }] } });
    await pass(h);
    expect(h.calls.resume).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toMatch(/already on lane\/item-68b \(pushed before the gate/);
    expect(h.calls.resume[0].prompt).toMatch(/You still hold the fix claim: keep it/);
    expect(h.state.claimHeld).toBe(true);
    // the fixer commits a NEW commit and re-marks attempt 2 (mark writes a fresh record)
    h.store.set(SESSION, rec({ sha: SHA2, attempt: 2, requestedAt: new Date(T0 + 60_000).toISOString() }));
    h.state.lane = { head: SHA2, dirty: false, treeHash: TREE };
    h.state.marker = marker('running', { sha: SHA2 });
    await pass(h, { nowMs: T0 + 90_000 });
    expect(h.state.remote).toBe(SHA2);
    h.state.marker = marker('green', { sha: SHA2 });
    await pass(h, { nowMs: T0 + 400_000 });
    expect(h.calls.resume).toHaveLength(2);
    expect(h.calls.resume[1].prompt).toMatch(/GREEN .*since 2026-10-10T14:06:30.000Z \(push-before-gate\)/s);
    expect(h.state.events).toEqual(['push 65a382e8', 'push b9657499', 'push b9657499', 'claim released']);
    await pass(h, { nowMs: T0 + 500_000 });
    expect(h.state.events.filter((e) => e === 'claim released')).toHaveLength(1);
    expect(h.store.size).toBe(0);
  });
});

describe('load-flake exits after an early push name the pushed sha as the PR head', () => {
  it('redispatch and WE alt-branch prompts', () => {
    const r = rec({ earlyPush: { sha: SHA, ok: true, done: true, at: 'x' } });
    const m = marker('red', { failureDetails: { tests: [{ file: 'a.test.mjs', name: 'x' }] } });
    const redis = buildAwaitVerifyResumePrompt({ kind: 'load-flake-redispatch', record: { ...r, repo: 'plateauapp/plateau-app' }, marker: m });
    expect(redis).toContain(`--head=${SHA}`);
    expect(redis).not.toContain('git rev-parse origin/');
    expect(buildAwaitVerifyResumePrompt({ kind: 'load-flake', record: r, marker: m })).toContain(`pass --head=${SHA}`);
    // without an early push the prompts are unchanged
    expect(buildAwaitVerifyResumePrompt({ kind: 'load-flake-redispatch', record: rec(), marker: m })).toContain('git rev-parse origin/lane/item-68b');
  });
});

describe('setting off = the old behaviour exactly', () => {
  it('no push until green, then exactly one push', async () => {
    const h = harness({ policy: OFF });
    const { rows } = await pass(h);
    expect(h.calls.push).toEqual([]);
    expect(h.store.get(SESSION).earlyPush).toBeUndefined();
    expect(rows.filter((r) => r.action !== 'wait' && r.action !== 'policy')).toEqual([]);
    h.state.marker = marker('green');
    await pass(h);
    expect(h.calls.push).toHaveLength(1);
    expect(h.calls.resume[0].prompt).toMatch(/pushed at/);
  });
  it('an IO with no policy port (every existing caller/test) is OFF', async () => {
    const h = harness();
    delete h.io.pushPolicy;
    await pass(h);
    expect(h.calls.push).toEqual([]);
  });
});

describe('the held claim blocks every dispatch on a red intermediate head', () => {
  const redPr = (over = {}) => ({
    number: 4115, title: 'x', headRefName: 'lane/item-68b', headRefOid: SHA, baseRefName: 'main', isDraft: false, state: 'OPEN',
    mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', body: 'b',
    labels: [{ name: 'review:changes' }, { name: 'review-status:fixing' }],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-10T14:20:00Z' }],
    fixClaim: { who: 'fix-4115', why: 'conveyor fix', claimedAt: '2026-10-10T14:00:00Z' },
    ...over,
  });
  it('reconcile planner: refuses fix-claimed, and the same PR unclaimed WOULD be dispatched (control)', () => {
    const plan = planReconcile({ repo: 'we', prs: [redPr()], agents: [], requiredChecks: ['test'], now: T0 + 900_000 });
    expect(plan.dispatch.filter((d) => d.prNumber === 4115)).toEqual([]);
    expect(plan.refusals.some((r) => r.prNumber === 4115 && /fix-claimed/.test(JSON.stringify(r)))).toBe(true);
    // a green intermediate head with review owed: review is planned unclaimed, refused claimed
    const owed = redPr({ labels: [{ name: 'review:pending' }], statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    const { fixClaim, ...unclaimed } = owed;
    expect(fixClaim).toBeTruthy();
    expect(planReconcile({ repo: 'we', prs: [unclaimed], agents: [], requiredChecks: ['test'], now: T0 + 900_000 }).dispatch.map((d) => d.kind)).toContain('review');
    expect(planReconcile({ repo: 'we', prs: [owed], agents: [], requiredChecks: ['test'], now: T0 + 900_000 }).dispatch).toEqual([]);
  });
  it('ci-heal spawn re-checks the live claim and holds', async () => {
    const r = await dispatchCiHeal({ itemNum: null, pr: 4115, laneRef: 'lane/item-68b', scope: [], lane: 5, repo: 'we' }, {
      actions: [], pollAttempts: () => [], readFixClaim: () => ({ meta: { who: 'fix-4115' } }),
      acquireClaim: () => { throw new Error('must not acquire'); },
    });
    expect(r).toMatchObject({ held: true, reason: 'fix-claimed', heldBy: 'fix-4115' });
  });
  it('drain: never lands a claimed PR, even accepted and green', () => {
    const green = redPr({ mergeStateStatus: 'CLEAN', labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
    expect(classifyPr(green)).toMatchObject({ decision: 'skip', reason: expect.stringMatching(/fix claim held by fix-4115/) });
    const { fixClaim, ...released } = green;
    expect(fixClaim).toBeTruthy();
    expect(classifyPr(released).decision).toBe('merge');
  });
  it('merge-site reread refuses an unreadable fix claim store', () => {
    const green = () => { const { fixClaim, ...p } = redPr({ mergeStateStatus: 'CLEAN', labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }); return { ...p, number: 4115 }; };
    const throwing = () => { throw new Error('EACCES: lock store unreadable'); };
    // unreadable store -> fail closed: the merge is refused, naming the placeholder holder
    const unreadable = attachLiveFixClaim(green(), { claimKey: 'we', readClaim: throwing });
    expect(unreadable.fixClaim).toMatchObject({ who: '(fix-claim store unreadable)' });
    expect(classifyPr(unreadable)).toMatchObject({ decision: 'skip', reason: expect.stringMatching(/fix claim held by \(fix-claim store unreadable\)/) });
    // controls: readable + claimed -> refused for the holder; readable + unclaimed -> merges
    const seen = [];
    const claimed = attachLiveFixClaim(green(), { claimKey: 'we', readClaim: (a) => { seen.push(a); return { meta: { who: 'fix-4115', claimedAt: 't' } }; } });
    expect(seen).toEqual([{ repo: 'we', pr: 4115 }]);
    expect(classifyPr(claimed)).toMatchObject({ decision: 'skip', reason: expect.stringMatching(/fix-4115/) });
    const unclaimed = attachLiveFixClaim(green(), { claimKey: 'we', readClaim: () => null });
    expect(unclaimed.fixClaim).toBeUndefined();
    expect(classifyPr(unclaimed).decision).toBe('merge');
    // no repo key (unknown slug): the reader is never called, nothing attached
    expect(attachLiveFixClaim(green(), { claimKey: null, readClaim: throwing }).fixClaim).toBeUndefined();
  });
});
