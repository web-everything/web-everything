import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFreeLaneList, resolveFreeLaneListPath, writeFreeLaneListAtomic } from '../lib/free-lane-list.mjs';
import soakBreak from '../conveyor/soak/breaks/lane-acquire-skips-unpushed.mjs';

const SCRIPT = resolve('scripts/lane-pool.mjs');
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
let base, origin, reference, poolRoot, bin, trace;
const lane = n => join(poolRoot, 'skiptest', `lane-${n}`);
const git = (args, cwd) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repoArgs = () => [`--origin=${origin}`, `--reference=${reference}`, '--name=skiptest', '--branch=main', '--no-install', '--no-reap'];
function run(args, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args, ...repoArgs()], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${bin}:${process.env.PATH}`, SKIP_TRACE: trace,
      WE_NEEDS_YOU_FEED: join(base, 'needs-you.jsonl'), LANE_POOL_ACQUIRE_DEFAULT_WAIT_MS: '0', ...extra },
  });
}
function freeList(numbers) {
  const poolDir = join(poolRoot, 'skiptest');
  writeFreeLaneListAtomic(resolveFreeLaneListPath({ repoName: 'skiptest', poolDir }), buildFreeLaneList({
    repoName: 'skiptest', poolDir, writtenAt: Date.now(),
    lanes: numbers.map(n => ({ lane: n, path: lane(n), head: git(['rev-parse', 'HEAD'], lane(n)), branch: 'local/lane' })),
  }));
}
function localCommits(n, count) {
  const dir = lane(n);
  git(['checkout', '-qb', 'local/lane'], dir);
  // Real commits with distinct, nonempty patches; no patch-equivalence shortcut can prove them pushed.
  let parent = git(['rev-parse', 'HEAD'], dir);
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, 'local.txt'), `lane ${n}, commit ${i}\n`);
    git(['add', 'local.txt'], dir);
    const tree = git(['write-tree'], dir);
    parent = git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', parent, '-m', `local ${i}`], dir);
  }
  git(['reset', '--hard', parent], dir);
  return parent;
}
function assertSkipped(numbers, heads) {
  for (const n of numbers) expect(git(['rev-parse', 'HEAD'], lane(n))).toBe(heads[n]);
  const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const protectedCalls = calls.filter(c => numbers.some(n => c.cwd.endsWith(`/lane-${n}`)));
  // Refusing a reset during provisioning is too late: it marks a provision failure and blocks growth.
  expect(protectedCalls.filter(c => c.args.some(a => ['fetch', 'checkout', 'reset', 'clean'].includes(a)))).toEqual([]);
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'acquire-skips-unpushed-'));
  origin = join(base, 'origin.git'); reference = join(base, 'reference');
  poolRoot = join(base, 'pool'); bin = join(base, 'bin'); trace = join(base, 'trace.jsonl');
  mkdirSync(bin); mkdirSync(reference);
  git(['init', '-q', '-b', 'main'], reference);
  writeFileSync(join(reference, 'file.txt'), 'base\n');
  git(['add', '.'], reference);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], reference);
  git(['clone', '-q', '--bare', reference, origin], base);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\n` +
    `const fs = require('node:fs'); const cp = require('node:child_process');\n` +
    `const args = process.argv.slice(2);\n` +
    `fs.appendFileSync(process.env.SKIP_TRACE, JSON.stringify({cwd:process.cwd(),args})+'\\n');\n` +
    `if (process.cwd().endsWith('/lane-1') && args.includes('rev-list') && args.includes('--count') && process.env.UNKNOWN_AHEAD) {\n` +
    `  if (process.env.UNKNOWN_AHEAD === 'oversized') { process.stdout.write('9007199254740992\\n'); process.exit(0); }\n` +
    `  process.exit(1);\n}\n` +
    `const r=cp.spawnSync(${JSON.stringify(REAL_GIT)},args,{stdio:'inherit'}); process.exit(r.status ?? 1);\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const provision = run(['provision', '--count=3']);
  expect(provision.status, provision.stderr).toBe(0);
  writeFileSync(trace, '');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('auto-pick skips unpushed and unknown-ahead lanes before provisioning', () => {
  it('replays the daemon break with the real acquire CLI', async () => {
    expect(soakBreak.judge(await soakBreak.run())).toEqual([]);
  });
  for (const listed of [false, true]) {
    for (const stale of [false, true]) {
      it(`preserves many local commits and acquires the clean higher lane (free list=${listed}, stale origin ref=${stale})`, () => {
        const heads = { 1: localCommits(1, 39), 2: localCommits(2, 17) };
        if (stale) for (const n of [1, 2]) git(['update-ref', 'refs/remotes/origin/lane/deleted', heads[n]], lane(n));
        if (listed) freeList([1, 2]); // Clean lane deliberately omitted: must fall through to the scan.
        writeFileSync(trace, '');
        const result = run(['acquire', '--session=picker', '--hard-max=3', '--json']);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).lane).toBe(3);
        assertSkipped([1, 2], heads);
      });
    }
  }
  for (const listed of [false, true]) {
    it(`skips an unknown ahead-count without provisioning it (free list=${listed})`, () => {
      const heads = { 1: git(['rev-parse', 'HEAD'], lane(1)) };
      if (listed) freeList([1]);
      writeFileSync(trace, '');
      const result = run(['acquire', '--session=unknown-picker', '--hard-max=3', '--json'], { UNKNOWN_AHEAD: '1' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).lane).toBe(2);
      const calls = readFileSync(trace, 'utf8');
      expect(calls).toContain('--count');
      assertSkipped([1], heads);
      expect(existsSync(join(lane(1), '.git', '.lane-lease'))).toBe(false);
    });
  }
  it('skipped unpushed hints do not suppress bounded growth when the clean lane is held', () => {
    const heads = { 1: localCommits(1, 3), 2: localCommits(2, 2) };
    const held = run(['acquire', '--lane=3', '--no-reset', '--session=holder']);
    expect(held.status, held.stderr).toBe(0);
    freeList([1, 2]);
    writeFileSync(trace, '');
    const result = run(['acquire', '--session=growth-picker', '--hard-max=4', '--growth-max-new=1', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).lane).toBe(4);
    assertSkipped([1, 2], heads);
  });
  it('skips an oversized, untrustworthy ahead-count and takes the next clean lane', () => {
    const heads = { 1: git(['rev-parse', 'HEAD'], lane(1)) };
    freeList([1]);
    writeFileSync(trace, '');
    const result = run(['acquire', '--session=oversized-picker', '--hard-max=3', '--json'], { UNKNOWN_AHEAD: 'oversized' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).lane).toBe(2);
    assertSkipped([1], heads);
  });
});
