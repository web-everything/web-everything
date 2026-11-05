import { describe, it, expect, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import fsAsync from 'node:fs/promises';
import childProcess from 'node:child_process';
import { findServicesRunningFromClone, restartServicesForClone, findStaleCodeServices } from '../launchd-code-restart.mjs';
import { withSelfSync } from '../daemon-self-sync.mjs';
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
    ['interpreter option value', ['node', '--require', join(cloneRoot, 'loader.mjs'), resolve('..', 'other-clone', 'sampler.mjs')]],
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
    const root = await fsAsync.mkdtemp(join(process.env.TMPDIR, 'launchd-two-process-'));
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
  it('the existing /var vs /private/var alias is canonicalized', async () => {
    const real = await fsAsync.realpath(process.env.TMPDIR ?? '/tmp');
    const lexical = join(process.env.TMPDIR ?? '/tmp', 'x');
    if (real === process.env.TMPDIR?.replace(/\/$/, '')) return; // no alias on this host
    const o = { ...fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', join(lexical, 'sampler.mjs')] }]), cloneRoot: join(real, 'x') };
    expect(findServicesRunningFromClone(o).matches).toHaveLength(1);
  });
  it('an unreadable realpath fails closed as unreadable evidence', () => {
    const o = { ...fixture([{ ...sampler, ProgramArguments: ['/usr/local/bin/node', '/elsewhere/sampler.mjs'] }]),
      realpath: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    expect(findServicesRunningFromClone(o).unreadable).toHaveLength(1);
  });
});
