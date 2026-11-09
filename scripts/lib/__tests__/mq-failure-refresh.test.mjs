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

  it('repeated failure on an already refreshed head => no second refresh, including the successor SHA (the fixer takes it)', async () => {
    const options = fixture();
    await refreshMqFailureHead(options);
    options.io.readHead.mockResolvedValue(newHead);
    expect(await refreshMqFailureHead({ ...options, head: newHead })).toMatchObject({ action: 'fix', note: expect.stringMatching(/no second refresh/i) });
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


describe('mq no-op refresh fallback', () => {
  it('unchanged merged head persists a normal-fixer fallback without pushing or reporting refreshed', async () => {
    const options = fixture();
    options.io.git.mockResolvedValue({ ok: true, head: identity.head });
    const recordRefresh = vi.spyOn(options.ledger, 'recordRefresh');
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'fix', note: expect.stringMatching(/unchanged|no.op|already.*main/i) });
    expect(pushes(options)).toHaveLength(0);
    expect(recordRefresh).not.toHaveBeenCalled();
    expect(await options.ledger.readFixFallback(identity)).toBe(true);
    expect(options.io.removeCheckout).toHaveBeenCalledTimes(1);
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop' });
    expect(options.io.createCheckout).toHaveBeenCalledTimes(1);
    expect(pushes(options)).toHaveLength(0);
  });
});


describe('mq failure refresh ordering', () => {
  it('successor reservation is persisted before push begins', async () => {
    const options = fixture();
    let reservedAtPush = null;
    options.io.git = vi.fn(async ({ args }) => {
      if (args[0] === 'push') reservedAtPush = (await options.ledger.claim({ ...identity, head: newHead, kind: 'refresh' })).claimed === false;
      return args[0] === 'merge' ? { ok: true, head: newHead } : { ok: true };
    });
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'refreshed' });
    expect(reservedAtPush).toBe(true); // the successor was already claimed (reserved) when the push ran
  });

  it('a failed successor reservation prevents the push and hands the PR to the fixer', async () => {
    const options = fixture();
    options.ledger = { ...options.ledger, recordRefresh: vi.fn(async () => { throw new Error('disk full'); }) };
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'fix' });
    expect(pushes(options)).toHaveLength(0);
    expect(options.io.removeCheckout).toHaveBeenCalledTimes(1);
    expect(await options.ledger.readFixFallback(identity)).toBe(true);
  });
});

// Policy per yield point after the attempt is claimed: every failure records the fixer fallback (`fix`), except the
// single deliberate stop "head changed after merge". A claimed attempt must never leave the PR with no owner.
describe('mq failure refresh post-claim failure policy', () => {
  const boom = () => { throw new Error('transient'); };
  it.each([
    ['createCheckout throws', o => { o.io.createCheckout = vi.fn(boom); }, false, 0],
    ['merge throws', o => { o.io.git = vi.fn(async ({ args }) => { if (args[0] === 'merge') boom(); return { ok: true }; }); }, true, 0],
    ['merged head is unreadable', o => { o.io.git = vi.fn(async ({ args }) => args[0] === 'merge' ? { ok: true, head: 'nope' } : { ok: true }); }, true, 0],
    ['recordRefresh throws', o => { o.ledger = { ...o.ledger, recordRefresh: vi.fn(boom) }; }, true, 0],
    ['post-merge head read throws', o => { let n = 0; o.io.readHead = vi.fn(async () => { if (++n === 2) boom(); return identity.head; }); }, true, 0],
    ['push throws', o => { o.io.git = vi.fn(async ({ args }) => { if (args[0] === 'push') boom(); return args[0] === 'merge' ? { ok: true, head: newHead } : { ok: true }; }); }, true, 1],
  ])('%s => fixer fallback recorded, checkout cleaned up', async (_name, inject, hasCheckout, pushAttempts) => {
    const options = fixture();
    inject(options);
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'fix' });
    expect(await options.ledger.readFixFallback(identity)).toBe(true);
    expect(options.io.removeCheckout).toHaveBeenCalledTimes(hasCheckout ? 1 : 0);
    expect(pushes(options).length).toBeLessThanOrEqual(pushAttempts);
  });
  it('the head moving after the merge is the one deliberate stop: no push, no fallback', async () => {
    const options = fixture();
    let n = 0;
    options.io.readHead = vi.fn(async () => (++n === 2 ? newHead : identity.head));
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop', note: expect.stringMatching(/head changed/i) });
    expect(pushes(options)).toHaveLength(0);
    expect(await options.ledger.readFixFallback(identity)).toBe(false);
  });
  it('when even the fallback cannot be recorded, the executor stops visibly', async () => {
    const options = fixture();
    options.io.createCheckout = vi.fn(boom);
    options.ledger = { ...options.ledger, recordFixFallback: vi.fn(async () => { throw new Error('disk full'); }) };
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop', note: expect.stringMatching(/operator inspection/i) });
  });
  it('a refreshed head that fails again goes to the fixer, not a dead-end stop; a plain denied claim still stops', async () => {
    const options = fixture();
    await refreshMqFailureHead(options); // refreshes identity.head -> newHead and reserves the successor
    options.io.readHead.mockResolvedValue(newHead);
    expect(await refreshMqFailureHead({ ...options, head: newHead })).toMatchObject({ action: 'fix', note: expect.stringMatching(/failed again/i) });
    expect(await options.ledger.readFixFallback({ ...identity, head: newHead })).toBe(true);
    expect(pushes(options)).toHaveLength(1); // no second refresh
    // A concurrent loser on the original head (claimed, not a successor) must not dispatch a second owner.
    options.io.readHead.mockResolvedValue(identity.head);
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'stop', note: expect.stringMatching(/already refreshed/i) });
  });
  it.each([['-x'], ['a..b'], ['has space'], ['semi;colon'], ['']])('invalid checkout branch %j never reaches the push refspec', async branch => {
    const options = fixture();
    options.io.createCheckout = vi.fn(async () => ({ cwd: checkout.cwd, branch }));
    expect(await refreshMqFailureHead(options)).toMatchObject({ action: 'fix', note: expect.stringMatching(/invalid checkout branch/i) });
    expect(pushes(options)).toHaveLength(0);
    expect(options.io.git).not.toHaveBeenCalled();
    expect(options.io.removeCheckout).toHaveBeenCalledTimes(1);
  });
});


// ── The default adapter, with every subprocess captured (no real git or gh runs) ─────────────────────────────
import { existsSync } from 'node:fs';
import { mqFailureRefreshIo } from '../mq-failure-refresh.mjs';

describe('mq failure default refresh IO', () => {
  const root = 'fixture/dispatch-checkout';
  let execFileSync, execFileSyncThrottled;
  function wire({ remote = 'https://example.test/acme/web.git', pr = {} } = {}) {
    execFileSyncThrottled = vi.fn(() => JSON.stringify({ headRefOid: identity.head, headRefName: 'topic', isCrossRepository: false, ...pr }));
    execFileSync = vi.fn((file, args) => {
      if (args[0] === 'remote') return `${remote}\n`;
      if (args[0] === 'rev-parse') return `${newHead}\n`;
      return '';
    });
    return mqFailureRefreshIo(root, { exec: execFileSync, throttled: execFileSyncThrottled });
  }
  const gitCalls = () => execFileSync.mock.calls.map(([file, args, options]) => ({ file, args, options }));
  const mutating = new Set(['merge', 'push', 'checkout', 'fetch', 'reset', 'clean', 'commit', 'rebase']);

  it('default refresh IO confines mutations to its temporary clone and bounds subprocesses', () => {
    const io = wire();
    const made = io.createCheckout({ repo: identity.repo, pr: identity.pr, head: identity.head });
    try {
      expect(made.branch).toBe('topic');
      expect(made.cwd).not.toBe(root);
      expect(io.git({ cwd: made.cwd, args: ['merge', 'origin/main'] })).toEqual({ ok: true, head: newHead });
      expect(io.git({ cwd: made.cwd, args: ['push', 'origin', 'HEAD:refs/heads/topic'] })).toEqual({ ok: true });
      const calls = gitCalls();
      expect(calls.every(call => call.file === 'git' && Array.isArray(call.args))).toBe(true); // argv-only, never a shell string
      expect(calls.every(call => Number.isFinite(call.options.timeout) && call.options.timeout > 0
        && Number.isFinite(call.options.maxBuffer) && call.options.maxBuffer > 0)).toBe(true);
      // Nothing that changes a checkout ever runs in the dispatch checkout; only clone/read-only calls do.
      expect(calls.filter(call => call.options.cwd === root).map(call => call.args[0]).sort())
        .toEqual(['check-ref-format', 'clone', 'remote']);
      expect(calls.filter(call => mutating.has(call.args[0])).every(call => call.options.cwd === made.cwd)).toBe(true);
      expect(calls.find(call => call.args[0] === 'clone').args).toEqual(['clone', '--no-checkout', '--shared', '--', root, made.cwd]);
      expect(calls.find(call => call.args[0] === 'fetch').args.slice(0, 3)).toEqual(['fetch', '--no-tags', 'origin']);
      expect(calls.find(call => call.args[0] === 'checkout').args).toEqual(['checkout', '--detach', identity.head]);
      expect(execFileSyncThrottled.mock.calls.every(([file, args, options]) => file === 'gh' && Array.isArray(args)
        && Number.isFinite(options.timeout) && Number.isFinite(options.maxBuffer))).toBe(true);
    } finally { io.removeCheckout(made); }
    expect(existsSync(made.cwd)).toBe(false);
  });

  it('a failing merge or push in the clone reports not-ok (conflict only for merge) and never throws', () => {
    const io = wire();
    execFileSync.mockImplementation(() => { throw new Error('boom'); });
    expect(io.git({ cwd: 'fixture/clone', args: ['merge', 'origin/main'] })).toEqual({ ok: false, conflict: true });
    expect(io.git({ cwd: 'fixture/clone', args: ['push', 'origin', 'HEAD:refs/heads/topic'] })).toEqual({ ok: false, conflict: false });
  });

  it.each([
    ['a stale head', { pr: { headRefOid: 'd'.repeat(40) } }],
    ['a fork head', { pr: { isCrossRepository: true } }],
    ['an origin for another repository', { remote: 'https://example.test/acme/other.git' }],
  ])('refuses %s before any clone is made', (_name, options) => {
    const io = wire(options);
    expect(() => io.createCheckout({ repo: identity.repo, pr: identity.pr, head: identity.head })).toThrow();
    expect(gitCalls().some(call => call.args[0] === 'clone')).toBe(false);
  });
});
