// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Node's ESM namespace is immutable; spy on the mutable built-in default export.
import childProcess from 'node:child_process';
import { planReconcile } from '../reconcile-core.mjs';
import { ACTION_PRIORITY, DECIDE_VERSION, decide } from '../decide.mjs';

// Keep real-planner fixtures, but control its output for arbitration and error cases.
vi.mock('../reconcile-core.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, planReconcile: vi.fn(actual.planReconcile) };
});

const NOW = Date.parse('2026-11-15T12:00:00Z');
const HEAD = 'a'.repeat(40);
const REPO = 'owner/web-everything';
const NUMBER = 5454;
const snapshot = (extra = {}) => ({
  number: NUMBER, state: 'OPEN', isDraft: false, headRefName: 'lane/5454', headRefOid: HEAD,
  labels: [{ name: 'review:pending' }, { name: 'checking' }], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
  comments: [], ...extra,
});
const input = (extra = {}) => ({
  pr: snapshot(), now: NOW, repoSlug: REPO,
  projection: { head: HEAD, seq: 42, observedAt: NOW },
  plannerOptions: { requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' } },
  ...extra,
});
const dispatch = kind => ({ kind, prNumber: NUMBER, headRefOid: HEAD });
const output = (kinds = [], refusals = []) => ({ dispatch: kinds.map(dispatch), refusals, notes: [] });

/** Assert the operator-visible reason and scheduled retry, without inventing unspecified codes. */
function expectClosed(result, reason, retry = NOW + 60_000) {
  expect(result.action).toBeNull();
  expect(result.recheckAt).toBe(retry);
  expect(result.reasons.length).toBeGreaterThan(0);
  expect(result.reasons.every(code => typeof code === 'string' && code.length > 0 && code.length <= 200)).toBe(true);
  if (reason) expect(result.reasons).toContain(reason);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('decide: one pure decision for all roles (A1)', () => {
  it('publishes the version and repair-before-review priority', () => {
    expect(DECIDE_VERSION).toBe('decide/1');
    expect(ACTION_PRIORITY).toEqual(['ci-heal', 'fix', 'review']);
  });

  it('a PR owing review and fix gets exactly one fix, with both considered', () => {
    const pr = snapshot({ mergeStateStatus: 'DIRTY', labels: [{ name: 'review:pending' }] });
    planReconcile.mockReturnValueOnce(output(['review', 'fix']));
    const result = decide(input({ pr }));
    expect(planReconcile).toHaveBeenCalledTimes(1);
    expect(planReconcile).toHaveBeenCalledWith(expect.objectContaining({ prs: [pr], repo: 'we', agents: [], now: NOW }));
    expect(result.action).toEqual({ kind: 'fix', key: `${REPO}#${NUMBER}@${HEAD}:fix` });
    expect(result.considered).toHaveLength(2);
    expect(result.considered).toEqual(expect.arrayContaining(['fix', 'review']));
  });

  it('uses the unchanged real planner for a PR owing only review', () => {
    const result = decide(input());
    expect(result.action).toEqual({ kind: 'review', key: `${REPO}#${NUMBER}@${HEAD}:review` });
    expect(result.considered).toContain('review');
    expect(result.considered).not.toContain('fix');
    expect(result).toMatchObject({ version: DECIDE_VERSION, repo: REPO, number: NUMBER, head: HEAD, seq: 42 });
  });

  it('uses the unchanged real planner for a conflict owing only fix', () => {
    // The real planner refuses a fixer when there is no recorded finding.
    const pr = snapshot({ mergeStateStatus: 'DIRTY', labels: [{ name: 'review:changes' }, { name: 'merge-status:conflicting' }],
      comments: [{ body: 'Resolve the conflicting export.', author: { login: 'web-everything' } }] });
    const result = decide(input({ pr }));
    expect(result.action?.kind).toBe('fix');
    expect(result.considered).not.toContain('review');
  });

  it('ci-heal beats fix and review regardless of planner order', () => {
    planReconcile.mockReturnValueOnce(output(['review', 'fix', 'ci-heal']));
    const result = decide(input());
    expect(result.action?.kind).toBe('ci-heal');
    expect(result.considered).toEqual(expect.arrayContaining(['review', 'fix', 'ci-heal']));
    expect(planReconcile).toHaveBeenCalledTimes(1);
  });

  it('passes explicit agents, planner repo, and planner options through once', () => {
    const agents = [{ sessionId: 'review-5454' }];
    planReconcile.mockReturnValueOnce(output());
    decide(input({ agents, plannerRepo: 'fui', plannerOptions: { requiredChecks: ['custom'] } }));
    expect(planReconcile).toHaveBeenCalledTimes(1);
    expect(planReconcile).toHaveBeenCalledWith(expect.objectContaining({ repo: 'fui', agents, requiredChecks: ['custom'] }));
  });

  it('makes no fetch, gh, or child-process call while running the real planner', () => {
    const forbidden = vi.fn(() => { throw new Error('unexpected decision IO'); });
    vi.stubGlobal('fetch', forbidden);
    for (const name of ['execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'spawnSync']) {
      vi.spyOn(childProcess, name).mockImplementation(forbidden);
    }
    expect(decide(input()).action?.kind).toBe('review');
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('keys actions by repo, PR and head; a pushed head invalidates the old key (edge 6)', () => {
    planReconcile.mockReturnValueOnce(output(['review'])).mockReturnValueOnce(output(['review']));
    const first = decide(input());
    const head = 'b'.repeat(40);
    const second = decide(input({ pr: snapshot({ headRefOid: head }), projection: { head, seq: 43, observedAt: NOW } }));
    expect(first.action.key).toBe(`${REPO}#${NUMBER}@${HEAD}:review`);
    expect(second.action.key).toBe(`${REPO}#${NUMBER}@${head}:review`);
    expect(second.action.key).not.toBe(first.action.key);
  });
});

describe('decide fails closed with a reason and retry', () => {
  it.each([{ state: 'CLOSED' }, { state: 'MERGED' }, { draft: true }])(
    'projected ineligibility %j overrides a cached open snapshot', fields => {
      expectClosed(decide(input({ projection: { head: HEAD, observedAt: NOW, ...fields } })));
      expect(planReconcile).not.toHaveBeenCalled();
    });
  it('caller shadow dependencies cannot enable planner journal IO', () => {
    const appendLine = vi.fn();
    const readLocals = vi.fn();
    decide(input({ plannerOptions: { shadowDeps: { mode: 'on', appendLine, readLocals } } }));
    const options = planReconcile.mock.calls[0][0].shadowDeps;
    expect(options.mode).toBe('off');
    options.appendLine('unwanted');
    options.readLocals();
    expect(appendLine).not.toHaveBeenCalled();
    expect(readLocals).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'unreadable', 1, []])('missing or non-object PR %j refuses action', pr => {
    expectClosed(decide(input({ pr })));
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('a truncated snapshot refuses action', () => {
    expectClosed(decide(input({ pr: snapshot({ truncated: true }) })));
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('a snapshot without headRefOid refuses action', () => {
    expectClosed(decide(input({ pr: snapshot({ headRefOid: undefined }) })));
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('a missing projection refuses action', () => {
    expectClosed(decide(input({ projection: undefined })));
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('a mismatched projection head refuses action', () => {
    expectClosed(decide(input({ projection: { head: 'old', seq: 42, observedAt: NOW } })), 'head-mismatch');
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('a projection older than the default bound refuses action and schedules a retry', () => {
    expectClosed(decide(input({ projection: { head: HEAD, seq: 42, observedAt: NOW - 300_001 } })), 'projection-stale');
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('the exact staleness boundary remains admissible', () => {
    planReconcile.mockReturnValueOnce(output(['review']));
    expect(decide(input({ projection: { head: HEAD, seq: 42, observedAt: NOW - 300_000 } })).action?.kind).toBe('review');
  });
  it('custom staleness and retry bounds have an explicit scheduled fallback', () => {
    expectClosed(decide(input({ maxStaleMs: 10, recheckMs: 250, projection: { head: HEAD, seq: 42, observedAt: NOW - 11 } })),
      'projection-stale', NOW + 250);
  });
  it('planner-error is contained without exposing exception text or throwing', () => {
    planReconcile.mockImplementationOnce(() => { throw new Error('PRIVATE_UNTRUSTED_EXCEPTION'); });
    const result = decide(input());
    expectClosed(result, 'planner-error');
    expect(JSON.stringify(result.reasons)).not.toContain('PRIVATE_UNTRUSTED_EXCEPTION');
  });
});

describe('decide time rules and bounded explanations (A4, edge 1)', () => {
  it('returns the fix-join-wait deadline as recheckAt', () => {
    planReconcile.mockReturnValueOnce(output([], [{ prNumber: NUMBER, kind: 'fix-join-wait', deadline: NOW + 30_000 }]));
    const result = decide(input());
    expect(result.action).toBeNull();
    expect(result.recheckAt).toBe(NOW + 30_000);
    expect(result.reasons).toContain('fix-join-wait');
  });
  it('takes the earliest numeric or ISO refusal time for this PR and ignores invalid and foreign times', () => {
    planReconcile.mockReturnValueOnce(output([], [
      { prNumber: NUMBER, kind: 'fix-join-wait', deadline: NOW + 40_000 },
      { prNumber: NUMBER, kind: 'cool-off', retryAt: new Date(NOW + 20_000).toISOString() },
      { prNumber: NUMBER, kind: 'lease', until: NOW + 30_000, recheckAt: new Date(NOW + 10_000).toISOString() },
      { prNumber: NUMBER, kind: 'invalid', deadline: Infinity, retryAt: 'not-a-time', until: NaN },
      { prNumber: NUMBER + 1, kind: 'other-pr', deadline: NOW + 1 },
    ]));
    expect(decide(input()).recheckAt).toBe(NOW + 10_000);
  });
  it('has no recheck timer when no refusal contains a finite time', () => {
    planReconcile.mockReturnValueOnce(output([], [{ prNumber: NUMBER, kind: 'nothing-owed', why: 'idle' }]));
    const result = decide(input());
    expect(result.action).toBeNull();
    expect(result.recheckAt).toBeNull();
    expect(result.reasons).toEqual(expect.arrayContaining(['nothing-owed', 'idle']));
  });
  it('title, body and ordinary comment instructions never enter reasons', () => {
    const text = 'UNTRUSTED_PAYLOAD_$(touch should-never-run)\u001b[31m';
    const result = decide(input({ pr: snapshot({ title: text, body: text, comments: [{ body: text, author: { login: 'outsider' } }] }) }));
    expect(JSON.stringify(result.reasons)).not.toContain('UNTRUSTED_PAYLOAD');
    expect(result.action?.kind).toBe('review');
  });
  it('oversized refusal codes are bounded to 200 characters and retain the retry fallback', () => {
    planReconcile.mockReturnValueOnce(output([], [{ prNumber: NUMBER, kind: 'fix-join-wait', why: 'x'.repeat(20_000), deadline: NOW + 100 }]));
    const result = decide(input());
    expect(result.action).toBeNull();
    expect(result.recheckAt).toBe(NOW + 100);
    expect(result.reasons).toContain('fix-join-wait');
    expect(result.reasons.every(code => typeof code === 'string' && code.length <= 200)).toBe(true);
    expect(JSON.stringify(result.reasons)).not.toContain('x'.repeat(201));
  });
});

 it('incomplete agent evidence refuses before planning and schedules a retry', () => {
  const result = decide(input({ agentsIncomplete: true }));
  expect(result).toEqual({ version: DECIDE_VERSION, repo: REPO, number: NUMBER, head: HEAD, seq: 42,
    action: null, considered: [], reasons: ['agents-incomplete'], recheckAt: NOW + 60000, incomplete: true });
  expect(planReconcile).not.toHaveBeenCalled();
});
