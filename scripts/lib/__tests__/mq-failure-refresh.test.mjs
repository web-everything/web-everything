import { describe, expect, it, vi } from 'vitest';
import { refreshMqFailureHead } from '../mq-failure-refresh.mjs';
import { createMqFailureLedger } from '../mq-failure-ledger.mjs';

const identity = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40) };
const newHead = 'b'.repeat(40);
const checkout = { cwd: 'fixture/isolated-checkout', branch: 'topic' };
function fixture() {
  let state = {};
  let tail = Promise.resolve();
  const storage = { atomicUpdate: vi.fn(update => {
    const operation = tail.then(async () => {
      const next = await update(structuredClone(state));
      state = structuredClone(next.state);
      return next.result;
    });
    tail = operation.catch(() => {});
    return operation;
  }) };
  const io = {
    readHead: vi.fn(async () => identity.head),
    createCheckout: vi.fn(async () => checkout),
    git: vi.fn(async ({ args }) => args[0] === 'merge' ? { ok: true, head: newHead } : { ok: true }),
    removeCheckout: vi.fn(async () => {}),
  };
  return { ...identity, ledger: createMqFailureLedger({ io: storage }), io, dryRun: false };
}
const pushes = options => options.io.git.mock.calls.filter(([call]) => call.args[0] === 'push');

describe('mq failure head refresh executor', () => {
  it('outside-diff failure => exactly one head refresh with isolated merge and ordinary push', async () => {
    const options = fixture();
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'refreshed', head: newHead });
    expect(options.io.readHead).toHaveBeenCalledWith({ repo: identity.repo, pr: identity.pr });
    expect(options.io.createCheckout).toHaveBeenCalledTimes(1);
    expect(options.io.createCheckout).toHaveBeenCalledWith(expect.objectContaining(identity));
    expect(options.io.git.mock.calls.map(([call]) => call)).toEqual([
      { cwd: checkout.cwd, args: ['merge', 'origin/main'] },
      { cwd: checkout.cwd, args: ['push', 'origin', 'HEAD:refs/heads/topic'] },
    ]);
    expect(options.io.removeCheckout).toHaveBeenCalledTimes(1);
    expect(options.io.removeCheckout).toHaveBeenCalledWith(checkout);
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop', note: expect.stringMatching(/already|once|refresh/i) });
    expect(pushes(options)).toHaveLength(1);
    expect(options.io.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('repeated failure on an already refreshed head => no loop (stop with note), including the successor SHA', async () => {
    const options = fixture();
    await refreshMqFailureHead(options);
    options.io.readHead.mockResolvedValue(newHead);
    expect(await refreshMqFailureHead({ ...options, head: newHead })).toMatchObject({ action: 'stop', note: expect.stringMatching(/already refreshed/i) });
    expect(pushes(options)).toHaveLength(1);
    expect(options.io.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('concurrent executors share an atomic claim and push at most once', async () => {
    const options = fixture();
    const results = await Promise.all([refreshMqFailureHead(options), refreshMqFailureHead(options)]);
    expect(results.map(result => result.action).sort()).toEqual(['refreshed', 'stop']);
    expect(pushes(options)).toHaveLength(1);
  });

  it('changed head before checkout stops without merging or pushing', async () => {
    const options = fixture();
    options.io.readHead.mockResolvedValue('c'.repeat(40));
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop', note: expect.stringMatching(/head|changed|stale/i) });
    expect(options.io.createCheckout).not.toHaveBeenCalled();
    expect(options.io.git).not.toHaveBeenCalled();
  });

  it('rechecks head after merge and refuses a stale push', async () => {
    const options = fixture();
    options.io.readHead.mockResolvedValueOnce(identity.head).mockResolvedValue('c'.repeat(40));
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop', note: expect.stringMatching(/head|changed|stale/i) });
    expect(options.io.readHead.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(options.io.git).toHaveBeenCalledWith({ cwd: checkout.cwd, args: ['merge', 'origin/main'] });
    expect(pushes(options)).toHaveLength(0);
    expect(options.io.removeCheckout).toHaveBeenCalledWith(checkout);
  });

  it('merge conflicts fall back to normal fix without any push and consume the attempt', async () => {
    const options = fixture();
    options.io.git.mockResolvedValue({ ok: false, conflict: true });
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'fix', note: expect.stringMatching(/conflict/i) });
    expect(pushes(options)).toHaveLength(0);
    expect(options.io.removeCheckout).toHaveBeenCalledWith(checkout);
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop' });
    expect(options.io.createCheckout).toHaveBeenCalledTimes(1);
  });

  it('ordinary push rejection never escalates to force push or retries', async () => {
    const options = fixture();
    options.io.git.mockImplementation(async ({ args }) => args[0] === 'merge'
      ? { ok: true, head: newHead } : { ok: false, error: 'non-fast-forward' });
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'fix', note: expect.stringMatching(/push|fast.forward/i) });
    expect(pushes(options)).toHaveLength(1);
    expect(options.io.git.mock.calls.flatMap(([call]) => call.args).some(arg => /force|^\+/.test(arg))).toBe(false);
    expect(options.io.removeCheckout).toHaveBeenCalledWith(checkout);
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop' });
    expect(pushes(options)).toHaveLength(1);
  });

  it('unreadable live head stops with a note and performs no writes', async () => {
    const options = fixture();
    options.io.readHead.mockRejectedValue(new Error('head unreadable'));
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop', note: expect.stringMatching(/head|unreadable/i) });
    expect(options.io.createCheckout).not.toHaveBeenCalled();
    expect(options.io.git).not.toHaveBeenCalled();
  });

  it('DRY_RUN does not claim the head, allowing a later live refresh', async () => {
    const options = fixture();
    expect(await refreshMqFailureHead({ ...options, dryRun: true })).toMatchObject({ action: 'stop', note: expect.stringMatching(/dry.run/i) });
    expect(options.io.createCheckout).not.toHaveBeenCalled();
    expect(options.io.git).not.toHaveBeenCalled();
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'refreshed' });
    expect(pushes(options)).toHaveLength(1);
  });
});
