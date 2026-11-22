import { it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isLeaseStale } from '../lib/lane-lease.mjs';

const script = resolve('scripts/lane-pool.mjs');
const hooks = resolve('.githooks');
let base, root, lane, marker, lease;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'renew-assert-'));
  root = join(base, 'pool'); lane = join(root, 'renewal', 'lane-1');
  mkdirSync(join(lane, '.git'), { recursive: true });
  marker = join(lane, '.git', '.lane-lease');
  lease = { holder: 'holder', session: 'worker', ownerSession: 'owner', acquiredAt: new Date().toISOString(), ttlMinutes: 1 };
  save();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
function save() { writeFileSync(marker, JSON.stringify(lease)); }
function run(args, extra = {}, cwd = lane) {
  return spawnSync('node', [script, ...args], { cwd, env: { ...process.env, LANE_POOL_ROOT: root, LANE_SESSION: 'holder', CLAUDE_CODE_SESSION_ID: '', ...extra }, encoding: 'utf8', timeout: 10000 });
}
const read = () => JSON.parse(readFileSync(marker));
it.each(['expired', 'absent'])('assert-lease refuses an %s lease, even with an attempted env bypass', state => {
  if (state === 'absent') rmSync(marker);
  else { lease.acquiredAt = new Date(Date.now() - 120000).toISOString(); save(); }
  const r = run(['assert-lease'], { LANE_LEASE_ASSERT: '0' });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('lane-1 lease expired/absent: you no longer hold this lane. Re-acquire (lane-pool.mjs acquire) before committing or pushing.');
});
it('assert-lease refuses a different LANE_SESSION against a live lease', () => {
  const r = run(['assert-lease'], { LANE_SESSION: 'intruder' });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('lane-1 is now leased to holder, not intruder: refusing to write');
  expect(read()).toEqual(lease);
});
it.each(['holder', 'worker', 'owner', ''])('a live holder (%s) is kept and auto-renewed', session => {
  const r = run(['assert-lease'], { LANE_SESSION: session });
  expect(r.status, r.stderr).toBe(0);
  expect(read().holder).toBe('holder');
  expect(Date.parse(read().renewedAt)).toBeGreaterThanOrEqual(Date.parse(lease.acquiredAt));
});
it('assert-lease is a no-op outside a lane clone', () => {
  expect(run(['assert-lease'], {}, base).status).toBe(0);
});
it('assert-lease fails open with a warning on unexpected read errors', () => {
  rmSync(marker); mkdirSync(marker);
  const r = run(['assert-lease']);
  expect(r.status).toBe(0); expect(r.stderr).toMatch(/warning/i);
});
it('renew by a non-holder is refused without changing the marker', () => {
  const r = run(['renew', '--lane=1', '--pool=renewal', '--session=intruder']);
  expect(r.status).toBe(1); expect(r.stderr).toMatch(/not yours|held by/);
  expect(read()).toEqual(lease);
});
it('renew extends a just-expired lease past its original short TTL', () => {
  lease.ttlMinutes = 0.01;
  lease.acquiredAt = new Date(Date.now() - 2000).toISOString(); save();
  expect(isLeaseStale(lease, Date.now())).toBe(true);
  const r = run(['renew', '--lane=1', '--pool=renewal', '--session=holder', '--json']);
  expect(r.status, r.stderr).toBe(0);
  const next = read();
  expect(next.holder).toBe('holder'); expect(next.acquiredAt).toBe(lease.acquiredAt);
  expect(isLeaseStale(next, Date.parse(next.renewedAt) + 300)).toBe(false);
});
it.each(['absent', 'reserved'])('renew refuses an %s lease', state => {
  if (state === 'absent') rmSync(marker); else { lease.reserved = true; save(); }
  const r = run(['renew', '--lane=1', '--pool=renewal']);
  expect(r.status).toBe(1); expect(r.stderr).toMatch(/absent|reserved/);
});
it('renew accepts ownerSession and persists an explicit TTL', () => {
  const r = run(['renew', '--lane=1', '--pool=renewal', '--session=owner', '--ttl-minutes=2', '--json']);
  expect(r.status, r.stderr).toBe(0); expect(read().ttlMinutes).toBe(2);
});

it('assert-lease preserves a reserved lease unchanged', () => {
  lease.reserved = true; save();
  const r = run(['assert-lease']);
  expect(r.status, r.stderr).toBe(0); expect(read()).toEqual(lease);
});
it('assert-lease finds the lane from a nested cwd', () => {
  const nested = join(lane, 'nested'); mkdirSync(nested);
  const r = run(['assert-lease'], {}, nested);
  expect(r.status, r.stderr).toBe(0); expect(read().renewedAt).toBeTruthy();
});
it.each(['pre-commit', 'pre-push'])('%s runs assert-lease before other guards and propagates refusal', hook => {
  const bin = join(base, 'bin'); mkdirSync(bin);
  const calls = join(base, 'calls');
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOOK_CALLS"\nexit 1\n');
  chmodSync(join(bin, 'node'), 0o755);
  const r = spawnSync('sh', [join(hooks, hook)], { cwd: lane, input: 'refs/heads/lane/x abc refs/heads/lane/x def\n', encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOOK_CALLS: calls } });
  expect(r.status).toBe(1);
  expect(readFileSync(calls, 'utf8')).toBe('scripts/lane-pool.mjs assert-lease\n');
});
it('pre-push preserves stdin for both existing guards after lease assertion', () => {
  const bin = join(base, 'bin'); mkdirSync(bin);
  const calls = join(base, 'calls');
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOOK_CALLS"\ncase "$1" in *guard-*) cat >> "$HOOK_CALLS";; esac\n');
  chmodSync(join(bin, 'node'), 0o755);
  const payload = 'refs/heads/lane/x abc refs/heads/lane/x def';
  const r = spawnSync('sh', [join(hooks, 'pre-push')], { cwd: lane, input: `${payload}\n`, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOOK_CALLS: calls } });
  expect(r.status, r.stderr).toBe(0);
  const recorded = readFileSync(calls, 'utf8');
  expect(recorded.indexOf('assert-lease')).toBeLessThan(recorded.indexOf('guard-git-push'));
  expect(recorded.split(payload)).toHaveLength(3);
});

it('assert-lease fails open on an unexpected atomic-write error and restores the marker', () => {
  const preload = join(base, 'fail-write.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFileSync;
fs.writeFileSync = function(file, ...args) {
  if (String(file).includes('.lane-lease.tmp-')) throw new Error('injected disk error');
  return write.call(this, file, ...args);
};
syncBuiltinESMExports();
`);
  const r = run(['assert-lease'], { NODE_OPTIONS: `--import=${preload}` });
  expect(r.status, r.stderr).toBe(0); expect(r.stderr).toMatch(/WARNING.*injected disk error/);
  expect(read()).toEqual(lease);
});
