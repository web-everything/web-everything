---
bornAs: xjo32w1
kind: story
size: 3
status: resolved
scope: ["we:scripts/operations/completion-record.mjs", "we:scripts/operations/completion-store.mjs", "we:scripts/operations/completion-cli.mjs", "we:scripts/operations/worker-result-router.mjs", "we:scripts/operations/__tests__/worker-result-router.test.mjs", "we:scripts/operations/__tests__/completion-record-v2.test.mjs"]
dateOpened: "2026-10-08"
dateStarted: "2026-10-08"
dateResolved: "2026-10-08"
graduatedTo: worker-contract-s2
tags: []
---

# Worker result contract S2: completion record v2 envelope (folds three stores) and the blocker-to-action router

117 S2 (D2 + D3): completion record v2 is the ONE envelope the launcher writes (role, launcher, model, pid, timeout, heads, parse, result, action) and the one store the three old stores fold into: v1 completion, delivery-report and fix-report records read back through it. A pure router maps blocker.kind to an action: tooling-defect, permission-wall and contract-violation make a 114 draft card under postmortem.mode (off|draft|file, OFF by default: with no WE_POSTMORTEM_MODE set and no postmortem config file, no draft is written), needs-ruling goes to the operator, and it is the only route there. Spec: prepare-117 sections 3-5, 8 (S2).

## Done when

1. **Executable** — vitest on `we:scripts/operations/__tests__/worker-result-router.test.mjs` and `we:scripts/operations/__tests__/completion-record-v2.test.mjs` passes: v1 records still read; delivery-report and fix-report records read as v2; the router covers every blocker kind (an unknown kind fails closed); the fix-4228 fixture routes to a product-fix draft and not to the operator; `we:scripts/operations/completion-cli.mjs show --session=X` prints `result` and `action` for a v2 record.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Free text in summary and evidence is length-capped and redacted at the single envelope write point; the router never reads prose.
2. **Truncated reads** — A torn or over-long record is refused on read (the existing corrupt-record refusal), never read as nothing.
3. **Shared state files** — The existing completion lock and atomic rename are reused; the v2 write goes through the same writeCompletion.
4. **Fail closed** — Unknown kind, unparseable and invalid results route to a contract-violation draft, never to success; the draft dedupe signature is role+launcher+reason.
5. **Identity scoping** — A v2 record keeps the owner sessionId rule of #4306; a draft is keyed by signature, not by session.
6. **State over time** — v is 1 or 2; a v1 record is never rewritten as v2 on read; unknown versions are refused. An operator stop is aborted and makes no draft (D6).
7. **Who wrote it** — The launcher writes the envelope and the worker only supplies the result object; the router is pure and decides the action, no model.
