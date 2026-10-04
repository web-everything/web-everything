---
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Urgent overlay bypasses the 600s restart gate

Live 2026-10-03/04: after a clone adopts new code, we:scripts/lib/daemon-self-sync.mjs defers the restart 'until this process has run 600s (#4044 restart gate)'. The #3887 and #3889 fixes took 10+ extra minutes to take effect. Fix: a flag on an overlay (e.g. --urgent) makes the daemon restart at its next pass boundary instead of waiting out the gate. Related to #3867 (faster edge adoption); cite it and keep the two consistent. Done when: (1) an overlay added with --urgent triggers a restart at the next pass boundary; (2) non-urgent overlays still honour the 600s gate (#4044); (3) the restart log says it was urgent and names the overlay; (4) tests cover both paths; (5) the card cites #3867.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
