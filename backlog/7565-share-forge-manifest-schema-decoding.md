---
bornAs: x3yazu1
kind: story
status: open
size: 2
dateOpened: '2026-10-31'
scope: ['we:scripts/readiness/forge-exec-run.mjs', 'we:scripts/readiness/forge-exec-manifest.mjs', 'we:scripts/readiness/__tests__/forge-exec-run.test.mjs']
tags: [forge, simplification]
---

# Reuse shared manifest decoding in Forge verification

The advisory simplicity finding in PR #6059 (2026-10-31) points to the second
schema decoder in `we:scripts/readiness/forge-exec-run.mjs:164`. Reuse
`decodeManifest` while retaining the verifier's digest, filesystem, sibling,
Git-evidence and excluded-test checks. The review requires a separate card;
this repair does not change the decoder.

## Acceptance

- One schema decoder validates the manifest wire format for both callers.
- Existing malformed-manifest, canonical-base64, ordering, sibling and digest
  rejection tests retain their guarantees; add parity cases for any differing checks.

## Test plan

Run the affected manifest and runner suites with valid and malformed manifests,
including Git metadata and sibling manifests. Confirm no rejected input becomes accepted.

## Non-goals

No wire-format migration or changes to copy, ownership or cache policy.
