---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/push-gate-lint.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7420 (head 83e123bb4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7420 (reviewed head `83e123bb42fcbc430a91c71a3dd7eec5ca52c4a2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/push-gate-lint.mjs:73` — (failing-input, degraded) Quoted option values containing spaces let raw pushes pass admission
   - Scenario: Add execSync('git -C "my repo" push origin HEAD') to a new tracked script. Removing the quotes splits the directory argument into two words, so findRawPushes returns no sites and admission passes without an allowlist entry. This ordinary static push should be detected. The same failure occurs with git -c user.name="Jane Doe" push origin HEAD.
   - Class: live-reproduced (basis: Executed the checked-in lint and boundary admission function in memory: the quoted-directory push returned an empty list and admission passed. A harmless shell function confirmed that the shell preserves the directory as one argument.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/push-gate-lint.mjs:18` — (failing-input, degraded) A read-only git log command is rejected as a raw push
   - Scenario: Add execSync('git --no-pager log --grep push') to a new tracked script. The regex consumes log as an optional value of --no-pager, then mistakes the grep pattern for the push subcommand. Admission rejects the script with 'raw push count 1, pinned none'. This read-only log command should produce no findings.
   - Class: live-reproduced (basis: Executed the checked-in lint and boundary admission function in memory: the command produced one shell finding and admission rejected it. A harmless shell function confirmed the arguments are --no-pager, log, --grep, push.)
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
