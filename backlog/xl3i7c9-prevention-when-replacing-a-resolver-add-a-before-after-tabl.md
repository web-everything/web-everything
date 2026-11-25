---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/sibling-clone-provision.mjs", "we:scripts/__tests__/sibling-clone-provision.test.mjs", "we:docs/agent/testing/sibling-clone-provision.md", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/sibling-clone-provision.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — When replacing a resolver, add a before/after table test covering every input class the old funct… (from web-everything/web-everything#7507 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:4037` — When replacing a resolver, add a before/after table test covering every input class the old function accepted (any owner, bare name, legacy owner).
2. `we:scripts/lib/sibling-clone-provision.mjs:72` — Clone into a temp sibling name and rename atomically on success, or write a provisioning marker so a crashed attempt is recognisable and safely removable. File as a hardening card.
3. `we:scripts/__tests__/sibling-clone-provision.test.mjs:206` — Add an end-to-end CLI harness case with a fake clone runner and fake origin that asserts routing through the provisioned clone.
4. `we:docs/agent/testing/sibling-clone-provision.md:16` — Add a drain startup self-check or status command that emits a structured sibling-status record. Have the card-close gate require that record for live-acceptance items.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7507@dae1ffc6d018a26a3d037812a6ecb0378e6cb99d

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
