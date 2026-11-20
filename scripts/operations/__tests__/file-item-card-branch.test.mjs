import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardBranchSink, createFileItemSinks } from '../file-item-io.mjs';
import { fileItemOperation } from '../file-item.mjs';
import { advanceWhileRunning, startRun, runStatus } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';

const EFFECT = 'file-item.card-branch';
// UTC is already tomorrow while the operator is still on November 20.
const now = () => new Date('2026-11-20T23:30:00-05:00');
const ref = 'refs/heads/lane/card-batch-2026-11-21';
const dirs = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'file-item-card-branch-'));
  dirs.push(dir);
  const origin = join(dir, 'origin.git');
  const lane = join(dir, 'lane');
  const git = (args, opts = {}) => execFileSync('git', [
    '-c', 'user.name=Card Fixture', '-c', 'user.email=cards@example.invalid',
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
  git(['config', 'user.email', 'cards@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const sinks = createFileItemSinks({ root: lane, queuePath: () => join(dir, 'queue.json'), now });
  return { dir, origin, lane, git, sinks, warning };
}

async function file(ctx, title = 'Preserve worker discoveries', input = {}) {
  const registry = createRegistry();
  registry.register(fileItemOperation({
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
  }
  expect(runStatus(run, { registry })).toBe('complete');
  return { run, card: run.verdict.rel, result: run.effects.find(e => e.type === EFFECT)?.result };
}

const remote = (ctx, args) => ctx.git(['--git-dir', ctx.origin, ...args]);

describe('file-item durable card branch (real bare origin, no network)', () => {
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
    const { card, result } = await file(ctx, 'Retain an unqueued discovery', { queue: 'false' });
    const replay = await ctx.sinks[EFFECT]({ rel: card });
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
    const { card, result } = await file(ctx);
    writeFileSync(join(ctx.lane, card), 'different card bytes');
    const conflict = await ctx.sinks[EFFECT]({ rel: card });
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
    expect(cardBranch).toHaveBeenCalledWith({ rel: card }, expect.any(Object));
    expect(result).toEqual({ pushed: true, fixture: true });
    expect(() => remote(ctx, ['rev-parse', '--verify', ref])).toThrow();
  });
});
