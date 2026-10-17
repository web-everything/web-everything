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
it('reserves one send-back slot when no setting is supplied (the standard default)', () => {
  const claims = [{ meta: { kind: 'fix', repo: 'we', pr: 1 } }];
  const throttle = createResourceFixThrottle({ env: {}, listClaims: () => claims, alive: () => true, readSnap: () => null, readHeavyWait: () => 0,
    settings: { cutover: 'enforce', fixCap: { floor: 2, ceiling: 2 } }, gate: () => ({ admit: true }), log: () => {} });
  expect(throttle.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'send-back-reserved' });
  expect(throttle.tryAdmit('fix', { sendBack: true }).admit).toBe(true);
});

import { vi } from 'vitest';
import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
it('the live dispatch pass asks the throttle for the send-back slot only for a review:changes PR', () => {
  const entries = [
    { kind: 'fix', prNumber: 5401, headRefName: 'lane/5401-bounced', labels: ['review:changes'] },
    { kind: 'fix', prNumber: 5402, headRefName: 'lane/5402-ci-red', labels: ['ci:failed'] },
  ];
  const tryAdmit = vi.fn(() => ({ admit: false, kind: 'fix-cap', why: 'full' }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    runReconcileFixDispatch({
      root: '.', repo: 'we', checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => ({ dispatch: entries, refusals: [] }),
      findItemFn: key => ({ num: key, scope: [`we:scripts/${key}.mjs`] }),
      fetchItemlessDiffPaths: () => [], resolveFallbackScope: () => [],
      loadItems: () => [], pickFreeLanes: () => [3, 4], listBuildClaims: () => [], listFixClaims: () => [],
      dispatch: vi.fn(), borrowGate: { consider: () => ({ borrow: false, why: 'borrow-off' }), clear: () => {} },
      priorityShadow: null, readMainRedPriorityRecord: () => null, dispatchThrottle: { tryAdmit },
    });
  } finally { log.mockRestore(); }
  expect(tryAdmit.mock.calls).toEqual(expect.arrayContaining([['fix', { sendBack: true }], ['fix', { sendBack: false }]]));
  expect(tryAdmit).toHaveBeenCalledTimes(2);
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
