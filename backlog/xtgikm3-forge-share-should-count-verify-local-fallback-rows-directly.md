---
kind: story
size: 3
status: active
scaffoldedBy: "verify-routing"
dateScaffolded: "2026-11-04"
dateOpened: "2026-11-04"
tags: []
---

# forge-share should count verify-local fallback rows directly in its denominator

forgeShare derives local runs from slot-release rows, so a verify-local:* fallback row written on the unslotted timeout path never enters the denominator and the share reads too high. Count verify-local:* fallback rows directly (deduplicated against a matching slot-release row). Found by the PR-1 audit of verify-local logging.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/forge-share.test.mjs` has a case with one remote run and one verify-local fallback and no local row, expecting share 0.5; it fails today (share 1).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: no routing change; this only fixes the share arithmetic.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads local jsonl rows only, as forge-share already does.
2. **Truncated reads** — n/a: reads local jsonl rows only, as forge-share already does.
3. **Shared state files** — n/a: reads local jsonl rows only, as forge-share already does.
4. **Fail closed** — n/a: reads local jsonl rows only, as forge-share already does.
5. **Identity scoping** — n/a: reads local jsonl rows only, as forge-share already does.
6. **State over time** — n/a: reads local jsonl rows only, as forge-share already does.
7. **Who wrote it** — n/a: reads local jsonl rows only, as forge-share already does.
