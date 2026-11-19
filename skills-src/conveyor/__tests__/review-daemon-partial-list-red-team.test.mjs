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

function failedListTick(error) {
  const redTeamOnSkip = vi.fn(() => ({ rows: [], dispatched: [], notStarted: [] }));
  const readPrs = vi.fn(() => { throw error; });
  const reconcile = vi.fn(() => ({ dispatch: [], refusals: [] }));
  const dispatch = vi.fn();
  const out = runReviewTick({ repo, readPrs, readAgents: () => [], reconcile, dispatch, redTeamOnSkip,
    holdReconcile: () => [], statusCandidates: () => [], tagRound: vi.fn(), tagStatus: vi.fn(),
    acquirableLanes: () => 2, hostAdmission: () => ({ admitted: true, maxPerTick: 2 }),
    liveReviewBudget: { left: 2 }, log: vi.fn(),
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
