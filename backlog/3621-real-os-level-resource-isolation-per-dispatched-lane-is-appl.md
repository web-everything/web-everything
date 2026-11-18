---
bornAs: xnb0gxj
kind: decision
parent: "3383"
status: open
relatedTo: ["3456", "3611", "3608", "3610", "3612", "3609", "3593", "3594", "3569", "3716", "3711", "3427"]
dateOpened: "2026-09-07"
tags: [conveyor, capacity, isolation, container, apple-silicon, platform]
---

# Real OS-level resource isolation per dispatched lane — is Apple's container/Containerization framework (Apple Silicon-only, 1.0 June 2026) the right foundation?

Live incident 2026-09-07: a busy-spin bug in a dispatched agent's Monitor command (a while/until wait-loop with no sleep in its body, caught and manually killed after 3.5+ minutes at 95-98% CPU, we:backlog/3594) burned host CPU with nothing to contain it, and the same night 42 concurrent claude -p sessions launching in one tick drove 1-min load average to 34.95 on the host (we:backlog/3612-cap-concurrent-dispatched-lanes-with-a-max-concurrent-lanes.md, we:backlog/3609-a-manual-emergency-pause-new-dispatch-lever-distinct-from-th.md). Everything filed tonight in response — we:backlog/3456's heavy-command admission cap, we:backlog/3611-hardware-usage-aware-heavy-command-capacity-control-a-staged.md's staged self-learning admission project (epic, parent #3456, filed but not yet merged, PR #1998) with its own we:backlog/3608-stage-1-sample-real-cpu-memory-usage-per-heavy-command-run-a.md (Stage 1 sampling) and we:backlog/3610-how-far-to-take-heavy-command-admission-control-beyond-stage.md (the EWMA-vs-learned-policy fork), we:backlog/3612's MAX_CONCURRENT_LANES dispatch ceiling, we:backlog/3609's manual pause lever, and we:backlog/3593-catch-and-correct-agent-instruction-slips-mechanically-a-syn.md / we:backlog/3594's instruction-slip scanner — is either ADMISSION (deciding whether to let a lane or heavy command start at all) or DETECTION (statically flagging a badly-written Monitor loop after the fact, report-only). Confirmed by reading each in full: none of them CONTAIN what an already-admitted, already-running process actually does to host resources once it is running. A perfect admission policy plus a perfect static scanner still would not have capped the busy-spin loop's CPU draw once it started — only a hard ceiling enforced by the OS itself would. This item is that different, deeper axis, filed as a sibling of 3611 (parented directly under #3383, not under 3611 or #3456) because 3611 is scoped narrowly to we:scripts/readiness/heavy-admission.mjs's command-counting semaphore and never touches per-process resource caps, and 3612 is scoped to how many lanes get dispatched, not what a dispatched lane's process can consume once running.

Checked before filing: grepped this repo for any existing resource-capping primitive (ulimit/cgroup/nice/renice/cpulimit/rlimit) across we:scripts/ and we:skills-src/ — zero hits; genuinely new ground. Searched we:backlog/ for 'container'/'virtualization'/'resource isolation'/'sandbox' in a capacity/conveyor context — nothing exists; the one superficially similar hit, we:backlog/3141-safe-edit-sandbox-discard-or-emit-pr-orchestration.md, is an editor undo/discard buffer, unrelated to OS-level process isolation. Checked we:backlog/2445-plateau-loop-extract-the-delivery-machinery-into-a-coordinat.md, we:backlog/2505-plateau-loop-operable-backlog-console-built-fresh-in-plateau.md, we:docs/agent/platform-decisions.md, and we:skills-src/mechanical-delivery-doctrine/SKILL.md for any existing target-hardware/audience statement: none exists anywhere on record. So the operator's framing tonight (Apple Silicon is an acceptable hard requirement because Plateau Loop targets an early-adopter audience, not legacy-hardware breadth) is not contradicted by anything already written, but it is also not yet a codified platform decision — if this item is ratified toward building on Apple's tool, its own resolution should be the first place that gets stated explicitly in we:docs/agent/platform-decisions.md, not left as an assumed conversational premise.

Researched (cited, current as of 2026-09): Apple's container CLI plus the open-source Containerization framework (github.com/apple/container, 1.0.0 shipped 2026-06-09) runs each container as its own dedicated micro-VM via Virtualization.framework/vmnet, not a shared-kernel model like classic Docker. Apple-Silicon-only per the project's own README (no Intel Mac support, ever — architectural, not a temporary gap); full functionality (container-to-container networking specifically) needs macOS 26. container run --cpus N --memory NgB are real, documented flags (https://github.com/apple/container/blob/main/docs/command-reference.md); because each container is a separate VM rather than a cgroup inside a shared kernel, the cap is enforced at hypervisor/VM-allocation level, a materially harder boundary than Linux cgroup throttling (this is an architectural inference, not a directly-quoted Apple guarantee — flagged as such). Filesystem isolation is strong (a separate EXT4 disk per container, no shared namespace outside an explicit volume mount); networking gives each container its own IP plus outbound NAT, so reaching api.anthropic.com should work unmodified, though container-to-container networking and DNS-after-sleep/wake are documented rough edges even on macOS 26, and small-file-heavy I/O (relevant to mounting a large node_modules-bearing git worktree read-write) has an open upstream complaint about being slower than Docker Desktop/OrbStack's shared-VM model (apple/container#948). The one real friction point for running the claude CLI inside such a container: the guest is a separate Linux VM with no macOS Keychain at all, so Claude Code's normal interactive OAuth/browser login flow has nothing to complete against inside the container — the practical path is ANTHROPIC_API_KEY env-var auth with claude --print/non-interactive mode (Anthropic's own docs confirm the env var bypasses OAuth/login), a real change from however dispatched lanes authenticate today. Sources: https://github.com/apple/container (README, https://github.com/apple/container/blob/main/docs/technical-overview.md, https://github.com/apple/container/blob/main/docs/command-reference.md, https://github.com/apple/container/blob/main/docs/networking.md), https://github.com/apple/containerization, https://thenewstack.io/apple-containers-on-macos-a-technical-comparison-with-docker/, https://github.com/apple/container/issues/948 and /issues/282, https://code.claude.com/docs/en/authentication.

What adoption would change: we:scripts/lane-pool.mjs today provisions lanes as plain filesystem clones on the shared host (git clone --reference, per-lane node_modules, zero process/resource isolation between a lane's running claude session, the host, and every other lane) — adopting per-lane containers means acquire would need to spin up or reuse (via the 1.0 container machine persistent-VM feature) a container instead of a bare directory, bind-mount the lane's git worktree read-write, and switch dispatched sessions to API-key auth.

Real tradeoffs, not glossed over: (1) this becomes a hard Apple-Silicon-only platform requirement for running the mechanical conveyor at all — acceptable per the operator's explicit framing, but a real, stated consequence that should be recorded, not assumed; (2) real migration cost against we:scripts/lane-pool.mjs's existing lease/reap/sibling-clone/port-band machinery; (3) whether a simpler, already-mature alternative solves the actual incident better — Docker Desktop and OrbStack already offer per-container CPU/memory caps on Mac (Intel and Apple Silicon both) via a mature, widely-used VM layer today, against Apple's tool being roughly three months past its 1.0 with open filesystem-throughput and DNS/sleep-wake issues, which is a real is-this-even-the-right-pick fork distinct from is-containerization-the-right-approach; (4) the eventual cross-platform goal (Linux/Windows, much longer down the line per the operator) — a Linux host already has native cgroups and needs no such tool at all, so this could end up being a macOS-specific implementation of what should be a platform-neutral resource-isolation capability the dispatcher calls through, a real design question worth naming rather than building a macOS-only escape hatch that has to be re-abstracted later.

## Amendment (2026-09-07) — could the same container also enforce operations-only + file-scope boundaries?

Folded in per the operator's own follow-up the same night, captured here rather than as a separate item.
Expanded research question: beyond resource caps, could the SAME container also serve as the enforcement
boundary for two other things filed separately tonight — (a) restricting a dispatched agent to declared
operations only (no arbitrary shell commands), and (b) file-scope enforcement (blocking an edit outside an
item's declared scope, the concern behind we:backlog/3716-epic-edit-time-scope-enforcement-with-a-request-extension-es.md
and its build-ready first slice we:backlog/3711-block-an-edit-write-outside-a-dispatched-lane-s-own-declared.md,
both filed but not yet merged, PR #2032). Checked before writing this in: 3716/3711 cover ONLY the
file-scope half (b); no existing item covers (a) — searched for any "restrict to declared operations only"
enforcement mechanism and found only we:backlog/3427-design-an-operation-manager-a-real-execution-chokepoint-ever.md
(ratified, codified in we:docs/agent/platform-decisions.md#operations-declared-once-callers-generated), which
is a software CONVENTION (operations declared once, callers generated) with no technical restriction stopping
a dispatched agent from calling the Bash tool directly outside any declared operation — (a) is genuinely new
ground, not a rediscovery.

**The mechanism this would need, to sit alongside the resource-cap ask above:**
1. A minimal container image whose only reachable entrypoint is the declared-operations CLI (we:scripts/operations/run.mjs
   `<op>`) — no general shell exposed to the dispatched agent. Structurally stronger than a permission check: the
   capability to run an arbitrary command would not exist in the environment at all, so there is nothing to bypass.
2. Read-only filesystem mounts outside the item's own declared `scope:` paths — the same protection
   3716/3711's guard-hook approach provides, but enforced by the mount itself rather than a PreToolUse
   hook that has to correctly intercept every Edit/Write call (and, as 3716's own epic body admits, we:scripts/guard-bash.mjs
   today has NO scope-vs-edit-target check at all — a dispatched agent writing a file via a raw Bash redirect
   or `sed -i` rather than the Edit/Write tool would sail past the planned we:scripts/guard-lane.mjs arm entirely;
   a read-only mount would block that write regardless of which tool or command performed it).
3. Resource caps (the original ask, above).

**The honest cost, stated plainly rather than glossed over:** this means the ENTIRE dispatched Claude session
runs inside the container, not just its individual Bash-tool subprocess calls — today we:scripts/operations/dispatch-lane.mjs
spawns `claude --bg` on the host directly. The container needs real outbound network to Anthropic's API (the
agent cannot function without it) plus git/npm/gh tooling reachable from inside it — "locked down" here means
"only the declared-operations entrypoint is reachable from the agent's own shell," not "no network." This is a
materially bigger architectural shift than either the resource-cap work above or the guard-hook work already
filed tonight (3716/3711) — not a small addition riding along with either.

**Recommended priority ordering, stated as this research's own view, grounded in tonight's evidence:** hard
boundaries (this container approach) > scanners (we:backlog/3594's compliance scanner) > prose doctrine
(we:skills-src/mechanical-delivery-doctrine's rules), in terms of actual trustworthiness. Tonight produced
dozens of real instruction-slip violations (we:backlog/3593) despite explicit doctrine and direct
corrections; a structural boundary does not depend on an agent behaving correctly, a scanner catches a known
bad pattern only after the fact, and prose doctrine is what gets written down once something cannot be fully
enforced. Future hardening work on this axis should sequence in that order — hard boundary first where one is
buildable, scanner as the interim/cheaper catch, doctrine as the fallback for whatever neither yet covers.

**Supersede or complement 3716/3711? Judgment, with reasoning:** complement in the near term, likely
supersede for the scope-enforcement half specifically if this container work ever ships. 3711 is already a
build-ready, cheap, incremental win against the two tools (Edit/Write) it actually covers, and it does not
require the architectural shift above — it should land on its own timeline, not wait on this decision. But it
is structurally weaker than a read-only mount: it covers Edit/Write only, and by its own epic's admission
leaves every Bash-tool file mutation unguarded, which is exactly the class of gap a mount-level boundary
closes for free, regardless of which tool or command the agent used. If the container approach is eventually
built, its read-only mount would make the we:scripts/guard-lane.mjs scope arm redundant for every
dispatched-lane session running inside a container — at that point keeping both is unnecessary defense in
depth rather than a real second line of defense, since the container's boundary cannot be bypassed the way a
per-tool hook can. Net: build 3711 now for its own cheap, real interim value; treat it as scaffolding for
this container work, not as permanent belt-and-suspenders alongside it.

## Amendment (2026-09-08) — decouple lane count from CPU: low-cpu lane containers + a separate heavy-command core pool

Folded in per the operator's own follow-up tonight, captured here rather than as a separate item, same
discipline as the 2026-09-07 amendment above: a research/idea addendum only, ratifying nothing, changing no
status, resolving no fork.

**The idea:** a dispatched lane's own orchestration — the Claude/Codex CLI session itself, waiting on API
responses, doing git operations, editing files — runs through Node's async event loop and is mostly I/O-bound,
not CPU-bound: it spends the large majority of wall-clock time waiting on network I/O, during which it
consumes near-zero CPU. The CPU-hungry part is specifically HEAVY COMMANDS — `test:unit` spinning up vitest
workers, `check:standards`' static analysis, npm install/compile — a much smaller, distinct set of processes
from "how many lanes are open."

**Checked before writing this in:** we:scripts/lib/lane-concurrency.mjs's `DEFAULT_MAX_CONCURRENT_LANES = 8`
(env-overridable via `WE_MAX_CONCURRENT_LANES`) caps concurrency by lane count, with no distinction between an
idle-waiting-on-API lane and one mid-`test:unit`. we:scripts/readiness/heavy-admission.mjs already implements
the LOGICAL half of this split — a `DEFAULT_ADMISSION_CAP = 2` (env-overridable via `WE_HEAVY_ADMISSION_CAP`),
an in-process counting semaphore that heavy commands acquire "at invocation time, never at lane-acquire time"
(the module's own header comment, citing #3461/#3456) — but it shares the same core pool as every other
process on the host: it throttles how many heavy commands run at once, not how many CPU cores they get, and a
lane can still be acquired freely regardless of the semaphore's state. So it is a soft, cooperative limit
inside one shared pool, not a hard resource boundary between "lane orchestration" and "heavy command work."

**Why this belongs on #3621 specifically, not filed separately:** this item's own researched mechanism — the
`container` CLI plus Containerization framework, with `container run --cpus N --memory NgB` giving each
container real, hypervisor-enforced resource allocation (see the Researched paragraph above) — is the exact
tool that could implement this split, not merely a cooperative in-process semaphore. The refinement this
amendment adds on top of the base decision's framing: rather than (or in addition to) giving each LANE's own
container a resource cap, give lane containers a LOW cpu allocation (since orchestration is mostly idle/async)
and route heavy commands specifically into a SEPARATE, properly-cored container pool. That specific split is
not in this item's existing body above, which currently frames adoption as "each lane gets a container"
without distinguishing the lane-orchestration part from the heavy-command part. If this holds, lane count
could decouple from CPU almost entirely and scale much higher — limited by memory, disk, or provider API rate
limits instead of cores — while a smaller number of dedicated cores get reserved specifically for heavy-command
throughput. `we:scripts/readiness/heavy-admission.mjs`'s cap-of-2 semaphore is the natural sizing signal for
how many cores that dedicated pool would need, if this is ever built.

**Secondary implication, worth recording in the same amendment:** if this holds up, it could reshape how the
operator's in-progress second-machine hardware purchase decision (a separate, not-yet-filed conversation about
a build host) gets sized — potentially one pool of machine(s)/cores for many cheap concurrent
lane-orchestration sessions, and a smaller dedicated core allocation specifically for heavy-command throughput,
rather than sizing hardware as if lane count and core count scale together 1:1. Not filing a new item for the
hardware decision itself — it lives in conversation, not yet in the backlog — just noting the connection here
so it isn't lost.

**Explicitly not decided by this amendment:** whether lane orchestration is ACTUALLY as idle as claimed under
real measurement (this is stated as a reasonable inference from Node's async I/O model, not a profiled claim
against this repo's actual dispatched-lane workload — an open verification question for whenever this decision
is prepared), how large the dedicated heavy-command pool should be, whether the split is even worth the added
container-topology complexity over the base per-lane-container proposal, and how this interacts with the
already-open tradeoffs above (Apple-Silicon-only requirement, migration cost against we:scripts/lane-pool.mjs,
Docker Desktop/OrbStack as a simpler alternative, eventual Linux/Windows portability). Left as an open question
for whoever prepares or ratifies this decision.

## Amendment (2026-09-08, later same day) — a single git-manager chokepoint for GitHub API calls, and push-notify execution instead of agent polling

Folded in per the operator's own follow-up tonight, later the same day as the lane-count/CPU amendment
above — same discipline as both prior amendments: a research/idea addendum only, ratifying nothing,
changing no status, resolving no fork. Two related but distinct ideas from tonight's conversation.

**Idea 1 — a single managed "git manager" bottleneck for GitHub API calls.** Tonight, GitHub's
*secondary* (burst) rate limit — not the primary 5,000/hr core quota tracked by we:backlog/3573 below —
got hit repeatedly because dozens of concurrent dispatched sessions each independently called `gh`
directly. Confirmed via fresh web research tonight (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api):
GitHub's secondary limits cap concurrent requests at 100 (shared across REST and GraphQL together), 900
REST points/min, and 2,000 GraphQL points/min — a SHARED ceiling across the whole account, not raised by
any plan tier. Checked before writing this in: grepped this repo for every file invoking `gh` via a
subprocess call (execSync/spawnSync/execFile) — 84 files hit, confirming the decentralized-call pattern
the operator described is real, not assumed. The operator's proposed fix: route all
`gh`/GitHub-API-calling commands through a single managed chokepoint (a "git manager") that
gates/serializes them, the same pattern already built for heavy local commands via
we:scripts/readiness/heavy-admission.mjs's counting semaphore (`DEFAULT_ADMISSION_CAP`, overridable via
`WE_HEAVY_ADMISSION_CAP` — see the prior amendment above) — but gating GitHub API calls specifically
instead of CPU-heavy commands.

**Checked against we:backlog/3573 first, since it looked adjacent:** we:backlog/3573-gh-cli-rate-limits-stay-on-oauth-pat-or-migrate-to-a-github.md
is already `status: resolved` (ratified 2026-09-07, codified `one-off`) — it ratified fork (c),
instrument-first: log `gh api rate_limit`'s remaining/used on every we:scripts/conveyor/infra-blocked.mjs
retry trip, revisit a GitHub App migration only if usage data later shows sustained pressure. That
decision is about the PRIMARY 5,000/hr core quota and whether to change *auth method* (OAuth/PAT vs.
GitHub App installation token) to raise it — it does not touch the secondary burst limit at all, and a
GitHub App migration would not fix a secondary-limit hit anyway, since the secondary limits (concurrency,
points/min) are enforced per-account regardless of auth method and are not raised by any plan or app
type. So Idea 1 is adjacent to #3573 (both are "gh rate limit" concerns) but not overlapping in scope:
#3573 is about which credential to authenticate with against the primary quota; Idea 1 is about
serializing concurrent callers against the secondary burst limit. Stated plainly rather than treated as
fully novel ground, since the two are easy to conflate on a skim.

**Idea 2 — stop agents from polling; delegate execution to "the mechanic," which notifies on completion.**
A broader architectural shift: instead of each dispatched agent independently polling/waiting for a
result (a backgrounded `verify-lane` run, a PR status check, a `gh` call), delegate the actual execution
to a central mechanical authority (the conveyor/runner itself) which performs the work and pushes a
notification back when done — a push model instead of each agent running its own pull/poll loop.
Operator's stated reasoning: "more reliable and cheaper." Ties directly to two real, repeated problems
from tonight, both already on record: (a) the passive-wait/false-Monitor-claim anti-pattern documented in
we:agent-memory-src/subagent-must-not-end-turn-on-passive-wait.md and pinned at the top of this repo's
we:CLAUDE.md — a subagent kicking off a gating check via a backgrounded Bash call or untracked nested
child, then ending its turn assuming a notification will wake it, when no such notification exists
outside a harness-tracked Task/Agent job; and (b) redundant/wasteful polling itself consuming API calls
and contributing to the very rate-limit pressure Idea 1 addresses — every independent poll loop is itself
more `gh`/API traffic against the same shared secondary-limit ceiling.

**Why these belong on #3621 specifically, not filed separately:** the operator's own framing tying this
to "the prototype" suggests both ideas compose with #3621's already-recorded container/isolation work and
the heavy-task-runner/core-sharing idea in the amendment above. A central git-manager service (Idea 1) and
a push-notify execution model (Idea 2) are both instances of the same broader shift this item is already
tracking: centralize/gate shared-resource access through one managed authority, rather than many
independent dispatched agents each doing it themselves. Recorded here as the same underlying shift, not
merged into one idea — Idea 1 is specifically about GitHub API access; Idea 2 is the general
poll-vs-push execution model, which applies well beyond `gh` calls (test runs, PR checks, any
long-running gating step).

**Cross-reference, not expanded on here:** we:backlog/2660-conveyor-ui-surface-infra-blocked-lanes-distinctly-outage-ba.md
and the we:scripts/conveyor/infra-blocked.mjs/#2659 auto-retry mechanism discussed tonight are the CURRENT
reactive handling of rate-limit hits — retry after the fact, once already blocked. Both ideas in this
amendment are about PREVENTING the hits in the first place (serializing callers so the secondary limit is
never hit; reducing poll traffic so fewer redundant calls happen at all) — a different but related layer
sitting upstream of the existing reactive retry path. Noted for whoever prepares or ratifies this decision
to connect the two, not expanded on further here.

**Explicitly not decided by this amendment:** whether a single git-manager chokepoint should live inside
this item's eventual container/isolation work or ship independently of it; how a chokepoint process would
itself be dispatched/supervised without becoming a new single point of failure; what the push-notify
mechanism in Idea 2 would be built on (a long-poll, a filesystem watch, a socket, something else); how
either idea interacts with the still-open lane-orchestration/heavy-command core split from the prior
amendment. Left open for whoever prepares or ratifies this decision.

## Amendment (2026-09-11) — LIVE test on this machine: the tool works and the cap is real, but it does NOT fix the Codex-isolation problem

Same discipline as the three amendments above — evidence addendum only, ratifying nothing, changing no
status, resolving no fork. Everything below was **run on this machine tonight**, replacing this item's
prior documentation-only research with measurement. It was commissioned to answer one operator question:
*"if the product needs containers anyway for #3621's reasons, should the Codex-isolation fix be built on
top of that now, instead of point-fixing it twice?"*

**The short answer, stated up front because the rest is detail: no — because containerizing does not fix
the Codex-isolation problem.** The two concerns barely overlap. See "the headline negative result" below.

### Is Apple's `container` actually usable here? Yes — confirmed live, not from docs

`command -v container` exited 1 (not preinstalled), matching the parallel probe's earlier check. It is a
plain Homebrew-core formula: `brew install container` installed **1.3.1** (400.8 MB), then
`container system start --enable-kernel-install` pulled the kata-containers 3.32.0 arm64 static kernel
(`vmlinux-6.18.35`). Host: macOS 26.6.2 (build 25G83), `uname -m` = **arm64**. Note for this
item's own record: the body above cites "1.0.0 shipped 2026-06-09" — the tool is now three minor versions
past that, so the desk research was current when written but the project is moving.

- First run (`alpine`, cold, incl. image pull): **6s**. Warm start, three consecutive runs: **0.86 / 0.86 / 0.88s**.
- `--memory 1g` → guest sees 1102 MB total. Enforced.
- `--cpus N` → guest `nproc` reports **N+1** (1→2, 2→3, 4→5). A real off-by-one; any sizing arithmetic
  built on these flags must account for it rather than assume `--cpus N` means N visible CPUs.

### The resource cap is REAL — measured against this item's own founding incident

The #3594 busy-spin shape, reproduced deliberately: **8 infinite `while :; do :; done` spinners** inside
one `--cpus 2 --memory 2g` container.

| observed | value |
| --- | --- |
| host `com.apple.Virtualization.VirtualMachine` process | **188.3% CPU** |
| `container stats` (guest's own view) | 214.66% CPU, 5.38 MiB / 2.00 GiB |
| unconstrained equivalent on the host | ~800% CPU |

The cap held: ~16% of the machine instead of ~two-thirds of it. **This is the first direct evidence for
this item's central claim** — that a hypervisor-enforced ceiling contains an *already-running* runaway,
which neither #3456/#3611's admission control nor #3593/#3594's static scanner can. The base proposal's
core premise is now measured, not inferred.

`--volume src:/ro:ro` also behaves as the 2026-09-07 amendment's mechanism 2 assumed: a write inside the
container failed with `Read-only file system`, reads succeeded. Mount-level scope enforcement works.

Outbound network works unmodified: `https://api.anthropic.com/v1/messages` → HTTP 405 (reachable; 405 is
the correct answer to a GET), `https://api.github.com` → HTTP 200.

### THE HEADLINE NEGATIVE RESULT — a container does not close the we:AGENTS.md leak

The decisive test for the operator's question. A full clone with root we:AGENTS.md deleted (exactly
#3371 Probe 11's technique, now shipped as `createMacosDeletionIsolationProvider` in
we:scripts/lib/isolation-provider.mjs), bind-mounted read-write into a real container:

```
== 1. AGENTS.md present on mount? ==   ls: AGENTS.md: No such file or directory
== 2. git show recovery INSIDE container ==
     $ git show HEAD:AGENTS.md
     # AGENTS.md — Web Everything …          ← RECOVERED, in full
== 3. tool-bearing write ==   hello
== 4. git status ==    D AGENTS.md / ?? container-write-proof.txt
== 5. git commit ==   bb45168b test
```

The file is absent from the mount and real tool-bearing work is unaffected — **but the `git show` above
printed the real doctrine text from inside the container, exactly as it does on the host.** The container
changes nothing here, and the reason is structural: the leak lives in the mounted git object database, not
in the process boundary, so putting a VM around the directory cannot touch it. #3371 Probe 13b's finding —
6/6 tool-bearing Codex runs shelled `cat` on the doctrine file unprompted — is not mitigated by
containerizing; such an agent would simply `git show` instead.

Closing that leak means changing **what goes into the directory** (a `git archive` export, or a
`file://`-URL `--depth 1` clone — measured tonight: a plain local `git clone --depth 1` is silently
ignored, `warning: --depth is ignored in local clones; use file:// instead`, so the naive shallow-clone
fix does not work). That change costs the same with or without a container around it.

#3371's Probe 14 landed independently while this test was running and reaches the same conclusion from the
other side, more strongly: given an *ordinary, non-adversarial* task, a tool-bearing Codex session ran a
`git show` of the doctrine file at HEAD on its own initiative and recovered all 16,480 bytes — because
`git status` advertises the deletion with a ` D` line that reads as a signpost. Two independent tests,
same gap.

### The one place the container IS structurally stronger — Probe 14's gap 3

Probe 14b found a gap neither deletion nor this item had named: `-s workspace-write` restricts *writes*
only, so a session read its way **out of its own clone** into a sibling directory (a `head` of the same
filename in a sibling clone one level up), and the primary checkout sits at a well-known absolute path.
Its conclusion: "no amount of clone-level hardening is isolation on its own."

Tested tonight, because that gap is exactly the kind a filesystem namespace closes. The same escape,
attempted from inside a container with only the clone mounted:

```
sibling dir (probe 14b route):            ../sibling-AGENTS.md: No such file or directory
host primary checkout by absolute path:   /Users/…/webeverything/AGENTS.md: No such file or directory
what IS visible above the mount:          bin dev etc home lib … usr var w
```

**Both routes are gone, structurally** — the sibling directory and the host path do not exist in the
guest's filesystem at all, so there is nothing to deny and no profile to get right. This is a real win the
container delivers that neither deletion nor a Seatbelt path-deny regex achieves as cleanly, and it should
be weighed in this item's favour. It is also not urgent: Probe 14c proved Seatbelt *does* compose with a
fully tool-bearing Codex session (under `-s danger-full-access`, letting the outer profile be the only
sandbox), so gap 3 has a working cheaper interim answer today.

**Net, and the answer to the operator's question.** The two problems are *mostly* disjoint, and the half
that matters most right now is the half the container does not touch: gap 1 (history recovery) has to be
fixed by changing what goes into the directory no matter what, at the same cost either way. The container
is the eventually-cleanest answer to gap 3 only, which already has an interim fix. So there is no
"point-fixing it twice" to avoid by waiting — building the Codex fix on containers would buy one gap's
worth of elegance while inheriting the whole container migration's cost and its unresolved billing
question. #3630's wiring of the deletion backend should proceed on its own terms.

### Two real costs this item's desk research missed

1. **The host lane's dependency tree is architecturally unusable inside a Linux container.** The body
   above proposes to "bind-mount the lane's git worktree read-write"; that does not work as written.
   This repo's installed tree carries an `@esbuild/darwin-arm64` build and a `rollup-darwin-arm64` build,
   and running the real suite over the host mount dies with `MODULE_NOT_FOUND` out of rollup's own
   native-binding loader. Every container needs its own linux-arm64 dependency tree. The cost is small
   once measured — in-container `npm ci` took **14s**, produced 18,850 files with an
   `@esbuild/linux-arm64` build, and bakes into an image once rather than per-lane — but a lane's on-disk
   cost roughly doubles (a darwin tree for host tooling plus a linux tree for container work) and the two
   cannot be shared.
2. **Mount-bound I/O is measurably slower, which is in tension with the prior amendment's premise.**
   With a correct linux tree in place, this repo's real
   we:scripts/lib/__tests__/isolation-provider.test.mjs ran **15/15 green inside a real container**
   (`--cpus 4 --memory 4g`, over a mounted lane-shaped clone) — the complete tool-bearing proof this
   amendment was asked for. But it took **2.80s vs 779ms on the host**, ~3.6x, concentrated in
   mount-bound file I/O (`environment 1.22s` vs `161ms`; `prepare 566ms` vs `110ms`). Bulk read of the
   real 18,834-file / 447 MB installed dependency tree: **5s over a container mount vs 3.39s on the
   host**, ~1.5x. This quantifies apple/container#948 for this repo rather than repeating its complaint.
   It cuts against the 2026-09-08 core-split amendment, which assumed a dedicated core pool would *raise*
   heavy-command throughput: containerizing heavy commands to protect host CPU makes those same heavy
   commands slower. Whether the net is positive is now an open, measurable question, not an assumption.

### Per-lane memory floor — a number for the core-split amendment's own open question

Six concurrent idle `--cpus 1 --memory 1g` alpine containers, each with its own IP (192.168.64.16–21):
**377–380 MB host RSS each, 2,270 MB across six.** At we:scripts/lib/lane-concurrency.mjs's current
`DEFAULT_MAX_CONCURRENT_LANES = 8` that is ~3 GB of host RAM for *empty* VMs, before any agent session or
dependency tree. This confirms the 2026-09-08 amendment's prediction that lane count would become bound by
memory rather than cores — with a concrete floor of **~378 MB/lane** to size against, including for the
second-machine hardware question that amendment flagged.

### Auth: confirmed, and it is a billing decision, not a config flag

The body above flags Keychain/OAuth as "the one real friction point." Confirmed and sharper than stated:
`ANTHROPIC_API_KEY` is **not set** on this machine — dispatched sessions authenticate through the CLI's
OAuth/keychain path — so the container route requires switching to API-key auth, which is a different
*billing model* (metered API credits vs. the subscription the CLI uses), not just a different env var.
`gh auth status` confirms the token lives in the macOS `(keyring)` with `Git operations protocol: ssh`, so
a containerized lane additionally needs `GH_TOKEN` in its environment and an ssh key mounted in.

**None of that applies to the heavy-command half.** `vitest` and `check:standards` need no credentials at
all — which is exactly why tonight's in-container suite ran green with zero auth work. This is the single
biggest asymmetry between the two halves of the core-split proposal.

Mitigating, checked rather than assumed: this repo's 11 registered we:.claude/settings.json hooks are all
repo-relative node scripts, so they follow the repo into a container and keep working — a containerized
session does not silently lose the write-time guards, provided node and the linux dependency tree are present.

### Grounded effort estimate, from reading the actual code

we:scripts/lane-pool.mjs is 1,687 lines (`cmdAcquire` alone is 287); 31 files reference the pool-path
module, 45 reference the acquire path. But two of the three seams this work needs **already exist as
ports**, which materially lowers the estimate the body above implies:

- we:scripts/lib/isolation-provider.mjs (landed via #3371 Probe 11 / PR #2118) — a backend-neutral
  *directory preparation* port.
- `defaultClaudeProvider` at we:scripts/operations/dispatch-lane-io.mjs:899 (#3579) — an already
  CLI-independent *spawn* port.
- The missing third piece is named by the isolation-provider's own header: *"process/container execution
  and stronger guarantees need a separate execution contract."*

**Per-lane containers (the base proposal): multiple days, and gated on a non-engineering decision.** A new
ExecutionProvider port plus container backend at the #3579 seam; a container image (node, git, gh, the
agent CLI, linux deps); the auth/billing migration above; and reconciling we:scripts/lane-pool.mjs's
host-path lease/reap/port-registry machinery (we:.claude/lane-ports.json, `gh pr list`-driven reaping,
`--reference` object sharing) against a guest filesystem.

**Heavy-command containers only: plausibly 1–2 days for a working first cut.**
we:scripts/readiness/heavy-admission.mjs already owns the invocation-time chokepoint, so the change is
to route the command it admits through `container run --cpus N --memory Ng` against a prebuilt image
instead of executing it on the host. No auth work, no spawn-seam change, no lane-pool surgery — and it is
the half that directly answers #3594, the incident that opened this item.

### Portability, restated plainly because it is permanent

This machine is `arm64`, so nothing here was blocked. But Apple's project supports **Apple Silicon only,
architecturally and permanently** — not a gap that closes. Adopting it means: an **Intel Mac cannot run
the conveyor at all**; a **Linux host** already has native cgroups and needs a completely different
backend (the tool is irrelevant there); a **Windows host** has neither. Full container-to-container
networking additionally requires macOS 26. Whatever gets built must therefore be a *backend behind a
platform-neutral execution port*, never a direct `container run` call sprinkled through the dispatcher —
the same shape we:scripts/lib/isolation-provider.mjs already chose, and the fork this item's tradeoff (4)
already names.

### Also checked, so it is not re-discovered

The 2026-09-08 git-manager idea (Idea 1 of the amendment above) is **not built**: no
we:scripts/lib/gh-throttle.mjs exists and nothing under we:scripts/, we:docs/ or we:backlog/ references a
git-manager or gh-throttle. It remains open as written.

## Amendment (2026-09-14) — the heavy-command-pool container POC, started and given a real first working slice

Same discipline as every amendment above: this one DOES change something — it records real code, not just
research — but changes no `status` and resolves no fork; this item's own two remaining forks (Docker
Desktop/OrbStack as a simpler mature alternative; the platform-neutral-abstraction question) are still open.
Tracked as a progress note on `we:backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md`
(see that item's own 2026-09-14 session update for the full account) rather than as a new formal backlog item
— per the operator's own explicit direction, and confirmed against this repo's actual convention: landing a
PR here does not require a fresh item number when the change legitimately references an existing one
(precedent: `PR #2131` landed real code referencing `#3631` by number alone).

**Why now, despite this item's own per-lane-container deferral still standing as written.** The
2026-09-11 amendment above already drew the exact distinction this slice depends on: per-lane containers stay
deferred on a real, unresolved auth/billing question (OAuth/keychain → metered `ANTHROPIC_API_KEY`); the
heavy-command-pool slice needs none of that (`check:standards`/`test:unit` need no credentials at all) and was
this item's OWN amendment's explicit recommendation for what should start first if anything did. Nothing about
that recommendation has changed — this is that recommendation acted on, not a reopening of the per-lane
question.

**A real first working slice landed, `check:standards` only — see `#3383`'s session update for the full
build/evidence writeup (`we:scripts/lib/container-exec.mjs`, `we:scripts/lib/container-exec/Containerfile`,
and a new `run` CLI mode on `we:scripts/readiness/heavy-admission.mjs`).** Headline results, condensed here
because they bear directly on open questions THIS item's own body left unresolved:

- **The CPU cap reproduces this item's own 2026-09-11 busy-spin containment result on a second, independent
  build**: 8 unbounded spinners inside a `--cpus 2 --memory 2g` container held host CPU at ~190-205%
  throughout the run, versus ~800% unconstrained on this same the host. Corroborates, does not merely
  repeat, the earlier finding.
- **A real fidelity proof for a HEAVY COMMAND specifically** (the earlier amendment proved the isolation
  provider's own unit suite in-container; this proves an actual heavy command in the closed named set
  `we:scripts/readiness/heavy-admission.mjs` gates): `check:standards` produced an identical error count and
  identical error messages run inside the container vs. the host, back-to-back against the same repo state.
- **A cheaper path than this item's own measured `npm ci`-in-container approach, for commands with a pure-JS
  dependency closure**: `check:standards`'s only two npm dependencies (`gray-matter`, `markdown-it`) carry no
  native binding, so the container mounts the lane's own HOST-BUILT (darwin) `node_modules` read-only rather
  than baking a separate linux-arm64 tree. This is real, but narrow — it does NOT extend to `test:unit`
  (vitest/esbuild/rollup carry native darwin bindings in this lane's tree), where this item's own
  `MODULE_NOT_FOUND` finding almost certainly still applies and the baked-linux-tree approach already measured
  above remains the needed path.
- **A previously-unnamed friction point, found and closed while building this**: a lane clone's
  `.git/objects/info/alternates` records an ABSOLUTE host path to the primary checkout (how `--reference`
  object sharing works) — a container that mounts only the lane itself cannot resolve it, so `git merge-base
  origin/main HEAD` and similar calls fail inside the guest. Fixed by mounting the primary checkout read-only
  at its own identical absolute path alongside the lane's read-write mount. Worth recording here since any
  future container work touching a lane clone (per-lane containers included) will hit the same thing.

**Still explicitly open, not resolved by this slice:** whether `--container` should ever become the DEFAULT
execution path for `check:standards` (not done here — opt-in only, via a new `--container` flag/
`WE_HEAVY_ADMISSION_CONTAINER=1`); `test:unit`/Playwright coverage (unstarted); the `frontierui`/`plateau-app`
sibling-checkout mount gap (a named, understood scope limitation, not yet closed); image-build automation (a
human/agent runs `container build` by hand today); and a real, accepted risk that this landed on `main` while
a fuller version of the same general-purpose `run`-CLI idea already exists, unmerged, on the separate
`lane/mechanical-dispatcher` integration branch — reconciling the two is deferred to whoever lands that
branch's eventual merge.

### This amendment does NOT stamp `preparedDate`, deliberately

It closes real questions (is the tool usable; does the cap work; what does a lane cost; does the Codex
question compose) but **opens** others: whether containerized heavy commands are net-positive given the
~3.6x I/O penalty measured above, and whether the API-key billing change is acceptable. It also leaves this
item's two pre-existing forks unresearched — Docker Desktop/OrbStack as the simpler mature alternative
(tradeoff 3), and the platform-neutral-abstraction question (tradeoff 4). Stamping readiness now would be
exactly the false stamp we:docs/agent/backlog-workflow.md's G4 / "never trust the stamp" rules warn about.

**Recommended sequencing, as this research's own view rather than a ruling:** the operator's stated
preference — wait until Codex and Gemini are hooked up — is well supported by the evidence, because the
Codex work gains nothing from waiting for containers. If anything starts in parallel sooner, it should be
the **heavy-command container pool**, not per-lane containers: it is the cheap half, needs no auth or
billing change, answers this item's founding incident directly, and would produce the throughput
measurement the prior amendment's core-split premise still lacks.

## Amendment (2026-09-13) — correction: the 2026-09-11 amendment's "requires API-key billing" claim is FALSE, tested live tonight

Same discipline as the four amendments above — a factual correction to prior research, not a decision:
ratifies nothing, changes no status, stamps no `preparedDate`, and does not change the operator's
already-recorded sequencing (containers stay deferred until Codex/Gemini are hooked up, per the
2026-09-11 amendment's "Recommended sequencing" above — this only corrects a technical claim that will
matter whenever that work eventually resumes).

**The claim being corrected.** The 2026-09-11 amendment's "Auth: confirmed, and it is a billing
decision, not a config flag" section states the container route "requires switching to API-key auth,
which is a different *billing model* (metered API credits vs. the subscription the CLI uses)." Tested
live tonight, real Apple `container` CLI, not desk research: **this is false, or at minimum stated far
too pessimistically.** Subscription auth (Claude Max plan, Codex ChatGPT subscription) works fine from
inside a container. No API-key billing switch is required.

**Evidence, already verified tonight — not to be re-tested:**
- **Claude Code CLI** has a plain-file credential fallback, mode 0600, at:
  ```
  ~/.claude/.credentials.json
  ```
  used on Linux/when Keychain is unavailable, plus an official headless path: `claude setup-token` mints
  a one-year OAuth token settable via `CLAUDE_CODE_OAUTH_TOKEN`. Verified live in a real `container run`
  (Apple container CLI 1.3.1, `node:20` image): the CLI made a real authenticated round-trip to
  Anthropic's servers from inside the container, zero Keychain involved.
- **Codex CLI**'s credential file is *always* plain (never Keychain, on any platform), at:
  ```
  ~/.codex/auth.json
  ```
  holding `{auth_mode, tokens: {access_token, refresh_token, ...}}`. Verified live the same way — real
  calls to chatgpt.com's backend from inside a container. Also found: `codex login
  --with-access-token` (headless bearer-token injection) and a `chatgpt_base_url`/`model_providers`
  config override — both official, supported mechanisms.
- **Antigravity** is Keychain-only; no plain-file fallback was found. This one gap is real, but matters
  less: Antigravity isn't run headlessly by the conveyor today anyway.

**Best design identified, for whenever this work resumes:** a host-side auth proxy — the real credential
stays outside the container on the host, and the container points at it via the officially-supported
`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` env vars (Claude) and the `chatgpt_base_url` override
(Codex). The container never holds the real secret at all. This also sidesteps a footgun found tonight:
a raw copied Codex credential file can have its refresh token rotated *inside* the container, causing a
split-brain with the host session — a proxy avoids that because the container never holds a token that
can itself be refreshed and diverge. A lower-effort interim step, if a quick unblock is ever needed
before the proxy is built: inject `CLAUDE_CODE_OAUTH_TOKEN` directly, or use `codex login
--with-access-token` directly — no proxy required, at the cost of the token living in the container.

**A third option, tested and ruled out:** scoping a credential file's visibility to a single process
rather than the whole container. This does not exist as an Apple `container` CLI primitive — mounts are
whole-container, whole-lifetime only, with no per-process visibility control. Not worth pursuing further
since the host-side proxy is strictly better anyway (never exposes the secret to the container at all,
process-scoped or not).

**Net correction to this item's own record:** the 2026-09-11 amendment's "Two real costs this item's
desk research missed" section and its auth paragraph should now be read alongside this one — the
dependency-tree cost and the ~3.6x mount I/O penalty measured that night both still stand untouched by
tonight's testing, but the auth/billing cost does not: it was the single biggest asymmetry that amendment
named between the per-lane-container and heavy-command-only halves, and it turns out not to be a real
cost at all, just an under-researched one. This does not revive per-lane containers as an active proposal
— the operator's sequencing call above still holds — it only means that when the decision is eventually
made, the auth/billing line item should be crossed off the tradeoff list rather than carried forward as a
blocker.

## Amendment (2026-09-14) — LIVE test: a container DOES fully contain Antigravity's write tools, git-hook write-escape ruled out, and the auth gap is confirmed real

Same discipline as the amendments above — evidence addendum only, ratifying nothing, changing no status,
resolving no fork. Commissioned by a different operator question than the 2026-09-11 amendment's Codex
question: given `#3633`'s own finding that Antigravity's `--sandbox` flag confines only its shell while its 57
in-process tools (its native file-write tool among them) walk around it entirely — the reason
`we:scripts/lib/antigravity-judge-spawn.mjs` seats it tool-FREE today — could the SAME `container` boundary
this item already proved for Codex's git-history problem also close Antigravity's write-safety gap, regardless
of its own internal sandbox being broken? Tested live tonight, not reasoned about.

**Setup, mirroring this item's own established pattern:** a real, disposable `container run --rm --cpus 2
--memory 2g`, exactly ONE host directory bind-mounted read-write (`-v <mount>:/workspace:rw`), nothing else —
no full repo, no host credentials. A first discovery worth recording on its own: Antigravity IS distributed as
a genuine Linux-native binary, not only the macOS Homebrew cask (`Mach-O 64-bit arm64`) this repo's other
records reference:

```
$ curl -sI https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.1-.../linux-arm/cli_linux_arm64.tar.gz
   HTTP/2 200
$ file antigravity   (after download + extract)
   ELF 64-bit LSB pie executable, ARM aarch64, dynamically linked, interpreter /lib/ld-linux-aarch64.so.1
$ container run --rm -v <mount>:/workspace node:20 /workspace/bin/antigravity --version
   1.2.1   (exit 0)
```

So "run Antigravity inside a container" is not blocked by an architecture mismatch, contrary to what the macOS
cask alone would suggest.

**The filesystem boundary test, run as root inside the guest (the container's default uid).** Every write
attempted outside the single declared mount — a guest-local `/etc` write, a `..`-above-the-mount write, a
fabricated host-shaped absolute path built fresh inside the guest, and (below) a malicious git hook — either
failed outright or landed ONLY in the guest's own ephemeral disk (wiped on `--rm`). Verified independently from
the real host after each run: a sibling secret file, deliberately never mounted, was byte-identical throughout,
and none of the guest-side canary paths exist anywhere on the real host:

```
guest: echo pwned > /etc/canary-write-test        → "WROTE to /etc"      (guest-local /etc, not the host's)
guest: echo pwned > /workspace/../escape-test.txt → "WROTE above mount"  (resolves to guest /, not host)
guest: mkdir -p /Users/<home> && echo pwned > .../canary-write-test.txt → "WROTE" (fresh path inside the guest)
host:  ls /Users/<home>/canary-write-test.txt     → No such file or directory   ← never reached the real host
host:  ls <the never-mounted sibling secret dir>  → not visible to the guest at all
guest: df -h                                       → only /workspace is the real virtiofs bind mount;
                                                       everything else is the guest's own isolated /dev/vdb disk
```

This holds regardless of which mechanism performs the write, because the boundary is enforced BENEATH the
process/syscall layer (VM-level), not by any per-tool or per-CLI permission check — the same structural reason
this item's 2026-09-11 amendment already gave for why a container contains a busy-spin loop that no admission
control or scanner can. The Antigravity binary itself carries no setuid/setgid bit and (so far as the minimal
test image's tooling could show) no special file capability — an ordinary unprivileged process, no different
from any other guest command tested.

**The specific write-relevance question this amendment was asked to answer: is the git-history leak (this
item's own 2026-09-11 finding, "a container does not close the doctrine-file leak") ALSO a write-escape route,
not just a read one?** Built the same deletion-clone signature this item's own prior amendment uses (a real
commit containing the doctrine file, then a plain working-tree delete — not `git rm` — leaving an UNCOMMITTED
` D` signpost so `HEAD` still holds the file), mounted it as the container's one read-write directory, and
reproduced the read leak first — `git show HEAD:<the doctrine file>`, run from inside the container, recovered
the full canary text, identical to this item's existing finding, now confirmed specifically inside Antigravity's
own execution environment (the Linux binary, not a bare `git` client). Then planted a `.git/hooks/post-commit`
hook designed to write outside the mount on every commit, and triggered it with a real `git commit` inside the
container:

```
$ git commit -q -m "trigger hook"
HOOK-FIRED: attempting to write outside the mount from a git hook
.git/hooks/post-commit: cannot create /Users/<home>/hook-write-test.txt: Directory nonexistent
hook ran with uid: 0
guest: cat /outside-via-hook.txt   → "hook-pwned"        (the hook's OWN write, inside the guest)
host:  ls  /outside-via-hook.txt   → No such file or directory   ← never reached the real host
```

**The hook DID fire** — git hooks execute with full process privilege, confirmed running as the same uid as
everything else in the guest — but its writes were subject to the identical VM boundary as any other write: one
landed only in the guest's own ephemeral filesystem (absent from the real host afterward), the other failed
outright because the target path does not exist in the guest at all. **Answer: no — git plumbing and hooks carry
no additional escape privilege beyond an ordinary process write.** The git-history problem is confirmed to be
purely a READ-side concern (recovering content that already lives inside the mount); there is no distinct
write-escape route through git internals that the general filesystem boundary above does not already cover.

**Network and auth (the sidecar/IPC question).** The real Antigravity backend domains — `antigravity.google`,
`gweb-jetski.appspot.com` (the `jetski` service named in `#3633`'s own stderr text), `accounts.google.com` — are
reachable over ordinary outbound HTTPS from inside the container with zero special network configuration; the
default `container run` networking already provides this, matching this item's existing
`api.anthropic.com`/`api.github.com` finding. No hole beyond standard outbound internet access is needed.
Separately: Antigravity's host-side auth lives in the macOS Keychain (confirmed via `security dump-keychain`:
service `gemini`, account `antigravity`), not a plain credential file under its own state directory — checked
directly, nothing token-shaped sits there. A Linux container guest has no Keychain, so an unauthenticated
headless run inside the container failed immediately and cleanly (`Error: authentication required. Run
'antigravity' to log in, then retry.`, `status: "ERROR"`) rather than silently inheriting or proxying host
credentials through any hidden channel. **No evidence of a sidecar/IPC route bridging host credentials or host
filesystem access into the guest was found** — the auth boundary held exactly as the filesystem boundary did.
This mirrors this item's own already-recorded Claude-Code-Keychain-auth finding (and the 2026-09-13 amendment's
host-side auth-proxy design immediately above), now confirmed for Antigravity specifically: a real deployment
still needs the same kind of auth-bridging mechanism (a host-side proxy, or a directly-injected token) before a
containerized Antigravity seat could run authenticated turns at all — real, separate engineering work, not a
reason to doubt the containment finding itself.

**One honest gap in this test, stated plainly rather than glossed over.** A live, fully-authenticated
Antigravity turn actually invoking its own native file-write tool end-to-end was NOT run, because doing so would
have required extracting the operator's real Keychain-stored Google credential into the throwaway container —
explicitly avoided per this session's "don't touch real credentials" constraint. What was run instead — raw
guest-context writes, and a fired git hook attempting the identical escape, both under the exact root-uid
unprivileged execution context Antigravity's own binary runs under, with that binary independently confirmed to
carry no elevated capability — is offered as strong, generalizing evidence rather than identical evidence. A
future test with a scoped, disposable Antigravity credential (not the operator's primary one) could close this
specific gap and should be preferred over further reasoning-only extrapolation if this ever gates a real
delivery-seat decision.

**Verdict, and the correction this adds to this item's own record.** A container DOES fully contain
Antigravity's write tools at the OS/filesystem level — every write attempted outside the single declared mount
failed to reach the host, regardless of the mechanism (raw syscall, git hook, and by direct generalization its
own native file-write tool and the other 56 in-process tools, none of which carry any elevated privilege). This
closes, at the deployment layer, the exact gap `#3633` found in Antigravity's own `--sandbox` flag (confines the
shell, not the in-process tools) — the reason `we:scripts/lib/antigravity-judge-spawn.mjs` seats it tool-free
today. The one caveat already on record here — the git-history leak — is now confirmed to be read-only in
nature; it is not a route past the write boundary. **Net: once container infrastructure exists for this item's
other reasons, a write-capable Antigravity delivery seat becomes safe to build on top of it, gated only on (a)
solving the Keychain-auth bridging problem above and (b) the one real gap this test could not close (a
genuinely live, authenticated native-tool write call) — not on the container boundary itself, which held in
every test run.**

## Amendment (2026-09-13) — operator confirms the recommended sequencing: defer until judge/provider integration graduates

Same discipline as the four amendments above — an operator-intent addendum only, ratifying nothing, changing
no status, resolving no fork, and **not stamping `preparedDate`**. This item stays `open`/unprepared.

The operator confirmed tonight that containers will likely be useful for resource management, but it is a
larger piece of work, so it should wait until the current judge/provider integration work (Codex/Antigravity/
model-probation, tracked on we:#3383) graduates. This is the same conclusion the 2026-09-11 amendment above
already reached in its own "Recommended sequencing" section — restated and confirmed here, not a new
judgment. If anything on this axis starts before that graduation, it should be the heavy-command container
pool named in that section, not per-lane containers. Recorded in full on the epic tracker,
we:backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md (operator note, 2026-09-13).

## Amendment (2026-09-14, later the same day) — the heavy-command-pool container POC extended: `test:unit` (vitest) now proven too

Same discipline as every amendment above: this records real code and real evidence, changes no `status`,
resolves no fork, and stamps no `preparedDate`. Tracked as a progress note on
`we:backlog/3383-a-background-mechanical-dispatcher-replaces-the-interactive.md` (see that item's own
2026-09-14 session update, second entry) rather than a new formal item, same convention as the amendment
directly above this one.

**What this closes from the prior amendment's own "still explicitly open" list.** That amendment named
`test:unit`/Playwright coverage as unstarted, the `frontierui`/`plateau-app` sibling-mount gap as open, and
image-build automation as manual-only. This slice closes the first two for `test:unit` specifically (not
Playwright — still unstarted) and adds real automation for the third:

- **The predicted blocker was real and confirmed empirically, not just inferred**: mounting the lane's own
  host-built (darwin) `node_modules` straight into the container — the shortcut that worked for
  `check:standards`'s pure-JS dependency closure — fails for `test:unit` exactly as predicted. `npx vitest run`
  inside a container with only the host `node_modules` mounted throws `Failed to resolve import
  "@frontierui/plugs/..."` and, separately, esbuild's own native binding never resolves (only
  `@esbuild/darwin-arm64` exists in the host tree; the guest needs `@esbuild/linux-arm64`).
- **The fix, measured**: bake a real LINUX-built `node_modules` via `npm ci` inside `node:22-alpine`
  (`we:scripts/lib/container-exec/Containerfile.test-unit-deps` — no compiler toolchain needed; every native
  optionalDependency in this lockfile — esbuild, rollup, swc, lightningcss, sharp, `@parcel/watcher` — ships a
  prebuilt `linux-arm64`/`linux-arm64-musl` binary; `npm ci` completes in ~15-20s), seed a named `container
  volume` from the result, then mount that volume at `<cwd>/node_modules` OVER the checkout's own rw mount — a
  more-specific-path mount genuinely shadows the parent bind mount for just that subtree (proven directly: a
  host-side stub `we:node_modules/marker.json` placed under the checkout mount is completely unreachable inside
  the guest once the volume is mounted on top, and a write the guest makes into the shadowed path never
  reaches the host — see `we:scripts/lib/container-exec.mjs`'s own "test:unit slice" header section and its
  test suite's real integration proof for the exact mechanism).
- **The second predicted gap, also confirmed and closed**: `we:vitest.config.ts` resolves `@frontierui/plugs`/
  `@frontierui/webtheme` to the sibling `frontierui` checkout (`we:vitest.shared.ts`'s
  `resolve(repoRoot, '../frontierui/...')`) — mounting that sibling directory read-only at its own identical
  host path (`we:scripts/lib/container-exec.mjs#frontieruiSiblingRoot`) fixes it. `plateau-app` was
  deliberately NOT mounted — it is a `we:vite.config.mts`/dev-server-only reference, never part of `test:unit`'s
  own import graph (confirmed by running the proof WITHOUT a plateau-app mount and getting a clean pass).
- **Real evidence, measured on this machine**: the same 35-file/441-test subset (`we:blocks/__tests__`) run on
  the host and inside the container (via `node we:scripts/readiness/heavy-admission.mjs run --container
  --container-node-modules -- npx vitest run we:blocks/__tests__`) produced IDENTICAL pass counts both times.
  The full suite (447 files / 12007 tests, ~9m48s on the host) was NOT re-run inside the container for this
  proof — a representative subset was used instead, matching this task's own explicit allowance, since the
  full run's wall-clock cost does not belong in a first-proof loop. The busy-spin CPU-cap containment result
  was independently reproduced a THIRD time under this exact node_modules-volume + sibling-mount
  configuration: 8 unbounded spinners held to ~191-204% aggregate host CPU inside a `--cpus 2` container vs.
  ~800% unconstrained on the host (8 separate `node -e` processes, each pinned at ~100%).
- **Image-build automation, partially closed**: `we:scripts/lib/container-exec/build-test-unit-deps.mjs` (new)
  builds the deps image, creates/seeds the named volume, stamps a lockfile-hash marker so a re-run is a cheap
  no-op when the lockfile hasn't changed, and reports `status` (image/volume presence + staleness) for a
  preflight. This is real automation for the ONE image this slice needs — it does not generalize to
  `check:standards`'s own image (still built by hand per the prior amendment) or to any future image, so "no
  image-build automation exists yet" is now only PARTIALLY true.

**Still explicitly open, not resolved by this slice:** Playwright coverage (unstarted — a different, likely
harder shape again, since it needs a real browser inside the guest, not just a Linux dependency tree);
`--container`/`--container-node-modules` are not wired as any default anywhere; the full `test:unit` suite was
not run side-by-side in the container (representative-subset evidence only, as stated above); `check:standards`'s
own image-build step is still manual; and the same `lane/mechanical-dispatcher` reconciliation risk the prior
amendment named is unchanged by this slice.

## Amendment (2026-09-14, later still) — three forward-looking requirements for the NEXT phase of this work, plus a live test of one of them

Same discipline as every amendment above — a requirements/evidence addendum only, ratifying nothing, changing
no status, resolving no fork, and deliberately NOT designing the full solution (that is real scoping work for
later, per the operator's own explicit instruction). Captured now, precisely, so nothing said tonight gets lost
to conversation. Triggered by the operator's own direct statement: *"we will need to use a container for the
heavy command soon. Have capacity reserved for it separate from lane capacity. Commands like vitest and
verify lane must use the correct parallelism to not overflow allocation and the cap 2 should be aware of what
each heavy command usage is."* That statement breaks cleanly into three distinct requirements, none of which
either `#2206` or `#2211` (the two container POC slices landed earlier tonight, see the two amendments directly
above) actually built — both proved CONTAINMENT works (a command runs correctly inside a capped container,
producing identical results), not CAPACITY PARTITIONING, INTERNAL-PARALLELISM CORRECTNESS, or an
INTELLIGENT ADMISSION POLICY. Checked before writing this in: grepped `we:scripts/` for any existing
implementation of a separate heavy-command resource pool, a container-aware worker-count derivation, or a
per-command-weighted admission cap — none exists; each of the three below is genuinely open ground, not a
rediscovery.

### Requirement 1 — reserved capacity for heavy-command containers, kept SEPARATE from lane capacity (two pools, not one shared budget)

A heavy-command container needs its own CPU/memory budget that does not compete with, or get counted against,
`we:scripts/lib/lane-concurrency.mjs`'s lane-concurrency cap (`DEFAULT_MAX_CONCURRENT_LANES = 8`, env-overridable
via `WE_MAX_CONCURRENT_LANES`). Today those are already two DIFFERENT counters
(`we:scripts/lib/lane-concurrency.mjs`'s lane cap vs. `we:scripts/readiness/heavy-admission.mjs`'s `DEFAULT_ADMISSION_CAP = 2`
heavy-command cap) — but neither is backed by an actual reserved slice of host CPU/memory; both are purely
COOPERATIVE counting semaphores drawing from the same undivided host resource pool. This is exactly the
"low-cpu lane containers + a separate heavy-command core pool" idea this item's own 2026-09-08 amendment
already floated in the abstract (see above) — this requirement makes it concrete and names it as a real,
needed piece of work rather than a still-open idea: whatever eventually runs heavy commands in containers needs
a resource reservation (e.g. a fixed CPU/memory slice carved out up front, or a hard ceiling enforced
independently of how many lanes happen to be open) that a burst of lane-orchestration activity cannot eat into,
and vice versa. Neither `#2206` nor `#2211` touched this — both ran a SINGLE container ad hoc, on demand, with
no notion of a standing reserved pool at all.

### Requirement 2 — a heavy command must configure its OWN internal parallelism to fit the container it actually runs in, not autodetect (or assume) the host's full core count

A command like `vitest` (`test:unit`) or `we:scripts/verify-lane.mjs`, when run inside a `container run --cpus
N` instance, must size its own worker/thread pool to fit within N — never oversubscribe its OWN container
allocation. This needs to be verified/fixed PER COMMAND, not assumed to already hold repo-wide.

**Live-tested tonight, on this machine, per the operator's own request for a real answer rather than an
assumption** — using `#2211`'s already-built container infrastructure directly (a fresh lane, `lane-20`,
acquired via `we:scripts/lane-pool.mjs` specifically for this test; the node_modules volume/image were already
built and fresh on this host):

- **Does Node itself see a container's real CPU allocation?** Mixed, and worth recording precisely rather than
  as a single yes/no. `container run --cpus 2 --memory 2g node:22-alpine node -e "os.cpus().length"` → **3**
  (an off-by-one, N+1 — matching this item's own 2026-09-11 amendment's earlier finding, now reconfirmed with
  `--cpus 1` → 2 and `--cpus 4` → 5, a consistent pattern, not a one-off fluke). But `os.availableParallelism()`
  — the newer, cgroup-aware Node API — correctly reported **2** for `--cpus 2`. So a command that reads the
  older `os.cpus().length` API gets a systematically wrong (inflated by one) view of its container's real
  allocation; one that reads `os.availableParallelism()` gets the correct, cgroup-limited number. Which API a
  given command's dependency chain actually calls is exactly the kind of thing that has to be checked per
  command, not assumed.
- **Does THIS repo's `test:unit` (vitest) actually use either API to size its pool?** No — and this is the
  more important finding. `we:vitest.shared.ts#maxTestWorkers` is a **hardcoded literal constant, `= 4`**, wired
  into `we:vitest.config.ts`/`we:vitest.maas-conformance.config.ts`'s `poolOptions.threads.maxThreads` and
  `we:vitest.integration.config.ts`'s `poolOptions.forks.maxForks`. It calls neither `os.cpus()` nor
  `os.availableParallelism()` at all — confirmed by reading the constant's own definition and every call site.
  It was deliberately sized (per that constant's own `#3650` comment, already in the repo, unrelated to this
  amendment) for the HOST's core budget under a documented worst-case assumption of **3 concurrent `vitest`
  invocations** racing past `we:scripts/readiness/heavy-admission.mjs`'s admission cap during its fail-open timeout window (3×4=12,
  "fully subscribed but never oversubscribed" — on the HOST). **That sizing has nothing to do with, and does
  not adapt to, any container it might later run inside.** Ran the real 35-file/441-test `we:blocks/__tests__`
  subset (the same subset `#2211` proved fidelity with) inside a real `--cpus 2 --memory 2g` container via the
  actual wrapper — `node we:scripts/readiness/heavy-admission.mjs run --container --container-node-modules --
  npx vitest run --config we:vitest.config.ts we:blocks/__tests__` — and it passed 35/35 files, 441/441 tests,
  confirming the pipeline itself works end to end. But the config value governing its worker count is still the
  same literal `4`, regardless of the `--cpus 2` the container was actually given.
- **The confirmed, specific instance of this requirement, stated plainly:** `test:unit`, run inside a `--cpus 2`
  container exactly the way a future heavy-command-pool default would run it, will request up to **4** worker
  threads against a container that only has **2** real cores — a genuine 2x oversubscription of the
  container's own allocation, distinct from (and not fixed by) the host-level oversubscription
  `maxTestWorkers = 4` was originally built to prevent. This is NOT the naive failure mode this requirement's
  own framing worried about going in (blind `os.cpus().length` autodetection of the HOST'S full core count) —
  that specific shape is already avoided by the existing hardcoded constant. It is a related but different
  gap: a fixed value tuned for one resource budget (the host, under a specific concurrent-invocation
  assumption) silently carried into a different, smaller, actual resource budget (one container's `--cpus N`)
  with no mechanism connecting the two. Diagnosed here, not fixed — per the operator's own instruction, fixing
  vitest's config to read its container's real allocation (e.g. via `os.availableParallelism()`, or an
  explicit `--cpus`-derived env var the wrapper could pass in) is real scope, better sequenced as its own
  follow-up once Requirement 1's capacity reservation is designed — a worker-count fix sized against an
  UNRESERVED container allocation would just be guessing at a moving target.
- **Not yet checked, flagged rather than assumed:** `we:scripts/verify-lane.mjs` itself and `check:standards`'s
  own internal parallelism (if any) were not tested this way tonight — only `test:unit`/vitest was, since it is
  the one with a real, already-discovered worker-pool config to inspect. Whoever picks this requirement up
  should check each named heavy command individually, not generalize from vitest's result alone.

### Requirement 3 — the admission cap should become resource-aware per command, not a flat cap-of-2 treating every heavy command as equal

`we:scripts/readiness/heavy-admission.mjs`'s own header is explicit that v1 is "an EQUAL-COST NAMED SET — every
heavy command consumes exactly one slot, none is weighted differently." The operator's direction tonight is
that this should change: the cap should know what each specific heavy command actually needs (e.g. `vitest`
plausibly needing more CPU/memory budget than `check:standards`'s pure-JS static analysis pass) rather than
treating every admitted command as an interchangeable unit. This is a real evolution of the semaphore model —
weighted/typed slots, or a per-command resource-cost table the admission logic consults — not a small tweak to
the existing flat-count code.

**This is not purely theoretical — a live instance of the SAME underlying "admission control does not actually
see what is really happening" gap was found and is being fixed separately tonight, worth citing here as
concrete, dated evidence rather than a hypothetical.** Confirmed 2026-09-14: `we:scripts/readiness/heavy-admission.mjs`'s slot
reentrancy is keyed by LANE PATH STRING, not process identity — so two genuinely different processes legitimately
verifying the same lane back-to-back (the conveyor's own auto-verify, then a manual re-verify after a new
commit landed) both get treated as "one slot" under that owner key, meaning real concurrent load on this host
was 3 processes while the gate reported a healthy 2/2. A fix for that specific reentrancy bug is separately in
flight this same session (not yet landed as of this note) — flagged here only as evidence that a cap-of-2
which cannot see what is really holding its slots is already producing real, measurable blind spots today, not
as a claim that fixing it resolves this requirement. Requirement 3 is the larger, forward-looking shape:
even a cap that correctly counts HOW MANY processes hold a slot still treats every one of them as costing the
same, which this requirement says should not remain true.

**Cross-reference, not merged into this requirement:** this item's own 2026-09-13 "Operator goal, recorded for
the record: make the lane-concurrency admission cap resource-aware instead of a flat count" entry (above, under
`we:scripts/lib/lane-concurrency.mjs`) is a SIBLING goal, not a duplicate — that one is about the LANE-COUNT cap
(how many lanes may be open at once) becoming resource-aware using accumulated `host.process.*` telemetry;
this requirement is about the HEAVY-COMMAND admission cap (how many heavy commands may run at once) becoming
aware of each named command's own resource footprint. Both point at the same underlying shift — flat counts
are a crude stopgap, real capacity should be measured/weighted, not counted — but they are two different caps
on two different resources, and should likely be designed together rather than one blocking the other, per
whoever eventually scopes this.

### Explicitly not decided or built by this amendment

None of the three requirements above is designed in any technical detail here, deliberately, per the
operator's own instruction that this needs proper scoping later rather than being designed or built now. Left
open: how a reserved heavy-command pool would actually be carved out of host resources (Requirement 1); how
each per-command worker-pool fix would read its container's real allocation, and whether that is env-var-based,
API-based, or something else (Requirement 2); and what shape a weighted/typed admission cap takes — a static
per-command cost table, measured telemetry, or something else (Requirement 3). This amendment does not stamp
`preparedDate` — it is a requirements capture, not a readiness claim.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
