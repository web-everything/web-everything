---
bornAs: xilljpr
kind: story
size: 2
status: open
scope: ["we:scripts/lib/lane-verify.mjs", "we:scripts/pr-land.mjs", "we:scripts/lib/__tests__/lane-verify-ci-source.test.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Reinforce CI-green verification source: pin workflow and re-audit

Reinforce later: the CI check-run verification source in we:scripts/lib/lane-verify.mjs trusts the GitHub Actions app id and check name test only. Also pin the workflow path and re-audit after the app-id fix (round 2 was cut at the cap; R903+R907 accepted the residual).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/lane-verify-ci-source.test.mjs` fails before the pin lands and passes after: a same-named `test` check-run from the right app but a different workflow path is refused.

## Non-goals

- [N1] n/a: nothing excluded beyond the pin itself.

## Edge cases this change must handle

1. **Untrusted text** — n/a: check-run fields are compared, never rendered.
2. **Truncated reads** — refuse when the check-runs read is unparseable or cut off.
3. **Shared state files** — n/a: no state file is written.
4. **Fail closed** — any unreadable, pending, cancelled, missing or other-sha result keeps refusing.
5. **Identity scoping** — pin the workflow path and the app id, not only the check name.
6. **State over time** — a newer re-run on the same sha wins over an older success.
7. **Who wrote it** — only the GitHub Actions app counts; a foreign app with the same check name is ignored.
