---
bornAs: x1a9dcz
kind: story
size: 3
status: open
dateOpened: "2026-10-27"
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-self-hosted-workflows.test.mjs", "we:scripts/__tests__/ci-integration-parallel.test.mjs", "we:scripts/ci/__tests__/ci-hetzner-routing.test.mjs", "we:scripts/ci/__tests__/ci-shard-steps.test.mjs"]
tags: [ci, security, prevention]
---

# Prevent self-hosted workflow authentication drift

Track the prevention guards owed by the advisory review of web-everything/web-everything#6003. That repair narrows the Hetzner caller to its two needed secrets and disables checkout credential persistence; repository-wide standards enforcement remains to be built.

## Acceptance

- [A1] **Executable** — Add a rule to `check:standards` rejecting `secrets: inherit` on callers of reusable workflows containing self-hosted jobs. Resolve local reusable-workflow calls, including nested calls; unreadable targets or cycles must report incomplete evidence and require operator review rather than pass. Test direct and nested calls, hosted-only calls, explicit maps, missing files, and cycles.
- [A2] **Executable** — Require boolean `persist-credentials: false` on every checkout in a workflow containing self-hosted jobs. Cover omitted, true, string, and expression values, plus both WE and FUI checkouts. Diagnostics name the workflow, job, and step. Operator fallback is an explicit reviewed exception, never silent success.
- [A3] **Executable** — Keep the exact two-key secret-map assertion in `we:scripts/ci/__tests__/ci-hetzner-routing.test.mjs` wired to the real workflows; extra or missing keys must fail.
- [A4] **Executable** — Preserve the guards delivered by the same repair: both workflows' shard run scripts execute under failing/empty/successful assignment stubs in `we:scripts/ci/__tests__/ci-shard-steps.test.mjs`; both integration commands are checked in `we:scripts/__tests__/ci-integration-parallel.test.mjs`; all five required contexts retain their actual owning workflows in `we:scripts/ci/__tests__/ci-hetzner-routing.test.mjs`.
- [A5] **Executable** — Test the rule through scoped `check:standards` on caller and callee edits. A self-hosted target introduced by a callee edit must cause its existing inheriting caller to fail too.

## Non-goals

- [N1] Change runner routing, required check identities, token minting, or the human review ceremony.
- [N2] Replace the runner workspace cleanup hook; these guards limit credentials independently of that hook.

## Edge cases this change must handle

1. **Untrusted text** — Parse YAML as data; never execute expressions or shell commands while linting. Unknown runner expressions need review.
2. **Truncated reads** — Missing or malformed workflow evidence fails closed with its path.
3. **Shared state files** — n/a: validators only read the supplied workflow set.
4. **Fail closed** — Unresolvable reusable-workflow targets require operator review with a named diagnostic.
5. **Identity scoping** — Follow each call to its referenced workflow and inspect every checkout; hosted callers may reach self-hosted callees.
6. **State over time** — Adding or changing a callee must re-evaluate its callers under scoped validation.
7. **Who wrote it** — Workflow contents are untrusted data regardless of their author; exceptions require explicit review.
