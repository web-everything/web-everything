import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';

const reason = 'closure-scope on-mode locked until allowlist card 7540 (xfgw4ro) lands';
let root, env, settingsPath, error;
beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'closure-lock-'));
  settingsPath = join(root, 'settings.json');
  env = { WE_PLATFORM_PREFERENCES_FILE: join(root, 'platform.json'), WE_POLICY_CASCADE_LOG: '0' };
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each(['tool', 'env', 'platform'])('locks on from %s to off with provenance and the exact reason', async source => {
  const { resolveClosureScopeMode } = await import('../daemon-rebuild/closure-scope-settings.mjs');
  if (source === 'tool') writeFileSync(settingsPath, JSON.stringify({ closureScope: { mode: 'on' } }));
  if (source === 'env') env.WE_DAEMON_CLOSURE_SCOPE = ' on ';
  if (source === 'platform') writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ closureScope: { mode: 'on' } }));
  expect(resolveClosureScopeMode(env, { settingsPath })).toEqual({ mode: 'off', source });
  const { mode } = resolveClosureScopeMode(env, { settingsPath });
  const { planRebuild } = await import('../daemon-rebuild/plan.mjs');
  const f = fixture();
  const entries = vi.fn(() => { throw new Error('must not discover scope'); });
  const plan = await planRebuild({ ...f.options, entries, closureScopeMode: mode });
  expect(plan.applied).toEqual([]);
  expect(plan.decisions).toContainEqual(expect.objectContaining({ reason: 'conflict' }));
  expect(entries).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual([[reason]]);
});

function fixture({ conflict = true } = {}) {
  const git = (args, options = {}) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, ...options });
  const ok = args => {
    const r = git(args); if (r.status !== 0) throw new Error(String(r.stderr || r.error));
    return r.stdout.trim();
  };
  const commit = files => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
    }
    ok(['add', '-A']); ok(['commit', '-qm', 'fixture']); return ok(['rev-parse', 'HEAD']);
  };
  ok(['init', '-qb', 'main']);
  const base = commit({ ...Object.fromEntries(smokeSurfaceEntries({}).map(p => [p, 'export {};\n'])),
    'entry.mjs': 'export {};\n', 'unused.mjs': '// base\n' });
  const overlay = commit({ 'added.mjs': 'export {};\n', 'unused.mjs': '// overlay\n' });
  ok(['update-ref', 'refs/remotes/origin/lane/a', overlay]);
  ok(['checkout', '-q', '--detach', base]);
  const main = commit(conflict ? { 'unused.mjs': '// main\n' } : { 'main-only.mjs': 'export {};\n' });
  ok(['update-ref', 'refs/remotes/origin/main', main]);
  return { git, ok, main, options: { git, headSha: main, mainRef: 'origin/main', overlays: [{ ref: 'lane/a' }],
    env, entries: ['entry.mjs'], stackMode: 'independent', edgeResolve: false } };
}

it.each(['explicit', 'env'])('planRebuild uses the complete off plan for an on request from %s', async source => {
  const { planRebuild } = await import('../daemon-rebuild/plan.mjs');
  const f = fixture();
  const off = await planRebuild({ ...f.options, closureScopeMode: 'off' });
  const entries = vi.fn(() => { throw new Error('must not discover scope'); });
  const on = await planRebuild({ ...f.options, entries,
    ...(source === 'explicit' ? { closureScopeMode: 'on' } : { env: { ...env, WE_DAEMON_CLOSURE_SCOPE: 'on' } }) });
  expect(on).toEqual(off);
  expect(on.applied).toEqual([]);
  expect(on.decisions).toContainEqual(expect.objectContaining({ reason: 'conflict' }));
  expect(entries).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual([[reason]]);
});

it('locked on applies the full clean overlay, including files outside the runtime closure', async () => {
  const { planRebuild } = await import('../daemon-rebuild/plan.mjs');
  const { readyBuildVerified } = await import('../daemon-rebuild/adopt.mjs');
  const f = fixture({ conflict: false });
  const entries = vi.fn(() => { throw new Error('must not discover scope'); });
  const off = await planRebuild({ ...f.options, entries, closureScopeMode: 'off' });
  const on = await planRebuild({ ...f.options, entries, closureScopeMode: 'on' });
  expect(on).toEqual(off);
  expect(on.applied).toHaveLength(1);
  expect(on.applied[0].resolvedVia).toBeUndefined();
  expect(on.applied[0].excluded).toBeUndefined();
  expect(f.ok(['show', `${on.finalSha}:unused.mjs`])).toBe('// overlay');
  expect(f.ok(['show', `${on.finalSha}:added.mjs`])).toBe('export {};');
  expect(readyBuildVerified({ git: f.git, adopt: on, mainTip: f.main, prevHead: f.main,
    env, entries, closureScopeMode: 'on' })).toBe(true);
  expect(entries).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual([[reason]]);
});

it.each(['explicit', 'env'])('readyBuildVerified treats an on request from %s as off without reading scope', async source => {
  const { readyBuildVerified } = await import('../daemon-rebuild/adopt.mjs');
  const f = fixture();
  const entries = vi.fn(() => { throw new Error('must not discover scope'); });
  const args = { git: f.git, adopt: { mainSha: f.main, finalSha: f.main, applied: [] },
    mainTip: f.main, prevHead: f.main, entries, env };
  expect(readyBuildVerified({ ...args, closureScopeMode: 'off' })).toBe(true);
  expect(readyBuildVerified({ ...args,
    ...(source === 'explicit' ? { closureScopeMode: 'on' } : { env: { ...env, WE_DAEMON_CLOSURE_SCOPE: 'on' } }) })).toBe(true);
  expect(entries).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual([[reason]]);
});

it('logs an explicit on request even when a saved scoped record refuses adoption before Git checks', async () => {
  const { readyBuildVerified } = await import('../daemon-rebuild/adopt.mjs');
  const git = vi.fn();
  expect(readyBuildVerified({ git, adopt: { applied: [{ resolvedVia: 'closure-scope', excluded: ['unused.mjs'] }] },
    entries: [], closureScopeMode: 'on' })).toBe(false);
  expect(git).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual([[reason]]);
});

it.each(['root', 'no root', 'fixed list', 'override'])('boot entry resolution locks on with %s and never discovers entries', async path => {
  const { resolveDaemonEntries, DAEMON_ENTRY_MODULES, DAEMON_ENTRIES_ENV } = await import('../daemon-boot-smoke.mjs');
  const runtimeEntries = vi.fn(() => { throw new Error('must not discover scope'); });
  const result = resolveDaemonEntries({ ...env, WE_DAEMON_CLOSURE_SCOPE: 'on',
    ...(path === 'override' ? { [DAEMON_ENTRIES_ENV]: 'custom.mjs' } : {}) },
  { ...(path === 'no root' ? {} : { root }), runtimeEntries, fixedEntriesOnly: path === 'fixed list' });
  expect(result).toEqual({ entries: path === 'override' ? ['custom.mjs'] : DAEMON_ENTRY_MODULES, overridden: path === 'override' });
  expect(runtimeEntries).not.toHaveBeenCalled();
  expect(error.mock.calls).toEqual([[reason]]);
});

it('logs the lock once across resolver, explicit consumers and boot entry resolution in the same process', async () => {
  const { resolveClosureScopeMode } = await import('../daemon-rebuild/closure-scope-settings.mjs');
  const { planRebuild } = await import('../daemon-rebuild/plan.mjs');
  const { readyBuildVerified } = await import('../daemon-rebuild/adopt.mjs');
  const { resolveDaemonEntries } = await import('../daemon-boot-smoke.mjs');
  const f = fixture();
  resolveClosureScopeMode({ ...env, WE_DAEMON_CLOSURE_SCOPE: 'on' });
  await planRebuild({ ...f.options, closureScopeMode: 'on' });
  readyBuildVerified({ git: f.git, adopt: { mainSha: f.main, finalSha: f.main },
    mainTip: f.main, prevHead: f.main, closureScopeMode: 'on' });
  resolveDaemonEntries({ ...env, WE_DAEMON_CLOSURE_SCOPE: 'on' }, { root });
  expect(error.mock.calls).toEqual([[reason]]);
});

it('keeps shadow diagnostics and the off plan intact without a lock warning', async () => {
  const { resolveClosureScopeMode } = await import('../daemon-rebuild/closure-scope-settings.mjs');
  const { planRebuild } = await import('../daemon-rebuild/plan.mjs');
  const f = fixture();
  expect(resolveClosureScopeMode({ ...env, WE_DAEMON_CLOSURE_SCOPE: 'shadow' })).toEqual({ mode: 'shadow', source: 'env' });
  const off = await planRebuild({ ...f.options, closureScopeMode: 'off' });
  const shadow = await planRebuild({ ...f.options, closureScopeMode: 'shadow' });
  expect({ ...shadow, alerts: off.alerts }).toEqual(off);
  expect(shadow.alerts).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({
    mode: 'shadow', excluded: ['unused.mjs'], message: expect.stringContaining('would resolve, excluded 1'),
  }) }));
  expect(error).not.toHaveBeenCalled();
});

it('returns off without crashing when lock logging fails', async () => {
  const { lockClosureScopeMode } = await import('../daemon-rebuild/closure-scope-settings.mjs');
  const log = vi.fn(() => { throw new Error('closed stderr'); });
  expect(lockClosureScopeMode('on', { log })).toBe('off');
  expect(lockClosureScopeMode('on', { log })).toBe('off');
  expect(log).toHaveBeenCalledTimes(1);
  expect(lockClosureScopeMode('shadow')).toBe('shadow');
  expect(lockClosureScopeMode('off')).toBe('off');
});
