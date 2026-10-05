/**
 * @file scripts/__tests__/verify-lane.test.mjs
 * @description Behavioral proof of the #2833 verification WRITER (`scripts/verify-lane.mjs`) — the IO half the
 *   pure core (`lane-verify.mjs`) cannot cover. It reproduces the overlapping-runs RACE that finding 1 caught:
 *   two `verify-lane` runs share one clone's marker, and the finish write must never stamp a result for a sha it
 *   did not verify. A slow GREEN run at X must NOT stamp green over a RED record for Y — the exact false-green
 *   this guard exists to kill, reintroduced in the guard's own writer.
 *
 *   Substrate: an ephemeral throwaway `git init` repo under `mkdtemp` (never the shared lane pool; decision
 *   #2274). The "overlapping run" is simulated by a GATE command that overwrites the marker with a red record
 *   for a DIFFERENT sha mid-run — i.e. between this run's start-write and its finish-write, exactly when a real
 *   sibling run B would claim the marker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireRunnerLease, makeOwner, heartbeatRunnerLease, RUNNER_LEASE_MINUTES } from '../../skills-src/conveyor/runner-lock.mjs';
import { VERIFY_DAEMON_LEASE_KEY } from '../../skills-src/conveyor/verify-daemon.mjs';
import { LEASE_FILENAME } from '../lib/lane-lease.mjs';

const VERIFY_LANE = resolve(process.cwd(), 'scripts/verify-lane.mjs');
const OTHER_SHA = 'b'.repeat(40); // "Y" — the sha the overlapping run's marker belongs to (never this HEAD)

function seedVerifyServer(root, options = {}) {
  const result = acquireRunnerLease(root, makeOwner('verify-test'), { key: VERIFY_DAEMON_LEASE_KEY, ...options });
  expect(result.ok).toBe(true);
}

let dir;
let lockRoot;
let previousLockRoot;
beforeEach(() => {
  previousLockRoot = process.env.CONVEYOR_RUNNER_LOCK_ROOT;
  lockRoot = mkdtempSync(join(tmpdir(), 'verify-server-'));
  seedVerifyServer(lockRoot);
  process.env.CONVEYOR_RUNNER_LOCK_ROOT = lockRoot;
  dir = mkdtempSync(join(tmpdir(), 'verify-lane-race-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'x'], { cwd: dir });
});
afterEach(() => {
  if (previousLockRoot === undefined) delete process.env.CONVEYOR_RUNNER_LOCK_ROOT;
  else process.env.CONVEYOR_RUNNER_LOCK_ROOT = previousLockRoot;
  rmSync(lockRoot, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const marker = () => join(dir, '.git', '.lane-verify');
const headSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

/** Run verify-lane in the temp repo with a custom gate; return { code, json }. Never throws on non-zero exit. */
function runVerify(gate) {
  try {
    const out = execFileSync('node', [VERIFY_LANE, `--gate=${gate}`, '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, json: JSON.parse(out.trim().split('\n').pop()) };
  } catch (e) {
    return { code: e.status ?? null, json: (() => { try { return JSON.parse(String(e.stdout).trim().split('\n').pop()); } catch { return null; } })() };
  }
}

describe('verify-lane writer — overlapping-runs race (#2833 finding 1)', () => {
  it('a slow GREEN run at X refuses to stamp green over a RED record for Y (no false-green)', () => {
    // Gate = a mid-run "overlapping run B" that claims the marker with red-Y, then exits 0 (this run's suites pass).
    const redY = JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: '2026-08-02T00:00:00.000Z', finishedAt: '2026-08-02T00:01:00.000Z', suites: 'gate', exitCode: 2 });
    const gateScript = join(dir, 'gate.mjs');
    writeFileSync(gateScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker())}, ${JSON.stringify(redY + '\n')});\nprocess.exit(0);\n`);

    const { code, json } = runVerify(`node ${gateScript}`);

    // The finish write is REFUSED (compare-and-set failed: on-disk sha Y ≠ this run's sha X).
    expect(code).toBe(3);
    expect(json?.status).toBe('superseded');

    // The marker on disk is STILL the red record for Y — never overwritten with a green.
    const onDisk = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(onDisk.sha).toBe(OTHER_SHA);
    expect(onDisk.status).toBe('red');
  });

  it('with no overlap, a green run writes a green marker keyed to THIS head (the writer still works)', () => {
    const { code, json } = runVerify('true');
    expect(code).toBe(0);
    expect(json.status).toBe('green');
    expect(existsSync(marker())).toBe(true);
    const onDisk = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(onDisk.sha).toBe(headSha()); // stamped the sha it actually verified
    expect(onDisk.status).toBe('green');
  });

  it('the START write never destroys a terminal GREEN for a FOREIGN sha: it archives it and runs (#2833 finding 4, #3751)', () => {
    // Before this run begins, the marker holds a terminal GREEN for a DIFFERENT sha Y. Finding 4 forbids destroying
    // that result; #3751 keeps it in `.lane-verify.previous` instead of refusing, so this head's verify still runs.
    const greenY = JSON.stringify({ sha: OTHER_SHA, status: 'green', startedAt: '2026-08-02T00:00:00.000Z', finishedAt: '2026-08-02T00:01:00.000Z', suites: 'gate', exitCode: 0 });
    writeFileSync(marker(), greenY + '\n');

    const { code, json } = runVerify('true');

    expect(code).toBe(0);
    expect(json?.status).toBe('green');
    expect(JSON.parse(readFileSync(marker(), 'utf8')).sha).toBe(headSha());
    const kept = JSON.parse(readFileSync(join(dir, '.git', '.lane-verify.previous'), 'utf8'));
    expect(kept.sha).toBe(OTHER_SHA);
    expect(kept.status).toBe('green');
  });
});

describe('verify-lane — a terminal record for an EARLIER commit of this lane is archived, not a blocker (#3751, #3383)', () => {
  it('a second verify after a new commit starts, runs, and keeps the old record in .lane-verify.previous', () => {
    const first = runVerify('true');
    expect(first.json.status).toBe('green');
    const firstSha = headSha();
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'next'], { cwd: dir });
    const second = runVerify('true');
    expect(second.code).toBe(0);
    expect(second.json.status).toBe('green');
    expect(JSON.parse(readFileSync(marker(), 'utf8')).sha).toBe(headSha());
    const prev = JSON.parse(readFileSync(join(dir, '.git', '.lane-verify.previous'), 'utf8'));
    expect(prev).toMatchObject({ sha: firstSha, status: 'green' });
  });
});

/**
 * #4296 — THE LIVE BUG, REPRODUCED END TO END: a mid-work merge of `origin/main` that conflicts only on a file
 * OUTSIDE the lane's own touch-set used to invalidate a green marker and force a full re-run, purely because the
 * merge commit's sha differs from the sha the marker was recorded for. The fix keys the marker's validity to what
 * LANE-RELEVANT files changed since it was recorded, not the exact commit — reusing the same changed-file
 * computation `resolveDefaultGate` derives for gate selection. Real `git`, real merge, the real `check` CLI —
 * no fakes — because the whole point is that this survives an ACTUAL merge commit, not a synthetic marker edit.
 */
describe('verify-lane check — #4296 a no-op merge of origin/main (touching only an out-of-lane file) keeps a green marker valid', () => {
  function runBareCheck() {
    const r = spawnSync('node', [VERIFY_LANE, 'check', '--json'], { cwd: dir, encoding: 'utf8' });
    return { code: r.status, json: (() => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return null; } })() };
  }
  const commit = (msg) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], { cwd: dir });
  const writeAndAdd = (relPath, contents) => {
    mkdirSync(join(dir, relPath.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(dir, relPath), contents);
    execFileSync('git', ['add', relPath], { cwd: dir });
  };
  // Never hardcode 'main' — beforeEach's `git init` uses whatever this host's git resolves as its default
  // branch name, and this suite must not depend on that.
  const laneBranch = () => execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  it('a merge that touches only a file the lane never edited keeps the green marker for the PRE-merge sha valid', () => {
    const main = laneBranch();
    // Base tree: the two files this scenario needs, committed before either side diverges.
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'base\n');
    commit('base');
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir }); // stand-in for the remote-tracking ref

    // The LANE's own edit: touches only scripts/verify-lane.mjs.
    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    const laneSha = headSha();

    // Record a GREEN marker for the lane's edit, via the REAL CLI.
    const verified = runVerify('true');
    expect(verified.json.status).toBe('green');
    expect(verified.json.sha).toBe(laneSha);

    // Meanwhile, `origin/main` moved on — a change to a file the lane itself never touches.
    execFileSync('git', ['checkout', '-q', 'origin/main'], { cwd: dir });
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'upstream edit\n');
    commit('upstream edit');
    execFileSync('git', ['checkout', '-q', main], { cwd: dir });

    // The mid-work merge (a real merge commit — auto-clean, the two sides touch different files).
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', '-q', 'origin/main'], { cwd: dir });
    const mergeSha = headSha();
    expect(mergeSha).not.toBe(laneSha); // the marker is now for an EARLIER commit than HEAD

    // THE FIX: `check` (no re-run) still reports green for the NEW head — the merge touched nothing lane-relevant.
    const { code, json } = runBareCheck();
    expect(code).toBe(0);
    expect(json).toMatchObject({ sha: mergeSha, status: 'green', ok: true, reason: 'verified' });
    expect(json.detail).toMatch(/carried forward/);
    expect(json.detail).toMatch(new RegExp(laneSha.slice(0, 8)));

    // The marker on disk is UNCHANGED (still recorded for the pre-merge sha) — this is a read-time carry-forward,
    // never a rewrite, and no suite ran a second time.
    expect(JSON.parse(readFileSync(marker(), 'utf8')).sha).toBe(laneSha);
  });

  it('COUNTER-CASE: a merge that DOES touch a file the lane relies on still forces a re-verify', () => {
    const main = laneBranch();
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    commit('base');
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });

    writeAndAdd('scripts/verify-lane.mjs', 'lane edit\n');
    commit('lane edit');
    const laneSha = headSha();
    expect(runVerify('true').json.status).toBe('green');

    // This time `origin/main` changes the SAME file the lane's own diff already covers.
    execFileSync('git', ['checkout', '-q', 'origin/main'], { cwd: dir });
    writeAndAdd('scripts/verify-lane.mjs', 'base\nupstream addition\n');
    commit('upstream addition to the lane\'s own file');
    execFileSync('git', ['checkout', '-q', main], { cwd: dir });

    // A real conflict (both sides touched the same line region is not required — just the same file) — resolve
    // by taking the lane's own content plus the upstream addition, i.e. a genuine 3-way merge outcome.
    const merge = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-edit', '-q', 'origin/main'], { cwd: dir, encoding: 'utf8' });
    if (merge.status !== 0) {
      // Conflict — resolve trivially and complete the merge (still a merge commit whose diff vs the marker's
      // sha touches scripts/verify-lane.mjs, which is exactly what this counter-case needs to prove).
      writeFileSync(join(dir, 'scripts/verify-lane.mjs'), 'lane edit\nupstream addition\n');
      execFileSync('git', ['add', 'scripts/verify-lane.mjs'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--no-edit', '-q'], { cwd: dir });
    }
    const mergeSha = headSha();
    expect(mergeSha).not.toBe(laneSha);

    const { code, json } = runBareCheck();
    expect(code).toBe(2); // NOT ok — this is not a blanket bypass
    expect(json).toMatchObject({ sha: mergeSha, status: 'absent', reason: 'unverified', ok: false });
  });

  it('#4296 round-1 RED-TEAM FIX, reproduced with real git: a lane REVERT of its own already-verified edit still forces a re-verify', () => {
    // The blocker the red-team found in the FIRST cut of this fix: filtering `changedSinceRecord` against only
    // `diff(base, headSha)` (the CURRENT lane touch-set) missed the case where the lane's OWN later commit
    // reverts one of its own already-verified edits back to `base`'s content while another lane edit remains —
    // the reverted file drops out of `diff(base, headSha)` (it is identical to base again) even though it
    // genuinely changed between the marker's recorded sha and headSha, and that revert itself was never run
    // through the suite. The fix folds in `diff(base, recordSha)` too, so a file relevant at EITHER end stays
    // relevant.
    const main = laneBranch();
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'base\n');
    commit('base');
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });

    // The lane edits TWO files.
    writeAndAdd('scripts/verify-lane.mjs', 'lane edit A\n');
    writeAndAdd('scripts/operations/ci-heal-pr-dispatch.mjs', 'lane edit B\n');
    commit('lane edit A+B');
    const laneSha = headSha();
    expect(runVerify('true').json.status).toBe('green');

    // A LATER lane commit reverts A back to base's content, keeping B's edit. No merge involved at all — this
    // is the lane's own work, and origin/main never moves in this scenario.
    writeAndAdd('scripts/verify-lane.mjs', 'base\n');
    commit('revert A back to base');
    const revertSha = headSha();
    expect(revertSha).not.toBe(laneSha);
    void main;

    const { code, json } = runBareCheck();
    expect(code).toBe(2); // the revert of A must still force a re-verify — it was never itself tested
    expect(json).toMatchObject({ sha: revertSha, status: 'absent', reason: 'unverified', ok: false });
  });
});

describe('verify-lane request (#3105) — stamp the marker, run nothing, return immediately', () => {
  function runRequest(gate) {
    try {
      const out = execFileSync('node', [VERIFY_LANE, 'request', `--gate=${gate}`, '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, json: JSON.parse(out.trim().split('\n').pop()) };
    } catch (e) {
      return { code: e.status ?? null, json: (() => { try { return JSON.parse(String(e.stdout).trim().split('\n').pop()); } catch { return null; } })() };
    }
  }

  it('stamps a running marker for HEAD and exits 0 without running the gate', () => {
    // A gate that would fail loudly if ever executed — proves `request` never runs it.
    const { code, json } = runRequest('exit 7');
    expect(code).toBe(0);
    expect(json.status).toBe('requested');
    expect(json.sha).toBe(headSha());

    const onDisk = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(onDisk.status).toBe('running');
    expect(onDisk.sha).toBe(headSha());
    expect(onDisk.finishedAt).toBeNull();
  });

  it('`check` reads a requested marker exactly like an ordinary in-flight running one — no new vocabulary', () => {
    runRequest('true');
    let out;
    try {
      out = execFileSync('node', [VERIFY_LANE, 'check', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String(e.stdout);
    }
    const { status, ok, reason } = JSON.parse(out.trim());
    expect(status).toBe('running');
    expect(ok).toBe(false);
    expect(reason).toBe('verify-unfinished');
  });

  it('a plain `verify` run picks up the requested marker and carries it to a terminal green result', () => {
    runRequest('true');
    const after = runVerify('true');
    expect(after.code).toBe(0);
    expect(after.json.status).toBe('green');
  });

  it('archives a foreign TERMINAL marker rather than clobbering it — the same start-write rule `verify` applies', () => {
    writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'green', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 0 }) + '\n');
    const { code, json } = runRequest('true');
    expect(code).toBe(0);
    expect(json.status).toBe('requested');
    // The foreign terminal record survives, in the archive.
    const kept = JSON.parse(readFileSync(join(dir, '.git', '.lane-verify.previous'), 'utf8'));
    expect(kept.sha).toBe(OTHER_SHA);
    expect(kept.status).toBe('green');
  });
});

describe('verify-lane check --wait= (#4358) — a bounded internal wait, one CLI call per settle', () => {
  /** Run `check --wait=…` (plus any extra args) in the temp repo; returns {code, json, stderr}. Uses `spawnSync`
   *  (not `execFileSync`) specifically so stderr is captured on the SUCCESS path too (a clamp warning prints on
   *  stderr even when the call itself exits 0) — `execFileSync` only surfaces stderr via the thrown error on a
   *  non-zero exit, which would silently drop it here. */
  function runCheckWait(waitArg, extraArgs = []) {
    const r = spawnSync('node', [VERIFY_LANE, 'check', ...(waitArg != null ? [`--wait=${waitArg}`] : []), '--json', ...extraArgs], { cwd: dir, encoding: 'utf8' });
    return {
      code: r.status,
      json: (() => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return null; } })(),
      stderr: String(r.stderr || ''),
    };
  }

  it('an already-GREEN marker settles on the very first poll — no waiting out the ceiling', () => {
    runVerify('true'); // records a green marker for HEAD
    const { code, json } = runCheckWait(60_000);
    expect(code).toBe(0);
    expect(json).toMatchObject({ status: 'green', ok: true, settled: true });
    expect(json.sha).toBe(headSha());
    expect(json.waited.polls).toBe(1);
  });

  it('a marker that never settles times out at the ceiling — a bounded "still pending", not a hang', () => {
    runRequestOnly(); // stamps `running` and returns — nothing ever finishes it
    const { code, json } = runCheckWait(200); // short real ceiling keeps this test fast
    expect(code).toBe(2);
    expect(json).toMatchObject({ status: 'timeout', reason: 'wait-timeout', ok: false, settled: false });
    expect(json.lastStatus).toBe('running');
    expect(json.waited.ms).toBeGreaterThanOrEqual(200);
  });

  it('rejects a non-positive/non-numeric --wait as a usage error (exit 3), never a silent 0ms wait', () => {
    for (const bad of ['0', '-5', 'nope']) {
      const { code, json } = runCheckWait(bad);
      expect(code, bad).toBe(3);
      expect(json?.reason, bad).toBe('bad-wait');
    }
  });

  it('rejects a BARE --wait (no =<ms>) as a usage error too — never the silent ~1ms wait Number(true) would give', () => {
    // #4358 — the arg parser turns a bare `--wait` into the boolean `true`, and `Number(true) === 1` would
    // otherwise sail past the finite/positive check and run a real (near-instant) wait instead of flagging the
    // likely typo.
    const r = spawnSync('node', [VERIFY_LANE, 'check', '--wait', '--json'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(3);
    const json = JSON.parse(String(r.stdout).trim().split('\n').pop());
    expect(json.reason).toBe('bad-wait');
  });

  it('clamps an outsized --wait to the safe ceiling (warns on stderr) rather than blocking for the full ask', () => {
    runVerify('true'); // already green — settles on poll 1, so this proves the CLAMP fires, not a long wait
    const { code, json, stderr } = runCheckWait(10_000_000);
    expect(code).toBe(0);
    expect(json.status).toBe('green');
    expect(stderr).toMatch(/clamped/);
  });

  it('the CLI passes the CLAMPED ceiling to waitForVerifySettle, not the raw --wait= it was given', () => {
    // #4358 — the stderr-warning test above proves a warning PRINTS, not that the value actually handed to the
    // wait core is the clamped one. `resolveWaitCeilingMs` is unit-tested in isolation (lane-verify.test.mjs);
    // this pins the WIRING at the one call site that matters, by source inspection — a live 90s-vs-10,000,000ms
    // timing race would prove the same thing far more slowly.
    const src = readFileSync(VERIFY_LANE, 'utf8');
    const waitCallBlock = src.slice(src.indexOf('await waitForVerifySettle({'), src.indexOf('await waitForVerifySettle({') + 300);
    expect(waitCallBlock).toMatch(/\bceilingMs\b/);
    expect(waitCallBlock).not.toMatch(/\brequestedMs\b/);
    // and ceilingMs itself is assigned from the clamp helper, not a bare `Math.min` re-derived at the call site.
    expect(src).toMatch(/const ceilingMs = resolveWaitCeilingMs\(requestedMs\);/);
  });

  it('the DEFAULT posture (no --require-verified flag at all, exactly the brief\'s own example) already requires verification', () => {
    // #4358 — #3321 flipped the bare default to requireVerified:true, so the brief's plain `check --wait=…`
    // example (no flag) needs no `--require-verified` to get a fast, honest `absent` for a forgotten `request` —
    // it is NOT the permissive `untracked`/ok:true path, which needs an EXPLICIT opt-out this example never gives.
    const { code, json } = runCheckWait(500); // no --require-verified, no WE_REQUIRE_VERIFIED env — the bare default
    expect(code).toBe(2);
    expect(json).toMatchObject({ status: 'absent', reason: 'unverified', ok: false, settled: false });
  });

  it('bare `check` (no --wait) is completely unchanged — one fast, non-blocking read', () => {
    runRequestOnly();
    const { code, json } = runCheckWait(null);
    expect(code).toBe(2);
    expect(json.status).toBe('running');
    expect(json.waited).toBeUndefined(); // the non-wait path never adds wait bookkeeping
  });

  /** `request` with a gate that would never actually run (a plain no-op if it did) — a plain in-flight
   *  `running` marker for HEAD that nothing here ever finishes. */
  function runRequestOnly() {
    execFileSync('node', [VERIFY_LANE, 'request', '--gate=true', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
});

/**
 * #4473 — THE LIVE BUG, REPRODUCED END TO END: `request`/bare `verify` used to overwrite an already-accurate
 * terminal marker with a fresh `running` one on EVERY call, even when nothing the gate looks at had changed
 * since that marker was recorded — the exact "same lane+sha verified repeatedly" waste this item's transcript
 * evidence measured (a worker re-`request`s after each uncommitted edit while HEAD never moves). The fix adds a
 * working-tree content hash (`computeWorkingTreeHash`) alongside `sha` AND the gate command (`suites`) as the
 * cache-hit key, and restricts the cache hit to a GREEN record only (never red — see the dedicated describe
 * block below): real `git`, the real CLI — this describe block needs a real `origin/main` ref (the outer
 * suite's bare temp repo has none) so the hash's own merge-base lookup can resolve.
 */
describe('verify-lane request/verify — a cache hit on an UNCHANGED working tree skips re-verifying (#4473)', () => {
  beforeEach(() => {
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
  });

  function runRequest(gate) {
    try {
      const out = execFileSync('node', [VERIFY_LANE, 'request', `--gate=${gate}`, '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, json: JSON.parse(out.trim().split('\n').pop()) };
    } catch (e) {
      return { code: e.status ?? null, json: (() => { try { return JSON.parse(String(e.stdout).trim().split('\n').pop()); } catch { return null; } })() };
    }
  }

  it('`request` on an unchanged tree, SAME gate, after an existing GREEN marker leaves the marker untouched and reports it cached', () => {
    const first = runVerify('true');
    expect(first.json.status).toBe('green');
    const beforeOnDisk = readFileSync(marker(), 'utf8');

    // Same gate command ('true') as the one that produced the green — this is the genuine cache-hit case.
    const { code, json } = runRequest('true');
    expect(code).toBe(0);
    expect(json.status).toBe('cached');
    expect(json.sha).toBe(headSha());

    expect(readFileSync(marker(), 'utf8')).toBe(beforeOnDisk); // byte-identical — never rewritten to `running`
  });

  // #4473 review findings 2/3 — the cache key must include the GATE COMMAND, not just sha+treeHash. A green
  // recorded under a weaker/narrower `--gate=` (e.g. `true`) must never satisfy a LATER request for a different
  // gate on the same unchanged tree: that would silently skip the real verification the caller actually asked
  // for (a false green for the stronger gate).
  it('`request` on an unchanged tree but a DIFFERENT gate than the recorded green does NOT serve that green from cache — forces a fresh run', () => {
    expect(runVerify('true').json.status).toBe('green'); // green recorded under the weak gate `true`

    const { code, json } = runRequest('exit 7'); // a different, stronger gate on the SAME unchanged tree
    expect(code).toBe(0);
    expect(json.status).toBe('requested'); // NOT `cached` — the differing gate command misses the cache key
    const onDisk = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(onDisk.status).toBe('running'); // re-stamped for a real re-run, exactly as before this fix existed
    expect(onDisk.suites).toBe('exit 7');
  });

  // converge round 1 (v3), claim-accuracy — the `preStart.sha === headSha` clause is asserted in the design
  // prose ("`headSha` alone is NOT safe... only fires when sha, treeHash and gate all match") but no prior test
  // isolated it: every other test in this block keeps HEAD fixed, so deleting that clause would still pass them
  // all. A new empty commit changes `headSha` while leaving the WORKING TREE'S CONTENT identical (`git commit
  // --allow-empty` writes no file), so `treeHash` recomputes to the exact same value — isolating the sha check
  // specifically.
  it('`request` on an IDENTICAL working tree but a DIFFERENT headSha (an empty commit) does NOT serve the old green from cache', () => {
    expect(runVerify('true').json.status).toBe('green');
    const firstSha = headSha();

    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'no tree change'], { cwd: dir });
    expect(headSha()).not.toBe(firstSha); // sha moved...
    // ...but the tracked+untracked tree content is byte-identical, so treeHash alone would (wrongly) match.

    const { code, json } = runRequest('true'); // same gate, same tree content, DIFFERENT sha
    expect(code).toBe(0);
    expect(json.status).toBe('requested'); // NOT `cached` — sha mismatch alone forces a fresh run
    expect(json.sha).toBe(headSha());
    const onDisk = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(onDisk.status).toBe('running');
    expect(onDisk.sha).toBe(headSha());
  });

  it('`request` on a tree that changed (an uncommitted edit) since that green STILL overwrites to `running` (safety preserved)', () => {
    expect(runVerify('true').json.status).toBe('green');

    writeFileSync(join(dir, 'scratch.txt'), 'an uncommitted edit\n'); // HEAD unchanged, tree changed

    const { code, json } = runRequest('true');
    expect(code).toBe(0);
    expect(json.status).toBe('requested');
    const onDisk = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(onDisk.status).toBe('running');
    expect(onDisk.sha).toBe(headSha());
  });

  it('bare `verify` on an unchanged tree, same gate, exits green from the cached record WITHOUT invoking the gate at all', () => {
    // The spy script + its ran-marker live OUTSIDE `dir` (a sibling temp dir) — writing them INSIDE the repo
    // would itself be a new untracked file, changing the working-tree hash and masking the very fast path this
    // test means to prove (that trap is exactly what the first cut of this test fell into).
    const spyDir = mkdtempSync(join(tmpdir(), 'verify-lane-spy-'));
    try {
      const ranMarker = join(spyDir, 'gate-ran.txt');
      const gateScript = join(spyDir, 'spy.mjs');
      writeFileSync(gateScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ranMarker)}, 'ran');\nprocess.exit(0);\n`);
      const gateCmd = `node ${gateScript}`;

      const first = runVerify(gateCmd); // records green, and legitimately runs the gate once
      expect(first.json.status).toBe('green');
      expect(existsSync(ranMarker)).toBe(true);
      rmSync(ranMarker); // reset the spy so the second call below proves the gate did NOT run again

      const second = runVerify(gateCmd); // identical gate command to the one that produced the green
      expect(second.code).toBe(0);
      expect(second.json.status).toBe('green');
      expect(second.json.reason).toBe('cached');
      expect(existsSync(ranMarker)).toBe(false); // the gate command never executed the SECOND time
    } finally {
      rmSync(spyDir, { recursive: true, force: true });
    }
  });

  it('bare `verify` on a changed tree still runs the gate for real', () => {
    expect(runVerify('true').json.status).toBe('green');
    writeFileSync(join(dir, 'scratch.txt'), 'an uncommitted edit\n');

    const spyDir = mkdtempSync(join(tmpdir(), 'verify-lane-spy-'));
    try {
      const ranMarker = join(spyDir, 'gate-ran-2.txt');
      const gateScript = join(spyDir, 'spy2.mjs');
      writeFileSync(gateScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ranMarker)}, 'ran');\nprocess.exit(0);\n`);

      const second = runVerify(`node ${gateScript}`);
      expect(second.code).toBe(0);
      expect(second.json.status).toBe('green');
      expect(existsSync(ranMarker)).toBe(true); // the gate DID execute
    } finally {
      rmSync(spyDir, { recursive: true, force: true });
    }
  });
});

/**
 * #4473 review finding 1 — a RED record must NEVER be served from cache. Reds are frequently non-code (host
 * contention, a flaky test — this very item's own card logged three such reds live), and before this fix a bare
 * re-`request`/`verify` on an unchanged tree always re-ran the gate, which is exactly how a worker clears a
 * flaky red: touch nothing, ask again. If a red were cache-hit, that red would become STICKY — stuck at exit 2
 * until a file is touched or `reset` is run — strictly worse than the redundant-rerun problem this item set out
 * to fix. These tests prove the fast path never engages for a red marker, on the SAME gate and an UNCHANGED
 * tree — the exact conditions that would otherwise be a cache hit for green.
 */
describe('verify-lane request/verify — a RED marker is NEVER cache-hit, even on an unchanged tree with the same gate (#4473 finding 1)', () => {
  beforeEach(() => {
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
  });

  function runRequest(gate) {
    try {
      const out = execFileSync('node', [VERIFY_LANE, 'request', `--gate=${gate}`, '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, json: JSON.parse(out.trim().split('\n').pop()) };
    } catch (e) {
      return { code: e.status ?? null, json: (() => { try { return JSON.parse(String(e.stdout).trim().split('\n').pop()); } catch { return null; } })() };
    }
  }

  it('`request` after a RED marker on an unchanged tree re-stamps `running` instead of returning the red from cache', () => {
    const first = runVerify('exit 2');
    expect(first.json.status).toBe('red');
    expect(first.code).toBe(2);

    // Unchanged tree, SAME gate command — this is exactly the shape that IS a cache hit for green.
    const { code, json } = runRequest('exit 2');
    expect(code).toBe(0);
    expect(json.status).toBe('requested'); // never `cached` for a red
    const onDisk = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(onDisk.status).toBe('running'); // re-stamped, so verify-dispatch.mjs actually re-dispatches
  });

  it('bare `verify` after a RED marker on an unchanged tree actually RE-EXECUTES the gate (a flaky red can clear on retry)', () => {
    expect(runVerify('exit 2').json.status).toBe('red');

    // Same gate command this time exits 0 — simulating the flake clearing on an untouched retry. If the red were
    // wrongly cache-hit, this would report `red` again from the stale record without ever running the command.
    const spyDir = mkdtempSync(join(tmpdir(), 'verify-lane-spy-'));
    try {
      const ranMarker = join(spyDir, 'gate-ran-red.txt');
      const gateScript = join(spyDir, 'spy-red.mjs');
      writeFileSync(gateScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ranMarker)}, 'ran');\nprocess.exit(0);\n`);

      const second = runVerify(`node ${gateScript}`);
      expect(existsSync(ranMarker)).toBe(true); // the gate WAS actually invoked — never served from cache
      expect(second.json.status).toBe('green'); // and its real (fresh) result is what gets reported
    } finally {
      rmSync(spyDir, { recursive: true, force: true });
    }
  });
});

/**
 * #4473 review round 2 (PR #2982) — the cache KEY must describe the tree the gate actually ran on, and must see
 * every property of an untracked file the gate can observe:
 *  - an OVERLAPPING `request` (a worker edits + re-requests while the daemon's `verify` is mid-gate) rewrites the
 *    shared marker with a NEWER tree's hash; the finish write must never inherit that hash onto its green, or the
 *    worker's next `request` is served a cached green for a tree that was never verified;
 *  - an untracked executable that loses its execute bit (same content, same `hash-object`) must invalidate the key;
 *  - an untracked path `git` would C-quote (non-ASCII) must still hash, not fail closed and disable the cache.
 */
describe('verify-lane — the cache key is bound to the tree THIS run verified (#4473 review round 2)', () => {
  beforeEach(() => {
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
  });

  function runRequest(gate) {
    try {
      const out = execFileSync('node', [VERIFY_LANE, 'request', `--gate=${gate}`, '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, json: JSON.parse(out.trim().split('\n').pop()) };
    } catch (e) {
      return { code: e.status ?? null, json: (() => { try { return JSON.parse(String(e.stdout).trim().split('\n').pop()); } catch { return null; } })() };
    }
  }

  it('an overlapping `request` on an edited tree mid-gate never lets the finish write record green for that newer tree', () => {
    const spyDir = mkdtempSync(join(tmpdir(), 'verify-lane-spy-'));
    try {
      // The gate itself plays the worker: mid-run it edits the tree (a new untracked file) and re-`request`s with
      // the SAME gate command — which re-stamps the shared marker `running` with the NEWER tree's hash.
      const gateScript = join(spyDir, 'overlap.mjs');
      const gateCmd = `node ${gateScript}`;
      writeFileSync(gateScript, [
        "import { writeFileSync } from 'node:fs';",
        "import { execFileSync } from 'node:child_process';",
        `writeFileSync(${JSON.stringify(join(dir, 'edited-mid-gate.txt'))}, 'never verified\\n');`,
        `execFileSync('node', [${JSON.stringify(VERIFY_LANE)}, 'request', ${JSON.stringify(`--gate=${gateCmd}`)}, '--json'], { cwd: ${JSON.stringify(dir)}, stdio: 'ignore' });`,
        'process.exit(0);',
        '',
      ].join('\n'));

      expect(runVerify(gateCmd).json.status).toBe('green');

      // The worker's next `request` on the (unchanged since) edited tree must NOT be answered from cache.
      const { code, json } = runRequest(gateCmd);
      expect(code).toBe(0);
      expect(json.status).toBe('requested');
      expect(JSON.parse(readFileSync(marker(), 'utf8')).status).toBe('running');
    } finally {
      rmSync(spyDir, { recursive: true, force: true });
    }
  });

  it('overlapping requests with different gates cannot relabel a completed green (PR #2982 round-2 review)', () => {
    const spyDir = mkdtempSync(join(tmpdir(), 'verify-lane-spy-'));
    try {
      // The STRONGER gate fails for real; the weaker one passes, and mid-run re-`request`s the stronger gate on the
      // SAME unchanged tree — re-stamping the shared marker `running` with suites = the stronger command.
      const strongScript = join(spyDir, 'strong.mjs');
      writeFileSync(strongScript, 'process.exit(1);\n');
      const strongCmd = `node ${strongScript}`;
      const weakScript = join(spyDir, 'weak.mjs');
      const weakCmd = `node ${weakScript}`;
      writeFileSync(weakScript, [
        "import { execFileSync } from 'node:child_process';",
        `execFileSync('node', [${JSON.stringify(VERIFY_LANE)}, 'request', ${JSON.stringify(`--gate=${strongCmd}`)}, '--json'], { cwd: ${JSON.stringify(dir)}, stdio: 'ignore' });`,
        'process.exit(0);',
        '',
      ].join('\n'));

      expect(runVerify(weakCmd).json.status).toBe('green');
      // The finished marker names the gate that actually ran, never the overlapping request's.
      expect(JSON.parse(readFileSync(marker(), 'utf8')).suites).toBe(weakCmd);

      const { code, json } = runRequest(strongCmd);
      expect(code).toBe(0);
      expect(json.status).toBe('requested');
    } finally {
      rmSync(spyDir, { recursive: true, force: true });
    }
  });

  it('a tree edited while the gate runs records no tree hash, so reverting to the start-of-run tree afterwards is not served from cache', () => {
    const spyDir = mkdtempSync(join(tmpdir(), 'verify-lane-spy-'));
    try {
      // The gate itself plays the worker editing mid-run (the same effect as an edit during the admission wait:
      // the tree the gate saw is not the tree hashed at start). It does NOT re-request.
      const edited = join(dir, 'edited-mid-gate.txt');
      const gateScript = join(spyDir, 'edit.mjs');
      const gateCmd = `node ${gateScript}`;
      writeFileSync(gateScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(edited)}, 'x\\n');\nprocess.exit(0);\n`);

      expect(runVerify(gateCmd).json.status).toBe('green');
      expect(JSON.parse(readFileSync(marker(), 'utf8')).treeHash).toBeNull();

      rmSync(edited); // back to the start-of-run tree
      const { code, json } = runRequest(gateCmd);
      expect(code).toBe(0);
      expect(json.status).toBe('requested');
    } finally {
      rmSync(spyDir, { recursive: true, force: true });
    }
  });

  it('an untracked executable that loses its execute bit (same content) invalidates the cached green — the gate re-runs and fails', () => {
    const tool = join(dir, 'tool.sh');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);
    expect(runVerify('./tool.sh').json.status).toBe('green');

    chmodSync(tool, 0o644); // content (and `git hash-object`) unchanged — only the mode moved

    const second = runVerify('./tool.sh');
    expect(second.json.reason).not.toBe('cached');
    expect(second.json.status).toBe('red'); // the gate really ran, and a non-executable tool.sh really fails
  });

  it('an untracked file with a non-ASCII name (C-quoted by `git ls-files`) still hashes, so an unchanged tree IS a cache hit', () => {
    writeFileSync(join(dir, 'café.txt'), 'accented\n');
    expect(runVerify('true').json.status).toBe('green');

    const { code, json } = runRequest('true');
    expect(code).toBe(0);
    expect(json.status).toBe('cached');
  });
});

/**
 * #4473 review finding 5 — the fail-closed guarantee (`currentTreeHash != null`, so an unresolvable hash never
 * matches) needs a BEHAVIORAL proof, not only the source-text regex that used to be the only guard. This describe
 * block deliberately does NOT create an `origin/main` ref (unlike the two describe blocks above) — the outer
 * `beforeEach` only leaves a bare one-commit repo — so `computeWorkingTreeHash`'s own merge-base lookup has
 * nothing to resolve and returns `null`, and the cache-hit guard must never treat that as a match.
 */
describe('verify-lane verify — with no computable origin/main ref, the tree hash is unknown and the cache is fail-closed (#4473 finding 5)', () => {
  it('a repeat `verify` with the SAME gate command on an otherwise-unchanged tree still re-runs the gate for real', () => {
    // converge round 2 (claim-accuracy) — the first cut of this test used a DIFFERENT gate command for the
    // second call, so `preStart.suites === GATE` alone already forced the re-run: the test passed even with
    // `currentTreeHash != null` deleted, proving nothing about the null-hash guard specifically. Both calls now
    // use the SAME spy script, isolating exactly the one thing this test claims to defend.
    const spyDir = mkdtempSync(join(tmpdir(), 'verify-lane-spy-'));
    try {
      const ranMarker = join(spyDir, 'gate-ran-noref.txt');
      const gateScript = join(spyDir, 'spy-noref.mjs');
      writeFileSync(gateScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ranMarker)}, 'ran');\nprocess.exit(0);\n`);
      const gateCmd = `node ${gateScript}`;

      const first = runVerify(gateCmd);
      expect(first.json.status).toBe('green');
      expect(existsSync(ranMarker)).toBe(true);
      rmSync(ranMarker); // reset the spy so the second call proves a REAL re-execution, not a leftover file

      const second = runVerify(gateCmd); // identical gate command — only the missing origin/main ref differs
      expect(second.code).toBe(0);
      expect(second.json.status).toBe('green');
      expect(second.json.reason).not.toBe('cached'); // a null tree hash must never satisfy the cache-hit guard
      expect(existsSync(ranMarker)).toBe(true); // the gate DID execute AGAIN — no false cache hit from a null hash
    } finally {
      rmSync(spyDir, { recursive: true, force: true });
    }
  });
});

describe('verify-lane reset (x4jcqm4) — clearing a stale marker without a lease to protect', () => {
  const leaseFile = () => join(dir, '.git', '.lane-lease');
  function runReset(env = {}) {
    try {
      const out = execFileSync('node', [VERIFY_LANE, 'reset', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
      return { code: 0, json: JSON.parse(out.trim().split('\n').pop()) };
    } catch (e) {
      return { code: e.status ?? null, json: (() => { try { return JSON.parse(String(e.stdout).trim().split('\n').pop()); } catch { return null; } })() };
    }
  }

  it('clears a terminal marker for a foreign sha when the lane holds no lease', () => {
    writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');

    const { code, json } = runReset();

    expect(code).toBe(0);
    expect(json.status).toBe('reset');
    expect(existsSync(marker())).toBe(false);
    // and a fresh verify now starts cleanly instead of refusing as superseded
    const after = runVerify('true');
    expect(after.code).toBe(0);
    expect(after.json.status).toBe('green');
  });

  it('is a no-op, not an error, when there is no marker to clear', () => {
    const { code, json } = runReset();
    expect(code).toBe(0);
    expect(json.status).toBe('noop');
  });

  it('refuses when the lane holds a LIVE lease, leaving the marker intact', () => {
    writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');
    writeFileSync(leaseFile(), JSON.stringify({ session: 'someone', acquiredAt: new Date().toISOString(), ttlMinutes: 240 }) + '\n');

    const { code, json } = runReset();

    expect(code).toBe(3);
    expect(json?.status).toBe('refused');
    expect(existsSync(marker())).toBe(true);
  });

  it('refuses when the lane holds a LIVE FOREIGN lease (ownerSession set, does not match caller)', () => {
    writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');
    writeFileSync(leaseFile(), JSON.stringify({ session: 'someone', ownerSession: 'sess-OTHER', acquiredAt: new Date().toISOString(), ttlMinutes: 240 }) + '\n');

    const { code, json } = runReset({ CLAUDE_CODE_SESSION_ID: 'sess-ME' });

    expect(code).toBe(3);
    expect(json?.status).toBe('refused');
    expect(existsSync(marker())).toBe(true);
  });

  it('clears the marker when the lane holds a LIVE lease CONFIRMED as the caller\'s own (#3378)', () => {
    writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');
    writeFileSync(leaseFile(), JSON.stringify({ session: 'me', ownerSession: 'sess-ME', acquiredAt: new Date().toISOString(), ttlMinutes: 240 }) + '\n');

    const { code, json } = runReset({ CLAUDE_CODE_SESSION_ID: 'sess-ME' });

    expect(code).toBe(0);
    expect(json.status).toBe('reset');
    expect(existsSync(marker())).toBe(false);
    // the lease itself is untouched — reset only clears the verify marker, never the lease
    expect(existsSync(leaseFile())).toBe(true);
  });

  it('clears the marker when the lane holds only a STALE (expired) lease', () => {
    writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');
    writeFileSync(leaseFile(), JSON.stringify({ session: 'someone', acquiredAt: '2000-01-01T00:00:00.000Z', ttlMinutes: 240 }) + '\n');

    const { code, json } = runReset();

    expect(code).toBe(0);
    expect(json.status).toBe('reset');
    expect(existsSync(marker())).toBe(false);
  });

  // #3378 review rounds 2-4 — a bare ownerSession match is not proof of "mine" in two documented topologies:
  // a dispatcher/worker split (`workerSession`), and sibling lanes that share one `ownerSession` by
  // construction (`workflowLane` / conveyor dispatch). Both must still refuse.
  it('refuses when ownerSession matches the caller but a DIFFERENT session has ADOPTED the lane (dispatcher vs. worker)', () => {
    writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');
    writeFileSync(leaseFile(), JSON.stringify({ session: 'dispatcher', ownerSession: 'sess-DISPATCHER', workerSession: 'sess-WORKER', acquiredAt: new Date().toISOString(), ttlMinutes: 240 }) + '\n');

    // The DISPATCHER's own session id matches ownerSession, but a different session has declared occupancy.
    const { code, json } = runReset({ CLAUDE_CODE_SESSION_ID: 'sess-DISPATCHER' });

    expect(code).toBe(3);
    expect(json?.status).toBe('refused');
    expect(existsSync(marker())).toBe(true);
  });

  it('clears the marker for the ADOPTING WORKER even though ownerSession belongs to the dispatcher', () => {
    writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');
    writeFileSync(leaseFile(), JSON.stringify({ session: 'dispatcher', ownerSession: 'sess-DISPATCHER', workerSession: 'sess-WORKER', acquiredAt: new Date().toISOString(), ttlMinutes: 240 }) + '\n');

    const { code, json } = runReset({ CLAUDE_CODE_SESSION_ID: 'sess-WORKER' });

    expect(code).toBe(0);
    expect(json.status).toBe('reset');
    expect(existsSync(marker())).toBe(false);
  });

  it('refuses when ownerSession matches the caller but a SIBLING lane (elsewhere in the pool) shares that ownerSession (CONTESTED)', () => {
    const poolRoot = mkdtempSync(join(tmpdir(), 'verify-lane-pool-'));
    try {
      const siblingLeaseFile = join(poolRoot, 'some-pool', 'lane-9', '.git', LEASE_FILENAME);
      mkdirSync(join(poolRoot, 'some-pool', 'lane-9', '.git'), { recursive: true });
      writeFileSync(siblingLeaseFile, JSON.stringify({ session: 'sibling', ownerSession: 'sess-SHARED', workflowLane: true, acquiredAt: new Date().toISOString(), ttlMinutes: 240 }) + '\n');

      writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');
      writeFileSync(leaseFile(), JSON.stringify({ session: 'me', ownerSession: 'sess-SHARED', workflowLane: true, acquiredAt: new Date().toISOString(), ttlMinutes: 240 }) + '\n');

      const { code, json } = runReset({ CLAUDE_CODE_SESSION_ID: 'sess-SHARED', LANE_POOL_ROOT: poolRoot });

      expect(code).toBe(3);
      expect(json?.status).toBe('refused');
      expect(existsSync(marker())).toBe(true);
    } finally {
      rmSync(poolRoot, { recursive: true, force: true });
    }
  });

  it('clears the marker when ownerSession matches and NO sibling lane shares it (uncontested, the ordinary case is unchanged)', () => {
    const poolRoot = mkdtempSync(join(tmpdir(), 'verify-lane-pool-'));
    try {
      writeFileSync(marker(), JSON.stringify({ sha: OTHER_SHA, status: 'red', startedAt: 'x', finishedAt: 'y', suites: 'gate', exitCode: 1 }) + '\n');
      writeFileSync(leaseFile(), JSON.stringify({ session: 'me', ownerSession: 'sess-SOLO', acquiredAt: new Date().toISOString(), ttlMinutes: 240 }) + '\n');

      const { code, json } = runReset({ CLAUDE_CODE_SESSION_ID: 'sess-SOLO', LANE_POOL_ROOT: poolRoot });

      expect(code).toBe(0);
      expect(json.status).toBe('reset');
      expect(existsSync(marker())).toBe(false);
    } finally {
      rmSync(poolRoot, { recursive: true, force: true });
    }
  });
});

describe('red diagnostics transport', () => {
  const gate = `printf ' FAIL  example.test.ts > outer > broken\n'; exit 1`;
  function invoke(args) {
    const result = spawnSync('node', [VERIFY_LANE, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
    return { code: result.status, json: JSON.parse(result.stdout.trim().split('\n').at(-1)), stdout: result.stdout };
  }
  it('streams the evidence and round trips marker, check and wait; green clears', () => {
    const ran = invoke([`--gate=${gate}`]);
    expect(ran.code).toBe(2);
    expect(ran.stdout).toContain(' FAIL  example.test.ts');
    const disk = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(ran.json.failureDetails).toEqual(disk.failureDetails);
    expect(disk.failureDetails.tests).toEqual([{ file: 'example.test.ts', name: 'outer > broken' }]);
    for (const args of [['check'], ['check', '--wait=100']]) {
      expect(invoke(args).json.failureDetails).toEqual(disk.failureDetails);
    }
    expect(invoke([`--gate=printf ' FAIL  example.test.ts > fake\\n'`]).json.failureDetails).toBeUndefined();
    expect(JSON.parse(readFileSync(marker(), 'utf8')).failureDetails).toBeUndefined();
  });
  it('marker-free run returns its own diagnostics without writing a marker', () => {
    const result = invoke(['run', `--gate=${gate}`]);
    expect(result.code).toBe(2);
    expect(result.json.failureDetails.tests[0].name).toBe('outer > broken');
    expect(existsSync(marker())).toBe(false);
  });
});

it('--run-id is stamped into the running marker the gate sees (dispatcher run identity)', () => {
  const seen = join(dir, 'seen-marker.json');
  const out = execFileSync('node', [VERIFY_LANE, `--gate=cp ${marker()} ${seen}`, '--run-id=run-abc', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(JSON.parse(out.trim().split('\n').pop()).status).toBe('green');
  expect(JSON.parse(readFileSync(seen, 'utf8'))).toMatchObject({ status: 'running', runId: 'run-abc' });
});

describe('fix-3311: killed gates are infrastructure failures', () => {
  it.each(['exit 137', 'kill -KILL $$'])('records %s without fabricating a test failure or an OOM cause', (gate) => {
    const { code, json } = runVerify(gate);
    expect(code).toBe(3);
    expect(json).toMatchObject({ status: 'infrastructure-failure', reason: 'verify-signal' });
    expect(json.detail).toContain('SIGKILL');
    expect(json.detail).toContain('sender/cause unknown');
    const record = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(record.status).toBe('infrastructure-failure');
    expect(record.infrastructure.signal).toBe('SIGKILL');
  });
});

describe('request with an explicit --gate when the default selection is blocked', () => {
  const blockDefault = () => {
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'echo must-not-run' } }));
  };
  const request = (gate) => spawnSync('node', [VERIFY_LANE, 'request', `--gate=${gate}`, '--json'], { cwd: dir, encoding: 'utf8' });

  it.each(['true', 'exit 0', 'npx vitest related src/a.test.ts --run || true', 'npx vitest related --run',
    'npx vitest related ghost.ts --run --passWithNoTests'])(
    'refuses weak gate %j and records no marker', (gate) => {
      blockDefault();
      const r = request(gate);
      expect(r.status).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'gate-refused', reason: 'explicit-gate-not-affected-test' });
      expect(existsSync(marker())).toBe(false);
    });

  it('accepts an affected-test gate and stamps the request', () => {
    blockDefault();
    const r = request('npx vitest related src/a.test.ts --run');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'requested' });
    expect(JSON.parse(readFileSync(marker(), 'utf8'))).toMatchObject({ status: 'running', suites: 'npx vitest related src/a.test.ts --run' });
  });

  it('a dispatcher child (--run-id) re-checks at run time: a gate accepted for a docs-only diff does not run once the tree reaches package.json', () => {
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
    writeFileSync(join(dir, 'notes.md'), 'docs-only: `true` is accepted at request time\n');
    expect(request('true').status).toBe(0);
    // The agent now edits a dependency file; the dispatcher's child must refuse instead of recording a green.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'echo must-not-run' } }));
    const r = spawnSync('node', [VERIFY_LANE, '--gate=true', '--run-id=run-x', '--json'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'gate-refused', reason: 'explicit-gate-not-affected-test' });
    // Terminal red — not left `running`, so the dispatcher does not re-spawn the same refusal every sweep.
    expect(JSON.parse(readFileSync(marker(), 'utf8'))).toMatchObject({ status: 'red', exitCode: 3 });
  });

  it('leaves an explicit gate alone when the default selection is NOT blocked (pre-existing capability)', () => {
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
    writeFileSync(join(dir, 'notes.md'), 'a docs-only change selects (not blocks) the default gate\n');
    const r = request('true');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'requested' });
  });
});

it('an unscopable default request refuses before stamping a runnable marker', () => {
  execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'echo must-not-run' } }));
  const r = spawnSync('node', [VERIFY_LANE, 'request', '--json'], { cwd: dir, encoding: 'utf8' });
  expect(r.status).toBe(3);
  expect(JSON.parse(r.stdout)).toMatchObject({ status: 'selection-required', reason: 'local-selection-bound' });
  expect(existsSync(marker())).toBe(false);
});

describe('local timeout-only retry under admission', () => {
  function fixture({ edited = false, mixed = false, retryExit = 0, standardsExit = 0, truncated = false, live = false } = {}) {
    const files = truncated ? Array.from({ length: 21 }, (_, i) => `untouched-${i}.test.mjs`) : ['untouched-a.test.mjs', 'untouched-b.test.mjs'];
    const stderr = files.map((f, i) => ` FAIL  ${f} > case ${i}\n${mixed && i === 1 ? 'AssertionError: wrong value' : 'Error: Test timed out in 5000ms.'}\n`).join('');
    const stdout = ` Test Files  ${files.length} failed\n Tests  ${files.length} failed\n Duration  5.1s\n`;
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'source.mjs'), 'export const x = 1;\n');
    for (const file of files) writeFileSync(join(dir, file), live ? `
import './source.mjs';
import { it } from ${JSON.stringify(resolve(process.cwd(), 'node_modules/vitest/dist/index.js'))};
import { existsSync, writeFileSync } from 'node:fs';
it('first attempt times out', async () => {
  const attempt = ${JSON.stringify(file + '.attempt')};
  if (existsSync(attempt)) return;
  writeFileSync(attempt, 'attempted');
  await new Promise(() => {});
}, 40);
` : '// baseline\n');
    if (live) writeFileSync(join(dir, 'vitest.config.mjs'), 'export default { test: { environment: "node", include: ["*.test.mjs"] } };\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'test:unit': 'vitest run', 'check:standards': 'true' } }));
    const admissionModule = resolve(process.cwd(), 'scripts/readiness/heavy-admission.mjs');
    const fake = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { admissionLockRoot, heldSlots } from ${JSON.stringify(admissionModule)};
const args = process.argv.slice(2);
const held = heldSlots({ lockRoot: admissionLockRoot(process.cwd()), cap: 1, fastSlots: 1 });
appendFileSync('calls.jsonl', JSON.stringify({ args, held, inherited: process.env.WE_HEAVY_ADMISSION_HELD }) + '\\n');
if (${live} && args[0] === 'vitest') {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [${JSON.stringify(resolve(process.cwd(), 'node_modules/vitest/vitest.mjs'))}, ...args.slice(1), ...(args[1] === 'related' ? ['--maxWorkers=1', '--minWorkers=1'] : [])], { stdio: 'inherit' });
  process.exit(result.status ?? 2);
}
if (args[0] === 'vitest' && args[1] === 'related') {
  process.stdout.write('passed file\\n'.repeat(148));
  process.stderr.write(${JSON.stringify(stderr)});
  process.stdout.write(${JSON.stringify(stdout)});
  process.exit(1);
}
if (args[0] === 'vitest') process.exit(${retryExit});
process.exit(${standardsExit});
`;
    for (const name of ['npx', 'npm']) {
      writeFileSync(join(dir, 'bin', name), fake); chmodSync(join(dir, 'bin', name), 0o755);
    }
    // Keep fixture infrastructure out of the change's own edited set.
    writeFileSync(join(dir, '.gitignore'), 'calls.jsonl\npool/\n*.attempt\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'baseline'], { cwd: dir });
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
    writeFileSync(join(dir, edited ? files[0] : 'source.mjs'), '// changed\n');
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, LANE_POOL_ROOT: join(dir, 'pool'), WE_HEAVY_ADMISSION_CAP: '1' };
    function invoke(args = []) {
      const result = spawnSync('node', [VERIFY_LANE, ...args, '--json'], { cwd: dir, env, encoding: 'utf8' });
      return { code: result.status, json: JSON.parse(result.stdout.trim().split('\n').at(-1)), stdout: result.stdout, stderr: result.stderr };
    }
    return { files, invoke, calls: () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
  }

  it('retries only failed files once with one worker, then runs standards and records why', () => {
    const f = fixture();
    // Exercise request → dispatcher --gate replay, the production path.
    expect(f.invoke(['request']).code).toBe(0);
    const gate = JSON.parse(readFileSync(marker(), 'utf8')).suites;
    const result = f.invoke([`--gate=${gate}`, '--run-id=retry-proof']);
    expect(result.code).toBe(0);
    expect(result.json, result.stdout + result.stderr).toMatchObject({ status: 'green', retriedTimeouts: f.files });
    expect(result.json.detail).toContain('timeout-only failures in untouched files');
    expect(JSON.parse(readFileSync(marker(), 'utf8'))).toMatchObject({ status: 'green', retriedTimeouts: f.files });
    const calls = f.calls();
    expect(calls).toHaveLength(3);
    expect(calls[1].args).toEqual(['vitest', 'run', '--maxWorkers=1', '--minWorkers=1', '--no-file-parallelism', ...f.files.map(f => `./${f}`)]);
    expect(calls[2].args.slice(0, 2)).toEqual(['run', 'check:standards']);
    for (const call of calls) {
      expect(call.held).toHaveLength(1);
      expect(call.inherited).toBe('1');
      expect(call.held[0].pid).toBe(calls[0].held[0].pid);
    }
    for (const args of [['check'], ['check', '--wait=100'], []]) {
      const read = f.invoke(args);
      expect(read.json.retriedTimeouts).toEqual(f.files);
      expect(read.json.detail).toContain('Retried once serially');
    }
    expect(f.calls()).toHaveLength(3);
  });

  it('recovers actual Vitest timeouts using the installed reporter and single-worker flags', () => {
    const f = fixture({ live: true });
    const result = f.invoke();
    expect(result.json, result.stdout + result.stderr).toMatchObject({ status: 'green', retriedTimeouts: f.files });
    expect(f.calls()).toHaveLength(3);
  }, 15000);

  it.each([
    ['an edited failing file', { edited: true }, 1],
    ['mixed failures', { mixed: true }, 1],
    ['a second timeout', { retryExit: 1 }, 2],
    ['truncated failure identities', { truncated: true }, 1],
    ['standards failing after recovery', { standardsExit: 1 }, 3],
  ])('keeps red for %s', (_, options, count) => {
    const f = fixture(options);
    const result = f.invoke();
    expect(result.code).toBe(2);
    expect(result.json.status).toBe('red');
    expect(JSON.parse(readFileSync(marker(), 'utf8')).status).toBe('red');
    expect(f.calls()).toHaveLength(count);
    if (count === 1) expect(result.json.retriedTimeouts).toBeUndefined();
    else expect(result.json.retriedTimeouts).toEqual(f.files);
  });
});


describe('verify-lane request refuses fast when no verify daemon is alive (#4161)', () => {
  function request() {
    const result = spawnSync(process.execPath, [VERIFY_LANE, 'request', '--gate=true', '--json'], {
      cwd: dir, encoding: 'utf8', timeout: 2000,
    });
    expect(result.error).toBeUndefined();
    return { code: result.status, json: JSON.parse(result.stdout.trim()) };
  }
  function expectRefusal(reason) {
    const { code, json } = request();
    expect(code).toBe(3);
    expect(json).toMatchObject({ status: 'no-server', reason: 'verify-daemon-not-alive', ok: false, sha: headSha() });
    expect(json.detail).toContain(reason);
    expect(json.detail).toContain(VERIFY_DAEMON_LEASE_KEY);
    expect(json.detail).toContain('launchctl kickstart');
    expect(json.detail).toContain('no marker was written');
    expect(existsSync(marker())).toBe(false);
  }
  it('request with no verify-daemon lease exits 3 and writes no marker', () => {
    rmSync(lockRoot, { recursive: true, force: true });
    expectRefusal('no-lease');
  });
  it('request with a stale verify-daemon lease is refused the same way', () => {
    const nowMs = Date.now() - (RUNNER_LEASE_MINUTES + 1) * 60_000;
    heartbeatRunnerLease(lockRoot, makeOwner('verify-test'), { key: VERIFY_DAEMON_LEASE_KEY, nowMs });
    expectRefusal('stale-lease');
  });
  it('request with a fresh lease whose same-host holder exited is refused', () => {
    rmSync(lockRoot, { recursive: true, force: true });
    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    seedVerifyServer(lockRoot, { pid: child.pid });
    expectRefusal('holder-dead');
  });
  it('request on an unchanged tree with a cached green still returns cached with no daemon alive', () => {
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
    expect(runVerify('true').json.status).toBe('green');
    const before = readFileSync(marker(), 'utf8');
    rmSync(lockRoot, { recursive: true, force: true });
    expect(request()).toMatchObject({ code: 0, json: { status: 'cached' } });
    expect(readFileSync(marker(), 'utf8')).toBe(before);
  });
  it('request with a live verify-daemon lease still stamps running', () => {
    expect(request()).toMatchObject({ code: 0, json: { status: 'requested' } });
    expect(JSON.parse(readFileSync(marker(), 'utf8')).status).toBe('running');
  });
});


describe('verify phase telemetry (#5141)', () => {
  let previousPoolRoot;
  beforeEach(() => {
    previousPoolRoot = process.env.LANE_POOL_ROOT;
    process.env.LANE_POOL_ROOT = join(dir, '.git', 'pool');
  });
  afterEach(() => {
    if (previousPoolRoot === undefined) delete process.env.LANE_POOL_ROOT;
    else process.env.LANE_POOL_ROOT = previousPoolRoot;
  });
  const explicitPhases = { admissionWaitMs: expect.any(Number), gateMs: expect.any(Number),
    vitestMs: null, scanMs: null, standardsMs: null, targetFileCount: null, changedFileCount: null,
    importGraphTargetCount: null, literalReferenceTargetCount: null,
    outcomes: { vitest: { result: 'skipped' }, scan: { result: 'skipped' }, standards: { result: 'skipped' } } };
  function invoke(args) {
    const result = spawnSync('node', [VERIFY_LANE, ...args, '--json'], { cwd: dir, encoding: 'utf8' });
    return { code: result.status, json: JSON.parse(result.stdout.trim().split('\n').at(-1)), stderr: result.stderr };
  }
  it.each([['true', 0], ['false', 2], ['exit 137', 3]])('records and emits phases for %s', (gate, code) => {
    const result = runVerify(gate);
    expect(result.code).toBe(code);
    const record = JSON.parse(readFileSync(marker(), 'utf8'));
    expect(record.phases).toEqual(explicitPhases);
    expect(result.json.phases).toEqual(record.phases);
    for (const args of [['check'], ['check', '--wait=100']]) {
      expect(invoke(args).json.phases).toEqual(record.phases);
    }
  });
  it('preserves phases on cached verify and request results', () => {
    execFileSync('git', ['branch', 'origin/main'], { cwd: dir });
    const first = runVerify('true');
    expect(first.json.phases).toEqual(explicitPhases);
    for (const args of [['--gate=true'], ['request', '--gate=true']]) {
      expect(invoke(args).json).toMatchObject({ reason: 'cached', phases: first.json.phases });
    }
  });
  it.each([['true', 0], ['false', 2], ['exit 137', 3]])('emits run phases and one timing line for %s without a marker', (gate, code) => {
    const result = invoke(['run', `--gate=${gate}`]);
    expect(result.code).toBe(code);
    expect(result.json.phases).toEqual(explicitPhases);
    expect(result.stderr.match(/⏱ phaseMs /g)).toHaveLength(1);
    expect(result.stderr).toContain('⏱ gate execution starting');
    expect(existsSync(marker())).toBe(false);
  });
  it.each([null, { corrupt: true, phases: {} }, { phases: null }, { phases: [] }, { phases: 4 }])(
    'omits phases from check for absent, corrupt, or invalid telemetry: %j', (record) => {
      if (record) writeFileSync(marker(), JSON.stringify(record));
      for (const args of [['check'], ['check', '--wait=100']]) {
        expect(invoke(args).json).not.toHaveProperty('phases');
      }
    });
});
