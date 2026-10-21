// fix-run's hand-back after a push (operator brief 2026-10-21): an accepted PR whose pushed head is provably the same
// net change keeps its accept (no re-arm → no review round), and a mechanical conflict/restack merge re-arms through
// the separate conflict cap (`rearm-review.mjs --round=conflict`) instead of an ordinary review round.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { runFixCli, isMechanicalConflictRound } from '../fix-run.mjs';
import { countRearmComments, REARM_COMMENT_MARKER } from '../../conveyor/rearm-review.mjs';
import { countConflictFixComments, CONFLICT_FIX_COMMENT_MARKER } from '../../conveyor/conflict-fix-round-count.mjs';

beforeEach(() => { vi.stubEnv('WE_RESOURCE_CUTOVER', 'shadow'); vi.stubEnv('WE_RESOURCE_SHADOW', 'off'); });
afterEach(() => vi.unstubAllEnvs());

const argv = ['--pr=7', '--session=fix-7', '--ref=lane/7-x', '--prompt-file=/p.md', '--provider=codex', '--repo=o/r', '--lane-repo=/w'];
function mk(heads, { merging: startMerging = false } = {}) {
  const calls = [];
  let merging = startMerging;
  const run = vi.fn((cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') return JSON.stringify({ title: 'T', body: 'B' });
    if (args.includes('acquire')) return 'noise\n/lanes/lane-5\n';
    if (args.includes('--absolute-git-dir')) return tmpdir();
    if (args.includes('--git-path')) return merging ? 'MERGE_HEAD' : '';
    if (args.includes('merge')) merging = true;
    if (args.includes('commit')) merging = false;
    if (args[0] === 'rev-parse') return heads.shift();
    return '';
  });
  const spawn = vi.fn(async () => ({ finalMessage: 'done' }));
  const pendingRearm = { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() };
  const write = vi.fn();
  return { calls, run, spawn, write, io: { recordPush: () => {}, run, pendingRearm,
    readComments: async () => [{ createdAt: '2026-01-01', body: '🔁 review — changes requested\nFIX THE THING' }],
    releaseClaim: async () => ({ released: [] }), recordOutcome: () => {}, recordRouted: () => ({}), appendLoopRow: () => {},
    removePrompt: () => {}, readPrompt: () => 'BRIEF', resolveProvider: () => ({ spawn }), weRoot: '/we', write, writeErr: () => {},
    fileExists: () => true } };
}
const rearmCall = m => m.calls.find(c => c[0] === 'node' && String(c[1]).endsWith('rearm-review.mjs'));

describe('fix-run hand-back: carry, conflict round, or ordinary re-arm', () => {
  it('same-patch push on an accepted PR → accept carried, rearm-review never runs (no review round consumed)', async () => {
    const m = mk(['aaa', 'bbb']);
    // The agent made a commit whose net change equals the reviewed head (e.g. a CI heal restoring the accepted tree).
    const run = (cmd, args, opts) => (args.includes('status') ? ' M card.md\0' : m.run(cmd, args, opts));
    const carryVerdict = vi.fn(async () => ({ carried: true, fromSha: 'a'.repeat(40), headSha: 'bbb', patchId: 'c'.repeat(40) }));
    const out = await runFixCli(argv, { ...m.io, run, carryVerdict });
    expect(out.code).toBe(0);
    expect(carryVerdict).toHaveBeenCalledWith(expect.objectContaining({ pr: '7', head: 'bbb', lanePath: '/lanes/lane-5' }));
    expect(rearmCall(m)).toBeUndefined();
    expect(out.result).toContain('accept carried');
    // Nothing the round counter reads was written.
    expect(countRearmComments([])).toBe(0);
  });
  it('an unproven carry re-arms exactly as before (ordinary round, no --round=conflict)', async () => {
    const m = mk(['aaa', 'bbb']);
    const run = (cmd, args, opts) => (args.includes('status') ? ' M card.md\0' : m.run(cmd, args, opts));
    const carryVerdict = vi.fn(async () => ({ carried: false, reason: 'net patch-id differs' }));
    expect((await runFixCli(argv, { ...m.io, run, carryVerdict })).code).toBe(0);
    expect(rearmCall(m)).toBeDefined();
    expect(rearmCall(m)).not.toContain('--round=conflict');
  });
  it('a clean dispatcher-planned merge with no agent edit → conflict round (separate cap), no carry attempt', async () => {
    const m = mk(['aaa', 'bbb']);
    const carryVerdict = vi.fn(async () => ({ carried: true }));
    expect((await runFixCli([...argv, '--merge-onto=lane/base'], { ...m.io, carryVerdict, readComments: async () => [] })).code).toBe(0);
    expect(rearmCall(m)).toContain('--round=conflict');
    expect(rearmCall(m)).toContain('--main-ref=lane/base'); // records the target it resolved against
    expect(carryVerdict).not.toHaveBeenCalled();
  });
  it('a retried hand-back keeps its conflict-round class (audit finding 2)', async () => {
    const m = mk(['aaa', 'bbb']);
    const store = {};
    m.io.pendingRearm = { read: () => store.v ?? null, write: (_r, _p, sha, _n, extra = {}) => { store.v = { sha, at: 0, ...(extra.conflictRound ? { conflictRound: true } : {}) }; }, clear: () => {} };
    const failing = (cmd, args, opts) => { if (cmd === 'node' && String(args[0]).endsWith('rearm-review.mjs')) throw new Error('gh down'); return m.run(cmd, args, opts); };
    await runFixCli([...argv, '--merge-onto=lane/base'], { ...m.io, run: failing, readComments: async () => [] });
    expect(store.v).toMatchObject({ sha: 'bbb', conflictRound: true });
    const m2 = mk(['bbb']);
    const carryVerdict = vi.fn(async () => ({ carried: true }));
    await runFixCli(argv, { ...m2.io, pendingRearm: m.io.pendingRearm, carryVerdict });
    expect(rearmCall(m2)).toContain('--round=conflict');
    expect(carryVerdict).not.toHaveBeenCalled();
  });
  it('conflict re-arm does not bump the review round: only the ordinary marker is counted as a round', () => {
    const trusted = body => ({ author: { login: 'chalbert' }, body });
    const thread = [trusted(`${CONFLICT_FIX_COMMENT_MARKER}\n\nA mechanical conflict-resolution round.`)];
    expect(countRearmComments(thread)).toBe(0);
    expect(countConflictFixComments(thread)).toBe(1);
    expect(countRearmComments([...thread, trusted(`${REARM_COMMENT_MARKER}\n\nrepaired`)])).toBe(1);
  });
  it.each([
    [{ mergeOnto: 'main', conflicted: true, unmerged: ['a.md'], unstaged: ['a.md'] }, true],
    [{ mergeOnto: 'main', conflicted: true, unmerged: ['a.md'], unstaged: ['a.md', 'b.mjs'] }, false],
    [{ mergeOnto: 'main', conflicted: true, unmerged: [], unstaged: [] }, false],
    [{ mergeOnto: 'main', mergeCommitted: true, agentPaths: [] }, true],
    [{ mergeOnto: 'main', mergeCommitted: true, agentPaths: ['b.mjs'] }, false],
    [{ mergeOnto: 'main', mergeCommitted: false, agentPaths: [] }, false],
    [{ mergeOnto: null, conflicted: true, unmerged: ['a.md'], unstaged: ['a.md'] }, false],
    [{ mergeOnto: 'main', repairKind: 'ci-heal', mergeCommitted: true }, false],
  ])('isMechanicalConflictRound(%j) → %s', (facts, expected) => {
    expect(isMechanicalConflictRound(facts)).toBe(expected);
  });
});
