/**
 * @file wake-cli.test.mjs — the waker's CLI block, which nothing used to execute (#3037, PR #1211 review F2).
 *
 * WHAT WAS UNTESTED, AND WHY IT IS THE SAME DEFECT CLASS AS AN UNREGISTERED OPERATION. `wake.mjs`'s
 * `if (IS_CLI)` block is the ONLY place the dispatch observer is wired in production. `wake.test.mjs` imports
 * the pure functions; `__fixtures__/observe-dispatch.mjs` builds its own observer table. So
 * `const observers = createDispatchObservers()` could be replaced with `{}` and all 163 test files stayed
 * green — an observer nothing reaches is the same shape of defect as a declaration nothing can resolve, which
 * `gate-health` shipped with once and which `dispatch-lane.test.mjs` now has a named test against.
 *
 * SO THIS DRIVES THE REAL CLI, in a real child process, and asserts what it OBSERVED WITH. Only `claude` is
 * stubbed — a two-line `sh` script on the child's `PATH` that records its argv and prints a canned listing.
 * That makes the child's `PATH` carry no real `claude`: **no agent is started and no `claude` process runs.**
 * Stubbing it that way also pins, across a real process boundary, that the listing is read as
 * `claude agents --json` and NEVER with `--all` (review F6) — with `--all` a finished build reads `running`
 * forever, which the observer's own docblock calls the one mistake that makes an observer worse than none.
 *
 * The third case drives `--resolve`, the close-out surface the review's F1 said did not exist: until it did,
 * an operator's only remedy for a dispatch the observer can never call `succeeded` was hand-written node,
 * once per completed build, forever.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { advanceWhileRunning, runStatus, startRun } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createFileRunStore } from '../run-store.mjs';
import { createRegistry } from '../registry.mjs';
import { DISPATCH_LANE_OP, dispatchLaneOperation } from '../dispatch-lane.mjs';
import { LIST_TIMEOUT_ENV, PR_LIST_JSON_FIELDS, PR_LIST_LIMIT, PR_LIST_TIMEOUT_ENV, createDispatchSinks } from '../dispatch-lane-io.mjs';
import { assertHandleNotLive, closeOutEntry, flagValue } from '../wake.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAKE_CLI = resolve(HERE, '..', 'wake.mjs');
const RUN_ID = 'run-wake-cli';
const KEY = `${RUN_ID}#2#0`;
const HANDLE = 'ffffffff-1111-2222-3333-444444444444';
// #3331: `entry.handle` is now the SHORT id the CLI's own `--bg` confirmation carries, not the minted
// `sessionId` — a genuine prefix of it. `HANDLE` stays the FULL id used in every `agents` listing fixture
// below (realistic — that is what `claude agents --json` actually reports), and `SHORT_HANDLE` is what
// `parkOneDispatch`'s sink now records and every dispatch-side assertion compares against.
const SHORT_HANDLE = HANDLE.split('-')[0];
/** A fake `--bg` confirmation carrying `shortId`, shaped exactly like the real CLI's (#3331). */
const bgStdout = (shortId, name = 'conveyor-3037') => `backgrounded · ${shortId} · ${name}\n`;
/** A PRIMARY checkout — the sink refuses to dispatch from a lane clone, which is what the default resolves to. */
const PRIMARY = '/primary/webeverything';
const BRIEF = 'build #{{ITEM_NUM}} at {{ITEM_SPEC_PATH}} in lane {{LANE}} as {{SESSION_SLUG}} scoped {{SCOPE}}';

let dir;
let binDir;
let argvFile;
let ghArgvFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'we-wake-cli-runs-'));
  binDir = mkdtempSync(join(tmpdir(), 'we-wake-cli-bin-'));
  argvFile = join(binDir, 'argv.txt');
  ghArgvFile = join(binDir, 'gh-argv.txt');
  // THE STUB `claude`. `sh` builtins only, so it needs nothing on `PATH` itself — which lets the child run with
  // a `PATH` holding this directory and nothing else, and therefore with no way to reach a real `claude`.
  const stub = join(binDir, 'claude');
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$STUB_ARGV_FILE"\nprintf \'%s\' "$STUB_AGENTS"\n');
  chmodSync(stub, 0o755);
  // THE STUB `gh` (#x9ylkp7). The observer's second axis reads `gh pr list`, and the same rule applies: no real
  // `gh` is on the child's `PATH`, so **no network call is made and no real repo is queried**. It records its
  // argv for the same reason the `claude` stub does — the discovery query's failure mode is SILENCE (an empty
  // page is indistinguishable from "no PR yet"), so `--state all` and `headRefName` are pinned across a real
  // process boundary and not only in-process.
  const ghStub = join(binDir, 'gh');
  writeFileSync(ghStub, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$STUB_GH_ARGV_FILE"\nprintf \'%s\' "$STUB_PRS"\n');
  chmodSync(ghStub, 0o755);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

/** Park a real dispatch run on disk, aged past the observer's 2-minute listing grace and far short of escalation. */
async function parkOneDispatch({ ageMs = 10 * 60 * 1000 } = {}) {
  const registry = createRegistry();
  registry.register(dispatchLaneOperation({
    readTick: () => ({
      resolvedNum: '3037',
      launch: { num: '3037', lane: 8 },
      suppressed: null,
      item: { num: '3037', slug: 'declare-dispatch', specPath: 'backlog/3037-declare-dispatch.md', scope: ['we:scripts/operations/'] },
      briefTemplate: BRIEF,
      nextState: { tick: 1, buildGuards: [{ num: '3037', lane: 8, spawnedTick: 0 }] },
      statusLine: 'conveyor · 1 building',
      notes: [],
      bookkeepingSource: 'file',
      observedAt: new Date().toISOString(),
    }),
  }));

  const store = createFileRunStore(dir);
  let run = advanceWhileRunning(startRun({ op: DISPATCH_LANE_OP, id: RUN_ID, input: { num: '3037' }, registry }), { registry });
  expect(runStatus(run, { registry })).toBe('awaiting-effect');
  // `claude --bg` is not run on this side either; the in-flight write, the handle and the deadline are real.
  // #3331: the handle recorded is what the (faked) confirmation carries, not the minted id — `mintSessionId`
  // only feeds the ignored `--session-id` flag now.
  const sinks = createDispatchSinks({ root: PRIMARY, spawnAgent: () => bgStdout(SHORT_HANDLE), mintSessionId: () => HANDLE });
  run = (await applyPendingEffects(run, { sinks, store })).run;
  expect(run.effects[0].status).toBe('in-flight');

  // TEN MINUTES OLD by default: past `LISTING_GRACE_MS` (a just-started session is legitimately still `running`
  // even when absent), and nowhere near `STUCK_ESCALATION_HOURS`, which would make the CLI exit non-zero.
  // `ageMs` is what the escalation case dials up, so it can prove the 6h clock still bites.
  const startedAt = new Date(Date.now() - ageMs).toISOString();
  run = { ...run, effects: run.effects.map((e) => ({ ...e, startedAt })) };
  store.write(run);
  return run;
}

/**
 * Run the REAL `wake.mjs` CLI in a child whose `PATH` holds only the stub `claude`.
 *
 * NO WALL CLOCK IS RACED HERE (PR #1211 round 2, G3). The observer's `claude agents --json` read is bounded at
 * 15 seconds in production, and under the required gate's fork storm the stub's own `sh` spawn did not always
 * finish inside it: `execFileSync` SIGKILLed the stub, the observer reported an error instead of `running`, and
 * this file failed roughly one `--shard=1/2` run in five. A flaky test on the required check teaches everyone
 * to re-run instead of read, and this one's whole job is to prove a blocker fix.
 *
 * So the child sets the bound to `0`, which Node's `child_process` reads as NO TIMEOUT. That REMOVES the race
 * rather than lengthening it. The production default is untouched and is asserted, with its literal, in
 * `dispatch-lane-defaults.test.mjs`.
 */
/**
 * THE REAL CEILING ON A HANG (PR #1211 round-3 review, H4). `execFileSync` below is SYNCHRONOUS, so vitest's
 * own per-test bound (`CHILD_PROCESS_TIMEOUT_MS`) cannot interrupt it — vitest can only fail the test AFTER the
 * call already returned. Passed as `execFileSync`'s own `timeout` option, Node itself enforces this one: if the
 * child has not exited by the deadline, Node sends it `killSignal` (`SIGKILL`) and `execFileSync` throws.
 *
 * RAISED from 60s (2026-08-28), because "comfortably above every real case" stopped being true under a FULL
 * unsharded `npm run test:unit` run on a loaded machine: this genuinely healthy path (the stub `claude`/`gh` do
 * nothing but write a file and print — low-hundreds-of-ms on a quiet machine, per the wedged-kill test's own
 * comment below) was SIGKILLed by this exact 60_000ms bound three times in a row, with `stdout`/`stderr` empty —
 * proof the child was still starting up, not still working. `CHILD_PROCESS_TIMEOUT_MS` already carries the same
 * lesson once (its own history: this file's wall time went ~78s → ~512s, ~6.5x, under a sharded CI fork storm)
 * but that raise only widened the OUTER vitest bound — this INNER, Node-enforced kill never moved with it, so
 * under load it now fires FIRST and kills a slow-but-healthy child before the outer bound would even notice.
 * 100s keeps a real 20s margin below `CHILD_PROCESS_TIMEOUT_MS` (so the two still do not race — this one fires
 * first) without matching the full ~6.5x, which the wedged-child test below still bounds independently via its
 * own `WEDGED_KILL_DEADLINE_MS` override — this default governs only the healthy-path cases.
 */
const EXEC_TIMEOUT_MS = 100_000;

function runWakeCli(args = [], { agents = '[]', prs = '[]', execTimeoutMs = EXEC_TIMEOUT_MS, detached = false } = {}) {
  return execFileSync(process.execPath, [WAKE_CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: execTimeoutMs,
    killSignal: 'SIGKILL',
    // `detached` makes `node wake.mjs` the leader of its OWN process group instead of joining this test file's
    // (the default). Only the wedged-child case below needs this: `execFileSync`'s timeout only ever signals the
    // ONE pid it spawned directly, so a wedged grandchild (the stub `claude` process `wake.mjs` itself execs,
    // synchronously and with no timeout of its own) is orphaned, not killed, when that fires — and an orphaned
    // infinite loop is a real, permanent CPU leak on whatever machine runs this file. A DEDICATED group lets the
    // catch block below take the whole group out in one shot instead.
    detached,
    env: {
      HOME: process.env.HOME,
      PATH: binDir,
      OPERATION_RUNS_DIR: dir,
      STUB_AGENTS: agents,
      STUB_ARGV_FILE: argvFile,
      STUB_PRS: prs,
      STUB_GH_ARGV_FILE: ghArgvFile,
      [LIST_TIMEOUT_ENV]: '0',
      [PR_LIST_TIMEOUT_ENV]: '0',
    },
  });
}

/**
 * Generous, because every case here spawns at least one real `node` child and vitest's default per-test bound
 * is five seconds — which under a loaded shard is the OTHER way this file could go red for a reason that is
 * not a defect. THIS IS A FLOOR, NOT A CEILING (PR #1211 round-3 review, H4): it only raises vitest's own
 * per-test bound so a slow-but-healthy run under a loaded shard is not mistaken for a hang. It bounds nothing
 * about a genuine hang — `EXEC_TIMEOUT_MS` above is what does that, by being passed into `execFileSync`'s own
 * `timeout` option, which Node enforces even though the call is synchronous.
 *
 * RAISED with #x9ylkp7, which added four more child spawns to this file (two of them inside one case). Measured
 * on the required gate's `--shard=1/2`, this file's own wall time went from ~78s standalone to ~512s under the
 * fork storm — i.e. the per-case margin against the old 60s bound was thin and getting thinner. Raising this
 * bound costs only how long a slow-but-healthy run takes to be reported as passing; leaving it costs a flaky
 * required check, and a flaky required check teaches everyone to re-run instead of read.
 */
const CHILD_PROCESS_TIMEOUT_MS = 120_000;

// ── PR #1211 round-3 review, H4 — proving the ceiling is real, not merely trusted by inspection ───────────────

// Round three of this flake (CI run 31890521468, job 95025986829) falsified the previous fix's assertion in a
// THIRD, different way: the stub's marker file was PRESENT, meaning the run finished as if nothing had been
// killed. Chasing that as another timing/signal-delivery mystery (as rounds one and two each did) turned out to
// be the wrong move: local reproduction with debug instrumentation (timestamps + exit codes written by the stub
// itself, `TMPDIR`-scoped so no environment could interfere) found the REAL defect, on the FIRST local run —
// `sleep`, the command the stub used to simulate being wedged, is an EXTERNAL binary (`/bin/sleep` or
// equivalent), and this file deliberately restricts the child's `PATH` to a directory holding only the `claude`
// and `gh` stubs (`runWakeCli`'s `PATH: binDir`) — that restriction is BY DESIGN, the thing that guarantees no
// real `claude` is reachable. So `sleep N` inside the stub resolves to nothing: `sh` prints
// "sleep: command not found", exits that one statement 127, and the script falls straight through to the
// marker-file write — NOT after N seconds, but after however long the surrounding `node wake.mjs` process takes
// to start up and reach the call at all (irrelevant, low-hundreds-of-ms overhead on a quiet machine). The three
// rounds of "flakiness" were never a signal-delivery race: they were a coin flip between that overhead and
// whatever `execTimeoutMs` the assertion happened to be using that round — nothing here was ever proving a
// wedged child gets killed, on CI OR locally, and no amount of widening the OUTCOME margin (tried and verified
// to still fail — see git history) fixes a stub that was never actually blocking.
//
// THE FIX: stop depending on an external command to simulate "wedged". `while :; do :; done` is pure `sh`
// syntax (`:` is the shell no-op builtin) — it needs NOTHING on `PATH`, so it cannot silently no-op the way
// `sleep` did, and unlike `sleep N` it has NO natural completion to race against: the only way past it is a
// signal. That makes `stubRanToCompletion` a true proof of "was genuinely still wedged when killed" rather than
// a coin flip against unrelated startup overhead, and it means the margin below only has to absorb real
// scheduling/signal-delivery slack, not paper over a stub that finishes on its own.
const WEDGED_KILL_DEADLINE_MS = 1_000; // the `execFileSync` `timeout` — still 60x smaller than production's 60s
const WEDGED_OUTCOME_MARGIN_MS = 8_000; // room for CI's slower signal delivery; the loop never completes on its own

describe('a wedged `claude` is bounded by a REAL ceiling, not only by vitest\'s per-test bound', () => {
  it('is SIGKILLed once EXEC_TIMEOUT_MS is exceeded — the run terminates rather than hanging', async () => {
    await parkOneDispatch();
    // A PURE-BUILTIN INFINITE LOOP, not `sleep` (see the block comment above for why `sleep` silently no-ops
    // under this file's deliberately-restricted `PATH`). It only writes its marker file (proof of having run to
    // completion) if it ever falls out of the loop — which, needing no external command and having no timer of
    // its own, only a signal can make happen.
    const stub = join(binDir, 'claude');
    writeFileSync(
      stub,
      '#!/bin/sh\nwhile :; do :; done\nprintf \'%s\\n\' "$*" > "$STUB_ARGV_FILE"\nprintf \'%s\' "$STUB_AGENTS"\n',
    );
    chmodSync(stub, 0o755);

    const startedAt = Date.now();
    let caught;
    try {
      runWakeCli([], { agents: '[]', execTimeoutMs: WEDGED_KILL_DEADLINE_MS, detached: true });
      expect.unreachable('a wedged child must be killed, not allowed to run to completion');
    } catch (e) {
      caught = e;
    } finally {
      // GROUP-KILL, NOT JUST THE ONE PID `execFileSync`'s own timeout already signalled. `wake.mjs` is orphaned
      // by that kill, not the grandchild `claude` stub it was itself synchronously blocked on (spawnSync's
      // timeout only ever targets the pid it directly spawned) — and this stub, unlike the `sleep`-based one it
      // replaced, has no natural end, so an orphaned copy spins one CPU core forever. `detached: true` above put
      // `wake.mjs` (and everything it spawns, which inherits its process group) in a group of its own, so this
      // takes the whole thing out in one shot. `ESRCH` here means the group was already fully gone — the good
      // outcome, not an error.
      if (caught?.pid) {
        try { process.kill(-caught.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    const elapsedMs = Date.now() - startedAt;
    // THE STUB'S MARKER FILE — written only by the `printf … > "$STUB_ARGV_FILE"` line, which the loop above can
    // only reach by exiting, which it never does on its own. If that file exists, the loop was somehow escaped
    // without the kill ever landing; if it does not, the stub was still spinning when it was killed. This is a
    // DETERMINISTIC fact by the time `execFileSync` returns (SIGKILL never lets the shell reach the `printf`
    // after a genuine kill), so there is nothing to gain by polling for it.
    const stubRanToCompletion = existsSync(argvFile);

    // OBSERVABLE OUTCOME, NOT NODE'S OWN ERROR METADATA (rounds one and two of this flake, CI runs 31888620937
    // and its predecessor). `.code`/`.signal` proved unreliable twice, in two different ways, for reasons
    // neither tracing Node's C++ `spawn_sync.cc` nor deliberate local reproduction could pin down — so this
    // asserts the OUTCOME that metadata was only ever a proxy for, straight from the filesystem and the wall
    // clock:
    expect(elapsedMs).toBeLessThan(WEDGED_OUTCOME_MARGIN_MS); // the kill (or vitest's own bound) cut this short
    expect(stubRanToCompletion).toBe(false); // …and the loop was never escaped on its own

    // `.code`/`.signal` are still worth knowing WHEN a run is unhealthy — logged (never asserted) so a real
    // regression (the wedged child NOT actually being killed) still carries Node's own diagnosis alongside the
    // outcome-based proof above.
    if (elapsedMs >= WEDGED_OUTCOME_MARGIN_MS || stubRanToCompletion) {
      // eslint-disable-next-line no-console
      console.error('wedged-claude kill diagnostics (informational only, never asserted):', {
        elapsedMs, stubRanToCompletion, code: caught?.code, signal: caught?.signal,
        status: caught?.status, killed: caught?.killed, message: caught?.message,
      });
    }
  }, CHILD_PROCESS_TIMEOUT_MS);
});

describe('the waker CLI registers the dispatch observer — the half of the feature no test reached', () => {
  it('OBSERVES a parked dispatch with the real observer, not with an empty table', async () => {
    await parkOneDispatch();
    const out = runWakeCli([], { agents: JSON.stringify([{ sessionId: HANDLE, kind: 'background' }]) });

    // The session is live, so the observer says `running`. An UNREGISTERED observer cannot produce this: the
    // entry would come back `skipped` with reason `no-observer`, which is the mutation the review ran (M23).
    expect(out).toMatch(/1 run\(s\) scanned, 1 parked/);
    expect(out).toMatch(new RegExp(`still running ${KEY.replace(/[#]/g, '#')}`));
    expect(out).not.toMatch(/SKIPPED/);
    expect(out).not.toMatch(/no-observer/);
    expect(out).toMatch(/now awaiting-effect/);
    // …and the record is untouched, because a live session resolves nothing.
    expect(createFileRunStore(dir).read(RUN_ID).effects[0]).toMatchObject({ status: 'in-flight', handle: SHORT_HANDLE });
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('reads the live sessions as `claude agents --json`, and NEVER with `--all`', async () => {
    await parkOneDispatch();
    runWakeCli([], { agents: JSON.stringify([{ sessionId: HANDLE }]) });
    // The argv the CLI actually handed `claude`, recorded by the stub across a real process boundary.
    expect(readFileSync(argvFile, 'utf8').trim()).toBe('agents --json');
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('a session that is GONE is reported for a person, and the line NAMES the close-out command', async () => {
    await parkOneDispatch();
    const out = runWakeCli([], { agents: '[]' });
    expect(out).toMatch(/NEEDS A PERSON/);
    expect(out).toMatch(/liveness and not outcome/);
    expect(out).toMatch(new RegExp(`wake\\.mjs --resolve=${RUN_ID} --key=<effectKey>`));
    // `unresolved` WRITES NOTHING — the entry is still in flight, which is why a close-out surface has to exist.
    expect(createFileRunStore(dir).read(RUN_ID).effects[0].status).toBe('in-flight');
  }, CHILD_PROCESS_TIMEOUT_MS);
});

// ── #x9ylkp7 — the PR axis, across the same real process boundary ────────────────────────────────────────────

describe('the waker CLI reads the PR axis too — the half that can finally answer `succeeded`', () => {
  it('reads the PRs as `gh pr list --state all --json …headRefName`, and the query is pinned HERE too', async () => {
    // The discovery query fails SILENTLY when it is wrong — an empty page is by design indistinguishable from
    // "no PR yet" — so it is pinned in-process (`dispatch-lane-defaults.test.mjs`) AND across the boundary the
    // CLI actually crosses, exactly as the `claude agents --json` argv is.
    await parkOneDispatch();
    runWakeCli([], { agents: '[]' });
    expect(readFileSync(ghArgvFile, 'utf8').trim())
      .toBe(`pr list --state all --limit ${PR_LIST_LIMIT} --json ${PR_LIST_JSON_FIELDS}`);
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('a MERGED PR for the item RESOLVES the entry with no person — and the next pass no longer reports it', async () => {
    // The item's whole purpose: before this, a finished build was re-reported on every pass forever, and past
    // `STUCK_ESCALATION_HOURS` the waker exited non-zero on every pass until someone closed it out by hand.
    const run = await parkOneDispatch();
    const out = runWakeCli([], {
      agents: '[]', // the session is already gone — liveness alone would say `unresolved`
      prs: JSON.stringify([{
        number: 4242,
        headRefName: 'lane/3037-declare-dispatch',
        state: 'MERGED',
        // AFTER this entry's `startedAt`, which is what makes it attributable to THIS dispatch.
        mergedAt: new Date(Date.parse(run.effects[0].startedAt) + 60_000).toISOString(),
        labels: [],
      }]),
    });
    expect(out).toMatch(/resolved .*→succeeded/);
    expect(out).not.toMatch(/NEEDS A PERSON/);
    const entry = createFileRunStore(dir).read(RUN_ID).effects[0];
    expect(entry.status).toBe('applied');
    expect(entry.result).toMatchObject({ resolvedBy: 'pr-merged', pr: 4242 });
    // AND THE WEDGE IS GONE without anybody touching `--resolve`.
    expect(runWakeCli([], { agents: '[]' })).toMatch(/none parked on a dispatch/);
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('a PARKED PR still needs a person — terminal-looking is not the same as finished', async () => {
    await parkOneDispatch();
    const out = runWakeCli([], {
      agents: '[]',
      prs: JSON.stringify([{ number: 4243, headRefName: 'lane/3037-declare-dispatch', state: 'OPEN', mergedAt: null, labels: [{ name: 'review:pending' }] }]),
    });
    expect(out).toMatch(/NEEDS A PERSON/);
    expect(out).toMatch(/PARKED for review/);
    expect(createFileRunStore(dir).read(RUN_ID).effects[0].status).toBe('in-flight');
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('an entry that never reaches a PR still ESCALATES at 6h — the clock is untouched by the new axis', async () => {
    // The dominant case until real dispatch lands, and the one this item must not quietly change: no PR means
    // no verdict from the PR axis, so the entry follows exactly the path it followed before — reported, then
    // escalated past `STUCK_ESCALATION_HOURS` with a non-zero exit for whatever is watching exit codes.
    await parkOneDispatch({ ageMs: 7 * 60 * 60 * 1000 });
    let stdout = '';
    try {
      runWakeCli([], { agents: '[]', prs: '[]' });
      expect.unreachable('a run stuck past the escalation threshold must exit non-zero');
    } catch (e) {
      stdout = String(e.stdout || '');
      expect(e.status).toBe(1);
    }
    expect(stdout).toMatch(/ESCALATED — /);
    expect(stdout).toMatch(/has been unresolved for 7\.\dh \(over 6h\)/);
    expect(createFileRunStore(dir).read(RUN_ID).effects[0].status).toBe('in-flight');
  }, CHILD_PROCESS_TIMEOUT_MS);
});

describe('--resolve closes an in-flight entry out — the way out of a dispatch the observer can never settle', () => {
  it('records the operator\'s verdict on the entry and un-parks the run', async () => {
    await parkOneDispatch();
    const out = runWakeCli([`--resolve=${RUN_ID}`, `--key=${KEY}`, '--status=failed', '--note=the build never opened a PR']);
    expect(out).toMatch(new RegExp(`${RUN_ID}:${KEY.replace(/[#]/g, '#')} closed out as .failed.`));
    const entry = createFileRunStore(dir).read(RUN_ID).effects[0];
    expect(entry.status).toBe('failed');
    expect(entry.error).toMatch(/never opened a PR/);

    // AND THE WEDGE IS GONE: the next pass no longer sees the run parked at all, which is the whole remedy.
    expect(runWakeCli([], { agents: '[]' })).toMatch(/none parked on a dispatch/);
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('reports a refused close-out on stdout and exits non-zero rather than failing silently', async () => {
    await parkOneDispatch();
    // ONE child covers the CLI's own error path; the refusal RULES are `resolveInFlight`'s and are asserted
    // in-process below, because a `node` spawn per case costs seconds and proves nothing extra.
    let stdout = '';
    try { runWakeCli([`--resolve=${RUN_ID}`, `--key=${KEY}`, '--status=maybe']); expect.unreachable('must exit non-zero'); } catch (e) {
      stdout = String(e.stdout || '');
      expect(e.status).toBe(1);
    }
    expect(stdout).toMatch(/terminal status/);
    expect(createFileRunStore(dir).read(RUN_ID).effects[0].status).toBe('in-flight');
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('refuses an incomplete or unknown close-out rather than guessing', async () => {
    const run = await parkOneDispatch();
    const store = { read: (id) => (id === RUN_ID ? run : null), write: () => { throw new Error('must not write'); } };
    expect(() => closeOutEntry({ runId: RUN_ID, status: 'failed', store })).toThrow(/needs both --resolve=<runId> and --key=/);
    expect(() => closeOutEntry({ runId: 'nope', key: KEY, status: 'failed', store })).toThrow(/no run record for/);
    expect(() => closeOutEntry({ runId: RUN_ID, key: 'not-a-key', status: 'failed', store })).toThrow(/has no effect/);
    expect(() => closeOutEntry({ runId: RUN_ID, key: KEY, status: 'maybe', store })).toThrow(/terminal status/);
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('parses the flags the way the CLI branch reads them', () => {
    // `--resolve` PRESENT WITH NO VALUE must still take the close-out branch (and then refuse), rather than
    // silently falling through to a full waking pass the operator did not ask for.
    expect(flagValue(['--resolve=r1', '--key=k'], 'resolve')).toBe('r1');
    expect(flagValue(['--resolve'], 'resolve')).toBe('');
    expect(flagValue(['--key=k'], 'resolve')).toBeUndefined();
    expect(flagValue(['--note=a=b'], 'note')).toBe('a=b');
    // `--force` takes no value, so PRESENCE is what the CLI branch reads.
    expect(flagValue(['--force'], 'force')).toBe('');
    expect(flagValue([], 'force')).toBeUndefined();
  });
});

// ── PR #1211 round 2, G2 — an escape hatch must not destroy the evidence of what it escaped from ────────────
//
// `--resolve --status=failed` on a LIVE five-minute-old entry used to: un-park the run, hand it to the
// executor's uncapped retry, start a SECOND agent under the same deterministic session slug — and overwrite
// the first agent's handle in place, so `sess-1` existed nowhere on the record and neither the observer nor a
// second `--resolve` could ever reach it. Two live agents, one lane, one of them on the books.

describe('--resolve refuses a LIVE handle, and a retry never orphans the handle it supersedes', () => {
  it('G2: refuses to close out an entry `claude agents` still lists, and writes NOTHING', async () => {
    await parkOneDispatch();
    let stdout = '';
    try {
      runWakeCli([`--resolve=${RUN_ID}`, `--key=${KEY}`, '--status=failed'], {
        agents: JSON.stringify([{ sessionId: HANDLE, kind: 'background' }]),
      });
      expect.unreachable('closing out a live dispatch must be refused');
    } catch (e) {
      stdout = String(e.stdout || '');
      expect(e.status).toBe(1);
    }
    expect(stdout).toMatch(/STILL LISTED by `claude agents`/);
    expect(stdout).toMatch(/--force/);
    // THE ENTRY IS UNTOUCHED, which is the half that matters: a refusal that had already written would have
    // handed the run to the retry anyway.
    expect(createFileRunStore(dir).read(RUN_ID).effects[0]).toMatchObject({ status: 'in-flight', handle: SHORT_HANDLE });
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('G2: `--force` gets through, and says on the line that liveness was not checked', async () => {
    await parkOneDispatch();
    const out = runWakeCli([`--resolve=${RUN_ID}`, `--key=${KEY}`, '--status=failed', '--force'], {
      agents: JSON.stringify([{ sessionId: HANDLE }]),
    });
    expect(out).toMatch(/liveness not checked/);
    expect(createFileRunStore(dir).read(RUN_ID).effects[0].status).toBe('failed');
  }, CHILD_PROCESS_TIMEOUT_MS);

  it('G2: an UNREADABLE listing refuses too — it is not evidence the agent died', () => {
    // Fail closed, with the door one flag away. Reading "cannot check" as "not running" is the same mistake as
    // reading an aged-out clock as "finished or died", one layer up.
    const entry = { handle: 'sess-1' };
    expect(() => assertHandleNotLive(entry, { listAgents: () => { throw new Error('spawn claude ENOENT'); } }))
      .toThrow(/MIGHT be alive/);
    expect(() => assertHandleNotLive(entry, { listAgents: () => ({}) })).toThrow(/MIGHT be alive/);
    expect(() => assertHandleNotLive(entry, { listAgents: () => [{ sessionId: 'sess-1' }] })).toThrow(/STILL LISTED/);
    // A listing that WAS read and does not carry the handle passes, and so does a handle-less INDETERMINATE
    // entry — the case where a person has nothing to check and is exactly who this surface exists for.
    expect(() => assertHandleNotLive(entry, { listAgents: () => [{ sessionId: 'someone-else' }] })).not.toThrow();
    expect(() => assertHandleNotLive({ handle: null }, { listAgents: () => { throw new Error('never called'); } })).not.toThrow();
  });

  it('G2: a retried dispatch KEEPS the superseded handle, so the first agent is still findable', async () => {
    // The other half of the same defect, and the one that made it unrecoverable rather than merely wrong. The
    // pre-sink write blanks `handle` so the new session's id can land there; without `supersededHandles` the
    // first agent's id existed nowhere on the record.
    const run = await parkOneDispatch();
    const store = createFileRunStore(dir);
    // Close it out under --force, exactly as an operator who was sure would — then let the retry run.
    closeOutEntry({ runId: RUN_ID, key: KEY, status: 'failed', force: true, store });
    const sinks = createDispatchSinks({ root: PRIMARY, spawnAgent: () => bgStdout('a2a2a2a2'), mintSessionId: () => 'sess-2' });
    const after = (await applyPendingEffects(store.read(RUN_ID), { sinks, store })).run;

    const entry = after.effects[0];
    expect(entry.handle).toBe('a2a2a2a2');
    expect(entry.status).toBe('in-flight');
    // sess-1 IS STILL FINDABLE — the whole point. The review's reproduction asked exactly this question of the
    // record and got `false`. #3331: the superseded handle is the SHORT id `parkOneDispatch`'s sink actually
    // recorded, not the full `HANDLE` it minted (which was never what got stored).
    expect(entry.supersededHandles.map((h) => h.handle)).toEqual([SHORT_HANDLE]);
    expect(JSON.stringify(store.read(RUN_ID))).toContain(SHORT_HANDLE);
  }, CHILD_PROCESS_TIMEOUT_MS);
});
