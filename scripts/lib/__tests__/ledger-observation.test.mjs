import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planLedgerObservation, observeLedgerHead, observeLedgerPrEvent, observeLiveLedgerHead, proveLedgerCarry,
  resolveLedgerObservationSettings, readObservationLedger } from '../ledger-observation.mjs';
import { appendVerdict, buildVerdictRecord, buildLedgerEvent, foldVerdictLedger, ledgerObservationApplies, validateVerdictRecord } from '../verdict-ledger.mjs';
import { derivePrState } from '../pr-state.mjs';
import { planDrainLedgerFacts } from '../drain-ledger-facts.mjs';
import { shadowRow } from '../drain-ledger-shadow.mjs';
import { createEventWaker } from '../pr-events.mjs';
import { backfillLedger } from '../../operations/ledger-backfill.mjs';
const repo = 'example/repo', head = 'a'.repeat(40), next = 'b'.repeat(40), now = '2026-10-17T12:00:00.000Z';
const settings = { value: { firstSeenRows: true, headMoveInvalidation: true }, sources: { firstSeenRows: 'standard', headMoveInvalidation: 'standard' } };
const accepted = () => buildVerdictRecord({ repo, pr: 1, headSha: head, verdict: 'accepted', source: 'test', at: now });
const plan = (over = {}) => planLedgerObservation({ repo, pr: 1, headSha: next, events: [accepted()], now, settings, proveCarry: () => null, ...over });
const facts = { repo, pr: 1, head: { sha: next }, now, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [] };

describe('open-head ledger observations', () => {
  for (const firstSeenRows of [false, true]) for (const headMoveInvalidation of [false, true]) {
    for (const verdict of ['accepted', 'changes']) it(`honors fresh ${verdict} verdicts with observations ${firstSeenRows}/${headMoveInvalidation}`, () => {
      const flags = { value: { firstSeenRows, headMoveInvalidation } };
      const baseline = plan({ events: [], headSha: head, settings: flags });
      const fresh = buildVerdictRecord({ repo, pr: 1, headSha: next, verdict, source: 'test', at: now });
      // The observer may be disabled or its append may miss. A completed review still witnesses its head.
      const events = [...baseline, ...(baseline.length ? [] : [accepted()]), fresh];
      expect(foldVerdictLedger(events).get(1).current).toBe(fresh);
      expect(derivePrState(events, facts).verdict).toBe(verdict);
      expect(foldVerdictLedger(events).get(1).clears).toBe(verdict === 'accepted');
      const delayed = accepted();
      expect(foldVerdictLedger([...events, delayed]).get(1).current).toBe(fresh);
      if (verdict === 'changes') expect(foldVerdictLedger([...events, delayed]).get(1).outstandingHolds).toContain(fresh);
    });
  }
  it('retains a fresh review when its missed observation arrives later and permits an explicit return to an old head', () => {
    const fresh = buildVerdictRecord({ repo, pr: 1, headSha: next, verdict: 'accepted', source: 'test', at: now });
    const moved = plan()[0];
    expect(foldVerdictLedger([accepted(), fresh, moved]).get(1).current).toBe(fresh);
    expect(derivePrState([accepted(), fresh, moved], facts)).toMatchObject({ verdict: 'accepted', clears: true });
    const back = buildVerdictRecord({ repo, pr: 1, headSha: head, fromHead: next, verdict: 'head-moved', source: 'head-observer', at: now });
    const replayed = accepted();
    expect(foldVerdictLedger([accepted(), fresh, back, replayed]).get(1).current).toBe(replayed);
  });
  it('keeps a headless hold after a witnessed head and leaves a headless clear as history', () => {
    // The drain and pr-land park writers pass `headSha: v.headSha ?? null`; a hold must never vanish for that.
    const baseline = plan({ events: [], headSha: head })[0];
    const park = buildVerdictRecord({ repo, pr: 1, verdict: 'human', source: 'merge-ai-prs', at: now });
    const parked = [baseline, accepted(), park];
    expect(foldVerdictLedger(parked).get(1)).toMatchObject({ current: park, clears: false, outstandingHolds: [park] });
    expect(derivePrState(parked, facts)).toMatchObject({ verdict: 'human', clears: false });
    const moved = plan({ events: [baseline, accepted()] })[0];
    const changes = buildVerdictRecord({ repo, pr: 1, verdict: 'changes', source: 'merge-ai-prs', at: now });
    const heldAfterMove = [baseline, accepted(), moved, changes];
    expect(foldVerdictLedger(heldAfterMove).get(1).current).toBe(changes);
    // The observer reads the witnessed head, not the headless row's missing one: no repeat move, no rewind.
    expect(plan({ events: heldAfterMove })).toEqual([]);
    expect(plan({ events: heldAfterMove, headSha: 'c'.repeat(40) })[0]).toMatchObject({ verdict: 'head-moved', fromHead: next });
    const headlessAccept = buildVerdictRecord({ repo, pr: 1, verdict: 'accepted', source: 'test', at: now });
    const afterMove = [baseline, accepted(), moved, headlessAccept];
    expect(foldVerdictLedger(afterMove).get(1)).toMatchObject({ current: moved, clears: false });
    expect(derivePrState(afterMove, facts).clears).toBe(false);
    // A drain park built from a list snapshot can name a superseded head after the new head was accepted.
    // The label holds whatever head is live, so the hold applies too, without rewinding the witness.
    const acceptedNext = buildVerdictRecord({ repo, pr: 1, headSha: next, verdict: 'accepted', source: 'test', at: now });
    const stalePark = buildVerdictRecord({ repo, pr: 1, headSha: head, verdict: 'pending', source: 'merge-ai-prs', at: now });
    const staleParked = [baseline, accepted(), moved, acceptedNext, stalePark];
    expect(foldVerdictLedger(staleParked).get(1)).toMatchObject({ current: stalePark, clears: false, outstandingHolds: [stalePark] });
    expect(derivePrState(staleParked, facts).clears).toBe(false);
    expect(plan({ events: staleParked })).toEqual([]);
    expect(foldVerdictLedger([...staleParked, accepted()]).get(1).current).toBe(stalePark);
    // A late baseline (a store split or transport race past the append guard) keeps its imported hold.
    const lateHold = plan({ events: [], headSha: head, labels: ['review:human'] })[0];
    const lateBaseline = [baseline, accepted(), moved, acceptedNext, lateHold];
    expect(foldVerdictLedger(lateBaseline).get(1)).toMatchObject({ current: lateHold, clears: false });
    expect(plan({ events: lateBaseline })).toEqual([]);
    expect(foldVerdictLedger([baseline, accepted(), plan({ events: [], headSha: next })[0]]).get(1).current).toMatchObject({ verdict: 'accepted' });
    // A headless hold never moves the witness, so the next live transition from that head still applies.
    const movedAfterPark = plan({ events: parked })[0];
    expect(movedAfterPark).toMatchObject({ verdict: 'head-moved', fromHead: head });
    expect(foldVerdictLedger([...parked, movedAfterPark]).get(1).current).toBe(movedAfterPark);
  });
  it('does not let a stale transition end approval scope on the current head', () => {
    const human = buildVerdictRecord({ repo, pr: 1, headSha: next, verdict: 'human', source: 'test', at: now });
    const approval = buildLedgerEvent({ repo, pr: 1, at: now, source: 'test', type: 'approval', approval: 'clear-human' });
    expect(derivePrState([accepted(), human, approval, plan()[0]], facts).clears).toBe(true);
  });
  it('records first sight, imports holds, and does not invent acceptance from labels', () => {
    expect(plan({ events: [], labels: ['review:human'] })[0]).toMatchObject({ source: 'first-seen', verdict: 'human', coverage: { headSha: next } });
    expect(plan({ events: [], labels: ['review:accepted'] })[0]).toMatchObject({ verdict: 'observed', clears: false, state: 'accepted' });
    expect(plan({ state: 'CLOSED', events: [] })).toEqual([]);
    expect(plan({ headSha: head })).toEqual([]);
  });
  it('invalidates old verdicts and implicit approvals', () => {
    const approval = buildLedgerEvent({ repo, pr: 1, at: now, source: 'test', type: 'approval', approval: 'clear-human' });
    const moved = plan()[0];
    const events = [accepted(), approval, moved];
    expect(moved).toMatchObject({ verdict: 'head-moved', clears: false, fromHead: head });
    expect(foldVerdictLedger(events).get(1).current.coverage.headSha).toBe(next);
    expect(derivePrState(events, facts)).toMatchObject({ clears: false, verdict: 'head-moved' });
    expect(validateVerdictRecord(moved).valid).toBe(true);
    expect(foldVerdictLedger([...events, accepted()]).get(1).current).toBe(moved);
    expect(derivePrState([...events, accepted()], facts).clears).toBe(false);
  });
  it('requires a fresh drain exemption after invalidating an exempt old head', () => {
    const oldExempt = buildLedgerEvent({ repo, pr: 1, at: now, source: 'test', type: 'review-exempt', headSha: head, basis: 'no review owed' });
    const moved = plan({ events: [oldExempt] })[0];
    const events = [oldExempt, moved];
    expect(derivePrState(events, facts).clears).toBe(false);
    const fresh = planDrainLedgerFacts({ repo, events, now,
      verdicts: [{ repo, num: 1, headSha: next, decision: 'merge', reviewGate: { reviewExempt: true } }] });
    expect(fresh).toHaveLength(1);
    expect(derivePrState([...events, ...fresh], facts).clears).toBe(true);
  });
  it('records the numbering carry rule and covers the new head', () => {
    const carried = plan({ proveCarry: () => 'numbering-only' })[0];
    expect(carried).toMatchObject({ verdict: 'carried', carryRule: 'numbering-only', fromHead: head, coverage: { headSha: next }, clears: true });
    expect(derivePrState([accepted(), carried], facts).clears).toBe(true);
    expect(validateVerdictRecord(carried).record.carryRule).toBe('numbering-only');
  });
  it('carries a human clearance followed by its approval event and retains the clearance kind', () => {
    const cleared = buildVerdictRecord({ repo, pr: 1, at: now, source: 'test', verdict: 'clear-human', headSha: head });
    const approval = buildLedgerEvent({ repo, pr: 1, at: now, source: 'test', type: 'approval', approval: 'clear-human' });
    let human;
    const carried = plan({ events: [cleared, approval], proveCarry: args => { human = args.human; return 'tree-identical'; } })[0];
    expect(human).toBe(true);
    expect(carried).toMatchObject({ verdict: 'carried', state: 'clear-human', carryRule: 'tree-identical' });
    expect(ledgerObservationApplies(carried, [cleared, approval])).toBe(true);
    expect(derivePrState([cleared, approval, carried], facts).clears).toBe(true);
  });
  it('rechecks observation preconditions against the append tip', () => {
    const baseline = plan({ events: [] })[0], moved = plan()[0];
    expect(ledgerObservationApplies(baseline, [])).toBe(true);
    expect(ledgerObservationApplies(baseline, [accepted()])).toBe(false);
    expect(ledgerObservationApplies(moved, [accepted(), moved])).toBe(false);
  });
  it('backfills idempotently and removes no-row readiness accounting', async () => {
    const events = [], prs = [{ number: 1, headRefOid: next, state: 'OPEN', labels: ['review:pending'] }];
    const append = row => { events.push(row); return { ok: true }; };
    const before = shadowRow({ repo, verdict: { num: 1, headSha: next, decision: 'merge' }, events });
    expect(before.ledgerHolds).toContain('no-ledger-row');
    expect(await backfillLedger({ repo, prs, events, dryRun: true, append, settings, now })).toMatchObject({ missing: 1, written: 0 });
    expect(events).toHaveLength(0);
    expect(await backfillLedger({ repo, prs, events, append, settings, now })).toMatchObject({ written: 1 });
    expect(await backfillLedger({ repo, prs, events, append, settings, now })).toMatchObject({ missing: 0, written: 0 });
    expect(shadowRow({ repo, verdict: { num: 1, headSha: next, decision: 'merge' }, events }).ledgerHolds).not.toContain('no-ledger-row');
  });
  it('backfills through the real locked home writer and skips a late baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-backfill-'));
    vi.stubEnv('WE_VERDICT_LEDGER_DIR', join(dir, 'rows'));
    vi.stubEnv('WE_VERDICT_LEDGER_STORE', 'home');
    try {
      const prs = [{ number: 1, headRefOid: next, labels: ['review:pending'] }];
      const append = row => appendVerdict(row, { store: 'home' });
      expect(await backfillLedger({ repo, prs, events: [], append, settings, now })).toMatchObject({ written: 1 });
      const events = readObservationLedger(repo);
      expect(events).toHaveLength(1);
      expect(await backfillLedger({ repo, prs, events, append, settings, now })).toMatchObject({ written: 0 });
      expect(append(plan({ events: [] })[0]).ok).toBe(true);
      expect(readObservationLedger(repo)).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('feeds open PR sightings to the observer and ignores historical check SHAs', async () => {
    const seen = [];
    const event = { type: 'pull_request', repo, prs: [1], sha: next, state: 'open', action: 'synchronize' };
    const waker = createEventWaker({ role: 'review', observeHead: (...args) => seen.push(args),
      poll: async () => ({ ok: true, cursor: 1, events: [event, { ...event, type: 'check_run' }, { ...event, state: 'closed' }], more: false }) });
    await waker.pollOnce();
    expect(seen).toEqual([[event, 1]]);
  });
  it('holds on unreadable input and logs settings sources', () => {
    const logs = [];
    const result = observeLedgerHead({ repo, pr: 1, headSha: head }, { settings, read: () => { throw Error('unreadable'); }, log: s => logs.push(s) });
    expect(result.ok).toBe(false);
    expect(logs.join('\n')).toContain('ledger.firstSeenRows=true (standard)');
    expect(plan({ events: [], settings: { value: { firstSeenRows: false } } })).toEqual([]);
    expect(plan({ settings: { value: { headMoveInvalidation: false } } })).toEqual([]);
    expect(resolveLedgerObservationSettings({ tool: { firstSeenRows: false }, platform: {}, env: {} })).toMatchObject({ value: { firstSeenRows: false, headMoveInvalidation: true }, sources: { firstSeenRows: 'tool' } });
  });
  it('reads the current PR instead of rewinding to a delayed feed SHA', () => {
    let seen;
    observeLedgerPrEvent({ repo, sha: head }, 1, { readPr: () => ({ state: 'OPEN', headRefOid: next, labels: [] }), observe: f => { seen = f; } });
    expect(seen.headSha).toBe(next);
  });
  it('keeps a newer ledger acceptance when a drain snapshot still names an older head', () => {
    const current = buildVerdictRecord({ repo, pr: 1, headSha: next, verdict: 'accepted', source: 'test', at: now });
    const append = vi.fn();
    const readPr = vi.fn(() => ({ state: 'OPEN', headRefOid: next, labels: [] }));
    const result = observeLiveLedgerHead({ repo, pr: 1, headSha: head, listedHeadSha: head }, {
      readPr, observe: live => observeLedgerHead(live, { settings, read: () => [current], append }),
    });
    expect(readPr).toHaveBeenCalledWith(repo, 1);
    expect(result).toMatchObject({ ok: true, rows: [] });
    expect(append).not.toHaveBeenCalled();
  });
  it('uses the existing numbering proof on real git objects', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ledger-numbering-'));
    const git = args => String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    try {
      git(['init', '-b', 'main']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
      mkdirSync(join(cwd, 'backlog'));
      writeFileSync(join(cwd, 'backlog/xabcdef-card.md'), '---\ntitle: Test\n---\nTest card\n');
      git(['add', '.']); git(['commit', '-m', 'base']);
      const fromSha = git(['rev-parse', 'HEAD']);
      git(['update-ref', 'refs/remotes/origin/main', fromSha]);
      git(['mv', 'backlog/xabcdef-card.md', 'backlog/123-card.md']);
      writeFileSync(join(cwd, 'backlog/123-card.md'), '---\nbornAs: xabcdef\ntitle: Test\n---\nTest card\n');
      git(['add', '.']); git(['commit', '-m', 'drain: JIT-number xabcdef→#123 at land (#2288)']);
      const toSha = git(['rev-parse', 'HEAD']);
      const rule = proveLedgerCarry({ fromSha, toSha, cwd });
      expect(rule).toBe('numbering-only');
      git(['commit', '--allow-empty', '-m', 'empty recovery']);
      expect(proveLedgerCarry({ fromSha: toSha, toSha: git(['rev-parse', 'HEAD']), cwd })).toBe('tree-identical');
      const prior = buildVerdictRecord({ repo, pr: 1, headSha: fromSha, verdict: 'accepted', source: 'test', at: now });
      expect(plan({ headSha: toSha, events: [prior], proveCarry: args => proveLedgerCarry({ ...args, cwd }) })[0]).toMatchObject({ verdict: 'carried', carryRule: 'numbering-only' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
