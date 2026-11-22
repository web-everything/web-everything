---
kind: story
size: 2
status: open
scope: ["we:skills-src/review-design/SKILL.md"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7281 (head 84287b175)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7281 (reviewed head `84287b17515a9ef05aad0dd02228392b54b5ba9e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/review-design/SKILL.md:10` — (edge-case, degraded) Relocating review-design leaves its required rubric links dangling
   - Scenario: After migration, invoke /review-design and follow its we:../../../docs/agent/vision-tiers.md link. The deployed skill resolves it to ~we:/docs/agent/vision-tiers.md, which returns ENOENT. The relocated ops source also resolves it outside WE, to ~we:/workspace/docs/agent/vision-tiers.md. Its we:intents.json and we:AGENTS.md links likewise fail. Previously the project-scoped skill path resolved the rubric inside WE. The relocated skill should retain resolvable references to the required WE documents.
   - Class: live-reproduced (basis: Read the relocated ops source and inspected the actual global deployed skill: both retain the relative rubric link. Read-only filesystem probes confirmed the former project-relative rubric target exists, while the ops and global targets are absent; access checks on all three global document targets returned ENOENT.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
