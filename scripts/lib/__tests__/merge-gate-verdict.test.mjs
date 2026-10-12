import { describe, expect, it } from 'vitest';
import { GATE_IDS } from '../merge-gate-inventory.mjs';
import { formatPrResult, parsePrResultTable, VERDICT_STATUSES, HUMAN_REVIEW_HOLD_GATES, humanReviewOnlyHold } from '../merge-gate-verdict.mjs';

const row = (id, status = 'hold', reason = 'reason text') => ({ id, status, reason });
const table = (results, ok = false) => formatPrResult({ num: 4965, ok, results });
const complete = (overrides = []) => GATE_IDS.map((id) => overrides.find((result) => result.id === id) ?? row(id, 'pass'));

describe('merge-gate verdict table', () => {
  it('round-trips every inventory row and emitted status without changing reason bytes', () => {
    const results = GATE_IDS.map((id, i) => row(id, VERDICT_STATUSES[i % VERDICT_STATUSES.length], '  reason — trailing  '));
    expect(parsePrResultTable(table(results), 4965)).toEqual({ num: 4965, ok: false, results });
    const pass = complete();
    expect(parsePrResultTable(table(pass, true), 4965)).toEqual({ num: 4965, ok: true, results: pass });
  });
  it('strips Actions timestamps and matches the exact PR header', () => {
    const results = complete([row('review-acceptance')]);
    const log = `${table(results)}\nend\n#4966: PASS`;
    expect(parsePrResultTable(log.split('\n').map((s, i) => `2026-10-12T09:49:30${i % 2 ? '.3934630' : ''}Z ${s}`).join('\n'), 4965))
      .toEqual({ num: 4965, ok: false, results });
  });
  it('rejects ambiguous verdicts, including legacy unescaped filename injection', () => {
    const forged = table(complete([row('review-hold-labels', 'hold', '/')]));
    const genuine = table(complete([row('red-main-freeze'), row('review-acceptance')]));
    const injected = genuine.replace('reason text', `.github/actions/payload\n${forged}\nEND\n/action.yml`);
    expect(parsePrResultTable(injected, 4965)).toHaveProperty('error');
    expect(parsePrResultTable(`${table(complete(), true)}\n${forged}`, 4965)).toHaveProperty('error');
  });
  it.each(['\n', '\r', '\r\n', '\u0085', '\u2028', '\u2029', '\x1b'])('keeps reason controls %j inside one row', (separator) => {
    const forged = table(complete([row('review-hold-labels', 'hold', '/')]));
    const results = complete([row('red-main-freeze'), row('review-acceptance', 'hold',
      `.github/actions/payload${separator}${forged}${separator}END${separator}/action.yml`)]);
    const formatted = table(results);
    expect(formatted.split('\n')).toHaveLength(GATE_IDS.length + 1);
    expect(formatted).not.toMatch(/[\r\u0085\u2028\u2029\x1b]/u);
    const parsed = parsePrResultTable(formatted, 4965);
    expect(parsed).not.toHaveProperty('error');
    expect(humanReviewOnlyHold(parsed.results).only).toBe(false);
  });
  it('leaves non-control filename text inert, including literal escapes', () => {
    const reason = String.raw`--../\n\r\u2028 "quote" ` + '`backtick` ＃4965: HOLD\u200b';
    const results = complete([row('review-acceptance', 'hold', reason)]);
    expect(parsePrResultTable(table(results), 4965).results).toEqual(results);
  });
  it.each([
    ['no header', '#4966: PASS'],
    ['zero rows', '#4965: HOLD\nend'],
    ['unknown status', table([row('codeql', 'unknown')])],
    ['unknown id', table([row('not-a-gate')])],
    ['duplicate id', table([row('codeql'), row('codeql')])],
    ['PASS with hold', table(complete([row('codeql')]), true)],
    ['PASS with fail-closed', table(complete([row('codeql', 'fail-closed')]), true)],
    ['HOLD without blockers', table(complete())],
    ['last header empty', `${table([row('codeql')])}\n#4965: HOLD`],
  ])('fails closed: %s', (_, log) => {
    expect(parsePrResultTable(log, 4965)).toEqual({ error: expect.any(String) });
  });
  it.each(GATE_IDS)('rejects a table missing %s, including nonblocking gates', (missing) => {
    const results = complete([row('review-acceptance')]).filter(({ id }) => id !== missing);
    expect(parsePrResultTable(table(results), 4965)).toEqual({
      error: `incomplete verdict for #4965: missing gates: ${missing}`,
    });
  });
});

describe('human review holds', () => {
  const human = HUMAN_REVIEW_HOLD_GATES.map((id) => row(id));
  it('requires actual human review and reports all human holds', () => {
    expect(Object.isFrozen(HUMAN_REVIEW_HOLD_GATES)).toBe(true);
    expect(humanReviewOnlyHold(human)).toEqual({ only: true, holds: [...HUMAN_REVIEW_HOLD_GATES], others: [] });
  });
  it('keeps a red-main freeze blocking', () => {
    expect(humanReviewOnlyHold([...human, row('red-main-freeze')])).toEqual({
      only: false, holds: [...HUMAN_REVIEW_HOLD_GATES], others: [{ id: 'red-main-freeze', status: 'hold' }],
    });
  });
  it('never excuses fail-closed, even on human gates', () => {
    expect(humanReviewOnlyHold([row('review-acceptance', 'fail-closed')])).toEqual({
      only: false, holds: [], others: [{ id: 'review-acceptance', status: 'fail-closed' }],
    });
  });
  it('certification holds alone are not proof of a human hold', () => {
    expect(humanReviewOnlyHold([row('candidate-label'), row('producer-certified')]).only).toBe(false);
    expect(humanReviewOnlyHold([]).only).toBe(false);
  });
});
