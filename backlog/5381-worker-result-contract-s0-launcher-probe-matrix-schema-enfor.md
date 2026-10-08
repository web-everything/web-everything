---
bornAs: xqzqxn3
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
2. **Truncated reads** — Output is parsed whole; a non-JSON first reply (claude -p, agy) is honored:null with the reason, and a result that parses but does not match the schema shape is honored:false.
3. **Shared state files** — Writes only a temp dir it removes, but the live runs leave session records behind (claude session, ~/.claude/jobs/<id>, a Codex thread, an agy conversation); the header says so.
4. **Fail closed** — A missing CLI, an unparseable first reply (auth failure) or a first-call timeout is reported per launcher as honored:null with the reason; an unknown --only name exits 2; never reported as success.
5. **Identity scoping** — n/a: no per-user or per-session identity is used.
6. **State over time** — The probe starts live paid sessions (small, haiku and one-line prompts); the two --bg sessions are stopped by id.
7. **Who wrote it** — n/a: all output is the probe's own.
