import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reserve, lockDirFor, heartbeatOwn } from '../../readiness/file-locks.mjs';
import { fixDispatchResource } from '../fix-claim-store.mjs';

const NOW = Date.parse('2026-11-20T22:18:05Z');
const MIN = 60_000;
const KINDS = ['fixing', 'fix', 'ci-heal'];
let lockRoot;
let readLiveDrainClaim;

// Snapshot names, bytes and mtimes around every read, including failing reads (T15).
function snapshot(path) {
  try {
    return readdirSync(path).sort().map(name => {
      const full = join(path, name);
      const stat = statSync(full);
      return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(full) : readFileSync(full).toString('base64')];
    });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function read(options = {}) {
  const before = snapshot(lockRoot);
  try {
    return readLiveDrainClaim({ repo: 'we', pr: 7267, lockRoot, nowMs: NOW, ...options });
  } finally {
    expect(snapshot(lockRoot)).toEqual(before);
  }
}
function claim(kind, { repo = 'we', pr = 7267, age = 0, owner = 'studio:83231', meta = {} } = {}) {
  const resource = fixDispatchResource({ repo, pr, kind });
  const iso = new Date(NOW - age).toISOString();
  reserve(lockRoot, resource, owner, NOW - age, iso, null, 'unknown', 10,
    { host: 'studio', sessionId: 'heal-session', repo, pr, kind, headSha: 'abc123', claimedAt: iso, ...meta });
  return { resource, file: join(lockDirFor(lockRoot, resource), 'lock.json') };
}

beforeEach(async () => {
  lockRoot = mkdtempSync(join(process.env.TMPDIR, 'drain-claim-'));
  ({ readLiveDrainClaim } = await import('../fix-procedure.mjs'));
});
afterEach(() => rmSync(lockRoot, { recursive: true, force: true }));

describe('drain claim reader', () => {
  it('drain claim reader: a live ci-heal dispatch claim with no meta.who is held', () => {
    claim('ci-heal');
    expect(typeof readLiveDrainClaim).toBe('function');
    expect(read()).toMatchObject({ kind: 'ci-heal', owner: 'studio:83231', holder: 'studio:83231',
      claimedAt: new Date(NOW).toISOString(), heartbeatAt: new Date(NOW).toISOString(),
      uncertain: false, heldKinds: ['ci-heal'], entry: { meta: { who: 'studio:83231' } } });
  });
  it.each(KINDS)('T1/T2: live %s is held regardless of owner identity', kind => {
    claim(kind, { owner: 'unrelated:BEHIND cap' });
    expect(read()).toMatchObject({ kind, holder: 'unrelated:BEHIND cap', uncertain: false, heldKinds: [kind] });
  });
  it('normalises a recorded who as the holder', () => {
    claim('fixing', { meta: { who: 'fix-7267' } });
    expect(read()).toMatchObject({ holder: 'fix-7267', entry: { meta: { who: 'fix-7267' } } });
  });
  it('T3: expired fixing yields to live ci-heal', () => {
    claim('fixing', { age: 21 * MIN });
    claim('ci-heal');
    expect(read()).toMatchObject({ kind: 'ci-heal', heldKinds: ['ci-heal'] });
  });
  it('all live kinds are collected in fixed order', () => {
    for (const kind of [...KINDS].reverse()) claim(kind);
    expect(read()).toMatchObject({ kind: 'fixing', heldKinds: KINDS });
  });
  it('T4: all absent returns null', () => expect(read()).toBeNull());
  it('T4: all expired returns null', () => {
    for (const kind of KINDS) claim(kind, { age: 21 * MIN });
    expect(read()).toBeNull();
  });
  it.each(KINDS)('T5: %s is held at TTL and expires one millisecond later', kind => {
    const ttl = kind === 'fixing' ? 20 : 10;
    claim(kind, { age: ttl * MIN });
    expect(read()).toMatchObject({ kind, uncertain: false });
    expect(read({ nowMs: NOW + 1 })).toBeNull();
  });
  it('T6: fixing honours its stored 45-minute TTL at 30 minutes', () => {
    claim('fixing', { age: 30 * MIN, meta: { ttlMinutes: 45 } });
    expect(read()).toMatchObject({ kind: 'fixing', uncertain: false });
  });
  it('T7: owner hb file extends an expired dispatch heartbeat', () => {
    const { resource } = claim('ci-heal', { age: 11 * MIN });
    heartbeatOwn(lockRoot, resource, 'studio:83231', new Date(NOW).toISOString());
    expect(read()).toMatchObject({ kind: 'ci-heal', heartbeatAt: new Date(NOW).toISOString(), uncertain: false });
  });
  for (const kind of KINDS) {
    it.each(['truncated', 'missing'])('T8: ' + kind + ' %s entry fails closed', state => {
      const { file } = claim(kind);
      if (state === 'missing') unlinkSync(file);
      else writeFileSync(file, '{');
      expect(read()).toMatchObject({ kind, uncertain: 'unreadable-entry', heldKinds: [kind],
        entry: { meta: { who: '(' + kind + ' claim)' } } });
    });
    it('T12: ' + kind + ' invalid heartbeat fails closed', () => {
      const { file } = claim(kind);
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      entry.heartbeatAt = 'garbage';
      writeFileSync(file, JSON.stringify(entry));
      expect(read()).toMatchObject({ kind, uncertain: 'invalid-heartbeat' });
    });
  }
  it.each(['EACCES', 'EIO'])('T9: probe %s fails closed', code => {
    expect(read({ probe: () => { throw Object.assign(new Error(code), { code }); } }))
      .toMatchObject({ kind: 'fixing', uncertain: 'probe-error:' + code, heldKinds: KINDS });
  });
  it('T10: missing store fails closed', () => {
    rmSync(lockRoot, { recursive: true });
    expect(read()).toMatchObject({ uncertain: 'store-missing', heldKinds: KINDS });
  });
  it('T11: entry vanishes between read and probe while root remains', () => {
    const { file } = claim('fixing');
    writeFileSync(file, '{');
    const probes = [];
    // Simulate the keyed directory vanishing after the null read, without a reader-side write.
    expect(read({ probe: path => {
      probes.push(path);
      if (path !== lockRoot) throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
      return statSync(path);
    } })).toBeNull();
    expect(probes).toContain(lockRoot);
  });
  it('T13: slug normalises to we, other repositories and PRs do not block', () => {
    claim('ci-heal', { repo: 'frontierui' });
    claim('fix', { pr: 7268 });
    expect(read()).toBeNull();
    claim('ci-heal');
    expect(read({ repo: 'web-everything/web-everything' })).toMatchObject({ kind: 'ci-heal' });
  });
  it('T14: unknown repo throws TypeError', () => {
    expect(() => read({ repo: 'unknown/repository' })).toThrow(TypeError);
  });
});
