---
kind: story
size: 3
status: open
scope: ["we:backlog/4456-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a prepare-gate check: for each 'Remaining gap' or 'not enforced' claim, require the card to c… (from web-everything/web-everything#4541 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4541's review (reviewed head `5ca54428c4ffd9407de9d0f38f3e4f7bad4389e5`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:backlog/4456-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:28` — Add a prepare-gate check: for each 'Remaining gap' or 'not enforced' claim, require the card to cite a repo-wide grep of the invariant's message text or keywords. A lint could flag a card whose scope lacks any file that already contains the guarded error string.
2. `we:backlog/4456-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:29` — Add a prepare checklist item, enforced by a card-lint on 'Corrected premise' sections: any new check:standards error must state its expected corpus violation count from a dry run, and any prior 'deliberately not enforced' comment must be cited. File a backlog item to require a dry-run corpus count on cards that add a gate error.
3. `we:backlog/4456-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:50` — Have the prepare gate run the proposed rejection predicate over backlog/*.md (a grep for `^workItem:` is enough) and record the offender list in the card. Not captured as a gate; file it.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
