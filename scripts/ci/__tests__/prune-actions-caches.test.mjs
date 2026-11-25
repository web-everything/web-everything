// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { overlayLanguage, parseCaches, parseOpenPrs, selectCachesToDelete } from '../prune-actions-caches.mjs';

const c = (id, key, created_at, ref = 'refs/heads/main') => ({ id, key, ref, created_at });
// Key layout sampled in review; its abbreviated commit is reconstructed for fixtures.
const overlayKey = (language, id) => `codeql-overlay-base-database-1-c801913f1ee29663-${language}-2.27.5-a8ce0d12ae780000000000000000000000000000-${45461855920 + id}-1`;
const js = (id, day, ref) => c(id, overlayKey('javascript', id), `2026-11-${day}T00:00:00Z`, ref);
const py = (id, day, ref) => c(id, overlayKey('python', id), `2026-11-${day}T00:00:00Z`, ref);
const ids = (r) => r.map((d) => d.id).sort((a, b) => a - b);

describe('prune-actions-caches', () => {
  it('parses the language after the components hash in the review-sampled CodeQL key layout', () => {
    expect(overlayLanguage(overlayKey('javascript', 1))).toBe('javascript');
    expect(overlayLanguage(overlayKey('python', 2))).toBe('python');
    expect(overlayLanguage(overlayKey('csharp', 3).replace('2.27.5', '2.28.0'))).toBe('csharp');
    expect(overlayLanguage(overlayKey('c-cpp', 4).replace('2.27.5', '2.28.0-rc.1'))).toBe('c-cpp');
    expect(overlayLanguage(overlayKey('javascript', 5).toUpperCase())).toBe('javascript');
    expect(overlayLanguage('codeql-overlay-base-database-1-abc1-javascript')).toBeNull();
    expect(overlayLanguage('node-cache-Linux-x64-npm-aaa')).toBeNull();
    expect(overlayLanguage(`${overlayKey('javascript', 1)}\n`)).toBeNull();
    expect(overlayLanguage(overlayKey('javascript', 1).replace('c801913f1ee29663', 'not-a-components-hash'))).toBeNull();
  });

  it('keeps the newest overlay per language and lists the rest for deletion', () => {
    const caches = [js(1, '20'), js(2, '22'), js(3, '21'), py(4, '19'), py(5, '23')];
    expect(ids(selectCachesToDelete(caches, new Set()))).toEqual([1, 3, 4]);
  });

  it('groups the same language across components hashes, CodeQL versions, commits and attempts', () => {
    const old = js(1, '20');
    const newest = { ...js(2, '22'), key: overlayKey('javascript', 2)
      .replace('c801913f1ee29663', '0000000000000000')
      .replace('2.27.5', '2.28.0')
      .replace('a8ce0d12ae780000000000000000000000000000', 'ffffffffffffffffffffffffffffffffffffffff')
      .replace(/-1$/, '-2') };
    expect(ids(selectCachesToDelete([old, newest], new Set()))).toEqual([1]);
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
    const caches = [c(20, 'build-x', '2026-11-01T00:00:00Z', 'refs/pull/7/merge'), js(1, '20'), js(2, '21')];
    expect(selectCachesToDelete(caches)).toEqual([]);
  });

  it.each([
    ['refs/heads/main', overlayKey('javascript', 4)],
    ['refs/pull/7/merge', overlayKey('javascript', 4)],
    ['refs/pull/7/merge', 'build-x'],
    ['refs/heads/main', 'node-cache-x'],
  ])('invalid timestamps on %s / %s prevent deletion across all selection paths', (ref, key) => {
    const bad = c(4, key, 'garbage', ref);
    const caches = [bad, js(1, '20'), js(2, '21'), c(3, 'build-x', '2026-11-01T00:00:00Z', 'refs/pull/7/merge')];
    expect(selectCachesToDelete(caches, new Set())).toEqual([]);
  });

  it('filters malformed records while still pruning valid main and closed-PR caches', () => {
    const malformed = [null, { id: 'x' }, { ...js(5, '20'), id: '5' }, { ...js(6, '20'), key: null }, { ...js(7, '20'), ref: undefined }];
    const caches = [...malformed, js(1, '20'), js(2, '21'), c(3, 'build-x', '2026-11-01T00:00:00Z', 'refs/pull/7/merge')];
    expect(ids(selectCachesToDelete(caches, new Set()))).toEqual([1, 3]);
  });

  it('rejects malformed enumeration responses', () => {
    expect(() => parseCaches('[{"total_count":0}]')).toThrow();
    expect(() => parseCaches('{}')).toThrow();
    expect(() => parseCaches('[]')).toThrow();
    expect(() => parseOpenPrs('[[{"number":1},{"id":2}]]')).toThrow();
    expect(() => parseOpenPrs('[]')).toThrow();
    expect(() => parseOpenPrs('[{"number":1}]')).toThrow();
    expect([...parseOpenPrs('[[]]')]).toEqual([]);
    expect([...parseOpenPrs('[[{"number":1}],[{"number":2}]]')]).toEqual([1, 2]);
  });

  describe('CLI with a fake gh', () => {
    const run = (extraArgs, options = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'prune-caches-'));
      const log = join(dir, 'calls.log');
      const fake = join(dir, 'gh');
      const payload = {
        caches: [{ actions_caches: options.caches ?? [js(1, '20'), js(2, '22'), c(3, 'node-cache-x', '2026-11-01T00:00:00Z')] }],
        pulls: [[{ number: 1 }]],
      };
      writeFileSync(
        fake,
        `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2).join(' ');fs.appendFileSync(${JSON.stringify(log)},a+'\\n');\n` +
          `const p=${JSON.stringify(payload)},o=${JSON.stringify(options)};
if(a.includes('-X DELETE'))process.exit(0);
if(a.includes('/pulls')){
  if(o.pullsExit){process.stderr.write('pulls unavailable');process.exit(o.pullsExit);}
  process.stdout.write(o.pullsRaw ?? JSON.stringify(p.pulls));
}else if(a.endsWith('/actions/cache/usage')){
  process.stdout.write(o.usageRaw ?? JSON.stringify({active_caches_size_in_bytes:o.usageBytes ?? 3000000000}));
}else{
  const deleted=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(l=>l.includes('-X DELETE')).map(l=>Number(l.split('/').pop()));
  const records=p.caches[0].actions_caches.filter(c=>!deleted.includes(c.id) && !(o.loseNpm && deleted.length && c.key.startsWith('node-cache-')));
  process.stdout.write(JSON.stringify([{actions_caches:records}]));
}\n`,
      );
      chmodSync(fake, 0o755);
      const r = spawnSync(process.execPath, ['scripts/ci/prune-actions-caches.mjs', '--repo=o/r', ...extraArgs], {
        env: { ...process.env, GH_BIN: fake },
        encoding: 'utf8',
        timeout: 10_000,
      });
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      return { r, calls, deletes: calls.filter((l) => l.includes('-X DELETE')) };
    };

    it('dry-run issues no DELETE calls', () => {
      const { r, deletes } = run([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('would delete 1 ');
      expect(deletes).toEqual([]);
    });

    it('requires --apply for post-run acceptance without issuing any gh call', () => {
      const r = spawnSync(process.execPath, ['scripts/ci/prune-actions-caches.mjs', '--verify-acceptance'], {
        env: { ...process.env, GH_BIN: '/nonexistent/gh' }, encoding: 'utf8', timeout: 10_000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--verify-acceptance requires --apply');
    });

    it('--apply deletes only the older overlay', () => {
      const { r, deletes } = run(['--apply']);
      expect(r.status).toBe(0);
      expect(deletes).toEqual(['api -X DELETE repos/o/r/actions/caches/1']);
    });

    it.each([
      { pullsRaw: 'garbage' },
      { pullsRaw: '[{"number":1}]' },
      { pullsExit: 1 },
    ])('aborts before any DELETE when the second gh call fails: %j', (options) => {
      const { r, deletes } = run(['--apply'], options);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/JSON|array|failed/);
      expect(deletes).toEqual([]);
    });

    it('invalid timestamps abort --apply before deleting valid main or closed-PR caches', () => {
      const { r, deletes } = run(['--apply'], { caches: [js(1, '20'), js(2, '21'), { ...js(4, '20'), created_at: 'garbage' }, js(5, '20', 'refs/pull/7/merge')] });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('timestamp');
      expect(deletes).toEqual([]);
    });

    it('live dry-run gate requires at least one candidate and never deletes', () => {
      const selected = run(['--require-candidates']);
      expect(selected.r.status).toBe(0);
      expect(selected.r.stdout).toContain('would delete 1 ');
      expect(selected.deletes).toEqual([]);
      const empty = run(['--require-candidates'], { caches: [js(2, '22')] });
      expect(empty.r.status).toBe(1);
      expect(empty.r.stderr).toContain('No pruning candidates');
      expect(empty.deletes).toEqual([]);
    });

    it('post-prune usage is below 4 GB and pre-run npm cache IDs remain', () => {
      const { r, calls, deletes } = run(['--apply', '--verify-acceptance']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Acceptance passed: 3000000000 bytes < 4000000000; all 1 npm cache IDs remain');
      expect(deletes).toEqual(['api -X DELETE repos/o/r/actions/caches/1']);
      expect(calls.slice(-2)).toEqual([
        'api --paginate --slurp repos/o/r/actions/caches?per_page=100',
        'api repos/o/r/actions/cache/usage',
      ]);
    });

    it.each([
      { usageBytes: 4000000000 },
      { usageBytes: 5000000000 },
      { usageRaw: '{}' },
      { usageRaw: 'garbage' },
      { usageBytes: -1 },
      { usageBytes: '3000000000' },
      { loseNpm: true },
    ])('fails operational acceptance on excessive/unknown usage or missing npm IDs: %j', (options) => {
      // loseNpm applies only after a DELETE so the pre-run inventory includes it.
      const { r } = run(['--apply', '--verify-acceptance'], options);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('Acceptance passed');
    });
  });

  it('workflow is scheduled, least-privilege and runs the script', () => {
    const wf = yaml.load(readFileSync(new URL('../../../.github/workflows/cache-hygiene.yml', import.meta.url), 'utf8'));
    expect(wf.on.schedule).toEqual([{ cron: '17 5 * * *' }]);
    expect(wf.permissions).toEqual({ actions: 'write', contents: 'read', 'pull-requests': 'read' });
    expect(JSON.stringify(wf.jobs)).toContain('prune-actions-caches.mjs --apply --verify-acceptance');
  });
});
