/**
 * R320 perf fix #1 — the gh shim must not fan out into a process chain per call.
 * Before: shim node -> /bin/ps -> git remote get-url -> throttle node -> gh (5 processes per call; 6 for a daemon).
 * After: shim node (throttle runs in-process) -> ps -> git -> gh.
 * Counting is real: a --require preload logs every child process any node process in the chain spawns.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderGhShimScript } from '../gh-app-shim.mjs';

const CLEAN = {
  WE_GH_DAEMON_CALLER: undefined, XPC_SERVICE_NAME: undefined, WE_GH_AUTH_PERSONAL_FALLBACK: undefined,
  GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CALLER: undefined, GH_REPO: undefined, CLAUDE_CODE_SESSION_ID: undefined,
};
const CALLS = 20;

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'we-gh-shim-perf-')));
  const realGh = join(dir, 'real-gh');
  writeFileSync(realGh, '#!/bin/sh\necho ok\n');
  chmodSync(realGh, 0o755);
  const cachePath = join(dir, 'cache.json');
  writeFileSync(cachePath, JSON.stringify({ v: 2, token: 'ghs_perf', expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
  const shimPath = join(dir, 'gh');
  writeFileSync(shimPath, renderGhShimScript({ realGhPath: realGh, cachePath }));
  chmodSync(shimPath, 0o755);
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  spawnSync('/usr/bin/git', ['init', '-q'], { cwd: repo });
  spawnSync('/usr/bin/git', ['remote', 'add', 'origin', 'git@github.com:chalbert/web-everything.git'], { cwd: repo });
  const log = join(dir, 'spawns.log');
  const preload = join(dir, 'count.cjs');
  writeFileSync(preload, `const cp = require('node:child_process'); const fs = require('node:fs');
for (const name of ['spawnSync', 'spawn']) { const orig = cp[name]; cp[name] = function (file, ...rest) {
  try { fs.appendFileSync(${JSON.stringify(log)}, require('node:path').basename(String(file)) + '\\n'); } catch {}
  return orig.call(this, file, ...rest); }; }
`);
  // The driver is the stable parent (like a daemon), making CALLS shim calls from one pid.
  const driver = join(dir, 'driver.cjs');
  writeFileSync(driver, `const { spawnSync } = require('node:child_process');
for (let i = 0; i < ${CALLS}; i++) { const r = spawnSync(${JSON.stringify(shimPath)}, ['api', 'ping'], { cwd: ${JSON.stringify(repo)}, encoding: 'utf8',
  env: Object.assign({}, process.env, { NODE_OPTIONS: '--require ' + ${JSON.stringify(preload)} }) });
  if (r.status !== 0 || r.stdout.trim() !== 'ok') { console.error(r.stderr, r.stdout); process.exit(1); } }
`);
  return { dir, driver, log, repo, real: realGh, cachePath };
}

describe('gh shim process fan-out (R320 #1)', () => {
  it(`spawns no second (throttle) node over ${CALLS} calls: ps + git + gh only`, () => {
    const f = fixture();
    try {
      const env = { ...process.env, ...CLEAN, WE_GH_THROTTLE_LOCK_ROOT: join(f.dir, 'locks'), LANE_POOL_ROOT: undefined };
      const r = spawnSync(process.execPath, [f.driver], { env, encoding: 'utf8', timeout: 120000 });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const spawns = readFileSync(f.log, 'utf8').split('\n').filter(Boolean);
      const count = (name) => spawns.filter((s) => s === name).length;
      expect(spawns.filter((s) => /^node/.test(s))).toEqual([]);
      expect(count('git')).toBe(CALLS);
      expect(count('ps')).toBe(CALLS);
      expect(count('real-gh')).toBe(CALLS);
      expect(spawns.length).toBe(3 * CALLS);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }, 150000);
});

describe('in-process throttle load failures', () => {
  it('a throttle module that throws on load fails like the old child (status 1, loader diagnostics), never an unthrottled bypass; a missing one still falls back', () => {
    const f = fixture();
    try {
      const broken = join(f.dir, 'broken-throttle.mjs');
      writeFileSync(broken, 'export function runGhCliPassthrough() {}\nthrow new Error("boom at load");\n');
      const mk = (cli) => { const p = join(f.dir, 'gh-' + Math.random().toString(36).slice(2)); writeFileSync(p, renderGhShimScript({ realGhPath: f.real, cachePath: f.cachePath, ghThrottleCliPath: cli })); chmodSync(p, 0o755); return p; };
      const env = { ...process.env, ...CLEAN, WE_GH_THROTTLE_LOCK_ROOT: join(f.dir, 'locks'), LANE_POOL_ROOT: undefined };
      const bad = spawnSync(mk(broken), ['api', 'ping'], { cwd: f.repo, env, encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toBe('');
      expect(bad.stderr).toContain('boom at load');
      const gone = spawnSync(mk(join(f.dir, 'nope', 'gh-throttle.mjs')), ['api', 'ping'], { cwd: f.repo, env, encoding: 'utf8' });
      expect(gone.status).toBe(0);
      expect(gone.stdout.trim()).toBe('ok');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
