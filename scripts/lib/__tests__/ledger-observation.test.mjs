import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planLedgerObservation, observeLedgerHead, observeLedgerPrEvent, observeLiveLedgerHead, proveLedgerCarry,
  resolveLedgerObservationSettings, readObservationLedger, observeDrainLedgerHeads, ghBudget } from '../ledger-observation.mjs';
import { appendGitRowsSync, appendLedgerRows } from '../verdict-ledger-io.mjs';
import { appendVerdict, buildVerdictRecord, buildLedgerEvent, foldVerdictLedger, ledgerObservationApplies, validateVerdictRecord } from '../verdict-ledger.mjs';
import { derivePrState } from '../pr-state.mjs';
import { planDrainLedgerFacts } from '../drain-ledger-facts.mjs';
import { shadowRow } from '../drain-ledger-shadow.mjs';
import { createEventWaker } from '../pr-events.mjs';
import { backfillLedger, main } from '../../operations/ledger-backfill.mjs';
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
  it('baselines a PR whose only rows are headless, then records its head moves', () => {
    const park = buildVerdictRecord({ repo, pr: 1, verdict: 'human', source: 'merge-ai-prs', at: now });
    const [baseline] = plan({ events: [park], labels: ['review:human'] });
    expect(baseline).toMatchObject({ source: 'first-seen', coverage: { headSha: next } });
    expect(ledgerObservationApplies(baseline, [park])).toBe(true);
    expect(ledgerObservationApplies(baseline, [park, baseline])).toBe(false);
    const events = [park, baseline];
    expect(foldVerdictLedger(events).get(1)).toMatchObject({ clears: false });
    expect(plan({ events })).toEqual([]);
    expect(plan({ events, headSha: 'c'.repeat(40) })[0]).toMatchObject({ verdict: 'head-moved', fromHead: next });
  });
  it('backfills a PR whose only rows are headless', async () => {
    const events = [buildVerdictRecord({ repo, pr: 1, verdict: 'human', source: 'merge-ai-prs', at: now })];
    const prs = [{ number: 1, headRefOid: next, state: 'OPEN', labels: ['review:human'] }];
    const append = row => { events.push(row); return { ok: true }; };
    expect(await backfillLedger({ repo, prs, events, append, settings, now })).toMatchObject({ missing: 1, written: 1 });
    expect(events.at(-1)).toMatchObject({ source: 'first-seen', coverage: { headSha: next } });
    expect(await backfillLedger({ repo, prs, events, append, settings, now })).toMatchObject({ missing: 0, written: 0 });
  });
  it('never lets a carry prover upgrade a hold or an unreviewed head into a clearing carry', () => {
    // Deliberate pins on the two existing carry guards (planLedgerObservation#canCarry, ledgerObservationApplies).
    const always = () => 'tree-identical';
    for (const verdict of ['changes', 'human', 'pending']) {
      const held = [accepted(), buildVerdictRecord({ repo, pr: 1, headSha: head, verdict, source: 'test', at: now })];
      expect(plan({ events: held, proveCarry: always })[0]).toMatchObject({ verdict: 'head-moved', clears: false });
    }
    const moved = plan({ headSha: next })[0];
    expect(plan({ events: [accepted(), moved], headSha: 'c'.repeat(40), proveCarry: always })[0]).toMatchObject({ verdict: 'head-moved', fromHead: next });
    const forged = buildVerdictRecord({ repo, pr: 1, headSha: next, fromHead: head, verdict: 'carried', carryRule: 'tree-identical', source: 'head-observer', at: now });
    const changes = buildVerdictRecord({ repo, pr: 1, headSha: head, verdict: 'changes', source: 'test', at: now });
    expect(ledgerObservationApplies(forged, [changes])).toBe(false);
    expect(ledgerObservationApplies(forged, [accepted()])).toBe(true);
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
  it('re-emits a new-head exemption that a late head move pushed behind its boundary', () => {
    const baseline = plan({ events: [], headSha: head })[0];
    const earlyExempt = buildLedgerEvent({ repo, pr: 1, at: now, source: 'test', type: 'review-exempt', headSha: next, basis: 'no review owed' });
    const lateMove = plan({ events: [baseline] })[0];
    const events = [baseline, earlyExempt, lateMove];
    expect(derivePrState(events, facts).clears).toBe(false);
    const fresh = planDrainLedgerFacts({ repo, events, now,
      verdicts: [{ repo, num: 1, headSha: next, decision: 'merge', reviewGate: { reviewExempt: true } }] });
    expect(fresh).toHaveLength(1);
    expect(derivePrState([...events, ...fresh], facts).clears).toBe(true);
    expect(planDrainLedgerFacts({ repo, events: [...events, ...fresh], now,
      verdicts: [{ repo, num: 1, headSha: next, decision: 'merge', reviewGate: { reviewExempt: true } }] })).toEqual([]);
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
  describe('backfill command main()', () => {
    const pr = n => ({ number: n, head: { sha: String(n).repeat(40).slice(0, 40) }, state: 'open', labels: [] });
    // Own sources so the once-per-line settings log is not consumed for the other tests in this file.
    const cli = { ...settings, sources: { firstSeenRows: 'cli-test', headMoveInvalidation: 'cli-test' } };
    const run = async (argv, { pages = [[pr(1)], [pr(2)]], ledger = { status: 'ok', rows: [] } } = {}) => {
      const calls = [], appended = [], printed = [];
      const exec = (cmd, args) => { calls.push(args); return JSON.stringify(args[0] === 'repo' ? { nameWithOwner: repo } : pages); };
      const result = await main(argv, { exec, readLedger: () => ledger, settings: cli, out: s => printed.push(s), log: () => {},
        append: row => { appended.push(row); return { ok: true }; } });
      return { result, calls, appended, printed };
    };
    it('flattens every --slurp page into the dry-run count and writes nothing', async () => {
      const { result, calls, appended, printed } = await run(['--dry-run', `--repo=${repo}`]);
      expect(calls).toEqual([['api', `repos/${repo}/pulls?state=open&per_page=100`, '--paginate', '--slurp']]);
      expect(result).toMatchObject({ dryRun: true, open: 2, missing: 2, planned: 2, written: 0 });
      expect(appended).toEqual([]);
      expect(JSON.parse(printed.join(''))).toEqual(result);
    });
    it('appends through the injected writer without --dry-run and resolves the repo from gh', async () => {
      const { result, appended } = await run([]);
      expect(result).toMatchObject({ repo, dryRun: false, open: 2, written: 2 });
      expect(appended.map(r => r.source)).toEqual(['first-seen', 'first-seen']);
    });
    it('refuses an unknown flag or a malformed repo before reading GitHub', async () => {
      for (const argv of [['--force'], ['--repo=../x'], ['--repo=owner/..'], ['--repo=./.'], ['--repo=owner/name;rm'], ['--repo=a/b/c']]) {
        const calls = [];
        await expect(main(argv, { exec: (c, a) => { calls.push(a); return '[]'; }, readLedger: () => ({ status: 'ok', rows: [] }), settings: cli, log: () => {} }))
          .rejects.toThrow(/usage|invalid repository/);
        expect(calls).toEqual([]);
      }
    });
    it('refuses a non-page --slurp shape and an unreadable ledger', async () => {
      await expect(run([`--repo=${repo}`], { pages: [pr(1)] })).rejects.toThrow(/array of pages/);
      await expect(run([`--repo=${repo}`], { ledger: { status: 'unreadable', reason: 'lock' } })).rejects.toThrow('ledger unreadable: lock');
      await expect(run([`--repo=${repo}`], { ledger: null })).rejects.toThrow('ledger unreadable');
    });
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
  describe('drain observation cap per pass (operator send-back item 1)', () => {
    const sha = n => String(n).repeat(40).slice(0, 40);
    const targets = n => Array.from({ length: n }, (_, i) => ({ repo, pr: i + 1, listedHeadSha: sha(i + 1) }));
    const capped = (max, budget) => ({ value: { firstSeenRows: true, headMoveInvalidation: true, drainObserveMaxPerPass: max, drainObserveBudgetMs: budget },
      sources: { firstSeenRows: 'standard', headMoveInvalidation: 'standard', drainObserveMaxPerPass: 'tool', drainObserveBudgetMs: 'tool' } });
    const run = ({ n = 5, max = 2, budget = 15_000, read = () => [], readPr, append, cost = 0 } = {}) => {
      let now = 1_000; const logs = [], reads = [], appended = [];
      const out = observeDrainLedgerHeads(targets(n), { read, settings: capped(max, budget), clock: () => now, log: s => logs.push(s),
        readPr: readPr ?? ((r, pr, opts) => { reads.push([pr, opts]); now += cost; return { state: 'OPEN', headRefOid: sha(pr), labels: [] }; }),
        append: append ?? (row => { appended.push(row.pr); return { ok: true }; }) });
      return { out, logs, reads, appended, clock: () => now, tick: ms => { now += ms; } };
    };
    it('resolves both caps through the ledger cascade with standard defaults', () => {
      expect(resolveLedgerObservationSettings({ tool: {}, platform: null }).value).toMatchObject({ drainObserveMaxPerPass: 20, drainObserveBudgetMs: 15_000 });
      const r = resolveLedgerObservationSettings({ tool: { drainObserveMaxPerPass: 3, drainObserveBudgetMs: 'x' }, platform: null });
      expect(r.value).toMatchObject({ drainObserveMaxPerPass: 3, drainObserveBudgetMs: 15_000 });
      expect(r.sources).toMatchObject({ drainObserveMaxPerPass: 'tool', drainObserveBudgetMs: 'standard' });
      expect(r.invalid).toEqual(['tool.drainObserveBudgetMs="x"']);
    });
    it('count cap: live reads stop at ledger.drainObserveMaxPerPass and the rest are one logged miss', () => {
      const { out, logs, reads, appended } = run({ n: 5, max: 2 });
      expect(reads.map(r => r[0])).toEqual([1, 2]);
      expect(appended).toEqual([1, 2]);
      expect(out).toMatchObject({ observed: 2, capped: [{ pr: 3 }, { pr: 4 }, { pr: 5 }] });
      expect(logs.join('\n')).toContain('ledger.drainObserveMaxPerPass=2 (tool)');
      expect(logs.join('\n')).toContain(`ledger-write-miss: drain observation skipped 3 PR(s) this pass (count cap ledger.drainObserveMaxPerPass=2): ${repo}#3, ${repo}#4, ${repo}#5`);
    });
    it('unchanged heads cost no live read and are never capped', () => {
      const witnessed = pr => buildVerdictRecord({ repo, pr, headSha: sha(pr), verdict: 'accepted', source: 'test', at: now });
      const { out, reads } = run({ n: 4, max: 1, read: () => [witnessed(1), witnessed(2), witnessed(4)] });
      expect(reads.map(r => r[0])).toEqual([3]);
      expect(out).toMatchObject({ observed: 1, unchanged: 3, capped: [] });
    });
    it('time budget: a slow gh read ends the pass\'s observing; each read gets the remaining budget as its timeout', () => {
      const { out, logs, reads } = run({ n: 4, max: 20, budget: 10_000, cost: 6_000 });
      expect(reads.map(([pr, opts]) => [pr, opts.timeout])).toEqual([[1, 10_000], [2, 4_000]]);
      expect(out.capped.map(t => t.pr)).toEqual([3, 4]);
      expect(logs.join('\n')).toContain('(time budget ledger.drainObserveBudgetMs=10000)');
    });
    it('slow git leg: a failing, slow dual-store git append stops at the pass deadline and skips the rest with a logged miss', () => {
      let pushes = 0, sleeps = 0, clockRef;
      const calls = [];
      // Each git command takes 4s and every push is rejected: without the deadline, 5 attempts x ~6 commands each.
      const slowRun = (args, opts) => { calls.push({ cmd: args[0], at: clockRef.clock(), timeout: opts?.timeout }); clockRef.tick(4_000);
        if (args[0] === 'push') { pushes += 1; throw Error('! [rejected] slow remote'); }
        return args[0] === 'diff' ? 'verdict-ledger/x.jsonl' : ''; };
      const gitLeg = (row, opts) => appendGitRowsSync([row], { board: '/board', repo, ...opts }, { appendRows: args => appendLedgerRows({ ...args,
        run: slowRun, sleep: () => { sleeps += 1; }, clock: clockRef.clock, mkdir: () => {}, write: () => {}, rm: () => {}, read: () => null, now: () => 1 }) });
      const append = (row, opts) => { const g = gitLeg(row, opts); return g.ok ? { ok: true } : { ok: true, ledgerWriteMiss: true, errors: [g.error] }; };
      let now = 1_000; const logs = [];
      clockRef = { clock: () => now, tick: ms => { now += ms; } };
      const started = now;
      const out = observeDrainLedgerHeads(targets(4), { read: () => [], settings: capped(20, 15_000), clock: clockRef.clock, log: s => logs.push(s),
        readPr: (r, pr) => ({ state: 'OPEN', headRefOid: sha(pr), labels: [] }), append });
      // PR 1's git leg is bounded by the 15s budget: every command carries the time left as its timeout, no network
      // command starts past it, there is no retry or sleep, and PRs 2–4 never start a write.
      const deadline = started + 15_000;
      expect(calls.length).toBeGreaterThan(1);
      for (const c of calls) expect(c.timeout).toBe(Math.max(deadline - c.at, 2_000));
      expect(calls.filter(c => ['fetch', 'push', 'ls-remote'].includes(c.cmd) && c.at >= deadline)).toEqual([]);
      expect(pushes).toBeLessThanOrEqual(1);
      expect(sleeps).toBe(0);
      expect(out).toMatchObject({ observed: 1, missed: [{ pr: 1 }], capped: [{ pr: 2 }, { pr: 3 }, { pr: 4 }] });
      expect(logs.join('\n')).toMatch(/ledger-write-miss: observation example\/repo#1: .*deadline passed before/);
      expect(logs.join('\n')).toContain('drain observation skipped 3 PR(s) this pass (time budget ledger.drainObserveBudgetMs=15000)');
      expect(logs.join('\n')).toContain(`drain observation failed for 1 PR(s): ${repo}#1`);
    });
    it('the live gh read stays inside its budget: the throttle wait and the child split it, and a rate-limited read is not retried', () => {
      expect(ghBudget(10_000)).toEqual({ timeout: 5_000, throttle: { acquireTimeoutMs: 5_000, maxAttempts: 1 } });
      expect(ghBudget(1)).toEqual({ timeout: 1, throttle: { acquireTimeoutMs: 1, maxAttempts: 1 } });
      const logs = [];
      // Already past the deadline: the read never starts.
      const readPr = vi.fn();
      expect(observeLedgerPrEvent({ repo }, 1, { readPr, deadline: 5, clock: () => 5, log: s => logs.push(s) })).toEqual({ ok: false });
      expect(readPr).not.toHaveBeenCalled();
      expect(logs.join('\n')).toContain('observation budget spent before the live read');
    });
    it('a throwing observer or unreadable snapshot never throws out of the pass', () => {
      const logs = [];
      const out = observeDrainLedgerHeads(targets(2), { read: () => { throw Error('unreadable'); }, settings: capped(5, 1_000), log: s => logs.push(s),
        observe: () => { throw Error('boom'); } });
      expect(out).toMatchObject({ observed: 2, missed: [{ pr: 1 }, { pr: 2 }] });
      expect(logs.join('\n')).toContain('drain observation failed for 2 PR(s)');
    });
  });
  describe('home writer guard (appendVerdictHome → ledgerObservationApplies at the locked tip)', () => {
    const third = 'c'.repeat(40), key = `sha256:${'9'.repeat(64)}`;
    const withHome = fn => {
      const dir = mkdtempSync(join(tmpdir(), 'ledger-home-guard-'));
      vi.stubEnv('WE_VERDICT_LEDGER_DIR', join(dir, 'rows'));
      vi.stubEnv('WE_VERDICT_LEDGER_STORE', 'home');
      try { fn(row => appendVerdict(row, { store: 'home' })); } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
    };
    const moved = (verdict, to = next, from = head) => buildVerdictRecord({ repo, pr: 1, headSha: to, fromHead: from, verdict,
      source: 'head-observer', at: now, ...(verdict === 'carried' ? { carryRule: 'tree-identical', state: 'accepted' } : {}) });
    it('head-moved: writes at a matching tip, refuses a stale from-head and an already-witnessed destination', () => withHome(append => {
      expect(append(accepted())).toMatchObject({ ok: true });
      const row = moved('head-moved');
      // Planned from a snapshot; a fresh review of B lands first, so B is already witnessed at the tip.
      expect(append(buildVerdictRecord({ repo, pr: 1, headSha: next, verdict: 'accepted', source: 'test', at: now }))).toMatchObject({ ok: true });
      expect(append(row)).toMatchObject({ ok: true, duplicate: true });
      // A move whose from-head is no longer the witness (a delayed A→C after the tip moved to B) is refused too.
      expect(append(moved('head-moved', third, head))).toMatchObject({ ok: true, duplicate: true });
      expect(readObservationLedger(repo).map(r => r.verdict)).toEqual(['accepted', 'accepted']);
      // The live move B→C applies and is written.
      expect(append(moved('head-moved', third, next))).toMatchObject({ ok: true });
      expect(append(moved('head-moved', third, next))).toMatchObject({ ok: true, duplicate: true });
      expect(readObservationLedger(repo).map(r => r.verdict)).toEqual(['accepted', 'accepted', 'head-moved']);
    }));
    it('carried: writes only while the carry is allowed at the tip; an outstanding referral refuses it', () => withHome(append => {
      expect(append(accepted())).toMatchObject({ ok: true });
      append(buildLedgerEvent({ repo, pr: 1, type: 'referral', headSha: head, findingKeys: [key], at: now, source: 'test' }));
      expect(append(moved('carried'))).toMatchObject({ ok: true, duplicate: true });
      append(buildLedgerEvent({ repo, pr: 1, type: 'ruling', findingKey: key, ruling: 'not-real', at: now, source: 'test' }));
      expect(append(moved('carried'))).toMatchObject({ ok: true });
      expect(readObservationLedger(repo).filter(r => r.verdict === 'carried')).toHaveLength(1);
      // A stale carry from the old head after the tip moved on is refused.
      expect(append(moved('carried', third, head))).toMatchObject({ ok: true, duplicate: true });
      expect(readObservationLedger(repo).filter(r => r.verdict === 'carried')).toHaveLength(1);
    }));
  });
  it('feeds open PR sightings to the observer and ignores historical check SHAs', async () => {
    const seen = [];
    const event = { type: 'pull_request', repo, prs: [1], sha: next, state: 'open', action: 'synchronize' };
    const waker = createEventWaker({ role: 'review', repos: [repo], observeHead: (...args) => seen.push(args),
      poll: async () => ({ ok: true, cursor: 1, events: [event, { ...event, type: 'check_run' }, { ...event, state: 'closed' }], more: false }) });
    await waker.pollOnce();
    expect(seen).toEqual([[event, 1, { deadline: expect.any(Number) }]]);
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
  it('resolves both observation defaults to true with all override layers empty', () => {
    expect(resolveLedgerObservationSettings({ tool: {}, platform: {}, env: {} })).toMatchObject({
      value: { firstSeenRows: true, headMoveInvalidation: true },
      sources: { firstSeenRows: 'standard', headMoveInvalidation: 'standard' } });
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
  it('skips the live read only while the listed head equals the witnessed head', () => {
    const readPr = vi.fn(() => ({ state: 'OPEN', headRefOid: next, labels: [] }));
    const observe = vi.fn(() => ({ ok: true, rows: [] }));
    const witnessed = [plan({ events: [], headSha: head })[0]];
    // Steady state: nothing moved, so no `gh pr view` this pass.
    expect(observeLiveLedgerHead({ repo, pr: 1, listedHeadSha: head.toUpperCase() }, { read: () => witnessed, readPr, observe }))
      .toMatchObject({ ok: true, skipped: 'head-unchanged' });
    expect(readPr).not.toHaveBeenCalled();
    // A moved listed head, no witnessed head, a short listed head, or an unreadable snapshot all read live.
    observeLiveLedgerHead({ repo, pr: 1, listedHeadSha: next }, { read: () => witnessed, readPr, observe });
    observeLiveLedgerHead({ repo, pr: 1, listedHeadSha: head }, { read: () => [], readPr, observe });
    observeLiveLedgerHead({ repo, pr: 1, listedHeadSha: 'sha-1' }, { read: () => witnessed, readPr, observe });
    observeLiveLedgerHead({ repo, pr: 1, listedHeadSha: head }, { read: () => { throw Error('unreadable'); }, readPr, observe });
    expect(readPr).toHaveBeenCalledTimes(4);
    // The observed head is always the live one, never the listed snapshot.
    expect(observe.mock.calls.every(([facts]) => facts.headSha === next)).toBe(true);
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
