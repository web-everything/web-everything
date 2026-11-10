import { describe, expect, it, vi } from 'vitest';
import { drainMqFailureRecovery } from '../drain-mq-failure-recovery.mjs';
import { parseMqFailureRoute } from '../mq-failure-route.mjs';

const removal = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40) };
const evidence = { failedJobs: ['unit (node 22)'], testFiles: ['tests/widget.test.mjs'],
  assertions: ['FAIL tests/widget.test.mjs > keeps state', 'AssertionError: expected true'], complete: true };
function fixture() {
  const claimed = new Set();
  return {
    removal, hold: { reason: 'mq-same-head-failed', historyComplete: true, mergeState: 'CLEAN', retriesExhausted: false }, dryRun: false,
    ledger: { claim: vi.fn(async key => {
      const id = JSON.stringify(key);
      if (claimed.has(id)) return { claimed: false };
      claimed.add(id);
      return { claimed: true };
    }) },
    io: {
      collectEvidence: vi.fn(async () => structuredClone(evidence)),
      readLabels: vi.fn(async () => ({ labels: [], complete: true })),
      postComment: vi.fn(async () => ({ id: 101 })), addLabel: vi.fn(async () => {}),
    },
  };
}
function expectNoWrites(options) {
  expect(options.ledger.claim).not.toHaveBeenCalled();
  expect(options.io.postComment).not.toHaveBeenCalled();
  expect(options.io.addLabel).not.toHaveBeenCalled();
}

describe('drain mq failure recovery', () => {
  it('route emitted on a real failure with job names and test names, exactly once per head', async () => {
    const options = fixture();
    expect(await drainMqFailureRecovery(options)).toMatchObject({ action: 'routed' });
    expect(options.ledger.claim).toHaveBeenCalledWith({ ...removal, kind: 'route' });
    expect(options.io.collectEvidence).toHaveBeenCalledWith(expect.objectContaining({ removal }));
    expect(options.io.postComment).toHaveBeenCalledTimes(1);
    const [comment] = options.io.postComment.mock.calls[0];
    expect(comment).toMatchObject({ repo: removal.repo, pr: removal.pr, body: expect.any(String) });
    expect(parseMqFailureRoute({ comment: { body: comment.body, author: { login: 'chalbert' } }, expected: removal }))
      .toMatchObject({ ...removal, ...evidence, stale: false });
    expect(options.io.addLabel).toHaveBeenCalledTimes(1);
    expect(options.io.addLabel).toHaveBeenCalledWith({ repo: removal.repo, pr: removal.pr, label: 'mq-failure-recovery' });
    expect(await drainMqFailureRecovery(options)).toMatchObject({ action: 'skip' });
    expect(options.io.postComment).toHaveBeenCalledTimes(1);
    expect(options.io.addLabel).toHaveBeenCalledTimes(1);
  });

  it('does not add an already-present recovery label', async () => {
    const options = fixture();
    options.io.readLabels.mockResolvedValue({ labels: ['mq-failure-recovery'], complete: true });
    expect(await drainMqFailureRecovery(options)).toMatchObject({ action: 'routed' });
    expect(options.io.addLabel).not.toHaveBeenCalled();
    expect(options.io.postComment).toHaveBeenCalledTimes(1);
  });

  it.each(['infra', 'incomplete', 'unreadable-history', 'conflicts', 'exhausted-retries', 'dry-run', 'other-hold', 'unknown-labels'])('does not route or claim for %s', async reason => {
    const options = fixture();
    if (reason === 'infra') options.io.collectEvidence.mockResolvedValue({ failedJobs: ['unit'], testFiles: [], assertions: ['The runner has lost communication with the server.'], complete: true });
    if (reason === 'incomplete') options.io.collectEvidence.mockResolvedValue({ ...evidence, complete: false });
    if (reason === 'unreadable-history') options.hold.historyComplete = false;
    if (reason === 'conflicts') options.hold.mergeState = 'CONFLICTING';
    if (reason === 'exhausted-retries') options.hold.retriesExhausted = true;
    if (reason === 'dry-run') options.dryRun = true;
    if (reason === 'other-hold') options.hold.reason = 'review-required';
    if (reason === 'unknown-labels') options.io.readLabels.mockResolvedValue({ labels: [], complete: false });
    expect(await drainMqFailureRecovery(options)).toMatchObject({ action: 'skip', note: expect.any(String) });
    expectNoWrites(options);
  });

  it('unreadable failure evidence never becomes a route', async () => {
    const options = fixture();
    options.io.collectEvidence.mockRejectedValue(new Error('history unavailable'));
    expect(await drainMqFailureRecovery(options)).toMatchObject({ action: 'skip', note: expect.stringMatching(/unreadable|unavailable|evidence/i) });
    expectNoWrites(options);
  });

  it('already-routed head refuses both comment and label writes', async () => {
    const options = fixture();
    options.ledger.claim.mockResolvedValue({ claimed: false });
    expect(await drainMqFailureRecovery(options)).toMatchObject({ action: 'skip' });
    expect(options.io.postComment).not.toHaveBeenCalled();
    expect(options.io.addLabel).not.toHaveBeenCalled();
  });

  it('ledger failure retains the hold with an operator-visible note', async () => {
    const options = fixture();
    options.ledger.claim.mockRejectedValue(new Error('ledger unreadable'));
    expect(await drainMqFailureRecovery(options)).toMatchObject({ action: 'skip', note: expect.stringMatching(/ledger|operator/i) });
    expect(options.io.postComment).not.toHaveBeenCalled();
    expect(options.io.addLabel).not.toHaveBeenCalled();
  });
});
