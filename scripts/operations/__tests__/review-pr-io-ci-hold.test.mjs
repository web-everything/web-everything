import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReviewPrSinks } from '../review-pr-io.mjs';
import { REVIEW_EFFECTS } from '../review-pr.mjs';
import { reviewCiGate } from '../../lib/review-ci-gate.mjs';
import { resolveTimingPolicy } from '../../lib/review-timing-settings.mjs';
import { frozenWriteUpStore } from './helpers/frozen-writeup-store.mjs';
import { classifyReviewLoopOutcome } from '../review-job.mjs';
import { outcomePayload } from '../cli-adapter.mjs';

// #6769: the panel read starts hours AFTER the test-gaming hold on this same head.
// Job/run IDs are synthetic; details_url, not the check-run id, identifies the job to rerun.
const head = '963cdb2c' + 'a'.repeat(32);
const readStart = '2026-11-14T23:26:00.000Z';
const publishStart = Date.parse('2026-11-14T23:31:16.000Z');
const oldCompleted = '2026-11-14T18:11:00.000Z';
const freshCompleted = '2026-11-14T23:31:15.000Z';
const jobId = 676901;
const runId = 'review-6769';
const requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'review-gate', 'merge-gate'];
const body = '# Accept\n\nThe removed finalGate=full test is obsolete under R913.\n';
const payload = { repo: 'o/n', pr: 6769, to: 'accepted', actor: 'operator',
  bodyFile: 'verdict.md', reviewedHead: head };
const ok = name => ({ name, head_sha: head, status: 'completed', conclusion: 'success',
  completed_at: '2026-11-14T18:33:00.000Z' });
const staleHold = {
  ...ok('merge-gate'), id: 999999, conclusion: 'failure', completed_at: oldCompleted,
  details_url: `https://github.com/o/n/actions/runs/676900/job/${jobId}`,
  output: { title: '#6769: HOLD', summary: 'test-gaming suspected: tests-removed' },
  mergeGateReviewHold: { holds: ['test-gaming'], jobId },
};
const allButMerge = requiredChecks.filter(name => name !== 'merge-gate').map(ok);
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Same sink/strict-gate/fake-clock harness as review-pr-io.test.mjs's startEarly
// publish-wait group. New IO contracts: rerunJob(jobId) and readRunStart({ runId })
// returning the persisted read-start ISO timestamp (null means unreadable).
async function fixture(initialChecks = [...allButMerge, staleHold], { env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'review-ci-hold-'));
  roots.push(root);
  let time = publishStart;
  let checks = initialChecks;
  const writes = [];
  const runNode = vi.fn(argv => {
    writes.push({ argv, body: readFileSync(argv.find(arg => arg.startsWith('--body-file=')).slice('--body-file='.length), 'utf8') });
    return '{"ok":true}';
  });
  const sleep = vi.fn(async ms => { time += ms; });
  const getRerunRun = vi.fn(async () => ({ head_sha: head }));
  const getRerunJob = vi.fn(async () => ({ run_id: 676900, name: 'merge-gate', head_sha: head }));
  const rerunJob = vi.fn(async () => {});
  const readRunStart = vi.fn(async () => readStart);
  const readPublishHead = vi.fn(async () => head);
  const publishGate = vi.fn(async () => ({
    ...reviewCiGate({ headSha: head, requiredChecks, checks }), requiredChecks, checks,
  }));
  const rerunStateDir = join(root, 'ci-reruns');
  const options = { root, tmpDir: root, rerunStateDir,
    runStore: frozenWriteUpStore(root, ['verdict.md'], body),
    env: { WE_REVIEW_START_EARLY: 'on', WE_REVIEW_START_AFTER: 'push', ...env },
    runNode, publishGate, readPublishHead, sleep, now: () => time, out: () => {},
    rerunJob, getRerunRun, getRerunJob, readRunStart,
  };
  let sinks = createReviewPrSinks(options);
  await sinks[REVIEW_EFFECTS.WRITE_UP]({ bodyFile: payload.bodyFile, body }, { runId });
  return { runNode, writes, sleep, rerunJob, getRerunRun, getRerunJob, readRunStart, readPublishHead, publishGate,
    rerunStateDir,
    recreate: () => { sinks = createReviewPrSinks(options); },
    elapsed: () => time - publishStart,
    setChecks: rows => { checks = rows; },
    publish: (change = {}, id = runId) => sinks[REVIEW_EFFECTS.LABEL]({ ...payload, ...change }, { runId: id }),
  };
}

describe('#6769 S1/S2: accepted review publication held by CI', () => {
  it('reruns a pre-read merge-gate failure once, then reports review-hold-human and preserves the accept for the human label', async () => {
    const f = await fixture();
    f.rerunJob.mockImplementation(async () => {
      f.setChecks([...allButMerge, { ...staleHold, completed_at: freshCompleted,
        details_url: 'https://github.com/o/n/actions/runs/676902/job/676903',
        mergeGateReviewHold: { holds: ['test-gaming'], jobId: 676903 } }]);
    });

    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, reason: 'review-hold-human' });
    expect(f.readRunStart).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    expect(f.rerunJob.mock.calls).toEqual([[jobId]]);
    expect(f.publishGate).toHaveBeenCalledTimes(2);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.elapsed()).toBe(0);
    expect(f.runNode).not.toHaveBeenCalled();

    // The caller can route this typed hold to review:human with the SAME accept
    // evidence; no acceptance was written by the refused publication above.
    await expect(f.publish({ to: 'human' })).resolves.toEqual({ ok: true });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].argv).toContain('--to=human');
    expect(f.writes[0].body).toBe(body);
    expect(f.rerunJob.mock.calls).toEqual([[jobId]]);
  });

  it('publishes accept when the stale merge-gate rerun succeeds without spending the pending budget', async () => {
    const f = await fixture();
    f.rerunJob.mockImplementation(async () => { f.setChecks(requiredChecks.map(ok)); });

    await expect(f.publish()).resolves.toEqual({ ok: true });
    expect(f.rerunJob.mock.calls).toEqual([[jobId]]);
    expect(f.publishGate).toHaveBeenCalledTimes(2);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].argv).toContain('--to=accepted');
    expect(f.writes[0].body).toBe(body);
  });

  it.each(['review-gate', 'merge-gate'])('holds a %s failure completed after read start immediately as ci-red-real, without rerun or polling', async name => {
    const f = await fixture(requiredChecks.map(check => check === name
      ? { ...ok(name), conclusion: 'failure', completed_at: freshCompleted,
        details_url: `https://github.com/o/n/actions/runs/676900/job/${jobId}` }
      : ok(check)));

    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, reason: 'ci-red-real' });
    expect(f.rerunJob).not.toHaveBeenCalled();
    expect(f.publishGate).toHaveBeenCalledTimes(1);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.elapsed()).toBe(0);
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it('polls genuinely pending CI and defers within the 120000ms default instead of the old 1500000ms budget', async () => {
    const f = await fixture(requiredChecks.map(name => name === 'test'
      ? { name, status: 'in_progress', head_sha: head }
      : ok(name)));

    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, outcome: 'deferred-ci' });
    expect(f.elapsed()).toBe(120000);
    expect(f.sleep.mock.calls).toEqual([[30000], [30000], [30000], [30000]]);
    expect(f.publishGate).toHaveBeenCalledTimes(5);
    expect(f.rerunJob).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it.each(['throws', 'missing', 'pending-then-unreadable'])('keeps %s CI evidence on infrastructure cooldown at the deadline', async kind => {
    const f = await fixture(requiredChecks.map(name => name === 'test' ? { name, status: 'queued', head_sha: head } : ok(name)));
    if (kind === 'throws') f.publishGate.mockRejectedValue(new Error('CI unavailable'));
    if (kind === 'missing') f.setChecks(requiredChecks.filter(name => name !== 'test').map(ok));
    if (kind === 'pending-then-unreadable') {
      const pending = await f.publishGate();
      f.publishGate.mockReset().mockResolvedValueOnce(pending).mockRejectedValue(new Error('CI unavailable'));
    }
    const error = await f.publish().catch(error => error);
    expect(error).toMatchObject({ notApplied: true, message: 'review held: CI still pending on reviewed head' });
    expect(error).not.toHaveProperty('outcome');
    expect(classifyReviewLoopOutcome({ stopped: 'effect-halted', error: error.message }).outcome).toBe('blocked-on-infra');
    expect(f.elapsed()).toBe(120000);
    expect(f.publishGate).toHaveBeenCalledTimes(5);
    expect(f.rerunJob).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it('preserves the explicit pending outcome through CLI serialization and job classification', async () => {
    const f = await fixture(requiredChecks.map(name => name === 'test' ? { name, status: 'queued', head_sha: head } : ok(name)));
    const error = await f.publish().catch(error => error);
    const parsed = outcomePayload({ run: { id: runId, op: 'review-pr', effects: [] }, stopped: 'effect-halted', error });
    expect(parsed.outcome).toBe('deferred-ci');
    expect(classifyReviewLoopOutcome(parsed).outcome).toBe('deferred-ci');
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it('never reruns a stale row with a check-run id but no job URL', async () => {
    const f = await fixture([...allButMerge, { ...staleHold, details_url: undefined }]);
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    expect(f.rerunJob).not.toHaveBeenCalled();
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it.each(['other-repo', 'job-name', 'job-run', 'job-head', 'run-head', 'unreadable', 'missing'])('holds without rerun for %s ownership evidence', async kind => {
    const f = await fixture([...allButMerge, { ...staleHold,
      ...(kind === 'other-repo' ? { details_url: `https://github.com/other/repo/actions/runs/676900/job/${jobId}` } : {}) }]);
    if (kind === 'job-name') f.getRerunJob.mockResolvedValue({ run_id: 676900, name: 'deploy', head_sha: head });
    if (kind === 'job-run') f.getRerunJob.mockResolvedValue({ run_id: 123, name: 'merge-gate', head_sha: head });
    if (kind === 'job-head') f.getRerunJob.mockResolvedValue({ run_id: 676900, name: 'merge-gate', head_sha: 'b'.repeat(40) });
    if (kind === 'run-head') f.getRerunRun.mockResolvedValue({ head_sha: 'b'.repeat(40) });
    if (kind === 'unreadable') f.getRerunJob.mockRejectedValue(new Error('unavailable'));
    if (kind === 'missing') f.getRerunRun.mockResolvedValue({});
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    expect(f.rerunJob).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
    if (kind === 'other-repo') expect(f.getRerunRun).not.toHaveBeenCalled();
  });

  it('persists the rerun allowance across sink recreation for the same run', async () => {
    const f = await fixture();
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    f.recreate();
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    expect(f.rerunJob.mock.calls).toEqual([[jobId]]);
    expect(f.elapsed()).toBe(240000);
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it('holds without requesting a rerun if the durable attempt cannot be written', async () => {
    const f = await fixture();
    writeFileSync(f.rerunStateDir, 'not a directory');
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, message: expect.stringContaining('inspect run state') });
    expect(f.rerunJob).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it('reruns each stale row only once per review run id, including a second publication attempt seeing the old row', async () => {
    const f = await fixture();
    // GitHub may keep serving the original completed row after accepting rerun.
    // Repeated snapshots and a second sink call must not dispatch it again.
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    expect(f.rerunJob.mock.calls).toEqual([[jobId]]);
    expect(f.runNode).not.toHaveBeenCalled();

    // A different review run gets its own allowance for this row.
    await expect(f.publish({}, 'review-6769-next')).rejects.toMatchObject({ notApplied: true });
    expect(f.rerunJob.mock.calls).toEqual([[jobId], [jobId]]);
  });

  it('waits through a stale ci-red snapshot after rerun, then publishes when the rerun succeeds', async () => {
    const checks = [...allButMerge, { ...staleHold, mergeGateReviewHold: undefined }];
    const f = await fixture(checks);
    const staleCi = { ...reviewCiGate({ headSha: head, requiredChecks, checks }),
      reason: 'ci-red', requiredChecks, checks };
    const greenChecks = requiredChecks.map(ok);
    f.publishGate.mockResolvedValueOnce(staleCi).mockResolvedValueOnce(staleCi)
      .mockResolvedValue({ ...reviewCiGate({ headSha: head, requiredChecks, checks: greenChecks }),
        requiredChecks, checks: greenChecks });

    await expect(f.publish()).resolves.toEqual({ ok: true });
    expect(f.rerunJob.mock.calls).toEqual([[jobId]]);
    expect(f.publishGate).toHaveBeenCalledTimes(3);
    expect(f.sleep.mock.calls).toEqual([[30000]]);
    expect(f.elapsed()).toBe(30000);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].argv).toContain('--to=accepted');
    expect(f.writes[0].body).toBe(body);
  });

  it('never publishes or grants deferred-ci for an unchanged ci-red snapshot after rerun', async () => {
    const checks = [...allButMerge, { ...staleHold, mergeGateReviewHold: undefined }];
    const f = await fixture(checks);
    f.publishGate.mockResolvedValue({ ...reviewCiGate({ headSha: head, requiredChecks, checks }),
      reason: 'ci-red', requiredChecks, checks });

    const error = await f.publish().catch(error => error);
    expect(error).toMatchObject({ notApplied: true, message: 'review held: CI still pending on reviewed head' });
    expect(error).not.toHaveProperty('outcome');
    expect(f.rerunJob.mock.calls).toEqual([[jobId]]);
    expect(f.publishGate).toHaveBeenCalledTimes(6);
    expect(f.sleep.mock.calls).toEqual([[30000], [30000], [30000], [30000]]);
    expect(f.elapsed()).toBe(120000);
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it('keeps a failed rerun held across publication attempts without rerunning or publishing', async () => {
    const f = await fixture();
    f.rerunJob.mockRejectedValue(new Error('rerun unavailable'));

    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, reason: 'ci-red-real' });
    // Even a later green snapshot cannot turn an errored rerun request into successful rerun evidence.
    f.setChecks(requiredChecks.map(ok));
    f.recreate();
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, reason: 'ci-red-real' });
    expect(f.rerunJob.mock.calls).toEqual([[jobId]]);
    expect(f.publishGate).toHaveBeenCalledTimes(2);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
  });

  it('does not infer staleness or publish accept when the run read start is unreadable', async () => {
    const f = await fixture();
    f.readRunStart.mockResolvedValue(null);
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    expect(f.rerunJob).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
    expect(f.sleep).not.toHaveBeenCalled();
  });
});

describe('CI hold publication wait settings', () => {
  const base = { env: {}, read: () => '{}', review: {}, fix: {}, platformReview: {}, platformFix: {} };
  it('defaults startEarlyPublishWaitMs to 120000 with standard provenance', () => {
    const policy = resolveTimingPolicy(base);
    expect(policy.review.startEarlyPublishWaitMs).toBe(120000);
    expect(policy.sources.review.startEarlyPublishWaitMs).toBe('standard');
  });
  it('allows platform, tool, and environment overrides of the shortened wait', () => {
    const platform = { ...base, platformReview: { startEarlyPublishWaitMs: 180000 } };
    expect(resolveTimingPolicy(platform).review.startEarlyPublishWaitMs).toBe(180000);
    const tool = { ...platform, review: { startEarlyPublishWaitMs: 90000 } };
    expect(resolveTimingPolicy(tool).review.startEarlyPublishWaitMs).toBe(90000);
    const policy = resolveTimingPolicy({ ...tool, env: { WE_REVIEW_START_EARLY_PUBLISH_WAIT_MS: '45000' } });
    expect(policy.review.startEarlyPublishWaitMs).toBe(45000);
    expect(policy.sources.review.startEarlyPublishWaitMs).toBe('env');
  });
});
