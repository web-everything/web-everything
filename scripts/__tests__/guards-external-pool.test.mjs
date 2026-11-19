import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { laneRootFromCwd, isLaneCwd } from '../guard-bash.mjs';
import { workspaceRootOf } from '../guard-lane.mjs';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'external-pool-guards-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home');
const primary = join(home, 'workspace', 'web-everything');
const pool = join(root, 'volume', '.lanes');
const lane = join(pool, 'web-everything', 'lane-1');
const bin = join(root, 'bin');
for (const dir of [primary, join(lane, '.git'), bin]) mkdirSync(dir, { recursive: true });
// Only the guard's read-only staleness probe is simulated. No Git state is changed.
writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1" = rev-list ]; then echo 1; else exit 1; fi\n', { mode: 0o755 });
const env = { ...process.env, HOME: home, LANE_POOL_ROOT: pool, WE_HOOK_ROOT: lane,
  LANE_GUARD_OFF: '', CLAUDE_CODE_SESSION_ID: 'mine', WE_DISPATCH_KIND: '', WE_CONVEYOR_WORKER: '',
  PATH: bin + ':' + process.env.PATH };
function hook(script, tool_input, cwd = lane) {
  return spawnSync(process.execPath, [resolve('scripts', script)], {
    input: JSON.stringify({ tool_input, cwd, session_id: 'mine' }), cwd,
    env, encoding: 'utf8', timeout: 15_000,
  });
}
function lease(overrides = {}) {
  writeFileSync(join(lane, '.git', '.lane-lease'), JSON.stringify({
    session: 'test', ownerSession: 'other', workerSession: 'other', purpose: 'external test',
    acquiredAt: new Date().toISOString(), ttlMinutes: 240, ...overrides,
  }));
}
it('external .lanes paths retain lane recognition and resolve the real primary workspace', () => {
  expect(isLaneCwd(lane)).toBe(true);
  expect(laneRootFromCwd(join(lane, 'src', 'file'))).toBe(lane);
  expect(workspaceRootOf(lane, env, { prefs: {}, tool: {}, log: () => {} })).toBe(join(home, 'workspace'));
});
it('external lane foreign-occupant edits are denied by the real Edit hook', () => {
  lease();
  const result = hook('guard-lane.mjs', { file_path: join(lane, 'file') });
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toMatch(/DIFFERENT session/);
});
it('primary-checkout edits from an external lane are still denied', () => {
  const result = hook('guard-lane.mjs', { file_path: join(primary, 'file') });
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toMatch(/PRIMARY checkout/);
});
it('external lane Bash destructive operations still check the on-disk lease', () => {
  lease();
  const result = hook('guard-bash.mjs', { command: 'git reset --hard origin/main' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/lease|session/i) });
});
it('external lane Bash mutations still run the staleness probe', () => {
  const result = hook('guard-bash.mjs', { command: 'node scripts/backlog.mjs claim 123' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/1 commit.*behind/) });
});
it('Bash rooted in an external lane still protects primary checkout mutations', () => {
  const result = hook('guard-bash.mjs', { command: 'node scripts/backlog.mjs claim 123' }, primary);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/primary checkout/) });
});
