---
name: converge
description: Run the REAL bounded editor↔reviewer convergence loop on working-tree work in a lane clone — before any PR exists. A multi-lens panel judges the lane's diff, an editor fixes or dismisses each finding, a red-team tries to break the accept, and the panel re-judges, until it converges or hits the round cap. Use when the user wants to "converge" the current work, "review and fix until it's clean", "run the convergence loop on this lane", or when a delivery agent needs its converge-before-PR pass. ADVISORY — it reports a verdict and never opens, labels, or lands a PR. NOT for a parked PR (that is `/drain`), NOT for the interactive human verdict on one (that is `/review`), and NOT for a judge-only opinion with no fixes (that is `/jury`).
---

# /converge — converge working-tree work before a PR exists

The convergence loop — panel judges → editor revises → red-team ratifies → panel re-judges, bounded by a round
cap — used to exist only for PRs the drain had already parked. Everything upstream of that ran on **prose**: the
conveyor's delivery-agent brief tells an agent to "address every finding to convergence", with no round cap, no
panel reduction, and no ledger. This skill gives that step the real loop.

**The improvement is boundedness, not enforcement.** `/converge` reports a verdict. It does **not** gate opening
a PR, and it never commits, pushes, labels, or merges. Whether the work ships stays the human's call.

## What this skill owns — and what it must never re-decide

It owns **driving**: run a command, spawn the agents an action calls for, feed the results back. That is all.

Every decision is a pure derivation it shells for and obeys:

- **The loop's control flow** — [we:scripts/lib/converge-core.mjs](../../../scripts/lib/converge-core.mjs):
  `convergeStep` (what happens next), `deriveRoundObservations` (what actually happened), the grow-only roster
  union, the pre-land red-team, the fail-closed degradations. Unit-tested in
  [we:scripts/lib/\_\_tests\_\_/converge-core.test.mjs](../../../scripts/lib/__tests__/converge-core.test.mjs).
- **The judging** — [we:scripts/lib/jury-core.mjs](../../../scripts/lib/jury-core.mjs): who is on the panel, how
  many jurors a care band earns, which lenses are mandatory, how verdicts reduce, the round cap.
- **Where material comes from and where revisions go** —
  [we:scripts/lib/converge-transports.mjs](../../../scripts/lib/converge-transports.mjs).

**Never** re-derive any of it in this skill. If you find yourself deciding whether to run another round, stop —
that is `convergeStep`'s call, and hand-deciding it is exactly the prose-loop failure this skill exists to fix.

## Run it

Everything goes through [we:scripts/converge-cli.mjs](../../../scripts/converge-cli.mjs). Keep the state file for
the whole run — it carries the round counter and the roster.

### 1. Seed the run

```bash
STATE=$(mktemp -t converge)   # keep this path for every later call
node scripts/converge-cli.mjs init --lane="$LANE" --state="$STATE" --care=elevated \
  --goal="what this lane's work is trying to do"
```

`--lane` must be the **absolute root of a lane clone** (`…/.lanes/<repo>/lane-N`). The CLI proves it: a relative
path, a subdirectory, a non-repo, or a shared primary checkout all exit 2. `/converge` never reads or writes a
primary tree — if you are not in a lane, provision one (`node scripts/lane-pool.mjs status --json`) first.

`--care` dials the jury size and the round cap through `panelRigorForCareLevel` — never hand-tune either.
`--jurors` / `--round-cap` can only **raise** rigor above the band, never lower it, and any override is recorded
in the run's `dialOverrides` so a hand-tuned run cannot report itself as a plain band run.

> **Pick the care level deliberately.** Working-tree material has no escalation reasons, so nothing derives care
> for you. The default is `elevated` (the weakest band at which an editor round can happen at all — `low` caps
> the run at one round, so the first finding escalates before the editor ever runs). Use `high` for anything
> touching a trust boundary, a gate, a contract, or a shared derivation. (Deriving care from the touch-set is an
> open backlog item, not yet built — [#2954](../../../backlog/2954-derive-the-care-level-for-working-tree-convergence-from-the-.md).)

> **State the `--goal`.** Without it a juror judges the work against an implicit ideal, which is what produces
> findings that are true, unhelpful and expensive. With it, every round's mandate names what the work is FOR, and
> jurors judge against that plus the base the lane started from. One sentence from the backlog item's lead
> paragraph is enough. Omitting it is allowed and changes nothing about how the loop runs — it just costs you the
> cheapest accuracy available (#2950).

### 2. Loop until the action is `land` or `escalate`

`init` and every `step` print an `action` **and a `round`**. Do exactly what it says, then step again with what
happened — **stamped with the `round` the CLI just printed**.

| action | what you do | what you feed back |
|---|---|---|
| `read` | run the printed `read.command` | `{"round": N, "readResult": {"material": "<the diff>"}}` |
| `panel` | seat ONE juror per printed lens (× `jurors`) **through `judgePanel`, never the `Agent` tool** (see *Seating a juror* below), each carrying that lens's `mandate` **verbatim** | `{"round": N, "lensResults": [{"lens": …, "ok": true, "findings": […]}], "invites": […]}` |
| `edit` | spawn ONE editor subagent with the printed `edit.prompt` — the one spawn here that stays a subagent (see *Seating a juror* below) | `{"round": N, "lensResults": …, "editResult": {"advanced": true, "dismissed": […]}}` |
| `red-team` | seat one adversary per entry in `redTeam.jury` the same way as `panel`, each with its `prompt` as the mandate; union their findings | `{"round": N, "lensResults": …, "redTeamResult": {"ran": true, "findings": […]}}` |
| `invite` | shell `review-core-cli invite` for the growth delta | `{"round": N, "invite": …, "inviteEcho": <what it returned, `null` if it crashed>}` |
| `land` | done — report the verdict | — |
| `escalate` | done — report the escalation packet | — |

```bash
cat > "$OBS" <<'JSON'
{ "round": 1, "readResult": { "material": "…" } }
JSON
node scripts/converge-cli.mjs step --state="$STATE" --obs="$OBS"
```

**Observations travel as a FILE, never through a shell variable.** `--obs=<file>` is the only route the CLI
accepts, on purpose: assembling a multi-thousand-line diff into `"$VAR"` evaluates `$(…)` and backticks *inside
the diff* before the JSON ever reaches Node, and diffs routinely contain shell snippets. Write the JSON with a
quoted heredoc (`<<'JSON'`) or a file-write tool — never `echo "$VAR" |`.

**Stamp every step with the printed `round`.** This is the one field you must always send. Observations for the
wrong round are refused (`reason: stale-observations`), which is what stops a driver that keeps appending to one
growing blob from re-sending a stale panel and burning the whole budget with no second panel.

`readResult` and `findings` are **carried forward within a round** by the state file, so you only re-send them
when they CHANGE. The carry is stamped with the round it was captured in and invalidated the moment the round
advances — so a step whose read genuinely failed still reports a failed read.

**Report `inviteEcho: null` if the invite agent crashed** — the field's PRESENCE (not its truthiness) is what
selects the invite branch, and a rejected/crashed invite falls through to an editor round on the same round.

### 2b. Seating a juror — `judgePanel`, never the `Agent` tool (#3145)

The `panel` and `red-team` actions are **judgments**, and the whole point of the invariants below is that the
actor judging is not the actor that authored. A subagent cannot give you that: it inherits this session's
`CLAUDE_CODE_SESSION_ID`, the identity `we:scripts/lib/review-independence.mjs` keys independence on, so a
panel of subagents is one actor wearing N hats — the exact defect `/jury` shipped with and #3057 removed.
Seat them through `judgePanel` instead, via the shim (payload shape and honest limits in
[delivery-loop.md](../../docs/agent/delivery-loop.md#independent-judgment-spawn)):

```bash
# $MATERIAL ← the diff you already have in readResult.material, written to a file (never a shell variable).
# $PAYLOAD  ← { subject: "pr-diff", subjectNoun: "diff", round: N, materialFile: "$MATERIAL",
#               jurors: [ { id: "<lens>#<slot>", lens: "<printed lens>",
#                           mandate: "<that lens's printed `mandate`, VERBATIM>" },
#                         … one entry per lens per juror slot … ] }
node skills-src/jury/panel-fanout.mjs --payload-file="$PAYLOAD" \
  --depth=0 --max-depth=2 --max-total-budget-usd=8 --run-id="converge-<lane>-r<N>"
```

Three things to get right, each of which is a real property and not a formality:

- **A new `--run-id` for every round, and a distinct one for the red-team** (`…-r<N>` / `…-r<N>-redteam`). A
  seat's session id is derived from `runId` + `lens#slot`, so reusing a run id across rounds mints the same
  actor to re-judge material it already judged — and gives the red-team the identity of the panel juror it is
  supposed to be able to contradict.
- **Give every juror an explicit `id` and map seats back by it, not by position.** Write `<lens>#<slot>` —
  the same convention `materializeRoster` uses — so two seats on ONE lens (care `high` gives `jurors: 2`)
  stay distinct actors rather than collapsing onto one derived session id. Omitting `id` is not fatal (the
  shim slots by lens order and mints the same string), but the red-team's jury comes from `redTeam.jury`
  rather than the lens list, so writing the id yourself is the only way its seats line up with what you fed
  back. Each seat returns `{ id, lens, sessionId, ok, findings, … }`; build `lensResults` from those. A seat
  with `ok: false` is a lens that **did not run** — report it as `ok: false` and let the core degrade the
  round. Never fill a crashed seat's findings with `[]`, which reads as a clean lens.
- **Pass the printed `mandate` verbatim.** The diff is fenced inside it *and* travels on the juror's stdin as
  `materialFile`; that redundancy is fine and is not a licence to trim the mandate.

**The `edit` action is the one spawn that stays a subagent, deliberately.** An editor *authors*, and
independence is a property of the judge — `judgePanel` seats are tool-free and answer a forced findings
schema, so there is no editor for them to be. More concretely, `judgeSpawn` grants tools only against a lane
clone that is **not the driver's own** (`assertLaneCwd`), and this loop's editor exists to edit precisely the
driver's lane, so it structurally cannot be a tool-bearing juror. What the *"the panel never authors what it
judges"* invariant needs is that the editor is not one of the actors that judged — and once the jurors are
headless with their own ids, that holds by construction. Giving the editor its own headless spawn is tracked
separately as
[#xl5jroq](../../backlog/xl5jroq-give-the-revision-round-editor-its-own-tool-bearing-headless.md).

### 3. Report

On `land`: the verdict, the per-lens table, how many rounds it took, the red-team result, and every dismissed
finding with its stated reason (the CLI prints them in `dismissed` on every action). On `escalate`: the printed
`escalation` packet — the reason, the round history, and the findings that survived. Say plainly which one
happened; a `land` here means a non-author panel accepted the final diff **and** an independent red-team failed
to break it, and an `escalate` means it did not.

## The invariants you are not allowed to soften

These are enforced in the tested core, so you cannot break them by accident — but do not paper over them in how
you report, either.

- **A reviewer that did not run never reads as accept.** If a mandatory lens (`correctness` / `security`) crashes
  or was never scheduled, the round degrades to `needs-human` and escalates. No round budget saves it.
- **An accept is not a land until a red-team fails to break it (#2707).** An unrun red-team never ratifies.
- **A failed read escalates.** No material means nothing was judged. An *empty* read is reported separately as
  `nothing-to-review` — the read worked, there was simply nothing there.
- **The round cap is real.** It comes from `deriveNegotiationOutcome`, not from anything an agent returned.
- **An editor that could not advance the work escalates.** Re-judging identical material just replays the verdict.
- **Every finding is fixed or dismissed with a stated reason.** Silence is a stall, not an acceptance.
- **The panel never authors what it judges.** The editor writes; the NEXT round's fresh reviewers judge, and a
  red-team that never saw their reasoning ratifies. Never let one agent do both. Since #3145 this is backed by
  identity rather than by prose: jurors are headless processes with pairwise-distinct session ids, so a juror
  is provably not the editor and provably not its own sibling — see *Seating a juror* above.
- **The loop never touches git state.** The read is `git diff` + `git diff --no-index` only — nothing is staged,
  stashed, committed or checked out, in the lane or anywhere else.

## Boundary

`/converge` applies no label, posts no comment, opens no PR, and merges nothing. It does not commit or push —
the editor is explicitly told not to. Landing a PR is [`/drain`](../drain/SKILL.md); the human verdict on a
parked PR is [`/review`](../review/SKILL.md); a judge-only opinion with no fixes is [`/jury`](../jury/SKILL.md).
