/**
 * @file scripts/__tests__/guard-git-push.test.mjs
 * @description Proof of the #2217 pre-push strict-lock decision (guard-git-push.mjs) — LAYER 3 of the #2203
 *   lock that catches a SCRIPT-internal push to `main` the Bash-tool guard can't see. The git process is the
 *   I/O boundary (the hook pipes the ref list on stdin); the pure block/allow decision is unit-tested here.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { mainPushRefs, pushGuardDecision, readPushLease } from '../guard-git-push.mjs';

// A pre-push stdin line: `<localRef> <localSha> <remoteRef> <remoteSha>`.
const line = (localRef, remoteRef) => `${localRef} ${'a'.repeat(40)} ${remoteRef} ${'b'.repeat(40)}`;

describe('mainPushRefs', () => {
  it('matches a push to refs/heads/main', () => {
    expect(mainPushRefs(line('refs/heads/main', 'refs/heads/main'))).toEqual(['refs/heads/main']);
  });
  it('does NOT match a push to a lane/* ref (the sanctioned path)', () => {
    expect(mainPushRefs(line('HEAD', 'refs/heads/lane/x-2217'))).toEqual([]);
  });
  it('catches a DELETE of main (zero local sha, same remoteRef)', () => {
    expect(mainPushRefs(`(delete) ${'0'.repeat(40)} refs/heads/main ${'0'.repeat(40)}`)).toEqual(['refs/heads/main']);
  });
  it('matches even when a lane push is in the same batch (mixed refspecs)', () => {
    const stdin = [line('HEAD', 'refs/heads/lane/x-1'), line('refs/heads/main', 'refs/heads/main')].join('\n');
    expect(mainPushRefs(stdin)).toEqual(['refs/heads/main']);
  });
  it('ignores blank / malformed lines', () => {
    expect(mainPushRefs('\n  \nfoo\n')).toEqual([]);
    expect(mainPushRefs('')).toEqual([]);
  });
});

describe('pushGuardDecision', () => {
  it('BLOCKS a push to main (returns a #2203 reason)', () => {
    const r = pushGuardDecision(line('refs/heads/main', 'refs/heads/main'));
    expect(r).toMatch(/BLOCKED/);
    expect(r).toMatch(/#2203/);
    expect(r).toMatch(/MAIN_PUSH_OK=1/);
  });
  it('ALLOWS a lane/* push (returns null)', () => {
    expect(pushGuardDecision(line('HEAD', 'refs/heads/lane/x-2217'))).toBe(null);
  });
  it('ALLOWS a main push when the MAIN_PUSH_OK override is set (mirrors guard-bash)', () => {
    expect(pushGuardDecision(line('refs/heads/main', 'refs/heads/main'), { override: true })).toBe(null);
  });
  it('an empty payload (no refs) is allowed', () => {
    expect(pushGuardDecision('')).toBe(null);
  });
  it.each(['main', 'lane/target', 'lane/other'])('blocks a pinned runner push to %s even with the main override', destination => {
    const lease = { at: 'c'.repeat(40), acquiredAt: '2000-01-01T00:00:00Z', ttlMinutes: 1 };
    expect(pushGuardDecision(line('HEAD', `refs/heads/${destination}`), { lease, override: true })).toMatch(/pre-push BLOCKED.*pinned/);
  });
  it('allows ordinary leased build lanes to push lane refs', () => {
    expect(pushGuardDecision(line('HEAD', 'refs/heads/lane/target'), { lease: { session: 'builder' } })).toBe(null);
  });
  it('refuses unknown lease evidence even with the main override', () => {
    expect(pushGuardDecision(line('HEAD', 'refs/heads/lane/target'), { leaseReadError: true, override: true })).toMatch(/pre-push BLOCKED.*cannot read lane lease/);
  });
  it('refuses a malformed pin field', () => {
    expect(pushGuardDecision(line('HEAD', 'refs/heads/lane/target'), { lease: { at: null } })).toMatch(/pre-push BLOCKED.*pinned/);
  });
  it('blocks deleting a branch from a pinned runner', () => {
    const payload = `(delete) ${'0'.repeat(40)} refs/heads/lane/target ${'b'.repeat(40)}`;
    expect(pushGuardDecision(payload, { lease: { at: 'c'.repeat(40) } })).toMatch(/pre-push BLOCKED.*pinned/);
  });
});

describe('readPushLease', () => {
  const cwd = process.cwd();
  it('uses the Git-resolved lease path, including worktree metadata outside the checkout', () => {
    const leasePath = resolve(cwd, '..', 'worktree-metadata', '.lane-lease');
    const exec = vi.fn(() => `${leasePath}\n`);
    const read = vi.fn(() => JSON.stringify({ at: 'c'.repeat(40) }));
    expect(readPushLease({ cwd, exec, read })).toEqual({ at: 'c'.repeat(40) });
    expect(exec).toHaveBeenCalledWith('git', ['rev-parse', '--git-path', '.lane-lease'], expect.objectContaining({ cwd, timeout: 5000, maxBuffer: 65536 }));
    expect(read).toHaveBeenCalledWith(leasePath, 'utf8');
  });
  it('allows a missing lease marker', () => {
    const read = () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); };
    expect(readPushLease({ exec: () => '.git/.lane-lease\n', read })).toBe(null);
  });
  it('propagates unreadable lease evidence', () => {
    const read = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(() => readPushLease({ exec: () => '.git/.lane-lease\n', read })).toThrow('denied');
  });
  it.each(['{', 'null', '[]', 'false', '"lease"'])('rejects corrupt or non-object lease JSON %s', contents => {
    expect(() => readPushLease({ exec: () => '.git/.lane-lease\n', read: () => contents })).toThrow();
  });
  it.each(['ETIMEDOUT', 'ENOBUFS'])('propagates failed Git discovery (%s) without reading a fallback path', code => {
    const exec = () => { throw Object.assign(new Error('Git probe failed'), { code }); };
    const read = vi.fn();
    expect(() => readPushLease({ exec, read })).toThrow('Git probe failed');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects an empty Git path instead of reading unrelated files', () => {
    expect(() => readPushLease({ exec: () => '\n' })).toThrow('empty lease path');
  });
});
