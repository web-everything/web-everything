---
kind: story
size: 3
status: open
scope: ["we:scripts/verify-lane.mjs we:scripts/forge-exec-run.mjs we:scripts/verify-remote-routing.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Remote verify raw-command fallbacks: route allowed vitest flags remote and extend the Forge argv allowlist

R909 (2026-11-12 20:47 ET, 2026-11-13 07:31 and 08:26 ET, plus gate-timeout-retry). Flags --passWithNoTests and --testTimeout/--hookTimeout are allowed remote but log raw-command because acquireAdmission in we:scripts/verify-lane.mjs passes forceLocal=true (always-run guard/tests phases); route them remote. Runs with --reporter/--outputFile are not recognised and run on the Mac. VITEST_ALLOWED_OPTIONS in we:scripts/forge-exec-run.mjs rejects --maxWorkers/--minWorkers/--no-file-parallelism, so isolated retries (isolatedRetryArgv) run on the Mac (20 min per 12h); extending it needs a security review of the Forge argv allowlist and the deployed wrapper (file held by PR 6745). Related: we:scripts/verify-remote-routing.mjs

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Duplicate admission

capability-search found no matching open card
