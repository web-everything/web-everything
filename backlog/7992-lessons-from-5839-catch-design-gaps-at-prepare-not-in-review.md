---
bornAs: xzpq9ow
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Lessons from #5839: catch design gaps at prepare, not in review rounds (operator: "We have to learn from that

MED priority hint. ## (held 2026-10-25 20:05 ET) Lessons from #5839: catch design gaps at prepare, not in review rounds (operator: "We have to learn from that to address at the design and preparation stage") #5839 (codex-job) took 18 rounds. Almost every round the red-team found a NEW class of break (credential capture, TOCTOU, rewrite after test, relative origin, test subprocess showing different bytes), and the PR was closed for a redesign (R114). Root cause: the design never stated its threat model (what is trusted, what may be adversarial: Codex output, test subprocesses, git config) or its "frozen inputs" rule, so the review loop discovered the threat model one break at a time. Proposed: (1) /prepare and the build brief get a required "Trust boundary + threat model" section for any item that runs, publishes or trusts untrusted output (what is adversarial, what is out of scope, which inputs are frozen). (2) A design red-team (jury on the prose) runs on that section BEFORE build. (3) The review loop: a new break CLASS in 3 consecutive rounds → stop rounds and go back to design (lowers R88/R90 from ≥8 rounds). (4) The coroner tracks "break classes per PR" as a design-quality signal.

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
