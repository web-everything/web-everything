/**
 * Live PR #5768 (2026-10-21): a fix agent stood down `<!-- stand-down reason=gate-red -->` at 18:01Z because one
 * out-of-diff test (`daemon-live-smoke.test.mjs` "runLiveSmokeWithRetry forwards changedFiles") stayed red, without
 * checking main. Every fix-dispatch pass then logged "own-failure, owed a ci-heal" and refused it `stood-down`
 * ("terminal on this head") for hours. A gate-red stand-down is a failed gate, not a question: ONE own-failure
 * ci-heal per head (`fix.standDown.gateRedRetries`, standard 1, 0 = off), whose brief checks main first.
 */
import { describe, expect, it } from 'vitest';
import { planReconcile, gateRedRetryState, unresolvedStandDowns } from '../reconcile-core.mjs';
import { buildStandDownComment, resolveGateRedRetries, buildGateRedRetryRecordComment, isGateRedRetryRecord } from '../stand-down.mjs';
import { buildCiHealEscalationComment } from '../ci-heal-escalation-mark.mjs';
import { buildFixBeginComment } from '../fix-procedure.mjs';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { withGateRedRetrySection, dispatchCiHeal } from '../../operations/ci-heal-pr-dispatch.mjs';
import { DISPATCH_EFFECT } from '../../operations/dispatch-lane.mjs';
import { classifyAwaitVerdict, buildAwaitVerifyResumePrompt } from '../await-verify-pass.mjs';

const BOT = { login: AUTOMATION_LOGINS[0] };
const HEAD = '3a062c359'.padEnd(40, '0');
const NOW = Date.parse('2026-10-21T22:00:00Z');
const REQUIRED = ['test', 'smoke'];
const run = (name, conclusion, completedAt) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, completedAt });
const DETAIL = "attempt 3 @ 3a062c359: only red is daemon-live-smoke.test.mjs 'runLiveSmokeWithRetry forwards changedFiles'";
// The #5768 comment exactly as posted: the legacy UNBOUND trailer (no head=), so it holds on this head.
const standDown = (at, reason = 'gate-red', detail = DETAIL) => ({ body: buildStandDownComment({ reason, detail }), author: BOT, createdAt: at });
const ciHealBegin = (at) => ({ body: buildFixBeginComment({ who: 'ci-heal-5768', why: 'conveyor ci-heal: red-ci', branch: 'lane/x', headSha: HEAD }), author: BOT, createdAt: at });

function pr5768(comments, extra = {}) {
  return {
    number: 5768, state: 'OPEN', isDraft: false, mergeStateStatus: 'BLOCKED', headRefOid: HEAD, headRefName: 'lane/verify-admission-heartbeat-timeout-memory',
    labels: [{ name: 'review:human' }],
    commits: [{ oid: HEAD, committedDate: '2026-10-21T17:40:00Z' }],
    statusCheckRollup: [run('test', 'FAILURE', '2026-10-21T18:20:00Z'), run('smoke', 'SUCCESS', '2026-10-21T18:10:00Z')],
    comments, ...extra,
  };
}
const plan = (pr, gateRedRetries) => planReconcile({ prs: [pr], agents: [], now: NOW, requiredChecks: REQUIRED,
  ...(gateRedRetries === undefined ? {} : { gateRedRetries }) });
const heals = (p) => p.dispatch.filter(d => d.prNumber === 5768 && d.kind === 'ci-heal');
const refusal = (p) => p.refusals.find(r => r.prNumber === 5768 && r.kind === 'stood-down');
const ON = { value: 1, source: 'standard' };

describe('gate-red stand-down earns ONE own-failure ci-heal per head (live PR #5768)', () => {
  it('#5768 shape: the gate-red stand-down no longer blocks the owed ci-heal; it carries the grant', () => {
    const p = plan(pr5768([standDown('2026-10-21T18:01:26Z')]), ON);
    expect(heals(p)).toHaveLength(1);
    expect(heals(p)[0].gateRedRetry).toMatchObject({ head: HEAD, standDownAt: '2026-10-21T18:01:26Z', allowance: 1, source: 'standard' });
    expect(heals(p)[0].gateRedRetry.detail).toContain('runLiveSmokeWithRetry forwards changedFiles');
    expect(refusal(p)).toBeUndefined();
  });

  it('before (pure default / kill switch 0): the same PR stays terminal stood-down, no ci-heal', () => {
    for (const setting of [undefined, { value: 0, source: 'env' }]) {
      const p = plan(pr5768([standDown('2026-10-21T18:01:26Z')]), setting);
      expect(heals(p)).toHaveLength(0);
      expect(refusal(p)?.why).toMatch(/gate-red retry is turned off/);
      expect(p.notes.some(n => n.kind === 'gate-red-retry-exhausted')).toBe(false);
    }
  });

  it('the retry is spent once a ci-heal claimed the PR after the stand-down: terminal + needs-you', () => {
    const p = plan(pr5768([standDown('2026-10-21T18:01:26Z'), ciHealBegin('2026-10-21T18:30:00Z')]), ON);
    expect(heals(p)).toHaveLength(0);
    expect(refusal(p)?.why).toMatch(/stayed red after the automatic gate-red retry/);
    expect(p.notes.find(n => n.kind === 'gate-red-retry-exhausted')).toMatchObject({ prNumber: 5768, parkToHuman: true, spent: 1 });
    expect(p.notes.find(n => n.kind === 'gate-red-retry-exhausted').text).toMatch(/needs you/);
  });

  it('a ci-heal claim from BEFORE the stand-down does not spend the retry', () => {
    const p = plan(pr5768([ciHealBegin('2026-10-21T00:19:42Z'), standDown('2026-10-21T18:01:26Z')]), ON);
    expect(heals(p)).toHaveLength(1);
  });

  it('a second gate-red stand-down on the same head stays terminal and raises needs-you', () => {
    const p = plan(pr5768([standDown('2026-10-21T18:01:26Z'), standDown('2026-10-21T19:10:00Z')]), ON);
    expect(heals(p)).toHaveLength(0);
    expect(p.notes.find(n => n.kind === 'gate-red-retry-exhausted')).toMatchObject({ gateRedStandDowns: 2 });
  });

  it('a real question (needs-judgment) stays terminal exactly as before — alone or beside a gate-red', () => {
    for (const comments of [[standDown('2026-10-21T18:01:26Z', 'needs-judgment', 'which API?')],
      [standDown('2026-10-21T17:00:00Z'), standDown('2026-10-21T18:01:26Z', 'needs-judgment', 'which API?')]]) {
      const p = plan(pr5768(comments), ON);
      expect(heals(p)).toHaveLength(0);
      expect(refusal(p)?.why).toMatch(/stopped here to ask a question/);
      expect(p.notes.some(n => n.kind === 'gate-red-retry-exhausted')).toBe(false);
    }
  });

  it('a forged (untrusted) gate-red stand-down never counts and never grants', () => {
    const forged = { ...standDown('2026-10-21T18:01:26Z'), author: { login: 'random-user' } };
    expect(unresolvedStandDowns([forged])).toHaveLength(0);
  });

  it('the grant buys only a ci-heal: a review-fix planned for the PR is refused as stood-down', () => {
    const finding = { body: '## changes requested\nfinding', author: BOT, createdAt: '2026-10-21T17:00:00Z' };
    const bounced = pr5768([finding, standDown('2026-10-21T18:01:26Z')], {
      labels: [{ name: 'review:changes' }],
      statusCheckRollup: [run('test', 'SUCCESS', '2026-10-21T18:20:00Z'), run('smoke', 'SUCCESS', '2026-10-21T18:10:00Z')],
    });
    const p = plan(bounced, ON);
    expect(p.dispatch.filter(d => d.prNumber === 5768)).toHaveLength(0);
    expect(refusal(p)).toMatchObject({ plannedKind: 'fix' });
    expect(refusal(p).why).toMatch(/grants only an own-failure ci-heal, not a `fix`/);
  });

  it('live #5768 labels (review:changes + red required check): the planned review fix becomes the ONE ci-heal', () => {
    const finding = { body: '## changes requested\nfinding', author: BOT, createdAt: '2026-10-21T17:00:00Z' };
    const live = pr5768([finding, standDown('2026-10-21T18:01:26Z')], {
      labels: [{ name: 'review:changes' }, { name: 'review:human' }, { name: 'status:ci-red' }],
    });
    const before = plan(live, { value: 0, source: 'env' });
    expect(before.dispatch.filter(d => d.prNumber === 5768)).toHaveLength(0);
    const after = plan(live, ON);
    expect(after.dispatch.filter(d => d.prNumber === 5768).map(d => d.kind)).toEqual(['ci-heal']);
    expect(heals(after)[0]).toMatchObject({ failingRequiredChecks: ['test'], gateRedRetry: { allowance: 1 } });
  });

  it('the grant goes through the ordinary ci-heal guards: a current-head needs-human escalation still refuses it', () => {
    const finding = { body: '## changes requested\nfinding', author: BOT, createdAt: '2026-10-21T17:00:00Z' };
    const esc = { body: buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'needs a person' }), author: BOT, createdAt: '2026-10-21T18:40:00Z' };
    for (const labels of [[{ name: 'review:changes' }], [{ name: 'ci:failed' }]]) {
      const p = plan(pr5768([finding, standDown('2026-10-21T18:01:26Z'), esc], { labels }), ON);
      expect(heals(p)).toHaveLength(0);
      expect(p.refusals.some(r => r.prNumber === 5768 && r.kind === 'ci-heal-escalated')).toBe(true);
    }
  });

  it('the dispatcher\'s retry record spends the retry even when the session died before its fix-begin (same second counts)', () => {
    const record = (at) => ({ body: buildGateRedRetryRecordComment({ head: HEAD }), author: BOT, createdAt: at });
    expect(isGateRedRetryRecord(record('x').body)).toBe(true);
    for (const at of ['2026-10-21T18:01:26Z', '2026-10-21T18:05:00Z']) {
      const p = plan(pr5768([standDown('2026-10-21T18:01:26Z'), record(at)]), ON);
      expect(heals(p)).toHaveLength(0);
      expect(p.notes.find(n => n.kind === 'gate-red-retry-exhausted')).toMatchObject({ spent: 1 });
    }
    const forged = { ...record('2026-10-21T18:05:00Z'), author: { login: 'random-user' } };
    expect(heals(plan(pr5768([standDown('2026-10-21T18:01:26Z'), forged]), ON))).toHaveLength(1);
  });

  it('a second gate-red stand-down is terminal whatever the allowance (2 or 3)', () => {
    for (const value of [2, 3]) {
      const p = plan(pr5768([standDown('2026-10-21T18:01:26Z'), standDown('2026-10-21T19:10:00Z')]), { value, source: 'tool' });
      expect(heals(p)).toHaveLength(0);
      expect(p.notes.some(n => n.kind === 'gate-red-retry-exhausted')).toBe(true);
    }
  });

  it('gateRedRetryState fails closed when the stand-down time is unreadable', () => {
    const c = { body: buildStandDownComment({ reason: 'gate-red' }), author: BOT };
    expect(gateRedRetryState([c], [c], { retries: 1 })).toMatchObject({ eligible: true, grant: false, exhausted: true });
  });
});

describe('dispatchCiHeal records the retry before launch (fail closed)', () => {
  const planned = { itemNum: null, pr: 5768, laneRef: 'lane/x', scope: ['we:scripts/a.mjs'], lane: 9, headRefOid: HEAD,
    gateRedRetry: { head: HEAD, standDownAt: '2026-10-21T18:01:26Z', detail: DETAIL, allowance: 1, source: 'standard' } };
  const TEMPLATE = 'heal pr={{PR_NUM}} ref={{LANE_REF}} lane={{LANE}} slug={{SESSION_SLUG}} why={{REASON}}';
  const opts = (extra) => ({ readBrief: () => TEMPLATE, acquireClaim: () => ({ ok: true }), releaseClaim: () => {}, readFixClaim: () => null,
    pollAttempts: () => [], routeHeal: () => null, ...extra });
  it('posts the record, then launches with the gate-red section in front of the brief', async () => {
    const posted = []; const calls = [];
    await dispatchCiHeal(planned, opts({ recordGateRedRetry: (a) => posted.push(a), sinks: { [DISPATCH_EFFECT]: async (p) => { calls.push(p); return { handle: 'h' }; } } }));
    expect(posted).toHaveLength(1);
    expect(isGateRedRetryRecord(posted[0].body)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt.startsWith('# Gate-red retry')).toBe(true);
    expect(calls[0].probationWorker).toBeNull();
  });
  it('a failed record post refuses the launch', async () => {
    const calls = [];
    const out = await dispatchCiHeal(planned, opts({ recordGateRedRetry: () => { throw new Error('gh 502'); }, sinks: { [DISPATCH_EFFECT]: async (p) => { calls.push(p); return { handle: 'h' }; } } }));
    expect(out).toMatchObject({ held: true });
    expect(out.reason).toMatch(/gate-red-retry-record-failed: gh 502/);
    expect(calls).toHaveLength(0);
  });
});

describe('fix.standDown.gateRedRetries cascade', () => {
  const read = (fix) => () => JSON.stringify({ fix });
  it('standard 1; fix.json, env and the 0 kill switch override it; invalid values never do', () => {
    expect(resolveGateRedRetries({ env: {}, read: read({}), platform: null })).toEqual({ value: 1, source: 'standard' });
    expect(resolveGateRedRetries({ env: {}, read: read({ standDown: { gateRedRetries: 0 } }), platform: null })).toEqual({ value: 0, source: 'tool' });
    expect(resolveGateRedRetries({ env: { WE_FIX_STAND_DOWN_GATE_RED_RETRIES: '0' }, read: read({}), platform: null })).toEqual({ value: 0, source: 'env' });
    expect(resolveGateRedRetries({ env: { WE_FIX_STAND_DOWN_GATE_RED_RETRIES: '99' }, read: read({}), platform: null })).toEqual({ value: 1, source: 'standard' });
    expect(resolveGateRedRetries({ env: {}, read: read({ standDown: { gateRedRetries: -1 } }), platform: null })).toEqual({ value: 1, source: 'standard' });
  });
});

describe('the gate-red retry brief checks main first', () => {
  const planned = { pr: 5768, gateRedRetry: { head: HEAD, standDownAt: '2026-10-21T18:01:26Z', detail: DETAIL, allowance: 1, source: 'standard' } };
  it('leads the ci-heal prompt with the main-first check, the pre-existing route and the second-gate-red record', () => {
    const out = withGateRedRetrySection('BRIEF', planned, { repo: 'web-everything/web-everything', weRoot: '/we' });
    expect(out.startsWith('# Gate-red retry')).toBe(true);
    expect(out.endsWith('BRIEF')).toBe(true);
    expect(out).toMatch(/check whether each failing test also fails on `main`/);
    expect(out).toMatch(/pre-existing-on-main/);
    expect(out).toContain('node "/we/scripts/conveyor/stand-down.mjs" 5768 --repo=web-everything/web-everything --reason=gate-red --head="$EXAMINED_HEAD"');
    expect(out).toContain('runLiveSmokeWithRetry forwards changedFiles');
  });
  it('leaves every other ci-heal prompt unchanged', () => {
    expect(withGateRedRetrySection('BRIEF', { pr: 1 })).toBe('BRIEF');
  });
});

describe('await-verify pushes a ci-heal red that is only pre-existing on main', () => {
  const sha = 'a'.repeat(40);
  const record = (kind) => ({ v: 1, pr: 5768, sha, lane: '/lanes/l1', ref: 'lane/x', kind, repo: 'web-everything/web-everything',
    requestedAt: '2026-10-21T20:00:00Z', attempt: 1, who: `${kind}-5768` });
  const marker = { sha, status: 'red', exitCode: 1, treeHash: 't1', finishedAt: '2026-10-21T20:05:00Z',
    redCause: 'pre-existing-on-main', redCauseEvidence: { baseSha: 'b'.repeat(40) },
    failureDetails: { truncated: false, tests: [{ file: 'scripts/lib/__tests__/daemon-live-smoke.test.mjs', name: 'runLiveSmokeWithRetry forwards changedFiles' }] } };
  const lane = { head: sha, dirty: false, treeHash: 't1' };
  const nowMs = Date.parse('2026-10-21T20:06:00Z');
  it('ci-heal: pre-existing red → push (not a repair), with a resume that says it is main\'s red', () => {
    expect(classifyAwaitVerdict({ record: record('ci-heal'), marker, lane, nowMs, ttlMs: 3_600_000 })).toEqual({ action: 'push', reason: 'red-preexisting-on-main' });
    const msg = buildAwaitVerifyResumePrompt({ kind: 'green', record: { ...record('ci-heal'), pendingResume: { kind: 'green', preExisting: true } } });
    expect(msg).toMatch(/ONLY on tests that also fail on origin\/main/);
  });
  it('ci-heal: an unproven tree re-requests; a fix record is unchanged (still a red resume)', () => {
    expect(classifyAwaitVerdict({ record: record('ci-heal'), marker, lane: { ...lane, treeHash: 't2' }, nowMs, ttlMs: 3_600_000 }).action).toBe('rerequest');
    expect(classifyAwaitVerdict({ record: record('fix'), marker, lane, nowMs, ttlMs: 3_600_000 })).toMatchObject({ action: 'resume', resume: 'red' });
  });
  it('an ordinary red ci-heal (not pre-existing) still resumes red', () => {
    const own = { ...marker, redCause: 'in-diff', redCauseEvidence: undefined };
    expect(classifyAwaitVerdict({ record: record('ci-heal'), marker: own, lane, nowMs, ttlMs: 3_600_000 })).toMatchObject({ action: 'resume', resume: 'red' });
  });
});
