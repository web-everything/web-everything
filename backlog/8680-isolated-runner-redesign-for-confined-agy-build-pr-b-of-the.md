---
bornAs: xzf2vxv
kind: story
size: 5
status: open
scope: ["we:scripts/lib/agy-sandbox.mjs", "we:scripts/lib/__tests__/agy-isolated-runner.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Isolated-runner redesign for confined agy build (PR-b of the #7134 split)

Redesign confined agy launch around an isolated runner: separate macOS user or VM/container with no operator HOME or credentials, a dedicated agy credential, egress only to the model API, patch-file-only output, and no agy-authored test run on the host before review. Lift condition for the unavailable pin in we:scripts/lib/agy-sandbox.mjs; holds PR-b (launcher, sandbox profile, gemini-direct-task exclusiveLog) of #7134 (#7290). Supersedes the class-A cards from #7134.

## Acceptance

- [A1] **Executable** — Planned `REAL denies operator HOME and credentials with dedicated identity` in `we:scripts/lib/__tests__/agy-isolated-runner.test.mjs`: Plant disposable operator-HOME and credential sentinels; prove unsandboxed control reads succeed, then assert the isolated worker cannot read either and authenticates only with its dedicated agy credential.
- [A2] **Executable** — Planned `REAL permits only model API egress` in `we:scripts/lib/__tests__/agy-isolated-runner.test.mjs`: Probe the approved model API plus direct, loopback, private-network and unrelated destinations; assert only the approved model API succeeds.
- [A3] **Executable** — Planned `REAL exports only patch file and holds executable tests` in `we:scripts/lib/__tests__/agy-isolated-runner.test.mjs`: Attempt extra output channels and an agy-authored test writing a dummy host marker; assert only the patch file is exported, no host test starts before review and the marker is absent.
- [A4] **Executable** — Planned `keeps production refusal for incomplete isolation proof` in `we:scripts/lib/__tests__/agy-isolated-runner.test.mjs`: Parameterize missing, skipped, failed and unreadable proof for each boundary above; assert the unavailable pin remains and no production worker launches. Only a complete passing proof set permits lifting the pin.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No production enablement before the full lift condition is proved.

## Edge cases this change must handle

1. **Untrusted text** — Worker text and patches cannot alter isolation policy.
2. **Truncated reads** — Incomplete probe evidence keeps the provider unavailable.
3. **Shared state files** — Separate runner HOME, credentials and logs from operator state.
4. **Fail closed** — Failed isolation setup or proof refuses launch with provider fallback.
5. **Identity scoping** — Bind credentials and patch output to the isolated run.
6. **State over time** — Cover concurrent runs, interruption and restart without crossing isolation.
7. **Who wrote it** — Only independently observed runner proofs may lift the pin.

## Duplicate admission

nd
