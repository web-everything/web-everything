---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/", "we:scripts/check-standards-rules.mjs"]
dateOpened: "2026-11-23"
tags: [security, prevention]
---

# Centralize redaction before publishing gh stderr diagnostics

PR #7381 review identified raw `gh` stderr reaching logs and failed-merge reports. The immediate repair restores the shared error formatter's historical bound, uses the existing redacted tail helper for the new default-branch warning, and redacts catch-up child stderr before cutting its diagnostic tail. Route all remaining gh stderr surfaced to logs or reports through a shared redaction helper, and add a standards rule rejecting raw stderr interpolation.

## Acceptance

- [A1] Executable diagnostic tests cover merge failures, listing failures, and catch-up child stderr, including Authorization headers, GitHub tokens, URL credentials, and configured secret values.
- [A2] Redact before truncation and whitespace collapse. A token spanning the output boundary must leave no credential suffix; preserve useful nonsecret failure text and existing output bounds.
- [A3] Executable standards fixtures reject raw stderr interpolation into logs/reports and accept calls through the approved helper, including aliases and concatenation.
- [A4] An unreadable or oversized diagnostic yields a bounded withheld-diagnostic placeholder; missing redaction evidence must never permit raw fallback output.

## Non-goals

- Redaction is hygiene, not proof that arbitrary child output is safe to publish. Do not change pass admission, routing, retries, or merge authority.

## Edge cases

- Untrusted text: cover LF, CR, Unicode separators, terminal controls, quoted/concatenated assignments, token prefixes, Authorization lines, and URL credentials.
- Truncated reads and resource bounds: inspect the bounded raw stream before cutting the public tail; define a withheld-diagnostic fallback on overflow.
- Shared state: no new persistent credential store or diagnostic registry.
- Normalization: redact before every output transformation; test both string and Buffer inputs.
- Recovery: missing stderr, redaction failure, timeout and wrapper errors use the same bounded safe fallback.

Source: PR #7381 security prevention, review dated 2026-11-23. Related narrower alert-path prevention: #7253.
