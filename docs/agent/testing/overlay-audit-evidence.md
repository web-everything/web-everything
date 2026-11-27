# Overlay audit evidence

Spec for `scripts/lib/overlay-audit-evidence.mjs` (`loadAuditEvidence`, `auditEvidenceFor`). Tests: `scripts/lib/__tests__/overlay-audit-evidence.test.mjs`.

## Waiver precedence

For each exact ref, case-insensitive SHA, and ruling, validated tool/platform entries shadow lower-priority entries even when revoked; revocation never enables fallback.

1. **Shadowing.** Precedence is tool > platform > store. It applies to every higher-layer entry that survives settings validation, revoked or not. The shadow set is built from the full merged set BEFORE the revocation filter, so a revoked higher-layer entry shadows the lower layer for the same [ref, sha, ruling] key. Revocation only decides what is admitted, never what is shadowed. A WITHDRAWN record is keyed by [ref, sha] only.
2. **Timestamps.** There is no validity filter at load. An invalid or future `at` stays in `loadAuditEvidence().waivers` (only revocation removes entries at load) and is rejected later by `auditEvidenceFor`.
3. **Malformed settings.** A malformed platform or tool `prototypeLoad` settings file, or any non-ENOENT read or parse error of the tool settings, marks the evidence damaged and blocks ALL waivers, not only matching keys. This is not shadowing.
