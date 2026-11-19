import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../scripts/lib/review-facts.mjs', async original => ({
  ...await original(), warmReviewFacts: async () => ({ skipped: 'test' }),
}));
import { runReviewTick } from '../review-daemon.mjs';
import { assertInventoryComplete, PrListUnreadableError } from '../../../scripts/lib/pr-list-paged.mjs';

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
  it('list read partial', () => {
    const error = inventoryError([{ number: 1 }], 10);
    expect(error.message).toContain('pages carried 1 unique of 10 open PRs');
    const { redTeamOnSkip } = failedListTick(error);
    expect(redTeamOnSkip).toHaveBeenCalledOnce();
    expect(redTeamOnSkip).toHaveBeenCalledWith(expect.objectContaining({
      repo, listPartial: true, rawPrs: [], plan: expect.objectContaining({ refusals: [] }),
    }));
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
