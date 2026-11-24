// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { selectCachesToDelete } from '../prune-actions-caches.mjs';

const c = (id, key, created_at, ref = 'refs/heads/main') => ({ id, key, ref, created_at });
const js = (id, day) => c(id, `codeql-overlay-base-database-1-abc${id}-javascript`, `2026-11-${day}T00:00:00Z`);
const py = (id, day) => c(id, `codeql-overlay-base-database-1-abc${id}-python`, `2026-11-${day}T00:00:00Z`);

describe('prune-actions-caches', () => {
  it('keeps the newest overlay per language and lists the rest for deletion', () => {
    const caches = [js(1, '20'), js(2, '22'), js(3, '21'), py(4, '19'), py(5, '23')];
    const ids = selectCachesToDelete(caches).map((d) => d.id).sort();
    expect(ids).toEqual([1, 3, 4]);
  });

  it('never selects node-cache or other non-overlay keys', () => {
    const caches = [
      c(10, 'node-cache-Linux-x64-npm-aaa', '2026-11-01T00:00:00Z'),
      c(11, 'node-cache-Linux-x64-npm-aaa', '2026-11-02T00:00:00Z', 'refs/pull/5/merge'),
      c(12, 'other-key', '2026-11-01T00:00:00Z'),
      js(1, '20'), js(2, '22'),
    ];
    expect(selectCachesToDelete(caches, new Set()).map((d) => d.id)).toEqual([1]);
  });

  it('selects non-npm caches of closed PRs and keeps open PR caches', () => {
    const caches = [c(20, 'build-x', '2026-11-01T00:00:00Z', 'refs/pull/7/merge'), c(21, 'build-y', '2026-11-01T00:00:00Z', 'refs/pull/8/merge')];
    expect(selectCachesToDelete(caches, new Set([8])).map((d) => d.id)).toEqual([20]);
  });

  it('dry-run deletes nothing: the workflow only passes --apply on schedule/dispatch, and the script defaults to dry run', () => {
    const src = readFileSync(new URL('../prune-actions-caches.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/const apply = argv\.includes\('--apply'\)/);
    expect(src).toMatch(/if \(apply\) gh\(\['api', '-X', 'DELETE'/);
  });

  it('workflow is scheduled, least-privilege and runs the script', () => {
    const wf = yaml.load(readFileSync(new URL('../../../.github/workflows/cache-hygiene.yml', import.meta.url), 'utf8'));
    expect(wf.on.schedule?.length).toBeGreaterThan(0);
    expect(wf.permissions).toEqual({ actions: 'write', contents: 'read', 'pull-requests': 'read' });
    expect(JSON.stringify(wf.jobs)).toContain('prune-actions-caches.mjs --apply');
  });
});
