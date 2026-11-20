---
kind: story
status: open
size: 2
dateOpened: "2026-11-20"
scope: ['we:scripts/lib/__tests__/agy-sandbox.test.mjs']
tags: [security, testing, agent-infrastructure]
---

# Probe every confined agy secret root with the real sandbox

PR #7134's 2026-11-20 advisory found that only ssh, secrets and clone environment reads have live denial probes. Parameterize the real sandbox probe from the production secret-root list so new roots cannot silently receive only profile-text coverage. Production remains unavailable while live proof is outstanding.

## Acceptance

- [A1] Planned `REAL denies every declared secret root` in `we:scripts/lib/__tests__/agy-sandbox.test.mjs` iterates `sandboxSecretPaths(fakeHome)` plus the workspace operations root. Plant dummy files beneath directory roots and directly at file roots such as `.netrc`; first assert an unsandboxed read succeeds, then assert EPERM/EACCES under the profile, with no dummy bytes returned. Include `.aws`, `.gnupg`, `.config/gh`, `Library/Keychains`, `.plateau` and `workspace/.operations`.
- [A2] Planned `REAL denies canonical secret aliases` in the same file points a secret-root symlink into an otherwise readable fixture directory and asserts its canonical target is unreadable too. Assert ordinary clone reads still succeed to exclude a non-running client as proof.
- [A3] Run `npm run test:unit -- <test-file>` using the A1 file's repository-relative path after the `we:` prefix on an unnested Darwin host. A skipped or sandbox-setup-failed case is incomplete evidence, never a passing denial.

## Non-goals and variants

No production enablement or real operator-secret access. Cover absent roots, file versus directory roots, canonical aliases and all roots added to the helper. Service channels remain #x6wh6fe; direct credential-state exposure remains #x7agyp2. This test plan is not implemented coverage.
