---
bornAs: xn9zuyc
kind: story
size: 5
status: open
scope: ["we:scripts/lib/red-team-gate.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Red-team gate: sign the gate's own decision records so automation can't forge sent-back/card-queued releases

PR #5788 limits release of a held break to human operator-* records, and the operatorRuled fix counts only human logins for clear-human. One gap remains: the gate's own records (outcome=sent-back, card-queued and their action lines) are posted by the automation account, so any process holding its credentials could forge one and release a hold. Sign each record so unsigned or invalid ones are ignored.

Proposal: the gate signs each record (HMAC over pr/head/result/outcome with a key only the gate's runner holds, or a detached signature verified by `readRedTeamDisposition`). Unsigned or invalid automation records are ignored. Key rotation and a missing key fail closed (the PR stays held).

Links: PR #5788 (operator-* records only human may release); identity helper `we:scripts/lib/operator-identity.mjs`; operatorRuled fix (lane-43 commits 0289eec30, de31d5b8b). Gate code: `we:scripts/lib/red-team-gate.mjs`.

## Acceptance

- [A1] **Executable** — a reader test for `readRedTeamDisposition` fails before and passes after: a forged unsigned `card-queued` record (and its action line) leaves the PR held, and a gate-signed record releases it.
- [A2] **Executable** — a drain-queue-safety test fails before and passes after: a forged unsigned or bad-signature `sent-back` / `card-queued` record posted by the automation account does not release a hold; a valid gate-signed one does.
- [A3] **Fail closed** — a missing key, an unknown key id, or a signature over different pr/head/result/outcome values keeps the PR held. Key rotation keeps old signatures valid only for the declared rotation window; outside it they are ignored.

## Non-goals

- [N1] Does not change the human operator-* release path from PR #5788 or the operatorRuled / clear-human login rule.
- [N2] Does not defend against an attacker who holds the gate runner's signing key; only against holders of the automation account's GitHub credentials alone.
- [N3] Does not design a general signing scheme for other bot comments.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the record body is untrusted; the signature is parsed from a fixed field and compared in constant time; extra or duplicate signature fields invalidate the record.
2. **Truncated reads** — a truncated comment or missing signature field is treated as unsigned and ignored.
3. **Shared state files** — the key is read from the runner's own secret store, never from a shared state file or a comment; the key is never logged.
4. **Fail closed** — missing key, unreadable key, bad or unsigned record: stay held.
5. **Identity scoping** — the signature binds pr number and head sha, so a signed record cannot be replayed onto another PR or a newer head.
6. **State over time** — a new head invalidates older signed records; rotation is handled with a key id and a bounded overlap window.
7. **Who wrote it** — the signature, not the author login, proves the gate wrote it; records from the automation account without a valid signature are ignored.
