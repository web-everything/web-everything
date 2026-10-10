/**
 * @file scripts/lib/review-speculative-red-team.mjs
 * @description Card xbizuci — START THE POST-ACCEPT RED TEAM WITH THE JUROR SEATS, NOT AFTER THEM.
 *
 *   The post-accept red team (`we:scripts/operations/review-extra-seats.mjs#runRedTeam`, comment marker
 *   `we:red-team-advisory`) is owed only when the review ACCEPTS (`we:scripts/lib/jury-core.mjs#redTeamRequired`), so
 *   `we:scripts/operations/review-job.mjs` used to start it only after the review loop finished — adding the red
 *   team's whole run (~3–5 min) to every accepted review. Under `review.speculativeRedTeam` the job starts it as soon
 *   as the loop's `read` step has the head and the net diff, i.e. beside the juror seats, and then:
 *     - the review ACCEPTS → the speculative pass is finished exactly as the sequential pass would have been (same
 *       seat row, same folded verdict, same comment, same red-team gate routing after it) — provided it judged the
 *       very read the review judged ({@link redTeamReadFingerprint} in the seats module); otherwise the job falls
 *       back to the sequential pass, so an accept's recorded outcome never rests on a different input;
 *     - the review does NOT accept → the pass is called off (killed if still running), nothing is posted or routed,
 *       and its spend is recorded as a `review-seat-speculative-discard` row;
 *     - the speculative pass FAILED → the same degraded result the sequential pass gives today (fail-closed: an
 *       unrun red team never folds to accept, `jury-core.mjs#foldRedTeamVerdict`).
 *
 *   THE SETTING, under the policy cascade (agent-memory 151 "policy cascade = team practice"). Each layer is read
 *   only when the one above it says nothing usable:
 *     1. env `WE_REVIEW_SPECULATIVE_RED_TEAM` (on|off|true|false|1|0) — the operator's per-process override;
 *     2. TOOL / project override — `speculativeRedTeam` in `we:scripts/settings/review.json` (only when this repo
 *        deliberately differs from the team);
 *     3. PLATFORM preference (Platform Forever, team level) — `review.speculativeRedTeam` in
 *        `we:scripts/lib/delivery-platform-preferences.json`, the delivery strategies' shared file (absent → not set);
 *     4. STANDARD default (Ship Evermore) — `on`.
 *   `off` is the sequential order this replaced. The resolved value carries the layer that set it; the job logs it.
 *
 *   PURE except the two settings-file reads and {@link withReadSink}'s one file write.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SPECULATIVE_RED_TEAM_ENV = 'WE_REVIEW_SPECULATIVE_RED_TEAM';
export const STANDARD_SPECULATIVE_RED_TEAM = 'on';
export const TOOL_SETTINGS_FILE = join(HERE, '..', 'settings', 'review.json');
export const PLATFORM_PREFERENCES_FILE = join(HERE, 'delivery-platform-preferences.json');

/** The env var the review job hands the loop: where to write the `read` finding the moment it exists. */
export const READ_SINK_ENV = 'WE_REVIEW_READ_SINK';

/** Normalise one layer's value to `on` | `off`, or null when it says nothing usable. PURE. */
export function normOnOff(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  const x = String(v ?? '').trim().toLowerCase();
  if (x === 'on' || x === 'true' || x === '1') return 'on';
  if (x === 'off' || x === 'false' || x === '0') return 'off';
  return null;
}

/**
 * Resolve `review.speculativeRedTeam` through the cascade. PURE over its inputs.
 * @param {{env?: object, tool?: *, platform?: *}} layers  `tool` = review.json's `speculativeRedTeam`,
 *   `platform` = the platform file's `review.speculativeRedTeam` (undefined = layer not set)
 * @returns {{value: 'on'|'off', enabled: boolean, source: 'env'|'tool'|'platform'|'standard', invalid: string[]}}
 */
export function resolveSpeculativeRedTeam({ env = {}, tool, platform } = {}) {
  const invalid = [];
  const layers = [['env', env?.[SPECULATIVE_RED_TEAM_ENV]], ['tool', tool], ['platform', platform]];
  for (const [source, raw] of layers) {
    if (raw === undefined || raw === null || raw === '') continue;
    const v = normOnOff(raw);
    if (v) return { value: v, enabled: v === 'on', source, invalid };
    invalid.push(`${source}=${JSON.stringify(raw)}`);
  }
  return { value: STANDARD_SPECULATIVE_RED_TEAM, enabled: STANDARD_SPECULATIVE_RED_TEAM === 'on', source: 'standard', invalid };
}

/** IO: read both settings files (a missing or unreadable file is "layer not set") and resolve. Never throws. */
export function loadSpeculativeRedTeam({
  env = process.env, toolFile = TOOL_SETTINGS_FILE, platformFile = PLATFORM_PREFERENCES_FILE, readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const read = (p) => { try { return JSON.parse(readFile(p)); } catch { return null; } };
  return resolveSpeculativeRedTeam({ env, tool: read(toolFile)?.speculativeRedTeam, platform: read(platformFile)?.review?.speculativeRedTeam });
}

/** One log line: the effective value and the layer that set it. PURE. */
export function formatSpeculativeRedTeamSourceLine(r) {
  const bad = r?.invalid?.length ? ` · ignored invalid: ${r.invalid.join('; ')}` : '';
  return `review.speculativeRedTeam=${r?.value ?? '?'} (${r?.source ?? '?'})${bad}`;
}

/**
 * Wrap a run store so the FIRST write that carries `findings.read` also writes `{pr, repo, read}` to `sinkPath`
 * (atomically: tmp + rename). `driveRun` writes the run after every step, so this fires right after the `read`
 * step and before any juror is spawned. No `sinkPath` → the store unchanged. A failed sink write never fails the
 * review (the speculative pass then finds no read and the job falls back to the sequential order).
 */
export function withReadSink(store, sinkPath, { write = (p, text) => { const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, text); renameSync(tmp, p); } } = {}) {
  if (!sinkPath || !store) return store;
  let done = false;
  return {
    ...store,
    write: (run) => {
      const out = store.write(run);
      if (!done && run?.findings?.read) {
        done = true;
        try { write(sinkPath, `${JSON.stringify({ pr: run.input?.pr ?? null, repo: run.input?.repo ?? null, runId: run.id ?? null, read: run.findings.read })}\n`); } catch { /* the review never depends on this */ }
      }
      return out;
    },
  };
}

/**
 * What the job does with the speculative pass once the review is over. PURE.
 * @param {{accepted: boolean, spec: (object|null)}} o  `spec` = the pass file's content, or null when the process
 *   died without writing one
 * @returns {'finish'|'sequential'|'failed'|'discard'}
 *   - `discard`    — the review did not accept: call it off, record any spend, post and route nothing;
 *   - `finish`     — accepted and a model call was made: finish it (`red-team-finish`), which re-checks the read;
 *   - `failed`     — accepted, but the speculative process died without a result: the red team failed (degraded,
 *                    exactly as a crashed sequential pass);
 *   - `sequential` — accepted and the speculation made no model call (disabled, skipped, a prior clean row to
 *                    resume, no read sunk): run today's sequential pass, which reaches the same status on its own.
 */
export function decideSpeculativeOutcome({ accepted, spec }) {
  if (!accepted) return 'discard';
  if (!spec || typeof spec !== 'object') return 'failed';
  if (spec.status === 'speculated') return 'finish';
  if (spec.status === 'error') return 'failed';
  return 'sequential';
}
