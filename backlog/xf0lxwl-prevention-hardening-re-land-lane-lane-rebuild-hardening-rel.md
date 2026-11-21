---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/audited-tip.mjs", "we:scripts/daemon-overlay.mjs", "we:scripts/conveyor/soak/breaks/ready-candidate-adopted-across-overlay-churn.mjs", "we:scripts/lib/daemon-rebuild/__tests__/audited-tip.test.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/ready-candidate-adopted-across-overlay-churn.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Hardening re-land lane (lane/rebuild-hardening-reland) must restore pathBEvidenceGit plus we:audi… (from web-everything/web-everything#7303 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/audited-tip.mjs:44` — Hardening re-land lane (`lane/rebuild-hardening-reland`) must restore `pathBEvidenceGit` plus `we:audited-tip-drivers.test.mjs`. Add a check:standards gate that every `merge-tree` call site in `scripts/lib/daemon-rebuild` goes through `pathBEvidenceGit`.
2. `we:scripts/daemon-overlay.mjs:494` — The re-land should keep the writer-contract test with the writer, independent of the classifier.
3. `we:scripts/conveyor/soak/breaks/ready-candidate-adopted-across-overlay-churn.mjs:20` — A lint rule in the soak break framework that rejects `readFileSync(...).includes(` in `fixPresent` and requires a behavioural probe.
4. `(no file cited)` — Add a named deterministic check comparing all reverted paths against the pre-merge tree, allowing only the explicitly identified unrelated timing entries.
5. `we:scripts/lib/daemon-rebuild/audited-tip.mjs:48` — In the separate hardening lane, restore the named real-Git regression test and require it in CI alongside a guard rejecting custom-driver evidence.
6. `(no file cited)` — Add a deterministic check named 'revert restores all #7171 paths to pre-merge blobs', deriving the paths from the reverted merge and explicitly checking the allowed timing-file exceptions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7303@5bbf74e54653fb41f1b2d7c7e1504334e2bc611f

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
