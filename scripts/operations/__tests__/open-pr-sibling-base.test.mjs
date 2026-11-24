import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSiblingBase } from '../../lib/sibling-base-check.mjs';
import { createGitReader } from '../../lib/pr-size-admission.mjs';
import { createPrLandRunner, readSiblingBase } from '../open-pr-io.mjs';
import { ghRepoSlug } from '../../lib/constellation-repos.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'sibling-base-'));
  dirs.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('remote', 'add', 'origin', `https://github.com/${ghRepoSlug('we')}.git`);
  const commit = name => {
    writeFileSync(join(dir, name), name + '\n');
    git('add', name); git('commit', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  commit('root');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const openPrs = [];
  const sibling = number => {
    const headRefName = `lane/sibling-${number}`;
    git('checkout', '-b', headRefName);
    const headRefOid = commit(`change-${number}`);
    git('update-ref', `refs/remotes/origin/${headRefName}`, headRefOid);
    const pr = { number, headRefName, headRefOid, baseRefName: 'main', isCrossRepository: false,
      headRepositoryOwner: { login: ghRepoSlug('we').split('/')[0] } };
    openPrs.push(pr); return pr;
  };
  const check = (opts = {}) => checkSiblingBase({ git: createGitReader(dir), base: 'main', sha: git('rev-parse', 'HEAD'), openPrs, ...opts });
  return { dir, git, commit, sibling, check, openPrs };
}

describe('sibling base admission', () => {
  it('refuses a branch whose history holds commits that belong to another open lane', () => {
    const f = fixture(), pr = f.sibling(236);
    f.git('checkout', '-b', 'lane/child'); f.commit('child');
    expect(f.check()).toEqual([{ number: 236, headRefName: pr.headRefName, count: 1 }]);
    expect(f.check({ openPrs: [{ number: 237, headRefName: 'lane/distinct', baseRefName: 'main', headRefOid: f.git('rev-parse', 'HEAD') }] }))
      .toEqual([{ number: 237, headRefName: 'lane/distinct', count: 2 }]);
  });

  it.each(['replace', 'graft'])('ignores %s metadata that hides sibling ancestry', metadata => {
    const f = fixture(), pr = f.sibling(236);
    f.git('checkout', '-b', 'lane/child'); const head = f.commit('child');
    if (metadata === 'replace') {
      const replacement = f.git('commit-tree', `${head}^{tree}`, '-p', f.git('rev-parse', 'main'), '-m', 'fake parents');
      f.git('replace', head, replacement);
    } else writeFileSync(join(f.dir, '.git', 'info', 'grafts'), `${head} ${f.git('rev-parse', 'main')}\n`);
    expect(f.check()).toEqual([{ number: 236, headRefName: pr.headRefName, count: 1 }]);
  });

  it('fails closed on shallow history even when no sibling overlap is visible', () => {
    const f = fixture(); f.sibling(236); const head = f.commit('child');
    writeFileSync(join(f.dir, '.git', 'shallow'), `${head}\n`);
    expect(f.git('rev-parse', '--is-shallow-repository')).toBe('true');
    expect(f.check()).toMatchObject({ reason: 'sibling-base-unreadable', detail: expect.stringContaining('non-shallow history') });
  });

  it('allows a branch cut on main, and a branch whose sibling commits already landed via their PRs', () => {
    const f = fixture(), pr = f.sibling(236);
    f.git('checkout', '-b', 'lane/clean', 'main'); f.commit('clean');
    expect(f.check()).toEqual([]);
    f.git('checkout', '-b', 'lane/child', pr.headRefOid); f.commit('child');
    f.git('checkout', 'main'); f.git('merge', '--squash', pr.headRefName);
    f.git('commit', '-m', 'squash landing with different metadata');
    f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(f.git('rev-parse', 'HEAD')).not.toBe(pr.headRefOid);
    expect(f.check({ sha: 'lane/child' })).toEqual([]);
  });

  it('the refusal names the sibling lanes and the fix command', () => {
    const f = fixture();
    f.sibling(7357); f.sibling(7366); f.sibling(7374);
    f.git('checkout', '-b', 'lane/child'); f.commit('child');
    const result = runner(f)({ argv: ['--ref=lane/child', '--check'] });
    expect(result.outcome).toBe('refused');
    for (const pr of f.openPrs) {
      expect(result.detail).toContain(`#${pr.number}`);
      expect(result.detail).toContain(pr.headRefName);
      expect(result.detail).toContain(`git rebase --onto origin/main ${pr.headRefName} lane/child`);
    }
  });

  it('allows a stacked PR whose declared base is the sibling lane', () => {
    const f = fixture(), pr = f.sibling(236);
    f.git('checkout', '-b', 'lane/237'); f.commit('child');
    expect(f.check({ base: pr.headRefName })).toEqual([]);
  });

  it.each([true, undefined])('does not exempt a declared-base name collision without same-repository proof (%s)', isCrossRepository => {
    const f = fixture(), parent = f.sibling(236), fork = f.sibling(237);
    f.commit('child');
    const evidence = { ...fork, isCrossRepository };
    const expected = [{ number: fork.number, headRefName: parent.headRefName, count: 1 }];
    expect(f.check({ base: parent.headRefName, openPrs: [{ ...evidence, headRefName: parent.headRefName }] }))
      .toEqual(expected);
    expect(f.check({ base: parent.headRefName, openPrs: [evidence] }))
      .toEqual([{ ...expected[0], headRefName: fork.headRefName }]);
  });

  it.each([false, true])('allows updating a parent with an open stacked child (review fix: %s)', reviewFix => {
    const f = fixture(), parent = f.sibling(236);
    const child = { ...f.sibling(237), baseRefName: parent.headRefName,
      isCrossRepository: false };
    f.git('checkout', parent.headRefName);
    if (reviewFix) f.commit('parent-review-fix');
    const gh = vi.fn(() => JSON.stringify([child]));
    const siblingBase = opts => readSiblingBase({ ...opts, cwd: f.dir }, gh);
    const result = runner(f, { siblingBase })({ argv: [`--ref=${parent.headRefName}`, '--check'] });
    expect(result).toMatchObject({ outcome: 'checked', reason: 'check-ok' });
    expect(result.blockers ?? []).toEqual([]);
    expect(gh.mock.calls[0][0].at(-1).split(',')).toContain('baseRefName');
  });

  it('allows a parent with a deeper declared stack regardless of listing order', () => {
    const f = fixture(), parent = f.sibling(236), child = f.sibling(237), grandchild = f.sibling(238);
    child.baseRefName = parent.headRefName;
    grandchild.baseRefName = child.headRefName;
    f.git('checkout', parent.headRefName); f.commit('parent-review-fix');
    const opts = { cwd: f.dir, branch: parent.headRefName, git: createGitReader(f.dir), sha: 'HEAD' };
    expect(readSiblingBase(opts, () => JSON.stringify([grandchild, child, parent]))).toEqual([]);
  });

  it.each([true, undefined])('does not exempt a child without same-repository proof (%s)', isCrossRepository => {
    const f = fixture(), parent = f.sibling(236), child = f.sibling(237);
    child.baseRefName = parent.headRefName;
    child.isCrossRepository = isCrossRepository;
    f.git('checkout', parent.headRefName);
    expect(f.check({ branch: parent.headRefName, openPrs: [child] }))
      .toEqual([{ number: child.number, headRefName: child.headRefName, count: 1 }]);
  });

  it('does not follow a fork branch-name collision as an intermediate stack base', () => {
    const f = fixture(), parent = f.sibling(236), fork = f.sibling(237), grandchild = f.sibling(238);
    fork.baseRefName = parent.headRefName; fork.isCrossRepository = true;
    grandchild.baseRefName = fork.headRefName;
    f.git('checkout', parent.headRefName);
    expect(f.check({ branch: parent.headRefName, openPrs: [grandchild, fork] }).map(pr => pr.number))
      .toEqual([grandchild.number, fork.number]);
  });

  it('still refuses unrelated sibling ancestry when a declared child is open', () => {
    const f = fixture(), sibling = f.sibling(235), parent = f.sibling(236), child = f.sibling(237);
    child.baseRefName = parent.headRefName;
    f.git('checkout', parent.headRefName); f.commit('parent-review-fix');
    expect(f.check({ branch: parent.headRefName, openPrs: [child, sibling] }))
      .toEqual([{ number: sibling.number, headRefName: sibling.headRefName, count: 1 }]);
  });

  it.each([undefined, '', 'lane//parent', 'lane/../parent', 'lane/parent\n'])('fails closed on missing or invalid base metadata (%s)', baseRefName => {
    const f = fixture(), parent = f.sibling(236), child = f.sibling(237);
    f.git('checkout', parent.headRefName);
    expect(f.check({ branch: parent.headRefName, openPrs: [{ ...child, baseRefName }] }))
      .toMatchObject({ reason: 'sibling-base-unreadable' });
  });

  it('fails closed on ambiguous or cyclic declared stack evidence', () => {
    const f = fixture(), first = f.sibling(236), second = f.sibling(237);
    first.baseRefName = second.headRefName;
    second.baseRefName = first.headRefName;
    expect(f.check()).toMatchObject({ reason: 'sibling-base-unreadable' });
    expect(f.check({ openPrs: [first, { ...first, number: 238 }] }))
      .toMatchObject({ reason: 'sibling-base-unreadable' });
  });

  it('requires readable child commit objects before exempting a declared descendant', () => {
    const f = fixture(), parent = f.sibling(236), child = f.sibling(237);
    f.git('checkout', parent.headRefName);
    expect(f.check({ branch: parent.headRefName,
      openPrs: [{ ...child, baseRefName: parent.headRefName, headRefOid: 'f'.repeat(40) }] }))
      .toMatchObject({ reason: 'sibling-base-unreadable' });
  });

  it('fails closed when git state is unreadable', () => {
    const f = fixture(); f.sibling(236); f.commit('child');
    f.git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(f.check()).toMatchObject({ reason: 'sibling-base-unreadable' });
    expect(f.check({ git: () => { throw new Error('unreadable'); } })).toMatchObject({ reason: 'sibling-base-unreadable' });
    expect(f.check({ openPrs: null })).toMatchObject({ reason: 'sibling-base-unreadable' });
  });

  it('surfaces the sibling blocker in runner --check output and retains other gates', () => {
    const f = fixture(); f.sibling(236); f.commit('child');
    const spawn = vi.fn(() => ({ status: 3, stdout: JSON.stringify({ reason: 'verify-red', blockers: [{ gate: 'verify', reason: 'verify-red', detail: 'red' }] }) }));
    const result = runner(f, { spawn })({ argv: ['--ref=lane/child', '--check'] });
    expect(result.blockers.map(b => b.reason)).toEqual(['sibling-base', 'verify-red']);
    expect(result.detail).toContain('sibling-base');
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][1]).toContain('--check');
  });

  it('reads open PRs once with the runner env and excludes this ref', () => {
    const f = fixture(); f.sibling(236); f.commit('child');
    const env = { PATH: process.env.PATH };
    const gh = vi.fn(() => JSON.stringify([...f.openPrs,
      { number: 237, headRefName: 'lane/child', headRefOid: 'missing-self-is-excluded',
        isCrossRepository: false, headRepositoryOwner: { login: ghRepoSlug('we').split('/')[0] } }]));
    expect(readSiblingBase({ cwd: f.dir, env, branch: 'lane/child', git: createGitReader(f.dir), base: 'main', sha: 'HEAD' }, gh))
      .toEqual([{ number: 236, headRefName: 'lane/sibling-236', count: 1 }]);
    expect(gh).toHaveBeenCalledOnce();
    expect(gh).toHaveBeenCalledWith(['pr', 'list', '--repo', ghRepoSlug('we'), '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,headRefOid,baseRefName,headRepositoryOwner,isCrossRepository'],
      expect.objectContaining({ cwd: f.dir, env: { ...env, WE_GH_READ_MEMO_DIR: '' }, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
  });

  it.each([
    ['we', 'https://github.com/web-everything/web-everything.git'],
    ['frontierui', 'git@github.com:frontier-ui/frontierui.git'],
    ['plateau-app', 'ssh://git@github.com:443/plateauapp/plateau-app.git'],
    ['frontierui', 'https://github.com/chalbert/frontierui.git'],
  ])('uses the target checkout repository for listing and self-exclusion (%s, %s)', (key, remote) => {
    const f = fixture(), pr = f.sibling(236), slug = ghRepoSlug(key);
    f.git('remote', 'set-url', 'origin', remote);
    const owner = slug.split('/')[0];
    const gh = vi.fn(() => JSON.stringify([
      { ...pr, number: 237, headRefName: 'lane/child', headRefOid: 'excluded-self',
        headRepositoryOwner: { login: owner.toUpperCase() } },
      { ...pr, headRepositoryOwner: { login: owner } },
      { ...pr, number: 238, headRefName: 'lane/child', isCrossRepository: true,
        headRepositoryOwner: { login: owner } },
      { ...pr, number: 239, headRefName: 'lane/child', headRepositoryOwner: { login: 'other-owner' } },
    ]));
    const siblingBase = opts => readSiblingBase({ ...opts, cwd: f.dir }, gh);
    const result = runner(f, { siblingBase })({ argv: ['--ref=lane/child', '--check'] });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.detail).toContain('#236');
    expect(result.detail).toContain('#238');
    expect(result.detail).toContain('#239');
    expect(result.detail).not.toContain('#237');
    expect(gh).toHaveBeenCalledOnce();
    expect(gh.mock.calls[0][0]).toContain(slug);
  });

  it.each([null, '/local/repo', 'https://example.test/owner/repo.git'])('fails closed before listing when the checkout repository is unreadable (%s)', remote => {
    const f = fixture(), gh = vi.fn(() => '[]');
    if (remote === null) f.git('remote', 'remove', 'origin');
    else f.git('remote', 'set-url', 'origin', remote);
    const siblingBase = opts => readSiblingBase({ ...opts, cwd: f.dir }, gh);
    expect(runner(f, { siblingBase })({ argv: ['--ref=lane/child', '--check'] }))
      .toMatchObject({ outcome: 'refused', reason: 'sibling-base-unreadable' });
    expect(gh).not.toHaveBeenCalled();
  });

  it('keeps repository selection and ancestry in the target checkout despite inherited Git overrides', () => {
    const f = fixture(), decoy = fixture(), pr = f.sibling(236);
    f.git('remote', 'set-url', 'origin', `https://github.com/${ghRepoSlug('frontierui')}.git`);
    const gh = vi.fn(() => JSON.stringify([pr]));
    const inherited = { GIT_DIR: join(decoy.dir, '.git'), GIT_WORK_TREE: decoy.dir,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url',
      GIT_CONFIG_VALUE_0: `https://github.com/${ghRepoSlug('plateau-app')}.git` };
    try {
      Object.entries(inherited).forEach(([key, value]) => vi.stubEnv(key, value));
      expect(readSiblingBase({ cwd: f.dir }, gh))
        .toEqual([{ number: pr.number, headRefName: pr.headRefName, count: 1 }]);
      expect(gh.mock.calls[0][0]).toContain(ghRepoSlug('frontierui'));
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([true, undefined])('retains a same-name PR without same-repository proof (cross-repository: %s)', isCrossRepository => {
    const f = fixture(); const pr = f.sibling(236);
    const gh = () => JSON.stringify([{ ...pr, isCrossRepository,
      headRepositoryOwner: { login: ghRepoSlug('we').split('/')[0] } }]);
    expect(readSiblingBase({ cwd: f.dir, branch: pr.headRefName, git: createGitReader(f.dir), sha: pr.headRefOid }, gh))
      .toEqual([{ number: 236, headRefName: pr.headRefName, count: 1 }]);
  });

  it('disables the read memo in both the throttle and child environments', () => {
    const f = fixture(); f.sibling(236);
    const env = { WE_GH_READ_MEMO_DIR: join(f.dir, 'memo') };
    const gh = vi.fn((_args, opts) => opts.throttle?.env.WE_GH_READ_MEMO_DIR
      ? '[]' : JSON.stringify(f.openPrs));
    expect(readSiblingBase({ cwd: f.dir, env, git: createGitReader(f.dir), sha: 'HEAD' }, gh)).toHaveLength(1);
    const opts = gh.mock.calls[0][1];
    expect(opts.throttle.env.WE_GH_READ_MEMO_DIR).toBe('');
    expect(opts.env.WE_GH_READ_MEMO_DIR).toBe('');
    expect(env.WE_GH_READ_MEMO_DIR).toBe(join(f.dir, 'memo'));
  });

  it.each(['overlap', 'unreadable'])('rechecks the canonical audit sha and refuses %s before publication', evidence => {
    const f = fixture(); const clean = f.git('rev-parse', 'HEAD');
    f.sibling(236); const audited = f.commit('child');
    const siblingBase = vi.fn(({ sha }) => {
      if (sha === audited && evidence === 'unreadable') throw new Error('missing audited objects');
      return f.check({ sha });
    });
    const spawn = vi.fn(() => ({ status: 0, stdout: '{"reason":"check-ok"}' }));
    const result = runner(f, { siblingBase, spawn, canonicalAudit: () => ({ ok: true, sha: audited }) })
      ({ argv: ['--ref=lane/child', `--sha=${clean}`] });
    expect(siblingBase.mock.calls.map(([opts]) => opts.sha)).toEqual([clean, audited]);
    expect(result).toMatchObject({ outcome: 'refused', reason: evidence === 'overlap' ? 'sibling-base' : 'sibling-base-unreadable' });
    expect(spawn.mock.calls[0][1]).toContain('--check');
    expect(spawn.mock.calls[0][1]).toContain(`--sha=${audited}`);
  });

  it('refuses an oversized or malformed open PR listing with an operator fallback', () => {
    const f = fixture();
    for (const evidence of [Array(1000).fill({}), null, '{bad-json']) {
      const siblingBase = opts => readSiblingBase({ ...opts, cwd: f.dir },
        () => typeof evidence === 'string' ? evidence : JSON.stringify(evidence));
      const result = runner(f, { siblingBase })({ argv: ['--ref=lane/child', '--check'] });
      expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unreadable' });
      expect(result.detail).toContain('retry --check');
      if (Array.isArray(evidence)) expect(result.detail).toContain('ask a human');
    }
  });

  it('refuses unreadable PR and Git evidence in the runner, including read limits', () => {
    const f = fixture();
    for (const siblingBase of [() => { throw new Error('GitHub unavailable'); }, () => undefined,
      () => f.check({ git: () => { throw new Error('maxBuffer exceeded'); } })]) {
      const result = runner(f, { siblingBase })({ argv: ['--ref=lane/child', '--check'] });
      expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unreadable' });
      expect(result.detail).toContain('retry --check');
    }
  });

  it('fails closed on missing sibling objects and bounds each Git read', () => {
    const f = fixture(); f.sibling(236); f.commit('child');
    expect(f.check({ openPrs: [{ ...f.openPrs[0], headRefOid: 'f'.repeat(40) }] }))
      .toMatchObject({ reason: 'sibling-base-unreadable' });
    const real = createGitReader(f.dir), git = vi.fn((...args) => real(...args));
    expect(f.check({ git })).toHaveLength(1);
    for (const [, opts] of git.mock.calls) {
      expect(opts).toMatchObject({ timeout: 5000, maxBuffer: 8 * 1024 * 1024,
        env: { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' } });
      const pins = Object.fromEntries(Array.from({ length: Number(opts.env.GIT_CONFIG_COUNT) }, (_, i) =>
        [opts.env[`GIT_CONFIG_KEY_${i}`], opts.env[`GIT_CONFIG_VALUE_${i}`]]));
      expect(pins['core.commitGraph']).toBe('false');
    }
  });
});

function runner(f, opts = {}) {
  return createPrLandRunner({ cwd: f.dir, env: {},
    spawn: () => ({ status: 0, stdout: '{"reason":"check-ok"}' }),
    prepGate: () => ({ ok: true }), prePrReview: () => ({ action: 'pass' }),
    canonicalAudit: () => ({ ok: true }),
    siblingBase: ({ base, sha }) => f.check({ base, sha }), ...opts });
}
