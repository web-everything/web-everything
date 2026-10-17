---
kind: story
size: 5
parent: "xrlwbd7"
status: open
blockedBy: ["xdstsoh"]
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency slice 2 — settings table used by the ruling step

Add the review-stringency settings table (class by level to block, expedite, debt or advisory), every cell a cascade setting with its source logged, and make the ruling step read it. Fail closed on gaps. Current level internal delivery.

## Acceptance

- [A1] **Executable** — validator test `settings-table-schema` over `we:scripts/settings/review-stringency.json` rejects an unknown class, a missing level cell, or a debt cell without a must-pay-before level, and passes on the ratified amended table.
- [A6] **Executable** — validator test `monotonic-levels` rejects fixtures where a class blocks at one level but becomes expedite, debt or advisory at any higher level; the ratified table passes.
- [A7] **Executable** — ruling-step test `table-gap-blocks` supplies a missing class/level cell and observes block.
- [A2] **Executable** — ruling-step test `override-precedence` supplies a reviewer tag that conflicts with a matching path rule, then with a matching pattern rule; each rule wins and the outcome comes from the overridden class at the current level. With no matching rule, the reviewer tag supplies the class.
- [A3] **Executable** — ruling-step test `confidence-cap` covers each non-always-block outcome (block, expedite, debt, advisory): an explicitly valid low reviewer confidence yields advisory. Invalid or missing confidence is handled first by A8.
- [A4] **Executable** — settings-write test `settings-edit-authority` rejects agent attempts to change any table cell, an invariant row, or the current level, leaving the effective settings unchanged; the corresponding operator edits succeed and log the setting source and operator identity.
- [A5] **Executable** — ruling-step test `careless-debt-block` rejects reckless or inadvertent debt as block regardless of the configured cell or low reviewer confidence; prudent-deliberate debt follows the class/level outcome and confidence rules.
- [A8] **Executable** — ruling-step test `malformed-finding-blocks` independently omits and corrupts class, severity and confidence (null, wrong type, empty, garbage and instruction strings); each yields block before the confidence cap. Class values with changed case, surrounding whitespace, invisible characters or Unicode lookalikes are rejected, never silently matched or downgraded.
- [A9] **Executable** — ruling-step test `unreadable-table-blocks` supplies missing, unreadable, truncated and malformed settings and finding payloads; each yields block without a permissive fallback.
- [A10] **Executable** — integration test `forged-settings-operator` exercises the production writer and protected CI gate: a claimed operator in finding text, frontmatter, commit author, environment or PR body grants no authority; missing, stale, replayed or wrong-repository approval evidence refuses the write. A verified operator approval bound to the exact repository, base/head and settings diff permits it. Identity is the authenticated GitHub review actor fetched by protected CI with credentials unavailable to the PR job, checked against the protected operator allowlist; approval metadata supplied by the PR is never evidence.
- [A11] **Executable** — settings integration test `settings-snapshot-race` races two approved edits and a level move; compare-and-swap against the approved base revision rejects the stale writer, readers use one complete validated snapshot, and a crash before atomic replacement leaves the prior valid file effective. An unreadable snapshot blocks per A9.
- [A12] **Executable** — ruling-step test `always-block-second-check` observes a second check and block pending its result for low confidence on every always-block class, including classes selected by path and pattern overrides; an unknown class or table gap blocks before any confidence cap.

Ruling and amended table: [we:backlog/xugqjw1](/backlog/xugqjw1-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Debt lifecycle, panel rendering and advisory jobs belong to slices 3–5; this slice does not change ratified cells.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — A8 validates every model-supplied class, severity and confidence field before policy evaluation; source code, docs, config and data cannot supply policy or authority (A10).
2. **Truncated reads** — A9 blocks on any incomplete or unreadable finding or settings snapshot.
3. **Shared state files** — A11 uses atomic replacement and a revision check; no mixed or stale snapshot is effective.
4. **Fail closed** — A1, A6–A9 reject invalid tables and payloads; always-block and careless-debt invariants precede the confidence cap (A5, A12).
5. **Identity scoping** — A10 binds authenticated review evidence to the repository, exact head/base and approved diff, never a self-declared role.
6. **State over time** — stale approvals and concurrent writes refuse under A10–A11; only a fresh approved revision becomes effective.
7. **Who wrote it** — protected CI verifies the GitHub review actor against the protected operator allowlist (A10); agent proposals cannot change effective settings (A4).
