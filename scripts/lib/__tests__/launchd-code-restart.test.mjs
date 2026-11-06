import { describe, it, expect, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import fsAsync from 'node:fs/promises';
import childProcess from 'node:child_process';
import { findServicesRunningFromClone, restartServicesForClone, findStaleCodeServices } from '../launchd-code-restart.mjs';
import { withSelfSync, resolveRestartServices } from '../daemon-self-sync.mjs';
const cloneRoot = resolve('fixtures/wev-pass-readers');
function fixture(plists = [{ Label: 'com.we.resource-sampler', ProgramArguments: ['node', join(cloneRoot, 'sampler.mjs')] }]) {
  return { cloneRoot, agentsDir: resolve('fixtures/agents'), listPlists: () => plists.map((_, i) => `${i}.plist`),
    readPlist: path => { const p = plists[Number(path.split('/').at(-1).split('.')[0])]; if (p instanceof Error) throw p; return p; },
    launchctl: vi.fn(() => ({ stdout: 'pid = 42', status: 0 })), uid: () => 501, log: vi.fn(), now: () => 1_000_000,
    stateStore: new Map(), lockStore: { acquire: async () => async () => {} }, adoptedSha: 'new-sha', platform: null, env: {} };
}
describe('launchd clone restart', () => {
  it('label matching normalizes paths and respects path-boundary', () => {
    const o = fixture([
      { Label: 'com.we.exact', ProgramArguments: [cloneRoot] },
      { Label: 'com.we.child', ProgramArguments: ['node', join(cloneRoot, 'scripts', '..', 'run.mjs')] },
      { Label: 'com.we.sibling', ProgramArguments: [`${cloneRoot}2/run.mjs`] }]);
    expect(findServicesRunningFromClone(o).matches.map(x => x.label)).toEqual(['com.we.exact', 'com.we.child']);
  });
  it('bare executable with unrelated absolute script does not match when cwd equals cloneRoot', async () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['node', resolve('..', 'other-clone', 'sampler.mjs')] }]);
    o.cloneRoot = process.cwd();
    expect(findServicesRunningFromClone(o).matches).toEqual([]);
    expect((await restartServicesForClone(o)).restarted).toEqual([]);
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100, readAdoptedAtMs: () => 200 })).toEqual([]);
  });
  it.each(['--flag', './sampler.mjs', 'scripts/sampler.mjs'])('does not interpret service-relative argument %s using reviewer cwd', arg => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: [resolve('..', 'bin', 'node'), arg] }]);
    o.cloneRoot = process.cwd();
    expect(findServicesRunningFromClone(o).matches).toEqual([]);
  });
  it.each([
    ['data argument', [resolve('..', 'bin', 'sampler'), '--data-dir', cloneRoot]],
    ['script data argument', ['node', resolve('..', 'other-clone', 'sampler.mjs'), '--data-dir', cloneRoot]],
    ['working directory alone', [resolve('..', 'bin', 'sampler')]],
    // --require/--import/--loader values are CODE the service runs (covered by the preload tests below); a
    // --conditions value is only data.
    ['interpreter option value that is data', ['node', '--conditions', join(cloneRoot, 'loader.mjs'), resolve('..', 'other-clone', 'sampler.mjs')]],
  ])('ownership counts executable/script positions only: %s', async (_name, ProgramArguments) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments, WorkingDirectory: cloneRoot }]);
    expect(findServicesRunningFromClone(o).matches).toEqual([]);
    expect((await restartServicesForClone(o)).restarted).toEqual([]);
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it.each(['node', 'python3', 'bash'])('recognizes the first script position after interpreter %s', interpreter => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: [interpreter, join(cloneRoot, 'sampler')] }]);
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
  });
  it('Program outside clone overrides a clone-looking ProgramArguments argv0', async () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', Program: resolve('..', 'other-clone', 'sampler'),
      ProgramArguments: [join(cloneRoot, 'sampler.mjs')] }]);
    expect(findServicesRunningFromClone(o).matches).toEqual([]);
    expect((await restartServicesForClone(o)).restarted).toEqual([]);
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it.each(['node', 'python3', 'bash'].flatMap(interpreter => [[interpreter, false], [interpreter, true]]))('equivalent interpreter ownership for %s with explicit Program=%s', async (interpreter, explicitProgram) => {
    const executable = resolve('..', 'tools', interpreter);
    const plist = { Label: 'com.we.resource-sampler',
      ProgramArguments: [explicitProgram ? interpreter : executable, join(cloneRoot, 'sampler.mjs')] };
    if (explicitProgram) plist.Program = executable;
    const o = fixture([plist]);
    expect(findServicesRunningFromClone(o).matches).toEqual([{ label: plist.Label, plistPath: join(o.agentsDir, '0.plist') }]);
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect(o.launchctl).toHaveBeenCalledWith(['kickstart', '-k', 'gui/501/com.we.resource-sampler']);
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 }))
      .toEqual([expect.objectContaining({ label: plist.Label, reason: 'stale-code' })]);
  });
  it('external Program interpreter ignores disguised argv0 when its actual script is outside the clone', async () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', Program: resolve('..', 'tools', 'node'),
      ProgramArguments: [join(cloneRoot, 'sampler.mjs'), resolve('..', 'other-clone', 'sampler.mjs')] }]);
    expect(findServicesRunningFromClone(o).matches).toEqual([]);
    await restartServicesForClone(o); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('external non-interpreter Program cannot acquire script ownership from a fake node argv0', () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', Program: resolve('..', 'tools', 'sampler'),
      ProgramArguments: ['node', join(cloneRoot, 'sampler.mjs')] }]);
    expect(findServicesRunningFromClone(o).matches).toEqual([]);
  });
  it('Program alone establishes clone ownership without ProgramArguments', () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', Program: join(cloneRoot, 'sampler') }]);
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
    expect(findServicesRunningFromClone(o).unreadable).toEqual([]);
  });
  it('Program participates in the built-in dev-server exclusion despite disguised argv0', async () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', Program: join(cloneRoot, 'vite'),
      ProgramArguments: [join(cloneRoot, 'sampler.mjs')] }]);
    const result = await restartServicesForClone(o);
    expect(result.skipped[0]?.reason).toBe('built-in-never');
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('invalid Program is flagged instead of trusting a clone-looking argv0', async () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', Program: null, ProgramArguments: [join(cloneRoot, 'sampler.mjs')] }]);
    const result = await restartServicesForClone(o);
    expect(result.flagged).toHaveLength(1); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('expands tilde and excludes selfLabel', () => {
    const o = fixture([{ Label: 'com.we.self', ProgramArguments: ['~/clone/run.mjs'] }]);
    o.cloneRoot = join(homedir(), 'clone');
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
    expect(findServicesRunningFromClone({ ...o, selfLabel: 'com.we.self' }).matches).toEqual([]);
  });
  it.each(['com.we.writer', 'com.webeverything.writer'])('default policy never restarts non-approved writer %s', async label => {
    const o = fixture([{ Label: label, ProgramArguments: [join(cloneRoot, 'writer.mjs')] }]);
    const result = await restartServicesForClone(o);
    expect(result.skipped[0].reason).toBe('stateless-approval-required');
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('namespace wildcard cannot approve a stateless service; exact approval is required', async () => {
    const o = fixture([{ Label: 'com.we.writer', ProgramArguments: [join(cloneRoot, 'writer.mjs')] }]);
    await restartServicesForClone({ ...o, settings: { allow: ['*'], approvedStatelessLabels: ['com.we.*'] } });
    expect(o.launchctl).not.toHaveBeenCalled();
    expect((await restartServicesForClone({ ...o, settings: { approvedStatelessLabels: ['com.we.writer'] } })).restarted).toHaveLength(1);
  });
  it('restart argv exact with setting provenance logged', async () => {
    const o = fixture(); expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect(o.launchctl).toHaveBeenCalledWith(['kickstart', '-k', 'gui/501/com.we.resource-sampler']);
    expect(o.log.mock.calls.flat().join(' ')).toMatch(/source.*standard/);
  });
  it('denylist beats allowlist and unallowed labels skip', async () => {
    for (const settings of [{ allow: ['com.we.*'], deny: ['com.we.resource*'] }, { allow: ['com.we.other'] }]) {
      const o = fixture(); await restartServicesForClone({ ...o, settings }); expect(o.launchctl).not.toHaveBeenCalled();
    }
  });
  it.each(['dev', 'vite', 'storybook', 'playground', 'npm-start'])('built-in dev-server never: %s', async name => {
    const o = fixture([{ Label: `com.we.${name}`, ProgramArguments: [join(cloneRoot, 'run.mjs')] }]);
    const r = await restartServicesForClone({ ...o, settings: { allow: ['*'], approvedStatelessLabels: [`com.we.${name}`] } });
    expect(r.skipped[0].reason).toBe('built-in-never'); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it.each(['vite', 'webpack-dev-server', 'npm start', 'npm run dev'])('built-in dev-server argv never: %s', async arg => {
    const o = fixture([{ Label: 'com.we.server', ProgramArguments: [join(cloneRoot, 'run.mjs'), ...arg.split(' ')] }]);
    const r = await restartServicesForClone({ ...o, settings: { approvedStatelessLabels: ['com.we.server'] } });
    expect(r.skipped[0].reason).toBe('built-in-never'); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it.each([
    ['npm', '--prefix', 'X', 'run', 'dev'], ['npm', 'run', '--silent', 'dev'],
    ['npm', '--prefix', 'X', 'start'], ['npm', 'run', '--workspace=X', 'serve'],
    ['npx', 'vite'], ['yarn', 'dev'], ['pnpm', 'dev'], ['bun', 'run', 'dev'],
    ['next', 'dev'], ['storybook', 'dev'],
  ])('dev-server exclusion parses argv tokens conservatively: %j', async (...args) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: [join(cloneRoot, 'sampler.mjs'), ...args] }]);
    const r = await restartServicesForClone(o);
    expect(r.skipped[0]?.reason).toBe('built-in-never'); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it.each([
    ['nuxt', 'dev'], ['astro', 'dev'], ['next', 'dev'], ['python', '-m', 'http.server'], ['python3', '-m', 'http.server'],
    ['php', '-S', 'localhost:8080'], ['serve'], ['live-server'], ['parcel'], ['rollup', '-w'],
    ['rollup', '--watch'], ['esbuild', '--serve'], ['esbuild', '--serve=localhost:8080'], ['wrangler', 'dev'], ['ng', 'serve'],
  ])('extended dev-server exclusion never restarts: %j', async (...args) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: [join(cloneRoot, 'sampler.mjs'), ...args] }]);
    const result = await restartServicesForClone(o);
    expect(result.skipped[0]?.reason).toBe('built-in-never'); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('fresh-service evidence is emitted only for inspected fresh or not-running services', () => {
    const onFreshService = vi.fn();
    const o = { ...fixture(), readAdoptedAtMs: () => 200_000, onFreshService };
    findStaleCodeServices({ ...o, readProcessStartMs: () => 300_000 });
    findStaleCodeServices({ ...o, readProcessStartMs: () => null });
    expect(onFreshService).toHaveBeenCalledTimes(2);
    expect(onFreshService).toHaveBeenCalledWith(expect.objectContaining({ label: 'com.we.resource-sampler' }));
    findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000 });
    findStaleCodeServices({ ...o, readProcessStartMs: () => NaN });
    findStaleCodeServices({ ...o, readProcessStartMs: () => 300_000, readAdoptedAtMs: () => NaN });
    expect(onFreshService).toHaveBeenCalledTimes(2);
  });
  it('disabled setting skips and environment overrides tool and platform', async () => {
    const o = fixture(); await restartServicesForClone({ ...o, platform: { enabled: true }, settings: { enabled: true }, envValues: { enabled: false } });
    expect(o.launchctl).not.toHaveBeenCalled(); expect(o.log.mock.calls.flat().join(' ')).toMatch(/env/);
  });
  it('unreadable and unparseable plist flagged not restarted', async () => {
    const o = fixture([new Error('bad plist'), { Label: 'com.we.bad' }]);
    expect(findServicesRunningFromClone(o).unreadable).toHaveLength(2);
    expect((await restartServicesForClone(o)).flagged).toHaveLength(2); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('debounce and same-sha prevent restart storms across calls', async () => {
    const o = fixture(); await restartServicesForClone(o);
    await restartServicesForClone({ ...o, adoptedSha: 'next' });
    await restartServicesForClone({ ...o, now: () => 2_000_000 }); expect(o.launchctl).toHaveBeenCalledTimes(1);
    await restartServicesForClone({ ...o, adoptedSha: 'next', now: () => 2_000_000 }); expect(o.launchctl).toHaveBeenCalledTimes(2);
  });
  it('persist intent before kickstart and same sha twice produces one kickstart', async () => {
    const o = fixture();
    o.launchctl.mockImplementation(() => {
      expect(o.stateStore.get('com.we.resource-sampler')).toEqual({ at: o.now(), sha: o.adoptedSha });
      return { status: 0 };
    });
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect((await restartServicesForClone(o)).skipped[0].reason).toBe('same-adopted-sha');
    expect(o.launchctl).toHaveBeenCalledTimes(1);
  });
  it('intent write failure refuses kickstart and is flagged for operator inspection', async () => {
    const o = fixture(); o.stateStore.set = () => { throw new Error('disk full'); };
    const r = await restartServicesForClone(o);
    expect(o.launchctl).not.toHaveBeenCalled(); expect(r.restarted).toEqual([]);
    expect(r.flagged[0]?.reason).toMatch(/state.*inspect/i);
  });
  it.each([null, false, 0, '', [], {}, { at: 'bad', sha: 's' }, { at: 100, sha: null }].map(previous => [previous]))('only undefined is missing persisted state: %j', async previous => {
    const o = fixture(); o.stateStore.set('com.we.resource-sampler', previous);
    const r = await restartServicesForClone(o);
    expect(o.launchctl).not.toHaveBeenCalled(); expect(r.restarted).toEqual([]);
    expect(r.flagged[0]?.reason).toMatch(/state.*inspect/i);
  });
  it('launchctl failure does not throw or mark successful restart', async () => {
    const o = fixture(); o.launchctl.mockImplementation(() => { throw new Error('launchctl failed'); });
    const r = await restartServicesForClone(o); expect(r.errors).toHaveLength(1); expect(r.restarted).toEqual([]); expect(o.stateStore.get('com.we.resource-sampler')).toEqual({ at: o.now(), sha: o.adoptedSha });
    expect((await restartServicesForClone(o)).skipped[0].reason).toBe('same-adopted-sha');
    expect(o.launchctl).toHaveBeenCalledTimes(1);
  });
  it('unreadable agents directory is flagged with no restart', async () => {
    const o = fixture(); o.listPlists = () => { throw new Error('permission denied'); };
    expect((await restartServicesForClone(o)).flagged).toHaveLength(1);
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('oversized plist output fails closed with an operator fallback', async () => {
    const o = fixture([new Error('stdout maxBuffer length exceeded')]);
    const r = await restartServicesForClone(o);
    expect(r.flagged[0].reason).toMatch(/inspect and repair/); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('corrupt persisted restart state refuses restart', async () => {
    const o = fixture(); o.stateStore.set('com.we.resource-sampler', { sha: 'legacy' });
    expect((await restartServicesForClone(o)).errors[0].reason).toMatch(/inspect persisted state/);
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('concurrent calls do not restart an in-flight label twice', async () => {
    const o = fixture(); let finish, markLaunched;
    const launched = new Promise(resolve => { markLaunched = resolve; });
    o.launchctl.mockImplementation(() => new Promise(resolve => { finish = resolve; markLaunched(); }));
    const first = restartServicesForClone(o);
    // The helper may asynchronously inspect several host resources before launchctl.
    const second = await restartServicesForClone(o);
    expect(second.skipped[0].reason).toBe('restart-in-flight');
    await launched; finish({ status: 0 }); await first; expect(o.launchctl).toHaveBeenCalledTimes(1);
  });
  it.each(['busy', 'error', 'unknown'])('restart lock acquisition fails closed with operator fallback: %s', async mode => {
    const o = fixture(), get = vi.spyOn(o.stateStore, 'get');
    o.lockStore.acquire = async () => { if (mode === 'error') throw new Error('permission denied'); return mode === 'busy' ? null : undefined; };
    const result = await restartServicesForClone(o);
    expect(get).not.toHaveBeenCalled(); expect(o.launchctl).not.toHaveBeenCalled();
    expect(result.flagged[0].reason).toMatch(/inspect.*lock|lock.*inspect/i);
  });
  it.each(['success', 'same-sha', 'state failure', 'launch failure'])('releases the label lock after %s', async outcome => {
    const o = fixture(), release = vi.fn(async () => {});
    o.lockStore.acquire = vi.fn(async () => release);
    if (outcome === 'same-sha') o.stateStore.set('com.we.resource-sampler', { at: o.now(), sha: o.adoptedSha });
    if (outcome === 'state failure') o.stateStore.set = () => { throw new Error('disk full'); };
    if (outcome === 'launch failure') o.launchctl.mockImplementation(() => { throw new Error('launchctl failed'); });
    await restartServicesForClone(o);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('lock release failure is flagged and never throws', async () => {
    const o = fixture(); o.lockStore.acquire = async () => async () => { throw new Error('release denied'); };
    const result = await restartServicesForClone(o);
    expect(result.flagged[0].reason).toMatch(/release-failed.*inspect/i);
    expect(result.errors).toHaveLength(1);
  });
  it('two adopting processes contending for one label perform exactly one kickstart', async () => {
    const root = await fsAsync.mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'launchd-two-process-'));
    const moduleUrl = pathToFileURL(resolve('scripts/lib/launchd-code-restart.mjs')).href;
    const workerSource = String.raw`
      import fs from 'node:fs/promises';
      import { join } from 'node:path';
      import { restartServicesForClone } from ${JSON.stringify(moduleUrl)};
      const root = process.argv[1], cloneRoot = process.argv[2], statePath = join(root, 'state.json');
      const released = new Promise(resolve => process.once('message', resolve));
      const stateStore = {
        async get() {
          let previous;
          try { previous = JSON.parse(await fs.readFile(statePath, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          process.send({ type: 'read' });
          await released;
          return previous;
        },
        async set(label, value) {
          const temp = statePath + '.' + process.pid;
          await fs.writeFile(temp, JSON.stringify(value)); await fs.rename(temp, statePath);
        },
      };
      const result = await restartServicesForClone({
        cloneRoot, agentsDir: root,
        listPlists: () => ['sampler.plist'],
        readPlist: () => ({ Label: 'com.we.resource-sampler', ProgramArguments: ['node', join(cloneRoot, 'sampler.mjs')] }),
        launchctl: async argv => { await fs.appendFile(join(root, 'kicks.jsonl'), JSON.stringify(argv) + '\n'); return { status: 0 }; },
        uid: () => 501, stateStore, adoptedSha: 'shared-adoption', platform: null, env: {}, log: () => {},
      });
      process.send({ type: 'result', result }, () => process.disconnect());
    `;
    const workers = [];
    function startWorker() {
      const child = childProcess.spawn(process.execPath, ['--input-type=module', '-e', workerSource, root, cloneRoot],
        { env: { ...process.env, HOME: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const messages = [], waiters = [];
      let stderr = '';
      const deliver = message => waiters.length ? waiters.shift()(message) : messages.push(message);
      child.on('message', deliver);
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-16_384); });
      const closed = new Promise(resolve => {
        child.once('error', error => deliver({ type: 'error', error: String(error) }));
        child.once('close', (code, signal) => {
          const end = { type: 'closed', code, signal, stderr };
          deliver(end); resolve(end);
        });
      });
      const worker = { child, closed, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)) };
      workers.push(worker); return worker;
    }
    try {
      const first = startWorker();
      expect(await first.next()).toEqual({ type: 'read' });
      const second = startWorker(), secondEvent = await second.next();
      expect(['read', 'result']).toContain(secondEvent.type);
      // The first reader stays paused until the second process has tried the same lock.
      first.child.send('release');
      if (secondEvent.type === 'read') second.child.send('release');
      const firstResult = await first.next();
      const secondResult = secondEvent.type === 'result' ? secondEvent : await second.next();
      expect((await Promise.all(workers.map(worker => worker.closed))).map(end => end.code)).toEqual([0, 0]);
      const kicks = (await fsAsync.readFile(join(root, 'kicks.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      expect(kicks).toEqual([['kickstart', '-k', 'gui/501/com.we.resource-sampler']]);
      expect(firstResult.result.restarted).toHaveLength(1);
      expect(secondResult.result.skipped[0].reason).toBe('restart-lock-held');
    } finally {
      workers.forEach(({ child }) => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      await Promise.all(workers.map(worker => worker.closed));
      await fsAsync.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
  it('nonzero launchctl status is failure', async () => {
    const o = fixture(); o.launchctl.mockReturnValue({ status: 1, stderr: 'denied' });
    expect((await restartServicesForClone(o)).errors).toHaveLength(1);
  });
  it.each([[100_000, true], [200_000, false], [300_000, false], [null, false]])('stale flag true/false/not-running start=%s', (start, stale) => {
    expect(findStaleCodeServices({ ...fixture(), readProcessStartMs: () => start, readAdoptedAtMs: () => 200_000 }).some(x => x.reason === 'stale-code')).toBe(stale);
  });
  it('production ps lstart parser compares adoption at whole-second precision', () => {
    const output = 'Thu Nov 05 01:02:03 2026';
    const start = Date.parse(output), ps = vi.fn(() => output);
    const o = { ...fixture(), ps };
    const hostPs = vi.spyOn(childProcess, 'execFileSync').mockReturnValue(output);
    try {
      expect(findStaleCodeServices({ ...o, readAdoptedAtMs: () => start + 750 })).toEqual([]);
      expect(ps).toHaveBeenCalledWith(['-o', 'lstart=', '-p', '42']);
      expect(findStaleCodeServices({ ...o, readAdoptedAtMs: () => start + 1000 })[0].reason).toBe('stale-code');
    } finally { hostPs.mockRestore(); }
  });
  it('stale detection flags process-reader errors rather than declaring clean', () => {
    const result = findStaleCodeServices({ ...fixture(), readProcessStartMs: () => { throw new Error('ps failed'); } });
    expect(result[0].reason).toBe('process-unreadable');
  });
  it('stale detection flags unreadable plists and unknown timestamps', () => {
    expect(findStaleCodeServices({ ...fixture([new Error('bad')]), readAdoptedAtMs: () => 200 })).toEqual([expect.objectContaining({ label: null, reason: 'plist-unreadable' })]);
    expect(findStaleCodeServices({ ...fixture(), readProcessStartMs: () => 100, readAdoptedAtMs: () => NaN })[0].reason).toBe('adoption-unreadable');
  });
});
describe('withSelfSync default service-restart wiring', () => {
  it('real-IO path restarts services with the real launchd restart', () => {
    expect(resolveRestartServices(undefined, true)).toBe(restartServicesForClone);
  });
  it('injected-rebuild (hermetic) path defaults to a no-op that never reaches launchd', async () => {
    const real = vi.fn(), restart = resolveRestartServices(undefined, false, real);
    expect(restart).not.toBe(real);
    await restart({ cloneRoot });
    expect(real).not.toHaveBeenCalled();
  });
  it('an injected restartServices hook wins on both paths', () => {
    const hook = vi.fn();
    expect(resolveRestartServices(hook, true)).toBe(hook);
    expect(resolveRestartServices(hook, false)).toBe(hook);
  });
});
describe('withSelfSync service restart hook', () => {
  function wrapped(result, restartServices, overrides = {}) {
    return withSelfSync({ tickOnce: () => 'ticked' }, {
      root: cloneRoot, env: { XPC_SERVICE_NAME: 'com.we.self' }, versions: null, background: null,
      onRestart: () => 'restarted', rebuild: async () => result, restartServices,
      readHead: () => 'boot', readOriginRef: () => null, readState: () => ({}), readReady: () => null,
      cloneIdentity: () => null, acquireRead: () => ({ ok: true }), releaseRead: () => {},
      importClosure: () => new Set(), diffFiles: () => [], log: { error: vi.fn() }, ...overrides });
  }
  it('adopter waits for slow restartServices completion before onRestart can exit', async () => {
    vi.useFakeTimers(); let finish;
    const events = [], onRestart = vi.fn(() => { events.push('exit'); return 'restarted'; });
    const restart = () => new Promise(resolve => { finish = () => { events.push('kicked'); resolve(); }; });
    try {
      const pending = wrapped({ moved: true, adopted: true, head: 'new' }, restart, { onRestart, diffFiles: () => null }).tickOnce();
      await vi.advanceTimersByTimeAsync(0);
      expect(onRestart).not.toHaveBeenCalled();
      finish(); await expect(pending).resolves.toBe('restarted');
      expect(events).toEqual(['kicked', 'exit']);
    } finally { finish?.(); vi.useRealTimers(); }
  });
  it('a recovered adoption (moved=false, adopted=true) restarts services once with the adopted head', async () => {
    const restart = vi.fn(async () => {});
    await wrapped({ moved: false, adopted: true, reason: 'recovered-adopted', head: 'recovered-sha' }, restart, { diffFiles: () => null }).tickOnce();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart.mock.calls[0][0]).toMatchObject({ adoptedSha: 'recovered-sha' });
  });
  it.each([
    ['up-to-date', { moved: false, adopted: false, reason: 'up-to-date', head: 'same' }],
    ['adopted without a move or recovery', { moved: false, adopted: true, reason: 'other', head: 'same' }],
    ['moved but not adopted', { moved: true, adopted: false, head: 'new' }],
  ])('a %s result does not restart services', async (_name, result) => {
    const restart = vi.fn(async () => {});
    await wrapped(result, restart, { diffFiles: () => null }).tickOnce();
    expect(restart).not.toHaveBeenCalled();
  });
  it('hung restartServices times out at default 15 seconds with operator fallback', async () => {
    vi.useFakeTimers(); const log = { error: vi.fn() }, onRestart = vi.fn(() => 'restarted');
    try {
      const pending = wrapped({ moved: true, adopted: true, head: 'new' }, () => new Promise(() => {}),
        { log, onRestart, diffFiles: () => null }).tickOnce();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(onRestart).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe('restarted');
      expect(log.error.mock.calls.flat().join(' ')).toMatch(/timed out.*15000.*inspect/i);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(['inspection', 'state persistence', 'lock acquisition'])('timeout cancellation prevents late kickstarts when delayed %s resumes', async stage => {
    vi.useFakeTimers();
    const o = fixture(), log = { error: vi.fn() }, onRestart = vi.fn(() => 'restarted');
    let release, markStarted, restartDone, signal;
    const blocked = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    if (stage === 'inspection') {
      const read = o.readPlist;
      o.readPlist = async path => { markStarted(); await blocked; return read(path); };
    } else if (stage === 'lock acquisition') {
      const acquire = o.lockStore.acquire;
      o.lockStore.acquire = async label => { markStarted(); await blocked; return acquire(label); };
    } else {
      const persist = o.stateStore.set.bind(o.stateStore);
      o.stateStore.set = async (label, value) => { markStarted(); await blocked; persist(label, value); };
    }
    const restart = args => {
      signal = args.signal;
      restartDone = restartServicesForClone({ ...o, ...args, platform: null });
      return restartDone;
    };
    try {
      const pendingTick = wrapped({ moved: true, adopted: true, head: 'new' }, restart,
        { log, onRestart, diffFiles: () => null }).tickOnce();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      expect(signal.aborted).toBe(false);
      expect(onRestart).not.toHaveBeenCalled();
      expect(o.launchctl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pendingTick).resolves.toBe('restarted');
      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(true);
      expect(o.launchctl).not.toHaveBeenCalled();
      // Resume the helper AFTER the adopter has proceeded, then observe all remaining work.
      release();
      const result = await restartDone;
      expect(result.restarted).toEqual([]);
      expect(result.errors.some(error => error.reason.includes('cancelled'))).toBe(true);
      expect(o.launchctl).not.toHaveBeenCalled();
      if (stage === 'state persistence') {
        expect(o.stateStore.get('com.we.resource-sampler')).toEqual({ at: o.now(), sha: 'new' });
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(); vi.useRealTimers(); }
  });
  it('production plist inspection stays asynchronous while tick awaits completed kickstart', async () => {
    const o = fixture(); let completePlutil, restartDone, markInspectionStarted;
    const inspectionStarted = new Promise(resolve => { markInspectionStarted = resolve; });
    const readDir = vi.spyOn(fsAsync, 'readdir').mockResolvedValue(['0.plist']);
    const exec = vi.spyOn(childProcess, 'execFile').mockImplementation((command, argv, options, callback) => {
      expect(command).toBe('plutil');
      completePlutil = callback; markInspectionStarted();
      return {};
    });
    try {
      const restart = args => {
        const { listPlists, readPlist, ...hostDefaults } = o;
        restartDone = restartServicesForClone({ ...hostDefaults, ...args, platform: null });
        return restartDone;
      };
      let tickDone = false;
      const pendingTick = wrapped({ moved: true, adopted: true, head: 'new' }, restart).tickOnce();
      void pendingTick.then(() => { tickDone = true; });
      await inspectionStarted;
      expect(tickDone).toBe(false);
      expect(readDir).toHaveBeenCalledWith(o.agentsDir);
      expect(exec).toHaveBeenCalledWith('plutil', ['-convert', 'json', '-o', '-', join(o.agentsDir, '0.plist')], expect.objectContaining({ timeout: 5000 }), expect.any(Function));
      expect(o.launchctl).not.toHaveBeenCalled();
      let settled = false;
      void restartDone.then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      completePlutil(null, JSON.stringify({ Label: 'com.we.resource-sampler', ProgramArguments: [join(cloneRoot, 'sampler.mjs')] }), '');
      expect((await restartDone).restarted).toHaveLength(1);
      await expect(pendingTick).resolves.toBe('ticked');
      expect(o.launchctl).toHaveBeenCalledTimes(1);
    } finally { readDir.mockRestore(); exec.mockRestore(); }
  });
  it.each([{ moved: true, adopted: true, head: 'new' }, { moved: true }, { adopted: true }, {}])('fires on moved+adopted and not otherwise: %j', async result => {
    const restart = vi.fn(); await wrapped(result, restart).tickOnce();
    expect(restart).toHaveBeenCalledTimes(result.moved && result.adopted ? 1 : 0);
    if (result.adopted && result.moved) expect(restart).toHaveBeenCalledWith(expect.objectContaining({ cloneRoot, selfLabel: 'com.we.self', adoptedSha: 'new' }));
  });
  it.each([() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom')), () => new Promise(() => {})])('throwing, rejecting or pending restartServices does not fail tick beyond the bound', async restart => {
    vi.useFakeTimers();
    try {
      const pending = wrapped({ moved: true, adopted: true, head: 'new' }, restart).tickOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toBe('ticked');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('launchd clone ownership: interpreter options and filesystem aliases', () => {
  const sampler = { Label: 'com.we.resource-sampler' };
  it.each([
    ['attached memory flag', ['--max-old-space-size=512']],
    ['attached value flag', ['--stack-size=984']],
    ['operand-free flag', ['--expose-gc']],
    ['two flags', ['--max-old-space-size=512', '--no-deprecation']],
  ])('node option does not hide a clone script: %s', async (_name, opts) => {
    const o = fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', ...opts, join(cloneRoot, 'sampler.mjs')] }]);
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 1000, readAdoptedAtMs: () => 2000 }))
      .toEqual([expect.objectContaining({ reason: 'stale-code' })]);
  });
  it('an unrecognized bare option before a clone path is surfaced as unreadable evidence, not silently excluded', async () => {
    const o = fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', '--made-up-option', join(cloneRoot, 'sampler.mjs')] }]);
    expect(findServicesRunningFromClone(o).unreadable).toEqual([expect.objectContaining({ error: expect.stringMatching(/--made-up-option/) })]);
    expect((await restartServicesForClone(o)).flagged).toEqual([expect.objectContaining({ reason: expect.stringMatching(/^plist-unreadable/) })]);
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 1000, readAdoptedAtMs: () => 2000 }))
      .toEqual([expect.objectContaining({ reason: 'plist-unreadable' })]);
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('an unrecognized option with no clone path anywhere stays quietly unrelated', () => {
    const o = fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', '--made-up-option', resolve('..', 'other-clone', 'sampler.mjs')] }]);
    expect(findServicesRunningFromClone(o)).toEqual({ matches: [], unreadable: [] });
  });
  it('symlink alias of the clone is still the clone (sync, async restart and stale detection)', async () => {
    const dir = await fsAsync.realpath(await fsAsync.mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'launchd-alias-')));
    try {
      const real = join(dir, 'clone'), alias = join(dir, 'alias');
      await fsAsync.mkdir(real); await fsAsync.symlink(real, alias);
      for (const [root, script] of [[real, join(alias, 'sampler.mjs')], [alias, join(real, 'sampler.mjs')]]) {
        const o = { ...fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', script] }]), cloneRoot: root };
        expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
        expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
        expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 1000, readAdoptedAtMs: () => 2000 }))
          .toEqual([expect.objectContaining({ reason: 'stale-code' })]);
      }
      const other = { ...fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', join(dir, 'clone2', 'sampler.mjs')] }]), cloneRoot: alias };
      expect(findServicesRunningFromClone(other).matches).toEqual([]);
    } finally { await fsAsync.rm(dir, { recursive: true, force: true }); }
  });
  it('a path that merely contains "vite" (vitest temp dir, vite-named folder) is not a dev server; real dev-server argv still is', async () => {
    const root = join(cloneRoot, 'we-vitest-501', 'vite-tools');
    const o = { ...fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', join(root, 'sampler.mjs')] }]), cloneRoot: root };
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    for (const argv of [['/bin/sh', '-c', 'vite --port 3000'], ['/bin/sh', '-c', 'npm run dev'], [join(root, 'node_modules/.bin/vite')]]) {
      const d = { ...fixture([{ ...sampler, ProgramArguments: argv }]), cloneRoot: root };
      const r = await restartServicesForClone(d);
      expect(r.restarted).toEqual([]);
      expect(r.skipped.length === 1 ? r.skipped[0].reason : 'not-matched').toMatch(/^(?:built-in-never|not-matched)$/);
    }
  });
  it('the existing /var vs /private/var alias is canonicalized', async () => {
    const real = await fsAsync.realpath(process.env.TMPDIR ?? '/tmp');
    const lexical = join(process.env.TMPDIR ?? '/tmp', 'x');
    if (real === process.env.TMPDIR?.replace(/\/$/, '')) return; // no alias on this host
    const o = { ...fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', join(lexical, 'sampler.mjs')] }]), cloneRoot: join(real, 'x') };
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
  });
  it('an unreadable clone root fails closed as unreadable evidence', async () => {
    const o = { ...fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', join(cloneRoot, 'sampler.mjs')] }]),
      realpath: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    expect(findServicesRunningFromClone(o).unreadable).toHaveLength(1);
    const asyncOptions = { ...o, realpath: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    expect((await restartServicesForClone(asyncOptions)).flagged).toHaveLength(1);
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('an unresolvable path unrelated to the clone does not flag the service (sync and async)', async () => {
    const fails = path => { if (path.startsWith('/protected')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return path; };
    const o = { ...fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', '/protected/run.mjs'] }]), realpath: fails };
    expect(findServicesRunningFromClone(o)).toEqual({ matches: [], unreadable: [] });
    expect((await restartServicesForClone({ ...o, realpath: async p => fails(p) })).flagged).toEqual([]);
  });
  it('an unresolvable realpath on a path inside the clone still matches, sync and async alike', async () => {
    const o = { ...fixture(), realpath: path => { if (path.startsWith(cloneRoot + '/')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return path; } };
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
    expect((await restartServicesForClone({ ...o, realpath: async p => o.realpath(p) })).restarted).toHaveLength(1);
  });
  it.each([
    ['later data path', ['/usr/local/bin/node', '--made-up-option', '/other/x.mjs', 'mode', join(cloneRoot, 'cfg.json')]],
    ['option operand then other script', ['/usr/local/bin/node', '--made-up-option', 'v', '/other/x.mjs', join(cloneRoot, 'cfg.json')]],
  ])('unknown option does not flag on a clone path in script data: %s', (_n, ProgramArguments) => {
    expect(findServicesRunningFromClone(fixture([{ ...sampler, ProgramArguments }]))).toEqual({ matches: [], unreadable: [] });
  });
  it('unknown option followed by an operand then a clone script is still surfaced', () => {
    const o = fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', '--made-up-option', '512', join(cloneRoot, 'sampler.mjs')] }]);
    expect(findServicesRunningFromClone(o).unreadable).toHaveLength(1);
  });
});

describe('python interpreter options never hide a clone script', () => {
  const sampler = { Label: 'com.we.resource-sampler' };
  it.each([
    ['-O optimise flag', ['-O']],
    ['-OO optimise flags', ['-OO']],
    ['-O combined with -u', ['-O', '-u']],
    ['-B -d -q -R flags', ['-B', '-d', '-q', '-R']],
    ['-W with separate operand', ['-W', 'ignore']],
    ['-W with attached operand', ['-Wignore']],
    ['-X with separate operand', ['-X', 'dev']],
    ['-X with attached operand', ['-Xdev']],
    ['-O before -W operand', ['-O', '-W', 'error']],
  ])('python %s before a clone script still matches (sync, async restart, stale detection)', async (_name, opts) => {
    const o = fixture([{ ...sampler, ProgramArguments: ['/usr/bin/python3', ...opts, join(cloneRoot, 'sampler.py')] }]);
    expect(findServicesRunningFromClone(o)).toEqual({ matches: [expect.objectContaining({ label: sampler.Label })], unreadable: [] });
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 1000, readAdoptedAtMs: () => 2000 }))
      .toEqual([expect.objectContaining({ reason: 'stale-code' })]);
  });
  it('python -O with an unrelated script and a clone data path stays unrelated', () => {
    const o = fixture([{ ...sampler, ProgramArguments: ['/usr/bin/python3', '-O', resolve('..', 'other', 'x.py'), cloneRoot] }]);
    expect(findServicesRunningFromClone(o)).toEqual({ matches: [], unreadable: [] });
  });
});

describe('stale detection honours the restart policy', () => {
  const stale = o => findStaleCodeServices({ ...o, readProcessStartMs: () => 1000, readAdoptedAtMs: () => 2000 });
  const svc = (Label, ProgramArguments = ['node', join(cloneRoot, 'sampler.mjs')]) => ({ Label, ProgramArguments });
  it.each([
    ['dev-server label', svc('com.we.dev-server')],
    ['dev-server argv', svc('com.we.web', [join(cloneRoot, 'node_modules/.bin/vite')])],
    ['non-allowed namespace', svc('com.other.writer')],
    ['allowed but not approved stateless', svc('com.we.writer')],
  ])('a service policy never restarts is not flagged stale: %s', (_n, plist) => {
    const fresh = vi.fn();
    expect(stale({ ...fixture([plist]), onFreshService: fresh })).toEqual([]);
    expect(fresh).not.toHaveBeenCalled();
  });
  it('an explicitly denied label is not flagged; the approved sampler still is', () => {
    const o = fixture([svc('com.we.resource-sampler'), svc('com.we.denied')]);
    expect(stale({ ...o, settings: { deny: ['com.we.denied'], approvedStatelessLabels: ['com.we.resource-sampler', 'com.we.denied'] } }).map(f => f.label)).toEqual(['com.we.resource-sampler']);
  });
  it('the adopting daemon itself (selfLabel) is not flagged stale', () => {
    const o = fixture([svc('com.we.resource-sampler')]);
    expect(stale({ ...o, selfLabel: 'com.we.resource-sampler' })).toEqual([]);
    expect(stale(o)).toHaveLength(1);
  });
});

describe('interpreter option shapes that once hid a clone script (value contains "c", shell -e, ruby -I)', () => {
  const script = name => join(cloneRoot, name);
  it.each([
    ['python -W attached value containing c', ['/usr/bin/python3', '-Wignore::DeprecationWarning', script('s.py')]],
    ['python -X attached value containing c', ['/usr/bin/python3', '-Xcpu_count=2', script('s.py')]],
    ['python -O then -W attached with c', ['/usr/bin/python3', '-O', '-Wignore::ResourceWarning', script('s.py')]],
    ['bash -e errexit flag', ['/bin/bash', '-e', script('s.sh')]],
    ['sh -eu combined flags', ['/bin/sh', '-eu', script('s.sh')]],
    ['ruby -I with separate directory', ['/usr/bin/ruby', '-I', 'lib', script('s.rb')]],
    ['ruby -I attached directory', ['/usr/bin/ruby', '-Ilib', script('s.rb')]],
    ['perl -I with separate directory', ['/usr/bin/perl', '-I', 'lib', script('s.pl')]],
  ])('%s still matches the clone script', async (_name, ProgramArguments) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]);
    expect(findServicesRunningFromClone(o)).toEqual({ matches: [expect.objectContaining({ label: 'com.we.resource-sampler' })], unreadable: [] });
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
  });
  it.each([
    ['bash -c inline program', ['/bin/bash', '-c', `cat ${join(cloneRoot, 'data.txt')}`]],
    ['bash -ec inline program', ['/bin/bash', '-ec', `cat ${join(cloneRoot, 'data.txt')}`]],
    ['node -e inline program', ['/usr/bin/node', '-e', 'run()', join(cloneRoot, 'data.txt')]],
    ['python -c inline program', ['/usr/bin/python3', '-c', 'pass', join(cloneRoot, 'data.txt')]],
  ])('inline-program option %s never makes a clone data path the script', (_name, ProgramArguments) => {
    expect(findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]))).toEqual({ matches: [], unreadable: [] });
  });
  const outside = resolve('..', 'bin', 'node');
  it.each([
    ['relative script', [outside, 'scripts/conveyor/resource-sampler-daemon.mjs']],
    ['dot-relative script', [outside, './sampler.mjs']],
    ['bare script name', [outside, 'sampler.mjs']],
    ['interpreter flag before script', [outside, '--no-warnings', 'scripts/sampler.mjs']],
    ['after --', [outside, '--', 'scripts/sampler.mjs']],
    ['relative executable', ['./bin/sampler']],
    ['env wrapper', ['/usr/bin/env', outside, 'scripts/sampler.mjs']],
  ])('explicit WorkingDirectory in the clone anchors a %s', async (_name, ProgramArguments) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments, WorkingDirectory: cloneRoot }]);
    expect(findServicesRunningFromClone(o).matches.map(x => x.label)).toEqual(['com.we.resource-sampler']);
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 })).toHaveLength(1);
  });
  it.each([
    ['no WorkingDirectory', undefined, 'scripts/sampler.mjs'],
    ['relative WorkingDirectory', 'clone', 'scripts/sampler.mjs'],
    ['WorkingDirectory outside the clone', resolve('..', 'other-clone'), 'scripts/sampler.mjs'],
    ['bare executable name is a PATH lookup, not cwd-relative', cloneRoot, undefined],
  ])('does not claim a relative script without an in-clone absolute anchor: %s', (_name, WorkingDirectory, script) => {
    const ProgramArguments = script ? [outside, script] : ['sampler'];
    expect(findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments, WorkingDirectory }])).matches).toEqual([]);
  });
  it.each([
    ['plain env', ['/usr/bin/env', outside, join(cloneRoot, 'sampler.mjs')], true],
    ['env with assignments', ['/usr/bin/env', 'A=1', 'B=two', outside, join(cloneRoot, 'sampler.mjs')], true],
    ['env -i / -u NAME', ['/usr/bin/env', '-i', '-u', 'HOME', outside, join(cloneRoot, 'sampler.mjs')], true],
    ['env -- separator', ['/usr/bin/env', '--', outside, join(cloneRoot, 'sampler.mjs')], true],
    ['env with interpreter flags', ['/usr/bin/env', 'A=1', outside, '--no-warnings', join(cloneRoot, 'sampler.mjs')], true],
    ['env of a clone executable', ['/usr/bin/env', join(cloneRoot, 'bin', 'sampler')], true],
    ['env -C anchors a relative script', ['/usr/bin/env', '-C', cloneRoot, outside, 'sampler.mjs'], true],
    ['nohup wrapper', ['/usr/bin/nohup', outside, join(cloneRoot, 'sampler.mjs')], true],
    ['nice -n wrapper', ['/usr/bin/nice', '-n', '5', outside, join(cloneRoot, 'sampler.mjs')], true],
    ['nested wrappers', ['/usr/bin/env', 'A=1', '/usr/bin/nohup', outside, join(cloneRoot, 'sampler.mjs')], true],
    ['env around an unrelated script', ['/usr/bin/env', outside, resolve('..', 'other-clone', 'sampler.mjs')], false],
    ['clone path only as script data', ['/usr/bin/env', outside, resolve('..', 'other-clone', 'sampler.mjs'), join(cloneRoot, 'data')], false],
    ['clone path as env assignment value', ['/usr/bin/env', `DATA=${join(cloneRoot, 'x')}`, outside, resolve('..', 'other-clone', 'sampler.mjs')], false],
    ['env -C outside leaves a relative script unproven', ['/usr/bin/env', '-C', resolve('..', 'other-clone'), outside, 'sampler.mjs'], false],
    ['env -u operand is not the program', ['/usr/bin/env', '-u', join(cloneRoot, 'x'), outside, resolve('..', 'other-clone', 'sampler.mjs')], false],
  ])('wrapper commands do not hide the executed program: %s', async (_name, ProgramArguments, owned) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]);
    expect(findServicesRunningFromClone(o).matches).toHaveLength(owned ? 1 : 0);
    expect((await restartServicesForClone(o)).restarted).toHaveLength(owned ? 1 : 0);
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 })).toHaveLength(owned ? 1 : 0);
  });
  describe('same-class wrapper and cwd shapes', () => {
  const script = join(cloneRoot, 'x.mjs'), other = resolve('..', 'other-clone', 'x.mjs');
  it.each([
    ['env -P PATH', ['/usr/bin/env', '-P', '/usr/bin', outside, script]],
    ['env combined -iu', ['/usr/bin/env', '-iu', 'HOME', outside, script]],
    ['env -S string', ['/usr/bin/env', '-S', `${outside} ${script}`]],
    ['env -S attached', ['/usr/bin/env', `-S${outside} ${script}`]],
    ['env --split-string=', ['/usr/bin/env', `--split-string=${outside} ${script}`]],
    ['caffeinate -t N', ['/usr/bin/caffeinate', '-t', '3600', outside, script]],
    ['caffeinate -w N', ['/usr/bin/caffeinate', '-w', '1', outside, script]],
    ['time -o file', ['/usr/bin/time', '-o', '/tmp/f', outside, script]],
    ['arch -arm64', ['/usr/bin/arch', '-arm64', outside, script]],
    ['arch -x86_64', ['/usr/bin/arch', '-x86_64', outside, script]],
    ['taskpolicy -b', ['/usr/bin/taskpolicy', '-b', outside, script]],
    ['sudo -u user', ['/usr/bin/sudo', '-u', 'me', outside, script]],
    ['xcrun', ['/usr/bin/xcrun', outside, script]],
    ['timeout DURATION', ['/usr/bin/timeout', '10', outside, script]],
    ['sandbox-exec -f profile', ['/usr/bin/sandbox-exec', '-f', '/tmp/p.sb', outside, script]],
    ['wrapper chain through a loose wrapper', ['/usr/bin/taskpolicy', '-b', '/usr/bin/env', 'A=1', outside, script]],
    ['loose wrapper around a clone executable', ['/usr/bin/sudo', '-u', 'me', join(cloneRoot, 'bin', 'sampler')]],
    ['unknown env option before a non-interpreter clone program', ['/usr/bin/env', '--mystery', 'operand', join(cloneRoot, 'bin', 'sampler')]],
  ])('same-class wrapper shape is flagged (matched or unreadable), never silently excluded: %s', (_name, ProgramArguments) => {
    const result = findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]));
    expect(result.matches.length + result.unreadable.length).toBe(1);
  });
  it.each([
    ['env -P PATH', ['/usr/bin/env', '-P', '/usr/bin', outside, other]],
    ['env -S string', ['/usr/bin/env', '-S', `${outside} ${other}`]],
    ['arch -arm64', ['/usr/bin/arch', '-arm64', outside, other]],
    ['timeout DURATION', ['/usr/bin/timeout', '10', outside, other]],
    ['sudo -u user', ['/usr/bin/sudo', '-u', 'me', outside, other]],
  ])('wrapper shapes running an unrelated script stay unflagged: %s', (_name, ProgramArguments) => {
    expect(findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]))).toEqual({ matches: [], unreadable: [] });
  });
  it.each([
    ['arch -arm64 with program name and WorkingDirectory', ['/usr/bin/arch', '-arm64', 'node', other]],
    ['env -S with program name and WorkingDirectory', ['/usr/bin/env', '-S', `node ${other}`]],
  ])('a bare program name is never resolved against WorkingDirectory: %s', (_name, ProgramArguments) => {
    expect(findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments, WorkingDirectory: cloneRoot }])))
      .toEqual({ matches: [], unreadable: [] });
  });
  it('relative env -C resolves against the explicit WorkingDirectory', () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', '-C', 'scripts', outside, 'x.mjs'], WorkingDirectory: cloneRoot }]);
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
    const unanchored = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', '-C', 'scripts', outside, 'x.mjs'] }]);
    expect(findServicesRunningFromClone(unanchored).matches).toEqual([]);
  });
  it('env -C survives a later unknown option', () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', '-C', cloneRoot, '--mystery', 'x.mjs'] }]);
    expect(findServicesRunningFromClone(o).unreadable).toHaveLength(0);
    const flagged = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', '-C', cloneRoot, '--mystery', './x.mjs'] }]);
    expect(findServicesRunningFromClone(flagged).unreadable).toHaveLength(1);
  });
  it('deeply nested wrappers fail closed with a clear error instead of a stack overflow', () => {
    const ProgramArguments = [...Array(5000).fill('/usr/bin/env'), outside, script];
    const result = findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]));
    expect(result.matches).toEqual([]);
    expect(result.unreadable[0].error).toMatch(/Too many nested command wrappers/);
  });
  it.each([
    ['sudo first operand', ['/usr/bin/sudo', '-u', 'me', join(cloneRoot, 'bin', 'sampler')]],
    ['timeout first operand', ['/usr/bin/timeout', '10', join(cloneRoot, 'bin', 'sampler')]],
    ['xcrun first operand', ['/usr/bin/xcrun', join(cloneRoot, 'bin', 'sampler')]],
    ['taskpolicy first operand', ['/usr/bin/taskpolicy', '-b', join(cloneRoot, 'bin', 'sampler')]],
    ['interpreter-named word later is data, not the program', ['/usr/bin/sudo', join(cloneRoot, 'bin', 'sampler'), '--runner', 'node']],
    ['interpreter-named path later is data, not the program', ['/usr/bin/timeout', '10', join(cloneRoot, 'bin', 'sampler'), outside]],
    ['nested loose wrappers', ['/usr/bin/taskpolicy', '-b', '/usr/bin/sudo', join(cloneRoot, 'bin', 'sampler')]],
    ['sudo boolean flag, later interpreter word', ['/usr/bin/sudo', '-E', join(cloneRoot, 'bin', 'sampler'), '--runner', 'node']],
    ['sudo -n boolean flag', ['/usr/bin/sudo', '-n', join(cloneRoot, 'bin', 'sampler'), 'node']],
    ['taskpolicy -b boolean flag', ['/usr/bin/taskpolicy', '-b', join(cloneRoot, 'bin', 'sampler'), '--runner', 'node']],
    ['timeout --foreground', ['/usr/bin/timeout', '--foreground', join(cloneRoot, 'bin', 'sampler'), 'node']],
    ['stdbuf -oL', ['/usr/bin/stdbuf', '-oL', join(cloneRoot, 'bin', 'sampler'), 'node']],
    ['sudo -u me then boolean flag', ['/usr/bin/sudo', '-u', 'me', '-E', join(cloneRoot, 'bin', 'sampler'), 'node']],
    ['sudo attached -uwho', ['/usr/bin/sudo', '-uwho', join(cloneRoot, 'bin', 'sampler'), 'node']],
    ['sandbox-exec profile in the clone is claimed', ['/usr/bin/sandbox-exec', '-f', join(cloneRoot, 'p.sb'), '/usr/bin/true']],
  ])('a clone executable as the loose wrapper first operand is matched and restarted: %s', async (_name, ProgramArguments) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]);
    expect(findServicesRunningFromClone(o)).toMatchObject({ matches: [{ label: 'com.we.resource-sampler' }], unreadable: [] });
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 })).toHaveLength(1);
  });
  it.each([
    ['option value path outside the clone', ['/usr/bin/sandbox-exec', '-f', resolve('..', 'other-clone', 'p.sb'), outside, other]],
    ['env assignment with a slash is not a program', ['/usr/bin/sudo', `FOO=${join(cloneRoot, 'x')}`, outside, other]],
    ['unrelated first operand', ['/usr/bin/sudo', '-u', 'me', resolve('..', 'other-clone', 'bin', 'sampler')]],
    ['clone path only as data after an unrelated program', ['/usr/bin/timeout', '10', resolve('..', 'other-clone', 'bin', 'sampler'), 'node', join(cloneRoot, 'data')]],
  ])('loose wrapper operands that are not the program stay unflagged: %s', (_name, ProgramArguments) => {
    expect(findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }])).matches).toEqual([]);
  });
  it('a relative first operand of a loose wrapper resolves against the explicit WorkingDirectory', () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/sudo', './bin/sampler'], WorkingDirectory: cloneRoot }]);
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
  });
  const cloneScript = join(cloneRoot, 'x.mjs');
  it.each([
    ['double quotes', ['/usr/bin/env', '-S', `"${outside}" "${cloneScript}"`]],
    ['single quotes', ['/usr/bin/env', '-S', `'${outside}' '${cloneScript}'`]],
    ['mixed with assignment', ['/usr/bin/env', '-S', `A="b c" "${outside}" "${cloneScript}"`]],
    ['escaped space in the script path', ['/usr/bin/env', '-S', `${outside} ${cloneScript.replace(/[\\ ]/g, '\\$&')} --flag "x y"`]],
    ['attached -S with quotes', ['/usr/bin/env', `-S"${outside}" "${cloneScript}"`]],
    ['quoted whole command', ['/usr/bin/env', '-S', `"${outside}"   "${cloneScript}"`]],
  ])('quoted env -S string is discovered, restarted and flagged stale: %s', async (_name, ProgramArguments) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]);
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
    expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 })).toHaveLength(1);
  });
  it('quoted env -S string running an unrelated script is not claimed', () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', '-S', `"${outside}" "${other}" "${join(cloneRoot, 'data')}"`] }]);
    expect(findServicesRunningFromClone(o).matches).toEqual([]);
  });
  describe('node preload options run clone code before an external entry', () => {
    const boot = join(cloneRoot, 'bootstrap.cjs');
    it.each([
      ['--require', [outside, '--require', boot, other]],
      ['-r', [outside, '-r', boot, other]],
      ['--import', [outside, '--import', boot, other]],
      ['--loader', [outside, '--loader', boot, other]],
      ['--experimental-loader', [outside, '--experimental-loader', boot, other]],
      ['--require=', [outside, `--require=${boot}`, other]],
      ['--import=', [outside, `--import=${boot}`, other]],
      ['--loader=', [outside, `--loader=${boot}`, other]],
      ['--experimental-loader=', [outside, `--experimental-loader=${boot}`, other]],
      ['via env -S', ['/usr/bin/env', '-S', `"${outside}" --require "${boot}" "${other}"`]],
      ['env NODE_OPTIONS= assignment', ['/usr/bin/env', `NODE_OPTIONS=--require ${boot}`, outside, other]],
      ['env -S NODE_OPTIONS= assignment', ['/usr/bin/env', '-S', `NODE_OPTIONS="--require=${boot}" ${outside} ${other}`]],
    ])('%s is discovered, restarted and flagged stale', async (_name, ProgramArguments) => {
      const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]);
      expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
      expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
      expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 })).toHaveLength(1);
    });
    it.each([
      ['--import file: URL', [outside, '--import', pathToFileURL(boot).href, other], undefined],
      ['--loader= file: URL', [outside, `--loader=${pathToFileURL(boot).href}`, other], undefined],
      ['NODE_OPTIONS --require', [outside, other], { NODE_OPTIONS: `--max-old-space-size=64 --require ${boot}` }],
      ['NODE_OPTIONS quoted --import=', [outside, other], { NODE_OPTIONS: `--import="${boot}"` }],
      ['NODE_OPTIONS -r on a non-node argv', ['/bin/sh', other], { NODE_OPTIONS: `-r ${boot}` }],
    ])('%s is discovered, restarted and flagged stale', async (_name, ProgramArguments, EnvironmentVariables) => {
      const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments, EnvironmentVariables }]);
      expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
      expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
      expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 })).toHaveLength(1);
    });
    it('an unparsable env NODE_OPTIONS= assignment is flagged unreadable, and one outside the clone is not claimed', () => {
      const bad = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', `NODE_OPTIONS=--require "${boot}`, outside, other] }]);
      const result = findServicesRunningFromClone(bad);
      expect(result.matches).toEqual([]);
      expect(result.unreadable[0].error).toMatch(/Unsupported NODE_OPTIONS/);
      const ext = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', `NODE_OPTIONS=--require ${other}`, outside, other] }]);
      expect(findServicesRunningFromClone(ext).matches).toEqual([]);
    });
    it('an unparsable NODE_OPTIONS is flagged unreadable, never silently excluded', () => {
      const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: [outside, other], EnvironmentVariables: { NODE_OPTIONS: `--require "${boot}` } }]);
      const result = findServicesRunningFromClone(o);
      expect(result.matches).toEqual([]);
      expect(result.unreadable[0].error).toMatch(/Unsupported NODE_OPTIONS/);
    });
    it('NODE_OPTIONS preloading code outside the clone is not claimed', () => {
      const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: [outside, other], EnvironmentVariables: { NODE_OPTIONS: `--require ${other}` } }]);
      expect(findServicesRunningFromClone(o).matches).toEqual([]);
    });
    // In a shell `-r` is the operand-free restricted-mode flag, so the next argument is the script that runs.
    it.each(['bash', 'sh', 'zsh', 'dash', 'ksh'])('%s -r keeps the immediately following clone script as the executable code path', async shell => {
      const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: [`/bin/${shell}`, '-r', join(cloneRoot, 'sampler.sh')] }]);
      expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
      expect((await restartServicesForClone(o)).restarted).toHaveLength(1);
      expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 })).toHaveLength(1);
    });
    it('bash -r with a clone script and trailing external data is still clone-backed; with an external script and a clone data argument it is not', () => {
      expect(findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/bin/bash', '-r', join(cloneRoot, 'data'), other] }])).matches).toHaveLength(1);
      const external = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/bin/bash', '-r', other, join(cloneRoot, 'data.json')] }]);
      expect(findServicesRunningFromClone(external).matches).toEqual([]);
    });
    it('-r combined with other shell flags (-ru, -r -e) still leaves the next argument as the script', () => {
      for (const flags of [['-ru'], ['-r', '-e'], ['-eu', '-r']]) {
        const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/bin/bash', ...flags, join(cloneRoot, 'sampler.sh')] }]);
        expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
      }
    });
    it('-r is still a preload operand for ruby', () => {
      const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/ruby', '-r', join(cloneRoot, 'boot.rb'), other] }]);
      expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
    });
    it.each([
      ['separate operand', [outside, '--require', other, other]],
      ['attached operand', [outside, `--require=${other}`, other]],
    ])('a preload outside the clone with an external entry is not claimed: %s', (_name, ProgramArguments) => {
      expect(findServicesRunningFromClone(fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }])).matches).toEqual([]);
    });
  });
  it.each(['"unterminated', "'unterminated", 'trailing\\', '${HOME}/x', '"${HOME}/x"', 'a\\_b', 'a\\cb'])('unparsable env -S string %s is flagged unreadable, never silently excluded', value => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', '-S', `${outside} ${cloneScript} ${value}`] }]);
    const result = findServicesRunningFromClone(o);
    expect(result.matches).toEqual([]);
    expect(result.unreadable[0].error).toMatch(/Unsupported env -S string/);
  });
  it.each([
    ['direct argv', [join(cloneRoot, 'node_modules', '.bin', 'next'), 'dev']],
    ['env -S next dev', ['/usr/bin/env', '-S', `"${outside}" "${join(cloneRoot, 'node_modules', '.bin', 'next')}" dev`]],
    ['env -S quoted vite', ['/usr/bin/env', '-S', `"${outside}" "${join(cloneRoot, 'node_modules', '.bin', 'vite')}"`]],
  ])('dev-server exclusion sees the effective argv: %s is skipped, not kickstarted or flagged stale', async (_name, ProgramArguments) => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments }]);
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
    const r = await restartServicesForClone(o);
    expect(r.restarted).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: 'built-in-never' })]);
    expect(o.launchctl).not.toHaveBeenCalled();
    expect(findStaleCodeServices({ ...o, readProcessStartMs: () => 100_000, readAdoptedAtMs: () => 200_000 })).toEqual([]);
  });
  describe('restart deferred by the cooldown is owed to a later tick', () => {
    const label = 'com.we.resource-sampler';
    function cooled(clock) {
      const o = fixture(); const states = new Map();
      o.stateStore = { get: l => states.get(l), set: (l, v) => { states.set(l, v); },
        pending: () => [...states].filter(([, v]) => v.pendingSha).map(([l, v]) => ({ label: l, ...v })) };
      o.now = () => clock.t;
      return Object.assign(o, { states });
    }
    it('adopt A, adopt B within cooldown, a later tick after cooldown restarts for B', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      expect((await restartServicesForClone({ ...o, adoptedSha: 'A' })).restarted).toHaveLength(1);
      clock.t += 60_000;
      const second = await restartServicesForClone({ ...o, adoptedSha: 'B' });
      expect(second.skipped).toEqual([expect.objectContaining({ reason: 'debounced' })]);
      expect(o.states.get(label)).toMatchObject({ sha: 'A', pendingSha: 'B' });
      // A later tick inside the cooldown does nothing and stays quiet.
      clock.t += 60_000;
      const early = await restartServicesForClone({ ...o, pendingOnly: true });
      expect(early).toEqual({ restarted: [], skipped: [], flagged: [], errors: [] });
      expect(o.launchctl).toHaveBeenCalledTimes(1);
      // After the cooldown the owed restart runs once and the owed marker is cleared.
      clock.t += 600_000;
      const late = await restartServicesForClone({ ...o, pendingOnly: true });
      expect(late.restarted).toHaveLength(1);
      expect(o.launchctl).toHaveBeenCalledTimes(2);
      expect(o.states.get(label)).toEqual({ at: clock.t, sha: 'B' });
      expect((await restartServicesForClone({ ...o, pendingOnly: true })).restarted).toEqual([]);
      expect(o.launchctl).toHaveBeenCalledTimes(2);
    });
    it('a still-cooling owed marker costs no plist scan on any later tick', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      o.listPlists = vi.fn(o.listPlists);
      for (let i = 0; i < 20; i += 1) { clock.t += 1000; await restartServicesForClone({ ...o, pendingOnly: true }); }
      expect(o.listPlists).not.toHaveBeenCalled();
    });
    it("another clone's later tick neither retries nor clears this clone's owed marker", async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      clock.t += 600_000;
      const foreign = await restartServicesForClone({ ...o, cloneRoot: resolve('fixtures/other-clone-root'), listPlists: () => [], pendingOnly: true });
      expect(foreign).toEqual({ restarted: [], skipped: [], flagged: [], errors: [] });
      expect(o.states.get(label)).toMatchObject({ sha: 'A', pendingSha: 'B', pendingRoot: cloneRoot });
    });
    it('clearing an owed marker never rolls back a restart another process recorded meanwhile', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      const stale = o.stateStore.pending();
      o.stateStore.pending = () => stale; // listed before the other process finished
      o.states.set(label, { at: 2_000_000, sha: 'C' }); // that process restarted for C and cleared the marker
      o.listPlists = () => []; clock.t += 3_000_000;
      await restartServicesForClone({ ...o, pendingOnly: true });
      expect(o.states.get(label)).toEqual({ at: 2_000_000, sha: 'C' });
    });
    describe('clearing an owed marker is serialised by the label lock', () => {
      function locked(clock) {
        const o = cooled(clock), events = []; let busy = false;
        const get = o.stateStore.get, set = o.stateStore.set;
        o.stateStore.get = l => { events.push('get'); return get(l); };
        o.stateStore.set = (l, v) => { events.push('set'); return set(l, v); };
        o.lockStore = { acquire: async () => { if (busy) return null; events.push('acquire'); return async () => { events.push('release'); }; } };
        return Object.assign(o, { events, hold: () => { busy = true; }, free: () => { busy = false; } });
      }
      async function owe(o, clock) {
        await restartServicesForClone({ ...o, adoptedSha: 'A' });
        clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
        o.events.length = 0;
      }
      it('no-longer-clone-backed cleanup reads and writes only while holding the lock', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        o.listPlists = () => []; clock.t += 600_000;
        await restartServicesForClone({ ...o, pendingOnly: true });
        expect(o.events).toEqual(['acquire', 'get', 'set', 'release']);
        expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'A' });
      });
      it('policy-refused cleanup reads and writes only while holding the lock', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        clock.t += 600_000;
        await restartServicesForClone({ ...o, pendingOnly: true, envValues: { enabled: false } });
        expect(o.events).toEqual(['acquire', 'get', 'set', 'release']);
        expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'A' });
      });
      it('a held lock leaves the marker untouched, still owed, without alarms', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        o.listPlists = () => []; clock.t += 600_000; o.hold();
        const r = await restartServicesForClone({ ...o, pendingOnly: true });
        expect(o.events).toEqual([]);
        expect(r.errors).toEqual([]); expect(r.flagged).toEqual([]);
        expect(o.states.get(label)).toMatchObject({ sha: 'A', pendingSha: 'B' });
        o.free(); await restartServicesForClone({ ...o, pendingOnly: true });
        expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'A' });
      });
      it('an unreadable lock result during cleanup is reported and writes nothing', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        o.listPlists = () => []; clock.t += 600_000; o.lockStore.acquire = async () => undefined;
        const r = await restartServicesForClone({ ...o, pendingOnly: true });
        expect(r.errors).toHaveLength(1); expect(o.events).toEqual([]);
        expect(o.states.get(label)).toMatchObject({ pendingSha: 'B' });
      });
      it('the lock is released even when the cleanup write fails', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        o.listPlists = () => []; clock.t += 600_000;
        o.stateStore.set = () => { o.events.push('set'); throw new Error('disk full'); };
        const r = await restartServicesForClone({ ...o, pendingOnly: true });
        expect(r.errors).toEqual([expect.objectContaining({ reason: 'disk full' })]);
        expect(o.events).toEqual(['acquire', 'get', 'set', 'release']);
      });
    });
    it('returning to the running sha while a restart is owed clears the owed marker', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      clock.t += 1000;
      const back = await restartServicesForClone({ ...o, adoptedSha: 'A' });
      expect(back.skipped).toEqual([expect.objectContaining({ reason: 'same-adopted-sha' })]);
      expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'A' });
      clock.t += 600_000;
      expect((await restartServicesForClone({ ...o, pendingOnly: true })).restarted).toEqual([]);
      expect(o.launchctl).toHaveBeenCalledTimes(1);
    });
    it('nothing owed means no plist scan on a later tick', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock); o.listPlists = vi.fn(o.listPlists);
      await restartServicesForClone({ ...o, pendingOnly: true });
      expect(o.listPlists).not.toHaveBeenCalled();
    });
    it('a newer adoption replaces the owed sha', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'C' });
      expect(o.states.get(label)).toMatchObject({ sha: 'A', pendingSha: 'C' });
    });
    it('an owed label that is no longer clone-backed is cleared instead of retried forever', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      o.listPlists = () => []; clock.t += 600_000;
      await restartServicesForClone({ ...o, pendingOnly: true });
      expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'A' });
      expect(o.launchctl).toHaveBeenCalledTimes(1);
    });
    it('an unreadable scan does not clear an owed restart', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      o.listPlists = () => { throw new Error('EACCES'); }; clock.t += 600_000;
      await restartServicesForClone({ ...o, pendingOnly: true });
      expect(o.states.get(label)).toMatchObject({ pendingSha: 'B' });
    });
    it('withSelfSync retries owed restarts on a non-adopting tick and not on an adopting one', async () => {
      const retry = vi.fn(async () => {}), restart = vi.fn(async () => {});
      const make = result => withSelfSync({ tickOnce: () => 'ticked' }, {
        root: cloneRoot, env: {}, versions: null, background: null, onRestart: () => 'restarted', rebuild: async () => result,
        restartServices: restart, retryPendingRestarts: retry, readHead: () => 'boot', readOriginRef: () => null,
        readState: () => ({}), readReady: () => null, cloneIdentity: () => null, acquireRead: () => ({ ok: true }),
        releaseRead: () => {}, importClosure: () => new Set(), diffFiles: () => [], log: { error: vi.fn() } });
      await make({ moved: false }).tickOnce();
      expect(retry).toHaveBeenCalledWith(expect.objectContaining({ pendingOnly: true, cloneRoot }));
      expect(restart).not.toHaveBeenCalled();
      retry.mockClear();
      await make({ moved: true, adopted: true, head: 'new' }).tickOnce();
      expect(restart).toHaveBeenCalledWith(expect.objectContaining({ adoptedSha: 'new' }));
      expect(retry).not.toHaveBeenCalled();
    });
  });
  it('an unclassifiable wrapper option resumes at the interpreter, so the clone script is matched', () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', '--mystery', outside, join(cloneRoot, 'sampler.mjs')] }]);
    expect(findServicesRunningFromClone(o)).toMatchObject({ matches: [{ label: 'com.we.resource-sampler' }], unreadable: [] });
  });
  it('an unclassifiable wrapper option with no interpreter after it names the option when a clone path follows', () => {
    const o = fixture([{ Label: 'com.we.resource-sampler', ProgramArguments: ['/usr/bin/env', '--mystery', 'operand', join(cloneRoot, 'bin', 'sampler')] }]);
    expect(findServicesRunningFromClone(o).unreadable[0].error).toMatch(/--mystery/);
  });
  });
});
