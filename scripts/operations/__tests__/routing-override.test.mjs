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
import { createRoutingOverrideSinks } from '../routing-override-file.mjs';
import { routingOverrideOperation, planRoutingOverride } from '../routing-override.mjs';
import { op } from '../registry.mjs';
import { compute } from '../step-kinds.mjs';

const dirs = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const key = 'review-seat:red-team';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'routing-override-cli-')); dirs.push(dir);
  const path = join(dir, 'preferences.json');
  const env = { WE_PLATFORM_PREFERENCES_FILE: path };
  const command = argv => runOperationCli({ ...resolveOperation('routing-override'),
    sinks: createRoutingOverrideSinks({ env }), argv, store: createMemoryRunStore(),
    newRunId: () => 'routing-override-test' });
  return { dir, path, command };
}

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
