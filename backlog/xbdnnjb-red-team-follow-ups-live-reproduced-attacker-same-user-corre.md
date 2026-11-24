---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/file-class-policy.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user, correctness-in-normal-use] from web-everything/web-everything#7426 (head 6c64738a7)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7426 (reviewed head `6c64738a711cdd0b6a5c15a0cb2dce47587ecf76`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/file-class-policy.mjs:10` — (failing-input, degraded) A newline in a generated filename produces a false pass.
   - Scenario: Call recordOnly with a policy containing unmatched:'source' and row {glob:'dist/**',class:'generated'}, ignore:['dist/**'], and an added path 'dist/a\we:nb.js'. It records class:'source', verdict:'pass', and no findings. The control path 'we:dist/a.js' correctly fails with committed-generated. The terminal globstar compiles to .*, which excludes newlines. Both valid Git paths should match dist/** and fail as committed generated files.
   - Class: live-reproduced (basis: Observed through recordOnly in native Node with a valid 40-hex head and change identity. The current impact is an incorrect evaluation record; no production authorization bypass is claimed.)
   - Also class: attacker-same-user
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/file-class-policy.mjs` — (edge-case, degraded) Renamed append-only files skip entry validation.
   - Scenario: Use row {glob:'logs/*.json',class:'append-only',params:{order:'append'}} and file {path:'we:logs/new.json',status:'renamed',entries:{before:[{key:'a',digest:{sha256:'a'.repeat(64)}}],after:[{key:'a',digest:{sha256:'b'.repeat(64)}}]}}. recordOnly returns pass with no findings. Changing only status to modified returns fail with rewrote-entry. A rename that rewrites an existing entry should also fail. Omitting entries on the renamed file likewise returns pass instead of unknown.
   - Class: live-reproduced (basis: Reproduced both status variants through recordOnly in native Node. Renames are explicitly admitted by input validation, but append-only evidence checks run only for modified files. This confirms the rename gap acknowledged in the PR description; the observed impact remains incorrect records.)
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
