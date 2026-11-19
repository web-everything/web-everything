import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../scripts/lib/review-facts.mjs', async original => ({
  ...await original(), warmReviewFacts: async () => ({ skipped: 'test' }),
}));
import { runReconcilePass } from '../../../scripts/conveyor/reconcile-pass.mjs';
import { runReviewTick } from '../review-daemon.mjs';
import { assertInventoryComplete, PrListUnreadableError } from '../../../scripts/lib/pr-list-paged.mjs';
import { createRedTeamDispatchQueue, runWithRedTeamQueue } from '../../../scripts/lib/red-team-dispatch-queue.mjs';
import { runRedTeamOnSkip } from '../../../scripts/lib/review-red-team-on-skip.mjs';

const repo = 'example/project';
function inventoryError(rows, totalCount) {
  try { assertInventoryComplete({ repo, rows, totalCount }); }
  catch (error) {
    expect(error).toBeInstanceOf(PrListUnreadableError);
    return error;
  }
  throw new Error('Fixture must produce an inventory failure');
}

function failedListTick(error, overrides = {}) {
  const redTeamOnSkip = vi.fn(() => ({ rows: [], dispatched: [], notStarted: [] }));
  const readPrs = vi.fn(() => { throw error; });
  const reconcile = vi.fn(() => ({ dispatch: [], refusals: [] }));
  const dispatch = vi.fn();
  const out = runReviewTick({ repo, readPrs, readAgents: () => [], reconcile, dispatch, redTeamOnSkip,
    holdReconcile: () => [], statusCandidates: () => [], tagRound: vi.fn(), tagStatus: vi.fn(),
    acquirableLanes: () => 2, hostAdmission: () => ({ admitted: true, maxPerTick: 2 }),
    liveReviewBudget: { left: 2 }, log: vi.fn(), ...overrides,
  });
  expect(readPrs).toHaveBeenCalledOnce();
  expect(reconcile).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(out.dispatched).toEqual([]);
  expect(out.reconcileError).toBeTruthy();
  return { out, redTeamOnSkip };
}

describe('partial PR inventory red-team recovery', () => {
  it('a known blocked draft passes through real reconcile and never reaches dispatch', () => {
    const f = recoveryTick(inventoryError([], 10), 'draft');
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(f.readAgents).toHaveBeenCalledOnce();
    expect(f.reconcile.mock.results[0].value.refusals).toContainEqual(expect.objectContaining({ kind: 'draft', prNumber: 1 }));
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.readEvidence).not.toHaveBeenCalled();
    expect(f.queue.entries()).toEqual([expect.objectContaining(f.before[0])]);
  });

  it('list read partial', () => {
    const error = inventoryError([{ number: 1 }], 10);
    expect(error.message).toContain('pages carried 1 unique of 10 open PRs');
    const { redTeamOnSkip, result, readEvidence, readReviews, queue, head } = recoveryTick(error);
    expect(redTeamOnSkip).toHaveBeenCalledOnce();
    expect(redTeamOnSkip).toHaveBeenCalledWith(expect.objectContaining({
      repo, listPartial: true, rawPrs: [], plan: expect.objectContaining({ refusals: [] }),
    }));
    expect(result.rows).toEqual([expect.objectContaining({ prNumber: 1, head,
      action: 'skip', why: 'red-team pass in flight' })]);
    expect(readEvidence).toHaveBeenCalledWith({ repo, pr: 1, head });
    expect(readReviews).toHaveBeenCalledWith({ repo, pr: 1 });
    expect(queue.entries()).toHaveLength(1);
  });

  it.each(['comments missing', 'labels missing', 'unreadable', 'throw', 'wrong number', 'head moved', 'closed'])(
    '%s defers the known entry without a planner probe or eviction', mode => {
      const { result, readEvidence, readReviews, queue, before } = recoveryTick(inventoryError([], 10), mode);
      expect(result.rows).toEqual([]);
      expect(readEvidence).not.toHaveBeenCalled();
      expect(readReviews).not.toHaveBeenCalled();
      expect(queue.entries()).toEqual(before);
    });

  it.each([
    ['page error', () => new PrListUnreadableError({ repo, stage: 'page', page: 2, cause: new Error('page failed') })],
    ['hydrate error', () => new PrListUnreadableError({ repo, stage: 'hydrate', number: 1, cause: new Error('hydrate failed') })],
    ['duplicate numbers', () => inventoryError([{ number: 1 }, { number: 1 }], 10)],
    ['ordinary read error', () => new Error('read failed')],
  ])('list read partial fails closed on %s', (_name, makeError) => {
    const { redTeamOnSkip } = failedListTick(makeError());
    expect(redTeamOnSkip).not.toHaveBeenCalled();
  });
});

function recoveryTick(error, mode) {
  const head = 'a'.repeat(40);
  const entry = { key: `${repo}#1`, repo, pr: 1, head, enqueuedAt: 1, attempts: 0, blocked: 'planner-skip' };
  let stored = JSON.stringify([entry]);
  const queue = createRedTeamDispatchQueue({ file: 'fixture-queue.json', readFile: () => stored,
    writeFile: (_path, data) => { stored = data; }, rename: () => {} });
  const before = queue.entries();
  const dispatch = vi.fn();
  const readAgents = vi.fn(() => []);
  const reconcile = vi.fn(options => runReconcilePass({ ...hermeticReconcile, ...options, repo: 'we' }));
  const readEvidence = vi.fn(() => mode === 'draft'
    ? { recorded: false, loopPayload: { verdict: { verdict: 'accept' },
      findings: { read: { netBasis: { rev: head } } } } }
    : { inFlight: true });
  const readReviews = vi.fn(() => []);
  let result;
  const redTeamOnSkip = vi.fn(options => {
    result = runWithRedTeamQueue({ ...options, queue, run: runRedTeamOnSkip,
      readPartialPr: ({ pr }) => {
        if (mode === 'throw') throw Error('offline');
        if (mode === 'unreadable') return null;
        return { number: mode === 'wrong number' ? 99 : pr,
          isDraft: mode === 'draft', mergeStateStatus: 'UNKNOWN',
          state: mode === 'closed' ? 'CLOSED' : 'OPEN',
          headRefOid: mode === 'head moved' ? 'b'.repeat(40) : head,
          labels: mode === 'labels missing' ? undefined : [{ name: mode === 'draft' ? 'review:pending' : 'review:accepted' }],
          comments: mode === 'comments missing' ? undefined : [] };
      },
      setting: { enabled: true, retryCooldownMin: 30 }, readEvidence, readReviews,
      readCarry: () => null, readWitness: null, readStatus: () => null, lastDispatch: new Map(),
      headNeverReviewed: () => false,
      syncLabels: vi.fn(), dispatch,
    });
    return result;
  });
  failedListTick(error, { redTeamOnSkip, reconcile, readAgents });
  return { redTeamOnSkip, result, readEvidence, readReviews, queue, before, head, dispatch, reconcile, readAgents };
}

describe('partial inventory recovery safety', () => {
  it('partial inventory recovery keeps host, recovery-lane and shared-budget bounds', () => {
    const budget = { left: 1 }, take = vi.fn();
    const { redTeamOnSkip } = failedListTick(inventoryError([], 10), {
      recoveryAcquirableLanes: () => ['recovery-lane'],
      hostAdmission: () => ({ admitted: true, maxPerTick: 2, take }), liveReviewBudget: budget,
    });
    const { capacity } = redTeamOnSkip.mock.calls[0][0];
    expect(capacity).toMatchObject({ lanes: 1, remainingStarts: 2, startsCeiling: 2 });
    expect(capacity.budget).toBe(budget);
    capacity.take();
    expect(take).toHaveBeenCalledWith(1);
  });

  it('partial inventory recovery stays skipped while paused', () => {
    expect(failedListTick(inventoryError([], 10), { paused: true }).redTeamOnSkip).not.toHaveBeenCalled();
  });

  it('partial inventory recovery fails closed on unreadable host admission', () => {
    const { redTeamOnSkip } = failedListTick(inventoryError([], 10), {
      hostAdmission: () => { throw new Error('host unknown'); },
    });
    expect(redTeamOnSkip.mock.calls[0][0].capacity).toMatchObject({ remainingStarts: 0, startsCeiling: 0 });
  });

  it('partial inventory recovery fails closed on unreadable recovery lanes', () => {
    const { redTeamOnSkip } = failedListTick(inventoryError([], 10), {
      recoveryAcquirableLanes: () => { throw new Error('lanes unknown'); },
    });
    expect(redTeamOnSkip.mock.calls[0][0].capacity.lanes).toBe(0);
  });

  it('a failed partial inventory recovery preserves the reconcile error return', () => {
    const log = vi.fn();
    failedListTick(inventoryError([], 10), { redTeamOnSkip: () => { throw new Error('recovery failed'); }, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('partial-inventory red-team recovery failed'));
  });
});

// Keep the actual IO shell and planner; replace external evidence readers only.
const identity = prs => prs;
const hermeticReconcile = {
  readOnly: true, env: {}, stepLog: () => {}, enrich: identity,
  readRequiredChecks: () => ({ checks: [] }), readChecks: () => [],
  excuseMergeGateHolds: identity, enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
  enrichAlreadyLanded: identity, enrichBaseRef: identity, enrichConflictDisposition: identity,
  enrichSystemFix: identity, enrichEscalationBase: identity, enrichFixClaims: identity,
  enrichTimeouts: identity, enrichReferralHolds: identity, enrichReferralAutoResolve: identity,
  enrichLedgerHolds: identity, enrichRulings: identity, enrichScopeBloat: identity,
  enrichCodeQL: identity, enrichStandingRulingGrants: identity, enrichOwedMainRule: () => {},
  enrichMechanicalRound: identity, resolveMainSha: () => null, readPriority: () => null,
};
