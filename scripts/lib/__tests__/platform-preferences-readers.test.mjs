// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../operator-override-reader.mjs', async importOriginal => ({
  ...await importOriginal(), readOperatorOverrides: () => ({ readable: true, values: {} }),
}));
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_FILE_MAX_BYTES } from '../platform-preferences-io.mjs';
import { loadResourcePolicy } from '../resource-admission.mjs';
import { loadResourceGateSettings } from '../resource-gate.mjs';
import { loadHostOverloadSettings, boundedText } from '../host-overload-settings.mjs';
import { resolveToolsRoot } from '../tools-root.mjs';
import { phaseAdmissionPlan, decidePhaseRemote, localPhaseBypassDetail } from '../verify-remote-routing.mjs';
import { resolveAdmissionPolicy } from '../../readiness/heavy-admission.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR, 'platform-readers-')); roots.push(root);
  mkdirSync(join(root, 'pool'));
  const path = join(root, 'prefs.json');
  const env = { WE_PLATFORM_PREFERENCES_FILE: path, WE_PLATFORM_PREFERENCES: path, LANE_POOL_ROOT: join(root, 'pool'), WE_UNDER_TEST: '1' };
  return { root, path, env };
}
it('all platform readers accept a growing settings bag above 256 KiB', () => {
  const f = fixture();
  mkdirSync(join(f.root, '.git'));
  mkdirSync(join(f.root, 'other'));
  mkdirSync(join(f.root, 'scripts'));
  writeFileSync(join(f.root, 'scripts/entry.mjs'), '// entry');
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'web-everything' }));
  writeFileSync(f.path, JSON.stringify({ padding: 'x'.repeat(300 * 1024), tools: { root: f.root },
    resourceAdmission: { build: { minCpuIdlePct: 31 } }, resourceGate: { cutover: 'shadow' }, host: { maxLoadPerCore: 7 } }));
  expect(loadResourcePolicy({ env: f.env, repoRoot: f.root }).policy.build.minCpuIdlePct).toBe(31);
  expect(loadResourceGateSettings({ env: f.env, repoRoot: f.root }).settings.cutover).toBe('shadow');
  expect(loadHostOverloadSettings({ env: f.env, toolPath: join(f.root, 'absent'), log: () => {} }).settings.host.maxLoadPerCore).toBe(7);
  expect(resolveToolsRoot({ env: f.env, ownRoot: join(f.root, 'other'), scriptRelPath: 'scripts/entry.mjs',
    git: (_root, args) => ({ status: 0, stdout: args.includes('HEAD') ? 'a'.repeat(40) : f.root }) })).toMatchObject({ active: true });
});
it('inputs beyond 4 MiB are diagnosed and host overload refuses rather than accepting incomplete evidence', () => {
  const f = fixture(); writeFileSync(f.path, ' '.repeat(PLATFORM_FILE_MAX_BYTES + 1));
  expect(loadResourcePolicy({ env: f.env, repoRoot: f.root }).sources.errors).toHaveLength(1);
  expect(loadResourceGateSettings({ env: f.env, repoRoot: f.root }).invalid.length).toBeGreaterThan(0);
  expect(() => loadHostOverloadSettings({ env: f.env, log: () => {} })).toThrow(/bounded read exceeded|file larger than/);
  expect(resolveToolsRoot({ env: f.env, ownRoot: f.root }).reason).toContain('byte limit');
});
it('a raw selected Vitest phase delegates admission when always routing is enabled at low load', async () => {
  const f = fixture();
  const command = 'npx vitest run scripts/lib/__tests__/platform-preferences-readers.test.mjs';
  const policy = resolveAdmissionPolicy({ platform: { remote: { enabled: true, mode: 'always' } } });
  const decision = await decidePhaseRemote({ cwd: f.root, env: f.env, policy,
    argv: command.split(' '), loadPerCore: () => 0.1, checkHealth: async () => ({ ok: true }) });
  expect(decision, decision.reason).toMatchObject({ remote: true });
  const plan = phaseAdmissionPlan({ command, cwd: f.root, decision, fileExists: () => true, readPackageJson: () => ({}) });
  expect(plan).toEqual({ command: `node scripts/readiness/heavy-admission.mjs run -- ${command}`, takeLocalSlot: false, setHeld: false });
});
it('raw local-only bypass detail names caller, lane and session without command values', () => {
  expect(localPhaseBypassDetail('npx vitest run private.test.mjs --config=private.config', { lane: '19', session: 'fix-session' }))
    .toBe('caller=verify-lane lane=19 session=fix-session; npx vitest run --config');
});

it('non-platform host tool settings and other files retain the 256 KiB rejection threshold', () => {
  const f = fixture(); writeFileSync(f.path, '{}');
  const toolPath = join(f.root, 'tool-settings.json');
  writeFileSync(toolPath, ' '.repeat(256 * 1024 + 1));
  expect(() => boundedText(toolPath)).toThrow('bounded read exceeded');
  expect(() => loadHostOverloadSettings({ env: f.env, toolPath, log: () => {} })).toThrow('bounded read exceeded');
});
