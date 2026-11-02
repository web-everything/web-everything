/**
 * @file Hermetic prototype admission proofs.
 * WHY (incident 2026-10-22): pin main preservation, ready evidence, adopt-before-remove, stale
 * replacement, and adoption refusal with injected doubles, plus real Git adoption probes.
 */
import { describe, it, expect, vi } from 'vitest';
import nodeFs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { withBareOrigin } from './helpers/real-repo.mjs';
import { createPrototypeLoader, defaultDeps } from '../prototype-load-io.mjs';
import { changedPaths, comparePaths, nextMergeRef, prototypeLoadOperation, PROTOTYPE_LOAD_EFFECT } from '../prototype-load.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun, advance } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
import { overlaySafetySettings } from '../../lib/daemon-load-overlay.mjs';
import { checkPendingAdoptions, readPendingAdoptions, recordPendingAdoption } from '../../lib/overlay-adoption.mjs';
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40), MERGE = 'c'.repeat(40);
const BASE = { branch: 'lane/new', sha: SHA, daemon: 'control', waitAdoptionMs: 30 };
const settings = {
  daemons: { control: { label: 'com.we.control', clone: 'wev-control' }, review: { label: 'com.we.review-daemon' }, drain: { label: 'com.plateau.drain-daemon', clone: '.lanes/we-drain-daemon/code' } },
  workspaceRoot: '~/workspace', launchAgentsDir: '~/Library/LaunchAgents', recordPath: '~/records', readyRecordPath: '~/ready',
  loaderCli: 'scripts/daemon-overlay.mjs', adoption: { timeoutMs: 30, pollMs: 10 },
};
function fixture(options = {}) {
  const candidateSha = options.sha || SHA;
  const calls = [], records = [], sleeps = [], reads = [], cloneRoots = [];
  let clock = 0;
  let remoteTip = candidateSha;
  let tipReads = 0;
  let establishedAdvanced = false;
  const lateChanges = [];
  const registrations = new Map((options.list || []).map(ref => [ref, { ref }]));
  const establishedTips = new Map((options.list || []).filter(ref => ref !== BASE.branch)
    .map((ref, i) => [ref, 'd'.repeat(39) + i.toString(16)]));
  const establishedFetches = new Map();
  const admitted = [];
  const env = { HOME: '/home/test', USER: 'tester', PATH: '/bin', GH_TOKEN: 'secret', NODE_OPTIONS: 'unsafe', WE_ALLOW_NO_PR: '1', ...options.env };
  const ready = { ref: BASE.branch, sha: candidateSha, tests: 'green', audit: 'NOT WEAKENED' };
  const fs = {
    readFileSync(p) {
      reads.push(p);
      if (options.readError && p === '/home/test/ready') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      if (p === '/home/test/ready') return options.ready ?? `bad line\n${JSON.stringify(ready)}\n`;
      if (options.alertsReadError && p.endsWith('.alerts.jsonl')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      if (p.endsWith('.alerts.jsonl')) return options.alerts || '';
      if (p.endsWith('.events.jsonl')) return options.events || '';
      if (p.endsWith('.drop-pending') && options.pendingDrops) return options.pendingDrops;
      if (p.endsWith('.rebuild.json')) {
        if (options.rebuildStateReadError) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        if (options.rebuildStateRaw !== undefined) return options.rebuildStateRaw;
        if (options.rebuildState !== undefined) return JSON.stringify(options.rebuildState);
      }
      const e = new Error('missing'); e.code = 'ENOENT'; throw e;
    },
    mkdirSync() {}, appendFileSync(p, line) { records.push({ path: p, ...JSON.parse(line) }); },
  };
  const fail = (status, stdout = '', stderr = 'failed') => { throw Object.assign(new Error(stderr), { status, stdout, stderr }); };
  const exec = (cmd, args, config) => {
    calls.push({ cmd, args, config });
    if (options.combinedIO?.handles(cmd, args)) return options.combinedIO.exec(cmd, args, config);
    expect(args.join(' ')).not.toMatch(/--allow-conflict|--force|--allow-no-pr/);
    expect(Object.keys(config.env).sort()).toEqual(['HOME', 'PATH', 'USER', ...Object.keys(options.gitEnv || {}), ...(env.WE_DAEMON_OVERLAY_DIR ? ['WE_DAEMON_OVERLAY_DIR'] : []), ...(env.WE_OVERLAY_NO_PR?.trim() === 'refuse' ? ['WE_OVERLAY_NO_PR'] : [])].sort());
    if (options.gitEnv) expect(config.env).toMatchObject(options.gitEnv);
    if (options.execFailure === args[0]) throw Object.assign(new Error('maxBuffer exceeded; inspect full output separately'), { code: 'ENOBUFS' });
    if (cmd === 'plutil') return JSON.stringify({ WorkingDirectory: '/home/test/workspace/review' });
    if (cmd === 'node') {
      const action = args[1], ref = args.find((a) => a.startsWith('--ref='))?.slice(6);
      if (action === 'list') return options.listRaw ?? JSON.stringify({ list: [...registrations.values()] });
      if (action === 'recover-drops') return options.recoverRaw ?? JSON.stringify({ settled: [{ ref: 'lane/x', outcome: 'restored' }], pending: [] });
      if (action === 'retire') {
        if (options.retireRefuses === ref) return fail(3, JSON.stringify({ retired: false, refused: 'tip-moved' }));
        registrations.delete(ref);
        return JSON.stringify({ retired: true, refused: null });
      }
      if (action === 'replace') {
        const old = args.find((a) => a.startsWith('--replaces='))?.slice(11);
        const contained = (options.contained || []).includes(old);
        const check = { ok: true, clean: true, candSha: remoteTip };
        if (args.includes('--check')) {
          return contained ? JSON.stringify({ check, containment: { ok: true, contained: true }, wouldReplace: true, refused: null })
            : fail(3, JSON.stringify({ check: null, containment: { ok: true, contained: false }, wouldReplace: false, refused: 'not-contained' }));
        }
        admitted.push({ ref, replaces: old });
        registrations.delete(old);
        registrations.set(ref, { ref });
        return JSON.stringify({ replaced: true, registered: true, conflictCheck: check, list: [...registrations.values()] });
      }
      if (action === 'add' && overlaySafetySettings(config.env, { readSettings: () => options.safetySettings || {} }).noPr === 'refuse') {
        return fail(3, JSON.stringify({ check: { ok: false, reason: 'no-pr' }, wouldRegister: false }));
      }
      if (args.includes('--check')) {
        if (options.checkRaw) return options.checkRaw;
        if (options.unverifiable === ref) return fail(1, JSON.stringify({ check: { ok: false, reason: 'ref-unresolved' } }), 'WARNING overlay NO PR');
        if (options.checkBeforeFetch === ref && !establishedFetches.has(ref)) return fail(1, JSON.stringify({ check: { ok: false, reason: 'ref-unresolved' } }));
        const clean = !(options.conflicts || []).includes(ref);
        const data = JSON.stringify({ check: { ok: true, clean, candSha: remoteTip, ...(clean ? {} : { files: options.checkFiles?.[ref] ?? ['x'], conflicting: [{ ref: 'lane/other' }] }) }, wouldRegister: clean });
        if (options.advanceAfterCheck && ref === (options.behind ? 'lane/new-m1' : BASE.branch)) remoteTip = TREE;
        if (options.noPrWarning === ref) return fail(1, data, 'WARNING overlay NO PR');
        if (options.checkExit?.ref === ref && options.checkExit.code !== 0) {
          if (options.checkExit.message) throw Object.assign(new Error(options.checkExit.message), {
            status: options.checkExit.code, stdout: data, stderr: options.checkExit.stderr,
          });
          return fail(options.checkExit.code, data, options.checkExit.stderr);
        }
        return clean ? data : fail(3, data);
      }
      if (action === 'add' && options.addFails) return fail(1);
      if (action === 'add') {
        if (options.advanceDuringAdd) remoteTip = TREE;
        const expected = args.find((a) => a.startsWith('--expected-sha='))?.slice(15);
        if (expected && expected !== remoteTip) return fail(3, JSON.stringify({ conflictCheck: { ok: false, reason: 'sha-moved', candSha: remoteTip } }));
        admitted.push({ ref });
        if (options.advanceEstablishedDuringAdd) establishedAdvanced = true;
        return options.addRaw ?? JSON.stringify({ conflictCheck: { ok: true, clean: true, candSha: remoteTip } });
      }
      if (action === 'remove' && options.removeFails === ref) return fail(1);
      if (action === 'remove') registrations.delete(ref);
      return '{}';
    }
    if (args[0] === '-C') {
      if (options.adoptionExec) return options.adoptionExec(args, config);
      if (args[2] === 'rev-parse') {
        if (args.at(-1) === 'HEAD^{commit}') return options.badHead ? fail(1) : SHA;
        return options.missingCandidate ? fail(1, '', '') : SHA;
      }
      expect(args.slice(2)).toEqual(['merge-base', '--is-ancestor', options.behind ? MERGE : candidateSha, 'HEAD']);
      if (options.missingCandidate && (options.missingForever || sleeps.length === 0)) return fail(128, '', 'Not a valid commit name');
      if (options.adoptionError) return fail(options.adoptionError);
      return options.timeout ? fail(1) : '';
    }
    if (args[0] === 'fetch') {
      const ref = args[2]?.replace(/^\+refs\/heads\//, '').split(':')[0];
      if (options.staleFetchFails === ref) return fail(1);
      if (ref === BASE.branch && tipReads > 0 && options.advanceEstablishedBeforeSwap) establishedAdvanced = true;
      if (establishedTips.has(ref)) {
        const count = (establishedFetches.get(ref) || 0) + 1;
        establishedFetches.set(ref, count);
        if (count > 1 && options.refreshError === 'fetch') return fail(1);
      }
      return '';
    }
    if (args[0] === 'rev-parse') {
      const ref = args.at(-1).replace(/^refs\/remotes\/origin\//, '').replace(/\^\{commit\}$/, '');
      if (establishedTips.has(ref)) {
        if (options.refreshError === 'tip') return fail(1);
        if (options.refreshError === 'invalid-tip') return '';
        return establishedAdvanced && ref === 'lane/old' ? TREE : establishedTips.get(ref);
      }
      tipReads++;
      if (options.tipReadFails && tipReads > 1) return fail(1);
      return options.tip || remoteTip;
    }
    if (args[0] === 'diff') {
      if (args[1] === '--name-only') {
        expect(args).toEqual(['diff', '--name-only', '--no-renames', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv',
          '-z', 'origin/main...origin/lane/old']);
        return options.landedPathsError ? fail(128) : options.landedPaths ?? 'x\0';
      }
      const ref = args.at(-1).startsWith('origin/main...origin/') ? args.at(-1).slice('origin/main...origin/'.length) : null;
      if (registrations.has(ref)) {
        expect(args.slice(1, 4)).toEqual(['--name-status', '-z', `origin/main...origin/${ref}`]);
        if (options.staleDiffFails === ref) return fail(1);
        if (options.staleChanged?.[ref] !== undefined) return options.staleChanged[ref];
      }
      return args.at(-1).startsWith('origin/main...') ? 'M\0x\0' : options.diff ?? 'M\0x\0';
    }
    if (args[0] === 'cherry') {
      expect(args.slice(1, 2)).toEqual(['origin/main']);
      const ref = args[2]?.replace(/^origin\//, '');
      expect(registrations.has(ref)).toBe(true);
      return options.cherry?.[ref] ?? `+ ${SHA}\n`;
    }
    if (args[0] === 'merge-base') {
      if (args[2] === 'origin/main') return options.behind ? fail(1) : '';
      if (args[2] === TREE) return options.advancedContained ? '' : fail(1);
      if ([...establishedTips.values()].includes(args[2])) {
        if (options.refreshError === 'ancestry') return fail(128);
        if (options.advanceEstablishedAfterContainment) establishedAdvanced = true;
        // The immutable SHA still passes while the registered branch/entry changes underneath it.
        if (options.changeAfterContainment) {
          establishedAdvanced = true;
          if (options.changeAfterContainment === 'registration replaced') {
            registrations.set('lane/old', { ref: 'lane/old', addedAt: 'new identity', reason: 'concurrent writer' });
          }
          lateChanges.push(options.changeAfterContainment);
        }
        return '';
      }
      return (options.contained || []).includes(args[2].slice(7)) ? '' : fail(1);
    }
    if (args[0] === '--literal-pathspecs') {
      expect(args.slice(1, 7)).toEqual(['diff', '--quiet', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none']);
      expect(['origin/main', candidateSha].includes(args[7])).toBe(true);
      expect(args.slice(8, 10)).toEqual(['origin/lane/old', '--']);
      const proof = options.landedProof?.[args[7]];
      if (proof && typeof proof === 'object') return fail(proof.code, proof.stdout || '');
      return proof ?? '';
    }
    if (args[0] === 'merge-tree') return options.mergeConflict ? fail(1, `${TREE}\n100644 ${SHA} 1\tx\nCONFLICT (content): Merge conflict in x\n`) : TREE;
    if (args[0] === 'ls-remote') {
      if (args[1] === '--exit-code') {
        expect(args).toEqual(['ls-remote', '--exit-code', 'origin', `refs/heads/${options.staleFetchFails}`]);
        if (options.staleRemoteCode) return fail(options.staleRemoteCode);
      }
      return options.remote || '';
    }
    if (args[0] === 'commit-tree') return MERGE;
    if (args[0] === 'push') { remoteTip = MERGE; return ''; }
    throw new Error(`unexpected command ${cmd} ${args}`);
  };
  const combinedTest = vi.fn(async (input) => typeof options.combinedTest === 'function'
    ? options.combinedTest(input)
    : options.combinedTest ?? { ok: false, command: 'fixture-related-tests', result: 'failed', reason: 'tests-failed' });
  if (options.combinedIO) Object.assign(fs, options.combinedIO.fs);
  if (options.pendingFs) {
    const readFixture = fs.readFileSync;
    const mkdirFixture = fs.mkdirSync;
    for (const method of ['writeFileSync', 'renameSync', 'rmSync', 'rmdirSync', 'statSync']) fs[method] = options.pendingFs[method];
    fs.readFileSync = (p, ...args) => String(p).endsWith('.pending')
      ? options.pendingFs.readFileSync(p, ...args) : readFixture(p, ...args);
    fs.mkdirSync = (p, ...args) => String(p).includes('/adoption-pending')
      ? options.pendingFs.mkdirSync(p, ...args) : mkdirFixture(p, ...args);
  }
  // Retirement has its own real-git suite (prototype-retire.test.mjs); here it is injected like combinedTest.
  const retirePlanner = vi.fn((input) => options.retirePlan ? options.retirePlan(input) : []);
  const load = createPrototypeLoader({ exec, fs, env, retirePlanner, ...(options.defaultCombined ? {} : { combinedTest }), settings: structuredClone({ ...settings, ...options.settings }), now: () => clock,
    cloneKey: (root) => { cloneRoots.push(root); return 'test-clone-key'; },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; await options.onSleep?.(); } });
  return { calls, records, sleeps, admitted, reads, cloneRoots, lateChanges, registrations, combinedTest, retirePlanner, run: (input = {}) => load({ ...BASE, sha: candidateSha, ...input }) };
}
const mutations = (f, action) => f.calls.filter((c) => c.cmd === 'node' && c.args[1] === action && !c.args.includes('--check'));
describe('default combined-tree test proof', () => {
  const limits = { waitMs: 1234, timeoutMs: 5678, maxBuffer: 4096 };
  const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0,
    numPassedTests: 3, numPendingTests: 2, numTodoTests: 1, numTotalTests: 5, testResults: [
      { name: 'one.test.mjs', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'todo' }] },
      { name: 'two.test.mjs', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'passed' }] },
    ] };
  async function runReport(value, { missing = false, failure, cleanupRemains = false, env = {}, sourceFiles, changedFiles, runTests, mergeConflict = false, unreadable = false } = {}) {
    const worktree = '/tmp/prototype-combined-proof';
    const sources = new Map(sourceFiles || [['one.test.mjs', ''], ['two.test.mjs', '']]);
    let reportPath;
    let selectedTests = [];
    const fs = {
      mkdtempSync: () => worktree, existsSync: vi.fn((path) => path === worktree && cleanupRemains), rmSync: vi.fn(),
      readFileSync: vi.fn((path) => {
        if (path === reportPath) {
          if (missing) throw new Error('missing report');
          const reported = typeof value === 'function' ? value(selectedTests) : value;
          return typeof reported === 'string' ? reported : JSON.stringify(reported);
        }
        if (unreadable) throw new Error('permission denied');
        const source = sources.get(path.slice(worktree.length + 1));
        if (source === undefined) throw new Error('unexpected read');
        return source;
      }),
    };
    const exec = vi.fn((command, args) => {
      if (command === 'node') {
        selectedTests = args.filter(arg => sources.has(arg));
        reportPath = args.find(arg => arg.startsWith('--outputFile='))?.slice('--outputFile='.length);
        if (failure) throw failure;
        runTests?.(selectedTests);
        return ''; // Exit zero alone proves nothing.
      }
      if (args[0] === '-C' || args[0] === 'rev-parse') return SHA;
      if (['fetch', 'merge-base', 'worktree'].includes(args[0])) return '';
      if (args[0] === 'merge-tree') {
        if (mergeConflict) throw Object.assign(new Error('merge conflict'), { status: 1 });
        return TREE;
      }
      if (args[0] === 'commit-tree') return MERGE;
      if (args[0] === 'ls-files') return [...sources.keys()].join('\0') + '\0';
      throw new Error('unexpected command');
    });
    const result = await defaultDeps().combinedTest({ clone: '/fixture/clone', candidateSha: SHA,
      changedFiles: changedFiles ?? [...sources.keys()], refs: ['lane/old'] }, { exec, fs, env, settings: { combinedTest: limits } });
    return { result, exec, fs, worktree, reportPath };
  }
  it.each(Object.keys(limits).flatMap(key => [0, -1, 1.5].map(value => [key, value])))(
    'rejects invalid %s=%s before spawning anything', async (key, value) => {
      const exec = vi.fn();
      await expect(defaultDeps().combinedTest({}, { exec, fs: {}, env: {},
        settings: { combinedTest: { ...limits, [key]: value } } })).rejects.toThrow(`invalid combinedTest.${key}`);
      expect(exec).not.toHaveBeenCalled();
    });
  it('refuses a real combined-tree merge conflict without spawning tests', async () => {
    const { result, exec } = await runReport(report, { mergeConflict: true });
    expect(result).toEqual({ ok: false, reason: 'combined-merge-conflict' });
    expect(exec.mock.calls.some(([command]) => command === 'node')).toBe(false);
  });
  it('refuses zero related tests without spawning tests', async () => {
    const { result, exec } = await runReport(report, { sourceFiles: [['source.mjs', '']] });
    expect(result).toMatchObject({ ok: false, reason: 'no-related-tests', testCount: 0 });
    expect(exec.mock.calls.some(([command]) => command === 'node')).toBe(false);
  });
  it('throws sources incomplete for unreadable tracked sources before spawning tests', async () => {
    await expect(runReport(report, { unreadable: true })).rejects.toThrow('sources incomplete');
  });
  it.each(['file', 'symlink', 'directory', 'fresh'])('requires a report from this invocation (report fixture: %s)', async (kind) => {
    const fs = defaultDeps().fs;
    const root = fs.mkdtempSync(join(tmpdir(), 'prototype-report-freshness-'));
    const worktree = join(root, 'worktree');
    const reportPath = join(worktree, '.prototype-vitest-results.json');
    const oldReport = join(root, 'old-report.json');
    const passingReport = JSON.stringify({ success: true, numFailedTests: 0, numFailedTestSuites: 0,
      numPassedTests: 1, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1,
      testResults: [{ name: 'one.test.mjs', status: 'passed', assertionResults: [{ status: 'passed' }] }] });
    fs.mkdirSync(worktree);
    fs.writeFileSync(oldReport, passingReport);
    const exec = vi.fn((command, args) => {
      if (command === 'node') {
        if (kind === 'fresh') fs.writeFileSync(reportPath, passingReport);
        return ''; // Other cases model config exiting zero without writing a report.
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        fs.writeFileSync(join(worktree, 'one.test.mjs'), kind === 'fresh' ? '' : "throw new Error('test must fail');");
        fs.writeFileSync(join(worktree, 'vitest.config.mjs'), kind === 'fresh' ? '' : 'process.exit(0);');
        if (kind === 'symlink') fs.symlinkSync(oldReport, reportPath);
        else if (kind === 'directory') fs.mkdirSync(reportPath);
        else fs.writeFileSync(reportPath, passingReport);
        return '';
      }
      if (args[0] === '-C' || args[0] === 'rev-parse') return SHA;
      if (['fetch', 'merge-base', 'worktree'].includes(args[0])) return '';
      if (args[0] === 'merge-tree') return TREE;
      if (args[0] === 'commit-tree') return MERGE;
      if (args[0] === 'ls-files') return 'one.test.mjs\0vitest.config.mjs\0.prototype-vitest-results.json\0';
      throw new Error('unexpected command');
    });
    try {
      const result = await defaultDeps().combinedTest({ clone: '/fixture/clone', candidateSha: SHA,
        refs: ['lane/old'] }, { exec, fs: { ...fs, mkdtempSync: () => worktree }, env: {},
        settings: { combinedTest: limits } });
      expect(result).toMatchObject(kind === 'fresh' ? { ok: true, result: '1 passed, 0 skipped' }
        : { ok: false, reason: kind === 'directory' ? 'tests-failed' : 'tests-unproven' });
      if (kind === 'directory') expect(exec.mock.calls.some(([command]) => command === 'node')).toBe(false);
      const loader = fixture({ list: ['lane/old'], conflicts: ['lane/old'], combinedTest: result });
      expect((await loader.run()).ok).toBe(kind === 'fresh');
      if (kind !== 'fresh') {
        expect(mutations(loader, 'add')).toEqual([]);
        expect(mutations(loader, 'remove')).toEqual([]);
      }
      expect(fs.existsSync(worktree)).toBe(false);
      expect(fs.readFileSync(oldReport, 'utf8')).toBe(passingReport);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses combined evidence when an unimported filesystem-dependent test fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prototype-fs-dependency-'));
    const combination = `const { readFileSync } = require('node:fs');
      const enabled = name => JSON.parse(readFileSync(require('node:path').join(root, name), 'utf8')).enabled;
      if (enabled('a.json') && enabled('b.json')) throw new Error('both enabled');`;
    const runCombination = () => runInNewContext(combination, { root, require: createRequire(import.meta.url) }, { timeout: 1000 });
    const writeConfig = (a, b) => {
      writeFileSync(join(root, 'a.json'), JSON.stringify({ enabled: a }));
      writeFileSync(join(root, 'b.json'), JSON.stringify({ enabled: b }));
    };
    try {
      for (const [a, b] of [[true, false], [false, true]]) {
        writeConfig(a, b);
        expect(runCombination).not.toThrow(); // Each branch alone passes.
      }
      writeConfig(true, true);
      expect(runCombination).toThrow('both enabled');
      const { result, exec } = await runReport({ success: true, numFailedTests: 0, numFailedTestSuites: 0,
        numPassedTests: 1, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1,
        testResults: [{ name: 'shared.test.mjs', status: 'passed', assertionResults: [{ status: 'passed' }] }] }, {
        sourceFiles: [['shared.mjs', 'export const shared = true;'], ['shared.test.mjs', "import './shared.mjs';"],
          ['a.json', '{"enabled":true}'], ['b.json', '{"enabled":true}'], ['combination.test.mjs', combination]],
        changedFiles: ['shared.mjs', 'a.json', 'b.json'],
        runTests: tests => {
          if (tests.includes('combination.test.mjs')) {
            try { runCombination(); }
            catch (error) { throw Object.assign(error, { status: 1, stderr: error.message }); }
          }
        },
      });
      expect(result).toMatchObject({ ok: false, reason: 'tests-failed' });
      expect(exec.mock.calls.find(([command]) => command === 'node')[1]).toContain('combination.test.mjs');
      const loader = fixture({ list: ['lane/old'], conflicts: ['lane/old'], combinedTest: result });
      expect(await loader.run()).toMatchObject({ ok: false, stopReason: 'stale-registration', staleTolerated: [] });
      expect(mutations(loader, 'add')).toEqual([]);
      expect(mutations(loader, 'remove')).toEqual([]);
      expect(loader.records[0]).toMatchObject({ ok: false, stopReason: 'stale-registration' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const passingReport = tests => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0,
    numPassedTests: tests.length, numPendingTests: 0, numTodoTests: 0, numTotalTests: tests.length,
    testResults: tests.map(name => ({ name, status: 'passed', assertionResults: [{ status: 'passed' }] })) });
  it('requires all tracked test suffixes even with no static import edges or changed tests', async () => {
    const tests = ['mjs', 'cjs', 'js', 'jsx', 'ts', 'tsx', 'mts', 'cts'].map(ext => `indirect.test.${ext}`).sort();
    const { result, exec } = await runReport(passingReport, {
      sourceFiles: [['source.mjs', ''], ...tests.map(file => [file, ''])], changedFiles: ['source.mjs'],
    });
    expect(result).toMatchObject({ ok: true, testCount: tests.length });
    expect(exec.mock.calls.find(([command]) => command === 'node')[1].slice(-tests.length)).toEqual(tests);
  });
  it('refuses a passing report that omits an unimported tracked test', async () => {
    const { result } = await runReport(passingReport(['one.test.mjs']), { changedFiles: ['one.test.mjs'] });
    expect(result).toMatchObject({ ok: false, reason: 'tests-unproven', testCount: 2 });
  });
  it.each([0, 1])('bounds the complete inventory even when no imports reveal its tests (over limit: %s)', async extra => {
    const { MAX_RELATED_TARGETS } = await import('../../lib/verify-lane-gate.mjs');
    const tests = Array.from({ length: MAX_RELATED_TARGETS + extra }, (_, i) => `indirect-${i}.test.mjs`);
    const { result, exec, fs, worktree } = await runReport(passingReport, {
      sourceFiles: [['source.mjs', ''], ...tests.map(file => [file, ''])], changedFiles: ['source.mjs'],
    });
    if (extra) {
      expect(result).toMatchObject({ ok: false, reason: 'related-tests-truncated', testCount: 0,
        result: expect.stringContaining('Rebase and retest the overlapping refs') });
      expect(exec.mock.calls.some(([command]) => command === 'node')).toBe(false);
    } else expect(result).toMatchObject({ ok: true, testCount: MAX_RELATED_TARGETS });
    expect(fs.rmSync).toHaveBeenCalledWith(worktree, { recursive: true, force: true });
  });
  it('drops credentials only from the tests child and preserves ordinary and NODE_* variables', async () => {
    const safe = { PATH: '/bin', HOME: '/home/test', TMPDIR: '/tmp', USER: 'tester', NODE_OPTIONS: '--no-warnings', NODE_ENV: 'test' };
    const secrets = { SSH_AUTH_SOCK: '/agent', GIT_ASKPASS: '/askpass', GIT_SSH_COMMAND: 'ssh', GH_TOKEN: 'gh',
      GITHUB_TOKEN: 'github', SERVICE_TOKEN: 'token', SERVICE_SECRET: 'secret', SERVICE_KEY: 'key', NODE_API_KEY: 'key' };
    const env = { ...safe, ...secrets };
    const { exec } = await runReport(report, { env });
    expect(exec.mock.calls.find(([command]) => command === 'node')[2].env).toEqual(safe);
    for (const [command, , options] of exec.mock.calls) if (command === 'git') expect(options.env).toEqual(env);
  });
  it('requires positive JSON proof and reports passed and skipped test counts', async () => {
    const { result, exec, fs, worktree, reportPath } = await runReport(report);
    expect(result).toMatchObject({ ok: true, testCount: 2, result: '3 passed, 2 skipped' });
    const [, args, options] = exec.mock.calls.find(([command]) => command === 'node');
    expect(args.slice(args.indexOf('vitest'))).toEqual(['vitest', 'run', '--reporter=json',
      `--outputFile=${reportPath}`, '--testTimeout=30000', '--hookTimeout=60000', '--teardownTimeout=10000',
      'one.test.mjs', 'two.test.mjs']);
    expect(reportPath.startsWith(worktree + '/')).toBe(true);
    expect(fs.readFileSync).toHaveBeenCalledWith(reportPath, 'utf8');
    expect(args.slice(0, args.indexOf('--'))).toContain(`--ceiling-ms=${limits.timeoutMs}`);
    expect(options).toMatchObject({ cwd: worktree, timeout: limits.timeoutMs, maxBuffer: limits.maxBuffer, shell: false,
      killSignal: 'SIGTERM' });
    expect(fs.rmSync).toHaveBeenCalledWith(worktree, { recursive: true, force: true });
  });
  it('accepts actual Vitest JSON containing skipped and todo tests', async () => {
    // Serialized by Vitest 3.2.4 JsonReporter.onFinished with pass/skip/todo task
    // records (the todo has result.state=skip). No test runner is spawned here.
    // Source: https://github.com/vitest-dev/vitest/blob/v3.2.4/packages/vitest/src/node/reporters/json.ts
    const json = `{
      "numTotalTestSuites": 2, "numPassedTestSuites": 2, "numFailedTestSuites": 0, "numPendingTestSuites": 0,
      "numTotalTests": 5, "numPassedTests": 3, "numFailedTests": 0, "numPendingTests": 2, "numTodoTests": 1,
      "snapshot": {}, "startTime": 0, "success": true,
      "testResults": [
        {"assertionResults": [
          {"ancestorTitles": [],"fullName": "case 0","status": "passed","title": "case 0","duration": 0,"failureMessages": [],"meta": {}},
          {"ancestorTitles": [],"fullName": "case 1","status": "skipped","title": "case 1","duration": 0,"failureMessages": [],"meta": {}},
          {"ancestorTitles": [],"fullName": "case 2","status": "skipped","title": "case 2","duration": 0,"failureMessages": [],"meta": {}}
        ], "startTime": 0, "endTime": 0, "status": "passed", "message": "", "name": "one.test.mjs"},
        {"assertionResults": [
          {"ancestorTitles": [],"fullName": "case 0","status": "passed","title": "case 0","duration": 0,"failureMessages": [],"meta": {}},
          {"ancestorTitles": [],"fullName": "case 1","status": "passed","title": "case 1","duration": 0,"failureMessages": [],"meta": {}}
        ], "startTime": 0, "endTime": 0, "status": "passed", "message": "", "name": "two.test.mjs"}
      ]
    }`;
    expect(JSON.parse(json)).toMatchObject({ numPendingTests: 2, numTodoTests: 1, numTotalTests: 5 });
    expect((await runReport(json)).result).toMatchObject({ ok: true, testCount: 2, result: '3 passed, 2 skipped' });
  });
  it('accepts separately reported todo assertions without double-counting the summary', async () => {
    expect((await runReport({ ...report, numPendingTests: 1 })).result)
      .toMatchObject({ ok: true, testCount: 2, result: '3 passed, 2 skipped' });
  });
  it('rejects a todo count larger than all skipped assertions in reporter output', async () => {
    const value = structuredClone(report);
    value.testResults[0].assertionResults[2].status = 'skipped';
    value.numTodoTests = 3;
    expect((await runReport(value)).result).toMatchObject({ ok: false, reason: 'tests-unproven' });
  });
  it('accepts absolute worktree file names and reordered results', async () => {
    const value = { ...report, testResults: [...report.testResults].reverse().map(file => ({
      ...file, name: `/tmp/prototype-combined-proof/${file.name}`,
    })) };
    expect((await runReport(value)).result.ok).toBe(true);
  });
  it.each([
    ['wrong file', files => { files[1].name = 'other.test.mjs'; }],
    ['duplicate file', files => { files[1].name = files[0].name; }],
    ['outside worktree', files => { files[1].name = '../two.test.mjs'; }],
    ['missing name', files => { delete files[1].name; }],
    ['missing file status', files => { delete files[1].status; }],
    ['failed file status', files => { files[1].status = 'failed'; }],
    ['skipped file status', files => { files[1].status = 'skipped'; }],
    ['missing assertions', files => { delete files[1].assertionResults; }],
    ['empty assertions', files => { files[1].assertionResults = []; }],
    ['failed assertion with green counts', files => { files[1].assertionResults.push({ status: 'failed' }); }],
    ['unknown assertion status', files => { files[1].assertionResults.push({ status: 'unknown' }); }],
    ['null assertion', files => { files[1].assertionResults.push(null); }],
    ['skipped-only file despite overall passes', files => { files[1].assertionResults = [{ status: 'skipped' }, { status: 'todo' }]; }],
    ['null file', files => { files[1] = null; }],
  ])('rejects %s in fake JSON despite green aggregate counts', async (_name, mutate) => {
    const value = structuredClone(report);
    mutate(value.testResults);
    const { result, fs, worktree } = await runReport(value);
    expect(result).toMatchObject({ ok: false, reason: 'tests-unproven' });
    expect(fs.existsSync).toHaveBeenCalledWith(worktree);
    expect(result.result).toContain('temp worktree removed');
  });
  it.each(['numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTests'])(
    'fails closed on missing or invalid %s without unknown counts', async (key) => {
      for (const invalid of [undefined, null, '0', -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const value = { ...report, [key]: invalid };
        const { result } = await runReport(value);
        expect(result).toMatchObject({ ok: false, reason: 'tests-unproven' });
        expect(result.result).not.toContain('unknown');
      }
    },
  );
  it.each([
    ['passed', { numPassedTests: 4, numTotalTests: 6 }],
    ['pending', { numPendingTests: 3, numTotalTests: 6 }],
    ['todo', { numTodoTests: 2, numTotalTests: 6 }],
    ['total', { numTotalTests: 6 }],
    ['balanced pending/todo', { numPendingTests: 0, numTodoTests: 2 }],
  ])('rejects %s counts inconsistent with individual assertions', async (_name, counts) => {
    const { result } = await runReport({ ...report, ...counts });
    expect(result).toMatchObject({ ok: false, reason: 'tests-unproven' });
    expect(result.result).toContain('counts mismatch');
  });
  it.each(['', ' ', '\n', '"', "'", '(', ')', ':', '='])(
    'redacts arbitrary absolute paths from failed-run output after %j', async (prefix) => {
      const { result } = await runReport(report, { failure: Object.assign(new Error('runner failed'), {
        status: 1, stderr: `${prefix}/srv/x/y ${prefix}/mnt/a/b`,
      }) });
      expect(result).toMatchObject({ ok: false, reason: 'tests-failed' });
      expect(result.result).not.toMatch(/\/srv\/x\/y|\/mnt\/a\/b/);
      expect(result.result).toContain(`${prefix}<path> ${prefix}<path>`);
    },
  );
  it.each(['[', ']', ',', '{', '}', ';', '!', '?', '+', '-', '@', '#', '$', '%', '&', '*', '/', '\\', '|', '~', '`'])(
    'preserves legacy delimiter %j redaction in persisted failed-run output', async (prefix) => {
      const raw = `${prefix}/home/fixture/secret.txt] ${prefix}/srv/x/y ${prefix}/mnt/a/b`;
      const { result } = await runReport(report, { failure: Object.assign(new Error('runner failed'), {
        status: 1, stderr: raw,
      }) });
      expect(result).toMatchObject({ ok: false, reason: 'tests-failed' });
      expect(result.result.match(/<path>/g)).toHaveLength(3);
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], combinedTest: result });
      const loaded = await f.run();
      expect(loaded).toMatchObject({ ok: false, stopReason: 'stale-registration', staleTolerated: [] });
      for (const output of [result, loaded, ...f.records]) {
        expect(JSON.stringify(output)).not.toMatch(/\/home\/fixture\/secret\.txt|\/srv\/x\/y|\/mnt\/a\/b/);
      }
      expect(mutations(f, 'add')).toEqual([]);
      expect(mutations(f, 'remove')).toEqual([]);
    },
  );
  it('redacts ANSI-prefixed and single-component absolute paths from failed-run output', async () => {
    const { result } = await runReport(report, { failure: Object.assign(new Error('runner failed'), { status: 1, stderr: '\u001b[31m/srv/private/file and /secret end' }) });
    expect(result.result).not.toMatch(/srv|private\/file|\/secret/);
    expect(result.result).not.toMatch(/\u001b/);
  });
  it('redacts home and other absolute paths from failed-run output', async () => {
    const { result } = await runReport(report, { failure: Object.assign(new Error('runner failed'), { status: 1, stderr: 'at /Users/fixture/secret/dir/file.mjs:3 and /private/var/x/y' }) });
    expect(result.result).not.toMatch(/\/Users\/fixture|\/private\/var/);
    expect(result.result).toContain('<path>');
  });
  it.each([
    ['timeout', { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }],
    ['nonzero exit', { status: 1, stderr: 'failed' }],
    ['output overflow', { code: 'ENOBUFS', status: null }],
    ['spawn failure', { code: 'ENOENT' }],
  ])('verifies cleanup after %s and reports descendant ownership only as information', async (_name, failure) => {
    const { result, fs, exec, worktree } = await runReport(report, { failure: Object.assign(new Error('runner failed'), failure) });
    expect(result).toMatchObject({ ok: false, reason: 'tests-failed' });
    expect(exec.mock.calls.some(([cmd, args]) => cmd === 'git' && args.join(' ') === `worktree remove --force ${worktree}`)).toBe(true);
    expect(fs.rmSync).toHaveBeenCalledWith(worktree, { recursive: true, force: true });
    expect(fs.existsSync).toHaveBeenCalledWith(worktree);
    expect(result.result).toContain('temp worktree removed');
    expect(result.result).toContain('child processes may outlive the timeout; heavy-admission owns them');
  });
  it('refuses unverifiable cleanup with an operator recovery instruction', async () => {
    await expect(runReport(report, { failure: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), cleanupRemains: true }))
      .rejects.toThrow('cleanup unproven; remove the temporary worktree and retry');
  });
  it.each([
    ['missing JSON', report, { missing: true }], ['unparseable JSON', '{bad'],
    ['null JSON', 'null'], ['skipped-only', { ...report, numPassedTests: 0 }],
    ['unsuccessful run', { ...report, success: false }], ['missing success', { ...report, success: undefined }],
    ['failed tests', { ...report, numFailedTests: 1 }], ['failed suites', { ...report, numFailedTestSuites: 1 }],
    ['missing counts', { success: true, testResults: [{}, {}] }],
    ['missing results', { ...report, testResults: undefined }],
    ['too few files', { ...report, testResults: [{}] }], ['too many files', { ...report, testResults: [{}, {}, {}] }],
  ])('fails closed on exit zero with %s', async (_name, value, options) => {
    const { result, fs, worktree } = await runReport(value, options);
    expect(result).toMatchObject({ ok: false, reason: 'tests-unproven', testCount: 2 });
    expect(result.result).toMatch(/passed.*skipped/);
    expect(result.result).not.toContain('unknown');
    expect(result.result.length).toBeLessThanOrEqual(300);
    expect(fs.rmSync).toHaveBeenCalledWith(worktree, { recursive: true, force: true });
  });
});

describe('prototype-load', () => {
  it.each([
    ['missing', ''], ['wrong sha', JSON.stringify({ ref: BASE.branch, sha: TREE, tests: 'green', audit: 'NOT WEAKENED' })],
    ['weakened', JSON.stringify({ ref: BASE.branch, sha: SHA, tests: 'green', audit: 'WEAKENED' })],
  ])('no-ready: %s stops before git and records', async (_, ready) => {
    const f = fixture({ ready }); expect((await f.run()).stopReason).toBe('no-ready'); expect(f.calls).toHaveLength(0); expect(f.records[0].stopReason).toBe('no-ready');
  });
  it('accepts explicit tests-run and NOT WEAKENED pair', async () => {
    const f = fixture({ ready: '' }); expect((await f.run({ testsRun: 'test-1', audit: 'not weakened' })).ok).toBe(true);
  });
  it('refuses a branch tip mismatch before main checks', async () => {
    const f = fixture({ tip: TREE }); const r = await f.run(); expect(r.gate.reason).toBe('sha-not-branch-tip'); expect(r.stopReason).toBe('no-ready'); expect(f.calls).toHaveLength(2);
  });
  it.each(['lane/../x', '-danger', 'lane/x.lock', 'main'])('bad-input: refuses unsafe ref %s', async (branch) => {
    const f = fixture(); expect((await f.run({ branch })).stopReason).toBe('bad-input'); expect(f.calls).toHaveLength(0);
  });
  it('bad-input: malformed sha records refusal', async () => { const f = fixture(); expect((await f.run({ sha: 'short' })).stopReason).toBe('bad-input'); expect(f.records).toHaveLength(1); });
  it.each([[null, 'lane/new-m1'], [`${SHA}\trefs/heads/lane/new-m1\n`, 'lane/new-m2']])('clean behind-main merge publishes next suffix', async (remote, ref) => {
    const f = fixture({ behind: true, remote }); const r = await f.run(); expect(r.ok).toBe(true); expect(r.effectiveRef).toBe(ref); expect(r.effectiveSha).toBe(MERGE);
    expect(f.calls.find((c) => c.args[0] === 'push').args).toEqual(['push', 'origin', `${MERGE}:refs/heads/${ref}`]);
  });
  it('behind-main-conflict names paths and never registers', async () => {
    const f = fixture({ behind: true, mergeConflict: true }); const r = await f.run(); expect(r.stopReason).toBe('behind-main-conflict'); expect(r.mainCheck.files).toEqual(['x']); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('reverts-main catches outside paths before push or check', async () => {
    const f = fixture({ behind: true, diff: 'M\0x\0D\0main-fix\0' }); const r = await f.run(); expect(r.stopReason).toBe('reverts-main'); expect(r.offendingPaths).toEqual(['main-fix']); expect(f.calls.some((c) => c.cmd === 'node' || c.args[0] === 'push')).toBe(false);
  });
  it.each([false, true])('stale-registration names blocker and stops before add (candidate conflict: %s)', async (candidateConflict) => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old', ...(candidateConflict ? [BASE.branch] : [])] }); const r = await f.run(); expect(r.stopReason).toBe('stale-registration'); expect(r.message).toBe(`stale-registration: lane/old (${candidateConflict ? 'candidate-not-clean' : 'overlap-with-candidate: x; combined-tests-failed: tests-failed'})`); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('tolerates a pre-existing stale ref when the candidate is clean and file-disjoint', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs'] }, staleChanged: { 'lane/old': 'M\0old-only.mjs\0' } });
    const r = await f.run();
    expect(r.check).toMatchObject({ ok: true, clean: true });
    expect(r.mainCheck.effectivePaths).toEqual(['x']);
    expect(r.staleChecks['lane/old']).toMatchObject({ ok: true, clean: false, files: ['old-only.mjs'] });
    expect(r).toMatchObject({ ok: true, registered: true, adopted: true, stopReason: null, stale: ['lane/old'], contained: [] });
    expect(r.staleTolerated).toEqual([{ ref: 'lane/old', landedByContent: false, why: expect.stringMatching(/\S/) }]);
    expect(mutations(f, 'add')).toHaveLength(1);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ ok: true, staleTolerated: r.staleTolerated });
  });
  it('refuses a stale ref whose changed files overlap the candidate files', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs', 'x'] }, staleChanged: { 'lane/old': 'M\0old-only.mjs\0' } });
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, stopReason: 'stale-registration', blocking: ['lane/old'], blockingReasons: { 'lane/old': 'overlap-with-candidate: x; combined-tests-failed: tests-failed' } });
    expect(r.message).toMatch(/^stale-registration: lane\/old/);
    expect(r.message).toContain('overlap-with-candidate: x; combined-tests-failed: tests-failed');
    expect(mutations(f, 'add')).toEqual([]);
  });
  it('refuses a stale ref whose non-conflicting changed file overlaps the candidate', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs'] },
      staleChanged: { 'lane/old': 'M\0old-only.mjs\0M\0x\0' } });
    const r = await f.run();
    expect(r.staleChecks['lane/old'].files).toEqual(['old-only.mjs']);
    expect(r).toMatchObject({ ok: false, stopReason: 'stale-registration', blocking: ['lane/old'], blockingReasons: { 'lane/old': 'overlap-with-candidate: x; combined-tests-failed: tests-failed' } });
    expect(r.message).toContain('overlap-with-candidate: x; combined-tests-failed: tests-failed');
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it('allows an overlapping stale ref when combined-tree tests pass', async () => {
    const combinedTests = { command: 'fixture-related-tests', result: '2 passed', testCount: 2 };
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
      staleChanged: { 'lane/old': 'M\0z-old.mjs\0M\0x\0M\0a-old.mjs\0' },
      combinedTest: { ok: true, ...combinedTests } });
    const r = await f.run();
    expect(f.combinedTest).toHaveBeenCalledTimes(1);
    expect(f.combinedTest).toHaveBeenCalledWith({ clone: '/home/test/workspace/wev-control', candidateSha: SHA,
      changedFiles: ['a-old.mjs', 'x', 'z-old.mjs'], refs: ['lane/old'] });
    expect(r).toMatchObject({ ok: true, registered: true, adopted: true, stopReason: null, contained: [] });
    expect(r.combinedTests).toEqual(combinedTests);
    expect(r.staleTolerated).toEqual([{ ref: 'lane/old', landedByContent: false,
      why: expect.stringMatching(/combined/i), combinedTests }]);
    expect(mutations(f, 'add')).toHaveLength(1);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.registrations.has('lane/old')).toBe(true);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ ok: true, combinedTests, staleTolerated: r.staleTolerated });
  });
  it('refuses an overlapping stale ref when combined-tree tests fail', async () => {
    for (const reason of ['tests-failed', 'combined-merge-conflict', 'no-related-tests', 'unrunnable']) {
      const combinedTests = { command: 'fixture-related-tests', result: 'no passing evidence', testCount: 0 };
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
        combinedTest: { ok: false, reason, ...combinedTests } });
      const r = await f.run();
      expect(f.combinedTest).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ ok: false, registered: false, adopted: false, stopReason: 'stale-registration',
        blocking: ['lane/old'], blockingReasons: { 'lane/old': `overlap-with-candidate: x; combined-tests-failed: ${reason}` },
        combinedTests });
      expect(r.message).toBe(`stale-registration: lane/old (overlap-with-candidate: x; combined-tests-failed: ${reason})`);
      expect(r.staleTolerated).toEqual([]);
      expect(mutations(f, 'add')).toEqual([]);
      expect(mutations(f, 'remove')).toEqual([]);
      expect(f.records).toHaveLength(1);
      expect(f.records[0]).toMatchObject({ stopReason: 'stale-registration', combinedTests: r.combinedTests, staleTolerated: [] });
    }
  });
  it('blocks admission for truncated combined evidence when selected tests pass but an omitted related test fails', async () => {
    const { MAX_RELATED_TARGETS } = await import('../../lib/verify-lane-gate.mjs');
    const { buildReverseImportGraph, selectRelatedTests } = await import('../../lib/related-test-selection.mjs');
    const sources = new Map([
      ['x', ''], ['bridge.mjs', "import './x';"], ['deep.mjs', "import './bridge.mjs';"],
      ['omitted.test.mjs', "import './deep.mjs';"],
      ...Array.from({ length: MAX_RELATED_TARGETS }, (_, i) => [`passing-${i}.test.mjs`, "import './x';"]),
    ]);
    const reverse = buildReverseImportGraph({ files: [...sources.keys()], readFile: (file) => sources.get(file) });
    const selection = selectRelatedTests({ changedFiles: ['x'], reverse, maxTests: MAX_RELATED_TARGETS, maxDepth: 2 });
    expect(selection.status).toBe('selection-truncated');
    expect(selection.tests).toHaveLength(MAX_RELATED_TARGETS);
    expect(selection.tests).not.toContain('omitted.test.mjs');
    // Model the regression: the bounded subset passes, but complete evidence would fail.
    const testRunner = (tests) => {
      if (tests.includes('omitted.test.mjs')) throw Object.assign(new Error('omitted related regression'), { status: 1, stderr: 'omitted related regression' });
      return '';
    };
    expect(testRunner(selection.tests)).toBe('');
    expect(() => testRunner([...selection.tests, 'omitted.test.mjs'])).toThrow('omitted related regression');
    const queuedRun = vi.fn((args) => testRunner(args));
    const commands = [];
    const worktree = '/tmp/prototype-combined-fixture';
    const fs = {
      mkdtempSync: vi.fn(() => worktree), existsSync: () => false,
      readFileSync: (path) => {
        const file = path.slice(worktree.length + 1);
        if (!sources.has(file)) throw new Error(`unexpected read: ${file}`);
        return sources.get(file);
      },
      rmSync: vi.fn(),
    };
    const exec = (command, args) => {
      commands.push({ command, args });
      if (command === 'node') return queuedRun(args);
      if (args[0] === '-C') return SHA;
      if (args[0] === 'rev-parse') return SHA;
      if (args[0] === 'merge-base') return '';
      if (args[0] === 'fetch' || args[0] === 'worktree') return '';
      if (args[0] === 'merge-tree') return TREE;
      if (args[0] === 'commit-tree') return MERGE;
      if (args[0] === 'ls-files') return [...sources.keys()].join('\0') + '\0';
      throw new Error(`unexpected command: ${command} ${args}`);
    };
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
      combinedTest: (input) => defaultDeps().combinedTest(input, { exec, fs, env: {},
        settings: { combinedTest: { waitMs: 600000, timeoutMs: 1200000, maxBuffer: 16 * 1024 * 1024 } } }) });
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, registered: false, adopted: false, stopReason: 'stale-registration',
      blocking: ['lane/old'], blockingReasons: { 'lane/old': 'overlap-with-candidate: x; combined-tests-failed: related-tests-truncated' },
      combinedTests: { testCount: 0, result: expect.stringContaining('Rebase and retest the overlapping refs') }, staleTolerated: [] });
    expect(queuedRun).not.toHaveBeenCalled();
    expect(commands).toContainEqual({ command: 'git', args: ['worktree', 'remove', '--force', worktree] });
    expect(fs.rmSync).toHaveBeenCalledWith(worktree, { recursive: true, force: true });
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.registrations.has('lane/old')).toBe(true);
    expect(f.records[0]).toMatchObject({ ok: false, combinedTests: result.combinedTests });
  });
  it('blocks an overlapping ref absent from HEAD and candidate when its inclusion cannot be proved', async () => {
    const head = 'd'.repeat(40), staleTip = 'e'.repeat(40);
    const commands = [];
    // Even a passing runner cannot rescue a tree that excludes the registered work.
    const queuedRun = vi.fn(() => 'passed');
    const mkdtempSync = vi.fn();
    const exec = (command, args) => {
      commands.push({ command, args });
      if (command === 'node') return queuedRun(args);
      if (args[0] === '-C') return head;
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return staleTip;
      if (args[0] === 'merge-base') throw Object.assign(new Error('registered work absent'), { status: 1 });
      // Without the containment guard, a conflicting inclusion would never be attempted.
      if (args[0] === 'merge-tree' && args.includes(staleTip)) throw Object.assign(new Error('registered changes conflict'), { status: 1 });
      if (args[0] === 'merge-tree') return TREE;
      throw new Error(`unexpected command: ${command} ${args}`);
    };
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
      combinedTest: (input) => defaultDeps().combinedTest(input, { exec, fs: { mkdtempSync }, env: {},
        settings: { combinedTest: { waitMs: 600000, timeoutMs: 1200000, maxBuffer: 16 * 1024 * 1024 } } }) });
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, registered: false, adopted: false, stopReason: 'stale-registration',
      blocking: ['lane/old'], blockingReasons: { 'lane/old': 'overlap-with-candidate: x; combined-tests-failed: combined-ref-not-contained' },
      combinedTests: { testCount: 0, result: expect.stringContaining('Include its current tip in a tested replacement') }, staleTolerated: [] });
    expect(commands).toContainEqual({ command: 'git', args: ['fetch', 'origin', 'refs/heads/lane/old'] });
    expect(commands).toContainEqual({ command: 'git', args: ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'] });
    expect(commands.filter(({ args }) => args[0] === 'merge-base').map(({ args }) => args)).toEqual([
      ['merge-base', '--is-ancestor', staleTip, head], ['merge-base', '--is-ancestor', staleTip, SHA],
    ]);
    expect(commands.filter(({ args }) => args[0] === '-C')).toEqual([
      { command: 'git', args: ['-C', '/home/test/workspace/wev-control', 'rev-parse', 'HEAD'] },
    ]);
    expect(mkdtempSync).not.toHaveBeenCalled();
    expect(queuedRun).not.toHaveBeenCalled();
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.registrations.has('lane/old')).toBe(true);
    expect(f.records[0]).toMatchObject({ ok: false, combinedTests: result.combinedTests });
  });
  it('refuses an overlapping stale ref when combined-tree tests are unrunnable (throws)', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
      combinedTest: () => { throw new Error('test runner unavailable'); } });
    const r = await f.run();
    expect(f.combinedTest).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, registered: false, adopted: false, stopReason: 'stale-registration',
      blocking: ['lane/old'], blockingReasons: { 'lane/old': 'overlap-with-candidate: x; combined-tests-unrunnable: test runner unavailable' } });
    expect(r.message).toBe('stale-registration: lane/old (overlap-with-candidate: x; combined-tests-unrunnable: test runner unavailable)');
    expect(r.combinedTests).toEqual(expect.any(Object));
    expect(r.staleTolerated).toEqual([]);
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ stopReason: 'stale-registration', combinedTests: r.combinedTests, staleTolerated: [] });
  });
  it.each(['', ' ', '\n', '"', "'", '(', ')', ':', '='])(
    'redacts arbitrary absolute paths from thrown errors after %j in every persisted field', async (prefix) => {
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
        combinedTest: () => { throw new Error(`${prefix}/srv/x/y ${prefix}/mnt/a/b`); } });
      const result = await f.run();
      expect(result).toMatchObject({ ok: false, stopReason: 'stale-registration', staleTolerated: [] });
      expect(result.combinedTests.result.match(/<path>/g)).toHaveLength(2);
      for (const output of [result, ...f.records]) {
        expect(JSON.stringify(output)).not.toMatch(/\/srv\/x\/y|\/mnt\/a\/b/);
      }
      expect(mutations(f, 'add')).toEqual([]);
      expect(mutations(f, 'remove')).toEqual([]);
    },
  );
  it.each(['[', ']', ',', '{', '}', ';', '!', '?', '+', '-', '@', '#', '$', '%', '&', '*', '/', '\\', '|', '~', '`'])(
    'preserves legacy delimiter %j redaction in persisted thrown-error output', async (prefix) => {
      const raw = `${prefix}/home/fixture/secret.txt] ${prefix}/srv/x/y ${prefix}/mnt/a/b`;
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
        combinedTest: () => { throw new Error(raw); } });
      const result = await f.run();
      expect(result).toMatchObject({ ok: false, stopReason: 'stale-registration', staleTolerated: [] });
      expect(result.combinedTests.result.match(/<path>/g)).toHaveLength(3);
      for (const output of [result, ...f.records]) {
        expect(JSON.stringify(output)).not.toMatch(/\/home\/fixture\/secret\.txt|\/srv\/x\/y|\/mnt\/a\/b/);
      }
      expect(mutations(f, 'add')).toEqual([]);
      expect(mutations(f, 'remove')).toEqual([]);
    },
  );
  it('sanitizes and bounds thrown combined-test errors in every persisted refusal field', async () => {
    const repoPath = process.cwd().replace(/\/$/, '');
    const raw = `unavailable \u0000${repoPath}/private.mjs /home/test/secret /tmp/private-log \n` + 'x'.repeat(400);
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
      combinedTest: () => { throw new Error(raw); } });
    const r = await f.run();
    const message = r.combinedTests.result;
    expect(message).toContain('<repo>/private.mjs <home>/secret <tmp>/private-log');
    expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(message).toHaveLength(300);
    expect(r).toMatchObject({ ok: false, stopReason: 'stale-registration', staleTolerated: [] });
    expect(r.blockingReasons['lane/old']).toBe(`overlap-with-candidate: x; combined-tests-unrunnable: ${message}`);
    for (const output of [r, ...f.records]) {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(repoPath);
      expect(serialized).not.toContain('/tmp/private-log');
      expect(serialized).not.toContain('/home/test/secret');
    }
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it.each([false, true])('does not run combined tests for overlapping paths plus another blocker (dirty candidate: %s)', async (dirty) => {
    const f = fixture({ list: ['lane/old', 'lane/also'],
      conflicts: ['lane/old', 'lane/also', ...(dirty ? [BASE.branch] : [])],
      ...(dirty ? {} : { staleChanged: { 'lane/also': '' } }), combinedTest: { ok: true } });
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, stopReason: 'stale-registration', blocking: ['lane/old', 'lane/also'],
      blockingReasons: dirty ? { 'lane/old': 'candidate-not-clean', 'lane/also': 'candidate-not-clean' }
        : { 'lane/old': 'overlap-with-candidate: x', 'lane/also': 'stale-files-unknown' } });
    expect(f.combinedTest).not.toHaveBeenCalled();
    expect(mutations(f, 'add')).toEqual([]);
  });
  it('wires the default runner with cascade defaults and a credential-free tests environment', async () => {
    const worktree = '/tmp/prototype-default-wiring';
    const gitEnv = { SSH_AUTH_SOCK: '/agent', GIT_ASKPASS: '/askpass', GIT_SSH_COMMAND: 'ssh' };
    const combinedExec = vi.fn((cmd, args) => {
      if (cmd === 'node') throw Object.assign(new Error('fixture stops runner'), { status: 1 });
      if (args[0] === '-C' || args[0] === 'rev-parse') return SHA;
      if (args[0] === 'merge-tree') return TREE;
      if (args[0] === 'commit-tree') return MERGE;
      if (args[0] === 'ls-files') return 'one.test.mjs\0';
      return '';
    });
    const f = fixture({ defaultCombined: true, env: gitEnv, gitEnv,
      list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['one.test.mjs'] },
      combinedIO: { exec: combinedExec,
        handles: (cmd, args) => cmd === 'node' && args[1] === 'run' || cmd === 'git' &&
          (args[0] === '-C' || ['worktree', 'ls-files'].includes(args[0]) || args.includes('FETCH_HEAD^{commit}') ||
            args[0] === 'fetch' && args[1] !== 'origin' || args[0] === 'fetch' && args[2]?.startsWith('refs/heads/') ||
            args[0] === 'merge-base' && args[2] === SHA || args[0] === 'merge-tree' || args[0] === 'commit-tree'),
        fs: { mkdtempSync: () => worktree, existsSync: () => false, rmSync: vi.fn(),
          readFileSync: (path) => {
            if (path === worktree + '/one.test.mjs') return '';
            if (path === '/home/test/ready') return JSON.stringify({ ref: BASE.branch, sha: SHA, tests: 'green', audit: 'NOT WEAKENED' });
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          } } } });
    const result = await f.run();
    expect(result).toMatchObject({ stopReason: 'stale-registration', combinedTests: { testCount: 1 } });
    const [, args, config] = combinedExec.mock.calls.find(([cmd]) => cmd === 'node');
    expect(args).toContain('--wait-ms=600000');
    expect(args).toContain('--ceiling-ms=1200000');
    expect(config).toMatchObject({ timeout: 1200000, maxBuffer: 16 * 1024 * 1024,
      env: { HOME: '/home/test', PATH: '/bin', USER: 'tester' } });
    expect(config.env).toEqual({ HOME: '/home/test', PATH: '/bin', USER: 'tester' });
    for (const [cmd, , options] of combinedExec.mock.calls) if (cmd === 'git') expect(options.env).toMatchObject(gitEnv);
    expect(f.combinedTest).not.toHaveBeenCalled();
  });
  it('does not run combined tests when the candidate is not clean or the stale files are unknown', async () => {
    for (const options of [
      { conflicts: ['lane/old', BASE.branch], reason: 'candidate-not-clean' },
      { unverifiable: BASE.branch, reason: 'candidate-not-clean' },
      { staleDiffFails: 'lane/old', reason: 'stale-files-unknown' },
      { staleChanged: { 'lane/old': '' }, reason: 'stale-files-unknown' },
      { staleChanged: { 'lane/old': 'M\0' }, reason: 'stale-files-unknown' },
    ]) {
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
        combinedTest: { ok: true, command: 'fixture-related-tests', result: 'passed' }, ...options });
      const r = await f.run();
      expect(f.combinedTest).not.toHaveBeenCalled();
      expect(r).toMatchObject({ ok: false, stopReason: 'stale-registration', blocking: ['lane/old'],
        blockingReasons: { 'lane/old': options.reason } });
      expect(mutations(f, 'add')).toEqual([]);
      expect(mutations(f, 'remove')).toEqual([]);
    }
  });
  it('runs combined tests once for several overlapping stale refs', async () => {
    const combinedTests = { command: 'fixture-related-tests', result: '3 passed', testCount: 3 };
    const f = fixture({ list: ['lane/old', 'lane/also'], conflicts: ['lane/old', 'lane/also'],
      staleChanged: { 'lane/old': 'M\0z-old.mjs\0M\0x\0', 'lane/also': 'M\0x\0M\0a-also.mjs\0' },
      combinedTest: { ok: true, ...combinedTests } });
    const r = await f.run();
    expect(f.combinedTest).toHaveBeenCalledTimes(1);
    expect(f.combinedTest).toHaveBeenCalledWith({ clone: '/home/test/workspace/wev-control', candidateSha: SHA,
      changedFiles: ['a-also.mjs', 'x', 'z-old.mjs'], refs: ['lane/old', 'lane/also'] });
    expect(r).toMatchObject({ ok: true, registered: true, adopted: true, stopReason: null });
    expect(r.combinedTests).toEqual(combinedTests);
    expect(r.staleTolerated).toEqual([
      { ref: 'lane/old', landedByContent: false, why: expect.stringMatching(/combined/i), combinedTests },
      { ref: 'lane/also', landedByContent: false, why: expect.stringMatching(/combined/i), combinedTests },
    ]);
    expect(mutations(f, 'add')).toHaveLength(1);
    expect(mutations(f, 'remove')).toEqual([]);
    expect([...f.registrations.keys()]).toEqual(['lane/old', 'lane/also']);
    expect(f.records[0]).toMatchObject({ combinedTests, staleTolerated: r.staleTolerated });
  });
  it('runs combined-tree tests during dry-run without adding or removing registrations', async () => {
    for (const ok of [true, false]) {
      const combinedTests = { command: 'fixture-related-tests', result: ok ? 'passed' : 'failed', testCount: 1 };
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
        combinedTest: { ok, ...combinedTests, ...(ok ? {} : { reason: 'tests-failed' }) } });
      const r = await f.run({ dryRun: true });
      expect(f.combinedTest).toHaveBeenCalledTimes(1);
      expect(f.combinedTest).toHaveBeenCalledWith({ clone: '/home/test/workspace/wev-control', candidateSha: SHA,
        changedFiles: ['x'], refs: ['lane/old'] });
      expect(r).toMatchObject({ ok, dryRun: true, registered: false, adopted: false,
        stopReason: ok ? null : 'stale-registration', combinedTests });
      if (ok) expect(r.wouldRegister).toBe(true);
      else expect(r.blockingReasons).toEqual({ 'lane/old': 'overlap-with-candidate: x; combined-tests-failed: tests-failed' });
      expect(mutations(f, 'add')).toEqual([]);
      expect(mutations(f, 'remove')).toEqual([]);
      expect(f.records[0]).toMatchObject({ ok, combinedTests, staleTolerated: r.staleTolerated });
    }
  });
  it('fails closed when the stale ref changed-file diff is unterminated (partial evidence)', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs'] }, staleChanged: { 'lane/old': 'M\0old-only' } });
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, stopReason: 'stale-registration', blockingReasons: { 'lane/old': expect.stringContaining('stale-files-unknown') } });
    expect(mutations(f, 'add')).toEqual([]);
  });
  it('fails closed when the stale ref changed-file diff is unreadable', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs'] }, staleDiffFails: 'lane/old' });
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, stopReason: 'stale-registration', blocking: ['lane/old'], blockingReasons: { 'lane/old': 'stale-files-unknown' } });
    expect(r.message).toContain('stale-files-unknown');
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it.each(['', 'M\0'])('fails closed when the stale ref changed-file diff is empty or malformed (%j)', async (diff) => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], staleChanged: { 'lane/old': diff } });
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, stopReason: 'stale-registration', blocking: ['lane/old'], blockingReasons: { 'lane/old': 'stale-files-unknown' } });
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it('refuses a stale ref when the candidate is not clean', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old', BASE.branch], checkFiles: { 'lane/old': ['old-only.mjs'] }, staleChanged: { 'lane/old': 'M\0old-only.mjs\0' } });
    const r = await f.run();
    expect(r.check).toMatchObject({ ok: true, clean: false });
    expect(r.ok).toBe(false);
    expect(['stale-registration', 'check-conflict']).toContain(r.stopReason);
    expect(r.blockingReasons).toEqual({ 'lane/old': 'candidate-not-clean' });
    expect(r.message).toMatch(/^stale-registration: lane\/old/);
    expect(r.message).toContain('candidate-not-clean');
    expect(mutations(f, 'add')).toEqual([]);
  });
  it.each([
    ['main differs', { 'origin/main': { code: 1 } }],
    ['candidate differs', { [SHA]: { code: 1 } }],
    ['unreadable proof', { 'origin/main': { code: 128 } }],
    ['spawn or buffer failure', { 'origin/main': { code: -1 } }],
    ['partial proof with diagnostics', { 'origin/main': `${TREE}\npartial` }],
  ])('does not waive a patch-id match without exact content containment: %s', async (_, landedProof) => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'],
      cherry: { 'lane/old': `- ${SHA}\n` }, landedProof });
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, registered: false, adopted: false,
      stopReason: 'stale-registration', blocking: ['lane/old'] });
    expect(r.staleChecks['lane/old']).toMatchObject({ ok: true, clean: false });
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it.each([{ landedPaths: '' }, { landedPaths: 'x' }, { landedPaths: 'x\0\0' }, { landedPaths: 'x\uFFFD.mjs\0' }, { landedPathsError: true }])('does not waive a patch-id match with incomplete or lossy path evidence: %j', async (options) => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], cherry: { 'lane/old': `- ${SHA}\n` }, ...options });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'stale-registration', registered: false, adopted: false });
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it('compares exact tree entries including gitlinks with literal paths and ignores merge-driver results', async () => {
    const paths = ['module', 'x[1].mjs', ':(exclude)x', '--option', 'line\nbreak', 'quote"`', 'a\rb', 'a\u2028b', 'e\u0301.mjs'];
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], cherry: { 'lane/old': `- ${SHA}\n` },
      landedPaths: paths.join('\0') + '\0', landedProof: { 'origin/main': { code: 1 } } });
    // The fixture's merge-tree returns a clean unchanged tree, as a keep-ours
    // merge driver would. It cannot substitute for exact tree-entry comparison.
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'stale-registration', registered: false, adopted: false });
    expect(f.calls.find(c => c.cmd === 'git' && c.args[0] === '--literal-pathspecs')?.args).toEqual([
      '--literal-pathspecs', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none',
      'origin/main', 'origin/lane/old', '--', ...paths,
    ]);
    expect(f.calls.some(c => c.cmd === 'git' && c.args[0] === 'merge-tree')).toBe(false);
    expect(mutations(f, 'add')).toEqual([]);
  });
  it.each(['ab', 'a\tb'])('protects conflicting live string content ignored by Git patch-id: %j', async (oldValue) => {
    const root = mkdtempSync(join(tmpdir(), 'prototype-patch-id-'));
    try {
      const base = join(root, 'base'), old = join(root, 'old'), main = join(root, 'main'), candidate = join(root, 'candidate');
      for (const [path, value] of [[base, 'a'], [old, oldValue], [main, 'a b'], [candidate, 'a b c']]) {
        writeFileSync(path, `export const s = "${value}";\n`);
      }
      const patchId = (path) => {
        let patch;
        try { execFileSync('git', ['diff', '--no-index', '--', base, path], { encoding: 'utf8', stdio: 'pipe' }); }
        catch (e) { expect(e.status).toBe(1); patch = e.stdout; }
        // Use the same file names: only the content difference participates in this probe.
        patch = String(patch).replaceAll(path, old);
        return execFileSync('git', ['patch-id', '--stable'], { input: patch, encoding: 'utf8' }).split(' ')[0];
      };
      expect(patchId(old)).toMatch(/^[a-f0-9]{40}$/);
      expect(patchId(old)).toBe(patchId(main));
      const landedProof = {};
      for (const [target, path] of [['origin/main', main], [SHA, candidate]]) {
        try { execFileSync('git', ['merge-file', '-p', path, base, old], { encoding: 'utf8', stdio: 'pipe' }); }
        catch (e) { expect(e.status).toBe(1); landedProof[target] = { code: e.status, stdout: e.stdout }; }
        expect(landedProof[target]).toBeDefined();
        let comparisonCode = 0;
        try { execFileSync('git', ['diff', '--no-index', '--quiet', '--no-ext-diff', '--no-textconv', '--', path, old], { encoding: 'utf8', stdio: 'pipe' }); }
        catch (e) { expect(e.status).toBe(1); comparisonCode = e.status; landedProof[target] = { code: e.status }; }
        expect(comparisonCode).toBe(1);
      }
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], cherry: { 'lane/old': `- ${SHA}\n` }, landedProof });
      expect(await f.run()).toMatchObject({ ok: false, registered: false, adopted: false,
        stopReason: 'stale-registration', blocking: ['lane/old'] });
      expect(mutations(f, 'add')).toEqual([]);
      expect(mutations(f, 'remove')).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('adopts with a content-landed stale ref without pairwise checks or ancestry-only swap', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs'] }, staleChanged: { 'lane/old': 'M\0old-only.mjs\0' }, landedPaths: 'old-only.mjs\0', cherry: { 'lane/old': `- ${SHA}\n- ${TREE}\n` } });
    const r = await f.run();
    expect(r).toMatchObject({ ok: true, registered: true, adopted: true, stopReason: null, contained: [],
      swap: { contained: [], removed: [] }, staleChecks: { 'lane/old': { skipped: 'landed', included: false, landed: true } } });
    expect(r.swap.failed).toBeUndefined();
    expect(r.staleTolerated).toEqual([{ ref: 'lane/old', landedByContent: true, why: expect.stringMatching(/exact.*main.*candidate/) }]);
    expect(mutations(f, 'remove')).toEqual([]);
    expect([...f.registrations.keys()]).toEqual(['lane/old']);
    expect(f.calls.filter(c => c.cmd === 'node' && c.args.includes('--check'))).toHaveLength(1);
    expect(f.calls.some(c => c.cmd === 'git' && c.args.join(' ') === 'cherry origin/main origin/lane/old')).toBe(true);
    for (const target of ['origin/main', SHA]) {
      expect(f.calls.some(c => c.cmd === 'git' && c.args.join(' ') === `--literal-pathspecs diff --quiet --no-ext-diff --no-textconv --no-renames --ignore-submodules=none ${target} origin/lane/old -- old-only.mjs`)).toBe(true);
    }
    expect(f.records[0].staleTolerated).toEqual(r.staleTolerated);
    expect(mutations(f, 'add')).toHaveLength(1);
  });
  it.each([
    ['overlapping paths', { staleChanged: { 'lane/old': 'M\0x\0' } }],
    ['unresolved pairwise preview', { unverifiable: 'lane/old' }],
    ['already registered candidate', { list: [BASE.branch, 'lane/old'] }],
  ])('retains a landed-only registration without a swap failure: %s', async (_, options) => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], cherry: { 'lane/old': `- ${SHA}\n` }, ...options });
    const r = await f.run();
    expect(r).toMatchObject({ ok: true, adopted: true, stopReason: null, contained: [], swap: { contained: [], removed: [] } });
    expect(r.swap.failed).toBeUndefined();
    expect(f.calls.filter(c => c.cmd === 'node' && c.args.includes('--check'))).toHaveLength(1);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.registrations.has('lane/old')).toBe(true);
  });
  it('a stale ref with unlanded commits is tolerated but flagged landedByContent=false', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs'] }, staleChanged: { 'lane/old': 'M\0old-only.mjs\0' }, cherry: { 'lane/old': `- ${SHA}\n+ ${TREE}\n` } });
    const r = await f.run();
    expect(r.ok).toBe(true);
    expect(r.staleTolerated).toEqual([{ ref: 'lane/old', landedByContent: false, why: expect.stringMatching(/\S/) }]);
    expect(f.calls.some(c => c.cmd === 'git' && c.args.join(' ') === 'cherry origin/main origin/lane/old')).toBe(true);
    expect(f.records[0].staleTolerated).toEqual(r.staleTolerated);
    expect(mutations(f, 'add')).toHaveLength(1);
  });
  it('never removes a tolerated stale registration', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs'] }, staleChanged: { 'lane/old': 'M\0old-only.mjs\0' } });
    const r = await f.run();
    expect(r.ok).toBe(true);
    expect(r.staleTolerated).toEqual([{ ref: 'lane/old', landedByContent: false, why: expect.stringMatching(/\S/) }]);
    expect(mutations(f, 'add')).toHaveLength(1);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.removedTips).toEqual({});
    expect([...f.registrations.keys()]).toEqual(['lane/old']);
  });
  it('adopts a candidate containing two mutually conflicting stale refs without pairwise checks', async () => {
    const refs = ['lane/old', 'lane/also'];
    const f = fixture({ list: refs, contained: refs, conflicts: refs, checkBeforeFetch: 'lane/old' });
    const r = await f.run();
    expect(r).toMatchObject({ registered: true, adopted: true, stopReason: 'swap-remove-failed', contained: refs, swap: { contained: refs } });
    expect(r.staleChecks).toEqual(Object.fromEntries(refs.map(ref => [ref, { skipped: 'contained', included: true, landed: false }])));
    expect(f.calls.filter(c => c.cmd === 'node' && c.args.includes('--check')).map(c => c.args.find(a => a.startsWith('--ref=')))).toEqual([`--ref=${BASE.branch}`]);
  });
  it('fetches a non-contained stale ref before checking it', async () => {
    const f = fixture({ list: ['lane/old'], checkBeforeFetch: 'lane/old' });
    expect(await f.run()).toMatchObject({ ok: true, contained: [] });
  });
  it('fails closed on a genuinely unresolved non-contained stale ref despite a no-PR warning', async () => {
    const f = fixture({ list: ['lane/old'], unverifiable: 'lane/old' });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'check-unverifiable', staleChecks: { 'lane/old': { ok: false, reason: 'ref-unresolved' } } });
    expect(mutations(f, 'add')).toEqual([]);
  });
  it.each([BASE.branch, 'lane/old'])('accepts a clean JSON check with a nonzero no-PR warning: %s', async (noPrWarning) => {
    const f = fixture({ list: ['lane/old'], noPrWarning, safetySettings: { overlaySafety: { noPr: 'warn' } } });
    expect(await f.run()).toMatchObject({ ok: true, registered: true, adopted: true, stopReason: null });
  });
  it.each([BASE.branch, 'lane/old'].flatMap(ref => [0, 1, 2, 70, 128, -1].flatMap(code =>
    ['', 'daemon-overlay: WARNING — lane/new is being added with NO PR.'].map(stderr => ({ ref, code, stderr })),
  )))('bounds clean check exits: $ref code=$code stderr=$stderr', async (checkExit) => {
    const f = fixture({ list: ['lane/old'], checkExit });
    const accepted = checkExit.code === 0 || (checkExit.code === 1 && checkExit.stderr.includes('WARNING'));
    expect(await f.run()).toMatchObject({ ok: accepted, registered: accepted, adopted: accepted,
      stopReason: accepted ? null : 'check-unverifiable' });
    expect(mutations(f, 'add')).toHaveLength(accepted ? 1 : 0);
  });
  it.each([BASE.branch, 'lane/old'].flatMap(ref => [
    { ref, code: 1, stderr: '', message: 'WARNING overlay NO PR' },
    { ref, code: 1, stderr: 'WARNING unrelated error' },
    { ref, code: 1, stderr: 'NO PR' },
    { ref, code: 1, stderr: 'WARNING unrelated error\nNO PR' },
  ]))('rejects incomplete warning evidence: $ref stderr=$stderr message=$message', async (checkExit) => {
    const f = fixture({ list: ['lane/old'], checkExit });
    expect(await f.run()).toMatchObject({ ok: false, registered: false, adopted: false, stopReason: 'check-unverifiable' });
    expect(mutations(f, 'add')).toEqual([]);
  });
  it.each([
    ['included in the candidate', { contained: ['lane/old'] }],
    ['landed by content', { cherry: { 'lane/old': `- ${SHA}\n` } }],
  ])('fails closed when a deleted remote ref has only cached evidence %s', async (_, evidence) => {
    const f = fixture({ list: ['lane/old'], staleFetchFails: 'lane/old', staleRemoteCode: 2, ...evidence });
    expect(await f.run()).toMatchObject({ ok: false, registered: false, adopted: false,
      staleChecks: {}, stopReason: 'check-unverifiable', fallback: expect.stringContaining('authoritative registered tip is unavailable') });
    expect(f.calls.filter(c => c.cmd === 'git' && c.args[0] === 'ls-remote' && c.args[1] === '--exit-code')).toHaveLength(1);
    expect(f.calls.filter(c => c.cmd === 'node' && c.args.includes('--check')).map(c => c.args.find(a => a.startsWith('--ref=')))).toEqual([`--ref=${BASE.branch}`]);
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it('fails closed when a deleted remote ref has unlanded changes absent from the candidate', async () => {
    const f = fixture({ list: ['lane/old'], staleFetchFails: 'lane/old', staleRemoteCode: 2 });
    expect(await f.run()).toMatchObject({ ok: false, registered: false, adopted: false,
      stopReason: 'check-unverifiable', detail: 'could not fetch registered ref lane/old', staleChecks: {} });
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it('rejects deleted remote ref when cached tip predates registered tip', async () => {
    // The cached tip appears contained, but the listing claims a newer, uncontained
    // SHA. The registry has no authoritative tip contract; neither is safe evidence.
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'], staleFetchFails: 'lane/old', staleRemoteCode: 2,
      listRaw: JSON.stringify({ list: [{ ref: 'lane/old', sha: TREE }] }) });
    expect(await f.run()).toMatchObject({ ok: false, registered: false, adopted: false, stopReason: 'check-unverifiable' });
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.registrations.has('lane/old')).toBe(true);
    expect(f.calls.some(c => c.cmd === 'git' && ['cherry', 'rev-parse', 'merge-base'].includes(c.args[0])
      && c.args.some(arg => arg.includes('origin/lane/old')))).toBe(false);
  });
  it.each([0, 1, 128])('fails closed when fetching a registered ref fails and ls-remote exits %s even if containment would pass', async (staleRemoteCode) => {
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'], staleFetchFails: 'lane/old', staleRemoteCode });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'check-unverifiable', detail: 'could not fetch registered ref lane/old' });
    expect(f.calls.filter(c => c.cmd === 'git' && c.args[0] === 'ls-remote' && c.args[1] === '--exit-code')).toHaveLength(1);
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it('does not accept a conflicting JSON check with a no-PR warning exit', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], noPrWarning: 'lane/old' });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'check-unverifiable' });
    expect(mutations(f, 'add')).toEqual([]);
  });
  it('contained stale and clean registrations remain after replacement adoption', async () => {
    const f = fixture({ list: ['lane/old', 'lane/also'], contained: ['lane/old', 'lane/also'], conflicts: ['lane/old'] }); const r = await f.run();
    expect(r).toMatchObject({ ok: false, adopted: true, stopReason: 'swap-remove-failed', detail: 'mutable-registration', removed: [], removedTips: {}, swap: { retained: ['lane/old', 'lane/also'] } });
    expect(r.stale).toEqual([]);
    const index = f.calls.findIndex((c) => c.cmd === 'node' && c.args[1] === 'add' && !c.args.includes('--check'));
    const adopted = f.calls.findLastIndex((c) => c.args[0] === '-C');
    expect(adopted).toBeGreaterThan(index);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(r.fallback).toContain('until their changes land on main');
  });
  // Red-team (PR #5832 round 3): a replacement that fails live adoption must not have already
  // removed the working registrations it was meant to replace.
  const refusedAlert = JSON.stringify({ at: new Date(0).toISOString(), ref: BASE.branch, kind: 'overlay-dropped-smoke-failed' });
  it.each([
    ['refusal alert', { alerts: refusedAlert }, 'adoption-refused'],
    ['refusal event', { events: refusedAlert }, 'adoption-refused'],
    ['timeout', { timeout: true }, null],
    ['probe error 128', { adoptionError: 128 }, 'check-unverifiable'],
    ['probe error -1', { adoptionError: -1 }, 'check-unverifiable'],
    ['unreadable refusal trail', { alertsReadError: true }, 'check-unverifiable'],
  ])('retains every clean prior registration until the replacement is adopted: %s', async (_, options, stopReason) => {
    const f = fixture({ list: ['lane/old', 'lane/also'], contained: ['lane/old', 'lane/also'], ...options });
    const r = await f.run();
    expect(r).toMatchObject({ ok: stopReason === null, stopReason, registered: true, adopted: false, removed: [] });
    expect(mutations(f, 'remove')).toEqual([]);
    expect(r.fallback).toContain('Prior registrations retained: lane/old, lane/also.');
  });
  // A stale preview does not prove the prior live build is dispensable: adoption can still fail.
  it.each([
    ['refusal alert', { alerts: refusedAlert }, 'adoption-refused'],
    ['refusal event', { events: refusedAlert }, 'adoption-refused'],
    ['timeout', { timeout: true }, null],
    ['probe error', { adoptionError: 128 }, 'check-unverifiable'],
    ['unreadable refusal trail', { alertsReadError: true }, 'check-unverifiable'],
  ])('retains stale and clean registrations through failed adoption: %s', async (_, options, stopReason) => {
    const f = fixture({ list: ['lane/old', 'lane/also'], contained: ['lane/old', 'lane/also'], conflicts: ['lane/old'], ...options });
    const r = await f.run();
    expect(r).toMatchObject({ ok: stopReason === null, stopReason, registered: true, adopted: false, removed: [] });
    expect(mutations(f, 'remove')).toEqual([]);
    expect(r.fallback).toContain('Prior registrations retained: lane/old, lane/also.');
    expect(r.staleChecks['lane/old']).toEqual({ skipped: 'contained', included: true, landed: false });
    expect(r.fallback).not.toContain('If stale registrations block adoption');
  });
  it.each([false, true])('retains registrations while adoption is pending and if the wait is interrupted (already registered: %s)', async (already) => {
    const f = fixture({
      list: [...(already ? [BASE.branch] : []), 'lane/old'], contained: ['lane/old'], conflicts: ['lane/old'], timeout: true,
      onSleep() {
        expect(mutations(f, 'remove')).toEqual([]);
        throw new Error('adoption wait interrupted');
      },
    });
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, stopReason: 'check-unverifiable', adopted: false, removed: [], error: 'adoption wait interrupted' });
    expect(mutations(f, 'remove')).toEqual([]);
    expect(r.fallback).toContain('Prior registrations retained: lane/old.');
  });
  it.each([false, true])('retains an established branch that advances beyond the replacement during add (merge: %s)', async (behind) => {
    const f = fixture({ behind, list: ['lane/old'], contained: ['lane/old'], advanceEstablishedDuringAdd: true });
    const r = await f.run();
    expect(mutations(f, 'remove')).toEqual([]);
    // Removal now waits for adoption, so the replacement is adopted before the refresh refuses removal.
    expect(r).toMatchObject({ ok: false, stopReason: 'swap-remove-failed', detail: 'replacement-not-contained', registered: true, adopted: true, removed: [] });
    expect(r.swap).toMatchObject({ failed: 'lane/old', tip: TREE });
    expect(r.fallback).toContain('Retain');
    expect(f.calls.some(c => c.args[0] === '-C')).toBe(true);
  });
  it('refreshes every registration for diagnosis without removing earlier entries', async () => {
    const f = fixture({ list: ['lane/first', 'lane/old'], contained: ['lane/first', 'lane/old'], advanceEstablishedAfterContainment: true });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'swap-remove-failed', detail: 'replacement-not-contained', removed: [], swap: { failed: 'lane/old' } });
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it.each([
    [false, false, 'tip advanced'], [true, false, 'tip advanced'],
    [false, true, 'tip advanced'], [false, false, 'registration replaced'],
  ])('retains registrations that change after final containment (merge: %s, already: %s, change: %s)', async (behind, already, changeAfterContainment) => {
    const f = fixture({ behind, list: [...(already ? [BASE.branch] : []), 'lane/old', 'lane/also'],
      contained: ['lane/old', 'lane/also'], changeAfterContainment });
    const r = await f.run();
    expect(f.lateChanges).toContain(changeAfterContainment);
    expect(r.adopted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe('swap-remove-failed');
    expect(r.detail).toBe('mutable-registration');
    expect(r.removed).toEqual([]);
    expect(r.removedTips).toEqual({});
    expect(mutations(f, 'remove')).toEqual([]);
    expect(r.fallback).toContain('Prior registrations retained: lane/old, lane/also.');
    expect(f.records[0]).toMatchObject({ ok: false, adopted: true, removed: [], removedTips: {} });
    expect([...f.registrations.keys()]).toContain('lane/old');
    if (changeAfterContainment === 'registration replaced') expect(f.registrations.get('lane/old').reason).toBe('concurrent writer');
  });
  it('refreshes containment when the replacement is already registered', async () => {
    const f = fixture({ list: [BASE.branch, 'lane/old'], contained: ['lane/old'], advanceEstablishedBeforeSwap: true });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'swap-remove-failed', registered: 'already', removed: [] });
    expect(mutations(f, 'add')).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it.each(['fetch', 'tip', 'invalid-tip', 'ancestry'])('retains prior registrations when fresh containment cannot be proved: %s', async (refreshError) => {
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'], refreshError });
    // Adoption precedes removal; the unprovable containment still blocks every removal.
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'swap-remove-failed', registered: true, adopted: true, removed: [] });
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it('retains even an advanced registration whose observed tip is still contained', async () => {
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'], advanceEstablishedDuringAdd: true, advancedContained: true });
    expect(await f.run()).toMatchObject({ ok: false, adopted: true, removed: [], detail: 'mutable-registration' });
    expect(f.calls.some(c => c.args.join(' ') === `merge-base --is-ancestor ${TREE} ${SHA}`)).toBe(true);
  });
  it('check-conflict preserves files and conflicting registrations', async () => {
    const f = fixture({ conflicts: [BASE.branch] }); const r = await f.run(); expect(r.stopReason).toBe('check-conflict'); expect(r.check.files).toEqual(['x']); expect(r.check.conflicting).toEqual([{ ref: 'lane/other' }]);
  });
  it.each([BASE.branch, 'lane/old'])('check-unverifiable refuses incomplete candidate or established evidence: %s', async (unverifiable) => {
    const f = fixture({ unverifiable, list: ['lane/old'] }); expect((await f.run()).stopReason).toBe('check-unverifiable'); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('register-failed never removes anything', async () => {
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'], addFails: true }); const r = await f.run(); expect(r.stopReason).toBe('register-failed'); expect(mutations(f, 'remove')).toHaveLength(0); expect(f.calls.some((c) => c.args[0] === '-C')).toBe(false);
  });
  it.each([false, true])('sha-moved stops before add or removal (generated merge: %s)', async (behind) => {
    const f = fixture({ behind, advanceAfterCheck: true, list: ['lane/old'], contained: ['lane/old'] });
    const r = await f.run();
    expect(r).toMatchObject({ stopReason: 'no-ready', detail: 'sha-moved', registered: false, adopted: false });
    expect(mutations(f, 'add')).toEqual([]); expect(mutations(f, 'remove')).toEqual([]);
    expect(f.calls.some((c) => c.args[0] === '-C')).toBe(false);
    expect(f.records[0].detail).toBe('sha-moved');
  });
  it('unreadable tip before real add fails closed', async () => {
    const f = fixture({ tipReadFails: true });
    expect((await f.run()).stopReason).toBe('no-ready');
    expect(mutations(f, 'add')).toEqual([]);
  });
  it('swap-remove-failed never invokes the unsafe removal CLI or rolls back adoption', async () => {
    const f = fixture({ list: ['lane/a', 'lane/b', 'lane/c'], contained: ['lane/a', 'lane/b', 'lane/c'], removeFails: 'lane/b' });
    const r = await f.run(); expect(r.stopReason).toBe('swap-remove-failed'); expect(r.registered).toBe(true); expect(r.adopted).toBe(true); expect(r.removed).toEqual([]); expect(r.swap.retained).toEqual(['lane/a', 'lane/b', 'lane/c']); expect(mutations(f, 'remove')).toHaveLength(0);
  });
  it('adoption-timeout bounds injected polling and retains registration', async () => {
    const f = fixture({ timeout: true }); const r = await f.run(); expect(r.result).toBe('registered-pending'); expect(r.registered).toBe(true); expect(r.adopted).toBe(false); expect(f.sleeps).toEqual([10, 10, 10]);
  });
  it('returns registered-pending at once by default: ok, not adopted, no polling, no FAIL', async () => {
    const f = fixture({ timeout: true }); const r = await f.run({ waitAdoptionMs: undefined });
    expect(r).toMatchObject({ ok: true, result: 'registered-pending', registered: true, adopted: false, stopReason: null });
    expect(r.message).toContain('overlay-adopted');
    expect(f.sleeps).toEqual([]);
  });
  it.each([[false, undefined], [true, undefined], [false, 30]])('wires loader registration to a rebuild adoption event (generated merge: %s, wait: %s)', async (behind, waitAdoptionMs) => {
    const dir = mkdtempSync(join(tmpdir(), 'load-pending-'));
    const env = { WE_DAEMON_OVERLAY_DIR: dir };
    try {
      const f = fixture({ timeout: true, behind, pendingFs: nodeFs, env });
      const r = await f.run({ waitAdoptionMs });
      expect(r).toMatchObject({ ok: true, result: 'registered-pending', adoptionEventTracked: true,
        clone: '/home/test/workspace/wev-control', effectiveRef: behind ? 'lane/new-m1' : BASE.branch, effectiveSha: behind ? MERGE : SHA });
      expect(r.message).toContain('up to 7 days');
      expect(r.message).toContain('newest 128 registrations');
      expect(r.message).toContain('check the daemon rebuild state');
      expect(readPendingAdoptions(r.clone, { env })).toEqual([expect.objectContaining({ ref: r.effectiveRef, sha: r.effectiveSha, loadedBy: 'tester' })]);
      const events = [];
      const isAncestor = vi.fn(() => true);
      await checkPendingAdoptions({ root: r.clone, env, now: () => 0, daemon: BASE.daemon, isAncestor, emit: (e) => events.push(e) });
      expect(isAncestor).toHaveBeenCalledWith(r.clone, r.effectiveSha);
      expect(events).toEqual([expect.objectContaining({ kind: 'overlay-adopted', daemon: BASE.daemon,
        detail: expect.objectContaining({ ref: r.effectiveRef, sha: r.effectiveSha }) })]);
      expect(readPendingAdoptions(r.clone, { env })).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('warns when the pending-adoption tracking write fails', async () => {
    const r = await fixture({ timeout: true }).run({ waitAdoptionMs: undefined });
    expect(r.adoptionEventTracked).toBe(false);
    expect(r.message).toContain('pending-adoption record could not be written');
    expect(r.message).toContain('no overlay-adopted event will follow');
  });
  it.each([
    ['adoption-refused', { alerts: JSON.stringify({ at: new Date(0).toISOString(), ref: BASE.branch, kind: 'conflict-dropped' }) }, false],
    ['check-unverifiable', { adoptionError: 2 }, false],
    ['adopted immediately', {}, true],
    ['adopted in wait', { timeout: true }, true],
    ['adopted before swap refusal', { list: ['lane/old'], contained: ['lane/old'] }, true],
  ])('clears pending adoption on terminal outcome: %s', async (_, options, adopted) => {
    const dir = mkdtempSync(join(tmpdir(), 'load-terminal-'));
    const env = { WE_DAEMON_OVERLAY_DIR: dir };
    const clone = '/home/test/workspace/wev-control';
    try {
      recordPendingAdoption(clone, { ref: 'lane/unrelated', sha: TREE, at: new Date(0).toISOString() }, { env });
      const writes = vi.fn(nodeFs.renameSync);
      const loadOptions = { ...options, pendingFs: { ...nodeFs, renameSync: writes }, env };
      if (options.timeout) loadOptions.onSleep = () => {
        // Prove that this is adoption during the wait, with the registration already persisted.
        expect(readPendingAdoptions(clone, { env })).toEqual(expect.arrayContaining([
          expect.objectContaining({ ref: BASE.branch, sha: SHA }),
        ]));
        loadOptions.timeout = false;
      };
      const f = fixture(loadOptions);
      const r = await f.run();
      expect(r.registered).toBe(true);
      expect(r.adoptionEventTracked).toBe(true);
      expect(r.adopted).toBe(adopted);
      expect(f.sleeps).toEqual(options.timeout ? [10] : []);
      if (options.adoptionError) expect(r.stopReason).toBe('check-unverifiable');
      if (options.alerts) expect(r.stopReason).toBe('adoption-refused');
      expect(writes).toHaveBeenCalled();
      expect(readPendingAdoptions(clone, { env }).map((rec) => rec.ref)).toEqual(['lane/unrelated']);
      const events = [];
      await checkPendingAdoptions({ root: clone, env, now: () => 16 * 60000, isAncestor: () => true, emit: (e) => events.push(e) });
      expect(events.map((e) => e.detail.ref)).toEqual(['lane/unrelated']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ['bad-sha', { sha: 'abc1234' }, {}, 'full 40-character sha'],
    ['bad-branch', { branch: 'main' }, {}, 'Pass --branch=lane/<name>'],
    ['bad-adoption-settings', {}, { adoption: { timeoutMs: -1, pollMs: 10 } }, 'adoption.timeoutMs and adoption.pollMs'],
    ['bad-adoption-settings', {}, { adoption: { timeoutMs: 30, pollMs: 0 } }, 'adoption.timeoutMs and adoption.pollMs'],
    ['bad-adoption-settings', {}, { adoption: { timeoutMs: Infinity, pollMs: 10 } }, 'adoption.timeoutMs and adoption.pollMs'],
    ['bad-adoption-settings', {}, { adoption: { timeoutMs: 30, pollMs: NaN } }, 'adoption.timeoutMs and adoption.pollMs'],
    ['bad-wait-adoption-ms', { waitAdoptionMs: -1 }, {}, 'number of milliseconds'],
    ['bad-wait-adoption-ms', { waitAdoptionMs: 'NaN' }, {}, 'number of milliseconds'],
    ['bad-wait-adoption-ms', { waitAdoptionMs: 'Infinity' }, {}, 'number of milliseconds'],
  ])('explains bad-input refusal %s (%j, %j)', async (detail, input, overrides, fallback) => {
    const f = fixture({ settings: overrides });
    expect(await f.run(input)).toMatchObject({ ok: false, stopReason: 'bad-input', detail, fallback: expect.stringContaining(fallback) });
    expect(f.calls).toEqual([]);
  });
  it('--wait-adoption-ms opts into a bounded wait and is capped under 170 s', async () => {
    const f = fixture({ timeout: true, settings: { adoption: { timeoutMs: 600000, pollMs: 50000 } } });
    const r = await f.run({ waitAdoptionMs: 900000 });
    expect(r).toMatchObject({ ok: true, result: 'registered-pending' });
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(160000);
    expect(f.sleeps.length).toBeGreaterThan(0);
  });
  it('explains refusals in plain words', async () => {
    expect(await fixture({}).run({ sha: 'abc1234' })).toMatchObject({ stopReason: 'bad-input', fallback: expect.stringContaining('full 40-character sha') });
    const noReady = await fixture({ ready: '' }).run();
    expect(noReady.stopReason).toBe('no-ready'); expect(noReady.fallback).toMatch(/fix-ready record.*"tests":"green".*"audit":"NOT WEAKENED"/);
    const moved = await fixture({ tip: 'e'.repeat(40) }).run();
    expect(moved).toMatchObject({ stopReason: 'no-ready', fallback: expect.stringContaining(`branch tip is ${'e'.repeat(40)}`) });
  });
  it.each([undefined, '/custom/rebuild-state'])('adoption timeout reports the active build from the daemon state directory: %s', async (directory) => {
    const target = 'd'.repeat(40), startedAt = '2026-10-26T11:59:00.000Z';
    const f = fixture({ timeout: true, env: directory ? { WE_DAEMON_STATE_DIR: directory } : {},
      rebuildState: { building: { target, startedAt, pid: 123 } } });
    const r = await f.run();
    expect(r).toMatchObject({ ok: true, result: 'registered-pending', registered: true, adopted: false,
      adoption: { reason: 'rebuild-building' } });
    expect(r.fallback).toContain(target.slice(0, 7));
    expect(r.fallback).toContain(startedAt);
    expect(r.fallback).toContain('building');
    expect(f.reads).toContain(`${directory || '/home/test/.claude/daemon-self-sync-state'}/test-clone-key.rebuild.json`);
    expect(f.sleeps).toEqual([10, 10, 10]);
  });
  it.each([{}, { building: null }])('adoption timeout names an idle daemon and suggests catch-up with the last adoption: %j', async (state) => {
    const adoptedAt = '2026-10-26T11:00:00.000Z';
    const f = fixture({ timeout: true, rebuildState: { ...state, adopted: { at: adoptedAt, head: TREE } } });
    const r = await f.run();
    expect(r).toMatchObject({ ok: true, result: 'registered-pending', registered: true, adopted: false,
      adoption: { reason: 'daemon-not-refreshing' } });
    expect(r.fallback).toContain('catch-up');
    expect(r.fallback).toContain(adoptedAt);
    expect(f.reads).toContain('/home/test/.claude/daemon-self-sync-state/test-clone-key.rebuild.json');
  });
  it.each([
    ['missing', {}],
    ['permission denied', { rebuildStateReadError: true }],
    ['malformed JSON', { rebuildStateRaw: '{broken' }],
  ])('adoption timeout reports unreadable rebuild evidence: %s', async (_, options) => {
    const f = fixture({ timeout: true, ...options });
    const r = await f.run();
    expect(r).toMatchObject({ ok: true, result: 'registered-pending', registered: true, adopted: false,
      adoption: { reason: 'rebuild-state-unreadable' } });
    expect(r.fallback).toMatch(/rebuild.state.*unreadable|unreadable.*rebuild.state/i);
    expect(f.reads).toContain('/home/test/.claude/daemon-self-sync-state/test-clone-key.rebuild.json');
  });
  it('waits for a missing daemon commit to become available before adoption', async () => {
    const f = fixture({ missingCandidate: true });
    expect(await f.run()).toMatchObject({ ok: true, registered: true, adopted: true });
    expect(f.sleeps).toEqual([10]);
  });
  it('a missing daemon commit remains pending until the adoption deadline', async () => {
    const f = fixture({ missingCandidate: true, missingForever: true });
    expect(await f.run()).toMatchObject({ ok: true, result: 'registered-pending', registered: true, adopted: false });
    expect(f.sleeps).toEqual([10, 10, 10]);
  });
  it.each([false, true])('real Git keeps a fresh origin commit pending until daemon fetch/adoption or deadline (adopts: %s)', async (adopts) => {
    await withBareOrigin(async ({ origin, clone, seedOriginBranch, git }) => {
      seedOriginBranch(BASE.branch, { 'fresh.txt': 'fresh fix\n' });
      const sha = git(['rev-parse', `refs/heads/${BASE.branch}`], { cwd: origin }).trim();
      const initial = () => execFileSync('git', ['-C', clone, 'merge-base', '--is-ancestor', sha, 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
      expect(initial).toThrow(/Command failed/);
      const f = fixture({ sha,
        adoptionExec: (args, config) => execFileSync('git', ['-C', clone, ...args.slice(2)], { ...config, env: { ...config.env, PATH: process.env.PATH } }),
        onSleep: () => { if (adopts) { git(['fetch', 'origin', BASE.branch]); git(['merge', '--ff-only', 'FETCH_HEAD']); } },
      });
      expect(await f.run()).toMatchObject(adopts
        ? { ok: true, registered: true, adopted: true }
        : { ok: true, registered: true, adopted: false, result: 'registered-pending' });
      expect(f.sleeps).toEqual(adopts ? [10] : [10, 10, 10]);
    });
  });
  it.each([{ adoptionError: 128 }, { adoptionError: -1 }, { missingCandidate: true, badHead: true }])('fails closed on unrelated adoption probe failures: %j', async (options) => {
    const f = fixture(options);
    expect((await f.run()).stopReason).toBe('check-unverifiable');
    expect(f.sleeps).toEqual([]);
  });
  it.each([0, 1])('retries ancestry when a daemon fetch completes during missing-object diagnosis (retry exit: %s)', async (retryCode) => {
    let probes = 0;
    const f = fixture({ adoptionExec: (args) => {
      if (args[2] === 'rev-parse') return SHA;
      probes++;
      if (probes === 1) throw Object.assign(new Error('missing before fetch'), { status: 128 });
      if (retryCode === 1) throw Object.assign(new Error('not adopted yet'), { status: 1 });
      return '';
    } });
    expect(await f.run()).toMatchObject(retryCode === 0
      ? { ok: true, registered: true, adopted: true }
      : { ok: true, result: 'registered-pending', registered: true, adopted: false });
    expect(probes).toBe(retryCode === 0 ? 2 : 5);
    expect(f.sleeps).toEqual(retryCode === 0 ? [] : [10, 10, 10]);
  });
  it.each([false, true])('binds add admission to the approved SHA despite a racing branch advance (merge: %s)', async (behind) => {
    const f = fixture({ behind, advanceDuringAdd: true, list: ['lane/old'], contained: ['lane/old'] });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'register-failed', adopted: false });
    expect(f.admitted).toEqual([]);
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.calls.some((c) => c.args[0] === '-C')).toBe(false);
  });
  it.each(['{}', '{broken', JSON.stringify({ conflictCheck: { ok: true, clean: true, candSha: TREE } })])('refuses incomplete or mismatched add evidence before replacing prior registrations: %s', async (addRaw) => {
    const f = fixture({ addRaw, list: ['lane/old'], contained: ['lane/old'] });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'register-failed', adopted: false });
    expect(mutations(f, 'remove')).toEqual([]);
  });
  it.each(['refuse', ' refuse '])('preserves restrictive no-PR policy through the real resolver: %s', async (value) => {
    const f = fixture({ env: { WE_OVERLAY_NO_PR: value } });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'check-unverifiable', registered: false, adopted: false });
    expect(f.admitted).toEqual([]);
    expect(mutations(f, 'add')).toEqual([]);
    expect(f.calls.find((c) => c.cmd === 'node').config.env.WE_OVERLAY_NO_PR).toBe('refuse');
  });
  it.each(['warn', '', 'invalid'])('does not forward a weaker no-PR override over a restrictive file policy: %s', async (value) => {
    const f = fixture({ env: { WE_OVERLAY_NO_PR: value }, safetySettings: { overlaySafety: { noPr: 'refuse' } } });
    expect(await f.run()).toMatchObject({ ok: false, registered: false, adopted: false });
    expect(f.admitted).toEqual([]);
    expect(f.calls.every((call) => !Object.hasOwn(call.config.env, 'WE_OVERLAY_NO_PR'))).toBe(true);
  });
  it.each(['alerts', 'events'])('adoption-refused reads %s and stops even if HEAD contains candidate', async (file) => {
    const f = fixture({ [file]: JSON.stringify({ at: new Date(0).toISOString(), ref: BASE.branch, kind: 'conflict-dropped' }) }); expect((await f.run()).stopReason).toBe('adoption-refused');
  });
  it.each([undefined, '/custom/overlays', '~/custom-overlays'])('reads refusal files with injected clone key and overlay directory: %s', async (directory) => {
    const f = fixture({ env: directory ? { WE_DAEMON_OVERLAY_DIR: directory } : {} });
    expect((await f.run()).ok).toBe(true);
    expect(f.cloneRoots).toEqual(['/home/test/workspace/wev-control']);
    const root = directory === '~/custom-overlays' ? '/home/test/custom-overlays' : directory || '/home/test/.claude/daemon-overlays';
    expect(f.reads).toContain(`${root}/test-clone-key.alerts.jsonl`);
    expect(f.reads).toContain(`${root}/test-clone-key.events.jsonl`);
  });
  it('uses the loader argv contract for checks, list and add while refusing unsafe cleanup', async () => {
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'] });
    expect(await f.run({ why: 'tested change' })).toMatchObject({ ok: false, adopted: true, detail: 'mutable-registration' });
    const calls = f.calls.filter((c) => c.cmd === 'node').map((c) => c.args.slice(1));
    const clone = '--clone=/home/test/workspace/wev-control';
    expect(calls).toEqual([
      ['add', clone, '--ref=lane/new', '--check', `--expected-sha=${SHA}`, '--json'],
      ['list', clone, '--json'],
      ['add', clone, '--ref=lane/new', `--expected-sha=${SHA}`, '--reason=tested change', '--by=tester', '--json'],
    ]);
    const addIndex = f.calls.findIndex((c) => c.cmd === 'node' && c.args.includes('--by=tester'));
    expect(f.calls.slice(addIndex - 2, addIndex).map((c) => c.args)).toEqual([
      ['fetch', 'origin', BASE.branch], ['rev-parse', `origin/${BASE.branch}`],
    ]);
  });
  it('ignores old refusals and unrelated events', async () => {
    const f = fixture({ events: JSON.stringify({ at: new Date(-1).toISOString(), ref: BASE.branch, event: 'removed' }), alerts: JSON.stringify({ at: new Date(0).toISOString(), ref: 'lane/else', event: 'refused' }) }); expect((await f.run()).ok).toBe(true);
  });
  // R310 (incident 2026-11-01): a superseded registration and old tops froze two daemons for hours.
  describe('auto-retire and replace (R310)', () => {
    const retireOld = (extra = {}) => ({ retirePlan: ({ rows }) => rows.map((row) => (row.ref === 'lane/old'
      ? { ref: 'lane/old', action: 'retire', reason: 'superseded', tip: TREE, pr: 6056, evidence: { supersededBy: 6132 }, ...extra }
      : { ref: row.ref, action: 'keep', reason: 'unique-commits-not-on-main' })) });
    it('retires a proved registration before staleness checks, so it no longer blocks the load', async () => {
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], staleChanged: { 'lane/old': 'M\0x\0' }, ...retireOld() });
      const r = await f.run();
      expect(r).toMatchObject({ ok: true, adopted: true, retired: [{ ref: 'lane/old', reason: 'superseded', tip: TREE, pr: 6056 }], stale: [] });
      expect(f.retirePlanner).toHaveBeenCalledWith(expect.objectContaining({ rows: [{ ref: 'lane/old' }] }));
      const [call] = mutations(f, 'retire');
      expect(call.args).toEqual(expect.arrayContaining(['--ref=lane/old', `--expected-tip=${TREE}`, `--expected-entry=${JSON.stringify({ ref: 'lane/old' })}`, '--reason=superseded']));
      expect(r.staleChecks).toEqual({});
    });
    it('the same blocked load without a proved retirement still stops on the stale registration', async () => {
      const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], staleChanged: { 'lane/old': 'M\0x\0' } });
      expect(await f.run()).toMatchObject({ ok: false, stopReason: 'stale-registration', retired: [] });
      expect(mutations(f, 'retire')).toEqual([]);
    });
    it('settles drop intents left by an interrupted retire before planning', async () => {
      const f = fixture({ list: ['lane/old'], contained: ['lane/old'], pendingDrops: '{"pending":[{"ref":"lane/x"}]}' });
      await f.run();
      expect(f.reads).toContain('/home/test/.claude/daemon-overlays/test-clone-key.json.drop-pending');
      expect(mutations(f, 'recover-drops')).toHaveLength(1);
      expect(f.records[0]).toMatchObject({ dropRecovery: { settled: [{ ref: 'lane/x', outcome: 'restored' }] } });
      // The settle runs before the listing, so a restored registration takes part in every later check.
      const settleAt = f.calls.findIndex((c) => c.cmd === 'node' && c.args[1] === 'recover-drops');
      expect(settleAt).toBeLessThan(f.calls.findIndex((c) => c.cmd === 'node' && c.args[1] === 'list'));
      const quiet = fixture({ list: ['lane/old'], contained: ['lane/old'] });
      await quiet.run();
      expect(mutations(quiet, 'recover-drops')).toEqual([]);
    });
    it('stops before planning or registering when drop intents stay unsettled', async () => {
      const f = fixture({ list: ['lane/old'], pendingDrops: '{"pending":[{"ref":"lane/x"}]}', recoverRaw: JSON.stringify({ settled: [], pending: [{ ref: 'lane/x' }] }), ...retireOld() });
      expect(await f.run()).toMatchObject({ ok: false, stopReason: 'drop-recovery-failed', registered: false });
      expect(f.retirePlanner).not.toHaveBeenCalled();
      expect(mutations(f, 'add')).toEqual([]);
    });
    it('dry-run reports wouldRetire and retires nothing', async () => {
      const f = fixture({ list: ['lane/old'], ...retireOld() });
      expect(await f.run({ dryRun: true })).toMatchObject({ ok: true, wouldRetire: [{ ref: 'lane/old', reason: 'superseded', tip: TREE }] });
      expect(mutations(f, 'retire')).toEqual([]);
      expect(f.registrations.has('lane/old')).toBe(true);
    });
    it('stops without registering when the loader refuses a proved retirement', async () => {
      const f = fixture({ list: ['lane/old'], retireRefuses: 'lane/old', ...retireOld() });
      expect(await f.run()).toMatchObject({ ok: false, stopReason: 'retire-refused', retireRefused: [{ ref: 'lane/old', refused: 'tip-moved' }], registered: false });
      expect(mutations(f, 'add')).toEqual([]);
    });
    it('ignores planner decisions for unlisted refs, the candidate itself, or without a full tip', async () => {
      const f = fixture({ list: ['lane/old'], contained: ['lane/old'], retirePlan: () => [
        { ref: 'lane/ghost', action: 'retire', reason: 'in-main', tip: TREE },
        { ref: 'lane/old', action: 'retire', reason: 'in-main', tip: 'short' },
      ] });
      await f.run();
      expect(mutations(f, 'retire')).toEqual([]);
      expect(f.retirePlanner.mock.calls[0][0].rows.map((row) => row.ref)).not.toContain(BASE.branch);
    });
    it('retire-only mode drops proved registrations with no candidate and no ready record', async () => {
      const f = fixture({ list: ['lane/old', 'lane/live'], ready: '', ...retireOld() });
      const r = await f.run({ branch: '', sha: '', retire: true });
      expect(r).toMatchObject({ ok: true, retired: [{ ref: 'lane/old' }], registered: false });
      expect([...f.registrations.keys()]).toEqual(['lane/live']);
      expect(mutations(f, 'add')).toEqual([]);
    });
    it('replace swaps a contained old top in one loader command, with no retained-registration stop', async () => {
      const f = fixture({ list: ['lane/old'], contained: ['lane/old'] });
      const r = await f.run({ replace: 'lane/old' });
      expect(r).toMatchObject({ ok: true, adopted: true, replaced: 'lane/old', registered: true, stopReason: null });
      expect(mutations(f, 'add')).toEqual([]);
      expect(mutations(f, 'remove')).toEqual([]);
      expect(mutations(f, 'replace')[0].args).toEqual(expect.arrayContaining(['--ref=lane/new', '--replaces=lane/old', `--expected-sha=${SHA}`]));
      expect([...f.registrations.keys()]).toEqual(['lane/new']);
    });
    it('replace refuses an old top whose commits the new top lacks, and changes nothing', async () => {
      const f = fixture({ list: ['lane/old'] });
      expect(await f.run({ replace: 'lane/old' })).toMatchObject({ ok: false, stopReason: 'replace-not-contained', registered: false });
      expect(mutations(f, 'replace')).toEqual([]);
      expect([...f.registrations.keys()]).toEqual(['lane/old']);
    });
    it('replace refuses an unregistered old ref', async () => {
      const f = fixture({ list: [] });
      expect(await f.run({ replace: 'lane/old' })).toMatchObject({ ok: false, stopReason: 'bad-input' });
      expect(mutations(f, 'replace')).toEqual([]);
    });
  });
  it('happy path pins full command sequence, safe env and recorded provenance', async () => {
    const f = fixture(); const r = await f.run({ why: 'load tested patch' }); expect(r).toMatchObject({ ok: true, registered: true, adopted: true, stopReason: null, cloneSource: 'settings:prototype-load.json#daemons.control.clone' });
    expect(f.calls.map((c) => c.cmd === 'node' ? `${c.args[1]}${c.args.includes('--check') ? ':check' : ''}` : c.args[0])).toEqual(['fetch', 'rev-parse', 'fetch', 'diff', 'merge-base', 'diff', 'add:check', 'list', 'fetch', 'rev-parse', 'add', '-C']);
    expect(f.records[0]).toMatchObject({ path: '/home/test/records', daemon: 'control', branch: BASE.branch, sha: SHA, effectiveRef: BASE.branch, effectiveSha: SHA, dryRun: false, ok: true, registered: true, adopted: true, why: 'load tested patch' });
    expect(r.settings.sources['daemons.control.clone']).toBe('tool'); expect(r.settings.log).toContain('wev-control');
  });
  it('already registered is idempotent but still waits for adoption', async () => {
    const f = fixture({ list: [BASE.branch] }); expect((await f.run()).registered).toBe('already'); expect(mutations(f, 'add')).toHaveLength(0); expect(f.calls.at(-1).args[0]).toBe('-C');
  });
  it('dry-run checks original ref and records without push/add/remove or adoption', async () => {
    const f = fixture({ behind: true, list: ['lane/old'], contained: ['lane/old'] }); const r = await f.run({ dryRun: true }); expect(r.ok).toBe(true); expect(r.wouldMerge.ref).toBe('lane/new-m1'); expect(r.wouldRegister).toBe(true); expect(r.effectiveRef).toBe(BASE.branch); expect(r.wouldRemove).toEqual([]); expect(r.wouldRetain).toEqual(['lane/old']); expect(r.wouldStopReason).toBe('swap-remove-failed');
    expect(f.calls.some((c) => ['push', 'commit-tree', '-C'].includes(c.args[0]))).toBe(false); expect(mutations(f, 'add')).toHaveLength(0); expect(mutations(f, 'remove')).toHaveLength(0); expect(f.records[0].dryRun).toBe(true);
  });
  it('resolves plist WorkingDirectory with logged source', async () => { const f = fixture(); const r = await f.run({ daemon: 'review' }); expect(r.cloneSource).toBe('plist:com.we.review-daemon'); expect(r.clone).toBe('/home/test/workspace/review'); expect(f.calls[0].cmd).toBe('plutil'); });
  it('drain override selects CODE clone without reading plist', async () => { const f = fixture(); const r = await f.run({ daemon: 'drain' }); expect(r.clone).toBe('/home/test/workspace/.lanes/we-drain-daemon/code'); expect(f.calls.some((c) => c.cmd === 'plutil')).toBe(false); });
  it('unknown-daemon records without executing anything', async () => { const f = fixture(); expect((await f.run({ daemon: 'unknown' })).stopReason).toBe('unknown-daemon'); expect(f.calls).toHaveLength(0); expect(f.records).toHaveLength(1); });
  it('unreadable readiness fails closed and records the read failure', async () => {
    const f = fixture({ readError: true }); expect((await f.run()).stopReason).toBe('no-ready'); expect(f.calls).toHaveLength(0); expect(f.records[0].error).toContain('permission denied');
  });
  it.each([{ listRaw: '{}' }, { listRaw: '{broken' }, { checkRaw: '{"check":{"ok":true,"clean":false}}' }])('incomplete loader evidence refuses admission: %j', async (options) => {
    const f = fixture(options); expect((await f.run()).stopReason).toBe('check-unverifiable'); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('oversized subprocess output fails closed with an operator fallback', async () => {
    const f = fixture({ execFailure: 'diff' }); const r = await f.run(); expect(r.stopReason).toBe('check-unverifiable'); expect(r.error).toContain('maxBuffer'); expect(r.fallback).toContain('Inspect'); expect(mutations(f, 'add')).toHaveLength(0);
    expect(f.calls.every((c) => c.config.maxBuffer > 0 && c.config.timeout > 0)).toBe(true);
  });
  it('dry-run preserves already registered evidence', async () => {
    const f = fixture({ list: [BASE.branch] }); const r = await f.run({ dryRun: true }); expect(r.registered).toBe('already'); expect(r.wouldRegister).toBe(false); expect(mutations(f, 'add')).toHaveLength(0);
  });
  it('pure comparison handles renames, copies and exact path equality', () => {
    expect(changedPaths('R100\0old path\0new path\0C80\0from\0to\0')).toEqual(['from', 'new path', 'old path', 'to']);
    expect(comparePaths(['x'], ['y'])).toEqual({ outside: ['y'], missing: ['x'] });
    expect(nextMergeRef(BASE.branch, `${SHA}\trefs/heads/lane/new-m9\n${SHA}\trefs/heads/lane/new-mabc`)).toBe('lane/new-m10');
    expect(() => changedPaths('M\0')).toThrow();
  });
  it('declaration exposes verdict and marks transaction as writing', () => {
    const declaration = prototypeLoadOperation(); expect(declaration.name).toBe('prototype-load'); expect(declaration.verdictFrom).toBe('assess');
  });
  it('derived CLI and engine await the transaction and publish its JSON verdict', async () => {
    const f = fixture({ ready: '' });
    const declaration = prototypeLoadOperation();
    const argv = [`--branch=${BASE.branch}`, `--sha=${SHA}`, '--daemon=control', '--tests-run=case-1', '--audit=NOT WEAKENED', '--dry-run', '--json'];
    const parsed = parseOperationArgv(declaration, argv);
    expect(parsed.errors).toEqual([]);
    const registry = createRegistry(); registry.register(declaration);
    let run = startRun({ op: declaration.name, id: 'prototype-test', input: parsed.input, registry });
    run = advance(run, { registry });
    expect(f.calls).toHaveLength(0);
    run = (await applyPendingEffects(run, { store: createMemoryRunStore(), sinks: { [PROTOTYPE_LOAD_EFFECT]: (input) => f.run(input) } })).run;
    run = advance(run, { registry }); run = advance(run, { registry });
    expect(run.verdict).toMatchObject({ ok: true, dryRun: true, registered: false, adopted: false });
    expect(JSON.parse(JSON.stringify(run.verdict)).gate.testsRun).toBe('case-1');
  });
  it('publishes incomplete cleanup through the declared operation without losing adoption evidence', async () => {
    const f = fixture({ list: ['lane/old'], contained: ['lane/old'], changeAfterContainment: 'tip advanced' });
    const declaration = prototypeLoadOperation();
    const registry = createRegistry(); registry.register(declaration);
    const parsed = parseOperationArgv(declaration, [`--branch=${BASE.branch}`, `--sha=${SHA}`, '--daemon=control', '--json']);
    let run = startRun({ op: declaration.name, id: 'prototype-retention-test', input: parsed.input, registry });
    run = advance(run, { registry });
    run = (await applyPendingEffects(run, { store: createMemoryRunStore(), sinks: { [PROTOTYPE_LOAD_EFFECT]: (input) => f.run(input) } })).run;
    run = advance(run, { registry }); run = advance(run, { registry });
    expect(run.verdict).toMatchObject({ ok: false, adopted: true, stopReason: 'swap-remove-failed', detail: 'mutable-registration', removed: [], removedTips: {} });
    expect(mutations(f, 'remove')).toEqual([]);
    expect(f.registrations.has('lane/old')).toBe(true);
  });
});
