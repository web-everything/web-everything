/**
 * @file scripts/lib/__tests__/standards-status.test.mjs
 * @description Negative-first tests for the pure Standards status core (merge-path checklist lines 1-3, 5-7).
 */
import { describe, it, expect } from 'vitest';
import { harnessVerdict, validatorVerdict, statusPayload, evaluateStandardsStatus, STANDARDS_CONTEXT, TRUSTED_BOT } from '../standards-status.mjs';

const HEAD = 'a'.repeat(40);
const bot = { ...TRUSTED_BOT };
const st = (id, state, creator = bot, context = STANDARDS_CONTEXT) => ({ id, state, context, creator });
const combinedFor = (history, extra = {}) => {
  const newest = history.filter(s => s.context === STANDARDS_CONTEXT).sort((a, b) => b.id - a.id)[0];
  return { sha: HEAD, total_count: newest ? 1 : 0, statuses: newest ? [newest] : [], ...extra };
};
const evalWith = (history, over = {}) => evaluateStandardsStatus({ combined: combinedFor(history), history, head: HEAD, ...over });

const NONCE = 'n0nce-1234';
const good = (over = {}) => ({ status: 0, stdout: `${JSON.stringify({ nonce: NONCE, ok: true, count: 3 })}\n`, ...over });
describe('harnessVerdict (structured child result)', () => {
  it('passes only the exact shape with the run nonce and exit 0', () => expect(harnessVerdict(good(), NONCE).state).toBe('success'));
  it.each([
    ['early process.exit(0): no result at all', { status: 0, stdout: 'Standards validator exit status: 0\n' }],
    ['wrong nonce', good({ stdout: `${JSON.stringify({ nonce: 'guess', ok: true, count: 3 })}\n` })],
    ['missing nonce', good({ stdout: `${JSON.stringify({ ok: true, count: 3 })}\n` })],
    ['extra line before the result', good({ stdout: `forged\n${good().stdout}` })],
    ['extra line after the result', good({ stdout: `${good().stdout}more\n` })],
    ['text glued to the result line', good({ stdout: `x${good().stdout}` })],
    ['extra key in the result', good({ stdout: `${JSON.stringify({ nonce: NONCE, ok: true, count: 3, extra: 1 })}\n` })],
    ['ok false', good({ stdout: `${JSON.stringify({ nonce: NONCE, ok: false, count: 3 })}\n`, status: 1 })],
    ['zero protocols', good({ stdout: `${JSON.stringify({ nonce: NONCE, ok: true, count: 0 })}\n` })],
    ['ok string', good({ stdout: `${JSON.stringify({ nonce: NONCE, ok: 'true', count: 3 })}\n` })],
    ['non-zero exit despite a good result', good({ status: 1 })],
    ['signal', good({ status: null, signal: 'SIGKILL' })],
    ['timeout', good({ timedOut: true })],
    ['stdout overflow', good({ truncated: true })],
    ['spawn error', { status: null, error: new Error('ENOENT') }],
    ['no result', undefined],
  ])('%s is a failure', (_name, result) => expect(harnessVerdict(result, NONCE).state).toBe('failure'));
  it('fails without an expected nonce', () => expect(harnessVerdict(good(), '').state).toBe('failure'));
});

describe('validatorVerdict (the Studio validator run by the parent)', () => {
  it('passes exit 0 with clean output', () => expect(validatorVerdict({ status: 0, stdout: 'RESULT: PASS\n' }).state).toBe('success'));
  it.each([
    ['SKIP output', { status: 0, stdout: 'SKIP: no vectors\n' }],
    ['NOT RUN output', { status: 0, stdout: 'NOT RUN HERE\n' }],
    ['non-zero exit', { status: 1, stdout: 'RESULT: PASS\n' }],
    ['signal', { status: null, signal: 'SIGKILL', stdout: '' }],
    ['timeout', { status: 0, timedOut: true, stdout: '' }],
    ['spawn error', { status: null, error: new Error('x') }],
    ['no result', undefined],
  ])('%s is a failure', (_name, result) => expect(validatorVerdict(result).state).toBe('failure'));
});

describe('statusPayload', () => {
  it('binds the run id and validator hash, within 140 chars', () => {
    const p = statusPayload({ state: 'success', runId: 'r1', validatorHash: 'abcd1234', reason: 'x'.repeat(300) });
    expect(p.context).toBe(STANDARDS_CONTEXT);
    expect(p.description.startsWith('run r1 · validator abcd1234')).toBe(true);
    expect(p.description.length).toBeLessThanOrEqual(140);
  });
  it('rejects an unknown state', () => expect(() => statusPayload({ state: 'ok', runId: 'r' })).toThrow());
});

describe('evaluateStandardsStatus', () => {
  it('passes a trusted success', () => expect(evalWith([st(5, 'success')]).hold).toBe(false));
  it('holds when the context is absent although other contexts are green', () => {
    const combined = { sha: HEAD, total_count: 1, statuses: [st(9, 'success', bot, 'ci/other')] };
    expect(evaluateStandardsStatus({ combined, history: [st(9, 'success', bot, 'ci/other')], head: HEAD }).hold).toBe(true);
  });
  it('ignores a newer success by a user (operator login)', () => {
    const user = { id: 1, type: 'User', login: 'operator' };
    expect(evalWith([st(5, 'failure'), st(6, 'success', user)]).hold).toBe(true);
  });
  it('ignores a success by another bot', () => {
    expect(evalWith([st(6, 'success', { id: 2, type: 'Bot', login: 'other[bot]' })]).hold).toBe(true);
  });
  it('rejects a bot look-alike with the right login but wrong id', () => {
    expect(evalWith([st(6, 'success', { ...bot, id: 7 })]).hold).toBe(true);
  });
  it('orders by id, not by created_at: a newer-id failure beats an older-id success with a later timestamp', () => {
    const older = { ...st(5, 'success'), created_at: '2030-01-01T00:00:00Z' };
    const newer = { ...st(6, 'failure'), created_at: '2020-01-01T00:00:00Z' };
    expect(evalWith([older, newer]).hold).toBe(true);
  });
  it('holds on a newer pending (a crash after the pending post)', () => expect(evalWith([st(5, 'success'), st(6, 'pending')]).hold).toBe(true));
  it('holds on a newer failure or error from anyone', () => {
    const user = { id: 1, type: 'User', login: 'operator' };
    expect(evalWith([st(5, 'success'), st(6, 'error', user)]).hold).toBe(true);
  });
  it('holds on a success for the previous head (stale)', () => {
    const history = [st(5, 'success')];
    expect(evaluateStandardsStatus({ combined: { ...combinedFor(history), sha: 'b'.repeat(40) }, history, head: HEAD }).hold).toBe(true);
  });
  it.each(['abc123', '', undefined, 'g'.repeat(40), 'A'.repeat(40)])('refuses an invalid head %s', head => {
    expect(evalWith([st(5, 'success')], { head }).hold).toBe(true);
  });
  it('holds on a summary/history mismatch', () => {
    const history = [st(5, 'success')];
    expect(evaluateStandardsStatus({ combined: { ...combinedFor(history), statuses: [st(4, 'success')] }, history, head: HEAD }).hold).toBe(true);
  });
  it('holds when the combined summary is incomplete', () => {
    const history = [st(5, 'success')];
    expect(evaluateStandardsStatus({ combined: { ...combinedFor(history), total_count: 3 }, history, head: HEAD }).hold).toBe(true);
  });
  it('holds when the history hit the page cap', () => expect(evalWith([st(5, 'success')], { historyComplete: false }).hold).toBe(true));
  it('holds on malformed data', () => {
    expect(evaluateStandardsStatus({ combined: 'x', history: null, head: HEAD }).hold).toBe(true);
    expect(evaluateStandardsStatus({ combined: combinedFor([]), history: [{ id: 'x' }], head: HEAD }).hold).toBe(true);
    expect(evaluateStandardsStatus().hold).toBe(true);
  });
  it('reports the newest trusted terminal and the newest id for the verifier dedupe', () => {
    const r = evalWith([st(5, 'failure'), st(6, 'pending')]);
    expect(r.latestTrusted.id).toBe(5);
    expect(r.newestId).toBe(6);
  });
});
