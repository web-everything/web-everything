---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-version-migrate.mjs", "we:backlog/xnvwh5a-card-89-s6-migrate-unmigrate-tool-versioned-plist-template-l.md", "we:scripts/lib/__tests__/daemon-version-migrate.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Anchor the match on the known clone parent (dirname(clone)) when a clone is supplied, and add a p… (from web-everything/web-everything#4433 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-version-migrate.mjs:330` — Anchor the match on the known clone parent (`dirname(clone)`) when a clone is supplied, and add a plist test where the name also appears in a parent directory.
2. `we:scripts/lib/daemon-version-migrate.mjs:268` — Extend the failed-smoke test to a second migrate with a passing runSmoke on the same sha and assert 'migrated'.
3. `we:backlog/xnvwh5a-card-89-s6-migrate-unmigrate-tool-versioned-plist-template-l.md:15` — A check:standards rule that rejects 'TODO:' placeholders in backlog cards that a PR flips to implemented or lands code for.
4. `we:scripts/lib/daemon-version-migrate.mjs:148` — Use an atomic lock primitive: `mkdir` the lock directory, or take over by `rename`ing the stale lock to a unique name and re-checking it, then add a two-contender takeover test. A shared advisory-lock helper in scripts/lib that all daemon tools use would cover this class.
5. `we:scripts/lib/daemon-version-migrate.mjs` — Add a deterministic concurrency regression test using a paused build and a second call in the same process; require refusal and unchanged intent/state.
6. `we:scripts/lib/daemon-version-migrate.mjs` — Pass the exact clone path into the transformer and gate it with deterministic ancestor-name collision tests asserting complete rewritten paths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4433@3ef1e49239ca0f437a1117368e73dbf345dbe6dc

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
