---
bornAs: xyfyxjk
kind: task
status: open
humanGate: { kind: setup, what: "Mac Studio self-hosted runner (R112); resume remote verify once it is up" }
scope: ["we:.github/workflows/", "we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/remote-verify.test.mjs", "we:scripts/__tests__/check-standards-external-checkout.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevent cross-repository checkout authentication drift in remote verification

PR #5878 review requires CI-matching external-checkout authentication and one real green remote workflow run before merge. The offline repair cannot dispatch Actions; this card tracks the standards rule and live release evidence.

## Acceptance

- [A1] Add a `check:standards` rule over every `actions/checkout` step with an external `repository:`. Resolve that repository's canonical token expression from `we:.github/workflows/ci.yml` and require the same expression. Refuse unknown repositories, missing tokens, unreadable YAML, and mismatched token expressions with the workflow and step named. Own-repository checkouts retain their existing token policy.
- [A2] Planned cases in `we:scripts/__tests__/check-standards-external-checkout.test.mjs`: **external checkout requires CI token expression** rejects the old `secrets.GITHUB_TOKEN` FUI checkout, accepts the App-output/fallback expression, checks multiple workflows/jobs/steps, and rejects missing or malformed evidence. **own repository checkout retains its token policy** accepts an explicit own-repository checkout without the FUI token expression. Pass that test file to `npm run test:unit --`.
- [A3] Before merging PR #5878, dispatch `we:.github/workflows/remote-verify.yml` on the repaired SHA in lane-check mode; require one completed successful run, successful sibling checkout and required lane gate, and successful exact-SHA marker import. Record the run URL and SHA on the PR. No such live run was possible in the offline repair sandbox; this release check remains owed.
- [A4] Record timings for the first two live runs. Confirm setup-node's npm download cache restores without a node_modules cache that `npm ci` would delete. This is measurement evidence, not a promised speedup.

## Non-goals

- [N1] Do not expand App permissions, expose credentials to test arguments, or change the local verification fallback. No HTTP receive endpoint is introduced; CSRF and body-size limits are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Parse YAML as data; do not evaluate workflow expressions or print credential values in diagnostics.
2. **Truncated reads** — Missing/unreadable workflow or canonical token evidence refuses the rule; do not silently skip it.
3. **Shared state files** — n/a: the rule reads workflow source and writes no shared state.
4. **Fail closed** — Unknown external repository or missing/mismatched token expression fails standards.
5. **Identity scoping** — Compare tokens per external repository, with the existing FUI App owner/repository and contents-read permission retained.
6. **State over time** — Derive the expected expression from CI so future auth changes cannot silently leave remote verification behind.
7. **Who wrote it** — Source checks cannot prove live credential availability; require the real run on the final repaired SHA before merge.

Parked under operator ruling R112 (2026-10-25): resumes with the Mac Studio self-hosted runner. Code kept on branches lane/remote-verify-runner@25c401156c80c86be03d0f10880bde65e6846a47 and lane/remote-test-client@b46b3a004b209c4212a28b0d2f78a48a81a01af1 (PRs #5878, #5881 closed).
