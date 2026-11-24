/** @file Hermetic authorized-push refusals, live reads and lease boundary. */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizedPushForTesting, nonTestFactoryImports } from './helpers/authorized-push-factory.mjs';
const authorizedPush = options => createAuthorizedPushForTesting(options.io).authorizedPush(options);
const readPushAuthority = options => createAuthorizedPushForTesting(options.io).readPushAuthority(options);
import { PUSH_HOLD_LABELS } from '../review-hold-model.mjs';
import { runGhSync } from '../gh-throttle.mjs';
import { pushRefusal } from '../../conveyor/fix-procedure.mjs';
import { fixDispatchClaimRoot } from '../../conveyor/fix-claim-store.mjs';
import { resolveCoordinationRoot } from '../../operations/coordination-root.mjs';
import { authorizedPush as publicPush, readPushAuthority as publicRead } from '../authorized-push.mjs';

vi.mock('../gh-throttle.mjs', async importOriginal => ({ ...await importOriginal(), runGhSync: vi.fn() }));
vi.mock('../../conveyor/fix-procedure.mjs', async importOriginal => ({ ...await importOriginal(), pushRefusal: vi.fn(() => null) }));
afterEach(() => { vi.clearAllMocks(); pushRefusal.mockReturnValue(null); });
const head = 'a'.repeat(40), sha = 'b'.repeat(40);
const url = 'https://github.com/web-everything/web-everything.git';
const pushed = () => ({ status: 0, stdout: `To ${url}\n \t${sha}:refs/heads/lane/fix\taaaa..bbbb\nDone\n` });
const view = () => ({ labels: [], state: 'OPEN', isDraft: false, headRefOid: head,
  headRefName: 'lane/fix', isCrossRepository: false });
function fixture() {
  const io = { stat: () => ({ isFile: () => true, uid: process.getuid(), mode: 0o755 }), readClaim: vi.fn(() => ({ meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', sessionId: 'mine' } })),
    isClaimHolder: vi.fn((entry, holder) => entry.meta.sessionId === holder?.sessionId),
    ghPrView: vi.fn(() => ({ ...view(), headRefOid: (io.gitPush?.mock.calls.length || io.spawn?.mock.calls.some(([, args]) => args.includes('push'))) ? sha : head })), isAncestor: vi.fn(() => true),
    branchClaimRefusal: vi.fn(() => null),
    spawn: vi.fn((bin, args, opts) => args.includes('init') ? spawnSync(bin, args, opts)
      : args.includes('rev-parse') ? { status: 0, stdout: '.git\n' } : pushed()),
    gitPush: vi.fn(pushed) };
  return { repo: 'we', pr: 42, branch: 'lane/fix', expectedHead: head, sha, gitDir: 'checkout',
    holder: { sessionId: 'mine' }, purpose: 'repair', io };
}
const throws = () => { throw new Error('unreadable'); };
describe('authorized push', () => {
  it.each(['initial', 'pre-push', 'post-push'])('refuses an unbound who-only claim at %s', phase => {
    const f = fixture(); f.io.isClaimHolder.mockReturnValue(true);
    const bound = { meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', sessionId: 'mine' } }, unbound = { meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', who: 'worker' } };
    f.io.readClaim.mockReturnValue(unbound);
    if (phase !== 'initial') f.io.readClaim.mockReturnValueOnce(bound);
    if (phase === 'post-push') f.io.readClaim.mockReturnValueOnce(bound);
    expect(authorizedPush(f)).toMatchObject({ ok: false,
      code: phase === 'post-push' ? 'pushed-under-hold' : 'not-claim-holder', reason: 'Unbound claim' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(phase === 'post-push' ? 1 : 0);
  });
  it.each(['initial', 'pre-push', 'post-push'])('refuses another PR claiming the branch at %s', phase => {
    const f = fixture(); f.holder = { sessionId: 'mine', who: 'worker', token: 'secret' };
    f.io.branchClaimRefusal.mockReturnValue({ refused: true, pr: 99, message: 'Another PR holds this branch' });
    if (phase !== 'initial') f.io.branchClaimRefusal.mockReturnValueOnce(null);
    if (phase === 'post-push') f.io.branchClaimRefusal.mockReturnValueOnce(null);
    expect(authorizedPush(f)).toMatchObject({ ok: false,
      code: phase === 'post-push' ? 'pushed-under-hold' : 'foreign-claim' });
    expect(f.io.branchClaimRefusal).toHaveBeenLastCalledWith('we', 'lane/fix', f.holder);
    expect(f.io.gitPush).toHaveBeenCalledTimes(phase === 'post-push' ? 1 : 0);
  });
  it.each(['initial', 'pre-push', 'post-push'])('refuses unreadable branch claims at %s', phase => {
    const f = fixture(); f.io.branchClaimRefusal.mockImplementation(throws);
    if (phase !== 'initial') f.io.branchClaimRefusal.mockReturnValueOnce(null);
    if (phase === 'post-push') f.io.branchClaimRefusal.mockReturnValueOnce(null);
    expect(authorizedPush(f)).toMatchObject({ ok: false,
      code: phase === 'post-push' ? 'pushed-under-hold' : 'unreadable' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(phase === 'post-push' ? 1 : 0);
  });
  it.each([
    ['head', { headRefOid: head }], ['branch', { headRefName: 'lane/other' }],
  ])('blocks hand-back if post-push %s differs', (_name, patch) => {
    const f = fixture(); f.io.ghPrView.mockReturnValueOnce(view())
      .mockReturnValueOnce(view()).mockReturnValueOnce({ ...view(), headRefOid: sha, ...patch });
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'pushed-under-hold', pushed: true });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['released or expired', null], ['reassigned', { meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', sessionId: 'other' } }], ['unreadable', throws],
  ])('blocks hand-back when post-push claim is %s', (_name, entry) => {
    const f = fixture(); f.io.gitPush.mockImplementation(() => {
      f.io.readClaim.mockImplementation(typeof entry === 'function' ? entry : () => entry);
      return pushed();
    });
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'pushed-under-hold', pushed: true });
    expect(f.io.readClaim).toHaveBeenCalledTimes(3);
    expect(f.io.gitPush).toHaveBeenCalledTimes(1);
  });
  it('allows a token-bound sessionless holder', () => {
    const f = fixture(); f.io.readClaim.mockReturnValue({ meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', who: 'worker', tokenHash: 'hash' } });
    f.io.isClaimHolder.mockReturnValue(true);
    expect(authorizedPush(f)).toMatchObject({ ok: true, pushed: sha });
    expect(f.io.readClaim).toHaveBeenCalledTimes(3);
  });
  it('default branch guard forwards the holder identity and refuses a foreign PR', () => {
    const f = fixture(); delete f.io.branchClaimRefusal;
    f.holder = { sessionId: 'mine', who: 'worker', token: 'secret' };
    pushRefusal.mockReturnValue({ refused: true, pr: 99 });
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'foreign-claim' });
    expect(pushRefusal).toHaveBeenCalledWith({ repo: 'we', branch: 'lane/fix', ...f.holder, strict: true,
      lockRoot: fixDispatchClaimRoot(resolveCoordinationRoot({ env: {} })) });
    expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it('pins exactly the four push hold labels', () => {
    expect(PUSH_HOLD_LABELS).toEqual(['review:human','red-team:blocked','red-team:pending','review:held-mechanical']);
  });
  it.each([
    ['released or expired', null, 'not-claim-holder'],
    ['reassigned', { meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', sessionId: 'other' } }, 'not-claim-holder'],
    ['unreadable', throws, 'unreadable'],
  ])('refuses a claim %s at the final gate', (_name, entry, code) => {
    const f = fixture();
    f.io.readClaim.mockReturnValueOnce({ meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', sessionId: 'mine' } })
      .mockImplementation(typeof entry === 'function' ? entry : () => entry);
    expect(authorizedPush(f)).toMatchObject({ ok: false, code });
    expect(f.io.readClaim).toHaveBeenCalledTimes(2);
    expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it('disables recursive submodule pushes', () => {
    const f = fixture(); authorizedPush(f);
    expect(f.io.gitPush.mock.calls[0][1]).toContain('--no-recurse-submodules');
  });
  it.each([
    ['closed', { state: 'CLOSED' }, 'PR is not open'],
    ['merged', { state: 'MERGED' }, 'PR is not open'],
    ['drafted', { isDraft: true }, 'PR drafted outside this claim'],
    ['cross repo', { isCrossRepository: true }, 'Cross-repository PR'],
  ])('blocks hand-back when PR is %s after push', (_name, patch, reason) => {
    const f = fixture(); f.io.ghPrView.mockReturnValueOnce(view()).mockReturnValueOnce(view()).mockReturnValueOnce({ ...view(), ...patch });
    expect(authorizedPush(f)).toEqual({ ok: false, code: 'pushed-under-hold', pushed: true, reason });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1);
  });
  it('default git calls allowlist the environment and disable commit graphs', () => {
    const f = fixture(); delete f.io.isAncestor; delete f.io.gitPush;
    const leaks = ['GIT_GRAFT_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
    try {
      for (const key of leaks) vi.stubEnv(key, 'untrusted');
      expect(authorizedPush(f).ok).toBe(true);
      expect(f.io.spawn.mock.calls.filter(([, args]) => args.includes('merge-base'))).toHaveLength(1);
      for (const [bin, args, opts] of f.io.spawn.mock.calls) {
        expect(bin).toBe('/usr/bin/git');
        expect(args).toContain('core.commitGraph=false');
        expect(opts.env).toMatchObject({ GIT_NO_REPLACE_OBJECTS: '1',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
        for (const key of leaks) expect(opts.env).not.toHaveProperty(key);
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(['GH_TOKEN', 'GITHUB_TOKEN'])('credential helper receives token-only authentication via %s', key => {
    const root = mkdtempSync(join(process.env.TMPDIR, 'push-token-auth-'));
    try {
      const config = join(root, 'empty-gh-config'), helper = join(root, 'gh');
      mkdirSync(config);
      // A local gh stand-in exercises Git's real helper invocation without network or stored credentials.
      writeFileSync(helper, `#!/bin/sh
[ "$1" = auth ] && [ "$2" = git-credential ] && [ "$3" = get ] || exit 1
[ -n "\${GH_TOKEN:-$GITHUB_TOKEN}" ] || exit 1
printf 'username=x-access-token\\npassword=%s\\n' "\${GH_TOKEN:-$GITHUB_TOKEN}"
`, { mode: 0o700 });
      vi.stubEnv('GH_TOKEN', ''); vi.stubEnv('GITHUB_TOKEN', '');
      delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
      vi.stubEnv(key, 'fixture-token-only'); vi.stubEnv('GH_CONFIG_DIR', config);
      vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper');
      vi.stubEnv('GIT_CONFIG_VALUE_0', '!false');

      const f = fixture(), spawn = f.io.spawn; delete f.io.gitPush;
      f.io.gh = helper;
      let credentials;
      f.io.spawn = vi.fn((bin, args, opts) => {
        if (!args.includes('push')) return spawn(bin, args, opts);
        expect(opts.env.GIT_CONFIG_COUNT).toBeUndefined();
        expect(opts.env[key === 'GH_TOKEN' ? 'GITHUB_TOKEN' : 'GH_TOKEN']).toBeUndefined();
        credentials = spawnSync(bin, [...args.slice(0, args.indexOf('push')), 'credential', 'fill'], {
          ...opts, input: 'protocol=https\nhost=github.com\n\n',
        });
        return pushed();
      });
      expect(authorizedPush(f)).toMatchObject({ ok: true, pushed: sha });
      expect(credentials.status).toBe(0);
      expect(credentials.stdout).toContain('password=fixture-token-only');
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
  it('default transport overrides push.followTags=true to prevent publishing reachable tags', () => {
    const f = fixture(); delete f.io.gitPush;
    try {
      vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'push.followTags');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
      expect(authorizedPush(f)).toEqual({ ok: true, pushed: sha, purpose: 'repair' });
      const pushes = f.io.spawn.mock.calls.filter(([, args]) => args.includes('push'));
      expect(pushes).toHaveLength(1);
      const [, args, opts] = pushes[0];
      expect(args).toContain('push.followTags=false');
      expect(args).toContain('--no-follow-tags');
      expect(args).toContain(url);
      for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
        expect(opts.env).not.toHaveProperty(key);
    } finally { vi.unstubAllEnvs(); }
  });
  it('default PR reader pins the GitHub host in repo and child environment', () => {
    const f = fixture(); delete f.io.ghPrView;
    runGhSync.mockReturnValueOnce(JSON.stringify(view())).mockReturnValueOnce(JSON.stringify(view())).mockReturnValue(JSON.stringify({ ...view(), headRefOid: sha }));
    try {
      vi.stubEnv('GH_HOST', 'other.example');
      expect(authorizedPush(f).ok).toBe(true);
      expect(runGhSync).toHaveBeenCalledTimes(3);
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
    const f = fixture(); f.io.readClaim.mockReturnValue({ meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', sessionId: 'mine' }, ...(draft ? { sidecarAt: '2026-11-24T15:00:00.000Z' } : {}) });
    f.io.ghPrView.mockImplementation(() => ({ ...view(), isDraft: draft, headRefOid: f.io.gitPush.mock.calls.length ? sha : head }));
    expect(authorizedPush(f)).toEqual({ ok: true, pushed: sha, purpose: 'repair' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1);
    expect(f.io.gitPush).toHaveBeenCalledWith(expect.any(String), ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-recurse-submodules',
      `--force-with-lease=refs/heads/lane/fix:${head}`, 'https://github.com/web-everything/web-everything.git', `${sha}:refs/heads/lane/fix`]);
    expect(f.io.ghPrView).toHaveBeenCalledTimes(3);
  });
  it('never retries a remote move during the leased push', () => {
    const f = fixture(); f.io.gitPush.mockReturnValue({ status: 1, stderr: 'stale info' });
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'push-rejected' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1); expect(f.io.ghPrView).toHaveBeenCalledTimes(2);
  });
  it.each(['hold', 'unreadable'])('blocks hand-back after post-push %s', mode => {
    const f = fixture(); f.io.ghPrView.mockImplementationOnce(view).mockImplementationOnce(view).mockImplementationOnce(() => {
      if (mode === 'unreadable') throws();
      return { ...view(), labels: [{ name: 'red-team:pending' }] };
    });
    expect(authorizedPush(f)).toMatchObject({ ok: false, code: 'pushed-under-hold', pushed: true });
    expect(f.io.gitPush).toHaveBeenCalledTimes(1); expect(f.io.ghPrView).toHaveBeenCalledTimes(3);
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
    expect.objectContaining({ throttle: { noMemo: true, bin: expect.any(String) } }));
    expect(f.io.gitPush).toHaveBeenCalledTimes(0);
  });
});

describe('audit negative guarantees', () => {
  it.each(['repo', 'pr', 'kind', 'branch'])('refuses mismatched claim %s despite matching holder', key => {
    const f = fixture(), meta = { ...f.io.readClaim().meta, [key]: ({ repo: 'frontierui', pr: 99, kind: 'fix', branch: 'lane/foreign' })[key] };
    f.io.readClaim.mockReturnValue({ meta });
    expect(authorizedPush(f)).toMatchObject({ code: 'not-claim-holder' });
    expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it.each(['repo', 'pr', 'kind', 'branch'])('refuses missing claim %s', key => {
    const f = fixture(), meta = { ...f.io.readClaim().meta }; delete meta[key];
    f.io.readClaim.mockReturnValue({ meta });
    expect(authorizedPush(f)).toMatchObject({ code: 'unreadable' });
    expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it.each(['initial', 'pre-push', 'post-push'])('refuses malformed draft sidecar evidence at %s', phase => {
    const f = fixture(), bound = f.io.readClaim();
    f.io.readClaim.mockReturnValue({ meta: { ...bound.meta }, sidecarAt: 'true' });
    if (phase !== 'initial') f.io.readClaim.mockReturnValueOnce(bound);
    if (phase === 'post-push') f.io.readClaim.mockReturnValueOnce(bound);
    expect(authorizedPush(f)).toMatchObject({ code: phase === 'post-push' ? 'pushed-under-hold' : 'unreadable' });
    expect(f.io.gitPush).toHaveBeenCalledTimes(phase === 'post-push' ? 1 : 0);
  });
  it.each([undefined, false, true])('external draft with claim draft intent %s refuses without ownership', draft => {
    const f = fixture(), meta = { ...f.io.readClaim().meta, draft };
    if (draft === undefined) delete meta.draft;
    f.io.readClaim.mockReturnValue({ meta }); f.io.ghPrView.mockReturnValue({ ...view(), isDraft: true });
    expect(authorizedPush(f)).toMatchObject({ code: 'draft' });
    expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it.each(['missing', 'foreign-owner', 'group-writable', 'world-writable'])('refuses %s gh candidates without PATH fallback', kind => {
    const f = fixture(), paths = [];
    f.io.stat = path => {
      paths.push(path);
      if (kind === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true, uid: kind === 'foreign-owner' ? process.getuid() + 1 : process.getuid(),
        mode: kind === 'group-writable' ? 0o775 : kind === 'world-writable' ? 0o757 : 0o755 };
    };
    expect(authorizedPush(f)).toMatchObject({ code: 'unreadable' });
    expect(paths).toEqual(['/opt/homebrew/bin/gh', '/usr/local/bin/gh']);
    expect(f.io.gitPush).not.toHaveBeenCalled(); expect(f.io.ghPrView).not.toHaveBeenCalled();
  });
  it('resolves gh once and pins the same binary for all PR reads and the helper', () => {
    const f = fixture(); delete f.io.ghPrView;
    f.io.stat = vi.fn(() => ({ isFile: () => true, uid: 0, mode: 0o755 }));
    runGhSync.mockReturnValueOnce(JSON.stringify(view())).mockReturnValueOnce(JSON.stringify(view()))
      .mockReturnValue(JSON.stringify({ ...view(), headRefOid: sha }));
    expect(authorizedPush(f)).toMatchObject({ ok: true });
    expect(f.io.stat).toHaveBeenCalledTimes(1);
    for (const [, opts] of runGhSync.mock.calls) {
      expect(opts.throttle.bin).toBe('/opt/homebrew/bin/gh');
      expect(opts.env.GH_CONFIG_DIR).toEqual(expect.any(String));
      expect(opts.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    }
    expect(f.io.spawn.mock.calls[0][1]).toContain("credential.helper=!'/opt/homebrew/bin/gh' auth git-credential");
  });
  it.each(['stale', 'unreadable'])('blocks protected branches for %s tracker evidence with hooks off, even with ambient override', mode => {
    const f = fixture(), branch = 'lane/mechanical-dispatcher', spawn = f.io.spawn;
    f.branch = branch; const meta = { ...f.io.readClaim().meta, branch };
    f.io.readClaim.mockReturnValue({ meta }); f.io.ghPrView.mockReturnValue({ ...view(), headRefName: branch });
    f.io.spawn = vi.fn((bin, args, opts) => {
      if (args.includes('show')) return mode === 'unreadable' ? { status: 1 } : { status: 0, stdout: '## Session update (2020-01-01) — stale\n' };
      if (args.includes('diff')) return { status: 0, stdout: 'other-file\n' };
      return spawn(bin, args, opts);
    });
    vi.stubEnv('PROTOTYPE_TRACKER_PUSH_OK', '1');
    try {
      expect(authorizedPush(f)).toMatchObject({ code: 'protected-branch' });
      expect(f.io.gitPush).not.toHaveBeenCalled();
      if (mode === 'stale') expect(f.io.spawn.mock.calls.some(([, args]) => args.includes('diff'))).toBe(true);
      for (const [, args] of f.io.spawn.mock.calls) expect(args).toContain('core.hooksPath=/dev/null');
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(['io', 'remoteUrl', 'protocolAllow'])('public entry points refuse injected %s', key => {
    const f = fixture(), options = { ...f }; delete options.io;
    for (const call of [publicPush, publicRead]) expect(call({ ...options, [key]: f.io }))
      .toMatchObject({ code: 'bad-input', ok: false });
    for (const call of [publicPush, publicRead]) expect(call(Object.assign(Object.create({ [key]: f.io }), options)))
      .toMatchObject({ code: 'bad-input', ok: false });
    expect(f.io.readClaim).not.toHaveBeenCalled(); expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it('no production module imports the test-only factory', () => {
    const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(path => path && existsSync(path));
    expect(nonTestFactoryImports(paths)).toEqual([]);
  });
});
