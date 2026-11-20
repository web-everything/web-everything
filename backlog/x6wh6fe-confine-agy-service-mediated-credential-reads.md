---
kind: story
status: open
size: 3
dateOpened: '2026-11-19'
scope: ['we:scripts/lib/agy-sandbox.mjs', 'we:scripts/lib/__tests__/agy-sandbox.test.mjs']
tags: [security, agent-infrastructure]
---

# Probe and restrict service-mediated credential reads in confined agy

PR #7134 security review identified that direct filesystem denies do not establish protection from Keychain services, Mach/XPC or ssh-agent sockets. The profile still allows these channels by default.

In `we:scripts/lib/agy-sandbox.mjs`, evaluate denying securityd and launchd Mach lookup or removing shell tools from the worker toolset. Use disposable credentials and a fake agent socket to probe service-mediated reads, independently of the existing direct-file tests. Confirm that required agy login/API operation still works and retain provider fallback when it cannot.

Acceptance: named real Darwin probes demonstrate denial of service-mediated secret reads with dummy credentials, without touching operator secrets. Keep the documentation caveat until those probes pass.
