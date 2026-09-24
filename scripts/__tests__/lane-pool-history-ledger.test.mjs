/**
 * @file scripts/__tests__/lane-pool-history-ledger.test.mjs
 * @description Proof of #3383's lane-history hook points: `lane-pool.mjs acquire`/`adopt`/`release`, and the
 * reaper's ghost reclaim, each append a line to `<lane>/.git/lane-history.jsonl` — the durable trail that
 * survives a released lease (unlike the marker itself, which `release` deletes outright). Real child process,
 * throwaway bare origin + reference, private `LANE_POOL_ROOT` — same tier-1 geometry as the existing
 * `lane-pool-reap-on-*` suites.
 *
 * BEFORE (proof the gap was real): `git log -p` on this test's own throwaway lane before any of these calls
 * run shows no `.git/lane-history.jsonl` at all — nothing records who used a lane once its lease is released.
 * This suite is the AFTER.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_LEASE_TTL_MINUTES } from '../lib/lane-lease.mjs';
import { laneHistoryPath, readLaneHistory } from '../lib/lane-history.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const LEASE_FILE = (lane) => join(lane, '.git', '.lane-lease');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

function runPool(args) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: referenceDir,
    env: { ...process.env, LANE_POOL_ROOT: poolRoot },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, `--name=histledger`, '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, 'histledger', `lane-${n}`);

function pushCard(num, status) {
  const dir = join(referenceDir, 'backlog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${num}-item.md`), `---\nstatus: ${status}\n---\n\n# item ${num}\n`);
  git(['add', 'backlog'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', `card ${num} ${status}`], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-history-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);

  expect(runPool(['provision', '--count=2', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('lane-history ledger — BEFORE', () => {
  it('a freshly provisioned lane has no ledger at all (the gap #3383 closes)', () => {
    expect(existsSync(laneHistoryPath(lanePath(1)))).toBe(false);
  });
});

describe('lane-history ledger — AFTER', () => {
  it('acquire appends an "acquire" line carrying session/purpose/item/holder', () => {
    const r = runPool(['acquire', '--lane=1', '--session=sess-a', '--purpose=my-work', '--item=3901', ...poolArgs()]);
    expect(r.code).toBe(0);
    const entries = readLaneHistory(lanePath(1));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'acquire', session: 'sess-a', purpose: 'my-work', item: '3901' });
    expect(entries[0].holder).toMatch(/^my-work-lane-1-/);
    expect(entries[0].ts).toBeTruthy();
  });

  it('adopt appends an "adopt" line stamping the occupant session', () => {
    expect(runPool(['acquire', '--lane=1', '--session=sess-a', ...poolArgs()]).code).toBe(0);
    // adopt needs CLAUDE_CODE_SESSION_ID — inject it directly for this ONE call (the ambient env this vitest
    // process itself runs under may already carry a real CLAUDE_CODE_SESSION_ID, so this must be the only
    // adopt call in this test — a second one with a different id would hit the foreign-occupant guard).
    const withEnv = spawnSync('node', [SCRIPT, 'adopt', '--lane=1', ...poolArgs()], {
      encoding: 'utf8', cwd: referenceDir,
      env: { ...process.env, LANE_POOL_ROOT: poolRoot, CLAUDE_CODE_SESSION_ID: 'occupant-xyz' },
    });
    expect(withEnv.status).toBe(0);
    const entries = readLaneHistory(lanePath(1));
    const adoptEntry = entries.find((e) => e.event === 'adopt');
    expect(adoptEntry).toMatchObject({ event: 'adopt', ownerSession: 'occupant-xyz', workerSession: 'occupant-xyz' });
  });

  it('release appends a "release" line — the trail SURVIVES the marker being deleted', () => {
    // release derives `item` from the SESSION's own dispatcher-grammar name (itemNumFromSession) — a
    // conveyor-style session name, matching `conveyor/lease-reaper.mjs`'s own convention.
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-3901', '--item=3901', ...poolArgs()]).code).toBe(0);
    const r = runPool(['release', '--lane=1', '--session=conveyor-3901', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(LEASE_FILE(lanePath(1)))).toBe(false); // marker is gone
    const entries = readLaneHistory(lanePath(1)); // but the ledger remembers
    expect(entries.map((e) => e.event)).toEqual(['acquire', 'release']);
    expect(entries[1]).toMatchObject({ event: 'release', session: 'conveyor-3901', item: '3901' });
  });

  it('the reaper appends a "reap" line for a provably-dead ghost, before dropping its marker', () => {
    pushCard('9999', 'resolved');
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-9999', '--no-reap', ...poolArgs()]).code).toBe(0);
    // Backdate past TTL so the reaper's item-resolved axis fires.
    const leaseFile = LEASE_FILE(lanePath(1));
    const lease = JSON.parse(readFileSync(leaseFile, 'utf8'));
    lease.acquiredAt = new Date(Date.now() - (DEFAULT_LEASE_TTL_MINUTES + 60) * 60_000).toISOString();
    writeFileSync(leaseFile, JSON.stringify(lease, null, 2));

    const r = runPool(['list', '--acquirable', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(existsSync(leaseFile)).toBe(false); // reaped

    const entries = readLaneHistory(lanePath(1));
    const reapEntry = entries.find((e) => e.event === 'reap');
    expect(reapEntry).toBeTruthy();
    expect(reapEntry.reason).toBe('pr-merged');
    expect(reapEntry.item).toBe('9999');
  });

  it('the ledger lives inside .git/ — never tracked, never dirty, never wiped by acquire\'s reset', () => {
    expect(runPool(['acquire', '--lane=1', '--session=sess-a', ...poolArgs()]).code).toBe(0);
    expect(runPool(['release', '--lane=1', '--session=sess-a', ...poolArgs()]).code).toBe(0);
    const before = readLaneHistory(lanePath(1));
    expect(before.length).toBeGreaterThan(0);
    // A fresh acquire resets the lane (checkout -B + clean -fd) — the ledger must survive that untouched, and
    // git status must report clean (never see lane-history.jsonl as untracked).
    expect(runPool(['acquire', '--lane=1', '--session=sess-b', ...poolArgs()]).code).toBe(0);
    const status = git(['status', '--porcelain'], lanePath(1));
    expect(status).toBe('');
    const after = readLaneHistory(lanePath(1));
    expect(after.length).toBe(before.length + 1); // the new acquire's own line, nothing lost
  });
});
