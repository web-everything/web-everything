---
bornAs: x2vndgg
kind: story
size: 3
parent: "6268"
status: open
priority: now
scaffoldedBy: "fix-5549"
dateScaffolded: "2026-10-18"
blockedBy: ["6266"]
scope: ["we:scripts/lib/operator-override-store.mjs", "we:scripts/lib/__tests__/operator-override-store.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# operator override: a signed approval cannot be backdated by direct log insertion (expedite)

TOP PRIORITY (expedite), due before public preview. Ruled by the operator on 2026-10-18 from PR #5549's red-team break #2, at we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:23. Not fixed in PR #5549, by that same ruling.

**The break.** Protected CI signs a confirmed loosening request at 10:00, expiring at 10:00 the next day. Nobody applies it. At 10:30, apply must refuse it as older than 15 minutes. Instead, an agent writes that signed request straight into the store log and the matching snapshot. It picks an unused `requestId` and a key with no earlier record, and sets the unsigned record time to 10:05. Every read check slice 1 specifies then passes: the signature and request bytes match, the nonce is new, the approval ordering passes, the confirmation is signed and the expiry is still in the future. The 15-minute freshness rule is enforced only at apply, never at read.

**The fix.** The read path in we:scripts/lib/operator-override-store.mjs must never take freshness from an unsigned field of a log record. A record is applied only when the reader can prove, from signed or otherwise unforgeable data, that apply accepted it inside the 15-minute window. Two shapes to weigh while building: a host-side apply proof the agents' user cannot produce, or a read-time bound computed only from signed attestation fields (`approvedAt`) against the reader's own clock at first sight of the record.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/operator-override-store.test.mjs. Named tests, one per guarantee:
  - `a validly signed approval inserted directly into the log after its apply window is never applied` — the 10:00 / 10:30 / 10:05 scenario above: `readOperatorOverrides` does not return the entry, and the log keeps the record.
  - `a record whose unsigned time is changed after a normal apply is not applied` — editing the unsigned time of a valid record makes it invalid, never fresher.
  - `a normal apply inside the 15-minute window is still applied` — the fix does not refuse the legitimate path.

## Non-goals

- [N1] Does not change the approval workflow, the signing key or the attestation fields beyond what the read-time proof needs.
- [N2] Does not cover the other slice 1 read guarantees, which slice 1 already specifies and tests.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text input; records are still parsed as strict JSON by slice 1.
2. **Truncated reads** — a record whose freshness proof is missing or fails to parse is not applied, and an unparseable log still makes the whole layer unreadable (slice 1).
3. **Shared state files** — the agent can write the log and snapshot directly; nothing the reader trusts for freshness may come from those unsigned bytes.
4. **Fail closed** — no valid freshness proof means the record is not applied.
5. **Identity scoping** — n/a: actor and channel still come only from the attestation (slice 1).
6. **State over time** — freshness is judged from signed data and the reader's clock, never from a record time an agent can set.
7. **Who wrote it** — the record keeps the attestation and its freshness proof, so the log shows which apply accepted it.
