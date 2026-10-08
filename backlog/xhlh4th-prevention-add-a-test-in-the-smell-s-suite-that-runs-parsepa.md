---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/health-watch-core.mjs", "we:scripts/conveyor/health-smells/pass-failing-repeatedly.mjs", "we:scripts/conveyor/health-smells/__tests__/pass-failing-repeatedly.test.mjs", "we:scripts/conveyor/__tests__/health-watch-core.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a test in the smell's suite that runs parsePassFailures over formatRepeatLine output. Longer… (from web-everything/web-everything#4472 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4472's review (reviewed head `183ab4b47afaca52b7ddd610798852368f7d96f1`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/health-watch-core.mjs:236` — Add a test in the smell's suite that runs parsePassFailures over `formatRepeatLine` output. Longer term, add a lint or shared helper so every daemon-log parser goes through one `readDaemonLines()` that expands repeats and strips stamps.
2. `we:scripts/conveyor/health-smells/pass-failing-repeatedly.mjs:65` — Add a boundary test: one failure, slow interval, now = T+30 min, expect no breach. Alternatively require streak >= 2 for the no-success trigger.
3. `we:scripts/conveyor/health-watch-core.mjs:240` — Add a shared `quoteLogLine()` helper that strips ANSI/control characters, collapses whitespace and caps length. Have the smells use it, and add a lint or standards rule that health-smell summaries interpolate log text only through that helper.
4. `we:scripts/conveyor/health-smells/__tests__/pass-failing-repeatedly.test.mjs` — Add the named deterministic regression tests to the unit-test gate, including explicit bootstrap:true inputs and boundary-sized histories.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
