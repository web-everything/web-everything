/**
 * @file Hermetic prototype admission proofs.
 * WHY (incident 2026-10-22): pin main preservation, ready evidence, adopt-before-remove, stale
 * replacement, and adoption refusal with injected doubles, plus real filesystem refusal persistence.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { withRealRepo, withBareOrigin } from './helpers/real-repo.mjs';
import { createPrototypeLoader, defaultDeps } from '../prototype-load-io.mjs';
import { changedPaths, comparePaths, nextMergeRef, prototypeLoadOperation, PROTOTYPE_LOAD_EFFECT } from '../prototype-load.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun, advance } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
import { overlaySafetySettings } from '../../lib/daemon-load-overlay.mjs';
const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40), MERGE = 'c'.repeat(40);
const BASE = { branch: 'lane/new', sha: SHA, daemon: 'control' };
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
      const e = new Error('missing'); e.code = 'ENOENT'; throw e;
    },
    mkdirSync() {}, appendFileSync(p, line) { records.push({ path: p, ...JSON.parse(line) }); },
  };
  const fail = (status, stdout = '', stderr = 'failed') => { throw Object.assign(new Error(stderr), { status, stdout, stderr }); };
  const exec = (cmd, args, config) => {
    calls.push({ cmd, args, config });
    expect(args.join(' ')).not.toMatch(/--allow-conflict|--force|--allow-no-pr/);
    expect(Object.keys(config.env).sort()).toEqual(['HOME', 'PATH', 'USER', ...(env.WE_DAEMON_OVERLAY_DIR ? ['WE_DAEMON_OVERLAY_DIR'] : []), ...(env.WE_OVERLAY_NO_PR?.trim() === 'refuse' ? ['WE_OVERLAY_NO_PR'] : [])]);
    if (options.execFailure === args[0]) throw Object.assign(new Error('maxBuffer exceeded; inspect full output separately'), { code: 'ENOBUFS' });
    if (cmd === 'plutil') return JSON.stringify({ WorkingDirectory: '/home/test/workspace/review' });
    if (cmd === 'node') {
      const action = args[1], ref = args.find((a) => a.startsWith('--ref='))?.slice(6);
      if (action === 'list') return options.listRaw ?? JSON.stringify({ list: [...registrations.values()] });
      if (action === 'add' && overlaySafetySettings(config.env, { readSettings: () => options.safetySettings || {} }).noPr === 'refuse') {
        return fail(3, JSON.stringify({ check: { ok: false, reason: 'no-pr' }, wouldRegister: false }));
      }
      if (args.includes('--check')) {
        if (options.checkRaw) return options.checkRaw;
        if (options.unverifiable === ref) return fail(1, JSON.stringify({ check: { ok: false } }));
        const clean = !(options.conflicts || []).includes(ref);
        const data = JSON.stringify({ check: { ok: true, clean, candSha: remoteTip, ...(clean ? {} : { files: options.checkFiles?.[ref] ?? ['x'], conflicting: [{ ref: 'lane/other' }] }) }, wouldRegister: clean });
        if (options.advanceAfterCheck && ref === (options.behind ? 'lane/new-m1' : BASE.branch)) remoteTip = TREE;
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
    if (args[0] === 'merge-tree') return options.mergeConflict ? fail(1, `${TREE}\n100644 ${SHA} 1\tx\nCONFLICT (content): Merge conflict in x\n`) : TREE;
    if (args[0] === 'ls-remote') return options.remote || '';
    if (args[0] === 'commit-tree') return MERGE;
    if (args[0] === 'push') { remoteTip = MERGE; return ''; }
    throw new Error(`unexpected command ${cmd} ${args}`);
  };
  const combinedTest = vi.fn(async (input) => typeof options.combinedTest === 'function'
    ? options.combinedTest(input)
    : options.combinedTest ?? { ok: false, command: 'fixture-related-tests', result: 'failed', reason: 'tests-failed' });
  const load = createPrototypeLoader({ exec, fs, env, combinedTest, settings: structuredClone(settings), now: () => clock,
    cloneKey: (root) => { cloneRoots.push(root); return 'test-clone-key'; },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; await options.onSleep?.(); } });
  return { calls, records, sleeps, admitted, reads, cloneRoots, lateChanges, registrations, combinedTest, run: (input = {}) => load({ ...BASE, sha: candidateSha, ...input }) };
}
const mutations = (f, action) => f.calls.filter((c) => c.cmd === 'node' && c.args[1] === action && !c.args.includes('--check'));
describe('default combined-tree test proof', () => {
  const limits = { waitMs: 1234, timeoutMs: 5678, maxBuffer: 4096 };
  const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0,
    numPassedTests: 3, numPendingTests: 2, testResults: [
      { name: 'one.test.mjs', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'todo' }] },
      { name: 'two.test.mjs', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'passed' }] },
    ] };
  async function runReport(value, { missing = false, failure, cleanupRemains = false } = {}) {
    const worktree = '/tmp/prototype-combined-proof';
    const sources = new Map([['one.test.mjs', ''], ['two.test.mjs', '']]);
    let reportPath;
    const fs = {
      mkdtempSync: () => worktree, existsSync: vi.fn((path) => path === worktree && cleanupRemains), rmSync: vi.fn(),
      readFileSync: vi.fn((path) => {
        if (path === reportPath) {
          if (missing) throw new Error('missing report');
          return typeof value === 'string' ? value : JSON.stringify(value);
        }
        const source = sources.get(path.slice(worktree.length + 1));
        if (source === undefined) throw new Error('unexpected read');
        return source;
      }),
    };
    const exec = vi.fn((command, args) => {
      if (command === 'node') {
        reportPath = args.find(arg => arg.startsWith('--outputFile='))?.slice('--outputFile='.length);
        if (failure) throw failure;
        return ''; // Exit zero alone proves nothing.
      }
      if (args[0] === '-C' || args[0] === 'rev-parse') return SHA;
      if (['fetch', 'merge-base', 'worktree'].includes(args[0])) return '';
      if (args[0] === 'merge-tree') return TREE;
      if (args[0] === 'commit-tree') return MERGE;
      if (args[0] === 'ls-files') return [...sources.keys()].join('\0') + '\0';
      throw new Error('unexpected command');
    });
    const result = await defaultDeps().combinedTest({ clone: '/fixture/clone', candidateSha: SHA,
      changedFiles: [...sources.keys()], refs: ['lane/old'] }, { exec, fs, env: {}, settings: { combinedTest: limits } });
    return { result, exec, fs, worktree, reportPath };
  }
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
    expect(result.result.length).toBeLessThanOrEqual(300);
    expect(fs.rmSync).toHaveBeenCalledWith(worktree, { recursive: true, force: true });
  });
});

describe('prototype-load', () => {
  it('refuses missing readiness evidence and persists the refusal on a real filesystem', async () => {
    await withRealRepo(async ({ root }) => {
      const recordPath = join(root, 'audit', 'prototype-load.jsonl');
      const load = createPrototypeLoader({ ...defaultDeps(),
        env: { HOME: root },
        settings: { ...settings, workspaceRoot: root, recordPath, readyRecordPath: join(root, 'missing-ready.jsonl') },
      });
      const result = await load(BASE);
      expect(result).toMatchObject({ ok: false, stopReason: 'no-ready', registered: false, adopted: false });
      const records = readFileSync(recordPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ ...BASE, ok: false, stopReason: 'no-ready', registered: false, adopted: false });
    });
  });

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
      combinedTests: { testCount: 0, result: expect.stringContaining('Narrow the candidate or rebase and retest') }, staleTolerated: [] });
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
  it('sanitizes and bounds thrown combined-test errors in every persisted refusal field', async () => {
    const repoPath = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
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
      cherry: { 'lane/also': `- ${SHA}\n` },
      combinedTest: { ok: true, ...combinedTests } });
    const r = await f.run();
    expect(f.combinedTest).toHaveBeenCalledTimes(1);
    expect(f.combinedTest).toHaveBeenCalledWith({ clone: '/home/test/workspace/wev-control', candidateSha: SHA,
      changedFiles: ['a-also.mjs', 'x', 'z-old.mjs'], refs: ['lane/old', 'lane/also'] });
    expect(r).toMatchObject({ ok: true, registered: true, adopted: true, stopReason: null });
    expect(r.combinedTests).toEqual(combinedTests);
    expect(r.staleTolerated).toEqual([
      { ref: 'lane/old', landedByContent: false, why: expect.stringMatching(/combined/i), combinedTests },
      { ref: 'lane/also', landedByContent: true, why: expect.stringMatching(/combined/i), combinedTests },
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
  it('flags a content-landed stale ref as harmless in staleTolerated', async () => {
    const f = fixture({ list: ['lane/old'], conflicts: ['lane/old'], checkFiles: { 'lane/old': ['old-only.mjs'] }, staleChanged: { 'lane/old': 'M\0old-only.mjs\0' }, cherry: { 'lane/old': `- ${SHA}\n- ${TREE}\n` } });
    const r = await f.run();
    expect(r.ok).toBe(true);
    expect(r.staleTolerated).toEqual([{ ref: 'lane/old', landedByContent: true, why: expect.stringMatching(/\S/) }]);
    expect(f.calls.some(c => c.cmd === 'git' && c.args.join(' ') === 'cherry origin/main origin/lane/old')).toBe(true);
    expect(f.records[0].staleTolerated).toEqual(r.staleTolerated);
    expect(mutations(f, 'add')).toHaveLength(1);
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
  it('contained stale and clean registrations remain after replacement adoption', async () => {
    const f = fixture({ list: ['lane/old', 'lane/also'], contained: ['lane/old', 'lane/also'], conflicts: ['lane/old'] }); const r = await f.run();
    expect(r).toMatchObject({ ok: false, adopted: true, stopReason: 'swap-remove-failed', detail: 'mutable-registration', removed: [], removedTips: {}, swap: { retained: ['lane/old', 'lane/also'] } });
    expect(r.stale).toEqual(['lane/old']);
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
    ['timeout', { timeout: true }, 'adoption-timeout'],
    ['probe error 128', { adoptionError: 128 }, 'check-unverifiable'],
    ['probe error -1', { adoptionError: -1 }, 'check-unverifiable'],
    ['unreadable refusal trail', { alertsReadError: true }, 'check-unverifiable'],
  ])('retains every clean prior registration until the replacement is adopted: %s', async (_, options, stopReason) => {
    const f = fixture({ list: ['lane/old', 'lane/also'], contained: ['lane/old', 'lane/also'], ...options });
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, stopReason, registered: true, adopted: false, removed: [] });
    expect(mutations(f, 'remove')).toEqual([]);
    expect(r.fallback).toContain('Prior registrations retained: lane/old, lane/also.');
  });
  // A stale preview does not prove the prior live build is dispensable: adoption can still fail.
  it.each([
    ['refusal alert', { alerts: refusedAlert }, 'adoption-refused'],
    ['refusal event', { events: refusedAlert }, 'adoption-refused'],
    ['timeout', { timeout: true }, 'adoption-timeout'],
    ['probe error', { adoptionError: 128 }, 'check-unverifiable'],
    ['unreadable refusal trail', { alertsReadError: true }, 'check-unverifiable'],
  ])('retains stale and clean registrations through failed adoption: %s', async (_, options, stopReason) => {
    const f = fixture({ list: ['lane/old', 'lane/also'], contained: ['lane/old', 'lane/also'], conflicts: ['lane/old'], ...options });
    const r = await f.run();
    expect(r).toMatchObject({ ok: false, stopReason, registered: true, adopted: false, removed: [] });
    expect(mutations(f, 'remove')).toEqual([]);
    expect(r.fallback).toContain('Prior registrations retained: lane/old, lane/also.');
    expect(r.fallback).toContain('If stale registrations block adoption, rebase and retest them');
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
    const f = fixture({ timeout: true }); const r = await f.run(); expect(r.stopReason).toBe('adoption-timeout'); expect(r.registered).toBe(true); expect(r.adopted).toBe(false); expect(f.sleeps).toEqual([10, 10, 10]);
  });
  it('waits for a missing daemon commit to become available before adoption', async () => {
    const f = fixture({ missingCandidate: true });
    expect(await f.run()).toMatchObject({ ok: true, registered: true, adopted: true });
    expect(f.sleeps).toEqual([10]);
  });
  it('a missing daemon commit remains pending until the adoption deadline', async () => {
    const f = fixture({ missingCandidate: true, missingForever: true });
    expect(await f.run()).toMatchObject({ ok: false, stopReason: 'adoption-timeout', registered: true, adopted: false });
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
        : { ok: false, registered: true, adopted: false, stopReason: 'adoption-timeout' });
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
      : { ok: false, stopReason: 'adoption-timeout', registered: true, adopted: false });
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
      ['add', clone, '--ref=lane/old', '--check', '--json'],
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
