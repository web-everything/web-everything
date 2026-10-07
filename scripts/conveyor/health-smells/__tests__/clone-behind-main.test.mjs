/**
 * @file scripts/conveyor/health-smells/__tests__/clone-behind-main.test.mjs
 * @description 2026-10-06: the drain code clone sat ~20h behind main with no alert. Real git (temp repos) through
 *   `probeCloneLag`, then the smell.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeCloneLag } from '../../health-watch.mjs';
import smell from '../clone-behind-main.mjs';
import { MINUTE } from '../../health-watch-core.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

describe('clone-behind-main', () => {
  it('reports a clone that trails origin/main, and none that is current', () => {
    const origin = mkdtempSync(join(tmpdir(), 'cbm-o-'));
    g(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'a'), '1'); g(origin, 'add', '.'); g(origin, 'commit', '-qm', 'one');
    const stale = mkdtempSync(join(tmpdir(), 'cbm-s-'));
    g(tmpdir(), 'clone', '-q', origin, stale);
    writeFileSync(join(origin, 'a'), '2'); g(origin, 'commit', '-qam', 'two');
    writeFileSync(join(origin, 'a'), '3'); g(origin, 'commit', '-qam', 'three');
    const fresh = mkdtempSync(join(tmpdir(), 'cbm-f-'));
    g(tmpdir(), 'clone', '-q', origin, fresh);
    g(fresh, 'fetch', '-q', 'origin', 'main');
    const lag = probeCloneLag({ roots: [stale, fresh, join(tmpdir(), 'nope-xyz')], exec: (c, a) => exec(c, a), repo: fresh, fetch: false });
    const byRoot = Object.fromEntries(lag.map((c) => [c.cloneRoot, c]));
    expect(byRoot[fresh].behind).toBe(0);
    expect(byRoot[stale].behind).toBe(2);
    expect(byRoot[stale].behindSinceMs).toBeGreaterThan(0);
  });

  it('breaches only past the age threshold while behind', () => {
    const now = Date.parse('2026-10-06T22:00:00Z');
    const mk = (behind, minAgo) => [{ cloneRoot: '/c', head: 'abc', behind, behindSinceMs: now - minAgo * MINUTE }];
    const ev = (lag) => smell.evaluate({ cloneLag: lag }, { now })[0];
    expect(ev(mk(3, 20 * 60)).breach).toBe(true);
    expect(ev(mk(3, 5)).breach).toBe(false);
    expect(ev(mk(0, 20 * 60)).breach).toBe(false);
  });
});
