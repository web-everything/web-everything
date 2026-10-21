---
bornAs: xhh8ph0
kind: decision
size: 5
status: open
scope: ["we:scripts/operations/extend-rounds.mjs", "we:scripts/lib/red-team-gate.mjs", "we:scripts/conveyor/advisory-label-sweep.mjs", "we:docs/agent/platform-decisions.md"]
dateOpened: "2026-10-21"
tags: ["review", "red-team", "round-cap", "judge"]
---

# Decision: AI round judge replaces fixed round caps (progress-based grants, auto card/send-back/split, human only when needed)

Replace fixed round caps with an AI judge that grants rounds on progress, sends back or cards by existing policy, and escalates to a human only when needed. See we:scripts/operations/extend-rounds.mjs and we:scripts/lib/red-team-gate.mjs.


## Problem

Fixed round caps stall PRs that are making progress and keep PRs that are not.

- #5701 burned 7 rounds on the renumber loop while each round was still shrinking the findings.
- #5769 and #5530 sat at the red-team round cap overnight with no human awake to extend them.
- #5784 missed the same 3 findings 3 times in a row. The cap did not stop it; the count alone cannot tell "stuck" from "converging".

The number of rounds is the wrong signal. Progress is the right one.

## Proposal

A judge compares round N to round N-1 and looks at: findings shrinking, changing or repeating; the same lines re-raised; diff growth; edge-case drift (new findings that are variations of old ones). It outputs exactly one of:

1. **grant**: more rounds, because findings are shrinking or genuinely new and the diff is not growing.
2. **send-back** (the default when unsure): ask the author to change something, not block on a human.
3. **card-the-rest**: file the remaining findings by the EXISTING policy, the `redTeam.confirmedBreaks` card-vs-sendBack sorting in `we:scripts/lib/red-team-gate.mjs` and the review stringency classes (decision card 6239). No new taste is invented here.
4. **suggest-split**: the PR is too big to converge; propose the split.
5. **escalate to human**, ONLY when: the same finding returns unfixed after a send-back more than once; a guard or gate file is touched; or the judge is unsure about a guard.

Principle: asking for changes is better than blocking on a human call. If a strategy for what is a card and what is not already exists, the judge applies it and the human is rarely reached.

Fixed safety rails:

- Fail closed: if the judge did not run or its output is malformed, there is no grant.
- Every decision is logged with its reasons and the round-over-round evidence.
- A high hard ceiling stays as a backstop, so a fooled judge cannot loop forever.

Related: `we:scripts/operations/extend-rounds.mjs` and `we:scripts/operations/extend-rounds-io.mjs` (today's manual grant), `we:scripts/lib/red-team-gate.mjs`, `we:scripts/conveyor/advisory-label-sweep.mjs` (regate after a grant), decision card 6239 (stringency), standing ruling issue #5751.

## Open questions (to prepare, not resolve here)

1. **Card rulings by the judge.** May the judge record card rulings itself? Lean: yes for coverage-class findings only; never for confirmed correctness or security breaks.
2. **Split.** Should the judge only suggest a split, or file the split cards itself? Lean: suggest first.
3. **Ceiling value.** What hard ceiling of rounds? Needs data from past PRs.
4. **Model and check.** Which model runs the judge, and does a Codex check review the judge's calls? Per routing rules, Sonnet is the default.
5. **Composition.** How does this compose with the standing ruling (issue #5751) automatic +1 round and with `extend-rounds`? Does the judge replace, wrap or feed them?

## Acceptance

- [A1] **Executable** — run the read-only command below from the WE repo root. It exits 1 before preparation and 0 once `preparedDate` is set and all five questions above have prepared forks. Preparation must give each question a `## Fork N` section (N = 1–5, matching the question numbers), with nonempty `Options:` and `Tradeoffs:` lines and a `Default: **recommended option**` line. Review the substance of those options and tradeoffs during /prepare; this command checks their presence.

  ```sh
  node --input-type=commonjs <<'NODE'
  const { readFileSync } = require('node:fs');
  const assert = require('node:assert/strict');
  const matter = require('gray-matter');
  const { data, content } = matter(readFileSync('backlog/6753-decision-ai-round-judge-replaces-fixed-round-caps-progress-b.md', 'utf8'));
  assert.ok(data.preparedDate && String(data.preparedDate).trim(), 'preparedDate must be set');
  const body = content.replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm, '');
  for (let n = 1; n <= 5; n++) {
    const sections = [...body.matchAll(/^## Fork (\d+)\b[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].filter(m => Number(m[1]) === n);
    assert.equal(sections.length, 1, `question ${n}: expected one Fork section`);
    const fork = sections[0][2];
    for (const label of ['Options', 'Tradeoffs'])
      assert.match(fork, new RegExp(`^${label}:[ \\t]*\\S[^\\n]*$`, 'm'), `question ${n}: missing ${label}`);
    assert.match(fork, /^Default:[ \t]*\*\*[^*\n]*\S[^*\n]*\*\*[ \t]*$/m, `question ${n}: missing bold default`);
  }
  console.log('PASS: preparedDate and all five prepared forks present');
  NODE
  ```

- [A2] **Executable** — the ruling, once made, is codified in `we:docs/agent/platform-decisions.md` and `codifiedIn` is set on this card.
- [A3] **Must** — the ruling states what happens when the judge fails, times out or returns malformed output (answer: no grant, round state unchanged, logged).
- [A4] **Must** — the ruling states which finding classes the judge may never card or grant over (confirmed correctness and security breaks, guard and gate files).
- [A5] **Must** — the ruling names the evidence the shadow story (child of this card) must show before any action is enabled.

## Non-goals

- [N1] No code, no judge, no change to caps in this card. It records the decision only.
- [N2] Does not invent a new card-vs-send-back policy. It reuses `redTeam.confirmedBreaks` and the stringency classes.
- [N3] Does not remove the human path. It narrows it to the escalation cases.
- [N4] Does not change review stringency levels (decision card 6239).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the judge reads PR titles, diffs and reviewer findings, all untrusted. The ruling must require the input to be passed as quoted data, never as instructions, and the output as a closed schema (one of five verdicts plus reasons).
2. **Truncated reads** — a truncated diff or findings list must not look like "findings shrank". Truncated input means no grant and send-back.
3. **Shared state files** — grants and logs are written by several runners. The ruling must require one writer path with atomic appends, as `we:scripts/operations/extend-rounds-io.mjs` does today.
4. **Fail closed** — judge did not run, errored or timed out: no grant. A missing round N-1 record: no grant.
5. **Identity scoping** — each decision binds to repository, PR number, head SHA and round number; a grant for one head must not apply after a force-push or new head.
6. **State over time** — a stale judgment on an old head is void. The hard ceiling counts across the whole PR life and resets only by operator action.
7. **Who wrote it** — a PR author (agent or human) must not be able to steer the judge through PR text or by editing the judge's logs. Guard and gate file edits always escalate.
