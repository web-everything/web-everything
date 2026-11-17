/**
 * @file scripts/operations/verify-io.mjs
 * @description THE IO SHELL of the `verify` declaration — it shells `we:scripts/verify-lane.mjs`, THE single
 *   home for running a lane's suites, and classifies what that home reported.
 *
 * IT SHELLS THE SINGLE HOME, AND THE FIRST CUT DID NOT — which is the reason this header leads with it. That
 * cut ran `npm run check:standards` and vitest directly and parsed their summary lines, i.e. it was a second
 * implementation of a step that already had an authority. Its own header forbade exactly that, and it did it
 * anyway, because nothing looked for the existing home first.
 *
 * The defect was not stylistic. `verify-lane.mjs` records a lifecycle MARKER keyed to HEAD (`running` →
 * `green`/`red`), and `pr-land`'s finish-guard refuses to land a lane whose marker is not green for the
 * current commit (#2833). A parallel runner that skipped the marker could therefore report `ok` on a lane
 * `pr-land` would then refuse — two answers to one question, drifting apart silently, which is the whole
 * reason #2644 makes these things singular.
 *
 * WHAT THIS ADDS, given the home already exists: a DECLARATION over it. The home speaks in exit codes and a
 * marker vocabulary (`green`, `red`, `running`, `corrupt`, `absent`, TTL-abandoned); a caller has to know all
 * of it to gate correctly, and every caller that learns it learns it separately. This maps that vocabulary
 * onto the three outcomes a caller actually acts on, ONCE:
 *
 *   · `green` for this HEAD                                   → `pass`
 *   · suites ran and failed (`red`, exit 2)                    → `fail`
 *   · anything that is not a completed verdict for this commit → `unrun`
 *
 * THAT LAST BUCKET IS THE POINT, and it is wider than "the runner crashed": a `corrupt` marker, a `running`
 * marker stranded by a killed process, a marker for a DIFFERENT commit, a usage/git error (exit 3), or output
 * that did not parse. None of those is a failure anybody observed, and none may satisfy a gate. #3203 was the
 * same shape one layer down — a killed juror and a crashed juror arrived identically, which taught the reader
 * to retry rather than look.
 *
 * `mode: 'check'` is the home's own read-only subcommand: read the marker, run nothing. It is what a board
 * polls; `request` returns immediately after asking the verify daemon to run the gate. Acceptance is not
 * a result, so request mode always reports `unrun` until a later `check` reads green.
 */
import { boundFailureDetails } from '../lib/verify-failures.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCeilingMs } from '../readiness/heavy-admission.mjs';

/** The single home. Resolved from THIS file, never from cwd — the operation may verify another checkout, and
 *  the script that runs must be this repo's, not the verified tree's. */
export const VERIFY_LANE_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-lane.mjs');

/** Its documented exit codes: 0 green, 2 red (suites failed), 3 usage/git error with NO marker written. */
export const VERIFY_LANE_EXITS = Object.freeze({ GREEN: 0, RED: 2, USAGE: 3 });

/** How long the suites may run before the spawn is abandoned. The home runs them in the foreground on purpose
 *  (#2833); this bound only stops a wedged child from wedging the operation, and a kill lands as `unrun`. */
export const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;

/** Slack on top of the two phases, for the home's own git reads and marker writes. */
export const VERIFY_SPAWN_SLACK_MS = 5 * 60 * 1000;

/**
 * The spawn's whole bound: the heavy-admission queue wait (the home waits up to the admission ceiling before it
 * fails open) PLUS the suites' own {@link VERIFY_TIMEOUT_MS} plus slack. PURE. #3383, found live 2026-09-23: with a
 * 30-minute bound covering BOTH, a gate queued behind 7 or more heavy commands was killed before its suites ever
 * started and came back `unrun`, so `poc-land.mjs` could not land anything while the host was busy.
 * @param {object} [env]
 */
export function verifySpawnTimeoutMs(env = process.env) {
  return resolveCeilingMs(env) + VERIFY_TIMEOUT_MS + VERIFY_SPAWN_SLACK_MS;
}

/** The argv for one invocation. PURE, and exported so a test can assert the exact command with no subprocess —
 *  the same discipline `we:scripts/collect-review-requests.mjs` applies to its git argv. */
export function verifyArgv({ checkout, mode, gate = '' }) {
  const base = [VERIFY_LANE_CLI];
  // Both subcommands precede the flags. `request` must never fall through to a foreground gate run.
  if (mode === 'check' || mode === 'request') base.push(mode);
  base.push(`--repo=${checkout}`, '--json');
  // #xvj8sj0 — forward the caller's suite command under these conditions:
  //
  //   • ONLY WHEN NON-EMPTY. Passing `--gate=` with an empty value is not "use the default": the home reads
  //     `flags.gate` as a string and would run the empty command, so an unset gate must OMIT the flag and let
  //     the home apply its own default. Never restate that default here (#2644).
  //   • FORWARD IN `request` MODE too: the marker records the gate the daemon will run.
  //   • NEVER IN `check` MODE. `check` runs no suites at all — it reads the marker HEAD already carries and
  //     prints its verdict. A gate there would be an argument the home ignores, which reads to the next author
  //     as though the mode honoured it.
  //
  // Passed as ONE argv element, never shell-interpolated: the value is a full command line
  // (`npm run test:unit && npm run check:standards`), and `execFile` hands it to the home as a single
  // argument rather than letting `&&` reach a shell in this process.
  if (mode !== 'check' && typeof gate === 'string' && gate.trim()) base.push(`--gate=${gate}`);
  return base;
}

/**
 * Map what the home reported onto the three outcomes. PURE over the spawn result.
 *
 * THE MAPPING IS POSITIVE: `pass` and `fail` are only ever produced by a parsed verdict that names THIS
 * commit. Everything else — including a green marker for a different sha — is `unrun`, because a verdict about
 * another commit is not a verdict about this one.
 */
export function classifyVerifyResult({ status, signal, stdout = '', stderr = '', error } = {}, mode = 'run') {
  const tail = `${stdout}${stderr}`.trim().split('\n').slice(-3).join(' / ').slice(0, 300);
  if (error) return { outcome: 'unrun', reason: `runner error: ${error.message}` };
  if (signal) return { outcome: 'unrun', reason: `killed by ${signal} — the suites did not finish, so this is NOT a failure they observed` };

  let parsed = null;
  try { parsed = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { parsed = null; }

  if (!parsed || typeof parsed !== 'object') {
    return {
      outcome: 'unrun',
      reason: `exit ${status ?? '?'} and no parseable verdict on stdout — the home did not report a result, `
        + `so this is NOT a pass. Last output: ${tail || '<empty>'}`,
    };
  }
  // Exit 3 is a usage/git error and writes NO marker. Request refusals keep their recovery detail below.
  if (status === VERIFY_LANE_EXITS.USAGE && mode !== 'request') {
    return { outcome: 'unrun', reason: `usage/git error (exit 3): ${parsed.reason || parsed.detail || tail || 'no detail'}`, sha: parsed.sha };
  }
  const markerStatus = String(parsed.status ?? '');
  if (mode === 'request') {
    // Even a cached or card-only green response is an acknowledgement here. Require a check for a result.
    return {
      outcome: 'unrun',
      reason: status === 0 && ['requested', 'cached', 'green'].includes(markerStatus)
        ? 'requested, pending'
        : `request not accepted (exit ${status ?? '?'}, status ${JSON.stringify(markerStatus || 'unknown')}): ${parsed.detail || parsed.reason || tail || 'no detail'}`,
      sha: parsed.sha,
    };
  }
  if (markerStatus === 'green') return { outcome: 'pass', summary: `verified green for ${String(parsed.sha ?? '').slice(0, 8)}`, sha: parsed.sha };
  if (markerStatus === 'red') {
    return { outcome: 'fail', ...(parsed.failureDetails ? { failureDetails: boundFailureDetails(parsed.failureDetails) } : {}), errors: Number.isFinite(Number(parsed.exitCode)) ? Number(parsed.exitCode) : null, summary: `suites failed for ${String(parsed.sha ?? '').slice(0, 8)}`, sha: parsed.sha };
  }
  // `running` (stranded), `corrupt`, `absent`, `stale`, `untracked`, `break-glass` — none is a completed
  // verdict for this commit, and each carries its own reason from the home rather than being flattened here.
  return {
    outcome: 'unrun',
    reason: `marker status ${JSON.stringify(markerStatus || 'unknown')}${parsed.detail ? ` — ${parsed.detail}` : ''}`,
    sha: parsed.sha,
  };
}

/**
 * The runner the declaration is injected with. ONE spawn of the single home; `spawn` is injected so every
 * branch above is reachable with no suites, no git and no clock.
 */
export function createChecksRunner({ spawn = spawnSync, env = process.env } = {}) {
  return ({ cwd, mode, gate = '' }) => {
    const argv = verifyArgv({ checkout: cwd, mode, gate });
    const startedAt = Date.now();
    let r;
    try {
      r = spawn(process.execPath, argv, { encoding: 'utf8', timeout: verifySpawnTimeoutMs(env), maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      r = { error: e };
    }
    const classified = classifyVerifyResult(r ?? {}, mode);
    return {
      cwd,
      suite: mode,
      checks: [{ name: mode === 'check' ? 'verify-lane:marker' : 'verify-lane', durationMs: Date.now() - startedAt, ...classified }],
    };
  };
}
