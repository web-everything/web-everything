import { describe, expect, it, vi } from 'vitest';
import { writeVerdict } from '../verdict-write-gate.mjs';
const head = 'a'.repeat(40), moved = 'b'.repeat(40);
const live = (headRefOid = head, state = 'OPEN') => ({ headRefOid, state });
function fixture() {
  const write = vi.fn().mockResolvedValue({ ok: true });
  const io = { readPr: vi.fn().mockResolvedValue(live()), recordIncident: vi.fn() };
  return { repo: 'owner/repo', pr: 42, expectedHead: head, kind: 'review', write, io };
}
const incident = (args, actualHead) => ({
  kind: 'verdict-under-move', repo: args.repo, pr: args.pr,
  expectedHead: head, actualHead, writeKind: args.kind,
});
describe('writeVerdict', () => {
  it.each([undefined, null, 'abc', 'A'.repeat(39), 'g'.repeat(40), 123, 'A'.repeat(40)])(
    'refuses missing or invalid expected head %s without reading or writing', async expectedHead => {
      const args = fixture();
      expect(await writeVerdict({ ...args, expectedHead })).toEqual({ ok: false, refused: 'refused-no-expected-head' });
      expect([args.io.readPr, args.write].map(fn => fn.mock.calls.length)).toEqual([0, 0]);
    },
  );
  it.each(['repo', 'pr', 'kind', 'write'])('refuses missing %s safely', async key => {
    const args = fixture();
    expect(await writeVerdict({ ...args, [key]: undefined })).toEqual({ ok: false, refused: 'refused-bad-input' });
    expect([args.io.readPr, args.write].map(fn => fn.mock.calls.length)).toEqual([0, 0]);
  });
  it('refuses a moved head without writing and normalizes actualHead', async () => {
    const args = fixture();
    args.io.readPr.mockResolvedValue(live(moved.toUpperCase()));
    expect(await writeVerdict(args)).toEqual({ ok: false, refused: 'head-moved', actualHead: moved });
    expect(args.write).not.toHaveBeenCalled();
  });
  it.each(['CLOSED', 'MERGED'])('refuses %s without writing', async state => {
    const args = fixture();
    args.io.readPr.mockResolvedValue(live(moved, state));
    expect(await writeVerdict(args)).toEqual({ ok: false, refused: 'not-open' });
    expect(args.write).not.toHaveBeenCalled();
  });
  it('awaits exactly one write, accepts uppercase live heads, and reads twice', async () => {
    const args = fixture();
    let finish;
    args.write.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    args.io.readPr.mockResolvedValue(live(head.toUpperCase()));
    const pending = writeVerdict(args);
    await vi.waitFor(() => expect(args.write).toHaveBeenCalledTimes(1));
    expect(args.io.readPr).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    expect(await pending).toEqual({ ok: true, written: true, result: { ok: true }, verdictUnderMove: false });
    expect(args.io.readPr).toHaveBeenCalledTimes(2);
    expect(args.io.readPr).toHaveBeenNthCalledWith(1, { repo: args.repo, pr: args.pr });
    expect(args.io.recordIncident).not.toHaveBeenCalled();
    expect(args.write).toHaveBeenCalledTimes(1);
  });
  it.each([live(moved), live(head, 'CLOSED'), live(head, 'MERGED')])(
    'records a post-write move or closure %j with one write', async post => {
      const args = fixture();
      args.io.readPr.mockResolvedValueOnce(live()).mockResolvedValueOnce(post);
      expect(await writeVerdict(args)).toMatchObject({
        ok: false, code: 'verdict-under-move', written: true, result: { ok: true }, verdictUnderMove: true,
        incidentRecorded: true, actualHead: post.headRefOid,
      });
      expect(args.io.recordIncident).toHaveBeenCalledTimes(1);
      expect(args.io.recordIncident).toHaveBeenCalledWith(incident(args, post.headRefOid));
      expect(args.write).toHaveBeenCalledTimes(1);
    },
  );
  const unreadable = [null, 'not JSON', {}, [], { headRefOid: head },
    live('abc'), live('g'.repeat(40)), live(123), live(head, ''), live(head, null)];
  it.each(unreadable)('fails closed on unreadable pre-read %j', async value => {
    const args = fixture();
    args.io.readPr.mockResolvedValue(value);
    expect(await writeVerdict(args)).toEqual({ ok: false, refused: 'unreadable' });
    expect(args.write).not.toHaveBeenCalled();
  });
  it('fails closed on a throwing pre-read', async () => {
    const args = fixture();
    args.io.readPr.mockRejectedValue(new Error('offline'));
    expect(await writeVerdict(args)).toEqual({ ok: false, refused: 'unreadable' });
    expect(args.write).not.toHaveBeenCalled();
  });
  it.each(['throws', ...unreadable])('detects unreadable post-read %j after one write', async value => {
    const args = fixture();
    args.io.readPr.mockResolvedValueOnce(live());
    if (value === 'throws') args.io.readPr.mockRejectedValueOnce(new Error('offline'));
    else args.io.readPr.mockResolvedValueOnce(value);
    expect(await writeVerdict(args)).toMatchObject({
      ok: false, code: 'verdict-under-move', written: true, result: { ok: true }, verdictUnderMove: true, incidentRecorded: true,
    });
    expect(args.io.recordIncident).toHaveBeenCalledTimes(1);
    expect(args.io.recordIncident).toHaveBeenCalledWith(incident(args, undefined));
    expect(args.write).toHaveBeenCalledTimes(1);
  });
  it('never memoizes evidence across calls', async () => {
    const args = fixture();
    expect((await writeVerdict(args)).verdictUnderMove).toBe(false);
    expect(args.io.readPr).toHaveBeenCalledTimes(2);
    args.io.readPr.mockResolvedValue(live(moved));
    expect((await writeVerdict(args)).refused).toBe('head-moved');
    expect(args.io.readPr).toHaveBeenCalledTimes(3);
    expect(args.write).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, 'recorder'])('refuses missing or invalid recorder %s before IO', async recorder => {
    const args = fixture();
    args.io.recordIncident = recorder;
    expect(await writeVerdict(args)).toEqual({ ok: false, refused: 'refused-bad-input' });
    expect([args.io.readPr, args.write].map(fn => fn.mock.calls.length)).toEqual([0, 0]);
  });
  it.each(['sync', 'async', 'returned'])('surfaces incident recorder failure (%s)', async mode => {
    const args = fixture();
    args.io.readPr.mockResolvedValueOnce(live()).mockResolvedValueOnce(live(moved));
    args.io.recordIncident.mockImplementation(() => {
      if (mode === 'returned') return { ok: false, error: 'incident failed' };
      if (mode === 'sync') throw new Error('incident failed');
      return Promise.reject(new Error('incident failed'));
    });
    expect(await writeVerdict(args)).toEqual({
      ok: false, code: 'incident-record-failed', written: true, verdictUnderMove: true, incidentRecorded: false,
      incidentError: 'incident failed', result: { ok: true }, actualHead: moved,
    });
    expect([args.write, args.io.recordIncident].map(fn => fn.mock.calls.length)).toEqual([1, 1]);
  });
  it.each([live(moved), live(head, 'CLOSED'), live(head, 'MERGED'), null, 'throws'])(
    'records incident after throwing write and changed or unreadable post-read %j', async post => {
      const args = fixture();
      const error = new Error('lost ack');
      args.write.mockImplementation(() => { throw error; });
      args.io.readPr.mockResolvedValueOnce(live());
      if (post === 'throws') args.io.readPr.mockRejectedValueOnce(new Error('offline'));
      else args.io.readPr.mockResolvedValueOnce(post);
      await expect(writeVerdict(args)).rejects.toBe(error);
      expect([args.write, args.io.readPr, args.io.recordIncident].map(fn => fn.mock.calls.length)).toEqual([1, 2, 1]);
      expect(args.io.recordIncident).toHaveBeenCalledWith({ ...incident(args, post?.headRefOid), writeThrew: true });
    },
  );
  it.each(['sync', 'async', 'returned'])('attaches recorder failure to original write error (%s)', async mode => {
    const args = fixture();
    const error = new Error('lost ack');
    args.write.mockRejectedValue(error);
    args.io.readPr.mockResolvedValueOnce(live()).mockResolvedValueOnce(live(moved));
    args.io.recordIncident.mockImplementation(() => {
      if (mode === 'returned') return { ok: false, error: 'incident failed' };
      if (mode === 'sync') throw new Error('incident failed');
      return Promise.reject(new Error('incident failed'));
    });
    await expect(writeVerdict(args)).rejects.toBe(error);
    expect(error.incidentError).toBe('incident failed');
    expect(error.incidentRecorded).toBe(false);
    expect([args.write, args.io.readPr, args.io.recordIncident].map(fn => fn.mock.calls.length)).toEqual([1, 2, 1]);
  });
  it.each([null, undefined, 'lost ack', 42, Object.freeze(new Error('frozen'))])(
    'preserves primitive or frozen write failure %s when incident recording fails', async error => {
      const args = fixture();
      args.write.mockImplementation(() => { throw error; });
      args.io.readPr.mockResolvedValueOnce(live()).mockResolvedValueOnce(live(moved));
      args.io.recordIncident.mockRejectedValue(new Error('incident failed'));
      await expect(writeVerdict(args)).rejects.toMatchObject({
        message: error?.message ?? String(error), cause: error,
        incidentRecorded: false, incidentError: 'incident failed',
      });
      expect([args.write, args.io.readPr, args.io.recordIncident].map(fn => fn.mock.calls.length)).toEqual([1, 2, 1]);
    },
  );
  it.each([null, undefined, 'bad', 42, { ok: false, reason: 'denied' },
    { ok: false, error: 'offline' }, { ok: false }, { ok: false, reason: '', error: 'ignored' }])(
    'fails closed on unsuccessful write result %j, including after a move', async result => {
      const args = fixture();
      const reason = result?.reason ?? result?.error ?? 'non-object write result';
      args.write.mockResolvedValue(result);
      expect(await writeVerdict(args)).toEqual({ ok: false, code: 'write-failed', written: false, reason, result });
      expect(args.io.readPr).toHaveBeenCalledTimes(2);
      expect(args.io.recordIncident).not.toHaveBeenCalled();
      args.io.readPr.mockResolvedValueOnce(live()).mockResolvedValueOnce(live(moved));
      expect(await writeVerdict(args)).toEqual({
        ok: false, code: 'verdict-under-move', written: true, verdictUnderMove: true,
        incidentRecorded: true, result, actualHead: moved, writeReason: reason,
      });
      expect(args.io.recordIncident).toHaveBeenCalledWith(incident(args, moved));
      expect(args.io.readPr).toHaveBeenCalledTimes(4);
    },
  );
  it('accepts an object write result without an ok field', async () => {
    const args = fixture();
    args.write.mockResolvedValue({ id: 1 });
    expect(await writeVerdict(args)).toEqual({ ok: true, written: true, result: { id: 1 }, verdictUnderMove: false });
  });
  it('rethrows original write error after unchanged post-read without incident or retry', async () => {
    const args = fixture();
    const error = new Error('write failed');
    args.write.mockRejectedValue(error);
    await expect(writeVerdict(args)).rejects.toBe(error);
    expect(args.write).toHaveBeenCalledTimes(1);
    expect(args.io.readPr).toHaveBeenCalledTimes(2);
    expect(args.io.recordIncident).not.toHaveBeenCalled();
  });
  it.each(['success', 'invalid JSON', 'exec error'])('uses the default gh reader (%s)', async mode => {
    const args = fixture();
    delete args.io.readPr;
    args.io.execFileImpl = vi.fn((bin, argv, options, callback) => {
      callback(mode === 'exec error' ? new Error('gh failed') : null,
        mode === 'invalid JSON' ? '{' : JSON.stringify(live()));
    });
    const result = await writeVerdict(args);
    const success = mode === 'success';
    expect(result).toEqual(success
      ? { ok: true, written: true, result: { ok: true }, verdictUnderMove: false }
      : { ok: false, refused: 'unreadable' });
    expect(args.write).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(args.io.execFileImpl).toHaveBeenCalledTimes(success ? 2 : 1);
    for (const [bin, argv, options] of args.io.execFileImpl.mock.calls) {
      expect(bin).toBe('gh');
      expect(argv).toEqual(['pr', 'view', String(args.pr), '--repo', args.repo, '--json', 'headRefOid,state']);
      expect(options.shell).toBeUndefined();
      expect(options.maxBuffer).toBeGreaterThan(0);
      expect(options.timeout).toBeGreaterThan(0);
    }
  });
});
