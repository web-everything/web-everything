---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci-minutes/README.md", "we:scripts/ci-minutes/usage.test.ts"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a check:standards rule, or a tiny test, that asserts the required README headings or keywords… (from web-everything/web-everything#7342 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci-minutes/README.md:7` — Add a check:standards rule, or a tiny test, that asserts the required README headings or keywords for card-acceptance docs.
2. `we:scripts/ci-minutes/usage.test.ts:25` — Mark tests that depend on unverified semantics (for example `it.todo` or a comment tied to the S1.2 card) so they are revisited.
3. `we:scripts/ci-minutes/README.md:4` — Add a review-lens note requiring provenance labels ('observed earlier, outside this slice' versus 'this slice') on live-data claims.
4. `we:scripts/ci-minutes/usage.test.ts:38` — Use a shared secret-scan helper or gate, such as gitleaks or a check:standards rule, that covers all gh[pousr]_ prefixes and github_pat_ over scripts/**/fixtures/**. Prefer that over per-test regexes. Widening the regex to /gh[pousr]_|github_pat_|Bearer/ is the minimal local fix.
5. `we:scripts/ci-minutes/README.md:7` — File a card for S1.2 to add a test that the ci-minutes client reads tokens only through the keychain accessor. Alternatively add a check:standards rule that bans process.env.*TOKEN and token-file reads under scripts/ci-minutes/.
6. `we:scripts/ci-minutes/README.md:3` — Add a deterministic test named 'README records endpoints, scope, and multiplier status' in we:scripts/ci-minutes/usage.test.ts that asserts each required topic has nonempty documentation.
7. `we:scripts/ci-minutes/usage.test.ts:5` — Add a deterministic acceptance check for the required README sections and explicit verification statuses, with the named test included in the scoped fixture command.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7342@d7f0f35ecaa742fe24175247fa4b3a5a85a5826a

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
