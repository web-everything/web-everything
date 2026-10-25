/**
 * @file bounded-child-tree-kill.test.mjs — killProcessTree / descendantPids (verify-admission, 2026-10-20): verify-lane's
 * per-phase timeout must kill the whole gate tree (shell → npm exec → vitest → esbuild), not just the shell.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { descendantPids, killProcessTree, markedPidsFromPs, peerHolderPids } from '../bounded-child.mjs';
import { startTreeWatchdog } from '../tree-watchdog.mjs';
import { keepAliveScript } from '../test-keepalive.mjs';

describe('descendantPids', () => {
  it('returns every descendant, deepest first, excluding the root and unrelated processes', () => {
    const ps = ['1 0', '10 1', '11 10', '12 11', '13 10', '20 1', ' 14   12 ', 'junk', '15 15'].join('\n');
    expect(descendantPids(10, ps)).toEqual([14, 12, 11, 13]);
    expect(descendantPids(99, ps)).toEqual([]);
  });
});

describe('escaped-descendant listings (PR #5768)', () => {
  it('markedPidsFromPs matches the exact NAME=value word, never self, init, or a longer value', () => {
    const ps = ['  1 launchd M_1=abc', '42 node x.js PATH=/bin M_1=abc HOME=/h', '43 node M_1=abcd', '44 grep M_1=ab',
      '50 node M_1=abc', '45 sleep 120', 'junk', '46 node M_1=abc'].join('\n');
    expect(markedPidsFromPs(ps, 'M_1=abc', { selfPid: 50 })).toEqual([42, 46]);
  });

  it('peerHolderPids returns the holders of the peer ends of the given fds only', () => {
    // Self (50) holds fd 15 → peer 0xaa and fd 17 → peer 0xbb; fd 20 → 0xcc is not asked for.
    const lsof = ['p50', 'f15', 'd0xF0', 'n->0xAA', 'f17', 'd0xf1', 'n->0xbb', 'f20', 'd0xf2', 'n->0xcc',
      'p60', 'f1', 'd0xaa', 'n->0xf0', 'f2', 'd0xbb', 'n->0xf1',
      'p61', 'f2', 'd0xbb', 'n->0xf1',
      'p62', 'f1', 'd0xcc', 'n->0xf2',
      'p63', 'f4', 'd0xdd', 'n->(none)',
      'p1', 'f9', 'd0xaa', 'n->0xf0'].join('\n');
    expect(peerHolderPids(lsof, { selfPid: 50, fds: [15, 17] })).toEqual([60, 61]);
    expect(peerHolderPids(lsof, { selfPid: 50, fds: [] })).toEqual([]);
    expect(peerHolderPids('', { selfPid: 50, fds: [15] })).toEqual([]);
  });
});

describe('startTreeWatchdog (PR #5768)', () => {
  it('kills the tree from its own thread while the main thread is blocked, and heartbeats only until then', async () => {
    const child = spawn(process.execPath, ['-e', keepAliveScript()], { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', (code, signal) => r(signal)));
    const dir = mkdtempSync(join(tmpdir(), 'tree-watchdog-'));
    const beats = join(dir, 'beats.log');
    const beatModule = join(dir, 'beat.mjs');
    writeFileSync(beatModule, `import { appendFileSync } from 'node:fs';\nexport const beat = ({ file }) => appendFileSync(file, 'b');\n`);
    try {
      const fired = [];
      const watchdog = startTreeWatchdog({ pid: child.pid, timeoutMs: 600, onFire: () => fired.push(Date.now()),
        heartbeat: { module: pathToFileURL(beatModule).href, exportName: 'beat', args: { file: beats }, everyMs: 100 } });
      const blockUntil = Date.now() + 1_500;
      while (Date.now() < blockUntil) { /* a blocked event loop: no main-thread timer can run */ }
      expect(watchdog.fired()).toBe(true);
      expect(await exited).toBe('SIGKILL');
      const beatsAtKill = readFileSync(beats, 'utf8').length;
      expect(beatsAtKill).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 400));
      expect(fired).toHaveLength(1);
      expect(readFileSync(beats, 'utf8').length).toBe(beatsAtKill);
      watchdog.stop();
    } finally {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the ceiling on its thread when the heartbeat module fails to load (self-review A)', async () => {
    const child = spawn(process.execPath, ['-e', keepAliveScript()], { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', (code, signal) => r(signal)));
    const warned = [];
    try {
      const watchdog = startTreeWatchdog({ pid: child.pid, timeoutMs: 600, warn: (m) => warned.push(m),
        heartbeat: { module: pathToFileURL(join(tmpdir(), 'no-such-heartbeat-module.mjs')).href, exportName: 'beat', args: {}, everyMs: 100 } });
      const blockUntil = Date.now() + 1_500;
      while (Date.now() < blockUntil) { /* a blocked event loop: no main-thread timer can run */ }
      expect(watchdog.fired()).toBe(true);
      expect(await exited).toBe('SIGKILL');
      expect(warned).toEqual([]);
      watchdog.stop();
    } finally {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  });

  it('runs the code captured at load (a data: URL), and logs a fallback to the main-thread timer', async () => {
    const child = spawn(process.execPath, ['-e', keepAliveScript()], { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', (code, signal) => r(signal)));
    const warned = [];
    try {
      const watchdog = startTreeWatchdog({ pid: child.pid, timeoutMs: 200, moduleUrl: null, warn: (m) => warned.push(m) });
      expect(warned.join('')).toMatch(/falls back to a main-thread timer/);
      expect(await exited).toBe('SIGKILL');
      expect(watchdog.fired()).toBe(true);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
    // A copy of this module, loaded by a plain node process, then overwritten on disk: the watchdog must still run the
    // loaded code. (A plain process: vitest's loader cannot import a module from outside the project root.)
    const dir = mkdtempSync(join(tmpdir(), 'tree-watchdog-swap-'));
    try {
      const copy = join(dir, 'tree-watchdog.mjs');
      const helperCopy = join(dir, 'bounded-child.mjs');
      writeFileSync(copy, readFileSync(resolve(process.cwd(), 'scripts/lib/tree-watchdog.mjs')));
      writeFileSync(helperCopy, readFileSync(resolve(process.cwd(), 'scripts/lib/bounded-child.mjs')));
      const probe = join(dir, 'probe.mjs');
      writeFileSync(probe, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const loaded = await import(${JSON.stringify(pathToFileURL(copy).href)});
writeFileSync(${JSON.stringify(copy)}, 'export const broken = true;\\n');
writeFileSync(${JSON.stringify(helperCopy)}, 'export const broken = true;\\n');
const victim = spawn(process.execPath, ['-e', ${JSON.stringify(keepAliveScript())}], { stdio: 'ignore' });
const exited = new Promise((r) => victim.once('exit', (code, signal) => r(signal)));
const warned = [];
const watchdog = loaded.startTreeWatchdog({ pid: victim.pid, timeoutMs: 400, warn: (m) => warned.push(m) });
const blockUntil = Date.now() + 1_200;
while (Date.now() < blockUntil) { /* a blocked event loop: only the watchdog thread can fire */ }
const fired = watchdog.fired();
const signal = await Promise.race([exited, new Promise((r) => setTimeout(() => r('alive'), 5_000))]);
if (signal === 'alive') victim.kill('SIGKILL');
console.log(JSON.stringify({ fired, signal, warned }));
`);
      const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual({ fired: true, signal: 'SIGKILL', warned: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stop() right after the fire does not cut the escape sweep short; settled() waits for it (verify red, attempt 1)', async () => {
    // The tree root dies at once, so a caller settles on its close and stops the watchdog while the env-marker sweep
    // (a slow `ps -E`) is still running. Before: stop() terminated the worker mid-sweep and the marked escapee lived.
    if (!['darwin', 'linux'].includes(process.platform)) return;
    const marker = `WE_TEST_TREE_WATCHDOG_${process.pid}=${Date.now()}`;
    const [name, value] = marker.split('=');
    const escapee = spawn(process.execPath, ['-e', keepAliveScript()], { stdio: 'ignore', detached: true, env: { ...process.env, [name]: value } });
    escapee.unref();
    const root = spawn(process.execPath, ['-e', keepAliveScript()], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      let watchdog = null;
      const fired = new Promise((r) => { watchdog = startTreeWatchdog({ pid: root.pid, timeoutMs: 100, kill: { marker }, onFire: r }); });
      await fired;
      watchdog.stop();
      await watchdog.settled();
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(escapee.pid, 0), 'the marked escapee must be killed').toThrow();
    } finally {
      try { process.kill(escapee.pid, 'SIGKILL'); } catch { /* gone */ }
      try { root.kill('SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  it('stop() before the ceiling disarms it', async () => {
    const child = spawn(process.execPath, ['-e', keepAliveScript()], { stdio: 'ignore' });
    try {
      const watchdog = startTreeWatchdog({ pid: child.pid, timeoutMs: 300 });
      watchdog.stop();
      await new Promise((r) => setTimeout(r, 700));
      expect(watchdog.fired()).toBe(false);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('killProcessTree', () => {
  it('signals descendants before the root, and tolerates already-dead pids', () => {
    const sent = [];
    const kill = (pid, sig) => { if (pid === 11) throw new Error('ESRCH'); sent.push([pid, sig]); };
    expect(killProcessTree(10, 'SIGKILL', { listProcesses: () => '10 1\n11 10\n12 11\n', kill })).toEqual([12, 10]);
    expect(sent).toEqual([[12, 'SIGKILL'], [10, 'SIGKILL']]);
    expect(killProcessTree(0)).toEqual([]);
  });

  it('orphansOfGroup also kills reparented (ppid 1) members of that group, never the leader, self, or other groups', () => {
    const sent = [];
    const ps = ['10 5 77', '11 10 77', '40 1 77', '41 1 99', '77 1 77', '50 1 77'].join('\n');
    killProcessTree(10, 'SIGKILL', { orphansOfGroup: 77, selfPid: 50, listProcesses: () => ps, kill: (pid) => sent.push(pid) });
    expect(sent).toEqual([40, 11, 10]);
  });

  it('also kills escaped descendants found by the env marker and by the caller output pipes, never self or init', () => {
    const sent = [];
    const asked = {};
    killProcessTree(10, 'SIGKILL', { selfPid: 50, marker: 'M_1=abc', outputFds: [15],
      listProcesses: () => '10 5 77\n11 10 77\n',
      listMarked: (m) => { asked.marker = m; return [60, 50, 1, 11]; },
      listPeerHolders: (fds) => { asked.fds = fds; return [61, 60]; },
      kill: (pid) => sent.push(pid) });
    expect(asked).toEqual({ marker: 'M_1=abc', fds: [15] });
    expect(sent).toEqual([11, 10, 60, 61]); // the tree first: the escape listings are slow
  });

  it('kills a real grandchild that a plain child.kill() would orphan', async () => {
    const child = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise((r) => child.stdout.once('data', (d) => r(Number(String(d).trim()))));
    const closed = new Promise((r) => child.once('close', r));
    killProcessTree(child.pid, 'SIGKILL');
    await closed;
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });
});
