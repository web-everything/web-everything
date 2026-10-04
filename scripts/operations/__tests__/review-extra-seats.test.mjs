import { readRoutingPolicy } from '../../lib/dispatch-routing-policy-io.mjs';
/**
 * #4194 — ADDED NON-CLAUDE REVIEW SEATS: advisory lenses + one extra juror routed to Codex/Gemini through the
 * direct-task scripts, BESIDE Claude's mandatory seats. No real codex/agy/git/GitHub process: every effect is a fake.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reviewSeatRoutes, ROUTED_ADVISORY_LENSES, EXTRA_JUROR_MANDATE, REVIEW_SEAT_MODELS,
} from '../review-dispatch.mjs';
import {
  runExtraSeats, extraSeatsEnabled, resolveDailyCap, callsUsedToday, callsUsedTodayForProvider, quotaHold,
  PROBE_INTERVAL_ENV, DEFAULT_PROBE_INTERVAL_MS, resolveProbeIntervalMs, probeDue, quotaHoldOrProbe,
  claudeFindingsFromLoop, buildSeatTask, parseSeatAnswer, classifySeatCall, buildSeatRows, seatCallArgv, capDay,
  renderSeatSummary, EXTRA_SEATS_ENV, DAILY_CAP_ENV, DEFAULT_DAILY_CAP, PROVIDER_CAP_ENV, PROVIDER_CAP_DEFAULT,
  resolveProviderCap, reviewSeatCapUsage, toIsoInstant, extractAnswerJson, reserveSeatCalls, createExtraSeatsIo,
  withLedgerLock, isPinnedRev, repoRelativeFindings, readSeatCapUsage,
} from '../review-extra-seats.mjs';
import { runReviewJob, summarizeExtraSeats } from '../review-job.mjs';
import { ADVISORY_JUDGE_LENS, JUDGE_SEATS } from '../review-pr.mjs';
import {
  selectReviewSeatProvider, reviewSeatTaskType, REVIEW_SEAT_DISPATCH_KIND,
} from '../../lib/provider-routing.mjs';
import { ADVISORY_LENSES, MANDATORY_LENSES, findingCorroboratedBy } from '../../lib/jury-core.mjs';
import { validateScorecard, appendScorecard, writeStore } from '../../conveyor/run-scorecard-store.mjs';
import { buildCodexDirectTaskArgv, buildCodexPrompt } from '../../codex-direct-task.mjs';
import {
  buildAgyPrompt, buildAgyDirectTaskArgv, runAgyDirectExec, parseFlags as parseAgyFlags,
} from '../../gemini-direct-task.mjs';
import { EventEmitter } from 'node:events';

const REPO = 'web-everything/web-everything';
const NOW = Date.parse('2026-09-26T15:00:00Z');

const CLAUDE_FINDING = { summary: 'isMechanicalMergeCommit trusts the message headline alone, so a forged merge headline bypasses the gate', file: 'scripts/lib/ai-pr-authorship.mjs', line: 41 };
const LOOP_PAYLOAD = {
  runId: 'review-pr-1', stopped: 'complete', verdict: { verdict: 'changes' },
  findings: {
    read: {
      title: 'fix the thing', body: 'Claims: adds a guard.', diffText: 'diff --git a/x b/x\n+1\n',
      netChangedFiles: ['scripts/lib/ai-pr-authorship.mjs'], netBasis: { base: 'b'.repeat(40), rev: 'a'.repeat(40) },
    },
    judge: { findings: [CLAUDE_FINDING] },
    judgeSecurity: { findings: [] },
  },
};

const answer = (lenses) => `I reviewed it.\n\n\`\`\`json\n${JSON.stringify({ lenses })}\n\`\`\``;

/** A fake seat io recording every effect. Reservations are kept in ONE ledger PER PROVIDER inside `ledgerBox`
 *  (an object keyed by provider), matching the real io's per-provider ledger files — pass one `ledgerBox` to
 *  several fakes to model concurrent review jobs contending for the SAME provider's budget. */
function fakeSeatIo(over = {}, ledgerBox = {}) {
  const calls = [];
  const rows = [];
  const io = {
    now: () => NOW,
    newId: (() => { let n = 0; return () => `call-${++n}`; })(),
    log: (l) => calls.push(['log', l]),
    readRecords: () => [],
    reserveCalls: ({ provider, want, dailyCap, now }) => {
      const r = reserveSeatCalls({ ledger: ledgerBox[provider] ?? null, records: io.readRecords(), want, dailyCap, now, newId: io.newId, provider });
      ledgerBox[provider] = r.ledger;
      calls.push(['reserve', provider, want, r.callIds.length]);
      return r;
    },
    append: (row) => { const v = validateScorecard({ v: 1, scoredAt: new Date(NOW).toISOString(), ...row }); if (!v.ok) throw new Error(v.errors.join('; ')); rows.push(row); },
    cliAvailable: () => true,
    makeScratch: (o) => { calls.push(['scratch', o]); return '/tmp/seat-scratch'; },
    removeScratch: (d) => calls.push(['rm', d]),
    writeFile: (p) => calls.push(['write', p]),
    runSeat: async (o) => {
      calls.push(['seat', o]);
      if (o.provider === 'codex') {
        return { exitCode: 0, report: { lastMessage: answer({
          'extra-juror:correctness': { verdict: 'changes', findings: [{ summary: 'a forged merge headline bypasses isMechanicalMergeCommit', file: 'scripts/lib/ai-pr-authorship.mjs', line: 44, impactIfUnfixed: 'broken' }] },
        }), quotaUsedPercent: 12, quotaResetsAt: null } };
      }
      if (o.provider === 'agy-claude') {
        return { exitCode: 0, report: { events: { finalResponse: answer({ 'claim-accuracy': { verdict: 'changes', findings: [{ summary: 'PR body says tests were added; none were', file: null, impactIfUnfixed: 'cosmetic' }] } }) } } };
      }
      return { exitCode: 0, report: { events: { finalResponse: answer({ 'standards-conformance': { verdict: 'accept', findings: [] } }) } } };
    },
    ...over,
  };
  return { io, calls, rows };
}

describe('#4194 reviewSeatRoutes — which seats, on which provider', () => {
  it('routes the ADVISORY lenses and ONE extra juror to codex/agy-claude/agy-gemini, and never a mandatory lens\'s own seat', () => {
    const { routes, skipped } = reviewSeatRoutes({});
    expect(skipped).toEqual([]);
    expect(routes.map((r) => r.seat)).toEqual(['extra-juror', 'advisory-lens', 'advisory-lens']);
    expect(routes.filter((r) => r.seat === 'extra-juror')).toHaveLength(1);
    for (const r of routes) {
      expect(['codex', 'agy-claude', 'agy-gemini']).toContain(r.provider);
      expect(r.model).toBe(REVIEW_SEAT_MODELS[r.provider].model);
      if (r.seat === 'advisory-lens') expect(MANDATORY_LENSES).not.toContain(r.lens);
    }
    // spread across all three providers when all are usable (3 seats, 3 providers, no prior history)
    expect(new Set(routes.map((r) => r.provider)).size).toBe(3);
    // live-caught: agy refuses gemini-3.1-pro at `medium` ("available: low, high")
    expect(['low', 'high']).toContain(REVIEW_SEAT_MODELS['agy-gemini'].effort);
  });

  it('routes every advisory lens review-pr does not already seat off-Claude, and leaves Claude\'s mandatory seats alone', () => {
    expect(ROUTED_ADVISORY_LENSES).toEqual(ADVISORY_LENSES.filter((l) => l !== ADVISORY_JUDGE_LENS));
    expect(ROUTED_ADVISORY_LENSES).toEqual(expect.arrayContaining(['standards-conformance', 'claim-accuracy']));
    expect(EXTRA_JUROR_MANDATE).toBe('correctness');
    // Claude's own seats are still exactly review-pr's two mandatory ones.
    expect(JUDGE_SEATS.map((s) => s.step)).toEqual(['judge', 'judgeSecurity']);
  });

  it('daily cap: 0 calls left skips every seat; 1 call left puts every seat on one provider', () => {
    const none = reviewSeatRoutes({ callsRemaining: 0 });
    expect(none.routes).toEqual([]);
    expect(none.skipped.every((s) => /daily-cap/.test(s.reason))).toBe(true);
    const one = reviewSeatRoutes({ callsRemaining: 1 });
    expect(new Set(one.routes.map((r) => r.provider)).size).toBe(1);
    expect(one.routes).toHaveLength(3);
  });

  it('only available providers are picked; none available → named skips', () => {
    expect(reviewSeatRoutes({ available: ['agy-gemini'] }).routes.every((r) => r.provider === 'agy-gemini')).toBe(true);
    const none = reviewSeatRoutes({ available: [] });
    expect(none.routes).toEqual([]);
    expect(none.skipped).toHaveLength(3);
  });
});

describe('#4194 provider-routing selectReviewSeatProvider', () => {
  const row = (provider, status, scoredAt, lens = 'claim-accuracy') => ({ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider, status, scoredAt, taskType: reviewSeatTaskType(lens) });
  // These two tests are about the TIE-BREAK logic between two providers' histories, not about the full
  // three-provider set — `available` pins the comparison to exactly the two the scorecards below are about.
  const TWO = ['codex', 'agy-gemini'];

  it('ranks a provider whose last seat row for the lens failed after a clean one', () => {
    const scorecards = [row('codex', 'timeout', '2026-09-26T10:00:00Z'), row('agy-gemini', 'ok', '2026-09-26T09:00:00Z'), row('agy-gemini', 'ok', '2026-09-26T08:00:00Z')];
    expect(selectReviewSeatProvider({ lens: 'claim-accuracy', available: TWO, scorecards }).provider).toBe('agy-gemini');
    // a LATER clean codex row lifts the penalty; then fewer rows (explore evenly) wins
    const recovered = [...scorecards, row('agy-gemini', 'ok', '2026-09-26T07:00:00Z'), row('codex', 'ok', '2026-09-26T11:00:00Z')];
    expect(selectReviewSeatProvider({ lens: 'claim-accuracy', available: TWO, scorecards: recovered }).provider).toBe('codex');
  });

  it('a different lens\'s rows never count, and planned load spreads seats', () => {
    const scorecards = [row('codex', 'error', '2026-09-26T10:00:00Z', 'standards-conformance')];
    const pick = selectReviewSeatProvider({ lens: 'claim-accuracy', available: TWO, scorecards, plannedLoad: { 'agy-gemini': 1 } });
    expect(pick.provider).toBe('codex');
    expect(pick.auditTrail.length).toBeGreaterThan(1);
  });

  it('returns null with a reason when nothing is available, and is deterministic', () => {
    expect(selectReviewSeatProvider({ lens: 'x', available: [] }).provider).toBeNull();
    expect(selectReviewSeatProvider({ lens: 'x' })).toEqual(selectReviewSeatProvider({ lens: 'x' }));
  });
});

describe('card x6ov12s — quota hold self-probe', () => {
  const NOW = Date.parse('2026-09-29T14:00:00-04:00');
  const q = {
    dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider: 'codex', status: 'ok',
    quotaUsedPercent: 99, quotaResetsAt: '2026-10-03T17:11:00-04:00', scoredAt: '2026-09-28T22:31:00-04:00',
  };

  it('probeDue requires a row for that provider and a full interval since its timestamp', () => {
    const at = Date.parse(q.scoredAt);
    expect(probeDue([], 'codex', NOW, DEFAULT_PROBE_INTERVAL_MS)).toBe(false);
    expect(probeDue([q], 'agy-claude', NOW, DEFAULT_PROBE_INTERVAL_MS)).toBe(false);
    expect(probeDue([{ ...q, scoredAt: 'invalid' }], 'codex', NOW, DEFAULT_PROBE_INTERVAL_MS)).toBe(false);
    expect(probeDue([q], 'codex', at + DEFAULT_PROBE_INTERVAL_MS - 1, DEFAULT_PROBE_INTERVAL_MS)).toBe(false);
    expect(probeDue([q], 'codex', at + DEFAULT_PROBE_INTERVAL_MS, DEFAULT_PROBE_INTERVAL_MS)).toBe(true);
    expect(probeDue([q], 'codex', NOW, DEFAULT_PROBE_INTERVAL_MS)).toBe(true);
  });

  it('resolveProbeIntervalMs defaults when unset or invalid and respects a valid override', () => {
    expect(resolveProbeIntervalMs({})).toBe(DEFAULT_PROBE_INTERVAL_MS);
    expect(resolveProbeIntervalMs({ [PROBE_INTERVAL_ENV]: '60000' })).toBe(60_000);
    expect(resolveProbeIntervalMs({ [PROBE_INTERVAL_ENV]: '3600000' })).toBe(3_600_000);
    for (const v of ['lots', '-1', '59999', 'Infinity']) {
      expect(resolveProbeIntervalMs({ [PROBE_INTERVAL_ENV]: v })).toBe(DEFAULT_PROBE_INTERVAL_MS);
    }
  });

  it('quotaHoldOrProbe leaves an unheld provider available', () => {
    const clean = { ...q, quotaUsedPercent: 12 };
    expect(quotaHold([clean], 'codex', NOW)).toBeNull();
    expect(quotaHoldOrProbe([clean], 'codex', NOW, {})).toBeNull();
  });

  it('quotaHoldOrProbe preserves the exact hold reason until the probe is due', () => {
    const now = Date.parse(q.scoredAt) + DEFAULT_PROBE_INTERVAL_MS - 1;
    expect(quotaHold([q], 'codex', now)).toMatch(/99%/);
    expect(quotaHoldOrProbe([q], 'codex', now, {})).toBe(quotaHold([q], 'codex', now));
  });

  it('soak-break: the live incident stays held without the probe, but the probe admits it', () => {
    expect(quotaHold([q], 'codex', NOW)).toMatch(/99%.*2026-10-03T21:11:00.000Z/);
    expect(quotaHoldOrProbe([q], 'codex', NOW, {})).toBeNull();
  });

  it('a fresh exhausted probe re-arms the hold until another full interval elapses', () => {
    const at = Date.parse(q.scoredAt) + DEFAULT_PROBE_INTERVAL_MS;
    const records = [q, { ...q, status: 'quota-exhausted', scoredAt: '2026-09-28T23:01:00-04:00' }];
    expect(quotaHold(records, 'codex', at + 1)).toMatch(/quota exhausted/);
    expect(quotaHoldOrProbe(records, 'codex', at + 1, {})).toBe(quotaHold(records, 'codex', at + 1));
    expect(quotaHoldOrProbe(records, 'codex', at + DEFAULT_PROBE_INTERVAL_MS - 1, {})).toBe(quotaHold(records, 'codex', at + DEFAULT_PROBE_INTERVAL_MS - 1));
    expect(quotaHoldOrProbe(records, 'codex', at + DEFAULT_PROBE_INTERVAL_MS, {})).toBeNull();
  });
});

describe('#4194 cost controls — kill switch, cap, quota', () => {
  it('kill switch: only an explicit off value disables', () => {
    expect(extraSeatsEnabled({})).toBe(true);
    for (const v of ['0', 'off', 'false', 'no']) expect(extraSeatsEnabled({ [EXTRA_SEATS_ENV]: v })).toBe(false);
    expect(resolveDailyCap({})).toBe(DEFAULT_DAILY_CAP);
    expect(resolveDailyCap({ [DAILY_CAP_ENV]: '3' })).toBe(3);
    expect(resolveDailyCap({ [DAILY_CAP_ENV]: 'lots' })).toBe(DEFAULT_DAILY_CAP);
  });

  it('counts distinct calls on today\'s New York calendar day only', () => {
    const r = (callId, scoredAt) => ({ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, callId, scoredAt });
    const records = [r('a', '2026-09-26T14:00:00Z'), r('a', '2026-09-26T14:00:01Z'), r('b', '2026-09-26T05:00:00Z'), r('c', '2026-09-26T03:00:00Z')];
    // 03:00Z is still Sep 25 in New York
    expect(capDay('2026-09-26T03:00:00Z')).toBe('2026-09-25');
    expect(callsUsedToday(records, NOW)).toBe(2);
  });

  it('a provider sits out after a quota hit until its reset (or the cool-off), and a later clean row ends it', () => {
    const q = { dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider: 'codex', status: 'quota-exhausted', scoredAt: '2026-09-26T14:30:00Z' };
    expect(quotaHold([q], 'codex', NOW)).toMatch(/quota exhausted/);
    expect(quotaHold([q], 'codex', NOW + 2 * 60 * 60 * 1000)).toBeNull();
    expect(quotaHold([q, { ...q, status: 'ok', scoredAt: '2026-09-26T14:40:00Z' }], 'codex', NOW)).toBeNull();
    expect(quotaHold([{ ...q, status: 'ok', quotaUsedPercent: 99, quotaResetsAt: '2026-09-26T18:00:00Z' }], 'codex', NOW)).toMatch(/99%/);
    expect(quotaHold([q], 'gemini', NOW)).toBeNull();
    // live-caught: codex reports resets_at in epoch SECONDS
    expect(toIsoInstant(1790430415)).toBe(new Date(1790430415 * 1000).toISOString());
    expect(toIsoInstant('2026-09-26T18:00:00Z')).toBe('2026-09-26T18:00:00.000Z');
    expect(toIsoInstant(null)).toBeNull();
  });

  it('card xn2wf9t — per-provider caps are resolved and counted separately, with codex\'s own legacy fallback', () => {
    expect(resolveProviderCap('codex', {})).toBe(PROVIDER_CAP_DEFAULT.codex);
    expect(resolveProviderCap('agy-claude', {})).toBe(PROVIDER_CAP_DEFAULT['agy-claude']);
    expect(PROVIDER_CAP_DEFAULT).toEqual({ codex: 80, 'agy-claude': 300, 'agy-gemini': 0 });
    expect(resolveProviderCap('agy-gemini', {})).toBe(0);
    expect(resolveProviderCap('agy-gemini', { [PROVIDER_CAP_ENV['agy-gemini']]: '5' })).toBe(5);
    expect(resolveProviderCap('codex', { [PROVIDER_CAP_ENV.codex]: '5' })).toBe(5);
    // codex alone falls back to the OLD shared env for one release; the antigravity backends never do.
    expect(resolveProviderCap('codex', { [DAILY_CAP_ENV]: '7' })).toBe(7);
    expect(resolveProviderCap('agy-claude', { [DAILY_CAP_ENV]: '7' })).toBe(PROVIDER_CAP_DEFAULT['agy-claude']);
    // the provider's own env wins over the legacy shared one when both are set
    expect(resolveProviderCap('codex', { [PROVIDER_CAP_ENV.codex]: '9', [DAILY_CAP_ENV]: '7' })).toBe(9);

    const rows = (provider, n) => Array.from({ length: n }, (_, i) => ({ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider, callId: `${provider}-${i}`, scoredAt: '2026-09-26T14:00:00Z' }));
    const records = [...rows('codex', 2), ...rows('agy-claude', 1)];
    const usage = reviewSeatCapUsage(records, NOW, { [PROVIDER_CAP_ENV.codex]: '2' });
    expect(usage.codex).toEqual({ usedToday: 2, cap: 2, fraction: 1 });
    expect(usage['agy-claude']).toEqual({ usedToday: 1, cap: PROVIDER_CAP_DEFAULT['agy-claude'], fraction: expect.any(Number) });
    expect(usage['agy-gemini']).toEqual({ usedToday: 0, cap: 0, fraction: null });
    expect(callsUsedTodayForProvider(records, NOW, 'codex')).toBe(2);
  });

  it('card xn2wf9t — reviewSeatCapUsage includes outstanding reservations without double-counting completed calls', () => {
    const records = [{ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider: 'codex', callId: 'landed', scoredAt: '2026-09-26T14:00:00Z' }];
    const ledgers = {
      // untagged = pre-split codex reservation; 'landed' already has its row; yesterday's never counts
      codex: { version: 1, reservations: [
        { callId: 'landed', at: '2026-09-26T13:59:00Z', provider: 'codex' },
        { callId: 'inflight-1', at: '2026-09-26T14:10:00Z', provider: 'codex' },
        { callId: 'legacy', at: '2026-09-26T14:20:00Z' },
        { callId: 'old', at: '2026-09-25T14:20:00Z', provider: 'codex' },
      ] },
      'agy-claude': { version: 1, reservations: [{ callId: 'c1', at: '2026-09-26T14:10:00Z', provider: 'agy-claude' }] },
    };
    const usage = reviewSeatCapUsage(records, NOW, { [PROVIDER_CAP_ENV.codex]: '4' }, ledgers);
    expect(usage.codex).toEqual({ usedToday: 3, cap: 4, fraction: 0.75 });
    expect(usage['agy-claude'].usedToday).toBe(1);
    expect(usage['agy-gemini'].usedToday).toBe(0);
    // the SAME count admission gates on
    expect(reserveSeatCalls({ ledger: ledgers.codex, records, want: 5, dailyCap: 4, now: NOW, newId: () => 'n', provider: 'codex' }).used).toBe(3);
  });

  it('#4321 migration — a completed Gemini call keeps its own budget charge; the shared pre-split ledger\'s reservations stay codex\'s, never reassigned to Gemini', () => {
    // Pre-split scorecards: a landed codex row and a landed gemini row, both scored today.
    const records = [
      { dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider: 'codex', callId: 'codex-landed', scoredAt: '2026-09-26T14:00:00Z' },
      { dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider: 'agy-gemini', callId: 'gemini-landed', scoredAt: '2026-09-26T14:05:00Z' },
    ];
    // THE shared, pre-split ledger (card's own wording): it carries codex's own tagged reservation, an
    // UNTAGGED one from before the per-provider split existed, AND a Gemini-tagged one whose callId matches
    // Gemini's own completed row (so the completed-record/own-reservation dedupe is exercised too, not just
    // isolation from codex). Production already gives each provider its own ledger FILE
    // (`reservationLedgerFileFor`) — this fixture is NOT that normal path. It deliberately feeds the SAME
    // (codex-owned, pre-split) ledger object to BOTH providers, modeling the regression this test guards
    // against: a read path that ever fell back to the shared/legacy file for a provider it doesn't own.
    // `reservationIsFor`'s own per-entry provider check, not file separation, is what must hold here — and
    // prove Gemini's own completed call is still counted on its own budget, untouched by codex's (tagged or
    // legacy) reservations.
    const sharedLedger = { version: 1, reservations: [
      { callId: 'codex-landed', at: '2026-09-26T13:59:00Z', provider: 'codex' },
      { callId: 'legacy-untagged', at: '2026-09-26T14:10:00Z' },
      { callId: 'gemini-landed', at: '2026-09-26T14:04:00Z', provider: 'agy-gemini' },
    ] };
    const ledgers = { codex: sharedLedger, 'agy-gemini': sharedLedger };
    const usage = reviewSeatCapUsage(records, NOW, {}, ledgers);
    // Codex keeps both its own tagged call and the untagged legacy reservation — nothing lost off codex.
    expect(usage.codex.usedToday).toBe(2);
    // Gemini's completed call retains its own charge (1, deduped against its own matching reservation, not
    // doubled) — the shared ledger's codex-owned entries never inflate it, i.e. they are not reassigned to
    // Gemini.
    expect(usage['agy-gemini'].usedToday).toBe(1);
    // The SAME split holds through the admission-time counter both providers gate on.
    expect(reserveSeatCalls({ ledger: sharedLedger, records, want: 5, dailyCap: 10, now: NOW, newId: () => 'n', provider: 'codex' }).used).toBe(2);
    expect(reserveSeatCalls({ ledger: sharedLedger, records, want: 5, dailyCap: 10, now: NOW, newId: () => 'n', provider: 'agy-gemini' }).used).toBe(1);
  });
});

describe('#4194 the direct-task scripts in --review mode', () => {
  it('codex runs read-only with a review suffix; the default stays workspace-write', () => {
    expect(buildCodexDirectTaskArgv({ cwd: '/d', review: true })).toEqual(expect.arrayContaining(['-s', 'read-only']));
    expect(buildCodexDirectTaskArgv({ cwd: '/d' })).toEqual(expect.arrayContaining(['-s', 'workspace-write']));
    expect(buildCodexPrompt('Review it', { review: true })).toMatch(/READ-ONLY review/);
    expect(buildCodexPrompt('Review it', { review: true })).not.toMatch(/Make the change directly/);
  });

  it('gemini accepts --review and forbids edits in the prompt', () => {
    expect(parseAgyFlags(['--review', '--task=x'])).toMatchObject({ review: true });
    const p = buildAgyPrompt('Review it', '/abs/dir', { review: true });
    expect(p).toMatch(/READ-ONLY review/);
    expect(p).not.toMatch(/Make the change directly/);
  });

  it('gemini in --review mode never gets --dangerously-skip-permissions, so agy denies its shell and writes', () => {
    expect(buildAgyDirectTaskArgv({ review: true })).not.toContain('--dangerously-skip-permissions');
    expect(buildAgyDirectTaskArgv({ review: true, resumeConversationId: 'c-1' })).not.toContain('--dangerously-skip-permissions');
    expect(buildAgyDirectTaskArgv({})).toContain('--dangerously-skip-permissions');
    // an extra dir would re-grant the reads outside --dir that review mode denies
    expect(() => buildAgyDirectTaskArgv({ review: true, addDirs: ['/elsewhere'] })).toThrow(/add-dir/);
    const p = buildAgyPrompt('Review it', '/abs/dir', { review: true });
    expect(p).toMatch(/cannot run commands or write any file/);
    expect(p).not.toMatch(/\brg\b|grep|via your shell/);
  });

  it('gemini --review drops the permission bypass through the real run (initial attempt and resume alike)', async () => {
    const argvs = [];
    const spawnFn = (_cli, argv) => {
      argvs.push(argv);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end: () => {} });
      child.kill = () => {};
      setImmediate(() => { child.stdout.emit('data', Buffer.from('{"type":"result","status":"success"}\n')); child.emit('close', 0); });
      return child;
    };
    const dir = mkdtempSync(join(tmpdir(), 'we-agy-review-'));
    // Hermetic: never read or write the host's real agy quota-hold evidence (a live hold returns before spawnFn).
    const hold = { readHold: () => null, saveHold: () => {} };
    try {
      await runAgyDirectExec({ dir, task: 'Review it', review: true, timeoutMs: 60_000, logFile: join(dir, 'log.jsonl'), stream: false, spawnFn, ...hold });
      await runAgyDirectExec({ dir, task: 'Review it', review: true, timeoutMs: 60_000, logFile: join(dir, 'log.jsonl'), stream: false, spawnFn, resumeConversationId: 'c-1', ...hold });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(argvs).toHaveLength(2);
    for (const a of argvs) expect(a).not.toContain('--dangerously-skip-permissions');
  });

  it('seatCallArgv shells the existing scripts in review mode (gemini halves its per-attempt budget)', () => {
    const c = seatCallArgv({ provider: 'codex', taskFile: '/t', dir: '/d', model: 'm', effort: 'medium', timeoutMs: 600000, root: '/r' });
    expect(c[0]).toBe('/r/scripts/codex-direct-task.mjs');
    expect(c).toEqual(expect.arrayContaining(['--review', '--json', '--no-stream', '--timeout-ms=600000']));
    for (const provider of ['agy-claude', 'agy-gemini']) {
      const g = seatCallArgv({ provider, taskFile: '/t', dir: '/d', model: 'm', effort: 'medium', timeoutMs: 600000, root: '/r' });
      expect(g[0]).toBe('/r/scripts/gemini-direct-task.mjs');
      expect(g).toEqual(expect.arrayContaining(['--review', '--json', '--timeout-ms=300000']));
    }
  });
});

describe('#4194 prompt, answer parsing, confirmation, rows', () => {
  const seats = reviewSeatRoutes({}).routes.map((r) => ({ ...r }));

  it('the brief names each seat, the files, and the JSON contract', () => {
    const t = buildSeatTask({ pr: 5, repo: REPO, title: 'T', dir: '/s', diffFile: '/s/.git/d', bodyFile: '/s/.git/b', seats });
    for (const s of seats) expect(t).toContain(`"${s.key}"`);
    expect(t).toContain('/s/.git/d');
    expect(t).toMatch(/```json/);
  });

  it('an INLINE brief (the gemini seat) carries the diff and PR body in the message and points at no file', () => {
    const t = buildSeatTask({ pr: 5, repo: REPO, title: 'T', inline: { diffText: 'diff --git a/q b/q\n+NEEDLE\n', body: 'BODY-TEXT' }, seats });
    expect(t).toContain('+NEEDLE');
    expect(t).toContain('BODY-TEXT');
    expect(t).toMatch(/cannot run commands or write files/);
    expect(t).toMatch(/UNTRUSTED/);
    expect(t).not.toMatch(/checked out at|read what a seat needs/);
    const big = buildSeatTask({ pr: 5, repo: REPO, title: 'T', inline: { diffText: 'x'.repeat(500_000), body: '' }, seats });
    expect(big.length).toBeLessThan(260_000);
    expect(big).toMatch(/truncated/);
  });

  it('parses the last fenced JSON; a seat missing from it is not ok', () => {
    const text = answer({ 'claim-accuracy': { verdict: 'changes', findings: [{ summary: 'wrong count', file: 'a.md', line: 3 }] } });
    const parsed = parseSeatAnswer(text, seats);
    expect(parsed['claim-accuracy']).toMatchObject({ ok: true, verdict: 'changes' });
    expect(parsed['claim-accuracy'].findings[0]).toMatchObject({ summary: 'wrong count', file: 'a.md', line: 3 });
    expect(parsed['standards-conformance'].ok).toBe(false);
  });

  it('finds an unfenced answer however its JSON is spaced or indented', () => {
    const lenses = { 'claim-accuracy': { verdict: 'accept', findings: [] } };
    expect(extractAnswerJson(`Done.\n${JSON.stringify({ lenses })}`)).toEqual({ lenses });
    expect(extractAnswerJson(`Done.\n{ "lenses": { "claim-accuracy": { "verdict": "accept", "findings": [] } } }`)).toEqual({ lenses });
    expect(extractAnswerJson(`Done.\n${JSON.stringify({ lenses }, null, 2)}\n`)).toEqual({ lenses });
    expect(extractAnswerJson('Done.\n{\n\t"lenses"  :  {}\n}')).toEqual({ lenses: {} });
    expect(extractAnswerJson('no answer at all')).toBeNull();
  });

  it('classifies timeouts, quota hits, garbage and success', () => {
    expect(classifySeatCall('codex', { timedOut: true, report: null }).status).toBe('timeout');
    expect(classifySeatCall('gemini', { report: { events: { finalResponse: '', errorMessage: 'RESOURCE_EXHAUSTED: quota' } } }).status).toBe('quota-exhausted');
    expect(classifySeatCall('codex', { report: { lastMessage: 'I looked around.' } }).status).toBe('unparseable');
    expect(classifySeatCall('codex', { report: null, exitCode: 1, stderr: 'boom' }).status).toBe('error');
    expect(classifySeatCall('codex', { report: { lastMessage: answer({}) } }).status).toBe('ok');
  });

  it('confirmation: same file + near line, or same file + shared words; different file never', () => {
    expect(findingCorroboratedBy({ summary: 'forged headline', file: 'scripts/lib/ai-pr-authorship.mjs', line: 44 }, [CLAUDE_FINDING])).toBe(CLAUDE_FINDING);
    expect(findingCorroboratedBy({ summary: 'forged merge headline bypasses gate', file: './scripts/lib/ai-pr-authorship.mjs', line: 300 }, [CLAUDE_FINDING])).toBe(CLAUDE_FINDING);
    expect(findingCorroboratedBy({ summary: 'forged merge headline bypasses gate', file: 'other.mjs', line: 41 }, [CLAUDE_FINDING])).toBeNull();
    expect(findingCorroboratedBy({ summary: 'unrelated typo' }, [CLAUDE_FINDING])).toBeNull();
  });

  it('a seat citing the ABSOLUTE scratch path is cut back to the repo-relative path, so corroboration still matches', () => {
    const scratch = '/var/folders/xy/T/we-review-seat-AbC123';
    const parsed = { s: { ok: true, verdict: 'changes', findings: [
      { summary: 'a', file: `${scratch}/scripts/lib/ai-pr-authorship.mjs` },
      { summary: 'b', file: `/private${scratch}/x/y.mjs` },
      { summary: 'c', file: 'already/relative.mjs' },
      { summary: 'd', file: null },
    ] } };
    expect(repoRelativeFindings(parsed, scratch).s.findings.map((f) => f.file)).toEqual(['scripts/lib/ai-pr-authorship.mjs', 'x/y.mjs', 'already/relative.mjs', null]);
    const f = repoRelativeFindings(parsed, scratch).s.findings[0];
    expect(findingCorroboratedBy({ ...f, line: 41 }, [CLAUDE_FINDING])).toBe(CLAUDE_FINDING);
  });

  it('two DIFFERENT files that merely share a path tail never corroborate, even at a near line', () => {
    const claude = { summary: 'config default is read before the env override', file: 'lib/config.mjs', line: 104 };
    expect(findingCorroboratedBy({ summary: 'port parsing drops the scheme', file: 'apps/api/lib/config.mjs', line: 100 }, [claude])).toBeNull();
    expect(findingCorroboratedBy({ summary: 'port parsing drops the scheme', file: 'scripts/other/lib/x.mjs', line: 5 }, [{ ...claude, file: 'scripts/lib/x.mjs', line: 5 }])).toBeNull();
    // the same file, cited with or without a diff prefix / line suffix, still does
    expect(findingCorroboratedBy({ summary: 'x', file: 'b/lib/config.mjs:101', line: 101 }, [claude])).toBe(claude);
  });

  it('rows are valid scorecard rows carrying provider, model, lens, findings and Claude confirmation', () => {
    const group = seats.filter((s) => s.provider === 'codex');
    const call = { status: 'ok', text: '', error: null };
    const parsed = { 'extra-juror:correctness': { ok: true, verdict: 'changes', findings: [{ summary: 'forged headline', file: 'scripts/lib/ai-pr-authorship.mjs', line: 40 }] }, 'claim-accuracy': { ok: true, verdict: 'accept', findings: [] } };
    const rows = buildSeatRows({ callId: 'c1', pr: 5, repo: REPO, provider: 'codex', model: 'gpt-6-astra', effort: 'medium', seats: group, call, parsed, claudeFindings: [CLAUDE_FINDING], changedFiles: ['scripts/lib/ai-pr-authorship.mjs'] });
    for (const r of rows) expect(validateScorecard(r)).toEqual({ ok: true, errors: [] });
    for (const r of rows) expect(r.changedFiles).toEqual(['scripts/lib/ai-pr-authorship.mjs']);
    const juror = rows.find((r) => r.seat === 'extra-juror');
    expect(juror).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', lens: 'correctness', status: 'ok', findingsCount: 1, confirmedCount: 1, claudeConfirmed: true, taskType: 'review-lens:extra-juror:correctness' });
    // real store write, in memory
    let text = null;
    const io = { path: '/mem/store.json', read: () => text, write: (_p, t) => { text = t; }, exists: () => text !== null };
    appendScorecard(juror, io);
    expect(JSON.parse(text).records.at(-1)).toMatchObject({ dispatchKind: 'review-seat', lens: 'correctness', confirmedCount: 1 });
  });

  it('changedFiles (#4034 follow-up, card 4034b) defaults to null, never [], when the caller supplies none', () => {
    const group = seats.filter((s) => s.provider === 'codex');
    const call = { status: 'ok', text: '', error: null };
    const rows = buildSeatRows({ callId: 'c1', pr: 5, repo: REPO, provider: 'codex', model: 'gpt-6-astra', effort: 'medium', seats: group, call, parsed: {}, claudeFindings: null });
    for (const r of rows) expect(r.changedFiles).toBeNull();
  });

  it('claudeFindingsFromLoop reads only Claude\'s mandatory judge steps; no judged step → null', () => {
    expect(claudeFindingsFromLoop(LOOP_PAYLOAD)).toEqual([CLAUDE_FINDING]);
    expect(claudeFindingsFromLoop({ findings: { read: {} } })).toBeNull();
  });
});

describe('#4194 runExtraSeats — the arc, with fakes', () => {
  it('card x6ov12s — the live incident admits exactly one Codex call once its hold is probe-due', async () => {
    const now = Date.parse('2026-09-29T14:00:00-04:00');
    const records = [{
      dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider: 'codex', status: 'ok',
      quotaUsedPercent: 99, quotaResetsAt: '2026-10-03T17:11:00-04:00', scoredAt: '2026-09-28T22:31:00-04:00',
    }];
    const { io, calls, rows } = fakeSeatIo({ now: () => now, readRecords: () => records });
    expect(quotaHold(records, 'codex', now)).toMatch(/99%/);
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: {} }, io);
    expect(r.status).toBe('ran');
    expect(calls.filter((c) => c[0] === 'seat' && c[1].provider === 'codex')).toHaveLength(1);
    expect(rows.some((row) => row.provider === 'codex')).toBe(true);
  });

  it.each([undefined, 'invalid', '-1'])('Gemini defaults off with cap %s, logs the ruling, and routes every seat to other providers', async (cap) => {
    const { io, calls, rows } = fakeSeatIo();
    const env = cap === undefined ? {} : { [PROVIDER_CAP_ENV['agy-gemini']]: cap };
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env }, io);
    expect(r.status).toBe('ran');
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => ['codex', 'agy-claude'].includes(row.provider))).toBe(true);
    expect(calls.filter((c) => c[0] === 'seat').every((c) => c[1].provider !== 'agy-gemini')).toBe(true);
    expect(calls).toContainEqual(['log', 'added seats: skipping agy-gemini — daily-cap: off by default (operator ruling 2026-10-02: Gemini too weak for review until Gemini 4)']);
  });

  it('an explicit Gemini zero cap logs ordinary cap exhaustion, not the default ruling', async () => {
    const { io, calls } = fakeSeatIo();
    await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: { [PROVIDER_CAP_ENV['agy-gemini']]: '0' } }, io);
    expect(calls).toContainEqual(['log', 'added seats: skipping agy-gemini — daily-cap: 0/0 non-Claude seat calls already used today for agy-gemini']);
  });

  it('runs all three providers in parallel, writes one evidence row per seat, stamps Claude confirmation, cleans up', async () => {
    const { io, calls, rows } = fakeSeatIo();
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: { [PROVIDER_CAP_ENV['agy-gemini']]: '5' } }, io);
    expect(r.status).toBe('ran');
    expect(r.rowsWritten).toBe(3);
    expect(rows.map((x) => `${x.seat}:${x.lens}@${x.provider}`).sort()).toEqual([
      'advisory-lens:claim-accuracy@agy-claude', 'advisory-lens:standards-conformance@agy-gemini', 'extra-juror:correctness@codex',
    ]);
    const juror = rows.find((x) => x.seat === 'extra-juror');
    expect(juror.findings[0]).toMatchObject({ confirmedByClaude: true });
    expect(juror.quotaUsedPercent).toBe(12);
    // #4034 follow-up (card 4034b) — every row stamps the same read.netChangedFiles the loop already computed.
    for (const row of rows) expect(row.changedFiles).toEqual(LOOP_PAYLOAD.findings.read.netChangedFiles);
    const claim = rows.find((x) => x.lens === 'claim-accuracy');
    expect(claim.findings[0]).toMatchObject({ confirmedByClaude: false });
    expect(calls.filter((c) => c[0] === 'seat')).toHaveLength(3);
    expect(calls.find((c) => c[0] === 'scratch')[1]).toMatchObject({ lanePath: '/lane', rev: 'a'.repeat(40) });
    expect(calls.at(-1)).toEqual(['rm', '/tmp/seat-scratch']);
    expect(renderSeatSummary(r).join('\n')).toMatch(/also raised by Claude/);
    // Card xn2wf9t — per-provider usage is reported, not just a shared total.
    expect(r.providerUsage.codex).toMatchObject({ usedToday: 1, cap: PROVIDER_CAP_DEFAULT.codex });
    expect(r.providerUsage['agy-claude']).toMatchObject({ usedToday: 1, cap: PROVIDER_CAP_DEFAULT['agy-claude'] });
    expect(r.providerUsage['agy-gemini']).toMatchObject({ usedToday: 1, cap: 5 });
  });

  it('each antigravity seat gets an inline brief; the codex seat (OS read-only sandbox) reads the checkout', async () => {
    const written = new Map();
    const { io } = fakeSeatIo({ writeFile: (p, text) => written.set(p, text) });
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: { [PROVIDER_CAP_ENV['agy-gemini']]: '5' } }, io);
    expect(r.status).toBe('ran');
    const claude = [...written].find(([p]) => p.endsWith('task-agy-claude.md'))[1];
    const gemini = [...written].find(([p]) => p.endsWith('task-agy-gemini.md'))[1];
    const cod = [...written].find(([p]) => p.endsWith('task-codex.md'))[1];
    expect(claude).toContain(LOOP_PAYLOAD.findings.read.diffText.trim());
    expect(claude).not.toContain('/tmp/seat-scratch');
    expect(gemini).toContain(LOOP_PAYLOAD.findings.read.diffText.trim());
    expect(gemini).not.toContain('/tmp/seat-scratch');
    expect(cod).toContain('/tmp/seat-scratch');
  });

  it('no pinned rev on the loop payload → skipped before any reservation, scratch or spawn (never the released lane\'s HEAD)', async () => {
    const { io, calls } = fakeSeatIo();
    const payload = { ...LOOP_PAYLOAD, findings: { ...LOOP_PAYLOAD.findings, read: { ...LOOP_PAYLOAD.findings.read, netBasis: { base: 'b'.repeat(40) } } } };
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: payload, env: {} }, io);
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/pinned/);
    expect(calls.some((c) => ['reserve', 'scratch', 'seat'].includes(c[0]))).toBe(false);
  });

  it('soak: a seat that fails, times out or throws never fails the run — it is only that seat\'s status', async () => {
    const { io, rows } = fakeSeatIo({
      runSeat: async (o) => {
        if (o.provider === 'codex') throw new Error('spawn ENOENT');
        return { timedOut: true, report: null };
      },
    });
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: { [PROVIDER_CAP_ENV['agy-gemini']]: '5' } }, io);
    expect(r.status).toBe('ran');
    expect(rows.find((x) => x.provider === 'codex').status).toBe('error');
    expect(rows.find((x) => x.provider === 'agy-claude').status).toBe('timeout');
    expect(rows.find((x) => x.provider === 'agy-gemini').status).toBe('timeout');
    expect(rows.every((x) => x.findingsCount === 0)).toBe(true);
  });

  it('kill switch: nothing is read or spawned', async () => {
    const { io, calls } = fakeSeatIo({ readRecords: () => { throw new Error('must not read'); } });
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: { [EXTRA_SEATS_ENV]: '0' } }, io);
    expect(r.status).toBe('disabled');
    expect(calls).toEqual([]);
  });

  it('no CLI on PATH → skipped, logged with the reason, nothing spawned', async () => {
    const { io, calls } = fakeSeatIo({ cliAvailable: () => false });
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: {} }, io);
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/CLI not found/);
    expect(calls.some((c) => c[0] === 'seat')).toBe(false);
    expect(calls.filter((c) => c[0] === 'log').map((c) => c[1]).join('\n')).toMatch(/skipping codex/);
  });

  it('every provider at its own cap → skipped without spawning', async () => {
    const used = (provider) => ({ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider, callId: `k-${provider}`, scoredAt: '2026-09-26T14:00:00Z' });
    const { io, calls } = fakeSeatIo({ readRecords: () => ['codex', 'agy-claude', 'agy-gemini'].map(used) });
    const env = { [PROVIDER_CAP_ENV.codex]: '1', [PROVIDER_CAP_ENV['agy-claude']]: '1', [PROVIDER_CAP_ENV['agy-gemini']]: '1' };
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env }, io);
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/daily-cap/);
    expect(calls.some((c) => c[0] === 'seat')).toBe(false);
  });

  it('a provider AT ITS OWN CAP never blocks the others — the seat falls back rather than going unrun (never "no seat")', async () => {
    // codex is already at its (tiny) cap; the extra-juror seat would normally land there (see the empirical
    // routing above) — with codex excluded it must land on agy-claude or agy-gemini instead of being skipped.
    const used = { dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider: 'codex', callId: 'k-codex', scoredAt: '2026-09-26T14:00:00Z' };
    const { io, rows } = fakeSeatIo({ readRecords: () => [used] });
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: { [PROVIDER_CAP_ENV.codex]: '1' } }, io);
    expect(r.status).toBe('ran');
    expect(rows.some((x) => x.provider === 'codex')).toBe(false);
    const juror = rows.find((x) => x.seat === 'extra-juror');
    expect(juror).toBeTruthy();
    expect(['agy-claude', 'agy-gemini']).toContain(juror.provider);
    expect(r.providerUsage.codex).toMatchObject({ usedToday: 1, cap: 1 });
  });

  it('concurrent reviews cannot together overspend ONE provider\'s own cap; the loser falls back to a still-budgeted provider', async () => {
    // Both jobs read the same store snapshot (0 used) before either has written a row — the race the cap must
    // survive. Codex's cap is 1, so of the two jobs wanting it, only one may actually launch a codex call — the
    // other's seat falls back to agy-claude/agy-gemini rather than being skipped outright.
    const ledgerBox = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    let codexLaunched = 0;
    const runSeat = async (o) => { if (o.provider === 'codex') { codexLaunched += 1; await gate; } return fakeSeatIo().io.runSeat(o); };
    const a = fakeSeatIo({ runSeat }, ledgerBox);
    const b = fakeSeatIo({ runSeat, newId: (() => { let n = 0; return () => `b-call-${++n}`; })() }, ledgerBox);
    const env = { [PROVIDER_CAP_ENV.codex]: '1' };
    const pa = runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env }, a.io);
    const pb = runExtraSeats({ pr: 6, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env }, b.io);
    release();
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(codexLaunched).toBe(1);
    expect(ra.status).toBe('ran');
    expect(rb.status).toBe('ran'); // never "no seat" — rb's extra-juror seat fell back to the other backend
    const codexRuns = [ra, rb].filter((r) => r.seats.some((s) => s.provider === 'codex'));
    expect(codexRuns).toHaveLength(1);
    expect(ledgerBox.codex.reservations).toHaveLength(1);
  });

  it('a reservation that cannot be made fails closed — nothing spawned', async () => {
    const { io, calls } = fakeSeatIo({ reserveCalls: () => { throw new Error('EACCES ledger'); } });
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: {} }, io);
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/EACCES ledger/);
    expect(calls.some((c) => c[0] === 'seat' || c[0] === 'scratch')).toBe(false);
  });

  it('a loop that never read the PR → skipped; a crashing store append is survived', async () => {
    const { io } = fakeSeatIo({ append: () => { throw new Error('disk full'); } });
    expect((await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: { stopped: 'refused' }, env: {} }, io)).status).toBe('skipped');
    const r = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: {} }, io);
    expect(r.status).toBe('ran');
    expect(r.rowsWritten).toBe(0);
  });
});

describe('#4194 review-job — the seats run AFTER the arc, and can never change its outcome', () => {
  function fakeJobIo(over = {}) {
    const calls = [];
    const io = {
      root: '/daemon',
      now: (() => { let t = 1_000; return () => { t += 10; return t; }; })(),
      newActorId: () => 'actor',
      readPrevCompletion: () => null,
      report: (f) => calls.push(['report', f.status]),
      claim: () => { calls.push(['claim']); return { ok: true }; },
      updateRecord: () => calls.push(['update']),
      unclaim: () => calls.push(['unclaim']),
      acquireLane: () => { calls.push(['acquire']); return { lanePath: '/lanes/lane-7' }; },
      runLoop: () => { calls.push(['loop']); return { status: 0, stdout: JSON.stringify(LOOP_PAYLOAD), stderr: '' }; },
      releaseLane: () => calls.push(['release']),
      log: () => {},
      runExtraSeats: (input) => { calls.push(['seats', input]); return { status: 'ran', seats: [], skipped: [], rowsWritten: 0, callsUsedToday: 1, dailyCap: 40 }; },
      ...over,
    };
    return { io, calls };
  }

  it('Claude\'s loop runs first; the added seats run only after done/release/unclaim, with the loop payload', () => {
    const { io, calls } = fakeJobIo();
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(calls.map((c) => c[0])).toEqual(['claim', 'report', 'acquire', 'update', 'loop', 'report', 'release', 'unclaim', 'seats']);
    expect(calls.at(-1)[1]).toMatchObject({ pr: 10, repo: REPO, lanePath: '/lanes/lane-7', loopPayload: LOOP_PAYLOAD });
    expect(out).toMatchObject({ outcome: 'bounced', extraSeats: { status: 'ran' } });
  });

  it('a crashing seat stage leaves the review outcome untouched', () => {
    const { io } = fakeJobIo({ runExtraSeats: () => { throw new Error('seat runner exploded'); } });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(out.outcome).toBe('bounced');
    expect(out.extraSeats).toMatchObject({ status: 'error', reason: expect.stringMatching(/exploded/) });
  });

  it('no seats when the loop timed out or printed nothing parseable', () => {
    const { io, calls } = fakeJobIo({ runLoop: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }) });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(calls.some((c) => c[0] === 'seats')).toBe(false);
    expect(out.extraSeats).toBeUndefined();
  });

  it('no seats when the loop timed out even though it had already flushed a parseable payload', () => {
    // The child can print its whole JSON and then be SIGKILLed past the wall during cleanup: `parsed` is
    // non-null, so only the `timedOut` half of the guard keeps the seats from firing on an unfinished review.
    const { io, calls } = fakeJobIo({ runLoop: () => ({ status: null, signal: 'SIGKILL', stdout: JSON.stringify(LOOP_PAYLOAD), stderr: '', timedOut: true }) });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(calls.some((c) => c[0] === 'seats')).toBe(false);
    expect(out.extraSeats).toBeUndefined();
  });

  it('no seats when the loop finished in time but printed nothing parseable', () => {
    const { io, calls } = fakeJobIo({ runLoop: () => ({ status: 1, signal: null, stdout: 'not json', stderr: '', timedOut: false }) });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(calls.some((c) => c[0] === 'seats')).toBe(false);
    expect(out.extraSeats).toBeUndefined();
  });

  it('summarizeExtraSeats keeps findings and confirmation, drops the bulk', () => {
    const s = summarizeExtraSeats({ status: 'ran', seats: [{ seat: 'extra-juror', lens: 'correctness', provider: 'codex', model: 'm', status: 'ok', seatVerdict: 'changes', findings: [{ summary: 's', file: 'f', line: 1, impactIfUnfixed: 'broken', confirmedByClaude: true }] }], rowsWritten: 1, callsUsedToday: 2, dailyCap: 40 });
    expect(s.seats[0].findings[0]).toEqual({ summary: 's', file: 'f', line: 1, impact: 'broken', confirmedByClaude: true });
    expect(s).toMatchObject({ rowsWritten: 1, callsUsedToday: 2, dailyCap: 40 });
  });
});

describe('#4194 reserveSeatCalls — the daily budget is reserved BEFORE a call launches', () => {
  const at = (iso) => ({ callId: iso, at: iso });
  const ids = () => { let n = 0; return () => `r${++n}`; };

  it('grants up to what is left, counting both stored rows and outstanding reservations', () => {
    const records = [{ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, callId: 'done-1', scoredAt: '2026-09-26T14:00:00Z' }];
    const ledger = { version: 1, reservations: [at('2026-09-26T14:30:00Z')] };
    const r = reserveSeatCalls({ ledger, records, want: 3, dailyCap: 4, now: NOW, newId: ids() });
    expect(r.callIds).toEqual(['r1', 'r2']);
    expect(r.used).toBe(2);
    expect(r.ledger.reservations).toHaveLength(3);
  });

  it('a reservation whose row has since landed is counted once, not twice', () => {
    const records = [{ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, callId: 'x', scoredAt: '2026-09-26T14:00:00Z' }];
    const ledger = { version: 1, reservations: [{ callId: 'x', at: '2026-09-26T13:59:00Z' }] };
    expect(reserveSeatCalls({ ledger, records, want: 5, dailyCap: 3, now: NOW, newId: ids() }).callIds).toHaveLength(2);
  });

  it('yesterday\'s reservations are dropped and do not count; nothing is granted at or over the cap', () => {
    const ledger = { version: 1, reservations: [at('2026-09-25T12:00:00Z'), at('2026-09-26T12:00:00Z')] };
    const r = reserveSeatCalls({ ledger, records: [], want: 5, dailyCap: 2, now: NOW, newId: ids() });
    expect(r.callIds).toEqual(['r1']);
    expect(r.ledger.reservations.map((x) => x.at.slice(0, 10))).toEqual(['2026-09-26', '2026-09-26']);
    expect(reserveSeatCalls({ ledger: r.ledger, records: [], want: 1, dailyCap: 2, now: NOW, newId: ids() }).callIds).toEqual([]);
    expect(reserveSeatCalls({ ledger: null, records: [], want: 0, dailyCap: 2, now: NOW, newId: ids() }).callIds).toEqual([]);
  });

  it('card xn2wf9t — reserveSeatCalls counts only the requested provider\'s completed calls, never another provider\'s', () => {
    const rows = (provider, n) => Array.from({ length: n }, (_, i) => ({ dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider, callId: `${provider}-${i}`, scoredAt: '2026-09-26T14:00:00Z' }));
    const records = [...rows('codex', 2), ...rows('agy-gemini', 100), ...rows('agy-claude', 80)];
    const codex = reserveSeatCalls({ ledger: null, records, want: 1, dailyCap: 80, now: NOW, newId: ids(), provider: 'codex' });
    expect(codex.callIds).toEqual(['r1']);
    expect(codex.used).toBe(2);
    // the provider's own rows still count against its own cap
    expect(reserveSeatCalls({ ledger: null, records, want: 1, dailyCap: 80, now: NOW, newId: ids(), provider: 'agy-claude' }).callIds).toEqual([]);
    // no provider → the pre-split shared pool, unchanged
    expect(reserveSeatCalls({ ledger: null, records, want: 1, dailyCap: 80, now: NOW, newId: ids() }).used).toBe(182);
  });
});

describe('#4194 createExtraSeatsIo — real effects, on a throwaway repo and store', () => {
  let root;
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'we-seat-io-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('makeScratch is a SELF-CONTAINED copy of the pinned commit: no alternates, and it survives the lane being gc\'d or deleted', () => {
    const lane = join(root, 'lane');
    mkdirSync(lane);
    git(lane, 'init', '--quiet');
    writeFileSync(join(lane, 'a.txt'), 'one\n');
    git(lane, 'add', 'a.txt');
    git(lane, 'commit', '--quiet', '-m', 'one');
    const pinned = git(lane, 'rev-parse', 'HEAD');
    writeFileSync(join(lane, 'a.txt'), 'two\n');
    git(lane, 'commit', '--quiet', '-am', 'two');
    const io = createExtraSeatsIo({ env: process.env });
    const dir = io.makeScratch({ lanePath: lane, rev: pinned });
    try {
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(pinned);
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
      expect(existsSync(join(dir, '.git', 'objects', 'info', 'alternates'))).toBe(false);
      // The lane is re-acquired and reset (its objects pruned) — or gone entirely. The scratch must not care.
      rmSync(lane, { recursive: true, force: true });
      expect(git(dir, 'cat-file', '-p', `${pinned}:a.txt`)).toBe('one');
      expect(git(dir, 'fsck', '--no-progress', '--connectivity-only')).toBe('');
    } finally { io.removeScratch(dir); }
  });

  it('makeScratch with no pinned rev REFUSES — the released lane\'s HEAD may already be another PR', () => {
    const lane = join(root, 'lane');
    mkdirSync(lane);
    git(lane, 'init', '--quiet');
    writeFileSync(join(lane, 'a.txt'), 'x\n');
    git(lane, 'add', 'a.txt');
    git(lane, 'commit', '--quiet', '-m', 'x');
    const io = createExtraSeatsIo({ env: process.env });
    for (const rev of [null, undefined, '', 'HEAD', 'main']) {
      expect(() => io.makeScratch({ lanePath: lane, rev })).toThrow(/pinned/);
    }
  });

  it('a held reservation lock FAILS CLOSED: past the wait, reserveCalls throws and writes no reservation', () => {
    const storePath = join(root, 'state', 'run-scorecards.json');
    const ledger = join(root, 'state', 'review-seat-reservations.json');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(`${ledger}.lock`, '99999'); // a live holder (fresh mtime) that never lets go
    const io = createExtraSeatsIo({ env: process.env, storePath, lockTimeoutMs: 50 });
    expect(() => io.reserveCalls({ want: 2, dailyCap: 3, now: Date.now() })).toThrow(/lock/);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(`${ledger}.lock`)).toBe(true); // someone else's lock is never removed
  });

  it('a STALE reservation lock (a crashed holder) is taken over, not waited on forever', () => {
    const storePath = join(root, 'state', 'run-scorecards.json');
    const ledger = join(root, 'state', 'review-seat-reservations.json');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(`${ledger}.lock`, '99999');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${ledger}.lock`, old, old);
    const r = createExtraSeatsIo({ env: process.env, storePath, lockTimeoutMs: 50 }).reserveCalls({ want: 1, dailyCap: 3, now: Date.now() });
    expect(r.callIds).toHaveLength(1);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  it('a holder only ever removes ITS OWN lock — a lock taken over while it ran is left standing', () => {
    const p = join(root, 'state', 'x.json');
    withLedgerLock(p, () => {
      writeFileSync(`${p}.lock`, 'someone-else'); // a waiter took our lock over while we held it
    });
    expect(readFileSync(`${p}.lock`, 'utf8')).toBe('someone-else');
  });

  it('isPinnedRev accepts only a full commit id — never a ref name or an abbreviation git would read as a ref', () => {
    expect(isPinnedRev('a'.repeat(40))).toBe(true);
    expect(isPinnedRev('b'.repeat(64))).toBe(true);
    for (const r of ['deadbeef', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'HEAD', 'main', '', null]) expect(isPinnedRev(r)).toBe(false);
  });

  it('reserveCalls persists the ledger beside the store, so a second job sees the first one\'s reservation', () => {
    const storePath = join(root, 'state', 'run-scorecards.json');
    const now = Date.now();
    const first = createExtraSeatsIo({ env: process.env, storePath }).reserveCalls({ want: 2, dailyCap: 3, now });
    const second = createExtraSeatsIo({ env: process.env, storePath }).reserveCalls({ want: 2, dailyCap: 3, now });
    expect(first.callIds).toHaveLength(2);
    expect(second.callIds).toHaveLength(1);
    expect(second.used).toBe(2);
    expect(existsSync(`${join(root, 'state', 'review-seat-reservations.json')}.lock`)).toBe(false);
  });

  it('a corrupt ledger fails closed: reserveCalls throws and leaves the file for a human, never overwrites it', () => {
    const storePath = join(root, 'state', 'run-scorecards.json');
    const ledger = join(root, 'state', 'review-seat-reservations.json');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(ledger, '{ not json');
    expect(() => createExtraSeatsIo({ env: process.env, storePath }).reserveCalls({ want: 1, dailyCap: 3, now: Date.now() })).toThrow();
    expect(readFileSync(ledger, 'utf8')).toBe('{ not json');
  });

  const seatRowsFor = (provider, n, scoredAt) => Array.from({ length: n }, (_, i) => ({
    v: 1, dispatchKind: REVIEW_SEAT_DISPATCH_KIND, provider, callId: `${provider}-${i}`, scoredAt, outcome: null,
  }));

  it('card xn2wf9t — production reserveCalls: another provider\'s completed calls never reduce codex\'s grant', () => {
    const storePath = join(root, 'state', 'run-scorecards.json');
    const now = Date.now();
    writeStore({ version: 1, records: seatRowsFor('agy-claude', 3, new Date(now).toISOString()) }, { path: storePath });
    const r = createExtraSeatsIo({ env: process.env, storePath }).reserveCalls({ provider: 'codex', want: 1, dailyCap: 3, now });
    expect(r.callIds).toHaveLength(1);
    expect(r.used).toBe(0);
  });

  it('card xn2wf9t — readSeatCapUsage includes outstanding reservations without double-counting completed calls', () => {
    const storePath = join(root, 'state', 'run-scorecards.json');
    const now = Date.now();
    const env = { [PROVIDER_CAP_ENV.codex]: '5' };
    writeStore({ version: 1, records: seatRowsFor('codex', 1, new Date(now).toISOString()) }, { path: storePath });
    const io = createExtraSeatsIo({ env, storePath });
    // 3 more reserved, in flight (no rows yet); the landed row's own reservation must count once
    const reserved = io.reserveCalls({ provider: 'codex', want: 3, dailyCap: 5, now });
    expect(reserved.callIds).toHaveLength(3);
    io.reserveCalls({ provider: 'agy-gemini', want: 2, dailyCap: 300, now });
    const usage = readSeatCapUsage({ env, storePath, now });
    expect(usage.codex).toEqual({ usedToday: 4, cap: 5, fraction: 0.8 });
    expect(usage['agy-gemini'].usedToday).toBe(2);
    expect(usage['agy-claude'].usedToday).toBe(0);
    // reported usage equals admission usage: exactly one slot left for codex
    expect(io.reserveCalls({ provider: 'codex', want: 5, dailyCap: 5, now }).callIds).toHaveLength(1);
  });
});


it('keeps distinct per-seat policy models in separate calls and reserves both under the provider cap', async () => {
  const policy = structuredClone(readRoutingPolicy());
  policy.operations['review-seat'] = { provider: 'codex', model: 'default', fallback: [] };
  policy.operations['review-seat:claim-accuracy'] = { provider: 'codex', model: 'gpt-6-sol', fallback: [] };
  const { io, calls } = fakeSeatIo();
  const result = await runExtraSeats({ pr: 5, repo: REPO, lanePath: '/lane', loopPayload: LOOP_PAYLOAD, env: {}, routingPolicy: policy }, io);
  expect(result.status).toBe('ran');
  expect(calls.filter(c => c[0] === 'seat').map(c => c[1].model).sort()).toEqual(['gpt-6-astra', 'gpt-6-sol']);
  expect(calls.filter(c => c[0] === 'reserve')).toEqual([['reserve', 'codex', 2, 2]]);
  expect(result.seats.find(s => s.lens === 'claim-accuracy').model).toBe('gpt-6-sol');
});
