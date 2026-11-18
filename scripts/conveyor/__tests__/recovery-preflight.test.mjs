import { describe, it, expect, vi } from 'vitest';
import { pushMissingRunCommit } from '../missing-run-push.mjs';

vi.mock('../../lib/gh-throttle.mjs', async original => ({
  ...await original(), execFileSyncThrottled: vi.fn(() => { throw new Error('unexpected live IO'); }),
}));

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const BRANCH = 'lane/5060';
const done = (conclusion = 'STARTUP_FAILURE') => ({
  __typename: 'CheckRun', name: 'merge-gate', status: 'COMPLETED', conclusion,
});
const workflowRun = (conclusion = 'startup_failure') => ({
  id: 5060, name: 'Merge gate', path: '.github/workflows/merge-gate.yml', event: 'pull_request_target',
  head_sha: HEAD, status: 'completed', conclusion, created_at: '2026-11-08T00:00:00Z',
});
function goodInput() {
  return {
    repo: REPO, head: HEAD, headRefName: BRANCH, defaultBranch: 'main',
    pr: { state: 'OPEN', baseRefName: 'main', isCrossRepository: false,
      mergeable: 'MERGEABLE', headRefOid: HEAD, headRefName: BRANCH },
    recoveryEvidence: { requiredContexts: ['merge-gate'], rollup: [done()], workflowRuns: [workflowRun()] },
    claimed: false, token: 'ghp_acceptance_fixture', env: {},
    attemptsForSha: 0, attemptsForPr: 0, maxRetriesPerSha: 1, maxRetriesPerPr: 2,
  };
}

// Delayed import keeps the real push-boundary regressions runnable while the new module is absent.
async function preflight(input) {
  const modulePath = '../recovery-preflight.mjs';
  const { recoveryPreflight } = await import(/* @vite-ignore */ modulePath);
  return recoveryPreflight(input);
}
async function refuses(input) {
  const result = await preflight(input);
  expect(result).toMatchObject({ allow: false, reason: expect.any(String) });
  expect(result.reason.trim()).not.toBe('');
  return result;
}

describe('pure recoveryPreflight admission for the existing empty-commit push', () => {
  it('allows startup_failure-only merge-gate recovery with complete good inputs', async () => {
    const input = goodInput();
    const before = structuredClone(input);
    expect(await preflight(input)).toMatchObject({ allow: true, reason: expect.any(String) });
    expect(input).toEqual(before);
  });

  it('allows workflow startup_failure evidence without a rollup row', async () => {
    const input = goodInput();
    input.recoveryEvidence.rollup = [];
    expect(await preflight(input)).toMatchObject({ allow: true });
  });

  it('live fix claim blocks the push', async () => { await refuses({ ...goodInput(), claimed: true }); });
  it.each([undefined, null, 'unreadable'])('unreadable claim state blocks the push (%s)', async claimed => {
    await refuses({ ...goodInput(), claimed });
  });
  it.each([undefined, null, {}, { rollup: [], workflowRuns: [] },
    { requiredContexts: ['merge-gate'], rollup: [], workflowRuns: null },
    { requiredContexts: ['merge-gate'], rollup: [null], workflowRuns: [] },
    { requiredContexts: ['merge-gate'], rollup: [], workflowRuns: [{}] },
  ])('missing evidence refuses (%j)', async recoveryEvidence => {
    await refuses({ ...goodInput(), recoveryEvidence });
  });

  it.each(['FAILURE', 'CANCELLED', 'TIMED_OUT'])('real failure present refuses (%s)', async conclusion => {
    const input = goodInput();
    input.recoveryEvidence.rollup.push(done(conclusion));
    await refuses(input);
    input.recoveryEvidence.rollup = [];
    input.recoveryEvidence.workflowRuns.push({ ...workflowRun(conclusion.toLowerCase()), id: 5061 });
    await refuses(input);
  });

  it.each(['QUEUED', 'IN_PROGRESS', 'PENDING'])('pending evidence refuses (%s)', async status => {
    const input = goodInput();
    input.recoveryEvidence.rollup.push({ ...done(null), status });
    await refuses(input);
    input.recoveryEvidence.rollup = [];
    input.recoveryEvidence.workflowRuns.push({ ...workflowRun(null), id: 5061, status: status.toLowerCase() });
    await refuses(input);
  });

  it('non-lane branch refuses', async () => {
    const input = goodInput();
    await refuses({ ...input, headRefName: 'fix/5060', pr: { ...input.pr, headRefName: 'fix/5060' } });
  });
  it('Actions token refuses', async () => {
    await refuses({ ...goodInput(), token: 'ghs_actions', env: { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'ghs_actions' } });
  });
  it('moved head refuses', async () => {
    const input = goodInput();
    await refuses({ ...input, pr: { ...input.pr, headRefOid: NEXT } });
  });
  it.each([{ state: 'CLOSED' }, { state: 'MERGED' }, { baseRefName: 'lane/parent' },
    { isCrossRepository: true }, { isCrossRepository: undefined }, { mergeable: 'CONFLICTING' },
    { mergeable: 'UNKNOWN' }, { headRefOid: undefined },
  ])('ineligible or unreadable live PR refuses (%j)', async patch => {
    const input = goodInput();
    await refuses({ ...input, pr: { ...input.pr, ...patch } });
  });
  it.each([{ attemptsForSha: 1 }, { attemptsForPr: 2 }, { attemptsForSha: undefined },
    { attemptsForPr: -1 }, { maxRetriesPerSha: NaN }, { attemptsForPr: Number.MAX_SAFE_INTEGER + 1 },
  ])('spent or unreadable cap refuses with human/ci-heal fallback (%j)', async patch => {
    const result = await refuses({ ...goodInput(), ...patch });
    expect(result.reason).toMatch(/human|operator|ci-heal/i);
  });
});

// Execute the actual writer with intercepted IO: a pure helper alone cannot guard a push.
function pushFixture(patch = {}) {
  const input = { ...goodInput(), ...patch };
  const checkClaim = patch.checkClaim ?? vi.fn(() => null);
  const pushes = vi.fn();
  const exec = vi.fn((command, args) => {
    if (command === 'gh') {
      if (args.join(' ') !== `api repos/${REPO}/pulls/5060`) throw new Error('unexpected GitHub call');
      return JSON.stringify({ state: 'open', mergeable: true, base: { ref: 'main' },
        head: { sha: HEAD, ref: BRANCH, repo: { full_name: REPO } } });
    }
    if (command !== 'git') throw new Error('unexpected command');
    if (args.includes('FETCH_HEAD')) return HEAD;
    if (args.includes('show')) return 'original commit';
    if (args.includes(`${HEAD}^{tree}`)) return 'c'.repeat(40);
    if (args.includes('commit-tree')) return NEXT;
    if (args.includes('push')) pushes(args);
    return '';
  });
  const result = pushMissingRunCommit({ prNumber: 5060, headSha: HEAD, headRefName: BRANCH }, {
    ...input, exec, checkClaim, env: { GH_TOKEN: input.token, ...input.env }, readCache: () => null,
  });
  return { result, pushes, checkClaim };
}

describe('pushMissingRunCommit enforces preflight at the writer boundary', () => {
  it('pushes once with good startup_failure evidence', () => {
    const { result, pushes } = pushFixture();
    expect(result).toMatchObject({ ok: true, action: 'pull-request-push' });
    expect(pushes).toHaveBeenCalledTimes(1);
  });
  it('live fix claim blocks the push using the live repo/branch read', () => {
    const checkClaim = vi.fn(() => ({ refused: true, message: 'fixer holds claim' }));
    const { result, pushes } = pushFixture({ checkClaim });
    expect(checkClaim).toHaveBeenCalledWith({ repo: REPO, branch: BRANCH });
    expect(result.ok).toBe(false);
    expect(pushes).not.toHaveBeenCalled();
  });
  it('unreadable claim state blocks the push', () => {
    const { result, pushes } = pushFixture({ checkClaim: () => { throw new Error('claim read unavailable'); } });
    expect(result.ok).toBe(false);
    expect(pushes).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, { requiredContexts: ['merge-gate'], rollup: [], workflowRuns: 'unreadable' }])(
    'missing evidence refuses before a push (%j)', recoveryEvidence => {
      const { result, pushes } = pushFixture({ recoveryEvidence });
      expect(pushes).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
    });
  it('real failure present refuses at the writer boundary', () => {
    const recoveryEvidence = goodInput().recoveryEvidence;
    recoveryEvidence.rollup.push(done('FAILURE'));
    const { result, pushes } = pushFixture({ recoveryEvidence });
    expect(pushes).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
  it('spent per-head cap refuses at the writer boundary', () => {
    const { result, pushes } = pushFixture({ attemptsForSha: 1 });
    expect(pushes).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});
