---
bornAs: x77cl1h
kind: story
size: 5
parent: "6236"
status: open
blockedBy: ["6232"]
dateOpened: "2026-10-17"
tags: []
---

# we: review stringency slice 2 — settings table used by the ruling step

Add the review-stringency settings table (class by level to block, expedite, debt or advisory), every cell a cascade setting with its source logged, and make the ruling step read it. Fail closed on gaps. Current level internal delivery.

## Input contract

Implementation wire domains (exact ASCII tokens, no coercion): `severity` is `low | medium | high | critical`; the security high row means `high | critical`, and lower means `low | medium`. `confidence` is `low | medium | high`; only the exact token `low` triggers the confidence cap (no numeric threshold or string-to-number conversion). `debtQuadrant` is required on every finding and is `prudent-deliberate | prudent-inadvertent | reckless-deliberate | reckless-inadvertent`; only `prudent-deliberate` may follow a debt cell. This is a wire encoding of the ruling's categories, not a new severity score. Slice 1 owns the exact closed `class` tokens and their ratified table-row mapping; each token maps to exactly one row, with security additionally keyed by severity. Level tokens are `internal-delivery | dogfood | public-preview | public-release`, in that order. Outcome tokens are `block | expedite | debt | advisory`.

Matching path/pattern rules outrank the reviewer tag. Multiple matches selecting the same class deduplicate; different selected classes are an ambiguous policy and block before the confidence cap, independent of rule kind, order or confidence. Never select the last iterated rule. Invalid reviewer fields still block before overrides.

## Acceptance

- [A1] **Executable** — validator test `settings-table-schema` over `we:scripts/settings/review-stringency.json` rejects an unknown class, a missing level cell, or a debt cell without a must-pay-before level, and passes on the ratified amended table.
- [A6] **Executable** — validator test `monotonic-levels` rejects fixtures where a class blocks at one level but becomes expedite, debt or advisory at any higher level; the ratified table passes.
- [A7] **Executable** — ruling-step test `table-gap-blocks` supplies a missing class/level cell and observes block.
- [A2] **Executable** — ruling-step test `override-precedence` supplies a reviewer tag that conflicts with a matching path rule, then with a matching pattern rule; each rule wins and the outcome comes from the overridden class at the current level. With no matching rule, the reviewer tag supplies the class. Enumerate path/tag, pattern/tag, path/pattern, path/path and pattern/pattern pairs: different classes among matching rules block before the cap, including low confidence and guard-versus-doc fixtures in both insertion orders; identical-class matches deduplicate and use that class.
- [A3] **Executable** — ruling-step test `confidence-cap` covers each non-always-block outcome (block, expedite, debt, advisory): an explicitly valid low reviewer confidence yields advisory. Invalid or missing confidence is handled first by A8.
- [A4] **Executable** — settings-write test `settings-edit-authority` rejects agent attempts to change any table cell, an invariant row, or the current level, leaving the effective settings unchanged; the corresponding operator edits succeed and log the setting source and operator identity.
- [A5] **Executable** — ruling-step test `careless-debt-block` covers all four `debtQuadrant` values: each reckless or inadvertent value blocks regardless of configured cell or low confidence; only explicit `prudent-deliberate` follows the class/level outcome and confidence rules. Missing, null, wrong-type and injected quadrant values block, never default to prudent-deliberate.
- [A8] **Executable** — ruling-step test `malformed-finding-blocks` independently omits and corrupts class, severity, confidence and debtQuadrant (null, wrong type, empty, garbage and instruction strings); each yields block before the confidence cap or rule overrides. For every enum, changed case, whitespace, invisible characters, Unicode lookalikes, newline/CR/U+2028, quotes, backticks, leading `--`, traversal and joined fragments are rejected, never normalized into a valid value. Reject tokens above 128 UTF-8 bytes before enum matching; numeric confidence, NaN and infinities are invalid.
- [A9] **Executable** — ruling-step test `unreadable-table-blocks` supplies missing, unreadable, truncated and malformed settings and finding payloads; each yields block without a permissive fallback.
- [A10] **Executable** — integration test `forged-settings-operator` exercises the production writer and protected CI gate: a claimed operator in finding text, frontmatter, commit author, environment or PR body grants no authority; missing, stale, replayed or wrong-repository approval evidence refuses the write. A verified operator approval bound to the exact repository, base/head and settings diff permits it. Identity is the authenticated GitHub review actor fetched by protected CI with credentials unavailable to the PR job, checked against the protected operator allowlist; approval metadata supplied by the PR is never evidence.
- [A11] **Executable** — settings integration test `settings-snapshot-race` races two approved edits and a level move; compare-and-swap against the approved base revision rejects the stale writer, readers use one complete validated snapshot, and a crash before atomic replacement leaves the prior valid file effective. An unreadable snapshot blocks per A9.
- [A12] **Executable** — ruling-step test `always-block-second-check` observes a second check and block pending its result for low confidence on every always-block class, including classes selected by path and pattern overrides; an unknown class or table gap blocks before any confidence cap.
- [A13] **Executable** — production ruling table test `ratified-table-cells` independently pins every slice-1 class-to-row mapping and every row/level cell, without deriving expectations from the settings under test. Ordered by the four levels: every always-block row B,B,B,B; missing test elsewhere E,B,B,B; security high/critical E,E,B,B; security low/medium D,D,B,B; standards E,E,B,B; incorrect PR description E,E,E,B; doc/card/body drift D,D,D,B; simplicity/style A,A,A,D. Expand every class, severity and level at medium and high confidence with prudent-deliberate quadrant, then low confidence with the A3/A12 exceptions and every other quadrant with A5. Assert the exact field domains above and unknown/out-of-domain rejection; in particular exercise both security rows at internal and dogfood levels.
- [A14] **Executable** — production resolver/ruling test `cell-cascade-source-logged` sets distinct values at each existing supported cascade layer and checks the declared cascade winner for every cell and scalar setting (including level, deadline and lesson settings). Remove each upper layer in turn to expose the next, inspect its source identity/revision in the persisted ruling, and cover default-only resolution, override-selected classes and rejected invalid winners. Reading the raw file while bypassing the resolver, logging only writes, or omitting a read source fails this test; readers use the single A11 snapshot.
- [A15] **Executable** — protected-gate integration test `allowlist-and-gate-self-protection` proposes PR edits to the operator allowlist, gate workflow and writer, separately and together with settings/debt edits. The gate executes trusted base code and policy outside the PR job; none of these PR edits can authorize its own transition. PR jobs receive no privileged token/secret and cannot trigger a privileged run of candidate code. A fixture PR attempts token access and forged approval; both refuse without credential disclosure. A separately authorized protected-root update cannot grant authority to the PR that proposed it. Slice 3 A7 reuses this root test.
- [A16] **Executable** — production ingress test `review-ingress-bounds` rejects finding/settings bodies above 1 MiB before parsing, token fields above 128 UTF-8 bytes, and request 61 within a rolling minute per authenticated repository/principal (60 allowed); failure never becomes advisory or an effective write. Rate-limit state cannot be reset by PR fields or retries. Browser writes are not exposed: CSRF/origin `n/a:` for the protected CI event/CLI ingress, which has no cookie authentication; forged event/repository/revision provenance still refuses under A10/A15. If a browser writer is introduced, same-origin and CSRF rejection tests are required before exposing it.

Ruling and amended table: [we:backlog/6239](/backlog/6239-decision-review-stringency-classified-findings-per-level-out/) and the statute `we:docs/agent/platform-decisions.md#review-stringency-classified-outcomes`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Debt lifecycle, panel rendering and advisory jobs belong to slices 3–5; this slice does not change ratified cells.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — A8 validates every model-supplied class, severity and confidence field before policy evaluation; source code, docs, config and data cannot supply policy or authority (A10).
2. **Truncated reads** — A9 blocks on any incomplete or unreadable finding or settings snapshot.
3. **Shared state files** — A11 uses atomic replacement and a revision check; no mixed or stale snapshot is effective.
4. **Fail closed** — A1, A6–A9 reject invalid tables and payloads; always-block and careless-debt invariants precede the confidence cap (A5, A12).
5. **Identity scoping** — A10 binds authenticated review evidence to the repository, exact head/base and approved diff, never a self-declared role.
6. **State over time** — stale approvals and concurrent writes refuse under A10–A11; only a fresh approved revision becomes effective.
7. **Who wrote it** — protected CI verifies the GitHub review actor against the protected operator allowlist (A10); agent proposals cannot change effective settings (A4).

## Risks

The wrong security row, confidence default or ambiguous override could weaken outcomes (A2–A3, A5, A8, A12–A13). File-only reads could bypass cascade provenance (A14). Relaxed levels and missing state could permit delivery (A1, A6–A9). Forged identity, PR-edited trust roots and races could authorize unsafe writes (A4, A10–A11, A15); oversized or flooded inputs could exhaust ingress (A8, A16).

## Test plan

Planned file `we:scripts/__tests__/review-stringency-ruling.test.mjs` owns every named A1–A16 case and its concrete assertions above. Include production resolver, writer and protected-gate wiring rather than only schema/reducer tests. The table-cell expectations must be independent literals, and read-source assertions must inspect persisted ruling evidence. These tests remain implementation obligations; this card does not claim they exist or pass today.
