# Conveyor canary brief (template) — one tiny, real, end-to-end proof of the dispatch path (x0nxuqd)

> **This is a TEMPLATE, not a runnable skill.** `we:scripts/conveyor/canary.mjs` instantiates it — filling the
> `{{PLACEHOLDERS}}` below — and spawns it through the SAME dispatch sink every build/fix/ci-heal dispatch uses
> (`we:scripts/operations/dispatch-lane-io.mjs#createDispatchSinks`), so this run gets the identical scratch
> cwd, trust grant, `--settings` env, and system prompt a real conveyor dispatch gets. It exists to catch a
> real-environment break the fake-session soak harness cannot (e.g. PR #2701's scratch-cwd permission prompt) —
> see `we:docs/agent/prototype-based-dev.md`'s "Real end-to-end dispatch canary" section.

## Fill these before spawning

| Placeholder | What the canary fills it with |
|---|---|
| `{{SESSION_SLUG}}` | a stable per-run slug, e.g. `canary-1735246800000` (ties `acquire`↔`release`) |
| `{{CANARY_ID}}` | the same timestamp token, used for the branch name and the marker file |
| `{{WE_ROOT}}` | the absolute WE checkout you are dispatched FROM — you start in a scratch directory outside it |
| `{{GATE_COMMAND}}` | the selected gate for this checkout — `gateFor('we')` (`we:scripts/lib/repo-profile.mjs`), the SAME diff-selected gate a fix/ci-heal brief runs: `node <WE_ROOT>/scripts/verify-lane.mjs run --repo=.` |

## Your job (one sentence)

Acquire a lane, write ONE tiny marker file proving you touched it, run the selected gate green, push your
commit to a throwaway `canary/{{CANARY_ID}}` branch — **open no PR** — then release everything you took, and
exit. This is a smoke check of the dispatch machinery itself, not a real backlog item.

## The arc

### 1. Acquire a lane-pool clone (never edit the primary checkout)

Same as every other dispatched agent — see `we:skills-src/conveyor/delivery-agent-brief.md` step 1 for the full
rationale if anything below is unclear.

```bash
export LANE_SESSION={{SESSION_SLUG}}
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --purpose=canary --session={{SESSION_SLUG}} --adopt) && cd "$LANE"
```

If `acquire` fails, report exactly what it printed and exit — there is nothing to fix, only to report.

### 2. Write ONE tiny marker file (the "edit" this canary proves)

Use the **Edit/Write tool**, never a Bash rewrite (`we:skills-src/conveyor/dispatched-agent-system-prompt.md`
already tells you why: a Bash heredoc rewrite of a tracked file has been denied outright on this dispatch path
before). Create exactly one new file:

```
docs/agent/canary-runs/{{CANARY_ID}}.md
```

with exactly one line of content:

```
Canary run {{CANARY_ID}} — dispatch-path smoke, never merged (branch deleted after the canary reads it).
```

### 3. Run the selected gate GREEN

Same as `we:skills-src/conveyor/fix-agent-brief.md`'s own gate step — `{{GATE_COMMAND}}` is a diff-selected gate
(`verify-lane.mjs run`, not the marker-based `request`/`check` pair build dispatch uses), and that brief runs it
as a single direct foreground command:

```bash
{{GATE_COMMAND}}
```

A red gate is a hard stop: report it and exit — do not try to fix an unrelated failure, this is a smoke check.

### 4. Commit and push to a throwaway branch — open NO PR

```bash
printf '%s\n' "canary: {{CANARY_ID}} dispatch-path smoke" "" \
  "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>" > .canary-commit-msg.txt
git add docs/agent/canary-runs/{{CANARY_ID}}.md
git commit -F .canary-commit-msg.txt
git push origin HEAD:refs/heads/canary/{{CANARY_ID}}
```

Do **not** run `pr-land` or `gh pr create` — this branch is read by the canary's own watcher and deleted
afterward, never reviewed, never merged.

### 5. Release the lane and exit

```bash
node "{{WE_ROOT}}/scripts/lane-pool.mjs" release --session={{SESSION_SLUG}}
```

Report one line: `canary {{CANARY_ID}} → pushed canary/{{CANARY_ID}} (gate green)` or the exact stage that
failed. Then **exit** — do not wait, do not poll the branch, do not clean up anything beyond your own lane
release; the canary's own watcher handles the branch and scratch-folder cleanup.

## Guardrails

- **Never edit the primary checkout** — all work is in the acquired lane clone, exactly like every other
  dispatched agent.
- **Never open a PR** — this is a throwaway smoke branch, not a delivery.
- **One marker file, one commit** — do not touch anything else in the lane.
