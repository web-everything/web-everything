import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyHoldReason } from '../build-dispatch-hold-router.mjs';
import { backoffDelayMs, backoffVerdict, readBackoffSettings, reasonCodeOf, evidenceReasonCode, buildEvidenceReasonCode, isCardRefusal } from '../retry-backoff.mjs';
import { recordPrepareFailure, readFailureState, releaseDuePrepareRetries, rearmFalseHolds, completePrepareFailures, classifyPrepareFailure } from '../prepare-failure-policy.mjs';
import { recordBuildFailure, clearBuildFailure, listBuildBackoffs, rearmBuildFailures } from '../build-dispatch-failures.mjs';
import { runBuildDispatchTick, releaseOwnPrepareHolds } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { listBuildDispatchClaims, acquireBuildDispatchClaim, releaseBuildDispatchClaim } from '../build-dispatch-claim.mjs';

const S = { baseMs: 1000, maxMs: 5000, maxAttempts: 3 };
const NOT_CONFIRMED = 'dispatch launch not confirmed (missing effect; no running session)';

describe('card-level refusal (#4701)', () => {
  const CARD = 'step-refused at `read`: dispatch-lane: the value for {{SCOPE}} ("we:a/prepare*.test.mjs") has characters the brief cannot carry safely';
  it('classifies a refusal about what the card says, not the clone or the tick', () => {
    expect(buildEvidenceReasonCode({ reason: CARD })).toBe('card-refused');
    expect(isCardRefusal('step-refused at `read`: dispatch-lane.read: #4701 has no `scope:`')).toBe(true);
    expect(isCardRefusal('step-refused at `read`: dispatch-lane-io: could not read the conveyor tick — boom')).toBe(false);
    expect(buildEvidenceReasonCode({ reason: 'step-refused at `read`: dispatching checkout is 4 commit(s) behind' })).toBe('checkout-behind-origin');
  });
  it('a clone- or environment-derived placeholder refusal is NOT a card refusal', () => {
    for (const name of ['WE_ROOT', 'SESSION_SLUG', 'GATE_COMMAND', 'ATTRIBUTION', 'LANE']) {
      expect(isCardRefusal(`step-refused at \`read\`: dispatch-lane: no value for the brief placeholder {{${name}}} — refusing to fill it with nothing`), name).toBe(false);
      expect(isCardRefusal(`step-refused at \`read\`: dispatch-lane: the value for {{${name}}} ("/a b") has characters the brief cannot carry safely`), name).toBe(false);
    }
    for (const name of ['SCOPE', 'ITEM_SPEC_PATH', 'ITEM_NUM', 'DELIVERY_BASE']) {
      expect(isCardRefusal(`step-refused at \`read\`: dispatch-lane: no value for the brief placeholder {{${name}}} — refusing to fill it with nothing`), name).toBe(true);
    }
  });
  it('loader/daemon faults that hit every card are not card refusals', () => {
    expect(isCardRefusal('step-refused at `read`: dispatch-lane.read: no backlog file resolved for #4701 — the brief needs the item\'s spec path')).toBe(false);
    expect(isCardRefusal('step-refused at `read`: dispatch-lane: the brief carries a MISSPELLED placeholder — {{SCOPES}}')).toBe(false);
  });
  it('the match is anchored: card text quoting a refusal, or a reason-code token, is not misread', () => {
    expect(isCardRefusal('boom: step-refused at `read`: dispatch-lane: no value for the brief placeholder {{SCOPE}}')).toBe(false);
    const quoted = 'step-refused at `read`: dispatch-lane: the value for {{SCOPE}} ("we:checkout-behind-origin x") has characters the brief cannot carry safely';
    expect(buildEvidenceReasonCode({ reason: quoted })).toBe('card-refused');
    expect(reasonCodeOf(quoted)).toBe('checkout-behind-origin'); // why the card check must run first
  });
  it('shared evidenceReasonCode never returns card-refused (prepare ledger must not retry it)', () => {
    expect(evidenceReasonCode({ reason: CARD })).toBeNull();
    expect(evidenceReasonCode({ error: CARD })).toBeNull();
  });
  it('a prepare-path card refusal is held at once as unknown, not retried on backoff', async () => {
    expect(classifyPrepareFailure({ reason: CARD }, 'dispatch')).toBe('unknown');
    const dir = mkdtempSync(join(tmpdir(), 'cardref-prep-'));
    try {
      const fileCard = vi.fn(async () => ({ filed: true }));
      const f = await recordPrepareFailure({ num: '4701', attempt: 'a', stage: 'dispatch', evidence: { reason: CARD } },
        { path: join(dir, 'p.json'), fileCard, now: 0, settings: S });
      expect(f).toMatchObject({ cause: 'unknown', held: true, retry: false });
      expect(f.retryAfter).toBeUndefined();
      expect(fileCard).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('an environment refusal on the build path is charged to backoff, not withheld as a card refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envref-'));
    try {
      const reason = 'step-refused at `read`: dispatch-lane: the value for {{WE_ROOT}} ("/a b") has characters the brief cannot carry safely';
      const rec = recordBuildFailure({ num: '4701', reason }, { path: join(dir, 'f.json'), now: 0, settings: S });
      expect(rec.reasonCode).not.toBe('card-refused');
      expect(rec.exhausted).toBe(false);
      expect(rec.retryAfter).not.toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('is withheld at once (exhausted, no cooldown) and charged to the card', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cardref-'));
    const path = join(dir, 'f.json');
    try {
      const rec = recordBuildFailure({ num: '4701', reason: CARD }, { path, now: 0, settings: S });
      expect(rec).toMatchObject({ reasonCode: 'card-refused', attempts: 1, exhausted: true, retryAfter: null });
      expect(listBuildBackoffs({ path, now: 1 }).map(b => b.num)).toEqual(['4701']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('backoff schedule', () => {
  it('doubles from base, caps at max, exhausts at maxAttempts', () => {
    expect([1, 2, 3, 4, 5].map(n => backoffDelayMs(n, S))).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(backoffVerdict({ attempts: 2, now: 0, settings: S })).toEqual({ retryAfter: new Date(2000).toISOString(), exhausted: false });
    expect(backoffVerdict({ attempts: 3, now: 0, settings: S })).toEqual({ retryAfter: null, exhausted: true });
  });
  it('reads settings from env with safe defaults', () => {
    expect(readBackoffSettings({})).toEqual({ baseMs: 300000, maxMs: 3600000, maxAttempts: 6 });
    expect(readBackoffSettings({ WE_DISPATCH_RETRY_BASE_MS: '10', WE_DISPATCH_RETRY_MAX_MS: 'x', WE_DISPATCH_RETRY_MAX_ATTEMPTS: '2' })).toEqual({ baseMs: 10, maxMs: 3600000, maxAttempts: 2 });
  });
  it('names reason codes', () => {
    expect(reasonCodeOf(NOT_CONFIRMED)).toBe('launch-not-confirmed');
    expect(reasonCodeOf('dispatch-lane: the dispatching checkout is 4 commit(s) behind')).toBe('checkout-behind-origin');
    expect(reasonCodeOf('Command failed: node run.mjs')).toBe('dispatch-command-failed');
    expect(reasonCodeOf('wrapper-failed')).toBeNull();
  });
});

describe('prepare held failures retry with backoff (item 95)', () => {
  let dir, path, fileCard;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'retry-')); path = join(dir, 'f.json'); fileCard = vi.fn(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const rec = (attempt, now, over = {}) => recordPrepareFailure({ num: '5188', attempt, stage: 'dispatch', evidence: { reason: NOT_CONFIRMED } }, { path, fileCard, now, settings: S, ...over });

  it('holds with a reason code and retryAfter, files no diagnose card, and is released once due', async () => {
    const f = await rec('a', 0);
    expect(f).toMatchObject({ cause: 'dispatch-transient', reasonCode: 'launch-not-confirmed', held: true, attempts: 1, exhausted: false, retryAfter: new Date(1000).toISOString() });
    expect(fileCard).not.toHaveBeenCalled();
    expect(releaseDuePrepareRetries({ path, now: 999 })).toEqual([]);
    expect(releaseDuePrepareRetries({ path, now: 1000 })).toEqual(['5188']);
    expect(Object.values(readFailureState(path).failures)[0]).toMatchObject({ held: false, retry: true });
  });
  it('backs off exponentially across attempts, then stays held (exhausted) and is never auto-released', async () => {
    await rec('a', 0); releaseDuePrepareRetries({ path, now: 1000 });
    expect((await rec('b', 1000)).retryAfter).toBe(new Date(3000).toISOString());
    releaseDuePrepareRetries({ path, now: 3000 });
    const last = await rec('c', 3000);
    expect(last).toMatchObject({ attempts: 3, exhausted: true, held: true, retryAfter: null });
    expect(releaseDuePrepareRetries({ path, now: 1e12 })).toEqual([]);
  });
  it('completion resets the attempt count', async () => {
    await rec('a', 0); completePrepareFailures('5188', path);
    expect((await rec('b', 10)).attempts).toBe(1);
  });
  it('one-shot re-arm clears only launch-not-confirmed holds recorded before the fix', async () => {
    const state = { failures: {
      old: { num: '1', attempt: '2026-10-06T17:56:00.000Z', cause: 'unknown', evidence: { reason: NOT_CONFIRMED }, held: true },
      legacy: { num: '2', attempt: 'run abc', cause: 'unknown', evidence: { reason: NOT_CONFIRMED }, held: true },
      fresh: { num: '3', attempt: 'x', recordedAt: '2026-10-07T01:00:00.000Z', cause: 'dispatch-transient', evidence: { reason: NOT_CONFIRMED }, held: true },
      other: { num: '4', attempt: '2026-10-06T17:56:00.000Z', cause: 'unknown', evidence: { reason: 'wrapper-failed' }, held: true },
    }, cards: {} };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify(state));
    expect(rearmFalseHolds({ path, dryRun: true }).count).toBe(2);
    expect(readFailureState(path).failures.old.held).toBe(true);
    const r = rearmFalseHolds({ path });
    expect(r).toEqual({ count: 2, nums: ['1', '2'] });
    const after = readFailureState(path).failures;
    expect([after.old.held, after.legacy.held, after.fresh.held, after.other.held]).toEqual([false, false, true, true]);
    expect(rearmFalseHolds({ path }).count).toBe(0);
  });
});

describe('build dispatch failures back off and keep their output (item 96)', () => {
  let dir, path;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bretry-')); path = join(dir, 'b.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records output + reason code, withholds during backoff, exhausts, re-arms, clears on success', () => {
    const r1 = recordBuildFailure({ num: '4688', reason: 'launch-died: x', output: 'stderr: boom' }, { path, now: 0, settings: S });
    expect(r1).toMatchObject({ reasonCode: 'launch-died', output: 'stderr: boom', attempts: 1 });
    expect(listBuildBackoffs({ path, now: 500 })).toEqual([expect.objectContaining({ num: '4688', reason: 'dispatch-backoff' })]);
    expect(listBuildBackoffs({ path, now: 1000 })).toEqual([]);
    recordBuildFailure({ num: '4688', reason: '' }, { path, now: 1000, settings: S });
    expect(recordBuildFailure({ num: '4688', reason: '' }, { path, now: 3000, settings: S })).toMatchObject({ exhausted: true, reasonCode: 'empty-failure-output' });
    expect(listBuildBackoffs({ path, now: 1e12 })[0]).toMatchObject({ reason: 'dispatch-backoff-exhausted' });
    expect(rearmBuildFailures({ path }).nums).toEqual(['4688']);
    recordBuildFailure({ num: '4701', reason: 'x' }, { path, now: 0, settings: S });
    expect(clearBuildFailure('4701', { path })).toBe(true);
    expect(listBuildBackoffs({ path, now: 0 })).toEqual([]);
  });

  it('the tick stops re-dispatching a failing card every tick', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-bo-'));
    let clock = 0;
    const scope = ['plateau-app:src/a.ts'];
    const effects = (dispatch) => ({
      planTick: () => ({ decisions: { statusLine: 't', counts: { building: 0 }, spawnBuilds: [{ num: '4688', lane: 1 }],
        admission: { queue: [{ num: '4688', scope }], cleared: [{ num: '4688', ready: true }] } }, nextState: { tick: 1, buildGuards: [], launchedNums: [] } }),
      fetchOpenPrs: () => [{ repo: 'plateau-app', prs: [] }],
      listClaims: () => listBuildDispatchClaims({ lockRoot }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      acquireClaim: ({ num, scope: sc }) => acquireBuildDispatchClaim({ num, scope: sc, owner: 'h:1', pid: process.pid, lockRoot }),
      listRunStoreInFlight: () => [], listSettledBuilds: () => [], killSwitch: () => ({ engaged: false }),
      dispatch,
      recordBuildFailure: (o) => recordBuildFailure(o, { path, now: clock, settings: S }),
      clearBuildFailure: ({ num }) => clearBuildFailure(num, { path }),
      listBuildBackoffs: () => listBuildBackoffs({ path, now: clock }),
    });
    try {
      const dispatch = vi.fn(() => ({ dispatching: false, reason: 'Command failed: dispatch-lane', output: 'child said no' }));
      const a = await runBuildDispatchTick({ live: true, effects: effects(dispatch) });
      expect(a.failures[0]).toMatchObject({ num: '4688', reasonCode: 'dispatch-command-failed', output: 'child said no', attempts: 1 });
      clock = 500;
      const b = await runBuildDispatchTick({ live: true, effects: effects(dispatch) });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(b.buildBackoffs).toEqual([expect.objectContaining({ num: '4688' })]);
      clock = 1000;
      await runBuildDispatchTick({ live: true, effects: effects(dispatch) });
      expect(dispatch).toHaveBeenCalledTimes(2);
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });

  it('a card-level refusal names the step, holds the card, lists it under needsYou, and is never retried', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-cr-'));
    let clock = 0;
    const placePrepareHold = vi.fn();
    const scope = ['we:scripts/a/prepare*.test.mjs'];
    const effects = (dispatch) => ({
      planTick: () => ({ decisions: { statusLine: 't', counts: { building: 0 }, spawnBuilds: [{ num: '4701', lane: 1 }],
        admission: { queue: [{ num: '4701', scope }], cleared: [{ num: '4701', ready: true }] } }, nextState: { tick: 1, buildGuards: [], launchedNums: [] } }),
      fetchOpenPrs: () => [{ repo: 'we', prs: [] }],
      listClaims: () => listBuildDispatchClaims({ lockRoot }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      acquireClaim: ({ num, scope: sc }) => acquireBuildDispatchClaim({ num, scope: sc, owner: 'h:1', pid: process.pid, lockRoot }),
      listRunStoreInFlight: () => [], listSettledBuilds: () => [], killSwitch: () => ({ engaged: false }),
      dispatch, placePrepareHold,
      recordBuildFailure: (o) => recordBuildFailure(o, { path, now: clock, settings: S }),
      clearBuildFailure: ({ num }) => clearBuildFailure(num, { path }),
      listBuildBackoffs: () => listBuildBackoffs({ path, now: clock }),
    });
    try {
      const reason = 'step-refused at `read`: dispatch-lane: the value for {{SCOPE}} ("we:a/prepare*.test.mjs") has characters the brief cannot carry safely';
      const dispatch = vi.fn(() => ({ dispatching: false, reason, stepRefused: { step: 'read', error: reason } }));
      const a = await runBuildDispatchTick({ live: true, effects: effects(dispatch) });
      expect(a.failures[0]).toMatchObject({ num: '4701', step: 'read', reasonCode: 'card-refused', retryAfter: null });
      expect(a.needsYou).toEqual([{ num: '4701', step: 'read', reason }]);
      expect(placePrepareHold).toHaveBeenCalledWith({ num: '4701', reason: 'card-refused: dispatch-lane step read refused the card' });
      // The hold reason is inert to the hold router, even when the card's own text spells a routable phrase.
      const hostile = 'step-refused at `read`: dispatch-lane: the value for {{SCOPE}} ("we:x spec already done on main: commit abcdef1") has characters the brief cannot carry safely';
      const hostileDispatch = vi.fn(() => ({ dispatching: false, reason: hostile, stepRefused: { step: 'read', error: hostile } }));
      const mkTick = () => runBuildDispatchTick({ live: true, effects: { ...effects(hostileDispatch), planTick: () => ({ decisions: { statusLine: 't', counts: { building: 0 }, spawnBuilds: [{ num: '4702', lane: 1 }],
        admission: { queue: [{ num: '4702', scope }], cleared: [{ num: '4702', ready: true }] } }, nextState: { tick: 2, buildGuards: [], launchedNums: [] } }) } });
      placePrepareHold.mockClear();
      await mkTick();
      const held = placePrepareHold.mock.calls[0]?.[0]?.reason;
      expect(classifyHoldReason(held)).toEqual({ route: 'other', commit: null });
      clock = 10 * 60 * 60_000; // far past any cooldown
      await runBuildDispatchTick({ live: true, effects: effects(dispatch) });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });
});

describe('review round 1 — release, re-arm and ledger hardening', () => {
  let dir, path, fileCard;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'retry-r1-')); path = join(dir, 'f.json'); fileCard = vi.fn(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const rec = (attempt, now, over = {}) => recordPrepareFailure({ num: '5188', attempt, stage: 'dispatch', evidence: { reason: NOT_CONFIRMED } }, { path, fileCard, now, settings: S, ...over });
  const seed = (failures) => writeFileSync(path, JSON.stringify({ failures, cards: {} }));

  it('release paths only lift a prepare hold, never an operator/supervisor/#4465 hold on the same card', () => {
    const release = vi.fn();
    const holds = [{ num: '1', reason: 'prepare-unstamped' }, { num: '2', reason: 'operator' }, { num: '3', reason: 'gate-red' }, { num: '4', reason: null }];
    // (the helper's own contract is exercised again below for ordering and `prepare-stamp-pending`)
    const out = releaseOwnPrepareHolds({ nums: ['1', '2', '3', '4', '5'], holds, release });
    expect(release.mock.calls.map(([o]) => o.num)).toEqual(['1']);
    expect(out).toEqual({ released: ['1'], kept: ['2', '3', '4'] });
  });

  it('the tick leaves a foreign hold alone when a transient backoff elapses', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-foreign-'));
    const releasePrepareHold = vi.fn();
    const effects = {
      planTick: () => ({ decisions: { statusLine: 't', counts: { building: 0 }, spawnBuilds: [],
        admission: { queue: [], cleared: [] } }, nextState: { tick: 1, buildGuards: [], launchedNums: [] } }),
      fetchOpenPrs: () => [], listClaims: () => [], releaseClaim: () => {}, listRunStoreInFlight: () => [], listSettledBuilds: () => [],
      killSwitch: () => ({ engaged: false }),
      releaseDuePrepareRetries: () => ['4688', '4701'],
      listHolds: () => [{ num: '4688', reason: 'operator' }, { num: '4701', reason: 'prepare-unstamped' }],
      releasePrepareHold,
    };
    try {
      await runBuildDispatchTick({ live: true, effects });
      expect(releasePrepareHold.mock.calls.map(([o]) => o.num)).toEqual(['4701']);
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });

  it('re-arm keeps the hold while another unresolved held failure remains on the card', () => {
    seed({
      a: { num: '7', attempt: '2026-10-06T17:56:00.000Z', cause: 'unknown', evidence: { reason: NOT_CONFIRMED }, held: true },
      b: { num: '7', attempt: '2026-10-06T17:57:00.000Z', cause: 'unknown', evidence: { reason: 'wrapper-failed' }, held: true },
      c: { num: '8', attempt: '2026-10-06T17:56:00.000Z', cause: 'unknown', evidence: { reason: NOT_CONFIRMED }, held: true },
    });
    expect(rearmFalseHolds({ path, dryRun: true })).toEqual({ count: 2, nums: ['8'] });
    expect(rearmFalseHolds({ path })).toEqual({ count: 2, nums: ['8'] });
    const after = readFailureState(path).failures;
    expect([after.a.held, after.b.held, after.c.held]).toEqual([false, true, false]);
  });

  it('re-arm refuses an unparseable --before instead of widening to every held failure', () => {
    seed({ a: { num: '1', attempt: 'x', recordedAt: '2026-10-07T01:00:00.000Z', cause: 'dispatch-transient', evidence: { reason: NOT_CONFIRMED }, held: true } });
    for (const before of ['2026-10-0', 'yesterday', '', null]) expect(() => rearmFalseHolds({ path, before })).toThrow(/--before/);
    expect(readFailureState(path).failures.a.held).toBe(true);
  });

  it('re-arming an exhausted failure restarts its backoff budget, and the default re-arm reaches it', async () => {
    await rec('a', 0); releaseDuePrepareRetries({ path, now: 1000 });
    await rec('b', 1000); releaseDuePrepareRetries({ path, now: 3000 });
    expect(await rec('c', 3000)).toMatchObject({ attempts: 3, exhausted: true });
    // `recordedAt` is long after the #4148 cutoff: the default re-arm must still clear an EXHAUSTED hold.
    const r = rearmFalseHolds({ path, now: 4000 });
    expect(r.nums).toEqual(['5188']);
    expect(Object.values(readFailureState(path).failures).filter(f => f.held)).toEqual([]);
    expect(await rec('d', 5000)).toMatchObject({ attempts: 1, exhausted: false, retryAfter: new Date(6000).toISOString() });
  });

  it('a non-exhausted post-fix hold is still skipped by the default re-arm', async () => {
    await rec('a', Date.parse('2026-10-07T02:00:00Z'));
    expect(rearmFalseHolds({ path }).count).toBe(0);
  });

  it('only a dispatch-stage failure is a transient; a stamp-stage "Command failed" stays unknown with a diagnose card', async () => {
    const e = { reason: 'Command failed: git commit -m x' };
    expect(classifyPrepareFailure(e, 'dispatch')).toBe('dispatch-transient');
    for (const stage of ['stamp', 'stamp-read', 'result', 'retirement', 'claim', 'dispatch-refused']) {
      expect(classifyPrepareFailure(e, stage)).toBe('unknown');
    }
    fileCard.mockResolvedValue({ ok: true });
    const f = await recordPrepareFailure({ num: '9', attempt: 'a', stage: 'stamp', evidence: e }, { path, fileCard, now: 0, settings: S });
    expect(f).toMatchObject({ cause: 'unknown', held: true });
    expect(fileCard).toHaveBeenCalledTimes(1);
  });

  it('one helper names the reason code: `reason` first, `error` only when there is no reason', async () => {
    expect(evidenceReasonCode({ error: 'wrapper-failed', reason: NOT_CONFIRMED })).toBe('launch-not-confirmed');
    expect(evidenceReasonCode({ error: NOT_CONFIRMED })).toBe('launch-not-confirmed');
    expect(evidenceReasonCode({ error: 'launch-died: x', reason: 'wrapper-failed' })).toBeNull();
    expect(evidenceReasonCode({})).toBeNull();
    // classification, the stored reason code and the re-arm all agree, for both a coded and an un-coded `reason`.
    const coded = { error: 'raw child output', reason: NOT_CONFIRMED };
    expect(classifyPrepareFailure(coded, 'dispatch')).toBe('dispatch-transient');
    const f = await recordPrepareFailure({ num: '5188', attempt: 'a', stage: 'dispatch', evidence: coded }, { path, fileCard, now: 0, settings: S });
    expect(f.reasonCode).toBe('launch-not-confirmed');
    expect(rearmFalseHolds({ path, before: '1969-12-31', dryRun: true }).count).toBe(0); // recorded at epoch 0, after that cutoff: spared
    const uncoded = { error: NOT_CONFIRMED, reason: 'dispatch wrapper said no' };
    expect(classifyPrepareFailure(uncoded, 'dispatch')).toBe('unknown');
  });

  it('re-arm does not match a result-stage hold whose agent output merely QUOTES a known failure', () => {
    seed({
      q: { num: '95', attempt: '2026-10-06T17:56:00.000Z', stage: 'result', cause: 'unknown', evidence: { reason: 'prepare-unstamped', error: `quoting: ${NOT_CONFIRMED}` }, held: true },
      s: { num: '96', attempt: '2026-10-06T17:56:00.000Z', stage: 'stamp', cause: 'unknown', evidence: { reason: 'Command failed: git commit' }, held: true },
    });
    expect(rearmFalseHolds({ path, codes: ['launch-not-confirmed', 'dispatch-command-failed'] })).toEqual({ count: 0, nums: [] });
  });

  it('re-arm refuses a future, non-ISO or unknown-code scope', () => {
    seed({ a: { num: '1', attempt: 'x', recordedAt: '2026-10-07T01:00:00.000Z', cause: 'dispatch-transient', evidence: { reason: NOT_CONFIRMED }, held: true } });
    for (const before of ['1', 'Oct 7', '2999-01-01', '2999-10-07T00:00:00Z']) expect(() => rearmFalseHolds({ path, before })).toThrow(/--before/);
    for (const codes of [['typo'], [], ['launch-not-confirmed', 'nope']]) expect(() => rearmFalseHolds({ path, codes })).toThrow(/--codes/);
    expect(readFailureState(path).failures.a.held).toBe(true);
  });

  it('a budget reset does not relabel a still-held sibling as re-armed', () => {
    seed({
      a: { num: '7', attempt: '2026-10-06T17:56:00.000Z', stage: 'dispatch', cause: 'dispatch-transient', evidence: { reason: NOT_CONFIRMED }, held: true },
      b: { num: '7', attempt: 'b', stage: 'dispatch', cause: 'dispatch-transient', evidence: { reason: 'launch-died: x' }, held: true, recordedAt: '2026-10-07T01:00:00.000Z' },
    });
    rearmFalseHolds({ path });
    const f = readFailureState(path).failures;
    expect(f.a.rearmedAt).toBeTruthy();
    expect(f.b.rearmedAt).toBeUndefined();
    expect(f.b.budgetResetAt).toBeTruthy();
    expect(f.b.held).toBe(true);
  });

  it('a re-arm written while recordPrepareFailure awaits its diagnose card is not overwritten', async () => {
    seed({ old: { num: '7', attempt: '2026-10-06T17:56:00.000Z', stage: 'dispatch', cause: 'dispatch-transient', evidence: { reason: NOT_CONFIRMED }, held: true } });
    const slowCard = vi.fn(async () => { rearmFalseHolds({ path }); return { ok: true }; });
    await recordPrepareFailure({ num: '9', attempt: 'a', stage: 'stamp', evidence: { reason: 'weird' } }, { path, fileCard: slowCard, now: 0, settings: S });
    const f = readFailureState(path).failures;
    expect(f.old.held).toBe(false);
    expect(Object.values(f).find(x => x.num === '9')).toMatchObject({ cause: 'unknown', held: true });
  });

  it('the prepare ledger stores redacted evidence and signature, owner-only', async () => {
    const tok = 'ghp_' + 'b'.repeat(30);
    await recordPrepareFailure({ num: '9', attempt: 'a', stage: 'stamp', evidence: { reason: `Command failed: claude --settings {"env":{"GH_TOKEN":"${tok}"}}`, sessionAbsent: false } },
      { path, fileCard: vi.fn().mockResolvedValue({ ok: true }), now: 0, settings: S });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(tok);
    expect(JSON.parse(raw).failures['9:a:stamp'].evidence.sessionAbsent).toBe(false);
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('the release helper keeps a card that has ANY non-prepare hold, in either order, and never lifts stamp-pending', () => {
    const release = vi.fn();
    const holds = [
      { num: '1', reason: 'operator' }, { num: '1', reason: 'prepare-unstamped' },
      { num: '2', reason: 'prepare-unstamped' }, { num: '2', reason: 'operator' },
      { num: '3', reason: 'prepare-stamp-pending' }, { num: '4', reason: 'prepare-unstamped' },
    ];
    const out = releaseOwnPrepareHolds({ nums: ['1', '2', '3', '4'], holds, release });
    expect(out).toEqual({ released: ['4'], kept: ['1', '2', '3'] });
    expect(release.mock.calls.map(([o]) => o.num)).toEqual(['4']);
  });

  it('the build ledger redacts secrets before it cuts, and writes owner-only', () => {
    const p = join(dir, 'b.json');
    const tok = 'ghp_' + 'a'.repeat(30);
    const r = recordBuildFailure({ num: '4688', reason: `launch-died: GH_TOKEN=${tok}`,
      output: `${'x'.repeat(1990)} token=${tok} Bearer abcdefghijkl1234` }, { path: p, now: 0, settings: S });
    expect(readFileSync(p, 'utf8')).not.toContain(tok);
    expect(JSON.stringify(r)).not.toContain(tok);
    expect(r.output).not.toMatch(/abcdefghijkl1234/);
    expect(statSync(p).mode & 0o077).toBe(0);
    expect(r.reasonCode).toBe('launch-died');
  });
});

describe('builder-starved — clone-wide refusals and stale holds self-heal (2026-10-07)', () => {
  let dir, path, bpath, fileCard;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'starved-')); path = join(dir, 'f.json'); bpath = join(dir, 'b.json'); fileCard = vi.fn(async () => ({ ok: true })); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const BEHIND = 'launch-died: dispatch-lane exited with no output (dispatch-lane: the dispatching checkout is 3 commit(s) behind origin/main — refusing to dispatch a review that would run STALE code';

  it('a stale-clone build refusal is never charged to the card (4701 exhausted on seven of them overnight)', () => {
    for (let i = 0; i < 8; i += 1) {
      const r = recordBuildFailure({ num: '4701', reason: BEHIND, output: BEHIND }, { path: bpath, now: i * 1000, settings: S });
      expect(r).toMatchObject({ reasonCode: 'checkout-behind-origin', cloneWide: true, attempts: 0, exhausted: false });
    }
    expect(listBuildBackoffs({ path: bpath, now: 9000 })).toEqual([]);
  });

  it('an exhausted stale-clone build record written by older code no longer withholds the card', () => {
    writeFileSync(bpath, JSON.stringify({ items: { 4701: { num: '4701', attempts: 7, reasonCode: 'checkout-behind-origin', exhausted: true, retryAfter: null } } }));
    expect(listBuildBackoffs({ path: bpath, now: 0 })).toEqual([]);
  });

  it('a stale-clone prepare dispatch refusal never holds the card or enters the ledger', async () => {
    const f = await recordPrepareFailure({ num: '4425', attempt: 'a', stage: 'dispatch', evidence: { reason: BEHIND } }, { path, fileCard, now: 0, settings: S });
    expect(f).toMatchObject({ cause: 'clone-wide', held: false, retry: true });
    expect(fileCard).not.toHaveBeenCalled();
    expect(Object.keys(readFailureState(path).failures)).toEqual([]);
  });

  it('held dispatch failures the current policy would not hold are released by the per-tick release (no re-arm)', () => {
    // Written by pre-item-95 code: cause `unknown`, held forever, a diagnose card queued.
    writeFileSync(path, JSON.stringify({ cards: {}, failures: {
      'a': { num: '4425', attempt: 'a', stage: 'dispatch', cause: 'unknown', held: true, retry: false, evidence: { reason: BEHIND }, recordedAt: new Date(0).toISOString() },
      'b': { num: '4382', attempt: 'b', stage: 'dispatch', cause: 'unknown', held: true, retry: false, evidence: { reason: 'Command failed: node run.mjs dispatch-lane --num=4382' }, recordedAt: new Date(0).toISOString() },
      'c': { num: '4560', attempt: 'c', stage: 'result', cause: 'unknown', held: true, retry: false, evidence: { reason: 'prepare-unstamped' }, recordedAt: new Date(0).toISOString() },
    } }));
    const due = releaseDuePrepareRetries({ path, now: 10_000, settings: S });
    expect(due.sort()).toEqual(['4382', '4425']);
    const st = readFailureState(path).failures;
    expect(st.a).toMatchObject({ held: false, cause: 'clone-wide', healedFrom: 'unknown' });
    expect(st.b).toMatchObject({ held: false, cause: 'dispatch-transient', healedFrom: 'unknown', reasonCode: 'dispatch-command-failed' });
    expect(st.c).toMatchObject({ held: true, cause: 'unknown' }); // a result-stage failure keeps its diagnose hold
  });
});

describe('a late launch (effect-in-flight) retries quickly, not on the failure path (live #4647)', () => {
  const IN_FLIGHT = `${NOT_CONFIRMED} [stdout: { "op": "dispatch-lane", "stopped": "effect-in-flight" }]`;
  const DEFAULTS = readBackoffSettings({});
  it('has its own reason code, ahead of launch-not-confirmed; a plain not-confirmed keeps its code', () => {
    expect(reasonCodeOf(IN_FLIGHT)).toBe('launch-in-flight');
    expect(reasonCodeOf(NOT_CONFIRMED)).toBe('launch-not-confirmed');
  });
  it('waits 30s doubling to 2min with the default settings, and a real failure still waits 5min', () => {
    const now = Date.parse('2026-10-07T20:00:00Z');
    const at = (code, attempts) => Date.parse(backoffVerdict({ attempts, now, settings: DEFAULTS, code }).retryAfter) - now;
    expect([1, 2, 3, 4].map((n) => at('launch-in-flight', n))).toEqual([30_000, 60_000, 120_000, 120_000]);
    expect(at('launch-not-confirmed', 1)).toBe(5 * 60_000);
  });
  it('stays bounded by the same attempt cap', () => {
    expect(backoffVerdict({ attempts: DEFAULTS.maxAttempts, settings: DEFAULTS, code: 'launch-in-flight' })).toEqual({ retryAfter: null, exhausted: true });
  });
  it('a prepare failure with that evidence is held for a short retry and released on the next tick after it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quick-retry-'));
    try {
      const path = join(dir, 'failures.json');
      const now = Date.parse('2026-10-07T20:00:00Z');
      const f = await recordPrepareFailure({ num: '4647', attempt: 'a1', stage: 'dispatch', evidence: { reason: IN_FLIGHT } }, { path, fileCard: vi.fn(), now, settings: DEFAULTS });
      expect(f).toMatchObject({ cause: 'dispatch-transient', reasonCode: 'launch-in-flight', held: true });
      expect(Date.parse(f.retryAfter) - now).toBe(30_000);
      expect(releaseDuePrepareRetries({ path, now: now + 29_000, settings: DEFAULTS })).toEqual([]);
      expect(releaseDuePrepareRetries({ path, now: now + 31_000, settings: DEFAULTS })).toEqual(['4647']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
