// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectImportClosure } from '../../lib/import-closure.mjs';
import { createRemoteExec, resolveAdmissionPolicy } from '../heavy-admission.mjs';

const admissionUrl = new URL('../heavy-admission.mjs', import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('admission import boundary', () => {
  it('keeps daemon closures complete without importing the client loader or handoff push CLI', () => {
    const closure = collectImportClosure({ root: repoRoot, entries: ['scripts/readiness/heavy-admission.mjs'] });
    expect(closure.complete).toBe(true);
    expect(closure.files.has('scripts/lib/daemon-events.mjs')).toBe(true);
    expect(closure.files.has('scripts/operations/handoff-home.mjs')).toBe(false);
    expect(closure.files.has('scripts/readiness/remote-client-import.cjs')).toBe(false);
  });

  it.each([undefined, null])('unset %s still executes the real bundled client', async (clientPath) => {
    const policy = resolveAdmissionPolicy();
    policy.settings.remote.clientPath = clientPath;
    // The bundled client refuses this command before any external IO. Do not replace its loader with a mock.
    expect(await createRemoteExec({ policy })({ argv: ['not-an-allowed-heavy-command'] })).toEqual({
      mode: 'not-started', terminated: true, reason: 'command-not-allowed',
    });
  });

  it('succeeds with real FIFO provenance and lets a native subprocess exit promptly', (context) => {
    const root = mkdtempSync(join(tmpdir(), 'admission-fifo-'));
    roots.push(root);
    const clientPath = join(root, 'remote-exec.mjs');
    const eventPath = join(root, 'events.jsonl');
    const lockRoot = join(root, 'admission', 'heavy');
    const state = join(dirname(lockRoot), 'remote', 'client-override.json');
    mkdirSync(dirname(state), { recursive: true });
    try { execFileSync('mkfifo', [state], { timeout: 1000, maxBuffer: 4096 }); }
    catch (error) {
      if (['ENOENT', 'ENOSYS', 'ENOTSUP'].includes(error.code)) context.skip();
      throw error;
    }
    writeFileSync(clientPath, "export async function runRemote() { return { mode: 'remote', code: 0 }; }\n");
    const before = lstatSync(state);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRemoteExec, resolveAdmissionPolicy } from ${JSON.stringify(admissionUrl.href)};
      const execute = createRemoteExec({
        policy: resolveAdmissionPolicy({ platform: { remote: { clientPath: ${JSON.stringify(clientPath)} } } }),
        laneRoots: [], lockRoot: ${JSON.stringify(lockRoot)}, readSha: () => 'fifo-sha', log: () => {},
      });
      console.log(JSON.stringify(await execute({ argv: ['npm', 'run', 'build'] })));
      // No process.exit(): abandoned filesystem requests must not keep Node alive.
    `], {
      env: { ...process.env, WE_DAEMON_EVENTS: eventPath }, encoding: 'utf8',
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    });
    expect(JSON.parse(output)).toEqual({ mode: 'remote', code: 0 });
    expect(lstatSync(state).isFIFO()).toBe(true);
    expect(lstatSync(state).ino).toBe(before.ino);
    expect(readdirSync(dirname(state))).toEqual(['client-override.json']);
    expect(existsSync(eventPath)).toBe(false);
  }, 10_000);

  it('loads the native adapter only on remote execution and writes real override provenance and events', () => {
    const root = mkdtempSync(join(tmpdir(), 'admission-import-'));
    roots.push(root);
    const clientPath = join(root, 'remote-exec.mjs');
    const eventPath = join(root, 'events.jsonl');
    const lockRoot = join(root, 'admission', 'heavy');
    writeFileSync(clientPath, "export async function runRemote() { return { mode: 'remote', code: 7 }; }\n");
    // Native Node proves both the lazy CJS boundary and the event writer without Vitest's module mocks.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      import { createRemoteExec, resolveAdmissionPolicy } from ${JSON.stringify(admissionUrl.href)};
      const require = createRequire(${JSON.stringify(admissionUrl.href)});
      const adapter = require.resolve('./remote-client-import.cjs');
      const loadedBefore = !!require.cache[adapter];
      const execute = createRemoteExec({
        policy: resolveAdmissionPolicy({ platform: { remote: { clientPath: ${JSON.stringify(clientPath)} } } }),
        laneRoots: [], lockRoot: ${JSON.stringify(lockRoot)}, readSha: () => 'native-sha', log: () => {},
      });
      const loadedAfterCreate = !!require.cache[adapter];
      const result = await execute({ argv: ['npm', 'run', 'build'] });
      console.log(JSON.stringify({ loadedBefore, loadedAfterCreate, loadedAfterRun: !!require.cache[adapter], result }));
    `], {
      env: { ...process.env, WE_DAEMON_EVENTS: eventPath }, encoding: 'utf8',
      timeout: 10_000, maxBuffer: 64 * 1024,
    });
    expect(JSON.parse(output)).toEqual({
      loadedBefore: false, loadedAfterCreate: false, loadedAfterRun: true, result: { mode: 'remote', code: 7 },
    });
    const pair = JSON.parse(readFileSync(join(dirname(lockRoot), 'remote', 'client-override.json'), 'utf8'));
    expect(pair.sha).toBe('native-sha');
    const events = readFileSync(eventPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toEqual([expect.objectContaining({
      kind: 'remote-client-override', detail: { ...pair, previous: null },
    })]);
  });
});
