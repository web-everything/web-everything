---
bornAs: xkv3334
kind: story
size: 3
parent: "5407"
status: open
dateOpened: "2026-10-08"
tags: []
---

# Research a signed provenance attestation for AI-authored changes

Source: AI Delivery Landscape research brief, 2026-10-08, section 'Thirteen gaps' item 9 (the one gap with no working start in the prototype) and the provenance row of 'The standards stack'. Wanted: a signed record that agent X wrote a change under these instructions and reviewer Y approved it. Survey in-toto/SLSA v1.2 (Level 4 needs two-party review and assumes humans), Sigstore, Agent Trace draft 0.1 (line attribution only), the kernel Assisted-by trailer and Amp's signed commits with linked transcripts. Output: a research note recommending whether the delivery standard defines an in-toto predicate, reuses one, or binds to Agent Trace, and what the existing review record already supplies. Research only; no code.

## Done when

1. **Executable** — n/a: research only. Tier 3 instead: a research note (a /research/ topic or report) is published and linked from this card, with a recommendation the parent epic can slice from.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: research only; no code ships.
2. **Truncated reads** — n/a: research only; no code ships.
3. **Shared state files** — n/a: research only; no code ships.
4. **Fail closed** — n/a: research only; no code ships.
5. **Identity scoping** — n/a: research only; no code ships.
6. **State over time** — n/a: research only; no code ships.
7. **Who wrote it** — n/a: research only; no code ships.
