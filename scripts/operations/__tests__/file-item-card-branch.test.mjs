import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardBranchSink, createFileItemSinks } from '../file-item-io.mjs';
import { fileItemOperation } from '../file-item.mjs';
import { advanceWhileRunning, startRun, runStatus } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { runOperationCli, renderOutcome } from '../cli-adapter.mjs';
import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';

const EFFECT = 'file-item.card-branch';
// UTC is already tomorrow while the operator is still on November 20.
const now = () => new Date('2026-11-20T23:30:00-05:00');
const ref = 'refs/heads/lane/card-batch-2026-11-21';
const dirs = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'file-item-card-branch-'));
  dirs.push(dir);
  const origin = join(dir, 'origin.git');
  const lane = join(dir, 'lane');
  const git = (args, opts = {}) => execFileSync('git', [
    '-c', 'user.name=Card Fixture', '-c', 'user.email=cards@card-fixture.dev',
    '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args,
  ], { cwd: lane, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  git(['init', '--bare', '--initial-branch=main', origin], { cwd: dir });
  git(['clone', origin, lane], { cwd: dir });
  mkdirSync(join(lane, 'backlog'));
  writeFileSync(join(lane, 'seed.txt'), 'seed\n');
  git(['add', 'seed.txt']);
  git(['commit', '-m', 'Seed main']);
  git(['push', 'origin', 'HEAD:main']);
  git(['checkout', '-b', 'lane/worker']);
  writeFileSync(join(lane, 'worker-only.txt'), 'unpublished lane history');
  git(['add', 'worker-only.txt']);
  git(['commit', '-m', 'Private worker change']);
  git(['config', 'user.name', 'Card Fixture']);
  git(['config', 'user.email', 'cards@card-fixture.dev']);
  git(['config', 'commit.gpgsign', 'false']);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const sinks = createFileItemSinks({ root: lane, queuePath: () => join(dir, 'queue.json'), now });
  return { dir, origin, lane, git, sinks, warning };
}

async function file(ctx, title = 'Preserve worker discoveries', input = {}) {
  const registry = createRegistry();
  registry.register(fileItemOperation({
    now,
    readScaffoldContext: () => ({ existingIds: [], today: '2026-11-20', dir: join(ctx.lane, 'backlog') }),
    searchDuplicates: () => ({ backlog: [] }),
  }));
  let run = advanceWhileRunning(startRun({ op: 'file-item', id: title.replaceAll(' ', '-'), registry,
    input: { title, kind: 'task', digest: 'Retain the newly discovered work.', ...input },
  }), { registry });
  const store = createMemoryRunStore();
  // Bounded operation driving, never admission polling.
  for (let i = 0; i < 5 && runStatus(run, { registry }) === 'awaiting-effect'; i++) {
    const applied = await applyPendingEffects(run, { registry, sinks: ctx.sinks, store });
    expect(applied.error).toBeNull();
    run = advanceWhileRunning(applied.run, { registry });
    if (applied.warning) break;
  }
  expect(runStatus(run, { registry })).toBe(run.effects.at(-1)?.result?.pushed === false ? 'awaiting-effect' : 'complete');
  return { run, card: run.verdict.rel, result: run.effects.find(e => e.type === EFFECT)?.result };
}

const remote = (ctx, args) => ctx.git(['--git-dir', ctx.origin, ...args]);

describe('file-item durable card branch (real bare origin, no network)', () => {
  it.each(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'])(
    'ignores inherited Git repository, object and index overrides: %s', async key => {
      const ctx = fixture();
      const decoy = fixture();
      const head = ctx.git(['rev-parse', 'HEAD']);
      const laneIndex = readFileSync(join(ctx.lane, '.git/index'));
      const decoyIndex = readFileSync(join(decoy.lane, '.git/index'));
      const decoyObjects = readdirSync(join(decoy.lane, '.git/objects'), { recursive: true });
      const rel = 'backlog/isolated-card.md';
      const content = 'Retain isolated publication';
      writeFileSync(join(ctx.lane, rel), content);
      const value = key === 'GIT_WORK_TREE' ? decoy.lane
        : key === 'GIT_INDEX_FILE' ? join(decoy.lane, '.git/index')
          : key.includes('OBJECT') ? join(decoy.lane, '.git/objects') : join(decoy.lane, '.git');
      let calls = 0;
      const git = (args, options) => {
        calls++;
        if (key === 'GIT_INDEX_FILE') {
          expect(options.env[key]).not.toBe(value);
          expect(options.env[key]).not.toBe(join(ctx.lane, '.git/index'));
        } else expect(options.env).not.toHaveProperty(key);
        return execFileSync('git', args, options);
      };
      vi.stubEnv(key, value);
      const result = await createCardBranchSink({ root: ctx.lane, git })({ rel, content, batchDate: '2026-11-21' });
      vi.unstubAllEnvs();
      expect(result.pushed).toBe(true);
      expect(calls).toBeGreaterThan(0);
      expect(remote(ctx, ['show', `${ref}:${rel}`])).toBe(content);
      expect(ctx.git(['rev-parse', 'HEAD'])).toBe(head);
      expect(readFileSync(join(ctx.lane, '.git/index'))).toEqual(laneIndex);
      expect(readFileSync(join(decoy.lane, '.git/index'))).toEqual(decoyIndex);
      expect(readdirSync(join(decoy.lane, '.git/objects'), { recursive: true })).toEqual(decoyObjects);
      expect(remote(decoy, ['for-each-ref', '--format=%(refname)', 'refs/heads/lane/'])).toBe('');
    },
  );

  it('publishes a worker-filed card to origin within sixty seconds', async () => {
    const ctx = fixture();
    const started = performance.now();
    const { card, result } = await file(ctx);
    expect(remote(ctx, ['show', `${ref}:${card}`])).toContain('Retain');
    expect(result.pushed).toBe(true);
    expect(performance.now() - started).toBeLessThan(60_000);
  }, 60_000);

  it('appends when the lane origin/main is older than the remote batch baseline', async () => {
    const ctx = fixture();
    const oldMain = ctx.git(['rev-parse', 'origin/main']);
    const writer = join(ctx.dir, 'newer-main');
    ctx.git(['clone', ctx.origin, writer]);
    writeFileSync(join(writer, 'main-only.txt'), 'Newer main content');
    ctx.git(['add', 'main-only.txt'], { cwd: writer });
    ctx.git(['commit', '-m', 'Advance main'], { cwd: writer });
    ctx.git(['push', 'origin', 'HEAD:main'], { cwd: writer });
    ctx.git(['fetch', 'origin', 'main']);
    const first = await file(ctx);
    ctx.git(['update-ref', 'refs/remotes/origin/main', oldMain]);
    const second = await file(ctx, 'Card from stale lane');
    expect(second.result.pushed).toBe(true);
    expect(remote(ctx, ['show', `${ref}:${first.card}`])).toContain('Retain');
    expect(remote(ctx, ['show', `${ref}:${second.card}`])).toContain('Retain');
    expect(ctx.git(['rev-parse', 'origin/main'])).toBe(oldMain);
  });

  it('refuses a batch with a reverted non-card addition in its intermediate history', async () => {
    const ctx = fixture();
    const main = ctx.git(['rev-parse', 'origin/main']);
    const unsafeTree = ctx.git(['rev-parse', 'HEAD^{tree}']);
    const unsafe = ctx.git(['commit-tree', unsafeTree, '-p', main, '-m', 'Private content']);
    const tip = ctx.git(['commit-tree', ctx.git(['rev-parse', `${main}^{tree}`]), '-p', unsafe, '-m', 'Revert private content']);
    ctx.git(['push', 'origin', `${tip}:${ref}`]);
    const { card, result } = await file(ctx);
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/validating remote batch history/) });
    expect(remote(ctx, ['rev-parse', ref])).toBe(tip);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
  });

  it('refuses a batch merge whose unchanged first-parent tree hides private side-parent history', async () => {
    const ctx = fixture();
    const main = ctx.git(['rev-parse', 'origin/main']);
    const tree = ctx.git(['rev-parse', `${main}^{tree}`]);
    const safe = ctx.git(['commit-tree', tree, '-p', main, '-m', 'Empty batch commit']);
    const tip = ctx.git(['commit-tree', tree, '-p', safe, '-p', ctx.git(['rev-parse', 'HEAD']), '-m', 'Hide private side parent']);
    ctx.git(['push', 'origin', `${tip}:${ref}`]);
    const { card, result } = await file(ctx);
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/validating remote batch history/) });
    expect(remote(ctx, ['rev-parse', ref])).toBe(tip);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
  });

  it.each(['missing', 'malformed', 'unreadable', 'unfetchable'])(
    'refuses %s remote main evidence without changing the existing batch', async kind => {
      const ctx = fixture();
      const first = await file(ctx);
      const main = ctx.git(['rev-parse', 'origin/main']);
      let pushes = 0;
      const git = (args, options) => {
        if (args.includes('ls-remote') && args.at(-1) === 'refs/heads/main') {
          if (kind === 'missing') throw Object.assign(new Error('missing main'), { status: 2, stdout: '' });
          if (kind === 'unreadable') throw Object.assign(new Error('unreadable main'), { status: 128 });
          if (kind === 'malformed') return `${main}\trefs/heads/other`;
        }
        if (kind === 'unfetchable' && args.includes('fetch') && args.at(-1) === main) throw new Error('main fetch failed');
        if (args.includes('push')) pushes++;
        return execFileSync('git', args, options);
      };
      ctx.sinks[EFFECT] = createCardBranchSink({ root: ctx.lane, git });
      const { card, result } = await file(ctx, 'Retain card with unknown main');
      expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/reading remote main baseline/) });
      expect(pushes).toBe(0);
      expect(remote(ctx, ['rev-parse', ref])).toBe(first.result.sha);
      expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
    },
  );

  it('publishes after writing and clearing, with UTC date and untouched lane branch, HEAD and index', async () => {
    const ctx = fixture();
    const head = ctx.git(['rev-parse', 'HEAD']);
    const branch = ctx.git(['symbolic-ref', 'HEAD']);
    const index = readFileSync(join(ctx.lane, '.git/index'));
    const { run, card, result } = await file(ctx);
    expect(remote(ctx, ['show', `${ref}:${card}`])).toBe(readFileSync(join(ctx.lane, card), 'utf8').trim());
    expect(result).toMatchObject({ pushed: true, branch: ref.slice('refs/heads/'.length) });
    expect(run.effects.map(e => e.type)).toEqual(['scaffold.write', 'file-item.queue-add', EFFECT]);
    expect(ctx.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(ctx.git(['symbolic-ref', 'HEAD'])).toBe(branch);
    expect(readFileSync(join(ctx.lane, '.git/index'))).toEqual(index);
    expect(remote(ctx, ['log', '-1', '--format=%B', ref])).not.toContain(ctx.dir);
    expect(remote(ctx, ['ls-tree', '--name-only', ref])).not.toContain('worker-only.txt');
  });

  it('appends a second card on top of the existing remote batch', async () => {
    const ctx = fixture();
    const first = await file(ctx);
    const tip = remote(ctx, ['rev-parse', ref]);
    const second = await file(ctx, 'Retain another discovery');
    expect(remote(ctx, ['rev-parse', `${ref}^`])).toBe(tip);
    for (const card of [first.card, second.card]) expect(remote(ctx, ['show', `${ref}:${card}`])).toContain('Retain');
  });

  it('appends to the existing daily batch after main advances and the lane refreshes origin/main', async () => {
    const ctx = fixture();
    const first = await file(ctx);
    const originalBaseline = ctx.git(['rev-parse', 'origin/main']);
    const writer = join(ctx.dir, 'main-writer');
    ctx.git(['clone', ctx.origin, writer]);
    writeFileSync(join(writer, 'main-only.txt'), 'Independent main advancement');
    ctx.git(['add', 'main-only.txt'], { cwd: writer });
    ctx.git(['commit', '-m', 'Advance main independently'], { cwd: writer });
    ctx.git(['push', 'origin', 'HEAD:main'], { cwd: writer });
    ctx.git(['fetch', 'origin', 'main']);
    expect(ctx.git(['rev-parse', 'origin/main'])).not.toBe(originalBaseline);
    expect(ctx.git(['merge-base', 'origin/main', first.result.sha])).toBe(originalBaseline);

    const second = await file(ctx, 'Retain discovery after main advances');
    expect(second.result).toMatchObject({ pushed: true, branch: first.result.branch });
    expect(remote(ctx, ['rev-parse', `${ref}^`])).toBe(first.result.sha);
    for (const card of [first.card, second.card]) {
      expect(remote(ctx, ['show', `${ref}:${card}`])).toContain('Retain');
    }
    expect(remote(ctx, ['diff', '--name-only', originalBaseline, ref]).split('\n').sort())
      .toEqual([first.card, second.card].sort());
    expect(remote(ctx, ['ls-tree', '--name-only', ref])).not.toMatch(/main-only.txt|worker-only.txt/);
    expect(ctx.warning).not.toHaveBeenCalled();
  });

  it('push rejection keeps filing successful and the card on disk, with stderr and result warnings', async () => {
    const ctx = fixture();
    writeFileSync(join(ctx.origin, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const { card, result } = await file(ctx);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/WARNING.*retained/i) });
    expect(ctx.warning).toHaveBeenCalledWith(result.warning);
  });

  it('unreadable remote is never treated as an absent branch; retains card and warns', async () => {
    const ctx = fixture();
    rmSync(ctx.origin, { recursive: true, force: true });
    const { card, result } = await file(ctx);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/WARNING/) });
    expect(ctx.warning).toHaveBeenCalledWith(result.warning);
  });

  it('never stages or publishes unrelated staged, unstaged, or untracked files', async () => {
    const ctx = fixture();
    writeFileSync(join(ctx.lane, 'seed.txt'), 'unstaged edit');
    writeFileSync(join(ctx.lane, 'staged.txt'), 'staged edit');
    writeFileSync(join(ctx.lane, 'untracked.txt'), 'untracked edit');
    ctx.git(['add', 'staged.txt']);
    const index = readFileSync(join(ctx.lane, '.git/index'));
    const staged = ctx.git(['diff', '--cached']);
    const { card } = await file(ctx);
    expect(readFileSync(join(ctx.lane, '.git/index'))).toEqual(index);
    expect(ctx.git(['diff', '--cached'])).toBe(staged);
    expect(remote(ctx, ['diff-tree', '--no-commit-id', '--name-only', '-r', ref])).toBe(card);
    expect(remote(ctx, ['show', `${ref}:seed.txt`])).toBe('seed');
    expect(remote(ctx, ['ls-tree', '--name-only', ref])).not.toMatch(/staged.txt|untracked.txt/);
  });

  it('missing card skips publication with a warning and never fails filing', async () => {
    const ctx = fixture();
    ctx.sinks = createFileItemSinks({ root: ctx.lane, now, write: () => {}, queuePath: () => join(ctx.dir, 'queue.json') });
    const { result } = await file(ctx);
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/WARNING.*card/i) });
    expect(ctx.warning).toHaveBeenCalledWith(result.warning);
    expect(() => remote(ctx, ['rev-parse', '--verify', ref])).toThrow();
  });

  it('publishes even when conveyor clearance is opted out, and replay adds no duplicate commit', async () => {
    const ctx = fixture();
    const { run, result } = await file(ctx, 'Retain an unqueued discovery', { queue: 'false' });
    const replay = await ctx.sinks[EFFECT](run.effects.at(-1).payload);
    expect(replay).toMatchObject({ pushed: true, alreadyPresent: true, sha: result.sha });
    expect(remote(ctx, ['rev-parse', ref])).toBe(result.sha);
  });

  it('refetches and rebuilds once after a real push race, preserving the competing commit', async () => {
    const ctx = fixture();
    let pushes = 0;
    let rival;
    const git = (args, options) => {
      if (args.includes('push')) {
        pushes++;
        expect(args.some(a => a.includes('--force') || a.startsWith('+'))).toBe(false);
        if (pushes === 1) {
          const candidate = args.at(-1).split(':')[0];
          const base = ctx.git(['rev-parse', `${candidate}^`]);
          rival = ctx.git(['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'Concurrent filer']);
          // Transfer the rival object without publishing the candidate being tested.
          ctx.git(['push', 'origin', `${rival}:${ref}`]);
        }
      }
      return execFileSync('git', args, options);
    };
    ctx.sinks[EFFECT] = createCardBranchSink({ root: ctx.lane, now, git });
    const { card, result } = await file(ctx);
    expect(result.pushed).toBe(true);
    expect(pushes).toBe(2);
    expect(remote(ctx, ['rev-parse', `${ref}^`])).toBe(rival);
    expect(remote(ctx, ['show', `${ref}:${card}`])).toContain('Retain');
  });

  it('bounds repeated push races at two attempts and retains the card with a warning', async () => {
    const ctx = fixture();
    let pushes = 0;
    const git = (args, options) => {
      if (args.includes('push')) {
        pushes++;
        const candidate = args.at(-1).split(':')[0];
        const base = ctx.git(['rev-parse', `${candidate}^`]);
        const rival = ctx.git(['commit-tree', `${base}^{tree}`, '-p', base, '-m', `Concurrent filer ${pushes}`]);
        ctx.git(['push', 'origin', `${rival}:${ref}`]);
      }
      return execFileSync('git', args, options);
    };
    ctx.sinks[EFFECT] = createCardBranchSink({ root: ctx.lane, now, git });
    const { card, result } = await file(ctx);
    expect(pushes).toBe(2);
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/WARNING/) });
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
  });

  it('does not overwrite an existing remote card with different bytes', async () => {
    const ctx = fixture();
    const { run, card, result } = await file(ctx);
    writeFileSync(join(ctx.lane, card), 'different card bytes');
    const conflict = await ctx.sinks[EFFECT]({ ...run.effects.at(-1).payload, content: 'different card bytes' });
    expect(conflict).toMatchObject({ pushed: false, warning: expect.stringMatching(/WARNING/) });
    expect(remote(ctx, ['rev-parse', ref])).toBe(result.sha);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toBe('different card bytes');
  });

  it.each(['', 'not-a-sha\t' + ref, 'a'.repeat(40) + '\trefs/heads/unexpected'])('unknown remote evidence %j refuses publication', async listing => {
    const ctx = fixture();
    const git = vi.fn((args, options) => args.includes('ls-remote') ? listing : execFileSync('git', args, options));
    ctx.sinks[EFFECT] = createCardBranchSink({ root: ctx.lane, now, git });
    const { card, result } = await file(ctx);
    expect(result.pushed).toBe(false);
    expect(git.mock.calls.some(([args]) => args.includes('push'))).toBe(false);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
  });

  it('missing origin/main baseline preserves the card rather than publishing worker history', async () => {
    const ctx = fixture();
    ctx.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    const { result } = await file(ctx);
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/origin\/main baseline/) });
    expect(() => remote(ctx, ['rev-parse', '--verify', ref])).toThrow();
  });

  it('the publication sink can be injected without executing git', async () => {
    const ctx = fixture();
    const cardBranch = vi.fn(async () => ({ pushed: true, fixture: true }));
    ctx.sinks = createFileItemSinks({ root: ctx.lane, cardBranch, queuePath: () => join(ctx.dir, 'queue.json') });
    const { card, result } = await file(ctx);
    expect(cardBranch).toHaveBeenCalledWith({ rel: card, content: expect.any(String), batchDate: '2026-11-21' }, expect.any(Object));
    expect(result).toEqual({ pushed: true, fixture: true });
    expect(() => remote(ctx, ['rev-parse', '--verify', ref])).toThrow();
  });

  it.each(['author', 'committer', 'missing', 'unreadable'])('refuses %s identity before commit-tree and retains the card', async role => {
    const ctx = fixture();
    let committed = false;
    const git = (args, options) => {
      if (args.includes('commit-tree')) committed = true;
      if (args[0] === 'var') {
        if (role === 'unreadable') throw new Error('identity probe unavailable');
        if (role === 'missing') return '';
        if (args[1] === `GIT_${role.toUpperCase()}_IDENT`) return 'test <test@test.com> 1 +0000';
      }
      return execFileSync('git', args, options);
    };
    ctx.sinks[EFFECT] = createCardBranchSink({ root: ctx.lane, git });
    const { card, result } = await file(ctx);
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/validating commit identity/) });
    expect(committed).toBe(false);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
    expect(() => remote(ctx, ['rev-parse', '--verify', ref])).toThrow();
  });

  it('publishes validated verdict bytes despite a disk edit after the guarded write', async () => {
    const ctx = fixture();
    const publish = ctx.sinks[EFFECT];
    ctx.sinks[EFFECT] = (payload, context) => {
      writeFileSync(join(ctx.lane, payload.rel), 'unguarded edited bytes');
      return publish(payload, context);
    };
    const { run, card, result } = await file(ctx);
    expect(result.pushed).toBe(true);
    expect(remote(ctx, ['show', `${ref}:${card}`])).toBe(run.verdict.content.trim());
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toBe('unguarded edited bytes');
  });

  it('CLI warns without failing and --resume retries only publication from persisted state', async () => {
    const ctx = fixture();
    const registry = createRegistry();
    const declaration = fileItemOperation({ now,
      readScaffoldContext: () => ({ existingIds: [], today: '2026-11-20', dir: join(ctx.lane, 'backlog') }),
      searchDuplicates: () => ({ backlog: [] }),
    });
    registry.register(declaration);
    const memory = createMemoryRunStore();
    // Model a file store: symbol brands must not be needed after persistence.
    const store = { write: run => memory.write(JSON.parse(JSON.stringify(run))), read: id => memory.read(id) };
    const options = { declaration, registry, store, sinks: ctx.sinks, newRunId: () => 'retry-publication' };
    writeFileSync(join(ctx.origin, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const first = await runOperationCli({ ...options, argv: ['--title=Retry publication', '--kind=task', '--digest=Retain discoveries'] });
    expect(first).toMatchObject({ code: 0, stopped: 'effect-warning' });
    expect(first.lines.join(' ')).toMatch(/WARNING.*--resume=retry-publication/);
    const json = renderOutcome({ outcome: { run: first.run, stopped: first.stopped, applied: [], error: null }, json: true });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.lines[0])).toMatchObject({ stopped: 'effect-warning', warning: expect.stringMatching(/WARNING/) });
    expect(first.run.effects.map(e => e.status)).toEqual(['applied', 'applied', 'pending']);
    const card = first.run.verdict.rel;
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
    rmSync(join(ctx.origin, 'hooks/pre-receive'));
    const second = await runOperationCli({ ...options, argv: ['--resume=retry-publication'] });
    expect(second).toMatchObject({ code: 0, stopped: 'complete' });
    expect(second.run.effects.map(e => e.attempts)).toEqual([1, 1, 2]);
    expect(remote(ctx, ['show', `${ref}:${card}`])).toContain('Retain');
  });

  it('replays the persisted UTC batch date after midnight without a second branch', async () => {
    const ctx = fixture();
    const { run, result } = await file(ctx);
    const payload = JSON.parse(JSON.stringify(run.effects.at(-1).payload));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T01:00:00Z'));
    const replay = await createCardBranchSink({ root: ctx.lane })(payload);
    expect(replay).toMatchObject({ pushed: true, alreadyPresent: true, sha: result.sha });
    expect(remote(ctx, ['for-each-ref', '--format=%(refname)', 'refs/heads/lane/'])).toBe(ref);
  });

  it.each(['unrelated ancestry', 'non-card diff', 'space-prefixed card path'])('skips an unsafe existing batch with %s and retains the card', async kind => {
    const ctx = fixture();
    let tree = ctx.git(['rev-parse', kind === 'non-card diff' ? 'HEAD^{tree}' : 'origin/main^{tree}']);
    if (kind === 'space-prefixed card path') {
      ctx.git(['read-tree', 'origin/main']);
      mkdirSync(join(ctx.lane, ' backlog'));
      writeFileSync(join(ctx.lane, ' backlog/hidden.md'), 'unrelated path');
      ctx.git(['add', ' backlog/hidden.md']);
      tree = ctx.git(['write-tree']);
    }
    const tip = ctx.git(['commit-tree', tree, ...(kind !== 'unrelated ancestry' ? ['-p', ctx.git(['rev-parse', 'origin/main'])] : []), '-m', 'Unsafe batch']);
    ctx.git(['push', 'origin', `${tip}:${ref}`]);
    const { card, result } = await file(ctx);
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/validating remote batch history/) });
    expect(remote(ctx, ['rev-parse', ref])).toBe(tip);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
  });

  it('publishes to the inspected fetch URL when origin has a different pushurl', async () => {
    const ctx = fixture();
    const other = join(ctx.dir, 'other.git');
    ctx.git(['init', '--bare', other]);
    ctx.git(['config', 'remote.origin.pushurl', other]);
    const { card, result } = await file(ctx);
    expect(result.pushed).toBe(true);
    expect(remote(ctx, ['show', `${ref}:${card}`])).toContain('Retain');
    expect(ctx.git(['--git-dir', other, 'for-each-ref'])).toBe('');
  });

  it('disables inherited push.followTags for annotated tags reachable from the card commit', async () => {
    const ctx = fixture();
    ctx.git(['config', 'push.followTags', 'true']);
    const git = (args, options) => {
      if (args.includes('push')) ctx.git(['tag', '-a', 'private-tag', args.at(-1).split(':')[0], '-m', 'Private tag']);
      return execFileSync('git', args, options);
    };
    ctx.sinks[EFFECT] = createCardBranchSink({ root: ctx.lane, git });
    const { result } = await file(ctx);
    expect(result.pushed).toBe(true);
    expect(ctx.git(['tag', '--list'])).toBe('private-tag');
    expect(remote(ctx, ['tag', '--list'])).toBe('');
  });

  it('old rel-only persisted payloads warn rather than rereading unvalidated bytes', async () => {
    const ctx = fixture();
    const { card } = await file(ctx);
    const result = await ctx.sinks[EFFECT]({ rel: card });
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/legacy payloads need content and batchDate/) });
  });

  it('oversized remote history evidence warns with the preserve-lane fallback and never pushes', async () => {
    const ctx = fixture();
    await file(ctx);
    let pushes = 0;
    const git = (args, options) => {
      if (args.includes('log')) {
        expect(options.maxBuffer).toBe(1024 * 1024);
        throw Object.assign(new Error('output exceeded maxBuffer'), { code: 'ENOBUFS' });
      }
      if (args.includes('push')) pushes++;
      return execFileSync('git', args, options);
    };
    ctx.sinks[EFFECT] = createCardBranchSink({ root: ctx.lane, git });
    const { card, result } = await file(ctx, 'Preserve oversized evidence');
    expect(result).toMatchObject({ pushed: false, warning: expect.stringMatching(/ENOBUFS.*Preserve the lane and retry/) });
    expect(pushes).toBe(0);
    expect(readFileSync(join(ctx.lane, card), 'utf8')).toContain('Retain');
  });

});
