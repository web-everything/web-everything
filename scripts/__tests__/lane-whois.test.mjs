/**
 * @file scripts/__tests__/lane-whois.test.mjs
 * @description Proof of #3383's `lane-whois.mjs` — the read-only per-lane report over a real (throwaway)
 * pool: current lease + holder-alive, last holder (ledger or inference), uncommitted/ahead summary + proof of
 * preservation, card/PR lookup, and the four-way verdict. Real child process, private `LANE_POOL_ROOT`, no
 * network (`gh`/`claude` are faked on PATH) — same tier-1 geometry as the other `lane-pool-*` suites.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const POOL_SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const WHOIS_SCRIPT = resolve(process.cwd(), 'scripts/lane-whois.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, binDir, env;

function runPool(args) {
  const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function runWhois(args) {
  const r = spawnSync('node', [WHOIS_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=whoispool', '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, 'whoispool', `lane-${n}`);

function pushCard(num, status) {
  const dir = join(referenceDir, 'backlog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${num}-item.md`), `---\nstatus: ${status}\n---\n\n# item ${num}\n`);
  git(['add', 'backlog'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', `card ${num} ${status}`], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-whois-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');
  binDir = join(base, 'bin');
  mkdirSync(binDir);
  // Fake `gh` (no PRs anywhere) and `claude agents --json` (no live sessions) so the report never touches the
  // network or a real Claude Code session listing.
  writeFileSync(join(binDir, 'gh'), '#!/bin/sh\necho "[]"\n');
  chmodSync(join(binDir, 'gh'), 0o755);
  writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "[]"\n');
  chmodSync(join(binDir, 'claude'), 0o755);
  env = { ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${binDir}:${process.env.PATH}`, HOME: base };

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);

  expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('lane-whois — BEFORE (the gap)', () => {
  it('a plain `status`/`list` never answers "who used this lane, and is it done?" — whois does', () => {
    // (documented, not asserted against a command that doesn't exist — `lane-pool.mjs` has no `whois` verb at
    // all; that's the gap. `lane-whois.mjs` is the new, separate module that closes it — see the AAFTER block.)
    const r = runPool(['status', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/verdict|reclaimable/i);
  });
});

describe('lane-whois — AFTER', () => {
  it('a clean, unleased, untouched lane is finished-reclaimable (nothing to lose)', () => {
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].verdict).toBe('finished-reclaimable');
    expect(report.lanes[0].holderAlive).toBe(false);
  });

  it('a live-leased lane reports in-use, regardless of content', () => {
    expect(runPool(['acquire', '--lane=1', '--session=sess-a', ...poolArgs()]).code).toBe(0);
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].verdict).toBe('in-use');
    expect(report.lanes[0].holderAlive).toBe(true);
    expect(report.lanes[0].lease.session).toBe('sess-a');
  });

  it('reads the last holder off the lane-history ledger once one exists', () => {
    // release derives `item` from the session's own dispatcher-grammar name (itemNumFromSession) — see
    // lane-pool-history-ledger.test.mjs for the same convention.
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-3901', '--item=3901', ...poolArgs()]).code).toBe(0);
    expect(runPool(['release', '--lane=1', '--session=conveyor-3901', ...poolArgs()]).code).toBe(0);
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].lastHolder.event).toBe('release');
    expect(report.lanes[0].lastHolder.session).toBe('conveyor-3901');
    expect(report.lanes[0].lastHolder.item).toBe('3901');
  });

  it('a card resolved on main + an ahead commit PUSHED to its own remote lane/* branch is finished-reclaimable, WITH proof', () => {
    pushCard('4200', 'resolved');
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-4200', '--item=4200', ...poolArgs()]).code).toBe(0);
    // Commit in the lane, then push it to its OWN `lane/*` ref (exactly what `pr-land.mjs` does) — the PR
    // built off that ref then merges (mirrored here by resolving the card), so the commit is provably
    // preserved on a remote branch even though it never reaches `origin/main` under this same sha.
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', '4200: land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/4200-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=conveyor-4200', ...poolArgs()]).code).toBe(0);

    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    const row = report.lanes[0];
    expect(row.ahead.count).toBe(1);
    expect(row.ahead.commits[0].preserved).toBe(true); // patch-equivalent (empty diff) already "in" main
    expect(row.cards).toEqual([{ id: '4200', status: 'resolved' }]);
    expect(row.preserved).toBe(true);
    expect(row.verdict).toBe('finished-reclaimable');
  });

  it('unpreserved uncommitted content on a resolved card is finished-needs-review, never auto-reclaimed', () => {
    pushCard('4201', 'resolved');
    expect(runPool(['acquire', '--lane=2', '--session=conveyor-4201', '--item=4201', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(2);
    writeFileSync(join(dir, 'new-work.txt'), 'never pushed anywhere\n');
    expect(runPool(['release', '--lane=2', '--session=conveyor-4201', ...poolArgs()]).code).toBe(0);

    const r = runWhois(['--lane=2', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    const row = report.lanes[0];
    expect(row.uncommitted.untracked).toBe(1);
    expect(row.preserved).toBe(false);
    expect(row.unpreservedFiles).toEqual(['new-work.txt']);
    expect(row.verdict).toBe('finished-needs-review');
  });

  it('untouched content with an OPEN card is unknown-work', () => {
    pushCard('4202', 'open');
    expect(runPool(['acquire', '--lane=3', '--session=conveyor-4202', '--item=4202', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(3), 'wip.txt'), 'still going\n');
    expect(runPool(['release', '--lane=3', '--session=conveyor-4202', ...poolArgs()]).code).toBe(0);

    const r = runWhois(['--lane=3', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].verdict).toBe('unknown-work');
  });

  it('lanesNeedingDecision surfaces only finished-needs-review / unknown-work lanes — the operator-queue feed', async () => {
    const { lanesNeedingDecision } = await import('../lane-whois.mjs');
    const decisions = lanesNeedingDecision({
      lanes: [
        { exists: true, lane: 1, verdict: 'in-use' },
        { exists: true, lane: 2, verdict: 'finished-reclaimable' },
        { exists: true, lane: 3, verdict: 'finished-needs-review', reason: 'x', path: '/a' },
        { exists: true, lane: 4, verdict: 'unknown-work', reason: 'y', path: '/b' },
      ],
    });
    expect(decisions.map((d) => d.lane)).toEqual([3, 4]);
  });

  it('scans every requested lane in ONE transcript grep pass (no lane left unreported)', () => {
    const r = runWhois(['--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes.map((l) => l.lane)).toEqual([1, 2, 3]);
  });
});
