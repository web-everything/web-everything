import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPrLandRunner } from '../open-pr-io.mjs';
import { checkSiblingBase } from '../../lib/pr-size-admission.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(join(process.env.TMPDIR, 'sibling-base-'));
  dirs.push(cwd);
  const git = (args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', ...options });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Fixture']);
  const commit = (file, message) => {
    writeFileSync(join(cwd, file), `${message}\n`);
    git(['add', '--', file]);
    git(['commit', '-qm', message]);
  };
  commit('root', 'root');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['checkout', '-qb', 'lane/7357']);
  commit('one', 'first sibling change');
  commit('two', 'second sibling change');
  git(['update-ref', 'refs/remotes/origin/lane/7357', 'HEAD']);
  git(['checkout', '-qb', 'lane/own']);
  commit('own', 'own change');
  const calls = [];
  const run = (base = 'main', overrides = {}) => createPrLandRunner({
    cwd, git, canonicalAudit: () => ({ ok: true }), prePrReview: () => ({ action: 'pass' }),
    prepGate: () => ({ ok: true }), readPrepBody: () => '', env: {},
    spawn: (_cmd, argv) => {
      calls.push(argv);
      return { status: 0, stdout: JSON.stringify(argv.includes('--check') ? { reason: 'check-ok' } : { pr: 7379 }) };
    }, ...overrides,
  })({ argv: ['--ref=lane/own', `--base=${base}`] });
  return { git, commit, run, calls };
}

describe('open-pr sibling base', () => {
  it('admits a clean branch with 300 unrelated remote lane refs', () => {
    const f = fixture();
    f.git(['checkout', '-qb', 'lane/unrelated', 'main']);
    f.commit('unrelated', 'unrelated work');
    const tip = f.git(['rev-parse', 'HEAD']).trim();
    f.git(['update-ref', '--stdin'], { input: Array.from({ length: 300 }, (_, n) =>
      `update refs/remotes/origin/lane/unrelated-${n} ${tip}\n`).join('') });
    f.git(['checkout', 'lane/own']);
    f.git(['reset', '--hard', 'main']);
    f.commit('clean', 'clean own change');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('excludes this PR own branch and its -vN renames from sibling candidates', () => {
    const f = fixture();
    f.git(['reset', '--hard', 'main']);
    f.commit('first', 'first own change');
    f.git(['branch', 'lane/own-v2']);
    f.commit('second', 'second own change');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('fails closed when candidate ref reads fail', () => {
    const f = fixture();
    const result = f.run('main', { git: (args, opts) => {
      if (args[0] === 'for-each-ref') throw new Error('cannot read lane refs');
      return f.git(args, opts);
    } });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('cannot read lane refs');
    expect(f.calls[0]).toContain('--check');
  });

  it('refuses a branch whose history holds commits that belong to another open lane', () => {
    const f = fixture();
    expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('--check');
  });

  it('allows a branch cut on main, and a branch whose sibling commits already landed via their PRs', () => {
    const f = fixture();
    // lane/own itself is cut on main; a second lane at the same tip would be a duplicate sibling (refused above).
    f.git(['reset', '--hard', 'main']);
    f.commit('clean', 'clean change');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
    f.git(['checkout', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['commit', '-qm', 'land sibling (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    f.git(['reset', '--hard', 'lane/7357']);
    f.commit('own', 'own after squash');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('the refusal names the sibling lanes and the fix command', () => {
    const f = fixture();
    for (const number of [7366, 7374]) {
      f.git(['checkout', '-qb', `lane/${number}`]);
      f.commit(`file-${number}`, `sibling ${number}`);
    }
    f.git(['branch', '-f', 'lane/own', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    f.commit('final', 'final own change');
    const result = f.run();
    expect(result.blockers).toContainEqual(expect.objectContaining({ gate: 'sibling-base', reason: 'sibling-base' }));
    expect(result.detail).toMatch(/7357.*7366.*7374/s);
    expect(result.detail).toContain('git rebase --onto');
  });

  it('allows a legitimate stack with a declared parent', () => {
    expect(fixture().run('lane/7357')).toMatchObject({ outcome: 'opened' });
  });

  it.each(['origin/lane/7357', 'refs/remotes/origin/lane/7357', 'sha'])(
    'refuses fetched sibling creation ancestry as ownership evidence (%s)', source => {
      const f = fixture();
      const start = source === 'sha' ? f.git(['rev-parse', 'origin/lane/7357']).trim() : source;
      f.git(['branch', '-D', 'lane/7357']);
      f.git(['branch', 'lane/7357', start]);
      const result = f.run();
      expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
      expect(result.detail).toContain('published lane creation');
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toContain('--check');
    });

  it('refuses a fetched sibling even after its local and published tips advance', () => {
    const f = fixture();
    f.git(['branch', '-D', 'lane/7357']);
    f.git(['checkout', '-b', 'lane/7357', 'origin/lane/7357']);
    f.commit('later', 'later sibling change');
    f.git(['update-ref', 'refs/remotes/origin/lane/7357', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(f.calls).toHaveLength(1);
  });

  it('refuses an earlier carried tip when the sibling is first checked out after advancing', () => {
    const f = fixture();
    f.git(['checkout', 'lane/7357']);
    f.commit('later', 'published after own forked');
    f.git(['update-ref', 'refs/remotes/origin/lane/7357', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    f.git(['branch', '-D', 'lane/7357']);
    f.git(['branch', 'lane/7357', 'origin/lane/7357']);
    expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(f.calls).toHaveLength(1);
  });

  it.each(['lane/7357', 'refs/heads/lane/7357', 'origin/lane/7357', 'refs/remotes/origin/lane/7357'])(
    'uses the published declared parent instead of unpublished local commits (%s)', base => {
      const f = fixture();
      f.git(['update-ref', 'refs/remotes/origin/lane/7357', 'main']);
      const result = f.run(base);
      expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
      expect(result.detail).toContain('lane/7357');
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toContain('--check');
    });

  it('fails closed when a declared local parent has never been published', () => {
    const f = fixture();
    f.git(['update-ref', '-d', 'refs/remotes/origin/lane/7357']);
    expect(f.run('lane/7357')).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(f.calls).toHaveLength(1);
  });

  it('admits a published declared parent without a local branch', () => {
    const f = fixture();
    f.git(['branch', '-D', 'lane/7357']);
    expect(f.run('lane/7357')).toMatchObject({ outcome: 'opened' });
  });

  it('refuses an advanced published parent even when its local shadow is contained', () => {
    const f = fixture();
    f.git(['checkout', '-b', 'lane/advanced', 'lane/7357']);
    f.commit('advanced', 'published parent advanced');
    f.git(['update-ref', 'refs/remotes/origin/lane/7357', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    const result = f.run('lane/7357');
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('declared parent is not contained in this head');
    expect(f.calls).toHaveLength(1);
  });

  it('allows an advanced parent with an unmerged child sharing its earlier history', () => {
    const f = fixture();
    f.git(['reset', '--hard', 'main']);
    f.commit('parent-first', 'first parent change');
    f.git(['checkout', '-qb', 'lane/child']);
    f.commit('child', 'unmerged child change');
    f.git(['checkout', 'lane/own']);
    f.commit('parent-next', 'later parent change');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
    expect(f.calls[0]).not.toContain('--check');
  });

  it('refuses inherited sibling commits when lane/7357 advances after lane/own forks', () => {
    const f = fixture();
    f.git(['checkout', 'lane/7357']);
    f.commit('later', 'later sibling work');
    f.git(['checkout', 'lane/own']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.detail).toContain('lane/7357');
    expect(f.calls[0]).toContain('--check');
  });

  it('refuses a different sibling lane sharing the submitted head', () => {
    const f = fixture();
    // lane/own is created from the unmerged sibling and submitted before adding a commit: same tip, different lane.
    f.git(['checkout', 'lane/7357']);
    f.git(['branch', '-f', 'lane/own', 'lane/7357']);
    f.git(['checkout', 'lane/own']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.detail).toContain('lane/7357');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('--check');
  });

  it('admits a same-tip lane once the sibling work landed, and a same-tip lane with no own commits', () => {
    const f = fixture();
    f.git(['checkout', 'lane/7357']);
    f.git(['branch', '-f', 'lane/own', 'lane/7357']);
    f.git(['checkout', 'lane/own']);
    f.git(['branch', 'lane/empty-copy']);
    f.git(['checkout', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['commit', '-qm', 'land sibling (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('fails closed when shared history has no surviving lane creation evidence', () => {
    const f = fixture();
    f.git(['reflog', 'expire', '--expire=all', 'refs/heads/lane/7357']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('missing lane creation evidence');
    expect(result.detail).toContain('clean lane');
    expect(f.calls[0]).toContain('--check');
  });

  it('allows landed inherited sibling work even when the sibling advances with unmerged work', () => {
    const f = fixture();
    f.git(['checkout', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['commit', '-qm', 'land sibling (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/7357']);
    f.commit('later', 'later unmerged sibling work');
    f.git(['checkout', 'lane/own']);
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('fails closed on unreadable git state and names the operator fallback', () => {
    const f = fixture();
    const result = f.run('main', { git: () => { throw new Error('unreadable objects'); } });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toMatch(/repair.*Git|clean lane/i);
    expect(f.calls[0]).toContain('--check');
  });

  it('fails closed when lane refs name objects that cannot be resolved (not a size limit)', () => {
    const f = fixture();
    const result = f.run('main', { git: (args, opts) => args[0] === 'for-each-ref'
      ? Array.from({ length: 257 }, (_, n) => `refs/heads/lane/${n} ${'a'.repeat(40)}\n`).join('')
      : f.git(args, opts) });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('Cannot establish sibling history');
    expect(result.detail).toMatch(/clean lane/i);
  });
});

describe('open-pr sibling base: evidence bounds', () => {
  it('refuses more than 2048 commits of own history, asking Git for at most 2049 rows', () => {
    const f = fixture();
    const requests = [];
    const result = f.run('main', { git: (args, opts) => {
      if (args[0] !== 'rev-list') return f.git(args, opts);
      requests.push(args);
      return Array.from({ length: 2049 }, (_, n) => `${n.toString(16).padStart(40, '0')}\n`).join('');
    } });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('sibling history exceeds 2048 commits');
    expect(result.detail).toMatch(/clean lane/i);
    expect(requests[0]).toContain('--max-count=2049');
  });

  it('refuses more than 2048 reflog entries of lane creation evidence', () => {
    const f = fixture();
    const requests = [];
    const result = f.run('main', { git: (args, opts) => {
      if (args[0] !== 'reflog') return f.git(args, opts);
      requests.push(args);
      return Array.from({ length: 2049 }, (_, n) => `${n.toString(16).padStart(40, '0')}\0x\n`).join('');
    } });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('lane creation evidence exceeds 2048 reflog entries');
    expect(result.detail).toMatch(/clean lane/i);
    expect(requests[0]).toContain('--max-count=2049');
  });

  it('times out after 15s of inspection and bounds every Git read by the remaining budget', () => {
    const f = fixture();
    let now = 1000;
    const reads = [];
    const git = (args, opts) => { reads.push(opts); now += 4000; return f.git(args, { ...opts, timeout: undefined }); };
    const result = checkSiblingBase({ git, ref: 'lane/own', base: 'main', now: () => now });
    expect(result).toMatchObject({ ok: false, reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('sibling history inspection timed out');
    expect(reads.length).toBeGreaterThan(1);
    for (const opts of reads) {
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThanOrEqual(15_000);
      expect(opts.maxBuffer).toBe(8 * 1024 * 1024);
    }
    expect(reads[1].timeout).toBeLessThan(reads[0].timeout);
  });

  it('refuses an unrecognised declared base instead of falling back to main', () => {
    const result = fixture().run('release/x');
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('unknown declared base');
    expect(result.detail).toMatch(/clean lane/i);
  });

  it('refuses a declared lane parent that is not an ancestor of the head', () => {
    const f = fixture();
    f.git(['checkout', '-qb', 'lane/elsewhere', 'main']);
    f.commit('elsewhere', 'unrelated parent work');
    f.git(['update-ref', 'refs/remotes/origin/lane/elsewhere', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    const result = f.run('lane/elsewhere');
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('declared parent is not contained in this head');
  });
});

describe('open-pr sibling base: landed-sibling evidence', () => {
  const landSquashed = f => {
    f.git(['checkout', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['commit', '-qm', 'land sibling (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
  };

  it('admits a sibling whose commits landed one by one (rebase-merge), judged per commit', () => {
    const f = fixture();
    const patchIds = [];
    const git = (args, opts) => { if (args[0] === 'patch-id') patchIds.push(args); return f.git(args, opts); };
    // Control: before landing, the sibling is a live candidate and is refused.
    expect(f.run('main', { git })).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    f.git(['checkout', 'main']);
    // Copies with their own messages: a plain cherry-pick in the same second reproduces the SAME commit
    // object, which would make the sibling an ancestor of main rather than a landed copy.
    for (const [rev, message] of [['lane/7357~1', 'rebased first (#7357)'], ['lane/7357', 'rebased second (#7357)']]) {
      f.git(['cherry-pick', '-n', rev]);
      f.git(['commit', '-qm', message]);
    }
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    // Main holds two single-file commits, never the whole two-file sibling patch: only per-commit equivalence clears it.
    patchIds.length = 0;
    expect(f.run('main', { git })).toMatchObject({ outcome: 'opened' });
    expect(patchIds.length).toBeGreaterThanOrEqual(5);
  });

  it('refuses one-by-one copies on main whose content differs from the sibling commits', () => {
    const f = fixture();
    f.git(['checkout', 'main']);
    f.commit('one', 'different first');
    f.commit('two', 'different second');
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.detail).toContain('lane/7357');
  });

  describe('a stack of PRs that each landed separately', () => {
    const stack = () => {
      const f = fixture();
      f.git(['checkout', '-qb', 'lane/7358', 'lane/7357']);
      f.commit('child', 'child sibling change');
      f.git(['branch', '-f', 'lane/own', 'lane/7358']);
      f.git(['checkout', 'lane/own']);
      f.commit('own2', 'own change on the stack');
      const squash = lane => {
        f.git(['checkout', 'main']);
        f.git(['merge', '--squash', lane]);
        f.git(['commit', '-qm', `land ${lane}`]);
        f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      };
      return { f, squash };
    };

    it('admits the stack once the parent and the child each landed as their own squash', () => {
      const { f, squash } = stack();
      expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
      squash('lane/7357');
      squash('lane/7358');
      f.git(['checkout', 'lane/own']);
      expect(f.run()).toMatchObject({ outcome: 'opened' });
    });

    it('admits a three-deep stack where every level landed as its own squash', () => {
      const { f, squash } = stack();
      f.git(['checkout', '-qb', 'lane/7359', 'lane/7358']);
      f.commit('grandchild', 'grandchild sibling change');
      f.git(['branch', '-f', 'lane/own', 'lane/7359']);
      f.git(['checkout', 'lane/own']);
      f.commit('own3', 'own change on the deeper stack');
      expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
      for (const lane of ['lane/7357', 'lane/7358', 'lane/7359']) squash(lane);
      f.git(['checkout', 'lane/own']);
      expect(f.run()).toMatchObject({ outcome: 'opened' });
    });

    it('admits a separately squash-landed stack with a declared parent', () => {
      const { f, squash } = stack();
      // Control: while the child is unmerged, the declared parent never clears it.
      expect(f.run('lane/7357')).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
      squash('lane/7357');
      squash('lane/7358');
      f.git(['checkout', 'lane/own']);
      expect(f.run('lane/7357')).toMatchObject({ outcome: 'opened' });
    });

    it('fails closed when parent ancestry comparison exits with status 128', () => {
      const { f } = stack();
      const parentTip = f.git(['rev-parse', 'lane/7357']).trim();
      const childTip = f.git(['rev-parse', 'lane/7358']).trim();
      let compared = 0;
      const git = (args, opts) => {
        // Only the parent-classification call (sibling tip vs sibling tip); creation-evidence checks still succeed.
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[2] === parentTip && args[3] === childTip) {
          compared++;
          throw Object.assign(new Error('fatal: bad object'), { status: 128 });
        }
        return f.git(args, opts);
      };
      const result = f.run('main', { git });
      expect(compared).toBe(1);
      expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
      expect(result.detail).toContain('Cannot establish sibling history');
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toContain('--check');
    });

    it('still names the child when only the parent landed', () => {
      const { f, squash } = stack();
      squash('lane/7357');
      f.git(['checkout', 'lane/own']);
      const result = f.run();
      expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
      expect(result.detail).toContain('lane/7358');
      expect(result.detail).not.toContain('lane/7357');
    });
  });

  it('only reads: repository state is unchanged and only read-only Git verbs run', () => {
    const f = fixture();
    f.git(['checkout', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['commit', '-qm', 'land sibling (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    const snapshot = () => [
      ['for-each-ref', '--format=%(refname) %(objectname)'], ['reflog', 'show', '--all'],
      ['status', '--porcelain=v2', '--branch'], ['rev-parse', 'HEAD'], ['count-objects', '-v'],
    ].map(args => f.git(args)).join('\n--\n');
    const before = snapshot();
    const verbs = new Set();
    const git = (args, opts) => { verbs.add(args[0] === 'reflog' ? `reflog ${args[1]}` : args[0]); return f.git(args, opts); };
    expect(f.run('main', { git })).toMatchObject({ outcome: 'opened' });
    expect(f.run('release/x', { git })).toMatchObject({ outcome: 'refused' });
    expect(f.run('lane/7357', { git })).toMatchObject({ outcome: 'opened' });
    expect(snapshot()).toBe(before);
    expect(verbs).toContain('patch-id');
    for (const verb of verbs) {
      expect(['rev-parse', 'rev-list', 'for-each-ref', 'merge-base', 'reflog show', 'diff', 'patch-id']).toContain(verb);
    }
  });

  it('refuses a sibling when only some of its commits landed one by one', () => {
    const f = fixture();
    f.git(['checkout', 'main']);
    f.git(['cherry-pick', '-n', 'lane/7357~1']);
    f.git(['commit', '-qm', 'rebased first (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.detail).toContain('lane/7357');
  });

  it('refuses an unlanded sibling despite a matching PR title on main (patch evidence, not the title)', () => {
    const f = fixture();
    f.git(['checkout', 'main']);
    f.commit('unrelated', 'land sibling (#7357)');
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.detail).toContain('lane/7357');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('--check');
  });

  it('admits squash-landed siblings with fetched remote-tracking refs (creation evidence from the local lane)', () => {
    const f = fixture();
    f.git(['update-ref', 'refs/remotes/origin/lane/7357', 'refs/heads/lane/7357']);
    landSquashed(f);
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('still refuses an unlanded sibling seen through both local and remote-tracking refs', () => {
    const f = fixture();
    f.git(['update-ref', 'refs/remotes/origin/lane/7357', 'refs/heads/lane/7357']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.detail).toContain('lane/7357');
  });

  it('fails closed when the local lane was recreated elsewhere and its record is not in the fetched tip history', () => {
    const f = fixture();
    f.git(['checkout', '-qb', 'lane/side', 'main']);
    f.commit('side', 'unrelated side work');
    f.git(['checkout', 'lane/own']);
    f.git(['update-ref', 'refs/remotes/origin/lane/7357', 'refs/heads/lane/7357']);
    f.git(['branch', '-D', 'lane/7357']);
    f.git(['branch', 'lane/7357', 'lane/side']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('lane creation record for lane/7357 is not in the history of refs/remotes/origin/lane/7357');
  });

  it('fails closed for a remote-only sibling: a fetched ref has no local creation record', () => {
    const f = fixture();
    f.git(['update-ref', 'refs/remotes/origin/lane/7357', 'refs/heads/lane/7357']);
    f.git(['branch', '-D', 'lane/7357']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('missing lane creation evidence for lane/7357');
  });
});
