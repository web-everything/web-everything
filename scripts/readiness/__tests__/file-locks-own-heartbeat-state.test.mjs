import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as locks from '../file-locks.mjs';
import { acquireFixDispatchClaim } from '../../conveyor/fix-dispatch-claim.mjs';

const NOW = Date.parse('2026-11-21T08:09:00Z');
const OWNER = 'studio:14073';
let lockRoot, resource, dir;
function snapshot(path = lockRoot) {
  return readdirSync(path).sort().map(name => {
    const full = join(path, name), stat = statSync(full);
    return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(full) : readFileSync(full).toString('base64')];
  });
}
function state(owner = OWNER) {
  const before = snapshot();
  try { return locks.ownHeartbeatState(lockRoot, resource, owner); }
  finally { expect(snapshot()).toEqual(before); }
}
function beat() {
  expect(locks.heartbeatOwn(lockRoot, resource, OWNER, new Date(NOW).toISOString())).toBe(true);
  return join(dir, readdirSync(dir).find(name => name.startsWith('hb.')));
}
beforeEach(() => {
  lockRoot = mkdtempSync(join(process.env.TMPDIR, 'own-heartbeat-state-'));
  const result = acquireFixDispatchClaim({ repo: 'we', pr: 7283, kind: 'ci-heal', owner: OWNER, nowMs: NOW, lockRoot });
  expect(result.ok).toBe(true);
  resource = result.resource;
  dir = locks.lockDirFor(lockRoot, resource);
});
afterEach(() => rmSync(lockRoot, { recursive: true, force: true }));

describe('ownHeartbeatState: absent / ok / unreadable, without writes (T19)', () => {
  it('returns absent when the owner has no heartbeat file', () => { expect(state()).toBe('absent'); });
  it('returns ok for a valid timestamp written by heartbeatOwn', () => { beat(); expect(state()).toBe('ok'); });
  it('returns absent for another owner even when this owner has refreshed', () => {
    beat(); expect(state('another:owner')).toBe('absent');
  });
  it.each(['garbage', '', '   '])('fails closed as unreadable for invalid timestamp %j', value => {
    writeFileSync(beat(), value);
    expect(state()).toBe('unreadable');
  });
  it('fails closed as unreadable when the heartbeat path is a directory (EISDIR)', () => {
    const file = beat();
    rmSync(file); mkdirSync(file);
    expect(state()).toBe('unreadable');
  });
});
