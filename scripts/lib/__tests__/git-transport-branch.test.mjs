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
import { stageOnTransportBranch, reclaimStrandedTransportWorktrees } from '../git-transport-branch.mjs';

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
  it('stays detached without claiming the shared local branch', () => {
    const s = stub();
    stage(s);
    const checkouts = s.calls.filter((c) => c.args?.[0] === 'checkout');
    expect(checkouts).toEqual([]);
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
    expect(s.calls.find((c) => c.args?.[0] === 'push').args).toContain('HEAD:refs/heads/ops/x');
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

describe('stranded transport safety and useful git errors', () => {
  it.each([
    ['fresh', '/board/.operations/transport/wt-599999'],
    ['outside transport', '/board/other/wt-1'],
    ['prefix sibling', '/board/.operations/transport-other/wt-1'],
    ['not a transport name', '/board/.operations/transport/manual'],
    ['current run', '/board/.operations/transport/wt-1'],
  ])('never touches a %s worktree', (_label, path) => {
    const calls = [];
    reclaimStrandedTransportWorktrees({
      board: '/board', branch: 'ops/x', now: () => 600001,
      exclude: '/board/.operations/transport/wt-1',
      run: (args) => { calls.push(args); return 'worktree ' + path + '\nHEAD abc\ndetached\n\n'; },
    });
    expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
  });

  it.each(['fetch', 'commit'])('puts git stderr on the first line for %s failures', (command) => {
    const original = Object.assign(new Error('Command failed: git ' + command), {
      status: 128, stderr: Buffer.from("hint: context\nfatal: 'x' is already used by worktree at '/b'\nhint: trailing advice\n"),
    });
    const s = stub({ onRun: (args) => { if (args[0] === command) throw original; } });
    let caught;
    try { stage(s); } catch (e) { caught = e; }
    expect(caught.message.split('\n')[0]).toMatch(/^git .* failed: fatal: 'x' is already used by worktree at '\/b'$/);
    expect(caught.cause).toBe(original);
    expect(caught.status).toBe(128);
    expect(caught.stderr).toBe(original.stderr);
  });
});

describe('recovery preserves before removing and fails safely', () => {
  const path = '/board/.operations/transport/wt-1';
  const recover = ({ dirty = false, ancestor = false, fail } = {}) => {
    const calls = []; const logs = [];
    reclaimStrandedTransportWorktrees({
      board: '/board', branch: 'ops/x', now: () => 600001, exists: () => true,
      log: (line) => logs.push(line),
      run: (args, opts) => {
        calls.push({ args, ...opts });
        if (args[0] === fail) throw new Error('probe failed');
        if (args[0] === 'worktree' && args[1] === 'list') return 'worktree ' + path + '\nHEAD abc\n\n';
        if (args[0] === 'status') return dirty ? '?? uncommitted.txt\n' : '';
        if (args[0] === 'rev-parse') return 'abc\n';
        if (args[0] === 'merge-base' && !ancestor) throw Object.assign(new Error('not ancestor'), { status: 1 });
        return '';
      },
    });
    return { calls, logs };
  };
  it('guards worktree probes and saves the commit before removal', () => {
    const { calls, logs } = recover();
    expect(calls.map((c) => c.args[0])).toEqual(['worktree', 'ls-files', 'status', 'rev-parse', 'merge-base', 'update-ref', 'worktree']);
    calls.splice(1, 1); // the index-bit probe; the indices below address the rest of the sequence
    expect(calls[4]).toMatchObject({ cwd: '/board', args: ['update-ref', 'refs/transport-stranded/wt-1', 'abc'] });
    expect(calls[5].args).toEqual(['worktree', 'remove', '--force', path]);
    for (const c of calls.filter((c) => c.cwd === path)) {
      expect(c.env.GIT_CEILING_DIRECTORIES).toBe('/board/.operations/transport');
      expect(c.env.GIT_DIR).toBeUndefined();
    }
    expect(logs[0]).toContain('refs/transport-stranded/wt-1');
  });
  it('needs no backup when origin already contains the commit', () => {
    const { calls } = recover({ ancestor: true });
    expect(calls.some((c) => c.args[0] === 'update-ref')).toBe(false);
    expect(calls.at(-1).args).toEqual(['worktree', 'remove', '--force', path]);
  });
  it.each([{ dirty: true }, { fail: 'status' }, { fail: 'ls-files' }, { fail: 'rev-parse' }, { fail: 'update-ref' }])('leaves work untouched when unsafe: %j', (opts) => {
    const { calls, logs } = recover(opts);
    expect(calls.some((c) => c.args[1] === 'remove')).toBe(false);
    expect(logs.join()).toContain(path);
  });
  it('a failed sweep never fails the write', () => {
    const logs = [];
    const s = stub({ onRun: (args) => {
      if (args[0] === 'worktree' && args[1] === 'list') throw new Error('listing failed');
    } });
    expect(stage(s, { log: (line) => logs.push(line) }).pushed).toBe(true);
    expect(logs.join()).toContain('listing failed');
  });
});

describe('liveness, not age, decides whether a stale-looking worktree is abandoned (red team 2026-10-11)', () => {
  const path = '/board/.operations/transport/wt-1';
  const sweep = ({ owner = null, alive = () => false, readThrows = false } = {}) => {
    const calls = []; const removed = []; const probed = [];
    reclaimStrandedTransportWorktrees({
      board: '/board', branch: 'ops/x', now: () => 600001, exists: () => true, log: () => {},
      read: (p) => {
        probed.push(p);
        if (readThrows) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return owner;
      },
      alive: (pid) => { probed.push(`pid:${pid}`); return alive(pid); },
      rm: (p) => removed.push(p),
      run: (args) => {
        calls.push(args);
        if (args[0] === 'worktree' && args[1] === 'list') return `worktree ${path}\nHEAD abc\n\n`;
        if (args[0] === 'rev-parse') return 'abc\n';
        if (args[0] === 'merge-base') throw Object.assign(new Error('x'), { status: 1 });
        return '';
      },
    });
    return { calls, removed, probed };
  };
  it('leaves an old, clean worktree alone while its writer process is alive', () => {
    const { calls, probed } = sweep({ owner: '{"pid":4242}\n', alive: (pid) => pid === 4242 });
    expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
    expect(probed).toEqual(['/board/.operations/transport/wt-1.owner', 'pid:4242']);
  });
  it('reclaims it once the writer is gone, and drops the owner record with it', () => {
    const { calls, removed } = sweep({ owner: '{"pid":4242}\n' });
    expect(calls.at(-1)).toEqual(['worktree', 'remove', '--force', path]);
    expect(removed).toEqual(['/board/.operations/transport/wt-1.owner']);
  });
  it.each([['no record', null], ['garbled record', '{"pi'], ['bad pid', '{"pid":"x"}']])('falls back to the age rule with %s', (_l, owner) => {
    expect(sweep({ owner }).calls.at(-1)).toEqual(['worktree', 'remove', '--force', path]);
  });
  it('leaves it alone when the owner record cannot be read', () => {
    expect(sweep({ readThrows: true }).calls.some((c) => c[1] === 'remove')).toBe(false);
  });
  it('records its own pid before creating the worktree and removes the record afterwards', () => {
    const s = stub();
    stage(s);
    const owner = '/board/.operations/transport/wt-111.owner';
    const at = (pred) => s.calls.findIndex(pred);
    const wrote = at((c) => c.fs === 'write' && c.path === owner);
    expect(JSON.parse(s.calls[wrote].content).pid).toBe(process.pid);
    expect(wrote).toBeLessThan(at((c) => c.args?.[0] === 'worktree' && c.args?.[1] === 'add'));
    expect(s.calls.filter((c) => c.fs === 'rm').some((c) => c.path === owner)).toBe(true);
  });
  it('a failing owner write never fails the transport write', () => {
    const s = stub();
    s.seams.write = (p, c) => { if (p.endsWith('.owner')) throw new Error('disk full'); s.calls.push({ fs: 'write', path: p, content: c }); };
    expect(stage(s).pushed).toBe(true);
  });
});

describe('the dirty guard sees untracked files whatever the git config says (red team 2026-10-11)', () => {
  it('asks for untracked and ignored files explicitly, on the command line', () => {
    const { calls } = (() => {
      const calls = [];
      reclaimStrandedTransportWorktrees({
        board: '/board', branch: 'ops/x', now: () => 600001, exists: () => true, log: () => {}, read: () => null,
        run: (args) => { calls.push(args); return args[0] === 'worktree' ? 'worktree /board/.operations/transport/wt-1\n\n' : ''; },
      });
      return { calls };
    })();
    const status = calls.find((c) => c[0] === 'status');
    expect(status).toEqual(expect.arrayContaining(['--porcelain', '--untracked-files=all', '--ignored=traditional', '--ignore-submodules=none']));
  });

  it.each([
    ['status.showUntrackedFiles=no hides an unadded file', (git, board, wt, wf, j) => {
      git(['config', 'status.showUntrackedFiles', 'no'], board);
      wf(j(wt, 'net.diff'), 'request written just before the writer died\n');
    }],
    ['--assume-unchanged hides an edit to a tracked file', (git, board, wt, wf, j) => {
      git(['update-index', '--assume-unchanged', 'a.txt'], wt);
      wf(j(wt, 'a.txt'), 'edited and hidden\n');
    }],
    ['--skip-worktree hides an edit to a tracked file', (git, board, wt, wf, j) => {
      git(['update-index', '--skip-worktree', 'a.txt'], wt);
      wf(j(wt, 'a.txt'), 'edited and hidden\n');
    }],
  ])('with real git, a worktree whose work is hidden is NOT removed: %s', async (_label, hide) => {
    const { mkdtempSync, writeFileSync: wf, rmSync: rmf, existsSync, readFileSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: j } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
    const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    // realpath: git lists worktrees by their real path, and the sweep compares against `<board>/.operations/transport`.
    const root = realpathSync(mkdtempSync(j(tmpdir(), 'transport-untracked-')));
    try {
      const origin = j(root, 'origin.git'); const board = j(root, 'board');
      git(['init', '--quiet', '--bare', '-b', 'main', origin], root);
      git(['clone', '--quiet', origin, board], root);
      wf(j(board, 'a.txt'), 'x\n'); git(['add', '.'], board); git(['commit', '--quiet', '-m', 'm'], board);
      git(['push', '--quiet', 'origin', 'main'], board);
      const wt = j(board, '.operations', 'transport', 'wt-1');
      git(['worktree', 'add', '--detach', '--force', wt, 'HEAD'], board);
      hide(git, board, wt, wf, j);
      expect(git(['status', '--porcelain'], wt).trim()).toBe(''); // plain status really is blind to it
      const logs = [];
      reclaimStrandedTransportWorktrees({ board, branch: 'main', now: () => 600001, log: (l) => logs.push(l) });
      expect(logs.join()).toContain('dirty stranded worktree'); // skipped BECAUSE it is dirty, not for another reason
      expect(git(['worktree', 'list'], board)).toContain('wt-1');
      expect(existsSync(wt)).toBe(true);
      const kept = existsSync(j(wt, 'net.diff')) ? 'net.diff' : 'a.txt';
      expect(readFileSync(j(wt, kept), 'utf8')).toMatch(/request written|edited and hidden/);
    } finally { rmf(root, { recursive: true, force: true }); }
  });
});
