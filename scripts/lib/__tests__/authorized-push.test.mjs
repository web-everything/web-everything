/** @file Hermetic authorized-push refusals, live reads and lease boundary. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizedPush, readPushAuthority } from '../authorized-push.mjs';
import { PUSH_HOLD_LABELS } from '../review-hold-model.mjs';
import { runGhSync } from '../gh-throttle.mjs';

vi.mock('../gh-throttle.mjs', async importOriginal => ({ ...await importOriginal(), runGhSync: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const head = 'a'.repeat(40), sha = 'b'.repeat(40);
const view = () => ({ labels: [], state: 'OPEN', isDraft: false, headRefOid: head,
  headRefName: 'lane/fix', isCrossRepository: false });
function fixture() {
  const io = { readClaim: vi.fn(() => ({ meta: { sessionId: 'mine' } })),
    isClaimHolder: vi.fn((entry, holder) => entry.meta.sessionId === holder?.sessionId),
    ghPrView: vi.fn(view), isAncestor: vi.fn(() => true),
    readPushUrls: vi.fn(() => ['https://github.com/web-everything/web-everything.git']),
    gitPush: vi.fn(() => ({ status: 0 })) };
  return { repo: 'we', pr: 42, branch: 'lane/fix', expectedHead: head, sha, gitDir: 'checkout',
    holder: { sessionId: 'mine' }, purpose: 'repair', io };
}
const throws = () => { throw new Error('unreadable'); };
describe('authorized push', () => {
  it('pins exactly the four push hold labels', () => {
    expect(PUSH_HOLD_LABELS).toEqual(['review:human','red-team:blocked','red-team:pending','review:held-mechanical']);
  });
  it.each([
    ['released or expired', null, 'not-claim-holder'],
    ['reassigned', { meta: { sessionId: 'other' } }, 'not-claim-holder'],
    ['unreadable', throws, 'unreadable'],
  ])('refuses a claim %s after destination validation', (_name, entry, code) => {
    const f = fixture();
    f.io.readPushUrls.mockImplementation(() => {
      f.io.readClaim.mockImplementation(typeof entry === 'function' ? entry : () => entry);
      return ['https://github.com/web-everything/web-everything.git'];
    });
    expect(authorizedPush(f)).toMatchObject({ ok: false, code });
    expect(f.io.readClaim).toHaveBeenCalledTimes(2);
    expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it('disables recursive submodule pushes', () => {
    const f = fixture(); authorizedPush(f);
    expect(f.io.gitPush.mock.calls[0][1]).toContain('--recurse-submodules=no');
  });
  it('pushes to the validated URL despite subsequent remote configuration changes', () => {
    const f = fixture(); const url = 'git@github.com:web-everything/web-everything.git';
    f.io.readPushUrls.mockReturnValueOnce([url]).mockReturnValue(['git@github.com:another/repo.git']);
    expect(authorizedPush(f).ok).toBe(true);
    expect(f.io.gitPush.mock.calls[0][1]).toContain(url);
    expect(f.io.gitPush.mock.calls[0][1]).not.toContain('origin');
  });
  it.each([
    ['closed', { state: 'CLOSED' }, 'PR is not open'],
    ['merged', { state: 'MERGED' }, 'PR is not open'],
    ['drafted', { isDraft: true }, 'PR drafted outside this claim'],
    ['cross repo', { isCrossRepository: true }, 'Cross-repository PR'],
  ])('blocks hand-back when PR is %s after push', (_name, patch, reason) => {
    const f = fixture(); f.io.ghPrView.mockReturnValueOnce(view()).mockReturnValueOnce({ ...view(), ...patch });
    expect(authorizedPush(f)).toEqual({ ok: false, code: 'pushed-under-hold', pushed: true, reason });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1);
  });
  it('default git calls ignore inherited grafts and repository context and disable commit graphs', () => {
    const f = fixture(); delete f.io.isAncestor; delete f.io.readPushUrls; delete f.io.gitPush;
    f.io.spawn = vi.fn(() => ({ status: 0, stdout: 'https://github.com/web-everything/web-everything.git\n' }));
    const leaks = ['GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
    try {
      vi.stubEnv('GIT_GRAFT_FILE', 'untrusted-grafts');
      for (const key of leaks) vi.stubEnv(key, 'untrusted');
      expect(authorizedPush(f).ok).toBe(true);
      expect(f.io.spawn).toHaveBeenCalledTimes(3);
      for (const [, args, opts] of f.io.spawn.mock.calls) {
        expect(args.slice(0, 4)).toEqual(['-c', 'core.commitGraph=false', '-C', 'checkout']);
        expect(opts.env).toMatchObject({ GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' });
        for (const key of leaks) expect(opts.env).not.toHaveProperty(key);
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it('default PR reader pins the GitHub host in repo and child environment', () => {
    const f = fixture(); delete f.io.ghPrView;
    runGhSync.mockReturnValue(JSON.stringify(view()));
    try {
      vi.stubEnv('GH_HOST', 'other.example');
      expect(authorizedPush(f).ok).toBe(true);
      expect(runGhSync).toHaveBeenCalledTimes(2);
      for (const [args, opts] of runGhSync.mock.calls) {
        expect(args).toContain('github.com/web-everything/web-everything');
        expect(opts.env.GH_HOST).toBe('github.com');
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([
    ...['review:human','red-team:blocked','red-team:pending','review:held-mechanical'].map(name => [name, { labels: [{ name }] }, 'hold-label']),
    ['closed', { state: 'CLOSED' }, 'pr-not-open'], ['merged', { state: 'MERGED' }, 'pr-not-open'],
    ['foreign draft', { isDraft: true }, 'draft'], ['moved head', { headRefOid: sha }, 'head-moved'],
    ['cross repo', { isCrossRepository: true }, 'cross-repo'],
    ['wrong branch', { headRefName: 'lane/other' }, 'branch-mismatch'],
    ['labels not array', { labels: {} }, 'unreadable'],
    ['label not string', { labels: [{ name: 1 }] }, 'unreadable'],
    ['unknown state', { state: 'UNKNOWN' }, 'unreadable'],
    ['missing field', { isDraft: undefined }, 'unreadable'],
    ['bad head', { headRefOid: 'abc' }, 'unreadable'],
    ['bad cross repo', { isCrossRepository: null }, 'unreadable'],
  ])('refuses %s with zero pushes', (_name, patch, code) => {
    const f = fixture(); f.io.ghPrView.mockReturnValue({ ...view(), ...patch });
    const result = authorizedPush(f);
    expect(result).toMatchObject({ ok: false, code });
    if (code === 'hold-label') expect(result.reason).toContain(patch.labels[0].name);
    expect(f.io.gitPush).toHaveBeenCalledTimes(0);
  });
  it.each([
    ['gh throws', f => f.io.ghPrView.mockImplementation(throws), 'unreadable'],
    ['timeout', f => f.io.ghPrView.mockImplementation(() => { throw new Error('ETIMEDOUT'); }), 'unreadable'],
    ['bad JSON string', f => f.io.ghPrView.mockReturnValue('{bad'), 'unreadable'],
    ['null JSON', f => f.io.ghPrView.mockReturnValue(null), 'unreadable'],
    ['array JSON', f => f.io.ghPrView.mockReturnValue([]), 'unreadable'],
    ['claim throws', f => f.io.readClaim.mockImplementation(throws), 'unreadable'],
    ['absent claim', f => f.io.readClaim.mockReturnValue(null), 'not-claim-holder'],
    ['other holder', f => { f.holder.sessionId = 'other'; }, 'not-claim-holder'],
    ['ancestry throws', f => f.io.isAncestor.mockImplementation(throws), 'unreadable'],
    ['not descendant', f => f.io.isAncestor.mockReturnValue(false), 'not-descendant'],
  ])('refuses %s with zero pushes', (_name, change, code) => {
    const f = fixture(); change(f);
    expect(authorizedPush(f)).toMatchObject({ ok: false, code });
    expect(f.io.gitPush).toHaveBeenCalledTimes(0);
  });
  it.each([{ sha: 'abc' }, { expectedHead: 'A'.repeat(40) }, { branch: 'main' },
    { repo: 'unknown' }, { repo: '' }, { purpose: '' }, { purpose: ' ' }, { pr: 0 }])
  ('rejects bad input %j', patch => {
    const f = fixture(); expect(authorizedPush({ ...f, ...patch })).toMatchObject({ code: 'bad-input', ok: false });
    expect(f.io.gitPush).toHaveBeenCalledTimes(0); expect(f.io.readClaim).not.toHaveBeenCalled();
  });
  it('ignores caller labels from an earlier unheld read', () => {
    const f = fixture(); f.io.ghPrView.mockReturnValue({ ...view(), labels: [{ name: 'review:human' }] });
    expect(authorizedPush({ ...f, labels: [], state: 'OPEN', head: head })).toMatchObject({ code: 'hold-label' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(0);
  });
  it.each([false, true])('allows own-drafted=%s and pushes the exact lease once', draft => {
    const f = fixture(); f.io.readClaim.mockReturnValue({ meta: { sessionId: 'mine', draft } });
    f.io.ghPrView.mockReturnValue({ ...view(), isDraft: draft });
    expect(authorizedPush(f)).toEqual({ ok: true, pushed: sha, purpose: 'repair' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1);
    expect(f.io.gitPush).toHaveBeenCalledWith('checkout', ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
      `--force-with-lease=refs/heads/lane/fix:${head}`, 'https://github.com/web-everything/web-everything.git', `${sha}:refs/heads/lane/fix`]);
    expect(f.io.ghPrView).toHaveBeenCalledTimes(2);
  });
  it('never retries a remote move during the leased push', () => {
    const f = fixture(); f.io.gitPush.mockReturnValue({ status: 1, stderr: 'stale info' });
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'push-rejected' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1); expect(f.io.ghPrView).toHaveBeenCalledTimes(1);
  });
  it('default transport overrides push.followTags=true to prevent publishing reachable tags', () => {
    const f = fixture(); delete f.io.gitPush;
    f.io.spawn = vi.fn(() => ({ status: 0 }));
    try {
      vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'push.followTags');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
      expect(authorizedPush(f)).toEqual({ ok: true, pushed: sha, purpose: 'repair' });
      expect(f.io.spawn).toHaveBeenCalledTimes(1);
      const [bin, args, opts] = f.io.spawn.mock.calls[0];
      expect(bin).toBe('git');
      expect(args).toEqual(['-c', 'core.commitGraph=false', '-C', 'checkout', 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
        `--force-with-lease=refs/heads/lane/fix:${head}`, 'https://github.com/web-everything/web-everything.git', `${sha}:refs/heads/lane/fix`]);
      expect(opts.env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'push.followTags', GIT_CONFIG_VALUE_0: 'true' });
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([
    ['mismatched origin', ['https://github.com/another/repo.git']],
    ['mismatched pushurl', ['git@github.com:another/repo.git']],
    ['additional pushurl', ['https://github.com/web-everything/web-everything.git', 'git@github.com:another/repo.git']],
    ['missing destination', []], ['malformed destination', ['not-a-url']],
    ['unreadable shape', null], ['credentialed URL', ['https://user@github.com/web-everything/web-everything.git']],
  ])('rejects %s with zero pushes', (_name, urls) => {
    const f = fixture(); f.io.readPushUrls.mockReturnValue(urls);
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'destination-mismatch' });
    expect(f.io.readPushUrls).toHaveBeenCalledWith('checkout'); expect(f.io.gitPush).toHaveBeenCalledTimes(0);
  });
  it('refuses unreadable origin push configuration with zero pushes', () => {
    const f = fixture(); f.io.readPushUrls.mockImplementation(throws);
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'unreadable' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(0);
  });
  it('default destination reader checks effective pushurls and refuses a foreign pushurl', () => {
    const f = fixture(); delete f.io.readPushUrls;
    const spawn = f.io.spawn = vi.fn(() => ({ status: 0, stdout: 'git@github.com:another/repo.git\n' }));
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'destination-mismatch' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('git', ['-c', 'core.commitGraph=false', '-C', 'checkout', 'remote', 'get-url', '--push', '--all', 'origin'],
      expect.objectContaining({ timeout: 60_000, maxBuffer: 1024 * 1024 }));
    expect(f.io.gitPush).toHaveBeenCalledTimes(0);
  });
  it.each(['git@github.com:web-everything/web-everything.git', 'ssh://git@github.com/web-everything/web-everything',
    'https://github.com/web-everything/web-everything'])('accepts authorized destination %s', url => {
    const f = fixture(); f.io.readPushUrls.mockReturnValue([url]);
    expect(authorizedPush(f).ok).toBe(true); expect(f.io.gitPush).toHaveBeenCalledTimes(1);
  });
  it.each(['hold', 'unreadable'])('blocks hand-back after post-push %s', mode => {
    const f = fixture(); f.io.ghPrView.mockImplementationOnce(view).mockImplementationOnce(() => {
      if (mode === 'unreadable') throws();
      return { ...view(), labels: [{ name: 'red-team:pending' }] };
    });
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'pushed-under-hold', pushed: true });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1); expect(f.io.ghPrView).toHaveBeenCalledTimes(2);
  });
  it('read-only authority checks ancestry without pushing', () => {
    const f = fixture(); expect(readPushAuthority(f)).toEqual({ ok: true, purpose: 'repair' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(0); expect(f.io.ghPrView).toHaveBeenCalledTimes(1);
    expect(f.io.isAncestor).toHaveBeenCalledWith('checkout', head, sha);
  });
  it('default reader requires noMemo so a stale unheld memo cannot authorize a push', () => {
    const f = fixture(); delete f.io.ghPrView;
    const stale = view(), live = { ...view(), labels: [{ name: 'review:human' }] };
    runGhSync.mockImplementation((_args, opts) => JSON.stringify(opts.throttle.noMemo === true ? live : stale));
    expect(authorizedPush(f)).toMatchObject({ code: 'hold-label' });
    expect(runGhSync).toHaveBeenCalledTimes(1);
    expect(runGhSync).toHaveBeenCalledWith(['pr', 'view', '42', '--repo',
      expect.any(String), '--json', 'labels,state,isDraft,headRefOid,headRefName,isCrossRepository'],
    expect.objectContaining({ throttle: { noMemo: true } }));
    expect(f.io.gitPush).toHaveBeenCalledTimes(0);
  });
});
