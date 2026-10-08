---
kind: story
size: 1
status: resolved
scope: ["we:scripts/probes/worker-result-probe.mjs", "we:scripts/probes/__tests__/worker-result-probe.test.mjs"]
dateOpened: "2026-10-08"
dateStarted: "2026-10-08"
dateResolved: "2026-10-08"
graduatedTo: worker-contract-s1
tags: []
---

# Worker result contract S0: launcher probe matrix (schema enforcement, structured output, resume, failure shapes)

117 S0: a probe script that checks, for claude -p, claude --bg, codex exec and agy, whether a JSON schema is enforced, where the result lands, whether resume keeps the schema, and what a failure looks like. Findings recorded in the PR. Spec: prepare-117 section 8 (S0), decisions D1-D8 settled 2026-10-08.

## Done when

1. **Executable** — running `we:scripts/probes/worker-result-probe.mjs` under node with `--json` exits 0 and prints `{honored, resultLocation}` per launcher (claude -p, claude --bg, claude --bg --resume, codex exec, codex exec resume, agy); the findings are recorded in the PR.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the probe only reads CLI output it asked for; it never routes on it.
2. **Truncated reads** — Output is parsed whole; a cut-off or non-JSON result is reported as honored:false with the reason.
3. **Shared state files** — n/a: writes nothing outside a temp dir it creates and removes.
4. **Fail closed** — A missing CLI, auth failure or timeout is reported per launcher as honored:null with the reason, never as success.
5. **Identity scoping** — n/a: no per-user or per-session identity is used.
6. **State over time** — n/a: a one-shot read-only check.
7. **Who wrote it** — n/a: all output is the probe's own.
