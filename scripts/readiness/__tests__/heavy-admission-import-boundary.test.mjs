// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectImportClosure } from '../../lib/import-closure.mjs';
import { appendDaemonEvent } from '../../lib/daemon-events.mjs';
import { createRemoteExec, resolveAdmissionPolicy, resolveRemoteClient } from '../heavy-admission.mjs';

const admissionUrl = new URL('../heavy-admission.mjs', import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function cliFixture(source) {
  const root = mkdtempSync(join(tmpdir(), 'admission-cli-provenance-'));
  roots.push(root);
  const clientPath = join(root, 'remote-exec.mjs');
  const eventPath = join(root, 'events.jsonl');
  const pool = join(root, 'pool');
  const preferences = join(root, '.claude', 'platform-preferences.json');
  mkdirSync(pool);
  mkdirSync(dirname(preferences));
  writeFileSync(clientPath, source);
  writeFileSync(preferences, JSON.stringify({ heavyAdmission: { remote: { enabled: true, mode: 'always', clientPath } } }));
  const env = { ...process.env, LANE_POOL_ROOT: pool, WE_PLATFORM_PREFERENCES: preferences,
    WE_DAEMON_EVENTS: eventPath, WE_HEAVY_ADMISSION: 'on', WE_HEAVY_ADMISSION_HELD: '',
    WE_HEAVY_ADMISSION_CONTAINER: '', WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES: '', CI: '' };
  // Native CLI routing uses env-selected non-executable settings; only the home seam selects client code.
  const runner = `
    import { main, loadAdmissionPolicy, createRemoteExec } from ${JSON.stringify(admissionUrl.href)};
    import { easternTimestamp } from ${JSON.stringify(new URL('../forge-exec-run.mjs', import.meta.url).href)};
    const policy = loadAdmissionPolicy({ home: ${JSON.stringify(root)}, env: { ...process.env, WE_PLATFORM_PREFERENCES: '' } });
    await main(process.argv.slice(1), { remoteExec: createRemoteExec({
      policy, lockRoot: ${JSON.stringify(join(pool, '.admission', 'heavy'))},
    }), readTelemetry: async () => ({ sampledAtET: easternTimestamp(Date.now()),
      cores: 8, loadPerCore: 0.1, memFreePct: 90, activeRuns: 0, recent: [] }) });
  `;
  return { clientPath, eventPath, state: join(pool, '.admission', 'remote', 'client-override.json'),
    run: () => spawnSync(process.execPath, ['--input-type=module', '-e', runner, 'run', '--', 'npm', 'run', 'build'], {
      cwd: root, env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    }) };
}

describe('admission import boundary', () => {
  it.each([0, 7])('the real CLI persists fast remote provenance before exiting with code %i', (code) => {
    const f = cliFixture(`export async function runRemote() { return { mode: 'remote', code: ${code} }; }`);
    const result = f.run();
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(code);
    const pair = { clientPath: resolveRemoteClient({ clientPath: f.clientPath }).clientPath, sha: 'unknown' };
    expect(result.stderr).toContain(`heavy-admission: remote client override ${pair.clientPath} @ unknown\n`);
    expect(JSON.parse(readFileSync(f.state, 'utf8'))).toEqual({
      ...pair, pathKey: createHash('sha256').update(pair.clientPath).digest('hex'),
    });
    expect(readFileSync(f.eventPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([{
      at: expect.any(String), repo: 'web-everything', kind: 'remote-client-override',
      detail: { ...pair, previous: null },
    }]);
  });

  it.each([false, true])('the real CLI caps never-settling provenance and preserves the remote exit code (live handle=%s)', (liveHandle) => {
    const f = cliFixture(`
      export async function runRemote() {
        const write = process.stderr.write.bind(process.stderr);
        process.stderr.write = (line, ...args) => {
          const result = write(line, ...args);
          if (line.startsWith('heavy-admission: remote client override ')) {
            const started = performance.now();
            process.once('exit', () => console.log(JSON.stringify({ elapsed: performance.now() - started })));
            // Keep the process live so an unref'd drain timer can fire; the CLI must exit explicitly.
            if (${liveHandle}) setTimeout(() => process.exit(0), 30_000);
            return new Promise(() => {});
          }
          return result;
        };
        return { mode: 'remote', code: 7 };
      }
    `);
    const result = f.run();
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('heavy-admission: remote client override ');
    const { elapsed } = JSON.parse(result.stdout);
    if (liveHandle) expect(elapsed).toBeGreaterThanOrEqual(1400);
    // Allow scheduling jitter around the 1500 ms hard cap, excluding CLI startup and SHA lookup.
    expect(elapsed).toBeLessThan(1900);
    expect(existsSync(f.state)).toBe(false);
    expect(existsSync(f.eventPath)).toBe(false);
  }, 10_000);

  it('keeps daemon closures complete without importing the client loader or handoff push CLI', () => {
    const closure = collectImportClosure({ root: repoRoot, entries: ['scripts/readiness/heavy-admission.mjs'] });
    expect(closure.complete).toBe(true);
    expect(closure.files.has('scripts/lib/daemon-events.mjs')).toBe(true);
    expect(closure.files.has('scripts/readiness/remote-exec.mjs')).toBe(true);
    expect(closure.files.has('scripts/operations/handoff-home.mjs')).toBe(false);
    expect(closure.files.has('scripts/readiness/remote-client-import.cjs')).toBe(false);
  });

  it.each([undefined, null])('unset %s still executes the real bundled client', async (clientPath) => {
    const policy = resolveAdmissionPolicy();
    policy.settings.remote.clientPath = clientPath;
    // The bundled client refuses this command before any external IO. Do not replace its loader with a mock.
    // Pin the clock to assert the complete result, including the bundled client's stage timings.
    expect(await createRemoteExec({ policy })({
      argv: ['not-an-allowed-heavy-command'], clock: () => Date.parse('2026-01-01T12:00:00Z'),
    })).toEqual({
      mode: 'not-started', terminated: true, reason: 'command-not-allowed',
      timings: [{ stage: 'total', startedAtET: '2026-01-01T07:00:00.000-05:00', ms: 0 }],
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

  it.each(['FIFO', 'directory', 'symlink', 'dangling symlink', 'missing parent', 'non-directory parent', 'symlink parent'])(
    'skips a daemon-events %s (FIFO has no reader) and lets a successful native client exit naturally', (kind, context) => {
      const root = mkdtempSync(join(tmpdir(), 'admission-events-'));
      roots.push(root);
      const clientPath = join(root, 'remote-exec.mjs');
      let eventPath = join(root, 'events.jsonl');
      const lockRoot = join(root, 'admission', 'heavy');
      const target = join(root, 'target');
      if (kind === 'FIFO') {
        try { execFileSync('mkfifo', [eventPath], { timeout: 1000, maxBuffer: 4096 }); }
        catch (error) {
          if (['ENOENT', 'ENOSYS', 'ENOTSUP'].includes(error.code)) context.skip();
          throw error;
        }
      } else if (kind === 'directory') mkdirSync(eventPath);
      else if (kind === 'symlink' || kind === 'dangling symlink') {
        if (kind === 'symlink') writeFileSync(target, 'untouched');
        symlinkSync(target, eventPath);
      } else if (kind === 'missing parent') eventPath = join(root, 'missing', 'events.jsonl');
      else if (kind === 'symlink parent') {
        mkdirSync(target);
        symlinkSync(target, join(root, 'parent'));
        eventPath = join(root, 'parent', 'events.jsonl');
      } else {
        writeFileSync(target, 'untouched');
        eventPath = join(target, 'events.jsonl');
      }
      writeFileSync(clientPath, "export async function runRemote() { return { mode: 'remote', code: 0 }; }\n");
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { createRemoteExec, resolveAdmissionPolicy } from ${JSON.stringify(admissionUrl.href)};
        const execute = createRemoteExec({
          policy: resolveAdmissionPolicy({ platform: { remote: { clientPath: ${JSON.stringify(clientPath)} } } }),
          laneRoots: [], lockRoot: ${JSON.stringify(lockRoot)}, readSha: () => 'events-sha', log: () => {},
        });
        console.log(JSON.stringify(await execute({ argv: ['npm', 'run', 'build'] })));
        // No process.exit(): a blocked append must not keep Node alive after the provenance timeout.
      `], {
        env: { ...process.env, WE_DAEMON_EVENTS: eventPath }, encoding: 'utf8',
        timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      });
      expect(JSON.parse(output)).toEqual({ mode: 'remote', code: 0 });
      expect(existsSync(join(dirname(lockRoot), 'remote', 'client-override.json'))).toBe(false);
      if (kind === 'FIFO') expect(lstatSync(eventPath).isFIFO()).toBe(true);
      if (kind === 'symlink' || kind === 'dangling symlink') expect(lstatSync(eventPath).isSymbolicLink()).toBe(true);
      if (kind === 'symlink' || kind === 'non-directory parent') expect(readFileSync(target, 'utf8')).toBe('untouched');
      if (kind === 'dangling symlink') expect(existsSync(target)).toBe(false);
      if (kind === 'missing parent') expect(existsSync(dirname(eventPath))).toBe(false);
      if (kind === 'symlink parent') expect(readdirSync(target)).toEqual([]);
    }, 10_000);

  it.each([false, true])('loads the native adapter only on remote execution and writes real override provenance and identical daemon event lines (existing file=%s)', async (existing) => {
    const root = mkdtempSync(join(tmpdir(), 'admission-import-'));
    roots.push(root);
    const clientPath = join(root, 'remote-exec.mjs');
    const eventPath = join(root, 'events.jsonl');
    const lockRoot = join(root, 'admission', 'heavy');
    if (existing) writeFileSync(eventPath, '');
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
    const raw = readFileSync(eventPath, 'utf8');
    const events = raw.trim().split('\n').map(line => JSON.parse(line));
    const event = { kind: 'remote-client-override', detail: { clientPath: pair.clientPath, sha: pair.sha, previous: null } };
    expect(events).toEqual([{
      at: expect.any(String), repo: 'web-everything', ...event,
    }]);
    const reference = join(root, 'reference-events.jsonl');
    expect(await appendDaemonEvent(event, {
      env: { WE_DAEMON_EVENTS: reference }, now: () => new Date(events[0].at),
    })).toBe(true);
    expect(raw).toBe(readFileSync(reference, 'utf8'));
  });
});
