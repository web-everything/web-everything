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
