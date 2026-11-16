import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createReviewPrSinks } from '../review-pr-io.mjs';
import { frozenWriteUpStore } from './helpers/frozen-writeup-store.mjs';
import { REVIEW_EFFECTS } from '../review-pr.mjs';

// Same fake clock and frozen write-up harness as review-pr-io-early-publish.test.mjs.
const head = 'a'.repeat(40);
const changedFiles = ['docs/example.md'];
const payload = { repo: 'o/n', pr: 7, to: 'accepted', actor: 'operator', bodyFile: 'verdict.md', reviewedHead: head, changedFiles };
const reviewRow = { name: 'review-gate', head_sha: head, status: 'completed', conclusion: 'failure' };
const pending = { allowed: false, headSha: head, reason: 'required-review-gate-conflict',
  requiredChecks: ['merge-gate', 'review-gate'], checks: [reviewRow],
  affected: [{ name: 'merge-gate', reason: 'missing' }, { name: 'review-gate', reason: 'failure' }] };
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(ci = pending, decision = { publish: true, reason: 'verified-hold' }) {
  let time = 0;
  const root = mkdtempSync(join(tmpdir(), 'decide-publish-')); roots.push(root);
  const runNode = vi.fn(() => '{"ok":true}');
  const sleep = vi.fn(async ms => { time += ms; });
  const publishGate = vi.fn(async () => structuredClone(ci));
  const readLabels = vi.fn(async () => ['review:pending']);
  const decideReviewGate = vi.fn(async () => decision);
  const sinks = createReviewPrSinks({ root, runStore: frozenWriteUpStore(root, ['verdict.md']),
    env: { WE_REVIEW_START_EARLY: 'on', WE_REVIEW_START_AFTER: 'fast-checks', WE_REVIEW_CANCEL_ON_CI_RED: 'false',
      WE_REVIEW_START_EARLY_PUBLISH_WAIT_MS: '250', WE_REVIEW_START_EARLY_POLL_MS: '100' },
    runNode, sleep, now: () => time, publishGate, readPublishHead: () => head, readLabels, decideReviewGate, out: () => {} });
  return { runNode, sleep, publishGate, readLabels, decideReviewGate,
    publish: () => sinks[REVIEW_EFFECTS.LABEL](payload, { runId: 'decide-publish' }) };
}

describe('review-pr publish sink uses decideReviewGate', () => {
  it('publishes with no actions/runs write', async () => {
    const f = fixture();
    await expect(f.publish()).resolves.toEqual({ ok: true });
    expect(f.decideReviewGate).toHaveBeenCalledWith({ repo: 'o/n', pr: 7, head,
      liveLabels: ['review:pending'], changedFiles });
    expect(f.readLabels).toHaveBeenCalledWith('o/n', 7);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.runNode).toHaveBeenCalledTimes(1);
    const [argv] = f.runNode.mock.calls[0];
    expect(argv[0]).toMatch(/review-set-label\.mjs$/);
    expect(argv.join(' ')).not.toMatch(/actions\/runs|rerun|--method|(?:^| )-X(?: |$)/);
  });
  it('holds with reason review held: review-gate unproven (<reason>) at deadline', async () => {
    const f = fixture(pending, { publish: false, reason: 'marker-labels-mismatch' });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true,
      message: 'review held: review-gate unproven (marker-labels-mismatch)' });
    expect(f.decideReviewGate).toHaveBeenCalledTimes(4);
    expect(f.sleep.mock.calls).toEqual([[100], [100], [50]]);
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it('another red row holds without calling decideReviewGate', async () => {
    const f = fixture({ ...pending, checks: [...pending.checks, { name: 'test', status: 'completed', conclusion: 'failure' }],
      affected: [...pending.affected, { name: 'test', reason: 'failure' }] });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    expect(f.decideReviewGate).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it('green-rollup-but-decide-false-holds', async () => {
    const f = fixture({ ...pending, allowed: true, reason: 'required-checks-successful', affected: [],
      checks: [{ ...reviewRow, conclusion: 'success' }] }, { publish: false, reason: 'no-marker' });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true,
      message: 'review held: review-gate unproven (no-marker)' });
    expect(f.decideReviewGate).toHaveBeenCalled();
    expect(f.sleep.mock.calls).toEqual([[100], [100], [50]]);
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it('rollup-review-gate-requires-proof-even-when-not-required', async () => {
    const f = fixture({ allowed: true, headSha: head, reason: 'required-checks-successful', affected: [],
      requiredChecks: ['test'], checks: [{ ...reviewRow, conclusion: 'success' }] }, { publish: false, reason: 'no-marker' });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true,
      message: 'review held: review-gate unproven (no-marker)' });
    expect(f.decideReviewGate).toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it('polls-unproven-until-proof-arrives', async () => {
    const f = fixture();
    f.decideReviewGate.mockResolvedValueOnce({ publish: false, reason: 'latest-in-progress' })
      .mockResolvedValue({ publish: true, reason: 'verified-hold' });
    await expect(f.publish()).resolves.toEqual({ ok: true });
    expect(f.sleep.mock.calls).toEqual([[100]]);
    expect(f.decideReviewGate).toHaveBeenCalledTimes(2);
    expect(f.runNode).toHaveBeenCalledTimes(1);
  });
});
