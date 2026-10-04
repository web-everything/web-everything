/**
 * @file scripts/__tests__/lane-pool-status-leased-only.test.mjs
 * @description WE #4345 — `lane-pool.mjs status --leased-only` skips the per-lane git probe (rev-parse ×2,
 *   `status --porcelain`, rev-list — 4 git spawns/lane) for every lane with NO live lease, running it only for
 *   lanes that ARE leased. On the real pool (90 lanes, 1-2 leased) that cuts ~364 git spawns / ~14s to a
 *   handful. This file pins, against a real (throwaway) fixture pool:
 *
 *   1. Git-spawn count under `--leased-only` is bounded to the LEASED lane only — zero git spawns attributable
 *      to any unleased lane's directory (counted via a PATH-shimmed git wrapper, the same technique as
 *      lane-pool-ahead-provably-pushed-single-spawn.test.mjs).
 *   2. The leased lane's OWN row is byte-identical between `--leased-only` and a full `status` call — this is
 *      a SKIP, never a different answer, for the one row a caller actually needs.
 *   3. Every unleased row omits the git-derived fields (`head`/`branch`/`clean`/`behind`) and reads `leased:
 *      false`, `exists: true`.
 *   4. The item's two real readers — conveyor-state.mjs's `shapeLanes` and scope-lease-collect.mjs's
 *      `collectSnapshot` (composed through `liveScopePicture`) — produce IDENTICAL output whether fed the
 *      `--leased-only` payload or the full one, on the same fixture (neither ever reads an unleased row's
 *      git-derived fields — both filter `leased === true` before touching anything else).
 *   5. conveyor-state.mjs's `computeFreeSlots` (and the `freeSlots` it feeds `assembleConveyorState`) returns
 *      the SAME count fed a `--leased-only` payload as fed the full one on this fixture — the `clean !== false`
 *      test already reads a leased-only row's absent `clean` as clean, so no special-casing is needed, but that
 *      claim gets an actual assertion here rather than living only in a code comment (#4345 round-1 red-team
 *      finding: an earlier revision claimed this was "proved" by this file before any test here touched either
 *      function).
 *
 *   On today's `main` (no `--leased-only` flag), the `status --leased-only --json` call below is refused as an
 *   unrecognized flag (exit non-zero, no JSON on stdout) — this test fails at the very first assertion on the
 *   leased-only call's exit code until the flag exists.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { shapeLanes, computeFreeSlots, assembleConveyorState } from '../readiness/conveyor-state.mjs';
import { collectSnapshot } from '../readiness/scope-lease-collect.mjs';
import { liveScopePicture } from '../readiness/scope-lease-live.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const N = 5;
const LEASED_LANE = 2;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args, extraEnv = {}) {
  // LANE_POOL_ROOT MUST be this test's private tmp dir — without it every command falls back to the real
  // default pool root (~/workspace/.lanes), colliding with the LIVE pool this very task runs under.
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;
const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=leasedonly', '--branch=trunk', '--no-install'];
const laneDirOf = (n) => join(poolRoot, 'leasedonly', `lane-${n}`);

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lane-pool-leased-only-fixture-')));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/trunk'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  // realpathSync: on macOS `os.tmpdir()` resolves under `/var/...`, a symlink to the canonical `/private/var/...`
  // — a spawned shell's own `$PWD` (what the git-spawn PATH shim below logs) reports the CANONICAL path, so an
  // un-resolved `base` made every `spawnLines.some(l => l.startsWith(laneDirOf(n) + '|'))` compare a `/var/...`
  // prefix against logged `/private/var/...` lines: always false, which read as "zero spawns" for EVERY lane —
  // vacuously true for the "no spawn in an unleased lane" assertions and silently wrong for the "the leased lane
  // DID spawn ≥4 times" one (#4345 round-2 self-review: caught because that assertion expects a positive count,
  // where the same bug in the negative assertions could not have been noticed by the assertion failing).
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lane-pool-leased-only-')));
  poolRoot = join(base, 'pool');

  const provision = runPool(['provision', `--count=${N}`, ...poolArgs()]);
  expect(provision.code).toBe(0);
  const acquire = runPool(['acquire', ...poolArgs(), `--lane=${LEASED_LANE}`, '--session=holder', '--scope=we:scripts/lane-pool.mjs']);
  expect(acquire.code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('status --leased-only (#4345)', () => {
  it('spawns git only in the leased lane, and returns the same row for it as full status', () => {
    const full = runPool(['status', ...poolArgs(), '--json']);
    expect(full.code).toBe(0);
    const fullPayload = JSON.parse(full.out);
    expect(fullPayload.lanes).toHaveLength(N);
    const fullLeasedRow = fullPayload.lanes.find((l) => l.lane === LEASED_LANE);
    expect(fullLeasedRow.leased).toBe(true);

    // Count every `git` process spawned during the leased-only call, tagged with its cwd, via a PATH shim.
    const shimDir = join(base, 'bin');
    mkdirSync(shimDir, { recursive: true });
    const spawnLog = join(base, 'git-spawns.log');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shimDir, 'git'), `#!/bin/bash\necho "$PWD|$*" >> "${spawnLog}"\nexec "${realGit}" "$@"\n`);
    chmodSync(join(shimDir, 'git'), 0o755);

    const leasedOnly = runPool(['status', ...poolArgs(), '--leased-only', '--json'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(leasedOnly.code).toBe(0);
    const leasedOnlyPayload = JSON.parse(leasedOnly.out);
    expect(leasedOnlyPayload.leasedOnly).toBe(true);
    expect(leasedOnlyPayload.lanes).toHaveLength(N);

    const spawnLines = readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean);
    // Zero git spawns attributable to any UNLEASED lane directory.
    for (let n = 1; n <= N; n++) {
      if (n === LEASED_LANE) continue;
      expect(spawnLines.some((l) => l.startsWith(laneDirOf(n) + '|'))).toBe(false);
    }
    // The leased lane DID get the full git probe (rev-parse ×2, status --porcelain, rev-list).
    expect(spawnLines.filter((l) => l.startsWith(laneDirOf(LEASED_LANE) + '|')).length).toBeGreaterThanOrEqual(4);

    // The leased lane's row is byte-identical between --leased-only and full status — a skip, never a
    // different answer, for the one row a caller actually needs.
    const leasedOnlyLeasedRow = leasedOnlyPayload.lanes.find((l) => l.lane === LEASED_LANE);
    expect(leasedOnlyLeasedRow).toEqual(fullLeasedRow);

    // Every unleased row omits the git-derived fields and reads unleased.
    for (const row of leasedOnlyPayload.lanes) {
      if (row.lane === LEASED_LANE) continue;
      expect(row.leased).toBe(false);
      expect(row.exists).toBe(true);
      expect(row).not.toHaveProperty('head');
      expect(row).not.toHaveProperty('branch');
      expect(row).not.toHaveProperty('clean');
      expect(row).not.toHaveProperty('behind');
    }
  });

  it("conveyor-state's shapeLanes agrees under --leased-only and full status", () => {
    const full = runPool(['status', ...poolArgs(), '--json']);
    expect(full.code).toBe(0);
    const fullPayload = JSON.parse(full.out);

    const leasedOnly = runPool(['status', ...poolArgs(), '--leased-only', '--json']);
    expect(leasedOnly.code).toBe(0);
    const leasedOnlyPayload = JSON.parse(leasedOnly.out);

    const laneItem = { [LEASED_LANE]: '4345' };
    const scopePicture = { leases: [{ lane: LEASED_LANE, session: 'holder', predicted: ['we:scripts/lane-pool.mjs'], breach: [] }] };
    expect(shapeLanes({ poolStatus: leasedOnlyPayload, scopePicture, laneItem }))
      .toEqual(shapeLanes({ poolStatus: fullPayload, scopePicture, laneItem }));
  });

  it("scope-lease-collect's leases (and the composed observer) agree under --leased-only and full status", () => {
    const full = runPool(['status', ...poolArgs(), '--json']);
    expect(full.code).toBe(0);
    const fullPayload = JSON.parse(full.out);

    const leasedOnly = runPool(['status', ...poolArgs(), '--leased-only', '--json']);
    expect(leasedOnly.code).toBe(0);
    const leasedOnlyPayload = JSON.parse(leasedOnly.out);

    const observedForLane = () => [];
    const leasesFromLeasedOnly = collectSnapshot({ poolStatus: leasedOnlyPayload, observedForLane });
    const leasesFromFull = collectSnapshot({ poolStatus: fullPayload, observedForLane });
    expect(leasesFromLeasedOnly).toEqual(leasesFromFull);
    expect(liveScopePicture({ leases: leasesFromLeasedOnly })).toEqual(liveScopePicture({ leases: leasesFromFull }));
  });

  it("conveyor-state's computeFreeSlots (and assembleConveyorState's freeSlots) agree under --leased-only and full status", () => {
    const full = runPool(['status', ...poolArgs(), '--json']);
    expect(full.code).toBe(0);
    const fullPayload = JSON.parse(full.out);

    const leasedOnly = runPool(['status', ...poolArgs(), '--leased-only', '--json']);
    expect(leasedOnly.code).toBe(0);
    const leasedOnlyPayload = JSON.parse(leasedOnly.out);

    // Every unleased row's `clean` is simply ABSENT under --leased-only (never `false`), so `computeFreeSlots`'s
    // `l.clean !== false` test already reads it as clean — no leased-only-specific branch or fn is needed, and
    // the two payloads must yield the identical count. N-1 unleased + 0 dirty-unleased on this fixture, so both
    // read N-1 free.
    const freeSlotsLeasedOnly = computeFreeSlots(leasedOnlyPayload);
    const freeSlotsFull = computeFreeSlots(fullPayload);
    expect(freeSlotsLeasedOnly).toBe(freeSlotsFull);
    expect(freeSlotsLeasedOnly).toBe(N - 1);

    // And end-to-end through the composer the live IO shell actually calls.
    const assembled = assembleConveyorState({ poolStatus: leasedOnlyPayload, scopePicture: { leases: [] }, laneItem: {}, now: Date.now() });
    expect(assembled.freeSlots).toBe(N - 1);
  });

  it('computeFreeSlots DIVERGES on a dirty-but-unleased lane — full status excludes it, --leased-only counts it as free (the disclosed leniency tradeoff, #4345 round-1 red-team finding)', () => {
    // #4345 round-1 red-team: the previous test above only proves agreement on a fixture where every unleased
    // lane is CLEAN — the one input where `--leased-only`'s absent `clean` and full status's real `clean: false`
    // can never disagree. The actual tradeoff this card accepts (a dirty-but-unleased lane silently reads as
    // FREE under `--leased-only`, because `computeFreeSlots`'s `clean !== false` reads a missing `clean` as
    // clean) needs its own fixture: a lane that is dirty AND unleased.
    const DIRTY_UNLEASED_LANE = 4;
    expect(DIRTY_UNLEASED_LANE).not.toBe(LEASED_LANE);
    writeFileSync(join(laneDirOf(DIRTY_UNLEASED_LANE), 'scratch.txt'), 'dirty\n');

    const full = runPool(['status', ...poolArgs(), '--json']);
    expect(full.code).toBe(0);
    const fullPayload = JSON.parse(full.out);
    const fullDirtyRow = fullPayload.lanes.find((l) => l.lane === DIRTY_UNLEASED_LANE);
    expect(fullDirtyRow.leased).toBe(false);
    expect(fullDirtyRow.clean).toBe(false); // the real git probe sees the untracked file

    const leasedOnly = runPool(['status', ...poolArgs(), '--leased-only', '--json']);
    expect(leasedOnly.code).toBe(0);
    const leasedOnlyPayload = JSON.parse(leasedOnly.out);
    const leasedOnlyDirtyRow = leasedOnlyPayload.lanes.find((l) => l.lane === DIRTY_UNLEASED_LANE);
    expect(leasedOnlyDirtyRow.leased).toBe(false);
    expect(leasedOnlyDirtyRow).not.toHaveProperty('clean'); // no git ran there — the field is simply absent

    // The divergence: full status correctly EXCLUDES the dirty lane (N-1 leased-out minus this one dirty one),
    // --leased-only's lenient `clean !== false` test counts it as free anyway — the documented "optimistic
    // upper bound" this card's PR body and code comments accept, now actually exercised rather than assumed.
    expect(computeFreeSlots(fullPayload)).toBe(N - 2);
    expect(computeFreeSlots(leasedOnlyPayload)).toBe(N - 1);
  });
});
