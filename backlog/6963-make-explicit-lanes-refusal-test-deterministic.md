---
bornAs: xqccjvp
kind: task
status: open
scope: ["we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs"]
dateOpened: "2026-10-23"
tags: [prevention, testing, git]
---

# Make the explicit lanes refusal test deterministic

Make the named explicit-lanes refusal test prove the intended guard independently of the host home directory. PR #5806's advisory identifies this as a later-round card suggestion, so track the change separately rather than changing the test in that PR.

Source: web-everything/web-everything#5806, advisory review posted 2026-10-24T00:54:30Z, head `4a5ee48414889ace5d987b240b601ec1734aafa3`, simplicity/COVERAGE finding and codex-correctness card suggestion. The review cites `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs:705`; the current named case is at line 719. A generic thrown-error assertion can pass because the default scan root is absent before the explicit-lanes guard is reached.

Idempotency key (do not edit): advisory-prevention-key:web-everything/web-everything#5806@4a5ee48414889ace5d987b240b601ec1734aafa3:explicit-lanes-test

## Acceptance

- [A1] **Executable** — Pass the fixture's existing root explicitly as `--scan-root` and its existing pool root as `--pool-root`. Use `spawnSync` or inspect the thrown child error to assert status 2 and the specific `--apply needs an explicit --lanes=N,M list` diagnostic. A missing-root error or unrelated exception fails the test.
- [A2] **Executable** — The case passes when the user's default workspace is absent. Show with the sanctioned mutation/revert-red mechanism that removing the explicit-lanes guard makes this case fail, without manually weakening a production guard.
- [A3] **Executable** — Run `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs` through `npm run test:unit --`; preserve existing apply, dry-run, lease and borrower cases.

## Non-goals

- [N1] Do not change production lane selection, scan roots or cleanup eligibility.

## Edge cases

- Untrusted text: pass temporary paths as argv entries, including paths containing spaces.
- Truncated reads: n/a, the child diagnostic is small and fully captured.
- Shared state: use the existing test fixture, without changing the host workspace.
- Fail closed: assert the specific guard diagnostic and exit status rather than any failure.
- Identity scoping: validate fixture roots so a different repository or absent default root cannot satisfy the test.
- State over time: do not depend on whether a user's workspace exists on the day the test runs.
- Who wrote it: n/a, this test runs a local CLI with controlled fixture arguments.
