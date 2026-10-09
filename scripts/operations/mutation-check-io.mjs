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

export function runSuite({ cwd, suite, run, maxFailures = 20, timeoutMs = 0 }) {
  let out = '';
  let ok = false;
  // #5466 — a suite may be several test files (the revert-red check runs exactly the files a fix added or changed).
  const files = Array.isArray(suite) ? suite : [suite];
  try {
    // xaipsbs — through the host admission pool; the wrapper's stdout/stderr/exit code are vitest's own.
    const admitted = admittedArgv('npx', ['vitest', 'run', ...files, '--reporter=basic']);
    // #5466 — an optional ceiling: a run killed by it produces no summary line, so it reads as `ran: false` (unproven).
    out = String(run(admitted.file, admitted.args, { cwd, encoding: 'utf8', ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}) }) ?? '');
    ok = true;
  } catch (e) {
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
  const ran = !noFiles && Boolean(summary || fileSummary);
  const failed = /\bfailed\b/i.test(summary) || /\bfailed\b/i.test(fileSummary);
  const allFailures = [...new Set([...out.matchAll(/^\s*(?:FAIL|×)\s+(.+?)\s*$/gm)].map((m) => m[1]))];
  return {
    ran,
    green: ran && ok && !failed,
    // The named tests that went red, so a `killed` verdict can say WHICH guard caught the mutant rather than
    // merely that something did.
    failures: allFailures.slice(0, maxFailures),
    // Said, never inferred: a reader attributing failures per test must know the list was cut.
    failuresTruncated: allFailures.length > maxFailures,
    detail: noFiles ? `no test files matched ${files.join(' ')}` : (summary || fileSummary || 'no summary line'),
  };
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

    let restored = false;
    let mutant = { ran: false, green: false, failures: [], detail: '' };
    try {
      write(abs, original.split(find).join(replace));
      mutant = runSuite({ cwd, suite, run });
    } finally {
      // ALWAYS, and VERIFIED. `restored` is the re-read comparison, not the fact that a write was attempted.
      try {
        write(abs, original);
        restored = read(abs) === original;
      } catch {
        restored = false;
      }
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
        restored: true, detail: baseline.detail };
    }

    let restored = false;
    let mutant = { ran: false, green: false, failures: [], failuresTruncated: false, detail: '' };
    try {
      for (const o of originals) write(o.abs, o.revert);
      mutant = runSuite({ cwd, suite, run, maxFailures, timeoutMs });
    } finally {
      restored = true;
      for (const o of originals) {
        try {
          write(o.abs, o.original);
          if (read(o.abs) !== o.original) restored = false;
        } catch {
          restored = false;
        }
      }
    }
    return {
      ...base, applied: true, occurrences: list.length, baselineRan: true, baselineGreen: true,
      mutantRan: mutant.ran, mutantGreen: mutant.green, killedBy: mutant.failures,
      failuresTruncated: mutant.failuresTruncated === true, restored, detail: mutant.detail,
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
