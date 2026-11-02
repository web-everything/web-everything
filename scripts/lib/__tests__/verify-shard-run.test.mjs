import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { splitVitestArgs, runShards, executeShard, inventoryVerdict, parseShardCli } from '../verify-shard-run.mjs';

describe('shard split', () => {
  it('balances deterministically, covers files once, and preserves flags including values', () => {
    const args = ['npx', 'vitest', 'run', 'a', 'b', 'c', 'd', 'e', '--passWithNoTests', '--testTimeout=300', '--pool', 'forks'];
    const result = splitVitestArgs(args, 3);
    expect(result).toEqual({ shards: [['a', 'b'], ['c', 'd'], ['e']], flags: ['--passWithNoTests', '--testTimeout=300', '--pool', 'forks'] });
    expect(splitVitestArgs(args, 3)).toEqual(result);
    expect(splitVitestArgs(['npx', 'vitest', 'run', 'a'], 4).shards).toEqual([['a']]);
    expect(() => splitVitestArgs(['npx', 'vitest', 'run'], 2)).toThrow();
  });
});
function fixture(modes = [], budgetMs = 100, parallel = 1, acquire = async () => ({ ok: true }), discover = () => null) {
  let time = 0, calls = [], lines = [], releases = 0;
  const reports = new Map();
  const fs = { mkdtempSync: () => '/scratch/shards', readFileSync: p => { if (!reports.has(p)) throw Error('missing'); return reports.get(p); }, rmSync: () => {} };
  const execute = async ({ command, args, files, report, remoteReport, env, timeoutMs }) => {
    calls.push({ command, args, files, env, timeoutMs });
    const mode = modes[calls.length - 1] ?? 'pass';
    if (mode === 'timeout') { time += timeoutMs; return { exitCode: 124, timedOut: true }; }
    if (mode !== 'unreadable') reports.set(report, JSON.stringify({ testResults: (mode === 'missing' ? [] : files).map(name => ({ name, status: ['red', 'remote-red', 'remote-red-137', 'red-with-ok-remote'].includes(mode) ? 'failed' : 'passed', assertionResults: [{ status: 'passed' }] })) }));
    if (mode === 'remote-red' || mode === 'remote-red-137') reports.set(remoteReport, JSON.stringify({ location: 'remote', exitCode: 1 }) + '\n');
    if (mode === 'red-with-ok-remote') reports.set(remoteReport, JSON.stringify({ location: 'remote', exitCode: 0 }) + '\n');
    return { exitCode: mode === 'remote-red-137' ? 137 : ['red', 'remote-red', 'red-with-ok-remote'].includes(mode) ? 1 : 0 };
  };
  const run = () => runShards({ argv: ['npx', 'vitest', 'run', 'a', 'b', 'c'], shards: 3, parallel, budgetMs }, { discover,
    fs, execute, now: () => time, tmpdir: () => '/scratch', log: s => lines.push(s), env: {},
    acquireLocal: acquire, releaseLocal: () => { releases++; },
  });
  return { run, calls, lines, releases: () => releases };
}
describe('fail-closed wrapper', () => {
  it('all pass exits zero and prints GREEN plus a line per shard', async () => {
    const f = fixture(); expect(await f.run()).toBe(0);
    expect(f.lines.join('')).toContain('GREEN (all 3 shards, 3 files executed and passed)');
    expect(f.lines.filter(l => l.startsWith('verify-shard '))).toHaveLength(3);
    expect(f.calls[0].args.some(a => a.endsWith('scripts/readiness/heavy-admission.mjs'))).toBe(true);
  });
  it.each(['red', 'missing', 'unreadable'])('%s cannot turn green', async mode => {
    const f = fixture([mode]); expect(await f.run()).toBe(1);
    expect(f.lines.join('')).not.toContain('GREEN');
    if (mode !== 'red') expect(f.lines.join('')).toContain('INVENTORY-INCOMPLETE');
  });
  it('timeout exhausts budget and records unstarted shards NOT-RUN', async () => {
    const f = fixture(['timeout']); expect(await f.run()).toBe(124);
    expect(f.calls).toHaveLength(1); expect(f.lines.join('')).toContain('NOT-RUN');
  });
  it('a later timeout still surfaces as a timeout (never hidden as a plain red)', async () => {
    const f = fixture(['red', 'timeout']); expect(await f.run()).toBe(124);
  });
  it('exhausted budget starts nothing and cannot pass', async () => {
    const f = fixture([], 0); expect(await f.run()).toBe(124); expect(f.calls).toHaveLength(0);
  });
  it('remote red remains red when no local slot can be acquired', async () => {
    const f = fixture(['remote-red'], 100, 1, async () => ({ ok: false }));
    expect(await f.run()).toBe(1); expect(f.calls.every(c => c.command === 'node')).toBe(true);
    expect(f.releases()).toBe(0);
  });
  it.each(['pass', 'red'])('remote red is confirmed locally once: %s', async local => {
    const f = fixture(['remote-red', local]); expect(await f.run()).toBe(local === 'pass' ? 0 : 1);
    expect(f.calls).toHaveLength(4); expect(f.calls[1].command).toBe('npx');
    expect(f.calls[1].env.WE_HEAVY_ADMISSION_HELD).toBe('1'); expect(f.releases()).toBe(1);
  });
});

describe('process boundary and bounds', () => {
  it('kills the whole child tree at the deadline and prefixes both output streams', async () => {
    const child = new EventEmitter(); child.pid = 123;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let fire, killed, cleared = false; const lines = [];
    const pending = executeShard({ command: 'node', args: [], timeoutMs: 19, prefix: '[shard] ', log: l => lines.push(l) }, {
      spawn: () => child, killTree: (...args) => { killed = args; },
      setTimer: (fn, ms) => { expect(ms).toBe(19); fire = fn; return 7; }, clearTimer: () => { cleared = true; },
    });
    child.stdout.emit('data', 'failure details\n'); child.stderr.emit('data', 'stderr details\n'); fire();
    expect(await pending).toEqual({ exitCode: 124, timedOut: true });
    expect(killed).toEqual([123, 'SIGKILL', { orphansOfGroup: 123 }]); expect(cleared).toBe(true);
    expect(lines.join('')).toContain('[shard] failure details'); expect(lines.join('')).toContain('[shard] stderr details');
  });
  it('spawn errors are red, and malformed CLI input is refused', async () => {
    expect(await executeShard({}, { spawn: () => { throw Error('spawn'); } })).toEqual({ exitCode: 1 });
    expect(() => parseShardCli(['--shards=1', '--parallel=1', '--budget-ms=no', '--'])).toThrow();
    expect(() => splitVitestArgs(['npx', 'vitest', 'run', 'a', '--outputFile=x'], 1)).toThrow();
  });
  it('a skipped file in the JSON inventory is incomplete evidence', () => {
    expect(inventoryVerdict(JSON.stringify({ testResults: [{ name: 'a', status: 'passed', assertionResults: [{ status: 'pending' }] }] }), ['a'])).toBe('INVENTORY-INCOMPLETE');
  });
  it('runs at most P shards at once and keeps flags on each', async () => {
    let active = 0, peak = 0; const reports = new Map(), calls = [];
    const code = await runShards({ argv: ['npx', 'vitest', 'run', 'a', 'b', 'c', 'd', '--passWithNoTests'], shards: 4, parallel: 2, budgetMs: 5000 }, { discover: () => null,
      log: () => {}, env: {}, tmpdir: () => '/scratch', fs: { mkdtempSync: () => '/scratch/shards', rmSync: () => {}, readFileSync: p => { if (!reports.has(p)) throw Error(); return reports.get(p); } },
      execute: async ({ files, report, args }) => {
        active++; peak = Math.max(peak, active); calls.push(args);
        await new Promise(resolve => setTimeout(resolve, 1)); active--;
        reports.set(report, JSON.stringify({ testResults: files.map(name => ({ name, status: 'passed', assertionResults: [{ status: 'passed' }] })) }));
        return { exitCode: 0 };
      },
    });
    expect(code).toBe(0); expect(peak).toBe(2); expect(calls).toHaveLength(4);
    for (const args of calls) expect(args).toContain('--passWithNoTests');
  });
});

describe('config-excluded selected files', () => {
  const abs = f => resolve(process.cwd(), f);
  it('names and drops a file the vitest config excludes; never runs it', async () => {
    const f = fixture([], 100, 1, undefined, () => new Set([abs('a'), abs('b')]));
    expect(await f.run()).toBe(0);
    expect(f.calls.flatMap(c => c.files)).toEqual(['a', 'b']);
    expect(f.lines.join('')).toMatch(/NOTE 1 selected file\(s\) are excluded by the vitest config.*: c/);
  });
  it('unknown discovery keeps every file (fail closed)', async () => {
    const f = fixture();
    expect(await f.run()).toBe(0);
    expect(f.calls.flatMap(c => c.files)).toEqual(['a', 'b', 'c']);
    expect(f.lines.join('')).not.toMatch(/NOTE/);
  });
  it('discovery that rejects every file is treated as unreliable: all files stay selected', async () => {
    const f = fixture([], 100, 1, undefined, () => new Set());
    await f.run();
    expect(f.calls.flatMap(c => c.files)).toEqual(['a', 'b', 'c']);
  });
  it('a remote infrastructure exit (137) is never replaced by a local pass', async () => {
    const f = fixture(['remote-red-137']);
    expect(await f.run()).not.toBe(0);
    expect(f.lines.join('')).not.toMatch(/confirming locally/);
    expect(await fixture(['remote-red-137']).run()).toBe(137);
  });
});

describe('exit-code precedence and remote evidence', () => {
  it('a timeout beats a sibling red and no further shard starts after it', async () => {
    const f = fixture(['timeout', 'red', 'pass']);
    expect(await f.run()).toBe(124);
    expect(f.calls.length).toBe(1);
    expect(f.lines.join('')).toMatch(/NOT-RUN/);
  });
  it('a successful remote report never authorizes a local replacement', async () => {
    const f = fixture(['red-with-ok-remote']);
    expect(await f.run()).not.toBe(0);
    expect(f.lines.join('')).not.toMatch(/confirming locally/);
  });
});

describe('signal-killed shard (128+signal from heavy-admission)', () => {
  it('halts: no further shard starts and the 137 reaches the caller', async () => {
    const f = fixture(['remote-red-137', 'pass', 'pass']);
    expect(await f.run()).toBe(137);
    expect(f.calls.length).toBe(1);
  });
});
