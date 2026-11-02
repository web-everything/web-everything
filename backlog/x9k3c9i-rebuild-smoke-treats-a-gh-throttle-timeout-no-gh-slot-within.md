---
kind: story
size: 2
status: open
scope: ["we:ci.yml"]
dateOpened: "2026-11-02"
tags: []
---

# Rebuild smoke treats a gh-throttle timeout ("no gh slot within 8s", load 50) in dispatch-dry-run as BROKEN → r

HIGH priority hint. - (HIGH, 11-02 13:15 ET) Rebuild smoke treats a gh-throttle timeout ("no gh slot within 8s", load 50) in dispatch-dry-run as BROKEN → review held on last-good (smoke-rejected 13:12 ET, 28-min smoke). A throttle/timeout under load is "unverifiable → retry later", not a rejection. Classify infra-class smoke failures separately.   - addendum 13:27 ET (#6217): my workflow_dispatch CI (11:06) was CANCELLED because we:ci.yml test-selection-measure runs on ANY workflow_dispatch (`if: github.event_name == 'workflow_dispatch' || vars...`) and times out at 30 min → run concludes cancelled. Fixes: (1) gate the measure job on an explicit dispatch input, never plain dispatch; (2) a sanctioned "re-run required CI for head H" op for PRs whose required workflow never ran. Not re-dispatching by hand again.

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
