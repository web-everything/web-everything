import { describe, expect, it, vi } from 'vitest';
import { resolveCandidateRunSmoke, CANDIDATE_SMOKE_REL } from '../daemon-rebuild/candidate-smoke.mjs';
import { runLiveSmokeWithRetry } from '../daemon-live-smoke.mjs';

const candidatePath = '/cand/tree';
const log = () => ({ error: vi.fn() });

describe('rebuild smoke runner comes from the candidate tree', () => {
  it('uses the candidate runner, not the installed one, for the default runner', async () => {
    const candidateRunner = vi.fn();
    const load = vi.fn(async () => ({ runLiveSmokeWithRetry: candidateRunner }));
    const got = await resolveCandidateRunSmoke({ candidatePath, runSmoke: runLiveSmokeWithRetry,
      installedRunSmoke: runLiveSmokeWithRetry, log: log(), exists: () => true, load });
    expect(got).toBe(candidateRunner);
    expect(got).not.toBe(runLiveSmokeWithRetry);
    expect(load).toHaveBeenCalledWith(expect.stringContaining(`${candidatePath}/${CANDIDATE_SMOKE_REL}`));
  });
  it('keeps an injected runner untouched', async () => {
    const injected = vi.fn();
    const load = vi.fn();
    const got = await resolveCandidateRunSmoke({ candidatePath, runSmoke: injected,
      installedRunSmoke: runLiveSmokeWithRetry, log: log(), exists: () => true, load });
    expect(got).toBe(injected);
    expect(load).not.toHaveBeenCalled();
  });
  it('falls back to the installed runner when the candidate has no module or it fails to load', async () => {
    const l = log();
    expect(await resolveCandidateRunSmoke({ candidatePath, runSmoke: runLiveSmokeWithRetry,
      installedRunSmoke: runLiveSmokeWithRetry, log: l, exists: () => false })).toBe(runLiveSmokeWithRetry);
    expect(await resolveCandidateRunSmoke({ candidatePath, runSmoke: runLiveSmokeWithRetry,
      installedRunSmoke: runLiveSmokeWithRetry, log: l, exists: () => true, load: async () => { throw new Error('boom'); } }))
      .toBe(runLiveSmokeWithRetry);
    expect(await resolveCandidateRunSmoke({ candidatePath, runSmoke: runLiveSmokeWithRetry,
      installedRunSmoke: runLiveSmokeWithRetry, log: l, exists: () => true, load: async () => ({}) })).toBe(runLiveSmokeWithRetry);
    expect(l.error).toHaveBeenCalledTimes(2);
  });
});
