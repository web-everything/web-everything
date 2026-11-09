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


// ── The production file-backed storage, against a real temp directory ─────────────────────────────────────
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { mqFailureLedgerStorage } from '../mq-failure-ledger.mjs';
import { acquireLockDir } from '../../readiness/file-locks.mjs';

describe('mq failure ledger production storage (real filesystem)', () => {
  const roots = [];
  const freshRoot = () => { const root = mkdtempSync(join(tmpdir(), 'mq-ledger-test-')); roots.push(root); return root; };
  afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
  const files = root => ({ dir: join(root, 'mq-failure-recovery'), file: join(root, 'mq-failure-recovery', 'ledger.json'),
    locks: join(root, 'mq-failure-recovery', 'locks') });
  const seed = (root, bytes) => { const { dir, file } = files(root); mkdirSync(dir, { recursive: true }); writeFileSync(file, bytes); };

  it('persists a claim durably and refuses the same head from an independent ledger instance', async () => {
    const root = freshRoot();
    const first = createMqFailureLedger({ io: mqFailureLedgerStorage(root) });
    const second = createMqFailureLedger({ io: mqFailureLedgerStorage(root) });
    expect(await claim(first)).toEqual({ claimed: true });
    expect(await claim(second)).toMatchObject({ claimed: false });
    expect(Object.values(JSON.parse(readFileSync(files(root).file, 'utf8')))).toEqual([true]);
    expect(readdirSync(files(root).dir).filter(name => name.startsWith('ledger-'))).toEqual([]); // no temp left behind
    expect(readdirSync(files(root).locks)).toEqual([]); // lock released
  });

  it('production storage refuses an existing lock without reclaiming it', async () => {
    const root = freshRoot();
    const { dir, file, locks } = files(root);
    const ledger = createMqFailureLedger({ io: mqFailureLedgerStorage(root) });
    expect(await claim(ledger, 'route', { pr: 7 })).toEqual({ claimed: true });
    const bytesBefore = readFileSync(file);
    mkdirSync(dir, { recursive: true });
    expect(acquireLockDir(locks, 'ledger', { owner: 'other-dispatcher', pid: 1, heartbeatAt: '2000-01-01T00:00:00.000Z' })).toBe(true);
    const lockBefore = readFileSync(join(locks, readdirSync(locks)[0], 'lock.json'), 'utf8');
    await expect(claim(ledger, 'route', { pr: 8 })).rejects.toThrow(/busy/);
    // An old heartbeat is still not reclaimed: the held lock and the ledger are byte-for-byte unchanged.
    expect(readFileSync(join(locks, readdirSync(locks)[0], 'lock.json'), 'utf8')).toBe(lockBefore);
    expect(readFileSync(file).equals(bytesBefore)).toBe(true);
  });

  it.each([
    ['unparseable JSON', Buffer.from('{not json')],
    ['a non-true value', Buffer.from('{"k":1}')],
    ['an array', Buffer.from('[]')],
    ['null', Buffer.from('null')],
  ])('a corrupt ledger (%s) is rejected and left untouched, with the lock released', async (_name, bytes) => {
    const root = freshRoot();
    seed(root, bytes);
    const ledger = createMqFailureLedger({ io: mqFailureLedgerStorage(root) });
    await expect(claim(ledger)).rejects.toThrow();
    expect(readFileSync(files(root).file).equals(bytes)).toBe(true);
    expect(readdirSync(files(root).locks)).toEqual([]);
  });

  it('a ledger file over 8 MB is rejected before it is read', async () => {
    const root = freshRoot();
    seed(root, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    const readFile = vi.fn(() => { throw new Error('the oversized ledger must not be read'); });
    const ledger = createMqFailureLedger({ io: mqFailureLedgerStorage(root, { readFile }) });
    await expect(claim(ledger)).rejects.toThrow(/oversized/);
    expect(readFile).not.toHaveBeenCalled(); // observable: rejection happens on the size, before any content read
    expect(readdirSync(files(root).locks)).toEqual([]);
  });

  it('a ledger file at the 8 MB limit is still read (the spy sees the read, so the previous test discriminates)', async () => {
    const root = freshRoot();
    seed(root, Buffer.from('{}'));
    const readFile = vi.fn(path => readFileSync(path, 'utf8'));
    const ledger = createMqFailureLedger({ io: mqFailureLedgerStorage(root, { readFile }) });
    expect(await claim(ledger)).toMatchObject({ claimed: true });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('a transaction that would grow the ledger past 8 MB is rejected and nothing is written', async () => {
    const root = freshRoot();
    const storage = mqFailureLedgerStorage(root);
    expect(() => storage.atomicUpdate(state => ({ state: { ...state, ['k'.repeat(8 * 1024 * 1024)]: true }, result: 1 }))).toThrow(/oversized/);
    expect(existsSync(files(root).file)).toBe(false);
  });

  it('exactly one of many claims for the same head wins across independent ledgers', async () => {
    const root = freshRoot();
    const ledgers = Array.from({ length: 6 }, () => createMqFailureLedger({ io: mqFailureLedgerStorage(root) }));
    const results = await Promise.all(ledgers.map(ledger => claim(ledger, 'refresh')));
    expect(results.filter(result => result.claimed)).toHaveLength(1);
  });
});
