// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { needsPublish, publishStoredRedTeamResult } from '../red-team-withheld-publish.mjs';
import { parseRedTeamComment, redTeamMarker } from '../red-team-gate.mjs';

const head = 'a'.repeat(40);
const stored = (comment = 'withheld') => ({ repo: 'o/n', pr: 42, head, status: 'finished',
  result: { status: 'ran', comment, foldedVerdict: 'changes', confirmedMissCount: 1,
    findings: [{ summary: 'unsafe summary', file: 'scripts/x.mjs', line: 12, category: 'correctness', confirmed: true }] } });
function harness(status = stored(), extra = {}) {
  const io = { status, readStatus: () => io.status, withLock: (_path, fn) => fn(), listComments: () => [], postComment: vi.fn(), writeStatus: vi.fn(next => { io.status = next; }),
    publishNeedsYou: vi.fn(), now: () => '2026-10-24T12:00:00.000Z', ...extra };
  return io;
}
const legacy = (result = 'ran') => ({ repo: 'o/n', pr: 42, head, status: 'finished', result });
const seatRow = (extra = {}) => ({ rev: head, foldedVerdict: 'accept', confirmedMissCount: 0,
  findings: [], provider: 'claude', model: 'test-model', callId: 'legacy-red-team-call', ...extra });
const confirmedFinding = { summary: 'Confirmed boundary check bypass', file: 'scripts/x.mjs',
  line: 12, category: 'correctness', confirmedByRecheck: true };

describe('legacy bare-string red-team publication', () => {
  it('needs publication for a finished legacy ran result', () => {
    expect(needsPublish(legacy())).toBe(true);
    expect(needsPublish({ ...legacy(), status: 'running' })).toBe(false);
  });
  it.each(['skipped', 'not-owed', 'failed'])('does not publish a legacy %s result', result => {
    expect(needsPublish(legacy(result))).toBe(false);
  });
  it('recovers an accept from the exact-head seat row and persists the posted result', () => {
    const readSeatRow = vi.fn(() => seatRow());
    const io = harness(legacy(), { readSeatRow });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'posted' });
    expect(readSeatRow).toHaveBeenCalledTimes(1);
    expect(readSeatRow).toHaveBeenCalledWith({ repo: 'o/n', pr: 42, head });
    expect(io.postComment).toHaveBeenCalledTimes(1);
    expect(io.postComment).toHaveBeenCalledWith({ repo: 'o/n', pr: 42, body: expect.any(String) });
    const body = io.postComment.mock.calls[0][0].body;
    expect(body).toContain(redTeamMarker(42, head));
    expect(parseRedTeamComment(body)).toEqual({ pr: 42, rev: head, findings: [] });
    expect(body).toContain('recorded verdict `accept`');
    expect(io.writeStatus).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ status: 'ran', comment: 'posted', foldedVerdict: 'accept' }),
    }));
    expect(io.status.result).toMatchObject({ status: 'ran', comment: 'posted', foldedVerdict: 'accept' });
    expect(io.publishNeedsYou).not.toHaveBeenCalled();
  });
  it('retains a confirmed break when recovering a changes verdict', () => {
    const io = harness(legacy(), { readSeatRow: () => seatRow({ foldedVerdict: 'changes',
      confirmedMissCount: 1, findings: [confirmedFinding] }) });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'posted' });
    expect(io.postComment).toHaveBeenCalledTimes(1);
    const body = io.postComment.mock.calls[0][0].body;
    expect(body).toContain(redTeamMarker(42, head));
    expect(body).toContain('recorded verdict `changes`');
    expect(parseRedTeamComment(body)).toMatchObject({ pr: 42, rev: head,
      findings: [{ summary: confirmedFinding.summary, file: confirmedFinding.file,
        line: confirmedFinding.line, category: confirmedFinding.category, confirmed: true }] });
    expect(io.status.result).toMatchObject({ status: 'ran', comment: 'posted', foldedVerdict: 'changes' });
  });
  it.each([
    ['missing seat row', () => null],
    ['seat reader throws', () => { throw Error('seat unreadable'); }],
    ['accept row from another head', () => seatRow({ rev: 'b'.repeat(40) })],
    ['missing findings', () => seatRow({ findings: undefined })],
    ['non-array findings', () => seatRow({ findings: {} })],
    ['missing folded verdict', () => seatRow({ foldedVerdict: undefined })],
    ['invalid folded verdict', () => seatRow({ foldedVerdict: 'clear' })],
    ['count exceeds confirmed findings', () => seatRow({ confirmedMissCount: 1 })],
    ['changes verdict with zero confirmed findings', () => seatRow({ foldedVerdict: 'changes', confirmedMissCount: 0, findings: [] })],
    ['needs-human verdict with zero confirmed findings', () => seatRow({ foldedVerdict: 'needs-human', confirmedMissCount: 0, findings: [] })],
    ['count omits a confirmed finding', () => seatRow({ foldedVerdict: 'changes',
      confirmedMissCount: 0, findings: [confirmedFinding] })],
  ])('holds unreadable legacy evidence and alerts only once: %s', (_name, readSeatRow) => {
    const io = harness(legacy(), { readSeatRow: vi.fn(readSeatRow) });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.readSeatRow).toHaveBeenCalledWith({ repo: 'o/n', pr: 42, head });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'red-team-legacy-ran-unreadable', repo: 'o/n', pr: 42, head,
    }));
    expect(io.writeStatus).toHaveBeenCalledWith(expect.objectContaining({ needsYouPublished: true }));
    expect(io.status.needsYouPublished).toBe(true);
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.status.needsYouPublished).toBe(true);
  });
  it('persists posted state when a trusted comment already exists without posting again', () => {
    const io = harness(legacy(), { readSeatRow: () => seatRow(),
      listComments: () => [{ author: { login: 'web-everything' },
        body: `${redTeamMarker(42, head)}\n### Post-accept red team — no break found` }] });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'skipped' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.writeStatus).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ status: 'ran', comment: 'posted' }),
    }));
    expect(io.status.result).toMatchObject({ status: 'ran', comment: 'posted' });
    expect(io.publishNeedsYou).not.toHaveBeenCalled();
  });
});

describe('stored red-team publication', () => {
  it('only publishes finished ran results with withheld/error comments', () => {
    for (const comment of ['withheld', 'error']) expect(needsPublish(stored(comment))).toBe(true);
    for (const comment of ['posted', 'deduped', undefined]) {
      const status = stored();
      status.result.comment = comment;
      expect(needsPublish(status)).toBe(false);
    }
    expect(needsPublish({ ...stored(), status: 'running' })).toBe(false);
    expect(needsPublish({ ...stored(), result: { status: 'error', comment: 'error' } })).toBe(false);
    expect(needsPublish(null)).toBe(false);
  });
  it('withheld full body becomes minimal and the gate sees the confirmed break', () => {
    const io = harness(stored(), { renderFull: () => 'unsafe summary', scrub: body => body.includes('unsafe summary') ? ['secret'] : [] });
    expect(publishStoredRedTeamResult(io).status).toBe('posted');
    const body = io.postComment.mock.calls[0][0].body;
    expect(body).not.toContain('unsafe summary');
    expect(body).toContain('[summary withheld: failed the secret scrub]');
    expect(parseRedTeamComment(body).findings).toEqual([expect.objectContaining({ confirmed: true, file: 'scripts/x.mjs', line: 12 })]);
    expect(io.status).toMatchObject({ publishedAt: '2026-10-24T12:00:00.000Z', result: { comment: 'posted' } });
  });
  it('removes unsafe locations too, retaining parseable confirmed breaks', () => {
    const io = harness(stored(), { renderFull: () => 'unsafe summary', scrub: body => /unsafe summary|scripts\/x/.test(body) ? ['secret'] : [] });
    publishStoredRedTeamResult(io);
    expect(parseRedTeamComment(io.postComment.mock.calls[0][0].body).findings).toEqual([expect.objectContaining({ confirmed: true, file: null })]);
  });
  it('rebuilds full findings from stored confirmation flags', () => {
    const io = harness();
    publishStoredRedTeamResult(io);
    expect(parseRedTeamComment(io.postComment.mock.calls[0][0].body).findings[0].confirmed).toBe(true);
  });
  it('error retries once, then escalates exactly once and never posts a third time', () => {
    const io = harness(stored('error'), { postComment: vi.fn(() => { throw Error('gh failed'); }) });
    expect(publishStoredRedTeamResult(io)).toMatchObject({ status: 'retry' });
    expect(io.status.publishAttempts).toBe(1);
    expect(publishStoredRedTeamResult(io)).toMatchObject({ status: 'failed' });
    expect(io.status).toMatchObject({ publishAttempts: 2, needsYouPublished: true });
    expect(publishStoredRedTeamResult(io)).toMatchObject({ status: 'failed' });
    expect(io.postComment).toHaveBeenCalledTimes(2);
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ kind: 'red-team-publish-failed', repo: 'o/n', pr: 42, head, reason: expect.any(String) }));
  });
  it('trusted existing marker prevents a duplicate, forged marker does not', () => {
    for (const login of ['web-everything', 'attacker']) {
      const io = harness(stored(), { listComments: () => [{ author: { login }, body: redTeamMarker(42, head) }] });
      publishStoredRedTeamResult(io);
      expect(io.postComment).toHaveBeenCalledTimes(login === 'attacker' ? 1 : 0);
    }
  });
  it('unreadable comments fail closed and exhausting the scrub escalates without posting', () => {
    const io = harness(stored(), { listComments: () => { throw Error('unreadable'); } });
    expect(publishStoredRedTeamResult(io).status).toBe('retry');
    expect(io.postComment).not.toHaveBeenCalled();
    const scrubbed = harness(stored(), { scrub: () => ['secret'] });
    publishStoredRedTeamResult(scrubbed);
    publishStoredRedTeamResult(scrubbed);
    expect(scrubbed.postComment).not.toHaveBeenCalled();
    expect(scrubbed.publishNeedsYou).toHaveBeenCalledTimes(1);
  });
});

describe('publication with fresh disk state under the shared lock', () => {
  function disk(run) {
    const dir = mkdtempSync(join(tmpdir(), 'red-team-publish-'));
    const path = join(dir, `o%2Fn-42-${head}.json`);
    writeFileSync(path, JSON.stringify(stored()));
    try { run({ dir, path, read: () => JSON.parse(readFileSync(path, 'utf8')) }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('a second caller with a stale snapshot never posts or overwrites the fresh status', () => disk(({ dir, path, read }) => {
    const snapshot = stored();
    const postComment = vi.fn(() => expect(existsSync(`${path}.lock`)).toBe(true));
    const io = { status: snapshot, statusDir: dir, postComment, listComments: () => [] };
    expect(publishStoredRedTeamResult(io).status).toBe('posted');
    const fresh = read();
    expect(publishStoredRedTeamResult(io).status).toBe('skipped');
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(read()).toEqual(fresh);
  }));
  it('three callers with the same stale snapshot preserve attempts and escalate exactly once', () => disk(({ dir, read }) => {
    const postComment = vi.fn(() => { throw Error('failed'); });
    const publishNeedsYou = vi.fn();
    const io = { status: stored(), statusDir: dir, listComments: () => [], postComment, publishNeedsYou };
    expect(publishStoredRedTeamResult(io).status).toBe('retry');
    expect(publishStoredRedTeamResult(io).status).toBe('failed');
    expect(publishStoredRedTeamResult(io).status).toBe('failed');
    expect(read()).toMatchObject({ publishAttempts: 2, needsYouPublished: true });
    expect(postComment).toHaveBeenCalledTimes(2);
    expect(publishNeedsYou).toHaveBeenCalledTimes(1);
  }));
  it('unreadable fresh status never publishes from the supplied snapshot', () => disk(({ dir, path }) => {
    writeFileSync(path, '{');
    const postComment = vi.fn();
    expect(() => publishStoredRedTeamResult({ status: stored(), statusDir: dir, postComment })).toThrow();
    expect(postComment).not.toHaveBeenCalled();
  }));
});

describe('legacy recovery never publishes an unparseable break', () => {
  it('retries then escalates instead of posting a body that drops a confirmed finding', () => {
    const row = { rev: head, foldedVerdict: 'changes', confirmedMissCount: 1, provider: 'p', model: 'm', callId: 'c',
      findings: [{ summary: 's', file: ' ', category: 'correctness', confirmedByRecheck: true }] };
    const io = harness({ repo: 'o/n', pr: 42, head, status: 'finished', result: 'ran' }, { readSeatRow: () => row });
    expect(publishStoredRedTeamResult(io).status).not.toBe('posted');
    expect(io.postComment).not.toHaveBeenCalled();
  });
});

describe('legacy recovery against an existing comment', () => {
  it('holds and alerts when the posted comment shows no break but the stored verdict has one', () => {
    const row = { rev: head, foldedVerdict: 'changes', confirmedMissCount: 1, provider: 'p', model: 'm', callId: 'c',
      findings: [{ summary: 's', file: 'a.mjs', line: 1, category: 'correctness', confirmedByRecheck: true }] };
    const clean = { body: `${redTeamMarker(42, head)}\n### Post-accept red team\n\nno break found`, user: { login: 'github-actions[bot]' } };
    const io = harness({ repo: 'o/n', pr: 42, head, status: 'finished', result: 'ran' }, { readSeatRow: () => row, listComments: () => [clean], redTeamCommentPosted: () => true });
    expect(publishStoredRedTeamResult(io).status).toBe('held');
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
  });
});
