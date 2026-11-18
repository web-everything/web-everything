import { describe, it, expect, vi } from 'vitest';
import { CONTROL_OPS, planOperatorControl, operatorControlOperation, parseOperatorActions } from '../operator-controls.mjs';
import { createOperatorControlsReader, createOperatorControlsSinks } from '../operator-controls-io.mjs';
import { AWAIT_VERIFY_LIMITS } from '../../conveyor/await-verify-pass.mjs';

const head = 'abcdef0123456789abcdef0123456789abcdef01';
const otherHead = '1234567890abcdef1234567890abcdef12345678';
const now = '2026-11-09T12:00:00.000Z';
const input = { repo: 'web-everything/web-everything', pr: 7, head: head.slice(0, 9).toUpperCase(), actor: 'chalbert', channel: 'operator-session', reason: 'Retry after repairing the resume service' };
const row = (key, overrides = {}) => ({ key, record: { v: 1, sessionId: key, repo: input.repo, pr: 7, sha: head, kind: 'fix', resumeFailures: AWAIT_VERIFY_LIMITS.maxResumeFailures,
  previousCi: { ready: { ciFailures: ['test'] } }, requestedAt: now, ...overrides } });
function fixture(rows = [row('target')]) {
  let stored = structuredClone(rows), liveHead = head, comments = [];
  const writeAwaitVerify = vi.fn(record => { stored = stored.map(r => r.key === record.sessionId ? { ...r, record: structuredClone(record) } : r); return { ok: true }; });
  const reader = createOperatorControlsReader({ listAwaitVerify: () => structuredClone(stored), now: () => now,
    runGh: () => JSON.stringify({ state: 'OPEN', labels: [], headRefOid: liveHead }), readComments: () => comments });
  const sink = createOperatorControlsSinks({ readContext: reader, writeAwaitVerify,
    runGh: argv => { comments.push({ body: argv.at(-1), author: { login: 'chalbert' } }); } })['operator.control'];
  return { reader, sink, writeAwaitVerify, stored: () => stored, comments: () => comments, move: sha => { liveHead = sha; },
    plan: (args = input) => planOperatorControl('ci-heal-reset', reader('ci-heal-reset', args), args) };
}

describe('ci-heal-reset', () => {
  it('declares a required head and suppresses preview effects', () => {
    expect(CONTROL_OPS).toContain('ci-heal-reset');
    const declaration = operatorControlOperation('ci-heal-reset');
    const p = fixture().plan();
    expect(declaration.steps.find(s => s.name === 'write').step.effects({ input: { preview: true }, verdict: p })).toEqual([]);
    for (const bad of [{ head: undefined }, { head: 'abcdef' }, { head: 'z'.repeat(40) }, { head: head + '0' }, { head: head + '\n' }, { pr: 0 }]) expect(() => fixture().plan({ ...input, ...bad })).toThrow();
  });
  it('resets only matching repo/pr/head records, preserving every other field and the normal cap', async () => {
    const rows = [row('target'), row('second'), row('other-pr', { pr: 8 }), row('other-head', { sha: otherHead }), row('other-repo', { repo: 'elsewhere/project' })];
    const f = fixture(rows);
    expect(f.reader('ci-heal-reset', input).awaitVerify.map(r => r.key)).toEqual(['target', 'second', 'other-head']);
    await f.sink(f.plan());
    expect(f.writeAwaitVerify).toHaveBeenCalledTimes(2);
    expect(f.stored()).toEqual(rows.map((r, i) => i < 2 ? { ...r, record: { ...r.record, resumeFailures: 0, operatorResets: 1 } } : r));
    expect(AWAIT_VERIFY_LIMITS.maxResumeFailures).toBe(3);
    expect(f.stored()[0].record.resumeFailures).toBeLessThan(AWAIT_VERIFY_LIMITS.maxResumeFailures);
  });
  it('refuses mismatched live or stored heads, including unreadable live head evidence', () => {
    const f = fixture();
    f.move(otherHead);
    expect(() => f.plan()).toThrow('head moved');
    expect(() => fixture([row('old', { sha: otherHead })]).plan()).toThrow('head moved');
    f.move(null);
    expect(() => f.plan()).toThrow(/incomplete PR state/);
    expect(f.writeAwaitVerify).not.toHaveBeenCalled();
  });
  it('is idempotent: a second run is noop and rewrites nothing', async () => {
    const f = fixture();
    await f.sink(f.plan());
    const second = f.plan();
    expect(second.action).toBe('noop');
    await f.sink(second);
    expect(f.writeAwaitVerify).toHaveBeenCalledTimes(1);
    expect(f.comments()).toHaveLength(1);
  });
  it('records actor, channel, verbatim reason, time and recovery details in the operator comment', async () => {
    const f = fixture();
    await f.sink(f.plan());
    expect(parseOperatorActions(f.comments())).toMatchObject([{ actor: input.actor, channel: input.channel, reason: input.reason, at: now,
      details: { pr: 7, head, previousResumeFailures: 3, undo: expect.any(String) } }]);
  });
  it('refuses a stored sha that shares the prefix but differs from the live head', () => {
    const sibling = head.slice(0, 9) + '9'.repeat(31);
    expect(() => fixture([row('prefix-twin', { sha: sibling })]).plan()).toThrow('head moved');
  });
  it('bounds repeated resets per pr@head and escalates instead of resetting again', async () => {
    const f = fixture();
    await f.sink(f.plan());
    f.stored()[0].record.resumeFailures = AWAIT_VERIFY_LIMITS.maxResumeFailures;
    await f.sink(f.plan());
    expect(f.stored()[0].record.operatorResets).toBe(2);
    f.stored()[0].record.resumeFailures = AWAIT_VERIFY_LIMITS.maxResumeFailures;
    expect(() => f.plan()).toThrow(/limit reached/);
  });
  it('refuses invalid counters and a writer that omits the reset increment', async () => {
    expect(() => fixture([row('neg', { operatorResets: -1 })]).plan()).toThrow(/invalid operatorResets/);
    const f = fixture(), writeAwaitVerify = vi.fn(record => ({ ok: true, record: { ...record, operatorResets: undefined } }));
    const noIncrement = vi.fn(record => { f.stored()[0].record = { ...record, operatorResets: 0 }; return { ok: true }; });
    const sink = createOperatorControlsSinks({ readContext: f.reader, writeAwaitVerify: noIncrement, writeRecord: vi.fn() })['operator.control'];
    await expect(sink(f.plan())).rejects.toThrow(/verif/i);
  });
  it('refuses non-operator actors', () => {
    expect(() => fixture().plan({ ...input, actor: 'intruder' })).toThrow(/registered operator/);
  });
  it('accepts a full SHA or a seven-character prefix case-insensitively', async () => {
    for (const value of [head.toUpperCase(), head.slice(0, 7).toUpperCase()]) {
      const f = fixture([row('target', { sha: head.toUpperCase() })]);
      await f.sink(f.plan({ ...input, head: value }));
      expect(f.stored()[0].record.resumeFailures).toBe(0);
    }
  });
  it('does nothing without an exhausted pending previous-head failure', () => {
    for (const rows of [[], [row('below', { resumeFailures: 2 })], [row('no-ci', { previousCi: null })]]) expect(fixture(rows).plan().action).toBe('noop');
  });
  it('refuses changed fingerprints before mutation', async () => {
    const f = fixture(), p = f.plan();
    f.move(otherHead);
    await expect(f.sink(p)).rejects.toThrow(/head moved|changed/);
    expect(f.writeAwaitVerify).not.toHaveBeenCalled();
  });
  it('refuses failed store writes and failed verification without recording success', async () => {
    for (const result of [{ ok: false }, { ok: true }]) {
      const f = fixture(), writeAwaitVerify = vi.fn(() => result), writeRecord = vi.fn();
      const sink = createOperatorControlsSinks({ readContext: f.reader, writeAwaitVerify, writeRecord })['operator.control'];
      await expect(sink(f.plan())).rejects.toThrow(/write|verify/);
      expect(writeRecord).not.toHaveBeenCalled();
    }
  });
  it('recovers an unpushed repair: record sha is the withheld repair, remote still holds its pinned base', async () => {
    const repair = otherHead, rows = () => [row('target', { sha: repair, previousCi: { headSha: head, ready: { ciFailures: ['test'] } } })];
    for (const value of [head, repair]) {
      const f = fixture(rows());
      await f.sink(f.plan({ ...input, head: value }));
      expect(f.stored()[0].record).toMatchObject({ resumeFailures: 0, operatorResets: 1, sha: repair });
    }
    const pushed = fixture([row('target', { sha: repair, earlyPush: { ok: true, sha: repair }, previousCi: { headSha: head, ready: { ciFailures: ['test'] } } })]);
    expect(() => pushed.plan()).toThrow('head moved');
    const unrelated = fixture(rows());
    unrelated.move('f'.repeat(40));
    expect(() => unrelated.plan({ ...input, head: 'f'.repeat(40) })).toThrow('head moved');
    expect(() => fixture([row('target', { sha: repair, previousCi: { ready: { ciFailures: ['test'] } } })]).plan()).toThrow('head moved');
  });
  it('matches an exhausted record on the live head passed by the operator (daemon logs an empty head)', async () => {
    const f = fixture([row('target', { sha: head.toUpperCase() })]);
    await f.sink(f.plan({ ...input, head }));
    expect(f.stored()[0].record.resumeFailures).toBe(0);
  });
  it('replays a completed second reset as the recorded no-op', async () => {
    const f = fixture();
    await f.sink(f.plan());
    f.stored()[0].record.resumeFailures = AWAIT_VERIFY_LIMITS.maxResumeFailures;
    const second = f.plan();
    await f.sink(second);
    expect(f.stored()[0].record.operatorResets).toBe(2);
    const calls = f.writeAwaitVerify.mock.calls.length, comments = f.comments().length;
    await expect(f.sink(second)).resolves.toMatchObject({ action: 'noop' });
    expect(f.writeAwaitVerify.mock.calls.length).toBe(calls);
    expect(f.comments()).toHaveLength(comments);
  });
});
