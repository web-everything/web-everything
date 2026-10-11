---
bornAs: x79bqrk
kind: story
size: 2
status: open
scope: ["we:scripts/merge-gate-check.mjs", "we:scripts/settings/merge-queue.json"]
dateOpened: "2026-10-09"
tags: []
---

# merge-gate: read the drain enqueue clearance + retire the mergeQueue.strategy alias

Follow-up of 5803. The drain now stamps a we-drain-enqueue-clearance comment per judged head before it enqueues; the drain-merge-strategy lib exports readEnqueueClearance. Wire it into the merge-gate check's gatherPrFacts (replace the null enqueueClearance fact; read comments with author login) and choose the trusted author list (the drain's gh identity; fail closed when unset). The trusted list MUST contain the exact login the drain stamps as (`gh api user --jq .login`, which `we:scripts/lib/drain-merge-strategy.mjs` also uses to decide whether its own stamp already exists); a bot/app login can differ in form (`app/x` vs `x[bot]`), so compare normalized logins and add a test that writer and reader agree. Also retire or alias the drain-internal mergeQueue.strategy setting so the cascade has one strategy key. Deferred because the check script was held by red-main-freeze-shared and the settings file by PR 4689.

**Shared identity.** If PR authors and the drain use one gh identity (a single machine account), a marker from that login proves nothing about who wrote it: any PR author could plant a clearance for their own head. The check must refuse to trust the clearance when the PR's own author login equals the trusted drain login (normalized), and must not accept the marker alone then. It needs a second signal the author cannot forge (for example a drain-written status or label), or the PR is held for a human.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- merge-gate-ci drain-merge-strategy` fails before this item lands (no test reads the clearance in gatherPrFacts; none covers the shared-identity case) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] This item does not change how the drain stamps or enqueues, and does not add a new trust source beyond the drain's gh identity and the shared-identity second signal above.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — comment bodies are matched only by the exact clearance marker pattern for the judged head sha; any other text in a comment is ignored.
2. **Truncated reads** — an unread or partial comment list (null, paged out, read error) means no clearance: the check fails closed, never treats the gap as cleared.
3. **Shared state files** — n/a: the merge-gate check reads PR comments only and writes no state file.
4. **Fail closed** — an unset or unresolvable drain login, an unreadable comment list, or a marker for a different head all mean "no trusted clearance".
5. **Identity scoping** — logins are compared normalized (case, `app/x` vs `x[bot]`), and a test pins that the login the drain stamps as and the login the reader trusts agree.
6. **State over time** — a clearance covers one head sha only; a new push invalidates it and the drain stamps again.
7. **Who wrote it** — only the drain's login counts; when the PR author shares that login, the marker alone is not enough (see Shared identity above).
