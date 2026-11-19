import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueue, enqueueEntry, readQueue, dequeue, drainPrLimitQueue, MAX_QUEUE_ENTRIES } from '../pr-limit-queue.mjs';

const entry = (ref, sha = 'a'.repeat(40)) => ({ repoSlug: 'web-everything/web-everything', ref: `lane/${ref}`, sha,
  base: 'main', title: 'fix: queue', body: 'A real PR body', draft: false, parkLabel: 'review:human' });
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-limit-queue-'));
  const path = join(dir, 'queue.json');
  const create = vi.fn();
  const ports = { path, create, head: e => e.sha, hasPr: () => false, audit: () => ({ ok: true }),
    open: () => ({ count: 0, limit: 1 }), branchAllowed: () => false, globalOff: () => false };
  try { fn({ path, ports, create }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
describe('pr-limit queue', () => {
  it('dedupes by repo/ref with latest sha and keeps FIFO age; dequeue targets a pinned entry', () => fixture(({ path }) => {
    enqueue(entry('one'), { path, now: '2026-11-17T00:00:00Z' });
    enqueue(entry('two'), { path, now: '2026-11-18T00:00:00Z' });
    enqueue(entry('one', 'b'.repeat(40)), { path });
    expect(readQueue(path).map(e => [e.ref, e.sha])).toEqual([['lane/one', 'b'.repeat(40)], ['lane/two', 'a'.repeat(40)]]);
    dequeue(entry('one'), { path }); // stale dequeue cannot erase the newer payload
    expect(readQueue(path)).toHaveLength(2);
    dequeue(entry('one', 'b'.repeat(40)), { path });
    expect(readQueue(path)).toHaveLength(1);
  }));
  it('opens the oldest with its body/park label and stops at capacity', () => fixture(({ path, ports, create }) => {
    enqueue(entry('oldest'), { path, now: '2026-11-17T00:00:00Z' });
    enqueue(entry('newest'), { path, now: '2026-11-18T00:00:00Z' });
    expect(drainPrLimitQueue(ports).opened.map(e => e.ref)).toEqual(['lane/oldest']);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ body: 'A real PR body', parkLabel: 'review:human', draft: false }));
    expect(readQueue(path).map(e => e.ref)).toEqual(['lane/newest']);
  }));
  it.each(['moved', 'gone', 'PR exists'])('drops %s without create', kind => fixture(({ path, ports, create }) => {
    enqueue(entry('stale'), { path });
    const result = drainPrLimitQueue({ ...ports, head: e => kind === 'gone' ? null : kind === 'moved' ? 'b'.repeat(40) : e.sha,
      hasPr: () => kind === 'PR exists' });
    expect(result.dropped).toHaveLength(1); expect(create).not.toHaveBeenCalled(); expect(readQueue(path)).toEqual([]);
  }));
  it.each([1, null])('retains the queue when full or count unreadable: %s', count => fixture(({ path, ports, create }) => {
    enqueue(entry('wait'), { path });
    drainPrLimitQueue({ ...ports, open: () => ({ count, limit: 1 }) });
    expect(create).not.toHaveBeenCalled(); expect(readQueue(path)).toHaveLength(1);
  }));
  it('retains unreadable remote evidence and create failures for the next drain', () => fixture(({ path, ports }) => {
    enqueue(entry('wait'), { path });
    for (const port of ['head', 'hasPr', 'audit', 'create']) {
      expect(drainPrLimitQueue({ ...ports, [port]: () => { throw new Error('unavailable'); } }).errors).toHaveLength(1);
      expect(readQueue(path)).toHaveLength(1);
    }
  }));
  it.each([
    { ok: false, reason: 'canonical-audit-weakened' },
    { ok: false, reason: 'waiver-revoked' },
    { ok: false, reason: 'canonical-audit-missing' },
    undefined,
  ])('retains an unchanged queued SHA when its current audit is not ok: %j', verdict => fixture(({ path, ports, create }) => {
    const queued = entry('audit-blocked');
    enqueue(queued, { path });
    const audit = vi.fn(() => verdict);
    const result = drainPrLimitQueue({ ...ports, audit });
    expect(audit).toHaveBeenCalledWith({ repo: expect.any(String), ref: queued.ref, sha: queued.sha });
    expect(create).not.toHaveBeenCalled();
    expect(result.opened).toEqual([]);
    expect(readQueue(path)).toMatchObject([{ ...queued, blockedReason: verdict?.reason || 'canonical-audit-unconfirmed' }]);
    expect(drainPrLimitQueue(ports).opened).toHaveLength(1);
  }));
  it('dry-run performs no remote reads or writes, including an absent store', () => fixture(({ path, ports }) => {
    const open = vi.fn();
    expect(drainPrLimitQueue({ ...ports, open, dryRun: true }).pending).toEqual([]);
    expect(existsSync(path)).toBe(false); expect(open).not.toHaveBeenCalled();
    enqueue(entry('wait'), { path });
    drainPrLimitQueue({ ...ports, open, dryRun: true });
    expect(open).not.toHaveBeenCalled(); expect(readQueue(path)).toHaveLength(1);
  }));
  it('refuses corrupt and oversized state with an operator fallback', () => fixture(({ path, ports }) => {
    writeFileSync(path, 'null');
    expect(() => drainPrLimitQueue(ports)).toThrow(/inspect the queue file/);
    const entries = Array.from({ length: MAX_QUEUE_ENTRIES }, (_, n) => ({ ...entry(String(n)), queuedAt: '2026-11-17T00:00:00Z' }));
    expect(() => enqueueEntry(entries, entry('overflow'))).toThrow(/drain or dequeue/);
  }));
});
