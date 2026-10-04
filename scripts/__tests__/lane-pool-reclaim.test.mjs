/**
 * @file scripts/__tests__/lane-pool-reclaim.test.mjs
 * @description Proof of #3383 gap 2 (auto-reclaim) — the `reclaim` command in `scripts/lane-pool.mjs`, the
 *   MUTATION half of `lane-whois.mjs`'s read-only `finished-reclaimable` verdict. `reclaim --lane=N` resets ONE
 *   unleased lane to `origin/<branch>`, but only after its OWN re-check (never a caller's, possibly stale,
 *   verdict) proves every uncommitted/ahead change is still provably preserved right now. Real throwaway
 *   origin + reference checkout, private `LANE_POOL_ROOT` — same fixture shape as `lane-whois.test.mjs` and
 *   `lane-pool-trim.test.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const POOL_SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, binDir, env;

function runPool(args) {
  const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env, timeout: 30_000, killSignal: 'SIGKILL' });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

/** Like {@link runPool}, but with `envOverride` merged over this file's shared `env` — used by the quiet-period
 *  tests below, which need `WE_LANE_SALVAGE_QUIET_MIN` UNSET (the real 30-minute default), never the `'0'`
 *  every other test in this file relies on to skip the wait. */
function runPoolWithEnv(args, envOverride) {
  const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env: envOverride, timeout: 30_000, killSignal: 'SIGKILL' });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=reclaimpool', '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, 'reclaimpool', `lane-${n}`);
const leaseMarker = (n) => join(lanePath(n), '.git', '.lane-lease');

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-reclaim-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-reclaim-'));
  poolRoot = join(base, 'pool');
  binDir = join(base, 'bin');
  mkdirSync(binDir);
  // #xl5xhmj — `reclaim` now ALSO runs the liveness gate (`claude agents --json` + `lsof`) on its direct-reset
  // path, not just the salvage one. Fake both on PATH so every test here stays hermetic and fast (never a real
  // scan of THIS machine's own live sessions/processes) — same shape `lane-whois.test.mjs` already uses for
  // `claude`. No live agent, no live pid, by default; individual tests below overwrite `claude` to fake one.
  writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "[]"\n');
  chmodSync(join(binDir, 'claude'), 0o755);
  writeFileSync(join(binDir, 'lsof'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binDir, 'lsof'), 0o755);
  env = {
    ...process.env, LANE_POOL_ROOT: poolRoot, HOME: base, PATH: `${binDir}:${process.env.PATH}`,
    // The quiet-period half of the SAME gate defaults to 30 minutes (`lib/lane-salvage.mjs`'s own
    // `DEFAULT_SALVAGE_QUIET_MIN`) — irrelevant to most tests below (none is about recency), so it is zeroed
    // here so a lane written moments ago by this very test reads as quiet immediately. This zeroed env is
    // inherited by every test in this file, INCLUDING the "quiet period elapsed" test just below (`the SAME
    // lane, once its owner is gone...`) — that test is about liveness, not recency, and is not itself
    // end-to-end coverage of the real 30-minute default. That dedicated coverage lives in the `lane-pool
    // reclaim — quiet period at the REAL 30-minute default` describe block further down, which deliberately
    // uses `runPoolWithEnv` with this var UNSET.
    WE_LANE_SALVAGE_QUIET_MIN: '0',
  };

  expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool reclaim — BEFORE (the gap)', () => {
  it('a plain `release` frees the LEASE but never resets ahead/dirty content back to origin', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(1), 'orphan.txt'), 'never pushed\n');
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    // (documented, not the fix under test — `lane-pool.mjs` had no `reclaim` verb at all before this item; a
    // finished-but-dirty lane just sat there unusable until a human ran `git reset --hard` by hand.)
    expect(existsSync(join(lanePath(1), 'orphan.txt'))).toBe(true);
  });
});

describe('lane-pool reclaim — AFTER', () => {
  it('refuses a LIVE-leased lane outright, regardless of content', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/held/i);
    expect(existsSync(leaseMarker(1))).toBe(true); // untouched — never cleared a live hold
  });

  it('a clean, unleased lane (nothing to lose) is reclaimed — a no-op reset, lease marker cleared', () => {
    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(true);
    expect(report.preserved).toBe(true);
    expect(existsSync(leaseMarker(1))).toBe(false);
  });

  it('dry-run NEVER writes a claim or resets — reports wouldReclaim with the same preservation proof', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const before = readFileSync(join(lanePath(1), 'file.txt'), 'utf8');
    const r = runPool(['reclaim', '--lane=1', '--dry-run', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.wouldReclaim).toBe(true);
    expect(report.reclaimed).toBe(false);
    expect(existsSync(leaseMarker(1))).toBe(false); // dry-run never even claims
    expect(readFileSync(join(lanePath(1), 'file.txt'), 'utf8')).toBe(before); // untouched
  });

  it('uncommitted content NOT provably preserved anywhere refuses the reclaim — never destroyed', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(1), 'orphan.txt'), 'never pushed anywhere\n');
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);

    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0); // a refusal is a normal, successful report — never a crash
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(false);
    expect(report.preserved).toBe(false);
    expect(report.unpreservedFiles).toEqual(['orphan.txt']);
    expect(existsSync(join(lanePath(1), 'orphan.txt'))).toBe(true); // never destroyed
  });

  it('an ahead commit pushed to its own lane/* ref is provably preserved — reclaimed, reset to origin', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9000-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);

    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(true);
    expect(report.preserved).toBe(true);
    expect(existsSync(join(dir, 'work.txt'))).toBe(false); // reset away — its content lives on lane/9000-test
    expect(existsSync(leaseMarker(1))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(git(['rev-parse', 'origin/main'], dir));
  });

  // PR #2641 review finding — the DEFINING dead-session shape: the holder acquired, pushed its work, then died
  // WITHOUT ever calling `release`, so its lease marker is still on disk, merely TTL-expired. Every test above
  // `release`s first (which deletes the marker), which is why the bare O_EXCL claim never tripped on this.
  it('a lease present but TTL-expired, never released (a dead session) is reclaimed — the stale marker is taken aside', () => {
    expect(runPool(['acquire', '--lane=1', '--session=dead', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9001-test'], dir);
    // Backdate the (never-released) lease well past its TTL — the session died holding it.
    const lease = JSON.parse(readFileSync(leaseMarker(1), 'utf8'));
    lease.acquiredAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    writeFileSync(leaseMarker(1), `${JSON.stringify(lease, null, 2)}\n`);

    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(true);
    expect(existsSync(join(dir, 'work.txt'))).toBe(false);
    expect(existsSync(leaseMarker(1))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(git(['rev-parse', 'origin/main'], dir));
  });

  it('a stale lease whose lane still holds UNPRESERVED work is refused and the dead lease is left exactly as found', () => {
    expect(runPool(['acquire', '--lane=1', '--session=dead', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(1), 'orphan.txt'), 'never pushed anywhere\n');
    const lease = JSON.parse(readFileSync(leaseMarker(1), 'utf8'));
    lease.acquiredAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const staleBody = `${JSON.stringify(lease, null, 2)}\n`;
    writeFileSync(leaseMarker(1), staleBody);

    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).reclaimed).toBe(false);
    expect(existsSync(join(lanePath(1), 'orphan.txt'))).toBe(true);
    expect(readFileSync(leaseMarker(1), 'utf8')).toBe(staleBody); // never even claimed — untouched
  });

  it('reclaim never scans a whole pool — it always needs an explicit --lane', () => {
    const r = runPool(['reclaim', '--json', ...poolArgs()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--lane/);
  });
});

// #xl5xhmj — `cmdReclaim` only ran its liveness gate (live owner session / live process cwd / quiet period)
// inside `cmdReclaimSalvage`, and only when content was NOT preserved. A lane whose work was ALREADY PUSHED
// (preserved) skipped straight to `git reset --hard` with only the live-LEASE check — so a lane that had just
// lost its lease (see #xbk2is9) was reset the moment its work was pushed, mid-verify or mid-PR. This is the
// Done-when #1 executable proof: same gate now runs on the direct-reset path too.
describe('lane-pool reclaim — liveness gate (#xl5xhmj)', () => {
  it.each(['dead', 'reused-pid', 'old-working'])('reclaims preserved work after release with a %s historical holder', (kind) => {
    const session = kind === 'reused-pid' ? 'Mac:31893' : 'released-session';
    expect(runPool(['acquire', '--lane=1', `--session=${session}`, ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'preserved work\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/preserved'], dir);
    expect(runPool(['release', '--lane=1', `--session=${session}`, ...poolArgs()]).code).toBe(0);
    const agents = kind === 'dead' ? [] : [{ sessionId: session, pid: 31893, processStartTime: '2026-10-03T05:00:00Z', state: 'working', cwd: lanePath(2), lastActivityAt: 1 }];
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho '${JSON.stringify(agents)}'\n`);
    writeFileSync(join(binDir, 'lsof'), `#!/bin/sh\nprintf 'p31893\\nn${lanePath(2)}\\n'\n`);
    const dry = runPool(['reclaim', '--lane=1', '--dry-run', '--json', ...poolArgs()]);
    expect(dry.code, dry.err).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ preserved: true, wouldReclaim: true });
    const real = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(real.code, real.err).toBe(0);
    expect(JSON.parse(real.out)).toMatchObject({ preserved: true, reclaimed: true });
    expect(existsSync(join(dir, 'work.txt'))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(git(['rev-parse', 'origin/main'], dir));
  });

  it('an unleased lane with a pushed-only commit and a LIVE owner session is KEPT, never reset', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9010-test'], dir);
    // The lease is dropped (released) — exactly the #xbk2is9 shape — but the worker's OWN process is still
    // live, sitting in the lane's own directory (`claude agents --json` still lists it).
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho '[{"sessionId":"s","state":"working","cwd":"${dir}"}]'\n`);
    chmodSync(join(binDir, 'claude'), 0o755);

    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0); // a KEPT verdict is a normal, successful report — never a crash
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(false);
    expect(report.kept).toBe(true);
    expect(report.keptReason).toMatch(/live/i);
    expect(report.preserved).toBe(true); // the content WAS provably preserved — that alone is not enough
    expect(existsSync(join(dir, 'work.txt'))).toBe(true); // never reset out from under the live worker
    expect(git(['rev-parse', 'HEAD'], dir)).not.toBe(git(['rev-parse', 'origin/main'], dir));
    expect(existsSync(leaseMarker(1))).toBe(false); // KEPT never re-claims the lease marker either
  });

  it('the SAME lane, once its owner is gone and the quiet period has elapsed, is reset normally', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9011-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    // No live agent (the default fake `claude` reports none) and the quiet period is already satisfied
    // (WE_LANE_SALVAGE_QUIET_MIN=0 in this file's shared env, NOT the real 30-minute default — see that
    // describe block further down for the default-quiet-period coverage) — the gate is eligible, so this
    // proceeds exactly as the pre-existing "provably preserved" reclaim tests above.
    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(true);
    expect(report.kept).toBeUndefined();
    expect(existsSync(join(dir, 'work.txt'))).toBe(false);
    expect(existsSync(leaseMarker(1))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(git(['rev-parse', 'origin/main'], dir));
  });

  it('a live PROCESS cwd inside the lane (no matching agent) also keeps it — the lsof half of the gate', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9012-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    // `claude agents` reports nothing, but a live PID's cwd is still inside the lane (a shell parked there).
    writeFileSync(join(binDir, 'lsof'), `#!/bin/sh\nprintf 'p999999\\nfcwd\\nn${dir}\\n'\n`);
    chmodSync(join(binDir, 'lsof'), 0o755);

    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(false);
    expect(report.kept).toBe(true);
    expect(report.keptReason).toMatch(/pid/i);
    expect(existsSync(join(dir, 'work.txt'))).toBe(true);
  });

  it('`--override` skips the liveness gate too — the operator has already looked at this lane by eye', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9013-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho '[{"sessionId":"s","state":"working","cwd":"${dir}"}]'\n`);
    chmodSync(join(binDir, 'claude'), 0o755);

    const r = runPool(['reclaim', '--lane=1', '--override', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(true);
    expect(existsSync(join(dir, 'work.txt'))).toBe(false);
  });
});

// #xl5xhmj — `cmdReclaim` re-checks liveness a SECOND time ("under the hold", right before `git reset --hard`)
// to close the tiny race window between its FIRST gate read and the moment it claims the lease marker: a
// session could start or resume in that window. Every test above (and every existing reclaim test before this
// one) uses a STATIC fake `claude`/`lsof` — live from the start, or never live at all — so the first gate read
// and the second always see identical data and neither one, alone, proves the SECOND read is actually load-
// bearing. Deleting the `relive` block in `cmdReclaim` (or making it a no-op) would leave every one of those
// tests green. This describe block uses a STATEFUL fake `claude` whose answer changes between invocations
// (via a counter file) specifically to make the two reads disagree, so a broken/removed re-check reddens here.
describe('lane-pool reclaim — the under-the-hold re-check race (relive, #xl5xhmj)', () => {
  it('a live session appearing between the first gate read and the claim is caught by the re-check — KEPT, marker released, content untouched', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9020-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    // `claude` reports NO live agent on its first invocation (`cmdReclaim`'s first gate read, before the
    // claim) and a LIVE one on every invocation from the second onward (the re-check under the hold, after the
    // marker claim) — simulating a worker session that starts/resumes exactly in the race window the `relive`
    // block's own comment says it exists to close.
    const counterFile = join(binDir, 'claude-calls');
    writeFileSync(counterFile, '0');
    writeFileSync(
      join(binDir, 'claude'),
      `#!/bin/sh\nn=$(cat "${counterFile}")\nn=$((n+1))\necho "$n" > "${counterFile}"\nif [ "$n" -ge 2 ]; then echo '[{"sessionId":"s","state":"working","cwd":"${dir}"}]'; else echo '[]'; fi\n`,
    );
    chmodSync(join(binDir, 'claude'), 0o755);

    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0); // a KEPT verdict is a normal, successful report — never a crash
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(false);
    expect(report.kept).toBe(true);
    expect(report.keptReason).toMatch(/live/i);
    expect(existsSync(join(dir, 'work.txt'))).toBe(true); // never reset out from under the re-appeared live worker
    expect(git(['rev-parse', 'HEAD'], dir)).not.toBe(git(['rev-parse', 'origin/main'], dir));
    expect(existsSync(leaseMarker(1))).toBe(false); // the claimed marker is handed back, never left stuck
    // Proves the SECOND gate read is the one that actually tripped, not merely that `claude` was called twice:
    // the FIRST gate read alone catching a live agent would ALSO leave every assertion above true, so only the
    // log-line suffix `cmdReclaim` adds EXCLUSIVELY on the re-check path (never on the initial gate) is unique
    // to `relive` actually firing.
    expect(r.err).toMatch(/re-checked under the hold/);
    // The counter file backs that up structurally: the fake reported LIVE only from call #2 onward, so KEPT
    // could only have come from a call at n>=2 — i.e. the re-check, never the first read (which always saw n=1,
    // "[]"). Belt-and-suspenders alongside the log-line assertion above, not a substitute for it.
    expect(Number(readFileSync(counterFile, 'utf8').trim())).toBeGreaterThanOrEqual(2);
  });
});

// #4139 — the operator override: an explicit, logged escape hatch past the preservation gate for a
// `finished-needs-review` lane a human has looked at, wired from operator-queue.mjs's LANE RECLAIM section.
describe('lane-pool reclaim --override (#4139)', () => {
  it('WITHOUT --override, unpreserved content still refuses exactly as before (no behavior change for the default path)', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(1), 'orphan.txt'), 'never pushed anywhere\n');
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(JSON.parse(r.out).reclaimed).toBe(false);
    expect(existsSync(join(lanePath(1), 'orphan.txt'))).toBe(true);
  });

  it('WITH --override, the SAME unpreserved content is force-reclaimed — logged as an override, not silent', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(1), 'orphan.txt'), 'never pushed anywhere\n');
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);

    const r = runPool(['reclaim', '--lane=1', '--override', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(true);
    expect(report.override).toBe(true);
    expect(report.preserved).toBe(false); // the proof genuinely failed — override is what pushed it through
    expect(r.err).toMatch(/OVERRIDE/);
    expect(existsSync(join(lanePath(1), 'orphan.txt'))).toBe(false); // discarded — by explicit operator call
  });

  it('--override --dry-run still NEVER writes or resets — dry-run always wins over override', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(1), 'orphan.txt'), 'never pushed anywhere\n');
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);

    const r = runPool(['reclaim', '--lane=1', '--override', '--dry-run', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.wouldReclaim).toBe(true);
    expect(report.reclaimed).toBe(false);
    expect(report.override).toBe(true);
    expect(existsSync(join(lanePath(1), 'orphan.txt'))).toBe(true); // untouched
  });

  it('--override NEVER bypasses the live-lease guard — reuses that existing reclaim guard unchanged', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const r = runPool(['reclaim', '--lane=1', '--override', '--json', ...poolArgs()]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/held/i);
    expect(existsSync(leaseMarker(1))).toBe(true); // untouched — override never reaches a live lease
  });
});

// #xl5xhmj — every OTHER test in this file sets `WE_LANE_SALVAGE_QUIET_MIN=0` (see `beforeEach` above) so the
// quiet-period half of `laneLivenessGate` never blocks on the real 30-minute default — that default itself was
// otherwise NEVER exercised end to end through `cmdReclaim` (only via `lane-salvage.mjs`'s own pure-core math
// tests). This describe block runs `reclaim` with that env var deliberately UNSET, so `resolveSalvageQuietMs()`
// falls back to `DEFAULT_SALVAGE_QUIET_MIN` (30 minutes) exactly as the real, un-instrumented CLI does — the
// same path a live pool's periodic health-watch tick and an operator's own `reclaim --lane=N` both run.
describe('lane-pool reclaim — quiet period at the REAL 30-minute default (no env override)', () => {
  it('a lane pushed moments ago is KEPT — the real 30-minute default has not elapsed yet', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9030-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);

    const quietEnv = { ...env };
    delete quietEnv.WE_LANE_SALVAGE_QUIET_MIN;
    const r = runPoolWithEnv(['reclaim', '--lane=1', '--json', ...poolArgs()], quietEnv);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(false);
    expect(report.kept).toBe(true);
    expect(report.keptReason).toMatch(/quiet period/);
    expect(existsSync(join(dir, 'work.txt'))).toBe(true); // never reset while still inside the real quiet window
  });

  // NOTE ON METHOD: back-dates ONLY `.git/logs/HEAD`. `newestContentMtimeMs` deliberately never stats
  // `.git/index` at all (see that function's own docblock in `we:scripts/lib/lane-salvage.mjs`) — a plain,
  // read-only `git status` (the exact call `newestContentMtimeMs`'s own `dirtyPaths` makes, and ALSO the call
  // `laneReclaimPreservationProof`'s `gitStatusSummary` already made earlier in this same `cmdReclaim` run) can
  // itself REWRITE `.git/index` on disk — git's own "racy index" cache refresh — bumping its mtime to "now"
  // with no real content change. That race lives in git's own status call, not in any one function's read
  // order, so no reordering trick inside `newestContentMtimeMs` alone could have closed it; live-caught (~2 of
  // 3 runs) as this very test intermittently reading "0 min ago" purely from real elapsed time before the fix.
  it('the SAME lane, once genuinely quiet past the real 30-minute default, is reset normally', () => {
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9031-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    // Nothing is uncommitted, so `newestContentMtimeMs` reads only `.git/logs/HEAD` (see that function's own
    // docblock) — back-date it past the real 30-minute default to simulate a lane genuinely quiet that long,
    // without actually waiting 30 real minutes in this test.
    const old = new Date(Date.now() - 40 * 60_000);
    utimesSync(join(dir, '.git', 'logs', 'HEAD'), old, old);

    const quietEnv = { ...env };
    delete quietEnv.WE_LANE_SALVAGE_QUIET_MIN;
    const r = runPoolWithEnv(['reclaim', '--lane=1', '--json', ...poolArgs()], quietEnv);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.reclaimed).toBe(true);
    expect(existsSync(join(dir, 'work.txt'))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(git(['rev-parse', 'origin/main'], dir));
  });
});
