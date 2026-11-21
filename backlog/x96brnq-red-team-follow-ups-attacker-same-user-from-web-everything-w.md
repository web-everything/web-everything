---
kind: story
size: 2
status: open
scope: ["we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [attacker-same-user] from web-everything/web-everything#7188 (head 4ab892352)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7188 (reviewed head `4ab89235269738178666884d079f67ddab487f18`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/verify-lane.mjs:940` — (edge-case, degraded) Nested shell quoting bypasses forced-local shard routing
   - Scenario: Invoke verify-lane --local with --gate set to: sh -c 'node scripts/lib/verify-shard-"run".mjs --shards=1 --parallel=1 --budget-ms=60000 -- npx vitest run we:scripts/lib/__tests__/verify-selection-log.test.mjs'. The parser accepts this unchanged because its substring check misses the inner quoting. The shell resolves the real shard runner, but WE_VERIFY_SHARD_LOCAL is absent. runShards then removes the inherited admission-held flag and invokes heavy-admission without --local, allowing Forge routing despite --local and local:true metadata. The command should be refused or its shards forced local.
   - Class: attacker-same-user (basis: Requires caller control of the custom gate. Reproduced acceptance using the production parser body and confirmed path resolution with /bin/sh. Exercised the production runShards body with an injected execution boundary: it selected heavy-admission and removed the held flag. The selected test routes as git-free. No actual Forge request was made; remote execution depends on configured routing policy.)
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
