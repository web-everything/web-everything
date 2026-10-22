import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixWaitingObserver, resolveFixWaitingSettings } from '../fix-waiting.mjs';
import { getRequiredStatusChecks } from '../../lib/required-status-checks.mjs';
import { readOwedMainRule } from '../../lib/renamed-pr-refresh.mjs';
import { createResourceFixThrottle, RESOURCE_GATE_STANDARD } from '../../lib/resource-gate.mjs';
import { runReconcileFixDispatch, planFixDispatchClaimStatus } from '../reconcile-fix-dispatch.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fix-waiting-')); dirs.push(dir);
  const path = join(dir, 'waiting.json');
  const provider = { ensureLabel: vi.fn(), setLabels: vi.fn() };
  const notify = vi.fn(() => ({ ok: true })); const log = vi.fn();
  const make = (extra = {}) => createFixWaitingObserver({ repo: 'web-everything/web-everything', path,
    provider, notify, log, setting: { value: 30, source: 'default' }, ...options, ...extra });
  return { path, provider, notify, log, make };
}
const entry = { pr: 5806, labels: [] };

describe('fix-waiting host-busy episodes', () => {
  it('sets the label on deferral, persists the first time, and avoids redundant GitHub calls', () => {
    const f = fixture();
    f.make({ now: 1000 }).deferred(entry);
    f.make({ now: 2000 }).deferred({ pr: entry.pr }); // no snapshot: use remembered label
    expect(f.provider.ensureLabel).toHaveBeenCalledTimes(1);
    expect(f.provider.setLabels).toHaveBeenCalledTimes(1);
    expect(Object.values(JSON.parse(readFileSync(f.path, 'utf8')))[0].firstDeferredAt).toBe(1000);
  });
  it('does nothing to an already labelled PR, then clears on an actual dispatch', () => {
    const f = fixture(); const labelled = { ...entry, labels: [{ name: 'fix-waiting:host-busy' }] };
    f.make({ now: 1 }).deferred(labelled);
    expect(f.provider.setLabels).not.toHaveBeenCalled();
    f.make({ now: 2 }).dispatched(labelled);
    expect(f.provider.setLabels).toHaveBeenCalledWith('web-everything/web-everything', 5806,
      { remove: ['fix-waiting:host-busy'] });
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({});
  });
  it('alerts once after the limit, and starts a fresh episode after dispatch', () => {
    const f = fixture();
    f.make({ now: 0 }).deferred(entry);
    f.make({ now: 29 * 60000 }).deferred({ pr: entry.pr });
    expect(f.notify).not.toHaveBeenCalled();
    f.make({ now: 31 * 60000 }).deferred({ pr: entry.pr });
    f.make({ now: 90 * 60000 }).deferred({ pr: entry.pr });
    expect(f.notify).toHaveBeenCalledTimes(1);
    f.make({ now: 91 * 60000 }).dispatched({ pr: entry.pr });
    f.make({ now: 92 * 60000 }).deferred(entry);
    f.make({ now: 123 * 60000 }).deferred({ pr: entry.pr });
    expect(f.notify).toHaveBeenCalledTimes(2);
  });
  it('dry-run reports set, clear and alert without writing labels, alerts or state', () => {
    const f = fixture();
    f.make({ now: 0, dryRun: true }).deferred(entry);
    expect(existsSync(f.path)).toBe(false);
    f.make({ now: 0 }).deferred(entry);
    const before = readFileSync(f.path, 'utf8');
    f.provider.setLabels.mockClear(); f.provider.ensureLabel.mockClear();
    const observer = f.make({ now: 31 * 60000, dryRun: true });
    observer.deferred({ pr: entry.pr }); observer.dispatched({ pr: entry.pr });
    expect(f.log.mock.calls.flat().join('\n')).toMatch(/would set fix-waiting:host-busy on #5806/);
    expect(f.log.mock.calls.flat().join('\n')).toMatch(/would clear fix-waiting:host-busy on #5806/);
    expect(f.log.mock.calls.flat().join('\n')).toMatch(/would alert/);
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.provider.ensureLabel).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled(); expect(readFileSync(f.path, 'utf8')).toBe(before);
  });
  it('uses the settings cascade and logs the resolved limit and source once per pass', () => {
    const setting = resolveFixWaitingSettings({ env: {}, platform: {}, file: { fixWaiting: { hostBusyAlertMinutes: 17 } } });
    expect(setting).toEqual({ value: 17, source: 'tool' });
    expect(resolveFixWaitingSettings({ env: {}, platform: {}, file: {} })).toEqual({ value: 30, source: 'default' });
    expect(resolveFixWaitingSettings({ env: { WE_FIX_WAITING_HOST_BUSY_ALERT_MINUTES: '5' }, platform: {}, file: {} }).source).toBe('env');
    const f = fixture({ setting }); const observer = f.make(); observer.deferred(entry); observer.deferred(entry);
    expect(f.log.mock.calls.filter(([line]) => line.includes('alert limit'))).toEqual([
      ['reconcile-fix-dispatch: fix-waiting alert limit 17 min (source: tool)'],
    ]);
  });
});

function passOptions(f, throttle) {
  return { checkStaleness: () => ({ fresh: true, behind: 0 }), priorityShadow: null,
    reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 5806, headRefName: 'lane/123-fix', labels: [] }], refusals: [] }),
    findItemFn: () => ({ num: '123', scope: ['we:scripts/a.mjs'] }), loadItems: () => [],
    // Match the reconcile-fix-dispatch fixtures: every external reader stays local.
    fetchItemlessDiffPaths: () => [], resolveFallbackScope: () => [], resolveCardScopeAtRef: () => [],
    readPrComments: () => [], readMainRedPriorityRecord: () => null,
    tryResume: () => ({ resumed: false, resumeAttempt: null }), tryResumeRound: null,
    pickFreeLanes: () => [10], listBuildClaims: () => [], listFixClaims: () => [],
    dispatchThrottle: throttle, waiting: f.make(), dispatch: vi.fn(() => ({ pr: 5806 })) };
}
it('observes a host-load refusal without changing the guard decision or launching', () => {
  const f = fixture(); const verdict = { admit: false, kind: 'host-load', why: 'cpu idle < 8%' };
  const options = passOptions(f, { tryAdmit: vi.fn(() => verdict) });
  const result = runReconcileFixDispatch(options);
  expect(result.refusals).toContainEqual({ pr: 5806, kind: 'host-load', why: verdict.why });
  expect(result.dispatched).toEqual([]); expect(options.dispatch).not.toHaveBeenCalled();
  expect(verdict).toEqual({ admit: false, kind: 'host-load', why: 'cpu idle < 8%' });
  expect(f.provider.setLabels).toHaveBeenCalledTimes(1);
});
it('clears only after a launch lands in dispatched', () => {
  const f = fixture(); f.make().deferred(entry);
  const options = passOptions(f, { tryAdmit: () => ({ admit: true }) });
  // Snapshot absent: persisted state supplies the label.
  options.reconcile = () => ({ dispatch: [{ kind: 'fix', prNumber: 5806, headRefName: 'lane/123-fix' }], refusals: [] });
  expect(runReconcileFixDispatch(options).dispatched).toEqual([{ pr: 5806 }]);
  expect(f.provider.setLabels.mock.calls.at(-1)[2]).toEqual({ remove: ['fix-waiting:host-busy'] });
});
it('live dry-run preview evaluates the throttle and only observes refusals', () => {
  const f = fixture(); const options = passOptions(f, { tryAdmit: () => ({ admit: false, kind: 'host-load', why: 'busy' }) });
  const result = planFixDispatchClaimStatus({ ...options, waiting: f.make({ dryRun: true }), readClaim: () => null });
  expect(result.entries[0].throttle).toEqual({ admit: false, kind: 'host-load', why: 'busy' });
  expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(existsSync(f.path)).toBe(false);
});

it('preserves a real resource throttle host-load refusal', () => {
  const f = fixture();
  const gate = vi.fn(() => ({ admit: false, kind: 'host-load', why: 'cpu idle < 8%' }));
  const throttle = createResourceFixThrottle({
    settings: { ...RESOURCE_GATE_STANDARD, fixCap: { ...RESOURCE_GATE_STANDARD.fixCap, floor: 2, ceiling: 2 } },
    listClaims: () => [], readSnap: () => null, readHeavyWait: () => null,
    gate, log: () => {}, sendBackReservedSlots: 0,
  });
  const options = passOptions(f, throttle);
  expect(runReconcileFixDispatch(options).refusals).toContainEqual({ pr: 5806, kind: 'host-load', why: 'cpu idle < 8%' });
  expect(gate).toHaveBeenCalledWith('fix');
  expect(options.dispatch).not.toHaveBeenCalled();
});

it('dry preview proposes clearing an admitted launch without writing', () => {
  const f = fixture();
  const options = passOptions(f, { tryAdmit: () => ({ admit: true }) });
  options.reconcile = vi.fn(() => ({ dispatch: [{ kind: 'fix', prNumber: 5806, headRefName: 'lane/123-fix',
    labels: ['fix-waiting:host-busy'] }], refusals: [] }));
  planFixDispatchClaimStatus({ ...options, waiting: f.make({ dryRun: true }), readClaim: () => null });
  expect(options.reconcile).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  expect(f.log.mock.calls.flat().join('\n')).toContain('would clear fix-waiting:host-busy on #5806');
  expect(f.provider.setLabels).not.toHaveBeenCalled();
  expect(existsSync(f.path)).toBe(false);
});

it('a failed launch retains the waiting label and episode', () => {
  const f = fixture(); f.make({ now: 1 }).deferred(entry);
  f.provider.setLabels.mockClear();
  const options = passOptions(f, { tryAdmit: () => ({ admit: true }) });
  options.dispatch = () => { throw new Error('launch failed'); };
  const result = runReconcileFixDispatch(options);
  expect(result.dispatched).toEqual([]);
  expect(result.refusals.some(row => row.kind === 'dispatch-failed')).toBe(true);
  expect(f.provider.setLabels).not.toHaveBeenCalled();
  expect(Object.values(JSON.parse(readFileSync(f.path, 'utf8')))[0].firstDeferredAt).toBe(1);
});

it('preview cache readers return live evidence without persisting it', () => {
  const f = fixture();
  const cachePath = join(f.path, 'checks.json');
  const checks = getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath, readOnly: true,
    readChecks: () => ({ checks: ['test'], classic: ['test'] }),
  });
  expect(checks.checks).toEqual(['test']);
  expect(existsSync(cachePath)).toBe(false);
  const cache = join(f.path, 'rules.json');
  const verdict = readOwedMainRule({ number: 5806, headRefOid: 'abc123', statusCheckRollup: [
    { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/1/job/42' },
  ] }, { slug: 'web-everything/web-everything', cache, readOnly: true, authors: new Set(),
    exec: () => '##[error]vitest failed',
  });
  expect(verdict.owed).toBe(false);
  expect(existsSync(cache)).toBe(false);
});
