// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { parseCaches, parseOpenPrs, selectCachesToDelete } from '../prune-actions-caches.mjs';

const c = (id, key, created_at, ref = 'refs/heads/main') => ({ id, key, ref, created_at });
const js = (id, day, ref) => c(id, `codeql-overlay-base-database-1-abc${id}-javascript`, `2026-11-${day}T00:00:00Z`, ref);
const py = (id, day, ref) => c(id, `codeql-overlay-base-database-1-abc${id}-python`, `2026-11-${day}T00:00:00Z`, ref);
const ids = (r) => r.map((d) => d.id).sort((a, b) => a - b);

describe('prune-actions-caches', () => {
  it('keeps the newest overlay per language and lists the rest for deletion', () => {
    const caches = [js(1, '20'), js(2, '22'), js(3, '21'), py(4, '19'), py(5, '23')];
    expect(ids(selectCachesToDelete(caches, new Set()))).toEqual([1, 3, 4]);
  });

  it('retention is per ref: a newer PR overlay never evicts the main overlay', () => {
    const caches = [js(1, '20'), js(2, '22', 'refs/pull/9/merge')];
    expect(selectCachesToDelete(caches, new Set([9]))).toEqual([]);
  });

  it('closed-PR overlays are deleted even when newest; open-PR older overlays follow the newest-per-ref rule', () => {
    const caches = [js(1, '20', 'refs/pull/5/merge'), js(2, '21', 'refs/pull/9/merge'), js(3, '22', 'refs/pull/9/merge')];
    expect(ids(selectCachesToDelete(caches, new Set([9])))).toEqual([1, 2]);
  });

  it('never selects node-cache or other non-overlay keys on main', () => {
    const caches = [
      c(10, 'node-cache-Linux-x64-npm-aaa', '2026-11-01T00:00:00Z'),
      c(11, 'node-cache-Linux-x64-npm-aaa', '2026-11-02T00:00:00Z', 'refs/pull/5/merge'),
      c(12, 'other-key', '2026-11-01T00:00:00Z'),
      js(1, '20'), js(2, '22'),
    ];
    expect(ids(selectCachesToDelete(caches, new Set()))).toEqual([1]);
  });

  it('selects non-npm caches of closed PRs and keeps open PR caches', () => {
    const caches = [c(20, 'build-x', '2026-11-01T00:00:00Z', 'refs/pull/7/merge'), c(21, 'build-y', '2026-11-01T00:00:00Z', 'refs/pull/8/merge')];
    expect(ids(selectCachesToDelete(caches, new Set([8])))).toEqual([20]);
  });

  it('fails closed without open-PR evidence', () => {
    const caches = [c(20, 'build-x', '2026-11-01T00:00:00Z', 'refs/pull/7/merge'), js(1, '20', 'refs/pull/7/merge'), js(2, '21', 'refs/pull/7/merge')];
    expect(selectCachesToDelete(caches)).toEqual([]);
  });

  it('ignores overlays with invalid timestamps instead of deleting newer valid ones', () => {
    const bad = { ...js(1, '20'), created_at: 'garbage' };
    expect(selectCachesToDelete([bad, js(2, '21')], new Set())).toEqual([]);
  });

  it('rejects malformed enumeration responses', () => {
    expect(() => parseCaches('[{"total_count":0}]')).toThrow();
    expect(() => parseCaches('{}')).toThrow();
    expect(() => parseOpenPrs('[[{"number":1},{"id":2}]]')).toThrow();
    expect([...parseOpenPrs('[[{"number":1}],[{"number":2}]]')]).toEqual([1, 2]);
  });

  describe('CLI with a fake gh', () => {
    const run = (extraArgs) => {
      const dir = mkdtempSync(join(tmpdir(), 'prune-caches-'));
      const log = join(dir, 'calls.log');
      const fake = join(dir, 'gh');
      const payload = {
        caches: [{ actions_caches: [js(1, '20'), js(2, '22'), c(3, 'node-cache-x', '2026-11-01T00:00:00Z')] }],
        pulls: [[{ number: 1 }]],
      };
      writeFileSync(
        fake,
        `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2).join(' ');fs.appendFileSync(${JSON.stringify(log)},a+'\\n');\n` +
          `const p=${JSON.stringify(payload)};if(a.includes('-X DELETE'))process.exit(0);process.stdout.write(JSON.stringify(a.includes('/pulls')?p.pulls:p.caches));\n`,
      );
      chmodSync(fake, 0o755);
      const r = spawnSync(process.execPath, ['scripts/ci/prune-actions-caches.mjs', '--repo=o/r', ...extraArgs], {
        env: { ...process.env, GH_BIN: fake },
        encoding: 'utf8',
      });
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      return { r, deletes: calls.filter((l) => l.includes('-X DELETE')) };
    };

    it('dry-run issues no DELETE calls', () => {
      const { r, deletes } = run([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('would delete 1 ');
      expect(deletes).toEqual([]);
    });

    it('--apply deletes only the older overlay', () => {
      const { r, deletes } = run(['--apply']);
      expect(r.status).toBe(0);
      expect(deletes).toEqual(['api -X DELETE repos/o/r/actions/caches/1']);
    });
  });

  it('workflow is scheduled, least-privilege and runs the script', () => {
    const wf = yaml.load(readFileSync(new URL('../../../.github/workflows/cache-hygiene.yml', import.meta.url), 'utf8'));
    expect(wf.on.schedule?.length).toBeGreaterThan(0);
    expect(wf.permissions).toEqual({ actions: 'write', contents: 'read', 'pull-requests': 'read' });
    expect(JSON.stringify(wf.jobs)).toContain('prune-actions-caches.mjs --apply');
  });
});
