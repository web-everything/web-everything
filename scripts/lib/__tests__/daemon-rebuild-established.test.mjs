import { describe, it, expect, vi } from 'vitest';
import { isEstablished } from '../daemon-rebuild/established.mjs';

function fixture() {
  const git = vi.fn((args) => args[0] === 'rev-parse'
    ? { status: 0, stdout: args.at(-1).startsWith('HEAD') ? 'head' : `tip:${args.at(-1)}` }
    : { status: 1 });
  return { git, headSha: 'HEAD', state: { adopted: { head: 'adopted-head', applied: [] } }, overlay: { ref: 'lane/a' } };
}

describe('isEstablished — a newcomer must be proven', () => {
  it('holds without any evidence', () => {
    expect(isEstablished()).toBe(true);
  });

  it('requires negative results for every applicable probe', () => {
    const f = fixture();
    f.overlay.pinnedSha = 'pin';
    expect(isEstablished(f)).toBe(false);
    expect(f.git).toHaveBeenCalledWith(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    expect(f.git).toHaveBeenCalledWith(['merge-base', '--is-ancestor', 'pin', 'head']);
    expect(f.git).toHaveBeenCalledWith(['merge-base', '--is-ancestor', 'tip:refs/remotes/origin/lane/a^{commit}', 'head']);
  });

  it.each([undefined, {}, { adopted: {} }, { adopted: { applied: [] } },
    { adopted: { head: '', applied: [] } }, { adopted: { head: '  ', applied: [] } },
    { adopted: { head: 1, applied: [] } }, { adopted: { head: 'head' } },
    { adopted: { head: 'head', applied: {} } }, { adopted: { head: 'head', applied: [null] } },
    { adopted: { head: 'head', applied: [{}] } }])('holds with incomplete metadata %j', (state) => {
    expect(isEstablished({ ...fixture(), state })).toBe(true);
  });

  it.each(['lane/a', 'lane/old', 'lane/new', 'lane/newest'])('recognizes applied membership of %s across lineage', (ref) => {
    const f = fixture();
    f.state.adopted.applied = [{ ref }];
    f.overlays = [{ ref: 'lane/newest', refreshedFrom: ['lane/new'] },
      { ref: 'lane/new', refreshedFrom: ['lane/a'] }, { ref: 'lane/a', refreshedFrom: ['lane/old'] }];
    expect(isEstablished(f)).toBe(true);
  });

  it('holds when the remote tip is already in HEAD', () => {
    const f = fixture();
    f.git.mockImplementation((args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'sha' : '' }));
    expect(isEstablished(f)).toBe(true);
  });

  it('holds a pin in HEAD even after the remote tip moved', () => {
    const f = fixture();
    f.overlay.pinnedSha = 'old-pin';
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args[0] === 'merge-base' && args[2] === 'old-pin' ? { status: 0 } : negative(args));
    expect(isEstablished(f)).toBe(true);
  });

  it.each(['HEAD^{commit}', 'refs/remotes/origin/lane/a^{commit}'])('holds an unresolved %s', (rev) => {
    const f = fixture();
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args.at(-1) === rev ? { status: 128, stdout: '' } : negative(args));
    expect(isEstablished(f)).toBe(true);
  });

  it.each(['HEAD^{commit}', 'refs/remotes/origin/lane/a^{commit}'])('holds an empty resolution for %s', (rev) => {
    const f = fixture();
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args.at(-1) === rev ? { status: 0, stdout: '  ' } : negative(args));
    expect(isEstablished(f)).toBe(true);
  });

  it('holds without a running HEAD', () => {
    expect(isEstablished({ ...fixture(), headSha: null })).toBe(true);
  });

  it.each(['pin', 'remote'])('holds on merge-base status 128 for %s', (probe) => {
    const f = fixture();
    if (probe === 'pin') f.overlay.pinnedSha = 'pin';
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args[0] === 'merge-base' ? { status: 128 } : negative(args));
    expect(isEstablished(f)).toBe(true);
  });

  it.each([null, 2, -1])('holds on unexpected ancestry status %s', (status) => {
    const f = fixture();
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args[0] === 'merge-base' ? { status } : negative(args));
    expect(isEstablished(f)).toBe(true);
  });

  it('holds when Git throws', () => {
    expect(isEstablished({ ...fixture(), git: () => { throw new Error('spawn failed'); } })).toBe(true);
  });

  it.each(['rev-parse', 'merge-base'])('holds on a %s spawn error even with an ordinary status', (command) => {
    const f = fixture();
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args[0] === command ? { ...negative(args), error: new Error('timeout') } : negative(args));
    expect(isEstablished(f)).toBe(true);
  });

  it('maps pre-refresh evidence to successors in either registry order', () => {
    const f = fixture();
    f.establishedRefs = new Set(['lane/a']);
    f.overlay = { ref: 'lane/newest' };
    f.overlays = [{ ref: 'lane/newest', refreshedFrom: ['lane/new'] }, { ref: 'lane/new', refreshedFrom: ['lane/a'] }];
    expect(isEstablished(f)).toBe(true);
    f.overlays.reverse();
    expect(isEstablished(f)).toBe(true);
  });

  it('proves an entire refreshed lineage new only when all its probes are negative', () => {
    const f = fixture();
    f.overlays = [{ ref: 'lane/new', refreshedFrom: ['lane/a'] }];
    expect(isEstablished(f)).toBe(false);
    expect(f.git).toHaveBeenCalledWith(['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/lane/new^{commit}']);
  });

  it('shares pinned ancestry evidence with every name in a refresh chain', () => {
    const f = fixture();
    f.overlay = { ref: 'lane/newest' };
    f.overlays = [{ ref: 'lane/a', pinnedSha: 'old-pin' },
      { ref: 'lane/new', refreshedFrom: ['lane/a'] }, { ref: 'lane/newest', refreshedFrom: ['lane/new'] }];
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args[0] === 'merge-base' && args[2] === 'old-pin' ? { status: 0 } : negative(args));
    expect(isEstablished(f)).toBe(true);
    f.overlay = { ref: 'lane/a' };
    f.overlays[0] = { ref: 'lane/a' };
    f.overlays[2].pinnedSha = 'old-pin';
    expect(isEstablished(f)).toBe(true);
  });

  it('holds successors when the retired predecessor remote is missing', () => {
    const f = fixture();
    f.overlay = { ref: 'lane/new', refreshedFrom: ['lane/a'] };
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args.at(-1) === 'refs/remotes/origin/lane/a^{commit}' ? { status: 128 } : negative(args));
    expect(isEstablished(f)).toBe(true);
  });
});


describe('isEstablished — explicit evidence classification', () => {
  it('distinguishes a proven newcomer from unknown metadata without weakening boolean HOLDs', () => {
    const f = fixture();
    expect(isEstablished({ ...f, classify: true })).toBe('not-established');
    expect(isEstablished({ ...f, state: undefined, classify: true })).toBe('unknown');
    expect(isEstablished({ ...f, state: undefined })).toBe(true);
  });

  it('orders a moved tip as new while preserving adoption and pin protection', () => {
    const f = fixture();
    f.state.adopted.applied = [{ ref: f.overlay.ref }];
    expect(isEstablished({ ...f, classify: true })).toBe('established');
    expect(isEstablished({ ...f, evidence: 'tip', classify: true })).toBe('not-established');
    f.state.adopted.applied = [];
    f.overlay.pinnedSha = 'old-pin';
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args[0] === 'merge-base' && args[2] === 'old-pin'
      ? { status: 0 } : negative(args));
    expect(isEstablished({ ...f, classify: true })).toBe('established');
    expect(isEstablished({ ...f, evidence: 'tip', classify: true })).toBe('not-established');
  });

  it('preserves proven establishment for a published refresh rename in planner evidence', () => {
    const f = fixture();
    f.overlay = { ref: 'lane/refreshed', refreshedFrom: ['lane/a'] };
    f.state.adopted.applied = [{ ref: 'lane/a' }];
    expect(isEstablished({ ...f, evidence: 'tip', classify: true })).toBe('established');
    f.state.adopted.applied = [];
    expect(isEstablished({ ...f, evidence: 'tip', classify: true })).toBe('not-established');
    f.git.mockImplementation(() => ({ status: 128 }));
    expect(isEstablished({ ...f, evidence: 'tip', classify: true })).toBe('unknown');
  });

  it.each([0, 1, 128])('classifies tip ancestry status %s independently of missing adoption metadata', (status) => {
    const f = fixture();
    const negative = f.git.getMockImplementation();
    f.git.mockImplementation((args) => args[0] === 'merge-base' ? { status } : negative(args));
    expect(isEstablished({ ...f, state: undefined, evidence: 'tip', classify: true }))
      .toBe(status === 0 ? 'established' : status === 1 ? 'not-established' : 'unknown');
    expect(isEstablished({ ...f, state: undefined })).toBe(true);
  });

  it('does not turn a failed lineage probe into affirmative establishment', () => {
    const f = fixture();
    f.git.mockImplementation(() => ({ status: 128 }));
    expect(isEstablished({ ...f, classify: true })).toBe('unknown');
    expect(isEstablished(f)).toBe(true);
  });
});
