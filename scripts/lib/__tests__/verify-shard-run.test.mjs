// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { allowedCommand } from '../../readiness/forge-exec-run.mjs';
import { runRemote } from '../../readiness/remote-exec.mjs';
import { keepAliveScript } from '../test-keepalive.mjs';
import { pidIdentity } from '../pid-alive.mjs';
import { splitVitestArgs, runShards, executeShard, inventoryVerdict, parseShardCli, streamedInventory, SHARD_REPORT_MAX_BYTES, SHARD_UNSETTLED_EXIT } from '../verify-shard-run.mjs';

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
  // Every JSON failure signal, through every channel the inventory can arrive on, with the shard process exiting 0.
  // The exit code never carries the failure here, so a red verdict can only come from the JSON evidence itself.
  const JSON_FAILURE_SIGNALS = [
    ['report.success=false', { success: false }, 'passed', 'passed'],
    ['failed suite', { success: true }, 'failed', 'passed'],
    ['failed assertion', { success: true }, 'passed', 'failed'],
  ];
  const EVIDENCE_CHANNELS = {
    // executeShard's result already carries the streamed inventory.
    'streamed result': reportText => ({ fs: { mkdtempSync: () => '/scratch/shards', rmSync: () => {}, readFileSync: () => { throw Error('missing'); } },
      tmpdir: () => '/scratch', execute: async () => ({ exitCode: 0, reportText }) }),
    // No reportText key: the wrapper reads the per-shard report file instead.
    'report file': reportText => ({ fs: { mkdtempSync: () => '/scratch/shards', rmSync: () => {},
      readFileSync: p => { if (p === '/scratch/shards/0.initial.json') return reportText; throw Error('missing'); } },
    tmpdir: () => '/scratch', execute: async () => ({ exitCode: 0 }) }),
    // A real child prints the JSON on stdout and exits 0; executeShard must stream it into the verdict.
    // The result is returned, not asserted here: runShards catches anything thrown inside execute.
    'real child stdout': reportText => ({ fs, execute: async options => {
      const result = await executeShard({ ...options, command: process.execPath,
        args: ['-e', `console.log('install output'); console.log(${JSON.stringify(reportText)});`] });
      return { ...result, observed: { exitCode: result.exitCode, reportText: result.reportText } };
    } }),
  };
  const runOneShard = async ({ execute, ...deps }, lines, reportText) => {
    const results = [];
    const code = await runShards({ argv: ['npx', 'vitest', 'run', 'a'], shards: 1, parallel: 1, budgetMs: 10000 },
      { discover: () => null, env: { PATH: process.env.PATH }, log: line => lines.push(line), ...deps,
        execute: async options => { const result = await execute(options); results.push(result); return result; } });
    // Exactly one attempt, it exited 0, and (for a real child) the inventory really arrived on stdout.
    expect(results).toHaveLength(1);
    expect(results[0].exitCode).toBe(0);
    if (results[0].observed) expect(results[0].observed).toEqual({ exitCode: 0, reportText });
    expect(lines.join('')).not.toContain('verify-shard error');
    return code;
  };
  it.each(Object.keys(EVIDENCE_CHANNELS))('%s: passing JSON with exit 0 is GREEN (control for the failure cases)', async channel => {
    const reportText = JSON.stringify({ success: true, testResults: [{ name: 'a', status: 'passed', assertionResults: [{ status: 'passed' }] }] });
    const lines = [];
    expect(await runOneShard(EVIDENCE_CHANNELS[channel](reportText), lines, reportText)).toBe(0);
    expect(lines.join('')).toContain('verify-shard 1/1: PASS');
  });
  it.each(Object.keys(EVIDENCE_CHANNELS).flatMap(channel => JSON_FAILURE_SIGNALS.map(signal => [channel, ...signal])))(
    '%s: %s cannot turn green even when the process exits zero', async (channel, _label, summary, status, assertionStatus) => {
      const reportText = JSON.stringify({ ...summary, testResults: [
        { name: 'a', status, assertionResults: [{ status: assertionStatus }] },
      ] });
      expect(inventoryVerdict(reportText, ['a'])).toBe('FAIL');
      const lines = [];
      expect(await runOneShard(EVIDENCE_CHANNELS[channel](reportText), lines, reportText)).toBe(1);
      // FAIL from the JSON evidence, not INVENTORY-INCOMPLETE from a lost or unreadable report.
      expect(lines.join('')).toMatch(/verify-shard 1\/1: FAIL /);
      expect(lines.join('')).not.toContain('GREEN');
    });
  it('all pass exits zero and prints GREEN plus a line per shard', async () => {
    const f = fixture(); expect(await f.run()).toBe(0);
    expect(f.lines.join('')).toContain('GREEN (all 3 shards, 3 files executed and passed)');
    expect(f.lines.filter(l => l.startsWith('verify-shard '))).toHaveLength(3);
    expect(f.calls[0].args.some(a => a.endsWith('scripts/readiness/heavy-admission.mjs'))).toBe(true);
  });
  it.each(['red', 'missing', 'unreadable'])('%s cannot turn green without complete retry evidence', async mode => {
    const f = fixture(mode === 'red' ? [mode] : [mode, mode]);
    expect(await f.run()).toBe(mode === 'red' ? 1 : 75);
    expect(f.lines.join('')).not.toContain('GREEN');
    if (mode !== 'red') {
      expect(f.lines.join('')).toContain('UNSETTLED');
      expect(f.lines.join('')).not.toContain('RED');
      expect(f.calls).toHaveLength(4);
    }
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
  it.each(['pass', 'red'])('remote red is confirmed locally once and stays red: %s', async local => {
    const f = fixture(['remote-red', local]); expect(await f.run()).toBe(1);
    expect(f.calls).toHaveLength(4); expect(f.calls[1].command).toBe('npx');
    expect(f.calls[1].env.WE_HEAVY_ADMISSION_HELD).toBe('1'); expect(f.releases()).toBe(1);
  });
});

describe('one split retry for incomplete inventory', () => {
  async function run(modes, files = ['a', 'b', 'c', 'd'], shards = 1) {
    let clock = 0;
    const calls = [], lines = [];
    const reports = new Map();
    const code = await runShards({ argv: ['npx', 'vitest', 'run', ...files, '--pool', 'forks'], shards, parallel: 1, budgetMs: 10000 }, {
      discover: () => null, env: {}, now: () => clock, log: s => lines.push(s), tmpdir: () => '/scratch',
      fs: { mkdtempSync: () => '/scratch/shards', rmSync: () => {}, readFileSync: p => { if (!reports.has(p)) throw Error('missing'); return reports.get(p); } },
      acquireLocal: async () => ({ ok: true }), releaseLocal: () => {},
      execute: async options => {
        calls.push(options);
        const mode = modes[calls.length - 1];
        if (['remote-incomplete', 'remote-fail'].includes(mode)) reports.set(options.remoteReport, JSON.stringify({ location: 'remote', exitCode: 1 }) + '\n');
        if (mode === 'timeout') return { exitCode: 124, timedOut: true };
        if (mode === 'exit-failure') {
          options.log(`${options.prefix}runner failed before writing inventory\n`);
          return { exitCode: 2, reportText: null };
        }
        if (mode === 'fail') options.log(`${options.prefix}retry assertion failed: expected true, received false\n`);
        if (mode === 'exhausted') { clock = 10000; return { exitCode: 0, reportText: JSON.stringify({ testResults: [] }) }; }
        if (mode === 'killed') return { exitCode: 137 };
        if (mode === 'signal') return { exitCode: null, signal: 'SIGKILL' };
        if (typeof mode === 'object') return Object.hasOwn(mode, 'exitCode') ? mode : { exitCode: 1, reportText: JSON.stringify(mode) };
        if (mode === 'malformed') return { exitCode: 1, reportText: '{invalid JSON' };
        const reportText = mode === 'oversized' ? streamedInventory('x'.repeat(SHARD_REPORT_MAX_BYTES + 1))
          : JSON.stringify({ testResults: (['missing', 'remote-incomplete'].includes(mode) ? [] : options.files).map(name => ({ name,
            status: ['fail', 'remote-fail'].includes(mode) ? 'failed' : 'passed', assertionResults: [{ status: mode === 'fail' ? 'failed' : 'passed' }] })) });
        return { exitCode: ['fail', 'remote-incomplete', 'remote-fail'].includes(mode) ? 1 : 0, reportText };
      },
    });
    return { code, calls, output: lines.join('') };
  }
  it('incomplete shard retries in halves with independent argv and report paths, all-pass stays UNSETTLED with exit 75', async () => {
    const f = await run(['missing', 'pass', 'pass']);
    expect(f.code).toBe(SHARD_UNSETTLED_EXIT);
    expect(f.output).toContain('verify-shard 1/1: UNSETTLED (4 files,');
    expect(f.output).toContain('verify-shards: UNSETTLED (1:UNSETTLED;');
    expect(f.output).not.toContain('GREEN');
    expect(f.output.match(/verify-shard 1\/1: UNSETTLED /g)).toHaveLength(1);
    expect(f.calls.map(c => c.files)).toEqual([['a', 'b', 'c', 'd'], ['a', 'b'], ['c', 'd']]);
    expect(new Set(f.calls.map(c => c.report)).size).toBe(3);
    expect(new Set(f.calls.map(c => c.remoteReport)).size).toBe(3);
    for (const c of f.calls) expect(c.args.slice(3)).toEqual(['npx', 'vitest', 'run', ...c.files, '--pool', 'forks', '--reporter=json']);
  });
  const observedFailures = [
    ['failed suite', { testResults: [{ name: 'a', status: 'failed', assertionResults: [{ status: 'passed' }] }] }],
    ['failed assertion', { testResults: [{ name: 'a', status: 'passed', assertionResults: [{ status: 'failed' }] }] }],
    ['failed summary', { success: false, numFailedTests: 1, testResults: [] }],
    ['runtime error with unsuccessful report', { success: false, numRuntimeErrors: 1, testResults: [] }],
    ['unsuccessful report without failed test counts', { success: false, numFailedTests: 0, testResults: [] }],
    ['runtime error count alone', { numRuntimeErrors: 1, testResults: [] }],
    ['failed suite count alone', { numFailedTestSuites: 1, testResults: [] }],
    ['failed test count alone', { numFailedTests: 1, testResults: [] }],
  ];
  it.each(observedFailures)('%s in complete inventory stays RED even with exit 0', async (_label, report) => {
    const reportText = JSON.stringify({ ...report, testResults: ['a', 'b', 'c', 'd'].map(name =>
      report.testResults.find(r => r.name === name)
        ?? { name, status: 'passed', assertionResults: [{ status: 'passed' }] }) });
    const f = await run([{ exitCode: 0, reportText }]);
    expect(f.code).toBe(1);
    expect(f.output).toContain('verify-shards: RED (1:FAIL;');
    expect(f.calls).toHaveLength(1);
  });
  it.each(observedFailures)('%s with missing files stays RED after passing retries', async (_label, report) => {
    const f = await run([report, 'pass', 'pass']);
    expect(f.code).toBe(1); expect(f.output).toContain('verify-shards: RED');
    expect(f.output).toContain('verify-shard 1/1: FAIL');
    expect(f.output).not.toContain('GREEN'); expect(f.calls).toHaveLength(3);
  });
  it.each(observedFailures)('%s with missing files stays RED after incomplete retries', async (_label, report) => {
    const f = await run([report, 'missing', 'pass']);
    expect(f.code).toBe(1); expect(f.output).toContain('verify-shards: RED');
    expect(f.output).not.toContain('verify-shards: UNSETTLED'); expect(f.calls).toHaveLength(3);
  });
  it.each([
    ['passing partial report', { success: true, testResults: [{ name: 'a', status: 'passed', assertionResults: [{ status: 'passed' }] }] }],
    ['unparseable report', 'malformed'],
  ])('%s with exit 1 stays FAIL after passing retries', async (_label, report) => {
    const f = await run([report, 'pass', 'pass']);
    expect(f.code).toBe(1); expect(f.output).toContain('verify-shards: RED (1:FAIL;');
    expect(f.output).not.toContain('GREEN');
    expect(f.calls).toHaveLength(3);
  });
  it('exit 75 with no report stays UNSETTLED after passing retries', async () => {
    const f = await run([{ exitCode: 75, reportText: null }, 'pass', 'pass']);
    expect(f.code).toBe(75); expect(f.output).toContain('verify-shards: UNSETTLED');
    expect(f.output).not.toContain('GREEN');
    expect(f.calls).toHaveLength(3);
  });
  it.each([null, '{invalid JSON', 'x'.repeat(SHARD_REPORT_MAX_BYTES + 1)].map((reportText, i) => [
    ['missing', 'malformed', 'oversized'][i], reportText,
  ]))('exit 1 with %s report stays FAIL after passing retries', async (_label, reportText) => {
    const f = await run([{ exitCode: 1, reportText }, 'pass', 'pass']);
    expect(f.code).toBe(1); expect(f.output).toContain('verify-shards: RED (1:FAIL;');
    expect(f.output).not.toContain('GREEN'); expect(f.calls).toHaveLength(3);
  });
  it('incomplete shard with a failing retry half is FAIL with exit 1 and preserves failure output', async () => {
    const f = await run([{ exitCode: 1, reportText: null }, 'pass', 'fail']);
    expect(f.code).toBe(1); expect(f.output).toContain('verify-shard 1/1: FAIL');
    expect(f.output).toContain('[verify-shard 1/1] retry assertion failed: expected true, received false');
    expect(f.output).toContain('verify-shards: RED (1:FAIL;');
    expect(f.output.match(/verify-shard 1\/1: FAIL /g)).toHaveLength(1);
  });
  it.each(['pending', 'skipped', 'todo', 'disabled', undefined])(
    'retry half with one passed and one %s assertion stays UNSETTLED', async status => {
      const retry = { exitCode: 0, reportText: JSON.stringify({ testResults: ['a', 'b'].map(name => ({
        name, status: 'passed', assertionResults: [{ status: 'passed' }, { status }],
      })) }) };
      const f = await run(['missing', retry, 'pass']);
      expect(f.code).toBe(SHARD_UNSETTLED_EXIT);
      expect(f.output).toContain('verify-shards: UNSETTLED');
      expect(f.output).not.toContain('GREEN'); expect(f.calls).toHaveLength(3);
    });
  it('passing retry with pending assertions in an extra file stays UNSETTLED', async () => {
    const retry = { exitCode: 0, reportText: JSON.stringify({ testResults: ['c', 'd', 'extra'].map(name => ({
      name, status: 'passed', assertionResults: [{ status: 'passed' }, { status: name === 'extra' ? 'pending' : 'passed' }],
    })) }) };
    const f = await run(['missing', 'pass', retry]);
    expect(f.code).toBe(SHARD_UNSETTLED_EXIT);
    expect(f.output).toContain('verify-shards: UNSETTLED');
    expect(f.output).not.toContain('GREEN'); expect(f.calls).toHaveLength(3);
  });
  it('first-attempt inventory still allows passed assertions alongside pending assertions', async () => {
    const reportText = JSON.stringify({ testResults: [{ name: 'a', status: 'passed',
      assertionResults: [{ status: 'passed' }, { status: 'pending' }] }] });
    expect(inventoryVerdict(reportText, ['a'])).toBe('PASS');
    const f = await run([{ exitCode: 0, reportText }], ['a']);
    expect(f.code).toBe(0); expect(f.calls).toHaveLength(1);
  });
  it('a failed assertion in an incomplete retry makes the shard RED', async () => {
    const f = await run(['missing', observedFailures[1][1], 'pass']);
    expect(f.code).toBe(1); expect(f.output).toContain('verify-shards: RED');
    expect(f.calls).toHaveLength(3);
  });
  it.each(['missing', 'oversized'])('%s half stays UNSETTLED, never PASS; split depth and execute count are bounded', async mode => {
    const f = await run(['missing', mode, 'pass']);
    expect(SHARD_UNSETTLED_EXIT).toBe(75); expect(f.code).toBe(75);
    expect(f.output).toContain('verify-shards: UNSETTLED (');
    expect(f.output).not.toMatch(/RED|GREEN/); expect(f.calls).toHaveLength(3);
  });
  it.each([['fail', 'missing', 1], ['missing', 'fail', 1], ['timeout', 'missing', 124], ['missing', 'timeout', 124]])('real %s / %s half takes precedence over incomplete inventory', async (left, right, code) => {
    const f = await run(['missing', left, right]);
    expect(f.code).toBe(code); expect(f.output).toContain(`verify-shards: RED (1:${code === 124 ? 'TIMEOUT' : 'FAIL'};`);
    expect(f.calls).toHaveLength(['fail', 'timeout'].includes(left) ? 2 : 3);
  });
  it.each(['missing', 'exit-failure'])('retry timeout preserves TIMEOUT and stops later shards after %s evidence', async initial => {
    const f = await run([initial, 'timeout', 'pass'], ['a', 'b', 'c', 'd', 'e', 'f'], 2);
    expect(f.code).toBe(124);
    expect(f.output).toContain('verify-shards: RED (1:TIMEOUT, 2:NOT-RUN;');
    expect(f.calls.map(c => c.files)).toEqual([['a', 'b', 'c'], ['a', 'b']]);
  });
  it('budget exhaustion after failure evidence preserves retry NOT-RUN', async () => {
    const f = await run(['exit-failure', 'exhausted', 'pass']);
    expect(f.code).toBe(124);
    expect(f.output).toContain('verify-shards: RED (1:NOT-RUN;');
    expect(f.calls).toHaveLength(2);
  });
  it.each([
    ['initial', ['exit-failure', 'pass', 'pass']],
    ['retry', ['missing', 'exit-failure', 'pass']],
    ['initial with incomplete retry', ['exit-failure', 'missing', 'pass']],
  ])('%s nonzero exit without inventory stays FAIL and preserves failure details', async (_label, modes) => {
    const f = await run(modes);
    expect(f.code).toBe(1);
    expect(f.output).toContain('verify-shards: RED (1:FAIL;');
    expect(f.output).toContain('[verify-shard 1/1] runner failed before writing inventory');
    expect(f.output).not.toContain('GREEN');
    expect(f.calls).toHaveLength(3);
  });
  it('retry exit 75 without inventory remains unsettled-eligible', async () => {
    const f = await run(['missing', { exitCode: SHARD_UNSETTLED_EXIT, reportText: null }, 'pass']);
    expect(f.code).toBe(SHARD_UNSETTLED_EXIT);
    expect(f.output).toContain('verify-shards: UNSETTLED (1:UNSETTLED;');
    expect(f.calls).toHaveLength(3);
  });
  it.each(['killed', 'signal'])('first split half %s halts before the second half and preserves infrastructure exit', async mode => {
    const f = await run(['missing', mode, 'pass']);
    expect(f.code).toBe(137); expect(f.output).toContain('verify-shards: RED');
    expect(f.calls.map(c => c.files)).toEqual([['a', 'b', 'c', 'd'], ['a', 'b']]);
  });
  it('NOT-RUN after budget exhaustion launches neither split half', async () => {
    const f = await run(['exhausted', 'pass', 'pass']);
    expect(f.code).toBe(124); expect(f.output).toContain('verify-shard 1/1: NOT-RUN');
    expect(f.calls).toHaveLength(1);
  });
  it('both incomplete halves remain unsettled without another split', async () => {
    const f = await run(['missing', 'missing', 'missing']);
    expect(f.code).toBe(75); expect(f.calls).toHaveLength(3);
  });
  it('single-file incomplete shard retries once whole then is unsettled', async () => {
    const f = await run(['missing', 'missing'], ['a']);
    expect(f.code).toBe(75); expect(f.calls.map(c => c.files)).toEqual([['a'], ['a']]);
    expect(new Set(f.calls.map(c => c.report)).size).toBe(2);
  });
  it('remote incomplete nonzero exit cannot become GREEN after passing local confirmation', async () => {
    const f = await run(['remote-incomplete', 'pass']);
    expect(f.code).toBe(1);
    expect(f.output).toContain('remote red; confirming locally');
    expect(f.output).toContain('verify-shards: RED (1:FAIL;');
    expect(f.output).not.toContain('GREEN');
    expect(f.calls.map(c => c.command)).toEqual(['node', 'npx']);
    expect(f.calls.map(c => c.files)).toEqual([['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']]);
  });
  it('confirms remote incomplete evidence locally but preserves its failure exit after the split retry', async () => {
    const f = await run(['remote-incomplete', 'missing', 'pass', 'pass']);
    expect(f.code).toBe(1); expect(f.output).toContain('verify-shards: RED (1:FAIL;');
    expect(f.output).not.toContain('GREEN'); expect(f.calls).toHaveLength(4);
    expect(f.calls.map(c => c.command)).toEqual(['node', 'npx', 'node', 'node']);
    expect(f.calls.map(c => c.files.length)).toEqual([4, 4, 2, 2]);
  });
  it('complete remote failure then incomplete local confirmation and passing split retries stays FAIL with exit 1', async () => {
    const f = await run(['remote-fail', 'missing', 'pass', 'pass']);
    expect(f.code).toBe(1);
    expect(f.output).toContain('remote red; confirming locally');
    expect(f.output).toContain('verify-shards: RED (1:FAIL;');
    expect(f.output).not.toContain('UNSETTLED');
    expect(f.output).not.toContain('GREEN');
    expect(f.calls.map(c => c.command)).toEqual(['node', 'npx', 'node', 'node']);
    expect(f.calls.map(c => c.files.length)).toEqual([4, 4, 2, 2]);
  });
});

describe('process boundary and bounds', () => {
  it('kills the whole child tree at the deadline and prefixes both output streams', async () => {
    const child = new EventEmitter(); child.pid = 123;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let fire, watched, cleared = false; const lines = [];
    const pending = executeShard({ command: 'node', args: [], timeoutMs: 19, prefix: '[shard] ', log: l => lines.push(l) }, {
      spawn: (_command, _args, options) => { expect(options.detached).toBe(false); return child; },
      startWatchdog: options => { watched = options; fire = options.onFire; return {
        fired: () => false, settled: async () => {}, stop: async () => { cleared = true; },
      }; },
    });
    child.stdout.emit('data', 'failure details\n'); child.stderr.emit('data', 'stderr details\n'); fire();
    expect(await pending).toEqual({ exitCode: 124, timedOut: true });
    expect(watched).toMatchObject({ pid: 123, timeoutMs: 19, kill: { marker: expect.stringMatching(/^WE_VERIFY_SHARD_RUN=/) } });
    expect(watched.kill.orphansOfOwnGroup).toBeUndefined(); expect(cleared).toBe(true);
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

describe('review regressions: Forge and supervisor wiring', () => {
  it('sends the generated command through the real Forge allowlist and client', async () => {
    const f = fixture();
    await f.run();
    const requested = f.calls[0].args.slice(3);
    // Mirror admission's existing bare-vitest -> npm reconstruction.
    const remoteArgv = requested[0] === 'vitest'
      ? ['npm', 'run', 'test:unit', '--', ...requested.slice(2)] : requested;
    expect(allowedCommand(remoteArgv)).toBe(true);
    let transportCalls = 0;
    const result = await runRemote({ argv: remoteArgv, exec: async () => {
      transportCalls++; throw Error('offline probe: no transport');
    } });
    expect(result.reason).not.toBe('command-not-allowed');
    expect(transportCalls).toBeGreaterThan(0);
    expect(remoteArgv).toContain('--reporter=json');
    expect(remoteArgv.some(a => a.startsWith('--outputFile'))).toBe(false);
  });

  it('retrieves a JSON inventory streamed alongside install logs, across chunk boundaries', async () => {
    const reportText = JSON.stringify({ testResults: [{ name: 'a', status: 'passed', assertionResults: [{ status: 'passed' }] }] });
    const result = await executeShard({ command: process.execPath,
      args: ['-e', `process.stdout.write('install log\\n'); const report=${JSON.stringify(reportText)}; process.stdout.write(report.slice(0, 20)); setTimeout(() => process.stdout.write(report.slice(20)+'\\n'), 5);`],
      report: '/unused', timeoutMs: 5000, prefix: '', log: () => {} });
    expect(result.exitCode).toBe(0);
    expect(result.reportText).toBe(reportText);
  });

  it.each(['SIGTERM', 'SIGKILL'])('a real supervisor group %s reaches silent shards and descendants', async signal => {
    const directory = mkdtempSync(resolve(tmpdir(), 'shard-cancel-'));
    const pidFile = resolve(directory, 'pids');
    const moduleUrl = pathToFileURL(resolve('scripts/lib/verify-shard-run.mjs')).href;
    // Anchor both sleepers to the test runner, so losing their parent cannot
    // satisfy the signal assertion. The lifetime bound still cleans up a crash.
    const sleeper = keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 30_000 });
    const childCode = keepAliveScript({ anchorPid: process.pid, maxLifetimeMs: 30_000,
      prelude: `const {spawn}=require('node:child_process'); const grandchild=spawn(process.execPath,['-e',${JSON.stringify(sleeper)}],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid,grandchild.pid]));`,
    });
    const wrapper = spawn(process.execPath, ['--input-type=module', '-e',
      `import {executeShard} from ${JSON.stringify(moduleUrl)}; await executeShard({command:process.execPath,args:['-e',${JSON.stringify(childCode)}],timeoutMs:10000,prefix:'',log:()=>{}});`],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; wrapper.stderr.on('data', chunk => { errors += chunk; });
    let pids = [];
    const waitFor = async predicate => { const end = Date.now() + 5000; while (Date.now() < end) { if (predicate()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
    try {
      expect(await waitFor(() => { try { pids = JSON.parse(readFileSync(pidFile, 'utf8')); return true; } catch { return false; } }), errors).toBe(true);
      expect(pids).toHaveLength(2);
      expect(pids.map(pid => pidIdentity(pid).alive)).toEqual([true, true]);
      process.kill(-wrapper.pid, signal);
      // Linux may retain a killed orphan as a zombie until its subreaper exits.
      // Require positive death evidence; an unreadable identity is never enough.
      expect(await waitFor(() => pids.every(pid => pidIdentity(pid).alive === false))).toBe(true);
    } finally {
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      try { process.kill(-wrapper.pid, 'SIGKILL'); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

  it('fails closed for ambiguous, absent, malformed and oversized stdout inventories', () => {
    const report = JSON.stringify({ testResults: [] });
    for (const text of ['', '{broken', `${report}\n${report}`, 'x'.repeat(SHARD_REPORT_MAX_BYTES + 1)])
      expect(streamedInventory(text)).toBeNull();
  });

  it.each(['', 'slot-2/'])('rebases only the completed Forge run inventory (%s)', slot => {
    const receiptId = `r-${'a'.repeat(32)}`;
    const report = JSON.stringify({ testResults: [{ name: `/srv/forge-exec/${slot}${receiptId}/work/a.test.mjs`,
      status: 'passed', assertionResults: [{ status: 'passed' }] }] });
    expect(inventoryVerdict(report, ['a.test.mjs'], '/repo', { receiptId })).toBe('PASS');
    expect(inventoryVerdict(report, ['a.test.mjs'], '/repo')).toBe('INVENTORY-INCOMPLETE');
    expect(inventoryVerdict(report, ['a.test.mjs'], '/repo', { receiptId: `r-${'b'.repeat(32)}` })).toBe('INVENTORY-INCOMPLETE');
  });

  it.each(['remote', 'local-fallback'])('retrieves the streamed inventory end to end for %s', location => {
    const receiptId = `r-${'c'.repeat(32)}`;
    return runShards({ argv: ['npx', 'vitest', 'run', 'a.test.mjs'], shards: 1, parallel: 1, budgetMs: 10000 }, {
      fs, discover: () => null, log: () => {},
      execute: async options => {
        const name = location === 'remote' ? `/srv/forge-exec/slot-2/${receiptId}/work/a.test.mjs` : resolve('a.test.mjs');
        const text = JSON.stringify({ testResults: [{ name, status: 'passed', assertionResults: [{ status: 'passed' }] }] });
        fs.writeFileSync(options.remoteReport, JSON.stringify({ location, receiptId, exitCode: 0 }) + '\n');
        return executeShard({ ...options, command: process.execPath,
          args: ['-e', `console.log('install output'); console.log(${JSON.stringify(text)});`] });
      },
    }).then(code => expect(code).toBe(0));
  });

  it('keeps the timeout active when the wrapper event loop is blocked', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'shard-watchdog-'));
    const pidFile = resolve(directory, 'pid');
    const heartbeatFile = resolve(directory, 'heartbeat');
    const moduleUrl = pathToFileURL(resolve('scripts/lib/verify-shard-run.mjs')).href;
    const childCode = `const fs=require('node:fs');let tick=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeatFile)},String(++tick)),20);`;
    const wrapper = spawn(process.execPath, ['--input-type=module', '-e',
      `import {executeShard} from ${JSON.stringify(moduleUrl)};
       import {writeFileSync} from 'node:fs';
       executeShard({command:process.execPath,args:['-e',${JSON.stringify(childCode)}],timeoutMs:1500,prefix:'',log:()=>{}}, {
         spawn:(...args)=>{const child=spawn(...args);writeFileSync(${JSON.stringify(pidFile)},String(child.pid));return child;}
       });
       import {spawn} from 'node:child_process';
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);`],
    { detached: true, stdio: 'ignore' });
    let pid;
    try {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        try { pid = Number(readFileSync(pidFile, 'utf8')); } catch {}
        if (fs.existsSync(heartbeatFile)) break;
        await new Promise(r => setTimeout(r, 20));
      }
      expect(pid).toBeGreaterThan(0);
      expect(fs.existsSync(heartbeatFile)).toBe(true);
      await new Promise(r => setTimeout(r, 2000));
      const stoppedAt = readFileSync(heartbeatFile, 'utf8');
      await new Promise(r => setTimeout(r, 300));
      expect(readFileSync(heartbeatFile, 'utf8')).toBe(stoppedAt);
      // The blocked wrapper cannot reap its killed child yet (kill(pid, 0)
      // would also succeed for a zombie). Its independent heartbeat has stopped.
      expect(() => process.kill(wrapper.pid, 0)).not.toThrow();
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      try { process.kill(-wrapper.pid, 'SIGKILL'); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
});
