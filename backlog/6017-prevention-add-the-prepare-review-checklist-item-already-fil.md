---
bornAs: xx2nxas
kind: story
size: 3
status: open
scope: ["we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add the prepare-review checklist item already filed in #5989: every ran:false or error return mus… (from web-everything/web-everything#5026 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#5026's review (reviewed head `4c0325e050fa88f39dd9768a20ca900723a98b3d`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md` — Add the prepare-review checklist item already filed in #5989: every `ran:false` or error return must name its consumer and a behavioural end-state test in that consumer's own test file.
2. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md` — Add a check or card-lint rule: every new env knob named in a Design section needs a Test plan entry that names the resolver.
3. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md` — Extend the prepare-review lens in #5989 to require that each edge-case line carrying an absolute claim (never, always, fenced) names a test.
4. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md:47` — Add a deterministic clock-driven regression covering omitted, zero, positive, and invalid configuration, and verify that replacing the resolver with the old lease default makes the named test fail.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
