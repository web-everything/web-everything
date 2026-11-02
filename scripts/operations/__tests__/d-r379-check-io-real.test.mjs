/** @file Real pull-ref fetch and merge-base geometry for D-R379. */
import { it, expect } from 'vitest';
import { withNarrowClone } from './helpers/real-repo.mjs';
import { createCheckDeps } from '../d-r379-check-io.mjs';

it('fetches the real pull head and excludes files main gained after the PR branched', async () => {
  await withNarrowClone(async ({ clone, origin, git, seedOriginBranch, fetchRefspecs }) => {
    expect(fetchRefspecs()).toEqual(['+refs/heads/main:refs/remotes/origin/main']);
    const base = git(['rev-parse', 'origin/main']).trim();
    seedOriginBranch('pr-topic', {
      'docs/pr-first.md': 'first PR change\n',
      'docs/pr-second.md': 'second PR change\n',
    }, base);
    const head = git(['rev-parse', 'pr-topic'], { cwd: origin }).trim();
    git(['update-ref', 'refs/pull/6223/head', head], { cwd: origin });
    git(['update-ref', '-d', 'refs/heads/pr-topic'], { cwd: origin });
    seedOriginBranch('main', { 'docs/main-only.md': 'main advanced after branching\n' }, base);
    const main = git(['rev-parse', 'main'], { cwd: origin }).trim();
    expect(main).not.toBe(base);
    expect(git(['rev-parse', 'origin/main']).trim()).toBe(base);

    const deps = createCheckDeps({ cwd: clone });
    expect(await deps.fetchNetDiff(6223, head)).toEqual(['docs/pr-first.md', 'docs/pr-second.md']);
    expect(git(['rev-parse', 'origin/main']).trim()).toBe(main);
    expect(git(['rev-parse', 'FETCH_HEAD']).trim()).toBe(head);
    expect(git(['merge-base', 'origin/main', head]).trim()).toBe(base);
  });
});
