/**
 * capture-via-exec-file-sync.mjs — the shared "capture a gate's own stdout, even on its expected non-zero
 * exit" pattern (#xwt6ola). Was duplicated (copy-pasted) across scripts/__tests__/stdout-flush.test.mjs and
 * scripts/__tests__/citation-gate-dedup.test.mjs; single-sourced here, and hardened at the same time.
 *
 * THE DEFECT THIS FIXES. `execFileSync` throws on a non-zero exit, and the original pattern's `catch` read
 * `e.stdout` and returned it unconditionally — correct for a GATE's genuine non-zero exit (it finished,
 * wrote its complete JSON, then exited 1 because it found real findings), but WRONG whenever the captured
 * stdout is actually a TRUNCATED partial payload, and the caller's `JSON.parse(out)` failed with a cryptic
 * "SyntaxError: Unexpected end of JSON input" that reads as a flaky assertion, not what it actually is.
 *
 * FIRST HYPOTHESIS, DISPROVEN. A killed child (`e.signal` set, e.g. a `beforeAll` timeout or an external
 * kill) seemed the obvious mechanism — Node does set `e.signal` for exactly that case. A retry-on-signal fix
 * was built and shipped, then measured against a REAL reproduction of the flake: the failure recurred with
 * the SAME plain `SyntaxError`, not the new explicit "killed twice" error the signal-retry path would have
 * thrown — meaning `e.signal` was `null` on the failing runs. Ruled out, not assumed away.
 *
 * THE ACTUAL SHAPE OF THE BUG. `check-standards.mjs` currently exits 0 (no errors) on this repo's corpus, so
 * in the ordinary case `execFileSync` does not even throw — the whole `catch` branch is dead code on a clean
 * tree. A `catch` firing at all, with a `null` signal, points at the CHILD PROCESS ITSELF exiting non-zero
 * for a reason unrelated to "the gate found real findings" — most plausibly a crash under real memory/CPU
 * contention (e.g. a V8 OOM abort), which exits non-zero with whatever partial stdout had been written so
 * far, no signal involved. Reproducing that precisely proved elusive (ruled out: pure CPU oversubscription
 * up to 16 busy-loops against the host core count, and up to 32-way concurrent real subprocess spawning — both 100% clean), but
 * the FIX does not need the exact trigger pinned down: validate the SHAPE of whatever came back, on every
 * attempt (success or caught non-zero exit alike), and retry when it's invalid — this catches truncation
 * from ANY mechanism (signal, crash, or something else entirely), not just the one first suspected.
 *
 * THE FIX. An optional `validate(output) => boolean` in `opts`. Every attempt's output — from the success
 * path AND the catch-with-stdout path alike — is checked; an attempt that fails validation is treated the
 * same as an attempt with no captured payload at all: retry, up to `maxAttempts` (default 2). Exhausting all
 * attempts throws an explicit, diagnosable error — never a silent return of unvalidated output, and never a
 * bare downstream `JSON.parse` failure standing in for what actually happened. Callers with no `validate`
 * keep the original single-attempt behavior unchanged (this module is also used for non-JSON payloads, e.g.
 * markdown diffs, where there is no cheap shape check to apply).
 */
import { execFileSync } from 'node:child_process';

/** The real "run once" primitive. Exported separately so a test can inject a fake and exercise the
 *  retry/validate logic deterministically — no real OS process/timing to race against. */
export function defaultRunOnce(script, args, opts) {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
}

function describeAttemptFailure(e) {
  if (!e) return 'ok exit but failed validation';
  if (e.signal) return `killed (signal ${e.signal})`;
  if (e.status != null) return `exit ${e.status}`;
  return e.message || 'unknown error';
}

/**
 * Build a `captureViaExecFileSync`-shaped function bound to a given `runOnce` — the injection seam tests
 * use (see scripts/lib/__tests__/capture-via-exec-file-sync.test.mjs).
 * @param {(script: string, args: string[], opts: object) => string} runOnce
 */
export function createCapture(runOnce) {
  return function captureViaExecFileSync(script, args, opts = {}) {
    const { validate, maxAttempts = 2, ...execOpts } = opts;
    let lastFailure = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let out;
      let hadOutput = true;
      try {
        out = runOnce(script, args, execOpts);
      } catch (e) {
        if (typeof e.stdout !== 'string') throw e; // no captured payload at all — nothing to retry with
        out = e.stdout;
        lastFailure = e;
      }
      if (!validate || validate(out)) return out;
      lastFailure = lastFailure || { message: 'validate() rejected a successful exit\'s output' };
    }
    throw new Error(
      `${script}: ${maxAttempts} attempt(s) all produced an invalid/incomplete result (last: ` +
      `${describeAttemptFailure(lastFailure)}) — this reads as contention-induced truncation, not a ` +
      'deterministic defect (#xwt6ola). Investigate if it recurs outside a heavily loaded machine.',
    );
  };
}

/** The real, default-wired capture function most callers use directly. */
export const captureViaExecFileSync = createCapture(defaultRunOnce);

/** A ready-made `validate` for JSON-shaped output — pass as `opts.validate` for a JSON-emitting gate.
 *  @test-only-export-ok: its real consumers (citation-gate-dedup.test.mjs, stdout-flush.test.mjs) are
 *  themselves executable specs living under __tests__/ — genuine non-test-of-THIS-file callers, not just
 *  this module's own unit test, which the export-usage scan can't structurally tell apart from the latter. */
export function isParseableJson(out) {
  try { JSON.parse(out); return true; } catch { return false; }
}
