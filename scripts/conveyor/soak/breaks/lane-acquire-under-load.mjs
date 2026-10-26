/**
 * @file breaks/lane-acquire-under-load.mjs — live break 4, 2026-09-24 incident (#3383, card 4069 -> #4069).
 * `scripts/lane-pool.mjs`'s `cmdAcquire` auto-pick loop (no explicit `--lane=N`) used to recompute the FULL
 * dirty/ahead probe pipeline (`git status --porcelain` + `rev-list` + patch-equivalence, via
 * `effectiveDirtyOrAhead`) for EVERY unleased lane, FROM SCRATCH, on EVERY `ACQUIRE_POLL_MS` (1s) poll tick, IN
 * EVERY concurrent caller — so `--wait-ms=<W>` bounded only the gaps BETWEEN full rescans, never a rescan
 * itself. Live: one real `acquire --wait-ms=30000` took ~6 minutes and still failed while the pool actually had
 * spare capacity (`lane-pool-health-watch.mjs --dry-run` read 14-15 acquirable at the same moment).
 *
 * Fix: b6c6dee34 (card 4069 -> #4069, epic #3383) — auto-pick now consumes `acquirableListCached`, the SAME
 * single-flight, cached, `--scan-timeout-ms`-bounded scan `list --acquirable` already shares across concurrent
 * callers (#4012), instead of an independent uncached rescan per caller per poll tick. Live proof in that
 * commit: 3 concurrent `--wait-ms=8000` callers on a saturated pool went from 27.60s to 9.09s. Pinned unit
 * proof: `scripts/__tests__/lane-pool-acquire-shares-scan-cache.test.mjs`.
 *
 * SCENARIO (built per this task's brief): a larger pool (`LANES`), every lane made genuinely dirty (a real
 * uncommitted change to a TRACKED file, `.gitignore` — never an untracked scratch file, which
 * `lib/lane-litter.mjs`'s known-safe-litter allowlist would forgive and read as clean), a slow-`git` PATH shim
 * ahead of the real one (`SLOW_GIT_S` extra per git child — the SAME technique
 * `lane-pool-acquire-shares-scan-cache.test.mjs`'s own third case uses: a real local `git status`/`rev-list`
 * over a handful of tiny lanes is a few tens of ms, too fast on modern hardware to reliably blow a
 * several-second bound on its own), `CALLERS` concurrent REAL `node <simClone>/scripts/lane-pool.mjs acquire
 * --wait-ms=<WAIT_MS> --json` child processes (as review/fix sessions do — real dispatched sessions acquire
 * concurrently, `we:scripts/conveyor/__tests__/sim/agent-actions.mjs#acquireLane`), with exactly ONE lane
 * un-dirtied (freed) once the callers' first shared scan has provably read it dirty (soak-main-red — see
 * perRound), so there is a legitimate winner the pool must notice mid-wait. `api.violation('bounded',
 * ...)` fires when any call takes longer than `WAIT_MS + BOUND_MARGIN_MS`, or fails with a scan-timeout message
 * while a lane was, at some point, genuinely free (the OTHER shape the pinned unit test's third case pins).
 *
 * STATUS (2026-09-25, measured by this harness): STILL BROKEN ON MAIN AT LIVE SCALE — card we:backlog/4172.
 * At the 6-lane/3-caller shape every run was green on main AND on the pre-fix code (`red-green.mjs --at-parent`
 * restores lane-pool.mjs to b6c6dee34^: all callers inside the bound) — too small to tell the two apart. At
 * 14 lanes / 5 callers (now the default) current main returns 33s, 34s, 45s, 56s, 68s for `--wait-ms=20000` —
 * waiters give up one after another ~11s apart, the last at 3.4x its wait — while the pre-fix code returned all
 * five at ~34s in the same world. So b6c6dee34 fixed the 6-minute rescan storm but the wait is still no bound
 * under concurrency. `fixPresent` therefore probes for the NEXT fix (none yet → expected-fail); whoever fixes
 * 4172 replaces the probe with a marker their fix adds. `SOAK_LOAD_LANES` / `SOAK_LOAD_CALLERS` override the
 * scale.
 *
 * RED-GREEN CAVEAT — READ BEFORE RE-RUNNING `red-green.mjs` ON THIS BREAK (use `--at-parent`). Reverse-applying b6c6dee34's own
 * `scripts/lane-pool.mjs` hunk onto the CURRENT tree does not apply, even narrowed to just that one file
 * (verified: `git apply -R --3way` reports "repository lacks the necessary blob to perform 3-way merge...
 * patch does not apply" at exactly the `cmdAcquire` auto-pick hunk, `@@ -1538,21 +1516,55 @@`). Root cause:
 * `cmdAcquire`'s auto-pick loop has been rewritten SEVERAL times since 2026-09-24 by later, unrelated commits
 * layered on top (growth-on-empty, `holderSlug`/`acquirePollCount` instrumentation, …) — the patch's context no
 * longer matches, and `red-green.mjs`'s throwaway copy is a single fresh commit with no object history for a
 * real 3-way reconstruction. `git diff`'s path filter (`--paths`) selects whole FILES, not sub-file hunks, so
 * no narrower `--paths` choice fixes a context mismatch INSIDE the one file that has it — there is no subset
 * of paths that both (a) contains the fix and (b) reverse-applies cleanly. This is a tooling limitation of
 * reverse-applying an 8-revision-old commit onto a function since rewritten by later work, not a defect in
 * this scenario file; `fixPresent` below still correctly reports the fix IS present on this tree (confirmed:
 * `acquirableListCached` appears inside `cmdAcquire`'s body). See this task's final report for the exact
 * command/output evidence.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { runSoak } from '../soak.mjs';

const LANES = Number(process.env.SOAK_LOAD_LANES) || 14;
const CALLERS = Number(process.env.SOAK_LOAD_CALLERS) || 5;
// Numbers picked empirically against THIS scenario's own slow-git shim (see `SLOW_GIT_S`): one full 6-lane
// scan measured ~5.7s (6 lanes x ~5 git calls x 0.2s). `lane-1` frees right after the FIRST scan publishes, so
// the winner needs a SECOND scan (cheap: the per-lane verdict memo skips the 13 still-dirty lanes) before it can
// claim it — `WAIT_MS`/`BOUND_MARGIN_MS` leave real headroom above that measured cost so GREEN is comfortably
// inside the bound rather than riding its edge.
const WAIT_MS = 20_000;
// A REFUSED caller can legitimately run past `WAIT_MS` by up to one more in-flight scan's width (the scan's
// own budget is never shrunk to a caller's remaining wait — `cmdAcquire`'s own comment on this) — measured
// ~5.7s/scan plus real machine jitter, so the margin below is generous, not tight, to keep GREEN comfortably
// (not marginally) inside the bound.
const BOUND_MARGIN_MS = 20_000; // total bound = WAIT_MS + BOUND_MARGIN_MS = 40s
// Lane-1 frees at whichever comes first: the first scan publishing, or this many ms in. Lane-1 is the FIRST lane
// every scan probes (~1s in, after lane-pool's own startup), so by 4s the cold scan has already read it dirty
// even when it has not finished — freeing then is the mid-scan case (a clean landing after its lane was probed),
// which the pool must also notice. Early enough to leave the second, cheap scan well inside WAIT_MS.
const FREE_AFTER_MS = 4_000;
const FREE_POLL_MS = 50;
const LIST_CACHE_BASENAME = '.list-acquirable-cache.json'; // lane-pool.mjs's LIST_CACHE_FILE
const SLOW_GIT_S = 0.2; // extra seconds every `git` child call costs under the slow shim (see header)
const SCAN_TIMEOUT_MS = 60_000; // generous vs. the ~5.7s measured single-scan cost — never the thing under test

/** Resolved once, from the ambient PATH (never the sandboxed world env) — the real binary the slow shim execs. */
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function runCli(scriptPath, args, cwd, env) {
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolvePromise({ code, out: out.trim(), err: err.trim(), ms: Date.now() - startedAt }));
    child.on('error', (e) => resolvePromise({ code: 1, out: '', err: String(e && e.message ? e.message : e), ms: Date.now() - startedAt }));
  });
}

async function perRound(w, round, ctx, api) {
  if (round !== 0) return; // the whole scenario runs once, inside round 0
  const scriptPath = join(w.simCloneRoot, 'scripts', 'lane-pool.mjs');

  // 1. Resolve every lane's real path via the CLI itself (never guess the pool-naming scheme).
  const lanePaths = [];
  for (let n = 1; n <= LANES; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- a handful of cheap sequential setup calls, not the timed part
    const r = await runCli(scriptPath, ['path', `--lane=${n}`], w.simCloneRoot, w.env);
    if (r.code !== 0) throw new Error(`lane-acquire-under-load: could not resolve lane-${n} path: ${r.err || r.out}`);
    lanePaths.push(r.out);
  }

  // 2. Saturate: every lane genuinely dirty (a real uncommitted change to a TRACKED file).
  const gitignorePaths = lanePaths.map((p) => join(p, '.gitignore'));
  const originals = gitignorePaths.map((p) => readFileSync(p, 'utf8'));
  const dirtyMarker = '\n# soak: saturate (#4075 lane-acquire-under-load)\n';
  gitignorePaths.forEach((p, i) => writeFileSync(p, originals[i] + dirtyMarker));
  const restoreAll = () => gitignorePaths.forEach((p, i) => { try { writeFileSync(p, originals[i]); } catch { /* best effort */ } });

  // 3. A slow-`git` shim ahead of the real one, for OUR acquire calls only (never mutates `w.env`).
  const shimDir = join(w.root, 'soak-slow-git-bin');
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, 'git');
  writeFileSync(shimPath, `#!/bin/sh\nsleep "$GIT_SHIM_SLEEP"\nexec "${REAL_GIT}" "$@"\n`);
  chmodSync(shimPath, 0o755);
  // This break measures scan/wait contention. Recovery's preservation probes are a separate workload,
  // just as growth's clone cost is excluded below; the recovery CLI has its own real-Git coverage.
  const slowEnv = { ...w.env, LANE_POOL_NO_RECOVER: '1', PATH: `${shimDir}:${w.env.PATH}`, GIT_SHIM_SLEEP: String(SLOW_GIT_S) };

  // 4. Fire CALLERS concurrent real acquire callers, free lane-1 partway through, measure wall time.
  // soak-main-red — lane-1 is freed (its tracked edit written back — no git command, so `.git` never changes,
  // like an agent/editor reverting a file or deleting its scratch) only ONCE the callers' first shared scan has
  // provably read it dirty: when that scan publishes its answer (the list cache file appears), or at
  // `FREE_AFTER_MS`, by which point the cold scan has long since probed lane-1 (its first lane). That is the case
  // this break exists for — the pool must notice a lane freed AFTER it was scanned, inside the callers' wait.
  // It used to free at a fixed 2s, making the verdict a race on scan speed: whenever the first probe of lane-1
  // came AFTER 2s the scenario was trivially green (the old unsharded soak's load), and once sharding made that
  // probe land BEFORE 2s it went red on every daemon PR — lane-pool's per-lane verdict memo (#2778) pinned
  // lane-1 as "holds work" for its 10-minute max age because its fingerprint saw only `.git` state. Fixed in
  // lane-pool.mjs (`dirtSignature`); this trigger makes the scenario red on that bug EVERY run, not by luck.
  const poolDir = dirname(lanePaths[0]);
  // Cold start: no answer (or per-lane verdict) from before the saturation may exist, or "the first scan
  // published" would fire on a stale file and free lane-1 before anything had read it dirty.
  for (const f of [LIST_CACHE_BASENAME, '.acquirable-verdict-memo.json']) rmSync(join(poolDir, f), { force: true });
  const freeStartedAt = Date.now();
  let freed = false;
  let freedAtMs = null;
  let freedWhy = null;
  const freeLane1 = (why) => {
    if (freed) return;
    freed = true;
    freedAtMs = Date.now() - freeStartedAt;
    freedWhy = why;
    try { writeFileSync(gitignorePaths[0], originals[0]); } catch { /* best effort */ }
  };
  const freeTimer = setInterval(() => {
    if (existsSync(join(poolDir, LIST_CACHE_BASENAME))) freeLane1('after the first scan published');
    else if (Date.now() - freeStartedAt >= FREE_AFTER_MS) freeLane1('fallback timer');
    if (freed) clearInterval(freeTimer);
  }, FREE_POLL_MS);
  let results;
  try {
    results = await Promise.all(Array.from({ length: CALLERS }, (_, i) => runCli(
      // `LANE_POOL_HARD_MAX=${LANES}` (env, not the `--hard-max` flag: an older lane-pool.mjs rejects the unknown flag
      // outright, which would make the red-green RED side fail for a reason unrelated to this break) pins the SEPARATE growth-on-empty ceiling (#4025) at this pool's real size — the
      // SAME technique `lane-pool-acquire-shares-scan-cache.test.mjs`'s own "genuinely saturated" case uses —
      // so a caller whose wait elapses with nothing acquirable fails/retries the shared scan, rather than
      // cloning a brand-new lane (a real, but UNRELATED, feature that would otherwise swamp this scenario's
      // timing with clone/build cost that has nothing to do with the bug under test).
      scriptPath, ['acquire', `--session=soak-caller-${i + 1}`, `--wait-ms=${WAIT_MS}`, `--scan-timeout-ms=${SCAN_TIMEOUT_MS}`, '--json'], w.simCloneRoot, { ...slowEnv, LANE_POOL_HARD_MAX: String(LANES) },
    )));
  } finally {
    clearInterval(freeTimer);
    if (!freed) freeLane1('after the callers returned');
    restoreAll(); // hygiene — the world is torn down after this scenario regardless
  }

  // 5. Judge (built-in `owed`/`clean`/etc. invariants don't apply here — this scenario reports its own finding
  //    via `api.violation`, merged into the very next daemon tick's report line, per `soak.mjs`'s own contract).
  const bound = WAIT_MS + BOUND_MARGIN_MS;
  api.say(
    `r00 lane-acquire-under-load: ${CALLERS} concurrent acquire --wait-ms=${WAIT_MS} callers on a saturated `
    + `${LANES}-lane pool (lane-1 freed ${freedAtMs}ms in, ${freedWhy}; slow-git +${SLOW_GIT_S}s/call, bound ${bound}ms) -> `
    + results.map((r, i) => `caller-${i + 1}:${r.code === 0 ? 'ok' : 'refused'}(${r.ms}ms)`).join(' '),
  );
  for (const [i, r] of results.entries()) {
    if (r.ms > bound) {
      api.violation('bounded', `acquire --wait-ms=${WAIT_MS} (caller-${i + 1}) took ${r.ms}ms (bound ${bound}ms) — ${r.code === 0 ? 'succeeded late' : `refused: ${r.err.split('\n')[0]}`}`);
    } else if (r.code !== 0 && /scan itself did not finish/.test(r.err)) {
      api.violation('bounded', `acquire --wait-ms=${WAIT_MS} (caller-${i + 1}) failed with a scan timeout in ${r.ms}ms while a lane was free — ${r.err.split('\n')[0]}`);
    }
  }
  // A lane WAS freed inside every caller's wait window, so the pool owes one of them that lane: all callers
  // giving up means the freed lane was never handed out (live: every review session failing "no free lane").
  if (!results.some((r) => r.code === 0)) {
    const why = results.map((r, i) => `caller-${i + 1} after ${r.ms}ms: ${(r.err || '').split('\n').find((l) => l.trim()) ?? '(no output)'}`).join('; ');
    api.violation('bounded', `acquire --wait-ms=${WAIT_MS}: a lane was freed ${freedAtMs}ms in (${freedWhy}), yet no caller acquired it — ${why}`);
  }
}

export default {
  id: 'lane-acquire-under-load',
  title: 'lane acquire --wait-ms is no bound under concurrent load (live: 6-minute acquires; main today: last of 5 waiters at 3.4x its wait)',
  card: 'we:backlog/4172 (first fix b6c6dee34 / #4069 was partial; epic #4075)',
  fixedBy: { sha: '(this worker\'s PR) + soak-main-red', where: 'cmdAcquire / acquirableListCached; verdict memo dirtSignature', paths: ['scripts/lane-pool.mjs'] },
  // 4172 fix: `acquirableListCached`'s "wait for a DIFFERENT caller's in-flight shared-scan lock" branch now
  // takes a `callerDeadlineMs` (this acquire call's own --wait-ms deadline) and gives up with a distinguishable
  // `{ lockContention: true }` once it elapses, instead of sitting out the lock/scan's own (far larger, and
  // rightly still shared/unbounded-per-caller) budget regardless of how small THIS caller's own wait was. That
  // is exactly the "serialized staircase" this break measures: a caller stuck behind someone else's turn at the
  // single-flight lock, over and over, never getting to check its OWN deadline until each such wait finished.
  // `lockContention` is a marker string unique to this fix (absent from the pre-fix tree, including the earlier
  // partial b6c6dee34/#4069 fix `firstFixPresent` below still probes for).
  // soak-main-red (2026-09-26): ALSO requires `dirtSignature` — the per-lane verdict memo (#2778) pinned a lane
  // freed without touching `.git` as "holds work" for up to 10 min, so no caller ever got it (red on every daemon
  // PR once the sharded soak's first scan reached lane-1 before the free). Both fixes are needed for GREEN.
  fixPresent(root) {
    try {
      const src = readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8');
      return src.includes('lockContention') && src.includes('dirtSignature');
    } catch { return false; }
  },
  firstFixPresent(root) {
    try {
      const src = readFileSync(join(root, 'scripts/lane-pool.mjs'), 'utf8');
      const start = src.indexOf('function cmdAcquire(repo)');
      if (start === -1) return false;
      const next = src.indexOf('\nfunction ', start + 1);
      const body = next === -1 ? src.slice(start) : src.slice(start, next);
      return body.includes('acquirableListCached');
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:lane-acquire-under-load',
      rounds: 1,
      daemons: ['fix-dispatch'], // one cheap tick after perRound, so `api.violation` has somewhere to land
      mainEvery: 0,
      fleet: false, // this break is about the lane-acquire primitive itself, not PR handling
      lanes: LANES,
      bounds: { tickBoundMs: 110_000 },
      perRound,
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === 'bounded' && /^acquire --wait-ms=/.test(v.detail))
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
