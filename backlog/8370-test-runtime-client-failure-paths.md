---
bornAs: xw3j6d8
kind: story
size: 1
parent: "5452"
status: open
scope: ["we:scripts/lib/__tests__/pr-events.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Test runtime client failure paths never retry or log credentials

Advisory prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29: simplicity at we:scripts/lib/pr-events.mjs:94 and codex-correctness at the client test file both flag the success-only coverage of appendRuntimeEvent's no-retry and no-credential-logging promise.

Latest advisory linkage: PR #6889, 2026-11-16T05:37:58Z, head ae079849826a461c809a93df310d133f759eb31c. A1–A3 carry correctness/test-coverage and security/coverage's client failure-path requests, also raised as simplicity and codex-correctness card suggestions. The general prevention obligation requiring negative-path tests for 'never X' comments is carried by #8369 A4. The named tests below remain planned, not implemented evidence.

## Acceptance

- [A1] **Executable** — add failure-path tests in we:scripts/lib/__tests__/pr-events.test.mjs for fetch rejection, abort/timeout, non-2xx responses including 401/429/500, malformed JSON and a failure payload. Assert exactly one network attempt for each call.
- [A2] Capture logging and surfaced error text. Put a unique token marker in credentials and in hostile server/error strings; assert it never appears in logs or returned diagnostics. Exercise an error containing newlines and Authorization text without contacting a real service.
- [A3] Demonstrate red if a failure retries or logs the token; preserve the current fail-closed result shape and do not weaken existing success-path assertions.

## Test plan

Planned names in we:scripts/lib/__tests__/pr-events.test.mjs:

- A1 — **Preservation (GREEN today)**: 'runtime client attempts each failed request exactly once', parameterized for rejection, abort/timeout, 401/429/500, malformed JSON and a failure payload. Use an injected fetch and deterministic timer for timeout. Planned mutation proof: retry a failed request.
- A2 — **Preservation (GREEN today)**: 'runtime client failure diagnostics never expose credentials', capturing all console/log surfaces and returned diagnostics with a unique token marker echoed by hostile errors and response text. Planned mutation proof: log or return a token-bearing exception.
- A3 — **Preservation (GREEN today)**: assert both properties on each failure branch in the two named tests above, including after timer cleanup, so delayed retries or logs cannot escape the observation window. Keep the success assertion separate. Planned mutation proof: schedule a retry or credential-bearing log after returning.

## Proof plan

Record named failure-path red/green results using fake credentials and no network. Show the assertions detect an extra request and credential-bearing diagnostics through the approved red-proof workflow. Coordinate the general 'never X' review checklist with #8369 A4.

## Non-goals

- [N1] No new retry policy, credentials, network calls or production client redesign.

## Edge cases this change must handle

1. **Untrusted text** — remote/error text with newline and credential echoes stays sanitized.
2. **Truncated reads** — malformed or incomplete JSON fails closed.
3. **Shared state files** — n/a: injected fetch and log capture only.
4. **Fail closed** — network, HTTP and parsing failures never produce a success result.
5. **Identity scoping** — the credential marker is absent from every diagnostic surface.
6. **State over time** — timeout and retry branches issue at most one request per call.
7. **Who wrote it** — keep authentication in the request header; no live token is used.
