/**
 * @file scripts/operations/mutation-check-io.mjs
 * @description THE IO SHELL of the `mutation-check` declaration (#x4omld5) — the mutate → run → restore
 *   transaction its `probe` step is injected with.
 *
 * THIS FILE DELIBERATELY SABOTAGES A SOURCE FILE, so the restore is the most important thing in it and is
 * structured accordingly: the original bytes are captured BEFORE the write, and the restore runs in a
 * `finally` that no branch above can skip. The hand-rolled version of this procedure was a `python` heredoc
 * that copied to `/tmp` and copied back on the last line — a run that died in between (a killed process, a
 * container restart, a `pkill` that matched too broadly) left the mutant in the tree, which is exactly the
 * kind of failure that then gets diagnosed for an hour as a real bug.
 *
 * THE RESTORE IS VERIFIED, NOT ASSUMED. After writing the original bytes back it RE-READS the file and
 * compares. `restored` in the result is that comparison, not the fact that a write was attempted, because a
 * write that throws or half-succeeds is precisely when the caller most needs to be told the tree is dirty.
 *
 * EVERY SIDE EFFECT IS INJECTED — `read`, `write` and `run`. The lesson is #1497's: a sink that injected only
 * its subprocess runner still called the real `mkdirSync`, which succeeded silently as root and failed
 * `EACCES` in CI. A partially-injected shell is how a test suite goes green over code that genuinely wrote
 * outside its fixture.
 *
 * IMPURE by construction: `fs`, subprocess.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MUTATION_PROBE_EFFECT, REVERT_RED_PROBE_EFFECT } from './mutation-check.mjs';
import { admittedArgv } from '../readiness/heavy-admission.mjs';

/**
 * Run one suite and say whether it went green — and, separately, whether it RAN AT ALL.
 *
 * THE TWO ARE NOT THE SAME QUESTION and collapsing them is the bug this whole operation exists to prevent one
 * level up. A non-zero exit means "not green"; it does NOT distinguish a test that failed from a runner that
 * could not start (missing dependency, bad path, a suite name matching nothing). So `ran` is decided by
 * whether the runner produced a parseable result line, never by the exit code alone.
 *
 * A vitest run that matches NO test files exits non-zero and reports "No test files found" — which must be
 * `ran: false`, because a suite that does not exist cannot kill a mutant, and reporting it as a failing suite
 * would read as a killed mutant.
 */
/**
 * Strip ANSI escapes before matching — belt-and-braces for a coloured runner, NOT the fix for anything
 * observed. It was added as a guess at why `killedBy` came back empty; the real cause was the stream
 * short-circuit documented below. Kept because a TTY-attached run would colour the marker, but it is not
 * load-bearing and no test depends on it.
 */
const stripAnsi = (s) => s.replace(/\[[0-9;]*[A-Za-z]/g, '');

/**
 * #5466 — the run ceiling, applied INSIDE the admitted command. A `timeout` on the admission wrapper's own process would
 * also count the time the run spent queued for a heavy-pool slot (verify normally waits behind other heavy work), so a
 * healthy fix could be called "unrun" without its tests ever starting. The wrapper starts this shim only once a slot is
 * granted, so the clock starts then. The shim runs the command in its own process group and kills the WHOLE group on the
 * ceiling (or on SIGTERM/SIGINT/SIGHUP to itself): vitest's workers must not keep running against a tree that is about to
 * be restored. It exits 124 and writes {@link BOUNDED_RUN_MARKER} to stderr so the caller can tell a ceiling from a crash.
 * One line, no single quotes: the wrapper re-quotes its argv into a shell command.
 */
export const BOUNDED_RUN_MARKER = 'revert-red-timeout:';
/** Output cap for one captured test run (a broad fix's reverted run can print tens of thousands of FAIL lines). */
const RUN_MAX_BUFFER = 64 * 1024 * 1024;
export const BOUNDED_RUN_SHIM = [
  'const{spawn}=require("node:child_process");const{argv,ms}=JSON.parse(process.argv[1]);',
  'const c=spawn(argv[0],argv.slice(1),{stdio:"inherit",detached:true});',
  'const kill=()=>{try{process.kill(-c.pid,"SIGKILL")}catch{}};',
  `const t=setTimeout(()=>{process.stderr.write("${BOUNDED_RUN_MARKER} run exceeded "+ms+"ms and was killed\\n");kill()},ms);`,
  'for(const s of["SIGTERM","SIGINT","SIGHUP"])process.on(s,()=>{kill();process.exit(143)});',
  // A shim whose parent died (a SIGKILLed wrapper cannot forward a signal) would leave vitest running on a tree that is
  // about to be restored: when the parent changes, kill the group.
  'const ppid=process.ppid;const w=setInterval(()=>{if(process.ppid!==ppid){kill();process.exit(143)}},1000);w.unref();',
  'c.on("error",()=>{clearTimeout(t);process.exit(127)});',
  'c.on("exit",(code)=>{clearTimeout(t);process.exit(code??124)});',
].join('');

export function runSuite({ cwd, suite, run, maxFailures = 20, timeoutMs = 0 }) {
  let out = '';
  let ok = false;
  let exitStatus;
  let bufferCut = false;
  // #5466 — a suite may be several test files (the revert-red check runs exactly the files a fix added or changed).
  const files = Array.isArray(suite) ? suite : [suite];
  try {
    const vitest = ['npx', 'vitest', 'run', ...files, '--reporter=basic'];
    // xaipsbs — through the host admission pool; the wrapper's stdout/stderr/exit code are vitest's own.
    // #5466 — an optional ceiling, carried inside the admitted command (see BOUNDED_RUN_SHIM): a run killed by it
    // produces no summary line, so it reads as `ran: false` (unproven), and says so by name (`timedOut`).
    const admitted = timeoutMs > 0
      ? admittedArgv(process.execPath, ['-e', BOUNDED_RUN_SHIM, JSON.stringify({ argv: vitest, ms: timeoutMs })])
      : admittedArgv(vitest[0], vitest.slice(1));
    // maxBuffer: execFileSync's 1 MiB default cuts a large red run's FAIL list short, which would read as tests that
    // stayed green. A cut that still happens is said (`bufferCut` → failuresTruncated), never silent.
    out = String(run(admitted.file, admitted.args, { cwd, encoding: 'utf8', maxBuffer: RUN_MAX_BUFFER }) ?? '');
    ok = true;
  } catch (e) {
    exitStatus = e?.status;
    bufferCut = e?.code === 'ENOBUFS';
    // Non-zero exit is the NORMAL path for a red suite — the output is on the error, and it is the output
    // that decides `ran`.
    //
    // BOTH STREAMS, CONCATENATED — never `stdout || stderr`. vitest splits its output: the `Tests …` summary
    // goes to stdout while the `FAIL <file> > <name>` block goes to stderr. A `||` short-circuits on the
    // non-empty stdout and never reads stderr, so `ran` and `green` came out right while `killedBy` was
    // silently ALWAYS EMPTY — the verdict's claim to name the guard that caught the mutant was untrue next to
    // an outcome that looked correct. Two wrong theories preceded this one (ANSI escapes, then the anchor);
    // what settled it was printing the captured streams instead of reasoning about them.
    out = [e?.stdout, e?.stderr].map((s) => String(s ?? '')).filter(Boolean).join('\n')
      || String(e?.message ?? '');
  }
  out = stripAnsi(out);
  const noFiles = /No test files found/i.test(out);
  const summary = out.match(/Tests\s+(.*)$/m)?.[1] ?? '';
  const fileSummary = out.match(/Test Files\s+(.*)$/m)?.[1] ?? '';
  // RAN means the runner reported on tests. Either summary line is proof it got that far.
  // A killed run can still have printed a partial summary; the ceiling's own marker outranks it.
  // The marker alone is not enough (a failing assertion diff can print any text): the shim also exits 124.
  const timedOut = timeoutMs > 0 && exitStatus === 124 && out.includes(BOUNDED_RUN_MARKER);
  const ran = !noFiles && !timedOut && Boolean(summary || fileSummary);
  const failed = /\bfailed\b/i.test(summary) || /\bfailed\b/i.test(fileSummary);
  const allFailures = [...new Set([...out.matchAll(/^\s*(?:FAIL|×)\s+(.+?)\s*$/gm)].map((m) => m[1]))];
  return {
    ran,
    timedOut,
    green: ran && ok && !failed,
    // The named tests that went red, so a `killed` verdict can say WHICH guard caught the mutant rather than
    // merely that something did.
    failures: allFailures.slice(0, maxFailures),
    // Said, never inferred: a reader attributing failures per test must know the list was cut.
    failuresTruncated: allFailures.length > maxFailures || bufferCut,
    detail: noFiles ? `no test files matched ${files.join(' ')}` : timedOut ? `the run exceeded its ${timeoutMs}ms ceiling and was killed` : (summary || fileSummary || 'no summary line'),
  };
}

/**
 * Write `text` over `abs` only while the file still holds what THIS transaction last put there (`expected`). Anything else
 * means someone else edited it since — their work is left alone and the caller is told (`restored: false`) so the next
 * verify, not this one, deals with it. A write that itself threw (`touched`) may have left partial bytes, so it restores
 * unconditionally. Never throws.
 * @returns {boolean} true when the file now holds `text`.
 */
function restoreUnlessMovedOn({ read, write, abs, text, expected, touched }) {
  try {
    const now = read(abs);
    if (now === text) return true;
    if (!touched && now !== expected) return false;
    write(abs, text);
    return read(abs) === text;
  } catch {
    return false;
  }
}

/**
 * The transaction. Capture → mutate → run → RESTORE (always) → verify the restore.
 *
 * The baseline runs BEFORE the mutation rather than after, so a suite that was already red is discovered
 * without having touched the file at all — cheaper, and it means the failure mode "we sabotaged your tree to
 * learn something we could have learned first" cannot happen.
 */
export function createMutationProbe({
  read = (p) => readFileSync(p, 'utf8'),
  write = (p, s) => writeFileSync(p, s),
  run = execFileSync,
} = {}) {
  return ({ cwd, target, find, replace, suite }) => {
    const abs = join(cwd, target);
    const original = read(abs);
    const occurrences = original.split(find).length - 1;

    // NOTHING TO MUTATE — return before touching anything. `applied: false` is what makes the declaration
    // report `unrun/not-applied` instead of certifying a guard against an unmodified file.
    if (occurrences === 0) {
      return {
        target, suite, applied: false, occurrences: 0,
        baselineRan: false, baselineGreen: false, mutantRan: false, mutantGreen: false,
        restored: true, // nothing was written, so the tree is clean by construction
        detail: `the \`find\` text was not present in ${target}`,
      };
    }

    // BASELINE FIRST, on the untouched file.
    const baseline = runSuite({ cwd, suite, run });
    if (!baseline.ran || !baseline.green) {
      return {
        target, suite, applied: false, occurrences,
        baselineRan: baseline.ran, baselineGreen: baseline.green,
        mutantRan: false, mutantGreen: false,
        restored: true, // still untouched
        detail: baseline.detail,
      };
    }

    // The baseline run took time; the file may have been edited meanwhile. Writing the mutant over that edit (and then the
    // captured original over it again) would silently destroy someone's work — refuse and leave the file as it is.
    if (read(abs) !== original) {
      return {
        target, suite, applied: false, occurrences,
        baselineRan: true, baselineGreen: true, mutantRan: false, mutantGreen: false,
        restored: true, // nothing of ours was written
        driftedDuringBaseline: true,
        detail: `${target} changed while the baseline ran; nothing was mutated`,
      };
    }

    let restored = false;
    let mutant = { ran: false, green: false, failures: [], detail: '' };
    const mutated = original.split(find).join(replace);
    let writeThrew = false;
    try {
      try { write(abs, mutated); } catch (error) { writeThrew = true; throw error; }
      mutant = runSuite({ cwd, suite, run });
    } finally {
      // ALWAYS, and VERIFIED. `restored` is the re-read comparison, not the fact that a write was attempted — and a file
      // someone else changed while the mutant ran is left alone (and reported), never overwritten.
      restored = restoreUnlessMovedOn({ read, write, abs, text: original, expected: mutated, touched: writeThrew });
    }

    return {
      target, suite, applied: true, occurrences,
      baselineRan: true, baselineGreen: true,
      mutantRan: mutant.ran, mutantGreen: mutant.green,
      killedBy: mutant.failures,
      restored,
      detail: mutant.detail,
    };
  };
}

/**
 * #5466 — THE REVERT TRANSACTION: the same capture → mutate → run → RESTORE (always) → verify shape as
 * {@link createMutationProbe}, over SEVERAL files at once, each replaced whole by its pre-fix content. Used by the
 * revert-red check: put the fix's source changes back out, keep its tests, and see which tests go red.
 *
 * Why not N single-file probes: a fix that spans two files is only reverted when both are, and the run must see both
 * at once. Why whole-file replacement and not `find`: the pre-fix content IS the exact mutant. `occurrences` is the
 * number of files to revert; it is 0 (nothing touched, `not-applied`) when the list is empty or any file no longer
 * holds the fixed content.
 *
 * Restore is per file, in a `finally`, and VERIFIED by re-reading every one; `restored` is true only when all match.
 */
export function createRevertProbe({
  read = (p) => readFileSync(p, 'utf8'),
  write = (p, s) => writeFileSync(p, s),
  run = execFileSync,
  maxFailures = 200,
  // A reverted fix for a hang can hang: bounded, so the tree is restored in time rather than by an outer kill.
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  return ({ cwd, targets = [], suite = [] }) => {
    const list = Array.isArray(targets) ? targets : [];
    const names = list.map((t) => t.target);
    const base = {
      target: names.join(','), suite: (Array.isArray(suite) ? suite : [suite]).join(' '),
      mutantRan: false, mutantGreen: false, killedBy: [], failuresTruncated: false,
    };
    if (list.length === 0) {
      return { ...base, applied: false, occurrences: 0, baselineRan: false, baselineGreen: false, restored: true, detail: 'no file to revert' };
    }
    // Capture every original BEFORE anything is written, and refuse unless each file still holds the fixed content.
    const originals = list.map((t) => ({ abs: join(cwd, t.target), target: t.target, original: read(join(cwd, t.target)), fixed: t.fixed, revert: t.revert }));
    const drifted = originals.filter((o) => typeof o.fixed === 'string' && o.original !== o.fixed).map((o) => o.target);
    if (drifted.length) {
      return { ...base, applied: false, occurrences: 0, baselineRan: false, baselineGreen: false, restored: true,
        detail: `the working tree no longer holds the fixed content of ${drifted.join(', ')}` };
    }

    const baseline = runSuite({ cwd, suite, run, maxFailures, timeoutMs });
    if (!baseline.ran || !baseline.green) {
      return { ...base, applied: false, occurrences: list.length, baselineRan: baseline.ran, baselineGreen: baseline.green,
        baselineTimedOut: baseline.timedOut === true, restored: true, detail: baseline.detail };
    }

    // The baseline run took time, and nothing owns the checkout while it does. A target edited meanwhile holds someone
    // else's work: the revert would overwrite it and the restore would then put the STALE original over it. Re-read every
    // target and refuse (writing nothing) unless each still holds exactly what was captured.
    const moved = originals.filter((o) => { try { return read(o.abs) !== o.original; } catch { return true; } }).map((o) => o.target);
    if (moved.length) {
      return { ...base, applied: false, occurrences: list.length, baselineRan: true, baselineGreen: true, restored: true,
        driftedDuringBaseline: true, detail: `${moved.join(', ')} changed while the baseline ran; nothing was reverted` };
    }

    let restored = false;
    let mutant = { ran: false, green: false, failures: [], failuresTruncated: false, detail: '' };
    const writeThrew = new Set();
    try {
      for (const o of originals) {
        try { write(o.abs, o.revert); } catch (error) { writeThrew.add(o.target); throw error; }
      }
      mutant = runSuite({ cwd, suite, run, maxFailures, timeoutMs });
    } catch (error) {
      // A revert write that threw part-way is a run that never happened, not a lost restore: the finally below puts every
      // file back and VERIFIES it, and `restored` says what it found.
      mutant = { ran: false, green: false, failures: [], failuresTruncated: false, detail: `the revert could not be applied: ${String(error?.message ?? error)}` };
    } finally {
      restored = true;
      for (const o of originals) {
        // Only a file still holding what we wrote is put back; one someone else changed meanwhile is left alone and reported.
        if (!restoreUnlessMovedOn({ read, write, abs: o.abs, text: o.original, expected: o.revert, touched: writeThrew.has(o.target) })) restored = false;
      }
    }
    return {
      ...base, applied: true, occurrences: list.length, baselineRan: true, baselineGreen: true,
      mutantRan: mutant.ran, mutantGreen: mutant.green, killedBy: mutant.failures,
      failuresTruncated: mutant.failuresTruncated === true, mutantTimedOut: mutant.timedOut === true, restored, detail: mutant.detail,
    };
  };
}

/**
 * The sink that applies the `mutation-check.probe` effect.
 *
 * The engine records an effect's return value as the step's finding, so the transaction's result reaches
 * `assess` through the normal path — no second channel, and the declaration stays unable to reach the world.
 */
export function createMutationCheckSinks(deps = {}) {
  const probe = createMutationProbe(deps);
  return {
    [MUTATION_PROBE_EFFECT]: async (payload) => probe(payload),
  };
}

/**
 * #5466 — the sink for `revert-red-check`: plan the revert from git, run {@link createRevertProbe}, judge it with the
 * pure rule. The git reads go through the injected `git` runner (a lane is agent-writable: callers pass a hardened one).
 */
export function createRevertRedCheckSinks(deps = {}) {
  return {
    [REVERT_RED_PROBE_EFFECT]: async (payload) => {
      const { runRevertRedCheck } = await import('../lib/verify-revert-red.mjs');
      return runRevertRedCheck({ ...payload, probe: createRevertProbe(deps), git: deps.git });
    },
  };
}
