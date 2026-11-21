import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as procedure from '../fix-procedure.mjs';
import { acquireFixDispatchClaim, fixDispatchSessionName, refreshLiveFixDispatchClaims } from '../fix-dispatch-claim.mjs';
import { heartbeatOwn, lockDirFor, readLockEntry } from '../../readiness/file-locks.mjs';

const NOW = Date.parse('2026-11-21T08:09:00Z');
const MIN = 60_000;
const OWNER = 'studio:14073';
let lockRoot;
function snapshot(path = lockRoot) {
  return readdirSync(path).sort().map(name => {
    const full = join(path, name), stat = statSync(full);
    return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(full) : readFileSync(full).toString('base64')];
  });
}
// T19 applies even when the reader returns null or an assertion fails.
function read(options = {}) {
  const before = snapshot();
  try { return procedure.readLiveDrainClaim({ repo: 'we', pr: 7283, lockRoot, nowMs: NOW, ...options }); }
  finally { expect(snapshot()).toEqual(before); }
}
function claim({ kind = 'ci-heal', age = 0, ...extra } = {}) {
  const result = acquireFixDispatchClaim({ repo: 'we', pr: 7283, kind, owner: OWNER,
    lockRoot, nowMs: NOW - age, ...extra });
  expect(result.ok).toBe(true);
  return { resource: result.resource, dir: lockDirFor(lockRoot, result.resource) };
}
function rewriteMeta(resource, edit) {
  const file = join(lockDirFor(lockRoot, resource), 'lock.json');
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  edit(entry.meta);
  writeFileSync(file, JSON.stringify(entry));
}
function ownBeat(resource, dir, value) {
  expect(heartbeatOwn(lockRoot, resource, OWNER, new Date(NOW).toISOString())).toBe(true);
  const file = join(dir, readdirSync(dir).find(name => name.startsWith('hb.')));
  if (value === 'directory') { rmSync(file); mkdirSync(file); }
  else writeFileSync(file, value);
}
beforeEach(() => { lockRoot = mkdtempSync(join(process.env.TMPDIR, 'drain-claim-lease-')); });
afterEach(() => rmSync(lockRoot, { recursive: true, force: true }));

describe('drain heartbeat and lease evidence (read-only)', () => {
  for (const kind of ['ci-heal', 'fix', 'fixing']) {
    it.each(['garbage', 'directory'])(`T13/T19: expired ${kind} with %s own heartbeat fails closed`, state => {
      // The real dispatch writer accepts fixing as a resource kind too; no synthetic store implementation.
      const { resource, dir } = claim({ kind, age: 21 * MIN });
      ownBeat(resource, dir, state);
      expect(read()).toMatchObject({ kind, uncertain: 'unreadable-heartbeat' });
    });
  }
  it('T14/T19: absent own heartbeat and expired lock.json do not over-hold', () => {
    claim({ age: 11 * MIN });
    expect(read()).toBeNull();
  });
  it('T15/T19: a valid later own heartbeat extends an expired lock.json', () => {
    const { resource } = claim({ age: 11 * MIN });
    expect(heartbeatOwn(lockRoot, resource, OWNER, new Date(NOW - MIN).toISOString())).toBe(true);
    expect(read()).toMatchObject({ kind: 'ci-heal', uncertain: false, heartbeatAt: new Date(NOW - MIN).toISOString() });
  });
  for (const kind of ['ci-heal', 'fix']) {
    it.each(['', false, 0, '   '])(`${kind}: invalid meta.who %j falls back to the owner`, who => {
      const { resource } = claim({ kind });
      rewriteMeta(resource, meta => { meta.who = who; });
      expect(read()).toMatchObject({ kind, holder: OWNER, uncertain: false, entry: { meta: { who: OWNER } } });
    });
    it(`${kind}: no non-empty holder string retains an uncertain hold`, () => {
      const { dir } = claim({ kind });
      const file = join(dir, 'lock.json');
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      entry.owner = '   ';
      entry.meta.who = false;
      writeFileSync(file, JSON.stringify(entry));
      expect(read()).toMatchObject({ kind, holder: `(${kind} claim)`, uncertain: 'missing-holder',
        entry: { meta: { who: `(${kind} claim)` } } });
    });
    it.each(['bad', '', 0, -1, null, false, true, {}, [], 'Infinity'])
      (`${kind}: present invalid lease %j holds past the default TTL`, leaseMinutes => {
        const { resource } = claim({ kind, age: 30 * MIN });
        rewriteMeta(resource, meta => { meta.leaseMinutes = leaseMinutes; });
        expect(read()).toMatchObject({ kind, uncertain: 'invalid-lease' });
      });
    it(`T16/T19: ${kind} stored 45-minute lease is held at 30 minutes`, () => {
      const { resource } = claim({ kind, age: 30 * MIN, leaseMinutes: 45 });
      // Isolate reader semantics from T18's separate producer-persistence guarantee.
      rewriteMeta(resource, meta => { meta.leaseMinutes = 45; });
      expect(read()).toMatchObject({ kind, uncertain: false });
    });
    it(`T16/T19: ${kind} stored 5-minute lease cannot shorten the default at 8 minutes`, () => {
      const { resource } = claim({ kind, age: 8 * MIN, leaseMinutes: 5 });
      rewriteMeta(resource, meta => { meta.leaseMinutes = 5; });
      expect(read()).toMatchObject({ kind, uncertain: false });
    });
    it(`T17/T19: historical ${kind} without leaseMinutes expires at 11 minutes`, () => {
      const { resource } = claim({ kind, age: 11 * MIN });
      rewriteMeta(resource, meta => { delete meta.leaseMinutes; });
      expect(read()).toBeNull();
    });
  }
  it('T18: the real writer persists leaseMinutes=45 and the live-session sweep preserves it', () => {
    const { resource } = claim({ leaseMinutes: 45, sessionId: 'live-session' });
    const acquired = readLockEntry(lockRoot, resource);
    const result = refreshLiveFixDispatchClaims({ lockRoot, nowMs: NOW + MIN,
      nowIso: () => new Date(NOW + MIN).toISOString(),
      listAgentsAll: () => [{ name: fixDispatchSessionName({ repo: 'we', pr: 7283, kind: 'ci-heal' }),
        sessionId: 'live-session', state: 'working', startedAt: new Date(NOW).toISOString() }],
      awaitingVerifyFor: () => null, idleRelease: { enabled: false },
      hungInfoFor: () => null, recordEvent: () => {},
    });
    // Use an actual bound live session rather than letting the empty roster silently skip renewal.
    expect(result.refreshed).toHaveLength(1);
    const refreshed = readLockEntry(lockRoot, resource);
    expect(refreshed.heartbeatAt).toBe(new Date(NOW + MIN).toISOString());
    expect(acquired.meta.leaseMinutes).toBe(45);
    expect(refreshed.meta.leaseMinutes).toBe(45);
  });
});
