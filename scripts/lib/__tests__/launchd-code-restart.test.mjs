import { describe, it, expect, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import fsAsync from 'node:fs/promises';
import childProcess from 'node:child_process';
import { restartServicesForClone, findStaleCodeServices, createDiskLocks } from '../launchd-code-restart.mjs';
import { withSelfSync, resolveRestartServices, resolveRetryPendingRestarts } from '../daemon-self-sync.mjs';
import { lockDirFor } from '../../readiness/file-locks.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
const cloneRoot = resolve('fixtures/wev-pass-readers');
function fixture(plists = [{ Label: 'com.we.resource-sampler', ProgramArguments: ['node', join(cloneRoot, 'sampler.mjs')] }]) {
  return { cloneRoot, agentsDir: resolve('fixtures/agents'), listPlists: () => plists.map((_, i) => `${i}.plist`),
    readPlist: path => { const p = plists[Number(path.split('/').at(-1).split('.')[0])]; if (p instanceof Error) throw p; return p; },
    launchctl: vi.fn(() => ({ stdout: 'pid = 42', status: 0 })), uid: () => 501, log: vi.fn(), now: () => 1_000_000,
    stateStore: new Map(), lockStore: { acquire: async () => async () => {} }, adoptedSha: 'new-sha', platform: null, env: {} };
}
describe('explicit label allowlist (operator route R673): no command-line parsing', () => {
  const sampler = 'com.we.resource-sampler', kicked = o => o.launchctl.mock.calls.map(([argv]) => argv.at(-1).split('/').at(-1));
  it.each([
    ['a relative entry file inside a shell command (red-team break)', { ProgramArguments: ['/bin/sh', '-c', 'exec node sampler.mjs'], WorkingDirectory: cloneRoot }],
    ['python -O in front of a clone script', { ProgramArguments: ['/usr/bin/python3', '-O', join(cloneRoot, 'sampler.py')] }],
    ['an attached ruby preload', { ProgramArguments: ['/usr/bin/ruby', `-r${cloneRoot}/pre.rb`, resolve('..', 'other-clone', 'entry')] }],
    ['a loose wrapper in front of the program', { ProgramArguments: ['/usr/bin/timeout', '10', '/usr/bin/node', join(cloneRoot, 'sampler.mjs')] }],
    ['env -S with an unparsable string', { ProgramArguments: ['/usr/bin/env', '-S', 'node "unterminated'] }],
    ['a sibling path that shares the clone prefix', { ProgramArguments: ['node', `${cloneRoot}-control/sampler.mjs`] }],
    ['an argv that names no clone at all', { ProgramArguments: ['/opt/external/sampler'] }],
    ['an invalid Program value', { Program: null, ProgramArguments: ['node', 'x.mjs'] }],
  ])('an allowlisted label is restarted whatever its argv says: %s', async (_name, plist) => {
    const o = fixture([{ Label: sampler, ...plist }]);
    expect((await restartServicesForClone(o)).restarted).toEqual([expect.objectContaining({ label: sampler, reason: 'kickstart -k' })]);
    expect(o.launchctl).toHaveBeenCalledWith(['kickstart', '-k', `gui/501/${sampler}`]);
  });
  it.each([
    ['clone-looking argv', ['node', join(cloneRoot, 'writer.mjs')]],
    ['clone as the working directory and data', ['/opt/bin/writer', '--data-dir', cloneRoot]],
    ['a vite dev command', ['npx', 'vite']],
  ])('an unlisted label is never restarted whatever its argv says: %s', async (_name, ProgramArguments) => {
    for (const label of ['com.we.writer', 'com.webeverything.writer']) {
      const o = fixture([{ Label: label, ProgramArguments, WorkingDirectory: cloneRoot }]);
      const r = await restartServicesForClone(o);
      expect(o.launchctl).not.toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining(label)]));
      expect(r.skipped).toContainEqual({ label, reason: 'not-allowlisted' });
    }
  });
  it('listing a label restarts it with no plist at all; the plist is never needed', async () => {
    const o = { ...fixture([]), settings: { allowedLabels: ['com.we.writer'] } };
    expect((await restartServicesForClone(o)).restarted).toEqual([expect.objectContaining({ label: 'com.we.writer' })]);
    expect(kicked(o)).toEqual(['com.we.writer']);
  });
  it('a plist is read only for its Label: ProgramArguments, Program, WorkingDirectory and environment stay untouched', async () => {
    const trap = name => ({ get() { throw new Error(`${name} must not be read`); } });
    const plist = Object.defineProperties({ Label: 'com.we.writer' }, {
      ProgramArguments: trap('ProgramArguments'), Program: trap('Program'),
      WorkingDirectory: trap('WorkingDirectory'), EnvironmentVariables: trap('EnvironmentVariables') });
    const o = fixture([plist, { Label: sampler }]);
    const r = await restartServicesForClone(o);
    expect(r.errors).toEqual([]); expect(kicked(o)).toEqual([sampler]);
  });
  it('allowlist provenance is logged with its source layer', async () => {
    const lines = o => o.log.mock.calls.flat().join('\n');
    const standard = fixture(); await restartServicesForClone(standard);
    expect(lines(standard)).toMatch(/"allowedLabels":"standard"/);
    const tool = fixture(); await restartServicesForClone({ ...tool, settings: { allowedLabels: [sampler] } });
    expect(lines(tool)).toMatch(/"allowedLabels":"tool"/);
    const platform = fixture(); await restartServicesForClone({ ...platform, platform: { allowedLabels: [sampler] } });
    expect(lines(platform)).toMatch(/"allowedLabels":"platform"/);
  });
  it('one line names the managed services that are not on the allowlist, with where to add them', async () => {
    const o = fixture([{ Label: sampler }, { Label: 'com.we.writer' }, { Label: 'com.webeverything.logger' },
      { Label: 'com.apple.unrelated' }, { Label: 'com.we.self' }, { Label: 'com.we.writer' }]);
    const r = await restartServicesForClone({ ...o, selfLabel: 'com.we.self' });
    const named = o.log.mock.calls.flat().filter(line => line.includes('not-allowlisted:'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('com.we.writer, com.webeverything.logger');
    expect(named[0]).toMatch(/daemon\.serviceRestart\.allowedLabels.*allowedLabels source standard/);
    for (const hidden of ['com.apple.unrelated', 'com.we.self', sampler]) expect(named[0]).not.toContain(hidden);
    expect(r.skipped.filter(x => x.reason === 'not-allowlisted').map(x => x.label)).toEqual(['com.we.writer', 'com.webeverything.logger']);
    expect(kicked(o)).toEqual([sampler]);
  });
  it('no line is logged when every managed service is on the allowlist', async () => {
    const o = fixture(); await restartServicesForClone(o);
    expect(o.log.mock.calls.flat().filter(line => line.includes('not-allowlisted'))).toEqual([]);
  });
  it('an unreadable or oversized plist and an unreadable agents directory never block an allowlisted restart; the line counts them', async () => {
    const bad = fixture([new Error('stdout maxBuffer length exceeded'), { Label: 'com.we.writer' }]);
    expect((await restartServicesForClone(bad)).restarted).toHaveLength(1);
    expect(bad.log.mock.calls.flat().join('\n')).toMatch(/not-allowlisted: com\.we\.writer \(1 LaunchAgent entry unreadable, invalid or past the scan bound\)/);
    const gone = fixture(); gone.listPlists = () => { throw new Error('permission denied'); };
    expect((await restartServicesForClone(gone)).restarted).toHaveLength(1);
    expect(gone.log.mock.calls.flat().join('\n')).toMatch(/not-allowlisted: none named \(1 LaunchAgent entry unreadable, invalid or past the scan bound\)/);
  });
  it.each([['wildcard', ['*']], ['namespace glob', ['com.we.*']], ['a path', ['com.we/x']], ['whitespace', ['com.we x']], ['empty', ['']], ['not an array', 'com.we.writer']])(
    'an invalid allowlist (%s) never widens the list: the standard default still applies', async (_name, allowedLabels) => {
      const o = fixture([{ Label: 'com.we.writer' }, { Label: sampler }]);
      await restartServicesForClone({ ...o, settings: { allowedLabels } });
      expect(kicked(o)).toEqual([sampler]);
    });
  it('an explicitly empty allowlist restarts nothing', async () => {
    const o = fixture(); const r = await restartServicesForClone({ ...o, settings: { allowedLabels: [] } });
    expect(o.launchctl).not.toHaveBeenCalled(); expect(r.restarted).toEqual([]);
  });
  it.each(['dev', 'vite', 'storybook', 'playground', 'npm-start'])('a dev-server label is never restarted, even when listed: %s', async name => {
    const label = `com.we.${name}`, o = fixture([{ Label: label }]);
    const r = await restartServicesForClone({ ...o, settings: { allowedLabels: [label] } });
    expect(r.skipped).toContainEqual({ label, reason: 'built-in-never' }); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('the adopting daemon itself (selfLabel) is never restarted, even when listed', async () => {
    const o = fixture();
    const r = await restartServicesForClone({ ...o, selfLabel: sampler });
    expect(r.skipped).toContainEqual({ label: sampler, reason: 'self' }); expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('a label removed from the allowlist clears its owed marker instead of restarting it', async () => {
    const clock = { t: 1_000_000 }, o = fixture(); o.now = () => clock.t;
    o.stateStore.pending = () => [...o.stateStore].filter(([, v]) => v.pendingSha).map(([label, v]) => ({ label, ...v }));
    await restartServicesForClone({ ...o, adoptedSha: 'A' });
    clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
    expect(o.stateStore.get(sampler)).toMatchObject({ sha: 'A', pendingSha: 'B' });
    clock.t += 600_000;
    await restartServicesForClone({ ...o, pendingOnly: true, settings: { allowedLabels: [] } });
    expect(o.stateStore.get(sampler)).toEqual({ at: 1_000_000, sha: 'A' }); expect(o.launchctl).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['more than 64 labels', Array.from({ length: 65 }, (_, i) => `com.we.s${i}`)],
    ['a label over 128 characters', [`com.we.${'a'.repeat(125)}`]],
    ['two labels differing only by case', ['com.we.Writer', 'com.we.writer']],
  ])('an allowlist with %s is rejected whole: the standard default applies', async (_name, allowedLabels) => {
    const o = fixture([]); await restartServicesForClone({ ...o, settings: { allowedLabels } });
    expect(kicked(o)).toEqual([sampler]);
  });
  describe('the not-allowlisted listing is informational and bounded', () => {
    it('allowlisted restarts finish before any plist is read, so a slow directory cannot delay them', async () => {
      const events = [], o = fixture([{ Label: 'com.we.writer' }]);
      const read = o.readPlist;
      o.launchctl.mockImplementation(() => { events.push('kick'); return { status: 0 }; });
      o.readPlist = path => { events.push('read'); return read(path); };
      await restartServicesForClone(o);
      expect(events).toEqual(['kick', 'read']);
    });
    it('stops after 200 plists and says the scan was cut short', async () => {
      const plists = Array.from({ length: 250 }, (_, i) => ({ Label: `com.we.extra${i}` })), o = fixture(plists);
      const read = vi.fn(o.readPlist); o.readPlist = read;
      const r = await restartServicesForClone(o);
      expect(read).toHaveBeenCalledTimes(200);
      expect(o.log.mock.calls.flat().join('\n')).toMatch(/past the scan bound/);
      expect(r.skipped.filter(x => x.reason === 'not-allowlisted')).toHaveLength(20);
      expect(o.log.mock.calls.flat().join('\n')).toMatch(/\+180 more/);
    });
    it('stops after the 3 second budget', async () => {
      let t = 1_000_000; const o = fixture(Array.from({ length: 10 }, (_, i) => ({ Label: `com.we.slow${i}` })));
      const read = o.readPlist; let reads = 0;
      o.now = () => t; o.readPlist = path => { reads += 1; t += 1500; return read(path); };
      await restartServicesForClone(o);
      expect(reads).toBe(2);
      expect(o.log.mock.calls.flat().join('\n')).toMatch(/past the scan bound/);
    });
    it('an abort during the listing stops it quietly and reports no error', async () => {
      const controller = new AbortController(), o = fixture([{ Label: 'com.we.a' }, { Label: 'com.we.b' }]);
      const read = o.readPlist; let reads = 0;
      o.readPlist = path => { reads += 1; controller.abort(); return read(path); };
      const r = await restartServicesForClone({ ...o, signal: controller.signal });
      expect(reads).toBe(1); expect(r.errors).toEqual([]);
    });
    it.each([
      ['an over-long label', `com.we.${'x'.repeat(1_000_000)}`],
      ['a label with control characters', 'com.we.bad\nname'],
      ['a label with a path', 'com.we.a/b'],
    ])('%s is never named in the log or the result; it is counted instead', async (_name, Label) => {
      const o = fixture([{ Label }]); const r = await restartServicesForClone(o);
      const text = o.log.mock.calls.flat().join('\n');
      expect(text).toMatch(/not-allowlisted: none named \(1 LaunchAgent entry unreadable, invalid/);
      expect(text.length).toBeLessThan(5000);
      expect(r.skipped).toEqual([]);
    });
  });
});

describe('launchd clone restart', () => {
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
  it.each(['off', 'OFF', 'FALSE', 'False', ' no ', '0', 'false', 'disabled', 'garbage', '2'])(
    'kill-switch env %j disables restarts (unrecognised values fail closed)', async (value) => {
      const o = fixture(); const r = await restartServicesForClone({ ...o, env: { WE_DAEMON_SERVICE_RESTART_ENABLED: value } });
      expect(o.launchctl).not.toHaveBeenCalled(); expect(r.restarted ?? []).toEqual([]);
      expect(o.log.mock.calls.flat().join(' ')).toMatch(/env/);
    });
  it.each(['true', 'TRUE', ' On ', 'yes', '1', ''])('enable env %j leaves restarts enabled', async (value) => {
    const o = fixture(); const r = await restartServicesForClone({ ...o, env: { WE_DAEMON_SERVICE_RESTART_ENABLED: value } });
    expect(r.restarted).toHaveLength(1); expect(o.launchctl).toHaveBeenCalled();
  });
  it('blank min-interval env is unset, not zero (debounce stays on)', async () => {
    // A different sha on the second call, so only the debounce (not the same-sha guard) can block it.
    const o = fixture(); await restartServicesForClone({ ...o, adoptedSha: 'A', env: { WE_DAEMON_SERVICE_RESTART_MIN_INTERVAL_MS: '  ' } });
    const again = await restartServicesForClone({ ...o, adoptedSha: 'B', env: { WE_DAEMON_SERVICE_RESTART_MIN_INTERVAL_MS: '  ' } });
    expect(o.launchctl).toHaveBeenCalledTimes(1); expect(again.restarted ?? []).toEqual([]);
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
  it('corrupt persisted restart state refuses restart', async () => {
    const o = fixture(); o.stateStore.set('com.we.resource-sampler', { sha: 'legacy' });
    expect((await restartServicesForClone(o)).errors[0].reason).toMatch(/inspect persisted state/);
    expect(o.launchctl).not.toHaveBeenCalled();
  });
  it('concurrent calls do not restart an in-flight label twice', async () => {
    const o = fixture(); let finish, markLaunched;
    const launched = new Promise(resolve => { markLaunched = resolve; });
    o.launchctl.mockImplementation(() => new Promise(resolve => { finish = resolve; markLaunched(); }));
    // Start the second call only once the first is provably in flight (launchctl pending). Racing two
    // un-awaited calls is load-dependent: if the awaited call wins, it deadlocks on a launchctl that is only
    // released afterwards, and the module-level in-flight label stays claimed, failing every later test that
    // shares the label.
    const first = restartServicesForClone(o);
    try {
      await launched;
      const second = await restartServicesForClone(o);
      expect(second.skipped[0].reason).toBe('restart-in-flight');
    } finally { finish?.({ status: 0 }); }
    await first; expect(o.launchctl).toHaveBeenCalledTimes(1);
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
  it('stale detection flags unknown timestamps rather than declaring clean', () => {
    expect(findStaleCodeServices({ ...fixture(), readProcessStartMs: () => 100, readAdoptedAtMs: () => NaN })[0].reason).toBe('adoption-unreadable');
  });
  it('an unreadable policy fails closed into one unlabeled flag, never a clean result', () => {
    const o = { ...fixture(), readProcessStartMs: () => 300_000, readAdoptedAtMs: () => 200_000 };
    const result = findStaleCodeServices({ ...o, platform: { get enabled() { throw new Error('policy store unreadable'); } } });
    expect(result).toEqual([expect.objectContaining({ label: null, reason: 'policy-unreadable' })]);
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
  describe('owed-restart retry wiring (resolveRetryPendingRestarts)', () => {
    const real = vi.fn(), hook = vi.fn(), retry = vi.fn();
    it.each([
      ['real IO, nothing injected: the real retry', [undefined, undefined, true], real],
      ['hermetic (injected rebuild), nothing injected: no retry, never the real one', [undefined, undefined, false], null],
      ['real IO but a restart hook injected: no real retry', [undefined, hook, true], null],
      ['hermetic with a restart hook: no retry', [undefined, hook, false], null],
      ['an injected retry wins on real IO', [retry, undefined, true], retry],
      ['an injected retry wins when hermetic', [retry, hook, false], retry],
    ])('%s', (_name, [retryOpt, restartOpt, realIo], expected) => {
      expect(resolveRetryPendingRestarts(retryOpt, restartOpt, realIo, real)).toBe(expected);
    });
    it('the default real retry is the real launchd restart', () => {
      expect(resolveRetryPendingRestarts(undefined, undefined, true)).toBe(restartServicesForClone);
    });
  });
});
describe('disk restart lock: abandoned-owner recovery', () => {
  const label = 'com.we.resource-sampler', deadPid = 424242, livePid = 515151;
  function setup(liveness) {
    const root = mkdtempSync(join(tmpdir(), 'launchd-lock-test-'));
    return { root, locks: createDiskLocks({ root, liveness, pid: 7 }), dir: lockDirFor(root, `launchd-code-restart:${label}`) };
  }
  async function leave(dir, pid, extra = {}) {
    await fsAsync.mkdir(dir, { recursive: true });
    await fsAsync.writeFile(join(dir, 'lock.json'), JSON.stringify({ owner: `launchd-code-restart:${pid}:abc`, path: label, pid,
      heartbeatAt: '2000-01-01T00:00:00.000Z', ...extra }));
  }
  it('a lock left by a provably exited holder is reclaimed, and the new holder can release it', async () => {
    const { root, locks, dir } = setup(pid => (pid === deadPid ? 'dead' : 'alive'));
    try {
      await leave(dir, deadPid);
      const release = await locks.acquire(label);
      expect(release).toBeTypeOf('function');
      expect(JSON.parse(await fsAsync.readFile(join(dir, 'lock.json'), 'utf8')).pid).toBe(7);
      expect(await locks.acquire(label)).toBeNull();
      await release();
      expect(await fsAsync.stat(dir).catch(e => e.code)).toBe('ENOENT');
    } finally { await fsAsync.rm(root, { recursive: true, force: true }); }
  });
  it.each(['alive', 'unknown'])('an aged lock whose owner is %s (e.g. a paused owner) is never reclaimed', async verdict => {
    const { root, locks, dir } = setup(() => verdict);
    try {
      await leave(dir, livePid); // heartbeat is decades old: age alone must never free it
      expect(await locks.acquire(label)).toBeNull();
      expect(JSON.parse(await fsAsync.readFile(join(dir, 'lock.json'), 'utf8')).pid).toBe(livePid);
    } finally { await fsAsync.rm(root, { recursive: true, force: true }); }
  });
  it.each([
    ['corrupt lock.json', async dir => { await fsAsync.mkdir(dir, { recursive: true }); await fsAsync.writeFile(join(dir, 'lock.json'), '{nope'); }],
    ['no recorded pid', async dir => leave(dir, deadPid, { pid: null })],
  ])('an unreadable or pid-less lock (%s) fails closed', async (_name, make) => {
    const { root, locks, dir } = setup(pid => (Number.isInteger(pid) ? 'dead' : 'unknown'));
    try {
      await make(dir);
      expect(await locks.acquire(label)).toBeNull();
      expect(await fsAsync.stat(dir)).toBeTruthy();
    } finally { await fsAsync.rm(root, { recursive: true, force: true }); }
  });
  it('with the real liveness probe, a lock left by an exited process is reclaimed and a live pid' + '' + 's lock is not', async () => {
    const child = childProcess.spawn(process.execPath, ['-e', '']);
    await new Promise(resolve => child.once('close', resolve));
    const root = mkdtempSync(join(tmpdir(), 'launchd-lock-test-')), dir = lockDirFor(root, `launchd-code-restart:${label}`);
    try {
      const locks = createDiskLocks({ root });
      await leave(dir, child.pid);
      expect(await locks.acquire(label)).toBeTypeOf('function');
      await fsAsync.rm(dir, { recursive: true });
      await leave(dir, process.ppid);
      expect(await locks.acquire(label)).toBeNull();
    } finally { await fsAsync.rm(root, { recursive: true, force: true }); }
  });
  it('an empty lock dir stranded by a crash before the entry was written is replaced, not blocked forever', async () => {
    const { root, locks, dir } = setup(() => 'alive');
    try {
      await fsAsync.mkdir(dir, { recursive: true });
      expect(await locks.acquire(label)).toBeTypeOf('function');
      expect(JSON.parse(await fsAsync.readFile(join(dir, 'lock.json'), 'utf8')).pid).toBe(7);
    } finally { await fsAsync.rm(root, { recursive: true, force: true }); }
  });
  it('concurrent acquirers: exactly one wins, and the lock dir never exists without its owner entry', async () => {
    const { root, locks, dir } = setup(() => 'alive');
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => locks.acquire(label)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(JSON.parse(await fsAsync.readFile(join(dir, 'lock.json'), 'utf8')).pid).toBe(7);
      // Losers leave no staging residue behind.
      expect((await fsAsync.readdir(root)).filter(name => name.startsWith('.staging-'))).toEqual([]);
    } finally { await fsAsync.rm(root, { recursive: true, force: true }); }
  });
  it('a lock dir is only ever published with its lock.json (no entry-less state to strand a label)', async () => {
    const { root, locks, dir } = setup(() => 'alive');
    try {
      const release = await locks.acquire(label);
      expect(await fsAsync.readdir(dir)).toEqual(['lock.json']);
      await release();
      // A staged-but-unpublished attempt (crash before the rename) is not a held lock.
      await fsAsync.mkdir(join(root, '.staging-1-dead'));
      expect(await locks.acquire(label)).toBeTypeOf('function');
    } finally { await fsAsync.rm(root, { recursive: true, force: true }); }
  });
  it('a lock that changed hands between the judgement and the reclaim is left alone', async () => {
    // The probe says the judged holder is dead, but by the time it is removed a live holder has taken the path.
    const { root, dir } = setup(() => 'dead');
    let swapped = false;
    const locks = createDiskLocks({ root, pid: 7, liveness: () => {
      if (!swapped) { swapped = true; swap(); }
      return 'dead';
    } });
    function swap() {
      writeFileSync(join(dir, 'lock.json'), JSON.stringify({ owner: 'launchd-code-restart:99:new', path: label, pid: 99,
        heartbeatAt: new Date().toISOString() }));
    }
    try {
      await leave(dir, deadPid);
      expect(await locks.acquire(label)).toBeNull();
      expect(JSON.parse(await fsAsync.readFile(join(dir, 'lock.json'), 'utf8')).pid).toBe(99);
    } finally { await fsAsync.rm(root, { recursive: true, force: true }); }
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
  it.each(['state persistence', 'lock acquisition'])('timeout cancellation prevents late kickstarts when delayed %s resumes', async stage => {
    vi.useFakeTimers();
    const o = fixture(), log = { error: vi.fn() }, onRestart = vi.fn(() => 'restarted');
    let release, markStarted, restartDone, signal;
    const blocked = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    if (stage === 'lock acquisition') {
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
  it('the production not-allowlisted listing stays asynchronous and runs only after the kickstart; the tick waits for it', async () => {
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
      expect(o.launchctl).toHaveBeenCalledTimes(1); // the restart is already done; only the informational listing is pending
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

describe('stale detection inspects exactly the allowlisted labels', () => {
  const sampler = 'com.we.resource-sampler';
  const stale = o => findStaleCodeServices({ ...o, readProcessStartMs: () => 1000, readAdoptedAtMs: () => 2000 });
  const svc = (Label, ProgramArguments = ['node', join(cloneRoot, 'sampler.mjs')]) => ({ Label, ProgramArguments });
  it('a label that is not on the allowlist is never inspected, whatever its argv says', () => {
    const readProcessStartMs = vi.fn(() => 1000), fresh = vi.fn();
    const o = fixture([svc('com.we.writer'), svc('com.other.writer'), svc('com.we.web', [join(cloneRoot, 'node_modules/.bin/vite')])]);
    expect(findStaleCodeServices({ ...o, readProcessStartMs, readAdoptedAtMs: () => 2000, onFreshService: fresh, settings: { allowedLabels: [] } })).toEqual([]);
    expect(readProcessStartMs).not.toHaveBeenCalled(); expect(fresh).not.toHaveBeenCalled();
  });
  it('a dev-server label is not flagged stale even when listed', () => {
    const fresh = vi.fn();
    expect(stale({ ...fixture(), onFreshService: fresh, settings: { allowedLabels: ['com.we.dev-server'] } })).toEqual([]);
    expect(fresh).not.toHaveBeenCalled();
  });
  it('an extra reviewed label is inspected alongside the default sampler, with no plist needed', () => {
    const o = { ...fixture([]), settings: { allowedLabels: ['com.we.resource-sampler', 'com.we.extra'] } };
    expect(stale(o).map(f => f.label)).toEqual(['com.we.resource-sampler', 'com.we.extra']);
  });
  describe('a host-wide service is judged per clone without false alarms', () => {
    const base = { readProcessStartMs: () => 1000, readAdoptedAtMs: () => 2000, readAdoptedHead: () => 'S' };
    it('a second clone adopting the build another clone already restarted for is fresh, not stale forever', () => {
      const fresh = vi.fn(), readRestart = vi.fn(() => ({ at: 900, sha: 'S' }));
      expect(findStaleCodeServices({ ...fixture(), ...base, readRestart, onFreshService: fresh })).toEqual([]);
      expect(readRestart).toHaveBeenCalledWith(sampler);
      expect(fresh).toHaveBeenCalledWith(expect.objectContaining({ label: sampler }));
    });
    it.each([
      ['the restart record names another build', { at: 900, sha: 'OLD' }],
      ['the process started before the restart was recorded (kickstart failed)', { at: 2500, sha: 'S' }],
      ['the restart record has no usable time', { sha: 'S' }],
      ['there is no restart record', undefined],
    ])('still stale when %s', (_n, record) => {
      expect(findStaleCodeServices({ ...fixture(), ...base, readRestart: () => record })).toEqual([expect.objectContaining({ label: sampler, reason: 'stale-code' })]);
    });
    it('still stale when the clone has no adopted head to match the restart record against', () => {
      expect(findStaleCodeServices({ ...fixture(), ...base, readAdoptedHead: () => null, readRestart: () => ({ at: 900, sha: 'S' }) })).toHaveLength(1);
    });
    it('a clone that has adopted nothing makes no claim: no stale flag and no fresh evidence', () => {
      const fresh = vi.fn(), readProcessStartMs = vi.fn(() => 1000);
      expect(findStaleCodeServices({ ...fixture(), readProcessStartMs, readAdoptedAtMs: () => null, onFreshService: fresh })).toEqual([]);
      expect(fresh).not.toHaveBeenCalled();
    });
  });
  it('stale detection never reads a plist or its command line', () => {
    const readPlist = vi.fn(), listPlists = vi.fn();
    expect(stale({ ...fixture(), readPlist, listPlists })).toHaveLength(1);
    expect(readPlist).not.toHaveBeenCalled(); expect(listPlists).not.toHaveBeenCalled();
  });
  it('the adopting daemon itself (selfLabel) is not flagged stale', () => {
    const o = fixture([svc('com.we.resource-sampler')]);
    expect(stale({ ...o, selfLabel: 'com.we.resource-sampler' })).toEqual([]);
    expect(stale(o)).toHaveLength(1);
  });
});

describe('owed restarts and the cooldown', () => {
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
      o.settings = { allowedLabels: [] }; clock.t += 3_000_000;
      await restartServicesForClone({ ...o, pendingOnly: true });
      expect(o.states.get(label)).toEqual({ at: 2_000_000, sha: 'C' });
    });
    it.each([
      ['another clone re-owes the same sha from the same anchor', { pendingRoot: resolve('..', 'clone-b') }],
      ['the same clone re-owes the same sha as a newer deferral', { pendingGen: 'newer-generation' }],
    ])('cleanup is compare-and-delete: %s between the read and the cleanup', async (_name, rewrite) => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      const consumed = o.states.get(label);
      expect(consumed).toMatchObject({ pendingSha: 'B', pendingRoot: cloneRoot, pendingGen: expect.any(String) });
      const listed = o.stateStore.pending();
      o.stateStore.pending = () => listed; // clone A listed its owed marker here
      const reowed = { ...consumed, ...rewrite }; // then clone B (or a later deferral) rewrote it
      o.states.set(label, reowed);
      o.settings = { allowedLabels: [] }; clock.t += 600_000; // A's label left the allowlist: A's cleanup runs
      await restartServicesForClone({ ...o, pendingOnly: true });
      expect(o.states.get(label)).toEqual(reowed);
      expect(o.launchctl).toHaveBeenCalledTimes(1);
    });
    it("clone A's same-sha skip never clears clone B's owed marker", async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock), cloneB = resolve('..', 'clone-b');
      o.states.set(label, { at: 1_000_000, sha: 'X', pendingSha: 'B1', pendingRoot: cloneB, pendingGen: 'g1' });
      clock.t += 1000;
      const r = await restartServicesForClone({ ...o, adoptedSha: 'X' });
      expect(r.skipped).toEqual([expect.objectContaining({ reason: 'same-adopted-sha' })]);
      expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'X', pendingSha: 'B1', pendingRoot: cloneB, pendingGen: 'g1' });
    });
    it("clone A's debounced deferral never overwrites clone B's owed marker, and says so", async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock), cloneB = resolve('..', 'clone-b');
      const bMarker = { at: 1_000_000, sha: 'X', pendingSha: 'B1', pendingRoot: cloneB, pendingGen: 'g1' };
      o.states.set(label, bMarker);
      clock.t += 1000;
      const r = await restartServicesForClone({ ...o, adoptedSha: 'A1' });
      expect(r.skipped).toEqual([expect.objectContaining({ reason: 'debounced' })]);
      expect(r.flagged).toEqual([expect.objectContaining({ reason: expect.stringMatching(/restart-owed-by-other-clone/) })]);
      expect(o.states.get(label)).toEqual(bMarker);
    });
    it("clone A's successful restart never erases clone B's owed marker", async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock), cloneB = resolve('..', 'clone-b');
      o.states.set(label, { at: 1_000_000, sha: 'X', pendingSha: 'B1', pendingRoot: cloneB, pendingGen: 'g1' });
      clock.t += 600_000; // cooldown passed: A restarts for A1
      const r = await restartServicesForClone({ ...o, adoptedSha: 'A1' });
      expect(r.restarted).toHaveLength(1);
      expect(o.states.get(label)).toEqual({ at: 1_600_000, sha: 'A1', pendingSha: 'B1', pendingRoot: cloneB, pendingGen: 'g1' });
    });
    it("clone A's successful restart still consumes A's own owed marker", async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      clock.t += 600_000;
      await restartServicesForClone({ ...o, adoptedSha: 'C' });
      expect(o.states.get(label)).toEqual({ at: 1_601_000, sha: 'C' });
    });
    it('cleanup still clears the marker it consumed (owner, sha, anchor and generation match)', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      o.settings = { allowedLabels: [] }; clock.t += 600_000;
      await restartServicesForClone({ ...o, pendingOnly: true });
      expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'A' });
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
      it('no-longer-allowlisted cleanup reads and writes only while holding the lock', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        o.settings = { allowedLabels: [] }; clock.t += 600_000;
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
        o.settings = { allowedLabels: [] }; clock.t += 600_000; o.hold();
        const r = await restartServicesForClone({ ...o, pendingOnly: true });
        expect(o.events).toEqual([]);
        expect(r.errors).toEqual([]); expect(r.flagged).toEqual([]);
        expect(o.states.get(label)).toMatchObject({ sha: 'A', pendingSha: 'B' });
        o.free(); await restartServicesForClone({ ...o, pendingOnly: true });
        expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'A' });
      });
      it('an owed retry follows the marker on disk after the lock, not the pre-lock listing', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        const stale = o.stateStore.pending(); o.stateStore.pending = () => stale;
        // Between listing and locking, a newer adoption replaced the owed sha.
        o.states.set(label, { at: 1_001_000, sha: 'A', pendingSha: 'C', pendingRoot: cloneRoot });
        clock.t += 600_000;
        await restartServicesForClone({ ...o, pendingOnly: true });
        expect(o.launchctl).toHaveBeenCalledTimes(2);
        expect(o.states.get(label)).toEqual({ at: clock.t, sha: 'C' });
      });
      it('an owed retry whose marker was cleared or taken by another clone meanwhile restarts nothing', async () => {
        for (const meanwhile of [{ at: 2_000_000, sha: 'C' }, { at: 1_001_000, sha: 'A', pendingSha: 'B', pendingRoot: resolve('fixtures/other-clone-root') }]) {
          const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
          const stale = o.stateStore.pending(); o.stateStore.pending = () => stale;
          o.states.set(label, meanwhile); clock.t += 3_000_000;
          const r = await restartServicesForClone({ ...o, pendingOnly: true });
          expect(r.restarted).toEqual([]); expect(o.launchctl).toHaveBeenCalledTimes(1);
          expect(o.states.get(label)).toEqual(meanwhile);
        }
      });
      it('an unreadable lock result during cleanup is reported and writes nothing', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        o.settings = { allowedLabels: [] }; clock.t += 600_000; o.lockStore.acquire = async () => undefined;
        const r = await restartServicesForClone({ ...o, pendingOnly: true });
        expect(r.errors).toHaveLength(1); expect(o.events).toEqual([]);
        expect(o.states.get(label)).toMatchObject({ pendingSha: 'B' });
      });
      it('the lock is released even when the cleanup write fails', async () => {
        const clock = { t: 1_000_000 }, o = locked(clock); await owe(o, clock);
        o.settings = { allowedLabels: [] }; clock.t += 600_000;
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
    it('an owed label that is no longer on the allowlist is cleared instead of retried forever', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      o.settings = { allowedLabels: [] }; clock.t += 600_000;
      await restartServicesForClone({ ...o, pendingOnly: true });
      expect(o.states.get(label)).toEqual({ at: 1_000_000, sha: 'A' });
      expect(o.launchctl).toHaveBeenCalledTimes(1);
    });
    it('an unreadable agents directory never blocks the owed retry: no plist is read for it', async () => {
      const clock = { t: 1_000_000 }, o = cooled(clock);
      await restartServicesForClone({ ...o, adoptedSha: 'A' });
      clock.t += 1000; await restartServicesForClone({ ...o, adoptedSha: 'B' });
      o.listPlists = () => { throw new Error('EACCES'); }; clock.t += 600_000;
      const r = await restartServicesForClone({ ...o, pendingOnly: true });
      expect(r.restarted).toEqual([expect.objectContaining({ label })]);
      expect(o.states.get(label)).toEqual({ at: 1_601_000, sha: 'B' });
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
    it.each(['rebuild-job-started', 'rebuild-job-running'])('an owed restart is not retried while a rebuild job is in flight (%s)', async reason => {
      const retry = vi.fn(async () => {}), restart = vi.fn(async () => {});
      await withSelfSync({ tickOnce: () => 'ticked' }, {
        root: cloneRoot, env: {}, versions: null, background: null, onRestart: () => 'restarted',
        rebuild: async () => ({ moved: false, reason }),
        restartServices: restart, retryPendingRestarts: retry, readHead: () => 'boot', readOriginRef: () => null,
        readState: () => ({}), readReady: () => null, cloneIdentity: () => null, acquireRead: () => ({ ok: true }),
        releaseRead: () => {}, importClosure: () => new Set(), diffFiles: () => [], log: { error: vi.fn() } }).tickOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
    });
  });
});
