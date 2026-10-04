import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pushMissingRunCommit, recoveryPushCredential, RECOVERY_COMMIT_MARKER } from '../missing-run-push.mjs';
import { countMissingRunComments, buildMissingRunComment } from '../main-red-recovery.mjs';

const sha = '1f7481b9bccf75ae1c37ed5705ec2ab57d77a9c7';
const next = 'a'.repeat(40);
const repo = 'web-everything/web-everything';
const d = { prNumber: 3209, headRefName: 'lane/model-routing', headSha: sha };
const pr = { state: 'open', mergeable: true, head: { sha, ref: d.headRefName, repo: { full_name: repo } }, base: { ref: 'main' } };
function fixture({ live = pr, fetched = sha, message = 'fix', failPush = false, checkClaim = () => null,
  env = { GH_TOKEN: 'ghp_test-secret' } } = {}) {
  const calls = [];
  const exec = vi.fn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'gh') {
      expect(args).toEqual(['api', `repos/${repo}/pulls/3209`]);
      return JSON.stringify(live);
    }
    if (args.includes('FETCH_HEAD')) return fetched;
    if (args.includes('show')) return message;
    if (args.includes(`${sha}^{tree}`)) return 'b'.repeat(40);
    if (args.includes('commit-tree')) return next;
    if (args.includes('push') && failPush) throw new Error('secret credential in error');
    return '';
  });
  const result = pushMissingRunCommit(d, { repo, exec, env, checkClaim });
  return { result, calls, exec };
}
describe('missing-run PR-event recovery', () => {
  it('assembles a real unchanged-tree commit in a scratch repository (network and push intercepted)', () => {
    const seed = mkdtempSync(join(tmpdir(), 'we-recovery-seed-'));
    try {
      const seedGit = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
        { cwd: seed, encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      seedGit('init', '--bare', '.');
      const tree = seedGit('mktree');
      const head = seedGit('commit-tree', tree, '-m', 'original');
      seedGit('update-ref', `refs/heads/${d.headRefName}`, head);
      let observedPush = false;
      const result = pushMissingRunCommit({ ...d, headSha: head }, {
        repo, env: { PATH: process.env.PATH, GH_TOKEN: 'ghp_test-secret' }, checkClaim: () => null,
        exec(cmd, args, opts) {
          if (cmd === 'gh') return JSON.stringify({ ...pr, head: { ...pr.head, sha: head } });
          if (args.includes('push')) {
            observedPush = true;
            const newHead = args.at(-1).split(':')[0];
            const actual = execFileSync('git', ['show', '-s', '--format=%T%n%P%n%B', newHead], opts).trim();
            expect(actual).toBe(`${tree}\n${head}\nci: recover missing PR checks\n\n${RECOVERY_COMMIT_MARKER} ${head}`);
            expect(opts.cwd).not.toBe(seed);
            return ''; // Never execute a push, including to the local fixture.
          }
          // Fetch only from the fixture; no GitHub network call is possible.
          return execFileSync(cmd, args.map(a => a === `https://github.com/${repo}.git` ? seed : a), opts);
        },
      });
      expect(result.ok).toBe(true);
      expect(observedPush).toBe(true);
      expect(seedGit('rev-parse', `refs/heads/${d.headRefName}`)).toBe(head);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
  });
  it('pushes an unchanged tree with the observed head as sole parent and exact lease', () => {
    const { result, calls } = fixture();
    expect(result).toEqual({ ok: true, action: 'pull-request-push', newHeadSha: next });
    const commit = calls.find(c => c.args.includes('commit-tree'));
    expect(commit.args.slice(commit.args.indexOf('commit-tree'))).toEqual([
      'commit-tree', 'b'.repeat(40), '-p', sha, '-m', `ci: recover missing PR checks\n\n${RECOVERY_COMMIT_MARKER} ${sha}`,
    ]);
    const push = calls.find(c => c.args.includes('push'));
    expect(push.args.slice(push.args.indexOf('push'))).toEqual(['push', `--force-with-lease=refs/heads/${d.headRefName}:${sha}`,
      `https://github.com/${repo}.git`, `${next}:refs/heads/${d.headRefName}`]);
    expect(push.opts.env.WE_CI_PUSH_TOKEN).toBe('ghp_test-secret');
    expect(push.args).toContain('credential.helper=');
    expect(JSON.stringify(calls.map(c => c.args))).not.toContain('ghp_test-secret');
    expect(calls.some(c => c.args.includes('workflow'))).toBe(false);
  });
  it.each([false, null])('does not mutate when mergeable is %s', mergeable => {
    const { result, calls } = fixture({ live: { ...pr, mergeable } });
    expect(result).toMatchObject({ ok: false, deferred: true });
    expect(calls).toHaveLength(1);
  });
  it.each([
    { ...pr, state: 'closed' },
    { ...pr, head: { ...pr.head, sha: next } },
  ])('defers (free, transient) when the PR head or state changed', live => {
    expect(fixture({ live }).calls).toHaveLength(1);
    expect(fixture({ live }).result.deferred).toBe(true);
  });
  it('does not push after a fetch race, or after a previous recovery even if its comment was lost', () => {
    // A fetch race is transient (deferred, free). A marked tip is terminal: a counted failure so the cap can hand it off.
    const race = fixture({ fetched: next });
    expect(race.result.deferred).toBe(true);
    const marked = fixture({ message: `ci: recovery\n\n${RECOVERY_COMMIT_MARKER} old` });
    expect(marked.result).toMatchObject({ ok: false, error: expect.stringContaining('needs ci-heal') });
    expect(marked.result.deferred).toBeUndefined();
    for (const { calls } of [race, marked]) expect(calls.some(c => c.args.includes('push') || c.args.includes('commit-tree'))).toBe(false);
  });
  it('reports a stacked or fork PR as a counted failure (not a free deferral) and never pushes', () => {
    const stacked = fixture({ live: { ...pr, base: { ref: 'lane/other' } } });
    const fork = fixture({ live: { ...pr, head: { ...pr.head, repo: { full_name: 'someone/web-everything' } } } });
    for (const { result, calls } of [stacked, fork]) {
      expect(result).toMatchObject({ ok: false, action: 'pull-request-push', error: expect.stringContaining('stacked or from a fork') });
      expect(result.deferred).toBeUndefined();
      expect(calls.every(c => c.cmd === 'gh')).toBe(true);
    }
  });
  it('never calls the raw update-branch endpoint (it reintroduces the .lane-manifest.json collision)', () => {
    const scenarios = [{}, { failPush: true }, { fetched: next }, { live: { ...pr, base: { ref: 'lane/other' } } }];
    for (const options of scenarios) {
      const { calls } = fixture(options);
      for (const c of calls) expect([c.cmd, ...c.args].join(' ')).not.toMatch(/update-branch|rebase|merge/);
    }
  });
  it('reports a failed fetch with its stage-named error without throwing or leaking the credential', () => {
    const exec = vi.fn((cmd, args) => {
      if (cmd === 'gh') return JSON.stringify(pr);
      if (args.includes('fetch')) throw new Error('fatal: ghp_test-secret rejected');
      return '';
    });
    let result;
    expect(() => { result = pushMissingRunCommit(d, { repo, exec, env: { GH_TOKEN: 'ghp_test-secret' }, checkClaim: () => null }); }).not.toThrow();
    expect(result).toEqual({ ok: false, action: 'pull-request-push', error: 'missing-run recovery failed during fetch' });
    expect(JSON.stringify(result)).not.toContain('ghp_test-secret');
  });
  it('checks fixer ownership again immediately before pushing', () => {
    const checkClaim = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce({ message: 'fixer holds claim' });
    const { result, calls } = fixture({ checkClaim });
    expect(result).toMatchObject({ deferred: true, error: 'fixer holds claim' });
    expect(calls.some(c => c.args.includes('push'))).toBe(false);
  });
  it('reports a push failure without claiming CI started or exposing child credentials', () => {
    expect(fixture({ failPush: true }).result).toEqual({ ok: false, action: 'pull-request-push', error: 'missing-run recovery failed during push' });
  });
  it('rejects Actions and unknown installation tokens; accepts a token-bound conveyor App token', () => {
    const token = 'ghs_example';
    expect(recoveryPushCredential(token, { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo })).toBe(false);
    expect(recoveryPushCredential(token)).toBe(false);
    const env = { WE_GH_AUTH_INSTALLATION: '123', WE_GH_AUTH_TOKEN_HASH: createHash('sha256').update(token).digest('hex') };
    expect(recoveryPushCredential(token, env)).toBe(true);
    expect(recoveryPushCredential('ghs_other', env)).toBe(false);
    expect(recoveryPushCredential('github_pat_example')).toBe(true);
    expect(recoveryPushCredential('gho_example')).toBe(true);
  });
  it('never invokes git with an unverified installation credential', () => {
    const { result, calls } = fixture({ env: { GH_TOKEN: 'ghs_actions' } });
    // Structural, not transient: a counted failure so the per-sha cap hands the PR off (no free deferral).
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('push requires a PAT') });
    expect(result.deferred).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
  it('falls back to `gh auth token` when no token env is set, and counts an ineligible one', () => {
    const run = (authToken) => {
      const calls = [];
      const exec = vi.fn((cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        if (cmd === 'gh' && args[0] === 'api') return JSON.stringify(pr);
        if (cmd === 'gh' && args[0] === 'auth') return `${authToken}\n`;
        if (args.includes('FETCH_HEAD')) return sha;
        if (args.includes('commit-tree')) return next;
        if (args.includes(`${sha}^{tree}`)) return 'b'.repeat(40);
        if (args.includes('show')) return 'fix';
        return '';
      });
      return { result: pushMissingRunCommit(d, { repo, exec, env: {}, checkClaim: () => null }), calls };
    };
    const bad = run('ghs_unbound');
    expect(bad.calls).toContain('gh auth token --hostname github.com');
    expect(bad.result).toMatchObject({ ok: false, error: expect.stringContaining('push requires a PAT') });
    expect(bad.result.deferred).toBeUndefined();
    const good = run('ghp_from_gh_cli');
    expect(good.calls).toContain('gh auth token --hostname github.com');
    expect(good.result.ok).toBe(true);
  });
  it('honours a non-default defaultBranch when judging stacked PRs', () => {
    const onDev = { ...pr, base: { ref: 'develop' } };
    const run = (defaultBranch) => pushMissingRunCommit(d, { repo, defaultBranch, env: { GH_TOKEN: 'ghp_test-secret' }, checkClaim: () => null,
      exec: (cmd, args) => (cmd === 'gh' ? JSON.stringify(onDev)
        : args.includes('FETCH_HEAD') ? sha : args.includes('commit-tree') ? next : args.includes('show') ? 'fix' : args.includes(`${sha}^{tree}`) ? 'b'.repeat(40) : '') });
    expect(run('main')).toMatchObject({ ok: false, error: expect.stringContaining('stacked or from a fork') });
    expect(run('develop')).toEqual({ ok: true, action: 'pull-request-push', newHeadSha: next });
  });
  it('isolates git from inherited repository, config and index overrides', () => {
    const { calls } = fixture({ env: { GH_TOKEN: 'ghp_test-secret', GIT_DIR: '/daemon/.git',
      GIT_INDEX_FILE: '/daemon/index', GIT_CONFIG_COUNT: '1', GIT_CONFIG_GLOBAL: '/daemon/config' } });
    const push = calls.find(c => c.args.includes('push'));
    expect(push.opts.env.GIT_DIR).toBeUndefined();
    expect(push.opts.env.GIT_INDEX_FILE).toBeUndefined();
    expect(push.opts.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(push.opts.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(push.opts.cwd).not.toContain('/daemon');
  });
  it('old dispatch attempts cannot exhaust the new PR-event recovery budget', () => {
    const comments = ['workflow-dispatch', 'workflow-dispatch', 'pull-request-push'].map(action => ({
      author: { login: 'web-everything' }, body: buildMissingRunComment({ headSha: sha, action }),
    }));
    expect(countMissingRunComments(comments, sha)).toBe(1);
  });
  it('records the new head without claiming that checks were observed', () => {
    const body = buildMissingRunComment({ headSha: sha, newHeadSha: next });
    expect(body).toContain(`sha: ${sha}\nrecovery-sha: ${next}`);
    expect(body).toContain('requested CI via pull-request-push; PR checks must still be observed');
    expect(body).not.toContain('triggered CI');
  });
});
