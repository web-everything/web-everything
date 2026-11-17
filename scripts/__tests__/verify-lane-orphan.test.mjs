import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync, execFile, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pidIdentity } from '../lib/pid-alive.mjs';
import { markerLock } from '../lib/lane-verify-lifecycle.mjs';
import { writeInFlightHandoff } from '../../skills-src/conveyor/verify-daemon.mjs';
const exec = promisify(execFile);
const cli = resolve('scripts/verify-lane.mjs');
let dir;
let sha;
let env;
let marker;
const children = new Set();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-orphan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir });
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  marker = join(dir, '.git', '.lane-verify');
  const preferences = join(dir, '.git', 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ heavyAdmission: { remote: { enabled: false } } }));
  // Some hosts deny ps in the sandbox. Supply explicit process evidence to the CLI while
  // keeping spawning, signalling and marker writes real. Unknown fixture PIDs stay unreadable.
  const probe = join(dir, '.git', 'process-probe.mjs');
  const processes = join(dir, '.git', 'processes.json');
  writeFileSync(processes, '[]');
  writeFileSync(probe, `import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { readFileSync } from 'node:fs';
    const original = cp.execFileSync;
    cp.execFileSync = (command, args, options) => {
      if (command !== 'ps') return original(command, args, options);
      const rows = JSON.parse(readFileSync(process.env.WE_TEST_PROCESS_ROWS, 'utf8'));
      const format = args[args.indexOf('-o') + 1];
      if (format === 'pid=,ppid=,pgid=') return rows.map(r => [r.pid, r.ppid, r.pgid].join(' ')).join('\\n');
      if (format === 'pid=,command=') return '';
      const row = rows.find(r => r.pid === Number(args[args.indexOf('-p') + 1]));
      if (!row) throw new Error('fixture process identity unavailable');
      if (format === 'stat=,command=') return 'S ' + row.command;
      if (format === 'lstart=') return row.started;
      if (format === 'pgid=') return String(row.pgid);
      throw new Error('unexpected process probe: ' + format);
    };
    syncBuiltinESMExports();`);
  // These hermetic gate commands are nested inside the admitted test process, never a second heavy job.
  env = { ...process.env, WE_TOOLS_ROOT_REEXEC: '1', WE_PLATFORM_PREFERENCES: preferences,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(probe).href].filter(Boolean).join(' '),
    WE_TEST_PROCESS_ROWS: processes,
    LANE_POOL_ROOT: join(dir, 'pool'), WE_VERIFY_DAEMON_INFLIGHT_FILE: join(dir, 'inflight.json'), WE_DAEMON_JOBS_ROOT: join(dir, 'jobs') };
  writeFileSync(marker, JSON.stringify({ sha, status: 'running', pid: 2147483647,
    runId: 'orphan', heartbeatAt: new Date().toISOString(), startedAt: new Date().toISOString() }));
});
afterEach(async () => {
  await Promise.all([...children].map(async child => {
    const closed = child.exitCode === null && child.signalCode === null ? once(child, 'close') : null;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    await closed;
  }));
  children.clear();
  rmSync(dir, { recursive: true, force: true });
});
async function invoke(mode, args = []) {
  let output;
  let code = 0;
  try { output = await exec(process.execPath, [cli, mode, '--json', ...args], { cwd: dir, env, timeout: 30_000, maxBuffer: 256 * 1024 }); }
  catch (error) { output = error; code = error.code; }
  return { code, json: JSON.parse(String(output.stdout).trim().split('\n').at(-1)) };
}
const check = (args = []) => invoke('check', args);
async function liveRun() {
  const script = join(dir, '.git', 'verify-lane.mjs');
  writeFileSync(script, "process.on('message', () => {}); process.send('ready');");
  const child = fork(script, ['--run-id=executing'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.add(child);
  await once(child, 'message');
  writeFileSync(env.WE_TEST_PROCESS_ROWS, JSON.stringify([{ pid: child.pid, ppid: process.pid, pgid: child.pid,
    command: 'node verify-lane.mjs --run-id=executing', started: new Date().toString() }]));
  const record = { sha, status: 'running', pid: child.pid, runId: 'executing',
    heartbeatAt: new Date().toISOString(), startedAt: new Date().toISOString() };
  writeFileSync(marker, JSON.stringify(record));
  return record;
}

describe('foreground orphan takeover', () => {
  it.each([{ gateCode: 0, status: 'green', code: 0 }, { gateCode: 1, status: 'red', code: 2 }])(
    'normal completion preserves the completed $status verdict through transient marker-lock contention', async ({ gateCode, status, code }) => {
      const gateDone = join(dir, '.git', 'gate-completed');
      const evidence = join(dir, '.git', 'completion-lock-events');
      const lockRoot = join(dir, '.git', '.lane-verify.takeover') + '/';
      const preload = join(dir, '.git', 'completion-contention.mjs');
      // Inject contention at the filesystem boundary only after the real gate completes.
      // The real CLI chooses the retry policy; the fixture never supplies retryMs itself.
      writeFileSync(preload, `import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const mkdir = fs.mkdirSync;
        const wait = Atomics.wait;
        const now = Date.now;
        let blocked = true;
        let heldPath;
        let waitedMs = 0;
        Date.now = () => now() + waitedMs;
        fs.mkdirSync = (path, options) => {
          if (String(path).startsWith(${JSON.stringify(lockRoot)}) && options?.recursive === false
              && fs.existsSync(${JSON.stringify(gateDone)})) {
            fs.appendFileSync(${JSON.stringify(evidence)}, blocked ? 'contended\\n' : 'acquired\\n');
            if (blocked) {
              // Model a competing writer between atomic mkdir and its lock-entry write.
              mkdir(path, options);
              heldPath = path;
              throw Object.assign(new Error('fixture marker lock busy'), { code: 'EEXIST' });
            }
          }
          return mkdir(path, options);
        };
        Atomics.wait = (...args) => {
          if (blocked && fs.existsSync(${JSON.stringify(gateDone)})) {
            waitedMs += args[3];
            fs.rmSync(heldPath, { recursive: true });
            blocked = false;
            fs.appendFileSync(${JSON.stringify(evidence)}, 'waited ' + waitedMs + '\\n');
            return 'timed-out';
          }
          return wait(...args);
        };
        syncBuiltinESMExports();`);
      env.NODE_OPTIONS += ' --import=' + pathToFileURL(preload).href;
      const gate = join(dir, 'complete-gate.mjs');
      writeFileSync(gate, `import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(gateDone)}, 'completed'); process.exit(${gateCode});`);
      const result = await check([`--gate=node ${gate}`]);
      expect(result).toMatchObject({ code, json: { status, sha, exitCode: gateCode } });
      expect(readFileSync(evidence, 'utf8').trim().split('\n')).toEqual(['contended', 'waited 50', 'acquired']);
      const finished = JSON.parse(readFileSync(marker, 'utf8'));
      expect(finished).toMatchObject({ sha, status, exitCode: gateCode, finishedAt: expect.any(String) });
      expect(finished.infrastructure).toBeUndefined();
    });
  it.each([{ args: [] }, { args: ['--wait=1000'] }])('check $args reruns and reports green only after the exact-SHA gate completes', async ({ args }) => {
    const evidence = join(dir, 'completed');
    const gate = join(dir, 'gate.mjs');
    writeFileSync(gate, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(evidence)}, 'completed');`);
    const result = await check([...args, `--gate=node ${gate}`]);
    expect(result).toMatchObject({ code: 0, json: { status: 'green', sha } });
    expect(readFileSync(evidence, 'utf8')).toBe('completed');
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ sha, status: 'green', pid: expect.any(Number),
      runId: expect.any(String), finishedAt: expect.any(String) });
  });
  it('two concurrent checks start exactly one verification for the same SHA', async () => {
    const evidence = join(dir, 'runs');
    const gate = join(dir, 'gate.mjs');
    writeFileSync(gate, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(evidence)}, 'run\\n');`);
    const results = await Promise.all([check([`--gate=node ${gate}`]), check([`--gate=node ${gate}`])]);
    expect(readFileSync(evidence, 'utf8')).toBe('run\n');
    expect(results.some(result => result.json.status === 'green')).toBe(true);
    for (const result of results) if (result.json.status !== 'green') expect(result.code).not.toBe(0);
  });
  it('a HEAD change during takeover cannot publish green', async () => {
    const gate = join(dir, 'move-head.mjs');
    writeFileSync(gate, `import { execFileSync } from 'node:child_process';
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'moved']);`);
    const result = await check([`--gate=node ${gate}`]);
    expect(result).toMatchObject({ code: 3, json: { ok: false, status: 'head-moved' } });
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ sha, status: 'infrastructure-failure' });
  });
  it('status scans every pool without changing markers', async () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    const records = [
      { status: 'running', pid: 2147483647, heartbeatAt: old },
      { status: 'running', requestedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() },
      { status: 'green', finishedAt: old, exitCode: 0 }, { status: 'red', finishedAt: old, exitCode: 1 },
    ];
    const paths = records.map((record, i) => {
      const gitDir = join(env.LANE_POOL_ROOT, i % 2 ? 'second' : 'first', `lane-${i + 1}`, '.git');
      mkdirSync(gitDir, { recursive: true });
      const path = join(gitDir, '.lane-verify');
      writeFileSync(path, JSON.stringify({ ...record, sha }));
      return path;
    });
    const before = paths.map(path => readFileSync(path, 'utf8'));
    const output = await exec(process.execPath, [cli, 'status', '--json'], { cwd: dir, env, timeout: 10_000, maxBuffer: 256 * 1024 });
    const result = JSON.parse(output.stdout.trim());
    expect(result.markers.map(marker => marker.state).sort()).toEqual(['green', 'orphaned', 'red', 'requested']);
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before);
  });
  it('failed reruns never bless the orphaned SHA', async () => {
    const result = await check(['--gate=false']);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ sha, status: 'red' });
  });
  it('refused takeover gives the exact foreground rerun command', async () => {
    writeFileSync(join(dir, '.git', '.lane-verify.takeover'), 'unwritable lock root');
    const result = await check(['--gate=true']);
    expect(result.code).not.toBe(0);
    expect(result.json.rerun).toContain('node scripts/verify-lane.mjs --repo=');
    expect(result.json).toMatchObject({ status: 'orphaned', reason: 'dead-pid' });
    expect(JSON.parse(readFileSync(marker, 'utf8')).status).toBe('running');
  });
  it.each(['legacy-array', 'daemon-envelope'])('stale unstarted request recovers with an empty %s handoff', async shape => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    writeFileSync(marker, JSON.stringify({ sha, status: 'running', requestedAt: old, startedAt: old, heartbeatAt: old }));
    if (shape === 'legacy-array') writeFileSync(env.WE_VERIFY_DAEMON_INFLIGHT_FILE, '[]');
    else writeInFlightHandoff(new Map(), env.WE_VERIFY_DAEMON_INFLIGHT_FILE);
    expect(await check(['--gate=true'])).toMatchObject({ code: 0, json: { sha, status: 'green' } });
  });
  it('a live entry in the daemon envelope protects an old unstarted request', async () => {
    const live = await liveRun();
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    const request = { sha, status: 'running', requestedAt: old, startedAt: old, heartbeatAt: old };
    writeFileSync(marker, JSON.stringify(request));
    writeInFlightHandoff(new Map([['active', { ...live, dir, startedMs: Date.now() }]]), env.WE_VERIFY_DAEMON_INFLIGHT_FILE);
    expect(await check(['--gate=true'])).toMatchObject({ code: 2, json: { status: 'running' } });
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(request);
  });
  it('an unreadable handoff shape cannot establish that a stale request has no dispatcher', async () => {
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    const request = { sha, status: 'running', requestedAt: old, startedAt: old, heartbeatAt: old };
    writeFileSync(marker, JSON.stringify(request));
    writeFileSync(env.WE_VERIFY_DAEMON_INFLIGHT_FILE, JSON.stringify({ records: null }));
    expect(await check(['--gate=true'])).toMatchObject({ code: 2, json: { status: 'running' } });
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(request);
  });
  it('SIGTERM kills the running gate and its grandchild before persisting infra failure', async () => {
    const grandchild = join(dir, 'grandchild.mjs');
    const gate = join(dir, 'gate.mjs');
    writeFileSync(grandchild, 'setInterval(() => {}, 1000);'); // keepalive-helper-ok: the test asserts SIGTERM kills this grandchild and reaps it in afterEach
    writeFileSync(gate, `import { spawn } from 'node:child_process';
      import { readFileSync, writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit' });
      child.on('spawn', () => {
        const verifier = JSON.parse(readFileSync(${JSON.stringify(marker)}, 'utf8')).pid;
        writeFileSync(process.env.WE_TEST_PROCESS_ROWS, JSON.stringify([
          { pid: verifier, ppid: 0, pgid: verifier },
          { pid: process.ppid, ppid: verifier, pgid: verifier },
          { pid: process.pid, ppid: process.ppid, pgid: verifier },
          { pid: child.pid, ppid: process.pid, pgid: verifier }
        ]));
        console.log('TREE_READY:' + JSON.stringify([process.pid, child.pid]));
      });`);
    const child = spawn(process.execPath, [cli, '--json', `--gate=node ${gate}`],
      { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const closed = once(child, 'close');
    const pids = await new Promise((resolveReady, reject) => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /TREE_READY:(\[[^\n]+\])/.exec(output);
        if (match) resolveReady(JSON.parse(match[1]));
      });
      child.on('error', reject);
      child.on('exit', () => reject(new Error('verify exited before gate readiness')));
    });
    child.kill('SIGTERM');
    expect(await closed).toEqual([3, null]);
    for (const pid of pids) expect(pidIdentity(pid, { exec: (command, args, options) => {
      // An ESRCH from the kernel proves absence even where sandboxed ps is unavailable.
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return ''; throw error; }
      return execFileSync(command, args, options);
    } })).toMatchObject({ alive: false });
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ status: 'infrastructure-failure',
      exitCode: 3, infrastructure: { reason: 'killed-SIGTERM' } });
  }, 45_000);
  it.each(['refusal', 'card-only'])('%s terminal path preserves an executing run marker', async path => {
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
    if (path === 'refusal') writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'echo must-not-run' } }));
    else {
      mkdirSync(join(dir, 'backlog'));
      writeFileSync(join(dir, 'backlog', 'test-card.md'), 'card\n');
    }
    const active = await liveRun();
    const result = await invoke('verify', path === 'refusal' ? ['--gate=true', '--run-id=refusing'] : []);
    expect(result).toMatchObject({ code: 2, json: { status: 'running', reason: 'live-pid' } });
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(active);
  });
  it.each(['refusal', 'card-only'])('%s terminal path refuses a contended marker lock', async path => {
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
    if (path === 'refusal') writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'echo must-not-run' } }));
    else {
      mkdirSync(join(dir, 'backlog'));
      writeFileSync(join(dir, 'backlog', 'test-card.md'), 'card\n');
    }
    const live = await liveRun();
    const held = markerLock(join(dir, '.git'), { pid: live.pid });
    try {
      const result = await invoke('verify', path === 'refusal' ? ['--gate=true', '--run-id=refusing'] : []);
      expect(result).toMatchObject({ code: 3, json: { reason: 'marker-busy' } });
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(live);
    } finally { held(); }
  });
});
