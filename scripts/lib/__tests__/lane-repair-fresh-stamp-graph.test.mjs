// Live 2026-11-02: the fix daemon's clone had a corrupt commit-graph, the tick's repairCloneRefs returned early on a fresh
// deep-check stamp (never healing), and the read-only rebuild job deferred the heal to that tick forever.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { repairCloneRefs } from '../lane-repair.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let tmp, clone;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fresh-stamp-graph-'));
  const origin = join(tmp, 'origin.git');
  g(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(tmp, 'seed');
  g(tmp, 'clone', '-q', origin, seed);
  g(seed, 'config', 'user.email', 't@t'); g(seed, 'config', 'user.name', 't');
  writeFileSync(join(seed, 'a.txt'), 'a'); g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'one'); g(seed, 'push', '-q', 'origin', 'HEAD:main');
  clone = join(tmp, 'clone');
  g(tmp, 'clone', '-q', origin, clone);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const corruptGraph = () => {
  g(clone, 'commit-graph', 'write', '--reachable');
  const gp = join(clone, '.git/objects/info/commit-graph');
  expect(existsSync(gp)).toBe(true);
  chmodSync(gp, 0o644); const bytes = readFileSync(gp); bytes[bytes.length - 30] ^= 0xff; writeFileSync(gp, bytes);
  expect(() => g(clone, 'commit-graph', 'verify')).toThrow();
};

describe('repairCloneRefs with a fresh deep-check stamp', () => {
  it('still heals a commit-graph that went bad after the last deep check', () => {
    expect(repairCloneRefs(clone).ok).toBe(true);   // healthy: writes the fresh deep-check stamp
    corruptGraph();
    const r = repairCloneRefs(clone);                // inside the throttle window
    expect(r.commitGraphHealed).toBe(true);
    expect(() => g(clone, 'commit-graph', 'verify')).not.toThrow();
  });

  it('a healthy clone with a graph is not deep-checked again (verify only)', () => {
    g(clone, 'commit-graph', 'write', '--reachable');
    repairCloneRefs(clone);
    const r = repairCloneRefs(clone);
    expect(r.commitGraphHealed).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});
