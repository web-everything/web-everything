---
bornAs: xfgjg25
kind: story
status: open
size: 3
scope: ["we:scripts/lane-git-diet.mjs", "we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs"]
dateOpened: "2026-10-23"
tags: [prevention, security, git]
---

# Confirm borrower scan coverage before lane Git pruning

Make the borrower discovery boundary explicit before destructive lane cleanup. The security panel on PR #5806 accepted filing this prevention debt: repositories outside the scanned workspace, temporary directory and lane pools can borrow lane objects through alternates and remain invisible to the prune guard.

Source: web-everything/web-everything#5806, advisory review posted 2026-10-24T00:54:30Z, head `4a5ee48414889ace5d987b240b601ec1734aafa3`, security/data-safety finding at `we:scripts/lane-git-diet.mjs:78`. The review marks the risk PLAUSIBLE with unrecoverable impact; it does not report a reproduced loss. This card records prevention work, not an implementation fix or a human review verdict.

Idempotency key (do not edit): advisory-prevention-key:web-everything/web-everything#5806@4a5ee48414889ace5d987b240b601ec1734aafa3:security-borrower-roots

## Requested change

Show the scanned roots on apply and require explicit confirmation of the scan boundary, or add a documented, tested `--extra-scan-root` option as proposed by the reviewer. Explain that repositories outside those roots remain undiscoverable; no finite configured scan establishes absence of borrowers everywhere. Preserve the explicit lane list and every existing eligibility refusal.

## Acceptance

- [A1] **Executable** — Extend `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs` with a real borrower under a separate projects root outside the default candidates. With that root included, apply skips the lane before deleting its refs or objects; the borrower can still read its borrowed old object. Run that test file through `npm run test:unit --` and show the new case red before implementation and green after it.
- [A2] **Executable** — In the same suite, pin the selected interface: confirmation mode refuses unconfirmed apply before any lane write and prints the actual roots; extra-root mode documents the option and discovers borrowers through it. Cover a path containing spaces and a symlink alias without splitting or trimming path bytes.
- [A3] **Executable** — All borrower scans, including the rescan before repack and the final rescan before prune, use the same configured roots. A borrower appearing in an added root after startup prevents prune and retains its old borrowed object.
- [A4] **Executable** — A supplied root that is missing, unreadable or not a directory refuses cleanup with a useful diagnostic; it never becomes an empty successful scan. Test refusal before config/ref writes, and before prune when a root becomes unreadable mid-run.

## Non-goals

- [N1] Do not recursively search the whole filesystem or claim protection for unscanned repositories.
- [N2] Do not change lease ownership, retention windows, inherited Git environment hardening, or review labels.

## Edge cases

- Untrusted text: treat root paths as argv data; preserve spaces, quotes, Unicode and line endings without shell interpolation.
- Truncated reads and resource bounds: retain the bounded alternate graph and refuse incomplete discovery; do not silently truncate candidate roots.
- Shared state and state over time: retain scans under the claim and immediately before prune; test borrowers appearing after startup.
- Fail closed: unreadable explicit roots are errors, never proof of no borrowers.
- Identity scoping: canonicalize root aliases and object stores while retaining the identity of the borrowing repository.
- Who wrote it: scan configuration comes from explicit operator flags; inherited test seam variables do not authorize production writes.
