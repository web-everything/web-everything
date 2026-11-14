// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SEAL_SCHEMA, validateStoredFindings, buildSeal, strictPostedResult, readRedTeamResult } from '../lib/red-team-result-schema.mjs';
import { sealedBreakKeys, redTeamForHead } from '../lib/red-team-gate.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { renderRedTeamComment } from '../operations/review-extra-seats.mjs';

const repo = 'o/n', pr = 42, head = 'a'.repeat(40), now = '2026-11-14T12:00:00.000Z';
const identity = { repo, pr, head };
const finding = { confirmedByRecheck: true, category: 'correctness', file: 'scripts/x.mjs', line: 1, summary: 'Boundary bypass' };
const result = (extra = {}) => ({ status: 'ran', comment: 'posted', foldedVerdict: 'accept', confirmedMissCount: 0, findings: [], ...extra });
const comment = (findings = []) => ({ author: { login: OPERATOR_LOGINS[0] }, createdAt: now,
  body: renderRedTeamComment({ pr, rev: head, findings, foldedVerdict: findings.length ? 'changes' : 'accept', provider: 'codex', model: 'fixture' }) });
const seal = (findings = []) => ({ schema: 3, ...identity, breaks: sealedBreakKeys(findings),
  foldedVerdict: findings.length ? 'changes' : 'accept', confirmedMissCount: findings.length, sealedAt: now });
const status = (extra = {}) => ({ ...identity, status: 'finished', result: result(), seal: seal(), sealedBreaks: [], ...extra });
function read(stored = status(), comments = [comment()], disposition) {
  disposition ??= { result: redTeamForHead(comments, pr, head), sendBack: [], held: [] };
  return readRedTeamResult({ ...identity, status: stored, comments, disposition });
}
function pending(stored, comments) {
  expect(read(stored, comments)).toMatchObject({ outcome: 'pending', reason: expect.any(String), breaks: expect.any(Array) });
  expect(read(stored, comments).reason.length).toBeGreaterThan(0);
}
function refused(value) {
  expect(value).toMatchObject({ ok: false, reason: expect.any(String) });
  expect(value.reason.length).toBeGreaterThan(0);
}
const build = (r, findings = r.findings) => buildSeal({ ...identity, result: r, findings, now });

describe('red-team result schema: positive evidence only', () => {
  it("#1347/#1365 malformed findings [null, {confirmedByRecheck:'true'}] never seal as zero breaks", () => {
    for (const findings of [[null], [{ confirmedByRecheck: 'true' }], [null, { confirmedByRecheck: 'true' }], [{ confirmed: 1 }]]) {
      refused(validateStoredFindings(findings));
      refused(build(result({ findings })));
      pending(status({ seal: undefined, sealedBreaks: undefined, result: result({ findings }) }));
    }
  });

  it('#1366 a finding missing both confirmation flags with confirmedMissCount 1 is unreadable', () => {
    const findings = [{ category: 'correctness', summary: 'Unclassified confirmation' }];
    refused(validateStoredFindings(findings));
    refused(build(result({ findings, confirmedMissCount: 1, foldedVerdict: 'changes' })));
    pending(status({ seal: undefined, sealedBreaks: undefined, result: result({ findings, confirmedMissCount: 1 }) }));
  });

  it('#1368 foldedVerdict changes with confirmedMissCount 0 and no findings is not a positive zero', () => {
    for (const foldedVerdict of ['changes', 'needs-human']) {
      refused(build(result({ foldedVerdict })));
      pending(status({ seal: undefined, sealedBreaks: undefined, result: result({ foldedVerdict }) }));
    }
  });

  it('#1357 missing foldedVerdict never yields clear', () => {
    const r = result();
    delete r.foldedVerdict;
    refused(build(r));
    pending(status({ seal: undefined, sealedBreaks: undefined, result: r }));
    const s = seal();
    delete s.foldedVerdict;
    pending(status({ seal: s }));
  });

  it("#1357/#1356 seal {breaks:'garbled'}, unknown result shapes and garbled status values read as pending", () => {
    pending(status({ seal: { ...seal(), breaks: 'garbled' } }));
    for (const value of [null, [], 'garbled', 1, true]) pending(value);
    for (const value of ['unknown', {}, [], 1]) pending(status({ seal: undefined, result: value }));
    pending(status({ status: 'garbled' }));
    pending(status({ status: 'running' }));
  });

  it("#1356 finished bare 'resumed' (and bare 'not-owed') status reads as pending", () => {
    for (const value of ['resumed', 'not-owed']) pending(status({ seal: undefined, result: value }));
  });

  it('#1370 an unversioned sealedBreaks [] never yields clear', () => {
    pending(status({ seal: undefined, result: 'ran' }));
  });

  it('#1370/#1362 an indented or malformed confirmed finding under a valid marker with a v3 empty seal reads as pending', () => {
    const line = '1. [**confirmed**] (correctness, impact?) `scripts/x.mjs:1` — Boundary bypass';
    for (const malformed of [`  ${line}`, line.replace('confirmed', 'CONFIRMED'), line.replace('**confirmed**', '__confirmed__'),
      line.replace('1.', '1)'), line.replace(' — ', ' - ')]) {
      const c = { ...comment(), body: `${comment().body}\n${malformed}` };
      refused(strictPostedResult({ comments: [c], pr, head }));
      pending(status(), [c]);
    }
    // Strictness applies to the latest result, even when an earlier result was clean.
    const bad = { ...comment(), createdAt: '2026-11-14T12:01:00.000Z', body: `${comment().body}\n  ${line}` };
    refused(strictPostedResult({ comments: [comment(), bad], pr, head }));
  });

  it('#1367 an already-posted result with an old empty seal and a positive confirmed count reads as pending', () => {
    pending(status({ seal: undefined, result: result({ confirmedMissCount: 1 }) }));
  });

  it('#1345/#1346 empty status {} or result {} reads as pending', () => {
    pending({});
    pending(status({ seal: undefined, sealedBreaks: undefined, result: {} }));
  });

  it('identity mismatch (other head, other repo, other pr, short sha) reads as pending', () => {
    for (const mismatch of [{ head: 'b'.repeat(40) }, { repo: 'other/repo' }, { pr: 43 }, { head: head.slice(0, 7) }]) {
      pending(status(mismatch));
      pending(status({ seal: { ...seal(), ...mismatch } }));
    }
  });

  it('positive evidence: v3 seal on this head, accept, confirmedMissCount 0, strict comment with 0 confirmed -> clear', () => {
    expect(SEAL_SCHEMA).toBe(3);
    expect(build(result())).toEqual({ ok: true, seal: seal() });
    expect(validateStoredFindings([])).toEqual({ ok: true, breaks: [] });
    expect(strictPostedResult({ comments: [comment()], pr, head })).toEqual({ ok: true, posted: true, keys: [] });
    expect(strictPostedResult({ comments: [], pr, head })).toEqual({ ok: true, posted: false, keys: [] });
    expect(read()).toMatchObject({ outcome: 'clear', breaks: [], reason: expect.any(String) });
    expect(read(status({ seal: undefined, sealedBreaks: undefined }))).toMatchObject({ outcome: 'clear', breaks: [] });
  });

  it('a v3 seal with breaks and a disposition that sends back -> blocked', () => {
    const findings = [finding], comments = [comment(findings)];
    expect(validateStoredFindings(findings)).toEqual({ ok: true, breaks: sealedBreakKeys(findings) });
    const { confirmedByRecheck: _flag, ...confirmedOnly } = finding;
    expect(validateStoredFindings([{ ...confirmedOnly, confirmed: true }])).toEqual({ ok: true, breaks: sealedBreakKeys([finding]) });
    expect(validateStoredFindings([{ ...finding, confirmedByRecheck: false }, { confirmed: false }])).toEqual({ ok: true, breaks: [] });
    expect(build(result({ findings, foldedVerdict: 'changes', confirmedMissCount: 1 }))).toEqual({ ok: true, seal: seal(findings) });
    const r = result({ findings, foldedVerdict: 'changes', confirmedMissCount: 1 });
    expect(read(status({ seal: seal(findings), result: r, sealedBreaks: sealedBreakKeys(findings) }), comments,
      { result: redTeamForHead(comments, pr, head), sendBack: [finding], held: [] }))
      .toMatchObject({ outcome: 'blocked', breaks: sealedBreakKeys(findings) });
  });

  it('posted confirmed breaks beyond the seal (comment adds a hold) -> blocked or pending, never clear', () => {
    const comments = [comment([finding])];
    const value = read(status(), comments, { result: redTeamForHead(comments, pr, head), sendBack: [finding], held: [] });
    expect(['blocked', 'pending']).toContain(value.outcome);
    expect(value.breaks).toContain(sealedBreakKeys([finding])[0]);
  });

  it('a break ruled card by the operator (disposition empty sendBack/held, result present) with an agreeing v3 seal -> clear', () => {
    const findings = [finding], comments = [comment(findings)];
    const r = result({ findings, foldedVerdict: 'changes', confirmedMissCount: 1 });
    expect(read(status({ seal: seal(findings), result: r, sealedBreaks: sealedBreakKeys(findings) }), comments,
      { result: redTeamForHead(comments, pr, head), sendBack: [], held: [] }))
      .toMatchObject({ outcome: 'clear', breaks: sealedBreakKeys(findings) });
  });

  it('oversized input: 10000 findings / a 3000-line comment stay bounded and fail closed when malformed', () => {
    const findings = Array.from({ length: 10000 }, () => ({ confirmed: false }));
    findings[9999] = null;
    refused(validateStoredFindings(findings));
    refused(build(result({ findings })));
    const c = { ...comment(), body: `${comment().body}\n${'ordinary context\n'.repeat(2999)}  1. [**CONFIRMED**] malformed` };
    refused(strictPostedResult({ comments: [c], pr, head }));
    pending(status(), [c]);
  }, 2000);
});
