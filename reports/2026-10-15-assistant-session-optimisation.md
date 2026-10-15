# Cheaper assistant sessions with continuity beyond one chat
**Date:** 2026-10-15
**Point:** Keep Opus for the operator's judgment loop; remove routine wakeups and bound its working context before attempting a cheaper replacement for its focus.

---

## Evidence and limits

Research only; none of the recommendations below changes routing, daemons, permissions or the running session.
The operator's observation that Opus 5.5 is the first model to sustain focus is the quality baseline, not something a price comparison disproves.
The supplied measurement window begins 2026-10-14 22:00 ET (2026-10-15 02:00 UTC): 438M tokens, 92% Opus; this orchestrator has 243 calls, 141M cache reads and 1.2M cache writes; daemon sessions have 1,393 Opus calls; helpers account for 57M tokens.
These are operator-supplied totals, not independently recomputed here. Helper/daemon/session categories may overlap; do not add them into another total.

Local observations on October 15:
- Read the operator's user-wide Claude instructions and durable handoff rules (private files outside the repo). Durable priorities include decision cards, scoped approvals, brief replies, quiet hours, no waiting loops and explicit model routing. Historical task lists and later corrections coexist; recency alone cannot decide authority.
- Read bounded tails (at most 220KB each) of three recently modified top-level session transcripts in the operator's Claude project store; no full transcript ingestion. One was non-message metadata; another was October 13, outside the measurement window.
- The current `bd616854-…` tail contained 12 unique message IDs: 8,789,670 cache reads, 10,387 writes, 6,567 output and 24 uncached input tokens. Latest sampled calls read 735,246–737,204 tokens; writes were explicitly 1-hour TTL, model `claude-opus-5-5`, standard/global. This is a late-session sample, not a full-session output estimate.
- Deduplicate transcript usage by message ID, retaining final usage; streamed message fragments and nested `iterations` must not be added again. Thinking is part of output usage, not a second billable total.
- This lane lacks the bootstrap/feed implementation. Located and read it in sibling lane 10's `we:scripts/operations/operator-session-bootstrap-io.mjs`, bootstrap declaration and `we:scripts/operations/needs-you-feed.mjs`; ran only the read-only bootstrap IO CLI with `--json`. It returned a 30-minute sweep plan, monitor command, unread item and ack command. It prints setup; it does not install the cron/monitor or reconstruct goals, decisions and workers.
- Bootstrap includes only handoff lines matching `quiet`, not the whole standing-order file. A fresh session must explicitly load authoritative rules and current task state too.
- The live handoff feed existed: 19 lines parsed as 19 events at sampling. Despite its `.jsonl` suffix, lines have a `NEEDS-YOU`/`NEEDS-YOU-CLEARED` prefix and JSON suffix; use its parser. Three non-clear historical events lacked a head SHA. Revalidate before acting.
- Sibling feed source has transition deduplication, incomplete-read protection, locking and publication-count acknowledgements. A file sample and bootstrap output do not establish uninterrupted daemon delivery or monitor survival.
- The daemon-model migration PR (#5382) is supplied context; adoption on running clones was not verified. The backlog item with the same number is a different namespace.

## 1. What costs money, and how it grows

Use USD API list-price equivalents, not subscription invoices or undocumented Max quota weights.
[Opus 5.5's published rates](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5) are $4/M uncached input, $5/M five-minute cache writes, $8/M one-hour writes, $0.20/M reads and $20/M output.
For mutually exclusive usage buckets, with quantities in millions:

`cost = 4U + 5W5 + 8W60 + 0.20R + 20O`.

| Supplied orchestrator bucket | Tokens | API equivalent |
|---|---:|---:|
| Cache reads | 141M | $28.20 |
| Cache writes, TTL unknown for aggregate | 1.2M | $6.00–$9.60 |
| Output, including thinking | Not supplied | $20 per 1M |
| Uncached input | Not supplied | $4 per 1M |
| Known subtotal | 142.2M | $34.20–$37.80, before output/input |

Reads are 99.16% of these two known token buckets, but 74.6–82.5% of their dollar subtotal.
Output equals the read bill at 1.41M output tokens (about 5,802/call); therefore read-token dominance alone does not prove total-cost dominance.
If output were 0.1M/0.5M/1M, it would add $2/$10/$20; those are sensitivities, not measurements.
The bounded current tail prices at about $1.97: $1.758 reads + $0.083 writes + $0.131 output. Reads dominate that sample; extrapolating its output to all 243 calls is unjustified.

The supplied mean cached prefix is `141M / 243 ≈ 580k` tokens/call. Cache hits save processing cost but still charge for repeated history.
For a cached prefix C and n calls, read cost is `0.20 × nC / 1M`.
If context grows by g tokens/call from C0, cumulative reads are approximately `nC0 + g n(n−1)/2`: linear marginal cost in context size, quadratic cumulative growth in call count until compaction/window limits intervene.
Writes are approximately linear in newly appended content when the prefix stays reusable; expiry or prefix changes can rewrite old content.
This is billing arithmetic, not a claim about backend computational complexity.

| Cached context per call | Read tokens over 243 calls | Read cost |
|---|---:|---:|
| 50k | 12.15M | $2.43 |
| 100k | 24.30M | $4.86 |
| 250k | 60.75M | $12.15 |
| Observed mean ≈580k | 141M | $28.20 |
| 1M | 243M | $48.60 |

The [current pricing policy](https://platform.claude.com/docs/en/about-claude/pricing) includes Opus 5.5's 1M window at standard per-token rates; there is no assumed 200k price cliff here.
At the sampled 735k size, every unnecessary wake costs roughly $0.147 in reads before thinking, replies or tools.
A one-hour rewrite of that prefix costs $5.88. Avoiding a handful of reads is less valuable than accidentally provoking repeated full rewrites.
The full 438M total cannot be priced without per-model, per-bucket usage: 92% Opus tokens is not 92% of dollars. The same applies to the 57M helper total.

## 2. Continuity patterns: public evidence versus architecture inference

| Pattern | Established evidence | Implication for this assistant |
|---|---|---|
| Rolling summary / compaction | Anthropic documents Claude Code summarizing decisions and unresolved work, with risks from aggressive compression [A]. | Keep a short working narrative; audit omissions. A summary is a lossy view. |
| Structured external memory | Anthropic documents persistent notes and file-based memory [A]. | Store rules, goals, rulings and pending work separately from conversation. |
| Retrieval over an immutable log | Anthropic describes loading relevant material through lightweight references and targeted queries [A]. | Retrieve by repo/PR/head/rule and event sequence; preserve source evidence. |
| Event-driven wakeups | Dot publicly describes using calendar/location context [D]; Muse advertises unprompted suggestions [M]. Neither establishes its scheduler. | A deterministic event receiver can wake reasoning only when attention is needed; this is our proposed design. |
| Small model + escalation | No inspected Dot/Muse source establishes their model tiers or per-turn economics. | Use cheap classification plus bounded Sonnet execution; reserve Opus judgment. Validate locally. |
| State machine / standing orders | Our operator-queue and feed already encode eligibility and transitions. | Code enforces workflow and permissions; a model explains and reasons within them. Not a claim about companion internals. |

**Dot / New Computer:** [Dot's product page](https://new.computer/dot) describes personalized understanding; [its data statement](https://new.computer/your-data) says messages, photos, voice, location and calendar can inform responses, with cloud storage and account deletion. That supports continuity as a product promise. It does not reveal summary format, retrieval engine, model mix, token budget or wake policy; present availability was not tested. [D]

**Muse-style companions:** “Muse” is ambiguous; the concrete example here is [Meta's September 2026 Muse announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), not an attribution to every similarly named app. It advertises remembering details, proactive suggestions, a per-person cloud computer, audit trails and forgetting specific learned facts. Those are published product claims, not an independent reliability result or disclosure of memory/model-routing internals. [M]

**What generalizes:** external state survives a chat; bounded context is assembled for each task. [Anthropic's engineering account](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) supports compaction, persistent notes and retrieval, and warns that compaction can lose subtle context. [A]
No inspected source establishes drift-free companionship. “Drift-free” should mean measured adherence with explicit recovery, not a property promised by memory alone.

## 3. Options now, ranked by savings relative to risk to focus

All percentages below are planning scenarios, not measured improvements. The denominator is this orchestrator's 141M reads unless stated otherwise; alternatives overlap and must not be added.

| Rank | Change | Expected tokens / cost under explicit assumptions | Risk and guard |
|---|---|---|---|
| 1 | Let daemons/feed handle routine checks; wake Opus on meaningful changes | If 25–50% of calls are no-change checks, avoid 35–70.5M reads (25–50%), about $7–$14, plus those calls' output. Deterministic checks need zero model tokens. | Low–medium: lost events can hide work. Keep reconciliation, freshness checks and unread replay; do not remove the old sweep before live equivalence. |
| 2 | Bounded Sonnet sweeps / Haiku classification; Opus for rulings | If 60% of 243 calls move from 580k to 20–40k packets: Opus reads drop 84.6M; cheap-tier input is about 2.9–5.8M; total input falls about 79–82M (56–58%), before escalation. | Medium: preserve Opus conversation and send only escalations to it; do not forward every completion. Code determines readiness. |
| 3 | Periodic compaction or fresh Opus handoff through bootstrap | Keeping future average context at 100–200k across 243 calls would use 24.3–48.6M reads, saving 92.4–116.7M (66–83%), $18.48–$23.34 before rebuild/summary costs. | Medium–high for this operator: omitted standing orders or unresolved reasoning. Pilot at a natural boundary, retain old transcript, verify the restart packet. |
| 4 | Shorter replies and tool returns | Halving visible output saves half that output, not half total tokens. Example: remove 100k tokens spread evenly through the interval → about 12.1M later reads avoided, plus up to 100k writes and $2 output. | Low when repetition is cut; harmful if reasons or decision options disappear. Hidden thinking is not necessarily reduced by shorter visible replies. |
| 5 | Prompt-cache hygiene | No baseline token reduction for hits. If 10% of 1.2M writes were avoidable rewrites and became reads, save roughly $0.58–$0.94. Actual misses may differ. | Low: stable prefixes and compact tool outputs. Already excellent reuse means limited remaining upside. |

Routing economics need the actual target version. [Current Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) lists Sonnet 5.5 at $2/$10 input/output and $0.10 cached input per M; Haiku 5.5 at ≤100k prompt is $0.10/$0.50 and $0.01 cached input. Older Sonnet versions have different rates; Sonnet 4.6 reads cost $0.30/M, above Opus 5.5's $0.20/M.
Thus changing model alone need not save read dollars; reducing context and wake count matters. Model changes alone save **zero tokens** at equal usage.
For rank 2, 2.9–5.8M cold Sonnet 5.5 input costs $5.80–$11.60 versus $16.92 displaced Opus reads; output, tools and escalations determine net savings. One small cold request can cost more than a small cached request.
If 20% of routed calls return to Opus at the original context, read savings fall from 84.6M to 67.7M; measure escalation traffic too.
The 1,393 daemon Opus calls are a separate large lever: equal-token Sonnet 5.5 routing halves standard API-equivalent rates, but call counts cannot establish total dollars or tokens saved. Verify the daemon-model migration's actual model IDs before claiming savings.

**Compaction and fresh session differ.** In-place compaction may preserve conversation ergonomics; a fresh session is an explicit recovery exercise. Bootstrap restores attention plumbing only. Either needs an exact rules manifest, active goal, latest rulings with sources, unresolved forks, worker identities/status, quiet policy, unread cursor and next permitted action.
Keep 20–50k restart packets as a target, then allow 100–200k average growth; size and cadence are configurable trial parameters. Never recursively summarize standing orders into weaker prose.
A 50k one-hour rebuild costs $0.40; replacing 580k reads with 150k saves $0.086/call, recovering that write cost in about five calls, excluding summary/retrieval overhead. Full cold rebuilds of unchanged large prefixes can erase the gain.

**Caching discipline:** stable instructions/tools first, changing event data last; append evidence rather than rewrite history. [Anthropic caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) specify full-prefix matching, five-minute/default and one-hour TTLs, and usage fields for both. The sample already uses one hour. Do not create keepalive model turns; sparse work should sleep and reload a small packet.
[OpenAI's caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) likewise makes reusable prefix structure relevant. Codex is a CLI/product, not one model or one tariff: use the installed route's explicit model, subscription accounting and bounded-task replay before assigning a savings percentage. Prefer direct, scoped Codex work without a Claude wrapper when judgment is unnecessary, consistent with the operator's rules.

## 4. Product shape: the assistant is durable state plus disposable reasoning

This is a proposed operations/product feature, not a new WE standard or a runtime implemented in this report.
Follow the existing [daemon risk routing](../docs/agent/platform-decisions.md#daemon-claude-worker-risk), [durable daemon jobs](../docs/agent/platform-decisions.md#daemon-jobs), [fixed-policy precedence](../docs/agent/platform-decisions.md#delivery-decider-under-fixed-settings) and [verdict-ledger authority](../docs/agent/platform-decisions.md#verdict-ledger-pr-state-store).

**Stage A — current pieces, safer session replacement.** Bootstrap replays unread attention and prints monitoring setup; handoff supplies goals/rules. Add a reviewed checkpoint procedure and explicit monitor rearm. Keep Opus as the operator-facing conversation; workers remain detached. Existing private user files are a migration input, not the eventual runner dependency.

**Stage B — resident attention controller.** Move timers and monitor lifetime into a durable process. Feed transitions, worker completion/failure, stale PR/daemon thresholds, operator messages and scheduled reconciliation are wake triggers. Debounce by repo/PR/head/event; unchanged state causes no model call. Quiet hours suppress routine delivery, not persistence; preserve configured urgent exceptions. On startup, replay from a durable cursor, reconcile current queue state, then tail.

**State store:** begin with existing file stores and an append-only event journal; use SQLite transactions/indexes when multiple consumers require them. Do not create another PR truth store alongside the verdict ledger.

| State | Authority / fields |
|---|---|
| Standing orders | Versioned rule IDs, original wording/source, scope, supersession, effective dates; distinguish user authority from inferred preference. |
| Goals and focus | Ordered active goals, explicit non-goals, priority source, pending question, next permitted step; historical goals archived. |
| Decisions and approvals | Decision-card reference, exact ruling, actor, timestamp, repo/PR/head scope, expiry/revocation and evidence; summaries cannot extend permission. |
| Work and evidence | Durable job ID, owner/lease, scope, last observed state, head SHA, source pointers; observations expire and are refreshed. |
| Attention and delivery | Event ID/sequence, stream identity, received/presented/acknowledged/resolved separately, per-consumer cursor, retry/dedup keys. |
| Working memory | Disposable summary + indexed original log, provenance and retrieval links; never the authority for rules or approval. |

The current ack command advances to all events published when it runs; an event arriving after display but before ack could be marked read unseen. Future delivery should acknowledge only the displayed event IDs/high-water mark. Existing publication-count logic alone is not that guarantee.
Track clears and changed heads without forgetting an unanswered question; a cleared historical notification is not operator consent.

**Stage C — model tiers behind the controller.** Tier 0 code validates state, filters noise and schedules; it is the always-on component. Tier 1 Haiku classifies bounded ambiguous events; Tier 2 Sonnet assembles evidence and performs routine scoped work; Tier 3 Opus handles conflicting instructions, design forks, repeated failures and the operator's decision discussion. Codex handles eligible mechanical coding through the existing router. No cheap model must stay generating while idle.
All tiers receive authoritative rules relevant to their scope and explicit permissions. Unknown/stale/missing evidence escalates instead of guessing. Budgets, thresholds, model versions and fallback policy are settings; cheaper tiers start in shadow mode.

**Operator surface:** one pending decision at a time, linked to its prepared decision card, plain-language recommendation and source evidence. Follow-up questions keep that decision open. Separate pure action approvals from design rulings. Queue eligibility comes from operator-queue; revalidate the live head/gates before action. Persist the answer before dispatch, with idempotency and a bounded approval scope. Chat, phone and dashboard become interchangeable views of that state.

**Stage D — continuity as a product.** Multiple conversation windows share the same state and event cursor, not one giant transcript. Add inspect/correct/forget controls, audit history and conflict resolution. Workers get repo instructions plus explicit runner-supplied policy; product behavior must not depend on this operator's home-directory setup.

### Measure focus before reducing the strongest model's role

Run matched replay cases against the current Opus session baseline, followed by a live shadow period with no duplicate dispatches. Include quiet hours, restart mid-decision, feed gaps, changed heads, duplicate events, conflicting rules and worker failure. Score individual rules and harms; an overall average can hide a critical miss.

| Metric | Definition / proposed acceptance |
|---|---|
| Rules-followed rate | Compliant applicable actions / all applicable actions; target ≥99%, zero scope-of-approval or unsafe-readiness violations. |
| Re-asks | Requests to repeat already persisted facts/rulings per 100 operator turns; no regression from baseline. Necessary clarification is separate. |
| Missed needs-you | Eligible queue episodes not presented within configured SLA / all eligible episodes, reconciled independently against queue snapshots. Target zero critical misses; p95 routine latency ≤5 min outside quiet hours. |
| Focus / priority drift | Off-priority dispatches and abandoned active decisions per 100 actions; one active decision, zero unauthorized priority changes. |
| Recovery fidelity | Exact mandatory rule IDs, pending decisions and unread events recovered after restart; target 100% of required fields. |
| Attention quality | Duplicate/stale prompts, false escalations, operator corrections and correction recurrence. Report quiet-mode backlog separately. |
| Cost and utility | Per-tier U/W5/W60/R/O, calls, retries, wrapper tokens, p50/p95 latency, escalations, API-equivalent cost and actual plan-limit deltas per useful outcome. |

These thresholds are proposed, not ratified settings. Match workload and model version; count summarization, retrieval, shadow work and failed retries. Advance a tier only after replay and live parity; revert immediately on critical rule violations. Finite trials bound observed drift; they cannot prove perpetual zero drift.

## 5. First three steps (proposed work, not implemented)

Sizes are Fibonacci planning points, not elapsed-time promises; estimates overlap rather than add.

1. **Checkpoint and rehearse a fresh Opus session — size 2.** Capture rules manifest, active goals/decision, worker references and feed cursor; invoke bootstrap from a checkout that has it, rearm monitoring, then ask the fresh session to recover the next action without dispatching. Compare against the old session and replay several prior corrections. If correct, switch at a natural boundary and trial a 150k average context budget. At 243 comparable calls, reads fall from 141M to 36.45M: **104.55M fewer reads (74%), $20.91 before checkpoint/rebuild costs**. Stop the trial on lost rules or re-asks; retain the old transcript as evidence.
2. **Route only changed routine events, preserve Opus decisions — size 3.** Verify daemon-model migration adoption, then shadow Sonnet on bounded 20–40k sweep packets and use Haiku only where code cannot classify. Pilot 60% routine-call routing with ≤20% escalation: roughly **68–85M fewer Opus reads**, with about **3–6M cheap-tier input** added; net overall input reduction about **44–58%** under these assumptions. Keep all current review-family and human-approval rules. Direct Codex avoids wrapper duplication; quantify that separately rather than claiming the whole 57M helper total as recoverable.
3. **Make attention delivery independent of the chat — size 5.** Put durable wake/replay, exact displayed-event acknowledgements, deduplication, quiet delivery and reconciliation around bootstrap/feed/operator-queue. Demonstrate crash recovery, feed interruption and changed-head behavior on a live case before retiring session timers. If 25–50% of present calls are unchanged checks, save **35–70.5M reads ($7–$14)** plus output; this overlaps step 2. Success is no missed needs-you across restarts, not just fewer calls.

No new build cards or policy ratifications are implied by these estimates. The report pointer records this research only.

## Operator note (added 2026-10-15)

The operator reports that past switches of the assistant to a fresh session had mixed results and often dropped in quality. Step 1 therefore stays a shadow rehearsal only — no switch — until it scores at parity on the metrics above; steps 2 and 3 do not depend on replacing this session.

## Five-line summary

Keep Opus for the focus and decision discussion the operator already trusts.
141M cache reads price at $28.20; writes add $6–$9.60, while full-session output cost remains unknown.
Bounded 100–200k contexts could remove 66–83% of repeated reads, subject to handoff fidelity.
Let durable code watch events, cheap models handle bounded routine work, and Opus handle judgment.
Promote this into a product only when restart recovery, rule adherence and needs-you delivery match the baseline.
