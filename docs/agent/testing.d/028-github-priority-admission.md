## GitHub priority admission

The throttle returns a JSON `deferred-low-budget` result without invoking GitHub when a fresh,
identity-scoped GraphQL observation crosses the caller's reservation threshold (background 25%,
normal 10%). CLI status is zero; stderr and the spend report distinguish a skipped pass from success.
Use `isGhDeferred` from `we:scripts/lib/gh-deferred.mjs` before parsing query data or caching results;
a deferred response is not an empty PR list. Discovery CLI passes can use `deferGhPass` to skip before
making decisions. Critical review/drain callers still respect actual exhaustion and secondary backoff.
Test with a temporary throttle root and injected subprocesses; never spend live GitHub quota to test scarcity.
The gh holder policy lives in `scripts/settings/gh-throttle.json` and resolves once per process/env object. Holder tests use a temporary lock root and injected clock/sleep; watch calls must remain unslotted. Watch detection and the write/op classifiers read gh argv the way gh's own parser does, so test leading global flags (`--repo o/r run watch`), `--flag=value` booleans and flag values that look like flags (`--body --watch`). Verify timeout fidelity against a real local child, preserving native timeout errors and releasing its slot without signalling the holder process.
Holder diagnostics persist only allowlisted command labels, omitting endpoints and all argument values. Sanitize old metadata and process-table commands at the output boundary as well as new lock writes. Cover admission with a decision table over caller-capped, pool-full and over-age states. Reaping waits for the greater of policy and the recorded effective timeout plus grace; an explicit zero timeout prevents age-based reaping of that holder. Metric operation labels use the same bounded vocabulary as default call logs.
Daemon simulator worlds with independent clocks must each override `WE_GH_THROTTLE_LOCK_ROOT`
and `WE_COORDINATION_ROOT`, even when Vitest already supplies per-file roots. A previous world's
future-dated exhausted budget can otherwise make a fresh world wait for the production timeout.
Use the clone's routing policy rather than an inherited daemon snapshot, and exclude generated
GitHub App shim directories before scanning the host's tool PATH.

General simulator and soak fixtures model the full required-check set and pin `WE_REVIEW_START_AFTER=ci-green`
in the shared world environment. Keep the planner and dispatch-time gate on the same fixture policy across
daemon restarts. Production fast-check eligibility is covered by `review-timing-dispatch.test.mjs` and
`review-ci-gate-io.test.mjs`; scenarios exercising that timing must explicitly set their world policy and checks.

Fake-`gh` CLI fixtures that exercise throttling must set `WE_GH_THROTTLE_LOCK_ROOT` to a temporary
directory per invocation and route the binary to their fake. An intentional rate-limit response writes
cooldown state; sharing that state with another test or the host delays unrelated reads.
Generated shims that embed functions with `Function#toString` must embed every dependency as well.
Keep the resource classifier and its argv parsers together in `scripts/lib/gh-argv.mjs`: imported
references inside a stringified function can retain Vite's SSR binding names. Exercise the emitted
source in an empty VM context and the real shim after its generating checkout is removed.
For Node subprocess script paths imported by Vitest's browser environment, use
`join(dirname(fileURLToPath(import.meta.url)), filename)`: Vite can rewrite a relative `new URL(...,
import.meta.url)` as a browser asset URL, which `fileURLToPath` then rejects.

