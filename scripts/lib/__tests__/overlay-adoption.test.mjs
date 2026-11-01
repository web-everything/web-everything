import { describe, expect, it } from 'vitest';
import nodeFs, { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPendingAdoptions, pendingAdoptionPath, readPendingAdoptions, recordPendingAdoption } from '../overlay-adoption.mjs';

const SHA = 'a'.repeat(40);
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-'));
  return { root: join(dir, 'clone'), env: { WE_DAEMON_OVERLAY_DIR: dir } };
};
const t0 = Date.parse('2026-11-01T10:00:00.000Z');

describe('overlay adoption events', () => {
  it('emits overlay-adopted once when the sha becomes an ancestor, then forgets it', async () => {
    const { root, env } = setup();
    expect(recordPendingAdoption(root, { ref: 'lane/x', sha: SHA, at: new Date(t0).toISOString() }, { env })).toBe(true);
    const events = [];
    const args = { root, env, daemon: 'review', emit: (e) => events.push(e), now: () => t0 + 60000 };
    expect(await checkPendingAdoptions({ ...args, isAncestor: () => false })).toEqual([]);
    expect((await checkPendingAdoptions({ ...args, isAncestor: () => true })).map((e) => e.kind)).toEqual(['overlay-adopted']);
    expect(events[0]).toMatchObject({ daemon: 'review', detail: { ref: 'lane/x', sha: SHA, afterMs: 60000 } });
    expect(readPendingAdoptions(root, { env })).toEqual([]);
    expect(await checkPendingAdoptions({ ...args, isAncestor: () => true })).toEqual([]);
  });
  it('emits overlay-adoption-overdue once, keeps waiting, then still adopts', async () => {
    const { root, env } = setup();
    recordPendingAdoption(root, { ref: 'lane/x', sha: SHA, at: new Date(t0).toISOString() }, { env });
    const events = [];
    const args = { root, env, daemon: 'fix', emit: (e) => events.push(e), isAncestor: () => false };
    await checkPendingAdoptions({ ...args, now: () => t0 + 16 * 60000 });
    await checkPendingAdoptions({ ...args, now: () => t0 + 20 * 60000 });
    expect(events.map((e) => e.kind)).toEqual(['overlay-adoption-overdue']);
    await checkPendingAdoptions({ ...args, now: () => t0 + 21 * 60000, isAncestor: () => true });
    expect(events.map((e) => e.kind)).toEqual(['overlay-adoption-overdue', 'overlay-adopted']);
  });
  it('keeps a registration made while events are being written', async () => {
    const { root, env } = setup();
    recordPendingAdoption(root, { ref: 'lane/a', sha: SHA, at: new Date(t0).toISOString() }, { env });
    const sha2 = 'b'.repeat(40);
    await checkPendingAdoptions({ root, env, daemon: 'd', now: () => t0, isAncestor: () => true,
      emit: async () => { recordPendingAdoption(root, { ref: 'lane/b', sha: sha2 }, { env }); return true; } });
    expect(readPendingAdoptions(root, { env }).map((r) => r.ref)).toEqual(['lane/b']);
  });
  it('keeps the record when the event write fails, and retries next pass', async () => {
    const { root, env } = setup();
    recordPendingAdoption(root, { ref: 'lane/a', sha: SHA, at: new Date(t0).toISOString() }, { env });
    const args = { root, env, daemon: 'd', now: () => t0 + 20 * 60000 };
    expect(await checkPendingAdoptions({ ...args, isAncestor: () => false, emit: async () => false })).toEqual([]);
    expect(readPendingAdoptions(root, { env })[0].overdueSent).toBeUndefined();
    expect(await checkPendingAdoptions({ ...args, isAncestor: () => true, emit: async () => false })).toEqual([]);
    expect(readPendingAdoptions(root, { env })).toHaveLength(1);
    expect((await checkPendingAdoptions({ ...args, isAncestor: () => true, emit: async () => true })).map((e) => e.kind)).toEqual(['overlay-adopted']);
    expect(readPendingAdoptions(root, { env })).toEqual([]);
  });
  it('never overwrites existing records after a read error', () => {
    const { root, env } = setup();
    recordPendingAdoption(root, { ref: 'lane/a', sha: SHA }, { env });
    const fs = { ...nodeFs, readFileSync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } };
    expect(recordPendingAdoption(root, { ref: 'lane/b', sha: 'b'.repeat(40) }, { env, fs })).toBe(false);
    expect(readPendingAdoptions(root, { env }).map((r) => r.ref)).toEqual(['lane/a']);
  });
  it('a refreshed registration of the same ref and sha survives an older check', async () => {
    const { root, env } = setup();
    recordPendingAdoption(root, { ref: 'lane/a', sha: SHA, at: new Date(t0).toISOString() }, { env });
    await checkPendingAdoptions({ root, env, daemon: 'd', now: () => t0, isAncestor: () => true,
      emit: async () => { recordPendingAdoption(root, { ref: 'lane/a', sha: SHA, at: new Date(t0).toISOString() }, { env }); return true; } });
    expect(readPendingAdoptions(root, { env })).toHaveLength(1);
  });
  it('is best-effort: bad sha, unreadable file, throwing git or emit never throw', async () => {
    const { root, env } = setup();
    expect(recordPendingAdoption(root, { ref: 'lane/x', sha: 'abc' }, { env })).toBe(false);
    expect(await checkPendingAdoptions({ root, env, emit: () => { throw new Error('x'); } })).toEqual([]);
    recordPendingAdoption(root, { ref: 'lane/x', sha: SHA, at: new Date(t0).toISOString() }, { env });
    await expect(checkPendingAdoptions({ root, env, emit: () => { throw new Error('x'); }, isAncestor: () => { throw new Error('git'); }, now: () => t0 })).resolves.toEqual([]);
    expect(pendingAdoptionPath(root, env)).toContain('.adoption-pending.json');
  });
});
