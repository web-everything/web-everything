import { describe, expect, it, vi } from 'vitest';
import { createMqFailureLedger } from '../mq-failure-ledger.mjs';

const identity = { repo: 'acme/web', pr: 42, head: 'a'.repeat(40) };
// Atomic storage contract: update(state) -> {state, result}; the adapter serializes
// transactions and persists state before resolving result. Entirely in memory here.
function storage(initial = {}) {
  let state = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    atomicUpdate: vi.fn(update => {
      const operation = tail.then(async () => {
        const next = await update(structuredClone(state));
        state = structuredClone(next.state);
        return next.result;
      });
      tail = operation.catch(() => {});
      return operation;
    }),
    snapshot: () => structuredClone(state),
  };
}
const claim = (ledger, kind = 'route', overrides = {}) => ledger.claim({ ...identity, ...overrides, kind });

describe('mq failure once-per-head ledger', () => {
  it('atomically allows only one of concurrent claims for the same repo/PR/head', async () => {
    const io = storage();
    const a = createMqFailureLedger({ io });
    const b = createMqFailureLedger({ io });
    const results = await Promise.all([claim(a), claim(b), claim(a)]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(results.filter(result => !result.claimed)).toHaveLength(2);
    expect(io.atomicUpdate).toHaveBeenCalled();
  });

  it('keeps route and refresh states separate, refusing the second claim of each', async () => {
    const ledger = createMqFailureLedger({ io: storage() });
    expect(await claim(ledger)).toMatchObject({ claimed: true });
    expect(await claim(ledger, 'refresh')).toMatchObject({ claimed: true });
    expect(await claim(ledger)).toMatchObject({ claimed: false });
    expect(await claim(ledger, 'refresh')).toMatchObject({ claimed: false });
  });

  it('keys claims by all three identity fields', async () => {
    const ledger = createMqFailureLedger({ io: storage() });
    await claim(ledger);
    for (const overrides of [{ repo: 'acme/other' }, { pr: 43 }, { head: 'b'.repeat(40) }]) {
      expect(await claim(ledger, 'route', overrides)).toMatchObject({ claimed: true });
    }
  });

  it('refuses duplicate claims after reload from persisted state', async () => {
    const io = storage();
    await claim(createMqFailureLedger({ io }));
    const reloaded = createMqFailureLedger({ io: storage(io.snapshot()) });
    expect(await claim(reloaded)).toMatchObject({ claimed: false });
    expect(await claim(reloaded, 'refresh')).toMatchObject({ claimed: true });
  });

  it('records the refreshed successor so a subsequent failing refreshed head cannot loop', async () => {
    const io = storage();
    const ledger = createMqFailureLedger({ io });
    expect(await claim(ledger, 'refresh')).toMatchObject({ claimed: true });
    await ledger.recordRefresh({ ...identity, newHead: 'b'.repeat(40) });
    const resumed = createMqFailureLedger({ io: storage(io.snapshot()) });
    expect(await claim(resumed, 'refresh', { head: 'b'.repeat(40) })).toMatchObject({ claimed: false, note: expect.stringMatching(/already refreshed/i) });
  });

  it('fails closed when atomic storage is unreadable instead of granting a claim', async () => {
    const io = { atomicUpdate: vi.fn(async () => { throw new Error('corrupt ledger'); }) };
    await expect(claim(createMqFailureLedger({ io }))).rejects.toThrow(/corrupt ledger/);
  });

  it.each([{ head: '' }, { repo: '' }, { pr: null }, { kind: 'unknown' }])('rejects an unknown identity/state without touching storage: %j', async overrides => {
    const io = storage();
    const ledger = createMqFailureLedger({ io });
    await expect(ledger.claim({ ...identity, kind: 'route', ...overrides })).rejects.toThrow();
    expect(io.atomicUpdate).not.toHaveBeenCalled();
  });
});
