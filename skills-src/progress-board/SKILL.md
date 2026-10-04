---
name: progress-board
description: Refresh and re-publish the operator's progress board — the fixed-path Artifact page showing the current plan and where it stands. Use whenever a plan item starts, finishes, gets blocked or unblocked, after a PR lands, or after a review verdict — and when the user asks to "update the board", "refresh the progress board", "show me where the plan is", or runs /board. Costs one Bash call plus one Artifact call; NEVER hand-edit the page or its state file. Not a timer job — run it on state change only.
---

# Progress board — refresh the operator's status page

One page, one URL, refreshed mechanically. **You never see or write the page's markup.** A generator owns
every byte of it; your whole job is one CLI verb and one re-publish.

## 🛑 NEVER publish a page you wrote yourself

**The generator is the only thing allowed to produce the board.** There is exactly one template, it lives in
`we:scripts/progress-board.mjs`, and there is deliberately no example page anywhere to copy.

If you are ever tempted — the operator is blocked, the script is inconvenient, "just this once" — **do not.**
This is the failure that has already happened, so it is worth being blunt about why:

1. **A hand-written page silently drops the fields that make it usable.** The script refuses to render a
   decision without a question, two or more options with one recommended, and what breaks if nothing is done.
   You will not refuse yourself. The operator gets a thinner page and cannot tell.
2. **It gets overwritten by the next real run anyway.** The work is wasted, and until then the record is
   inconsistent — the page says one thing, `we:reports/progress-board.json` says another.
3. **An accidental one is detectable.** Every generated page carries a provenance marker whose fingerprint
   covers the marker's own fields and the body, so an edited page or a copied marker is caught.

**Publish only what the generator just wrote — the `✓` line from THIS turn's run is the only real proof.**

### What `--verify` is worth, exactly

If you are not certain the file at that path came from this turn's run, check it — one Bash call, one line:

```bash
node scripts/progress-board.mjs --verify=reports/progress-board.html
```

The two directions are **not** equally strong, and the wording says so:

- **Exit 1 (`is NOT the generated board`) is conclusive.** No marker, a copied marker, an edited body, a
  rewritten `at=` or `decisions=` — **do not publish**; re-run the generator.
- **Exit 0 (`marker and body agree`) is a tripwire, NOT an authorisation.** The digest is **unkeyed** and its
  algorithm lives in `we:scripts/progress-board.mjs` — the very file you may have just been told to read. Any
  page whose author recomputes the marker verifies. So exit 0 rules out an *accident* (a stray edit, a marker
  pasted onto other content); it **cannot** tell you the generator wrote the file.

This cannot be fixed by a stronger hash. A keyed digest needs a secret, and the board is a public,
self-contained page in a public repository — any key shipped with it is not a key. **The rule above is the
protection; `--verify` only catches the honest mistakes.**

And if the board *cannot* render, the fix is to give the generator what it is asking for — it names the id
and the missing field — never to route around it.

## The cost contract (this is the point of the skill)

**One update = one `Bash` call + one `Artifact` call.** Nothing else.

- Do **not** read `we:reports/progress-board.html`. It is generated output; reading it burns thousands of
  tokens and teaches you nothing the CLI does not already print.
- Do **not** hand-edit `we:reports/progress-board.json` with Edit/Write. Every field it holds has a verb —
  including `items[].pr`, `phases`, `title` and `repo`, and including removing and retitling a row (see the
  verb list below). A hand edit is how the mechanical property dies.
- Do **not** re-derive pull-request state in context. The generator reads it live from `gh` on every render.
- Do **not** write the page yourself. See above.

## WHEN to run it

On a **state change**, never on a timer:

- a plan item **starts** → `--start=<id>`
- a plan item **finishes** → `--done=<id>`
- a plan item **gets blocked** → `--block=<id> --why="…"`; **unblocked** → `--start=<id>` (it clears the blocker)
- **after a PR lands** → plain re-render (PR state is derived; nothing to type)
- **after a review verdict** → plain re-render, plus `--done=<id>` if that closed the item
- the operator **takes a decision** → `--decide=<id>`; **rules it but defers the work** → `--decision-set=<id> --field=status --value=queued`
  - `<id>` is **either handle**: the ruling number they quoted (`--decide=R6`) or the id it is filed under
    (`--decide=2978`). When they reply "R6 — as recommended", `--decide=R6` is the whole translation.
- a **new decision** surfaces → `--decision-add=…` plus the context verbs below
- new work joins the plan → `--add="<title>" --phase=<n>`

If nothing changed, do not run it. A re-render with no change is a wasted publish.

## HOW — step 1, the Bash call

```bash
node scripts/progress-board.mjs                          # re-render from live state
node scripts/progress-board.mjs --start=<id>
node scripts/progress-board.mjs --done=<id>
node scripts/progress-board.mjs --block=<id> --why="waiting on the #2832 gate fix"
node scripts/progress-board.mjs --note=<id> --text="rebased onto main"      # empty --text clears it
node scripts/progress-board.mjs --add="Ship the drain rewrite" --phase=2
node scripts/progress-board.mjs --decide=2978
```

Every other field the state file holds has a verb too — there is no field left that needs a hand edit:

```bash
node scripts/progress-board.mjs --link=<id> --pr=1101      # the JOIN to the live half; --unlink=<id> removes it
node scripts/progress-board.mjs --retitle=<id> --to="Corrected title"   # the id never moves — it is the key
node scripts/progress-board.mjs --rephase=<id> --phase=3   # move an existing row between phases
node scripts/progress-board.mjs --remove=<id>              # drop a plan row (a typo'd title, a dropped item)
node scripts/progress-board.mjs --phase-title=2 --to="Merge-gate correctness"   # empty --to clears it
node scripts/progress-board.mjs --board-title="Progress board"
node scripts/progress-board.mjs --repo=web-everything/web-everything   # what `gh pr list --repo` is given
node scripts/progress-board.mjs --decision-remove=<id>     # its R-number retires and is never reissued
node scripts/progress-board.mjs --start=<id> --date=2026-08-01   # correct a date the board stamped for you
```

The three dates the board sets for you — `startedAt`, `doneAt`, `takenAt` — are stamped **once**, at the
first transition, so a `--done` on an item that was never `--start`ed pins both to the same day. `--date` on
`--start`, `--done` or `--decide` corrects them. The only fields with no verb are `ruling` and `nextRuling`,
which are the board's to assign and yours never to touch.

`--url` is the one verb with a guard on top: it takes a real `https://…` value and **refuses to replace a
URL that is already stored** unless you add `--force`. A minted duplicate cannot be undone, so replacing the
stored one is a deliberate act, never a typo.

### Decisions carry the whole case — and the tool enforces it

A decision is the **only thing on the page that asks the operator for something**, so the bar is: they can
**answer it from the page**, without opening a backlog file, a PR or a diff.

> **You cannot forget this and you cannot opt out of it.** The script refuses to mark a decision `awaiting`,
> and refuses to render a board that already carries one, unless it has a `question`, **at least two** real
> `options` with **exactly one** recommended, and `ifNothing`. A missing field exits **1** naming the id and
> the field. Nothing below is a convention to remember — it is the shape the CLI will accept.

Build one in the order the tool expects. It lands as a **draft** and only becomes an ask once it is complete:

```bash
node scripts/progress-board.mjs --decision-add="Fork B — rebuild or drop" \
      --question="Does the codification shortcut get one more attempt, or get dropped?" \
      --if-nothing="Fork A still ships; codification PRs keep needing a human."
node scripts/progress-board.mjs --decision-set=fork-b-rebuild-or-drop --field=why --value="Broken three times by three independent reviewers; each round closed one class and missed another."
node scripts/progress-board.mjs --decision-option=fork-b-rebuild-or-drop --label="One round rebuilt on markdown-it" --detail="already a dependency, so detection and rendering cannot disagree" --recommend
node scripts/progress-board.mjs --decision-option=fork-b-rebuild-or-drop --label="Drop Fork B now" --detail="the status quo; every codification PR then needs a human"
node scripts/progress-board.mjs --decision-evidence=fork-b-rebuild-or-drop --text="three breaks: mid-rule splice · untagged second heading · eight more forms"
node scripts/progress-board.mjs --decision-set=fork-b-rebuild-or-drop --field=status --value=awaiting   # now it asks
```

| Field | Verb | What it must say | Required to ask? |
| --- | --- | --- | --- |
| `question` | `--decision-add --question=…` | the call, in one line, ending in a question mark | **yes** |
| `options[]` | `--decision-option --label=… --detail=… [--recommend]` | the **real** options with their tradeoffs — never padded to three; two if it is binary. A second `--recommend` moves the mark rather than adding one | **yes — 2+, exactly one recommended** |
| ↳ correcting one | `--decision-option-remove --label=…` | labels match **exactly**, so re-wording an option adds a *second* row and the page then offers the same choice twice. Remove the superseded label — never hand-edit the state file. The removal is checked by the same enforcement, so it refuses to strand the decision below two options or with no recommendation | — |
| `ifNothing` | `--decision-add --if-nothing=…` | what breaks if the operator never answers | **yes** |
| `why` | `--decision-set --field=why` | why it is a **judgment call** and not mechanical | strongly encouraged |
| `evidence[]` | `--decision-evidence --text=…` | the grounding — a `file:line`, a count, a prior ruling | strongly encouraged |
| `detail` | `--decision-set --field=detail` | the fallback one-liner, for a `draft`/`queued`/`taken` entry with none of the above | no |

`--decision-set --field=status` moves it through the lifecycle: **`draft`** (being prepared — renders
low-emphasis below the plan, never in "needs you"; this is where an unfinished one waits), **`awaiting`**
(outstanding, and therefore complete — this is what "needs you" counts), **`queued`** (ruled but
deliberately deferred: its own *Ruled, queued* section, and it stops being an ask), **`taken`** (absorbed
into the plan; it leaves the board — `--decide=<id>` is the shorthand). Recording an already-ruled call takes
`--decision-add=… --status=queued`, which is exempt from the contract: it is a record of an answer, not a
question. An empty `--value=` / `--text=` clears, exactly like `--note`.

**If a run exits 1 with "cannot be answered from the page"**, the board is telling you a decision on it is
unanswerable. Fill the named gaps, or park it with `--field=status --value=draft`. The verb you just ran was
still saved, so you fix forward — you are never stuck.

### Ruling numbers — how the operator answers

Every decision gets an `R<n>` the moment it is created, from a counter in the state file. It is **identity,
not position**: never renumbered when the list changes, and **never reused** — a decision that is taken or
dropped retires its number with it, so `R2` can never later mean something else. The card shows both handles:
the **R-number to answer with**, prominently at the top, and the **item number it is filed under** at the
bottom, for the record.

So when the operator replies **"R6 — as recommended"**, that is unambiguous: `--decide=R6`.

Every verb re-renders the page and prints **one line**: what changed, where the page was written, the
counts, whether PR state is stale, and **the stored artifact URL**. That line is your whole read of the
result — nothing else needs opening. Verbs are idempotent; running one twice is safe.

The page is always written to the same fixed path: **`we:reports/progress-board.html`**.

## HOW — step 2, the Artifact call

Publish **only** a page the generator just wrote. The `✓` line from step 1 is that proof — if you have it,
publish; the budget stays at one Bash call plus one Artifact call.

If you do **not** have it — you did not run the generator this turn, or you are unsure what is at that path —
spend one extra Bash call before publishing rather than publishing blind. Read its exit code with the caveat
above in mind: a failure is conclusive, a pass only means the file has not been *accidentally* disturbed.

```bash
node scripts/progress-board.mjs --verify=reports/progress-board.html
```

> ### ⚠️ THE URL-STABILITY RULE — READ THIS BEFORE EVERY PUBLISH
>
> Re-publishing the same `file_path` keeps the URL **only inside the conversation that first published
> it**. From **any other session** — a new chat, a subagent, tomorrow — publishing without the stored URL
> **mints a brand-new URL and the operator's bookmark silently dies.**
>
> So: **read `artifactUrl` off the CLI's confirmation line, and pass it as the `url` parameter.** The URL
> lives in `we:reports/progress-board.json` precisely so a session that has never published this page can
> still find it.

```
Artifact(
  file_path: "reports/progress-board.html",
  url: "<the artifactUrl the CLI printed>",     # REQUIRED unless THIS conversation published it already
  title: "Progress board",
  description: "Current plan and where it stands.",
  favicon: "📋"                                  # keep this stable across every redeploy
)
```

Two cases, no third:

| Situation | What you pass |
| --- | --- |
| This same conversation already published the board | `file_path` only — the URL is remembered |
| Any other session (the normal case) | `file_path` **and** `url:` from the state file |
| The CLI printed *no artifact URL stored yet* | Publish with `file_path` only, then **immediately** run `node scripts/progress-board.mjs --url=<the URL the publish returned>` so the next session can find it |

If you cannot find the stored URL, run `Artifact(action: "list")` and match the title — do **not** publish
blind. A minted duplicate URL cannot be undone.

## What lives where

- **`we:scripts/progress-board.mjs`** — owns the page. Derives every pull-request row live
  (`gh pr list`) and reduces each to one status: *awaiting your clear* / *changes requested* / *CI red* /
  *conflicted* / *awaiting review* / *queued to land* / *landed*. Degrades to the last cached snapshot,
  behind a visible stale banner, when `gh` is unavailable — it never crashes the render. A **partial** read
  (the open list came back, the merged one did not) is treated as stale too: the page says which half it
  could not read, keeps the cached *Landed* rows, and does **not** overwrite the cache with the thinner
  snapshot.
- **`we:scripts/lib/output-mix.mjs` + `we:scripts/lib/output-mix-paths.json`** — the **Output mix** section
  (#3012): lines added this week to the **product** versus to the **delivery machinery and backlog
  bookkeeping**, with the four completed weeks beside it. Derived from `git log --numstat` on every render,
  so there is **no verb and nothing to type** — it cannot go stale and it cannot be hand-edited. Every path
  is charged by the first matching rule in the `.json`, and each rule explains itself in one line. To
  disagree with the number, change one rule there — never patch the script. `--no-git` (or
  `WE_BOARD_NO_GIT=1`) skips the ~0.8s read; the section then says so rather than showing a zero.
- **`we:reports/progress-board.json`** — the small hand-maintained half: plan items, decisions awaiting the
  operator, and the artifact URL. Written only through the verbs above.
- **`we:reports/progress-board.html`** — generated output at a fixed path. Not tracked in git, never read
  by you, never edited by hand.

`--out=` and `--state=` may point inside `reports/` or anywhere **outside** the repository (publishing from
a scratchpad path is normal); a path inside the repository but outside `reports/` is refused, so the board
can never overwrite a tracked file.

If the state file itself will not read, there are **two** outcomes and the CLI names which one you are in:

| The file | The CLI says | What happens |
| --- | --- | --- |
| did not parse at all (an unresolved merge-conflict marker is the usual cause) | `STATE FILE UNREADABLE` | the page still renders, behind a red *"the plan and decisions could not be read"* banner, with **no** plan half. **Every verb is refused** — an empty save must never overwrite a recoverable plan. Fix it by hand. |
| parsed, but one key held the wrong type | `STATE FILE PARTLY IGNORED` | that key is not **shown**, but it is **kept in the file exactly as written** — the normalisation that makes the page renderable never reaches disk. Verbs that write to that one key are refused by name; every other verb still works. The page says which key it was. |

**A key the board could not read is never overwritten.** This is the rule to hold on to, because the
alternative broke the tool's whole promise: the emptied stand-in used to be saved back over the file, so a
single **idempotent no-op verb** — one that reported "already titled" and changed nothing — permanently
destroyed every plan row at exit 0. Anything the board does not understand it preserves and refuses to
touch, so the worst a wrong type can cost you is the hand repair of that one key.

**The answerability rule applies in both cases.** It is checked against whatever decisions actually loaded,
never skipped because something else about the file was wrong — a wrong-typed key is not a licence to put an
unanswerable ask in front of the operator.

**`--out=` and `--state=` may not be the same path.** They are written by different code at different
moments, so pointing them at one file wrote the page over the plan. It is refused before either is read.

## The page's own contract

It is **operated, not read**: *Needs you* first (decisions and human-only reviews), then *Ruled, queued*
(decisions already answered but deferred — shown only when there are some), then *In flight*, then *Output
mix* (the one standing number about the SHAPE of the work rather than its state), then the plan table, then
*Landed*. State is carried in form — a severity stripe and a chip — so it reads at a glance. It
is theme-aware and fully self-contained (no external font, script, or image), which is what the Artifact CSP
requires.

Decisions are the heaviest rows on the page on purpose: the question is the heading, the options are a
scannable list with the recommendation marked, what-breaks gets the same red treatment a blocker gets, and
the grounding sits underneath in small monospace.
