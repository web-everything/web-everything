## Provider rotation shadow (PROV-AB S1.2)

`provider-rotation.test.mjs` and `provider-rotation-shadow.test.mjs` cover the pure engine and the
post-append observer; run them with `run-scorecard-store.test.mjs` through heavy-admission.
The shared routing catalog is IO-free so validating rotation does not import a settings reader.
The shipped policy remains shadow with Carbon unpromoted. Go-live option A is inactive data;
neither its activation flag nor its allocation thresholds participate in routing.

Rotation and live dispatch use separate model allowlists: a rotation catalog entry does not authorize
a live adapter identity. Review draws need a known lens; key lenses (policy additions plus the three
built-ins) need a complete, catalog-valid builder arm. A builder-family assertion never substitutes
for that arm. The observer preserves dispatch identity (red-team stays key), shape and capacity
eligibility; any refusal records `crossVendor.ok: false` without changing the actual route.
Malformed `mode: on` policies refuse; absent policies and off/shadow preserve the legacy route.
Keep the Carbon-alias test promoted with a cross-vendor builder and assert successful live security
routes before inspecting their safeguards. Negative controls must fail when `carbon-high` is removed
or those live routes are replaced by null; the S1.2 audit repair exercised both controls red first.

Merge-path checklist answers (this slice observes seat selection and has no gate authority):

| Checklist | Boundary and negative evidence |
| --- | --- |
| 1 Producer identity | The existing scorecard validator remains the producer boundary. The named shadow invariance test compares stored bytes and actual identities. Shadow picks never become trusted statuses or routes. |
| 2 Present vs absent | Missing, malformed, oversized or invalid policies log refusals; absent capacity or builder evidence refuses picks. Tests cover the real file reader and no eligible cross-vendor arm. Oversized policy fallback: operator repairs the file to at most 256 KiB. |
| 3 Ordering | Lines append in observation order. Timestamps are telemetry; no ordering comparison grants admission. The multi-kind test asserts one line per append. |
| 4 Read/write races | Policy and capacity snapshots are observations, never write-back or admission evidence. Real-reader and thrown-draw tests prove failures cannot change the stored dispatch. |
| 5 Head binding | This observer grants no verdict and performs no head-based action. Subject and handle come from the appended run; existing dispatch head checks remain authoritative. Invariance tests cover actual routes. |
| 6 Round/run binding | Each line carries that row's handle and subject; no success joins or clearing actions exist. The multi-kind test pins attribution. |
| 7 Fail-open catches | Pure picks return refusals without catches. Only post-append telemetry catches errors; unreadable-policy, thrown-draw and failed-append tests prove it cannot affect dispatch. |
| 8 Write ordering | Scorecard append succeeds before logging; no dedupe receipt suppresses retries. Failed-sidecar tests preserve the append result. |
| 9 Crash windows | A lost sidecar line loses observation only. It cannot leave a gate open; failed-sidecar tests exercise the same boundary. |
| 10 Credentials | No remote write or credential selection is added; only a local JSONL append. Invariance tests exercise the complete hook. |
| 11 Environment | No new shell, Git or worker launch. Existing capacity readers keep their own hardened IO. Hermetic real-reader tests inject platform paths and observations. |
| 12 Exemptions | Unknown lenses, case variants and kind/lens mismatches refuse; required cross-vendor seats cannot be disabled by policy. On-mode logging refuses. Named tests cover these paths. |
| 13 Liveness | No agent process is launched and no verdict is recorded by the observer; thrown-draw tests preserve the completed run. |
| 14 Simplicity | One stateless append hook and one append-only sidecar; no retry machinery, markers or second scorecard rewrite. Byte comparisons and one-line-per-run assertions enforce the boundary. |
- [Testing topic notes and authoring guidance](README.md)


