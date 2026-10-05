---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xbhnqel-prevention-use-number-isfinite-d-gettime-after-constructing.md"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Have the prevention filer check that each repo:path reference exists in the named repo, and deriv… (from web-everything/web-everything#4020 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xbhnqel-prevention-use-number-isfinite-d-gettime-after-constructing.md:7` — Have the prevention filer check that each `<repo>:<path>` reference exists in the named repo, and derive the repo prefix from the origin PR's repo. Fail or rewrite the entry if the path is absent. This is a deterministic gate in the filer.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4020@a77b1f00530ea17fe5d48b9d99f0d0fd29c00c2d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
