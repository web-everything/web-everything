---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/github-app-installations.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7399 (head abaa5e943)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7399 (reviewed head `abaa5e943b8197d88a6a3c181841c1e9c7105638`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/github-app-installations.mjs:125` — (failing-input, degraded) Typed null target fields bypass the refusal guard
   - Scenario: With GH_REPO=web-everything/web-everything and ambient personal credentials, invoke api graphql -Fowner=null -Fname=plateau-app with a repository query. The parser returns the string "null", and the rendered shim forwards the request using personal credentials. gh's documented -F conversion makes this owner JSON null, so the target is unresolved and should be refused. Likewise, -Fowner=plateauapp -Fname=null proceeds using sibling credentials instead of refusing.
   - Class: live-reproduced (basis: Executed the generated shim in memory with mocked filesystem reads and a recording execution stub. Both null cases reached execution with credentials; the file-backed-owner control was refused. The installed gh manual confirms -F converts null, booleans, and integers into JSON types.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/github-app-installations.mjs:120` — (edge-case, degraded) Bracketed target fields are mistaken for absent targets
   - Scenario: Invoke api graphql '-Fowner[]=plateauapp' '-Fname[]=plateau-app' with a repository query and GH_REPO=web-everything/web-everything. Both fields miss the exact-key regex, leaving hasTarget false. The shim forwards the request using checkout credentials. gh interprets these fields as owner and name arrays, so they are explicit unresolved targets and should trigger refusal rather than ambient routing.
   - Class: live-reproduced (basis: The in-memory generated-shim probe recorded execution with the CHECKOUT token for this exact argv. Filesystem and execution boundaries were mocked; no network request was made. The installed gh manual documents bracketed field syntax as nested parameters and arrays.)
   - Also class: coverage-or-style
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
