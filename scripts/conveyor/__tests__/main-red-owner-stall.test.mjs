import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../main-ci-red-core.mjs';
import { probeAndOwnMainCi, readFixPrCi } from '../main-ci-red-io.mjs';
import mainSmell from '../health-smells/main-ci-red.mjs';
import { decideDelivery } from '../../lib/quiet-hours.mjs';
import { emptyHealthState, stepEpisodes, planActions } from '../health-watch-core.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../health-smells-notify-list.mjs';

// card 302: recorded facts, private ledgers, no GitHub or dispatch.
const facts = JSON.parse(readFileSync('scripts/conveyor/__tests__/fixtures/main-red-owner-stall-2026-10-14.json'));
const quietSettings = JSON.parse(readFileSync('scripts/quiet-hours-settings.json'));
const isolated = { mainCiRedRerunCancelledTip: false, mainCiRedFlakeSignaturePattern: '', mainCiRedMergeGroupFlakeEvidence: false };
const at = (time) => Date.parse('2026-10-14T' + time + 'Z');
const state = core.mainRedState(facts.mainRuns);
const settings = core.mainCiRedSettings(isolated);
const owner = { kind: 'dispatched', ref: 'main-fix-62da75ed3' };
const ci = { status: 'red', completedAt: facts.ownerRun.updatedAt, failedJobs: ['integration'] };
const assess = (extra = {}) => core.assessOwnerProgress({ state, owner, ownerPrs: [{ ...facts.pr, ci }],
  ledgerEntry: facts.ledger['62da75ed3'], now: at('07:28:00'), settings, ...extra });

async function replay(time, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'card302-'));
  const rerun = extra.rerun ?? vi.fn();
  try {
    writeFileSync(join(dir, 'main-red-owners.json'), JSON.stringify({ ...facts.ledger, _reruns: extra.reruns ?? {} }));
    const result = await probeAndOwnMainCi({ dir, now: at(time), config: { ...isolated, ...extra.config },
      dryRun: extra.dryRun ?? true, readRuns: () => ({ runs: structuredClone(extra.runs ?? facts.mainRuns), failing: { jobs: ['integration'] } }),
      readPrs: () => extra.unreadablePrs ? null : at(time) < Date.parse(facts.pr.createdAt) ? [] : [extra.pr ?? facts.pr],
      readPrCi: () => extra.ci ?? ci, listAgents: async () => [], gates: async () => ({ killed: true }),
      publishState: vi.fn(), publishPriority: vi.fn(), rerun,
    });
    return { result, rerun, ledger: JSON.parse(readFileSync(join(dir, 'main-red-owners.json'))) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('card 302 stalled red-main owner replay', () => {
  it('waits for dispatch and CI progress, then escalates by period', async () => {
    for (const time of ['06:30:00', '07:20:00']) {
      const { result } = await replay(time);
      expect(result.ownerStall).toMatchObject({ moving: true });
      expect(result.escalation).toBeNull();
    }
    const { result } = await replay('07:28:00');
    expect(result.ownerStall).toMatchObject({ stalled: true, reason: 'owner-ci-red', since: Date.parse(ci.completedAt) });
    expect(result.escalation).toMatchObject({ n: 1 });
    expect(result.recovery).toBeNull();
    const { default: smell } = await import('../health-smells/main-ci-red-owner-stalled.mjs');
    const sign = smell.evaluate({ mainCiRuns: result }, { now: at('07:28:00'), config: isolated })[0];
    expect(sign).toMatchObject({ breach: true, subject: 'main:62da75ed3:escalation-1' });
    expect(NOTIFY_EVEN_IN_SHADOW.has(smell.id)).toBe(true);
    const episode = stepEpisodes(emptyHealthState(), [{ smell, results: [sign] }], at('07:28:00'));
    expect(episode.transitions[0].type).toBe('opened');
    expect(planActions(episode.transitions, { [smell.id]: smell }, { mode: 'shadow' })
      .find((action) => action.kind === 'notify').suppressed).toBeNull();
    expect(decideDelivery({ title: 'Health: ' + smell.id + ' — ' + sign.subject },
      { now: at('07:27:00'), settings: quietSettings })).toMatchObject({ deliver: true, quiet: true, reason: 'breakthrough: main red (title)' });
    expect(mainSmell.evaluate({ mainCiRuns: result }, { now: at('07:28:00'), config: isolated, quarantineSafetyNet: null })[0].recommendation)
      .toContain('gh run rerun 38517676708 --failed');
    const later = (await replay('08:28:00')).result;
    expect(later.escalation.n).toBe(2);
    expect(smell.evaluate({ mainCiRuns: later }, { now: at('08:28:00') })[0].subject).toBe('main:62da75ed3:escalation-2');
  });
  it('recovers once or proposes reverting the first red commit', async () => {
    const { result, rerun } = await replay('07:58:00');
    expect(result.recovery).toMatchObject({ kind: 'rerun', runId: 38517676708, reason: 'owner-stalled', status: 'dry-run' });
    expect(rerun).not.toHaveBeenCalled();
    expect((await replay('07:58:00', { reruns: { 38517676708: { kind: 'owner-stalled' } } })).result.recovery)
      .toMatchObject({ kind: 'revert-proposal', sha: '62da75ed3' });
    const live = await replay('07:58:00', { dryRun: false });
    expect(live.rerun).toHaveBeenCalledTimes(1);
    expect(live.rerun).toHaveBeenCalledWith(38517676708);
    expect(live.ledger._reruns['38517676708']).toMatchObject({ kind: 'owner-stalled', status: 'issued' });
    const again = await replay('07:59:00', { dryRun: false, reruns: live.ledger._reruns });
    expect(again.rerun).not.toHaveBeenCalled();
    expect(again.result.recovery.kind).toBe('revert-proposal');
    const failed = await replay('07:58:00', { dryRun: false, rerun: vi.fn().mockRejectedValue(new Error('unavailable')) });
    expect(failed.ledger._reruns['38517676708']).toMatchObject({ kind: 'owner-stalled', status: 'failed', error: 'unavailable' });
  });
  it('suppresses a stalled owner while main is being re-run or facts are unreadable', async () => {
    const runs = facts.mainRuns.map((run) => run.databaseId === 38517676708
      ? { ...run, status: 'in_progress', conclusion: null, attempt: 2 } : run);
    const pending = (await replay('07:58:00', { runs, reruns: { 38517676708: { kind: 'owner-stalled' } } })).result;
    expect(pending.ownerStall).toMatchObject({ moving: true, reason: 'rerun-pending' });
    expect(pending.escalation).toBeNull();
    expect(pending.recovery).toBeNull();
    expect((await replay('07:58:00', { unreadablePrs: true })).result.escalation).toBeNull();
    const { result } = await replay('07:58:00', { config: { mainCiRedAutoRecover: false } });
    expect(result.ownerStall.stalled).toBe(true);
    expect(result.recovery).toBeNull();
  });
  it('logs the effective health overrides and their sources', async () => {
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await replay('07:58:00', { config: { mainCiRedOwnerStallMin: 30, mainCiRedAutoRecover: true } });
      const lines = log.mock.calls.map(([line]) => line);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('mainCiRedOwnerStallMin=30 (source health)');
      expect(lines[1]).toContain('mainCiRedAutoRecover=true (source health)');
      expect(lines[1]).toContain('mainCiRedAutoRecoverAfterMin=60 (source standard)');
    } finally { log.mockRestore(); }
  });
  it('stops escalation for a new head in flight and preserves old fields when off', async () => {
    const moving = (await replay('07:58:00', {
      pr: { ...facts.pr, headRefOid: 'new-head' },
      ci: readFixPrCi({ ...facts.pr, headRefOid: 'new-head' }, {
        exec: (bin, args) => JSON.stringify(args[0] === 'run'
          ? [{ ...facts.ownerRun, headSha: 'new-head', databaseId: 2, createdAt: '2026-10-14T07:40:00Z', status: 'in_progress' }, facts.ownerRun]
          : { total_count: 1, jobs: [{ name: 'integration', conclusion: 'failure' }] }),
      }),
    })).result;
    expect(moving.ownerStall.moving).toBe(true);
    expect(moving.escalation).toBeNull();
    const on = (await replay('07:28:00')).result;
    const off = (await replay('07:28:00', { config: { mainCiRedOwnerStallMin: 0 } })).result;
    expect(off.ownerStall).toBeUndefined();
    const { ownerStall, escalation, recovery, ...old } = on;
    expect(JSON.stringify(off)).toBe(JSON.stringify(old));
  });
});

describe('owner head without CI runs', () => {
  const read = (runs) => readFixPrCi(facts.pr, { exec: () => JSON.stringify(runs) });
  const deadline = Date.parse(facts.pr.createdAt) + 45 * core.MINUTE;

  it.each([[], [{ ...facts.ownerRun, headSha: 'old-head' }],
    [{ ...facts.ownerRun, headSha: 'old-head', status: 'in_progress' }]].map((runs) => ({ runs })))
  ('distinguishes missing current-head CI from an observed active run ($runs)', ({ runs }) => {
    expect(read(runs)).toMatchObject({ status: 'missing', completedAt: null });
    expect(read(runs).pending).not.toBe(true);
  });

  it('bounds missing CI through the real reader and owner-progress wiring', async () => {
    const missing = read([]);
    const early = (await replay('07:27:11', { ci: missing })).result;
    expect(early.ownerStall).toMatchObject({ moving: true, reason: 'owner-ci-deadline' });
    const expired = (await replay('07:27:12', { ci: missing })).result;
    expect(expired.ownerStall).toMatchObject({ stalled: true, reason: 'owner-ci-missing', since: deadline });
    expect(expired.escalation).not.toBeNull();
    expect(expired.recovery).toBeNull();
    const later = (await replay('12:00:00', { ci: missing })).result;
    expect(later.escalation).not.toBeNull();
    expect(later.recovery).toMatchObject({ kind: 'rerun', reason: 'owner-stalled' });
    expect(assess({ ownerPrs: [{ ...facts.pr, ci: missing }], now: deadline + 7 * 24 * 60 * core.MINUTE }))
      .toMatchObject({ stalled: true, reason: 'owner-ci-missing', since: deadline });
    const repeated = (await replay('12:00:00', { ci: missing, reruns: { 38517676708: { kind: 'owner-stalled' } } })).result;
    expect(repeated.recovery.kind).toBe('revert-proposal');
  });

  it('filters by current commit before limiting branch history', () => {
    const otherHeads = Array.from({ length: 5 }, (_, i) => ({ ...facts.ownerRun, headSha: `other-${i}` }));
    const ownerCi = readFixPrCi(facts.pr, { exec: (bin, args) => {
      if (args[0] !== 'run') return JSON.stringify({ total_count: 1, jobs: [{ name: 'integration', conclusion: 'success' }] });
      return JSON.stringify(args[args.indexOf('--commit') + 1] === facts.pr.headRefOid
        ? [{ ...facts.ownerRun, conclusion: 'success' }] : otherHeads);
    } });
    expect(ownerCi.status).toBe('green');
    expect(assess({ ownerPrs: [{ ...facts.pr, ci: ownerCi }], now: deadline + 7 * 24 * 60 * core.MINUTE }).moving).toBe(true);
  });

  it('requires observed pending evidence and handles multiple owners and timestamp fallbacks', () => {
    const missing = { status: 'missing', completedAt: null };
    for (const status of ['missing', 'pending']) {
      expect(assess({ ownerPrs: [{ ...facts.pr, ci: { ...missing, status } }] }))
        .toMatchObject({ stalled: true, reason: 'owner-ci-missing', since: deadline });
    }
    expect(assess({ ownerPrs: [{ ...facts.pr, ci: missing }, { ci }] }))
      .toMatchObject({ stalled: true, since: deadline });
    expect(assess({ ownerPrs: [{ ...facts.pr, ci: missing }, { ci: { status: 'pending', pending: true } }] }).moving).toBe(true);
    expect(assess({ ownerPrs: [{ ci: missing }] }).since).toBe(facts.ledger['62da75ed3'].at + 45 * core.MINUTE);
    expect(assess({ ownerPrs: [{ ci: missing }], ledgerEntry: null, owner: { kind: 'pr' } }).since)
      .toBe(state.redSinceMs + 45 * core.MINUTE);
    expect(assess({ ownerPrs: [{ ...facts.pr, ci: missing }], settings: { ...settings, mainCiRedOwnerPrDeadlineMin: 0 } }).moving).toBe(true);
  });

  it('keeps unreadable responses unknown and only recognizes active run statuses', () => {
    for (const response of [null, {}, { status: 'deferred-low-budget' }]) expect(read(response).status).toBe('unknown');
    expect(readFixPrCi(facts.pr, { exec: () => { throw new Error('unavailable'); } }).status).toBe('unknown');
    expect(read([{ ...facts.ownerRun, status: 'unrecognized' }]).status).toBe('unknown');
    for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      expect(read([{ ...facts.ownerRun, status, conclusion: null }])).toMatchObject({ status: 'pending', pending: true });
    }
  });
});

describe('completed inconclusive owner CI', () => {
  const pr = { ...facts.pr, headRefOid: 'new-head' };
  const old = { ...facts.ownerRun, headSha: 'old-head', updatedAt: '2026-10-14T06:30:00Z' };
  const finished = { ...facts.ownerRun, databaseId: 2, headSha: pr.headRefOid,
    createdAt: '2026-10-14T07:00:00Z', updatedAt: '2026-10-14T07:10:00Z', conclusion: 'cancelled' };
  const read = (runs) => readFixPrCi(pr, { exec: (bin, args) => {
    if (args[0] === 'run') return JSON.stringify(runs);
    return JSON.stringify({ total_count: 1, jobs: [{ name: 'integration', conclusion: 'success' }] });
  } });
  const outcomes = [
    { conclusion: 'cancelled' }, { conclusion: 'skipped' }, { conclusion: 'neutral' },
    { conclusion: 'failure', infraOnly: true },
  ];

  it.each(outcomes)('escalates and recovers after completed $conclusion owner CI stops moving', async (outcome) => {
    const ownerCi = read([{ ...finished, ...outcome }, old]);
    expect(ownerCi).toMatchObject({ status: 'inconclusive', completedAt: finished.updatedAt, failedJobs: [] });
    expect(ownerCi.pending).not.toBe(true);
    const recent = (await replay('07:39:59', { pr, ci: ownerCi })).result;
    expect(recent.ownerStall).toMatchObject({ moving: true, reason: 'owner-ci-recent' });
    expect(recent.escalation).toBeNull();
    const stalled = (await replay('07:40:00', { pr, ci: ownerCi })).result;
    expect(stalled.ownerStall).toMatchObject({ stalled: true, reason: 'owner-ci-inconclusive', since: at('07:10:00') });
    expect(stalled.escalation).not.toBeNull();
    const later = (await replay('12:00:00', { pr, ci: ownerCi })).result;
    expect(later.escalation).not.toBeNull();
    expect(later.recovery).toMatchObject({ kind: 'rerun', reason: 'owner-stalled', status: 'dry-run' });
    const retried = (await replay('12:00:00', { pr, ci: ownerCi, reruns: { 38517676708: { kind: 'owner-stalled' } } })).result;
    expect(retried.recovery).toMatchObject({ kind: 'revert-proposal' });
  });

  it('uses the completed current head with no history, older green CI, or unrelated active CI', () => {
    for (const history of [[], [{ ...old, conclusion: 'success' }], [{ ...old, status: 'in_progress', createdAt: '2026-10-14T08:00:00Z' }]]) {
      expect(read([finished, ...history])).toMatchObject({ status: 'inconclusive', completedAt: finished.updatedAt });
    }
    expect(read([{ ...finished, updatedAt: null }])).toMatchObject({ status: 'inconclusive', completedAt: null });
    expect(assess({ ownerPrs: [{ ci: read([{ ...finished, updatedAt: null }]) }] }).moving).toBe(true);
  });

  it('honors newer active and successful runs on the current head', async () => {
    const next = { ...finished, databaseId: 3, createdAt: '2026-10-14T07:20:00Z', updatedAt: '2026-10-14T07:30:00Z' };
    for (const status of ['queued', 'in_progress']) {
      const ownerCi = read([{ ...next, status, conclusion: null }, finished, old]);
      expect(ownerCi).toMatchObject({ status: 'pending', pending: true });
      expect((await replay('12:00:00', { pr, ci: ownerCi })).result.escalation).toBeNull();
    }
    const green = read([{ ...next, conclusion: 'success' }, finished, old]);
    expect(green.status).toBe('green');
    expect((await replay('12:00:00', { pr, ci: green })).result.escalation).toBeNull();
  });
});

describe('inconclusive main rerun recovery', () => {
  const outcomes = [
    { name: 'cancelled', conclusion: 'cancelled' },
    { name: 'skipped', conclusion: 'skipped' },
    { name: 'infra-only', conclusion: 'failure', infraOnly: true },
  ];
  const cases = ['owner-stalled', 'flake', 'manual'].flatMap((kind) => outcomes.map((outcome) => ({ kind, ...outcome })));

  it.each(cases)('preserves red main after a $kind rerun is $name and resumes escalation', async ({ kind, conclusion, infraOnly }) => {
    const runs = facts.mainRuns.map((run) => run.databaseId === 38517676708
      ? { ...run, status: 'completed', attempt: 2, conclusion, infraOnly } : run);
    // Flake retries are exhausted; manual reruns have no ledger entry.
    const reruns = kind === 'manual' ? {} : { 38517676708: { kind, rounds: kind === 'flake' ? core.FLAKE_RERUN_ROUNDS : 1 } };
    const { result, rerun } = await replay('08:28:00', { runs, reruns, dryRun: false });
    expect(core.mainRedState(result.runs)).toMatchObject({ status: 'red', firstRed: { runId: 38517676708 } });
    expect(result.mainRed).toMatchObject({ red: true, firstRedSha: '62da75ed3' });
    expect(result.ownerStall).toMatchObject({ stalled: true, reason: 'owner-ci-red' });
    expect(result.escalation).toMatchObject({ n: 2 });
    expect(result.recovery).toMatchObject({ kind: 'revert-proposal', sha: '62da75ed3' });
    expect(rerun).not.toHaveBeenCalled();
    const { default: smell } = await import('../health-smells/main-ci-red-owner-stalled.mjs');
    expect(smell.evaluate({ mainCiRuns: result }, { now: at('08:28:00'), config: isolated })[0].breach).toBe(true);
    expect(mainSmell.evaluate({ mainCiRuns: result }, { now: at('08:28:00'), config: isolated, quarantineSafetyNet: null })[0].breach).toBe(true);
  });

  it.each(outcomes)('does not invent a red verdict for a cancelled-tip rerun that is $name', async ({ conclusion, infraOnly }) => {
    const runs = facts.mainRuns.filter((run) => run.databaseId !== 38517676708).map((run) => run.databaseId === 38517780758
      ? { ...run, attempt: 2, conclusion, infraOnly } : run);
    const { result } = await replay('08:28:00', { runs, reruns: { 38517780758: { kind: 'cancelled-tip' } } });
    expect(core.mainRedState(result.runs).status).toBe('green');
    expect(result.decision.reason).toBe('main-green');
  });

  it.each(['same run', 'newer run'])('clears red main when a %s succeeds after owner-stalled recovery', async (success) => {
    const runs = facts.mainRuns.map((run) => run.databaseId === 38517676708
      ? { ...run, attempt: 2, conclusion: success === 'same run' ? 'success' : 'cancelled' } : run);
    if (success === 'newer run') runs.push({ ...facts.mainRuns[2], databaseId: 99, headSha: 'recovered', createdAt: '2026-10-14T08:20:00Z' });
    const { result } = await replay('08:28:00', { runs, reruns: { 38517676708: { kind: 'owner-stalled' } } });
    expect(core.mainRedState(result.runs).status).toBe('green');
    expect(result.decision.reason).toBe('main-green');
  });
});

describe('card 302 pure boundaries', () => {
  it('uses deadlines and finished-run timestamps, failing closed on unknown progress', () => {
    expect(assess().stalled).toBe(true);
    expect(assess({ rerunPending: true }).moving).toBe(true);
    expect(assess({ now: Date.parse(ci.completedAt) + 30 * core.MINUTE - 1 }).moving).toBe(true);
    expect(assess({ now: Date.parse(ci.completedAt) + 30 * core.MINUTE }).stalled).toBe(true);
    expect(assess({ ownerPrs: [{ ci: { status: 'unknown' } }] }).moving).toBe(true);
    expect(assess({ ownerPrs: [{ ci: { status: 'green', completedAt: ci.completedAt } }] }).moving).toBe(true);
    const deadline = facts.ledger['62da75ed3'].at + 45 * core.MINUTE;
    expect(assess({ ownerPrs: [], now: deadline - 1 }).moving).toBe(true);
    expect(assess({ ownerPrs: [], now: deadline })).toMatchObject({ stalled: true, reason: 'no-owner-pr', since: deadline });
    expect(assess({ ownerPrs: [], settings: { ...settings, mainCiRedOwnerPrDeadlineMin: 0 } }).moving).toBe(true);
    expect(assess({ settings: { ...settings, mainCiRedOwnerStallMin: 0 } }).moving).toBe(true);
    expect(assess({ owner: null }).moving).toBe(true);
    expect(assess({ ownerPrs: null }).moving).toBe(true);
    expect(assess({ ownerPrs: [{ ci }, { ci: { status: 'pending', pending: true } }] }).moving).toBe(true);
    expect(assess({ ownerPrs: [{ ci }, { ci: { ...ci, completedAt: '2026-10-14T07:20:00Z' } }] }).moving).toBe(true);
  });
  it('gates escalation and recovery at exact thresholds and honors off values', () => {
    const stall = assess();
    const plan = (extra = {}) => core.planEscalation({ state, stall, now: at('07:28:00'), settings, ...extra });
    expect(plan()).toEqual({ n: 1, at: stall.since });
    expect(plan({ state: { ...state, redSinceMs: at('07:00:00') }, now: at('08:00:00') }))
      .toEqual({ n: 1, at: at('08:00:00') });
    expect(plan({ now: stall.since + 60 * core.MINUTE - 1 }).n).toBe(1);
    expect(plan({ now: stall.since + 60 * core.MINUTE }).n).toBe(2);
    expect(plan({ now: state.redSinceMs + 60 * core.MINUTE - 1 })).toBeNull();
    expect(plan({ stall: { moving: true } })).toBeNull();
    for (const key of ['mainCiRedEscalateAfterMin', 'mainCiRedEscalateEveryMin'])
      expect(plan({ settings: { ...settings, [key]: 0 } })).toBeNull();
    const recover = (extra = {}) => core.planStalledRecovery({ stall, failingRun: facts.mainRuns[1], reruns: {}, settings,
      now: stall.since + 60 * core.MINUTE, ...extra });
    expect(recover({ now: stall.since + 60 * core.MINUTE - 1 })).toBeNull();
    expect(recover({ settings: { ...settings, mainCiRedAutoRecover: false } })).toBeNull();
    expect(recover({ settings: { ...settings, mainCiRedAutoRecoverAfterMin: 0 } })).toBeNull();
    for (const run of [{ ...facts.mainRuns[1], attempt: 2 }, { ...facts.mainRuns[1], status: 'in_progress' }, null])
      expect(recover({ failingRun: run })).toMatchObject({ kind: 'revert-proposal', sha: state.firstRed.sha });
    expect(assess({ state: { ...state, firstRed: { ...state.firstRed, attempt: 2 } } }).approval).toContain('review a revert');
  });
  it('reads completedAt and detects a newer run in flight', () => {
    const read = (runs) => readFixPrCi(facts.pr, { exec: (bin, args) => JSON.stringify(args[0] === 'run' ? runs
      : { total_count: 1, jobs: [{ name: 'integration', conclusion: 'failure' }] }) });
    expect(read([facts.ownerRun])).toMatchObject(ci);
    expect(read([{ ...facts.ownerRun, databaseId: 2, createdAt: '2026-10-14T07:40:00Z', status: 'in_progress' }, facts.ownerRun]))
      .toMatchObject({ pending: true, completedAt: ci.completedAt });
  });
});
