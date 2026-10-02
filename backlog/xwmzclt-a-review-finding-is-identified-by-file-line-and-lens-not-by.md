---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs"]
dateOpened: "2026-10-02"
tags: []
---

# A review finding is identified by file, line and lens, not by its wording, so a rephrased claim reuses its ruling

Live case 2026-10-02: after the ruling-carry fix (#3507), the human approval of #3432 was still refused because the Gemini seat reworded the same false claim (an "undeclared required" at we:scripts/operations/pr-status.mjs:179) in every run; referral keys include the summary text, so five wordings needed five rulings, and two rounds ruled the one real finding differently, leaving it pending. Fix in we:scripts/lib/jury-core.mjs: the referral key is the finding identity (seat lens, file, line or nearest symbol), with the wording kept only as evidence; a ruling on that identity covers rewordings on the same head; conflicting rulings on one identity escalate once instead of staying pending forever. Replay #3432.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
