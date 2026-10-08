---
kind: story
size: 3
status: resolved
scope: ["we:schemas/worker-result.v1.json", "we:scripts/operations/worker-result.mjs", "we:scripts/operations/__tests__/worker-result.test.mjs"]
dateOpened: "2026-10-08"
dateStarted: "2026-10-08"
dateResolved: "2026-10-08"
graduatedTo: worker-contract-s1
tags: []
---

# Worker result contract S1: we.worker-result v1 schema, validator, legacy outcome mapping, reroute guard

117 S1: the single strict-mode we.worker-result v1 schema, a pure validator with the reader checks, a total mapping of today's 20+ outcome words to blocker kinds, and the D1 deterministic guard that reroutes a needs-ruling naming code paths to tooling-defect. findingsAddressed ids reuse #4233 finding identity (D8). Spec: prepare-117 section 3, 4, 8 (S1).

## Done when

1. **Executable** — vitest on `we:scripts/operations/__tests__/worker-result.test.mjs` passes: (a) strict-mode check (every object has additionalProperties:false and required = all keys); (b) the fix-4228 replay fixture validates and maps to `tooling-defect`; (c) every `--outcome=` value in `we:skills-src/**/*-brief*.md` maps to a blocker kind or outcome (total mapping).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Summary and evidence text are length-capped and only stored as data; no daemon routes on prose.
2. **Truncated reads** — Over-long or truncated JSON fails validation and is treated as unparseable.
3. **Shared state files** — n/a: pure functions, no state files.
4. **Fail closed** — Any parse, schema or reader-check failure returns unparseable with blocker kind contract-violation, never success.
5. **Identity scoping** — Finding ids use the #4233 stable identity (file + rule/lens + normalized claim).
6. **State over time** — The v field is an enum of [1]; unknown versions are refused.
7. **Who wrote it** — The launcher writes the envelope; the worker only writes the result object, and the validator rejects extra keys.
