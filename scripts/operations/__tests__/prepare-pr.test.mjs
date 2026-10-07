import { describe, it, expect, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planOpen } from '../open-pr.mjs';
import { createPrLandRunner } from '../open-pr-io.mjs';
import { prepareItemFromRef } from '../prepare-pr.mjs';

const title = 'WE #4368: prepare — [subject unavailable for 4368]';
const request = (extra = {}) => ({ ref: 'lane/4368-prepare-item-mid-work-guard', base: 'main',
  sha: 'HEAD', bodyFile: '/tmp/body.md', mode: 'label-on-green', ...extra });

describe('prepare PR publication', () => {
  it.each([undefined, 'Merge pull request #3073 from chalbert/lane/4341-prepare-wip-queue'])
  ('uses the item identity instead of title %s', (subject) => {
    const plan = planOpen(request({ title: subject }));
    expect(plan.argv).toContain(`--title=${title}`);
    expect(plan.title).toBe(title);
  });

  // Local git history exercises the actual three-dot diff, including inherited card changes.
  function fixture(run) {
    const cwd = mkdtempSync(join(tmpdir(), 'prepare-pr-'));
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    try {
      git(['init', '-q']);
      mkdirSync(join(cwd, 'backlog'));
      for (const id of ['4368', '4341']) writeFileSync(join(cwd, `backlog/${id}-card.md`), '# Original card title\n');
      const snapshot = (parents = [], message = 'prepare') => {
        git(['add', '.']);
        const tree = git(['write-tree']).trim();
        const sha = git(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message]).trim();
        git(['update-ref', 'HEAD', sha]);
        return sha;
      };
      const main = snapshot();
      git(['update-ref', 'refs/heads/main', main]);
      git(['symbolic-ref', 'HEAD', 'refs/heads/preparing']);
      git(['update-ref', 'HEAD', main]);
      git(['remote', 'add', 'origin', cwd]);
      run({ cwd, git, snapshot, main, edit: (path) => writeFileSync(join(cwd, path), 'changed\n') });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }

  it('publishes only the own-card diff with a deterministic title and pinned SHA', () => fixture(({ cwd, git, snapshot, main, edit }) => {
    edit('backlog/4368-card.md');
    const sha = snapshot([main], 'Merge pull request #3073 from chalbert/lane/4341-prepare-wip-queue');
    const spawn = vi.fn(() => ({ status: 0, stdout: '{}' }));
    createPrLandRunner({ cwd, git, spawn })({ argv: planOpen(request()).argv });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][1]).toContain('--title=WE #4368: prepare — Original card title');
    expect(spawn.mock.calls[0][1]).toContain(`--sha=${sha}`);
  }));

  it('refuses publication when the card content read fails', () => fixture(({ cwd, git, snapshot, main, edit }) => {
    edit('backlog/4368-card.md');
    snapshot([main]);
    const spawn = vi.fn(() => ({ status: 0, stdout: '{}' }));
    const metadataUnavailable = (args) => {
      if (args[0] === 'show') throw new Error('card unavailable');
      return git(args);
    };
    expect(createPrLandRunner({ cwd, git: metadataUnavailable, spawn })({ argv: planOpen(request()).argv })).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/specific change subject/) });
    expect(spawn).not.toHaveBeenCalled();
  }));

  it.each(['backlog/4341-card.md', 'unrelated.mjs'])('refuses inherited %s before spawning pr-land', (path) => fixture(({ cwd, git, snapshot, main, edit }) => {
    edit(path);
    const predecessor = snapshot([main]);
    edit('backlog/4368-card.md');
    snapshot([predecessor]);
    const spawn = vi.fn();
    const result = createPrLandRunner({ cwd, git, spawn })({ argv: planOpen(request()).argv });
    expect(result.outcome).toBe('refused');
    expect(result.reason).toContain(`diff outside backlog/4368-card.md: ${path}`);
    expect(spawn).not.toHaveBeenCalled();
  }));

  it('refuses a merge even when the final diff only changes the own card', () => fixture(({ cwd, git, snapshot, main, edit }) => {
    const other = snapshot([main], 'another lane');
    edit('backlog/4368-card.md');
    snapshot([main, other]);
    const spawn = vi.fn();
    expect(createPrLandRunner({ cwd, git, spawn })({ argv: planOpen(request()).argv }).reason).toContain('lane contains merge commits');
    expect(spawn).not.toHaveBeenCalled();
  }));

  it('fails closed when git cannot observe the diff', () => {
    const spawn = vi.fn();
    const git = () => { throw new Error('fetch unavailable'); };
    expect(createPrLandRunner({ git, spawn })({ argv: planOpen(request()).argv })).toEqual({ outcome: 'refused', reason: 'fetch unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('prepare guard scope (only prepare-item PRs are guarded)', () => {
  const briefRef = (name) => readFileSync(join(process.cwd(), 'skills-src/conveyor', name), 'utf8')
    .match(/open-pr --ref=(lane\/\S+)/)[1].replace('{{ITEM_NUM}}', '4400').replace('<slug>', 'x');

  it('every conveyor brief `--ref=` template is either guarded (prepare-item) or exempt (all others)', () => {
    expect(prepareItemFromRef(briefRef('prepare-item-agent-brief.md'))).toBe('4400');
    expect(prepareItemFromRef(briefRef('prepare-decision-agent-brief.md'))).toBeNull();
  });

  it.each(['lane/4400-prepare-x', 'lane/4400-prepare-stamp', 'lane/4400-scope-x', undefined])(
    'leaves %s untouched: no card-only guard, no title override', (ref) => {
      expect(prepareItemFromRef(ref)).toBeNull();
    });

  it('lets a decision-shaped prepare (card + research files) through to pr-land unchanged', () => {
    const git = vi.fn(() => { throw new Error('guard must not run'); });
    const spawn = vi.fn(() => ({ status: 0, stdout: '{}' }));
    const argv = planOpen(request({ ref: 'lane/4400-prepare-decision-x', title: 'WE #4400: author decision forks' })).argv;
    createPrLandRunner({ git, spawn })({ argv });
    expect(git).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][1]).toContain('--title=WE #4400: author decision forks');
  });

  it('the default git runner has an explicit large maxBuffer (no 1 MB ENOBUFS cliff on the backlog listing)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/operations/open-pr-io.mjs'), 'utf8');
    expect(src).toMatch(/execFileSync\('git', args, \{[^}]*maxBuffer: 64 \* 1024 \* 1024/);
  });
});

describe('lane-pool acquire --purpose=conveyor-prepare-item', () => {
  const SCRIPT = join(process.cwd(), 'scripts/lane-pool.mjs');
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const ident = ['-c', 'user.email=t@t.com', '-c', 'user.name=t'];

  function withPool(run) {
    const root = mkdtempSync(join(tmpdir(), 'prepare-acquire-'));
    const origin = join(root, 'origin.git');
    const reference = join(root, 'reference');
    const poolRoot = join(root, 'pool');
    const common = [`--origin=${origin}`, `--reference=${reference}`, '--name=preptest', '--branch=main', '--no-install'];
    const pool = (args) => {
      const r = spawnSync('node', [SCRIPT, ...args, ...common], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot } });
      return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
    };
    try {
      g(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
      g(['clone', '--quiet', origin, reference]);
      writeFileSync(join(reference, 'f.txt'), 'main\n');
      g(['add', 'f.txt'], reference);
      g([...ident, 'commit', '--quiet', '-m', 'main'], reference);
      g(['push', '--quiet', 'origin', 'main'], reference);
      g(['checkout', '--quiet', '-b', 'lane/pred'], reference);
      writeFileSync(join(reference, 'f.txt'), 'predecessor\n');
      g([...ident, 'commit', '--quiet', '-am', 'pred'], reference);
      g(['push', '--quiet', 'origin', 'lane/pred'], reference);
      g(['checkout', '--quiet', 'main'], reference);
      expect(pool(['provision', '--count=2']).code).toBe(0);
      run({ pool, originMain: g(['rev-parse', 'main'], reference) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const prepare = ['acquire', '--purpose=conveyor-prepare-item'];

  it.each([
    ['an alternate --base', ['--base=lane/pred']],
    ['--no-reset', ['--no-reset']],
    ['--reserve', ['--reserve', '--lane=1']],
  ])('refuses %s', (_label, extra) => withPool(({ pool }) => {
    const r = pool([...prepare, ...extra]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/prepare-item requires a fresh origin\/main lane/);
  }));

  it.each([[[]], [['--base=origin/main']]])('starts at origin/main with args %j (omitted or explicit base)', (extra) => withPool(({ pool, originMain }) => {
    const r = pool([...prepare, ...extra, '--json']);
    expect(r.code).toBe(0);
    expect(g(['rev-parse', 'HEAD'], JSON.parse(r.out).path)).toBe(originMain);
  }));
});

describe('item 98 — prepare-item brief runs the gate once, via the marker-writing light path', () => {
  it('step 4 uses verify-lane request/check and forbids a second gate run', async () => {
    const brief = readFileSync(join(process.cwd(), 'skills-src/conveyor/prepare-item-agent-brief.md'), 'utf8');
    const step4 = brief.slice(brief.indexOf('### 4. Run the gate GREEN'), brief.indexOf('### 5'));
    expect(step4).toMatch(/verify-lane\.mjs request/);
    expect(step4).toMatch(/check --wait=/);
    expect(step4).not.toMatch(/^npm run check:standards$/m);
    expect(step4).toMatch(/ONLY gate run/);
  });

  // The marker is keyed to HEAD, so the card must be committed BEFORE the gate is requested: a request made against
  // the uncommitted tree is stale the moment the commit moves HEAD, and open-pr's finish-guard then refuses it.
  it('commits the card before the verify-lane request, never after it', async () => {
    const brief = readFileSync(join(process.cwd(), 'skills-src/conveyor/prepare-item-agent-brief.md'), 'utf8');
    const commit = brief.search(/^git commit -F /m);
    const requests = [...brief.matchAll(/^node scripts\/verify-lane\.mjs request/gm)].map((m) => m.index);
    expect(commit).toBeGreaterThan(-1);
    expect(requests.length).toBeGreaterThan(0);
    for (const at of requests) expect(at).toBeGreaterThan(commit);
    expect(brief.match(/^git commit -F /gm)).toHaveLength(1);
  });

  // canScopeCheckStandards is false for any backlog/ path, so a card-only diff runs the UNSCOPED check:standards.
  it('does not tell the agent a backlog-only diff gets a scoped check:standards', async () => {
    const brief = readFileSync(join(process.cwd(), 'skills-src/conveyor/prepare-item-agent-brief.md'), 'utf8');
    const step4 = brief.slice(brief.indexOf('### 4. Run the gate GREEN'), brief.indexOf('### 5'));
    expect(step4).not.toMatch(/(?<!un)scoped\s+`?check:standards/i);
    expect(step4).toMatch(/unscoped\s+`?check:standards/i);
  });
});
