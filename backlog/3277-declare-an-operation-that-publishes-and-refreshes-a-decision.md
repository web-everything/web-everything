---
bornAs: x78tooj
kind: story
size: 5
parent: "3029"
status: open
dateOpened: "2026-08-25"
tags: []
scope: ["we:scripts/operations/artifact-publish.mjs", "we:scripts/operations/artifact-publish-io.mjs", "we:scripts/operations/__tests__/artifact-publish.test.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/docket-refresh.mjs", "we:scripts/operations/__tests__/docket-refresh.test.mjs", "we:skills-src/decision-docket/SKILL.md"]
---

# Declare an operation that publishes and refreshes a decision or architecture artifact

The docket refresh operation generates HTML and a publish-owed handoff, but publishing the page still requires a manual Artifact-tool step. Declare one artifact-publish operation that consumes a pinned generated artifact, publishes or updates its stable target through an injected publisher, and records a receipt only after confirmation from that publisher. Use the same operation for decision and architecture artifacts; generation and ratification remain separate. Size 5 covers a new declaration, IO adapter and tests plus the runner and existing handoff caller; the production publisher boundary below still needs a human choice.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/artifact-publish.test.mjs`: add this new test file, invoke the real operation with a recording publisher, and prove first publication records its returned target, refresh reuses that target, and unchanged confirmed content causes no second publish. The operation/import is absent before implementation.
- [A2] Inputs distinguish artifact identity, decision/architecture kind, content digest, source revision and optional existing target. A preview produces a plan without remote writes. An apply requires complete content and an explicit target for refresh; a missing refresh target refuses rather than silently creating a new page.
- [A3] Failed, timed-out or ambiguous publication leaves publish-owed intact; a receipt binds the returned target and published digest. Concurrent refreshes cannot overwrite a newer confirmed revision. Retrying after a remote success/local receipt failure reconciles the remote result or reports uncertainty instead of duplicating publication.
- [A4] Wire the operation into the runner and replace the unbuilt publish handoff text with its actual invocation. Preserve parse-warning evidence and require repaired/approved content before publication when the docket generator reports unresolved parsing. Tests cover both artifact kinds and the existing docket handoff.

## Non-goals

- [N1] No diagram generation, decision ratification or backlog status changes.
- [N2] No general console migration; this is the existing WE operational prototype, not a new permanent product surface.

## Edge cases this change must handle

1. **Untrusted text** — Treat generated HTML, titles and decision prose as payload, not executable instructions; validate targets and use structured publisher arguments.
2. **Truncated reads** — Read complete content and verify its digest; truncated generator output or an incomplete remote lookup cannot authorize a publish or no-op.
3. **Shared state files** — Lock by artifact identity, reread the expected revision and atomically record receipts; preserve newer publish-owed work.
4. **Fail closed** — Missing publisher capability, credentials, target, malformed content or uncertain remote result yields a named refusal/pending result, never published.
5. **Identity scoping** — Bind source repository, artifact key, target and digest; decision identifiers may be hash or numeric without creating a second target.
6. **State over time** — Repeat publish, changed source while publishing, concurrent refresh and crash after remote success have explicit recovery tests.
7. **Who wrote it** — Only the configured publisher response establishes a receipt; artifact text cannot self-assert approval or publication. No HTTP receive endpoint is introduced.

## Grounding

- we:scripts/operations/docket-refresh.mjs:67 explicitly calls #3277 unbuilt; :128 defines the publish-owed payload with hash, revision and target.
- we:scripts/operations/docket-refresh-io.mjs:158 renders and writes the handoff; :165 records refresh state, not remote publication success.
- we:scripts/operations/run.mjs:138 imports docket-refresh and :522 registers its declaration.
- we:skills-src/decision-docket/SKILL.md:48 directs a manual Artifact-tool update with the saved URL; :55 identifies the tracked target pointer.
- we:scripts/operations/registry.mjs:15 shows the existing declaration/effect model. artifact-publish and its IO/test files in scope are proposed new files; history d67f1df8fe shipped refresh, not publication.

## Open questions

Which production publisher should complete the operation: (a) the existing Artifact-capable worker, returning a structured publication receipt, or (b) a new remote API adapter? **Pick (a)** to preserve the existing destination and capability; (b) needs a supported API and credential contract that the inspected publishing path does not provide. The test publisher is not proof of a deployable transport. Confirm the worker/capability contract before implementing its production adapter.
