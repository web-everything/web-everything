import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMechanicalRoundFacts } from '../mechanical-round-cap.mjs';
import { reviewExecFileSync, withReviewFetchTick } from '../../lib/review-fetch.mjs';

it('refuses cached mechanical-round evidence when a refresh fails within a shared tick', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-direct-fetch-'));
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const commit = (cwd, message) => git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message);
  let cwdSpy;
  try {
    const origin = join(root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'base.txt'), 'base\n');
    git(origin, 'add', '.'); commit(origin, 'base');
    git(origin, 'checkout', '-qb', 'lane/guard');
    writeFileSync(join(origin, 'feature.txt'), 'feature\n');
    git(origin, 'add', '.'); commit(origin, 'feature');
    git(origin, 'checkout', '-q', 'main');
    writeFileSync(join(origin, 'upstream.txt'), 'upstream\n');
    git(origin, 'add', '.'); commit(origin, 'upstream');
    git(origin, 'checkout', '-q', 'lane/guard');
    git(origin, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'merge', '-q', '--no-ff', 'main', '-m', 'sync main');
    const head = git(origin, 'rev-parse', 'HEAD');
    const clone = join(root, 'clone');
    git(root, 'clone', '-q', origin, clone);
    // Keep the default exec: Git honors this directory, and the tick cache keys it identically.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(clone);
    const oldCwd = process.env.GIT_DIR;
    const oldWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(clone, '.git');
    process.env.GIT_WORK_TREE = clone;
    try {
      withReviewFetchTick(() => {
        reviewExecFileSync('git', ['fetch', '--quiet', '--no-tags', '--end-of-options', 'origin',
          '+main:refs/remotes/origin/main', '+lane/guard:refs/remotes/origin/lane/guard'], { encoding: 'utf8' });
        const pr = { headRefOid: head, baseRefName: 'main', headRefName: 'lane/guard' };
        expect(readMechanicalRoundFacts({ pr })).toMatchObject({ head, proven: true });
        // Preserve all local objects/tracking refs while making the next remote read fail.
        git(clone, 'remote', 'set-url', 'origin', join(root, 'unavailable'));
        expect(readMechanicalRoundFacts({ pr })).toMatchObject({ head, proven: false, reason: 'git-read-failed' });
      }, { sharedPerTick: true });
    } finally {
      if (oldCwd === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldCwd;
      if (oldWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldWorkTree;
    }
  } finally {
    cwdSpy?.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  'conveyor/mechanical-round-cap.mjs',
  'conveyor/review-hold-reconcile.mjs',
  'conveyor/convert-advisory-dispatch.mjs',
  'review-set-label.mjs',
  'operations/review-pr-io.mjs',
])('keeps guard reader %s independent of the shared fetch cache', (path) => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../..', path), 'utf8');
  expect(source).not.toMatch(/\breview-fetch(?:\.mjs)?\b/);
});
