---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/worker-wrapper.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/review-job-store.mjs", "we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/lib/dispatch-throttle.mjs", "we:scripts/operations/completion-cli.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Worker result contract S3b: fix, ci-heal and review launches run through the detached worker wrapper

117 D7 FINAL slice S3b, stacked on S3a (#4439). Move the fix dispatch, ci-heal dispatch and review dispatch launches off claude --bg onto the unified detached worker wrapper, so each ends with a schema-checked completion record v2. Fix and ci-heal: claude -p with --json-schema via launchDetached; handle pid:<wrapperPid>; liveness from the wrapper pid (claim runner pid + listing rows from live v2 records). Review: the session path uses the wrapper; the default review job writes a v2 envelope (started + done) with a schema-checked result. The agent's own legacy outcome words are preserved on the envelope so reconcile behaves the same. Done when: vitest covers the argv conversion, the legacy-word preservation, the listing rows and the review-job envelope; live: one real fix or review dispatch after edge load writes a v2 record (before/after).

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/worker-wrapper-launch.test.mjs we:scripts/operations/__tests__/review-job-envelope.test.mjs` passes (the modules do not exist before): a `--bg` argv becomes `-p --session-id … --output-format json --json-schema …` with the prompt suffix; the agent's own legacy outcome words survive on the v2 envelope; a live wrapped v2 record becomes a listing row and a dead one does not; a claim with a dead runner pid is not live; the review job writes a v2 started and a v2 done record with a schema-valid result and the same outcome/label/verdict words.
2. **Live** — after the edge load on the fix and review daemon clones, one real fix or review dispatch writes a v2 completion record (`completion-cli show --session=<slug>` shows `v:2`, `pid`, `parse`, `result`, `action`); the previous record for the same kind was v1.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — The worker result goes through the S1 validator and S2 redaction; the review job's label text is redacted into the result summary; nothing routes on prose.
2. **Truncated reads** — A truncated stdout fails JSON parse and is unparseable; a half-written record is never read (atomic store writes).
3. **Shared state files** — One record per session slug under the completion lock; the agent's own `report` on a wrapped (v2) record keeps it v2 instead of downgrading it.
4. **Fail closed** — No/invalid structured output is contract-violation; a dead wrapper pid releases the claim and drops the listing row; an unknown launcher stays on the old path.
5. **Identity scoping** — The wrapped session gets a minted `--session-id`, stamped on the record, so the agent's own reports pass the existing owner check.
6. **State over time** — Rows for done wrapped records are emitted only within the longest reconcile cool-off window, so cool-offs still hold; the knob `WE_WORKER_WRAPPER=off` restores the old launches.
7. **Who wrote it** — The wrapper (or the review job) writes the envelope; the agent only emits the result object and its legacy report words.
