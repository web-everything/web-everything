import { it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { readRebuildState } from '../daemon-rebuild/state.mjs';
import { planRebuild } from '../daemon-rebuild/plan.mjs';
import { readyBuildVerified } from '../daemon-rebuild/adopt.mjs';
import { resolveClosureScopeMode, smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { addOverlay } from '../daemon-overlays.mjs';
import * as cloneEntries from '../daemon-clone-entries.mjs';
import * as edgeFetch from '../daemon-rebuild/edge-fetch.mjs';
import * as closureScope from '../daemon-rebuild/closure-scope.mjs';
import { resolveClosureScopedConflict, resolveOverlayConflict } from '../daemon-rebuild/overlay-strategies.mjs';

const temps = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture({ path = 'unused.mjs', entry = '', noop = false, files = {}, mainFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'closure-apply-')); temps.push(root);
  const git = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd: root, encoding: 'utf8', timeout: 20000, ...opts, env: { ...process.env, ...opts.env } });
  const ok = args => { const r = git(args); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const write = (p, text) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
  const commit = (files, ref) => { for (const [p, text] of Object.entries(files)) write(p, text);
    ok(['add', '-A']); ok(['commit', '-qm', ref]); const sha = ok(['rev-parse', 'HEAD']);
    ok(['update-ref', `refs/remotes/origin/${ref}`, sha]); return sha; };
  const content = label => path.endsWith('.json') ? JSON.stringify({ name: label }) + '\n' : `// ${label}\n`;
  ok(['init', '-qb', 'main']);
  const base = commit({ ...Object.fromEntries(smokeSurfaceEntries({}).map(p => [p, 'export {};\n'])),
    'entry.mjs': entry, [path]: content('base'), ...files }, 'main');
  const overlay = commit({ [path]: content('overlay'), ...(!noop ? { 'new.mjs': 'export {};\n',
    'entry.mjs': entry + "\nimport './new.mjs';\n" } : {}) }, 'lane/a');
  ok(['checkout', '-q', '--detach', base]);
  const main = commit({ [path]: content('main'), ...mainFiles }, 'main');
  const args = { git, headSha: main, mainRef: 'origin/main', overlays: [{ ref: 'lane/a' }],
    entries: ['entry.mjs'], env: {}, closureScopeMode: 'on', stackMode: 'independent' };
  return { root, git, ok, commit, args, main, overlay, base };
}

// Mint a historical record directly: the locked planner must never create new scoped builds.
function savedScopedCandidate(f) {
  const evidence = closureScope.computeClosureScope({ git: f.git, mainSha: f.main,
    overlays: [{ sha: f.overlay, changedFiles: ['entry.mjs', 'new.mjs', 'unused.mjs'] }],
    entries: ['entry.mjs'], env: {} });
  expect(evidence.ok).toBe(true);
  const resolved = resolveClosureScopedConflict({ git: f.git, cur: f.main, ovSha: f.overlay, scope: evidence.scope });
  expect(resolved).toMatchObject({ ok: true, excluded: ['unused.mjs'] });
  const finalSha = f.ok(['commit-tree', resolved.tree, '-p', f.main, '-p', f.overlay, '-m', 'historical scoped build']);
  return { mainSha: f.main, finalSha, applied: [{ ref: 'lane/a', sha: f.overlay,
    resolvedVia: 'closure-scope', excluded: resolved.excluded }] };
}

it('locked on retains the full-merge conflict instead of excluding unused files', async () => {
  const f = fixture();
  const p = await planRebuild(f.args);
  expect(p).toEqual(await planRebuild({ ...f.args, closureScopeMode: 'off' }));
  expect(p.applied).toEqual([]);
  expect(p.finalSha).toBe(f.main);
  expect(p.decisions).toContainEqual(expect.objectContaining({ action: 'drop', reason: 'conflict' }));
});

it('locked on retains a conflicted addition absent from the merge base', async () => {
  const f = fixture();
  f.ok(['checkout', '-q', '--detach', f.overlay]);
  f.commit({ 'added.mjs': '// overlay\n' }, 'lane/a');
  f.ok(['checkout', '-q', '--detach', f.main]);
  const main = f.commit({ 'added.mjs': '// main\n' }, 'main');
  const options = { ...f.args, headSha: main };
  const p = await planRebuild(options);
  expect(p).toEqual(await planRebuild({ ...options, closureScopeMode: 'off' }));
  expect(p.applied).toEqual([]);
  expect(p.finalSha).toBe(main);
});

it.each([
  { label: 'in-closure', entry: "import './unused.mjs';" },
  { label: 'package', path: 'package.json' },
  { label: 'lockfile', path: 'package-lock.json' },
  { label: 'named JSON', path: 'data/policy.json', entry: "const name = 'policy.json';" },
  { label: 'computed JSON', path: 'data/foo.json', entry: 'export function tick(dir, name){ return readFileSync(`${dir}/${name}.json`, "utf8"); }' },
  { label: 'incomplete closure', entry: 'import(target);' },
  { label: 'runtime Markdown', path: 'prompt.md', entry: "import { readFileSync } from 'node:fs';\nexport function tick(){return readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');}" },
  { label: 'commented dynamic import', path: 'worker.mjs', entry: 'export async function tick(){return (await import /* selected worker */ (process.env.TARGET)).runOverlay();}' },
  { label: 'commented literal import', path: 'worker.mjs', entry: "export async function tick(){return (await import /* selected worker */ ('./worker.mjs')).runOverlay();}" },
  { label: 'missing relative import', entry: "import './missing.mjs';" },
])('$label conflict retains the unresolved/manual-rebase fallback', async options => {
  const f = fixture(options); const p = await planRebuild(f.args);
  expect(p.applied).toEqual([]);
  expect(p.decisions).toContainEqual(expect.objectContaining({ action: 'drop', reason: 'conflict' }));
});

it('mechanism-path conflict refuses', async () => {
  const f = fixture({ path: 'scripts/lib/daemon-rebuild/change.mjs' });
  const p = await planRebuild(f.args);
  expect(p).toMatchObject({ ok: false, reason: 'pinned-overlay-conflict' });
});

it.each(['#worker', 'closure-test/worker'])('retains conflicts in package-import alias targets (%s)', async specifier => {
  const f = fixture({ path: 'worker.mjs', entry: `import '${specifier}';`, files: {
    'package.json': JSON.stringify({ name: 'closure-test', type: 'module',
      imports: { '#worker': './worker.mjs' }, exports: { './worker': './worker.mjs' } }),
  } });
  const p = await planRebuild(f.args);
  expect(p.applied).toEqual([]);
  expect(p.decisions).toContainEqual(expect.objectContaining({ action: 'drop', reason: 'conflict' }));
  expect(closureScope.finalClosureScope({ git: f.git, sha: f.main, entries: ['entry.mjs'], env: {} }))
    .toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('locked on uses the off conflict and inputs key instead of a scoped-noop skip', async () => {
  const f = fixture({ noop: true }); const p = await planRebuild(f.args);
  const off = await planRebuild({ ...f.args, closureScopeMode: 'off' });
  expect(p).toEqual(off);
  expect(p.decisions).toContainEqual(expect.objectContaining({ action: 'drop', reason: 'conflict' }));
  expect(p.decisions.some(d => d.action === 'remove' || d.reason === 'scoped-noop')).toBe(false);
});

it('shadow only reports would resolve, excluded N, preserving the off plan', async () => {
  const f = fixture();
  const off = await planRebuild({ ...f.args, closureScopeMode: 'off' });
  const shadow = await planRebuild({ ...f.args, closureScopeMode: 'shadow' });
  expect(shadow.finalSha).toBe(off.finalSha);
  expect(shadow.inputsKey).toBe(off.inputsKey);
  expect(shadow.decisions).toEqual(off.decisions);
  expect(shadow.alerts).toContainEqual({ kind: 'overlay-conflict-resolved', detail: expect.objectContaining({
    via: 'closure-scope', mode: 'shadow', excluded: ['unused.mjs'], message: expect.stringContaining('would resolve, excluded 1'),
  }) });
});

it('shadow preserves off-mode alerts when scope is unproven and edge resolution is disabled', async () => {
  const f = fixture({ entry: 'import(target);' });
  const off = await planRebuild({ ...f.args, edgeResolve: false, closureScopeMode: 'off' });
  const shadow = await planRebuild({ ...f.args, edgeResolve: false, closureScopeMode: 'shadow' });
  expect(shadow).toEqual(off);
});

it('shadow reports exclusions while locked on retains both full-merge conflicts', async () => {
  const f = fixture({ entry: "import './worker.mjs';\nimport './protected.mjs';\n",
    files: { 'worker.mjs': "import './unused.mjs';\n", 'protected.mjs': '// base\n' },
    mainFiles: { 'protected.mjs': '// main\n' } });
  f.ok(['checkout', '-q', '--detach', f.base]);
  // B removes the worker import in the optimistic combined scope, but conflicts on a runtime dependency.
  f.commit({ 'worker.mjs': '', 'protected.mjs': '// B\n' }, 'lane/b');
  const plans = { ...f.args, overlays: [{ ref: 'lane/a' }, { ref: 'lane/b' }] };
  const shadow = await planRebuild({ ...plans, closureScopeMode: 'shadow' });
  expect(shadow.alerts).toContainEqual(expect.objectContaining({ kind: 'overlay-conflict-resolved',
    detail: expect.objectContaining({ ref: 'lane/a', excluded: ['unused.mjs'] }) }));
  const p = await planRebuild(plans);
  expect(p.applied).toEqual([]);
  expect(p.decisions.filter(d => d.reason === 'conflict').map(d => d.ref)).toEqual(['lane/a', 'lane/b']);
});

it('locked on bypasses final closure checks and uses the full-merge fallback', async () => {
  const f = fixture();
  const final = vi.spyOn(closureScope, 'finalClosureScope').mockReturnValue({ ok: false, reason: 'closure-too-large' });
  const p = await planRebuild(f.args);
  expect(p).toEqual(await planRebuild({ ...f.args, closureScopeMode: 'off' }));
  expect(p.applied).toEqual([]);
  expect(final).not.toHaveBeenCalled();
});

it('locked on never starts fixpoint work even with multiple conflicting overlays', async () => {
  const paths = ['unused.mjs', ...Array.from({ length: 4 }, (_, i) => `unused${i + 1}.mjs`)];
  const f = fixture({ files: Object.fromEntries(paths.map(p => [p, '// base\n'])),
    mainFiles: Object.fromEntries(paths.map(p => [p, '// main\n'])) });
  const overlays = [{ ref: 'lane/a' }];
  for (let i = 1; i < paths.length; i++) {
    f.ok(['checkout', '-q', '--detach', f.base]);
    f.commit({ [paths[i]]: '// overlay\n', [`marker${i}.mjs`]: 'export {};\n' }, `lane/b${i}`);
    overlays.push({ ref: `lane/b${i}` });
  }
  const final = vi.spyOn(closureScope, 'finalClosureScope');
  const p = await planRebuild({ ...f.args, overlays });
  expect(p).toEqual(await planRebuild({ ...f.args, overlays, closureScopeMode: 'off' }));
  expect(final).not.toHaveBeenCalled();
  expect(p.applied).toEqual([]);
  expect(p.decisions.filter(d => d.reason === 'conflict')).toHaveLength(overlays.length);
}, 30000);

it('unreadable clone entries retain the conflict instead of narrowing the scope', async () => {
  const f = fixture();
  const p = await planRebuild({ ...f.args, entries() { throw new Error('plist unreadable'); } });
  expect(p.applied).toEqual([]);
  expect(p.decisions[0]).toMatchObject({ action: 'drop', reason: 'conflict' });
});

it.each([
  { label: 'omitted', options: {} },
  { label: 'empty', options: { entries: [] } },
])('planRebuild in locked on mode without entries uses the off conflict fallback ($label)', async ({ options }) => {
  const f = fixture();
  const { entries, ...args } = f.args;
  const p = await planRebuild({ ...args, ...options });
  expect(p.applied).toEqual([]);
  expect(p.decisions).toContainEqual(expect.objectContaining({ action: 'drop', reason: 'conflict' }));
  expect(p).toEqual(await planRebuild({ ...args, ...options, closureScopeMode: 'off' }));
});

it.each(['on', 'off', 'shadow'].flatMap(mode => [
  { mode, label: 'omitted', options: {} },
  { mode, label: 'empty', options: { entries: [] } },
  { mode, label: 'invalid', options: { entries: null } },
  { mode, label: 'empty provider', options: { entries: () => [] } },
  { mode, label: 'throwing provider', options: { entries() { throw new Error('unreadable'); } } },
]))('readyBuildVerified refuses saved scoped candidates without runtime entries in $mode mode ($label)', async ({ mode, options }) => {
  const f = fixture(); const adopt = savedScopedCandidate(f);
  expect(adopt.applied[0]).toMatchObject({ resolvedVia: 'closure-scope', excluded: ['unused.mjs'] });
  const args = { git: f.git, adopt, mainTip: f.main, prevHead: f.main,
    env: { WE_DAEMON_CLOSURE_SCOPE: mode } };
  expect(readyBuildVerified({ ...args, entries: ['entry.mjs'] })).toBe(true);
  expect(readyBuildVerified({ ...args, ...options })).toBe(false);
});

it.each(['on', 'off', 'shadow'])('readyBuildVerified resolves runtime entries once in %s mode', async mode => {
  const f = fixture(); const adopt = savedScopedCandidate(f);
  const entries = vi.fn().mockReturnValueOnce(['entry.mjs', 'unused.mjs']).mockReturnValue([]);
  expect(readyBuildVerified({ git: f.git, adopt, mainTip: f.main, prevHead: f.main,
    entries, env: { WE_DAEMON_CLOSURE_SCOPE: mode } })).toBe(false);
  expect(entries).toHaveBeenCalledTimes(1);
});

it('locked planning never reads a runtime entry provider', async () => {
  const f = fixture();
  const entries = vi.fn().mockReturnValueOnce(['entry.mjs']).mockReturnValue([]);
  const plan = await planRebuild({ ...f.args, entries });
  expect(plan.applied).toEqual([]);
  expect(entries).not.toHaveBeenCalled();
  expect(plan).toEqual(await planRebuild({ ...f.args, closureScopeMode: 'off' }));
});

it('readyBuildVerified rebuilds exclusions and refuses a reachable or tampered excluded path', async () => {
  const f = fixture(); const p = savedScopedCandidate(f);
  expect(p.applied[0]?.resolvedVia).toBe('closure-scope');
  const verify = adopt => readyBuildVerified({ git: f.git, adopt, mainTip: f.main, prevHead: f.main, entries: ['entry.mjs'], env: {} });
  expect(verify(p)).toBe(true);
  expect(verify({ ...p, applied: [{ ...p.applied[0], excluded: ['entry.mjs'] }] })).toBe(false);
  expect(verify({ ...p, applied: [{ ...p.applied[0], excluded: [] }] })).toBe(false);
  expect(verify({ ...p, applied: [{ ...p.applied[0], excluded: ['unused.mjs', 'package.json'] }] })).toBe(false);
  expect(verify({ ...p, applied: [{ ...p.applied[0], excluded: ['unused.mjs', 'data/foo.json'] }] })).toBe(false);
});

it('readyBuildVerified refuses reachable exclusions even when every recorded merge tree reconstructs', async () => {
  const f = fixture(); const a = savedScopedCandidate(f);
  expect(a.applied[0]?.resolvedVia).toBe('closure-scope');
  f.ok(['checkout', '-q', '--detach', f.main]);
  const b = f.commit({ 'worker.mjs': "import './unused.mjs';\n" }, 'lane/b');
  const tree = f.ok(['merge-tree', '--write-tree', '--no-messages', a.finalSha, b]).split('\n')[0];
  const finalSha = f.ok(['commit-tree', tree, '-p', a.finalSha, '-p', b, '-m', 'candidate']);
  const adopt = { ...a, finalSha, applied: [...a.applied, { ref: 'lane/b', sha: b }] };
  expect(readyBuildVerified({ git: f.git, adopt, mainTip: f.main, prevHead: f.main,
    entries: ['entry.mjs', 'worker.mjs'], env: {} })).toBe(false);
});

it.each(['read-tree', 'write-tree', 'update-index', 'commit-tree', 'log', 'merge-base', '--literal-pathspecs'])(
  'strategy fails closed on %s Git errors', failedCommand => {
  const f = fixture();
  const result = closureScope.computeClosureScope({ git: f.git, mainSha: f.main,
    overlays: [{ sha: f.overlay, changedFiles: ['entry.mjs', 'new.mjs', 'unused.mjs'] }],
    entries: ['entry.mjs'], env: {} });
  expect(result.ok).toBe(true);
  expect(closureScope.isExcludable('unused.mjs', result.scope)).toBe(true);
  const failures = [];
  const git = (args, opts) => {
    if (args[0] !== failedCommand) return f.git(args, opts);
    failures.push(args);
    return { status: 128, stdout: '' };
  };
  expect(resolveOverlayConflict({ git, cur: f.main, ovSha: f.overlay, ref: 'lane/a', scope: result.scope }).ok).toBe(false);
  expect(failures.length).toBeGreaterThan(0);
});

it('prepare discovers caller runtime entries lazily and emits the shadow would-resolve alert', async () => {
  const f = fixture(); f.ok(['checkout', '-q', '-B', 'main', f.main]);
  const state = mkdtempSync(join(tmpdir(), 'closure-prepare-')); temps.push(state);
  const env = { WE_DAEMON_STATE_DIR: join(state, 'state'), WE_DAEMON_OVERLAY_DIR: join(state, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(state, 'locks'), WE_DAEMON_AUTO_REBASE: '0',
    WE_DAEMON_OVERLAY_AUTO_RETIRE: 'off', WE_DAEMON_CLOSURE_SCOPE: 'shadow', WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0' };
  addOverlay(f.root, { ref: 'lane/a', addedBy: 'test' }, { env });
  // Refresh evidence is injected; all Git commands actually executed remain local.
  vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [], refEvidence: new Map([['lane/a', 'refreshed']]) });
  const discovery = vi.spyOn(cloneEntries, 'cloneRuntimeEntries').mockImplementation(({ entries }) => entries);
  const log = { error: vi.fn() };
  const result = await prepareRebuild({ root: f.root, env, log,
    run: (args, options) => f.git(args, options), prState: async () => null, now: Date.now,
    entries: ['entry.mjs'], skipCheck: null, prBaseChain: async () => [],
  });
  expect(discovery).toHaveBeenCalledWith({ root: f.root, entries: ['entry.mjs'], env });
  expect(result.alerts).toContainEqual({ kind: 'overlay-conflict-resolved', detail: expect.objectContaining({
    via: 'closure-scope', mode: 'shadow', excluded: ['unused.mjs'], message: expect.stringContaining('would resolve, excluded 1'),
  }) });
  expect(log.error).toHaveBeenCalledWith(expect.stringContaining('would resolve, excluded 1'));
});

it('locked on rebuild retains the full conflict and leaves HEAD on main', async () => {
  const f = fixture(); f.ok(['checkout', '-q', '-B', 'main', f.main]);
  const state = mkdtempSync(join(tmpdir(), 'closure-adopt-')); temps.push(state);
  const env = { WE_DAEMON_STATE_DIR: join(state, 'state'), WE_DAEMON_OVERLAY_DIR: join(state, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(state, 'locks'), WE_DAEMON_AUTO_REBASE: '0',
    WE_DAEMON_OVERLAY_AUTO_RETIRE: 'off', WE_DAEMON_CLOSURE_SCOPE: 'on', WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0' };
  addOverlay(f.root, { ref: 'lane/a', addedBy: 'test' }, { env });
  vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [], refEvidence: new Map([['lane/a', 'refreshed']]) });
  vi.spyOn(cloneEntries, 'cloneRuntimeEntries').mockImplementation(({ entries }) => entries);
  const emitEvent = vi.fn();
  const result = await rebuildClone({ root: f.root, env, log: { error() {} },
    run: (args, options) => f.git(args, options), prState: async () => null,
    entries: ['entry.mjs'], skipCheck: null, asJob: false, versions: null,
    runSmoke: async () => ({ verdict: 'pass', attempts: 1, smoke: { results: [] } }),
    dispatchSmoke: { settings: { dispatchSmoke: 'off' } }, emitEvent,
  });
  expect(result).toMatchObject({ moved: false, reason: 'up-to-date' });
  expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.main);
  expect(result.plan.applied).toEqual([]);
  expect(result.plan.decisions).toContainEqual(expect.objectContaining({ action: 'drop', reason: 'conflict' }));
  expect(emitEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'rebuild-adopted' }), expect.anything());
});

it('smoke failure replans with the locked full-merge fallback', async () => {
  const f = fixture({ files: { 'other-entry.mjs': 'export {};\n' } });
  f.ok(['checkout', '-q', '--detach', f.main]);
  f.commit({ 'bad.mjs': 'throw new Error("bad overlay");\n' }, 'lane/b');
  f.ok(['checkout', '-q', '-B', 'main', f.main]);
  const state = mkdtempSync(join(tmpdir(), 'closure-replan-')); temps.push(state);
  const env = { WE_DAEMON_STATE_DIR: join(state, 'state'), WE_DAEMON_OVERLAY_DIR: join(state, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(state, 'locks'), WE_DAEMON_AUTO_REBASE: '0',
    WE_DAEMON_OVERLAY_AUTO_RETIRE: 'off', WE_DAEMON_CLOSURE_SCOPE: 'on', WE_DAEMON_OVERLAY_EDGE_RESOLVE: '0' };
  for (const ref of ['lane/a', 'lane/b']) addOverlay(f.root, { ref, addedBy: 'test' }, { env });
  vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [],
    refEvidence: new Map([['lane/a', 'refreshed'], ['lane/b', 'refreshed']]) });
  const discovery = vi.spyOn(cloneEntries, 'cloneRuntimeEntries').mockImplementation(({ entries }) => entries);
  const entries = ['entry.mjs', 'other-entry.mjs'];
  const runSmoke = vi.fn(async ({ root }) => existsSync(join(root, 'bad.mjs'))
    ? { verdict: 'code', attempts: 1, smoke: { results: [{ ok: false, name: 'entry-boot',
      detail: `exited 1: file://${root}/bad.mjs:1` }] } }
    : { verdict: 'pass', attempts: 1, smoke: { results: [] } });
  const result = await rebuildClone({ root: f.root, env, log: { error() {} },
    run: (args, options) => f.git(args, options), prState: async () => null,
    entries, skipCheck: null, asJob: false, versions: null, runSmoke,
    dispatchSmoke: { settings: { dispatchSmoke: 'off' } }, emitEvent: vi.fn(),
  });
  // With A retained as a full-merge conflict, failed B leaves only the plain-main fallback.
  expect(result).toMatchObject({ adopted: true, reason: 'fallback-plain-main' });
  expect(runSmoke).toHaveBeenCalledTimes(2);
  expect(discovery).not.toHaveBeenCalled();
  expect(readRebuildState(f.root, env).adopted.applied).toEqual([]);
  expect(f.ok(['rev-parse', 'HEAD'])).toBe(f.main);
});

it('closureScope mode cascades standard shadow, file, and environment with provenance', () => {
  const f = fixture(); const settingsPath = join(f.root, 'settings.json');
  const env = { WE_PLATFORM_PREFERENCES_FILE: join(f.root, 'absent.json') };
  expect(resolveClosureScopeMode(env, { settingsPath })).toMatchObject({ mode: 'shadow', source: 'standard' });
  writeFileSync(settingsPath, JSON.stringify({ closureScope: { mode: 'on' } }));
  expect(resolveClosureScopeMode(env, { settingsPath })).toMatchObject({ mode: 'off', source: 'tool' });
  expect(resolveClosureScopeMode({ ...env, WE_DAEMON_CLOSURE_SCOPE: 'off' }, { settingsPath })).toMatchObject({ mode: 'off', source: 'env' });
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ closureScope: { mode: 'off' } }));
  writeFileSync(settingsPath, JSON.stringify({ closureScope: { mode: 'bogus' } }));
  expect(resolveClosureScopeMode(env, { settingsPath })).toMatchObject({ mode: 'off', source: 'platform' });
  rmSync(env.WE_PLATFORM_PREFERENCES_FILE);
  writeFileSync(settingsPath, '{bad');
  expect(resolveClosureScopeMode({ ...env, WE_DAEMON_CLOSURE_SCOPE: 'bogus' }, { settingsPath })).toMatchObject({ mode: 'shadow', source: 'standard' });
});

it('shipped closureScope remains shadow without overrides', () => {
  const f = fixture();
  const env = { WE_PLATFORM_PREFERENCES_FILE: join(f.root, 'absent.json') };
  expect(resolveClosureScopeMode(env)).toMatchObject({ mode: 'shadow', source: 'tool' });
});
