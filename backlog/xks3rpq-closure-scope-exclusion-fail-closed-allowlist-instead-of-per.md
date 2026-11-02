---
kind: story
size: 8
status: open
scope: ["we:scripts/lib/import-closure.mjs", "we:scripts/lib/daemon-rebuild/closure-scope.mjs", "we:scripts/lib/daemon-rebuild/skip-unrelated.mjs", "we:scripts/lib/__tests__/closure-scope.test.mjs", "we:scripts/lib/__tests__/daemon-clone-entries.test.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Closure-scope exclusion: fail-closed allowlist instead of per-form dynamic-eval detection (from #6033)

Design-stage card split from #6033 (R387). The closure-scope exclusion decides which files a daemon rebuild may treat as unrelated. Per-form detection of dynamic code loading keeps losing: the red-team found a new break class every round, each letting an executable dependency be excluded. Classes found: (1) inspector (node:inspector evaluating code), (2) Function constructor, (3) Function-constructor alias (indirect reference to Function), (4) TS import-assign (import x = require(...)). R115: a new break class in 3 consecutive rounds means stop rounds and return to design; this is a design-stage miss, so no more detector patches. DESIGN QUESTION: replace the denylist of dynamic-eval forms with a fail-closed allowlist (a file is excluded only when it is proven to be one of an explicit set of inert forms: static ESM/CJS imports with literal specifiers, no eval-capable globals or builtins), and everything else counts as in-closure. Decide: allowlist grammar, how unknown syntax or parse failure is handled (in-closure), the cost in rebuilds skipped, and the red-team proof required before build. Code: we:scripts/lib/import-closure.mjs, we:scripts/lib/daemon-rebuild/closure-scope.mjs, we:scripts/lib/daemon-rebuild/skip-unrelated.mjs. Prior work to mine: lane/overlay-generation-s1-r2.

## Acceptance

- [A1] **Inert-source proof** — Planned case `excludes only files admitted by the inert-source grammar` in `we:scripts/lib/__tests__/closure-scope.test.mjs`: an admitted file outside the runtime closure may be excluded; unknown syntax, parse failure, eval-capable globals and builtins remain relevant. Run the named file with `npm run test:unit -- <file>` after the grammar is ratified.
- [A2] **Incomplete evidence** — Preserve `missing hop-zero roots are incomplete (stopWhenIncomplete=%s)`, `a tracked-but-deleted spawn target at hop %i is incomplete` and `keeps the closure consumer conservative for a missing %s alongside readable entries` in `we:scripts/lib/__tests__/daemon-clone-entries.test.mjs`. Missing roots at hop 0, 1 or 2 must prevent skipping code changes, with both `stopWhenIncomplete` modes; docs-only changes may still skip. Recovery on a fresh walk restores filtering.
- [A3] **CommonJS proof before admission** — `refuses a CommonJS runtime root from %s until require graphs are supported` and `refuses CommonJS targets for default boot and manifest-mapped roots: %s` in `we:scripts/lib/__tests__/daemon-clone-entries.test.mjs` refuse `.cjs` caller, LaunchAgent, boot and mapped-pass symlink targets. `a changed required dependency remains relevant: %s` in that file asserts `closureHits === null` or the dependency is included for `.js`, `.mjs` and `.cjs`, direct, imported and spawned entries, require aliases, createRequire aliases and escaped identifiers. It also exercises accepted discovered roots with readable boot siblings. These conservative CommonJS checks do not establish the general inert-source grammar in A1.
- [A4] **Caller contract** — `missing runtime roots remain unknown at every closure consumer: %s` in `we:scripts/lib/__tests__/daemon-clone-entries.test.mjs` covers `collectRunClosure`, `makeSkipCheck`, `decideRestart`, `checkCodeUnchanged` and `loadReadOnlyOps`. Assert respectively unknown/no skip, no skip, restart, rerun, and no read-only proof. The same matrix covers review, promotion and fix dispatch classifiers, asserting code remains relevant. A readable sibling cannot erase a missing root. The read-only test feeds a real missing-sibling closure through the trusted-graph boundary and includes a positive complete-graph control.
- [A5] **Entry grammar** — Preserve the named cases `permits script arguments after an entry preceded by safe boolean Node flag %s`, `refuses pass-daemon with missing or duplicate pass flags: %j` and `permits Program equal to ProgramArguments[0]` in `we:scripts/lib/__tests__/daemon-clone-entries.test.mjs`. Every supported boolean flag before the entry must permit eval-shaped script arguments; missing/duplicate pass flags must refuse; matching Program must retain the entry.
- [A6] **Non-source inputs** — `retains conservative treatment for non-source runtime inputs: %s` in `we:scripts/lib/__tests__/daemon-clone-entries.test.mjs` asserts no skip for manifests, every supported lockfile, daemon configuration and named runtime-read data even with a complete ESM closure; its docs-only control may skip.
- [A7] **Discovery stays unwired** — `keeps clone discovery unwired pending inert-source proof` in `we:scripts/lib/__tests__/daemon-clone-entries.test.mjs` asserts no production script or skill module references the discovery module or export. Remove this interim prohibition only when A1's grammar and the prerequisite consumer proofs are supplied; the planned standards integration fixture below must replace it.

Must: missing, unreadable, malformed, unparsed or unsupported runtime evidence never permits exclusion of code changes. Discovery errors retain the full conflict; incomplete closures use the existing conservative fallback.

Must: manifests, lockfiles, daemon configuration and runtime-read data retain their existing conservative treatment. Docs-only exclusion remains permissible only through the established fallback. No receive or write endpoint is introduced, so body-size, rate-limit and CSRF checks do not apply.

## Non-goals

- [N1] Do not implement more per-form dynamic-eval detectors, execute candidate source to establish safety, or enable clone-root discovery on a live daemon. Ratifying and implementing the inert-source grammar is separate from slice D's discovery and missing-root fixes.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Treat source and plist values as data; do not execute them. Unknown grammar, quoting, computed specifiers, escaped identifiers and concatenation cannot establish an exclusion (A1).
2. **Truncated reads** — Read or parse failure, exceeded parser limits and incomplete plist output invalidate the proof; no prefix-only proof (A1, A2).
3. **Shared state files** — Cache only within one immutable tree walk. No shared persistent parser cache or new writer is introduced (A2).
4. **Fail closed** — A missing entry invalidates the closure even with readable siblings, including discovered spawn roots at later hops; unknown syntax remains relevant (A1, A2, A4).
5. **Identity scoping** — Canonicalize clone and entry paths; an alias must not bypass the `.cjs` refusal or pull a sibling clone into the proof (A3).
6. **State over time** — Re-run on the new tree snapshot; adding a formerly missing target must recover completeness, and deleting it must invalidate it again (A2).
7. **Who wrote it** — Source authorship grants no trust. Candidate source is never executed to prove an exclusion; the same grammar applies to all authors (A1).

## Risks

The grammar is not yet ratified. Conservative refusal can increase rebuild frequency; measure that cost rather than broadening the admitted language without proof. CommonJS source hints and Unicode escapes now make the import closure incomplete (including conservative false positives in comments or strings). This is an interim dependency boundary, not a proof of arbitrary JavaScript safety: computed property names and other dynamic code still require A1. Keep clone discovery unwired under A7 until the allowlist is implemented. Discovery scans every plist label and requires an explicit WorkingDirectory resolving to the clone root; unsupported or unreadable plists refuse discovery, which can increase conservative rebuilds. Regex-only recognition and cache reuse across snapshots can both produce false completeness.

## Test plan

All A1–A7 items above name the repository test file, case and observable assertion. A1 remains planned; A2–A7 name executable cases. Run the named files through `npm run test:unit -- <file>` during implementation, then use the diff-selected verify gate. Before enabling exclusions, mutation-check each admitted syntax form and each incomplete-evidence fallback: allowing an unknown form, dropping a missing root, or retaining `complete:true` after a null spawn-hop result must redden a named case. Include inspector, Function-constructor aliases and TS import-assign as denied grammar fixtures. Report the measured rebuild cost and remaining unsupported forms before wiring.

## Prevention owed by PR #6226

- Consumer-contract guard: A4 owns the missing-entry contract across every `collectImportClosure` caller; A2 defends hop zero and both later-hop branches and recovery. Planned standards case `rejects a collectImportClosure caller without a null-closure test` in `we:scripts/__tests__/check-standards.test.mjs`, implemented in `we:scripts/check-standards-rules.mjs`, must reject a fixture adding a caller without a named negative test and accept it with a conservative assertion. A change to collector semantics must require proof mappings for all callers, not just the changed file.
- Extension-coverage guard: A3 must fail if discovery accepts a new extension without a consumer dependency fixture proving completeness or conservative fallback. Include default boot roots and manifest-mapped pass scripts, not only plist arguments.
- Card-validation guard (planned follow-up): in `we:scripts/__tests__/check-standards.test.mjs`, add `rejects an open linked card with unfinished acceptance` and `requires a test file, named case and assertion for every acceptance identifier and unnumbered Must guarantee`; wire the corresponding rule in `we:scripts/check-standards-rules.mjs`. Assert a nonzero standards verdict for an open PR-linked card with a literal TODO marker or a missing proof field, including unnumbered guarantees in Acceptance and Risks, and zero for a concrete planned test such as A1. A6 maps the non-source-input Must guarantee; A7 maps the no-wiring risk. This card records the owed gate; it does not claim the gate exists.
- Wiring guard (planned standards replacement for A7): `rejects live clone discovery wiring before closure proof coverage` in `we:scripts/__tests__/check-standards.test.mjs` must reject a live integration fixture until A1, A3 and A4 proofs exist and pass, and accept the same fixture with those prerequisites. Wire the rule in `we:scripts/check-standards-rules.mjs` before removing A7's prohibition.
- Plist coverage guard: `unions clone-realpath LaunchAgents, mapped passes, caller entries and boot entries` includes an unrelated label pointing into this clone. `refuses a missing bare Node entry with WorkingDirectory=%s` and `refuses an absolute entry with unsupported WorkingDirectory=%s` cover absent, relative, nested, foreign and malformed working directories. `permits a WorkingDirectory alias of the clone root` pins canonical containment. All are in `we:scripts/lib/__tests__/daemon-clone-entries.test.mjs` and assert discovery or refusal, not just parser output.
- Argument-branch guard: A5 pins all supported boolean Node flags before an entry, missing/duplicate pass names and matching Program. Keep unknown value-taking flags refused.
