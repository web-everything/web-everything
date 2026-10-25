---
bornAs: x5eummi
kind: story
size: 3
status: open
scope: ["we:.github/workflows/remote-verify.yml", "we:scripts/lib/remote-verify.mjs", "we:scripts/verify-lane.mjs", "we:scripts/__tests__/remote-verify.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Bind remote verification evidence to a protected gate definition

PR #5878 review identified provenance debt: an exact-SHA successful run can still execute a lane-edited workflow or gate script. Canonical origin pinning is implemented in the repair; protected gate execution or land-time comparison must establish which definition produced the evidence.

PR #5878's next repair closes import conservatively: the importer reads canonical GitHub `main` and the exact run commit, requires their complete Git tree IDs to match, then repeats those reads before writing a marker. This covers workflow edits, gate scripts, transitive helpers, package lifecycle hooks and configuration without an incomplete executable-path allow-list. It records the repository, protected commit, tree and run attempt. Missing, malformed, changed or unreadable definitions refuse import with a local-verify fallback. The local working-tree hash remains separate from these Git tree IDs.

This intentionally refuses **all content-changing lane commits**, including legitimate gate changes, until their complete tree is protected on `main`. Remote workflows remain useful for diagnostics; normal lane changes use local verification. Keep this card open for protected execution that can safely verify content-changing lanes. Import and consumption checks must be designed together before relaxing the complete-tree restriction.

## Acceptance

- [A1] Execute the lane gate from a protected required workflow, or have the importer/land-time gate compare the run's workflow and executable gate dependency tree to the protected base. Fail closed when the protected definition cannot be read or when a lane-edited definition would be imported as proof. Comparing only job and step names is insufficient.
- [A2] Planned tests in `we:scripts/__tests__/remote-verify.test.mjs`: **lane-edited workflow cannot mint trusted remote evidence** makes a step named Required lane gate a no-op and asserts no trusted marker; **lane-edited gate dependency cannot mint trusted remote evidence** changes the invoked script or an imported helper and asserts refusal; **unchanged protected gate admits exact-SHA success** accepts complete successful evidence; **unreadable protected definition refuses import** asserts no marker and the local-verify fallback. Pass that test file to `npm run test:unit --`.
- [A3] Retain the canonical `web-everything/web-everything` repository pin, exact SHA, successful attempt/job/step evidence, final live recheck, and tree-stability checks. Record repository and protected-definition provenance in the accepted evidence and verify them on consumption.
- [A4] Define the policy for a legitimate gate-definition change: require protected review and execution after approval, with an operator-visible refusal/fallback until that evidence exists. An unavailable comparison must never silently admit a lane's own definition.

## Non-goals

- [N1] Do not claim that local verification is a hostile-lane security boundary. This item establishes remote provenance; it introduces no HTTP receive endpoint, so body-size and CSRF controls do not apply.

## Edge cases this change must handle

1. **Untrusted text** — Treat workflow titles, job/step labels, paths and marker fields as data; use literal argv and repository-qualified definitions.
2. **Truncated reads** — Refuse incomplete or unreadable protected workflow/dependency evidence; bound reads and expose the local-verify fallback.
3. **Shared state files** — Recheck definition and HEAD before atomically writing accepted evidence; a racing lane edit cannot inherit stale acceptance.
4. **Fail closed** — No-op gate, changed dependency, missing protected revision or failed API read writes no trusted marker.
5. **Identity scoping** — Pin repository, protected base revision, run SHA and attempt together; a fork cannot substitute an equivalent-looking workflow.
6. **State over time** — Recheck retries and base changes; handle legitimate definition updates explicitly instead of trusting a stale comparison.
7. **Who wrote it** — A lane can modify its own workflow and scripts. Trust must come from protected execution or a protected land-time policy outside that lane.
