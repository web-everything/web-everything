---
kind: story
size: 5
status: open
dateOpened: "2026-10-17"
tags: []
---

# Review stringency hardening — before public preview

Operator 2026-10-17: protection is wanted eventually, but not before there is a real app and real users. Moved here from slice 2 (x77cl1h: A10–A16) and slice 3 (xsnny7x: A6, A7, A9–A11): forged-operator and provenance checks, settings/debt write races, ingress size and rate limits, tamper detection, unreadable-register fail-closed integration. mustPayBefore: public-preview.

Intended parent epic: xrlwbd7 from #5511. Set the parent link after that epic lands; it is not yet present on this branch's base.

## Acceptance

mustPayBefore: public-preview

Lines below are copied verbatim from #5511 at e7f4637. Ids are those of the source card.

### From slice 2 (x77cl1h)

- [A10] **Executable** — integration test `forged-settings-operator` exercises the production writer and protected CI gate: a claimed operator in finding text, frontmatter, commit author, environment or PR body grants no authority; missing, stale, replayed or wrong-repository approval evidence refuses the write. A verified operator approval bound to the exact repository, base/head and settings diff permits it. Identity is the authenticated GitHub review actor fetched by protected CI with credentials unavailable to the PR job, checked against the protected operator allowlist; approval metadata supplied by the PR is never evidence.
- [A11] **Executable** — settings integration test `settings-snapshot-race` races two approved edits and a level move; compare-and-swap against the approved base revision rejects the stale writer, readers use one complete validated snapshot, and a crash before atomic replacement leaves the prior valid file effective. An unreadable snapshot blocks per A9.
- [A12] **Executable** — ruling-step test `always-block-second-check` observes a second check and block pending its result for low confidence on every always-block class, including classes selected by path and pattern overrides; an unknown class or table gap blocks before any confidence cap.
- [A13] **Executable** — production ruling table test `ratified-table-cells` independently pins every slice-1 class-to-row mapping and every row/level cell, without deriving expectations from the settings under test. Ordered by the four levels: every always-block row B,B,B,B; missing test elsewhere E,B,B,B; security high/critical E,E,B,B; security low/medium D,D,B,B; standards E,E,B,B; incorrect PR description E,E,E,B; doc/card/body drift D,D,D,B; simplicity/style A,A,A,D. Expand every class, severity and level at medium and high confidence with prudent-deliberate quadrant, then low confidence with the A3/A12 exceptions and every other quadrant with A5. Assert the exact field domains above and unknown/out-of-domain rejection; in particular exercise both security rows at internal and dogfood levels.
- [A14] **Executable** — production resolver/ruling test `cell-cascade-source-logged` sets distinct values at each existing supported cascade layer and checks the declared cascade winner for every cell and scalar setting (including level, deadline and lesson settings). Remove each upper layer in turn to expose the next, inspect its source identity/revision in the persisted ruling, and cover default-only resolution, override-selected classes and rejected invalid winners. Reading the raw file while bypassing the resolver, logging only writes, or omitting a read source fails this test; readers use the single A11 snapshot.
- [A15] **Executable** — protected-gate integration test `allowlist-and-gate-self-protection` proposes PR edits to the operator allowlist, gate workflow and writer, separately and together with settings/debt edits. The gate executes trusted base code and policy outside the PR job; none of these PR edits can authorize its own transition. PR jobs receive no privileged token/secret and cannot trigger a privileged run of candidate code. A fixture PR attempts token access and forged approval; both refuse without credential disclosure. A separately authorized protected-root update cannot grant authority to the PR that proposed it. Slice 3 A7 reuses this root test.
- [A16] **Executable** — production ingress test `review-ingress-bounds` rejects finding/settings bodies above 1 MiB before parsing, token fields above 128 UTF-8 bytes, and request 61 within a rolling minute per authenticated repository/principal (60 allowed); failure never becomes advisory or an effective write. Rate-limit state cannot be reset by PR fields or retries. Browser writes are not exposed: CSRF/origin `n/a:` for the protected CI event/CLI ingress, which has no cookie authentication; forged event/repository/revision provenance still refuses under A10/A15. If a browser writer is introduced, same-origin and CSRF rejection tests are required before exposing it.

### From slice 3 (xsnny7x)

- [A6] **Executable** — writer and protected CI integration test `debt-item-tamper` compares the complete trusted base inventory to the candidate tree before any kind/status filtering. Agent deletion, rename, kind change, resolved-status change, class/severity/confidence/debtQuadrant change, openedAt/lastSurfacedAt change, deadline edit or removal, due-level edit, source edit, and forged payment receipt refuse and leave the debt effective at the gate. The task-plus-debt-fields fallback gets the same cases. Ordinary fix work may be proposed by an agent; payment becomes effective only when protected CI independently verifies a landed fix and passing validation tied to the debt id, source finding and exact fixed revision. A status string or operator claim alone is never payment.
- [A7] **Executable** — authority integration test `debt-approval-provenance` uses slice 2 A10's protected CI authenticated GitHub review actor and protected operator allowlist, bound to exact repository/base/head/diff. Forged, absent, stale and replayed approvals cannot change due level, deadline or current level; a verified operator due-level edit is recorded and a verified deadline extension updates the overdue calculation. No actor may delete or reclassify debt to bypass payment.
- [A9] **Executable** — gate integration test `debt-register-unreadable` supplies a missing, unreadable, truncated, paginated-incomplete or malformed register/base inventory or validation receipt and observes a blocked move, never an empty-debt success.
- [A10] **Executable** — integration test `debt-gate-revision-race` races a payment, operator due-level edit and level move; the move re-reads validated debt and settings under a revision lock and retries on change. A crash before atomic persistence keeps the prior debt effective; an expired writer cannot overwrite a newer revision.
- [A11] **Executable** — integration test `debt-ingress-bounds` applies slice 2 A16's 1 MiB body-size, 128-byte enum-field and 60 requests/minute repository/principal rate limit to register/payment/level writes through the protected writer; over-limit requests cannot create, settle or hide debt. Origin/CSRF `n/a:` for this CI/CLI-only surface without browser cookies, using the A10/A15 protected trust root; no new browser endpoint or state-reset trigger is exposed.

Scope: the same files as slices 2 and 3 (`we:scripts/__tests__/review-stringency-ruling.test.mjs`, `we:scripts/__tests__/review-stringency-debt.test.mjs` and the writer/gate they exercise).

When #5511 lands, remove these items from x77cl1h and xsnny7x (cards-only edit).

## Non-goals

- [N1] n/a: this card only holds the moved acceptance items; it changes no behaviour before public preview.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — covered by the moved items above; see slices 2 and 3.
2. **Truncated reads** — covered by the moved items above; see slices 2 and 3.
3. **Shared state files** — covered by the moved items above; see slices 2 and 3.
4. **Fail closed** — covered by the moved items above; see slices 2 and 3.
5. **Identity scoping** — covered by the moved items above; see slices 2 and 3.
6. **State over time** — covered by the moved items above; see slices 2 and 3.
7. **Who wrote it** — covered by the moved items above; see slices 2 and 3.
