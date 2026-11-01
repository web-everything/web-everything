---
bornAs: x1r8mf2
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/forge-exec-run.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Forge runner allowlist: widen for soak (config flag) and the always-run guard (json reporter)

R332 routed files-scan and whole-verify chains to Forge. Two heavy kinds cannot route under the installed runner allowlist: soak runs vitest with a --config flag for we:vitest.soak.config.ts (flag refused), and the verify always-run guard uses a json reporter with an outputFile read back locally to prove each guard ran. Both need a runner allowlist widening in we:scripts/readiness/forge-exec-run.mjs (root redeploy, operator call) plus a way to return the report.

## Acceptance

- [A1] **Executable** — `node we:scripts/verify-lane.mjs` on a diff touching soak config routes the soak vitest run (with its --config flag) to Forge and passes; before this item the runner allowlist refuses the flag and the run stays local. Likewise the always-run guard with a json reporter returns its report from Forge.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not widen the allowlist for arbitrary vitest flags or reporters; only the soak --config and the guard json reporter are in scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Flag and reporter values are matched against exact allowlist entries; anything else is refused and runs local.
2. **Truncated reads** — The returned report must parse completely; a truncated report counts as the guard not having run.
3. **Shared state files** — n/a: the report is returned in the run result, not written to a shared file.
4. **Fail closed** — Any runner error or refusal falls back to local execution, never to a silent pass.
5. **Identity scoping** — n/a: the allowlist is per runner, not per user.
6. **State over time** — n/a: no state is kept between runs.
7. **Who wrote it** — n/a: the allowlist change is an operator redeploy; agents only propose it.
