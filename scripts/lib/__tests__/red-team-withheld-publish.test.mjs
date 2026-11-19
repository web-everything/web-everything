// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { needsPublish, publishStoredRedTeamResult, renderMinimalRedTeamComment } from '../red-team-withheld-publish.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
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
    expect(io.writeStatus).toHaveBeenCalledWith(expect.objectContaining({ legacyHoldPublished: true }));
    expect(io.status.legacyHoldPublished).toBe(true);
    expect(io.status.needsYouPublished).toBeUndefined();
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.status.legacyHoldPublished).toBe(true);
  });
  it('an agreeing posted comment is left alone; only the empty seal is recorded (it lifts the publication-pending hold)', () => {
    const io = harness(legacy(), { readSeatRow: () => seatRow(),
      listComments: () => [{ author: { login: 'web-everything' },
        body: `${redTeamMarker(42, head)}\n### Post-accept red team — no break found` }] });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'skipped' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.writeStatus).toHaveBeenCalledTimes(1);
    expect(io.writeStatus.mock.calls[0][0]).toMatchObject({ result: 'ran', sealedBreaks: [] });
    expect(io.writeStatus.mock.calls[0][0]).not.toHaveProperty('legacyHoldPublished');
    expect(io.publishNeedsYou).not.toHaveBeenCalled();
    // A second pass finds the seal already recorded and writes nothing more.
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'skipped' });
    expect(io.writeStatus).toHaveBeenCalledTimes(1);
  });
  const posted = (text = '### Post-accept red team — no break found', login = 'web-everything') =>
    [{ author: { login }, body: `${redTeamMarker(42, head)}\n${text}` }];
  const changesRow = () => seatRow({ foldedVerdict: 'changes', confirmedMissCount: 1, findings: [confirmedFinding] });
  const confirmedLine = '1. [**confirmed**] (correctness, impact?) `scripts/x.mjs:12` — Confirmed boundary check bypass';
  it('holds and alerts when a posted comment drops a recovered confirmed break', () => {
    const io = harness(legacy(), { readSeatRow: changesRow, listComments: () => posted() });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'red-team-legacy-ran-unreadable', repo: 'o/n', pr: 42, head }));
    expect(io.status.legacyHoldPublished).toBe(true);
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
  });
  const fullBody = (findings = [confirmedFinding], extra = {}) => renderRedTeamComment({ pr: 42, rev: head,
    provider: 'claude', model: 'test-model', findings, recheckStatus: 'ok', foldedVerdict: 'changes', ...extra });
  it('holds when the posted comment shows a DIFFERENT confirmed break with the same count', () => {
    const other = { ...confirmedFinding, summary: 'Unrelated confirmed defect', file: 'scripts/y.mjs', line: 99 };
    const io = harness(legacy(), { readSeatRow: changesRow,
      listComments: () => [{ author: { login: 'web-everything' }, body: fullBody([other]) }] });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
  });
  it('holds when only the confirmed line, category or summary differs', () => {
    for (const change of [{ line: 13 }, { category: 'security' }, { summary: 'Confirmed boundary check bypass!' }]) {
      const io = harness(legacy(), { readSeatRow: changesRow,
        listComments: () => [{ author: { login: 'web-everything' }, body: fullBody([{ ...confirmedFinding, ...change }]) }] });
      expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    }
  });
  describe('a posted comment cannot downgrade the stored break\'s gate outcome', () => {
    const rich = { ...confirmedFinding, impactIfUnfixed: 'broken', findingClass: 'security-reachable-today',
      classBasis: 'reproduced', alsoClasses: ['live-reproduced'], securityReachableToday: true };
    const richRow = () => seatRow({ foldedVerdict: 'changes', confirmedMissCount: 1, findings: [rich] });
    const run = postedFinding => {
      const io = harness(legacy(), { readSeatRow: richRow,
        listComments: () => [{ author: { login: 'web-everything' }, body: fullBody([postedFinding]) }] });
      return { io, out: publishStoredRedTeamResult(io) };
    };
    it('skips quietly when impact, class, extra classes and security flag all agree', () => {
      const { io, out } = run(rich);
      expect(out).toEqual({ status: 'skipped' });
      expect(io.publishNeedsYou).not.toHaveBeenCalled();
    });
    it.each([
      ['impact downgraded', { impactIfUnfixed: 'cosmetic' }],
      ['class downgraded', { findingClass: 'coverage-or-style', alsoClasses: [], securityReachableToday: false }],
      ['class dropped', { findingClass: undefined, classBasis: undefined }],
      ['extra classes dropped', { alsoClasses: [] }],
      ['security flag dropped', { securityReachableToday: false }],
    ])('holds and alerts when the posted comment has %s', (_name, change) => {
      const { io, out } = run({ ...rich, ...change });
      expect(out).toEqual({ status: 'held' });
      expect(io.postComment).not.toHaveBeenCalled();
      expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
      expect(io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ kind: 'red-team-legacy-ran-unreadable' }));
    });
  });
  it('skips quietly when the posted comment is the full rendering of the recovered break', () => {
    const io = harness(legacy(), { readSeatRow: changesRow,
      listComments: () => [{ author: { login: 'web-everything' }, body: fullBody() }] });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'skipped' });
    expect(io.publishNeedsYou).not.toHaveBeenCalled();
  });
  it('holds when the posted comment is the scrub-fallback rendering: its text differs from the stored break', () => {
    const minimal = renderMinimalRedTeamComment({ pr: 42, rev: head, findings: [confirmedFinding] });
    const io = harness(legacy(), { readSeatRow: changesRow,
      listComments: () => [{ author: { login: 'web-everything' }, body: minimal }] });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
  });
  const twoRow = () => seatRow({ foldedVerdict: 'changes', confirmedMissCount: 2, findings: [confirmedFinding,
    { ...confirmedFinding, summary: 'Second confirmed defect', file: 'scripts/y.mjs', line: 99 }] });
  it('skips when the posted confirmed findings appear in a different order', () => {
    const [a, b] = twoRow().findings;
    const io = harness(legacy(), { readSeatRow: twoRow,
      listComments: () => [{ author: { login: 'web-everything' }, body: fullBody([b, a]) }] });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'skipped' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.writeStatus).toHaveBeenCalledTimes(1); // the stored breaks are sealed; nothing else is recorded
    expect(io.status.sealedBreaks).toHaveLength(2);
    expect(io.publishNeedsYou).not.toHaveBeenCalled();
  });
  it('holds for the location-free fallback rendering: the stored break has a location the comment dropped', () => {
    const body = renderMinimalRedTeamComment({ pr: 42, rev: head, findings: [confirmedFinding], omitLocation: true });
    expect(parseRedTeamComment(body).findings[0]).toMatchObject({ confirmed: true, file: null });
    const io = harness(legacy(), { readSeatRow: changesRow,
      listComments: () => [{ author: { login: 'web-everything' }, body }] });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
  });
  it('holds when an existing clear comment matches a lossy rendering of a confirmed break', () => {
    // A blank file makes every rendering drop the break, so both sides parse to "no findings".
    const lossy = seatRow({ foldedVerdict: 'changes', confirmedMissCount: 1,
      findings: [{ summary: 's', file: ' ', category: 'correctness', confirmedByRecheck: true }] });
    const io = harness(legacy(), { readSeatRow: () => lossy, listComments: () => posted() });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ kind: 'red-team-legacy-ran-unreadable' }));
  });
  it('holds when a trusted marker comment does not parse to this head', () => {
    const io = harness(legacy(), { readSeatRow: changesRow, redTeamCommentPosted: () => true });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
  });
  it('carries the seat row re-check status into the recovered comment', () => {
    const io = harness(legacy(), { readSeatRow: () => seatRow({ foldedVerdict: 'changes',
      confirmedMissCount: 1, findings: [confirmedFinding], recheckStatus: 'ok' }) });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'posted' });
    const body = io.postComment.mock.calls[0][0].body;
    expect(body).toContain('re-check ok');
    expect(body).not.toContain('re-check error');
  });
  it('a prior publish-failed alert does not silence the legacy hold alert', () => {
    const io = harness({ ...legacy(), needsYouPublished: true, publishAttempts: 2 }, { readSeatRow: () => null });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ kind: 'red-team-legacy-ran-unreadable' }));
    expect(io.status).toMatchObject({ needsYouPublished: true, legacyHoldPublished: true });
  });
  it('a failing alert write is not counted as a publish attempt', () => {
    const io = harness(legacy(), { readSeatRow: changesRow, listComments: () => posted(),
      publishNeedsYou: vi.fn(() => { throw Error('feed down'); }) });
    expect(() => publishStoredRedTeamResult(io)).toThrow('feed down');
    expect(io.status.publishAttempts).toBeUndefined();
    expect(io.status.legacyHoldPublished).toBeUndefined();
    expect(io.postComment).not.toHaveBeenCalled();
  });
  it('holds when the posted comment shows a confirmed break the recovered row does not have', () => {
    const io = harness(legacy(), { readSeatRow: () => seatRow(), listComments: () => posted(confirmedLine) });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.postComment).not.toHaveBeenCalled();
  });
  it('skips quietly when a posted comment agrees with the recovered confirmed breaks', () => {
    const io = harness(legacy(), { readSeatRow: changesRow,
      listComments: () => [{ author: { login: 'web-everything' }, body: fullBody() }] });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'skipped' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).not.toHaveBeenCalled();
    expect(io.writeStatus).toHaveBeenCalledTimes(1); // only the seal is persisted
    expect(io.status.sealedBreaks).toHaveLength(1);
    expect(io.status.legacyHoldPublished).toBeUndefined();
  });
  it.each([
    ['seat row missing', () => null],
    ['seat reader throws', () => { throw Error('seat unreadable'); }],
    ['seat row from another head', () => seatRow({ rev: 'b'.repeat(40) })],
  ])('an already-posted legacy ran with an unreadable row is held with an alert, never cleared by the comment: %s', (_name, readSeatRow) => {
    // PR #6622 operator send-back item 1: the exact-head seat row is the single authority. With no readable row nothing
    // proves the posted comment shows its breaks, so the head is held (the comment cannot lift it).
    const io = harness(legacy(), { readSeatRow, listComments: () => posted() });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'held' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ kind: 'red-team-legacy-ran-unreadable' }));
    expect(io.status.legacyHoldPublished).toBe(true);
  });
  it('a forged marker from an untrusted author neither skips nor validates', () => {
    const io = harness(legacy(), { readSeatRow: changesRow, listComments: () => posted('', 'attacker') });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'posted' });
    expect(io.postComment).toHaveBeenCalledTimes(1);
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
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'retry' });
    expect(io.status.publishAttempts).toBe(1);
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'failed' });
    expect(io.status).toMatchObject({ publishAttempts: 2, needsYouPublished: true });
    expect(publishStoredRedTeamResult(io)).toEqual({ status: 'failed' });
    expect(io.postComment).not.toHaveBeenCalled();
    expect(io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'red-team-publish-failed', repo: 'o/n', pr: 42, head }));
  });
});
