import { afterEach, expect, it, vi } from 'vitest';
import fs, { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { resolveOperation } from '../run.mjs';
import { runOperationCli, buildCliSpec, parseOperationArgv } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRoutingOverrideSinks, writeRoutingOverride } from '../routing-override-file.mjs';
import { applyRoutingOverrides, DEFAULT_ROUTING_POLICY, resolveOperationRoute } from '../../lib/dispatch-routing-policy.mjs';
import { routingOverrideOperation, planRoutingOverride } from '../routing-override.mjs';
import { op } from '../registry.mjs';
import { compute, judge } from '../step-kinds.mjs';

const dirs = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const key = 'review-seat:red-team';
it.each(['claude', 'antigravity', 'unknown-provider'])(
  'refuses unsupported red-team provider %s and preserves working file bytes', async provider => {
    const f = fixture();
    const original = '{\n  "unrelated": true, "routingOverrides": {"review-seat:red-team": {"provider":"codex"}}\n}\n';
    writeFileSync(f.path, original);
    expect(() => planRoutingOverride({ operation: 'review-seat', taskType: 'red-team', provider })).toThrow(/unsupported provider/);
    expect(() => writeRoutingOverride({ key, patch: { provider } }, { env: f.env })).toThrow(/provider/);
    expect((await f.command(['--operation=review-seat', '--taskType=red-team', `--provider=${provider}`])).code).not.toBe(0);
    expect(readFileSync(f.path, 'utf8')).toBe(original);
  });

it.each([
  ['inherited', { disabledProviders: ['codex', 'agy-claude', 'agy-gemini'] }, /no available route/],
  ['explicit', { provider: 'codex', disabledProviders: ['codex', 'agy-claude', 'agy-gemini'] }, /both enabled and disabled/],
])('refuses disabling all red-team providers (%s) and preserves working file bytes', (mode, patch, error) => {
  const f = fixture();
  const original = '{\n "routingOverrides": {"review-seat:red-team": {"provider":"agy-claude"}}, "keep": true\n}\n';
  writeFileSync(f.path, original);
  expect(() => writeRoutingOverride({ key, patch }, { env: f.env })).toThrow(error);
  expect(readFileSync(f.path, 'utf8')).toBe(original);
  const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, JSON.parse(readFileSync(f.path, 'utf8')).routingOverrides);
  expect(resolveOperationRoute({ operation: 'review-seat', taskType: 'red-team', policy })).toMatchObject({ provider: 'agy-claude' });
});

it.each(['advisory:agy-correctness', 'mandatory:correctness', 'mandatory:security'])(
  'refuses an unsupported provider for %s without writing preferences', async taskType => {
    const f = fixture();
    const original = JSON.stringify({ unrelated: true });
    writeFileSync(f.path, original);
    expect(() => planRoutingOverride({ operation: 'review-seat', taskType, provider: 'codex' })).toThrow(/provider/);
    expect((await f.command(['--operation=review-seat', `--taskType=${taskType}`, '--provider=codex'])).code).not.toBe(0);
    expect(readFileSync(f.path, 'utf8')).toBe(original);
  });

function fixture() {
  const dir = fs.realpathSync(mkdtempSync(join(tmpdir(), 'routing-override-cli-'))); dirs.push(dir);
  const path = join(dir, 'preferences.json');
  const env = { WE_PLATFORM_PREFERENCES_FILE: path };
  const command = argv => runOperationCli({ ...resolveOperation('routing-override'),
    sinks: createRoutingOverrideSinks({ env }), argv, store: createMemoryRunStore(),
    newRunId: () => 'routing-override-test' });
  return { dir, path, env, command };
}

it('refuses an override that exhausts the effective fallback route and preserves file bytes', () => {
  const f = fixture();
  const original = '{"routingOverrides":{"prepare-item":{"provider":"codex"}},"keep":true}\n';
  writeFileSync(f.path, original);
  expect(() => writeRoutingOverride({ key: 'prepare-item', patch: { disabledProviders: ['codex', 'claude'] } },
    { env: f.env })).toThrow(/no available route/);
  expect(readFileSync(f.path, 'utf8')).toBe(original);
});

it('updates the real preferences target and preserves its symlink', async () => {
  const f = fixture();
  const target = join(f.dir, 'target.json');
  writeFileSync(target, '{"keep":true}');
  fs.symlinkSync('target.json', f.path);
  expect((await f.command(['--operation=review-seat', '--taskType=red-team', '--provider=agy-gemini'])).code).toBe(0);
  expect(fs.lstatSync(f.path).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(f.path)).toBe('target.json');
  expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ keep: true, routingOverrides: { [key]: { provider: 'agy-gemini' } } });
  expect(readdirSync(f.dir).sort()).toEqual(['preferences.json', 'target.json']);
});

it('creates a dangling symlink target instead of replacing the symlink', async () => {
  const f = fixture();
  fs.mkdirSync(join(f.dir, 'real'));
  fs.symlinkSync(join('real', 'target.json'), f.path);
  expect((await f.command(['--operation=review-seat', '--taskType=red-team', '--provider=codex'])).code).toBe(0);
  expect(fs.readlinkSync(f.path)).toBe(join('real', 'target.json'));
  expect(JSON.parse(readFileSync(join(f.dir, 'real', 'target.json'), 'utf8'))).toEqual({ routingOverrides: { [key]: { provider: 'codex' } } });
  expect(readdirSync(join(f.dir, 'real'))).toEqual(['target.json']);
});

it('declares and executes CLI write and clear, preserving unrelated preferences and entries atomically', async () => {
  const f = fixture();
  const other = { 'review-seat:advisory:agy-correctness': { model: 'sonnet' } };
  writeFileSync(f.path, JSON.stringify({ unrelated: { keep: true }, routingOverrides: other }));
  const result = await f.command(['--operation=review-seat', '--taskType=red-team', '--provider=agy-gemini', '--model=pro']);
  expect(result.code).toBe(0);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ unrelated: { keep: true },
    routingOverrides: { ...other, [key]: { provider: 'agy-gemini', model: 'pro' } } });
  expect((await f.command(['--operation=review-seat', '--taskType=red-team', '--clear'])).code).toBe(0);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ unrelated: { keep: true }, routingOverrides: other });
  expect(readdirSync(f.dir)).toEqual(['preferences.json']);
});

it('uses the operator file replacement and creates a missing preferences file', async () => {
  const f = fixture();
  const path = join(f.dir, 'nested', 'preferences.json');
  vi.stubEnv('WE_PLATFORM_PREFERENCES_FILE', path);
  const result = await runOperationCli({ ...resolveOperation('routing-override'), store: createMemoryRunStore(),
    newRunId: () => 'routing-override-test',
    argv: ['--operation=review-seat', '--taskType=red-team', '--provider=agy-claude'] });
  expect(result.code).toBe(0);
  expect(JSON.parse(readFileSync(path, 'utf8')).routingOverrides[key]).toEqual({ provider: 'agy-claude' });
});

it('preserves $schema, $comment, and nested metadata on write and --clear', async () => {
  const f = fixture();
  const metadata = { $schema: 'https://example.test/preferences.schema.json', $comment: 'Operator notes',
    unrelated: { $comment: 'Nested notes', values: [null, false, 0, { $custom: 'keep' }] } };
  writeFileSync(f.path, JSON.stringify(metadata));
  expect((await f.command(['--operation=review-seat', '--taskType=red-team', '--provider=codex'])).code).toBe(0);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ ...metadata, routingOverrides: { [key]: { provider: 'codex' } } });
  expect((await f.command(['--operation=review-seat', '--taskType=red-team', '--clear'])).code).toBe(0);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ ...metadata, routingOverrides: {} });
});

it.each(['__proto__', 'constructor', 'prototype'])('never emits unsafe %s keys on write or --clear', async unsafe => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ [unsafe]: { injected: true },
    unrelated: { keep: true, [unsafe]: { injected: true }, values: [{ [unsafe]: 'drop', keep: false }] } }));
  const unrelated = { keep: true, values: [{ keep: false }] };
  expect((await f.command(['--operation=review-seat', '--taskType=red-team', '--provider=codex'])).code).toBe(0);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ unrelated, routingOverrides: { [key]: { provider: 'codex' } } });
  expect((await f.command(['--operation=review-seat', '--taskType=red-team', '--clear'])).code).toBe(0);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ unrelated, routingOverrides: {} });
});

it.each([
  ['review-seat', 'retired-seat'], ['review-seat', 'red-teem'], ['review-seat', 'advisory:retired'],
  ['retired-operation', 'retired-task'], ['reviev-seat', 'red-team'],
])('plans and executes --clear for an unknown scoped key: %s:%s', async (operation, taskType) => {
  const f = fixture();
  const staleKey = `${operation}:${taskType}`;
  const other = { [key]: { provider: 'codex' } };
  expect(() => planRoutingOverride({ operation, taskType, provider: 'codex' })).toThrow(/unknown operation/);
  expect(planRoutingOverride({ operation, taskType, clear: true })).toEqual({
    key: staleKey, patch: null, source: 'platform', cleared: true,
  });
  writeFileSync(f.path, JSON.stringify({ unrelated: true, routingOverrides: { ...other, [staleKey]: { provider: 'codex' } } }));
  const bytes = readFileSync(f.path, 'utf8');
  expect((await f.command([`--operation=${operation}`, `--taskType=${taskType}`, '--provider=codex'])).code).not.toBe(0);
  expect(readFileSync(f.path, 'utf8')).toBe(bytes);
  expect((await f.command([`--operation=${operation}`, `--taskType=${taskType}`, '--clear'])).code).toBe(0);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ unrelated: true, routingOverrides: other });
});

it.each(['null', '[]', 'true', '1', '"preferences"'])('refuses a non-object preferences root without overwriting it: %s', async text => {
  const f = fixture(); writeFileSync(f.path, text);
  expect((await f.command(['--operation=review-seat', '--taskType=red-team', '--provider=codex'])).code).not.toBe(0);
  expect(readFileSync(f.path, 'utf8')).toBe(text);
});

it('refuses to modify preferences when the shared lock cannot be acquired', async () => {
  const f = fixture(); writeFileSync(f.path, '{"keep":true}');
  const open = fs.openSync;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation((path, ...args) => {
    if (path === `${f.path}.lock`) throw Object.assign(new Error('lock denied'), { code: 'EACCES' });
    return open(path, ...args);
  });
  try {
    const result = await f.command(['--operation=review-seat', '--taskType=red-team', '--provider=codex']);
    expect(result.code).not.toBe(0);
    expect(readFileSync(f.path, 'utf8')).toBe('{"keep":true}');
    expect(readdirSync(f.dir)).toEqual(['preferences.json']);
  } finally { spy.mockRestore(); }
});

it.each(['write', 'clear'])('serializes an overlapping %s and write without losing either update', async action => {
  const f = fixture();
  const otherKey = 'review-seat:advisory:agy-correctness';
  writeFileSync(f.path, JSON.stringify({ unrelated: { keep: true }, routingOverrides: { [key]: { provider: 'codex' } } }));
  const barrier = new SharedArrayBuffer(4);
  const control = new Int32Array(barrier);
  const workerFile = join(f.dir, 'overlapping-writer.mjs');
  writeFileSync(workerFile, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { parentPort, workerData } from 'node:worker_threads';
    const { path, module, payload, first, barrier } = workerData;
    const control = new Int32Array(barrier);
    const release = () => { Atomics.store(control, 0, 1); Atomics.notify(control, 0); };
    const read = fs.readFileSync, open = fs.openSync;
    let paused = false;
    fs.readFileSync = (file, ...args) => {
      const text = read(file, ...args);
      if (first && file === path && !paused) {
        paused = true;
        parentPort.postMessage('read');
        if (Atomics.wait(control, 0, 0, 8000) === 'timed-out') throw Error('writer barrier timed out');
      }
      return text;
    };
    fs.openSync = (file, ...args) => {
      try { return open(file, ...args); }
      catch (error) {
        if (!first && file === path + '.lock' && error.code === 'EEXIST') release();
        throw error;
      }
    };
    syncBuiltinESMExports();
    const { writeRoutingOverride } = await import(module);
    writeRoutingOverride(payload, { env: { WE_PLATFORM_PREFERENCES_FILE: path } });
    // Without serialization the second writer finishes first, then the paused stale writer overwrites it.
    if (!first) release();
  `);
  const workers = [];
  const start = (first, payload) => {
    const worker = new Worker(workerFile, { workerData: { first, payload, path: f.path, barrier,
      module: pathToFileURL(join(process.cwd(), 'scripts/operations/routing-override-file.mjs')).href } });
    workers.push(worker);
    return worker;
  };
  try {
    const first = start(true, { key, patch: action === 'clear' ? null : { provider: 'agy-gemini' } });
    const firstExit = once(first, 'exit');
    await once(first, 'message');
    const second = start(false, { key: otherKey, patch: { model: 'sonnet', provider: 'agy-claude' } });
    expect(await Promise.all([firstExit, once(second, 'exit')])).toEqual([[0], [0]]);
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ unrelated: { keep: true }, routingOverrides: {
      ...(action === 'clear' ? {} : { [key]: { provider: 'agy-gemini' } }),
      [otherKey]: { model: 'sonnet', provider: 'agy-claude' },
    } });
    expect(readdirSync(f.dir).sort()).toEqual(['overlapping-writer.mjs', 'preferences.json']);
  } finally {
    Atomics.store(control, 0, 1); Atomics.notify(control, 0);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}, 15000);

it.each([
  ['--provider=typo'], ['--provider=agy-gemini', '--model=sonnet'], ['--model=pro'], ['--clear', '--provider=codex'],
])('refuses invalid CLI requests without modifying preferences: %j', async (...flags) => {
  const f = fixture(); writeFileSync(f.path, '{"keep":true}');
  const result = await f.command(['--operation=review-seat', '--taskType=red-team', ...flags]);
  expect(result.code).not.toBe(0); expect(readFileSync(f.path, 'utf8')).toBe('{"keep":true}');
});

it('refuses torn preferences without overwriting them', async () => {
  const f = fixture(); writeFileSync(f.path, '{');
  const result = await f.command(['--operation=review-seat', '--taskType=red-team', '--provider=codex']);
  expect(result.code).not.toBe(0); expect(readFileSync(f.path, 'utf8')).toBe('{');
});

it('validates provider/model ids against the shared roster before writing', () => {
  expect(planRoutingOverride({ operation: 'review-seat', taskType: 'red-team', provider: 'agy-claude', model: 'claude-sonnet-5-5' }).patch.model).toBe('claude-sonnet-5-5');
  expect(() => planRoutingOverride({ operation: 'typo', clear: true })).toThrow(/unknown operation/);
});

it('derives provider/model as inputs only where declared, keeping absent juror flags closed', () => {
  const declaration = routingOverrideOperation();
  expect(buildCliSpec(declaration).usage).toContain('--provider');
  const parsed = parseOperationArgv(declaration, ['--operation=review-seat', '--taskType=red-team', '--provider=agy-gemini', '--model=pro']);
  expect(parsed).toMatchObject({ ok: true, input: { provider: 'agy-gemini', model: 'pro' }, control: { model: '', provider: '' } });
  const simple = op('simple', { input: {}, verdictFrom: 'read', read: compute({ reads: [], fn: () => ({}) }) });
  expect(parseOperationArgv(simple, ['--provider=agy-gemini']).ok).toBe(false);
  expect(parseOperationArgv(declaration, ['--operation=review-seat', '--cwd=somewhere']).ok).toBe(false);
});

it.each(['model', 'provider'])('keeps %s reserved for juror controls on judged operations', field => {
  const declaration = op('judged-collision', { input: { [field]: 'string' }, verdictFrom: 'panel',
    panel: judge({ reads: [], request: () => ({ mandate: 'review', input: '', shape: {} }) }),
  });
  expect(() => buildCliSpec(declaration)).toThrow(`declares an input field \`${field}\` that collides`);
});
