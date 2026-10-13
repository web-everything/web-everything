import { describe, it, expect } from 'vitest';
import { liveFactHolds, shadowRow, summarizeShadow, buildShadowRunRecord, formatShadowLine, runLedgerShadow, classifyHoldCodes } from '../drain-ledger-shadow.mjs';
import { buildVerdictRecord, buildLedgerEvent } from '../verdict-ledger.mjs';
const repo = 'o/r', head = 'a'.repeat(40), at = '2026-10-13T14:00:00Z';
const accepted = (sha = head) => ({ type: 'verdict', ...buildVerdictRecord({ repo, pr: 1, verdict: 'accepted', headSha: sha, at, source: 'test', reason: 'ok' }) });
const hold = (reasonCode) => buildLedgerEvent({ type: 'hold', repo, pr: 1, at, source: 'test', declaredActor: 'drain', holdSource: 'drain', reasonCode });
const row = (facts = {}, events = [accepted()]) => shadowRow({ repo, now: at, events, verdict: { num: 1, decision: 'merge', headSha: head, reason: ' x ', ...facts } });
describe('live fact comparison', () => {
  it.each([
    [{ requiredCheckReadError: 'error' }, 'required-check-unreadable'],
    [{ certifyLabel: false, aiGenerated: false, humanCleared: false }, 'not-certified'],
    [{ offDefaultBase: true }, 'off-default-base'], [{ testGreen: false }, 'required-check-not-green'],
    [{ codeqlBlocked: true }, 'codeql-failed'], [{ mergeable: 'UNKNOWN' }, 'not-mergeable'],
    [{ state: 'BLOCKED' }, 'merge-state-unlandable'], [{ redMainHold: true }, 'red-main-hold'],
  ])('adds only explicit failure %j', (facts, code) => {
    expect(liveFactHolds(facts)).toEqual([{ code: 'fact:' + code, reason: expect.any(String) }]);
  });
  it('ignores absent fields and queue relief', () => {
    for (const v of [undefined, null, {}, { certifyLabel: false }, { state: 'BLOCKED', queueBlockedRelief: true }]) expect(liveFactHolds(v)).toEqual([]);
  });
  it('adds a hold and reports facts without mutating the verdict', () => {
    expect(row({ decision: 'skip', offDefaultBase: true })).toMatchObject({ status: 'agree', ledgerVerdict: 'hold', ledgerHolds: ['fact:off-default-base'], labelReason: 'x', facts: { offDefaultBase: true } });
    expect(row({ offDefaultBase: false }, [accepted(), hold('review')]).ledgerVerdict).toBe('hold');
  });
  it('reports stale mechanical holds as transient without clearing', () => {
    expect(row({ testGreen: true }, [accepted(), hold('required check "test" is not green')])).toMatchObject({ status: 'transient', ledgerVerdict: 'hold', direction: null, transient: 'stale-drain-mechanical-hold' });
  });
  it('keeps all nonmechanical or unproven cases as disagreement', () => {
    for (const events of [[], [accepted(), hold('review')], [accepted('b'.repeat(40)), hold('required check "test" is not green')]]) expect(row({ testGreen: true }, events).status).toBe('disagree');
    expect(row({ testGreen: false }, [accepted(), hold('required check "test" is not green')]).status).toBe('disagree');
    expect(classifyHoldCodes(['stale-acceptance'], { testGreen: true })).toBe(false);
  });
  it.each([
    ['required check test', { testGreen: true }, { testGreen: false }],
    ['not mergeable (mergeable=unknown)', { mergeable: 'MERGEABLE' }, {}],
    ['merge state blocked', { state: 'CLEAN' }, { state: 'BLOCKED' }],
    ['merge state blocked', { queueBlockedRelief: true }, {}],
    ['base is not main', { offDefaultBase: false }, {}],
    ['red-main-hold', {}, { redMainHold: true }],
    ['codeql failed', { codeqlBlocked: false }, {}],
  ])('requires live contradiction for %s', (code, clear, unknown) => {
    expect(row(clear, [accepted(), hold(code)])).toMatchObject({ status: 'transient', ledgerVerdict: 'hold' });
    expect(row(unknown, [accepted(), hold(code)]).status).toBe('disagree');
  });
  it('never reclassifies mixed mechanical and review holds', () => {
    expect(row({ testGreen: true }, [accepted(), hold('required check test'), hold('review')]).status).toBe('disagree');
    expect(row({ testGreen: true }, [accepted('b'.repeat(40))]).ledgerHolds).toContain('stale-acceptance');
    expect(row({}, []).ledgerHolds).toEqual(['no-ledger-row']);
    expect(row({ reason: 'x'.repeat(300) }).labelReason).toHaveLength(200);
    expect(row({}, null)).toMatchObject({ status: 'unreadable', ledgerVerdict: 'unreadable', ledgerHolds: [] });
  });
  it('a transient-only record is clean and formats a successful readiness result', () => {
    const rows = [row({ testGreen: true }, [accepted(), hold('required check test')])];
    const summary = summarizeShadow(rows);
    expect(buildShadowRunRecord({ id: 'x', at, rows, summary }).verdict).toBe('clean');
    const line = formatShadowLine({ ok: true, summary, rows, readiness: {
      ok: true, measure: { ready: false, agreementPct: 0, comparedPRs: 1, shadowDays: 1, unsafe: 0, transient: 1 },
    } });
    expect(line.split('\n')[1]).toContain('ledger readiness: NOT READY');
  });
  it('summarizes, ranks and formats transient separately', () => {
    const rows = [row({ testGreen: true }, [accepted(), hold('required check test')]), row({}, [])];
    const summary = summarizeShadow(rows);
    expect(summary).toMatchObject({ transient: 1, disagree: 1, transientBy: { 'stale-drain-mechanical-hold': 1 } });
    const rec = buildShadowRunRecord({ id: 'x', at, rows, summary });
    expect(rec.input.schema).toBe(2);
    expect(rec.findings.rows[0].status).toBe('disagree');
    const line = formatShadowLine({ ok: true, rows, summary, readiness: { ok: false, error: 'oops' } });
    expect(line.split('\n')).toHaveLength(2);
    expect(line).toContain('transient 1');
    expect(line).toContain('#1(drain:clear/ledger:hold)');
  });
  it('time boxes readiness failures and skips dry-run readiness', async () => {
    const opts = { verdicts: [{ num: 1, repo, decision: 'merge', headSha: head }], readEvents: () => ({ status: 'ok', rows: [accepted()] }), write: () => '/x', timeoutMs: 5 };
    for (const readiness of [() => { throw Error('oops'); }, () => new Promise(() => {})]) {
      expect(await runLedgerShadow({ ...opts, readiness })).toMatchObject({ ok: true, written: true, readiness: { ok: false, error: expect.any(String) } });
    }
    const empty = await runLedgerShadow({ verdicts: [], readiness: () => { throw Error('oops'); } });
    expect(empty).toMatchObject({ ok: true, written: false, readiness: { ok: false, error: 'oops' } });
    expect((await runLedgerShadow({ ...opts, dryRun: true, readiness: () => { throw Error('called'); } })).readiness).toBeUndefined();
  });
});
