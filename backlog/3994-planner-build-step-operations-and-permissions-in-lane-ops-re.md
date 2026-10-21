---
bornAs: xaw0di9
kind: story
size: 8
parent: "3383"
status: open
dateOpened: "2026-09-23"
tags: []
scope: ["we:scripts/operations/step-operations.mjs", "we:scripts/operations/step-permissions.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/minimal-context-provider.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/guard-bash.mjs", "we:scripts/operations/__tests__/step-operations.test.mjs", "we:scripts/operations/__tests__/step-permissions.test.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
---

# Planner build: step operations and permissions (in-lane ops, request-run, request-scope, step deny table)

Planner steps need their own enforceable operation and file permissions. Implement typed related-test, request-run and request-scope operations, wrapper-owned request adjudication, launch-time step settings and a step-specific Bash deny table under the already-ratified rule in we:docs/agent/platform-decisions.md#planner-build-plan-and-execute. Requests record intent; they never grant the requesting worker authority. Size 8 covers declarations, permission generation, the launch caller and guard integration with three regression suites.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/step-permissions.test.mjs` — add a step-launch fixture that edits an allowed file, refuses an out-of-scope file and refuses free shell before effects; this new suite fails without the step profile. Assert the real launch argv loads the settings and hooks rather than merely checking a generated JSON shape.
- [A2] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/step-operations.test.mjs` — related-test invokes only named, validated test targets through heavy admission; request-run and request-scope append pending requests with step/run identity. A wrapper grant is revalidated against the current scope reservation before activation; denied or unreadable requests produce no execution or wider permissions.
- [A3] Test the guard with `WE_DISPATCH_KIND=step`: deny full-suite aliases, standards, verify-lane, converge, commit/push/PR operations and compound-shell evasions; allow only the approved typed operation entry points. Preserve existing delivery/repair and interactive behavior.
- [A4] Launch-time file scope covers source, docs, config and data; normalize paths, reject traversal and symlink escape. Unsupported enforcement refuses launch. Run one related-test per step as needed; full build gates remain wrapper-owned once per build.

## Non-goals

- [N1] No widening of this profile to all agent work and no ruling on the still-open general permission-profile decision #3993.
- [N2] No planner, lane allocator, router or scope-conflict policy redesign; consume the step identity and approved files supplied by the build wrapper.

## Edge cases this change must handle

1. **Untrusted text** — Validate operation names and typed arguments; no shell command strings, leading-option injection, or paths derived from instruction prose.
2. **Truncated reads** — Bound child output; incomplete reads of settings, scope or request records refuse execution rather than treating the grant as empty.
3. **Shared state files** — Persist requests atomically under a per-run lock; compare the reservation revision when granting, so concurrent grants cannot overlap silently.
4. **Fail closed** — Unknown operation, missing hooks, unsupported permissions, parse error or failed grant write refuses; docs/config/data receive the same checks as code.
5. **Identity scoping** — Bind every request and grant to repo, item (hash or numbered ID), run, step, lane and scope revision; a sibling cannot consume it.
6. **State over time** — Consume grants once; restart re-reads pending requests and never replays a completed command or inherits a stale wider scope.
7. **Who wrote it** — Only the wrapper adjudicates requests within its configured ceiling; worker-authored files or comments cannot impersonate grants.

## Grounding

- we:docs/agent/platform-decisions.md:5670 specifies scoped step sessions and wrapper requests; :5676 keeps heavy checks per build.
- we:scripts/operations/run.mjs:173 is the operation catalog; we:scripts/operations/registry.mjs:12 documents the typed declaration shape.
- we:scripts/guard-bash.mjs:4154 selects existing wrapper-owned deny behavior by dispatch kind; add step handling without broadening other roles.
- we:scripts/operations/deliver-item-wrapper.mjs:159 imports the shared provider argv/settings and gate helpers, the launch integration seam.
- we:backlog/3993-decision-permission-profiles-for-all-agent-work-scoped-by-de.md:5 is not a prerequisite: this card implements only the existing step-specific statute.
