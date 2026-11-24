---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/remote-target.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild-smoke.test.mjs", "we:docs/agent/testing/remote-targets.md", "we:scripts/readiness/__tests__/heavy-admission.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a test for a non-eligible argv with custom hosts that asserts targetExec is never called and… (from web-everything/web-everything#7427 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/heavy-admission.mjs:1325` — Add a test for a non-eligible argv with custom hosts that asserts targetExec is never called and the logged reason is the original decideRemote reason. Better, move the probe after decideRemote so the code structure enforces it.
2. `we:scripts/readiness/__tests__/remote-target.test.mjs:60` — Add a table test over mode × load × overloaded that asserts probe or no-probe. A review lens that asks which branch conditions guard each side effect would also catch this.
3. `we:scripts/lib/__tests__/daemon-rebuild-smoke.test.mjs:22` — A lint rule or standards check that flags duplicate vi.setConfig calls in one file.
4. `we:scripts/readiness/heavy-admission.mjs:403` — Add a table-driven test over `ADMISSION_VALID` leaves that classifies each as per-caller, tool-overridable or platform-only, so a new leaf has to be placed explicitly. Preferably make `remote.hosts` platform-only, next to the `clientPath` and `manifest` branches in `resolveAdmissionPolicy`.
5. `we:docs/agent/testing/remote-targets.md:4` — Add a deterministic parameterized resolver test covering competing platform/tool values and both pool scopes, and include it in the readiness test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7427@3e24a0543ef3283098f786116d8db01e42748618

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
