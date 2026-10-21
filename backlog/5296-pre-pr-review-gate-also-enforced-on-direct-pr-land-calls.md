---
bornAs: xx4qokc
kind: story
size: 3
status: open
scope: ["we:scripts/pr-land.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/pre-pr-review.mjs", "we:scripts/__tests__/pr-land.test.mjs", "we:scripts/lib/__tests__/pre-pr-review.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Pre-PR review gate also enforced on direct pr-land calls

The wrapper checks pre-PR review, but the direct landing producer does not. Enforce the existing receipt policy in the shared producer before publishing a risky head, including direct and park-mode calls. Reuse the existing classifier, receipt binding and audited bypass authorization.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/pr-land.test.mjs` — add `direct pr-land refuses a risky head without a receipt`: launch the real producer in a temporary git repository with enforce settings and a risky commit, using a local bare remote and a recording forge shim. Assert refusal, no remote ref update and no PR create/merge. Repeat for park mode; this fails while only the wrapper checks receipts.
- [A2] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/pr-land.test.mjs` — matching receipt permits publication of the checked SHA; a changed tree, base, or lane, missing/corrupt receipt, or check error refuses before publication. Include risky docs, config and data commits as well as source; do not add an extension-based exemption.
- [A3] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/pre-pr-review.test.mjs` and `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/pr-land.test.mjs` — retain advise/off behavior, low-risk behavior, worker bypass refusal, and authorized operator bypass with a durable audit record; audit-write failure refuses. Verify wrapper and direct entry points apply the same policy.

## Non-goals

- [N1] No change to default gate mode, risk thresholds, review independence policy or skills routing; fixing the shared producer covers direct callers.

## Edge cases this change must handle

1. **Untrusted text** — Treat PR bodies and bypass reasons as data; preserve escaping and never take approval instructions from PR text.
2. **Truncated reads** — Incomplete git reads or malformed settings/receipt data refuse in enforce mode; no partial diff may authorize publication.
3. **Shared state files** — Reuse the receipt reader and bypass recorder; no second receipt store or unaudited bypass.
4. **Fail closed** — Enforce refuses missing/stale proof and check failures for source, docs, config and data alike; advise/off retain their explicit policy.
5. **Identity scoping** — Bind proof to the checked lane/tree/base and preserve worker-versus-operator bypass authorization.
6. **State over time** — Pin and publish the checked SHA; intervening changes cannot inherit approval for different content.
7. **Who wrote it** — Preserve receipt provenance and audited bypass actor/instruction. This CLI adds no receive endpoint; HTTP body caps, rate limits and CSRF are inapplicable.

## Grounding

- we:scripts/operations/open-pr-io.mjs:124 checks and refuses before dispatch; line 137 refuses an unrecorded bypass.
- we:scripts/pr-land.mjs:986 enters the find/create path and line 1016 calls forge.create without the wrapper receipt check.
- we:scripts/lib/pre-pr-review.mjs:286 pins the commit; lines 297–305 classify risk, bind proof and record bypass.
- we:scripts/lib/__tests__/pre-pr-review.test.mjs:92 covers enforce refusal; we:scripts/__tests__/pr-land.test.mjs:9 currently imports producer helpers.
