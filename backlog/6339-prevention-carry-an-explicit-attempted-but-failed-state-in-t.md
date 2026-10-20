---
bornAs: x5zncjw
kind: story
size: 3
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/drain-saved-red-team.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs", "we:scripts/lib/__tests__/drain-saved-red-team.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Carry an explicit 'attempted-but-failed' state in the evidence (for example attempted:true). Have… (from web-everything/web-everything#5551 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#5551's review (reviewed head `6b4b3057ee20dc396123edb354ac8ada36fe49c6`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/drain-red-team-evidence.mjs:44` — Carry an explicit 'attempted-but-failed' state in the evidence (for example `attempted:true`). Have the overdue fallback refuse to enqueue, and instead re-request or escalate to a human, when an attempt exists without a usable result. Pin it with a strategy-level test: after the deadline, an error or unparseable row does not enqueue.
2. `we:scripts/lib/drain-saved-red-team.mjs:33` — Add table-driven tests for every `throw` in the reader. A lint or standards rule could require each `throw new Error` in a lib reader to be matched by a `toThrow` test.

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
