// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { resolvePreventionBatchSettings, loadPreventionBatchSettings, formatPreventionBatchSettings } from '../card-batch-settings.mjs';
import { spawnPreventionLandingJob } from '../prevention-landing-job.mjs';
import { landPreventionCard, parseLandPreventionCardArgv } from '../../operations/land-prevention-card.mjs';
import { fileItemForPreventionViaLandingJob } from '../../operations/review-loop-cli.mjs';
import { runApprovalPreventionFiling } from '../../review-set-label.mjs';

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reconcileCardBatches } from '../../operations/card-batch-reconcile.mjs';
let stateDir;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'owed-prevention-')); vi.stubEnv('WE_CARD_BATCH_STATE_DIR', stateDir); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(stateDir, { recursive: true, force: true }); });

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
  it('paused spawn reports an unmet obligation, without even resolving credentials', () => {
    const spawnDetached = vi.fn(); const resolveSettingsEnv = vi.fn(); const write = vi.fn();
    const result = spawnPreventionLandingJob(input, { spawnDetached, resolveSettingsEnv, loadFilingSettings: paused, write });
    expect(result).toMatchObject({ ok: false, skipped: true, reason: expect.stringMatching(/paused/) });
    expect(spawnDetached).not.toHaveBeenCalled(); expect(resolveSettingsEnv).not.toHaveBeenCalled();
    expect(write.mock.calls.flat().join('')).toContain('prevention.filingEnabled=false (repo)');
  });
  it('paused detached filer acquires no lane and writes no card/spool/files', async () => {
    const exec = vi.fn(); const writeFile = vi.fn(); const batch = vi.fn(); const write = vi.fn();
    expect(await landPreventionCard(input, { exec, writeFile, batch, write, loadFilingSettings: paused }))
      .toMatchObject({ ok: false, skipped: true, step: 'paused' });
    expect(exec).not.toHaveBeenCalled(); expect(writeFile).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
    expect(write.mock.calls.flat().join('')).toContain('prevention.filingEnabled=false (repo)');
  });
  it('review-loop adapter reports recorded owed state without claiming the card queued', async () => {
    const result = await fileItemForPreventionViaLandingJob(input, { spawnJob: () => ({ ok: false, skipped: true, step: 'paused', reason: 'filing paused' }) });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.lines[0])).toMatchObject({ skipped: true, owed: true, reason: 'filing paused' });
    expect(JSON.parse(result.lines[0]).queued).not.toBe(true);
  });
  it.each([
    { ok: false, step: 'paused', error: 'could not record owed filing' },
    { ok: false, skipped: true, reason: 'unrelated skip' },
  ])('review-loop preserves real filing failures: %j', async filed => {
    const result = await fileItemForPreventionViaLandingJob(input, { spawnJob: () => filed });
    expect(result.code).toBe(1);
    expect(result.lines.join('')).not.toContain('"owed":true');
  });
  it('approval records paused filing as owed and deduplicates the next approval', () => {
    const prComments = [];
    const postComment = vi.fn((repo, pr, body) => prComments.push({ body, author: { login: 'web-everything' } }));
    const fileApprovalPrevention = vi.fn(() => ({ ok: false, skipped: true, step: 'paused', reason: 'filing paused' }));
    const approve = () => runApprovalPreventionFiling({ to: 'accepted', repo: 'o/r', pr: 42, headSha: 'a'.repeat(40),
      commentBody: '**Verdict:** ✅ pass — no blocking findings\n- `scripts/a.mjs:1` — an issue\n  - _Prevention (OWED — file it):_ add a guard',
      prComments, provider: { postComment }, findFiledApprovalPrevention: () => null, fileApprovalPrevention });
    approve();
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(prComments[0].body).toContain('recorded, owed; filing paused');
    expect(prComments[0].body).not.toContain('Filed the');
    approve();
    expect(fileApprovalPrevention).toHaveBeenCalledTimes(1);
  });
});

it('records one durable obligation across pauses, retries failure, and completes once on a later tick', async () => {
  const options = { loadFilingSettings: paused, write: () => {} };
  expect(spawnPreventionLandingJob(input, options).ok).toBe(false);
  const dir = join(stateDir, 'owed-prevention');
  const names = readdirSync(dir);
  expect(names).toHaveLength(1);
  const path = join(dir, names[0]); const original = readFileSync(path, 'utf8');
  expect(await landPreventionCard({ ...input, session: 'another' }, options)).toMatchObject({ ok: false, step: 'paused' });
  expect(readFileSync(path, 'utf8')).toBe(original);
  const fileOwed = vi.fn(async () => ({ ok: false, reason: 'unavailable' }));
  await reconcileCardBatches({ stateDir, fileOwed, loadFilingSettings: paused, seal: async () => [] });
  expect(fileOwed).not.toHaveBeenCalled();
  const tick = { stateDir, fileOwed, loadFilingSettings: () => ({ filingEnabled: true }), seal: async () => [] };
  await reconcileCardBatches(tick);
  expect(JSON.parse(readFileSync(path)).status).toBe('owed');
  fileOwed.mockResolvedValue({ ok: true, step: 'batched', rel: 'backlog/guard.md' });
  await reconcileCardBatches(tick);
  expect(JSON.parse(readFileSync(path)).status).toBe('done');
  await reconcileCardBatches(tick);
  expect(fileOwed).toHaveBeenCalledTimes(2);
});

it('a subsequent landing call resumes the obligation once and failures retain it', async () => {
  spawnPreventionLandingJob(input, { loadFilingSettings: paused, write: () => {} });
  const path = join(stateDir, 'owed-prevention', readdirSync(join(stateDir, 'owed-prevention'))[0]);
  const exec = vi.fn(() => { throw Error('no lane'); });
  const options = { exec, loadFilingSettings: () => ({ filingEnabled: true }), write: () => {}, dedupe: () => null,
    batch: async () => ({ batched: false, disabled: true }),
    loadPreventionBatchSettings: () => ({ batchFiling: false }),
    mkTmp: () => stateDir, rmTmp: () => {}, writeFile: () => {} };
  expect((await landPreventionCard(input, options)).ok).toBe(false);
  expect(JSON.parse(readFileSync(path)).status).toBe('owed');
  exec.mockReset();
  exec.mockReturnValueOnce(JSON.stringify({ lane: 7, path: stateDir }))
    .mockReturnValueOnce(JSON.stringify({ verdict: { num: 9, rel: 'backlog/9-guard.md' } }))
    .mockReturnValueOnce('').mockReturnValueOnce('')
    .mockReturnValueOnce(JSON.stringify({ verdict: { ok: true, blocking: [] } }))
    .mockReturnValueOnce(JSON.stringify({ findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 99 } }] } } }))
    .mockReturnValue('');
  const result = await landPreventionCard(input, options);
  expect(result).toMatchObject({ ok: true, pr: 99 });
  expect(JSON.parse(readFileSync(path)).status).toBe('done');
  exec.mockClear();
  expect(await landPreventionCard({ ...input, session: 'retry' }, options)).toEqual(result);
  expect(exec).not.toHaveBeenCalled();
});

it('carries the original owed identity across CLI text bounding and keeps source PRs distinct', async () => {
  const filing = { ...input, digest: 'long guard '.repeat(3000), retractTo: { repo: 'o/r', pr: 42, headSha: 'a'.repeat(40) } };
  const pause = { loadFilingSettings: paused, write: () => {} };
  spawnPreventionLandingJob(filing, pause);
  spawnPreventionLandingJob({ ...filing, retractTo: { ...filing.retractTo, pr: 43 } }, pause);
  expect(readdirSync(join(stateDir, 'owed-prevention'))).toHaveLength(2);
  let argv;
  spawnPreventionLandingJob(filing, { loadFilingSettings: () => ({ filingEnabled: true }), write: () => {},
    resolveSettingsEnv: () => null, spawnDetached: args => { argv = args; return { pid: 123 }; } });
  const parsed = parseLandPreventionCardArgv(argv.slice(1));
  expect(parsed.digest.length).toBeLessThan(filing.digest.length);
  expect(parsed.owedKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(readFileSync(join(stateDir, 'owed-prevention', `${parsed.owedKey}.json`))).input.retractTo.pr).toBe(42);
  const fileOwed = vi.fn(async () => ({ ok: true }));
  await reconcileCardBatches({ stateDir, fileOwed, loadFilingSettings: () => ({ filingEnabled: true }), seal: async () => [] });
  expect(fileOwed).toHaveBeenCalledWith(expect.objectContaining({
    retract: filing.retractTo, owedKey: parsed.owedKey,
  }), expect.any(Object));
});

it('retains the same obligation when filing is paused between spawn and the CLI job', async () => {
  const filing = { ...input, digest: 'long guard '.repeat(3000) };
  let argv;
  spawnPreventionLandingJob(filing, { loadFilingSettings: () => ({ filingEnabled: true }), write: () => {},
    resolveSettingsEnv: () => null, spawnDetached: args => { argv = args; return { pid: 123 }; } });
  const parsed = parseLandPreventionCardArgv(argv.slice(1));
  expect(await landPreventionCard(parsed, { loadFilingSettings: paused, write: () => {} })).toMatchObject({ ok: false, step: 'paused' });
  spawnPreventionLandingJob(filing, { loadFilingSettings: paused, write: () => {} });
  expect(readdirSync(join(stateDir, 'owed-prevention'))).toEqual([`${parsed.owedKey}.json`]);
});
