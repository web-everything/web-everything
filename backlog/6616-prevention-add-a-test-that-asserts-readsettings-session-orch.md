---
bornAs: xr9t7py
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/settings/orchestrator-session.json", "we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a test that asserts readSettings().session.orchestratorDelegateCommands deep-equals ORCHESTRA… (from web-everything/web-everything#5455 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/settings/orchestrator-session.json:4` — Add a test that asserts `readSettings().session.orchestratorDelegateCommands` deep-equals `ORCHESTRATOR_DELEGATE_COMMANDS`. Alternatively, drop the array from the JSON and leave only a $comment.
2. `we:scripts/guard-bash.mjs:4362` — Wrap the optional loader in its own try/catch that falls back to `{}`. Add a test that forces the loader to throw and asserts the other guards still run.
3. `we:scripts/guard-bash.mjs:441` — Add negative and positive cases for a different directory and for the `nohup` wrapper to the 'executable positions' test, then adjust normalization to match.
4. `we:scripts/guard-bash.mjs:4362` — Wrap advisory/optional ctx loaders in their own try/catch that defaults to {} (as the daemonCloneRoots call already does), and add a check:standards rule flagging new calls inside the guard-bash IS_CLI top-level try that are not individually wrapped.
5. `we:scripts/settings/orchestrator-session.json:4` — Keep the defaults in one source and add a deterministic settings check rejecting redundant checked-in overrides of standard defaults.
6. `we:scripts/guard-bash.mjs:448` — Add a deterministic command-matching regression test for same-basename scripts in different directories, retaining the existing relative-path positive case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5455@3296a88e4697e5ec95fcd659c2eab4dd6952a468

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
