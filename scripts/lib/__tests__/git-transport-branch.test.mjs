/**
 * @file git-transport-branch.test.mjs — the worktree dance every credential-less transport pushes through
 *   (#xaoja7a).
 *
 * THESE ARE `record-verdict`'s HAZARDS, ASSERTED WHERE THE CODE NOW LIVES. When the dance was inlined in
 * `we:scripts/operations/record-verdict-io.mjs` its suite pinned each of them; extracting it for the PR-view
 * transport would have left the properties asserted only through one caller, so they are pinned here too — a
 * second caller must not be able to lose them by construction.
 */
import { describe, it, expect } from 'vitest';
import { stageOnTransportBranch } from '../git-transport-branch.mjs';

/** Every side effect stubbed, filesystem included. See the header of the module under test for why. */
const stub = ({ diff = 'ops/x/a.json', onRun } = {}) => {
  const calls = [];
  const run = (args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    if (onRun) { const r = onRun(args); if (r !== undefined) return r; }
    return args[0] === 'diff' ? diff : '';
  };
  return {
    calls,
    seams: {
      run,
      mkdir: (p) => calls.push({ fs: 'mkdir', path: p }),
      write: (p, c) => calls.push({ fs: 'write', path: p, content: c }),
      rm: (p) => calls.push({ fs: 'rm', path: p }),
      now: () => 111,
    },
  };
};
const stage = (s, over = {}) => stageOnTransportBranch({
  board: '/board', branch: 'ops/x', files: [{ path: 'ops/x/a.json', content: '{}\n' }], message: 'm',
  ...s.seams, ...over,
});

describe('it never checks the transport branch out over the caller\'s tree', () => {
  /**
   * The caller is standing in a lane with uncommitted work. Checking a transport branch out over that lane
   * destroys it — done by hand once, and it disrupted a running juror mid-review.
   */
  it('runs every checkout inside its own worktree, never in the board root', () => {
    const s = stub();
    stage(s);
    const checkouts = s.calls.filter((c) => c.args?.[0] === 'checkout');
    expect(checkouts.length).toBeGreaterThan(0);
    for (const c of checkouts) expect(c.cwd).not.toBe('/board');
  });

  it('writes only under the worktree it created', () => {
    const s = stub();
    stage(s);
    const writes = s.calls.filter((c) => c.fs);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.path.startsWith('/board/.operations/transport')).toBe(true);
  });
});

describe('the cleanup that stops one bad run becoming every subsequent one', () => {
  it('removes the directory AND prunes the registration, even when the push throws', () => {
    const s = stub({ onRun: (args) => { if (args[0] === 'push') throw new Error('network'); } });
    expect(() => stage(s)).toThrow(/network/);
    expect(s.calls.some((c) => c.fs === 'rm')).toBe(true);
    expect(s.calls.some((c) => c.args?.[0] === 'worktree' && c.args?.[1] === 'prune')).toBe(true);
  });

  // Pruning in the DRIVER's checkout would leave a stale registration in the repo that will need it (#3261).
  it('prunes in the board, not wherever the driver happens to stand', () => {
    const s = stub();
    stage(s);
    const prune = s.calls.find((c) => c.args?.[0] === 'worktree' && c.args?.[1] === 'prune');
    expect(prune.cwd).toBe('/board');
  });
});

describe('what it pushes, and when it does not', () => {
  it('pushes to the branch CI actually watches', () => {
    const s = stub();
    expect(stage(s).pushed).toBe(true);
    expect(s.calls.find((c) => c.args?.[0] === 'push').args).toContain('HEAD:ops/x');
  });

  // Identical bytes already staged is what `idempotent: true` promises on replay, not a failure to report.
  it('treats "nothing to commit" as success and pushes nothing', () => {
    const s = stub({ diff: '' });
    expect(stage(s)).toMatchObject({ pushed: false });
    expect(s.calls.some((c) => c.args?.[0] === 'push')).toBe(false);
    expect(s.calls.some((c) => c.args?.[0] === 'commit')).toBe(false);
  });

  it('stages every file it was given, not just the first', () => {
    const s = stub();
    stage(s, { files: [{ path: 'ops/x/a.json', content: 'a' }, { path: 'ops/x/b.json', content: 'b' }] });
    const added = s.calls.filter((c) => c.args?.[0] === 'add').map((c) => c.args[2]);
    expect(added).toEqual(['ops/x/a.json', 'ops/x/b.json']);
  });

  // #3779: starting a branch is opt-in. Every existing transport must still refuse a branch CI never created.
  it('never asks whether the branch exists unless the caller opted into creating it', () => {
    const s = stub();
    stage(s);
    expect(s.calls.some((c) => c.args?.[0] === 'ls-remote')).toBe(false);
  });

  it('with `createIfAbsent`, starts a missing branch as an orphan and pushes a full refname', () => {
    const s = stub({ onRun: (args) => (args[0] === 'ls-remote' ? '' : undefined) });
    expect(stage(s, { createIfAbsent: true })).toMatchObject({ pushed: true, created: true });
    const verbs = s.calls.filter((c) => c.args).map((c) => c.args[0]);
    expect(verbs).not.toContain('fetch');
    expect(s.calls.find((c) => c.args?.[0] === 'read-tree').args).toEqual(['read-tree', '--empty']);
    expect(s.calls.find((c) => c.args?.[0] === 'push').args).toContain('HEAD:refs/heads/ops/x');
  });

  it('refuses a call with nothing to stage rather than pushing an empty commit', () => {
    const s = stub();
    expect(() => stage(s, { files: [] })).toThrow(/nothing to stage/);
    expect(() => stageOnTransportBranch({ branch: 'ops/x', files: [{ path: 'a', content: 'b' }] })).toThrow(/`board` and `branch`/);
  });
});

describe('a broken worktree can never fall through to the board (live 2026-10-09 review-daemon outage)', () => {
  /**
   * The review daemon's clone was found checked out on `ops/review-requests` with the ledger file staged: a
   * `checkout -B` meant for the transport worktree had run on the board. Replay with real git: the worktree's
   * `.git` file vanishes right after `worktree add`, so an unguarded call from `cwd: wt` walks up into the board.
   */
  it('refuses loudly and leaves the board on main with its tree intact', async () => {
    const { mkdtempSync, mkdirSync: mk, writeFileSync: wf, rmSync: rmf, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    const git = (args, cwd, extra = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    const root = mkdtempSync(j(tmpdir(), 'transport-fallthrough-'));
    const origin = j(root, 'origin.git'); const board = j(root, 'board');
    git(['init', '--quiet', '--bare', '-b', 'main', origin], root);
    git(['clone', '--quiet', origin, board], root);
    mk(j(board, 'skills-src')); wf(j(board, 'skills-src/daemon.mjs'), 'x\n');
    wf(j(board, '.gitignore'), '.operations/\n');
    git(['add', '.'], board); git(['commit', '--quiet', '-m', 'main'], board); git(['push', '--quiet', 'origin', 'main'], board);
    git(['checkout', '--quiet', '--orphan', 'ops/x'], board); git(['rm', '-r', '--quiet', '-f', '.'], board);
    wf(j(board, 'ledger.jsonl'), '{}\n'); git(['add', 'ledger.jsonl'], board); git(['commit', '--quiet', '-m', 'ledger'], board);
    git(['push', '--quiet', 'origin', 'ops/x'], board); git(['checkout', '--quiet', '-f', 'main'], board);

    const run = (args, opts = {}) => {
      const out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { ...env, ...(opts.env || {}) } });
      if (args[0] === 'worktree' && args[1] === 'add') rmf(j(args[args.length - 2], '.git'), { force: true }); // the break
      return out;
    };
    expect(() => stageOnTransportBranch({ board, branch: 'ops/x', files: [{ path: 'ledger.jsonl', content: '{"a":1}\n' }], message: 'm', run }))
      .toThrow();
    expect(git(['symbolic-ref', '--short', 'HEAD'], board).trim()).toBe('main');
    expect(existsSync(j(board, 'skills-src/daemon.mjs'))).toBe(true);
    expect(git(['status', '--porcelain', '--untracked-files=no'], board).trim()).toBe('');
    rmf(root, { recursive: true, force: true });
  });
});
