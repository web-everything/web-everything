---
kind: story
status: open
size: 3
dateOpened: "2026-11-20"
scope: ['we:scripts/lib/agy-confined-build.mjs', 'we:scripts/lib/agy-sandbox.mjs', 'we:scripts/lib/__tests__/agy-confined-build.test.mjs', 'we:scripts/lib/__tests__/agy-sandbox.test.mjs']
scopeRationale: 'The shared secret-scrub module is a read-only dependency; this item wires its existing publish detector without changing it.'
tags: [security, agent-infrastructure]
---

# Block credential-state exfiltration through confined agy patches

PR #7134's 2026-11-20 security advisory identified readable real-HOME Gemini state as a separate credential boundary: an allowed document can carry a copied OAuth token into review. Scan the exact final patch before application with the shared publish-secret detector and narrow credential-state read grants to measured required files. Keep production unavailable until the credential boundary is proved.

## Acceptance

- [A1] Planned `voids final patch containing planted Gemini credential` in `we:scripts/lib/__tests__/agy-confined-build.test.mjs`: plant a detector-recognizable fake token in fake-HOME Gemini state; a fake worker copies it into an in-scope doc alongside an ordinary edit. Assert the whole run is voided, no patch is applied, the lane is unchanged and no token appears in returned diagnostics or transcripts published as evidence. Parameterize tracked and untracked docs and an admissible test file.
- [A2] Planned `scans the exact patch bytes passed to apply` in the same file instruments `scrubPublish` from `we:scripts/lib/secret-scrub.mjs` and the apply seam. Assert identical bytes, scan-before-apply ordering and atomic refusal on detector error or a hit. A clean patch still applies. Do not scan a prior diff or only path names.
- [A3] Planned `REAL denies unneeded Gemini credential state` in `we:scripts/lib/__tests__/agy-sandbox.test.mjs`: plant dummy OAuth, MCP and conversation-state files outside the measured read list, prove the unsandboxed controls can read them, then assert sandbox denial. Document measured required files individually. If login needs a credential, design a broker or private state boundary before claiming isolation; do not silently keep the broad read grant.

Run `npm run test:unit -- <test-files>` using the A1/A3 files' repository-relative paths after the `we:` prefix; A3 requires an unnested Darwin host. These cases are planned. The detector cannot establish protection from arbitrary encodings or unknown secret formats; read isolation is required independently. Service-mediated reads and log state remain #x6wh6fe and #x9ffusk, not duplicates of this file-read-to-diff path.
