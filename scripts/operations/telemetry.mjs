/**
 * @file scripts/operations/telemetry.mjs
 * @description THE DELIVERY TELEMETRY SCHEMA — the pure core of the mechanical delivery system's unified
 * trace/span/metric record (#3383). This is the *shape* half; the boundary (where it lands on disk, how a
 * line is appended and read back) lives next door in {@link ./telemetry-store.mjs} and re-exports everything
 * here, so a caller has ONE import. Same pure-core / io-shell split as `call-log.mjs`/`call-log-store.mjs`
 * and `run-record.mjs`/`run-store.mjs` — deliberately not a third convention.
 *
 * ================================================================================================
 * WHY THIS EXISTS — the gap it closes, measured before it was designed (survey, 2026-09-12).
 *
 * Five record families already capture *something* about a delivery, each keyed differently, none joinable:
 *
 *   | store                                   | keyed by         | duration? | attempt? | item? |
 *   |-----------------------------------------|------------------|-----------|----------|-------|
 *   | `.operations/runs/<runId>.json`          | `<op>-<uuid>`    | per STEP  | per EFFECT | buried in `input` |
 *   | `.operations/completions/<session>.json` | session slug     | no        | no       | yes   |
 *   | `.operations/delivery-reports/*.json`    | session slug     | no        | no       | yes   |
 *   | `.operations/calls/<day>.jsonl`          | day (append)     | no        | no       | NO    |
 *   | `.operations/fix-reports/*.json`         | session slug     | no        | no       | via PR |
 *
 * The run store's `stepTimings[]` is real per-phase timing — but it only covers work driven through the
 * DECLARED-operation engine (`registry.mjs` → `cli-adapter.mjs`). The six dispatch wrappers
 * (`deliver-item-wrapper.mjs`, `fix-dispatch-wrapper.mjs`, `prepare-scope-wrapper.mjs`,
 * `prepare-decision-wrapper.mjs`, `ci-heal-dispatch-wrapper.mjs`, `review-dispatch-wrapper.mjs`) do NOT go
 * through that engine — each hand-rolls its own sequence around `minimal-context-provider.mjs#run`. So the
 * single most expensive span in the whole system (the agent's own working turn, capped at 60 MINUTES by
 * `DELIVERY_AGENT_SPAWN_TIMEOUT_MS`) is timed by NOTHING today, and neither is lane-acquire, the gate, the
 * converge rounds, or PR-open.
 *
 * `readiness/conveyor-instrument.mjs` (#2680) already derives per-item phase math — but from `gh` PR
 * timestamps + backlog dates AFTER the fact, and it says so itself: with no dispatch stamp its `authoring`
 * phase is `{ms: null, reason: 'no-dispatch-signal'}` and the aggregate flags `needsDispatchInstrumentation`.
 * Its `mark-dispatch`/`mark-setup` capture verbs are confirmed DEAD (no call site, no sidecar on disk, per
 * `we:backlog/3569-*`). This file is the FIRST-PARTY capture that instrument was always missing — it does not
 * replace the instrument's derivation, it supplies the boundary stamps the derivation asks for.
 * ================================================================================================
 *
 * WHAT IT BORROWS FROM OPENTELEMETRY, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * BORROWED (portable ideas, no SDK, no dependency, no collector):
 *   • TRACE / SPAN / PARENT. One backlog item's whole delivery lifecycle = one trace; each phase = a span
 *     with `startedAt`/`endedAt`/`durationMs`/`status`, nested via `parentSpanId`.
 *   • THREE STATUS CODES, exactly OTel's: `unset` / `ok` / `error` ({@link SPAN_STATUS}). Not four, not a
 *     bespoke per-wrapper vocabulary. A wrapper's own richer outcome word (`blocked-on-infra`, `gate-red`,
 *     `bounced`) rides in `statusMessage` + `attributes`, never in `status` — that is exactly the
 *     `status` / `status_message` split OTel draws, and it is what lets an error RATE be computed across
 *     six wrappers that will never agree on outcome vocabulary.
 *   • LOW-CARDINALITY SPAN NAMES ({@link SPAN_NAMES}), high-cardinality detail in `attributes`. `lane.acquire`
 *     is a span name; `lane-19` is an attribute. This is the single semconv rule that makes aggregation work,
 *     and the closed set is ENFORCED ({@link validateSpanEnd}) so a sixth wrapper cannot quietly mint
 *     `acquireLaneForReviewLoop` and fall out of every rollup.
 *   • RESOURCE ATTRIBUTES — the "who/where produced this" bag that is identical for every span in a process
 *     (repo, branch, commit sha, host, pid, runner id). Stamped once per recorder, not retyped per span.
 *   • METRICS AS A SEPARATE SIGNAL from spans, sharing one transport ({@link EVENT_TYPES}).
 *
 * NOT BORROWED, on purpose:
 *   • No OTel SDK / collector / OTLP exporter. This is a CLI-driven, file-based, short-lived-process system;
 *     a batching exporter with a shutdown flush is the wrong shape for a process that may be `SIGKILL`ed, and
 *     a runtime dependency in the driver's critical path is exactly what the watchdog discipline forbids.
 *   • No W3C `traceparent` propagation header. Nothing here crosses a network hop; the trace id is DERIVED
 *     from the work's own stable identity ({@link deriveTraceId}) rather than propagated, so two processes
 *     that never talk (a build wrapper and, three hours later, a review wrapper) land in the SAME trace
 *     without either having to pass anything to the other. This is the one place a local file-based system
 *     can do something a distributed tracer cannot, and it is the whole reason a lifecycle trace is possible
 *     here at all.
 *   • No sampling. Delivery volume is single-digit-per-hour; sampling would only lose data.
 *
 * WHY THE TRACE ID IS THE ITEM AND THE ATTEMPT IS AN ATTRIBUTE. The obvious alternative — folding the attempt
 * into the trace id — would make attempt 1 and attempt 2 of item #3441 two unrelated traces, and "how many
 * attempts did this item take" would become unanswerable from the trace alone. Keeping the attempt as a span
 * ATTRIBUTE is strictly more information: a reader may still split by attempt, and may additionally ask the
 * retry question. See {@link deriveTraceId}.
 *
 * PURE. No fs, no clock, no process, no randomness, no network, no child_process. Every input is passed in.
 * A caller that needs a clock or an id generator injects one — which is also what makes every function here
 * unit-testable against plain objects with zero disk.
 * (The one sibling import, `command-redact.mjs`, is itself pure — no fs/clock/process — so the claim holds.)
 */

import { redactCommandLine } from './command-redact.mjs';

// ── VOCABULARIES (closed sets — the aggregation contract) ─────────────────────────────────────────────

/** The event discriminator. One NDJSON stream carries all three; a reader switches on this field.
 *  `span.start` is written ONLY for spans marked durable (see {@link DURABLE_SPAN_NAMES}) — everything else
 *  writes a single `span.end` line at completion. See the store's header for why. */
export const EVENT_TYPES = Object.freeze(['span.start', 'span.end', 'metric']);

/**
 * OTel's span status codes, verbatim and complete. `unset` is the honest default for a span that ended
 * without anyone asserting a verdict (a phase that ran, whose success is not this layer's to judge);
 * `error` means the phase itself failed. A wrapper's domain outcome NEVER goes here — see the header.
 */
export const SPAN_STATUS = Object.freeze(['unset', 'ok', 'error']);

/**
 * THE CLOSED SPAN-NAME VOCABULARY — low-cardinality, `<subject>.<operation>`, one entry per real phase of the
 * mechanical delivery system. Enforced at record time so a rollup can never silently miss a phase because a
 * seventh wrapper spelled it differently.
 *
 * Sourced from the actual phase sequences, not invented: `deliver-item-wrapper.mjs#deliverItem` steps 1–8,
 * `review-dispatch-wrapper.mjs#dispatchReviewMechanical`, and `runner.mjs`'s tick loop.
 */
export const SPAN_NAMES = Object.freeze([
  // ── the root span: one wrapper invocation, end to end ──
  'dispatch',
  // ── setup phases ──
  'lane.acquire',
  'item.claim',
  'brief.build',
  // ── the expensive middle: the agent's own working time ──
  'agent.turn',
  // ── gates and quality ──
  'verify.gate',
  'converge.round',
  // ── git / forge ──
  'git.commit',
  'pr.open',
  'review.loop',
  // ── teardown ──
  'lane.release',
  'report.write',
  // ── the runner's own loop ──
  'runner.tick',
  'runner.pass',
]);

/**
 * Spans that also emit a `span.start` line when they open.
 *
 * THE TRADE, STATED PLAINLY. Writing one line at END is cheaper, halves the volume, and needs no join on the
 * read side — so it is the default. But an end-only span is INVISIBLE if the process dies mid-phase, and the
 * phases below are exactly the ones long enough for that to be a real, observed failure mode rather than a
 * theoretical one: `agent.turn` runs up to 60 minutes (`DELIVERY_AGENT_SPAWN_TIMEOUT_MS`), and a delivery
 * agent wedged at an empty prompt is a live, filed defect (`we:backlog/3624-*`). For these, a `span.start`
 * with no matching `span.end` is not noise — it IS the signal, and {@link goldenSignals} surfaces it as
 * `abandoned`. Every other span is short enough that a crash inside it is adequately explained by the
 * neighbouring spans.
 */
export const DURABLE_SPAN_NAMES = Object.freeze(['dispatch', 'agent.turn', 'verify.gate', 'review.loop']);

/**
 * The dispatch kinds — the `kind` axis every rollup splits on ("errors per phase, per kind"). Mirrors the
 * launch kinds the dispatch provider registry knows, plus `runner` for the tick loop's own spans/metrics
 * (which belong to no single item) and `unknown` as the never-throw fallback.
 */
export const DISPATCH_KINDS = Object.freeze([
  'build', 'fix', 'prepare', 'prepare-decision', 'ci-heal', 'review', 'runner', 'sampler', 'unknown',
]);

/**
 * THE CLOSED METRIC-NAME VOCABULARY — the SATURATION half of the four golden signals, which spans alone
 * cannot express. A span says how long a phase took; it cannot say that at 14:03 every lane in the pool was
 * occupied, which is the thing that makes the NEXT dispatch slow. These are point-in-time gauges and counters
 * sampled by the runner's tick loop.
 *
 * The saturation signals already EXIST in the running system and are captured by nothing:
 *   • `lane-pool.mjs status` knows free/leased/total — sampled every tick, persisted never.
 *   • `readiness/heavy-admission.mjs` writes `waiting` intent markers that `tick-core.mjs` surfaces as
 *     `waiting-for-capacity` notes — a real queue-wait signal that evaporates with the tick that printed it.
 *   • `MAX_CONCURRENT_LANES` admission denials are a decision the runner makes and then forgets.
 */
export const METRIC_NAMES = Object.freeze([
  // lane pool (saturation)
  'lane.pool.total', 'lane.pool.free', 'lane.pool.leased', 'lane.pool.utilization',
  // a lease that is unexpired by TTL but has NO live process behind it (host-sampler reconciliation) —
  // reported apart from `leased` so a ghost never reads as concurrency.
  'lane.pool.stale_leases',
  // heavy-command admission semaphore (saturation + queue wait)
  'heavy.admission.cap', 'heavy.admission.held', 'heavy.admission.waiting', 'heavy.admission.wait_ms',
  // dispatch decisions (traffic + saturation)
  'dispatch.inflight', 'dispatch.admitted', 'dispatch.denied',
  // queue (traffic)
  'queue.depth', 'queue.ready',
  // ── SELF-TRACKED TOKEN USAGE (epic #3383, usage-ledger follow-up) ──
  // Recorded per real dispatch, tagged `provider` (today only `codex` — Claude's own usage is covered
  // instead by the OFFICIAL OpenTelemetry export Claude Code itself can emit
  // (`claude_code.token.usage`/`claude_code.cost.usage`), ingested separately by
  // `scripts/operations/claude-otel-collector.mjs`; these four exist so the ledger has a comparable
  // per-dispatch signal for the ONE provider with no such official export) and `model` in their
  // `attributes`. Four separate low-cardinality names (never one name with a `tokenType` attribute) so a
  // plain sum-by-name rollup needs no attribute filter to answer "how many input tokens" — this file's own
  // "low-cardinality name, high-cardinality detail in attributes" rule taken one step further: even the
  // "which token type" axis stays a NAME here because the ledger's very first operation on this data is
  // "sum this one axis," not a group-by.
  'dispatch.tokens.input', 'dispatch.tokens.output', 'dispatch.tokens.cache_read', 'dispatch.tokens.cache_write',
  // ── HOST RESOURCE (the capacity-planning half, #3383 follow-on) ──
  // Sampled by the runner's tick loop ALONGSIDE the saturation metrics above, at the same cadence and the same
  // timestamp — the whole point is answering "was the HOST the constraint, not the queue/lane logic" by
  // correlating these against `dispatch.*`/`lane.pool.*`/`queue.*` at the same points in time, never read in
  // isolation. `os.loadavg()`/`os.freemem()`/`os.totalmem()`/`os.cpus()` only — no subprocess (`sysctl`/
  // `vm_stat`), matching this file's own no-subprocess discipline (see `telemetry-store.mjs`'s purity header);
  // swap usage has no cross-platform in-process API in Node and is therefore NOT captured — see
  // `runner.mjs#readHostSample`'s docblock for the tradeoff, stated rather than silently dropped.
  'host.cpu.load1', 'host.cpu.load5', 'host.cpu.load15',
  // recorded alongside every sample (not once), so load-vs-cores is computable without a separate lookup —
  // trivially cheap (`os.cpus().length`) and a machine's core count could theoretically change (a VM resize)
  // between samples, which a once-only stamp would miss.
  'host.cpu.count',
  // RAW bytes, not a pre-computed ratio: free/total is one division away in any later analysis, but a ratio
  // alone could never recover the total — raw is strictly more information for the same two numbers.
  'host.mem.free_bytes', 'host.mem.total_bytes',
  // ── PER-CATEGORY PROCESS ATTRIBUTION (#3383 follow-on — the WHOLE-MACHINE gauges above can say the host is
  // loaded but never say by what; these say what). Sampled by the SAME tick-loop cadence, from ONE `ps`
  // snapshot enumerating every process on the host — see `host-process-sample.mjs` for the actual `ps`
  // invocation, the parser, and the category-matching rules (which live there, not here, because that is
  // where the real judgment calls are made and tested).
  //
  // REDESIGNED (#3383 telemetry-granularity follow-on). The original six FIXED categories included `vscode`/
  // `chrome`/`other` — on a real capture, `other` alone summed 888 processes into ONE entry with zero
  // per-process identity retained. Per the operator's direction ("any process taking substantial capacity
  // should have its own entry"), only THREE categories stay fixed at collection time — `conveyor` (the
  // driver/runner itself + anything under `skills-src/conveyor/`), `drain` (the merge-queue daemon),
  // `dispatched_agents` (a live `claude`/`codex` CHILD this system's own wrappers spawned, matched on argv
  // shape, never the bare binary name) — because those are THIS SYSTEM's own processes and were never the
  // problem. Everything else is now individual per-process rows (`host.process.entry.*`, see below) or a
  // clearly-labeled remainder (`host.process.below_floor_remainder.*`), never a silent catch-all.
  //
  // TWO metrics per category — CPU and MEMORY are separate names (never one name with a `metric` attribute),
  // the same "low-cardinality name, high-cardinality detail in attributes" rule `dispatch.tokens.*` above
  // already follows: a plain sum-by-name rollup answers "how much CPU did drain cost" with no attribute
  // filter. `cpu_pct` is the RAW SUM of `ps`'s own `%CPU` column across every matched process — "percent of
  // one core", so a bucket can legitimately read over 100 on a multi-core host with several matched processes
  // (never pre-divided by `host.cpu.count`, which is recorded alongside for a reader to divide by); `mem_bytes`
  // is summed RSS in raw bytes, matching `host.mem.*`'s own raw-over-ratio convention.
  'host.process.conveyor.cpu_pct', 'host.process.conveyor.mem_bytes',
  'host.process.drain.cpu_pct', 'host.process.drain.mem_bytes',
  'host.process.dispatched_agents.cpu_pct', 'host.process.dispatched_agents.mem_bytes',
  // ONE shared low-cardinality name for EVERY individual process that clears `host-process-sample.mjs`'s
  // storage floor (default >2% CPU or >200MB — see `DEFAULT_PROCESS_CPU_PCT`'s own docblock for the real-data
  // sizing math) — real identity (`pid`, `command`) travels in `attributes`, never in the metric name, so the
  // closed vocabulary here never has to grow per-process. `telemetry.mjs#summarizeHostProcesses` is the
  // reporting-layer function that reads these back and decides which get their own NAMED entry in a report.
  'host.process.entry.cpu_pct', 'host.process.entry.mem_bytes',
  // Everything below the storage floor, summed — clearly labeled as a REMAINDER (unlike the old `other`,
  // which read as a category of its own), carrying `processCount` in its attributes.
  'host.process.below_floor_remainder.cpu_pct', 'host.process.below_floor_remainder.mem_bytes',
  // ── gh-CALL RATE-LIMIT THROTTLE (epic #3383's git-manager vision, first real slice — `gh-throttle.mjs`
  // self-calibration against GitHub's real live rate-limit signals, wired into `pr-land.mjs`'s `gh pr create`
  // after it failed twice in one day with no automatic retry). `rate_limited` counts EVERY classified
  // rate-limit-shaped `gh` failure — retried or finally given up on — tagged in `attributes` with `op` (the
  // `gh` subcommand), `attempt`, `source` (`secondary-retry-after` | `primary-reset` | `guessed-backoff` —
  // WHICH real signal, if any, calibrated the wait; see `gh-throttle.mjs`'s own header for why primary and
  // secondary are never conflated) and `outcome` (`retry` | `exhausted`). `backoff_ms` is the wait actually
  // chosen before a retry (not emitted on the terminal exhausted give-up, since no wait is taken there).
  // `exhausted` counts a retry budget running out — the capacity signal a bare `rate_limited` count cannot
  // give alone (a hit that succeeded on retry vs one that never recovered). Three separate low-cardinality
  // names, not one name with a `metric` attribute — this file's own established convention (see
  // `dispatch.tokens.*` / `host.process.*` above) so a plain sum-by-name rollup needs no attribute filter.
  'gh.throttle.rate_limited', 'gh.throttle.backoff_ms', 'gh.throttle.exhausted',
  // ── INDEPENDENT HOST SAMPLER (#3383, `host-sampler.mjs`) — written by the sampler on its OWN cadence, not on
  // runner ticks, so a burst between ticks is captured. Every sampler record carries `attributes.source =
  // 'host-sampler'` and a shared `attributes.sample` id (metrics of one sample do NOT share a timestamp otherwise).
  // Per-FAMILY figures are ONE record per axis with the family in the attribute KEYS (`cpu.vitest`, `n.vitest`,
  // `mem.vitest`), not one metric name per family: 12 families x 3 axes as separate lines would triple the file
  // growth for the same information. `value` is the all-family total.
  'host.family.cpu_pct', 'host.family.count', 'host.family.mem_bytes',
  // Live agent sessions (`claude agents --json` + the session-verdicts classifier); `value` = sessions with a live
  // pid, attributes `verdict.<verdict>` counts.
  'host.sessions.live',
  // Direct saturation probes: wall-clock ms to spawn+reap `node -e 0`, and how far a fixed 50 ms busy-wait
  // overshot its deadline (an off-CPU stall). Both rise when the host cannot schedule us promptly.
  'host.probe.spawn_ms', 'host.probe.spin_overshoot_ms',
  // Memory pressure / swap / compressor, disk and CPU throttling (`host-sampler-extras.mjs`). `available_bytes` is
  // free + inactive + speculative + purgeable pages; `pressure_level` is macOS `kern.memorystatus_vm_pressure_level`
  // (1 normal, 2 warn, 4 critical); `thermal_limit_pct` is `pmset -g therm` CPU_Speed_Limit (100 = unthrottled).
  'host.mem.available_bytes', 'host.mem.compressed_bytes', 'host.mem.swap_used_bytes', 'host.mem.pressure_level',
  'host.disk.free_bytes', 'host.disk.io_bytes_per_s', 'host.cpu.thermal_limit_pct',
  // ── CAPACITY REFINEMENT (#3383, sampler schema 2, 2026-09-21) — the reservation question: how much to keep back for
  // the system/VS Code, for heavy commands and for lanes. All are ADDITIVE; every record above keeps its meaning.
  // `host.cpu.busy_pct` = TRUE whole-machine busy % (100 - idle) from the kernel's per-core tick deltas, attrs
  // user_pct/sys_pct/nice_pct/idle_pct/window_s/cpu_source/ncpu/hw_ncpu/core_busy_max/cores_over90.
  'host.cpu.busy_pct',
  // Per COMMAND-CLASS figures (`host-sampler-classes.mjs`): value = all-class total, the class in the attribute KEYS
  // (`cpu.check-standards`), exactly like `host.family.*`.
  'host.class.cpu_pct', 'host.class.count', 'host.class.mem_bytes',
  // Per-LANE CPU/RSS/process count over EVERY process (value = lane-attributed CPU total; attrs `cpu.<lane>`,
  // `mem.<lane>`, `n.<lane>`, `unlaned_cpu`, `share`) and the number of concurrent TOP-LEVEL heavy commands
  // (`host.heavy.roots`, attrs `by_class`, `unadmitted_cpu`, `unadmitted_n`, `held`, `cap`).
  'lane.attribution.cpu_pct', 'host.heavy.roots',
  // One record per heavy-admission HOLDER (value = seconds held; attrs slot/owner/pid/alive/cpu_pct/mem_bytes/procs/
  // classes/unslotted) and one for the STALE waiting markers (value = count; attrs owners/oldest_age_s). Stale
  // markers are flagged, never deleted.
  'heavy.admission.holder', 'heavy.admission.stale_markers',
  // Live sessions by KIND (build|prepare|review|task|interactive): value = total live, attrs `n.<kind>`,
  // `cpu.<kind>`, `mem.<kind>`, `heavy_cpu.<kind>`; and the EDGE-TRIGGERED start/finish of each (`dispatch.worker.event`,
  // value 1, attrs event/kind/name/session_id/at/discovered).
  'host.workers.live', 'dispatch.worker.event',
  // The sampler's own cost and health per sample: value = sampling wall ms; attrs cpu_ms, child_wall_ms, child_calls,
  // roster_ms, heartbeat_gap_s, heartbeat_missed_total, quality (`ok`|`partial`), failed (the probes that failed).
  'host.sampler.self',
  // ONE record per heavy command RUN, written when it ENDS (`host-sampler-episodes.mjs`): value = wall seconds, attrs = the
  // episode record (family, lane, session, start/end, cpu_s, peak RSS/procs/threads, admission, concurrency at start and
  // at peak, host busy/idle at start; `calibration: true` for `host-sampler.mjs calibrate` runs). And the HARDWARE PROFILE
  // (once per sampler start and daily): value = ncpu, attrs = physical/performance/efficiency cores, memory, chip, model, OS.
  'heavy.run.episode', 'host.hardware.profile',
  // ANY limit change (lane cap, worker cap, heavy-admission size) emits one of these — `value` is the NEW value,
  // attributes carry `limit`, `old`, `new`, `reason`, `who` — so before/after windows can be compared later.
  'config.limit.changed',
]);

/** Metric units — kept tiny and explicit so a renderer never has to guess whether 1200 is ms or a count.
 *  `bytes` (#3383) is for `host.mem.*` — distinct from `count` so a renderer can choose human-sized formatting
 *  (`1.2GB`) without needing to special-case a metric name to know it holds a byte quantity. `percent` (#3383
 *  follow-on, per-process attribution) is for `host.process.*.cpu_pct` — deliberately NOT `ratio`: every
 *  existing `ratio` metric (`lane.pool.utilization`) is a 0..1 fraction, while a `ps`-derived CPU-percent sum
 *  is 0..100-per-core and can legitimately exceed 100 for a multi-process bucket on a multi-core host: folding
 *  it into `ratio` would make a renderer guess which scale a given sample is on, exactly what this list exists
 *  to prevent. */
export const METRIC_UNITS = Object.freeze(['count', 'ms', 'ratio', 'bytes', 'percent']);

/**
 * THE CROSS-WRAPPER FAILURE VOCABULARY — the one place that says which of the six wrappers' own outcome words
 * mean "this dispatch did not deliver".
 *
 * This is the single most valuable piece of shared vocabulary in the file, and it exists because the survey
 * found the opposite: each wrapper invented its own outcome enum and nothing reconciled them. The union today
 * is `blocked-on-infra`, `not-applicable`, `gate-red`, `gate-blocked`, `escalated-conflict`,
 * `escalated-needs-judgment`, `re-armed`, `ci-healed`, `not-ready`, `blocked-mid-build`, `bounced`,
 * `auto-cleared`, `parked`, `pr-opened` — fourteen words across six files, with no agreement on which of them
 * is a failure. That is exactly why "what is the error rate of the delivery system" is unanswerable today.
 *
 * THE LINE IS DRAWN AT "DID THE PIPELINE PRODUCE THE ARTIFACT IT EXISTS TO PRODUCE", not at "was the news
 * good". So:
 *   • `bounced` (a review asked for changes) is NOT an error — the review worked perfectly. Counting it would
 *     make the error rate measure reviewer strictness.
 *   • `not-applicable` / `not-ready` are NOT errors — correctly declining work that should not be done is the
 *     system working. They close `unset`, the OTel status for "ran, no verdict asserted".
 *   • `blocked-on-infra`, `gate-red`, `gate-blocked`, `blocked-mid-build`, and both `escalated-*` ARE errors —
 *     in each, a dispatch consumed a lane and an agent turn and produced no landable diff.
 *
 * Used by {@link classifyOutcomeStatus}; a word not listed anywhere defaults to `unset` rather than guessing.
 */
export const ERROR_OUTCOMES = Object.freeze([
  'blocked-on-infra', 'gate-red', 'gate-blocked', 'blocked-mid-build',
  'escalated-conflict', 'escalated-needs-judgment', 'agent-spawn-failed', 'wrapper-threw',
  'no-free-lane', 'acquire-threw', 'could-not-predict', 'could-not-prepare',
]);

/** Outcome words that mean the dispatch DID deliver what it exists to deliver. */
export const OK_OUTCOMES = Object.freeze([
  'pr-opened', 're-armed', 'ci-healed', 'auto-cleared', 'bounced', 'parked', 'acquired', 'pass',
]);

/**
 * Map one wrapper's own outcome word onto an OTel status code. `unset` for anything unrecognised OR
 * deliberately neutral (`not-applicable`, `not-ready`) — never a guess in either direction, because a
 * mis-defaulted word would quietly bias the one number this whole file exists to make trustworthy.
 * @param {*} outcome
 * @returns {'ok'|'error'|'unset'}
 */
export function classifyOutcomeStatus(outcome) {
  const o = String(outcome ?? '').trim();
  if (ERROR_OUTCOMES.includes(o)) return 'error';
  if (OK_OUTCOMES.includes(o)) return 'ok';
  return 'unset';
}

/** The record schema version. A reader that does not recognise it must skip the line, never guess. */
export const TELEMETRY_SCHEMA_VERSION = 1;

// ── BOUNDS (a telemetry bug must never be able to fill a disk or wedge a write) ───────────────────────

/** Max characters of any single string attribute value or `statusMessage`. */
export const MAX_VALUE_LENGTH = 500;
/** Max number of keys kept in an `attributes` bag; extras are dropped (deterministically, by sort order). */
export const MAX_ATTRIBUTE_KEYS = 40;
/**
 * Hard ceiling on ONE serialized line, in bytes.
 *
 * 3800 is not arbitrary: POSIX guarantees an `O_APPEND` write of at most `PIPE_BUF` (4096 on Linux and macOS)
 * is atomic, which is what lets N concurrently-dispatched lanes append to one shared day-file without a lock
 * and without interleaving. A line over the ceiling is TRUNCATED (attributes shed first, then
 * `statusMessage`), never dropped — losing a phase's timing entirely is strictly worse than losing its
 * detail. The remaining 296 bytes of headroom absorb the trailing newline and multi-byte UTF-8.
 */
export const MAX_LINE_BYTES = 3800;

// ── SMALL PURE HELPERS ───────────────────────────────────────────────────────────────────────────────

/** @param {*} v @returns {boolean} */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Truncate `text` to at most `max` CHARACTERS, marking the cut with a trailing `…` so a reader can tell a
 * value was shortened from one that merely happens to be short. Mirrors `call-log.mjs#truncateDigest`.
 * @param {*} text @param {number} [max] @returns {string}
 */
export function truncateValue(text, max = MAX_VALUE_LENGTH) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Normalize an item reference to the trace-key form: a numeric ref via `String(Number())` (so `0341`, `341`
 * and `341 ` all key the same), a JIT `x…` slug lower-cased, anything else trimmed and lower-cased.
 *
 * Deliberately the SAME normalization `readiness/conveyor-instrument.mjs#normItemKey` already applies to its
 * dispatch-log keys — re-derived here rather than imported because that module is an IO shell (it imports
 * `node:child_process`) and this file is pure. The duplication is three lines and is asserted equivalent by
 * test; importing it would drag a subprocess dependency into every wrapper's hot path.
 * @param {*} num @returns {string}
 */
export function normItemKey(num) {
  const s = String(num ?? '').trim();
  if (s === '') return '';
  return /^\d+$/.test(s) ? String(Number(s)) : s.toLowerCase();
}

/**
 * DERIVE the stable trace id for a unit of delivery work. This is the join key for the whole system, and it
 * is derived rather than propagated on purpose — see the file header.
 *
 * Priority, and why:
 *   1. `item` → `i<normItemKey>` — the backlog item IS the lifecycle. Every wrapper that knows its item
 *      lands in the same trace as every other, across processes and across hours, with nothing passed
 *      between them.
 *   2. `pr` → `p<pr>` — the review and ci-heal wrappers are addressed by PR and may genuinely not know the
 *      item. Keying by PR is honest; a scoring pass joins `p…` to `i…` through the `item` ATTRIBUTE that a
 *      PR-addressed span carries whenever it can resolve one, or through the existing completion record
 *      (the one store that already carries `item` AND `pr` AND `runId` together).
 *   3. neither → `null`, and the caller must supply one (the recorder falls back to a random id). Returning
 *      null rather than inventing a key keeps "this work had no stable identity" visible instead of
 *      scattering it across N singleton traces that look like real ones.
 *
 * NOT included: the attempt. Attempt 2 of an item belongs in the SAME trace as attempt 1 — see the header.
 *
 * @param {{item?: *, pr?: *}} [o]
 * @returns {string|null}
 */
export function deriveTraceId({ item = null, pr = null } = {}) {
  const i = normItemKey(item);
  if (i !== '') return `i${i}`;
  const p = String(pr ?? '').trim();
  if (p !== '') return `p${p.replace(/^#/, '')}`;
  return null;
}

/**
 * Milliseconds between two ISO timestamps, or `null` when either is missing/unparseable OR the span is
 * NEGATIVE (`end` before `start` — clock skew or a mis-paired boundary). A negative duration is never
 * returned, for the same reason `conveyor-instrument.mjs#spanMs` refuses one: a `0` would understate an
 * aggregate and a `NaN` would poison every sum downstream of it.
 * @param {*} start @param {*} end @returns {number|null}
 */
export function durationMs(start, end) {
  if (start == null || end == null) return null;
  const a = Date.parse(String(start));
  const b = Date.parse(String(end));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const d = b - a;
  return d < 0 ? null : d;
}

/**
 * Coerce an arbitrary bag to a BOUNDED, serializable `attributes` object: strings truncated, finite numbers
 * and booleans kept as-is, `null` kept, everything else (objects, arrays, functions, `NaN`, `Infinity`,
 * `undefined`) JSON-ish-stringified then truncated, and the whole thing capped at
 * {@link MAX_ATTRIBUTE_KEYS} keys chosen by sorted key order so the result is DETERMINISTIC (two runs with
 * the same input drop the same keys — a non-deterministic drop would make a diff of two telemetry files
 * unreadable).
 *
 * Never throws. A getter that throws, or a circular structure, yields that key's value as the stringified
 * error rather than taking the whole span down with it — this is on the delivery critical path.
 * @param {*} attrs @returns {object}
 */
export function normalizeAttributes(attrs) {
  if (!isPlainObject(attrs)) return {};
  const out = {};
  let keys;
  try {
    keys = Object.keys(attrs).sort();
  } catch {
    return {};
  }
  for (const k of keys.slice(0, MAX_ATTRIBUTE_KEYS)) {
    let v;
    try {
      v = attrs[k];
    } catch (e) {
      out[k] = truncateValue(`<unreadable: ${e && e.message}>`);
      continue;
    }
    if (v === null) { out[k] = null; continue; }
    if (typeof v === 'boolean') { out[k] = v; continue; }
    if (typeof v === 'number') { out[k] = Number.isFinite(v) ? v : truncateValue(String(v)); continue; }
    if (typeof v === 'string') { out[k] = truncateValue(v); continue; }
    try {
      out[k] = truncateValue(JSON.stringify(v));
    } catch {
      out[k] = truncateValue(String(v));
    }
  }
  return out;
}

// ── RECORD CONSTRUCTORS ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a `span.start` line. Written only for {@link DURABLE_SPAN_NAMES} — see that constant for the trade.
 * @param {object} o
 * @returns {object}
 */
export function newSpanStart({
  traceId, spanId, parentSpanId = null, name, kind = 'unknown',
  attempt = 1, startedAt, attributes = {}, resource = {},
} = {}) {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    event: 'span.start',
    traceId: String(traceId ?? ''),
    spanId: String(spanId ?? ''),
    parentSpanId: parentSpanId == null ? null : String(parentSpanId),
    name: String(name ?? ''),
    kind: String(kind ?? 'unknown'),
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
    startedAt: String(startedAt ?? ''),
    attributes: normalizeAttributes(attributes),
    resource: normalizeAttributes(resource),
  };
}

/**
 * Build a `span.end` line — the workhorse record. `durationMs` is DERIVED from the two boundaries rather than
 * taken from the caller, so a caller can never report a duration that disagrees with its own timestamps.
 * @param {object} o
 * @returns {object}
 */
export function newSpanEnd({
  traceId, spanId, parentSpanId = null, name, kind = 'unknown',
  attempt = 1, startedAt, endedAt, status = 'unset', statusMessage = null,
  attributes = {}, resource = {},
} = {}) {
  const st = SPAN_STATUS.includes(status) ? status : 'unset';
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    event: 'span.end',
    traceId: String(traceId ?? ''),
    spanId: String(spanId ?? ''),
    parentSpanId: parentSpanId == null ? null : String(parentSpanId),
    name: String(name ?? ''),
    kind: String(kind ?? 'unknown'),
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
    startedAt: String(startedAt ?? ''),
    endedAt: String(endedAt ?? ''),
    durationMs: durationMs(startedAt, endedAt),
    status: st,
    statusMessage: statusMessage == null ? null : truncateValue(statusMessage),
    attributes: normalizeAttributes(attributes),
    resource: normalizeAttributes(resource),
  };
}

/**
 * Build a `metric` line — a point-in-time gauge or counter sample. Carries `traceId` only when the sample
 * genuinely belongs to one unit of work; a lane-pool gauge belongs to the HOST, not to an item, and correctly
 * carries `null`.
 * @param {object} o
 * @returns {object}
 */
export function newMetric({
  name, kind = 'runner', value, unit = 'count', timestamp,
  traceId = null, attributes = {}, resource = {},
} = {}) {
  const n = Number(value);
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    event: 'metric',
    name: String(name ?? ''),
    kind: String(kind ?? 'runner'),
    value: Number.isFinite(n) ? n : null,
    unit: METRIC_UNITS.includes(unit) ? unit : 'count',
    timestamp: String(timestamp ?? ''),
    traceId: traceId == null ? null : String(traceId),
    attributes: normalizeAttributes(attributes),
    resource: normalizeAttributes(resource),
  };
}

// ── VALIDATION ───────────────────────────────────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate one telemetry event. Returns `{ok, errors[]}` and NEVER throws — mirroring every other
 * `validateX` in `scripts/operations/`, and load-bearing here: the recorder calls this on the write path, and
 * a telemetry-shape bug must degrade to "this line was not written" rather than to a thrown exception inside
 * a real delivery.
 * @param {*} rec
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTelemetryEvent(rec) {
  const errors = [];
  if (!isPlainObject(rec)) return { ok: false, errors: ['record must be an object'] };
  if (rec.v !== TELEMETRY_SCHEMA_VERSION) errors.push(`unknown schema version ${JSON.stringify(rec.v)}`);
  if (!EVENT_TYPES.includes(rec.event)) errors.push(`event must be one of ${EVENT_TYPES.join('|')}`);

  if (rec.event === 'metric') {
    if (!METRIC_NAMES.includes(rec.name)) errors.push(`unknown metric name ${JSON.stringify(rec.name)}`);
    if (rec.value !== null && !Number.isFinite(rec.value)) errors.push('metric value must be a finite number or null');
    if (!METRIC_UNITS.includes(rec.unit)) errors.push(`unknown unit ${JSON.stringify(rec.unit)}`);
    if (!ISO_RE.test(String(rec.timestamp))) errors.push('timestamp must be an ISO-8601 instant');
  } else {
    if (!SPAN_NAMES.includes(rec.name)) errors.push(`unknown span name ${JSON.stringify(rec.name)}`);
    if (!rec.traceId) errors.push('traceId is required');
    if (!rec.spanId) errors.push('spanId is required');
    if (!ISO_RE.test(String(rec.startedAt))) errors.push('startedAt must be an ISO-8601 instant');
    if (!Number.isInteger(rec.attempt) || rec.attempt < 1) errors.push('attempt must be a positive integer');
    if (rec.event === 'span.end') {
      if (!ISO_RE.test(String(rec.endedAt))) errors.push('endedAt must be an ISO-8601 instant');
      if (!SPAN_STATUS.includes(rec.status)) errors.push(`status must be one of ${SPAN_STATUS.join('|')}`);
    }
  }
  if (!DISPATCH_KINDS.includes(rec.kind)) errors.push(`unknown dispatch kind ${JSON.stringify(rec.kind)}`);
  return { ok: errors.length === 0, errors };
}

// ── SERIALIZATION ────────────────────────────────────────────────────────────────────────────────────

/**
 * Serialize one event to a single NDJSON line (with its trailing newline), enforcing {@link MAX_LINE_BYTES}
 * by SHEDDING detail rather than dropping the line: attributes first (they are the bulkiest and the least
 * load-bearing), then `statusMessage`, then — only if a record is still somehow oversized — the resource bag.
 * The timing skeleton (`traceId`/`spanId`/`name`/`kind`/`durationMs`/`status`) is never shed, because that is
 * the part every rollup depends on.
 *
 * Marks what it shed with a `_truncated` field so a reader is never silently looking at a lossy record.
 * Returns `null` (never throws) if the event cannot be serialized at all.
 * @param {object} rec
 * @returns {string|null}
 */
export function serializeTelemetryEvent(rec) {
  const attempt = (r) => {
    try {
      const line = `${JSON.stringify(r)}\n`;
      return Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES ? line : null;
    } catch {
      return null;
    }
  };
  let line = attempt(rec);
  if (line) return line;

  const shedAttrs = { ...rec, attributes: {}, _truncated: 'attributes' };
  line = attempt(shedAttrs);
  if (line) return line;

  const shedMsg = { ...shedAttrs, statusMessage: null, _truncated: 'attributes,statusMessage' };
  line = attempt(shedMsg);
  if (line) return line;

  const shedAll = { ...shedMsg, resource: {}, _truncated: 'attributes,statusMessage,resource' };
  return attempt(shedAll);
}

/**
 * Parse one NDJSON line. Returns the event, or `null` for a blank/corrupt/unknown-version line — TOLERANT,
 * never throwing, exactly like `call-log.mjs#parseCallLogLine` and for the same reason: nothing is resumed
 * from this log, so a torn last line (a process killed mid-append) must not make the whole file unreadable.
 * @param {string} line
 * @returns {object|null}
 */
export function parseTelemetryLine(line) {
  const s = String(line ?? '').trim();
  if (s === '') return null;
  let rec;
  try {
    rec = JSON.parse(s);
  } catch {
    return null;
  }
  if (!isPlainObject(rec) || rec.v !== TELEMETRY_SCHEMA_VERSION) return null;
  if (!EVENT_TYPES.includes(rec.event)) return null;
  return rec;
}

/**
 * Parse a whole NDJSON blob, keeping only the lines that parse. Returns `{events, corrupt}` so a caller can
 * report corruption as a NUMBER rather than either hiding it or failing on it.
 * @param {string} text
 * @returns {{events: object[], corrupt: number}}
 */
export function parseTelemetryLines(text) {
  const events = [];
  let corrupt = 0;
  for (const raw of String(text ?? '').split('\n')) {
    if (raw.trim() === '') continue;
    const rec = parseTelemetryLine(raw);
    if (rec) events.push(rec); else corrupt += 1;
  }
  return { events, corrupt };
}

// ── READ SIDE: the rollup a future scoring pass consumes ─────────────────────────────────────────────

/**
 * Exact-rank percentile over an already-SORTED ascending numeric array (nearest-rank, the definition that
 * always returns a real observed value rather than an interpolated one that never happened). `null` on empty.
 * @param {number[]} sorted @param {number} p 0..1 @returns {number|null}
 */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** Latency summary for a bag of durations: count + the distribution shape, not just a mean (a mean alone
 *  hides exactly the tail that matters for "where did the time go"). */
function summarizeDurations(list) {
  const sorted = list.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const total = sorted.reduce((s, n) => s + n, 0);
  return {
    count: sorted.length,
    totalMs: total,
    meanMs: sorted.length ? Math.round(total / sorted.length) : null,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

/**
 * GROUP events into traces: `{ [traceId]: {traceId, kinds[], items[], spans[], starts[], metrics[]} }`.
 * Pure over an already-parsed event array.
 * @param {object[]} events
 * @returns {Record<string, object>}
 */
export function groupByTrace(events) {
  const out = {};
  for (const e of Array.isArray(events) ? events : []) {
    const id = e && e.traceId;
    if (!id) continue;
    if (!out[id]) out[id] = { traceId: id, kinds: [], items: [], spans: [], starts: [], metrics: [] };
    const t = out[id];
    if (e.kind && !t.kinds.includes(e.kind)) t.kinds.push(e.kind);
    const item = e.attributes && e.attributes.item;
    if (item != null && !t.items.includes(String(item))) t.items.push(String(item));
    if (e.event === 'span.end') t.spans.push(e);
    else if (e.event === 'span.start') t.starts.push(e);
    else t.metrics.push(e);
  }
  return out;
}

/**
 * THE FOUR GOLDEN SIGNALS (Google SRE), computed over a parsed event array. This is the function a future
 * run-scoring pass calls — the schema above exists to make exactly this cheap, and nothing here needs a
 * second pass over disk or a `gh` call.
 *
 *   • LATENCY   — per-span-name duration distributions (count/mean/p50/p90/p99/max) plus end-to-end per kind,
 *                 taken from the root `dispatch` span. Distributions, not means: the p99 of `agent.turn` is
 *                 the number that decides whether the 60-minute cap is binding.
 *   • TRAFFIC   — dispatch volume: root spans per kind, distinct traces, spans total.
 *   • ERRORS    — `status === 'error'` RATE per span name and per kind, WITH the classified reason
 *                 (`statusMessage`) counted, so "12% of fix dispatches fail" is immediately followed by "and
 *                 9 of the 11 were `blocked-on-infra`". A count without the classification is the thing
 *                 today's fix-report store already gives and is not enough to act on.
 *   • SATURATION— gauge summaries per metric name (min/max/mean/last) plus the admission ledger
 *                 (admitted vs denied, with denial reasons), which is the signal the running system produces
 *                 today and persists nowhere.
 *
 * Plus two things a delivery system specifically needs that the four signals do not name:
 *   • RETRIES   — attempts per span name (`maxAttempt`, how many spans ran at attempt > 1). Uniform across
 *                 every kind, which is precisely what today's per-store attempt bookkeeping is not.
 *   • ABANDONED — `span.start` lines with no matching `span.end` (see {@link DURABLE_SPAN_NAMES}).
 *
 * @param {object[]} events
 * @returns {object}
 */
export function goldenSignals(events) {
  // A `null`/non-object entry is not merely defensive paranoia: `parseTelemetryLines` never produces one, but
  // a CALLER that concatenates its own arrays can, and a rollup that throws is a rollup that takes down
  // whatever asked for it. Filtered once, here, so nothing downstream has to guard.
  const list = (Array.isArray(events) ? events : []).filter((e) => !!e && typeof e === 'object');
  const ends = list.filter((e) => e.event === 'span.end');
  const starts = list.filter((e) => e.event === 'span.start');
  const metrics = list.filter((e) => e.event === 'metric');

  // ── latency ──
  const bySpanDur = {};
  const endToEndDur = {};
  for (const e of ends) {
    if (!Number.isFinite(e.durationMs)) continue;
    (bySpanDur[e.name] ||= []).push(e.durationMs);
    if (e.name === 'dispatch') (endToEndDur[e.kind] ||= []).push(e.durationMs);
  }
  const latency = {
    bySpan: Object.fromEntries(Object.entries(bySpanDur).map(([k, v]) => [k, summarizeDurations(v)])),
    endToEndByKind: Object.fromEntries(Object.entries(endToEndDur).map(([k, v]) => [k, summarizeDurations(v)])),
  };

  // ── traffic ──
  const traces = new Set();
  const rootsByKind = {};
  const spansByKind = {};
  for (const e of ends) {
    if (e.traceId) traces.add(e.traceId);
    spansByKind[e.kind] = (spansByKind[e.kind] || 0) + 1;
    if (e.name === 'dispatch') rootsByKind[e.kind] = (rootsByKind[e.kind] || 0) + 1;
  }
  const traffic = {
    traces: traces.size,
    spans: ends.length,
    dispatchesByKind: rootsByKind,
    spansByKind,
    dispatches: Object.values(rootsByKind).reduce((s, n) => s + n, 0),
  };

  // ── errors ──
  const mkErrBucket = () => ({ total: 0, errors: 0, rate: 0, reasons: {} });
  const errBySpan = {};
  const errByKind = {};
  let totalErr = 0;
  for (const e of ends) {
    const a = (errBySpan[e.name] ||= mkErrBucket());
    const b = (errByKind[e.kind] ||= mkErrBucket());
    a.total += 1; b.total += 1;
    if (e.status === 'error') {
      a.errors += 1; b.errors += 1; totalErr += 1;
      // The CLASSIFIED reason — a wrapper's own outcome word when it set one, else the status message.
      const reason = (e.attributes && e.attributes.outcome) || e.statusMessage || 'unclassified';
      a.reasons[reason] = (a.reasons[reason] || 0) + 1;
      b.reasons[reason] = (b.reasons[reason] || 0) + 1;
    }
  }
  for (const b of [...Object.values(errBySpan), ...Object.values(errByKind)]) {
    b.rate = b.total ? b.errors / b.total : 0;
  }
  const errors = {
    bySpan: errBySpan,
    byKind: errByKind,
    overall: { total: ends.length, errors: totalErr, rate: ends.length ? totalErr / ends.length : 0 },
  };

  // ── saturation ──
  const gauges = {};
  for (const m of metrics) {
    if (!Number.isFinite(m.value)) continue;
    const g = (gauges[m.name] ||= { samples: 0, min: null, max: null, sum: 0, mean: null, last: null, unit: m.unit });
    g.samples += 1;
    g.sum += m.value;
    g.min = g.min === null ? m.value : Math.min(g.min, m.value);
    g.max = g.max === null ? m.value : Math.max(g.max, m.value);
    g.last = m.value;
  }
  for (const g of Object.values(gauges)) g.mean = g.samples ? g.sum / g.samples : null;

  const admitted = metrics.filter((m) => m.name === 'dispatch.admitted').reduce((s, m) => s + (m.value || 0), 0);
  const denied = metrics.filter((m) => m.name === 'dispatch.denied').reduce((s, m) => s + (m.value || 0), 0);
  const denyReasons = {};
  for (const m of metrics) {
    if (m.name !== 'dispatch.denied' || !m.value) continue;
    const r = (m.attributes && m.attributes.reason) || 'unclassified';
    denyReasons[r] = (denyReasons[r] || 0) + m.value;
  }
  const saturation = {
    gauges,
    admission: { admitted, denied, total: admitted + denied, denyRate: (admitted + denied) ? denied / (admitted + denied) : 0, reasons: denyReasons },
  };

  // ── retries ──
  const retries = {};
  for (const e of ends) {
    const r = (retries[e.name] ||= { spans: 0, retried: 0, maxAttempt: 1 });
    r.spans += 1;
    if (e.attempt > 1) r.retried += 1;
    if (e.attempt > r.maxAttempt) r.maxAttempt = e.attempt;
  }

  // ── abandoned (a durable start with no end) ──
  const endedIds = new Set(ends.map((e) => e.spanId));
  const abandoned = starts
    .filter((s) => !endedIds.has(s.spanId))
    .map((s) => ({ traceId: s.traceId, spanId: s.spanId, name: s.name, kind: s.kind, startedAt: s.startedAt, attempt: s.attempt }));

  return { latency, traffic, errors, saturation, retries, abandoned, corrupt: 0 };
}

// ── HOST-PROCESS REPORTING LAYER (#3383 telemetry-granularity follow-on) ───────────────────────────────

/**
 * THE DEFAULT "SUBSTANTIAL" REPORTING BAR — deliberately the SAME numbers as
 * `host-process-sample.mjs#DEFAULT_PROCESS_CPU_PCT`/`#DEFAULT_PROCESS_MEM_BYTES`, the collection-time storage
 * floor. See that constant's own docblock for the real-data sizing math (a 954-process capture on this host,
 * three candidate floors costed out in MB/day) that landed on this exact pair. Re-exported here, under this
 * module's own name, so a caller of {@link summarizeHostProcesses} is not required to reach into the
 * collection module just to know its own function's default.
 */
export const DEFAULT_SUBSTANTIAL_CPU_PCT = 2;
/** @see DEFAULT_SUBSTANTIAL_CPU_PCT — 200MB, in bytes. */
export const DEFAULT_SUBSTANTIAL_MEM_BYTES = 200 * 1024 * 1024;

/**
 * PURE. THE REPORTING/QUERY LAYER — reads back the individual `host.process.entry.*` samples
 * `host-process-sample.mjs#processSnapshotMetrics` wrote (paired `cpu_pct`/`mem_bytes` metric lines sharing one
 * tick + pid) and decides, per sample, whether it clears the "substantial" bar. This is the split the operator
 * asked for explicitly: collection just stores identity; THIS function is where "does this deserve its own
 * named entry" is actually decided, and it can be re-decided at any time — raise or lower `cpuThresholdPct`/
 * `memThresholdBytes` and re-run this over the SAME stored events, no re-collection needed.
 *
 * THE ONE HARD LIMIT, stated rather than hidden: a threshold LOWER than the collection-time storage floor
 * cannot recover detail that plain never got written — an `host.process.entry.*` sample only exists for a
 * process that already cleared `host-process-sample.mjs`'s own floor on the tick it was sampled. Passing a
 * looser threshold here just means everything already stored qualifies as substantial (the below-threshold
 * remainder this function computes will be empty save for whatever `host.process.below_floor_remainder.*`
 * already folded in at collection time — see below). A STRICTER threshold works exactly as advertised: some
 * already-stored rows move from "substantial" into this function's own remainder.
 *
 * GROUPED BY `command` (not `pid`) for the "substantial" bucket — a PID is a single tick's OS-assigned number
 * and is meaningless to roll up ACROSS ticks (a restarted helper gets a new one); the full command line is the
 * stable identity across the window, matching how `host-process-sample.mjs`'s own fixed-category matchers
 * already key on command, not pid. `pids` on each group lists every distinct pid observed, so "one process that
 * restarted 3 times" is still distinguishable from "3 processes running concurrently" if a reader needs that.
 * The label is the command line passed through `command-redact.mjs#redactCommandLine` again at READ time, so
 * lines stored before redaction existed (or by a caller that skipped it) are still masked in any report.
 *
 * THE MEAN IS WINDOW-NORMALISED, PER TICK (the arithmetic that makes the report reconcile with the machine).
 * A row only exists for a tick where its process cleared the storage floor, and several rows can share one
 * command on one tick (N Electron helpers with an identical command line, each its own pid). So, per group:
 *   1. rows are SUMMED per tick — N concurrent same-command processes contribute their combined load, not
 *      an average of them;
 *   2. that per-tick sum is divided by `windowTicks`, the count of DISTINCT ticks in the window that recorded
 *      any `host.process.*` sample — a tick where the group was absent counts as zero, not as "no data".
 * The same divisor is applied to `belowThresholdRemainder`. Per tick the machine is exactly
 * `fixed categories + substantial entries + below-floor remainder`, so the mean of each part over the SAME
 * `windowTicks` sums to the mean of the whole — the report's total is a true window mean, comparable to
 * `host.cpu.load1`. A tick is identified by its `tick` attribute; the runner restarts numbering at 0, so a
 * number LOWER than the previous one (in event order) starts a new run and is counted as a new tick, not
 * merged with the earlier run's. A sample with no `tick` attribute falls back to its `timestamp`.
 *
 * THE REMAINDER STAYS HONEST: `belowThresholdRemainder` sums, per tick, BOTH (a) any stored `entry` row this
 * function's own threshold judged not substantial, and (b) that tick's `host.process.below_floor_remainder.*`
 * sample (the collection-time floor's own remainder) — BEFORE averaging, so a stricter threshold never mixes a
 * single process row into a mean with a whole tick's aggregate. `substantial` entries + `belowThresholdRemainder`
 * + the three fixed categories (already reported by `goldenSignals`'s `saturation.gauges`, untouched by this
 * function) therefore still account for the whole machine, the same honesty invariant the original `other`
 * bucket existed to uphold. Any process that was substantial on some ticks and merely below-floor on others
 * has the latter ticks in the remainder — never lost, never double counted.
 * @param {object[]} events already-read telemetry events (see `telemetry-store.mjs#readAll`/`readDay`)
 * @param {{cpuThresholdPct?: number, memThresholdBytes?: number}} [opts]
 * @returns {{substantial: Array<{label: string, pids: number[], meanCpuPct: number, meanMemBytes: number,
 *   maxCpuPct: number, maxMemBytes: number, samples: number}>,
 *   belowThresholdRemainder: {meanCpuPct: number, meanMemBytes: number, samples: number},
 *   windowTicks: number, cpuThresholdPct: number, memThresholdBytes: number}}
 *   `samples` on a group / the remainder is the number of DISTINCT TICKS it appeared in (out of `windowTicks`);
 *   `maxCpuPct`/`maxMemBytes` are the peak PER-TICK sum for the group.
 */
export function summarizeHostProcesses(events, {
  cpuThresholdPct = DEFAULT_SUBSTANTIAL_CPU_PCT, memThresholdBytes = DEFAULT_SUBSTANTIAL_MEM_BYTES,
} = {}) {
  const list = (Array.isArray(events) ? events : []).filter((e) => !!e && typeof e === 'object' && e.event === 'metric'
    && typeof e.name === 'string' && e.name.startsWith('host.process.'));

  // Assign every process sample a tick id (see the docblock's restart handling), and record every tick seen.
  const tickIds = new Set();
  const attrsOf = (m) => ((m.attributes && typeof m.attributes === 'object') ? m.attributes : {});
  let epoch = 0;
  let lastTick = null;
  const tickOf = new Map(); // metric -> tick id
  for (const m of list) {
    const t = attrsOf(m).tick;
    let id;
    if (Number.isFinite(t)) {
      if (lastTick !== null && t < lastTick) epoch += 1;
      lastTick = t;
      id = `${epoch}:${t}`;
    } else {
      id = `ts:${m.timestamp ?? ''}`;
    }
    tickOf.set(m, id);
    tickIds.add(id);
  }
  const windowTicks = tickIds.size;

  // Pair each tick+pid's cpu_pct/mem_bytes lines back into one row — mirrors how `processSnapshotMetrics`
  // wrote them (two lines, same `attributes.pid`/`attributes.tick`, one name each).
  const byKey = new Map();
  for (const m of list) {
    if (!m.name.startsWith('host.process.entry.')) continue;
    const attrs = attrsOf(m);
    const tick = tickOf.get(m);
    const key = `${tick}:${attrs.pid ?? ''}:${attrs.command ?? ''}`;
    const row = byKey.get(key) || { tick, pid: attrs.pid ?? null, command: String(attrs.command ?? ''), cpuPct: 0, memBytes: 0 };
    const v = Number.isFinite(m.value) ? m.value : 0;
    if (m.name.endsWith('.cpu_pct')) row.cpuPct = v;
    if (m.name.endsWith('.mem_bytes')) row.memBytes = v;
    byKey.set(key, row);
  }

  const groups = new Map(); // label -> { pids:Set, perTick: Map<tick, {cpu, mem}> }
  const remainderByTick = new Map(); // tick -> {cpu, mem}
  const addTo = (map, tick, cpu, mem) => {
    const cur = map.get(tick) || { cpu: 0, mem: 0 };
    cur.cpu += cpu;
    cur.mem += mem;
    map.set(tick, cur);
  };
  for (const row of byKey.values()) {
    const substantial = row.cpuPct > cpuThresholdPct || row.memBytes > memThresholdBytes;
    if (substantial) {
      const command = redactCommandLine(row.command);
      const label = command || (row.pid == null ? '(unknown process)' : `pid ${row.pid}`);
      const g = groups.get(label) || { pids: new Set(), perTick: new Map() };
      if (row.pid != null) g.pids.add(row.pid);
      addTo(g.perTick, row.tick, row.cpuPct, row.memBytes);
      groups.set(label, g);
    } else {
      addTo(remainderByTick, row.tick, row.cpuPct, row.memBytes);
    }
  }

  // Fold in each tick's collection-time floor remainder — see the docblock's "the remainder stays honest".
  for (const m of list) {
    if (!Number.isFinite(m.value)) continue;
    if (m.name === 'host.process.below_floor_remainder.cpu_pct') addTo(remainderByTick, tickOf.get(m), m.value, 0);
    else if (m.name === 'host.process.below_floor_remainder.mem_bytes') addTo(remainderByTick, tickOf.get(m), 0, m.value);
  }

  const total = (perTick, field) => { let n = 0; for (const v of perTick.values()) n += v[field]; return n; };
  const peak = (perTick, field) => { let n = 0; for (const v of perTick.values()) n = Math.max(n, v[field]); return n; };
  const norm = (n) => (windowTicks ? n / windowTicks : 0);

  const substantial = [...groups.entries()]
    .map(([label, g]) => ({
      label,
      pids: [...g.pids].sort((a, b) => a - b),
      meanCpuPct: norm(total(g.perTick, 'cpu')),
      meanMemBytes: norm(total(g.perTick, 'mem')),
      maxCpuPct: peak(g.perTick, 'cpu'),
      maxMemBytes: peak(g.perTick, 'mem'),
      samples: g.perTick.size,
    }))
    .sort((a, b) => b.meanCpuPct - a.meanCpuPct || b.meanMemBytes - a.meanMemBytes);

  return {
    substantial,
    belowThresholdRemainder: {
      meanCpuPct: norm(total(remainderByTick, 'cpu')),
      meanMemBytes: norm(total(remainderByTick, 'mem')),
      samples: remainderByTick.size,
    },
    windowTicks,
    cpuThresholdPct,
    memThresholdBytes,
  };
}
