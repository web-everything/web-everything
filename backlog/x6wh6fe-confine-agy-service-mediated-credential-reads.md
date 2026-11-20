---
kind: story
status: open
size: 3
dateOpened: '2026-11-19'
scope: ['we:scripts/lib/agy-sandbox.mjs', 'we:scripts/lib/__tests__/agy-sandbox.test.mjs']
tags: [security, agent-infrastructure]
---

# Probe and restrict service-mediated credential reads in confined agy

PR #7134 security review identified that direct filesystem denies do not establish protection from Keychain services, Mach/XPC or ssh-agent sockets. The current profile denies these channels by default and production stays unavailable; live channel-specific proofs are still required.

In `we:scripts/lib/agy-sandbox.mjs`, retain deny-default policy while probing securityd and launchd Mach lookup and agent sockets. Use disposable credentials and a fake agent socket, independently of the existing direct-file tests. Confirm required agy login/API compatibility separately and retain provider fallback when it cannot work under the restrictions.

## Acceptance

All cases below are planned in `we:scripts/lib/__tests__/agy-sandbox.test.mjs`. Run `npm run test:unit -- <test-file>` using that file's repository-relative path after the `we:` prefix on an unnested Darwin host; skipped probes do not satisfy acceptance.

- [A1] `REAL denies securityd dummy Keychain lookup`: create a disposable Keychain fixture outside the worker. Prove the unsandboxed control reads its dummy item, then assert a sandboxed client cannot retrieve the item and the dummy bytes are absent from stdout, stderr and the proposed patch. An unlisted-executable failure alone does not prove securityd denial; use an allowed client that actually attempts the service call.
- [A2] `REAL denies launchd service lookup`: a controlled Mach lookup helper proves the target is reachable outside the sandbox, then attempts the same lookup under the profile and observes an explicit denial. Do not count an unrelated filesystem denial as the assertion.
- [A3] `REAL denies ssh-agent fixture socket`: a launcher-owned fake agent socket accepts an unsandboxed control request; the sandboxed client gets EPERM/EACCES and the fixture receives zero worker requests. Never connect to the operator's agent.
- [A4] `refuses service probe setup failure`: missing helpers, unsupported channels and incomplete evidence preserve the unavailable gate and provider fallback, rather than counting as a successful proof. Clean up disposable fixtures on success, refusal and interruption.

Keep the documentation caveat until these independent channel assertions pass. Credential-file-to-diff exposure is tracked separately in #x7agyp2.
