---
bornAs: xs3192y
kind: story
size: 3
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs", "we:scripts/lib/__tests__/merge-queue-adaptive-batching.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a shell-level test that supplies native membership and tip and asserts a POST cancel happens… (from web-everything/web-everything#5217 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#5217's review (reviewed head `bb50d410d8a20e792215780fed00e1a1271ef3b4`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:340` — Add a shell-level test that supplies native membership and tip and asserts a POST cancel happens under HEADGREEN. Alternatively make the selector throw on unknown arguments so a mismatched key fails loudly. Also state in the PR text that HEADGREEN savings need native-group data the shell lacks.
2. `we:scripts/lib/merge-queue-adaptive-batching.mjs:259` — Use a long finite lease (e.g. 10 minutes) so a genuinely abandoned lock is eventually reclaimed. Alternatively fail open on ELOCKTIMEOUT after N consecutive deferrals. Add a stale-lock recovery test.
3. `we:scripts/lib/merge-queue-adaptive-batching.mjs` — Add a deterministic IO test named 'skips cancellation reads without native group facts' that rejects ruleset and workflow-run requests when authoritative native groups are unavailable.
4. `we:scripts/lib/merge-queue-adaptive-batching.mjs:403` — Persist pending dequeue intents and add deterministic failure-injection tests covering a failed request and restart between state persistence and effect execution.

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
