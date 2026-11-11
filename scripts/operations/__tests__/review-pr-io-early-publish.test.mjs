import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createReviewPrSinks } from '../review-pr-io.mjs';
import { REVIEW_EFFECTS } from '../review-pr.mjs';

const head = 'a'.repeat(40);
const payload = { repo: 'o/n', pr: 7, to: 'accepted', actor: 'operator', bodyFile: 'verdict.md', reviewedHead: head };
const pending = { allowed: false, headSha: head, reason: 'required-checks-not-successful' };
const green = { allowed: true, headSha: head, reason: 'required-checks-successful' };
function fixture(overrides = {}) {
  let time = 0;
  const runNode = vi.fn(() => '{"ok":true}');
  const sleep = vi.fn(async ms => { time += ms; });
  const publishGate = vi.fn(() => pending);
  const readPublishHead = vi.fn(() => head);
  // The body is restored from the run record when it is not on disk (stuck-bodyfile recovery), so stage it there.
  const runStore = { read: id => ({ id, effects: [{ type: REVIEW_EFFECTS.WRITE_UP, status: 'applied',
    payload: { bodyFile: payload.bodyFile, body: 'verdict body' } }] }) };
  const sinks = createReviewPrSinks({ runStore, root: mkdtempSync(join(tmpdir(), 'early-publish-')), env: { WE_REVIEW_START_EARLY: 'on', WE_REVIEW_START_AFTER: 'fast-checks', WE_REVIEW_CANCEL_ON_CI_RED: 'false',
    WE_REVIEW_START_EARLY_PUBLISH_WAIT_MS: '250', WE_REVIEW_START_EARLY_POLL_MS: '100', ...overrides.env },
    runNode, sleep, now: () => time, publishGate, readPublishHead, out: () => {},
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'env')) });
  return { runNode, sleep, publishGate, readPublishHead,
    publish: (change = {}) => sinks[REVIEW_EFFECTS.LABEL]({ ...payload, ...change }, { runId: 'early-publish' }) };
}

describe('early accepted verdict publication requires strict head CI', () => {
  describe.each(['off', 'shadow'])('push-mode publication with startEarly=%s', startEarly => {
    const env = { WE_REVIEW_START_EARLY: startEarly, WE_REVIEW_START_AFTER: 'push', WE_REVIEW_CANCEL_ON_CI_RED: 'true' };
    it('waits for pending CI to become green before publishing', async () => {
      const f = fixture({ env });
      f.publishGate.mockReturnValueOnce(pending).mockReturnValue(green);
      await expect(f.publish()).resolves.toEqual({ ok: true });
      expect(f.sleep).toHaveBeenCalledWith(100);
      expect(f.publishGate).toHaveBeenCalledTimes(2);
      for (const [args] of f.publishGate.mock.calls) expect(args.policy)
        .toMatchObject({ startAfter: 'ci-green', startEarly: 'off', startBeforeCi: false });
      expect(f.runNode).toHaveBeenCalledTimes(1);
    });
    it('holds publication when CI remains pending through the deadline', async () => {
      const f = fixture({ env });
      await expect(f.publish()).rejects.toMatchObject({ notApplied: true, message: 'review held: CI still pending on reviewed head' });
      expect(f.sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 100, 50]);
      expect(f.runNode).not.toHaveBeenCalled();
    });
    it('refuses red CI without publishing or waiting', async () => {
      const f = fixture({ env });
      f.publishGate.mockReturnValue({ ...pending, reason: 'ci-red' });
      await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
      expect(f.sleep).not.toHaveBeenCalled();
      expect(f.runNode).not.toHaveBeenCalled();
    });
  });
  it('waits for pending CI to become green before publishing, with strict policy on every probe', async () => {
    const f = fixture({ env: { WE_REVIEW_START_BEFORE_CI: 'true', WE_REVIEW_START_AFTER: 'push' } });
    f.publishGate.mockReturnValueOnce(pending).mockReturnValue(green);
    f.sleep.mockImplementationOnce(async () => { expect(f.runNode).not.toHaveBeenCalled(); });
    await expect(f.publish()).resolves.toEqual({ ok: true });
    expect(f.sleep).toHaveBeenCalledWith(100);
    expect(f.publishGate).toHaveBeenCalledTimes(2);
    for (const [args] of f.publishGate.mock.calls) expect(args).toMatchObject({ expectedHead: head,
      policy: { startEarly: 'off', startAfter: 'ci-green', startBeforeCi: false } });
    expect(f.readPublishHead.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.runNode).toHaveBeenCalledTimes(1);
  });
  it.each(['pending', 'missing', 'unreadable', 'throw', 'unpinned-green'])('holds %s CI at the bounded timeout with no publication', async state => {
    const f = fixture();
    if (state === 'throw') f.publishGate.mockImplementation(() => { throw new Error('offline'); });
    else f.publishGate.mockReturnValue(state === 'unpinned-green' ? { allowed: true } : { ...pending,
      reason: state === 'unreadable' ? 'unreadable-ci' : pending.reason, affected: [{ name: 'test', reason: state }] });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, message: 'review held: CI still pending on reviewed head' });
    expect(f.sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 100, 50]);
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it('routes red CI to the CI-heal path without waiting or publishing', async () => {
    const f = fixture();
    f.publishGate.mockReturnValue({ ...pending, reason: 'ci-red' });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, message: 'review held: CI red on reviewed head; CI-heal path' });
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it('holds red CI discovered after waiting without publishing', async () => {
    const f = fixture();
    f.publishGate.mockReturnValueOnce(pending).mockReturnValue({ ...pending, reason: 'ci-red' });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, message: 'review held: CI red on reviewed head; CI-heal path' });
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it('clips an oversized poll interval to the remaining wait and holds instead of publishing', async () => {
    const f = fixture({ env: { WE_REVIEW_START_EARLY_POLL_MS: String(Number.MAX_SAFE_INTEGER) } });
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, message: 'review held: CI still pending on reviewed head' });
    expect(f.sleep.mock.calls).toEqual([[250]]);
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it.each(['off', 'shadow'])('preserves accepted publication with cancelOnCiRed off in %s mode', async startEarly => {
    const f = fixture({ env: { WE_REVIEW_START_EARLY: startEarly } });
    await expect(f.publish()).resolves.toEqual({ ok: true });
    expect(f.publishGate).not.toHaveBeenCalled();
    expect(f.sleep).not.toHaveBeenCalled();
  });
  it('preserves changes publication even with early start on and CI pending', async () => {
    const f = fixture();
    await expect(f.publish({ to: 'changes' })).resolves.toEqual({ ok: true });
    expect(f.publishGate).not.toHaveBeenCalled();
    expect(f.sleep).not.toHaveBeenCalled();
  });
  it('voids a head that moves during the wait before another CI probe or publication', async () => {
    const f = fixture();
    f.readPublishHead.mockReturnValueOnce(head).mockReturnValueOnce(head).mockReturnValue('b'.repeat(40));
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true, message: 'review void: head moved or current head could not be read' });
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.publishGate).toHaveBeenCalledTimes(1);
    expect(f.runNode).not.toHaveBeenCalled();
  });
  it('rechecks the live head after a green probe before publishing', async () => {
    const f = fixture();
    f.publishGate.mockReturnValue(green);
    f.readPublishHead.mockReturnValueOnce(head).mockReturnValue('b'.repeat(40));
    await expect(f.publish()).rejects.toMatchObject({ notApplied: true });
    expect(f.runNode).not.toHaveBeenCalled();
  });
});
