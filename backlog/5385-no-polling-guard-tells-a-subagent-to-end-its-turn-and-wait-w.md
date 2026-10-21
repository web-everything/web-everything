---
bornAs: x1wxvav
kind: story
size: 1
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash-no-polling.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# No-polling guard tells a subagent to end its turn and wait, which stalls it forever

The reported refusal wording has already been replaced: agent sessions are told to perform one bounded check, continue, or finish and report pending work. Preserve the existing regression coverage; do not invent another behavior change.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/guard-bash-no-polling.test.mjs` — existing assertions at we:scripts/__tests__/guard-bash-no-polling.test.mjs:149 require ONE bounded check and CONTINUE, and reject the old harness-resume advice for agent loop/long-wait refusals.
- [A2] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/guard-bash-no-polling.test.mjs` — existing decide() and hook-output cases preserve denial and session-specific advice, including the interactive session. These checks already target the shipped fix; there is no honest new red-to-green criterion for the stale premise.

## Non-goals

- [N1] No polling allowlist changes, automatic subagent resumption, daemon redesign or weaker refusal.

## Edge cases this change must handle

1. **Untrusted text** — The refusal is fixed guidance; command text cannot supply an instruction to relax it.
2. **Truncated reads** — n/a: this wording change does not read logs or partial tool output.
3. **Shared state files** — n/a: refusal guidance does not write shared state or resume markers.
4. **Fail closed** — Polling loops and excessive waits remain denied; only recovery advice changes, regardless of whether the pending work is source, docs, config or data.
5. **Identity scoping** — Agent-session guidance uses existing session detection; interactive sessions must not be promised automatic resumption either.
6. **State over time** — One bounded check is followed by continuing work or finishing with pending work reported; no indefinite idle turn.
7. **Who wrote it** — The guard authors the refusal; agent-supplied command text does not authorize waiting. No receive endpoint is involved; HTTP abuse controls are inapplicable.

## Grounding

- we:scripts/guard-bash.mjs:2447 explicitly says not to end a turn waiting; lines 2448–2454 give bounded-check and finish/report guidance.
- we:scripts/__tests__/guard-bash-no-polling.test.mjs:149 documents the incident and tests the new advice; line 255 checks the hook output.

## Open questions

STALE: the requested wording and regression coverage already exist. Should this card be closed as shipped, or does a distinct refusal path still reproduce the stall? A concrete remaining path is needed before authorizing more implementation.
