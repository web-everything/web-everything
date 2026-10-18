// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { resolvePreventionBatchSettings, loadPreventionBatchSettings, formatPreventionBatchSettings } from '../card-batch-settings.mjs';
import { spawnPreventionLandingJob } from '../prevention-landing-job.mjs';
import { landPreventionCard } from '../../operations/land-prevention-card.mjs';
import { fileItemForPreventionViaLandingJob } from '../../operations/review-loop-cli.mjs';
import { runApprovalPreventionFiling } from '../../review-set-label.mjs';

const standard = { enabled: true, maxCards: 10, maxAgeMinutes: 120 };
const paused = () => resolvePreventionBatchSettings({ standard, repo: { filingEnabled: false } });
const input = { title: 'Guard', kind: 'story', size: '1', digest: 'guard', scope: 'we:scripts/', queue: 'true', session: 'unit' };
describe('independent prevention filing pause', () => {
  it('defaults on without changing the independent batch switch', () => {
    expect(resolvePreventionBatchSettings({ standard, repo: { batchFiling: false } }))
      .toMatchObject({ filingEnabled: true, batchFiling: false, sources: { filingEnabled: 'standard' } });
  });
  it('resolves every layer and logs provenance', () => {
    expect(paused()).toMatchObject({ filingEnabled: false, batchFiling: true, sources: { filingEnabled: 'repo' } });
    const platform = resolvePreventionBatchSettings({ standard, platform: { filingEnabled: false } });
    expect(platform.sources.filingEnabled).toBe('platform');
    const env = resolvePreventionBatchSettings({ standard, repo: { filingEnabled: false }, env: { WE_PREVENTION_FILING_ENABLED: 'true' } });
    expect(env).toMatchObject({ filingEnabled: true, sources: { filingEnabled: 'env' } });
    expect(resolvePreventionBatchSettings({ standard, repo: { filingEnabled: false }, env: { WE_PREVENTION_FILING_ENABLED: 'invalid' } }))
      .toMatchObject({ filingEnabled: false, invalid: ['env.filingEnabled'] });
    expect(formatPreventionBatchSettings(paused())).toContain('prevention.filingEnabled=false (repo)');
  });
  it('prototype declared settings pause the actual filer', () => {
    expect(loadPreventionBatchSettings({ env: {}, read: () => '{}' }))
      .toMatchObject({ filingEnabled: false, sources: { filingEnabled: 'repo' } });
  });
  it('paused spawn is a non-error no-op, without even resolving credentials', () => {
    const spawnDetached = vi.fn(); const resolveSettingsEnv = vi.fn(); const write = vi.fn();
    const result = spawnPreventionLandingJob(input, { spawnDetached, resolveSettingsEnv, loadFilingSettings: paused, write });
    expect(result).toMatchObject({ ok: true, skipped: true, reason: expect.stringMatching(/paused/) });
    expect(spawnDetached).not.toHaveBeenCalled(); expect(resolveSettingsEnv).not.toHaveBeenCalled();
    expect(write.mock.calls.flat().join('')).toContain('prevention.filingEnabled=false (repo)');
  });
  it('paused detached filer acquires no lane and writes no card/spool/files', async () => {
    const exec = vi.fn(); const writeFile = vi.fn(); const batch = vi.fn(); const write = vi.fn();
    expect(await landPreventionCard(input, { exec, writeFile, batch, write, loadFilingSettings: paused }))
      .toMatchObject({ ok: true, skipped: true, step: 'paused' });
    expect(exec).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
    expect(write.mock.calls.flat().join('')).toContain('prevention.filingEnabled=false (repo)');
  });
  it('review-loop adapter preserves skipped state and never claims the card queued', async () => {
    const result = await fileItemForPreventionViaLandingJob(input, { spawnJob: () => ({ ok: true, skipped: true, reason: 'filing paused' }) });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.lines[0])).toMatchObject({ skipped: true, reason: 'filing paused' });
    expect(JSON.parse(result.lines[0]).queued).not.toBe(true);
  });
  it('approval does not mark paused filing as filed', () => {
    const postComment = vi.fn();
    runApprovalPreventionFiling({ to: 'accepted', repo: 'o/r', pr: 42, headSha: 'a'.repeat(40),
      commentBody: '**Verdict:** ✅ pass — no blocking findings\n- `scripts/a.mjs:1` — an issue\n  - _Prevention (OWED — file it):_ add a guard',
      prComments: [], provider: { postComment }, findFiledApprovalPrevention: () => null,
      fileApprovalPrevention: () => ({ ok: true, skipped: true, reason: 'filing paused' }) });
    expect(postComment).not.toHaveBeenCalled();
  });
});
