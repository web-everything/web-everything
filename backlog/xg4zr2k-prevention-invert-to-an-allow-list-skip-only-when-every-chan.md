---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild/skip-unrelated.mjs", "we:scripts/lib/daemon-rebuild/__tests__/skip-unrelated.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Invert to an allow-list: skip only when every changed file matches a known-inert pattern (docs/,… (from web-everything/web-everything#4272 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4272's review (reviewed head `0eb9dfb592a2b8e3bb1c4a54f581496000b4e3f6`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/daemon-rebuild/skip-unrelated.mjs:165` — Invert to an allow-list: skip only when every changed file matches a known-inert pattern (docs/, backlog/, *.md outside skills-src). Add a test that sweeps repo files read via readFileSync and asserts none classify as skippable.
2. `we:scripts/lib/daemon-rebuild/skip-unrelated.mjs:167` — In decideSkipRebuild, make the skip allowlist-based instead of denylist-based: skip only for known-inert paths (docs/, backlog/, *.md outside runtime-read trees) and send every other changed file, including all .json, to the smoke. Pin it with a test that a non-literal JSON read still smokes.
3. `we:scripts/lib/daemon-rebuild/skip-unrelated.mjs:119` — Add a deterministic regression test for computed spawn/fork/exec targets and mark unresolved execution targets incomplete so code changes require smoke.

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
