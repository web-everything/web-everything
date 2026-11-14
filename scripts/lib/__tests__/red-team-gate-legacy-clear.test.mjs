// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { createHash } from 'node:crypto';
import { readRedTeamDisposition, redTeamMarker, redTeamGateMarker, redTeamResultId } from '../red-team-gate.mjs';

const head = 'a'.repeat(40), pr = 6777;
const comment = (body, login = 'web-everything') => ({ body, author: { login, type: 'User' } });
const result = comment(`${redTeamMarker(pr, head)}\n### Post-accept red team — no break found`);
const seal = { breaks: [], legacyHold: true };
const fp = s => createHash('sha256').update(JSON.stringify(s, Object.keys(s).sort())).digest('hex').slice(0, 16);
const id = redTeamResultId(readRedTeamDisposition({ comments: [result], pr, head, sealed: null }).result);
const ruling = (s = seal, login = 'chalbert', resultId = id) => comment(`${redTeamGateMarker(pr, head, 'operator-legacy-clear', resultId)}\n- legacy-conflict hold cleared by the operator for seal ${fp(s)}.\n\nReason: Reviewed the legacy conflict.`, login);
const read = (comments, sealed = seal, extra = {}) => readRedTeamDisposition({ comments, pr, head, sealed, ...extra });

describe('legacy-conflict operator clearance (design 13–19)', () => {
  it('13 clears #6777 empty sealedBreaks legacy flag with a human ruling', () => {
    const d = read([result, ruling()]);
    expect(d.held).toEqual([]); expect(d.sendBack).toEqual([]);
  });
  it('14 holds without a ruling', () => expect(read([result]).held).toHaveLength(1));
  it.each(['plateau-reviewer', 'chalbert[bot]'])('15 ignores ruling by %s', login => {
    expect(read([result, ruling(seal, login)]).held).toHaveLength(1);
  });
  it('16 holds after seal changes', () => expect(read([result, ruling()], { ...seal, breaks: ['changed'] }).held).toHaveLength(1));
  it('16 holds for a newer result id', () => expect(read([result, ruling(seal, 'chalbert', 'b'.repeat(16))]).held).toHaveLength(1));
  it('16 an actual newer result restores the synthetic hold', () => {
    const newer = comment(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok',
      foldedVerdict: 'changes', findings: [{ summary: 'New result', category: 'correctness', impactIfUnfixed: 'broken', confirmedByRecheck: true }] }));
    expect(read([result, ruling(), newer]).held.some(f => f.index === 0)).toBe(true);
  });
  it('only removes the synthetic item, retaining real confirmed breaks', () => {
    const broken = comment(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok',
      foldedVerdict: 'changes', findings: [{ summary: 'Real break', category: 'correctness', impactIfUnfixed: 'broken', confirmedByRecheck: true }] }));
    const resultId = redTeamResultId(read([broken], null).result);
    const d = read([broken, ruling(seal, 'chalbert', resultId)]);
    expect(d.held).toEqual([]); expect(d.sendBack).toHaveLength(1);
  });
  it('17 ignores a ruling before the result', () => expect(read([ruling(), result]).held).toHaveLength(1));
  it('17 ignores a carried ruling', () => {
    const to = 'b'.repeat(40);
    const carry = comment(`<!-- review-verdict-carried from=${head} to=${to} patch-id=${'c'.repeat(40)} -->\n${result.body.replaceAll(head, to)}`);
    expect(read([result, ruling(), carry], seal, { head: to }).held).toHaveLength(1);
  });
  it('18 clears the unsealed legacy shape using its own fingerprint', () => {
    const s = { unsealed: true, legacyHold: true };
    expect(read([result, ruling(s)], s).held).toEqual([]);
    expect(read([result, ruling()], s).held).toHaveLength(1);
  });
  it.each([{ unreadable: true }, { unsealed: true }, { breaks: ['conflict'], legacyHold: false }])('19 never clears non-legacy %j', s => {
    expect(read([result, ruling(s)], s).held).toHaveLength(1);
  });
  it('19 caller-forced legacy hold cannot be ruled away', () => expect(read([result, ruling()], seal, { legacyHold: true }).held).toHaveLength(1));
  it('fails closed without a result or with a missing fingerprint', () => {
    expect(read([ruling()]).held).toHaveLength(1);
    expect(read([result, comment(redTeamGateMarker(pr, head, 'operator-legacy-clear', id), 'chalbert')]).held).toHaveLength(1);
  });
});
