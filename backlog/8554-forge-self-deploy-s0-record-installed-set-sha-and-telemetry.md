---
bornAs: xtwhrvr
kind: story
size: 3
status: active
scaffoldedBy: "forge-self-deploy-s0"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/readiness/forge-setup.sh", "we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/forge-telemetry.mjs"]
dateOpened: "2026-11-16"
tags: []
---

# Forge self-deploy S0: record installed set sha and telemetry deploy block

Slice S0 of we:designs/forge-self-deploy.md section 5: we:scripts/readiness/forge-setup.sh writes the installed-set record (setDigest, forgeSetSha, hostTier); we:scripts/readiness/forge-exec-run.mjs telemetry adds installed-set fields to the deploy block only for capability deploy:1, preserving the existing draining field; we:scripts/readiness/forge-telemetry.mjs surfaces it. No automation.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/readiness/__tests__/forge-telemetry.test.mjs we:scripts/readiness/__tests__/forge-protocol-capabilities.test.mjs we:scripts/readiness/__tests__/forge-setup-state.test.mjs` (remove `we:` prefixes when executing from the WE checkout).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No fetching, timers, automatic installation, rollback, host-tier upgrades, or live host provisioning; S0 records an operator-run setup only.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Parse installed state as bounded JSON data only; strict types and keys prevent text from becoming terminal commands or forged evidence.
2. **Truncated reads** — Read at most 4097 bytes; missing, malformed, truncated, invalid UTF-8, non-file, or over-4096-byte state omits installed evidence while telemetry remains available.
3. **Shared state files** — Publish state by exclusive temporary file and atomic rename in a pinned root-owned directory; readers see a complete old or new record.
4. **Fail closed** — Invalid or incomplete state supplies no installed-set fields; null hashes explicitly represent unknown identity. Existing draining evidence remains unchanged.
5. **Identity scoping** — Fixed host state path; no request-selected path or per-task settings. The path override is an injected test option only. HTTP rate limits, CSRF and origins are n/a for this existing SSH telemetry command.
6. **State over time** — Each setup replaces the record with the current installed-byte digest, source-set SHA and ET timestamp. Legacy clients receive identical schemas and new clients accept old Forge responses.
7. **Who wrote it** — Setup writes root:root 0644 state under root:root 0755 directory; git failures warn and record null. SHA identifies the eight bundle source paths; digest identifies the five installed bundles, not their source bytes.
