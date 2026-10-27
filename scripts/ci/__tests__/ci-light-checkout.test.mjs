// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const raw = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const { jobs } = yaml.load(raw);
const fetchMain = 'git fetch --no-tags --filter=blob:none --depth=1000000 origin +refs/heads/main:refs/remotes/origin/main';
// Historical full-history WE checkouts; `test` is intentionally gone from this roster.
const historyJobs = ['changes', 'standards', 'test-shard', 'integration', 'daemon-soak-scope', 'test-selection-measure'];

describe('ci.yml shallow checkouts with blobless main history', () => {
  it('contains no fetch-depth: 0, including stale comments', () => {
    expect(raw).not.toMatch(/fetch-depth:\s*0\b/);
  });

  it.each(historyJobs)('%s retains its history-dependent checkout at depth 50', (name) => {
    const checkouts = jobs[name].steps.filter((s) => s.uses?.startsWith('actions/checkout@') && !s.with?.repository);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with['fetch-depth']).toBe(50);
  });

  it('every depth-50 checkout immediately fetches blobless main in the checkout directory', () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!step.uses?.startsWith('actions/checkout@') || step.with?.['fetch-depth'] !== 50) continue;
        const next = job.steps[index + 1];
        if (name === 'changes') {
          expect(job.steps.some((s) => s.name === 'Fetch main history (blobless)')).toBe(false);
          expect(next.run).toMatch(/git fetch --no-tags --filter=blob:none --depth=1000000 origin ['"]?\+refs\/heads\/main:refs\/remotes\/origin\/main['"]?/);
        } else {
          expect(next.name, name).toBe('Fetch main history (blobless)');
          expect(next.run.trim(), name).toBe(fetchMain);
          expect(next['working-directory']).toBe(step.with?.path);
          expect(next.if).toBe(step.if);
        }
      }
    }
  });

  it('depth-50 checkout plus the documented deep main fetch preserves the real merge base (local Git only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-light-checkout-'));
    const origin = join(dir, 'origin');
    const checkout = join(dir, 'checkout');
    const git = (cwd, args, input) => execFileSync('git', args, {
      cwd, input, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    try {
      mkdirSync(origin);
      git(origin, ['init', '--bare', '-q']);
      git(origin, ['config', 'uploadpack.allowFilter', 'true']);
      const tree = git(origin, ['mktree'], '');
      const commit = (parent, message) => git(origin, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
      let base;
      for (let i = 0; i < 55; i++) base = commit(base, `common ${i}`);
      const feature = commit(base, 'feature');
      let main = base;
      for (let i = 0; i < 55; i++) main = commit(main, `main ${i}`);
      git(origin, ['update-ref', 'refs/heads/main', main]);
      git(origin, ['update-ref', 'refs/heads/feature', feature]);
      git(dir, ['clone', '-q', '--no-tags', '--depth=50', '--branch=feature', '--single-branch', pathToFileURL(origin).href, checkout]);
      expect(git(checkout, ['rev-parse', '--is-shallow-repository'])).toBe('true');
      // The ref is absent before the additional fetch, so this cannot pass on clone defaults alone.
      expect(() => git(checkout, ['rev-parse', '--verify', 'origin/main'])).toThrow();
      git(checkout, fetchMain.split(' ').slice(1));
      expect(git(checkout, ['rev-parse', 'origin/main'])).toBe(main);
      expect(git(checkout, ['merge-base', 'origin/main', 'HEAD'])).toBe(base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
