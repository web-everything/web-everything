/**
 * @file breaks/build-daemon-retry-blocks-tick-on-slow-ci-wait.mjs — #4517. LIVE INCIDENT (2026-09-29,
 * 2:22-2:56pm ET): the build-dispatch daemon's own tick calls `infra-blocked.mjs retry` synchronously via
 * `cliRetryInfraBlocked`'s `execFileSync` (no `timeout` option). That retry can itself call
 * `pr-land.mjs --label-on-green`, which blocks on CI. launchd com.we.build-dispatch-daemon (pid 77087) wrote
 * no tick line for 30+ minutes while its child sat 26 minutes into the retry, itself 14 minutes into a
 * `pr-land --label-on-green` CI wait for `lane/4511-prevention-card`.
 *
 * FIX (#4517): `cliRetryInfraBlocked` now passes a bounded `timeout` (`INFRA_RETRY_TIMEOUT_MS`, default
 * 60_000ms — well under the daemon's own 120_000ms tick interval) to `execFileSync`. A retry that runs past
 * the bound is killed and reported `{timedOut: true}`; it is simply retried next tick (idempotent, #2659's
 * own backoff design already tolerates this).
 *
 * RED (fix absent): `cliRetryInfraBlocked` passes no `timeout` to `exec`, so a slow child call blocks for as
 * long as it takes — modeled here with a fake `exec` that "would" run 5x the daemon's own tick budget.
 * GREEN (fix present): the same call returns near the bound instead, `timedOut: true`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
  id: 'build-daemon-retry-blocks-tick-on-slow-ci-wait',
  title: 'the build-dispatch daemon\'s infra-blocked retry call has no bound, so a slow `pr-land --label-on-green` '
    + 'CI wait nested inside it can stall the WHOLE tick (dispatch, liveness, claims) for as long as it runs '
    + '(live #4517, com.we.build-dispatch-daemon pid 77087, stalled 2:22-2:56pm ET 2026-09-29)',
  card: 'we:backlog/4517 (4517)',
  // `sha` is filled once this fix lands (the fix and this break land in the SAME commit, so the real sha is
  // not knowable at authoring time) — established repo pattern, see e.g.
  // `breaks/lease-reaper-hand-briefed-owner-invisible.mjs`'s own `fixedBy.sha: 'PENDING-FILL-AT-LAND'`.
  fixedBy: { sha: 'PENDING-FILL-AT-LAND', where: 'main', paths: ['skills-src/conveyor/build-dispatch-daemon.mjs'] },
  fixPresent(root) {
    try {
      const src = readFileSync(join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs'), 'utf8');
      // The original child bound became the remaining budget of a shared pass deadline.
      return /INFRA_RETRY_TIMEOUT_MS/.test(src) && /timeout:\s*(?:timeoutMs|remainingMs)\b/.test(src);
    } catch { return false; }
  },
  async run({ log } = {}) {
    const daemon = await import('../../../../skills-src/conveyor/build-dispatch-daemon.mjs');
    const { withRuntimeAdmission } = await import('../../../lib/runtime-admission.mjs');
    // Models real execFileSync timeout semantics without a real subprocess (see the sibling unit test in
    // build-dispatch-daemon.test.mjs for a real process-tree timeout check). Inject the clock too, so
    // unrelated soak workers cannot turn scheduler delays into a timeout regression.
    const slowMs = 5 * 50; // "5x the daemon's tick budget", scaled down for a fast, deterministic soak run
    const boundMs = 50;
    let elapsedMs = 0, execCalls = 0;
    const exec = (cmd, args, opts) => {
      execCalls += 1;
      const bound = opts?.timeout;
      const boundBites = typeof bound === 'number' && bound > 0 && bound < slowMs;
      const wait = boundBites ? bound : slowMs;
      elapsedMs += wait;
      if (boundBites) { const err = new Error(`command timed out after ${bound}ms`); err.signal = 'SIGTERM'; throw err; }
      return JSON.stringify({ retried: [], resumed: [], surfaced: [], waiting: [] });
    };
    const entry = { num: '4517', groupMembers: [] };
    const result = withRuntimeAdmission(entry, 'infra-recovery', () => daemon.cliRetryInfraBlocked({
      exec, env: {}, home: '/x', timeoutMs: boundMs, now: () => elapsedMs,
      readEntries: () => [entry],
    }), { readSettings: () => ({ mode: 'lift' }) });
    log?.(`build-daemon-retry-blocks-tick-on-slow-ci-wait: elapsedMs=${elapsedMs} slowMs=${slowMs} boundMs=${boundMs} execCalls=${execCalls} result=${JSON.stringify(result)}`);
    const violations = [];
    if (elapsedMs > boundMs) {
      violations.push({
        invariant: 'retry-call-bounded',
        detail: `cliRetryInfraBlocked took ${elapsedMs}ms against a retry that would run ${slowMs}ms unbounded — `
          + 'no timeout is reaching exec, so a slow pr-land --label-on-green CI wait can still stall the whole daemon tick',
      });
    }
    if (execCalls !== 1 || result.timedOut !== true) {
      violations.push({
        invariant: 'slow-retry-exercised',
        detail: `expected one admitted slow retry and timedOut: true; execCalls=${execCalls} result=${JSON.stringify(result)}`,
      });
    }
    return { violations, elapsedMs, slowMs, boundMs, execCalls, timedOut: result.timedOut === true };
  },
  judge(report) {
    return (report.violations || []).map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
