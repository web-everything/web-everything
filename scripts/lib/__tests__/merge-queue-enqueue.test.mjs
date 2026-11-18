// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { closeSync, openSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isAlreadyQueuedError, ENQUEUE_MUTATION, mergeActionFor, buildEnqueueArgs, enqueuePr, planQueueFollowUps, rulesetSuggestion, workflowEditHold, normalizeGatePath, readPinnedChangedFiles } from '../merge-queue-enqueue.mjs';
import { classifyStartupFailureGate, handleStaleMergeGate, staleMergeGateRefreshStatePath, handleRequiredWorkflowsRefusal, isRequiredWorkflowsUnsatisfiedError, REQUIRED_WORKFLOWS_UNSATISFIED } from '../merge-queue-enqueue.mjs';
import { refreshStalePr as refreshRealStalePr } from '../merge-queue-hook.mjs';
import { execFileSyncThrottled } from '../gh-throttle.mjs';
import { reserve, releaseLockDirIf, readLockEntry } from '../../readiness/file-locks.mjs';

vi.mock('../gh-throttle.mjs', async importOriginal => ({
  ...await importOriginal(), execFileSyncThrottled: vi.fn(() => { throw new Error('unexpected GitHub IO'); }),
}));

const HEAD = 'a'.repeat(40);

const startupRun = (extra = {}) => ({ id: 123, head_sha: HEAD, event: 'pull_request_target', path: '.github/workflows/merge-gate.yml', status: 'completed', conclusion: 'startup_failure', ...extra });
const nonStaleRuns = [
  ['newest success', [startupRun({ conclusion: 'success' })]],
  ['newest failure', [startupRun({ conclusion: 'failure' })]],
  ['startup_failure with missing status', [startupRun({ status: undefined })]],
  ['startup_failure not completed', [startupRun({ status: 'in_progress' })]],
  ['in-progress run', [startupRun({ status: 'in_progress', conclusion: null })]],
  ['no runs', []],
  ['older startup failure with newer success', [startupRun({ id: 124, conclusion: 'success' }), startupRun()]],
  ['other head', [startupRun({ head_sha: 'b'.repeat(40) })]],
  ['other event', [startupRun({ event: 'pull_request' })]],
];
const unreadableRuns = [
  ['undefined', undefined], ['null', null], ['object', {}], ['string', 'bad JSON'],
  ['null entry', [null]], ['missing head/event', [{ id: 123 }]],
  ...['123', 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, undefined].map(id => [`bad id ${id}`, [startupRun({ id })]]),
  ['unorderable matching run', [startupRun(), startupRun({ id: '124', conclusion: 'success' })]],
  ['missing conclusion', [startupRun({ conclusion: undefined })]],
];

describe('classifyStartupFailureGate', () => {
  it('selects the highest integer id regardless of input order, name, or path', () => {
    expect(classifyStartupFailureGate({ headSha: HEAD, runs: [startupRun({ id: 122, conclusion: 'success' }), startupRun(), startupRun({ id: 121 })] }))
      .toEqual({ stale: true, runId: 123, reason: 'newest Merge gate workflow run 123 ended startup_failure' });
  });
  it.each(nonStaleRuns)('does not refresh: %s', (_name, runs) => {
    expect(classifyStartupFailureGate({ headSha: HEAD, runs })).toMatchObject({ stale: false, reason: expect.any(String) });
  });
  it.each(unreadableRuns)('fails closed: %s', (_name, runs) => {
    expect(classifyStartupFailureGate({ headSha: HEAD, runs })).toMatchObject({ stale: false, reason: expect.stringContaining('unreadable') });
  });
  it('ignores higher ids for other heads and events', () => {
    expect(classifyStartupFailureGate({ headSha: HEAD, runs: [startupRun(), startupRun({ id: 200, head_sha: 'other', conclusion: 'success' }), startupRun({ id: 201, event: 'push', conclusion: 'success' })] }))
      .toMatchObject({ stale: true, runId: 123 });
  });
  it('fails closed on a missing head or input', () => {
    expect(classifyStartupFailureGate()).toMatchObject({ stale: false });
    expect(classifyStartupFailureGate({ runs: [startupRun()] })).toMatchObject({ stale: false });
  });
});

describe('startup-failure stale merge-gate refresh', () => {
  const green = name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
  function options(extra = {}) {
    return {
      c: { num: 5006, repo: 'o/r', headRef: 'lane/test', decision: 'skip', state: 'BLOCKED', reason: 'merge state BLOCKED' },
      pr: { headRefOid: HEAD, rowsComplete: true, statusCheckRollup: [green('test'), green('merge-gate')] },
      rosterSource: 'live', requiredChecks: ['test', 'merge-gate'], classifyPr: vi.fn(() => ({ decision: 'merge' })), setting: 'on',
      readGateRuns: vi.fn(() => [startupRun()]), readVerdict: vi.fn(), readFreeze: vi.fn(), readAcceptance: vi.fn(),
      cloneDir: '/clone', readState: () => ({}), record: vi.fn(), statePath: join(mkdtempSync(join(tmpdir(), 'sg-ledger-')), 'ledger.json'),
      refreshStalePr: vi.fn(async () => ({ ok: true, action: 'rerun', newCommit: HEAD })), ...extra,
    };
  }
  it('refreshes once with runId and shares the ledger bound when newHead equals head', async () => {
    const state = {};
    const o = options({ readState: () => state, record: vi.fn((_path, key, entry) => { state[key] = entry; }) });
    expect(await handleStaleMergeGate(o)).toMatchObject({ handled: true, reason: expect.stringContaining('merge-gate workflow startup_failure (run 123) → refresh rerun') });
    expect(o.readGateRuns).toHaveBeenCalledTimes(1);
    expect(o.readGateRuns).toHaveBeenCalledWith({ repo: 'o/r', headSha: HEAD });
    expect(o.refreshStalePr).toHaveBeenCalledTimes(1);
    expect(o.refreshStalePr).toHaveBeenCalledWith({ laneRef: 'lane/test', root: '/clone', repo: 'o/r', runId: 123, runConclusion: 'startup_failure', expectedHead: HEAD });
    expect(o.record).toHaveBeenCalledWith(o.statePath, 'o/r#5006', expect.objectContaining({ fromHead: HEAD, newHead: HEAD }));
    expect(await handleStaleMergeGate(o)).toMatchObject({ handled: true, reason: expect.stringContaining('a person should look') });
    expect(o.refreshStalePr).toHaveBeenCalledTimes(1);
    expect(o.record).toHaveBeenCalledTimes(1);
    expect(o.readVerdict).not.toHaveBeenCalled();
    expect(o.readFreeze).not.toHaveBeenCalled();
    expect(o.readAcceptance).not.toHaveBeenCalled();
  });
  it('refreshes when the merge-gate row is missing (startup_failure leaves no check-run)', async () => {
    const o = options({ pr: { headRefOid: HEAD, rowsComplete: true, statusCheckRollup: [green('test')] } });
    expect(await handleStaleMergeGate(o)).toMatchObject({ handled: true, reason: expect.stringContaining('startup_failure (run 123)') });
    expect(o.refreshStalePr).toHaveBeenCalledTimes(1);
  });
  it('stays refused when merge-gate is missing AND another required check is not green', async () => {
    const o = options({ pr: { headRefOid: HEAD, rowsComplete: true, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] } });
    expect(await handleStaleMergeGate(o)).toEqual({ handled: false });
    expect(o.readGateRuns).not.toHaveBeenCalled();
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it('refuses the missing-row path when integration is missing even though test is green', async () => {
    const o = options({ requiredChecks: ['test', 'integration', 'merge-gate'], pr: { headRefOid: HEAD, rowsComplete: true, statusCheckRollup: [green('test')] } });
    expect(await handleStaleMergeGate(o)).toEqual({ handled: false });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
    expect(o.readGateRuns).not.toHaveBeenCalled();
  });
  it('refuses on the allowed path when integration is missing (reviewCiGate implication fallback)', async () => {
    const o = options({ requiredChecks: ['test', 'integration', 'merge-gate'], pr: { headRefOid: HEAD, rowsComplete: true, statusCheckRollup: [green('test'), green('merge-gate')] } });
    expect(await handleStaleMergeGate(o)).toEqual({ handled: false });
    expect(o.readGateRuns).not.toHaveBeenCalled();
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it('claims the produced head durably: a pass on the new head skips', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'sg-claim-')), 'ledger.json');
    const NEW = 'c'.repeat(40);
    const refreshStalePr = vi.fn(async () => ({ ok: true, action: 'rebased', newCommit: NEW }));
    await handleStaleMergeGate(options({ statePath, refreshStalePr, needsAcceptanceRestamp: () => false }));
    const again = options({ statePath, refreshStalePr, needsAcceptanceRestamp: () => false,
      pr: { headRefOid: NEW, rowsComplete: true, statusCheckRollup: [green('test')] }, readGateRuns: vi.fn(() => [startupRun({ head_sha: NEW, id: 200 })]) });
    expect(await handleStaleMergeGate(again)).toMatchObject({ handled: false, reason: expect.stringContaining('already claimed') });
    expect(refreshStalePr).toHaveBeenCalledTimes(1);
  });
  it('emits a loud smell and blocks the PR when the new-head claim cannot be written', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'sg-claim-')), 'ledger.json');
    const NEW = 'd'.repeat(40);
    const warn = vi.fn();
    const refreshStalePr = vi.fn(async () => ({ ok: true, action: 'rebased', newCommit: NEW }));
    const writeClaim = vi.fn(path => { if (!/-pr-/.test(path) && writeClaim.mock.calls.length > 1) throw new Error('disk full'); closeSync(openSync(path, 'wx')); });
    await handleStaleMergeGate(options({ statePath, refreshStalePr, warn, writeClaim, needsAcceptanceRestamp: () => false }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SMELL'));
    const next = options({ statePath, refreshStalePr, writeClaim, needsAcceptanceRestamp: () => false,
      pr: { headRefOid: NEW, rowsComplete: true, statusCheckRollup: [green('test')] }, readGateRuns: vi.fn(() => [startupRun({ head_sha: NEW, id: 200 })]) });
    expect(await handleStaleMergeGate(next)).toMatchObject({ handled: false, reason: expect.stringContaining('person should look') });
    expect(refreshStalePr).toHaveBeenCalledTimes(1);
  });
  it('dispatches exactly once for two concurrent refreshes (atomic claim)', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'sg-claim-')), 'ledger.json');
    let release; const gate = new Promise(r => { release = r; });
    const refreshStalePr = vi.fn(async () => { await gate; return { ok: true, action: 'rerun', newCommit: HEAD }; });
    const a = handleStaleMergeGate(options({ statePath, refreshStalePr }));
    const b = handleStaleMergeGate(options({ statePath, refreshStalePr }));
    const second = await Promise.race([b, a]);
    expect(second).toMatchObject({ handled: false, reason: expect.stringContaining('already claimed') });
    release();
    await Promise.all([a, b]);
    expect(refreshStalePr).toHaveBeenCalledTimes(1);
  });
  it('releases the claim when the dispatch errors so a later pass can retry', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'sg-claim-')), 'ledger.json');
    const bad = vi.fn(async () => ({ ok: false, error: 'boom' }));
    await handleStaleMergeGate(options({ statePath, refreshStalePr: bad }));
    const good = vi.fn(async () => ({ ok: true, action: 'rerun', newCommit: HEAD }));
    expect(await handleStaleMergeGate(options({ statePath, refreshStalePr: good }))).toMatchObject({ handled: true });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
  const pendingClaim = o => join(dirname(o.statePath), readdirSync(dirname(o.statePath)).find(name => name.includes('-claim-head-')));
  it.each(['no clone', 'dry run', 'off', 'skip', 'state read throws'])('retains pending claims on non-dispatch exit: %s', async kind => {
    const o = options({ refreshStalePr: vi.fn(async () => ({ ok: false, action: 'gate-refresh-pending', state: 'pending-unknown', confirmed: true })) });
    await handleStaleMergeGate(o);
    const claim = pendingClaim(o);
    const before = readFileSync(claim, 'utf8');
    let reads = 0, settingReads = 0;
    const second = { ...o,
      ...(kind === 'no clone' ? { cloneDir: null } : {}),
      ...(kind === 'dry run' ? { dryRun: true } : {}),
      ...(kind === 'off' ? { setting: { get value() { return ++settingReads > 2 ? 'off' : 'on'; } } } : {}),
      readState: () => {
        if (++reads < 2) return {};
        if (kind === 'state read throws') throw new Error('unreadable state');
        return kind === 'skip' ? { 'o/r#5006': { fromHead: HEAD } } : {};
      },
    };
    await handleStaleMergeGate(second).catch(() => {});
    expect(readFileSync(claim, 'utf8')).toBe(before);
    expect(o.refreshStalePr).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['fresh unknown holder', false, null, null, false],
    ['expired unknown holder', true, null, null, true],
    ['fresh live holder', false, process.pid, null, false],
    ['expired live holder', true, process.pid, null, false],
    ['fresh dead holder', false, process.pid, 'ESRCH', true],
    ['expired dead holder', true, process.pid, 'ESRCH', true],
    ['expired unprobeable holder', true, process.pid, 'EPERM', false],
  ])('a %s reread lock excludes a second reader or permits recovery', async (_name, expired, pid, probeError, recover) => {
    const o = options({ refreshStalePr: vi.fn(async () => ({ ok: false, action: 'gate-refresh-pending', state: 'pending-unknown' })) });
    await handleStaleMergeGate(o);
    const claim = pendingClaim(o), root = `${claim}-reread-locks`;
    const at = Date.now() - (expired ? 20 * 60_000 : 0);
    expect(reserve(root, claim, 'earlier-reader', at, new Date(at).toISOString(), pid)).toMatchObject({ ok: true });
    const savedLock = readLockEntry(root, claim), savedClaim = readFileSync(claim, 'utf8');
    const kill = process.kill;
    const probe = probeError ? vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === pid && signal === 0) throw Object.assign(new Error('fixture liveness probe'), { code: probeError });
      return kill(target, signal);
    }) : null;
    try {
      o.refreshStalePr.mockResolvedValue({ ok: true, action: 'gate-refresh', newCommit: null });
      const result = await handleStaleMergeGate(o);
      expect(o.refreshStalePr).toHaveBeenCalledTimes(recover ? 2 : 1);
      expect(o.record).toHaveBeenCalledTimes(recover ? 1 : 0);
      if (recover) {
        expect(result.reason).toContain('refresh gate-refresh');
        expect(readLockEntry(root, claim)).toBeNull();
        expect(o.refreshStalePr).toHaveBeenLastCalledWith(expect.objectContaining({
          gateRefreshPending: { state: 'pending-unknown', confirmed: false },
        }));
      } else {
        // Age alone must never evict a live or unprobeable reader.
        expect(result.reason).toContain('label re-read');
        expect(readLockEntry(root, claim)).toEqual(savedLock);
        expect(readFileSync(claim, 'utf8')).toBe(savedClaim);
      }
    } finally {
      probe?.mockRestore();
      releaseLockDirIf(root, claim, { owner: 'earlier-reader' });
      rmSync(dirname(o.statePath), { recursive: true, force: true });
    }
  });
  it.each(['fresh', 'expired'])('honors a %s legacy reread file only until its expiry', async age => {
    const o = options({ refreshStalePr: vi.fn(async () => ({ ok: false, action: 'gate-refresh-pending', state: 'pending-unknown' })) });
    await handleStaleMergeGate(o);
    const path = `${pendingClaim(o)}-reread`;
    writeFileSync(path, '');
    const at = new Date(Date.now() - (age === 'expired' ? 20 * 60_000 : 0));
    utimesSync(path, at, at);
    await handleStaleMergeGate(o);
    expect(o.refreshStalePr).toHaveBeenCalledTimes(age === 'fresh' ? 1 : 2);
  });
  it('excludes concurrent pending rereads while a reader is running', async () => {
    const o = options({ refreshStalePr: vi.fn(async () => ({ ok: false, action: 'gate-refresh-pending', state: 'pending-unknown' })) });
    await handleStaleMergeGate(o);
    let release;
    o.refreshStalePr.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = handleStaleMergeGate(o);
    expect((await handleStaleMergeGate(o)).reason).toContain('label re-read');
    release({ ok: true, action: 'gate-refresh', newCommit: null });
    await first;
    expect(o.refreshStalePr).toHaveBeenCalledTimes(2);
    expect(o.record).toHaveBeenCalledTimes(1);
  });
  it('persists confirmation through failed cleanup and operator removal across passes', async () => {
    let present = false, cleanupFails = true, adds = 0;
    const o = options({ refreshStalePr: vi.fn(args => refreshRealStalePr({ ...args, prNumber: 5006,
      readTip: () => HEAD, refresh: () => ({ ok: true, action: 'current' }), execGh: argv => {
        if (argv.includes('--add-label')) { adds++; present = true; }
        if (argv.includes('--remove-label')) { if (cleanupFails) throw new Error('offline'); present = false; }
        return JSON.stringify(argv[1] === 'view' ? { labels: present ? [{ name: 'gate:refresh' }] : [] } : { head: { sha: HEAD } });
      } })) });
    await handleStaleMergeGate(o);
    expect(JSON.parse(readFileSync(pendingClaim(o), 'utf8'))).toMatchObject({ confirmed: true });
    present = false; cleanupFails = false; // Operator removed the already-confirmed label.
    expect((await handleStaleMergeGate(o)).reason).toContain('refresh gate-refresh');
    expect(o.record).toHaveBeenCalledTimes(1);
    expect(adds).toBe(1);
  });
  it('holds the head after an existing-label removal dispatch even if label creation fails', async () => {
    let present = true, fail = true, transitions = 0;
    const o = options({ refreshStalePr: vi.fn(args => refreshRealStalePr({ ...args, prNumber: 5006,
      readTip: () => HEAD, refresh: () => ({ ok: true, action: 'current' }), execGh: argv => {
        if (argv.includes('--remove-label')) { present = false; transitions++; }
        if (argv[0] === 'label' && fail) throw new Error('HTTP 403: create denied');
        if (argv.includes('--add-label')) { present = true; transitions++; }
        return JSON.stringify(argv[1] === 'view' ? { labels: present ? [{ name: 'gate:refresh' }] : [] } : { head: { sha: HEAD } });
      } })) });
    expect((await handleStaleMergeGate(o)).reason).toContain('gate-refresh-pending');
    expect(JSON.parse(readFileSync(pendingClaim(o), 'utf8'))).toMatchObject({ state: 'pending-unknown', confirmed: true });
    fail = false;
    await handleStaleMergeGate(o);
    await handleStaleMergeGate(o);
    expect(transitions).toBe(1);
    expect(o.record).toHaveBeenCalledTimes(1);
  });
  it('does not spend catch-up budget on failed startup_failure recovery; a later trigger succeeds once', async () => {
    const state = {}, calls = [];
    let refused = true;
    const refreshStalePr = vi.fn(options => refreshRealStalePr({ ...options, prNumber: 5006,
      readTip: () => HEAD, refresh: () => ({ ok: true, action: 'current' }),
      execGh: args => {
        calls.push(args);
        if (refused || args.includes('POST')) throw new Error('HTTP 403: This workflow run cannot be retried');
        return JSON.stringify(args[0] === 'pr' && args[1] === 'view' ? { labels: calls.some(call => call.includes('--add-label')) ? [{ name: 'gate:refresh' }] : [] } : { head: { sha: HEAD } });
      } }));
    const o = options({ refreshStalePr, readState: () => state,
      record: vi.fn((_path, key, entry) => { state[key] = entry; }) });
    expect(await handleStaleMergeGate(o)).toMatchObject({ reason: expect.stringContaining('refresh FAILED') });
    expect(o.record).not.toHaveBeenCalled();
    expect(state).toEqual({});
    expect(readdirSync(dirname(o.statePath)).some(name => name.includes('-claim-'))).toBe(false);
    refused = false;
    expect(await handleStaleMergeGate(o)).toMatchObject({ reason: expect.stringContaining('refresh gate-refresh') });
    expect(o.record).toHaveBeenCalledTimes(1);
    expect(state['o/r#5006']).toMatchObject({ fromHead: HEAD, newHead: null, action: 'gate-refresh' });
    await handleStaleMergeGate(o);
    expect(refreshStalePr).toHaveBeenCalledTimes(2);
    expect(calls.filter(args => args.includes('POST'))).toHaveLength(0);
  });
  it.each(['timeout', 'unreadable', 'removal', 'denied', 'graphql-denied'])('%s holds only uncertain claims and re-reads pending next pass', async kind => {
    const denied = kind === 'denied' || kind === 'graphql-denied';
    const state = {}, calls = [];
    let added = false, secondPass = false;
    const refreshStalePr = vi.fn(options => refreshRealStalePr({ ...options, prNumber: 5006,
      readTip: () => HEAD, refresh: () => ({ ok: true, action: 'current' }),
      execGh: args => {
        calls.push(args);
        if (args.includes('--add-label')) {
          if (!secondPass && kind === 'graphql-denied') throw Object.assign(new Error('Command failed: gh pr edit'), {
            status: 1, stderr: Buffer.from('GraphQL: Resource not accessible by integration (addLabelsToLabelable)\n'),
          });
          added = true;
          if (!secondPass && kind === 'denied') throw new Error('HTTP 403: denied');
          if (!secondPass && kind === 'timeout') throw new Error('add timed out');
        }
        if (args.includes('--remove-label') && !secondPass && kind === 'removal') throw new Error('cleanup denied');
        if (args[1] === 'view') {
          if (!secondPass && added && kind === 'unreadable') throw new Error('offline');
          return JSON.stringify({ labels: added && (secondPass || kind !== 'timeout') ? [{ name: 'gate:refresh' }] : [] });
        }
        return JSON.stringify({ head: { sha: HEAD } });
      } }));
    const o = options({ refreshStalePr, readState: () => state,
      record: vi.fn((_path, key, entry) => { state[key] = entry; }) });
    try {
      const first = await handleStaleMergeGate(o);
      expect(first.reason).toContain(denied ? 'refresh FAILED' : 'gate-refresh-pending');
      expect(o.record).not.toHaveBeenCalled();
      expect(state).toEqual({});
      expect(readdirSync(dirname(o.statePath)).filter(name => name.includes('-claim-head-'))).toHaveLength(denied ? 0 : 1);
      expect(calls.filter(args => args.includes('--add-label'))).toHaveLength(1);
      secondPass = true;
      expect((await handleStaleMergeGate(o)).reason).toContain('refresh gate-refresh');
      expect(o.record).toHaveBeenCalledTimes(1);
      expect(calls.filter(args => args.includes('--add-label'))).toHaveLength(denied ? 2 : 1);
      expect(refreshStalePr).toHaveBeenCalledTimes(2);
    } finally { rmSync(dirname(o.statePath), { recursive: true, force: true }); }
  });
  it('refuses when the required-check set is unknown (gate not allowed)', async () => {
    const o = options({ requiredChecks: undefined });
    expect(await handleStaleMergeGate(o)).toEqual({ handled: false });
    expect(o.readGateRuns).not.toHaveBeenCalled();
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it('fails closed when the ledger is unreadable or unwritable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-ledger-'));
    const bad = join(dir, 'bad.json'); writeFileSync(bad, '{not json');
    const nul = join(dir, 'nul.json'); writeFileSync(nul, '{"o/r#5006":{}}');
    for (const statePath of [bad, nul, join(dir, 'missing-dir', 'sub', '\0x')]) {
      const o = options({ statePath });
      expect(await handleStaleMergeGate(o)).toMatchObject({ handled: false, reason: expect.stringContaining('refresh ledger unusable') });
      expect(o.refreshStalePr).not.toHaveBeenCalled();
    }
  });
  it.each(['fromHead', 'newHead'])('retains the existing bound independently for previous.%s', async field => {
    const o = options({ readState: () => ({ 'o/r#5006': { [field]: HEAD } }) });
    expect(await handleStaleMergeGate(o)).toMatchObject({ handled: true, reason: expect.stringContaining('a person should look') });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
    expect(o.record).not.toHaveBeenCalled();
  });
  it.each(nonStaleRuns)('leaves the skip unchanged: %s', async (_name, runs) => {
    const o = options({ readGateRuns: vi.fn(() => runs) });
    expect(await handleStaleMergeGate(o)).toEqual({ handled: false });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
    expect(o.record).not.toHaveBeenCalled();
  });
  it.each(unreadableRuns)('keeps unreadable evidence closed: %s', async (_name, runs) => {
    const o = options({ readGateRuns: () => runs });
    expect(await handleStaleMergeGate(o)).toMatchObject({ handled: false, reason: expect.stringContaining('merge-gate workflow runs unreadable:') });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
    expect(o.record).not.toHaveBeenCalled();
  });
  it('keeps thrown reads closed', async () => {
    const o = options({ readGateRuns: () => { throw new Error('offline'); } });
    expect(await handleStaleMergeGate(o)).toEqual({ handled: false, reason: 'merge-gate workflow runs unreadable: offline' });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it.each([{ dryRun: true }, { setting: 'off' }, { classifyPr: () => ({ decision: 'skip' }) },
    { pr: { headRefOid: HEAD, reviewDecision: 'CHANGES_REQUESTED' } }])('does not list runs before preconditions pass: %j', async extra => {
    const o = options(extra);
    expect(await handleStaleMergeGate(o)).toEqual({ handled: false });
    expect(o.readGateRuns).not.toHaveBeenCalled();
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it.each(['test', 'merge-gate'])('never lists workflow runs when %s is failing', async name => {
    const o = options({ pr: { headRefOid: HEAD, rowsComplete: true, statusCheckRollup: [green('test'), green('merge-gate')].map(row => row.name === name ? { ...row, conclusion: 'FAILURE' } : row) } });
    expect((await handleStaleMergeGate(o)).handled).toBe(false);
    expect(o.readGateRuns).not.toHaveBeenCalled();
  });
  it.each([null, 'declared', 'stale-cache'])('refuses an unproven roster source before reading runs: %s', rosterSource => {
    const o = options({ rosterSource });
    return handleStaleMergeGate(o).then(result => {
      expect(result).toEqual({ handled: false });
      expect(o.readGateRuns).not.toHaveBeenCalled();
      expect(o.readVerdict).not.toHaveBeenCalled();
    });
  });
  it('uses the throttled workflow endpoint once with bounded output and time', async () => {
    execFileSyncThrottled.mockClear();
    execFileSyncThrottled.mockReturnValueOnce(JSON.stringify({ total_count: 1, workflow_runs: [startupRun()] }));
    const o = options({ readGateRuns: undefined });
    expect((await handleStaleMergeGate(o)).handled).toBe(true);
    expect(execFileSyncThrottled).toHaveBeenCalledTimes(1);
    expect(execFileSyncThrottled).toHaveBeenCalledWith('gh', ['api', `repos/o/r/actions/runs?head_sha=${HEAD}&event=pull_request_target&per_page=100`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
  });
  it('ignores other workflows\' runs and path-less runs when picking the newest Merge gate run', () => {
    const other = startupRun({ id: 900, path: '.github/workflows/ci.yml', conclusion: 'success' });
    expect(classifyStartupFailureGate({ headSha: HEAD, runs: [startupRun(), other] })).toMatchObject({ stale: true, runId: 123 });
    expect(classifyStartupFailureGate({ headSha: HEAD, runs: [startupRun({ path: undefined })] })).toMatchObject({ stale: false, reason: expect.stringContaining('unreadable') });
    expect(classifyStartupFailureGate({ headSha: HEAD, runs: [startupRun(), startupRun({ id: 124, path: undefined, conclusion: 'success' })] })).toMatchObject({ stale: false });
    expect(classifyStartupFailureGate({ headSha: HEAD, runs: [startupRun({ path: '.github/workflows/merge-gate.yml@refs/heads/main' })] })).toMatchObject({ stale: true });
  });
  it.each([{ workflow_runs: [startupRun()] }, { total_count: '1', workflow_runs: [startupRun()] }, { total_count: 2, workflow_runs: [startupRun()] }])('fails closed on a missing, malformed or mismatched total_count: %j', async body => {
    execFileSyncThrottled.mockReturnValueOnce(JSON.stringify(body));
    const o = options({ readGateRuns: undefined });
    expect(await handleStaleMergeGate(o)).toMatchObject({ handled: false, reason: expect.stringContaining('unreadable') });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it('fails closed when the repo-wide run list is truncated', async () => {
    execFileSyncThrottled.mockReturnValueOnce(JSON.stringify({ total_count: 150, workflow_runs: [startupRun()] }));
    const o = options({ readGateRuns: undefined });
    expect(await handleStaleMergeGate(o)).toMatchObject({ handled: false, reason: expect.stringContaining('unreadable') });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it.each(['not JSON', '{}'])('fails closed on unreadable default-reader output: %s', async output => {
    execFileSyncThrottled.mockReturnValueOnce(output);
    const o = options({ readGateRuns: undefined });
    expect(await handleStaleMergeGate(o)).toMatchObject({ handled: false, reason: expect.stringContaining('merge-gate workflow runs unreadable:') });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it.each(['maxBuffer exceeded', 'timeout exceeded'])('preserves the skip when the bounded reader reports %s', async message => {
    execFileSyncThrottled.mockImplementationOnce(() => { throw new Error(message); });
    const o = options({ readGateRuns: undefined });
    expect(await handleStaleMergeGate(o)).toEqual({ handled: false, reason: `merge-gate workflow runs unreadable: ${message}` });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
    expect(o.record).not.toHaveBeenCalled();
  });
});

// A fake `gh` + `git`: the PR read (live head), the pinned git diff of HEAD (NUL-separated paths), the mutation.
// `--no-renames` means a rename arrives as two paths (old + new), so the fakes list both.
// `liveBase: null` = the PR read carries no usable base; `baseTip` = the base branch's tip as git reports it.
const execFor = ({ files, liveHead = HEAD, liveBase = 'main', baseTip = '', mutation = '{}', calls = [], filesError }) => (cmd, args) => {
  calls.push([cmd, args]);
  if (cmd === 'gh' && args[0] === 'pr') return JSON.stringify({ id: 'PR_1', headRefOid: liveHead, baseRefName: liveBase });
  if (cmd === 'git') {
    if (args[0] === 'diff') {
      if (filesError) throw new Error(filesError);
      return files.map((f) => (Array.isArray(f) ? f.filter(Boolean).join('\0') : f)).join('\0');
    }
    if (args[0] === 'ls-remote') return baseTip ? `${baseTip}\trefs/heads/${liveBase}\n` : '';
    if (args[0] === 'rev-parse') return baseTip ? `${baseTip}\n` : '';
    return '';
  }
  if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: calls.some(([, a]) => a.includes(`query=${ENQUEUE_MUTATION}`)), headRefOid: HEAD } } } });
  return mutation;
};
const CWD = '/clone';

describe('merge queue enqueue', () => {
  it.each([
    [{ strategy: 'github-merge-queue' }, 'enqueue'],
    [{ strategy: 'drain-direct' }, 'merge'],
    [null, 'merge'],
  ])('chooses the action for %j', (policy, action) => {
    expect(mergeActionFor(policy)).toBe(action);
  });

  it('builds a mutation pinned to the PR node and judged head', () => {
    const args = buildEnqueueArgs({ nodeId: 'PR_1', headSha: HEAD });
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toEqual(expect.arrayContaining([`query=${ENQUEUE_MUTATION}`, 'id=PR_1', `sha=${HEAD}`]));
    expect(() => buildEnqueueArgs({ headSha: HEAD })).toThrow(/node id required/);
    expect(() => buildEnqueueArgs({ nodeId: 'PR_1' })).toThrow(/head SHA required/);
  });

  it.each(['exact', 'numbering', 'mechanical'])('enqueues a licensed human-only hold (%s)', tier => {
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD,
      exec: execFor({ files: ['.github/workflows/ci.yml'], mutation: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E' } } } }) }),
      humanOnlyLicense: hold => { expect(hold.humanOnly).toBe(true); return { licensed: true, tier, reason: 'proven' }; } });
    expect(result).toMatchObject({ ok: true, licensedBy: tier });
  });

  it.each([undefined, () => ({ licensed: false, reason: 'no approval' }), () => { throw Error('unreadable'); }])('keeps a human-only hold without a proven license', humanOnlyLicense => {
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD,
      exec: execFor({ files: ['.github/workflows/ci.yml'] }), humanOnlyLicense });
    expect(result).toMatchObject({ ok: false, held: true, humanOnly: true });
  });

  it('reads the node id and file list, then enqueues exactly the judged head', () => {
    const calls = [];
    const entry = { id: 'E', position: 1, state: 'QUEUED' };
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['scripts/a.mjs', '']], mutation: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: entry } } }), calls }) });
    expect(result).toEqual({ ok: true, entry });
    expect(calls[0]).toEqual(['gh', ['pr', 'view', '7', '--repo', 'o/r', '--json', 'id,headRefOid,baseRefName']]);
    const diff = calls.find(([c, a]) => c === 'git' && a[0] === 'diff');
    expect(diff[1]).toEqual(['diff', '--name-only', '--no-renames', '--no-relative', '-z', '--end-of-options', `refs/remotes/origin/main...${HEAD}`]);
    expect(calls.some(([c, a]) => c === 'gh' && a.includes('--paginate'))).toBe(false);
    const last = calls.find(([cmd, args]) => cmd === 'gh' && args.includes(`query=${ENQUEUE_MUTATION}`));
    expect(last[0]).toBe('gh');
    expect(last[1]).toEqual(buildEnqueueArgs({ nodeId: 'PR_1', headSha: HEAD }));
    expect(last[1]).toContain(`sha=${HEAD}`);
  });

  it.each([
    ['already in the merge queue', { ok: false, error: 'already in the merge queue' }],
    ['permission denied', { ok: false, error: 'permission denied' }],
  ])('handles GraphQL errors: %s', (message, expected) => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['a.txt', '']], mutation: JSON.stringify({ errors: [{ message }] }), calls }) });
    expect(result).toEqual(expected);
    expect(calls.filter(([c, a]) => c === 'gh' && a.includes(`query=${ENQUEUE_MUTATION}`))).toHaveLength(1);
  });

  it.each([
    {}, { data: { enqueuePullRequest: null } },
    { data: { enqueuePullRequest: {} } },
    { data: { enqueuePullRequest: { mergeQueueEntry: {} } } },
    { errors: [{ message: 'Pull request has merge conflicts and Pull request not in mergeable state' }], data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E' } } } },
  ])('fails closed on a missing entry or errors even alongside an entry: %j', response => {
    expect(enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: ['a.txt'], mutation: JSON.stringify(response) }) }).ok).toBe(false);
  });

  it('fails without enqueueing when the PR read throws', () => {
    let calls = 0;
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: () => {
      calls += 1;
      throw new Error('offline');
    } });
    expect(result).toEqual({ ok: false, error: 'node id read failed: offline' });
    expect(calls).toBe(1);
  });

  it('filters completed follow-ups and orders the remainder by merge time', () => {
    expect(planQueueFollowUps({ merged: [
      { number: 3, mergedAt: '2026-01-03T00:00:00Z', mergeCommit: { oid: 'c' } },
      { number: 1, mergedAt: '2026-01-01T00:00:00Z', mergeCommit: { oid: 'a' } },
      { number: 2, mergedAt: '2026-01-02T00:00:00Z', mergeCommit: { oid: 'b' } },
    ], followedUp: new Set([2]) })).toEqual([
      { num: 1, mergeSha: 'a', mergedAt: '2026-01-01T00:00:00Z' },
      { num: 3, mergeSha: 'c', mergedAt: '2026-01-03T00:00:00Z' },
    ]);
  });

  it('suggests the configured queue and required safety checks', () => {
    const result = rulesetSuggestion({ mergeMethod: 'merge', batchSize: 3, maxGroupWaitMinutes: 5 });
    expect(result.mergeQueue).toMatchObject({ mergeMethod: 'MERGE', maxEntriesToBuild: 3, minEntriesToMergeWaitMinutes: 5 });
    expect(result.requiredStatusChecks).toEqual(expect.arrayContaining(['merge-gate', 'test']));
  });
});

// The required checks' workflow YAML is read from the PR merge ref / group commit, so the ruleset must run
// those workflows from main (a `workflows` rule) and only accept a check posted by the GitHub Actions app.
describe('rulesetSuggestion pins the required workflows to main', () => {
  const result = rulesetSuggestion({ mergeMethod: 'merge', batchSize: 3, maxGroupWaitMinutes: 5 });

  it('requires merge-gate.yml, ci.yml and soak-replay-gate.yml from refs/heads/main', () => {
    const byPath = Object.fromEntries(result.requiredWorkflows.map((w) => [w.path, w]));
    for (const path of ['.github/workflows/merge-gate.yml', '.github/workflows/ci.yml', '.github/workflows/soak-replay-gate.yml']) {
      expect(byPath[path], path).toMatchObject({ ref: 'refs/heads/main' });
    }
  });

  it('only accepts required checks posted by the GitHub Actions app', () => {
    expect(result.requiredStatusCheckIntegrationId).toBe(15368);
  });
});

// The required `merge-gate` check is a workflow a PR can edit to `exit 0`, and no check a PR can edit can defend
// that. So the drain (running from main, outside the PR's reach) never enqueues a PR whose diff touches one.
describe('a PR that touches a workflow file is never enqueued (human-only hold)', () => {
  const held = (files, extra = {}) => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files, calls, ...extra }) });
    return { result, mutated: calls.some(([, args]) => args[1] === 'graphql') };
  };

  it.each([
    ['the gate workflow itself', [['.github/workflows/merge-gate.yml', '']]],
    ['a new workflow carrying a required check name', [['.github/workflows/evil.yml', ''], ['scripts/a.mjs', '']]],
    ['the .yaml spelling', [['.github/workflows/merge-gate.yaml', '']]],
    ['a composite action the workflows call', [['.github/actions/setup/action.yml', '']]],
    ['a rename OUT of the workflows directory', [['docs/gate.yml', '.github/workflows/merge-gate.yml']]],
    ['a rename INTO the workflows directory', [['.github/workflows/merge-gate.yml', 'docs/gate.yml']]],
    ['a different case', [['.GitHub/Workflows/Merge-Gate.yml', '']]],
    ['a ./ prefix', [['./.github/workflows/x.yml', '']]],
    ['backslash separators', [['.github\\workflows\\x.yml', '']]],
    ['doubled slashes', [['.github//workflows/x.yml', '']]],
    ['fullwidth look-alike characters', [['．github/workflows/x.yml', '']]],
    ['a dot-dot segment', [['scripts/../.github/workflows/x.yml', '']]],
  ])('holds %s for a human and sends no mutation', (_name, files) => {
    const { result, mutated } = held(files);
    expect(result).toMatchObject({ ok: false, held: true, humanOnly: true, reason: expect.stringMatching(/workflow-edit/) });
    expect(result.paths.length).toBeGreaterThan(0);
    expect(mutated).toBe(false);
  });

  it.each([
    ['the pinned git diff fails', { files: [], filesError: 'fatal: bad object' }],
  ])('fails closed (retryable hold, no mutation) when %s', (_name, opts) => {
    const { result, mutated } = held(opts.files, opts);
    expect(result).toMatchObject({ ok: false, held: true, humanOnly: false, retryable: true, reason: 'unreadable' });
    expect(mutated).toBe(false);
  });

  it('fails closed with no checkout to read the pinned diff from', () => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, exec: execFor({ files: [['a.txt', '']], calls }) });
    expect(result).toMatchObject({ ok: false, held: true, retryable: true, reason: 'unreadable' });
    expect(calls.some(([, a]) => a[1] === 'graphql')).toBe(false);
  });

  it('holds (retryable, no mutation) when the PR head is no longer the judged sha', () => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['a.txt', '']], liveHead: 'b'.repeat(40), calls }) });
    expect(result).toMatchObject({ ok: false, held: true, humanOnly: false, retryable: true, reason: 'head-moved' });
    expect(calls.some(([c]) => c === 'git')).toBe(false);
    expect(calls.some(([, a]) => a[1] === 'graphql')).toBe(false);
  });

  it('fails closed on a malformed repo or PR number before any read', () => {
    const calls = [];
    const result = enqueuePr({ repo: 'o/r/../../x', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['a.txt', '']], calls }) });
    expect(result).toMatchObject({ ok: false, held: true, reason: 'unreadable' });
    expect(calls).toEqual([]);
  });

  it('enqueues an ordinary PR, including one that merely names github or workflows in a path', () => {
    const files = [['docs/github/workflows.md', ''], ['scripts/.github-notes.txt', ''], ['workflows/x.yml', ''], ['.githubx/workflows/x.yml', '']];
    const { result, mutated } = held(files, { mutation: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E' } } } }) });
    expect(result).toMatchObject({ ok: true });
    expect(mutated).toBe(true);
  });

  // PR #5480 red-team finding: a file list prepared against one base was reused after the PR was retargeted,
  // so a workflow edit visible only against the new base was enqueued. The list is bound to its base.
  describe('a prepared file list is reused only against the base it was read against', () => {
    const ENQUEUED = JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E' } } } });
    const TIP = 'c'.repeat(40);
    const run = (preparedSurface, liveBase, baseTip = TIP) => {
      const calls = [];
      const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, preparedSurface, exec: execFor({ files: [['README.md', ''], ['.github/workflows/ci.yml', '']], liveBase, baseTip, mutation: ENQUEUED, calls }) });
      return { result, calls, mutated: calls.some(([, a]) => a.includes(`query=${ENQUEUE_MUTATION}`)) };
    };
    const prepared = (extra) => ({ headSha: HEAD, base: 'main', baseSha: TIP, files: ['README.md'], ...extra });

    it.each([
      ['retargeted to another branch', prepared(), 'release', TIP],
      ['retargeted away and the base differs only by case', prepared({ base: 'Release' }), 'release', TIP],
      ['prepared without a recorded base', prepared({ base: undefined }), 'main', TIP],
      ['prepared with a non-string base', prepared({ base: ['main'] }), 'main', TIP],
      ['the base branch moved under the same name', prepared(), 'main', 'd'.repeat(40)],
      ['prepared without a recorded base commit', prepared({ baseSha: undefined }), 'main', TIP],
      ['prepared with a malformed base commit', prepared({ baseSha: 'C'.repeat(40) }), 'main', 'C'.repeat(40)],
      ['the live base commit is unreadable', prepared(), 'main', ''],
    ])('re-reads the pinned diff and holds the workflow edit when %s', (_name, surface, liveBase, baseTip) => {
      const { result, calls, mutated } = run(surface, liveBase, baseTip);
      expect(result).toMatchObject({ ok: false, held: true, humanOnly: true, reason: 'workflow-edit', paths: ['.github/workflows/ci.yml'] });
      expect(calls.some(([c, a]) => c === 'git' && a[0] === 'diff')).toBe(true);
      expect(mutated).toBe(false);
    });

    it('pins the base tip before the diff and diffs against that sha, so the recorded base is the one the list used', () => {
      const calls = [];
      const read = readPinnedChangedFiles({ headSha: HEAD, cwd: CWD, withBaseSha: true, exec: execFor({ files: [['README.md', '']], baseTip: TIP, calls }) });
      expect(read).toEqual({ files: ['README.md'], baseSha: TIP });
      // Callers that did not ask for it (the merge gate pins the exact shape) keep the plain `{files}` result.
      expect(readPinnedChangedFiles({ headSha: HEAD, cwd: CWD, exec: execFor({ files: [['README.md', '']], baseTip: TIP }) })).toEqual({ files: ['README.md'] });
      const at = (sub) => calls.findIndex(([c, a]) => c === 'git' && a[0] === sub);
      expect(at('rev-parse')).toBeGreaterThan(-1);
      expect(at('rev-parse')).toBeLessThan(at('diff'));
      expect(calls[at('diff')][1].at(-1)).toBe(`${TIP}...${HEAD}`);
    });

    it.each([['null', null], ['empty', '']])('fails closed (retryable, no git read, no mutation) when the live base is %s', (_name, liveBase) => {
      const { result, calls, mutated } = run(prepared(), liveBase);
      expect(result).toMatchObject({ ok: false, held: true, humanOnly: false, retryable: true, reason: 'unreadable' });
      expect(calls.some(([c]) => c === 'git')).toBe(false);
      expect(mutated).toBe(false);
    });

    it('reuses the prepared list without a fetch or diff when head, base and base commit all still match', () => {
      const { result, calls, mutated } = run(prepared({ base: 'release' }), 'release');
      expect(result).toMatchObject({ ok: true });
      expect(calls.some(([c, a]) => c === 'git' && ['fetch', 'diff'].includes(a[0]))).toBe(false);
      expect(mutated).toBe(true);
    });
  });

  it('a workflow-edit hold is human-only and not retryable', () => {
    expect(held([['.github/workflows/x.yml', '']]).result).toMatchObject({ humanOnly: true, retryable: false });
  });

  // The refusal only binds if nothing else can send the mutation: any script that does is a bypass.
  it('no script other than merge-queue-enqueue.mjs sends the enqueue mutation', () => {
    const root = new URL('../../../scripts/', import.meta.url);
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '__tests__' || e.name === '.git') continue;
        const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
        if (e.isDirectory()) walk(p);
        else if (/\.(?:mjs|js|cjs|ts)$/.test(e.name) && e.name !== 'merge-queue-enqueue.mjs' && /enqueuePullRequest|ENQUEUE_MUTATION|buildEnqueueArgs/.test(readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) offenders.push(p.pathname);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('workflowEditHold is a pure decision over plain strings too, and normalizes paths consistently', () => {
    expect(workflowEditHold({ files: ['a.txt', '.github/workflows/x.yml'], expectedCount: 2 })).toMatchObject({ hold: true, reason: 'workflow-edit', paths: ['.github/workflows/x.yml'] });
    expect(workflowEditHold({ files: ['a.txt'], expectedCount: 1 })).toEqual({ hold: false });
    expect(workflowEditHold({ files: [], expectedCount: 0 })).toEqual({ hold: false });
    expect(workflowEditHold({})).toMatchObject({ hold: true, reason: 'unreadable' });
    expect(normalizeGatePath('.\\.GitHub//Workflows/X.yml')).toBe('.github/workflows/x.yml');
  });
});

// PR #4708 round-6 finding (merge-queue-enqueue.mjs, ruled block): the workflow-edit refusal read the REST
// `pulls/{n}/files` list, which describes whatever the branch points at NOW, not the head being enqueued. The
// refusal now reads git at the exact sha. Real repos: the branch moves between judging and enqueueing.
describe('the workflow-edit refusal reads the change list of the exact enqueued sha (real git)', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'mq-pin-'));
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    const clone = join(root, 'clone');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, work);
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'base'); git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-qb', 'lane/x');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'safe');
    const safe = git(work, 'rev-parse', 'HEAD');
    mkdirSync(join(work, '.github/workflows'), { recursive: true });
    writeFileSync(join(work, '.github/workflows/merge-gate.yml'), 'jobs: {}\n');
    git(work, 'add', '.'); git(work, 'commit', '-qm', 'evil');
    const evil = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'lane/x');
    git(root, 'clone', '-q', origin, clone);
    return { root, work, clone, safe, evil };
  };
  // gh answers with the given live head; git runs for real in the clone.
  const realExec = (liveHead, calls) => (cmd, args, opts) => {
    calls.push([cmd, args]);
    if (cmd === 'gh' && args[0] === 'pr') return JSON.stringify({ id: 'PR_1', headRefOid: liveHead, baseRefName: 'main' });
    if (cmd === 'gh' && args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: calls.some(([, a]) => a.includes(`query=${ENQUEUE_MUTATION}`)), headRefOid: liveHead } } } });
    if (cmd === 'gh') return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E' } } } });
    return execFileSync(cmd, args, opts);
  };

  it('holds the sha that touches a workflow, even when the branch NAME now points at a safe commit', () => {
    const { root, work, clone, safe, evil } = setup();
    try {
      git(work, 'push', '-qf', 'origin', `${safe}:refs/heads/lane/x`); // the branch moves back to the safe commit
      const calls = [];
      const result = enqueuePr({ repo: 'o/r', num: 7, headSha: evil, cwd: clone, exec: realExec(evil, calls) });
      expect(result).toMatchObject({ ok: false, held: true, humanOnly: true, reason: 'workflow-edit', paths: ['.github/workflows/merge-gate.yml'] });
      expect(calls.some(([c, a]) => c === 'gh' && a[1] === 'graphql')).toBe(false);
      expect(calls.some(([c, a]) => c === 'git' && a.includes('lane/x'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('enqueues the safe sha with expectedHeadOid pinned to it, even though the branch now carries the workflow edit', () => {
    const { root, clone, safe } = setup();
    try {
      const calls = [];
      const result = enqueuePr({ repo: 'o/r', num: 7, headSha: safe, cwd: clone, exec: realExec(safe, calls) });
      expect(result).toMatchObject({ ok: true });
      const mutation = calls.find(([c, a]) => c === 'gh' && a.includes(`query=${ENQUEUE_MUTATION}`));
      expect(mutation[1]).toContain(`sha=${safe}`);
      expect(readPinnedChangedFiles({ headSha: safe, cwd: clone }).files).toEqual(['b.txt']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('lists both sides of a rename out of the workflows directory', () => {
    const { root, work, clone, evil } = setup();
    try {
      git(work, 'push', '-q', 'origin', `${evil}:refs/heads/main`);
      git(work, 'mv', '.github/workflows/merge-gate.yml', 'docs-gate.yml');
      git(work, 'commit', '-qm', 'rename');
      const renamed = git(work, 'rev-parse', 'HEAD');
      git(work, 'push', '-qf', 'origin', `${renamed}:refs/heads/lane/x`);
      const files = readPinnedChangedFiles({ headSha: renamed, cwd: clone }).files;
      expect(files.sort()).toEqual(['.github/workflows/merge-gate.yml', 'docs-gate.yml']);
      expect(workflowEditHold({ files, expectedCount: files.length })).toMatchObject({ hold: true, humanOnly: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // PR #5480 self-review: same base NAME, but main moved. The head adds a workflow (C1), reverts it (C2), edits
  // README. Prepared against the old main the list is README only; once C1 lands on main the merge base moves to
  // C1 and the same head now deletes the workflow. A list bound only to the base name would hide that edit.
  it('re-reads a prepared list once the base branch moved under the same name, and holds the newly visible workflow edit', () => {
    const { root, work, clone } = setup();
    try {
      git(work, 'checkout', '-qb', 'lane/y', 'main');
      mkdirSync(join(work, '.github/workflows'), { recursive: true });
      writeFileSync(join(work, '.github/workflows/ci.yml'), 'jobs: {}\n');
      git(work, 'add', '.'); git(work, 'commit', '-qm', 'C1');
      const c1 = git(work, 'rev-parse', 'HEAD');
      git(work, 'rm', '-q', '.github/workflows/ci.yml'); git(work, 'commit', '-qm', 'C2');
      writeFileSync(join(work, 'README.md'), 'r\n');
      git(work, 'add', '.'); git(work, 'commit', '-qm', 'C3');
      const head = git(work, 'rev-parse', 'HEAD');
      git(work, 'push', '-q', 'origin', 'lane/y');
      const read = readPinnedChangedFiles({ headSha: head, cwd: clone, withBaseSha: true });
      expect(read.files).toEqual(['README.md']);
      expect(read.baseSha).toBe(git(work, 'rev-parse', 'main'));
      const preparedSurface = { headSha: head, base: 'main', baseSha: read.baseSha, files: read.files };
      const unmoved = [];
      expect(enqueuePr({ repo: 'o/r', num: 7, headSha: head, cwd: clone, preparedSurface, exec: realExec(head, unmoved) })).toMatchObject({ ok: true });
      expect(unmoved.some(([c, a]) => c === 'git' && a[0] === 'diff')).toBe(false);
      git(work, 'push', '-q', 'origin', `${c1}:refs/heads/main`); // C1 lands on main
      const calls = [];
      const result = enqueuePr({ repo: 'o/r', num: 7, headSha: head, cwd: clone, preparedSurface, exec: realExec(head, calls) });
      expect(result).toMatchObject({ ok: false, held: true, humanOnly: true, reason: 'workflow-edit', paths: ['.github/workflows/ci.yml'] });
      expect(calls.some(([c, a]) => c === 'gh' && a.includes(`query=${ENQUEUE_MUTATION}`))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an unfetchable sha fails closed', () => {
    const { root, clone } = setup();
    try {
      expect(readPinnedChangedFiles({ headSha: 'f'.repeat(40), cwd: clone })).toHaveProperty('error');
      expect(readPinnedChangedFiles({ headSha: 'nope', cwd: clone })).toHaveProperty('error');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('isAlreadyQueuedError (card 257: a PR another path already enqueued is not a failed land)', () => {
  it("reads GitHub's 'already in the queue' refusal as already queued", () => {
    // Live text, 2026-10-13 (#5183, #5191, #5198): counted as a failed land, so the pass exited 2 and backed off.
    expect(isAlreadyQueuedError('gh: Pull request is already in the queue')).toBe(true);
    expect(isAlreadyQueuedError('Pull request is already in the merge queue')).toBe(true);
    expect(isAlreadyQueuedError('is already queued to merge')).toBe(true);
    expect(isAlreadyQueuedError("Pull request Required workflows 'Soak replay gate' failed")).toBe(false);
    expect(isAlreadyQueuedError('')).toBe(false);
  });
});

describe('the "merge-gate is expected" enqueue refusal routes to the VERIFIED stale-gate path', () => {
  const MESSAGE = `Pull request Required workflows 'Merge gate' failed Required status check "merge-gate" is expected.`;
  const green = name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
  function options(extra = {}) {
    return {
      c: { num: 6940, repo: 'o/r', headRef: 'lane/test', mergeGateExpected: true }, key: 'o/r#6940', headSha: HEAD,
      setting: 'on', staleMergeGateSetting: 'on', readGateRuns: vi.fn(() => [startupRun()]), cloneDir: '/clone',
      staleStatePath: join(mkdtempSync(join(tmpdir(), 'mge-')), 'ledger.json'), readState: () => ({}), record: vi.fn(),
      refreshStalePr: vi.fn(async () => ({ ok: true, action: 'rerun', newCommit: HEAD })), needsAcceptanceRestamp: () => false,
      restampAcceptance: vi.fn(), warn: vi.fn(), ...extra,
    };
  }
  it('enqueuePr tags the refusal as a required-workflows refusal marked gateExpected, without widening the old matcher', () => {
    expect(isRequiredWorkflowsUnsatisfiedError(MESSAGE)).toBe(false);
    const result = enqueuePr({ repo: 'o/r', num: 7, headSha: HEAD, cwd: CWD, exec: execFor({ files: [['a.txt', '']], mutation: JSON.stringify({ errors: [{ message: MESSAGE }] }) }) });
    expect(result).toMatchObject({ ok: false, reason: REQUIRED_WORKFLOWS_UNSATISFIED, gateExpected: true });
  });
  it('the drain normalizes --this-repo before expected-gate recovery, as it does for stale-gate recovery', () => {
    const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    for (const handler of ['handleRequiredWorkflowsRefusal', 'handleStaleMergeGate']) {
      expect(source.includes(`${handler}({ c: { ...c, repo: c.repo || localSlug }`), handler).toBe(true);
    }
  });
  it.each([null, 'o/r', 'other/repo'])('uses the canonical repository for run reads, refreshes and claims (candidate repo %s)', async repo => {
    const localSlug = 'o/r';
    const candidate = { num: 6940, repo, headRef: 'lane/test', mergeGateExpected: true };
    const slug = repo || localSlug;
    const o = options({ c: { ...candidate, repo: slug }, readGateRuns: undefined });
    const transport = vi.mocked(execFileSyncThrottled);
    transport.mockReturnValueOnce(JSON.stringify({ total_count: 1, workflow_runs: [startupRun()] }));
    try {
      expect(await handleRequiredWorkflowsRefusal(o)).toMatchObject({ handled: true });
      expect(transport).toHaveBeenLastCalledWith('gh', ['api',
        `repos/${slug}/actions/runs?head_sha=${HEAD}&event=pull_request_target&per_page=100`], expect.any(Object));
      expect(o.refreshStalePr).toHaveBeenCalledWith(expect.objectContaining({ repo: slug, runId: 123 }));
      expect(o.record).toHaveBeenCalledWith(o.staleStatePath, `${slug}#6940`, expect.objectContaining({ fromHead: HEAD }));
      // An explicit slug on the next pass must share the local alias's atomic claim.
      const retry = { ...o, c: { ...candidate, repo: slug }, readGateRuns: vi.fn(() => [startupRun()]), refreshStalePr: vi.fn() };
      expect(await handleRequiredWorkflowsRefusal(retry)).toMatchObject({ handled: false, reason: expect.stringContaining('already claimed') });
      expect(retry.refreshStalePr).not.toHaveBeenCalled();
      expect(candidate.repo).toBe(repo);
    } finally {
      transport.mockReset();
      transport.mockImplementation(() => { throw new Error('unexpected GitHub IO'); });
      rmSync(dirname(o.staleStatePath), { recursive: true, force: true });
    }
  });
  it('refreshes once when the newest Merge gate run ended startup_failure, with run evidence and a durable claim', async () => {
    const o = options();
    expect(await handleRequiredWorkflowsRefusal(o)).toMatchObject({ handled: true, reason: expect.stringContaining('startup_failure (run 123)') });
    expect(o.readGateRuns).toHaveBeenCalledWith({ repo: 'o/r', headSha: HEAD });
    expect(o.refreshStalePr).toHaveBeenCalledTimes(1);
    expect(await handleRequiredWorkflowsRefusal(o)).toMatchObject({ handled: false });
    expect(o.refreshStalePr).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['success', [startupRun({ conclusion: 'success' })]], ['no runs', []], ['unreadable', 'garbage'],
  ])('does not refresh without startup_failure evidence: %s', async (_name, runs) => {
    const o = options({ readGateRuns: vi.fn(() => runs) });
    expect(await handleRequiredWorkflowsRefusal(o)).toMatchObject({ handled: false });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it('honours refreshOnStaleMergeGate=off', async () => {
    const o = options({ staleMergeGateSetting: 'off' });
    expect(await handleRequiredWorkflowsRefusal(o)).toMatchObject({ handled: false });
    expect(o.refreshStalePr).not.toHaveBeenCalled();
  });
  it('leaves an ordinary required-workflows refusal on the old handler', async () => {
    const o = options({ c: { num: 1, repo: 'o/r', headRef: 'lane/test' } });
    await handleRequiredWorkflowsRefusal(o);
    expect(o.readGateRuns).not.toHaveBeenCalled();
    expect(o.refreshStalePr).toHaveBeenCalledTimes(1);
  });
});
