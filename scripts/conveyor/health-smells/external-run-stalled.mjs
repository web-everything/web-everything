/**
 * @file scripts/conveyor/health-smells/external-run-stalled.mjs
 * @description Health smell — an EXTERNAL (Codex/Gemini) build or prepare run the build daemon launched that is
 *   alive but not producing output. Two shapes: (1) its worker output log (`<lane>/.git/<provider>-direct-task.jsonl`)
 *   has not grown for `stallMs` (default 12 min); (2) launched-but-not-confirmed — the run record is `in-flight`
 *   with no pid handle `unconfirmedMs` (default 10 min) after launch. External runs are invisible to
 *   `claude agents`/`~/.claude/jobs`, so the dispatch run record is the only liveness source. DETECTION ONLY.
 *   Input: `probes.externalRuns` (`we:scripts/conveyor/build-supervision.mjs#probeExternalRuns`, fs-only).
 */
import { BUILD_SUPERVISION_DEFAULTS, fmtMin } from '../build-supervision.mjs';

export default {
  id: 'external-run-stalled',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['externalRuns'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'alert',
  stallMs: BUILD_SUPERVISION_DEFAULTS.stallMs,
  unconfirmedMs: BUILD_SUPERVISION_DEFAULTS.unconfirmedMs,
  recommendationHint: 'An external (Codex) build/prepare run is alive but silent, or never confirmed. Read its output log before judging.',
  evaluate({ externalRuns }) {
    return (externalRuns || []).map((r) => {
      const unconfirmed = !r.confirmed && r.ageMs != null && r.ageMs >= this.unconfirmedMs;
      // No output file found: fall back to the run's own age as "time without output" (it never wrote any).
      const silentMs = r.outputAgeMs ?? r.ageMs;
      const stalled = r.confirmed && silentMs != null && silentMs >= this.stallMs;
      const what = `${r.executor} ${r.kind ?? 'run'} (card #${r.card}${r.lane != null ? `, lane-${r.lane}` : ''}${r.pr ? `, PR #${r.pr}` : ''})`;
      return {
        subject: `run:${r.runId}`,
        breach: unconfirmed || stalled,
        measure: { runId: r.runId, executor: r.executor, kind: r.kind, card: r.card, lane: r.lane, pr: r.pr, pid: r.pid,
          ageMin: r.ageMs == null ? null : Math.round(r.ageMs / 60_000), silentMin: silentMs == null ? null : Math.round(silentMs / 60_000),
          heartbeatAgeMin: r.heartbeatAgeMs == null ? null : Math.round(r.heartbeatAgeMs / 60_000),
          confirmed: r.confirmed, outputFile: r.outputFile, stallMin: Math.round(this.stallMs / 60_000) },
        summary: unconfirmed
          ? `${what} was launched ${fmtMin(r.ageMs)} ago but never confirmed (no pid handle).`
          : `${what} (pid ${r.pid}) has produced no output for ${silentMs == null ? '?' : fmtMin(silentMs)} (threshold ${fmtMin(this.stallMs)}).`,
        recommendation: unconfirmed
          ? `Run record ${r.runId} is in-flight with no pid: the launch may have failed silently. Check the build daemon log for the launch of card #${r.card}.`
          : `Read the tail of ${r.outputFile ?? `lane-${r.lane}'s .git/${r.executor}-direct-task.jsonl`} (inspect-codex-transcript). If the worker is hung, stop pid ${r.pid} by hand and fix the stall cause; detection only here.`,
      };
    });
  },
};
