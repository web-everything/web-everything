import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, renameSync, writeFileSync } from 'node:fs';
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
  return spawnSync(process.execPath, [SCRIPT, args[0], ...repoArgs(), ...args.slice(1)], {
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
    `if ((process.cwd().endsWith('/lane-1') || process.cwd().endsWith('/frontierui')) && args.includes('rev-list') && args.includes('--count') && process.env.UNKNOWN_AHEAD) {\n` +
    `  if (process.env.UNKNOWN_AHEAD === 'oversized') { process.stdout.write('9007199254740992\\n'); process.exit(0); }\n` +
    `  process.exit(1);\n}\n` +
    `if (process.env.FAIL_STATUS && args.includes('status') && (process.cwd().endsWith('/lane-1') || process.cwd().endsWith('/frontierui'))) process.exit(1);\n` +
    `if (process.env.FAIL_HISTORY && (process.cwd().endsWith('/lane-1') || process.cwd().endsWith('/frontierui')) && args.includes('rev-list') && args.includes('--max-count=200')) { process.stderr.write('fatal: missing ancestor\\n'); process.exit(1); }\n` +
    `if (process.env.LATE_STATUS_FAILURE && process.cwd().endsWith('/lane-1') && args.includes('status') && fs.readFileSync(process.env.SKIP_TRACE,'utf8').trim().split('\\n').map(JSON.parse).filter(c => c.cwd === process.cwd() && c.args.includes('status')).length >= 2) process.exit(1);\n` +
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
  for (const missing of ['directory', 'git metadata']) {
    for (const noReset of [false, true]) {
      it(`vanished free-list hint permits bounded growth without quarantine (${missing}, no-reset=${noReset})`, () => {
        rmSync(lane(3), { recursive: true, force: true });
        const held = run(['acquire', '--lane=2', '--no-reset', '--session=holder']);
        expect(held.status, held.stderr).toBe(0);
        freeList([1]);
        rmSync(missing === 'directory' ? lane(1) : join(lane(1), '.git'), { recursive: true, force: true });
        writeFileSync(trace, '');
        const result = run(['acquire', '--session=vanished-picker', '--wait-ms=0', '--hard-max=3', '--growth-max-new=1', '--json', ...(noReset ? ['--no-reset'] : [])]);
        expect(result.status, result.stderr).toBe(0);
        // Growth may fill a vacant number, but must preserve a checkout missing only metadata.
        expect(JSON.parse(result.stdout).lane).toBe(missing === 'directory' ? 1 : 3);
        if (missing === 'git metadata') expect(readFileSync(join(lane(1), 'file.txt'), 'utf8')).toBe('base\n');
        expect(result.stderr).not.toContain('QUARANTINED');
        const quarantine = join(poolRoot, 'skiptest', '.quarantine-state');
        expect(existsSync(join(quarantine, 'lane-1.json'))).toBe(false);
        expect(existsSync(join(quarantine, 'lane-1.evidence.jsonl'))).toBe(false);
      });
    }
  }
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

describe('audit fail-closed regressions', () => {
  for (const failure of [{ UNKNOWN_AHEAD: '1' }, { FAIL_STATUS: '1' }]) {
    it(`refresh refuses unknown evidence (${Object.keys(failure)[0]})`, () => {
      const head = failure.UNKNOWN_AHEAD ? localCommits(1, 1) : git(['rev-parse', 'HEAD'], lane(1));
      if (failure.FAIL_STATUS) writeFileSync(join(lane(1), 'precious.txt'), 'keep me');
      const result = run(['refresh', '--lane=1'], { ...failure, WE_LANE_HOLD: 'off' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('SKIPPED');
      expect(git(['rev-parse', 'HEAD'], lane(1))).toBe(head);
      if (failure.FAIL_STATUS) expect(readFileSync(join(lane(1), 'precious.txt'), 'utf8')).toBe('keep me');
      const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      expect(calls.filter(c => c.cwd === lane(1) && c.args.some(a => ['reset', 'clean'].includes(a)))).toEqual([]);
    });
  }
  it('refresh obeys a refused destructive verdict when the later snapshot probe fails', () => {
    const result = run(['refresh', '--lane=1'], { LATE_STATUS_FAILURE: '1', WE_LANE_HOLD: 'off' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('unpushed state unknown');
    const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    expect(calls.filter(c => c.cwd === lane(1) && c.args.some(a => ['reset', 'clean'].includes(a)))).toEqual([]);
  });
  for (const failure of [{ FAIL_STATUS: '1' }, { UNKNOWN_AHEAD: '1' }]) {
    it(`sibling reset refuses failed probes before checkout/reset/clean (${Object.keys(failure)[0]})`, () => {
      const wePool = join(poolRoot, 'web-everything');
      mkdirSync(wePool);
      renameSync(lane(3), join(wePool, 'lane-3'));
      const sibling = join(wePool, 'frontierui');
      git(['clone', '-q', origin, sibling], base);
      if (failure.FAIL_STATUS) writeFileSync(join(sibling, 'precious.txt'), 'keep me');
      else {
        writeFileSync(join(sibling, 'local.txt'), 'unpushed');
        git(['add', 'local.txt'], sibling);
        git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'unpushed'], sibling);
      }
      const head = git(['rev-parse', 'HEAD'], sibling);
      const result = run(['refresh', '--name=web-everything'], { ...failure, WE_LANE_HOLD: 'off' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('frontierui sibling: SKIPPED');
      expect(git(['rev-parse', 'HEAD'], sibling)).toBe(head);
      if (failure.FAIL_STATUS) expect(readFileSync(join(sibling, 'precious.txt'), 'utf8')).toBe('keep me');
      const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      expect(calls.filter(c => c.cwd === sibling && c.args.some(a => ['checkout', 'reset', 'clean'].includes(a)))).toEqual([]);
    });
  }
  for (const listed of [false, true]) {
    it(`local probe failure blocks growth despite reachable origin (free list=${listed})`, () => {
      for (const n of [2, 3]) expect(run(['acquire', `--lane=${n}`, '--no-reset', `--session=holder-${n}`]).status).toBe(0);
      if (listed) freeList([1]);
      const result = run(['acquire', '--session=blocked-growth', '--hard-max=4', '--growth-max-new=1'], { UNKNOWN_AHEAD: '1', LANE_POOL_NO_RECOVER: '1' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('local eligibility probe failed');
      expect(existsSync(lane(4))).toBe(false);
    });
  }
  it('unreadable hinted history records evidence, retries and persists quarantine', () => {
    freeList([1]);
    const result = run(['acquire', '--session=quarantine-picker', '--hard-max=3', '--json'], { FAIL_HISTORY: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).lane).toBe(2);
    expect(result.stderr).toContain('QUARANTINED');
    const state = join(poolRoot, 'skiptest', '.quarantine-state');
    expect(existsSync(join(state, 'lane-1.json'))).toBe(true);
    expect(readFileSync(join(state, 'lane-1.evidence.jsonl'), 'utf8')).toContain('missing ancestor');
    const calls = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    expect(calls.filter(c => c.cwd === lane(1) && c.args.includes('--max-count=200'))).toHaveLength(2);
  });
  it('failed ahead probe with litter-only dirt is not remembered as held after recovery', () => {
    const scratch = join(lane(1), '.pr-body.md');
    writeFileSync(scratch, 'scratch');
    utimesSync(scratch, new Date(0), new Date(0));
    const failed = run(['list', '--acquirable', '--no-cache'], { UNKNOWN_AHEAD: '1' });
    expect(failed.status, failed.stderr).toBe(0);
    const memo = JSON.parse(readFileSync(join(poolRoot, 'skiptest', '.acquirable-verdict-memo.json'), 'utf8'));
    expect(memo.lanes['1']).toBeUndefined();
    const recovered = run(['list', '--acquirable', '--no-cache']);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain(lane(1));
  });
  it('stale integration patch equivalence cannot vouch for work removed from live origin', () => {
    const head = localCommits(1, 1);
    // Same patch, different commit ID: only the stale tracking ref has it.
    const tree = git(['rev-parse', `${head}^{tree}`], lane(1));
    const parent = git(['rev-parse', 'origin/main'], lane(1));
    const stale = git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', parent, '-m', 'old integration'], lane(1));
    git(['update-ref', 'refs/remotes/origin/main', stale], lane(1));
    freeList([1]); writeFileSync(trace, '');
    const result = run(['acquire', '--session=stale-picker', '--hard-max=3', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).lane).toBe(2);
    assertSkipped([1], { 1: head });
  });
  it('any-equivalence override cannot make one matching patch vouch for another unpushed commit', () => {
    const first = localCommits(1, 1);
    // Publish just the first patch on another branch, without a push/fetch.
    const tree = git(['rev-parse', `${first}^{tree}`], lane(1));
    const parent = git(['rev-parse', 'origin/main'], lane(1));
    const published = git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', parent, '-m', 'published patch'], lane(1));
    execFileSync(REAL_GIT, ['--git-dir=' + origin, 'unpack-objects'], { input: execFileSync(REAL_GIT, ['pack-objects', '--stdout', '--revs'], { cwd: lane(1), input: published + '\n' }) });
    git(['update-ref', 'refs/heads/other', published], origin);
    writeFileSync(join(lane(1), 'second.txt'), 'unpublished');
    git(['add', 'second.txt'], lane(1));
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'unpublished'], lane(1));
    const head = git(['rev-parse', 'HEAD'], lane(1));
    freeList([1]); writeFileSync(trace, '');
    const result = run(['acquire', '--session=strict-picker', '--hard-max=3', '--json'], { WE_LANE_AHEAD_EQUIVALENCE: 'any', WE_LANE_HOLD: 'off' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).lane).toBe(2);
    assertSkipped([1], { 1: head });
  });
  it('soak enforcement does not depend on a source marker', () => {
    expect(soakBreak.fixPresent(base)).toBe(true); // Even a root with no lane-pool source keeps required-pass mode.
    expect(soakBreak.judge({ code: 1, picked: null, preserved: false, fetches: 'fetch' })).not.toEqual([]);
  });
});
