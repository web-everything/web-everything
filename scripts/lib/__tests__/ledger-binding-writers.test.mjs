/**
 * Slice 2 of the #5492 rebuild (design v2 W1/W2): writers stamp the judged head, the judgment boundary (`seen`) and the
 * run id. Pins: the additive schema (old readers still read every new row), the boundary helper, the review-set-label
 * pin (B2: a clearing verdict never lands on a head its judge did not see), the CI request transport (B2), the send-back
 * heads, and the review-pr reconcile deduping by run id (#5492 finding 3). Each binding case is checked end to end
 * through `ledgerAt`, the fold the shadow slice will compare against.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVerdictRecord, buildLedgerEvent, validateLedgerEvent, parseLedgerEvents, parseVerdictLog, serializeLedgerEvent,
  foldVerdictLedger, readVerdictLedger, appendVerdict, EVENT_TYPES, VERDICTS,
} from '../verdict-ledger.mjs';
import { ledgerAt, rowIdentity } from '../ledger-binding.mjs';
import { ledgerBoundary, readLedgerBoundary, prRowsOf } from '../ledger-boundary.mjs';
import { derivePrState } from '../pr-state.mjs';
import { runReviewLabelCli } from '../../review-set-label.mjs';
import { validateRequest, buildLabelArgv } from '../../apply-review-request.mjs';
import { buildSendBackArgv } from '../../operations/red-team-gate-apply.mjs';
import { createReviewPrSinks, isPreWriteRefusal } from '../../operations/review-pr-io.mjs';
import { REVIEW_EFFECTS } from '../../operations/review-pr.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const AT = '2026-10-21T12:00:00.000Z';
const NOW = '2026-10-21T13:00:00.000Z';
const base = { repo: 'o/n', pr: 7, at: AT, source: 'test' };
/** Serialize then re-parse: exactly what today's git/home readers see. */
const roundTrip = (rows) => parseLedgerEvents(rows.map((r) => {
  const s = serializeLedgerEvent(r);
  if (!s.ok) throw new Error(s.errors.join('; '));
  return s.line;
}).join('\n'));

describe('schema: the binding fields are additive and survive a round trip', () => {
  it('a verdict keeps judgedHead, seen and runId; a bad one is refused at build', () => {
    const v = buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, judgedHead: A, seen: 'empty', runId: 'run-1' });
    expect(roundTrip([v])[0]).toMatchObject({ judgedHead: A, seen: 'empty', runId: 'run-1', coverage: { headSha: A } });
    expect(() => buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, judgedHead: A.slice(0, 7) })).toThrow(/judgedHead/);
    expect(() => buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, seen: 'garbage' })).toThrow(/seen/);
    expect(() => buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, runId: 'bad id!' })).toThrow(/runId/);
  });
  it('approval and send-back carry the pin in judgedHead (never headSha); a short pin is refused', () => {
    const ap = buildLedgerEvent({ ...base, type: EVENT_TYPES.APPROVAL, approval: 'clear-human', judgedHead: A, seen: 'empty' });
    const sb = buildLedgerEvent({ ...base, type: EVENT_TYPES.SEND_BACK, cause: 'changes', judgedHead: A });
    const [ra, rs] = roundTrip([ap, sb]);
    expect([ra, rs]).toMatchObject([{ judgedHead: A, seen: 'empty' }, { judgedHead: A }]);
    expect(ra.headSha === undefined && rs.headSha === undefined).toBe(true);
    expect(() => buildLedgerEvent({ ...base, type: EVENT_TYPES.SEND_BACK, cause: 'changes', judgedHead: A.slice(0, 7) })).toThrow();
  });
  it('a malformed binding field on a stored row never makes today\'s parser drop the row (a hold is never lost)', () => {
    const sb = { ...buildLedgerEvent({ ...base, type: EVENT_TYPES.SEND_BACK, cause: 'changes' }), judgedHead: 'bad', seen: 42 };
    const [kept] = parseLedgerEvents(JSON.stringify(sb));
    expect(kept).toMatchObject({ type: 'send-back', judgedHead: 'bad' });
    const facts = { pr: 7, repo: 'o/n', head: { sha: A }, now: NOW, state: 'OPEN' };
    const rows = parseLedgerEvents([JSON.stringify(buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A })), JSON.stringify(sb)].join('\n'));
    expect(derivePrState(rows, facts).holds.map((h) => h.code)).toContain('send-back');
  });
  it('referral and review-run carry seen and runId', () => {
    const rr = buildLedgerEvent({ ...base, type: EVENT_TYPES.REVIEW_RUN, headSha: A, phase: 'completed', posted: true, seen: 'empty', runId: 'run-1' });
    expect(roundTrip([rr])[0]).toMatchObject({ seen: 'empty', runId: 'run-1' });
  });
  it('legacy rows are unchanged: no binding field appears on a row built without one', () => {
    const v = buildVerdictRecord({ ...base, verdict: VERDICTS.CHANGES });
    const ap = buildLedgerEvent({ ...base, type: EVENT_TYPES.APPROVAL, approval: 'clear-human' });
    const [rv, ra] = roundTrip([v, ap]);
    expect('seen' in rv || 'runId' in rv).toBe(false);
    expect(ra.headSha === undefined && ra.seen === undefined).toBe(true);
  });
  it("today's readers read new rows exactly as before: v1 reader, fold, and pr-state derive", () => {
    const legacy = [buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A })];
    const bound = [buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, seen: 'empty', runId: 'r' })];
    const v1 = parseVerdictLog(serializeLedgerEvent(bound[0]).line);
    expect(v1).toHaveLength(1);
    const strip = (m) => [...m.values()].map(({ current, clears }) => ({ verdict: current?.verdict, clears }));
    expect(strip(foldVerdictLedger(roundTrip(bound)))).toEqual(strip(foldVerdictLedger(roundTrip(legacy))));
    const facts = { pr: 7, repo: 'o/n', head: { sha: A }, now: NOW, state: 'OPEN' };
    const pick = (r) => ({ clears: r.clears, verdict: r.verdict, holds: r.holds.map((h) => h.code) });
    expect(pick(derivePrState(roundTrip(bound), facts))).toEqual(pick(derivePrState(roundTrip(legacy), facts)));
    // A bound approval and send-back validate, so pr-state never calls the ledger unreadable because of them.
    const ap = buildLedgerEvent({ ...base, type: EVENT_TYPES.APPROVAL, approval: 'clear-human', judgedHead: A, seen: 'empty' });
    expect(validateLedgerEvent(JSON.parse(serializeLedgerEvent(ap).line)).valid).toBe(true);
  });
  // Audit (slice 2, P1): today's send-back hold infers the sent-back head from EARLIER rows' heads, so a new value in
  // `headSha` would change its answer. Every pin lives in `judgedHead`; stripping the new fields must never change
  // what today's derive returns, on interacting histories too.
  it("stripping the binding fields never changes today's derive (interacting approval/send-back/verdict histories)", () => {
    const strip = (r) => { const c = { ...r }; for (const k of ['judgedHead', 'seen', 'runId']) delete c[k]; return c; };
    const V = (verdict, head, judged, extra = {}) => buildVerdictRecord({ ...base, verdict, headSha: head, judgedHead: judged, seen: judged ? 'empty' : null, ...extra });
    const E = (type, judged, extra) => buildLedgerEvent({ ...base, type, ...(judged ? { judgedHead: judged } : {}), ...extra });
    const histories = [
      [V(VERDICTS.CLEAR_HUMAN, B, B), V(VERDICTS.ACCEPTED, A, A), E(EVENT_TYPES.APPROVAL, B, { approval: 'clear-human' }), E(EVENT_TYPES.SEND_BACK, B, { cause: 'changes' }), V(VERDICTS.ACCEPTED, A, A)],
      [V(VERDICTS.CHANGES, A, B), E(EVENT_TYPES.SEND_BACK, B, { cause: 'changes' }), V(VERDICTS.ACCEPTED, A, A)],
      [V(VERDICTS.HUMAN, A, A), E(EVENT_TYPES.APPROVAL, A, { approval: 'clear-human' }), V(VERDICTS.CLEAR_HUMAN, A, A)],
      [V(VERDICTS.ACCEPTED, A, A, { runId: 'r1' }), V(VERDICTS.ACCEPTED, A, A, { runId: 'r1', source: 'operation-reconcile' })],
    ];
    for (const live of [A, B]) {
      const facts = { pr: 7, repo: 'o/n', head: { sha: live }, now: NOW, state: 'OPEN' };
      const pick = (r) => JSON.stringify({ clears: r.clears, verdict: r.verdict, holds: r.holds.map((h) => h.code) });
      for (const h of histories) expect(pick(derivePrState(roundTrip(h), facts))).toBe(pick(derivePrState(roundTrip(h.map(strip)), facts)));
    }
  });
});

describe('the judgment boundary', () => {
  it('is "empty" for no rows and "<n>:<id>" of the last row of this PR otherwise', () => {
    expect(ledgerBoundary([])).toBe('empty');
    const rows = roundTrip([{ ...buildVerdictRecord({ ...base, verdict: VERDICTS.CHANGES, headSha: A }), id: 'row-00001' },
      { ...buildVerdictRecord({ ...base, pr: 8, verdict: VERDICTS.CHANGES }), id: 'row-00002' }]);
    expect(ledgerBoundary(prRowsOf(rows, 7))).toBe('1:row-00001');
    expect(ledgerBoundary(null)).toBe(null);
  });
  it('reads the git store; an unreadable store gives null (the row is then unbounded, which answers nothing)', () => {
    const line = JSON.stringify({ ...buildVerdictRecord({ ...base, verdict: VERDICTS.CHANGES, headSha: A }), id: 'row-00001' });
    expect(readLedgerBoundary({ repo: 'o/n', pr: 7, board: '/x', readGit: () => ({ status: 'ok', text: line }) })).toBe('1:row-00001');
    expect(readLedgerBoundary({ repo: 'o/n', pr: 7, board: '/x', readGit: () => ({ status: 'unreadable' }) })).toBe(null);
    expect(readLedgerBoundary({ repo: 'o/n', pr: 7, board: '/x', readGit: () => { throw new Error('boom'); } })).toBe(null);
  });
  it('a boundary taken before a hold does not answer it; one taken after does (end to end through ledgerAt)', () => {
    const hold = { ...buildVerdictRecord({ ...base, verdict: VERDICTS.CHANGES, headSha: A }), id: 'row-00001' };
    const before = ledgerBoundary([]);
    const after = ledgerBoundary(roundTrip([hold]));
    const accept = (seen) => ({ ...buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, seen }), id: 'row-00002' });
    expect(ledgerAt(roundTrip([hold, accept(before)]), A, { now: NOW }).clears).toBe(false);
    expect(ledgerAt(roundTrip([hold, accept(after)]), A, { now: NOW }).clears).toBe(true);
    expect(rowIdentity(roundTrip([hold])[0])).toBe('row-00001');
  });
  it('the fold binds a row to its judgedHead, not to the live head today\'s field records', () => {
    const rows = roundTrip([{ ...buildVerdictRecord({ ...base, verdict: VERDICTS.CHANGES, headSha: A, judgedHead: B, seen: 'empty' }), id: 'row-00001' },
      { ...buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, judgedHead: A, seen: 'empty' }), id: 'row-00002' }]);
    expect(ledgerAt(rows, A, { now: NOW }).clears).toBe(true); // the bounce judged B, so it holds B only
    expect(ledgerAt(rows, B, { now: NOW }).holds.map((h) => h.code)).toContain('verdict:changes');
  });
});

describe('review-set-label pins the judged head (W1, Codex B2)', () => {
  const CFG = { defaultActor: 'test', usage: 'usage: test', buildComment: () => '# verdict body',
    successResult: (o) => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }) };
  let dir; const saved = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lbw-'));
    for (const k of ['WE_VERDICT_LEDGER_DIR', 'WE_VERDICT_LEDGER_STORE', 'WE_VERDICT_LEDGER_BOARD']) saved[k] = process.env[k];
    process.env.WE_VERDICT_LEDGER_DIR = dir;
    delete process.env.WE_VERDICT_LEDGER_STORE; delete process.env.WE_VERDICT_LEDGER_BOARD;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}-locks`, { recursive: true, force: true });
  });
  const provider = (labels, live = A) => {
    const calls = [];
    return { calls, name: 'stub', currentRepo: () => 'o/n',
      readPrState: () => ({ labels: labels.map((name) => ({ name })), comments: [], headRefOid: live, headRefName: 'lane/x', state: 'OPEN', body: '' }),
      readLabels: () => labels.map((name) => ({ name })),
      setLabels: () => { calls.push('setLabels'); }, postComment: () => { calls.push('postComment'); } };
  };
  function run(p, argv) {
    const chunks = []; const realExit = process.exit.bind(process); const realErr = process.stderr.write.bind(process.stderr);
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    process.stderr.write = () => true;
    let exitCode = 0;
    try { runReviewLabelCli({ ...CFG, emit: (l) => chunks.push(String(l)), provider: p, argv, verdictBody: 'prose verdict' }); }
    catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    finally { process.exit = realExit; process.stderr.write = realErr; }
    return { exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  }

  it('B2: an accept judged at B refuses before any write when the live head is A', () => {
    const p = provider(['review:pending']);
    const { exitCode, payload } = run(p, ['7', '--repo=o/n', '--to=accepted', '--actor=op', `--judged-head=${B}`]);
    expect(exitCode).toBe(1);
    expect(payload.error).toMatch(/live head differs from --judged-head/);
    expect(isPreWriteRefusal(payload.error)).toBe(true);
    expect(p.calls).toEqual([]);
    expect(readVerdictLedger('o/n')).toHaveLength(0);
  });
  // (A successful accept also reads the net diff and the referral thread live, which the test harness forbids; the
  // stamping is the same code for every target, so a bounce pins it and the refusal above pins the accept gate.)
  it('a pinned verdict stamps the judged head, seen and run id', () => {
    const { exitCode, payload } = run(provider([]), ['7', '--repo=o/n', '--to=changes', '--actor=op', '--reason=found a bug', `--judged-head=${A}`, '--seen=empty', '--run-id=run-9']);
    expect(exitCode, JSON.stringify(payload)).toBe(0);
    expect(readVerdictLedger('o/n')[0]).toMatchObject({ verdict: 'changes', coverage: { headSha: A }, judgedHead: A, seen: 'empty', runId: 'run-9' });
  });
  it('a pinned HOLD still swaps its label on a moved head; today\'s field keeps the live head, the pin names the judged one', () => {
    const p = provider([], A);
    const { exitCode } = run(p, ['7', '--repo=o/n', '--to=changes', '--actor=op', `--judged-head=${B}`, '--reason=found a bug']);
    expect(exitCode).toBe(0);
    expect(p.calls).toContain('setLabels');
    expect(readVerdictLedger('o/n')[0]).toMatchObject({ verdict: 'changes', coverage: { headSha: A }, judgedHead: B });
  });
  it('malformed binding flags refuse a CLEARING verdict before any write', () => {
    for (const bad of [['--judged-head=abc'], [`--judged-head=${A}`, '--seen=nope'], ['--run-id=a b']]) {
      const p = provider(['review:pending']);
      const { exitCode, payload } = run(p, ['7', '--repo=o/n', '--to=accepted', '--actor=op', ...bad]);
      expect(exitCode).not.toBe(0);
      expect(isPreWriteRefusal(payload.error)).toBe(true);
      expect(p.calls).toEqual([]);
    }
  });
  it('malformed binding flags never drop a HOLD: the bounce still lands, written without them', () => {
    const p = provider([]);
    const { exitCode } = run(p, ['7', '--repo=o/n', '--to=changes', '--actor=op', '--reason=bug', '--judged-head=abc', '--seen=nope', '--run-id=a b']);
    expect(exitCode).toBe(0);
    expect(p.calls).toContain('setLabels');
    const row = readVerdictLedger('o/n')[0];
    expect(row.verdict).toBe('changes');
    expect('judgedHead' in row || 'seen' in row || 'runId' in row).toBe(false);
  });
  // The accept-side pin (success, and a push between the two reads) runs against real git in review-set-label.test.mjs.
  it('--seen without --judged-head is not stamped (an unpinned row must not answer anything)', () => {
    run(provider([]), ['7', '--repo=o/n', '--to=changes', '--actor=op', '--reason=bug', '--seen=empty']);
    expect('seen' in readVerdictLedger('o/n')[0]).toBe(false);
  });
  it('an unpinned verdict is written exactly as before (legacy: no seen, no runId, live head)', () => {
    run(provider([]), ['7', '--repo=o/n', '--to=changes', '--actor=op', '--reason=found a bug']);
    const row = readVerdictLedger('o/n')[0];
    expect(row.coverage.headSha).toBe(A);
    expect('seen' in row || 'runId' in row).toBe(false);
  });
});

describe('the CI request path carries the judged head end to end (Codex B2)', () => {
  const req = { repo: 'o/n', pr: 7, to: 'accepted', actor: 'op' };
  it('validates and forwards judgedHead and seen to the single home', () => {
    const v = validateRequest({ ...req, judgedHead: A, seen: '3:row-00003' });
    expect(v.ok).toBe(true);
    const argv = buildLabelArgv(v.request, null);
    expect(argv).toContain(`--judged-head=${A}`);
    expect(argv).toContain('--seen=3:row-00003');
  });
  it('refuses a malformed pin on a clearing request, drops it from a holding one', () => {
    expect(validateRequest({ ...req, judgedHead: A.slice(0, 7) }).ok).toBe(false);
    expect(validateRequest({ ...req, judgedHead: A, seen: 'x' }).ok).toBe(false);
    const hold = validateRequest({ ...req, to: 'changes', body: 'bug', judgedHead: 'x', runId: 'a b' });
    expect(hold.ok).toBe(true);
    expect(buildLabelArgv(hold.request, null).some((a) => /^--(judged-head|seen|run-id)=/.test(a))).toBe(false);
  });
  it('forwards the run id, and drops seen when no head is pinned', () => {
    const v = validateRequest({ ...req, seen: 'empty', runId: 'run-3' });
    const argv = buildLabelArgv(v.request, null);
    expect(argv).toContain('--run-id=run-3');
    expect(argv.some((a) => a.startsWith('--seen='))).toBe(false);
  });
  it('an unpinned request still applies (producers migrate first); its argv names no head', () => {
    const v = validateRequest(req);
    expect(v.ok).toBe(true);
    expect(buildLabelArgv(v.request, null).some((a) => a.startsWith('--judged-head'))).toBe(false);
  });
});

describe('send-back writers name the head they sent back', () => {
  it('red-team gate pins its --to=changes call to the head it judged', () => {
    expect(buildSendBackArgv({ repo: 'o/n', pr: 7, bodyPath: '/x', head: A })).toContain(`--judged-head=${A}`);
    expect(buildSendBackArgv({ repo: 'o/n', pr: 7, bodyPath: '/x' }).some((a) => a.startsWith('--judged-head'))).toBe(false);
  });
});

describe("review-pr reconcile: today's write decision, rows stamped with the run id and judged head", () => {
  let dir, root; const saved = {};
  const CTX = { key: 'run-2#4#1', runId: 'run-2', type: 'x', stepIndex: 4, step: 'record', index: 1 };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lbw-r-')); root = mkdtempSync(join(tmpdir(), 'lbw-root-'));
    for (const k of ['WE_VERDICT_LEDGER_DIR', 'WE_VERDICT_LEDGER_STORE']) saved[k] = process.env[k];
    process.env.WE_VERDICT_LEDGER_DIR = dir; delete process.env.WE_VERDICT_LEDGER_STORE;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}-locks`, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  });
  const payload = { pr: 7, repo: 'o/n', to: 'accepted', actor: 'op', lens: 'correctness', findings: [], netBasis: { rev: A }, seen: 'empty' };

  it('a missed single-home write is recovered with the run id and judged head (today\'s head field stays headless)', async () => {
    appendVerdict(buildVerdictRecord({ ...base, verdict: VERDICTS.CHANGES, headSha: A, source: 'review-set-label', runId: 'run-1' }));
    const r = await createReviewPrSinks({ root })[REVIEW_EFFECTS.LEDGER](payload, CTX);
    expect(r.reconciled).toBe(false);
    const row = readVerdictLedger('o/n').at(-1);
    expect(row).toMatchObject({ runId: 'run-2', judgedHead: A, source: 'operation-reconcile' });
    expect(row.coverage.headSha).toBe(null);
    expect('seen' in row).toBe(false); // review-pr stamps no boundary until its judges are shown the ledger's questions
  });
  it("the write DECISION is today's: a later different verdict from another run still gets this run's row (audit P1)", async () => {
    appendVerdict(buildVerdictRecord({ ...base, verdict: VERDICTS.CHANGES, headSha: A, judgedHead: A, source: 'review-set-label', runId: 'run-2' }));
    appendVerdict(buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, judgedHead: A, source: 'review-set-label', runId: 'run-3' }));
    const r = await createReviewPrSinks({ root })[REVIEW_EFFECTS.LEDGER]({ ...payload, to: 'changes' }, CTX);
    expect(r.reconciled).toBe(false);
    expect(readVerdictLedger('o/n').map((x) => x.verdict)).toEqual(['changes', 'accepted', 'changes']);
  });
  it("the same verdict already live is reconciled, never written twice (today's rule)", async () => {
    appendVerdict(buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, judgedHead: A, source: 'review-set-label', runId: 'run-2' }));
    const sinks = createReviewPrSinks({ root });
    expect((await sinks[REVIEW_EFFECTS.LEDGER](payload, CTX)).reconciled).toBe(true);
    expect(readVerdictLedger('o/n')).toHaveLength(1);
  });
  it('equal verdict from a DIFFERENT run still skips (today\'s rule; the residual is fail-closed: this run has no answer row)', async () => {
    appendVerdict(buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, judgedHead: A, source: 'review-set-label', runId: 'run-1' }));
    expect((await createReviewPrSinks({ root })[REVIEW_EFFECTS.LEDGER](payload, CTX)).reconciled).toBe(true);
    expect(readVerdictLedger('o/n')).toHaveLength(1);
  });
  it('a row of this run with a DIFFERENT judgment is not reconciled: ours is appended and the fold holds on the conflict', async () => {
    appendVerdict(buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, judgedHead: A, source: 'review-set-label', runId: 'run-2' }));
    const r = await createReviewPrSinks({ root })[REVIEW_EFFECTS.LEDGER]({ ...payload, to: 'changes' }, CTX);
    expect(r.reconciled).toBe(false);
    const rows = readVerdictLedger('o/n').map((x, i) => ({ type: 'verdict', ...x, id: `row-0000${i + 1}` }));
    expect(rows.map((x) => x.verdict)).toEqual(['accepted', 'changes']);
    expect(ledgerAt(rows, A, { now: NOW }).holds.map((h) => h.code)).toContain('run-conflict');
  });
  it('a reconcile row and the single-home row of the same judgment are one judgment to the fold (no run-conflict)', async () => {
    // The single home's row landed in git but not home (so the sink cannot see it) — the sink then writes its own.
    const r = await createReviewPrSinks({ root })[REVIEW_EFFECTS.LEDGER](payload, CTX);
    expect(r.reconciled).toBe(false);
    const sinkRow = readVerdictLedger('o/n')[0];
    const homeRow = buildVerdictRecord({ ...base, verdict: VERDICTS.ACCEPTED, headSha: A, judgedHead: A, source: 'review-set-label', runId: 'run-2' });
    const rows = roundTrip([{ ...homeRow, id: 'row-00001' }, { ...sinkRow, id: 'row-00002' }]);
    expect(ledgerAt(rows, A, { now: NOW })).toMatchObject({ clears: true });
  });
  it('the label sink forwards the judged head, the boundary and the run id', async () => {
    const seen = [];
    const sinks = createReviewPrSinks({ root, runNode: (argv) => { seen.push(argv); return '{"ok":true}'; },
      readPublishHead: ({ expectedHead }) => expectedHead, publishGate: ({ expectedHead }) => ({ headSha: expectedHead, checks: [] }) });
    await sinks[REVIEW_EFFECTS.LABEL]({ pr: 7, repo: 'o/n', to: 'accepted', actor: 'op', reviewedHead: A, bodyFile: 'x.md' }, CTX);
    expect(seen[0]).toEqual(expect.arrayContaining([`--judged-head=${A}`, '--run-id=run-2']));
    expect(seen[0].some((a) => a.startsWith('--seen='))).toBe(false);
  });
  it('referral and review-run rows carry the run id (and no boundary from review-pr yet)', async () => {
    const sinks = createReviewPrSinks({ root });
    await sinks[REVIEW_EFFECTS.LEDGER_EVENTS]({ pr: 7, repo: 'o/n', headSha: A, posted: true, referralKeys: ['["correctness","a.js",1,"bug"]'], seen: 'empty' }, CTX);
    const rows = parseLedgerEvents(readFileSync(join(dir, 'o-n.jsonl'), 'utf8')).filter((r) => r.type !== 'verdict');
    expect(rows.map((r) => [r.type, r.seen, r.runId])).toEqual([['referral', undefined, 'run-2'], ['review-run', undefined, 'run-2']]);
  });
});
