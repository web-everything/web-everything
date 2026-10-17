import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signalFixDispatch, createFixHandoffSleep } from '../fix-handoff.mjs';
it('retains a send-back during a tick and wakes the following sleep', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-handoff-'));
  try {
    const sleep = createFixHandoffSleep({ dir });
    expect(signalFixDispatch({ repo: 'owner/repo', pr: 7, label: 'review:changes' }, { dir })).toBe(true);
    await expect(sleep(60_000)).resolves.toBe('handoff');
    expect(signalFixDispatch({ repo: 'owner/repo', pr: 7, label: 'review:accepted' }, { dir })).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
import { createResourceFixThrottle } from '../resource-gate.mjs';
it('keeps a send-back slot inside a reduced cap without bypassing host admission', () => {
  const throttle = createResourceFixThrottle({ listClaims: () => [], readSnap: () => null, readHeavyWait: () => 100,
    settings: { cutover: 'enforce', fixCap: { floor: 8, lowerBy: 4, lowerMinimum: 1, ceiling: 8 } },
    sendBackReservedSlots: 1, gate: () => ({ admit: true }), log: () => {} });
  for (let n = 0; n < 3; n++) expect(throttle.tryAdmit('ci-heal').admit).toBe(true);
  expect(throttle.tryAdmit('ci-heal').admit).toBe(false);
  expect(throttle.tryAdmit('fix', { sendBack: true }).admit).toBe(true);
  expect(throttle.tryAdmit('fix', { sendBack: true }).admit).toBe(false);
});
it('hands a CI-red label to the daemon in the label writer pass, only after success', async () => {
  const { writeLabelWithHandoff } = await import('../fix-handoff.mjs');
  const calls = [];
  writeLabelWithHandoff({ repo: 'owner/repo', pr: 8, label: 'ci:failed', write: () => calls.push('write') }, e => calls.push(e.label));
  expect(calls).toEqual(['write', 'ci:failed']);
  expect(() => writeLabelWithHandoff({ label: 'ci:failed', write: () => { throw Error('failed'); } }, () => calls.push('bad'))).toThrow('failed');
  expect(calls).toEqual(['write', 'ci:failed']);
});
it('wakes an already sleeping daemon from the real filesystem event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-handoff-'));
  try {
    const sleep = createFixHandoffSleep({ dir });
    const pending = sleep(60_000);
    signalFixDispatch({ repo: 'o/r', pr: 2, label: 'status:ci-red' }, { dir });
    await expect(pending).resolves.toBe('handoff');
    await expect(sleep(1)).resolves.toBe('interval');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('a send-back reservation never waives the host gate', () => {
  const throttle = createResourceFixThrottle({ sendBackReservedSlots: 1, listClaims: () => [], readSnap: () => null,
    settings: { cutover: 'enforce', fixCap: { floor: 1, ceiling: 1 } },
    gate: () => ({ admit: false, kind: 'host-load' }), log: () => {} });
  expect(throttle.tryAdmit('fix', { sendBack: true })).toMatchObject({ admit: false, kind: 'host-load' });
});
it('also checks local hand-offs when webhook waking is enabled', async () => {
  const { createEventWaker } = await import('../pr-events.mjs');
  let polled = false;
  const waker = createEventWaker({ role: 'fix', localWake: () => true,
    poll: async () => { polled = true; throw Error('should wake first'); } });
  await waker.sleep(60_000);
  expect(polled).toBe(false);
});
it('reserves exactly one send-back slot when no setting is supplied (the standard default)', () => {
  const throttleWith = live => createResourceFixThrottle({ env: {}, alive: () => true, readSnap: () => null, readHeavyWait: () => 0,
    listClaims: () => Array.from({ length: live }, (_, i) => ({ meta: { kind: 'fix', repo: 'we', pr: i + 1 } })),
    settings: { cutover: 'enforce', fixCap: { floor: 3, ceiling: 3 } }, gate: () => ({ admit: true }), log: () => {} });
  expect(throttleWith(1).tryAdmit('fix').admit).toBe(true); // a default of 2+ would refuse here
  const atReserve = throttleWith(2);
  expect(atReserve.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'fix-cap', reserved: 'send-back' }); // a default of 0 would admit
  expect(atReserve.tryAdmit('fix', { sendBack: true }).admit).toBe(true);
});
it.each([[1, 1], [1, 3], [2, 1], [2, 5], [3, 0], [4, 2]])(
  'cap %i with %i reserved slot(s) still admits an ordinary repair — the reserve never takes the last slot', (cap, reserve) => {
    const ordinary = cap - Math.min(reserve, cap - 1);
    expect(ordinary).toBeGreaterThanOrEqual(1);
    const throttleWith = live => createResourceFixThrottle({ env: {}, alive: () => true, readSnap: () => null, readHeavyWait: () => 0, sendBackReservedSlots: reserve,
      listClaims: () => Array.from({ length: live }, (_, i) => ({ meta: { kind: 'fix', repo: 'we', pr: i + 1 } })),
      settings: { cutover: 'enforce', fixCap: { floor: cap, ceiling: cap } }, gate: () => ({ admit: true }), log: () => {} });
    expect(throttleWith(ordinary - 1).tryAdmit('ci-heal').admit).toBe(true);
    expect(throttleWith(ordinary).tryAdmit('ci-heal').admit).toBe(false);
    expect(throttleWith(cap - 1).tryAdmit('fix', { sendBack: true }).admit).toBe(true);
  });

import { vi } from 'vitest';
import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
it('the live dispatch pass asks the throttle for the send-back slot only for a review:changes PR', () => {
  const entries = [
    { kind: 'fix', prNumber: 5401, headRefName: 'lane/5401-bounced', labels: ['review:changes'] },
    { kind: 'fix', prNumber: 5402, headRefName: 'lane/5402-ci-red', labels: ['ci:failed'] },
  ];
  // Only the reserved send-back slot is free: whichever entry the pass marks sendBack is the one that dispatches.
  const tryAdmit = vi.fn((_kind, { sendBack } = {}) => (sendBack ? { admit: true } : { admit: false, kind: 'fix-cap', reserved: 'send-back', why: 'reserved' }));
  const dispatch = vi.fn(entry => ({ pr: entry.pr, lane: entry.lane }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let result;
  try {
    result = runReconcileFixDispatch({
      root: '.', repo: 'we', checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => ({ dispatch: entries, refusals: [] }),
      findItemFn: key => ({ num: key, scope: [`we:scripts/${key}.mjs`] }),
      fetchItemlessDiffPaths: () => [], resolveFallbackScope: () => [],
      loadItems: () => [], pickFreeLanes: () => [3, 4], listBuildClaims: () => [], listFixClaims: () => [],
      dispatch, borrowGate: { consider: () => ({ borrow: false, why: 'borrow-off' }), clear: () => {} },
      priorityShadow: null, readMainRedPriorityRecord: () => null, dispatchThrottle: { tryAdmit },
    });
  } finally { log.mockRestore(); }
  expect(tryAdmit).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.calls.map(([entry]) => entry.pr)).toEqual([5401]);
  expect(result.refusals).toContainEqual(expect.objectContaining({ pr: 5402, kind: 'fix-cap' }));
});

// The real throttle through the real pass: cap 2, one live repair, so only the reserved send-back slot is open.
const passWith = (entries, extra = {}) => {
  const dispatch = vi.fn(entry => ({ pr: entry.pr, lane: entry.lane }));
  const borrowGate = { consider: vi.fn(() => ({ borrow: false, why: 'borrow-off' })), clear: vi.fn() };
  const dispatchThrottle = createResourceFixThrottle({ env: {}, alive: () => true, readSnap: () => null, readHeavyWait: () => 0,
    listClaims: () => [{ meta: { kind: 'fix', repo: 'we', pr: 1 } }],
    settings: { cutover: 'enforce', fixCap: { floor: 2, ceiling: 2 } }, gate: () => ({ admit: true }), log: () => {} });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = runReconcileFixDispatch({
      root: '.', repo: 'we', checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => ({ dispatch: entries, refusals: [] }),
      findItemFn: key => ({ num: key, scope: [`we:scripts/${key}.mjs`] }),
      fetchItemlessDiffPaths: () => [], resolveFallbackScope: () => [],
      loadItems: () => [], pickFreeLanes: () => [3], listBuildClaims: () => [], listFixClaims: () => [],
      dispatch, borrowGate, priorityShadow: null, readMainRedPriorityRecord: () => null, dispatchThrottle, ...extra,
    });
    return { result, dispatch, borrowGate };
  } finally { log.mockRestore(); }
};
it('a red-main fix still passes the fixer cap when only the send-back reservation is left (base admitted it)', () => {
  const { result, dispatch } = passWith([{ kind: 'fix', prNumber: 5269, headRefName: 'lane/302-red-main', mainFix: true, labels: ['ci:failed'] }]);
  expect(dispatch.mock.calls.map(([entry]) => entry.pr)).toEqual([5269]);
  expect(result.refusals).toEqual([]);
});
it('an ordinary repair held by the reservation may still borrow a builder slot, like any fixer-cap wait', () => {
  const { result, dispatch, borrowGate } = passWith([{ kind: 'fix', prNumber: 5268, headRefName: 'lane/304-ordinary', labels: ['ci:failed'] }]);
  expect(dispatch).not.toHaveBeenCalled();
  expect(borrowGate.consider).toHaveBeenCalledWith({ repo: 'we', pr: 5268 });
  expect(result.refusals).toEqual([expect.objectContaining({ pr: 5268, kind: 'fix-cap' })]);
});

import { buildCliDaemonEffects, fixDaemonPrEventsOptions } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
it('the fix daemon\'s real effects sleep on the hand-off mailbox: a send-back wakes the interval sleep', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-handoff-daemon-'));
  try {
    const pending = buildCliDaemonEffects({ owner: 'x', handoffDir: dir }).sleep(60_000);
    signalFixDispatch({ repo: 'o/r', pr: 3, label: 'review:changes' }, { dir });
    await expect(pending).resolves.toBe('handoff');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('the fix daemon hands its pr-events waker a local hand-off probe for its role and repos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-handoff-daemon-'));
  try {
    const opts = fixDaemonPrEventsOptions({ handoffDir: dir });
    expect(opts.role).toBe('fix');
    expect(opts.localWake()).toBe(false);
    signalFixDispatch({ repo: 'o/r', pr: 4, label: 'ci:failed' }, { dir });
    expect(opts.localWake()).toBe(true);
    expect(opts.localWake()).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { runReviewLabelCli } from '../../review-set-label.mjs';
it('review-set-label signals the fix daemon after a send-back write, through its injected seam', () => {
  const calls = [], signals = [];
  const provider = {
    name: 'stub', currentRepo: () => 'o/n', readPrReviews: () => [],
    readPrState: () => ({ labels: [{ name: 'review:pending' }], comments: [], headRefOid: 'a'.repeat(40), headRefName: 'lane/x', state: 'OPEN', body: '', title: '' }),
    readLabels: () => [{ name: 'review:pending' }],
    setLabels: (_r, _p, spec) => calls.push(['set', spec]), postComment: () => calls.push(['comment']),
  };
  const realExit = process.exit.bind(process);
  process.exit = code => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
  try {
    runReviewLabelCli({ argv: ['1048', '--repo=o/n', '--to=changes', '--actor=op'], provider, defaultActor: 'test', usage: 'usage', verdictBody: 'findings',
      buildComment: () => '# verdict', successResult: o => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }),
      emit: () => {}, signalFix: s => signals.push({ ...s, after: calls.length }) });
  } catch (e) { if (typeof e.exitCode !== 'number') throw e; } finally { process.exit = realExit; }
  expect(signals).toEqual([{ repo: 'o/n', pr: '1048', label: 'review:changes', after: 2 }]);
});

import { applyRedTeamGate } from '../../operations/red-team-gate-apply.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS } from '../red-team-gate.mjs';
it('the red-team gate signals the fix daemon when the PR is already review:changes (no label write to carry it)', async () => {
  const head = 'ea117e881164c3b6366b0bb78a3660c9a00503b1', comments = [{
    author: { login: 'web-everything' }, createdAt: '2026-10-10T02:04:41Z',
    body: renderRedTeamComment({ pr: 4722, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [{ summary: 'two writers', category: 'edge-case', impactIfUnfixed: 'broken', file: 'scripts/x.mjs', line: 3, confirmedByRecheck: true, recheckReason: 'real' }] }),
  }];
  const signals = [], sends = [];
  const io = {
    readPr: () => ({ headRefOid: head, labels: [{ name: 'review:changes' }], comments }), readHead: () => head,
    readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readRound: () => 1, dequeueSentBack: () => ({ dequeued: false }),
    sendBack: a => { sends.push(a); return { ok: true }; }, appendSendBackEvent: async () => {}, fileCard: () => ({ ok: true }),
    postComment: a => comments.push({ author: { login: 'web-everything' }, body: a.body }), log: () => {},
    signalFix: s => signals.push(s),
  };
  expect(await applyRedTeamGate({ repo: 'web-everything/web-everything', pr: 4722 }, io)).toMatchObject({ status: 'applied', outcome: 'sent-back' });
  expect(sends).toEqual([]);
  expect(signals).toEqual([{ repo: 'web-everything/web-everything', pr: 4722, label: 'review:changes' }]);
});
it('the red-team gate io wires the real fix-daemon signal', async () => {
  const { createRedTeamGateIo } = await import('../../operations/red-team-gate-apply.mjs');
  const { signalFixDispatch } = await import('../fix-handoff.mjs');
  expect(createRedTeamGateIo({ env: {} }).signalFix).toBe(signalFixDispatch);
});
