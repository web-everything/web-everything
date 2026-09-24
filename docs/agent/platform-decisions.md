# Platform Decisions — the standing rules (statute)

This file is the **source of truth for cross-cutting platform rulings**: the reusable rules that
govern *how* the constellation is built, promoted out of the ratified decisions in `backlog/`.

**Two layers, one discipline:**
- **Case law** — `backlog/*.md` `type: decision` items. Each records *one* call and *why* (the
  deliberation, the forks, the lineage). Immutable history.
- **Statute (this file + the topical `docs/agent/*.md`)** — the *rule* a decision established,
  stated once, named, and citable. This is what you read and cite when a new question lands.

> **Why this exists:** a 2026-06-18 sweep of all 166 resolved decisions found **64% were
> "case-law-only"** — the rule lived *only* in its backlog file, so each new instance re-derived
> the same axis instead of citing it. The worst offender was constellation placement (10 decisions
> re-deciding one test). The fix is this file plus a promotion discipline, below.

> **⚖️ THIS DOC IS THE SINGLE SOURCE OF TRUTH FOR SETTLED ORIENTATION — read and cite _it_, not the
> backlog decision chain.** When you need to know *the rule* (a placement / naming / boundary /
> monetization orientation), read **this file** and cite the **named anchor**
> (`platform-decisions.md#<anchor>`). **Do NOT reason from, or cite, the `backlog/*.md` `type:decision`
> items (`#NNN`) unless you specifically need the _history_** — the deliberation, the forks, the
> lineage behind a rule. The case-law items are an **archive**, not the reference; a bare `#NNN`
> citation of an already-codified rule is a smell (swap it for the anchor). This doc **must be kept
> complete and current** — if a settled rule is missing or stale here, that is a **codification gap to
> fix** (promote/repair the rule in this file, per the discipline below), never a licence to fall back
> to citing the work item. `#NNN` is correct in exactly two places: this doc's own **`Lineage:`**
> footers, and when you *genuinely mean the historical call* (e.g. a reversal that supersedes it).

## How to use this file

1. **Before opening a new `type: decision` for a placement / naming / monetization / boundary
   question, check here first.** If a named rule covers it, the "decision" is just *applying* the
   rule — cite it, don't re-litigate. If the rule genuinely doesn't reach your case, the new
   decision records only the *novel* wrinkle and then extends the rule here.
2. **When you ratify a decision that establishes (or refines) a reusable rule:** state the rule in
   the relevant section here (or the topical doc), then set `codifiedIn:` on the decision's
   frontmatter pointing at it. The decision item keeps the lineage; this file carries the rule.
3. Rules are **reversible** (see [backlog-workflow.md](backlog-workflow.md) → reversibility). A
   reversal supersedes the rule here *with lineage* ("supersedes #NNN because …") — never erase it.
4. **Exception — the constitution tier is exempt from ordinary supersede-with-lineage.** A rule anchored
   inside the constitution tier ([#spec-is-schema-human-gates-spec](#spec-is-schema-human-gates-spec))
   cannot be superseded the way any other statute rule can; amending it instead goes through the
   entrenched ceremony that same anchor's clauses define — a conferring `POLICY_SPEC` (example) leash surface, a
   forge-stamped cooling clock, a committed record (docs/agent/backlog-workflow.md →
   *Constitutional-amendment ceremony*). Bullet 3's ordinary reversibility still governs every other
   anchor.

## Promotion discipline (enforced)

- `codifiedIn:` is a frontmatter field on `type: decision` items. Value = the guideline path that
  carries the rule (e.g. `docs/agent/platform-decisions.md#constellation-placement`), **or** the
  sentinel `one-off` for a narrow call that establishes no reusable rule (the analogue of
  `graduatedTo: none`).
- **Hard gate at resolve.** `node scripts/operations/run.mjs resolve --ref=<NNN>` **refuses a
  `type: decision` that has no `codifiedIn`**, and names the refusal `uncodified-decision` — pass
  `--codifiedTo=<doc#anchor>` (the operation stamps the field) or `--codifiedTo=one-off`. Mind the
  shape: the item is a `--ref=` flag rather than a positional, and the flag is camelCase where the raw
  `we:scripts/backlog.mjs resolve <NNN> --codified-to=…` spells it kebab-case. You cannot resolve a
  decision and walk away from its rule; the orientation is captured at the moment the deliberation is
  freshest, not in a later sweep.
- **`check:health` (`scripts/audit-backlog-health.mjs`) flag G6** is now the catch-up pool for the
  **legacy** decisions resolved *before* the gate existed. The count is the un-promoted backlog; it
  should only ever shrink. (New decisions can't add to it — the gate blocks them.)
- **Cite the rule, not the case.** When a work item leans on a settled orientation, link the **named
  rule here** (`platform-decisions.md#<anchor>`), not the originating `#NNN`. The decision file holds
  the lineage for an archaeologist; day-to-day work cites the statute so the rule, not the deliberation,
  is what propagates. A bare `#NNN` reference to a *codified* decision is a smell — replace it with the
  anchor.
- The full per-decision codification status is the register at
  `audits/2026-06-18-decision-codification-register.md` (regenerate via the
  `decision-codification-sweep` workflow).

---

## The standing rules

### The primary checkout is read-only; every change lands via a lane→PR {#primary-read-only-lanes-only}

The shared PRIMARY checkout of a constellation repo (web-everything / frontierui / plateau-app) is **read-only**:
no source, no content, no backlog-item creation, and **no direct push to `main`**. Every change — including new
backlog items — reaches `main` through a `lane/*` ref → PR → CI-gated merge, so *nothing lands on `main`
ungated* holds by construction. Coordination writes that need immediacy (claims/reservations) happen **in-lane**
(claim-in-lane, #2123/#2183), not in the primary. Enforced in depth: `guard-lane.mjs` (PreToolUse Edit/Write on
the primary tree), `guard-bash.mjs` (PreToolUse Bash — an agent-typed direct `git push` to `main`; `lane/*`
allowed; `MAIN_PUSH_OK=1` overrides), and a git `pre-push` hook for script-internal pushes (#2217). Ruled #2203
after a `/workflow` scaffolded items + direct-pushed them to `main`, landing an ungated `check:standards` error
that stalled the queue. (The one structural need — publishing scaffolded items so lanes can claim them — routes
through a gated lane→PR, #2215, never a direct push.) **4th arm (#2749, ratified 2026-07-28):** `guard-bash.mjs`
also denies a **build that writes the shared primary tree** — an `npm run build`, an `fs`-writing generator
script, or a redirect/`tee`/`sed -i` into a primary path, run at primary cwd. This closes the hole the
Edit/Write-tool guard (`guard-lane.mjs`) never sees: a `node` script that writes the tree via `fs` bypasses the
Edit/Write tools entirely. The backstop keys on the **tree-write**, never on session identity — so it is sound
for *any* session (main or a delivery subagent; both build in a lane, never in the primary), and it cannot wedge
a subagent's lane-scoped `check:standards` (which writes no primary tree). `MAIN_SESSION_BUILD_OK=1` is the loud
sanctioned one-off escape, mirroring `MAIN_PUSH_OK` / `LANE_GUARD_OFF`. The un-script-decidable half —
"this session is doing mechanical work it should have delegated" — has **no reliable ambient discriminator**
(reported Bash cwd resets to primary between calls, #2335), so it stays judgment per
[#deterministic-core-thin-judgment](#deterministic-core-thin-judgment) (#2607): enforced by absence (#2677) and
a **warn** nudge, never a hard gate on an uncomputable predicate.

### At the primary checkout, nested shell re-execution the guard cannot resolve is DENIED — and the deny-flip ships behind a quote-aware resolver, never before it {#guard-unresolvable-reexecution-denies}

**Stop enumerating the ways a command re-enters the shell; refuse the ones you cannot read.** The rule: at the
primary checkout, `guard-bash.mjs` must **deny** a command containing shell re-execution it cannot **fully**
resolve. A bounded scanner has exactly three ways to stop short of an answer — it exhausts its **recursion
depth bound**, it exhausts its **expansion-count bound**, or it meets **nested text its parser cannot
represent** — and under this rule all three are *unresolvable*, which is a deny, never a pass. Stopping early
is not the same as looking and finding nothing. Built as **#3002**; the concrete bound values and the
per-case tests live there, not here, because a bound is an implementation constant and this rule is not.
The posture — a component that cannot read its input refuses rather than waving it through — is the one
`we:scripts/lib/lane-verify.mjs` already takes with a corrupt verification marker.

Ruled 2026-08-08 after **six** review rounds, each of which closed one class of hole and uncovered another;
the sixth reviewer found the structural reason — the fuzz generator's wrapper list *was* the list of classes
the previous fix had implemented, so three million generated pairs could only re-prove what was already
handled. **An enumeration cannot be completed from inside the thing being enumerated:** a deny-list over shell
is unbounded, so the unknown case must fall closed.

**The ordering is part of the rule, not an implementation detail.** "Refuse what it cannot resolve" says
nothing about *who decides it cannot be resolved*, and that — not how often real re-execution happens — sets
the cost. Over the local session corpus a **quote-blind** scan flags substantially more calls for
re-execution or redirection than a **quote-aware** one does, and the excess is ordinary text misread — a
JavaScript `=>` or a `>` inside a quoted argument taken for a redirect, an fd-dup `2>&1` taken for a write,
a heredoc body taken for commands. *No over-flag percentage is carried here:* the ratio moves with the
token list used and no committed script reproduces it — see #3002 for the measured range and its
provenance. The **direction** is what this rule rests on, and it is not in doubt. So the deny-flip lands
**only behind** the quote-aware segment splitter (#2986 / #2994), never in front of it — tightening the
default on a parser that misreads ordinary text amplifies the false-deny problem instead of fixing the
security one.
**A guard may only be made more eager to deny in the same change as, or after, the parser that
makes its "I can't read this" honest.** After any such flip, **re-run the false-deny sweep** rather than
inheriting the prior estimate.

**The precondition is a capability, not a schedule — and never a pull request's state.** The flip is
permitted once a quote-aware splitter is *on `main`*: a condition you check by running the guard against a
command whose only re-execution token sits inside a quoted string and watching it clear. Whether some pull
request is open, bounced, re-armed or merged is not this rule's business, and no review label belongs in it —
those change by the minute and would make the statute wrong without anyone editing it. Same for the guard's
own internals: this anchor states the rule, and #3002 states what the code does about it.
Lineage: ruled by the operator as **R8**, 2026-08-08 → built as #3002 ·
measurement #3001 · #2749 (4th arm) · #2986 · #2994 · #2203.

### Constellation placement {#constellation-placement}

**The test — where does a thing live (WE / Frontier UI / Plateau)?**
1. Code that **defines a contract** (types, protocol, conformance vectors) **or is consumed by a
   WE-side conformance gate** (`check.ts`) → **Web Everything**. Code that **delivers a capability
   at runtime** (registry-dispatching, artifact-producing, a running handler — incl. `assert*`,
   constants, engines, native-default strategies) → **Frontier UI**. A served, credential-holding
   product → **Plateau**. **WE holds zero implementation — contract / protocol / interface only.** WE
   never hosts delivery runtime, not even as a "reference implementation." The former
   reference-implementation tier (a WE-repo reference runtime kept so WE conformance demos had something
   real to run) is **withdrawn** — it conflated the WE *website* with the WE *project*. A conformance
   demo is a **website** artifact: the WE-docs site is a downstream *consumer* that **surfaces FUI**
   (mode-C runtime bundle / `fuiDemo` iframe — [we-fui-embed-boundary](#we-fui-embed-boundary) rule 6),
   so it exercises **FUI's** runtime, never a WE-project copy. Delivery runtime
   (`fui:webpolicy/enforcement.ts`, block engines, parser/proof logic, …) is **FUI-canonical**; the WE
   project keeps the **contract + conformance vectors (data)** only. The `@webeverything` *package*
   stays types-only (rule 3); the source arrow is WE→FUI, never inverts. **The one runtime-ish thing
   that stays WE is conformance *tooling* a WE-side `check.ts` gate consumes** (e.g.
   `we:capability-manifest/check.ts` + its `assert*`) — it *checks* conformance, it does not *deliver* a
   capability, so it is interface/conformance, not implementation. **(#1566 bounds this: the carve-out
   covers tooling that checks WE's *own declarative artifacts* — manifests, golden-corpus
   completeness/schema-validity. A verifier that judges a running *implementation's* output is executable
   + neutral → Plateau, not WE; see [devtools-placement](#devtools-placement). **#1771 sharpens the
   bound:** a *generator that runs an implementation* over WE's own artifacts — e.g. a renderer that
   lowers `<component>` to emit committed source data — is itself implementation → FUI, even though its
   input is WE's own corpus. The carve-out is for declarative *checks* (schema-validity, completeness),
   never for *executing the impl* to produce data; that the impl runs at build time, in-repo, and is
   drift-tested does not make it tooling. The generated data stays WE only if WE no longer runs the
   generator — FUI runs its own transform and either commits the data or WE consumes it across the seam
   as data.)** **Interim state (honest):** a set of
   WE-resident logic reference runtimes predate this rule and **violated** it — the ~10 subsystems #1078
   covered. **webpolicy is the first fully relocated** (#1294 cascade W1–W4: engine → `fui:webpolicy/`
   #1799, binding + WE vector corpus #1800, plateau-hosted conformance docs surface #1801, WE runtime
   deleted #1802) — both gates that held the move are now cleared: a FUI home exists, and the WE-website
   conformance demo surfaces FUI *headless* logic through the **plateau-hosted conformance iframe** (the
   #899 vector-runner, built #1790/#1801, drives the WE vectors against the FUI binding cross-origin).
   **webcompliance (#1815) and webtheme (#1294 T5 #1910: runtime → `fui:webtheme/`, WE-side consumers —
   the reproduction-parity harness + the docs/CEM component-token resolver — repointed to the
   `@frontierui/webtheme` dev-time alias) have since reached the same #1282 end-state.** The
   **remaining subsystems** stay put **as tracked relocation debt** under this rule (the non-engine ones
   gated on the deferred conformance-model decision #1784), **not** a sanctioned standing tier — and
   crucially **no _new_ WE-resident delivery runtime may be added.** Relocation tracked by #1294; the rule
   is #1282. **#2006 extends this debt list to the WE *website*:** the 11ty+Vite render (`we:.eleventy.js`,
   `we:vite.config.mts`, `we:src/*.njk`, `we:src/_data/*.js` loaders, `we:src/_includes/*-descriptions/`,
   `we:src/assets/`) is artifact-producing delivery = a **mis-homed product**, not standard — ratified
   end-state is extraction to a product-tier surface (own repo / package, e.g. `webeverything-docs`)
   consuming the published standard as FUI does, **gated on #872**. **Interim classifier (#2006 Fork 2b):**
   the website files lift under a `site/**` root while the standard `.json` defs + shared assembler-loader
   seam (`we:scripts/lib/*`) stay classified in place, enforced by a **fail-closed `check:standards` rule**
   — every tracked path classifies as exactly one of {standard-surface, site-surface}; an unclassified path
   is a hard error, so new site code can never masquerade as standard. The conformance gate/tooling
   (`we:capability-manifest/check.ts`) is **not** part of the website and stays WE regardless.
   **#2053 bounds the #2006 website extension to the WE repo:** a reference-implementation library's
   self-showcase docs-site (FUI's Eleventy render, `fui:src/` + `fui:.eleventy.js`) is render-not-product
   and **co-locates in FUI** — artifact-producing code is what this rule routes *to* FUI, and the
   [product-frontend](#identity-semantic-look-composable) "WE website" product example does not reach it (the site
   composes no product) — provided the site surface stays cleanly separated from the library dirs;
   extraction re-opens only if the site grows genuine independent product features (#2053's reserved
   trigger, incl. a real abstract-framework/concrete-design-system repo split).
2. **The file seam is the cut:** `contract.ts` (pure types, compile-erased) → WE; `provider.ts` +
   `registry.ts` (runtime) → FUI. Split mixed modules *mid-file* at this seam.
3. **Distribution end-state:** FUI consumes WE contracts via a WE-published type-only package
   (`@webeverything/contracts`, one entry per subsystem); byte-replication is the interim. The
   contract crosses the seam; code never does. `@webeverything` = standard artifacts only, never
   imports FUI.
4. **Managed offerings decompose** across the constellation — there is no single "home" decision:
   standard→WE, primitives/adapters→FUI, served product→Plateau, open-core by usage.
5. **An impl/substrate is not a standard** (e.g. a native `base-select`): it registers as a
   `capabilityMatrix` resolver impl, not a new protocol; the work it implies is a deferred build.
6. **Relocating the runtime does not retire the WE project that owns the contract.** When a
   standard/impl split moves a subsystem's *runtime* to FUI (the #606 move), the WE project
   *survives* on its contract surface (spec page + interface defs + conformance) — you reconcile its
   status drift, you do not delete it. A project whose surface ships as **spec + data defs** (not a
   `relatedProject`-tagged resolved item) can read as `concept` despite being live; bump it **off**
   `concept` (`poc` is the convention — project `status` is not enum-validated; the `LIFECYCLE` set
   governs *descriptors*, not projects). *Retire* is only on the table if WE owns **no** contract
   surface distinct from the moved runtime.
7. **The public compat table lists every impl as a peer — no privileged/reference column.** The
   `capabilityMatrix` catalog (capability-row × impl-column, rendered publicly) broadens from native
   substrates to incumbent libraries (Floating UI, Mousetrap, TanStack, FUI, …); **FUI is one column
   like any other**, its strength *earned and visible* (greenest column), never status-declared. No
   "reference / recommended impl" column — that reintroduces the single-lib perception the table
   exists to dispel and conflicts with minimize-lock-in. An adoption pointer, if wanted, lives in
   clearly-editorial getting-started prose, not the neutrality grid (matches BCD / caniuse /
   wpt.fyi / OpenFeature). Ruling #1450.

8. **Relocate at the granularity of dependency-readiness; a relocated module never reaches back.**
   {#relocation-granularity} When moving impl WE→FUI, relocate every piece whose cross-family deps are
   *already FUI-satisfiable now*, and defer **only** the pieces whose deps are *not yet FUI-resident* —
   as an explicit `blockedBy` slice on the dep's own relocation, never as "keep it WE-resident for now".
   Keeping a piece in WE "until later" leaves a **live WE-resident value-import**, so the relocation
   resolves *without* clearing the downstream blocker it was supposed to clear (a false unblock). A
   relocated FUI module satisfies a lagging dep by **(a)** using FUI's own equivalent (e.g. its canonical
   renderer/util), **(b)** inlining a small pure util, or **(c)** deferring that one feature — **never**
   by importing back into WE (a FUI→WE backward edge, the same ban as the runtime boundary). Pre-flight
   the *full* import graph before scoping: the "only dep is X" claim from a partial read is a hypothesis,
   not a plan. #1777 (upgrader family: `serve()` deferred to #1730 via #1781; `jsxToHtml` rewired to FUI's
   own via a browser-safe subpath; `compareSpecVersions` inlined — all kernel pins removed, clearing #1775).

*Soft sub-rule — locus tagging:* backlog items carry an explicit `locus:` field (WE / frontierui /
plateau-app / exercise-app); items gate in their own locus so cross-repo batches stay locus-agnostic.

**Lineage:** #730 #817 (the per-file define-vs-deliver holding) · #606 (plugs runtime → FUI) ·
#1248 (relocating the runtime does not retire the contract-owning project — `webplugs` survives #606) ·
#641 (block-protocol impl boundary) · #779 #426 #799 #497 #834 · #804 #872 #239 (contract package) ·
#091 (managed-offering decomposition) · #020→#291 (impl-is-not-a-standard) · #1078 (introduced a
WE-resident reference-implementation tier — **superseded by #1282**: conflated WE-website with
WE-project; WE holds zero implementation) · #1246 (blocks → FUI, reverses #697) · #1282 (**withdraws
the reference-implementation tier wholesale** — webpolicy + all delivery runtimes → FUI; WE = contract +
vectors only; demos are a *website* concern that surfaces FUI) · #1771 (**sharpens the #1566 carve-out
bound** — a generator that *runs* an impl over WE's own artifacts is impl → FUI, not tooling; resolves the
MaaS serve-core seam as a forced mapping, reversing #954's "WE runs `serve()`", unblocking #1730) ·
#1777 (**relocation granularity** — relocate deps-satisfiable-now, defer not-yet-FUI deps as `blockedBy`
slices, never reach back into WE; see [relocation granularity](#relocation-granularity)).

### Backlog tracking: one record of truth with locus-filtered views now, distributed per-repo as the destination {#backlog-tracking-locus-now-distributed-next}

**Ratified 2026-09-06 by the operator (Nicolas Gilbert) (#3129).** Where a constellation repo's backlog *lives*
is a different question from where its *code* lives ([#constellation-placement](#constellation-placement)
governs the latter and does not reach this). Two rulings, and the second is the load-bearing one:

- **Now — one record of truth, per-repo views are filtered, not separate.** Web Everything's `backlog/*.md` is
  the single tracker. A per-repo surface is a **locus-filtered virtual view** (`item.locus === slug`) over it —
  no second `backlog/` directory, no second numbering authority, no migration. Cross-repo landing keeps the
  already-proven #500 shape: the build lands in the target repo's own PR, and a thin mechanical "WE resolve"
  step flips the tracking record. This is the interim, and it is what runs today.
- **Destination — fully distributed, each repo owning its own backlog.** Not a rejected alternative and not a
  "someday": the declared end state. The ground is **product shape, not our own convenience**. A single central
  tracker every repo routes through assumes one org owns everything and never hands a repo over; for a customer
  with **dozens of repos whose ownership moves between owners**, that assumption fails — a repo changing hands
  either strands its history in a tracker the new owner cannot see, or forces a migration. A repo and its
  backlog are the same artifact and must move together. **Scale is the consumer**: the earlier "no evidenced
  need for repo autonomy" reading measured our own three-repo constellation, which is the wrong population for
  a product built to manage enterprise front-end platforms.
- **Therefore an item id always carries its locus, and that moves FIRST.** A bare `#NNN` is an implicit `we:`
  today — true by convention, never by construction. Locus-qualified ids (`we:#3423`, `fui:#118`) are the
  correct shape and are adopted **always**, not only once distribution lands: the ambiguity already exists, and
  making it explicit now converts a single all-at-once migration on the day distribution ships into an
  incremental, reversible one. The additive half — *accept and resolve* an explicit locus while a bare `#NNN`
  keeps meaning `we:` — comes first and alone; minting new ids with a locus, and migrating the corpus, are
  separate later slices. The `LOCI` registry (`we:scripts/check-standards-rules.mjs`) stays the single locus
  vocabulary; a second list is the drift class #1473 had to rewire. An id locus (`we:#3423`) and a **code-path**
  locus prefix (`we:scripts/x.mjs`) share a spelling and are different things — whatever parses one must not
  silently accept the other.

**Ordering is deliberate and is part of the ruling:** the destination is **not deferred and not parked**. Its
first slice is an ordinary ready item to take when there is capacity — not urgent, and not conditional on
#2456's evidence gate, whose ground this ruling narrows.

**Lineage:** ratified by #3129 (operator, 2026-09-06), carved out of #2475 during its build-readiness prep.
Confirms rather than overrides #2472's own premise ("each repo holds its own `backlog/*.md`") — the epic was
right about the end state and imprecise about the timing. Composes with #500 (the shipped cross-repo
landing/gate registry, which supplies the interim's landing half) and is **new turf**: the prep's statute pass
found no existing anchor governing backlog-*data* placement, so this one mints rather than extends —
[#constellation-placement](#constellation-placement) (code implementation),
[#repo-drain-check-contract](#repo-drain-check-contract) (the drain's CI boundary) and
[#pool-siblings-real-built-clones](#pool-siblings-real-built-clones) (lane checkouts) govern disjoint turf by a
different test. First slice: `#3533`.

### WE ↔ Frontier UI rendering & embed boundary {#we-fui-embed-boundary}

**WE never imports or renders FUI block code.** FUI owns the implementation *and* its rendered
display (its own site + demos, FUI branding).
1. **iframe-only:** WE embeds FUI-hosted demos via the `fuiDemo` iframe convention — no
   `frontierui` Vite alias, `@frontierui/*` never in WE `node_modules`. Cross-repo *import* is ruled
   out.
2. **Narrow relaxation (sanctioned, gated):** a future trust-gated, WE-FUI-only, runtime-SDK,
   Shadow-DOM-isolated **mode C** is allowed; it does not puncture impl ownership (FUI still
   renders) — only the iframe *mechanism* requirement relaxes. iframe stays the default.
3. **Escape/overlay** (modals breaking the iframe box) is host-side over an origin-validated
   `postMessage` channel via a **FUI-owned embed SDK**; seed transport is URL-canonical + additive.
4. **No block runtime in WE (#1246, reverses #697):** **every** block's runtime is FUI-canonical —
   *none* stays in WE, not even one whose demo exercises a WE standard. (This is the rendered-UI
   instance of the general rule in [constellation-placement](#constellation-placement) rule 1 — *WE
   holds zero implementation*, #1282.) Its demo is
   **FUI-hosted and iframe-embedded** (or consumed as a mode-C runtime URL-bundle per rule 6); WE owns
   only the block **protocol + conformance vectors** (#817/#899, data not impl). The former "stays in
   WE *iff* it is the standard's reference runtime" partition is **withdrawn** — the headline above
   ("WE never imports or renders FUI block code") now holds without exception.
5. **Chrome / workbench is FUI-owned**, decoupled from distribution; WE keeps only its
   standards-panel overlay.
6. **The WE *website* ≠ the WE *standard*.** The boundary constrains the *standard artifacts* and
   the *`webeverything` package* (no FUI **source** dependency; unidirectional WE→FUI) — **not** the
   WE-docs *website*, which is a downstream product/consumer free to render FUI **and** to run WE
   standard runtimes (e.g. booting the webbehaviors `CustomAttributeRegistry` in a mode-C shadow
   mount), exactly like any app. The test is **source-dependency direction, not runtime execution or
   rendered pixels**: a consumer page running FUI impl + a WE standard together is the dogfood, not a
   crossing. The one guard — the site consumes FUI by **runtime URL bundle** (mode C), *never* a
   build-time `import '@frontierui'` into its build; that import would invert the direction (#700/#239)
   and is the only thing that actually violates the boundary. So "does running a WE runtime in-document
   cross the boundary?" is answered *no* by construction — don't re-open it.
7. **Mount-model selection (#1621):** within a consumer page (rule 6), pick the mount by the component's
   nature, not one-size-fits-all. **Heavy / interactive / trusted** embeds → **mode-C** (one shadow root +
   one dynamic `import()` per mount point, `fui:embed/in-document.ts`) — e.g. the #865 chrome shell.
   **Many-small, behavior-free, server-rendered** components (a board of hundreds of pills) → the FUI
   **transient custom element** (`registerBadge()`-style, §7.7 of block-standard.md): register the element
   **once** via a runtime cross-origin import from the FUI origin, emit `<we-*>` server-side, let each
   upgrade in place (light-DOM, no shadow root, no per-instance import); inject the block's exported CSS
   (`BADGE_CSS`-style) globally and ship a `we-*{}` SSR baseline to kill the upgrade flash (the #865
   baseline pattern). Per-instance mode-C for many-small pills is **rejected** (N shadow roots + N imports
   per page). Cross-surface categorical styling resolves through design tokens + the taxonomy provider
   (#1670), never per-component palettes. **Applied (#1748):** the *published* WE-docs backlog-pill board
   loads this way — a FUI-served `fui:embed/badges-in-document.ts` entry registered via a second
   cross-origin `import(...)` in `we:src/_layouts/base.njk` (alongside the #865 chrome import at :418) +
   the `we-*{}` SSR baseline. Confirms there is **no #872/#907 publish gate** for this: the docs consume
   FUI by the already-live `links.frontierUrl` origin (URL bundle), not an npm package. Bundling the FUI
   package into the docs build was rejected as the lone rule-6 violation. Build: #1758.

**Lineage:** #604 #701 #707 (iframe boundary; "WE renders real FUI blocks" is mis-framed) · #700 ·
#1621 (rule 7 — mount-model selection: transient CE + cross-origin import for many-small server-rendered, mode-C for heavy/interactive) ·
#1748 (rule-7 applied to the published WE-docs pill board: cross-origin import from `links.frontierUrl`, no publish gate; build #1758) ·
#1246 (withdraws the rule-4 reference-vs-impl partition + reverses #697: no block runtime stays in WE) ·
#1282 (general rule — WE holds zero implementation; demos are a website concern that surfaces FUI) ·
#705 · #732 (escape SDK) · #765 (mode-C relaxation) · #788 (seed transport) · #791 (reference-vs-impl
partition) · #809 (workbench locus) · #932 (website≠standard; consumer may run WE runtimes in-document).

### SSR external I/O is a language-agnostic WE standard; renderers conform behind the wire-format seam {#ssr-external-io-standard-renderers-conform}

**A rendering surface's *externally-observable I/O* is a WE standard; the *renderer* that produces it is a
conforming, swappable impl.** The instance of [WE #6](#constellation-placement) for server-render/SSR
(#2030, under #1971/#2005). Split every rendering decision by one test — *can anything outside the render
boundary observe the difference?*

1. **Observable ⇒ WE standard.** The emitted wire format (marker grammar, `data-key`, state-token layout),
   the zero-JS baseline, and the client hydration handshake are pinned in the WE standard
   (`we:src/_includes/project-webdirectives.njk`) **precisely enough that a renderer in any language
   produces conformant output the single client hydrates identically.** New observable I/O is codified into
   WE, never settled per-impl.
2. **The wire format is the swap seam.** One client hydrates *any* server's output because all servers
   emit the identical standard. A Go/Rust/PHP/JS renderer is a drop-in behind the same client — there is no
   per-language client.
3. **Conformance vectors are WE-owned data, not impl** (the `#817/#899` protocol-plus-vectors pattern): a
   fixture set `(input tree + data) → exact expected HTML bytes` (markers incl. space-padding, `data-key`,
   state tokens). **Every** language's renderer passes the same vectors; that — not code reuse — is what
   makes renderers interchangeable. A **reference renderer** (Node first) defines the vectors and is their
   oracle; later languages validate against them.
4. **Render internals are a per-impl black box.** How a given server builds the tree before emitting the
   fixed wire format (DOM shim, string concat, template engine) has no external observer — each impl (and
   each language) may choose differently and swap later behind the seam; only the emitted bytes are fixed.
   A JS-only trick (e.g. reusing the client's DOM stamp logic via a server DOM shim) is a legitimate
   *reference-impl* choice but confers no cross-language rule.
5. **Per-impl ≠ standard change.** Escalating an internal encoding to something observable (e.g. moving
   state from in-marker tokens to a `<script type="application/json">` side-channel) is a *standard*
   amendment (+ vector update), not a silent per-impl move.

**Lineage:** #2030 (foundational call — the five prepped "forks" collapse: four are conforming black-box
impl, the external I/O is the standard) · #1971/#2005 (webdirectives SSR epic + foundational surface) ·
#817/#899 (protocol-plus-vectors, data-not-impl) · #1282 ([WE holds zero implementation](#constellation-placement)).

### Catalog tiles adopt `<we-card>`/`<we-badge>`/`<we-tag>` by-intent; relocate the anchor outward {#catalog-tile-by-intent-mapping}

**A docs catalog tile maps to FUI block vocabulary by-intent — never a bespoke palette wrapped in a
cosmetic card shell.** This is the card-frame instance of [we-fui-embed-boundary](#we-fui-embed-boundary)
rule 7 + the #1621 badge/chip ruling: a tile's status pill → `<we-badge>` (the #1319 Status-Indicator
intent), its dimension/type chips → `<we-tag>` (the Tag intent), and the tile frame → `<we-card>` — all
server-emitted `<we-*>`, upgrading in place. A frame-only "shallow wrap" that leaves the bespoke
badge/chip vocabulary inside is **rejected**: it re-introduces the docs-palette-on-a-shared-component
conflation #1621 retired, and buys nothing — see the anchor mechanic below.

**The anchor-relocation mechanic.** `<we-card>` resolves to a non-linkable `<article>` and
`replaceChildren`-es the original node (`fui:blocks/card/CardElement.ts`, `excludedAttributes =
['title','heading-level']`). So when the tile **is** a single click-through `<a>` (the `we:src/intents.njk`
/ `we:src/blocks.njk` pattern: `class` + `data-status` + `data-haystack`/`data-search` + `href` on one
element, queried directly by the per-page filter IIFE), preserving click-through requires **relocating**
the `<a>` + filter `data-*` + tile class to an *outer* anchor wrapping the `<we-card>`; the filter JS then
queries that outer anchor. This relocation is unavoidable **even for a frame-only swap**, which is why the
shallow wrap is strictly dominated (same relocation cost, zero intent dogfood, statute violation). The
filter mechanism stays attribute-driven off `data-*` — it never reads a card model.

**Non-anchor surfaces carve out.** Structurally-distinct catalog surfaces get their own by-intent rulings,
not this one: `we:src/design-systems.njk`'s non-anchor `<div>` tiles (no click-through, no relocation) and
the `.status-meter` *bar* macro (`we:src/_includes/project-status.njk`, a status-bar not a pill). Folding
them into one "tile→card" rule re-merges surfaces #1319 split.

**Lineage:** #1820 (this ruling) · #1621 (`<we-badge>`/`<we-tag>` map-by-intent precedent) · #1319 (the
status/tag vocabulary split into owning intents) · #1786 (`<we-card>` embed wiring) · unblocks #1607 (the
three core catalog pages) + #1608 (the 14 `project-*.njk` includes).

### Dev-tool placement: the consumer test {#devtools-placement}

**Where does a dev/test tool live across the constellation?** A user ruling — *dev-tools belong in
Plateau, not FUI* — does **not** mean "move every tool." It **refines** [constellation-placement](#constellation-placement)
into **one positive test**, the *consumer* of the surface (the same axis as
[conformance-verifier-vs-subject](#we-fui-embed-boundary) / #1467):

> **A developer-operated surface a human runs — to inspect / switch / explore / configure an
> implementation, against your OWN build — is a developer *product* → Plateau.**

The other buckets:

1. **Conformance — split by *what runs* (amended 2026-06-22, #1566).** The earlier "reads output as
   DATA → stays WE (a verifier implements no standard)" reading is **overturned**: judging is
   executable, and WE holds **zero executable** (#1282). Split three ways:
   - **The conformance *contract* — the verifier *interface*, the vector/golden **corpus**, and the
     golden/vector **schema** (declarative data) → stays WE.** The standard owns the *definition* of
     conformance — the WPT/Test262 expected-files archetype. Per #1467/#817 and rule 1 of
     [constellation-placement](#constellation-placement).
   - **The verifier *implementation* (the code that judges a running implementation's output) and the
     conformance *run* → Plateau** (#1566). **Neutrality** — the reason the verifier cannot live in FUI
     (the contestant) — is preserved by **Plateau** (a non-implementer product layer; the home of the
     #427 conformance dashboard / #1577 explorer product), not by WE. The implementation under test is
     reached through a per-target **binding** its owner ships (FUI is one target among many).
   - **Carve-out (unchanged):** conformance tooling a WE-side `check.ts` gate consumes to check **WE's
     own declarative artifacts** (e.g. `we:capability-manifest/check.ts` + `assert*` over the manifest;
     golden-corpus completeness/schema-validity) **stays WE** — it checks WE-owned *data*, needs no
     external implementation, delivers no capability. #1566 moves only the verifier of an
     *implementation's runtime output*, which WE cannot run once the impl is deleted.
   - **Load-bearing constraint:** the conformance *rules* must be expressible declaratively in WE (the
     interface + schema) so Plateau's verifier is a faithful *interpreter*, not the *author* of "what
     conformance means."
2. **Build-time implementation transform / reference-impl generator** (codegen, CSS lowering, bundler
   plugins, serve-time impl) → **stays FUI.** Per impl-is-not-a-standard (#020/#291).
3. **Operator-facing surface run against your own build** (workbench chrome¹, spec/dev-panel,
   autonomous-explorer CLI chrome, configurators, dev-browser, mock-server) → **Plateau.**

**Two carve-outs the blanket reading gets wrong** (both ratified under #1565):

- ¹ **The block-explorer / workbench stays FUI** — it is *impl, not a tool*. It ships as an embeddable
  `<iframe>` distribution showing *how FUI is consumed* on third-party / customer sites (chrome + block
  intra-frame, **no postMessage protocol**). Routing it through Plateau re-introduces the cross-origin
  boundary [#809](#we-fui-embed-boundary) (rule 5) dissolved — same-origin only holds *on plateau.app*.
  The distinguishing **third-party-embed test**: *ships embedded on customer sites = FUI distribution;
  runs against your own build = Plateau dev-tool.*
- **A conformance ENGINE splits into contract / impl / binding / product (amended 2026-06-22, #1566).**
  The generic vector-runner + trace-judge **interface** + the vector corpus is the standard's
  implementer-agnostic **contract → WE** (it must define how *any* WE implementer is tested). The runner +
  judge **implementation** (the executable engine) → **Plateau** (#1566 — neutral, non-implementer; the
  home of the #427 dashboard / #1577 explorer product). The per-target **binding** that drives a concrete
  implementation is the **subject adapter → the implementer** (FUI ships its own; a customer ships theirs).
  Layer-3 vision → Plateau ([#475](#no-leakage-client)). This **re-points #1565's** autonomous-explorer
  split: engine **interface** → WE, engine **impl** + product CLI chrome → Plateau (#1576/#1577), bindings →
  each implementer. Distinct from [reproduction-conformance](#reproduction-conformance)'s *deterministic-diff*
  engine (#1225), which is FUI (it diffs FUI's own reproductions, not a cross-implementer conformance suite).
- **The autonomous explorer is a closed Plateau PRODUCT — engine included (amended 2026-06-24, #1747).** The
  explorer (the autonomous browser-driving *tester*: `playwrightDriver`, heuristic oracles incl.
  `genericInvariants`, harnesses, `stateFlowGraph`, `gate`, CLI, report-bundling) is **not** the standard's
  verifier and **not** the reference impl — it is an operator-facing surface you run against your own build
  (rule 3), and being generic (it tests *any* app) makes it product value, not adoption bait. So the **whole
  tool → Plateau, closed-source** (#1577; free/paid on the assembler model #775; open-sourcing later is
  Plateau's option). This corrects the earlier "engine stays FUI / only chrome moves" reading: FUI does **not
  consume** the explorer (it imports zero explorer code — it is only a browser *subject* the tool points at),
  so nothing forces the engine to stay FUI. **WE keeps exactly one artifact: the explorer result/output-format
  interchange schema** (#1769 — SARIF-compatible core + extension slot, per #1467; temporal rule met by
  convergent prior art — SARIF / axe / Lighthouse) so other tools and CI can consume explorer output without
  depending on the closed product. A *different* engine from the conformance engine above — the #1747 finding.

**Embed mechanism *inside* a Plateau dev-tool (#1654).** Once a tool is placed in Plateau, how it mounts
its *own* surfaces is a trust/origin question, not an iframe-by-default one. A Plateau dev-tool's chrome and
its own same-bundle, same-origin trusted panels (e.g. the **dev-browser shell** mounting plateau-app's
Technical/Intent Configurator + Profiles via `mount*(el)`) use a **direct in-process import** — an iframe
there is pure tax *and* would forbid the DevTools-style docked-chrome control that is the point of the tool.
iframe + origin-validated `postMessage` (the [we-fui-embed-boundary](#we-fui-embed-boundary) bus) is reserved
for genuinely **cross-origin / untrusted** surfaces. The **app under test** the dev-browser loads is *not*
such a web iframe: per [#141](../../backlog/141/) the dev-browser is a **Chromium/extension** shell, so the
loaded app is a real privileged page introspected via the source-awareness substrate (#562) + live-patch
(#410) — a privileged-introspection boundary, not a `fui-embed` channel.

**The "every developer tool → Plateau" reading is *mostly* right, with one WE residual:** the conformance
**contract** — the verifier *interface* + the vector/golden corpus + schema (declarative data) — stays in
the standard layer (#1467/#817, [constellation-placement](#constellation-placement) rule 1). What moves to
Plateau is the verifier **implementation** + the **run** (#1566); what stays FUI is the per-target
**binding**. The only thing the blanket reading still gets wrong is dragging the *contract/vectors* out of WE.

**Lineage:** #1565 (ratified 2026-06-22; research topic `/research/devtool-placement-constellation/`);
**amended by #1566** (ratified 2026-06-22) — verifier *implementation* + conformance *run* move WE→Plateau;
WE keeps the declarative *contract* (interface + vectors + schema) only; this overturns the prior "verifier
stays WE" carve-out and re-points the engine split above. Composes
[constellation-placement](#constellation-placement), [we-fui-embed-boundary](#we-fui-embed-boundary)
(#809), [no-leakage-client](#no-leakage-client) (#475), [reproduction-conformance](#reproduction-conformance)
(#1225), and `project_conformance_verifier_vs_subject` (#1467, amended). Unblocks #1553.
**Refined by #1654** (ratified 2026-06-23) — the embed-mechanism rule above: a Plateau dev-tool's own
same-bundle trusted panels mount by direct import; the dev-browser's loaded app is a privileged-introspection
boundary (#141/#562/#410), not a web iframe. Unblocks the #1391 `S5` panel-embed slice.

### Non-verdict conformance compares by a closed matcher vocabulary {#non-verdict-conformance-matcher}

**A relocated runtime whose conformance output is *not* a verdict does not get a new conformance model — it classifies onto one of the two suite shapes WE already ships and picks a comparison matcher.** The two shapes: the interaction-script `ConformanceVectorSuite` (`we:conformance-vectors/schema.ts`) for provider/behavioral surfaces, and the Doc-Spec golden suite (#1163, `we:conformance-vectors/webdocs.vectors.ts`) for pure `(input)→output` transforms. The comparison is a **closed four-member matcher set**, carried as a per-`expect`-key tag in the WE schema and interpreted by the Plateau judge:

1. **`exact`** — strict `===` (today's default; scalars, e.g. webcompliance `violationCount`).
2. **`deep-equal`** — structural equality (object returns: webtheme's resolved token map, reliability `RecoveryResult`).
3. **`resolved-options/parts-structure`** — assert `resolvedOptions()` + `formatToParts` part types/order, whitespace/separator classes as equivalence classes (intl `Number`/`DateTime`/`RelativeTime` — never raw strings, which drift with host ICU/CLDR).
4. **`predicate`** — a boolean over the observed surface: contains / subset / count / absence / sign-order (analytics' `void`-returning recorded-call log; `Intl.Collator`, which has no `formatToParts` — assert `compare()` sign + sort order).

The set is closed and exhaustive over what these runtimes emit; widening it is a fork to re-open, not a default. **Placement** (composes [constellation-placement](#constellation-placement), [we-fui-embed-boundary](#we-fui-embed-boundary)): the contract + vector/golden corpus + the `matcher` vocabulary stay **WE**; the per-key matcher **dispatch** in the judge is **Plateau** (`plateau:src/conformance-engine/conformanceVectors.ts`, today hardcoded strict `!==` — the seam does not yet exist); the per-target binding is the **FUI** subject. No new WE→FUI code edge; #1282 (WE holds zero executable) holds. **What this is NOT:** not strict-equality-only (false-negatives for intl and all object returns), not per-shape binding judges (driver proliferation — a matcher is a comparison *tag*, not a new driver).

**Lineage:** #1816 (ratified 2026-06-27; research `/research/non-verdict-conformance-model/`, report `we:reports/2026-06-27-non-verdict-conformance-model.md`; parent #1294). Two-pass red-team widened the set from three to four (`predicate` added for analytics + collator) and pinned webtheme's subject to the `resolveTokens` map, not `compileToCss` text. Complements #1784 (facts→verdict KIT) · grounds #899/#1789 (vector model + binding) · #1163 (golden precedent) · #404 (webtheme) · #1282 (zero-executable). Build mechanism: #1847.

### Is it a Project / Protocol — or just an intent? {#project-protocol-bar}

**Not every gap is a Project or a Protocol.**
1. Mint a **Protocol** only when independent vendors must conform to one contract — i.e. there is a
   real **provider seam** *or* an **interchange schema**. Otherwise it is an intent + block.
2. Mint a **Project** only for a genuine cross-cutting domain with orchestration. "Already homed in
   an existing project" is a valid resolution — do not spawn a project per homed gap.
3. **Temporal rule:** ship as a Block now; extract a Protocol only once a *second* independent impl
   exists and the contract has stabilised.
4. A paradigm with no provider seam and no UX dimensions is a **semantics term**, not a
   protocol/intent.

**Temporal-rule clarification — "a second independent impl" counts _external convergent_ impls, not only WE-internal ones (#1437).** Rule 3 exists to avoid freezing an *unvalidated* contract; for an **interchange schema** (not a provider seam) that validation can come from **convergent prior art in the world**. When N≥2 independent incumbents already emit the same shape (dockview / FlexLayout / golden-layout all serialize a `row→column→stack-of-tabs` tree), the temporal rule's "second impl + stabilised contract" precondition is **already met** — mint the **core schema now + an open extension slot** for the parts that still diverge (don't wait for WE itself to ship two impls). The deck case (#1175) is the contrast that proves the rule: it got "no protocol" precisely because it had **no** convergent external interchange schema. Caught when a decision-turn flip to "protocol-later" mis-read the rule as requiring WE-internal impls; the skeptic refuted it.

**Lineage:** #015 #016 #011 #014 #409 #616 #634 · #041 (protocol-extraction timing) · #258
(paradigm → semantics) · #020→#291 · #1175 (deck placement: a deck is composition, not a domain —
no `webdecks` project; novel surface is a *cross-media advanceable-sequence* family homed in webintents,
shared with video/carousel; rule 2 + temporal rule 3 applied) · #1437 (temporal rule counts external convergent
impls; `dockable` layout-tree minted core-schema-now + extension-slot).

### Portfolio project tiering — the named-consumer evidence bar {#portfolio-project-tiering}

**Every project carries a `tier` — an importance axis orthogonal to the `status` maturity axis —
assigned by the named-consumer evidence bar, never by vibe or proxy metric.** Website-app /
portfolio-governance turf (no standards-layer entity is shaped). The three tiers are **ordered
evidence classes** (both-qualify → the higher wins):

1. **`core`** — a benchmark design system or major framework demonstrably depends on the domain:
   the capability appears in the gap-analysis corpus (`we:src/_data/benchmarkCoverage.json`) or a
   named framework ships the equivalent surface. Stated asymmetry: the benchmark corpus is
   component-shaped, so `utility`-category projects reach core only via the named-framework clause.
2. **`contextual`** — a *named* constellation consumer's build/runtime uses the project's surface,
   **shipped and functional today** (Frontier UI, plateau-app, an exercise app, the WE site's own
   chrome). Catalog listing never qualifies (the site renders all 45 — it would empty tier 3);
   planned/aspirational dogfooding never qualifies (#777).
3. **`exploratory`** — no named consumer yet; a hypothesis about a missing standard. Deliberately
   an evidence-state word (the W3C strategy-funnel stage name), **not** scheduling vocabulary like
   "deferred" — a merit partition, not a prioritization.

**Mechanism:** an explicit, enum-validated `tier` field on each `we:src/_data/projects/<id>.json`,
plus a required non-empty `tierEvidence` one-liner *naming the consumer* on every non-exploratory
project — the falsifiability hook (a challenge is "that consumer doesn't depend on this", never "I
feel differently"). Deriving the tier from data is rejected on merit: the bar is a judgment over
heterogeneous evidence no dataset holds (Baseline derives only because browser support is one
homogeneous dataset).

**Surfacing:** in-place — the tier renders as a `we-tag` cue per
[#catalog-tile-by-intent-mapping](#catalog-tile-by-intent-mapping) (classification → Tag intent;
`we-badge` stays the *status* pill), grids group core → contextual → exploratory (an SSR default,
client re-sortable), and exploratory stays on the main catalog, never hidden or segregated.

**Invariants:** tier and status render side by side (orthogonal — a `core`+`concept` project still
demotes dependent builds via the D3-readiness rule, which keys off *status*); a tier is
re-assignable only through a review turn against the same bar with a rewritten `tierEvidence`,
never a silent free edit; a tier never gates what a consumer may use (mandate-nothing) — it directs
investment and narrative only; intents carry no tier of their own (per-project stamping surface only).

**Lineage:** #2088 (this ruling; forks + skeptic passes in the item) · filed by the 2026-07-01
external consultant review (program #2090) · research topic `portfolio-project-tiering` ·
[#project-protocol-bar](#project-protocol-bar) is upstream (what earns a Project at all) ·
`we:docs/agent/platform-decisions.md` placement-test rule (project `status` outside `LIFECYCLE`)
scopes the *status* axis and is untouched — the status-vocabulary drift is a separate
statute-amendment decision.

### Intents are UX-only; technical strategy → Configurator {#intents-ux-only}

Intents describe desired interaction (what/why) at project level — dimensions, states, events,
per-level contracts only. They carry **no implementation refs** (no conformance tiers, DI, type
shapes, registries — those belong to the block). Technical strategies become a **Technical
Configurator** domain. Borrow official platform vocabulary (`aria-sort`, `Intl.Collator`), never
coin away from native terms. Intents are an **open, never-finished system**: custom non-standard
intents must coexist conflict-free — standardize the meta-schema, not the list. Defaults are the
**most permissive** value; restriction is the author's opt-in.

**Corollary — technical machinery splits off into a composed contract, and an upstream-bundled data
model does not force a monolithic one.** When a UX intent needs durable/technical machinery
(serialize/re-resolve/fuzzy/orphan, etc.), that machinery is its own contract the intent *composes*
(referenced, not owned) — the same seam an intent already uses for a native capability. A canonical
upstream model that bundles several concerns into one object (e.g. W3C Web Annotation's
`target`+`selector`+`body`) is a **serialization-vocabulary** fact, *orthogonal to the runtime
ownership seam*: adopt the wire format wholesale while still splitting which artifact owns the
machinery. #1408 (annotation = UX intent composing a separate durable-range-anchor contract; the
platform itself split quote-anchoring into `#:~:text=`). #2029 (the `suggestion` motivation's
accept/reject mutation transaction = a composed `suggested-edit` contract — annotation supplies the
proposal body, the Editor Engine protocol the apply, record-only over read-only hosts; "rich-text owns
it" was a classification collapse, since the rich-text intent is itself UX-only and its engine is
already a separate protocol).

**Converse guard — "technical strategy → Configurator" does *not* license a Configurator domain that
re-homes axes the config already carries.** When the technical axes already ride a `we:`-layer registry +
config-flavors (e.g. the credential-creation policy slots on `CustomCredentialProvider` + #483), minting a
`plateau:` Configurator domain over them is redundant cross-layer duplication, not the rule's intent. The
UX intent **references** those axes as constraints; it neither owns them nor justifies a second product-layer
home for them. The free *authorial* UX choices the ceremony leaves open (when to prompt, skippability, tone,
surface) are what the intent standardizes. #499 (credential-enrollment intent = the `create()`/enrollment
UX layer; technical creation axes stay on the #483 config, referenced not re-homed; the plateau Configurator
domain dissolved as redundant — re-judged on pure merit after a zero-consumer demand-gate "hold" was rejected).

**Lineage:** #030 (intent-vs-trait channel split) · #063 (native vocabulary) · #129 (guard intent
re-framed) · #499 (enrollment intent; converse-guard) · #634 · #1408 (durable-anchor contract split) ·
#2029 (suggested-edit contract split) · intents-open-design.

### Intent-conformance is compliance of a block against the intent contract — not a runtime gate {#intent-conformance-is-block-compliance}

An **intent is an interface; blocks (components/behaviors) implement it** — indirectly, via the
build-time resolver ([`we:webtraits/intentProfileResolver.ts`](../../webtraits/intentProfileResolver.ts)):
the intent never names a trait, the resolver maps the active profile → traits (keeps intents UX-only,
traits technical). An intent with no implementer does nothing, like an unimplemented interface. So
"**conformance** of an intent" means *does the implementing block satisfy the intent contract* — **not**
a runtime DOM watcher, and faking a tie is forbidden. It splits two ways:

- **Static / contract conformance** — does the block declare the required `intentDimension`s / bundle the
  required traits? Checkable in **WE at build time** (resolver / `we:webcases/requirementValidator.ts` shape).
- **Behavioral conformance** — does the *rendered* component behave per the intent? Needs a running
  subject: **contract → WE**, **runner/verifier → Plateau** (neutral, so *any* implementer consumes it —
  FUI is one subject, not the verifier's home), **subject → FUI**.

Never smuggle a conformance run into a *consumer* of traits (e.g. docs chrome) — that is silent
scope-expansion. The active intent profile is already present in the runtime DOM as `data-intent-*`
(plus element-level `action-intent` etc.), so *surfacing* an intent for inspection is a read-only,
near-zero-cost dev-tool, distinct from *checking* conformance.

**Lineage:** #947 (this semantic call) · #1566/#1576/#1597 (verifier→Plateau placement) · #934 (the
descope that triggered it) · #1657 (intent-inspector card) · [[project_conformance_verifier_vs_subject]].

### Monetization line *(soft — explicitly revisitable)* {#monetization}

> Tiering/pricing rulings get a **lighter, revisitable** treatment than standards. Fix the
> *structural partition principle* firmly; treat specific knob placements as provisional.

1. The paid line is a **structural property — per-call cost OR hosted/credential-holding — never a
   category** (never price on a shifting axis like proprietary-vs-open).
2. **Open-core:** the open standard + open reference impl are free; hosted/managed/collab is paid.
3. **Plateau linear-cost rule:** cost must scale ~linearly with revenue — no uncapped per-call SDK
   inside flat-rate pricing; prefer owned **on-device fixed-cost** capability; BYO-key is a tier,
   not the floor.
4. **Vision / AI is never a WE standard** → see [§ no-leakage client](#no-leakage-client).
5. **Dev-surface paid flagship (#1590):** the paid product is the **licensed local dev-browser
   (fixed-cost, JetBrains/Sublime model)**, not a SaaS — *recurring* server/support cost is the
   dominant solo-dev risk, so the on-device fixed-cost surface leads; SaaS is an optional *later* tier
   (its recurring cost is a liability, not a reason to lead). Extensions are the free funnel. **Build
   is decoupled from release timing**: pursue the product now, switch on paid release later.
   - **In-shell free/paid line (#1655, soft-accepted):** two **orthogonal** gates, not a
     per-capability map. **Gate 1 — commercial-use license:** the *whole local browser* (every
     local fixed-cost feature) is free for **non-commercial / individual / OSS / learning** use,
     paid for **commercial** use — a use-context license, not a feature split (no Community/Pro
     local subset: fixed-cost features give no structural hook to split). **Gate 2 — server-cost
     tier:** any capability that **requires a server to run** (hosted sync/collab/share-links,
     per-call AI) is **paid for everyone**, non-commercial included, as cost-recovery. Local
     persist/export/write-back (local repro export, fixtures, safe-edit→PR) stays **free** — only
     the *server-backed* variant is paid (faithful to #775's "deterministic+local = free; hosted =
     paid" line; the "persist/write = paid" read-vs-act framing over-reached).

**Lineage:** #098 #185 (licensing / GTM) · #089–#093 #086 (open-core constellation) · #182 #183
(licensing/payments) · #451 (MaaS tier) · #775 (assembler open-core) · #410 #141 #166 · #665 #690
(self-driven framing) · #1590 (dev-surface paid flagship = local fixed-cost browser; build
decoupled from release). *Confidence: principle firm; specific knobs provisional.*

### A separate product brand is earned by structural product-distinctness, not appetite {#brand-on-distinctness}

> A positioning sibling to [§ monetization](#monetization): *never brand on a shifting category*. A
> sub-component gets its **own marketed product brand only when it has a real standalone consumer
> surface** — not to *drive* the adoption that would *create* the case (the circular, appetite-based
> move the monetization rule forbids).

1. **Structural test:** a thing earns a separate brand when ≥1 consumer depends on it **without**
   depending on the parent product — the `ReactDOM`/`Rollup` case (shipped to millions directly), not
   the `@lit/reactive-element` case (a sub-package Lit does **not** separately market).
2. **Default is fold.** A sub-package identity under the constellation/Frontier-UI brand is the
   *cheapest* path to a later split — folding forecloses nothing; the npm scope + contracts already exist.
3. **webplugs ruling (#642):** `@frontierui/plugs` **folds** — no separate brand. Per #606 the plugs
   runtime is a POC with no standalone product surface and one consumer (plateau-app). **Un-park** only
   on the structural event: webplugs gains ≥1 external consumer that depends on it *without* depending on
   `@frontierui/blocks` / FUI components. Brand on that event, never on appetite.

**Lineage:** #606 (code home + brand deferral) · #775 (soft/revisitable monetization) · #642 (this
ruling). *Confidence: high — structural test + un-park trigger firm.*

### npm scope = one per audience/layer; product = package name; restricted-until-an-explicit-go {#npm-scope-audience-layer}

The constellation's npm scopes map to the **layer/audience**, and products within a layer are differentiated
by **package name**, never by minting a second scope. Six orgs are held (`@webeverything`, `@frontierui`,
`@frontier-ui`, `@plateaujs`, `@plateaudev`, `@plateauapp`); this rule fixes which go live and how they
publish. It extends the #855 npm-scope-mirrors-layer family under
[constellation-placement](#constellation-placement) (WE↔FUI half already there — this adds the Plateau half
and the access posture) and **composes** the [monetization statute](#monetization) (rule 5 #1590) and
[brand-on-distinctness](#brand-on-distinctness) rather than colliding with them. npm has **no scope rename**,
so every live scope is a permanent identity — the lock-in axis dominates and the *reversible* posture is the
default.

1. **Canonical FUI scope = `@frontierui`** (no hyphen); **`@frontier-ui` is a permanent defensive hold that
   publishes nothing**. The code already names 13 `@frontierui/*` packages and every statute citation uses
   the no-hyphen spelling — the published name equals what the ecosystem reads in code and docs. The
   "multiword scopes hyphenate" ecosystem norm is genuinely mixed (`@webcomponents`/`@vitejs` smash), so
   there is no platform norm to align to; the governing precedent is the constellation's own shipped
   spelling. (#1991's smash-not-hyphenate rule is HTML-attribute-scoped and is **not** the authority here.)
2. **One live Plateau scope = `@plateaujs`**; **`@plateauapp` and `@plateaudev` are defensive holds.** All
   Plateau npm packages ride `@plateaujs`, customer-facing products differentiated by **package name**; a
   never-npm-published internal package, if one ever is, rides the same scope as `--access restricted`. A
   second scope buys a *label*, not an enforcement boundary — npm access is **per-package**
   (`--access restricted`), not per-scope, and org-level separation (2FA, teams, granular/OIDC tokens) is
   achievable within one org. An audience-boundary scope split (`@plateaudev` = internal) is **rejected**:
   its name-level signal is hypothetical while its misclassification surface is structural (the
   `@angular-devkit` "dev ≠ internal" trap), and the lock-in asymmetry favors one scope (a wrong single
   scope moves a *restricted, dependent-less* package cheaply; a wrong second scope republishes a public
   package with external dependents). The `@plateaujs`-over-`@plateauapp` spelling is **ruled**: the
   project-scope precedent (`@vitejs`/`@vuejs` — a "js" scope names the *project* whose packages consumers
   install) fits a scope that distributes installables, while `@plateauapp` names the SaaS app, which is
   **deployed, never npm-published**. `@plateaudev` re-opens **only** on one of two named triggers: (i) a
   genuine publish-policy channel emerges (a `@lit-labs`-style experimental tier); or (ii) a
   [brand-on-distinctness](#brand-on-distinctness) structural earn — a sub-component gains ≥1 consumer that
   depends on it *without* the parent product. Never merely to hide internal packages — privacy is
   per-package access, not a scope.
3. **Access posture = restricted-until-an-explicit-go for impl/product scopes; public + provenance for the
   WE standard surface.** `@frontierui/*` and `@plateaujs/*` publish `--access restricted` (no provenance)
   until an explicit go; `@webeverything/*` publishes public + provenance (settled by #907 — a standard's
   adoption requires tokenless, provenance-attested install). Disclosure is a **one-way door** (npm's
   unpublish fencing protects dependents; re-restricting un-discloses nothing) while restricted → public is a
   one-flag flip, so the reversible value is the honest default. "**Go**" is a **per-package-set event, not
   one launch date** — the first external consumer who cannot reasonably hold a read token flips that set
   public (#2128's pilot channel is exactly such an event for the pilot-scoped FUI blocks/plugs). The rule
   is **total**: restricted is the standing default for every non-`@webeverything` package; a flip to public
   is always an explicit decision (a paid `@plateaujs` product simply never gets flipped without its own
   ruling). For `@plateaujs/*`, restricted **implements** the ruled monetization line (#1590 licensed local
   flagship — public npm code would contradict it); for `@frontierui/*` (open-core-committed end-state), the
   merit is reversibility + not freezing pre-1.0 surfaces into public dependents. **Provenance-gap rule:**
   restricted versions never gain provenance retroactively and `npm access public` exposes the *entire*
   restricted history at once — so each go event ships a fresh provenance-attested version and treats pre-go
   versions as unattested.

**Settled inputs (not part of the fork):** `@webeverything` carries **WE standard artifacts only**
(type-only distribution, never imports FUI — [constellation-placement](#constellation-placement) rule 3 +
#907's public+provenance mode); the WE **website** app never publishes to `@webeverything` (if ever
packaged, it takes a product-tier name — #2006). Defensive holds publish nothing, ever — the first package
into a hold converts it to a live scope, which only a ratified amendment here can do.

**Human-action contingency:** all defaults assume the same npm account owns all six orgs (anonymous probe
proves existence, not ownership). If a scope turns out not to be held by the owner, its slot falls back to
the nearest held spelling and this rule re-opens for that scope only.

**Lineage:** #2155 (ratified 2026-07-03 — Fork 1 (a) `@frontierui` canonical [skeptic SURVIVES vs the
hyphenate-norm attack]; Fork 2 (b) one scope `@plateaujs` [SURVIVES-WITH-AMENDMENT — **flips the item's
original two-scope bold**: the second-scope rationale rested on per-scope access npm lacks]; Fork 3 (a)
restricted-until-go [SURVIVES-WITH-AMENDMENT vs the config-dimension and launch-timing re-routes]; prep
`/research/npm-scope-audience-naming/`, session report `reports/2026-07-02-npm-scope-audience-naming.md`).
Extends #855 npm-scope-mirrors-layer under [constellation-placement](#constellation-placement); composes
[monetization](#monetization) (#1590 — Fork 3 restricted *implements* it) and
[brand-on-distinctness](#brand-on-distinctness) (Fork 2's second re-open trigger *is* the structural earn).
Edges: #907 (WE public+provenance, delegates the rest here) · #2128 (first Fork 3 "go" event) · #2157
(publish lag) · #2154 (OIDC trusted publishing). Unblocks naming the #2128 pilot set's packages.
*Confidence: high (Fork 1/3) / med-high (Fork 2 — the reversal); lock-in asymmetry carries the close call.*

### Plug distribution unit = one `@frontierui/plugs`, subpath exports — never per-plug packages {#plug-distribution-unit}

The plug **distribution unit is one `@frontierui/plugs` package** with per-domain subpath exports
(`@frontierui/plugs/<domain>`), **never one npm package per plug**. Consumers get minimal-*import*
granularity via subpaths + tree-shaking; they do **not** get independently-versioned per-plug packages.

1. **Why not per-plug:** three independent grounds. (a) *Currently impossible* — the domains have dense
   cross-domain imports reaching private files (`fui:plugs/webregistries/ScopedRegistryAttribute.ts:17` →
   `../webbehaviors/CustomAttribute`; `fui:plugs/webexpressions/CustomTextNode.ts:7` →
   `../webinjectors/InjectorRoot`), so no domain ships standalone without first severing those edges. (b)
   *Reintroduces a closed hazard* — N independently-versioned packages sharing runtime registries/contexts
   let a consumer pin `webbehaviors@2` against `webregistries@1` and break the seam at runtime: the exact
   cross-monorepo skew #1045/#1006 closed. (c) *Against the industry* — Radix/Chakra/React Aria all
   consolidated *away* from per-package granularity post-2024, citing this very pain.
2. **Minimal-install ≠ minimal-import.** Subpath exports already deliver minimal *import*. A future
   external `npm install` consumer (#872/#907) wanting smaller *install* gets it by adding a build step +
   `sideEffects: false` to the **one** package — not by splitting into N.
3. **The only sanctioned split is a `-labs` stability tier** (Lit's `@lit-labs/*` model): split a plug out
   *only* when its API is genuinely experimental — axis = **stability, never per-feature** — and only after
   a decoupling pass severs the cross-domain edges. Not a free escape hatch.

**Lineage:** #1837 (this ruling) *upholds* #1045 (single-package) + #1006 (exports-lock) + #606 (plugs
FUI-owned); reframes #1846 (W6) into a subpath-export conformance check. Grounded in
`/research/unplugged-plug-parity/` Survey 1. *Confidence: high — impossible-today + closed-hazard +
industry consolidation converge; red-team failed.*

### Vision / AI = a Plateau no-leakage service client {#no-leakage-client}

Any **implementation capability** (vision, AI model inference) is **never a WE standard**. It is a
**Plateau service** that the WE project consumes as a **no-leakage client** — only the *outputs*
reach the standard, never the capability. Interim thin client seams repoint to Plateau. Harvested
candidates promote only through the human-ratified `/new-standard` flow.

**Lineage:** #475 #488 (#488: on-device fixed-cost floor + BYO-key bridge) · #396 · #086 + #314
(exercise-app conformance loop as the forcing function).

### Vision capability tiers — the on-device-first cascade {#vision-tiers}

The vision service (a [no-leakage client](#no-leakage-client)) ships as **three layered tiers**, not
interchangeable models — pick by job, and let the cheap tier gate the expensive one:

1. **Tier 1 — verdict classifier** (≤10 MB, on-device, free at any volume, **benchmarkable/gateable**):
   the always-on triage/router. Reach for it when the work is high-volume, must run everywhere/offline,
   must be instant, or needs a deterministic gate. Closed label set, whole-screen only — no "why/where".
2. **Tier 2 — small VLM** (device-gated, an opt-in download in the dev browser): open-ended describe /
   localize / tag — the "what's wrong and where" a real review needs. Generative → no clean agreement
   metric, so it is **never** deterministically gated the way Tier 1 is.
3. **Hosted** — richest, but **per-call cost**, so never the free floor: a dev tool / BYO-key bridge /
   premium upgrade only (the [linear-cost rule](#monetization)).

**The cascade is the load-bearing rule:** Tier 1 runs on every frame and decides *whether it's even
worth* an expensive call; only escalated frames reach Tier 2 / hosted. That filter is what makes the
heavy tier affordable under flat pricing. **Deployment floor:** Tier 1 bundled, on by default (in-browser
via ONNX Runtime Web + WebGPU); Tier 2 an opt-in dev-browser download on capable devices only; hosted
BYO-key / premium, never on mobile. Every tier registers behind the one `registerVisionProvider` seam —
swapping a tier is a provider swap, not new plumbing. The design-critique rubric (#1034) is the service's
*output contract*, not a published `@webeverything` artifact, and rides the same seam.

**Still deferred (a later call, not a fork):** whether a Tier-2-class critique model is ever built
on-device vs. stays hosted — the architecture holds either way and the provider seam absorbs the choice.

### WE-compliance validation = a dev-browser lens, not a hosted SaaS {#compliance-validation-home}

WE-compliance validation (run the conformance vectors against a design system, get a report) lives as a
**dev-browser lens** ([#141](../../backlog/141-dev-browser-vision.md) Chromium/extension shell;
[#1636](../../backlog/1636-role-scoped-lenses-over-one-dev-browser.md) role-scoped lenses; Plateau-layer
per [constellation-placement](#constellation-placement) / #1565), **not** a hosted upload SaaS. We **just
analyse the page in front of us**: the conformance engine runs consumer-side (#891/#954), so the lens runs
WE vectors against the loaded subject *in the user's own browser* — no upload service, no server-side
execution, **no per-uploader credentials held by us** (any auth to reach the user's own page is the user's
own credential in their own password manager). It consumes WE vectors+runner as a
[no-leakage client](#no-leakage-client) (#475); standard + engine never leave WE (#855).

**Two distinct products — separate them:** (1) the **self-validation lens** above is the non-speculative
product and where compliance validation lives; (2) a **trusted third-party badge/attestation SaaS** (an
independent party vouches to the market) is a *different*, demand-gated product. A self-run lens can only
self-attest, so a trusted badge is not the same thing. **Only product (2) would ever need the
plateau-app-domain-vs-own-constellation-project granularity call** — revive it (and the structural
identity/credential test in #966) only if a hosted attestation product is actually demanded.

**Lineage:** #966 (this ruling) · #141/#1636/#1565 (dev-browser home) · #891/#954 (consumer-side engine) ·
#475 (no-leakage client) · #855 (standard/engine stay in WE). *Confidence: high — fits a settled surface,
reversible, trigger-armed.*

**Lineage:** #1033 (interactive design-review loop) #1034 (critique rubric) #490 (build epic) · #475
#488 (on-device fixed-cost floor) · #511/#512/#513 (Tier 1 tooling/training) #1073 (Tier 2 epic) #485
(hosted teacher bridge) #141 (dev-browser home) #514 (ONNX/WebGPU runtime). Promoted from
[vision-tiers.md](vision-tiers.md) per #1244. *Confidence: architecture firm; on-device-vs-hosted for
the rich tier provisional.*

### Trainable judge — portable corpus, Plateau-owned learning, advisory output {#trainable-judge}

The autonomous explorer's judge ([#1552](../../backlog/1552/)) is made **trainable** from human feedback
on real runs, without ever becoming a gate or leaking the capability. Four rulings, all extending
[no-leakage-client](#no-leakage-client) + [vision-tiers](#vision-tiers) and cross-referencing
[devtools-placement](#devtools-placement):

1. **Two composable feedback channels, both captured.** A *verdict on a candidate* trains precision +
   severity; a *missed-issue capture* (a human authors a finding the judge never flagged) is the **only**
   channel that trains **recall**. Verdict-only is a strict subset that caps the perceptual ceiling — so
   capture both. **Label anchor:** a frozen-frame corpus keyed on `stateId` for eval/training (no spatial
   replay), plus a composite spatial anchor for missed-issue authoring — `stateId` gates the match, **bbox
   primary, a11y-role/text tiebreak, DOM-path debug-only**.
2. **Learning mechanism = k-NN → probe → parked fine-tune.** k-NN over **cached DaViT vision-encoder
   embeddings** at cold-start (on-device, free, works from the first label) → **linear/logistic probe** on
   the same cache at ~tens of labels (eval-gated) → full VLM fine-tune parked past ~1k labels (server-side).
3. **Agent-portability is a hard constraint** (the zero-lock-in seam extended from inference to training):
   the **asset is the model-agnostic corpus** (`{frozen frame, domSnapshot, stateId, verdict, anchor, label
   vocab}`); **embeddings are a re-derivable cache** keyed `(encoder-id, frame)`; **the recipe is
   encoder-parameterized**, so swapping the judge agent ⇒ re-embed + retrain, zero data loss. A
   train-disjoint, variant-rich **held-out regression benchmark** (bad-pattern catalogue + false-positive
   traps) scores *outputs*, so it validates any judge agent and is **CI-gated on accuracy** — distinct from
   the judge's *output*, which stays advisory and **never gates an explored run** ([#1172](../../backlog/1172/)).
4. **Constellation boundary (three-way split, per [devtools-placement](#devtools-placement)):** **Plateau
   owns the implementation** (model/embeddings/store/training/#490 distillation — extends the
   #1073/#475/#490 vision service); **WE owns only the contract** (the `JudgeModel` type / judgment schema,
   never any impl, per [#1282](../../backlog/1282/)); **the explorer dev-tool produces the signal + hosts
   the seam** from its Plateau-side orchestration/report tier (the human + `improve-explorer` loop is the
   actual consumer). Only outputs cross the seam; a FUI-local judgment provider is the fragmentation #475
   forbids.

**Lineage:** #1553 (this decision) · #1552 (epic) · #1565 ([devtools-placement](#devtools-placement)) ·
#489 (frame/verdict pairs) #1168 (DOM-signature stateId) #1034 (critique rubric) #490 (distillation) ·
#1073/#475 (vision service). *Confidence: architecture firm; escalation-trigger label count provisional.*

### Custom-element tagName naming {#tagname-naming}

1. **Element-ness is opt-in / authored:** a block declares `tagName` (0 / 1 / N tags); never
   auto-derived from type.
2. **Value = `<prefix>-<id>`**, default prefix `we-`, configurable via Config-Extends-Platform-
   Default (`fui-` excluded). FUI's irregular names migrate to conform.
3. Registration is **parameterized** (tag = contract default, never a hard-coded literal); the
   override hatch is consumer-side.
4. The convention **binds only global-registration modes** — deep JSX / compile-time consumption
   stays totally flexible.
5. The custom-element surface (`tagName` + attributes/properties/slots) is a **WE-owned contract in
   `blocks.json`**; FUI is one conforming implementation (not WE mirroring FUI's
   `customElements.define`).

Plus the standing naming rules (machine-checked): traits `with[Capability]` (never `use*`),
registries `Custom[Name]Registry`, injector domains start with `@`, event attrs `on:event`. WE
never *mandates* conventions — it ships a default vocabulary projects customize, enforced via
`webcompliance`. See [conventions.md](conventions.md).

**Lineage:** #841 (tagName convention) · #822 (CEM surface as contract) · #045 #046 · #063 #030 ·
#436/#437 (conventions-fold-into-compliance).

### Host back-reference property naming {#host-backreference-naming}

A host-attached object names its back-reference to the host **by the relationship's native /
semantic name — never a universal `target`**. `target`/`currentTarget` are reserved for transient
dispatch/observation (`Event`, `MutationRecord`), not persistent ownership, and collide with the
`e.target` a behaviour reads in its own listeners.

1. An `Attr`-derived host object (`CustomAttribute` + subclasses, which chain to `Attr.prototype`)
   uses **`ownerElement`** — the exact native `Attr.ownerElement`.
2. A non-attribute host-attached object (`Injector`, `CustomContext`, controllers) uses **`host`**
   (matches `ShadowRoot.host`, Lit `ReactiveControllerHost`, Angular host element).
3. **Name by semantics, not by uniformity:** two right names (`ownerElement` for `Attr`, `host`
   elsewhere) beat one wrong-but-uniform name — the web platform itself diverges this way
   (`Attr.ownerElement` vs `ShadowRoot.host`). A permanent dual name for one class is excluded; a
   deprecated alias getter for one cycle is a rollout tactic, not a second canonical name.

**Lineage:** #1121 (`CustomAttribute` → `ownerElement`, scoped to `Attr` subclasses) · #1042
(sibling `Injector`/`CustomContext` → `host`, open) · derived from [native-first
baseline](#native-first-baseline).

### Registry name-validation guards the host-shared namespace, not every `define()` {#registry-name-guard-namespace}

A `CustomRegistry.define()` name-validation throw is justified **iff the registry's keys enter a
namespace shared with the host platform** — never by a flat "every `define()` call validates the
same way" rule.

1. **The test is namespace sharing, not the `define()` call.** A key is guard-worthy iff it lands in
   a namespace where a bare name collides with a host built-in. Today that is the **HTML-attribute**
   namespace (`CustomAttributeRegistry` → DOM attributes, where `title`/`value`/`type` are taken).
   Element tags are the other host-shared namespace, but the platform **already** hyphen-forces them.
2. **Framework-internal keys are not guarded** — *with one amendment for grammar-keyed registries (#2112,
   2026-07-03).* Parser / expression / text-node / store / context registry keys never reach the DOM, so their bare
   grammar tokens (`value`, `pipe`, `call`, `mustache`, `polymer`) stay bare — no guard, no rename. The base
   `CustomRegistry` stays guard-less; the throw is a deliberate per-registry override, not a base invariant.
   **Amendment:** when the registry key *is a delimiter grammar* (the #2074 `customNodes` recipes, keyed by
   `static open` rather than by a name), a **narrow slice of that keyspace is host-shared** — an `open` rooted in the
   HTML tokenizer's tag-open set (`<` + `!`/`/`/`?`/letter) is claimed by the parser before text scanning, so it
   *does* touch a host surface. That slice — and only that slice — is guarded (a `ReservedDelimiterError` at
   `define()`), per [#2112](/backlog/2112-reserved-delimiter-family-policy-which-opens-are-platform-re/) Fork 1
   ([custom-node-recipes](block-standard.md#custom-node-recipes) rule 6). The exemption still holds for name-keyed
   internal registries; it is *narrowed, not removed*.
3. **This is the web platform's own rule.** Native `customElements.define` guards *only* element tags
   (the one host-shared namespace) and imposes nothing on internal JS registries — so scoping the
   guard generalizes the platform; a flat uniformity rule would be **stricter than the platform's
   own**, on namespaces it never guards.
4. **The separator set tracks what each namespace permits** (not uniformity): tags are hyphen-only
   (a colon isn't a valid tag char); attributes accept hyphen **or** colon (`xml:lang`, `nav:list`).
5. **One-line statement to cite:** *guard the namespace you share with the host.* This is an instance
   of the same "name/guard by semantics, not by uniformity" discipline as
   [host back-reference naming](#host-backreference-naming) and derives from the [native-first
   baseline](#native-first-baseline).

**Lineage:** #1347 (scope of #1120's guard → `CustomAttributeRegistry` only; sets #1348 rename
scope) · #1120 (the `CustomAttributeRegistry` `#assertValidName` guard) · #2112 (rule-2 amendment:
grammar-keyed registries guard the host tag-open slice of their delimiter keyspace) · derived from
[native-first baseline](#native-first-baseline).

### Guard / Gate vocabulary {#guard-gate}

**Guard** gates a *transition*; **Gate** gates *presence*. Protocolize only the **provider +
predicate seam** as the single lock; each member (exit-guard #273, access #178) owns its
deny-outcome family. Enforcement is **server-side, never in the UX intent**. The next gate-shaped
feature is a *member* of the open Guard protocol, not a fresh abstraction.

**Lineage:** #272 (protocol) · #129 (navigation/exit guard) · #178 (access/authorization gate).

### `<component>` declarative-component (DC-N) decisions {#component-dc}

The `<component>` build-time transform's design calls are consolidated as a **DC-decisions
reference table in `src/_includes/block-descriptions/component.njk`** (the canonical block home).
Read the table before re-opening a `<component>` question. Covers: tag name (DC-1), shadow attr
(DC-2), registration timing (DC-3), reactive depth / binding (DC-4 / #792), scripting hook (DC-5),
toggle (DC-7), implicit/explicit template (DC-9/10/11), `attachInternals` (DC-12/13/14),
preserve-on-move (DC-15), scoped registration **off** `<component>` (#854 → carves #900/#901/#902),
toolchain reach (#127).

> Key sub-ruling (#854): `<component>` is a *build-time* transform (gone by runtime) so it **cannot
> host a runtime registry** — scoped registration lives off it, as a runtime declared-registry
> (`<script type=registry>`) + IDREF association + a CustomAttribute binding behavior. The
> `{{ }}` / `[[ ]]` expression-binding layer (`webexpressions`) already exists — reuse its grammar,
> not a new runtime.

**Lineage:** #039 #040 #042 #043 #044 #045 #046 #047 #074 #082 #084 #127 #792 #854 · #853 (default-aria-*) · #1807 (DC-14 custom states — `states=` declarative surface + per-instance toggle, delivered plugged/unplugged via the custom-states plug per #1826).

### Compose an existing trait — don't hand-roll a covered pattern {#compose-dont-handroll}

A block/component **MUST compose an existing WE trait/behavior/contract for any capability a
standard already covers** (disclosure → `nav:section`, roving focus → `nav:list`). Hand-rolling an
interaction a registered trait provides (ad-hoc `addEventListener` re-implementing the pattern) is a
**conformance defect, not a style choice**. New behavior is allowed — but authored as a *new trait*
(a `CustomAttribute`), never as per-block event wiring.

**Advisory alone is insufficient** — the rule existed in spirit (authoring skills + `AGENTS.md`) and
still failed twice (`sectioned-nav` #870, `disclosure-nav` #931), so a **mechanical gate is
required**, not just a checklist. Enforced by two orthogonal mechanisms:
1. **Declaration** — a block records the traits it *consumes* in a `composesBehaviors` field
   (distinct from the `traits` it *provides*), projected into CEM `x-webeverything` and asserted to
   resolve against `src/_data/traits.json`. Mirrors the existing `composesIntents` field.
2. **Detection** — a `check:standards` gate (`validateBlockComposesTraits`, beside
   `validateBlockImplConformance`) runs a **curated "source-pattern → required-trait" deny-list**
   over FUI source (e.g. click/keydown on an `aria-expanded` head → must compose `nav:section`),
   **warn-first → ERROR** once curated (the #840/#844/#477 rollout precedent). Open-ended
   `addEventListener` sniffing is *rejected* (false-positive factory); declaration-only is *rejected*
   (can't catch a block that declares nothing and hand-rolls — the #931 mode). A *rendered* axe check
   **cannot** substitute: a hand-rolled disclosure is a11y-clean, so the defect is visible only in
   source + declaration → the gate is static.

The authoring pre-flight ("search the trait registry before wiring an interaction; compose, don't
re-implement") ships as the gate's **complement**, never as the enforcement. The declarative-only
end-state (trait-marked templates with no behavior code to hand-roll) is the long-term fix, sequenced
after #932/#934 — it removes the *temptation*; the gate catches what slips *now*.

**Lineage:** #933 (ratified 2026-06-18) · incidents #870 #931 · precedent #436/#437 (conventions
fold into compliance), #840/#844/#477 (warn-first rollout).

### Gate-rollout ratchet: promote-on-green, then flip-to-enforce-by-default at the drained milestone {#gate-rollout-ratchet}

How a per-route/per-target quality gate (the axe a11y lane is the reference case) rolls from
warn-only to build-blocking. Two orthogonal axes, both ratified #867:

1. **Promotion tracks measurement only, not any upstream rework.** A route/target enters the
   enforced set the moment it *measures green*, decoupled from whether its dogfood/UI conversion has
   landed. Enforcing early means every later rework of that surface lands **under** the guard — the
   proof made structural. Holding promotion until the rework lands is the **broken branch**: it
   removes the guard at the single riskiest edit (the rework itself). This is a forced invariant, not
   a weigh — it restates #774's green-only criterion; a rework precondition is not one the gate ever
   asserts (it measures rendered output, never provenance, and re-measures every run).
2. **Warn-only is a stage you exit, not a resting posture — flip to enforce-by-default once
   drained.** Keep the warn-only *entry* posture (#774) while a largely-unmeasured site is draining;
   once the enforced set equals the derived set and the lane is green (a mechanically-decidable
   predicate over repo state), **invert**: a derived route is build-blocking **unless** listed in an
   explicit, reviewable `WARN_ROUTES` opt-out (new/experimental surfaces opt *out*, visibly and
   temporarily). Fail-closed is what "the site is the conformance proof" means once the debt is
   drained; perpetual warn-entry is fail-open by construction, and measured evidence shows warn
   output is ignored in practice. Rejected alternatives: flip-everything-now (yields a permanently
   red lane that trains the repo to ignore it) and a violation-level baseline snapshot
   (churn-sensitive, and snapshotted debt rots with no drain forcing-function).

Two rollout obligations the flip carries: the drained-milestone trigger must be **self-announcing**
(a lane meta-check that flags "drain complete — execute the flip" when the enforced set equals the
derived set, shipped *ahead* of the milestone so it can't rot unnoticed — a red enforced lane once
went unnoticed for a week), and the flip **supersedes #774's warn-only-entry rider as a plain
successor-ruling-on-changed-facts** (preserving #774's explicit-set discipline; record the
supersession lineage beside the #774 entry, never a retro-edit). Applies **per repo** ("mirrored,
not shared", #774/#849) — each gate drains against its own enforced set.

**Lineage:** #867 (ratified 2026-07-09, parent #777) · #774 (auto-derivation + warn-only-entry
rider, superseded part (ii)) · #763/#770/#793/#805 (axe lane built + first enforce flip) · #849 (FUI
mirror) · precedent #840/#844/#477 (warn-first → ERROR), fail-closed `check:standards`
classifier ([constellation-placement](#constellation-placement) cluster).

### A composition artifact is owned by its *new* substance; referenced parts stay home {#composition-artifact-ownership}

When a new artifact is a **composition of capabilities that already exist** across the constellation (a
record that *binds* an existing snapshot + journal + trace + identity into one consumable thing), do
**not** mint a new project or duplicate any part's format. The artifact is a **thin envelope that
references** the existing protocols; each referenced **payload schema stays owned by its existing
project**. Ownership of the *envelope* goes to the project of the artifact's **new substance** — the
one capability the composition actually adds (e.g. an *ordered timeline* of spans → the tracing
project) — **not** to the project that owns the heaviest referenced payload, and never to a brand-new
"consumer-composition" project (that fragments the constellation for no interop gain —
[minimize-lock-in](#constellation-placement)). When a fork asks "which project owns this composite?",
the answer is: locate the single new substance, own it there, reference the rest.

Corollary (determinism/observation records): when such a record must *replay*, anchor the determinism
guarantee on the **recorded state-diff journal** (re-apply diffs, run no app code) — bounded explicitly
to *journaled* state, with a snapshot↔journal consistency precondition and an off-journal-state-out-of-scope
boundary. Action/event **re-fold through handlers is not the determinism anchor** (it assumes handler
purity the platform can't guarantee); it is a valid *optional* behavioral-replay mode, and event-identity
is load-bearing only there and for **correlation**, never for journaled-state determinism.

**Lineage:** #992 (trace/replay substrate — envelope owned by webtraces, journal stays webstates,
determinism anchor = state-diff A; ratified 2026-06-19) · #1411 (treegrid = a `hierarchy` projection on
`data-grid`, not a new block — the new substance is the Right/Left arbitration rule, homed on data-grid's
movement-engine seam; hierarchy's flatten-to-visible projection is referenced, not duplicated; ratified
2026-06-21) · #1423 (bulk-action = a thin `bulk-action` **intent** composing `selection` + `command` over a
target set, not an assemblerPreset/trait — the new substance a preset can't carry is fan-out across the live
selection set + the select-all `matching` predicate + the partial-failure outcome + the count-announce
binding; selection/command/#1409 toolbar are referenced and stay home; ratified 2026-06-21) · #1420
(offline-first sync = a composition over four already-ratified orthogonal axes — webrealtime transport +
webreliability durable outbox + change-tracking merge-strategy + `mutation` apply/rollback — so **no new
WE artifact**; the replay-on-reconnect *choreography* (FIFO + exactly-once + sync-cursor) rides a FUI
`sync-coordinator` **block** the `draft-persistence` way, never a 5th standard. **Deferral-bar corollary:**
don't mint an orchestrator over already-homed axes until a *real cross-cutting consumer* appears — that is
`storage.json`'s own bar, and it is unmet by the current exercise-app roadmap (loan/insurance/healthcare/
government/logistics are form/workflow apps, not collaborative-realtime). Presence stays its own render
intent (bias-to-separation; `CoEditCoordinator` "does not merge state"); ratified 2026-06-21). Kin to [constellation-placement](#constellation-placement),
[compose-dont-handroll](#compose-dont-handroll), [surface-contract-not-computation](#surface-contract-not-computation).

### An interchange Protocol whose family is project-less gets a thin protocol-host project — never owner-less, never mis-homed {#protocol-host-project}

A WE Protocol entry (`src/_data/protocols/*.json`) **structurally requires** an owning project: `validateProtocol`
(`scripts/check-standards-rules.mjs:772-789`) makes `ownedByProject` + `anchor` required fields, rejects an owner that
doesn't resolve in `projects.json`, and demands a `<section id="protocol-<id>">` anchor in the owner's
`src/_includes/project-<id>.njk` — its rendered catalog home. There is **no project-less escape hatch** (all 39
protocols are owned). So when a ruling makes a *family* project-less (intent + block, no orchestration domain) yet
also extracts its serialized form as a first-class Protocol, the two collide at mint time. **Resolution: mint a thin
*protocol-host* project that owns only the schema** — the Protocol entry, its anchor, and its round-trip conformance
vectors, **nothing behavioural.** The intent + block stay project-less; only the interchange *schema* gets a home.

This is **not** a re-open of the family's no-project ruling: a host owning *only* the schema is a different category
from the impl/orchestration domain a "no project" ruling rejects — the standards world homes interchange formats in
dedicated host/registry surfaces (glTF→Khronos 3D Formats WG, OpenAPI→OpenAPI Initiative), **never owner-less**, and
docking-style incumbents share *no* coordinating body, so WE must home the schema itself. **Do not** attach the
Protocol to an unrelated existing project (mis-homing — conflates entity classes, blurs that project's meaning), and
**do not** relax the required-owner invariant to serve one protocol (erodes a rule all others satisfy on exactly the
surface — the escapable lock — that most needs to stay crisp). The model-relaxation path (`ownedByProject` optional
iff `ownedByIntent` resolves + an intent-anchored rendering path) is the **dormant escape**, engaged only if the
host-vs-reopen category split is rejected.

**Lineage:** #1653 (dockable layout-tree Protocol → owned by a new thin `weblayout` protocol-host; #1437 Fork 1's
project-less family + Fork 2's first-class Protocol both honoured; skeptic SURVIVED — host ≠ reopen; ratified
2026-06-23; unblocks #1486's mint). Kin to [composition-artifact-ownership](#composition-artifact-ownership),
[constellation-placement](#constellation-placement), [minimize-lock-in](#constellation-placement).

### Data-shape evolution is a storage facet, not a reliability concern {#data-shape-vs-mechanism-failure}

When persisted client state **outlives the schema that reads it** (a stored value predates the shape the
current code expects — a renamed key, a changed field), the capability that detects + migrates/discards it
is a **webstates storage facet**, *not* a webreliability concern. webreliability owns **mechanism /
operation failures** (network timeout, server error, DB unreachable, computation crash) and is ratified
"distinct from validation — not input invalidity"; a schema-shape mismatch is **data evolution**, which
falls on the same far side of that line. The discard-to-defaults fallback merely *rhymes* with graceful
degradation — that resemblance does not move the home. **Test:** if the trigger is "the stored shape
changed", it's webstates; if the trigger is "an operation failed", it's webreliability.

Corollary (decision shape): such a placement question splits cleanly into **WE-internal architecture forks**
the developer never sees (which project owns it; how it attaches to the contract — WE must pick one on merit)
and **developer-facing behavior axes** with two legitimate end-states each (detection, mismatch policy,
on-disk granularity — *support both, record a most-flexible default*, never a mandate). Don't promote a
support-both axis to a fork. See [config-extends-platform-default](#config-extends-platform-default).

**Lineage:** #1251 (client-storage schema versioning + migration; home = webstates, granularity = configurable
dimension defaulting to per-key envelope; ratified 2026-06-20). Kin to [constellation-placement](#constellation-placement),
[composition-artifact-ownership](#composition-artifact-ownership), [config-extends-platform-default](#config-extends-platform-default).

### Mandate the surface contract, not the computation {#surface-contract-not-computation}

A WE standard normatively pins the **observable surface contract** — the hand-off shape, the regions,
the stable-id events — and **never the computation behind it**. Competing "models" that emit the same
surface are not separate models; they are **swappable provider strategies** (e.g. a `ValidityMergeRegistry`
resolver) that conform *iff* they leave the surface unchanged. So a state-derived engine, an event-driven
engine, and a degenerate/flat strategy all conform — conformance is the observable contract, never the
internal computation. When a fork looks like "which algorithm/model do we mandate?", the answer is almost
always: mandate neither, pin the surface, register both as strategies.

**Lineage:** #4 (validation validity-model & conformance-tier). Relates to [native-first-baseline](#native-first-baseline),
[forward-generation-adapters](#forward-generation-adapters) (both are "contract is the authority, impl is swappable").

### Export-shape drift: classify by coherence, resolve per-symbol by trim-or-build {#export-shape-drift}

When the export-shape gate (#170/#927) flags a `we:` contract `exports` symbol absent from the resolved
FUI barrel, it is a **source-of-truth call decided per symbol** — never one verdict for the whole block.
Classify each declared-but-absent symbol on **merit**: is it **load-bearing to the block's promised
coherence** — it delivers a capability the shipped core lacks (a *different mechanism*, not the same one
re-wrapped) → **build** the `locus: frontierui` impl and keep it declared — or is it
**additive/superseded/aspirational over an already-complete core** — sugar the impl never chose, or a
design it superseded → **trim** the contract `exports` array in place? The tell: a symbol that re-exposes
the *same* mechanism the core already ships (an optional element wrapper, a mixin form of a shipped base
class) is additive → trim; a symbol that adds a *capability the core cannot do* is load-bearing → build.
Cost (build size) is **excluded** from the classification — it only schedules a spawned build, never
selects the branch (an instance of *fork-is-not-a-prioritization-tool*). Reverse drift — the barrel exports
a symbol the contract omits — is a forced **add** (contract = barrel in both directions).

**Lineage:** #1165 (`tabs`/`transient-component` → trim; `view` show/if/switch → build via #1217; under
#904). Specializes [surface-contract-not-computation](#surface-contract-not-computation) for the
#1164/#927 export-shape arm.

### Native-first baseline floor {#native-first-baseline}

Standards **assume modern web-platform primitives are present** (Baseline-2024: FACE/`ElementInternals`,
`popover`, `:state()`/`CustomStateSet`, `:user-invalid`, anchor positioning) and treat anything below the
floor as **out of scope**. A spec stays **single-substrate** — it never carries a dual native-vs-shimmed
contract — and **polyfills are an opt-in enhancement layer the consumer adds**, never part of the standard.
This is the standards-level statement of the native-first default (`AGENTS.md` hard rule 6 carries the
day-to-day form; cite whichever fits).

**Polyfill-surface fidelity (corollary).** When you *do* ship a polyfill, its contract **is** the native
surface — it mirrors what the platform deliberately *omits*, not just what it provides. Don't add a method
the platform refuses to (e.g. no `downgrade()` on a `CustomElementRegistry` polyfill: native upgrade is
one-way and the registry is append-only with no `undefine`, so the symmetry the name implies doesn't
exist). A real per-subtree/teardown need is designed *then* as a **named, explicitly non-standard
extension** with documented semantics — never a mystery method whose name overpromises. The fidelity rule
applies **one level up too**: a *shared contract* that polyfills implement (an interface, a type guard, an
abstract base) must not **mandate** a method the platform omits — relax the requirement to optional
(`downgrade?`) so the native-faithful implementation is conformant, even when API symmetry (`upgrade`/`downgrade`
"look like a pair") tempts otherwise. Real implementers that genuinely need the method still ship it; only the
*requirement* relaxes.

**Lineage:** #31 (polyfill baseline floor); #1103 (polyfill-surface fidelity / `downgrade()` omission on the
`CustomElementRegistry` surface); #1350 (the corollary at the shared `Plug` contract — `isPlug`/`HTMLRegistry`
drop the `downgrade` *requirement*, `downgrade?` optional; build #1413). Mirrors `AGENTS.md` rule 6 + the
native-first authoring default.

**Plug = a proposed missing standard; unplugged = safe-now (corollary).** The floor rule above governs capabilities the platform *has* (assume present; below-floor is out of scope). Its mirror is the capability **elemental to web applications but absent from every spec**. WE can neither wait for standards bodies nor force adoption, so it ships **two postures over one contract**: **unplugged** — safe-today usage of only what the platform ships, non-invasive and enforcement-free (the supported product surface, #606); **plugged** — the *proposed standard materialized as runnable code* (the prollyfill / upstream candidate, carrying enforcement + polyfill). This is the Extensible Web Manifesto move (expose primitives, prototype in JS, standardize what wins); the ecosystem already names the split — **ponyfill** (non-global, side-effect-free) = unplugged, **polyfill / prollyfill** (global; a not-yet-standardized API) = plugged. **Guardrail (what reconciles this with the single-substrate floor):** the *contract* stays single-substrate — plugged/unplugged is a **delivery+enforcement** axis over one contract (enforcement-on vs enforcement-off, the `--strict` analogy), **not** two native-vs-shimmed contracts; and the plugged impl is still implementation (→ Frontier UI), never a `@webeverything` standard artifact (#606). So "plugged = the proposed standard" names the impl's *upstream-candidate role* — it does not make the polyfill a standard, and the floor rule is preserved. **Partition grain:** decompose a capability into layers and classify **each layer** present-vs-absent against a shippable browser — a present layer → native (this floor); a layer absent from every spec → the plug. (#1807 is the worked example: `:state()`/`CustomStateSet` primitive present → native; the custom-state *declaration/validation* layer absent from every spec → plugged.) The `/prepare` lens that applies this at decision time lives in [backlog-workflow.md](backlog-workflow.md).

**Decision-discipline corollary (#1892) — a plug decision ratifies the *contract*, never the implementation mechanism.** Because the plug **is** the contract and the impl is FUI-local + swappable, a plug decision ratifies only the **WE-level contract** — the API shape + observable semantics as a future first-class web-platform proposal. The **implementation mechanism** — *how* FUI realizes it: a prototype-method patch vs an out-of-band WeakMap, the [residue](#plugged-only-residue-bar) classification, the emitted-ESM shape, install ordering — is **secondary, FUI-canonical, and replaceable**: a *different* library could supply the plug (e.g. a more performant one) and be **equally valid as long as it conforms to the same WE contract**. So an impl-mechanism question must **never** be elevated into a WE ratification — it is not a standards fork, it is an FUI build detail (record candidates non-bindingly; decide it in FUI). The **only** implementation constraint the contract carries is a **feasibility floor**: the contract must be *implementable*, not implemented a particular way. **Worked miss (#1892):** *"how does the plugged form intercept an undeclared `internals.states` toggle — patch vs out-of-band?"* was framed as the **standard** decision and consumed a whole session of reframes + a red-team — but it is pure FUI implementation; the only WE call was the `declareStates(internals, vocab, {severity?})` **contract** itself (a closed, validated state vocabulary as a platform proposal). The signal you mis-scoped: the "fork" turns on *residue / patch / polyfill shape* (impl words), not on observable contract.

**Lineage:** #606 (unplugged-is-product / plugged-is-POC; plug impl → FUI) generalized into this corollary; #1826 (the doctrine decision); #1807 (first application); #1892 (the decision-discipline corollary — ratify contract, not mechanism). Prior art: the ponyfill / polyfill / prollyfill triad + the Extensible Web Manifesto.

### The plugged-only residue bar — contract-portability, not capability-portability {#plugged-only-residue-bar}

A capability is **plugged-only** (genuine residue ≈ the missing platform standard) — rather than merely **not-yet-ported** — **iff both**: **(i)** its observable contract requires intercepting a native method/constructor the *consumer* calls directly on a node the plug holds **no handle to** (e.g. tagging every `document.createElement` result), **and (ii)** that **observable contract** — *including transparency* — cannot be reproduced by WeakMap-keyed out-of-band state consulted through the plug's own API (`attach`/`upgrade`/getter). The clause-(ii) test is over the **contract**, not the bare **capability**: a capability whose kernel ports (a verb re-expressible as an explicit factory + WeakMap) but whose contract demands *transparent interception of call-sites the plug does not own* is still residue, because there is no standard hook to replace the interception. The bar is **mechanical and strict** — the DX/ergonomics bar ("possible but worse unplugged ⇒ plugged-only") is rejected: it inflates the residue the epic exists to minimise. The capability-class allowlist is rejected *as the gate* (it ossifies as the platform grows) but kept as explanatory prose. **Discharge rule:** a residue declaration must cite *which* unowned global it patches, *why* no handle reaches the node, **and name the missing platform hook** the residue stands in for — so the verdict stays auditable and falsifiable (if the platform ships that hook, the capability moves *out* of residue and the mechanical test notices). Worked example: webinjectors' `createElement` creation-context tagging (`fui:plugs/webinjectors/Node.injectors.patch.ts:88-94`) and webcontexts' transparent `Node.prototype.createElement` dispatch (`fui:plugs/webcontexts/Node.contexts.patch.ts:52-70`) are the **same mechanism** — both residue; the missing standard is a *construction/insertion lifecycle hook*.

**Parity marking (how the residue is recorded):** per-public-API-member state uses the caniuse-shaped **3-state** vocabulary — `works` (≈ `y`), `works-with-caveat` (≈ `a` / BCD `partial_implementation`, **mandatory note**), `plugged-only` (≈ `d`, gated — references the residue justification). A 2-state binary is rejected (drops the real caveated-but-working middle). The verdict is a **measured fact about the FUI runtime**, so it is stored **FUI-side** (e.g. `fui:plugs/<plug>/parity.json`) and surfaced to the doc-site table via the existing cross-origin data path; WE exposes **at most a type-only schema** — never the values (#606/#1282 zero-impl: a measured impl verdict in a WE contract file is a FUI→WE leak).

**Lineage:** #1839 (this ruling — both forks ratified 2026-06-27); refines #1826 ("residue minimal + justified") and [native-first-baseline](#native-first-baseline)'s plug corollary; grounds the #1840 re-audit (the bar = its per-API verdict) and #1844 (the parity-table schema). Prior art: caniuse `y`/`a`/`n`/`d` + MDN BCD `partial_implementation` + note. *Confidence: high — both alternatives are defeated by forced invariants (the epic's minimise-residue goal; the #1282 contract↔impl cut), and the contract-vs-capability discriminator is grounded in two real cases.*

### Observe-only posture spectrum between unplugged and plugged — semantics never altered; deferred-not-sync; pure-observation folds into unplugged {#observe-only-posture-spectrum}

Between **unplugged** (manual `register`/`upgrade`, zero global footprint) and **plugged** (full prototype
patching that reaches true residue) sits a family of **observe-only postures** whose **invariant is that native
method semantics are never altered** — they only observe and, at most, schedule a deferred `upgrade(root)`.
Three forced rules govern this band:

- **Substrate is a prototype-method wrapper, not a `Proxy`.** Mirror what plugged already does — `const o =
  proto.m; proto.m = function(…){ observe(this); return o.apply(this,…) }` — because plugged itself reassigns
  prototype members (there is **no `new Proxy` in the plugs tree**). This is strictly safer than a `Proxy` (no
  identity break, no `instanceof` surprise). The observation **instrument is global, never per-root**: per-root
  cannot see roots unowned code never hands you (whatwg/dom#1287 "extremely wasteful"; native
  `customElements.upgrade` uses a realm-level candidate registry).
- **Upgrade scheduling is deferred (microtask-batched), never synchronous-on-detect.** Synchronous upgrade
  mid-call is **behaviorally equivalent to plugged** — it re-enters the page's own mutation with the same
  construct-and-swap — so choosing it **dissolves the posture boundary** that justifies the band existing. Batch
  into a dirty-`Set`, flush once per microtask over a snapshot; ship a synchronous **`flush()`** escape hatch for
  the foreseeable live-read-before-flush window. (Dedup is **cost-load-bearing**, not cosmetic: `upgrade` re-walks
  every plug with no early-return.)
- **Pure-observation that patches *nothing* belongs inside unplugged, not as a separate rung.** A capability
  recoverable by a **global `MutationObserver`** alone (any connected insertion, post-hoc) patches no prototype
  member, so it does **not** violate unplugged's no-patching invariant and should **fold into unplugged** as a
  config-selectable `autoUpgrade` knob (candidate default-on, but always overridable — a global observer is
  semantics-safe yet **not footprint-free**). A posture only earns separate-rung status when it **must** patch a
  method to do its job (e.g. **diagnostic** needs call-site + creation-time attribution that `MutationObserver`
  cannot give). The boundary with plugged stays the [residue bar](#plugged-only-residue-bar): true residue
  (`createElement`-at-creation tagging) is reachable only by patching, so it stays plugged-only.

**Lineage:** #1872 (this ruling — both forks ratified 2026-06-27), under epic #1836 (every plug functional
unplugged). Builds on the [residue bar](#plugged-only-residue-bar) (the live portability predicate this band
applies) and [native-first-baseline](#native-first-baseline); the selected-posture value is a
[config-extends-platform-default](#config-extends-platform-default) dimension (enum/contract → WE type-only,
instrument + queue → FUI, value → project config). Successor build #1899. *Confidence: high — per-root and
sync-on-detect are each defeated by forced invariants (un-handed roots; the posture-boundary collapse); the
wrapper-vs-`MutationObserver` instrument split is left to a measured capture investigation in #1899.*

### Shape a new contract's surface by platform idiom, not capability {#contract-surface-platform-idiom}

When inventing a **new** protocol surface, pick the API shape the platform already uses for that *kind* of
thing — and never justify a shape by a capability difference that does not exist. A relationship to another
element that is **declared by an IDREF attribute** is a **writable element-reference property**
(`popovertarget`/`popoverTargetElement`, `for`/`htmlFor`), **not** a method; only the **derived/resolved
chain** stays read-only (`parentNode`, `assignedSlot`, `label.control`). A new propagation/visibility concern
that is **orthogonal** to an existing platform flag gets its **own flag** — never an overload of the existing
one (`composedLogical`, not a reinterpreted `composed`). "Use a method so we get validation/events" is a
**non-reason**: an accessor's setter validates and fires events exactly as a method does, so decide on idiom,
not capability.

**Lineage:** #1000 (Web Portals contract shape — `logicalParent` writable element-reference property +
`composedLogical` separate flag; the capability-not-idiom trap was caught by author review). Refines
[native-first-baseline](#native-first-baseline) (this shapes *new* surfaces to the platform; that floors on
*existing* features) and relates to [surface-contract-not-computation](#surface-contract-not-computation) and
[compose-intent-dont-duplicate](#compose-intent-dont-duplicate) (Web Portals composes Focus Containment, Q3).

### Behavior activation lifecycle — connected ≠ active {#behavior-activation-lifecycle}

A behavior (webtraits `CustomAttribute`) has **two orthogonal states**: **connected** (in the DOM, via
`connected/disconnectedCallback`) and **active** (should actually run, via a shared `activate()`/`deactivate()`
lifecycle). They are independent — a connected behavior can be dormant. Activation boundaries **reuse native
attributes** (e.g. `inert` marks a dead-zone) rather than inventing markers; **auto-dormancy is scoped by
meaning** to interaction-driven behaviors only; and a per-usage `<trait>-active` override re-enables. The
lifecycle contract is specified **once** and consumed by every activation gate (visibility #221, inert
dead-zone #222) — gates don't each re-derive what "active" means.

**Lineage:** #221 #222 (behaviour activation / inert dead-zone). Distinct from [guard-gate](#guard-gate)
(predicate-gated *transitions*; this is behavior *run-state*).

### Persistent-B element over a data-array kernel: source by typed property, not markup parse {#persistent-b-data-source}

A **persistent-B** `we-` element (the styled, light-DOM, **no-shadow** element hosting a kernel — per #1457)
whose kernel **renders the semantic DOM from a data array** (e.g. `TreeSelectBehavior(host, nodes, opts)`,
which does `host.innerHTML = ''` then builds) sources that array from a **typed property** (`.nodes` /
`.items` / `.rows`), mirroring `fui:blocks/wizard/WizardElement.ts` (property-sourced render-from-data) —
**not** by parsing author light-DOM markup. Markup-parse-as-primary is rejected *for this kernel shape*: peers
that treat markup as source-of-truth (native `<select>`, Open UI, `<sl-tree>`) do so behind a **shadow root**;
a no-shadow render-from-data kernel **destroys** any parsed markup on its first `innerHTML=''`, so the parse is
ceremony with negative payoff. The typed property is the floor. An **optional** declarative form is a binding
expression on the element's **own** observed attribute (`nodes="[[ data.tree ]]"`), resolved in the element's
own lifecycle by reusing `we:plugs/webexpressions/CustomExpressionParser` as a library — explicitly **not** a
globally-registered `CustomAttribute` over arbitrary elements (that is a framework-grade any-element binding
surface WE avoids); for data-array content, binding a *reference to a data source* is the right declarative
form, not hand-authored structural markup. **Scope guard:** this is specific to **render-from-data** kernels;
a **light-DOM-scan** kernel (`CustomAttribute` enhancing authored markup in place — type-ahead, data-grid,
stepper) has *no* data-source fork and mirrors `StepperElement` verbatim.

**Lineage:** #1570 (ratified — tree-select data-source; #1568/#1569 confirmed fork-free). Consumer refinement
of #1457 (support-both, element-over-behavior). Builds: #1567.

### Block data-ingestion: one `[[ ref ]]` form, resolved by determinism × interactivity {#block-data-ingestion}

A render-from-data `we-` block (per [persistent-b-data-source](#persistent-b-data-source)) sources its complete
data (rows/options/config) from **one declarative form** — an attribute web-expression `rows="[[ ref ]]"`
binding to a **context**, with the typed JS property `.rows`/`.config` as the imperative floor it sets. There is
**no second ingestion shape**; what varies by situation is *where the binding resolves* and *whether the resolved
data is shipped to the client*, set by two orthogonal axes:

1. **Determinism** — is the context **build-known**? The `webexpressions` evaluator is **DOM-free**
   (`CustomExpressionParser.evaluate(ResolvedValues)` takes a pre-resolved `contexts` map; the DOM coupling is
   only the *runtime* text-node binding layer), so a **deterministic** binding **resolves at build time**: the
   server supplies the context, evaluates, renders a plain `<table>`, and drops the binding. A **non-deterministic**
   (client-only) context can only resolve in the client.
2. **Interactivity** — does the client **re-render** (sort/filter)? If not, nothing is shipped. If so, the resolved
   typed data is shipped to the client.

|  | **non-interactive** | **interactive** |
|---|---|---|
| **deterministic** | server resolves → plain `<table>`, ship nothing | `<table>` baseline **+ serialized resolved context** (inert `<script type="application/json">`) for client re-render |
| **non-deterministic** | client resolves + renders once | ship binding **+ runtime context hydration (#1827)** — the app case |

The familiar paths are **derived consequences, not separate forms**: a "simple SSR table → plain `<table>`" is the
deterministic + non-interactive cell; a "JSON island" is the deterministic + interactive cell (the island *is* the
serialized resolved context — same source of truth, no hand-authored twin); runtime injector hydration is only the
non-deterministic cells. **Correctness invariant:** the server-resolved / serialized payload always carries the
**raw typed values**, so any client sort runs on raw `field` values — **nothing reparses rendered `<td>` text**
(a key recovered from rendered text is silently wrong on cells like `Baseline 2026` or `✅`).

**Precedence.** The typed JS property is **authoritative**; `[[ ref ]]` is the declarative path that sets it, and an
explicit imperative property set **wins over** a binding (a late-resolving async binding must observe this and no-op).
Raw author markup is **never** a data source for a render-from-data kernel (its kernel attaches a freshly-built tree
via `replaceChildren`, discarding any parsed markup) — markup-as-source stays exclusively the **light-DOM-scan**
kernel's contract; the two kernel shapes never mix in one element.

**Lineage:** #1818 (this decision — ratified) extends [persistent-b-data-source](#persistent-b-data-source) (#1570)
with the resolution-locus + client-payload axes. Surfaced by #1787 / the #1600 table→data-table family (all
deterministic, ship without #1827). Follow-on: #1827 (SSR injector-context hydration, app-facing) — its
production-consumer slice #1928 landed the runtime seed (`seedDeclarativeInjector`) wired to a real
non-deterministic client-only surface (a live board whose polled `rows` resolve `[[ @rows ]]` at upgrade),
plus the `@name → customContexts:name` key-derivation sugar so a consumer seeds under the exact key a live
context-query reads. Open impl
residuals (mechanism may flex, goal fixed): the determinism predicate, the build-time evaluation harness, the
serialized-context format — **all three filled by #1867** ([#ssr-data-table-build-harness](#ssr-data-table-build-harness)),
which refines the "JSON island" sketch above to a **`data-*`-on-cell + in-place enhancer** interactive format (the
raw-typed-value correctness invariant is preserved; only the transport mechanism changed).

### Forward (generation) adapters for polyglot reach {#forward-generation-adapters}

A WE standard projects **outward** into non-JS / enterprise runtimes (.NET, Java, Go) via a
**forward/generation adapter** — the inverse of an ingest adapter. The authority is a **language-neutral
contract/IR** (no language, *including JS*, is privileged); **generation is deterministic** (byte-identical
output; AI assists only at adapter-*development* time, never in the gen path or the gate); and a **shared
cross-language conformance suite gates every target's release**. The forward adapter is a WE `webadapters`
standard artifact; the generated origins are ecosystem impl, and any served product is Plateau (per
[constellation-placement](#constellation-placement)).

**Lineage:** #463 (ratified — polyglot MaaS origin generation) · builds #505/#506/#507. Relates to
[surface-contract-not-computation](#surface-contract-not-computation) (neutral contract is the SoT).

#### Browser-component emit substrate is a dedicated emit-purpose IR, not the ingest rep {#forward-emit-dedicated-ir}

For the **browser-component** member of the forward-generation family — emitting idiomatic per-framework
source (Vue/Svelte/Angular) — the canonical substrate is a **dedicated emit-purpose IR (Option C)**, a neutral
`@webeverything` contract authored for generation, **not** a bidirectionally-extended ingest `ComponentIR`.
**Direction ratified** (#939): the ingest rep is a deliberately *lossy* subset (its `notes` field records what
it **drops** — exactly the styling/event/slot/reactivity detail emit must preserve), so reusing it as the
high-fidelity emit substrate degrades the fidelity the fork exists to deliver and forces two conflicting
invariants into one schema (violating *bias-toward-separation*). The lone shipping precedent (Mitosis) built an
emit-shaped `MitosisComponent` rather than reuse its ingest rep. The per-framework serializers are forward-adapter
artifacts (each #506-gated); the live render stays FUI-hosted.

**Shape held, not the direction.** Option C's *contract shape* (its fields/grammar) is held on an **evidence
trigger** — designed once the idiomatic Vue/Svelte/Angular emitters accumulate real cases showing where the flat
declarative `<component>` subset stops stretching, rather than guessed today (#811's "decide with cases, not
guess"). Tracked as the parked residual.

**Lineage:** #939 (direction ratified) — de-buried from #818, grounded in #811 Fork 2
([report](../../reports/2026-06-16-forward-component-emit-substrate.md)). Applies
[bias-toward-separation](#bias-toward-separation) and synthesizes [forward-generation-adapters](#forward-generation-adapters).

#### New-target start gate: every new generation target/form starts by citing current external-adopter evidence {#forward-target-start-gate}

The **start-gate sibling** of the release condition above ("the conformance suite gates every target's
*release*"): **every *new* polyglot-widening item — by predicate, not item list: an item that adds a new
generation target or emit form (a further language target, a new wrapper form, any new forward-generation
scope) — may not start until it cites *current* external-adopter evidence** about the forward-generation
contract surface. Encoded as a hard `blockedBy` edge at scaffold time; the bootstrap instance is the Gate-A
pilot retro (#2129 — one criteria-bound external pilot whose required generated-artifact leg touches an
existing emit target), and later targets cite evidence *current at their filing*, never the stale first retro.
Rationale: the serve-path IR and target idioms have never met a consumer who didn't write them — widening
without external evidence risks standardizing the wrong contract; every surveyed graduation process (TC39
Stage 4, W3C CR exit, IETF RFC 6410, Kubernetes GA, Rust stabilization) makes independent experience a hard
input, encoded structurally, never as a memo. **Out of the gate by the same predicate:** maintenance of
shipped artifacts, and work that consumes existing emit forms without adding a target/form (the workbench
live-test family). **Exempt:** the emit-purpose IR widening (#1735) — it is governed by the ratified
empirical trigger in [forward-emit-dedicated-ir](#forward-emit-dedicated-ir) ("not a backlog edge"); the two
gates agree in kind (both adoption-evidence triggers) and compose by scope (this edge governs new
targets/forms; that trigger governs the IR widening). The gate is **prospective** — it governs the next
widening, never retracts shipped increments.

**Lineage:** #2089 (ratified 2026-07-02 — external-validation sequencing, from the 2026-07-01 external-review
finding 2). Composes with [forward-generation-adapters](#forward-generation-adapters) (start condition beside
its release condition) and [forward-emit-dedicated-ir](#forward-emit-dedicated-ir) (exemption above).

### Standard consumability: author to the standard, ship removable agnostic adapters {#standard-consumability}

**How a WE standard reaches consumers with zero lock-in.** A standard is a *guarantee*; making it work today
is a separable, removable concern. **Three layers, never conflated:** **(1) contract** = the guarantee (WE);
**(2) authoring source-of-truth** = the standard's *own form* — write to the platform (e.g. `@scope` CSS),
**never a tooling/impl format**; when the native form ships, the adapters drop and the authored source is
unchanged (minimize-lock-in / graceful-degradation applied to *authoring*, not just runtime); **(3)
impl/lowering** = removable *make-it-work-today* adapters (build-transform / runtime polyfill).

The lowering is **one pure, agnostic transform core + thin adapters**, and the adapters span every
consumption axis — which are **orthogonal**: **timing** (build / serve / runtime) ⟂ **host/bundler** (vite /
rspack / webpack / esbuild / rollup / CLI — *none privileged*; a project must consume **uncompiled** source
with **its own** bundler) ⟂ **guarantee-strength** (the Configurator dimensions). Expose these as **config**,
never as authoring choices — that is what "more than one valid way available to the user" means. The
trait-enforcer is the reference shape (pure functions + per-bundler shims over a WE-resident contract).

The **only lock is the contract + conformance** (the single escapable protocol lock); reference tools are
optional and swappable. **Placement:** contract + conformance vectors → WE; the reference transform + adapter
family → published impl/tooling (FUI-owned, zero-lock-in), **never `@webeverything`** — the contract crosses
the seam, the tool does not. Conformance is what makes the standard adoptable *independent of* the reference
tool.

**Lineage:** synthesizes [forward-generation-adapters](#forward-generation-adapters),
[framework-free-core-vendor-segregation](#framework-free-core-vendor-segregation) (the bundler-agnostic
axis), [native-first-baseline](#native-first-baseline),
[config-extends-platform-default](#config-extends-platform-default), and the #855 generator-is-a-tool /
npm-scope-mirrors-layer rules under [constellation-placement](#constellation-placement). First worked
instance: #1377 (webisolation L2 — author base `@scope`; pure PostCSS core + per-bundler adapter family).

### Authoring form ids are distinct from consume-mode wrapper ids; served source emits as data, the endpoint owns transpile {#authoring-form-id-distinct-from-consume-wrapper}

An **authoring form** (lowers a `<component>` definition to a target shape — e.g. `functional`, `wc-class`)
and a **consume-mode wrapper** (wraps an *already-built* artifact for a framework — e.g. `react-wrapper` via
`genWrapper`) are **distinct artifact kinds in disjoint id-spaces**, reached by different endpoints. One
stable id per authoring form; **never alias an authoring form id onto a consume wrapper** — that is exactly
the ambiguity #977 removed. WE owns one neutral catalog-gated `form` param; the value-set is the serving
runtime's injected catalog ([impl-is-not-a-standard](#)).

The served authoring artifact follows a **data-emit-for-display / endpoint-for-execution split**: WE's
deterministic `serve()` emits the authoring *source* as data (#954 channel →
`we:src/_data/authorModeSource.json`) for the panel to *display*; the *mountable* artifact is transpiled at
the FUI endpoint via the injected `compilerRegistry` (the delivery layer registers the compiler), the same
rule as `genWrapper` transpile. FUI reads the emitted data and **never imports WE's `serve()`**.

**No-consumer corollary:** a backward-compat shim (e.g. a retired-form alias served as a deprecation
redirect) with **zero real callers** is dead weight — verify the consumer graph, then **drop it rather than
design around it** (e.g. rename a colliding id). No consumer ⇒ no backward-compat obligation.

**Lineage:** #1619 (ratified — FUI functional-component adapter shape) · #954/#956 (data-emit channel) ·
#974/#977 (wrapper-form catalog + `functional` retirement) · #700 (emit placement). Refines
[runtime-DI-seam](#runtime-di-vs-devtools-provider-seam) (the `compilerRegistry` endpoint seam) and
[constellation-placement](#constellation-placement) (contract+data → WE, serving endpoint → FUI).

### The MaaS origin serves only self-contained modules; plug-mode is a consumer-side axis, never the served form {#maas-serves-self-contained-modules-only}

Plug-mode (global-patching `bootstrap` vs functional) and the MaaS serve catalog are **orthogonal axes**.
The served catalog is **delivery-shape** only — `?form=react-wrapper|vue-wrapper|react-live|vue-live`
(`fui:tools/maas/vite-plugin.mjs`) and `?variant=functional|live` on the separate `/_maas/fn/` route
(`fui:tools/maas/functionalServeHandler.mjs`, #1681); `plugged`/`unplugged` is **not a member of either
catalog**. The serve-path invariant: **every `form`/`variant` the origin serves must be a self-contained
module** — imported without patching host globals, self-registering scoped. The host consumes by cross-origin
`import(servedUrl)` then `document.createElement(tag)` (`fui:workbench/loader.ts:63-67`); the served bytes
register their own element as an import side effect.

A **plugged / host-global-patching served form is forbidden because it is incoherent**, not merely
dispreferred (forced-invariant — one branch is mechanically impossible): a module fetched by cross-origin
`import()` runs in its **own realm**, so its `window`/prototype patches (`fui:plugs/bootstrap.ts` patches the
importer's `window.WebEverything`) never reach the *host*, and the host's `createElement` path never reads
patched globals. Plugged therefore stays a **consumer-side** dev entry — the app imports
`@frontierui/plugs/bootstrap` itself, never over the wire. A genuinely plugged-only capability is
**marked-and-omitted**, never served plugged: the served module sets `X-MaaS-Lossy`
(`we:blocks/renderers/module-service/servePathIR.ts:57`) and the parity table records it `plugged-only`
([#1839](#)). The invariant is a guarantee about the **protocol's wire behavior** (every cross-origin
consumer relies on it) so it homes on the neutral serve-path contract (`we:servePathIR.ts`), validated by
the FUI serve handlers/catalog ([impl-is-not-a-standard](#); same contract/subject split as #1467). It
**constrains what any catalog entry may be**, not a default `form` value (the `form` value-set stays an
injected catalog the contract deliberately leaves open — [authoring-form-id-distinct-from-consume-wrapper](#authoring-form-id-distinct-from-consume-wrapper)).

**Lineage:** #1838 (ratified 2026-06-27 — Fork 1a; forced-invariant, the plugged-served branch is broken
across `import()`; skeptic REFUTED-AND-REGROUNDED→SURVIVES [re-grounded the original `?form=plugged` framing
onto the real seam]; red-team impl-is-not-a-standard FAILED [the invariant is contract-level]; prep
`we:reports/2026-06-27-unplugged-plug-parity.md`). Parent epic #1836 (W5); build slice #1843. Reconciles
#1841 (resolved `graduatedTo: none` — the incoherent plugged-serve axis was never shipped). Sub-fork — the
plugged-only residue bar — delegated to #1839. Sibling of
[authoring-form-id-distinct-from-consume-wrapper](#authoring-form-id-distinct-from-consume-wrapper) and
[we-data-crosses-via-fui-served-route](#we-data-crosses-via-fui-served-route) in the MaaS serve cluster;
instances of [constellation-placement](#constellation-placement) (contract → WE, serving → FUI) and
[impl-is-not-a-standard](#).

### A workbench/explorer block may be source-only — relax the host contract, never manufacture an unused live instance {#source-only-workbench-block}

When a host surface (the FUI workbench / block-explorer) wants to present a case whose real content is **emitted source + diagnostics** — a declarative `<component>` author-source case, no imperative element — host it as **exactly what it is**: let the block carry `authorSource`/`cem` with **no runnable `load`/`create`**, and have the shell render the source/CEM panels while **skipping the live-instance panels** (theme/trait/inspect). Do **not** wire a `<component>`→live-element lowering just to manufacture an instance the source panel never reads — the author-source renderer consumes `{name, definition, forms[]}` **data only** (`fui:workbench/authorMode.ts` `renderAuthorModePanel`, gated on `block.authorSource` in `fui:workbench/mount.ts`), so a synthesized instance is coupling no consumer reads (bias-toward-separation; faithful-shape). The relaxation is **additive** — the live-instance path stays mandatory for blocks that have one; a live-declarative-render runtime remains a **separate** capability, filed when a consumer that mounts the declarative case live actually exists. This rule fixes the host **contract** (a block *may* be source-only); the **acquisition mechanism** (hardcoded `WorkbenchBlock` literal vs resolved from the FUI `/_maas/` serve URL) is a distinct axis decided separately.

**Lineage:** #1701 (ratified 2026-06-24 — Fork 1 → (a) source-only `WorkbenchBlock`; (b) live-`<component>`-runtime excluded on the unneeded-coupling axis, no #746 consumer reads an instance; skeptic SURVIVES; prep `we:reports/2026-06-23-workbench-declarative-component-hosting.md`). Unblocks the #1618 Attachment slice. Acquisition-mechanism axis → #1731. Refines [authoring-form-id-distinct-from-consume-wrapper](#authoring-form-id-distinct-from-consume-wrapper) (data-emit-for-display split) and [constellation-placement](#constellation-placement).

### One authoring source-of-truth; a serializable form is a derived projection, never a second authoring home {#single-authoring-sot-derived-projection}

When a standard has a **native declarative authoring form** (HTML/DOM — `<template route>`, `<component>`, declarative markup) and a non-DOM consumer wants a serializable view of the same data, keep the **declarative form canonical** and **derive** the serializable form from it (DOM→data); do **not** make the data form a *second authoring home* (authoring-SoT-is-the-standard's-own-form, HTML-first). Two authoring homes for the same artifact = drift and violates single-SoT — and the fork-existence test usually finds a consumer for a *derived* data form but **none** for a data *authoring* form (incumbents author in code arrays only because they **lack** a native declarative form; we have one). The derived projection still **decides something now even when its builder is deferred**: it **forbids the dual-authoring branch** and **fixes the projection shape as the cross-consumer contract**, while the *builder* is folded into the first consuming slice ([build-when-a-consumer-exists](#)). Derivation need not be DOM-free (a headless DOM to run the existing parser is fine); the projection covers **statically-authored** entries only, and a serializable *input* path for **runtime/dynamic** entries is a **separate, non-conflicting** capability that reuses the *same* schema as its input contract (static vs dynamic are disjoint sets → single-SoT-per-entry holds). The projection stays an internal WE schema + conformance vectors until a 2nd independent impl conforms ([impl-is-not-a-standard](#); protocol temporal rule).

**Lineage:** #1685 (ratified 2026-06-23 — webrouting route-format: declarative `<template route>` is the authoring SoT, derive a serializable route-map for sitemap/prerender; prep `/research/route-table-authoring-source-of-truth`; skeptic SURVIVES-WITH-AMENDMENT; runtime/lazy ingestion split to #1720). Refines [authoring-form-id-distinct-from-consume-wrapper](#authoring-form-id-distinct-from-consume-wrapper) (data-emit-for-display split) and [configurability-partition](#configurability-partition) (declarative = the portable standard).

### A faithful derivation excludes what it cannot derive and realizes a declared axis — never fabricates a missing input, never re-derives a second home {#faithful-derivation-exclude-not-fabricate}

When a standard ships an **open registry of emitters/derivers** that each project the *same* canonical source ([single-authoring-sot-derived-projection](#single-authoring-sot-derived-projection)) into a downstream artifact, the registry is **support-all behind a default-less pluggable set** (the composability probe passes — each emitter is a facade over the one kernel and cannot conflict; new emitters join without a decision per [config-extends-platform-default](#config-extends-platform-default)). Build-order across emitters is **burndown, not a fork** (both orders agree on the end-state — all emitters exist). Two faithfulness rules govern any single emitter:

- **Exclude, never fabricate, at a lossy boundary.** Where the projection is lossy (a parametric `/users/:id` template has no concrete URL without an external value source), a concrete-output emitter **excludes** the un-derivable entries **by default** and reopens them via an **opt-in author-supplied source** (`generateStaticParams`-shaped); pattern-preserving emitters consume the template form directly. **Fabricating** a placeholder (`/users/0`, literal `:id`) is the named broken branch — it emits artifact-invalid fictions (SEO-poisoning, 404-prone). Requiring a source on *every* emitter is over-restrictive (punishes pattern-preserving emitters that never need concrete values) → most-flexible-default: the restriction is the author's opt-in. A skip is **surfaced** (build-time notice), not silent — but the notice changes no artifact, so it is an ergonomic affordance, not a third branch.
- **Realize a declared axis; never stand up a second home for it.** When a derived artifact describes the *same* structure a declared intent axis already owns (an IA nav-tree vs the Navigation Intent's `structure` axis), the emitter **realizes** the declared axis (one composed home: intent = UX declaration, emitter = derived artifact); deriving an independent artifact that can silently contradict the declaration is the two-unreconciled-homes drift [single-SoT](#single-authoring-sot-derived-projection) forbids. The fallback to a self-derived shape applies **only when nothing is declared** (the degraded case of realize, not the rejected independent-derivation branch).

**Lineage:** #1688 (ratified 2026-06-24 — webrouting route-table derivations: emitter set support-all; Fork 1 → (a) exclude-by-default + opt-in param-source + pattern-predicate + build-time skip notice; Fork 2 → (a) IA-tree realizes the Navigation Intent `structure` axis + intentless path-nesting fallback; both skeptics SURVIVE; prep `/research/webrouting-route-table-derivations`; reads now-resolved #1685). Build slices graduate to epic #1684 via `/slice 1684` (emitter registry + four emitters as separately-prioritized items + the Fork-1 param-source hook). Sibling of [single-authoring-sot-derived-projection](#single-authoring-sot-derived-projection) and [url-as-state-per-component-seam](#url-as-state-per-component-seam) in the webrouting cluster; instances of [config-extends-platform-default](#config-extends-platform-default), most-flexible-default, and [native-first-baseline](#native-first-baseline) (Speculation Rules / `sitemaps.org/0.9` substrates).

### URL-as-state is a per-component router-agnostic seam behind a typed codec lock; write-coordination lives at the component, never a central provider {#url-as-state-per-component-seam}

When a stateful component projects state to/from the URL (a grid's filters/sort/page, a tab, a wizard step, pagination), the canonical seam is **per-component declaration**, not a central router-coupled provider. A component **declares which slices sync** router-agnostically — so it syncs whether or not a router is mounted (the pagination precedent already writes the URL router-free; a central provider would couple every stateful block to a mounted router and break the standalone case). Three facets ratify together:

- **Codec is a typed per-slice strategy-lock, not raw strings.** Each syncable slice has a declared `serialize/parse` + coercion contract (number/boolean/enum/date/array, raw-string escape hatch) — a registry like [`CustomStorageStrategy`/`CustomChangeStrategy`](#) so Zod/nuqs *plug in* behind it; WE ships the contract, never the parser. Raw `URLSearchParams` strings are provably insufficient (they force the per-component coercion drift already visible in pagination's ad-hoc `Number(raw)`), and no existing layer owns string↔typed URL coercion (webexpressions is a `{{ }}` binding layer; the storage protocol self-excludes non-durable facets).
- **Write-coordination is scoped to two mechanisms, both component-side.** Intra-component **microtask coalescing** (always — one write per component per tick, History-presence-guarded for SSR/no-DOM) plus an **optional coordinator** that batches *cross-component* concurrent writes into one history entry (the nuqs batching model). Both write paths share the **same** per-slice codec — only the commit (one entry vs N) differs — so there is one encoding, not two. A pure-per-component variant with no coordinator is rejected (re-creates cross-component history-spam).
- **Placement: webrouting owns the URL persistence facet.** The "URL or not" axis is the navigation intent's `persistence` (`url | session | memory`, `we:src/_data/intents/navigation.json`) generalized per slice — never a webstates storage strategy (the storage protocol is scoped to durable structured-record stores ONLY and carves out the shareable/navigable/history-tied URL). Sync is **never forced**: per-slice opt-in with a permissive non-URL default (most-flexible-default). Contract clauses spelled out at build: namespaced query keys (collision arbiter), popstate/navigate is the read source of truth (back/forward restores true state), pure codec + History-presence-guarded writes.

**Lineage:** #1686 (ratified 2026-06-23 — Fork 1 → (c) per-component declaration + shared codec + optional coordinator; Fork 2 → (b) typed per-slice codec; both skeptics SURVIVE; prep `/research/url-as-state-component-seam`; reads now-resolved #1685). Build slices carve under epic #1684 (codec contract + declaration/coordinator seam + conformance vectors; pagination's ad-hoc `urlSync` migrates onto the seam). Sibling of [single-authoring-sot-derived-projection](#single-authoring-sot-derived-projection) in the webrouting cluster; instances of [runtime-di-vs-devtools-provider-seam](#runtime-di-vs-devtools-provider-seam) (the codec is a runtime strategy-lock) and most-flexible-default.

### Runtime/dynamic route ingestion reuses the injector seam with a distinct runtime route-object shape — not the serializable projection; resolution is name-by-DI default / inline override; precedence is config-extends-default, not a knob {#webrouting-runtime-route-ingestion}

`route-view` ingests static `<template route>` children today; the **runtime/dynamic** path (dynamic route objects + lazy component-from-URL) reuses the **injector-context DI mechanism** (`fui:plugs/webinjectors/InjectorRoot.ts`) — a new sibling `customContexts:routes` key — carrying a **distinct runtime route-object shape** `{ path, guard?, guardLeave?, loader?, outlet?, isErrorBoundary?, component? }`. That shape is **not** the #1685 serializable projection: `buildRouteMap` drops the non-serializable `pattern`/`template` and its closed `ENTRY_KEYS` rejects a component field, yet the engine must have a `template`/component to stamp (`fui:blocks/router/elements/RouteViewElement.ts:498`) — so #1685 is the **serialization/transport** contract, *never* the live engine input. (This **refines** [single-authoring-sot-derived-projection](#single-authoring-sot-derived-projection), which had anticipated the runtime input "reuses the *same* schema" — it reuses the *mechanism*, with its own runtime shape.) Four facets ratify together:

- **Reuse the mechanism, add a value shape (not a new contract).** `customContexts:routes` is set/read exactly like `customContexts:routeLoader`; only the value shape is new. A brand-new provider API is rejected (forks the seam for no payoff).
- **Resolution is name-by-DI *default*, inline-fn *override*** — for loader/guard and component alike. A route object references a callable by **name** (resolved through the inherited injector maps) *or* carries an **inline function/thunk** used as-is. The serializable/DOM form stays **string-only** (names + specifiers); inline fns are a JS-runtime affordance the #1685 projection drops — so the serialization contract is untouched. This is most-flexible-default: name-DI and inline are both *optional*, never a *mandatory* registry (the rejected branch).
- **Lazy component = `route:component`** inline `() => import()` thunk (JS) / bare specifier string (DOM); the data `route:loader` stays independent and eager. Named `route:component` (not `route:module`) to disambiguate from the data loader and match Angular/Vue (`loadComponent`).
- **Three authoring surfaces, all merging under one precedence config.** (i) DOM `<template route>`; (ii) the `customContexts:routes` injector provider; (iii) a settable `routes` property on `<route-view>` (the getter already exists, `fui:blocks/router/elements/RouteViewElement.ts:48`). Merge precedence is **not a bespoke knob** — it is a `mergePrecedence` field on the platform default config ([config-extends-platform-default](#config-extends-platform-default)): default `static-first` (static-first concatenation, first-match-wins, + a `console.warn` shadowing diagnostic mirroring `[Router] Invalid route pattern`, `fui:blocks/router/types.ts`), a project config *extends* to override (`dynamic-first`). Adding an unused per-view/per-provider knob ahead of a consumer is the rejected anti-pattern. A nested `route-view` must **merge** the resolved `customContexts:routes` with its local static parse, never let `getProviderOf`'s first-found-wins **shadow** it (shadowing a route *set* is data loss, unlike a benign fn-map).

**Lineage:** #1823 (ratified 2026-06-27 — Fork 1 → (a) reuse injector + runtime shape + merge-not-shadow [skeptic REFUTED→flipped off the #1685-as-input branch]; Fork 2 → (a) `route:component` inline/specifier + name-DI/inline-override resolution + settable `routes` property [skeptic SURVIVES-WITH-AMENDMENT]; Fork 3 reframed fork→dimension delivered by config-extends-default [skeptic SURVIVES-WITH-AMENDMENT→REFRAMED]; prep `/research/webrouting-runtime-route-ingestion`; reads ratified #1685/#1721). Unblocks build story #1720 (`blockedBy: ["1823"]`). Sibling of [single-authoring-sot-derived-projection](#single-authoring-sot-derived-projection), [faithful-derivation-exclude-not-fabricate](#faithful-derivation-exclude-not-fabricate), and [url-as-state-per-component-seam](#url-as-state-per-component-seam) in the webrouting cluster (epic #1684); instances of [config-extends-platform-default](#config-extends-platform-default), most-flexible-default, and [runtime-di-vs-devtools-provider-seam](#runtime-di-vs-devtools-provider-seam).

### A lazy `route:component` module→tag contract is the auto-define dimension; preset-flavor default is on-import self-register + tag-on-route, engine stays default-less {#lazy-route-component-auto-define-default}

#1823 settled that a runtime route object carries `component` = `() => import()` thunk (JS) / bare specifier (DOM) but **deferred how that module becomes a stampable tag** (the engine stamps by cloning a concrete `template`, `fui:blocks/router/elements/RouteViewElement.ts:498`; a lazy module yields neither a template nor — by default — a tag). This is **not a three-way fork** — `on-import` self-registration and `engine-defines` are both named end-states on the ratified **`auto-define` configurable dimension** ([config-extends-platform-default](#config-extends-platform-default), #227), so the call is to set the *default*, not bake a mechanism:

- **The route-engine code is default-less** — it resolves the auto-define strategy from settings, never a constant in the engine (the `CustomRegistry.extends` precedent; core stays default-less).
- **The platform-preset flavor ships `on-import self-register + tag-on-route`** — the lazy module **defines its own element as an import side-effect** (dominant ESM idiom); the **`tag` rides on the route value** (a companion field / `route:component-tag` attr in DOM, never read off the module); the engine `await`s the load then `createElement(tag)` and **never calls `customElements.define`**. Mirrors the ratified block loader field-for-field (`await load()` → `createElement(shape.tag)`, `fui:workbench/loader.ts:56-68`, #1731) and Vaadin (tag-on-route + self-registering import).
- **`engine-defines` (default-export ctor → engine `customElements.define`) is the per-scope override**, reachable through `CustomAutoDefineRegistry` / config-extends-default — **never foreclosed**. It is not the default because it must invent a tag (generation/collision policy), is non-idempotent across navigations (re-`define` throws), and double-defines when the module also self-registers (the common case). The thunk-returns-tag variant folds into the default as a JS-only shorthand (tag arrives as the thunk's resolved value).
- **tag-on-route, NOT a `mod.tag` module export** — no cited precedent reads the tag off the module, and a `mod.tag` export force-fails on third-party elements (you can't add an export to vendor bytes; you can write the tag on your own route).

**Lineage:** #1897 (ratified 2026-06-27 — decision over not-yet-shipped code; Fork 1 reframed fork→dimension; skeptic SURVIVES-WITH-AMENDMENT [`mod.tag`-export sub-default REFUTED→tag-on-route]; statute COLLISION reconciled — worded as the engine's *default*, not an "engine never defines" invariant; prep `/research/webrouting-lazy-component-module-to-tag`). Unblocks the lazy half of build story #1720. Sibling of [webrouting-runtime-route-ingestion](#webrouting-runtime-route-ingestion) in the webrouting cluster (epic #1684); **instances** [config-extends-platform-default](#config-extends-platform-default), reusing the self-register-on-import + tag-on-descriptor precedent of the block loader (#1731).

### Framework-free core; vendor frameworks segregated at the package boundary {#framework-free-core-vendor-segregation}

Frontier UI's **framework-free principle scopes to the core/floor packages only** — *not* identity-wide.
A framework-coupled vendor adapter lives in its **own published `@frontierui/<block>-<vendor>` package**, with
that vendor's framework as a **normal dependency of that package alone**, loaded **opt-in via a plain dynamic
`import()`** so the core's dependency tree stays *provably* framework-free. The whole mechanism is "a published
package + a dynamic import" — **no Module Federation**. If cross-deploy runtime sharing is ever needed, it uses
web-standard import-maps / Native-Federation, never webpack Module Federation (per the bundler-agnostic axis).

**Lineage:** #963 (Slate/React optional-dep fork). Refines — does not duplicate — [constellation-placement](#constellation-placement)
(WE/FUI/Plateau division); this is *intra-FUI* framework containment.

### WE-owned generated data crosses to FUI by build-emit + a FUI-served route, never a bundled read of WE's tree; the executable serve contract stays executable-only {#we-data-crosses-via-fui-served-route}

WE owns the generator for a derived artifact (component **source/CEM**, etc.), but FUI carries **no
`@webeverything` package dependency** and its dev-only sibling aliases vanish at deploy. So WE-generated data
reaches FUI's runtime by a **build-time CLI/copy emit into FUI's own deployable**, then a **FUI-served HTTP
route** the consumer fetches — **never** a bundled/aliased read of WE's tree (deploy-broken) and **never** a
runtime dependency on a live WE-hosted service. One route contract, two byte sources: **dev** runs the WE
generator in FUI's MaaS dev-server *middleware* in-memory (per-request / on file-watch — never stale);
**prod** serves the build-emitted committed copy. This honours #954 (FUI never imports the runtime `serve()`
engine into its bundle — fetching pre-emitted JSON over HTTP is consuming data, not running the transform)
and #700 (no WE package dep). Corollary: the **executable** serve contract (`servePathIR`, `javascript`/
`html`/`error` media + `?form=`) stays **executable-only**; inspection artifacts (source/CEM) get a
**distinct** data route (esm.sh `?raw`-style), never a widening of the executable catalog.

**Lineage:** #1731 (workbench source/CEM crossing). Refines [constellation-placement](#constellation-placement)
(WE/FUI/Plateau division) and #1499 (cross-origin FUI serve); applies #954/#1701 (author-mode data placement).

### Inert workbench display data rides as a static descriptor slot read directly (like `cem`); the FUI-served `/_maas/data/` route is the dev-freshness HMR seam, not the primary transport {#workbench-inert-data-static-slot}

Once a derived **inert display artifact** is generated wholly inside FUI (e.g. author-mode **source** text after #1730/#1282 deleted WE's generator), the workbench consumes it as a **static slot on the thin descriptor** (`authorSource?`/`cem?` in `fui:workbench/registry.ts`) **read directly** for first render (`block.cem`, `block.authorSource`) — synchronous, no fetch. The **primary transport is the static slot**, not a runtime route. Dev freshness rides the **existing `/_maas/data/<tag>.json` HMR re-fetch**: a dev-only watcher (`fui:vite.config.mts` `cemHotReload` pattern) fires an HMR event on fixture change and the workbench demo (`fui:demos/workbench.ts`) re-fetches the data route and calls `refresh()` — never stale, no registry rebuild. `/_maas/`'s **executable** serve role stays reserved for **transpilable live modules** (polyglot React/Vue forms loaded by cross-origin `import()`, `fui:workbench/loader.ts`); static display text never routes through it as its baseline transport. This is not a *live instance*: serving rendered text is "consuming data, not running the transform" (#954), so the slot is inert data, not a behavioural closure, and does not reintroduce the imperative `load`/`create` the workbench banished.

**Caveat — ratified ~80% (#1865).** Revisit if the MaaS layer matures such that `/_maas/data/` becomes the routine transport for *all* descriptor data; the static-slot-as-primary call may then flip to serving author-source directly. Reversal is cheap — the consumer reads `block.authorSource` either way; only where the baseline value comes from changes.

**Lineage:** #1865 (author-mode source generation-home, ratified-with-caveat). Refines [#we-data-crosses-via-fui-served-route](#we-data-crosses-via-fui-served-route) (static-slot baseline vs route-as-dev-seam for inert data); applies #1730/#1282 (WE generator deleted → generation is a FUI concern), #1731 (`cem`/source crossing) and #954/#1701 (author-mode data placement).

### FUI-resident table compute reaches WE's offline build via a pinned subprocess (FUI-compute → WE-build), never a served route; the interactive cell carries its raw sort key as a `data-*` attribute on the SSR `<table>`, never a re-rendering payload {#ssr-data-table-build-harness}

The `<we-data-table>` evaluator and renderer both live in **FUI** (`CustomExpressionParser.evaluate`,
`renderDataTable`); WE's Eleventy build **cannot import** them (a WE→FUI code import is a banned backward DAG edge
per [constellation-placement](#constellation-placement)). So WE's offline build resolves a deterministic
`rows="[[ ref ]]"` binding into an SSR `<table>` across a **process boundary**, on two settled facets:

1. **Boundary mechanism (Fork 1 → a).** WE's Eleventy build **shells out to a FUI build-CLI** — deterministic context
   in (stdin), SSR `<table>` HTML out (stdout) — homing the harness in **FUI** (`locus`/`relatedProject: frontierui`);
   WE orchestrates over the subprocess. This is the **inverse direction** of
   [#we-data-crosses-via-fui-served-route](#we-data-crosses-via-fui-served-route) (that rule is WE-data → FUI-runtime;
   this is **FUI-compute → WE-build**), and it is a **subprocess, not a served route** — the offline-build sibling.
   Three forced amendments: the CLI is a **locked FUI build-artifact version** (incl. the DOM-shim/serializer),
   **never PATH-resolved** (else the build is non-reproducible); the request is **one batched process, keyed-array in
   / keyed-array out**, so one malformed table fails in isolation and is attributable; and **the build never reads the
   dev `/_maas/data/` route** — that route is the dev-freshness HMR seam ([#workbench-inert-data-static-slot](#workbench-inert-data-static-slot)),
   not a build transport. A build-time *fetch from a running origin* is the rejected branch (Bazel-style hermeticity:
   network-during-build breaks reproducibility); a WE→FUI *runtime package* dep is excluded (inverts the DAG).
2. **Interactive-cell format (Fork 2 → c).** The deterministic + **interactive** cell carries its **raw typed value as
   a `data-*` attribute on the SSR cell** (`<td data-sort-value="2026">Baseline 2026</td>`,
   `<th data-type="number" data-sortable>`); a small **in-place DOM enhancer** (the `<we-data-table>` CE's own FUI-homed
   client behavior) reorders/hides the **existing** rows. There is **no JSON island and no client re-render** — so the
   build↔client **render-skew class is structurally gone** (only one rendered table ever exists; nothing can drift).
   This **refines** [#block-data-ingestion](#block-data-ingestion)'s anticipated "serialized resolved context / JSON
   island" sketch (#1818 left the format open — "mechanism may flex, goal fixed"): the goal it fixed is preserved
   (the client sorts on **raw `field` values, never reparsed `<td>` text** — the correctness invariant), with a
   **native-first** ([native-first-baseline](#native-first-baseline)) mechanism — the raw key rides the cell as plain
   HTML (GOV.UK `data-sort-value` / `tablesorter` lineage). The cell text and its `data-*` key are **two attributes of
   one build-time projection** ([single-authoring-sot-derived-projection](#single-authoring-sot-derived-projection)),
   emitted in a single pass so the displayed value and its sort key can never disagree. In-place **grouping** is
   fiddlier than re-render; a surface that ever needs heavy grouping may opt *that surface* into an island — a localized
   exception, not a reopening of the default.

**Pinned artifact + build ordering (#1946).** The "locked build-artifact, never PATH-resolved" amendment
resolves to a concrete pin: FUI's `npm run build:tools` typechecks the CLI (`fui:tsconfig.tools.json`) then
esbuild-bundles it to **one self-contained ESM file at the fixed path
`../frontierui/dist/tools/data-table-build/cli.mjs`** (the main `build:plugs`/`tsconfig.json` cannot emit it —
its `@webeverything/*` sibling path-aliases root the program at the workspace parent, so `tools/` would land at
an unstable `dist/frontierui/tools/…`). `node_modules` deps stay external (happy-dom's CJS transitive deps
can't be ESM-bundled), so the artifact is invoked **from within the FUI checkout** against FUI's locked
lockfile — reproducible, not PATH-resolved. WE's Eleventy orchestration (#1905) resolves this **fixed relative
path** (no PATH lookup, no version probe) and shells `node <that> < batch.json > out.json`. **Build ordering:**
FUI `build:tools` MUST run before WE's `build:docs` (Eleventy) — WE's build assumes the pinned artifact already
exists; it does not build FUI. (A missing artifact is a hard build error, never a silent skip.)

**Lineage:** #1867 (ratified 2026-06-27 — Fork 1 → (a) FUI build-CLI subprocess, keyed-batch, version-pinned
[skeptic SURVIVES-WITH-AMENDMENT]; Fork 2 → (c) `data-*`-on-cell + in-place enhancer [skeptic SURVIVES-WITH-AMENDMENT];
prep `reports/2026-06-27-ssr-data-table-build-harness-boundary.md`). Fills the [#block-data-ingestion](#block-data-ingestion)
(#1818) build residuals (determinism predicate / build harness / interactive format). Inverse-direction sibling of
[#we-data-crosses-via-fui-served-route](#we-data-crosses-via-fui-served-route); shares the offline-vs-dev-seam line with
[#workbench-inert-data-static-slot](#workbench-inert-data-static-slot). Prerequisite for the #1600 table→data-table
family (#1609–#1613, repointed off #1867 onto the build story). The non-deterministic app case is #1827.

### Runtime-DI seam vs devtools provider seam {#runtime-di-vs-devtools-provider-seam}

A capability is a **runtime-DI standard seam** — a mandated `CustomXRegistry` or protocol — **only if
the running app or standard consults it at runtime** (#052/#081). A capability consulted by a **tool at
author / build time** (an upgrader analyzer, a version-migration *input adapter*, #094/#191) is a
**devtools provider seam**: plain injected providers, **never** a global mutable singleton or a mandated
protocol. The cargo-cult tells are a kinship doc-comment + a global mutable registry where a passed
provider would do — demote build-time providers *out* of the runtime-registry surface.

**Lineage:** #052/#081 (runtime registries the standard consults) · #094/#191 (upgrader analyzer / migration adapter = devtools provider seam).

### A declarative author-facing seam over an already-built provider is a non-rendering behavior/directive — not a new intent or protocol {#declarative-seam-over-existing-provider}

When a standard **already ships the transport** — a contract + a runtime-DI provider ([runtime-DI seam](#runtime-di-vs-devtools-provider-seam)) + a controlled vocabulary — and the only unbuilt piece is the **author-facing declarative seam** (a `data-*`-style annotation that says "do X on interaction I" *without* sprinkled imperative calls), that seam is a **non-rendering behavior/directive that consumes the existing provider**. It is **not** a new [Intent](#intents-ux-only) (intents are UX-only and *render a surface*; an emission/binding seam renders nothing, so an intent would be the catalog's lone non-rendering member) and **not** a new Protocol (the contract + vocabulary already exist — the seam adds *vocabulary entries*, never a new transport, like [compose-don't-duplicate](#compose-intent-dont-duplicate)). Whether to ship the seam at all is a genuine support-vs-not call (imperative-only is coherent, not broken), decided on **end-state merit** (every scaled prior-art ships the `data-*` binding) with the build filed as **separately-prioritized** ([fork-is-not-a-prioritization-tool](#)); two emission concerns sharing the emit-to-a-sink shape stay **two homes that compose** (one emits *through* the other), never an umbrella ([bias-toward-separation](#bias-toward-separation)). Native-first floor: unconfigured provider → silent no-op default.

**Lineage:** #1415 (telemetry declarative emission seam → behavior/directive over the built `CustomTracker` sink + Analytics Event Vocabulary; #1414 experiment-exposure composes through it). Sibling of [runtime-DI-vs-devtools-provider-seam](#runtime-di-vs-devtools-provider-seam) and [intents-ux-only](#intents-ux-only).

### A boolean flag is an access-control gate; a multivariate flag is the experiment intent — same provider shape, different outcome family {#flag-gate-vs-experiment-selector}

"Feature flag" is an **overloaded incumbent word** that splits by outcome family ([decompose-overloaded-vocabulary](#decompose-overloaded-vocabulary-by-semantic-source)). A **boolean** flag (on/off) **IS the access-control gate**: it is `authority: feature-flag` on the [access-control](/intents/access-control/) intent over the **Guard** provider seam — its outcome is **allow/deny**, a trust-crossing authz mirror. A **multivariate** flag (one of N arms) is the separate **[experiment](/intents/experiment/) / variant-assignment intent**: its outcome is **pick-one-of-N** (a rendering choice, **no security semantics** — an arm is not an authz verdict), resolved by a *distinct* evaluation provider (`@webeverything/contracts/experiment`, returning `{value, variant, reason}`). The two **reuse the same provider *shape*** (native-first default → project override → custom plug) but must **never re-conflate**: different outcome families, different trust boundaries. OpenFeature's own typed-flag distinction is the upstream precedent — a **boolean** flag is a gate, a **string/object** flag is a selector.

**Lineage:** #1414 (placement: feature-flags vs experiments) · #1481 (this note) · #1479 (experiment intent + evaluation-provider contract). Sibling of [decompose-overloaded-vocabulary](#decompose-overloaded-vocabulary-by-semantic-source) and [intents-ux-only](#intents-ux-only).

### A multi-strategy concern is a configurable dimension; default extends the platform {#config-extends-platform-default}

When a concern has **more than one legitimate end-state** (e.g. auto-define: explicit / eager-barrel /
on-import / on-first-use / build-parse / declarative-map / convention / SSR), model it as a
**configurable strategy dimension** — never bake one mechanism (the *dimension-vs-fixed-mechanic* rule).
The **default is the most-permissive / native-first** value, with the restriction as the author's opt-in.
Defaults live in a **project config that *extends* a fully-defined platform default** (flavors); the core
tool/registry itself stays **default-less** (core `CustomRegistry` `extends`; the JSX render-strategy axis
is the precedent).

**Where those values materialize (#1662).** Storage is **per-dimension**: each dimension stores its value +
its own `extends`-to-flavor chain independently (the `CustomRegistry.extends` shape generalized — an
*open-set* dimension *is* a `CustomRegistry` subclass; a *scalar/mode* dimension realizes the same chain as a
plain config object). **File-count ≠ schema-coupling**, so the project **author surface defaults to one keyed
file** (`webeverything.config.{ts,js,json}` — one key per dimension, any key *extractable* to its own file;
`most-flexible-default`). A **unified config file as the authoritative SoT is rejected** (god-schema coupling
+ project-facing-format lock-in); a unified surface is supported **only as a derived, non-authoritative
discovery view** (a resolver that *reads* the per-dimension configs). `extends` is an ordered **nearest-wins
array** (lazy lookup, *not* a destructive merge); the same chain nests platform→project→app→fragment, so
settings scope to any subtree (runtime DI) and unregistered strategies tree-shake out. The discovery-view and
config-loader *builds* are separately prioritized, not triggered by this ruling.

**Lineage:** #227 (auto-define strategy axis) · #080 (render-strategy precedent) · #1662 (materialization:
per-dimension storage + one-keyed-file author surface + discovery-view). Process forms in [conventions.md](conventions.md) / [architecture.md](architecture.md).

### Compose an existing intent — don't duplicate an owned model {#compose-intent-dont-duplicate}

The intent-level analogue of [compose-don't-hand-roll](#compose-dont-handroll). When a standard needs
async / lifecycle / interaction behavior a **registered intent already owns**, it **composes that intent
and cross-references it — it never spins up a parallel model**. `<Resource>` resolves *through* the Loader
Intent's state machine (`idle|pending|success|error|stale|loadingMore`) rather than re-implementing one
(#124); a Menu block composes the owned anchor / focus / type-ahead / selection / disclosure intents and
builds **only the one genuinely-missing intent** (command invocation), not a fresh interaction stack
(#173). Build only the irreducibly-new vocabulary; wire the rest.

**Lineage:** #124 (Resource → Loader Intent) · #173 (Menu → existing intents + the one missing `command`). Sibling of [compose-dont-handroll](#compose-dont-handroll).

### A thin role-container over a shared primitive stays a preset/parameter until a 2nd consumer; graduate to a block then {#thin-container-graduation-trigger}

The placement face of [compose-intent-dont-duplicate](#compose-intent-dont-duplicate), for APG
composite-widget *containers* (toolbar, menubar, tabs-container). The roving/managed-focus algorithm is
**not** the container's — it is the owned `focus-delegation` intent + its `composite-widget` behavior
block, which the container *consumes* (`strategy=roving; orientation=…`). What the container actually adds
is a thin role surface — a `role` value (`role="toolbar"`), separators, a label, grouping — too small to
justify a first-class artifact on its **first** consumer. **The rule:** carry that role surface as
**assemblerPreset config + a `role` parameter on `composite-widget`**, *not* a new intent (no UX dimension
of its own) and *not* yet a new block. **Graduation trigger:** the moment a **second** container consumer
wants shared *container* concerns (separators, overflow, label), promote the preset into a **thin block**
composing `focus-delegation` + `action`. One consumer → preset; two → block. Matches Radix/Ariakit/React
Aria (thin role wrapper over one shared focus primitive; the algorithm is never re-homed per container).

**Tell:** a candidate "new roving control-group standard" names a role but supplies no focus mechanic of
its own (it delegates arrow-nav wholesale) — that's a consumer of `focus-delegation`, not a new standard.

**Lineage:** #1409 (Toolbar — roving unit = `focus-delegation`+`composite-widget` consumer (Fork A,
resolved invariant); container semantics = the webdocs `toolbar` assemblerPreset + promoted
`composite-widget`, thin `toolbar` block gated on a 2nd container consumer (Fork B)). Surfaced by the
ARIA-APG lens #1400; sibling of [compose-intent-dont-duplicate](#compose-intent-dont-duplicate) and
[intents-ux-only](#intents-ux-only).

### Decompose an overloaded incumbent word by semantic source; never widen one intent to absorb a foreign family {#decompose-overloaded-vocabulary-by-semantic-source}

The split-side complement of [compose-intent-dont-duplicate](#compose-intent-dont-duplicate). Incumbent
design systems overload a single word (classically **"badge"**) across **distinct semantic families** —
a decorative/categorical label (author-supplied tone, static, no provider), a lifecycle/state status (an
entity's state machine), a count/dot notification marker (a number overlaid on a host). The word lands in
a *different* family per system (shadcn's Badge is decorative; Ant's Badge is a count marker). The rule:
**carve one intent per semantic family along the semantic-source axis**, and **never widen an existing
intent to admit a foreign family** — widening *dilutes* the absorbing intent (a decorative label has no
provider/transition/state, so a lifecycle intent's machinery would have to go optional and hollow,
falsifying its own contract). The unhomed family earns its **own** home; the name must avoid colliding
with a token or element already owned by a sibling family (`badge` is a `shape` token; `label` collides
with the form-label intent **and** the HTML `<label>` element). Interactivity is **composed** (Action /
Selection), not baked in.

**Tell:** an incumbent component maps "close enough" onto an existing intent but supplies none of that
intent's defining inputs (no provider, no state, no transitions) — that's a foreign family asking for its
own home, not a widening candidate.

**Lineage:** #009 (Notification Marker — split the count/dot family off "badge") · #1319 (Tag Intent —
split the decorative label family off "badge"; Status Indicator keeps lifecycle) · #1395 (Mutation Intent —
the word **"optimistic"** is overloaded across two axes: a *read/blocking* strategy on `loader` ("don't
block the UI, sync in background") vs a *write apply-then-rollback* lifecycle; carve a first-class `mutation`
intent (symmetric to `loader` for reads) rather than widen the visual-weight `action` intent — `action`
supplies none of the write-lifecycle's inputs, the foreign-family tell). Inverse face of
[compose-intent-dont-duplicate](#compose-intent-dont-duplicate); kin to [reproduction-conformance](#reproduction-conformance)
(the gap sweeps that surface these overloads) and [intents-ux-only](#intents-ux-only).

### Configurability partition — declarative vocabulary is the portable standard; imperative is the per-impl escape hatch {#configurability-partition}

A runtime-agnostic standard's **author-facing configuration** splits along the **declarative/imperative
line**, *not* along "the reference impl vs others." A **declarative strategy vocabulary** (options expressed
as *data* — `sort by field, desc`; `group by tag`; an order pin) is **part of the standard**: portable,
golden-vector-locked, honored identically by **any** conforming implementer. An **imperative custom
function** (a JS/C# sort fn) is **inherently non-portable** (code, not data), so it is a **per-implementer
escape hatch**, never in the standard — and reaching for one is an explicit, **graceful-degradation** opt-out
of cross-implementer reproducibility for that aspect (another implementer declares non-support and falls
back to the declarative default, never silently differs). Consequences: configurability is **unbounded at
two levels** (portable declarative + per-impl imperative) without bloating the contract; the named
implementer is the **reference** impl, not "the engine" — the standard stays runtime-agnostic so a second
generator (`.NET`/Go) is a first-class possibility; the declarative vocabulary **starts minimal and grows on
demand** (promote a popular escape-hatch option into the vocabulary when real demand / a second implementer
appears — grow the *vocabulary*, not an impl's private knobs). Reproducibility (e.g. #091 no-drift) holds
across *any* implementer over the declarative surface, degrade-gracefully over the imperative one. **Tell:**
when "we must let people customize X" tempts a vendor-injected plugin *inside* the contract, the right move
is a declarative vocabulary entry (if expressible as data) **plus** an imperative escape hatch outside the
contract — never an imperative seam folded into the standard.

**Lineage:** #1163 (webdocs Doc Spec — declarative `docs.*` vocabulary in WE, custom `SortStrategy` fn as a
per-impl escape hatch; FUI = reference impl); #1687 (webrouting technical-config — the serializable route-config
schema admits *every* setting with merit + real-app use, placed by serializability: serializable deploy-shaped
settings → the config schema, author-in-code forms (a `scrollBehavior` fn, a per-route `import()`) → the block/markup
escape hatch; the set is open and grows as apps surface settings — never an exclusion). Composes [surface-contract-not-computation](#surface-contract-not-computation)
(pin surface / swap impl), [intents-ux-only](#intents-ux-only) + Intents-Open-Design (standardize the
meta-schema, not the list), and the minimize-lock-in / escapable-lock principle; the config-surface analogue
of [forward-generation-adapters](#forward-generation-adapters) (contract is the authority, code crosses no seam).

### Presentational variants are an open-numbered axis off one semantic contract {#open-numbered-variants}

When two things differ **only in presentation** — same semantics, same behavior, same DOM — that
variation is an **open-numbered axis**, never a closed enum. WE standardizes the **variant contract**
(*a value names a purely-presentational treatment that leaves the semantic meaning and behavior
unchanged*) **plus a recommended core set**; authors **mint as many members as they want from that
contract** (Intents-Open-Design applied to the presentational axis — standardize the meta-schema, not
the list). Membership is a **semantic test**, not a vote: *differs only in presentation* → a valid
member; *differs in semantics* (changes role, behavior, navigation) → a **different contract**
(different intent/dimension), never folded in. The axis lives **on its owning intent** (value sets are
intent-specific — a button's `ghost`/`link` ≠ an input's `borderless`), never as a shared cross-cutting
intent that would flatten the divergent vocabularies. Name the axis for the *treatment*, not the
attention it draws (`variant`/`treatment`, not `emphasis` — prominence is a separate semantic axis).

**Ceiling — variant vs block polymorphism.** The rule is bounded to **presentational treatment of one
rendering**. Three tiers: (1) **intent** = the semantic contract; (2) **variant** = a value the *same
block, same DOM* renders differently, CSS/token-reachable; (3) **block polymorphism** = when materially
**different DOM/markup** is required (one single-select intent as radios *vs* a segmented control *vs*
card-tiles), which is interchangeable *blocks* under one intent or a *structural/layout* axis — **not**
a variant value. **Diagnostic:** *can I reach it with CSS/tokens on the same markup?* — yes → variant;
no → block/structure layer. This stops "everything visual is a variant" sprawl. Generalizes beyond
Action to **sectioning and layout**: define the semantic contract once, expose presentational variants
as an open-numbered axis. Surface is a **plain attribute consumed by CSS** (`button[variant]`) — no
wrapper required, because a behavior-free axis needs none.

**Lineage:** #1318 (Action Intent `variant` axis — `fill | outline | ghost | link`, open vocabulary;
`link` in the core set; named `variant` not `emphasis`; renders via plain attribute, no wrapper).
Composes [intents-ux-only](#intents-ux-only) + Intents-Open-Design, [compose-intent-dont-duplicate](#compose-intent-dont-duplicate)
(divergent vocabularies stay on their owning intent), and the most-permissive-default / native-first
floor. Follow-ups: #1320 (build) · #1321 (FUI variant-surface packaging) · #1323 (sectioning/layout
application) · #1324 (`level`-as-outcome-role).

**Tone extension (#1427).** Applied a third time, to the cross-intent **`tone`** axis (semantic
color/severity). Same holding — the **value enum stays per-intent** (action `neutral | danger`; message
`neutral | positive | caution | negative`; status-indicator `+progress`; tag `+categorical`;
feedback/sys-notif `info | success | warning | error`), a flat shared enum is **rejected** (flattens; the
Bootstrap `btn-warning` smell). The tone axis adds **one nuance variant lacks: a shared DRY token layer.**
Because tone *is* color, the shared layer is two things, not one: (1) a shared tone **meta-contract** (*a tone
value names a semantic color/severity family the theme resolves — never a hex; open-numbered; membership test
= differs only in semantic color, not behavior/lifecycle*), and (2) a shared **`--tone-*` token palette** in
webtheme. The palette is **severity-family only** (`neutral · danger · success · warning · info · critical`);
values that fail the membership test stay **intent-local tokens** — `progress` (a lifecycle state) and
`categorical` (non-severity identity color) never enter the shared palette. Dimension name standardized to
**`tone`** with a canonical synonym table (`danger ≡ negative ≡ critical ≡ error`; `success ≡ positive`;
`warning ≡ caution`); `info` and `neutral` stay **distinct** (collapsing them is lossy). Action keeps
`neutral | danger` regardless (#1337, non-negotiable). Realized by #1458 (palette + statute) / #1459 (rename
sweep). Composes [intents-ux-only](#intents-ux-only) (tone is UX-only; the theme owns the hex).

### The presentation/style axis is intent-owned — never a parallel cross-cutting style vocabulary {#presentation-axis-is-intent-owned}

A standing temptation is to mint a **cross-cutting presentation vocabulary** — a `finishes`/style sibling to
intents (`rounded=md`, `shadowed=heavy`, `bordered`, `hover=shine`) that applies to *any* surface. **Rejected on
merit.** The presentation/style axis is owned by **intents** (one open model for *all* UI/UX config); a parallel
vocabulary over an axis an intent already homes is the *second home* that [realize a declared axis; never stand
up a second home](#) forbids, and the lone-card consumer never met the *real cross-cutting consumer* bar. Two
clarifications make this operative:

- **"UX-only" means semantic/declarative (what/why, no impl refs — the #030 intent/trait split), NOT
  "non-presentational."** `texture=glass` / `elevation=3` are legitimate **presentational intents** because each
  carries a semantic story; the trait resolver maps them to CSS. Presentation-as-declared-semantic belongs in
  intents.
- **The pure-decoration edge → theme tokens, not a vocabulary.** A CSS knob whose "what/why" is genuinely thin
  (a raw corner radius with no semantic role) stays a **theme token** (`--radius-*`), owned by webtheme. "Belongs
  to no intent" argues *token*, never *new intent-sibling vocabulary*. Where a presentation value **does** carry
  semantics, **extend the owning intent's dimensions** (add `radius`/`border` to `surface`) — standardize the
  meta-schema, not the list.

So every presentation concern routes to one of two existing homes — **intent dimension** (semantic) or **theme
token** (decoration) — never a third cross-cutting style home. **Reversibility:** a *future* real consumer that
needs one vocabulary spanning **multiple** intents, and **proves** intent-owns-the-axis cannot carry it, reopens
this as a fresh merit fork (a hypothesis of cross-cutting need is not such a proof).

**Lineage:** #1884 (ruled NO to a parallel presentation-trait vocabulary; prep's NOT-YET reframed to a merit
ruling — prioritization is not a fork branch). Composes [intents-ux-only](#intents-ux-only) (open never-finished
system; custom intents coexist), [open-numbered-variants](#open-numbered-variants), realize-a-declared-axis, and
no-orchestrator-until-real-consumer. Follow-ups: #1911 (realize `surface`) · #1912 (extend for `radius`/`border`
residual) · #1913 (realize app-authored custom intents — the open-system promise).

### App-authored custom intents — namespace by ownership, at the intent *and* value layer {#custom-intents-namespace-by-ownership}

Realizes the [intents-ux-only](#intents-ux-only) promise that intents are *"an open, never-finished system — standardize the meta-schema, not the list."* A product may **mint and use its own intents** through one meta-schema, with collision-freedom guaranteed by **namespacing by ownership** (RFC 6648: never by *status* — `x-`/`custom-` lie on promotion and force an interop-breaking rename). Three settled axes:

- **Namespacing (intent id).** A custom intent id is **scope-prefixed `owner:intent`** (e.g. `acme:lozenge`); **standard ids stay bare** (`action`, `navigation`). The `:` plays the custom-elements-dash role — a bare standard id can never collide with a scoped custom id, current or future — and is free of the `.`-delimited dimension keyspace (resolver `lastIndexOf('.')`). Promotion to standard = **drop the prefix** (an alias/registration), never a rename. (Colon chosen over the npm-scope `@owner/intent` spelling: `:` needs no path-like ceremony and is keyspace-safe.)
- **Unknown-intent behavior = most-permissive ignore (forward-compat).** An id the engine doesn't recognize **degrades to most-permissive** (its traits are simply ungated), per the **must-ignore discipline** of every extensible format (HTML unknown tags, CSS unknown properties, JSON unknown fields): a manifest authored against a *newer* vocabulary must degrade, not hard-break, on an *older* engine. Per-intent **`mustUnderstand: true`** is the author's fail-fast opt-in (SOAP/`Prefer: handling=strict` precedent); a **build-time `warn`** on an unrecognized *non-namespaced* id closes the silent-typo footgun without re-breaking forward-compat (a throw would). *This is forward-compat, not the value-default rule — `:385` is supporting, not dispositive.*
- **Composition (`extends`) is additive, never override.** A custom intent may **add wholly-new (namespaced) dimensions**, and may **add values to a standard dimension iff that dimension is open-numbered AND the value is namespaced (`owner:value`)** — e.g. a consuming lib adds `acme:caution` to an open severity axis with its own style/ordering; promotion = drop the prefix. It may **not** override/shadow an inherited dimension (the *second-home* drift [presentation-axis-is-intent-owned](#presentation-axis-is-intent-owned) forbids), and **closed enums stay untouchable by anyone** (#1337, e.g. action `neutral|danger`) — a closed set is closed because it is **semantically load-bearing** (a downstream consumer — a11y live-politeness, alert routing, log-severity — must understand every member). **Open-vs-closed is the gating judgment:** open when nothing downstream *reasons over* the values (pure presentation), closed when a finite set drives behavior/a11y/semantics. Bare (non-namespaced) cross-author values and closed-enum widening are **rejected at validate-time**.

This is the **value-level corollary of [open-numbered-variants](#open-numbered-variants)**: #1318 opens values *within* a standard intent for the **single WE authority**; this extends that openness to the **cross-author** case via ownership-namespacing (`owner:value`), since #1318's flat unnamespaced model was never written for multiple authors. **Placement (#1282):** the meta-schema *definition* + the `validateIntent` extension live in **WE** (the sanctioned definitions-plus-validate-script carve-out); the product-manifest **glob loader** and any **runtime register-API** are runtime impl → **FUI / the product** (the register-API is a demand-gated follow-up — declarative build-time manifest is the existing seam now). **Disambiguation (#1948):** the reusable build-time *substrate* that assembles `{standard catalog + product manifest}` and **invokes** the #776 WE resolver is a **bundler plugin → FUI** (`fui:tools/intent-resolver/`, the structural twin of `fui:tools/trait-enforcer/`) per [devtools-placement](#devtools-placement) rule 2; the product (plateau-app) supplies only its `owner:intent` manifest (product data) and wires the FUI substrate into its own build; the operator-facing intent-*configurator* is the part that is Plateau (rule 3). A *new* WE-resident substrate is excluded ([constellation-placement](#constellation-placement) rule 1 + #1771 — WE holds zero impl); "FUI = the substrate, product = the manifest + configurator" fills the single ambiguity #1913's "FUI/product" left. Composes [intents-ux-only](#intents-ux-only), [open-numbered-variants](#open-numbered-variants), [presentation-axis-is-intent-owned](#presentation-axis-is-intent-owned), and the #1337 closed-enum line.

**Lineage:** #1913 (surfaced by #1884 — the presentation axis is intent-owned *only if* apps can extend the model). Prior-art survey (7 systems: custom elements, CSS `--`, DTCG `$`, npm scopes, reverse-DNS, ARIA states, RFC 6648). Forks ratified 2026-06-28. **#1948** (ratified 2026-07-01 — the reusable resolution substrate → FUI; default (a), skeptic SURVIVED with two amendments folded in prep: rule 2 re-based as primary FUI-vs-product authority, rule 1/#1771 demoted to "excludes WE"). Gates #1930.

### Component composition lives on three substrates — WE contract / FUI primitive / product component {#identity-semantic-look-composable}

**Every "how do we build component X" question reduces to one: which substrate owns the responsibility.**
Fix the boundary once and the 100s of downstream calls (does a card have a title? what namespace? section
or article? where does the heading go?) become **mechanical placements, not decisions**. The card is this
principle's worked example.

**The substrate boundary.**

| Substrate | Owns | Deliberately does NOT own |
|---|---|---|
| **WE** — *standard* | the **contract**: semantic identity + the minimal invariant; names what a thing *is*. **Under-specifies on purpose** — any "a card has a title" claim is contradicted by the next design. | concrete structure, optional parts, look values |
| **FUI** — *implementation* | the **primitive**: the reusable mechanism realizing the contract — transient root-binding, root resolution, the tokenized base style hook (`.fui-card`, token-driven `CARD_CSS`), slot/prop machinery. Product-agnostic. | any product-specific design opinion (titles, footers, menus) |
| **Product** — *composition* | **concrete, semantically-named, namespaced components** composing primitives into what *this* product needs (title, footer, items, menus, behaviors). Lives in the **product's own frontend** (e.g. the WE website), **not** WE/FUI. | the standard/primitive — it *consumes*, never re-mints |

**Two consequences of "identity = semantic element, look = orthogonal style":**

1. **Different semantic value ⇒ different element.** A card (`<article>`, a self-contained composition)
   and a section (`<section>`, a thematic region) have different semantic value → different elements.
   They may share a *look*; that shared look is a **style**, never a shared element. (Role/variant minting
   restated: *different arrangement → distinct entity; same arrangement, different look → variant* — see
   [tagname-naming](#tagname-naming)'s "name by semantics, not by uniformity".)
2. **Native elements are the semantic standards; WE recognizes, it does not re-mint.** Settling thought
   experiment: *if HTML had no `<article>`/`<section>`, would WE mint standards for them? Yes.* So they
   are semantic standards the platform already provides — [native-first](#native-first-baseline) means WE
   builds the style layer on top, never wraps a custom element around a sufficient native one.

**Delivery is a composed web component — never a classname.** At *both* the FUI-primitive and
product-composition layers the deliverable is a custom element (own tag, multiple elements, props, slots,
behaviors), **not** a hand-authored class. `<section class="fui-card">` is only the degenerate look-only
*runtime residue*, never the authored artifact. **Native-first is preserved as a constraint *on the
composition*:** each component composes the correct native root internally (landmarks/roles/a11y) and never
reinvents a sufficient native primitive — but the unit delivered is the component.

**The card, worked example (#1886).**

- **WE** — the card *contract* only: "a styleable surface bound to a self-contained-composition root." No
  title/footer claim.
- **FUI** — the **transient primitives**: `we-card` (`resolveTag(): 'article'`,
  `fui:blocks/card/CardElement.ts:17-21`) and `we-section-card` (`resolveTag(): 'section'`). Authored as
  tags, they **erase to** `<article class="fui-card">` / `<section class="fui-card">` at runtime (transient
  — composition, not subclassing). Base style hook `.fui-card` (`fui:blocks/card/Card.ts:34` `BASE_CLASS`),
  token-driven `CARD_CSS`.
- **Product** — the WE website composes `standard-card` (`= we-card` + title + footer + items + …) and a
  section-rooted `standard-section` (`= we-section-card` + …), keeping each `<hN id>` heading verbatim so
  in-page anchors survive. **These live in the website, not WE/FUI.** The FUI-vs-product line, when it
  blurs, is settled by [reusable-against-all-implementers → neutral home](#reusable-neutral-home):
  product-agnostic + reusable ⇒ graduate to an FUI primitive; product-specific ⇒ stays in the product.

**Root polymorphism — intrinsic-yes / extrinsic-author-fiat-no (#1886 Fork 1).** Reject the *extrinsic
author-fiat* `<we-card as="section|article">` — one tag whose DOM root is an author *override* that can
contradict content. It imports React's `as=` (a workaround for JSX's lack of element-erasure; WE has
`TransientElement`, so the author just writes the right primitive — `we-section-card`). **But not**
polymorphism *per se*: **intrinsic, evidence-based** resolution where the element reads its **own** content
to pick its tag is **blessed** and shipped — `ButtonTransientElement.resolveTag()` returns
`this.hasAttribute('href') ? 'a' : 'button'` (`fui:blocks/button/ButtonTransientElement.ts:17-18`). The line
is **who chooses the root**: intrinsic evidence = blessed; extrinsic author-fiat = rejected.

**Where the look *values* live — FUI tokenized base + product values (#1886 Fork 2).** **FUI** ships the base
card's **tokenized neutral surface**, already token-driven (`CARD_CSS` = `var(--color-border, …)`,
`var(--radius-md, …)`, `var(--color-surface-card, …)`, `fui:blocks/card/Card.ts:90-103`), reskinnable by
*setting tokens*, never forked; the **product layer** supplies token *values* (and composes the concrete
components above) per [managed-offering constellation layering] (standard→WE, primitives→FUI,
product→plateau/site; default ships **zero** flavors). **Hardcoding the look in FUI core is rejected.** The
card surface is one *recipe* of the broader presentation-trait vocabulary (#1884); it ships on **plain tokens
now**, so #1884 does not block it.

**Namespace.** `we-*` is reserved for the standard+primitive layer; the **product** owns its own namespace
via a **config knob (default empty)** — the WE website uses unprefixed `standard-card`/`standard-section`;
the config lets any *published* product namespace its components without code change.

**Lineage:** #1886 — prepared + ratified 2026-06-27, then **reopened the same day and re-ratified** when the
human ruling corrected the delivery vehicle (a component is not a classname) and surfaced the real principle:
the **substrate boundary**. Parent #1287; `relatedReport`
`reports/2026-06-27-project-include-we-card-migration.md`. Grounds the #1871 docs migration (which authors
the product `standard-card`/`standard-section`) and spawns the FUI `we-section-card` primitive. Refines
[native-first-baseline](#native-first-baseline), [tagname-naming](#tagname-naming), and the constellation
three-layer split; uses [reusable-neutral-home](#reusable-neutral-home) as the FUI-vs-product tie-breaker.
Sibling of [composition-preserves-a11y-contract](#composition-preserves-a11y-contract) (#1832). *The original
"a section wears the look as `<section class="fui-card">`" framing is **superseded** — that bare class is the
runtime residue of the transient primitive, not an authored deliverable.*

### Composition preserves the base block's a11y contract; changing it means a new component {#composition-preserves-a11y-contract}

The a11y contract of a block (its roles, focus order, keyboard model, aria surface) is
**single-sourced on the base block**. Every sanctioned HTML-first re-skin strategy must be
**add-only** to that contract — it may *extend* the surface, never *override or remove* it.

**The contract clause (citable; #1832):** for each of the four sanctioned composition strategies —
**slots, behavior/decoration, sub-component (scoped) replacement, abstract-piece split** — the composed
result MUST be **non-destructive** over the base block's a11y contract across all four dimensions:
it MAY *add* roles, *add* to the focus order, *add* keyboard bindings, and *add* aria attributes/state;
it MUST NOT *override* or *remove* a base role, reorder/drop a focusable, rebind/suppress a base key,
or strip/contradict a base aria attribute. Crossing any of those is, by definition, no longer a re-skin
of the base block but the authoring of a **new** block (the developer test below). The invariant is a
**forced** property of the strategy set, not a per-variant opt-in.

**The developer test (cite this to inform any block/component-shape API):** *does the variation need
to **change** the base's a11y contract — different roles, focus order, or keyboard model?* **Yes → a
new component** (structural; a distinct block under the same intent). **No, it only adds → the same
block, re-skinned** via composition. This is the third tier below [open-numbered-variants](#open-numbered-variants)'s
diagnostic: *CSS/tokens-reachable on the same markup* → a **variant**; *not CSS-reachable but add-only
to a11y* → the **same block re-skinned by composition**; *requires changing the a11y contract* → a
**new block**. (Example: slotting an icon/badge or decorating a child with `aria-current` keeps one
`<nav-item>`; `as="menubar"` — which forces `role=menuitem` and a different arrow-key model — is a new
component, not a config flag.)

**The four sanctioned add-only strategies** (none excludes another — support-all, per
[compose-dont-handroll](#compose-dont-handroll)): **slots** (shadow `<slot>` + imperative
`HTMLSlotElement.assign()`, the `<component>` authoring form); **behavior/decoration** (a
`CustomAttribute` on a child — the HOC analog, the most mature; e.g. `route:link` adds `aria-current`);
**sub-component replacement** (scoped custom-element registry + IDREF per [`#component-dc`](#component-dc) —
sanctioned but its runtime is **blocked on the webregistries FUI re-home**); and **abstract-piece split**
(a userland *convention* — distinct tags + tree-shakable traits — WE ships no primitive for it).
**Context-driven config** (webinjectors/webexpressions) is sanctioned for **non-visual** wiring only
(locale, data, flags); for *visual* variation it is the rejected "configure-one-block" shape — a
combinatorial a11y matrix, the [open-numbered-variants](#open-numbered-variants) ceiling restated for a11y.

**Where a11y is verified:** WE owns the **contract statement** (add-only non-destructiveness); whether a
given composed variant honors it is a **FUI/Plateau conformance-run concern**, not a WE-shipped
per-strategy proof matrix — composed tuples aren't expressible in the vector schema, and verifier/impl
live downstream per [conformance-verifier-vs-subject] / WE-zero-standard-implementation.

**Lineage:** #1795 (HTML-first composition strategies — Fork 1 = compose-over-base; a11y
non-destructiveness ratified as a forced invariant; the support-all set classified). Extends
[open-numbered-variants](#open-numbered-variants) (adds the a11y-contract tier below the CSS-reachable
diagnostic) and composes [compose-dont-handroll](#compose-dont-handroll). The composition
non-destructiveness **contract clause** above was landed by #1832 (the add-only invariant stated across
the four roles/focus/keyboard/aria dimensions as a citable conformance target). Remaining build
follow-ups: the `nav-list` a11y vector corpus, the strategy seams (scoped-replace blocked on the
webregistries re-home), and a current-block-interface compliance review.

### A layout role's identity is its composition-intent; CSS-mechanism is impl, landmark is annotation {#layout-role-composition-intent}

A **layout role** is identified by its **composition-intent** — the semantic arrangement the author
wants ("even vertical flow with consistent spacing" = stack; "fixed+fluid split that collapses when
narrow" = sidebar) — **impl-agnostic**. The **CSS mechanism** that realizes it (margin-flow vs `gap` vs
auto-fit grid) is **FUI's impl detail**, never the identity; the **ARIA landmark**
(`navigation`/`complementary`/…) is an **optional author annotation** bound to the content, never the
role. Keying identity on CSS-mechanism is **rejected** — it violates
[surface-contract-not-computation](#surface-contract-not-computation) (Impl-Is-Not-A-Standard) and makes
the taxonomy brittle to browser releases (when CSS `masonry` ships, "masonry" must **not** merge into
"grid" — they stay distinct *intents*). Keying on landmark alone is **under-determining** (stack,
cluster, grid, center all map to *no* landmark).

**Minting contract — role vs variant vs annotation.** The role set is **open-numbered** (a ratified
core + this contract), [open-numbered-variants](#open-numbered-variants)/Intents-Open-Design applied to
roles. A candidate earns a **new role** iff it is a *distinct composition-intent* (a different semantic
arrangement). It is a **variant** if it differs only in presentation (MUI ImageList
standard/quilted/woven = one grid role + variants; Chakra HStack/VStack = an axis variant of stack). It
is an **annotation** if it differs only in content meaning (a `navigation` sidebar vs a `complementary`
sidebar = one sidebar role + a landmark annotation). **Diagnostic:** *different arrangement* → role;
*different look, same arrangement* → variant; *different content meaning, same arrangement* → annotation.

**Two altitudes.** Primitive region roles (stack, cluster, grid, box, center, sidebar, frame, …) are the
per-role taxonomy where **FUI ships exactly one block per role**. **Page archetypes** (app-shell,
list-detail, feed, holy-grail) are *compositions of* region roles and live in a **separate
composition-intent tier** — impl'd as FUI *blocks* composing region components + plateau assembler
presets, **never** admitted as atomic roles (that would make "one component per role" re-implement the
regions it should compose). The line is *atomic composition-intent* (sidebar = one fixed+fluid split) vs
*page-spanning arrangement of multiple region roles* (app-shell). The shipped `layout` intent
(we:src/_data/intents/layout.json) is the **charter member** of the composition-intent tier — reclassified,
**not retracted**.

**Lineage:** #1680 (taxonomy decision — Fork 1 composition-intent identity, flipped from CSS-mechanism by
the skeptic; Fork 2 separate composition-intent tier with `layout` as charter member). Prep survey
we:reports/2026-06-23-semantic-layout-role-taxonomy.md (Every Layout, WAI-ARIA, Tailwind, MUI, Radix,
Chakra, Carbon, MD3, Open UI). Composes [surface-contract-not-computation](#surface-contract-not-computation),
[open-numbered-variants](#open-numbered-variants), [intents-ux-only](#intents-ux-only), and bias-to-separation. Seeds per-role mint items (intent + FUI block per core role).

### Reproduction-conformance: reproduce incumbents as theme+intents; the copy is a forcing function {#reproduction-conformance}

Reproducing a third-party design system (Material, Ant, Carbon, Fluent, shadcn…) on the constellation is a
**forcing function, never a product**. The hypothesis under test is that the only difference between any two
top design systems is `theme tokens + intents`; everything structural/behavioral is shared WE-standard over
FUI primitives (the headless-library thesis — React Aria/Radix/Ark/Base — applied as a conformance probe).
Each target yields three buckets: a **theme pack** (DTCG tokens), an **intent set**, and a **gap list** — the
residue reproducible *only* by escaping the standard. **The gap list is the deliverable.** The governing
discipline mirrors [exercise-app *active-bypass = FAIL*](#) : a divergence you can only hit by hand-rolling
outside WE/FUI is a **gap to file, never a hack to add** — per-library escape hatches buy the screenshots and
learn nothing. Three consequences, all forced:

1. **No assumed quality — parity is a measured fact.** No parity claim may rest on eyeballing; each gates on a
   confirmed measurement. The oracle is **layered** (support-all, not a fork): **fuzzy-tolerance pixel**
   (WPT-reftest model — max per-channel color delta + max differing-pixel count, *not* naïve pixel-diff, which
   throws 30–40% false positives), **structural DOM/ARIA/focus-order diff** (deterministic), and an
   **advisory VLM/semantic judge** (never the sole gate). Reproduction-as-conformance *is* the WPT/reftest
   method: the incumbent's own render is the reference, the FUI-themed repro is the test.
2. **Validation-engine ownership splits at the capability seam** (the load-bearing rule). The **deterministic
   diff engine** (drives + captures + compares) is **FUI** (impl/devtool, like the #809 block-explorer); the
   **VLM/vision judgment** is **Plateau** ([no-leakage-client](#no-leakage-client) — #475 is categorical: a
   tool containing a vision capability cannot fold it into FUI); **WE consumes only the verdict + gap deltas**
   (never renders FUI, never runs the judge). The Plateau→WE delta protocol stays **deliberately thin**
   (pass/fail + gap list, not a fat schema).
3. **The instrument need not be finished before reproduction starts** (prioritization, not a fork). "No claim
   without measurement" is the invariant; *when* the validator reaches parity-grade relative to the first
   target is a scheduling call — the validator co-evolves, specified by a concrete adversarial target, with
   the claim-gate (not a hard `blockedBy`) carrying the correctness guarantee.

**Lineage:** #1225 (program charter — reproduction-conformance; ratified 2026-06-20; research topic
`/research/reproduction-conformance/`). Composes [no-leakage-client](#no-leakage-client) (vision → Plateau),
[we-fui-embed-boundary](#we-fui-embed-boundary) (FUI owns impl + render, WE consumes outputs),
[constellation-placement](#constellation-placement), and the backlog *fork-is-not-prioritization* rule
(sequencing demoted out of the fork set). Sibling forcing-function to the exercise-app conformance loop (#314).

### First-party dogfood: our own products render only from FUI components + WE intents, differentiated solely by a theme {#first-party-dogfood}

The internal twin of [reproduction-conformance](#reproduction-conformance). Where that program proves the
`theme + intents` thesis against **incumbents**, this rule proves it on **our own product surfaces**. A
first-party product (plateau-app today; the same bar reaches any served product) composes its UI **only** from
FUI components driven by WE intents; the **sole** thing distinguishing its look from WE-docs or any other
first-party surface is its **theme (DTCG tokens) + intent set** — nothing structural or behavioral is
hand-authored. Three consequences:

1. **Hand-rolled UI is a conformance defect, not a style choice.** Reaching for `document.createElement` /
   bespoke CSS to build an interaction a FUI component already provides is the product-layer analogue of
   [exercise-app *active-bypass = FAIL*](#) and [compose-don't-hand-roll](#compose-dont-handroll). The
   residue — anything the product *can't* build from `theme + intents` — is a **standards/FUI gap to file,
   never a hack to keep** (the forcing-function thesis: the product is a probe for FUI + intent coverage).
2. **Preserve once it lands (the load-bearing clause).** Once a surface migrates onto FUI, regressing it back
   to hand-rolled UI is a **gated defect, not a tradeoff**. This is *why* the goal is codified to the statute
   layer rather than living only as epic scope: the epic delivers the state, the rule keeps it durable.
3. **Unblocked by the WE↔FUI boundary.** Unlike the WE-docs dogfood (#777, which waits on a mode-C relaxation),
   a served product is the **product layer** and already consumes FUI directly ([constellation-placement](#constellation-placement)
   — served product → Plateau, free to render FUI). No boundary gate applies; the only gate is FUI shipping
   the parts (#658 promoted `@frontierui/blocks` canonical, so the floor exists).

**Lineage:** #1253 (charter — plateau-app dogfooding mandate; ratified 2026-06-20; lands via epic #1254).
Internal twin of [reproduction-conformance](#reproduction-conformance); parallel to the WE-docs dogfood
mandate #777; kin to the exercise-app conformance loop (#314). Composes [compose-don't-hand-roll](#compose-dont-handroll)
and [constellation-placement](#constellation-placement). Enforcement (a `check:`-style plateau-app render
conformance gate giving "preserve once landed" teeth) is a filed follow-up, not a precondition for the rule.

---

### Visualization-family shape: placement & seam count key on whether position is *derived* or *invented* {#viz-family-shape}

A visualization standard (charts, graphs, maps, timelines, …) is a family with a settled skeleton: a
**semantic profile** (data + meaning, presentation-free) + a **renderer-swap protocol** with a
**native-first SVG default** + **3-axis conformance** (semantic fidelity · theme · a11y), with
contract→WE / runtime→FUI per [constellation-placement](#constellation-placement) and adapters deferred
per-engine. Two recurring forks resolve by a single test — **is a mark's position *derived* from its datum,
or *invented* by an algorithm?**

1. **Own project vs sub-profile.** A family earns its **own project** iff it has a positioning **degree of
   freedom** the host family lacks — most often a **layout-algorithm axis**. Charts derive position from
   data via scales (`x = f(field)`); a graph *invents* position via a layout algorithm (force / layered /
   tree / radial) — that axis can't ride as a webcharts sub-profile without bolting a foreign dimension on,
   so graph is its **own** project. No new positioning axis → a sub-profile of the existing family.
2. **Protocol seam count.** Position **derived** from the spec (charts) → a **single** renderer seam
   (`CustomChartRenderer`: spec → output). Position **invented** by a swappable algorithm (graphs) →
   **split into two seams**: a layout protocol (`CustomGraphLayout`: spec → positioned coordinates) ⟂ a
   render protocol (`CustomGraphRenderer`: positioned + theme → output). This is
   [dimension-vs-fixed-mechanic](#config-extends-platform-default) applied to position: an independently
   swappable layout (ELK layered + SVG render) is a legitimate end-state, so it's its own dimension. A
   single-seam precedent from a *derived-position* family is **not** evidence for one seam in an
   *invented-position* family.
3. **Native-first default.** The default layout/renderer must be **deterministic** (pure: same input →
   same coordinates) so it is **conformance-assertable**; non-deterministic engines (force-directed) ship
   as **adapters** behind the layout contract, never as the default. ([native-first-baseline](#native-first-baseline).)

**Lineage:** #1352 (webgraph shape — ratified 2026-06-21; builds via scaffold epic #1351), generalizing the
webcharts family (`CustomChartRenderer`). Composes [constellation-placement](#constellation-placement),
[config-extends-platform-default](#config-extends-platform-default), [native-first-baseline](#native-first-baseline).

### A readout's home keys on its value-type; presentation is a dimension, not a home {#readout-placement-by-value-type}

A status/quantity readout gets its **own** intent for each distinct **value-type**, and the native ARIA
roles draw the lines: a **discrete-state enum** (`status-indicator` — `tone`/`shape`/`affordance`, a
lifecycle state), a **position in a known range** (`meter` / `role=meter` — `value`/`min`/`max`/`low`/
`high`/`optimum`, always determinate, has zones), and **task completion over time** (`progress` /
`role=progressbar` — `value`/`max`, may be indeterminate, drops `aria-valuenow`, no zones; its **own thin
intent** per #1469, with `loader.progress` and `flow-progress` as *consumers* — a determinate bar shown
*during* a pending op is a `progress` readout under a loader strategy, not `loader`'s to define). These are
**incompatible contracts** — folding a continuous bounded scalar into the discrete-state enum or the
task-over-time progress role **mis-types it** (the documented Chakra defect: a measurement that renders
`role="progressbar"`), so a home that has to mis-type the value is the genuine either/or. **Test:** *is
the value an enum, a position in `[min,max]`, or a completion fraction over time?* — three answers, three
homes. **Presentation is never a home:** a gauge (radial) is the meter contract rendered as an arc — a
`presentation` dimension value, not a separate intent (rating / password-strength are likewise meter
*presentations*, consumers not standards). This is [open-numbered-variants](#open-numbered-variants) +
[decompose-overloaded-vocabulary-by-semantic-source](#decompose-overloaded-vocabulary-by-semantic-source)
applied to the readout family, with WE owning the intent contract and FUI the block per
[constellation-placement](#constellation-placement).

**Lineage:** #1410 (meter placement — ratified 2026-06-21; surfaced by the #1400 ARIA-APG lens). Realizing
build #1468 (`meter` intent + FUI block). Sibling progress placement #1469 (ratified 2026-06-21 → `progress`
gets its own thin intent; `loader.progress`/`flow-progress` are consumers); realizing build #1488. Composes
[native-first-baseline](#native-first-baseline) (adopt `<meter>`/`<progress>` vocabulary verbatim).

### Tone is a shared token palette + a meta-contract, never a flattened cross-intent enum {#tone-meta-contract}

A semantic **tone** (an intent's `neutral`/`danger`/`success`/… value) names a **semantic color/severity
family the theme resolves — never a per-component hex** and never a behavior. Sharing happens at **two**
layers, and only those: (1) a shared **token palette** in webtheme — `--tone-{neutral · danger · success ·
warning · info · critical}`, the **severity family only**, scheme-aware via native `light-dark()`; and (2) a
shared **meta-contract** (the dimension is named `tone`; a canonical synonym table normalizes spellings —
`danger ≡ negative ≡ error`, `success ≡ positive`, `warning ≡ caution` — so the theme resolves any synonym
to one token; `neutral` and `info` stay **distinct**, collapsing them is lossy). The **value enum stays
per-intent** — never a single flat cross-intent vocabulary (the Bootstrap `btn-warning` smell). **Membership
test for the shared palette:** a value enters `--tone-*` only if it *differs only in semantic color, not in
behavior/lifecycle* — so `progress` (a lifecycle state, status-indicator) and `categorical` (non-severity
identity color, tag) **fail it** and stay **intent-local tokens**, never absorbed into the palette. This is
[open-numbered-variants](#open-numbered-variants) applied a second time (variant → tone): DRY where it's real
(palette + contract), divergent where it's real (the per-intent enums). **Test:** *does the value differ only
in color, or also in behavior/lifecycle? and is the difference a synonym of a canonical token?* — color-only +
synonym → the shared palette; behavior/lifecycle → intent-local.

**Lineage:** #1427 (cross-intent tone vocabulary — ratified 2026-06-21; #1337 spinoff, surfaced by the #1400
ARIA-APG lens). Realizing builds: #1458 (the `--tone-*` webtheme palette + this statute), #1459 (the per-intent
`severity`→`tone` rename + synonym normalization sweep). Second application of
[open-numbered-variants](#open-numbered-variants); composes [native-first-baseline](#native-first-baseline).

### Theme tokens are JS-first; the injector is the source of truth, CSS custom properties are a one-way projection {#tokens-js-first}

The **runtime source of truth** for a resolved theme token (colour, layout, spacing, font, radius — **every**
CSS-relevant value, not just colour) is **JS, held in the injector** WE already ships (`we:plugs/webinjectors/`
+ `webcontexts`). Any JS reads it **synchronously, off-DOM, with no cascade and no loop**. From that one
source a CSS custom property (`--token-*`) is **emitted one-way (JS→CSS)** for the declarative **paint** path
— cascade, light-DOM scope (the `scoped-token-override` semantic), dark-mode, zero render cost. **Direction is fixed:**
JS→CSS only; CSS custom properties are **never the source** and are **never hand-authored in parallel** (single
source ⇒ the two projections cannot drift). **Components read the injector to *know* their theme; CSS vars
exist only to paint** — `getComputedStyle` is **never** in the compute path. **Why CSS cannot be the source
(browser-validated #1682):** a detached element resolves an inherited/scoped var to `""` (no constructor /
pre-attach read); a worker/OffscreenCanvas, a `console.log("%c", …)`, SSR, and a test have **no element at
all**; and the `connectedCallback` read, even when it resolves, is a forced sync style recalc and the earliest
possible point (deferring to a later loop reintroduces FOUC). **Test:** *does JS need this value before/without
a painted element?* → read the injector, not CSS. This **refines the `design-tokens` protocol's runtime tier**:
"each resolved token compiles to a custom property" now reads — the **injector is the runtime source; the
custom property is the derived projection**. The categorical-taxonomy work (#1670) is one consumer: category
vocabularies are a JS-first token family (`--cat-*`), **not** a new provider/registry.

**Lineage:** #1682 (ratified 2026-06-23 — JS-first token SoT + one-way CSS sync; emerged from the #1670
categorical-taxonomy discussion). Realizing build: #1683 (injector resolves the theme; one-way CSS sync;
migrate the hand-authored `we:src/css/style.css` `:root` vars). Consumer: #1670 (categorical taxonomy).
Refines the `design-tokens` protocol; composes [tone-meta-contract](#tone-meta-contract) (the `--tone-*`
palette is one such emitted token family) and [native-first-baseline](#native-first-baseline).

### The semantic-alias tier is part of the component contract; the injector co-emits it at every themed scope {#semantic-alias-co-emit}

FUI components read **semantic role names** (`var(--color-border)`, `var(--radius-md)`, `--tone-*`) as
ratified by **#1886 Fork 2** (the tokenized-base ruling above) — the reskinnable surface *is* that semantic
role set, so the
semantic names are the **component contract**, not an optional app override. Canonical
`--token-<family>-<name>` values ([tokens-js-first](#tokens-js-first)) reach a component only through a
**semantic-alias tier** (`--color-border: var(--token-color-border)`). **Browser-validated placement rule
(#2026):** `var()` substitutes at the element that *declares* the alias, so a `:root`-only alias forwards
only root-level canonical values and can **never** carry a component-scoped `--token-*` override (Chromium
`getComputedStyle`: a child setting only `--token-color-border` renders the root colour until it
re-declares the alias). **Therefore the alias tier must be co-emitted at every scope a theme targets, and
its owner is FUI — the component-contract owner — not the consuming app or the website build.** The FUI
injector (`fui:plugs/webtheme/` `applyTokenVars`) emits `--token-*` **and** the `--<family>-*` alias tier
onto whatever scope element it themes (`:root` or a component host), both **derived from the single
`LEGACY_ALIASES` source** (relocated into `fui:plugs/webtheme/`), never hand-authored in the emitter — this
**satisfies** [tokens-js-first](#tokens-js-first)'s single-source / one-way rule (the alias is a JS→CSS
projection off the same SoT, not a parallel map). **Rejected:** a **canonical-fallback read**
(`var(--color-border, var(--token-color-border))`) that demotes the semantic tier to an app-optional
override — it strips role-indirection from the default build and reclassifies the semantic read as
app-owned, which #1886 declined; and **canonical-only reads** (no semantic tier), which discard role-remap
entirely. The website-build alias (#1824) stays valid as build-time `:root` transport; this ruling
**extends** the same single-sourced alias into the FUI runtime emit at *any* scope — a platform-runtime
ruling #1824 explicitly did not make.

**Lineage:** #2026 — prepared + ratified 2026-07-01 (Fork 1 = injector co-emit at every themed scope; Fork
2 = badge tones bind to the `--tone-*` severity palette). Refines/composes
[tokens-js-first](#tokens-js-first) (single source, one-way projection) and
[tone-meta-contract](#tone-meta-contract) (the badge severity family). Follow-on builds — relocate
`LEGACY_ALIASES`→FUI + runtime co-emit, close the three untokened card props, badge `--tone-*` migration,
`#2017` loader acceptance — are `blockedBy` #2026. Deferred merit forks: full per-component theme isolation
(F-iso) and per-slot theme inheritance (F-slot).

### Categorical vocabularies are a closed-set token-family meta-schema; behaviour-owned axes (status) are excluded {#categorical-taxonomy}

An app's **categorical vocabularies** (`kind`/`tier`/`size` — closed lists reused across many surfaces:
badge, tag, numbered circle, link-pill, filter chip, border) are **one JS-first token family** — each
`(set, value)` row carries `{ token-ref, icon, shape }`, realized as `--cat-<set>-<value>-*` on the
[tokens-js-first](#tokens-js-first) runtime and synced to CSS. **There is no new "taxonomy provider" or
runtime registry** — the contribution is the **meta-schema + closed-set discipline** (a value resolves to a
token, never an author-supplied hex; the set vocabulary is *open* — an app adds `size` without touching
components), layered on the existing injector. Surfaces consume by `(set, value)`, blind to the rest; this is
what lets a category be **defined once** and read identically everywhere instead of re-hardcoded per macro.
**Membership test — what is a categorical set:** a *pure-presentation* axis with **no behavioural owner**.
**`status` fails it and is excluded:** the Web Lifecycle protocol owns which status values exist + their
transitions, and `lifecycle.json`'s `realizesIntent: status-indicator` already assigns status *presentation*
to the **Status Indicator intent** — so status lives end-to-end in lifecycle + Status Indicator, and
cross-surface reuse comes from **sharing that component**, not smuggling a status colour-row into the
categorical taxonomy (which would fork lifecycle authority + recreate a two-place join). Same boundary as
[tone-meta-contract](#tone-meta-contract)'s palette-membership test (`progress`/lifecycle ⇒ intent-local, not
the shared palette), applied to the categorical layer.

**Lineage:** #1670 (ratified 2026-06-23 — Fork 1 dissolved into [tokens-js-first](#tokens-js-first); Fork 2:
status excluded, lifecycle/Status-Indicator-owned). Consumers: #1669 (`we-tag`), #1598/#1208 (taxonomy-surface
migration). Composes [tokens-js-first](#tokens-js-first) and [tone-meta-contract](#tone-meta-contract).

### Curated-corpus credibility weighting: two-stage admission⟂weight, GRADE-shaped, config-extends-default {#credibility-weighting}

When WE curates a corpus of external sources and must rank them by authority (the design-knowledge
corpus is the first; the shape generalizes to any admitted-and-weighted source set), settle it as
**three orthogonal axes**, never a frozen source list (open-design: custom/project sources must
coexist). **(1) Admission ⟂ weight = two-stage.** A permissive **provenance/content admission floor**
(identifiable + traceable-to-origin + on-topic — **not** a quality bar; "authoritative" means
*attributable*, not *credible*) gates in/out; a **separate scalar weight** is computed only for
admitted sources. A low-credibility custom source is *admitted-but-downweighted*, never excluded —
collapsing admission into a weight-≥-threshold test breaks the open posture. **(2) Weight = GRADE-
shaped.** A **baseline tier from source-`kind`** + a **small fixed, named, *optional* set** of up/down
modifiers; each *applied* modifier records a **rationale + attribution** (only staleness is
deterministic). Flat-tier-by-type is the *degenerate config* (no modifiers), not a rival; a free
per-source number is rejected (un-auditable). The named-vocabulary + mandatory-rationale constraint is
exactly what keeps it auditable rather than re-inventing the free number. **(3) Governance =
[config-extends-platform-default](#config-extends-platform-default).** WE ships the **meta-schema**
(kind enum + modifier vocabulary + computation function) **+ a default flavor**; a project extends
weights / adds kinds & modifiers. **Freeze the meta-schema as the comparable spine**; **cross-project
*absolute* weight comparability is a non-goal** (intra-corpus *ordering* is the only contract — revisit
only if a cross-corpus consumer lands); add a **nonzero floor** on admitted sources so weight-to-zero
can't covertly re-exclude (mirror of axis 1's guarantee). Specializes
[surface-contract-not-computation](#surface-contract-not-computation) and
[config-extends-platform-default](#config-extends-platform-default); internal precedent is
`benchmarkCorpus.json`'s `selectionCriteria`+`inclusionRule` multi-criteria gate (binary inclusion for
coverage, here extended with a weight axis for credibility).

**Lineage:** #1588 (ratified 2026-06-22; child of the #1585 design-knowledge intake program; prep
survey `reports/2026-06-22-design-knowledge-source-admission-credibility.md`). Graduating build: #1591
(meta-schema + computation function + default flavor); tunable-weights Configurator: #1592; consumers
#1586 (ledger weight column) #1587 (rubric provenance) #1589 (distillation). All three forks survived a
refute-only skeptic pass.

### One canonical introspection slot — render alternate subject forms into it, never duplicate the surface {#single-introspection-slot}

An explorer / workbench has **one** canonical render target (the "stage") that its introspection panels
(inspector, event-log, anatomy) read **generically off the rendered DOM**. When an *alternate form* of the
subject must be shown — a cross-origin framework live-mount, a different framework's wrapper, a future
device-frame — it **renders into that same slot**, not into a second pane with its own parallel
introspection wiring. Prior art is unanimous (Storybook / Histoire / Ladle / Bit all read one canvas
framework-agnostically; a separately-wired second introspection target is the surveyed anti-pattern). The
enabler is that the live wrapper mounts the **real custom element** and forwards attrs+events, so native
bubbling + computed-style + the CEM declaration all keep working — the alternate form is *the same subject
re-mounted*, not a new one. A "render beside source" view is **additive** (a non-introspected display), not
a rival target, so it never forks the slot. **Tell:** a proposal to "add a preview pane" that re-derives
events/computed-style/anatomy — that's duplicating the introspection surface; route it through the stage and
resolve the nested subject node instead. Cost is the **subject-node resolution** + **prop-routed control** +
**`unmount()` lifecycle** seams, materially less than a second surface.

**Lineage:** #1594 (ratified 2026-06-22; render the `?form=react-live` live-mount into the stage, not a
separate pane; prep survey `reports/2026-06-22-workbench-live-render-target.md`; skeptic
SURVIVES-WITH-AMENDMENT — the three seams fold into the #1030 build). Under polyglot-sandbox #912; sibling of
[compose-intent-dont-duplicate](#compose-intent-dont-duplicate) (reuse-don't-duplicate, render-target face).

---

### Live-page detection probes for tool-observed presence; the printed claim escalates with its evidence tier {#detection-claim-matches-evidence-tier}

A tool that decides whether a stranger's *running* page uses our platform must **passively probe** —
read tool-observed runtime signals with **zero app cooperation and zero page mutation** — because the
two alternatives are structurally ineligible for an always-on gate: a *declared* manifest is build-time
convention with no runtime footprint (no app ships one, and the level is self-asserted-and-trusted, never
behaviour-verified), and a *verify* pass that runs the conformance corpus **mutates the inspected page**,
so it can never silently decide whether to light up. This is the universal framework-devtool pattern
(React's global hook, Vue's `__VUE__`, Angular's `ng-version`). **The load-bearing rule:** the strength of
the claim the tool prints must **match the evidence tier it actually has** — passive probe ⇒ *presence*
only ("detected"), a self-declared manifest ⇒ the asserted level **badged unverified**, an on-demand verify
run ⇒ the **only** tier permitted to print a *verified* result. Tiers escalate the **assertion, not the
toolset** (the same panels may surface at every tier; what grows is the word the panel is allowed to use).
Conformance is a *verified* word; presence is what a probe knows — never let a passive signal print a
verified claim. **Tell:** a "light up as conformant on detection" proposal — that asserts what only verify
earns; downgrade the headline to "detected" and gate the verified word behind the mutating on-demand action.
**Caveat (probe reach):** only signals readable across an extension's isolated content-script world count —
a DOM marker (`script[type="registry"]`) does; a module-private `Symbol()` or closure state does **not**, so
a public global probe-marker is the load-bearing enabler that widens passive reach beyond the declarative
minority (the move React/Vue made with `__REACT_DEVTOOLS_GLOBAL_HOOK__`).

**Lineage:** #1673 (ratified 2026-06-23; probe-first tiered detection for the conformance-lit extension
MVP; prep topic `reports/2026-06-23-live-page-we-conformance-detection.md`; two skeptic passes both
SURVIVES-WITH-AMENDMENT — the false-positive attack collapsed, the ratification red-team re-sized the probe
reach and promoted the public-marker follow-up #1722). Buried fork under #1656; faithful MVP composition of
#141's "gate on a capability manifest, degrade gracefully" end-state.

### A standard's vocabulary dimension is designed in full up front when its member-set is settled in prior art — completeness-early, not consumer-at-a-time {#vocabulary-completeness-early}

Once an intent's existence is warranted on merit, design its **dimension's full member vocabulary** up
front rather than admitting members one real-consumer-at-a-time. For a **standard** (the intent/vocabulary
layer), the platform's value *is* the coherence of the whole space, so a named-but-incomplete dimension is
an outlier waiting to break the contract: the modifier/intersect/composition rules get proven against the
*whole* member-set instead of being retrofitted when a late shape appears and forces a breaking change.
**The rule:** when a dimension's full member-set is already **settled and specifiable from prior art**,
name and design every member now (`shape: rect | lasso | polygon | nearest`), even if only one is realized
today. This does **not** license inventing speculative members with no prior art — completeness is bounded
by what incumbents prove, not by imagination.

**Tension — and the precise line — vs [thin-container-graduation-trigger](#thin-container-graduation-trigger)
and [judge-on-merit](#judge-on-merit):** the graduation trigger governs minting a new *implementation
artifact* (a block/home) whose **reuse is unproven** — that waits for a 2nd consumer. This rule governs a
*standard's vocabulary completeness* whose **members are already proven in incumbents** — that ships
complete. Artifact reuse is demand-gated; vocabulary design is merit-gated. The marquee case is the
worked example: NOT-YET (wait for a 2nd recognizer shape) was **demand-gating a merit question**, which
judge-on-merit forbids — the shapes are all specifiable from settled geometry, so the dimension ships whole.

**Lineage:** #1463 (ratified 2026-06-24 GO, reversing the prepared demand-gated NOT-YET; merit reframe —
region-select is a coherent intent and `shape` a real dimension whose members all ship in incumbents and
are specifiable now). Fork-1 residual of #1406 (`marquee-select` placement); parent #099 (the intent
layer); graduated to build epic #1734. Prep topic
`reports/2026-06-23-region-select-recognizer-shape-vocabulary.md`.

---

### A reactive handle is never a thenable — expose `.value` + `await .next()` + async iteration, never `get then()` {#reactive-handle-not-thenable}

A reactive handle (the return of a future reactive `consume()`, or any value-plus-future-updates primitive)
must **not** be a thenable. Reading the current value is a synchronous pull — `handle.value` (re-reads live,
matching TC39 Signals `.get()` and RxJS `BehaviorSubject.value`); waiting for the next update is the
*explicit* `await handle.next()`; streaming future updates is `for await…of` via `Symbol.asyncIterator`. A
`get then()` is forbidden because `await handle` after an internal update **hangs forever** — `await` follows
the thenable and waits for the *next* settle that never comes (you also cannot return a thenable from an
`async` function: the Promise Resolution Procedure unwraps it and the outer promise *follows* its pending
state). The hang is thus eliminated **by construction**, not documented-around — the footgun-elimination +
native-first stance. The one spelling sacrificed (`await handle` meaning "wait for next") is *itself* the
ambiguity (now-vs-next collide on one object), so dropping it is the point, not a loss. Rejected alternatives:
keeping `consume()` sync and warning in prose (leaves the footgun); a `{ consumable, value }` wrapper (clunky
destructure + `value` is a consume-time snapshot, a quiet staleness footgun, where `.value` re-reads live).

**Lineage:** #1798 (ratified 2026-06-26 GO; default (a) survived the skeptic pass with amendment — the
value-first `.value` read is retained, only the thenable spelling is removed). Build filed as #1829
(`blockedBy: [1798]`), impl in `fui:plugs/webinjectors` + `fui:plugs/webcontexts`; WE keeps only the
consume/provide contract shape. Prep topic `reports/2026-06-26-consumable-await-footgun.md` +
`/research/reactive-consume-handle-shape/`. Coheres with
[framework-free-core-vendor-segregation](#framework-free-core-vendor-segregation) (native primitives over
vendor reactive libs).

### Bias toward separation — on any combine-vs-split fork, default to two composable homes {#bias-toward-separation}

On any "one combined thing vs. two composed things" fork, **default to separation**: split a reusable axis into
its own intent/protocol/plug that others *compose*, rather than absorbing it into a larger one. The **burden of
proof is on combining**, not separating — couple only when the split has a concrete, named cost. The test for a
distinct paradigm is **recurrence without its neighbour**: a concept that shows up without the thing it was
bundled with (disclosure without a tree; positioning without a droplist) is its own home; folding it in forces
unrelated consumers to drag in a host they don't need. The hazard the rule guards is **schema/ownership
coupling**, not file count — two concerns in two files but one shared schema are still coupled, and one concern
split across many files is not (see [file-count-not-schema-coupling](#categorical-taxonomy) framing). Worked
example: #064 → `disclosure` (open/closed) is its own intent that `hierarchy` *composes*, not absorbed into it.

**Lineage:** #064 (disclosure⟂hierarchy) and the standing per-fork classification pass in
[backlog-workflow.md](backlog-workflow.md); the composition-over-monolith logic the WE constellation is built
on. Coheres with [most-flexible-default](#native-first-baseline) and the harvest-cross-cutting-paradigms pass.

### Reusable-against-all-implementers → the neutral home; fix the surface, not the home {#reusable-neutral-home}

A tool/runtime **reusable against every implementer** belongs in the **shared, neutral home (plateau)**; code
**specific to one implementer** belongs in that implementer (FUI for FUI's own). When a placement decision is
pressured by *one* consuming surface's constraint (a trust-gate, an origin requirement, a backward-edge),
**fix the surface, not the home** — never relocate shared infrastructure to satisfy a single consumer. A
multi-surface tool (run via `npx` inside the impl under test, from the dev browser, from the SaaS exerciser,
and as the docs demo) is shared infra **by construction**; "neutrality is about who-hosts, not where-source-
lives" is a rationalization this rule rejects. The per-implementer piece is the **thin adapter** (the binding's
`dispatch`/`observe`), never the generic engine — distinct from "runnable backends → FUI" (#899), which means
the *impl-specific* backend, not the generic runner/judge.

**Lineage:** #1788 (ratified — the prepared default to re-home the conformance *runner* into FUI was
overturned; the runner is multi-surface shared infra). Refines [constellation-placement](#constellation-placement)
and relates to the backward-edge module-import boundary.

### Cross-origin import keeps the dev server clean — serve heavy/vendor deps from a second origin {#cross-origin-dev-server-hygiene}

When a live-test/workbench feature needs a heavy or vendor dependency (`react`/`react-dom`/`vue`), serve the
generated wrapper module from a **separate origin** and **cross-origin-import** it
(`await import('http://localhost:<port>/<block>.js?form=react-wrapper')`) rather than importing the dep into
the running dev-server tree. ES dynamic import is origin-agnostic and the imported module still mounts
**same-document** (the cross-origin *iframe* is what's forbidden, not a cross-origin fetch), so the dep lives
only on the serving origin — **never in the main dev tree or the shipped bundle** — and the running dev server
never resolves/pre-bundles it (no re-optimize, no reload, no don't-restart-the-server violation). Before
flagging "needs the dev server restarted" because a feature pulls a heavy dep, ask whether it can be served
from a *second* origin and cross-origin-imported (CORS in dev is trivial); two framework copies (one per
origin) is fine when the consumer is framework-free and the mount is isolated. The excluded fork — same-origin
via the running Vite middleware — both reloads the server and leaks vendor deps toward the main tree.

**Lineage:** #1499 (ruling — the workbench live-test #1030/#912 serves the wrapper cross-origin; this is why
#1030's `setup` human-gate was wrong and was removed). Coheres with the FUI vendor-deps-quarantined-to-a-
sub-package rule and [framework-free-core-vendor-segregation](#framework-free-core-vendor-segregation).

---

### Pool-root constellation siblings are real, pushable, built clones — one clone serves both render and the drain, not a render-only symlink {#pool-siblings-real-built-clones}

The lane pool provisions each **other** constellation repo (`frontierui`, `plateau-app`) as a **real, pushable
git clone at pool-root** (`<pool>/frontierui`, `<pool>/plateau-app`), fetched/reset to `main` and **built via
that repo's `build:tools`** (where it has one) on provision/refresh. The **one** clone serves both consumers at
the same `../<name>` path a lane resolves: **WE-lane render** reads its built `dist/`, and the **drain's
cross-repo rebase-drop** fetches/pushes its `origin`. This is safe to share because rebase-drop is **pure git
plumbing — merge-tree → commit-tree → push, no checkout** (`we:scripts/merge-ai-prs.mjs`), so it mutates only
git objects/refs while render reads only `dist/` — disjoint filesystem regions. `siblingCloneName`/
`siblingCloneDir` already resolve `../<name>`, so **no path fork is added**.

This **supersedes the render-only symlink** (#2166, `ensureFuiSibling` → primary's `~/workspace/frontierui`).
The symlink's one lost behavior: WE-lane render no longer reflects **uncommitted primary-FUI WIP** — it tracks
the clone's committed ref (`main`). **Freshness ownership moves to the provisioner** (it rebuilds `dist/` on
refresh; ~1.2s for FUI). Rejected alternative: keep the symlink + a *separate* push path — its only merit is
insulating a mutable push clone from a stable render source, which guards a **future non-plumbing** drain op the
"no checkout" design is committed against; **don't add that abstraction until a real requirement forces it** —
split `siblingCloneDir` (one function) *then*. A plain `plateau-app` clone also un-breaks the lane's Vite
dev-panel import (`vite.config.mts` → `../plateau-app/…`).

**Lineage:** #2282 (ruling — option a; foundational slice of the #2275 drain-on-lane migration; build carried by
the successor provisioner-generalization item). Supersedes the #2166 symlink. Coheres with
[pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism) (the drain is the sole `main` writer) and the #2123
edit-work-runs-in-a-lane-clone rule.

---

### A plugged-vs-unplugged faithfulness surface needs a clean realm per mode; same-document direct injection is the isolation *showcase*, the iframe is a consumer-distribution mode {#plug-gap-clean-realm-per-mode}

When a surface exists to **show the gap** between a plugged (proposed-standard) and unplugged (safe-now)
rendering, a same-document re-mount toggle is **unfaithful**: plugging irreversibly patches realm globals with
no teardown, so an "unplugged" re-mount inherits the lingering plugged globals and **falsely reports "works"** —
faking the very result the surface exists to expose. Faithfulness therefore requires a **clean realm per mode**,
and the cheapest correct mechanism is a **reload-scoped param** (`?plug=on|off` selecting the boot path at load,
reusing the surface's existing URL-state serialization) — ship that first. Two corollaries: **(1)** keeping the
stage *same-document* (no iframe) is itself the honest **isolation showcase** — it demonstrates *the platform's*
isolation, whereas an iframe demonstrates the *browser's* sandbox and masks whether the platform isolates; so
prefer same-document for the demo. **(2)** The iframe-isolated stage is not the toggle mechanism but a separate
**consumer-distribution mode** — sandboxed embedding for *untrusted/third-party* blocks, where isolation is the
product and the async postMessage DOM bridge cost is justified — filed as a follow-up that reuses the
reload-scoped `?plug` param as its per-iframe seed. Governed by most-flexible-default: ship the cheapest correct
clean-realm mechanism now; the richer iframe mode is opt-in later.

**Lineage:** #1845 (ruling — the FUI block-workbench plug toggle; (c) reload-scoped chosen, (b) same-document
re-mount excluded on the lingering-globals correctness bug, (a) iframe reframed as the consumer-distribution
follow-up #1901, build slice #1900). Builds on the plug = proposed-missing-standard lineage and the
same-document-stage contract (`fui:workbench/mount.ts:6-11`).

---

### The authoritative gate runs once, on the merged tree; the lane gate is a best-effort scoped fast-fail {#gate-on-merged-tree-lane-fast-fail}

In a lane-to-central parallel pipeline (agents work in lane clones, push `lane/*` branches, a central broker
merges + gates + pushes `main`), the **binding verdict gate runs once, centrally, on the *merged* tree** — the
full no-flag `npm run check:standards` (+ tests) after the broker merges `lane/*` into `main`, before pushing to
`origin`. This is the "Not Rocket Science Rule" invariant every mature merge queue enforces (Bors fast-forwards
only a green *merged* commit; GitHub gates the speculative merge commit; Zuul gates the assembled DAG), and it is
the **only** place a consistent — and, for cross-repo lanes, *assembled multi-repo* — tree exists. A **lane gate
cannot be the authority**: an isolated lane tree *false-reds* on whole-repo consistency rules that can't pass
without sibling lanes present (live-measured: #1153's 4-of-7 lanes red'd in isolation, green on merge). The lane
**may** run a gate, but only the **scoped** `check:standards --local --files=<lane's edited files>` (#1159's
partition, which demotes global-consistency findings) as a **best-effort pre-push fast-fail** — it catches the
author's own file-local mistakes before a wasted push+merge round-trip, but is an *optimization, not a
correctness gate*: skipping it costs only a round-trip, never correctness. The two halves are non-overlapping by
construction (#1159 deliberately removed the global rules from the lane gate and defers them to the unflagged
central gate), so this is a clean file-local-fast vs global-authoritative split, not redundant double-running.

**Lineage:** #1937 (ruling — Fork C adopted: central full gate = authority/mandatory, lane scoped fast-fail =
best-effort; report `we:reports/2026-06-28-gate-location-lane-central.md`). Under parent #1933 (the parallel-batch
pipeline); lane fast-fail build = follow-up #1939. Reuses the #1159 gate-partition (`we:scripts/check-standards.mjs:1385-1410`).

### Merge-risk = optimistic-by-default, lock only the irreducible shared set, derived static ∪ dynamic {#merge-risk-optimistic-with-targeted-lock}

In the same lane-to-central pipeline, a lane must **reserve (pre-lock) a file before editing it iff** the file is on a **static denylist OR ≥2 active lanes' probed touch-sets both name it** (static ∪ dynamic double-declaration); everything else relies on optimistic git-merge, with a merge conflict as the last-resort backstop (replay that lane serially). Optimism is the floor — pessimism is added *only* where a wrong guess is expensive — because the DB literature ("combine optimistic + pessimistic"), the merge-queue/monorepo "serialize only the shared scope" critique, and WE's already-disjoint **per-entry registries** ([#1145/#1146/#1157](backlog-workflow.md)) all converge there. The static set is **derived by category, not a fixed file list** (the list is operational and drifts): a candidate shared file is (①) a **splittable collection** → split to per-entry, leaves the lock-set; (②) **purely-derived** (a deterministic generator reproduces it from source) → regenerate-on-merge, leaves the lock-set; or (③) an **irreducible residual** (structured registration doc / hand-curated *sweep input* / hand-authored prose) → **locked**. **③ excludes flat config (#1952/#2149 Fork 1):** a **flat, developer-unique-keyed config** (`tsconfig.json`, `vite.config.mts`, `vitest.config.ts`) merges optimistically — distinct-line edits are trustworthy and a genuine clash is a real git conflict — so it is **not** ③. A **keyed manifest** (`package.json`) is likewise optimistic, *not* locked: its only clean-but-wrong class is two lanes adding the **same key** (order is irrelevant to npm; distinct-key adds merge clean and correct), which is fully enumerable and machine-checkable — so it rides the floor behind a **deterministic duplicate-key merge-gate lint** (`validateNoDuplicateManifestKeys`, run by check:standards on the merged tree), per the hookable-vs-judgment rule (a script-decidable class gets a hook, not a lock). What **stays ③** is a **registration monolith** (`.eleventy.js`: same-name / ordering-sensitive `addFilter`/`addShortcode`/… registrations clean-merge into a silent last-wins and are **not** deterministically lintable) — locked until a proven fragment split moves it to ① (order-insensitivity established, per #2149 Fork 2). The discriminator for ②-vs-③ is *purity*: a `lastSwept`/`selectionCriteria`-style **curated** artifact is **not** purely-derived (no generator reproduces a human's curation) and stays locked; a hand-authored doc with an embedded auto-generated block is **locked prose + a regenerated sub-block**, never a wholesale regenerate. The dynamic layer extends coverage to the unenumerable long tail (ordinary `*.ts`/`*.njk`/shared-test overlaps the static list can't name); a static-only interim re-exposes optimism on that *common* surface, so dynamic-B ships **promptly**, not deferred.

**Lineage:** #1935 (ratified 2026-06-28 — Fork 1: optimistic-floor + pre-lock layer [D-alone rejected]; Fork 2: Option C static[③] ∪ dynamic-B, static-first→B-promptly rollout [skeptic SURVIVES-WITH-AMENDMENT → AGENTS.md is locked-prose-not-output, curated-sweep stay locked, B prioritized not deferred]; report `we:reports/2026-06-28-merge-risk-file-determination.md`). Under parent #1933; format-change precursor = #1938 (`blockedBy: ["1935"]`, shrinks the at-risk set). Sibling of [gate-on-merged-tree-lane-fast-fail](#gate-on-merged-tree-lane-fast-fail) in the #1933 cluster.

**Amendment — deferred-landing lock lifetime + a whitelisted-additive carve to the ③-stays-locked rule (#2138 Fork 3, ratified 2026-07-02).** Deferred landing (the [#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism) merge-queue rider) reopens the clean-but-wrong structured-merge window *between push and drain*: a lane's write-time lock (`we:scripts/readiness/file-locks.mjs`) releases when the producing session ends at push, but the change then sits **queued and unmerged**, so a later lane can edit the same ③ file against a `main` that does not yet contain it. Ruling: the **drain detects denylist overlap among queued lanes and serial-replays the second — this is primary**, consistent with the "③ stays locked" floor and enforced anyway by the per-merge merged-tree gate. Holding the lock across the whole human-paced queue wait is **rejected** — a queued item may wait hours, far past the 15-min `DEFAULT_LEASE_MINUTES` ([`we:scripts/readiness/file-locks.mjs`](../../scripts/readiness/file-locks.mjs)), so the lock either expires and reopens the hazard or wedges the file under a dead owner. As an **opt-in optimization only**, an early **expand/contract micro-slice** ([ParallelChange](https://martinfowler.com/bliki/ParallelChange.html) *expand* phase) may land a lane's ③-file delta ahead of its bulk lane and release the lock early **iff** the hunk matches a **whitelist of provably-safe additive regions** (appending a new `we:package.json` script key; a new per-entry `we:.eleventy.js` registration line) — authored by the **drain** (not the producing agent — it alone sees sibling lanes' overlapping deltas), and cherry-picked **verbatim** so the bulk lane's later re-add onto post-drain `main` is a **byte-identical no-op** (a reformat between applies would break byte-identity → a real conflict). This is **not** a general line-diff classifier: a **dependency add / version bump**, an `"overrides"` block, or a side-effectful/ordering-sensitive registration is line-additive yet semantically load-bearing and is **NOT whitelisted** → serial-replay (ParallelChange authorizes additive-lands-ahead only *when a human judged it additive*, never a mechanical line diff). The carve narrows "③ stays locked" for the whitelisted regions only; the residual ③ set stays locked. Composes with **#2148** (removes the FUI directive barrels from the denylist entirely) and **#2149** (declares the irreducible `we:package.json` / `we:.eleventy.js` residual). Report `we:reports/2026-07-02-deferred-merge-queue-substrate.md`.

**Amendment — the two root files split asymmetrically, and the ③ "build config" wording is corrected (#2149, ratified 2026-07-03).** A batch story to blacklist `we:package.json` + `we:.eleventy.js` was retyped to a decision because the edit appeared to reverse #1952's line-structured demotion. The prep found (a) *neither path was ever actually listed* — both were swept in only by the code header's generalized "BUILD CONFIG" parenthetical, and #1952's real removals were `we:tsconfig.json` + `we:vite.config.mts`; and (b) the statute's ③ literal ("build config → locked") already contradicted those ratified removals. Ruling: the two files are **not symmetric**. **Fork 1 — `we:package.json` stays optimistic** (a keyed manifest whose sole clean-but-wrong class, duplicate keys, is deterministically lintable) behind a new duplicate-key merge-gate lint (`validateNoDuplicateManifestKeys`, `we:scripts/check-standards-rules.mjs`, shipped in this ruling's changeset — no unguarded interim window); declaring it ③ was **rejected on merit** — its only edge over the lint is replay-*speed* (prioritization wearing merit's clothes, #1961), and the lint has broader coverage (every landing, not just orchestrator-packed lanes). **Fork 2 — `we:.eleventy.js` is declared ③ merge-risk now** (a registration monolith whose same-name/order-sensitive registrations clean-merge silently and are un-lintable), listed in both mirror homes (`we:scripts/readiness/lane-partition.mjs` + `we:.claude/skills/batch-backlog-items/parallel-execute.workflow.js`); its future off-ramp is the **already-standing category-① split-and-exit** (delist iff a fragment split proves order-insensitivity — the split is an ordinary backlog story, *not* pre-blessed here). The ③ category line above is corrected in the same change (flat/keyed config → optimistic; registration monolith → ③). `we:tsconfig.json` / `we:vite.config.mts` stay optimistic under every branch. Report `we:reports/2026-07-02-merge-risk-blacklist-package-json-eleventy.md`.

### Lane ownership is a minted per-holder slug, asserted per op, checked at the guard — never inferred from ambient process identity {#lane-ownership-minted-slug-per-op}

In the parallel `/workflow` topology every sibling lane shares the top-level `CLAUDE_CODE_SESSION_ID` (a
spawned subagent inherits the parent's id verbatim; shell exports don't survive an agent's separate Bash
calls), so **no ambient env/process property can distinguish siblings** — a lease stamped from ambient
identity makes every sibling read as owner in every lane. The ruling adopts the fencing-token pattern the
prior art converges on (Kleppmann's fencing tokens; Kubernetes Lease `holderIdentity`): identity is a
**minted string per logical holder** (`<batchSlug>-<laneKey>`, already minted deterministically by the
orchestrator), carried **with each operation** (inline `LANE_SESSION=<slug>` in the command string — the
one per-op channel with both ends in-repo), and checked **by the arbiter at the point of use**
(`we:scripts/guard-bash.mjs`). Concretely: (1) each parallel lane's step-1 prep becomes an explicit-lane
`acquire --lane=N` under its per-lane slug — replacing the manual `reset --hard`/`clean -fd` prep, with a
short TTL (~60–90 min), an explicit slug-carrying release at close-out, an acquire per affected impl
repo, and invocation pinned to the primary; (2) the workflow acquire sets a dedicated `workflowLane`
lease field (a contract field, not `purpose` free text), and for a **live marked** lease the guard
requires the command string to assert the lease's own slug, denying on mismatch **or absence** —
fail-closed, with precedence over the degraded no-id fail-open (which is thereby rescoped to unmarked
leases; all serial-topology semantics unchanged). The hook-payload `agent_id` channel (ambient,
per-subagent, experimental) is **excluded on principle**: it is process identity — pid-shaped, ephemeral,
third-party-owned — with an unbridgeable mint/check split and silent fail-open degradation; any repair
routing it through the command string collapses into the minted-slug design with a worse token.

**Lineage:** #2413 (ratified 2026-07-11 — Fork 1 (a) in-lane acquire; Fork 2 (b) per-op slug assertion
fail-closed in marked lanes; two skeptic rounds incl. a refuted `agent_id` default-flip; report
`we:reports/2026-07-10-per-lane-ownership-signal-parallel-workflow-lanes.md`). Extends the #2367 guard
(cross-session protection) to sibling lanes. Build carried by #2427.

### Automated closeout is non-destructive and changeset-scoped; the writer operating model targets PR-flow / multi-session {#non-destructive-closeout-prflow}

Two rulings on *where* the constellation's work happens and what an automated closeout may touch.

**(Rung 1 — forced invariant) Non-destructive, changeset-scoped closeout.** Any agent / closeout / integrator
acts **only** on files in its own recorded manifest (the orchestrator ledger's `changedFiles`, or a session's
own edits), **never reverts or deletes a file it did not itself write**, and **never reads the dirty working
tree as ownership truth**. The shared primary checkout's dirty state is the normal baseline (other sessions'
uncommitted work lives there); inferring "what I own" from `git status` cannot tell your residue from a
stranger's live edits, so any destructive reaction (`checkout`/`rm`/`stash`) can erase another session's work —
which is exactly what happened (`batch-2026-06-29e` clobbered a concurrent `/prepare`'s in-progress #1983
files). It is a **forced** invariant, not one option: the alternatives (a session-scoped lock; a
commit-before-closeout discipline) both require cooperation the colliding **stranger** session cannot be made
to give, so "act only on your own manifest" is the only no-bad-actor-needed mechanism. Practised by the scoped
close-out gate in [backlog-workflow.md](backlog-workflow.md) (*Closing out a completed item* / pre-flight) and
the durable rule `we:agent-memory-src/closeout-never-infers-ownership-from-dirty-tree.md` (SoT relocated out of
`.claude/` by #2266; a back-compat symlink at `we:.claude/agent-memory/` still resolves the old spelling).

**(Rung 2 — operating-model direction) Writers collaborate through the remote in a PR-flow.** The
constellation's writers — **agent *and* human sessions, not just `/workflow` parallel batches** — target
collaborating **through the remote** (each works in its own clone/ref → push → gate → review → merge) rather
than sharing one dirty primary checkout, so multiple concurrent sessions can work together. The **`lane/*`
push-ref transport is the general primitive** (made reliable by #1995's bounded push-retry on transient
ref-lock contention), not a `/workflow`-only mechanism. This is a *direction*; the rollout **mechanism** —
clone scope (every session vs substantive-work-only), per-clone dev server/HMR, landing gate
(auto-merge-on-green vs human review), branch-protection shape (observe-only `main`, reconciled with the #1153
branch guard + the removed never-push default), and the visual-verification harness (Rung 3's #1895
acceptance test) — is **prepared as its own decision, #1996**, not ratified here.

**Lineage:** #1985 (ratified 2026-06-30 — Rung 1 forced invariant; Rung 2 direction *adopt PR-flow*, reframed
in discussion from the prep's "don't generalize" once the goal was set as a multi-session operating model, not
incident-remediation; Rung 3 folds into #1996; report `we:reports/2026-06-30-automated-writer-isolation.md`).
Under parent #1933; extends its clone model with closeout safety + the operating-model direction. Push
reliability = #1995. Mechanism to prepare = #1996. Sibling of
[gate-on-merged-tree-lane-fast-fail](#gate-on-merged-tree-lane-fast-fail) and
[merge-risk-optimistic-with-targeted-lock](#merge-risk-optimistic-with-targeted-lock) in the #1933 cluster.

---

### Visual-regression substrate — self-hosted Playwright, in-repo baselines, no hosted SaaS {#visual-regression-substrate}

The visual gate is **self-hosted Playwright in a pinned container** — never a hosted visual-review SaaS
(Argos/Chromatic/Percy). Baselines are committed `-linux` PNGs generated in the pinned
`mcr.microsoft.com/playwright:vX-jammy` image; review is the PR's rendered image diff (decision #2233,
ratified 2026-07-09; parent epic #2232, slices #2234–#2240 target this substrate). Rationale: Playwright is
already the incumbent (`@playwright/test` + `check:visual` + `tests/visual/` committed baselines), so the
real choice was keep-the-incumbent vs rip-it-out-for-a-vendor mid-epic — a migration buys a review-UX gain
for a token/secret, off-repo baseline storage, and a third party seeing rendered pages, all against the
self-contained / [native-first](#native-first-baseline) ethos. **Two evidence-gated escape hatches stay
live — revisit only on evidence, not pre-emptively:** (1) layer **Argos as a diff-review UI only** while
baselines remain in-repo, *if* in-PR image-diff review proves too coarse in practice (#2233 fork 2); (2)
**graduate baselines off committed PNG** when git churn weighs (#1967). Both are opt-in later moves, not the
default now.

### Design-source home + locked in-code target reference {#design-source-locked-in-code-target}

**Ratified 2026-08-01 (#2801).** Productizes RRFC INVARIANT A's target registry. Composes the
[UI-Fidelity Gate epic #2804](/backlog/2804-ui-fidelity-gate-real-route-conformance-born-with-contract-t/) and its
INVARIANT A — the target is registry-anchored + content-hashed. This statute rules **four directions only**; the
security-bearing *mechanics* are explicitly deferred to the target-registry slice #2806 (see "Deferred to #2806"
below). Four ruled directions:

- **Canonical stored form = the in-code artifact, the sole content-hashed canon.** The identity is a content hash
  over the in-code target artifact's canonical bytes — the in-code artifact is the single source of truth. A
  rendered baseline PNG is a **non-canonical, advisory** product-repo artifact feeding the tolerance-compared
  perceptual layer — **never** a hash anchor, **never** in WE as a *design target* (a hash over pixels isn't a
  stable identity, and committing product screenshots to WE breaches WE-holds-zero, MEMORY #6). *(This is the
  design-target baseline, and does not touch the [visual-regression substrate](#visual-regression-substrate)'s
  committed `-linux` baseline PNGs, which **are** WE's in-repo regression substrate — the two compose: the
  regression baseline proves WE's own gate does not drift; the design-target baseline is the product's rendered
  reference for a conformance oracle, and lives product-side. Different baselines, different repos.)* The exact
  canonicalization + hashing rule is a #2806 mechanic, not fixed here.
- **External-source import→freeze = normalize to one source-agnostic in-code artifact + provenance, and archive
  the raw native payload.** Every source materializes the *same* canonical in-code artifact; the raw native
  import payload (e.g. Figma node JSON + fetched PNG) is archived as an **opaque, non-canonical** provenance blob
  for lossless offline re-normalization — never a second per-source target kind the gate reads. **Figma is a
  swappable importer that pins `?version`, not a target kind.** What "frozen" must *guarantee* (no live/expiring
  subresources; redaction of the raw payload) is a #2806 mechanic, not asserted here.
- **Version-minting authority = a minter-agnostic WE contract.** WE owns the identity *mechanism* — the id scheme
  `registryId@vN` and the direction that any authorized client (not one product surface) can mint; design-studio
  #2676 is one client, not the owner. A product-owned minting authority is rejected as a layer leak that
  forecloses every other minter. The ledger format, the authorization predicate, and how a version is signed are
  #2806 mechanics, not fixed here.
- **Interactions gate on assertability.** Gate deterministic post-interaction states **now** through the boolean
  floor — focus / `focus-visible`, `aria-*` flips, disabled / loading / error states after an event. Motion /
  timing / prototype feel stays **advisory** (no deterministic oracle; blocking would rot).

**Deferred to #2806 (INVARIANT A) — the secure mechanism, not this statute.** This statute states *direction*;
the [target-registry slice #2806](/backlog/2806-target-registry-approval-token-perceptual-distance-floor/) owns
the token / authorization / keyed-signing / tamper-evidence / canonicalization / freeze / PII-redaction
**mechanics** and lists them as security requirements. Deliberately **not** ruled here (an earlier draft baked in
a self-issuable token, "the token signs the hash", append-only-ledger internals, and a "frozen" guarantee — a
broken trust model this statute must not codify): the mint needs an **authorization predicate** (not
self-issuable); the digest is an **integrity digest, not authenticity** (align with #2809 — an unkeyed sha256
over public inputs proves neither); the token must **bind `registryId` + `@vN` + `authoredInCommit`** (not the
bare content hash); the ledger needs **tamper-evidence**; "frozen" must **forbid live/expiring subresources**;
`sha256` needs a **canonicalization rule**; the raw payload needs **redaction/PII handling + a `sourceHash`
binding**. #2806 designs these; the statute only fixes the four directions above.

### Skill/memory replay substrate — an ephemeral throwaway clone, never the shared lane pool {#skill-memory-replay-substrate}

The skill/memory validation suite (#2268) replays a **mutating** script/skill case inside an **ephemeral
throwaway clone** — `mkdtempSync` + `git init`/`git clone` off the fixture corpus, run the *real* mutation,
assert the invariant-catalogue checks on the resulting tree, `rmSync` in teardown — **never** the shared lane
pool (decision #2274, ratified 2026-07-09; parent epic #2268; unblocks #2272, sibling #2273 owns the Tier-A
snapshot on the same substrate). This is the pattern already shipping in
`we:scripts/__tests__/lane-drain-numbering.test.mjs`, so it generalizes a proven shape rather than inventing a
primitive. The shared `we:scripts/lane-pool.mjs` is **excluded as the substrate** because it is production
infra: `acquire` exits 1 in CI (no pool exists, `we:scripts/lane-pool.mjs:474`), `reset --hard origin/main` +
`clean -fd` destroys any seeded synthetic fixture (`:508-511`), and a red test strands a 4-hour lease that
contends with the live drain. **This holds even when the case under test *is* the lane tooling:** point the
real `we:scripts/lane-pool.mjs` at a fabricated `LANE_POOL_ROOT` under a `mkdtemp` dir (a throwaway origin +
reference + pool), never at allocated production lanes — the pattern shipping in
`we:scripts/__tests__/lane-pool-refresh-guard.test.mjs`. **`--dry-run` stays an operator-preview feature, never
the suite's fidelity substrate** — a dry-run of a mutating op asserts the *preview* branch, not the real
commit/rename/merge the suite regression-guards, so "faithful dry-run" is self-contradictory (the universal
`--dry-run` retrofit was parent-excluded on that fidelity gap). Scope caveat: this settles only *where the
mutation runs*; driving an LLM *judgment* (Tier-B) skill deterministically enough to assert on is a separate,
unsolved #2272 problem that no substrate choice resolves.

### PR-flow rollout mechanism — automation isolates, human writes `main`, landing is fully automatic {#pr-flow-rollout-mechanism}

The **mechanism** implementing [#1985 Rung 2](#non-destructive-closeout-prflow)'s adopt-PR-flow direction (that
anchor is the governing direction; this one is the how). Five ratified calls (#1996, ratified 2026-06-30):

- **Isolate-by-default for automation; the human writes `main` directly.** Every **automated** writing session
  (agent / `/workflow`) works in a **clone** (branches are guard-blocked in the shared checkout, #1153, so
  isolation = a clone), gates itself, pushes a `lane/*` ref, and converges via the integrator's auto-merge —
  `main` is **convergence-only for automation**. The **human** is the single trusted writer and keeps direct
  commit/push to `main`. Rationale: an ad-hoc agent `main` edit cannot be *proven* disjoint from a live lane
  (the orchestrator's disjointness partition only covers items *it* dispatches), so isolation is the only
  race-free posture for automation; a lone trusted human has no one to race.
- **Per-lane dev-server ports = pure deterministic offset by lane index, `strictPort:true`, with per-repo
  thousands-bands.** A squat surfaces as a loud boot failure, never a silent re-scan (no linear probe — a probe
  is dynamic discovery and dissolves the determinism). Bands: **WE `3000+` / 11ty `8080+`, plateau-app
  `4000+`, Frontier UI `6000+`** (`5000`/`7000` are macOS AirPlay/ControlCenter-reserved). Ports **and** the
  11ty proxy `target` are env-driven (`WE_VITE_PORT` / `WE_ELEVENTY_PORT`, `changeOrigin:true`) via a generated
  per-clone `.env.local`; FUI needs no port inside a coupled WE+FUI lane (relative path-alias resolves it).
- **Landing is fully automatic: auto-merge on gate-green, no manual merge, no mandatory human review.** The
  automated gate (`check:standards` + build + tests + the visual check below) is the sole landing authority;
  per-item human review is opt-in but never required.
- **Branch posture is asymmetric: `main` writable by the human, observe-only for AI/agents.** Agents PR-flow
  only; enforcement is convention now (isolate-by-default + the commit/closeout guards) and a bot-principal
  branch rule later. Full observe-only `main` stays a future flip for when a second human appears.
- **Visual changes land safely by an automated render-check in the gate (not a human).** A visual-touching lane
  (`*.njk`/`*.css`/template surfaces) auto-merges **only when** a headless Playwright render check passes on its
  booted WE+FUI cross-origin pair; the harness is a v1 deliverable, bounded "done" by reproducing the #1895
  transparent-`.fui-card` regression *and* its fix from the CLI. (Fallback if descoped: agents don't auto-land
  visual changes and the human owns visual surfaces via the direct-`main` path.)

**Enforcement ladder for the asymmetric posture (#1998 — spec of the "convention now, bot-principal later"
bullet).** The isolate-by-default + human-writes-`main` posture tightens in three rungs; only Rung 1 is live:

- **Rung 1 — convention (live now).** No server-side gate. Automated writers isolate by *practice* (the
  `/workflow` orchestrator clones + converges via `lane/*`; the serial `/batch` still commits on the current
  branch per Rule 104 as the interim), backed by the existing **commit/closeout guards** — the #1153 branch
  guard (denies `git switch`/`checkout -b`/`worktree add` in the shared checkout, forcing clones), the
  broad-stage `git add -A` denial, and the non-destructive-closeout invariant ([#1985](#non-destructive-closeout-prflow)).
  The removed never-push default still authorizes the **human's** direct `git push origin main`. Interim risk:
  nothing *prevents* an agent committing `main` directly — the floor is discipline, not a rule.
- **Rung 2 — server-side bot-principal branch rule (the specced future flip).** Agents authenticate to the
  remote as a **distinct GitHub principal** (a bot identity — a machine user or GitHub App installation token,
  never the human's credentials). A branch-protection rule on `main` **requires a PR** (blocks direct pushes)
  for that principal, while the human account is **exempt** (or holds a bypass allowance). Mechanically: the
  integrator's converge-to-`main` merge either runs under the human/owner identity (so it lands) or the bot
  principal is granted the narrow "merge own green PR" bypass; lane pushes to `lane/*` refs stay open for the
  bot (they are not `main`). Net effect: an agent *cannot* write `main` directly even by mistake — the
  convention becomes a server-enforced invariant — while the human's direct path is untouched. This rung needs
  a real GitHub remote + org/app setup, so it is **not** agent-executable (a human `setup` gate).
- **Rung 3 — symmetric observe-only `main` (deferred).** When a *second human* writer appears, the human's
  direct-`main` path also closes and everyone PR-flows. By then agents are already off direct `main` (Rung 2),
  so only the human's exemption is removed — nearly free. Deferred until the second-writer need is real (a lone
  trusted writer has no one to race, so forcing them to PR buys friction with no safety).


**Amendment — the rung is a configurable dimension whose current value is Rung 1; Rung 2 is OFF, not rejected
(#3423, ratified 2026-09-06 by the operator).** #3373 found that nothing at GitHub's own layer enforces the
sole-writer invariant JIT numbering depends on — it holds entirely by script discipline. Ruling: **that
discipline is the accepted enforcement layer**, and what "accepted" names is a real layered control, not a
promise — `assertMayMerge` (`we:scripts/lib/pr-merge-gate.mjs`) is the sole `gh pr merge` chokepoint and throws
for any caller that is not the drain unless `WE_MERGE_BREAK_GLASS=1`, which logs loudly on every use;
`withNumberingLock` / `withLandWriteLock` (`we:scripts/readiness/drain-lock.mjs`) share a key so a merge write
and the numbering step stay mutually exclusive; and `duplicateBornAs` / `strandedHashesOnMain`
(`we:scripts/check-standards-rules.mjs`) are a build-time catch net that surfaces the artifact an out-of-band
write leaves behind — a duplicate or un-numbered hash — even if the live gate were skipped.

**Read the ladder as a dimension, not a verdict.** Rung 2 is **not turned on**; it was not weighed and lost.
The operator's framing at ratification, which is the ratified one: enforcement level is a **configurable
dimension** with a safe default, per [#config-extends-platform-default](#config-extends-platform-default) —
Rung 2 is a selectable flavor blocked on a *prerequisite*, not on merit. The mechanism genuinely exists
(Repository Rulesets carry a `bypass_actors` list and are available on GitHub Free for **public personal**
repos, which this repo is — the older "personal repos cannot do this" reading was too broad, and refers to the
org-only classic `restrictions` field). What is missing is the **actor**: this repo has exactly one
collaborator, and the drain's merges ride that same human credential, so there is nothing to name that is not
the human.

**What stays refused today, so the amendment is not a back door.** Flipping `enforce_admins` now either no-ops
(an admin acting outside the disciplined scripts is still an admin, allow-listed or not) or blocks the human's
own direct-`main` path that the Rung 1 / Rung 3 design depends on — and it would regress **#2152** (resolved
2026-07-02), which set `enforce_admins: false` deliberately to keep the `--fallback-git` and
`WE_MERGE_BREAK_GLASS` paths working. **Revisit trigger:** a distinct bot GitHub principal is minted for the
drain (Rung 2's own stated prerequisite — an App installation or machine-user PAT wired into its `gh` auth), or
a second human writer joins (Rung 3). Neither holds today. The declared-rung knob and the drift check that
keeps the declaration honest are build **#3532**.

**Lineage:** #1996 (ratified 2026-06-30; report `we:reports/2026-06-30-pr-flow-rollout-mechanism.md`; research
topic `pr-flow-rollout-mechanism`); enforcement ladder specced by #1998 (Forks 1+4). Implements
[#1985 Rung 2](#non-destructive-closeout-prflow); builds on the #1933 clone model + #1995 push-retry; composes
with the #1153 branch guard and the removed never-push default (both unchanged). Visual harness files under
#1933 / #1167 / #1552.

**Rider — close-out is not a direct-`main` write path; session-meta is the one sanctioned-direct carve-out
(#2191, under the #2203 strict lock).** Post-#2183/#2203 **every edit-shaped change already landed via a
lane→PR during the session**, so a session's close-out must not re-open a direct-to-`main` path for it:
- **Close-out auto-commit is edit-work-free.** The `closing-session` clean auto-commit **no-ops on already-PR'd
  work** (the common case now — nothing edit-shaped is left uncommitted at close). Anything genuinely
  uncommitted-and-finished that IS edit-action work (source, content, a backlog item/resolve) routes through
  the **lane→PR** helper (`we:scripts/pr-land.mjs`), never a `git commit` on `main`. The serial `/batch` and
  `/workflow` producers already close this way (they land as open ready-to-merge PRs and touch no `main`).
- **Agent-memory *content* rides a lane→PR — it is not the carve-out.** Substantive **agent-memory** writes
  (`we:agent-memory-src/**` — the SoT #2266 physically relocated out of `.claude/`; a back-compat symlink
  remains at `we:.claude/agent-memory/`, so either spelling names the same durable content) are durable content,
  so under the lane machinery they **land via a lane→PR**
  (each candidate red-teamed first; the survivors ride the one PR the close opens) — never an agent
  direct-`main` commit. **The sanctioned-direct carve-out is `claims.json`-class *local signals* ONLY**
  (`claims.json`/`queued.json`/`reservations.json`): these are session bookkeeping the #2138-Fork-4 rider
  already treats as a direct *local* signal (read offline, Rule #105), written to disk for the local checkout
  and never pushed. The carve-out is **local signals only**; it never widens to memory content, source, content,
  or backlog edits (all of which take the lane→PR path).
  **(#2266 re-anchor.)** Relocating this SoT out of `.claude/` is a **physical path move only**: the
  lane→PR-only landing rule and the "never widens" carve-out above are **unchanged** and now attach to
  `we:agent-memory-src/**` (they do **not** grow a back-door direct-`main` path for the new spelling).
  Auto-approving the VS Code `.claude` permission prompt (via the personal redirect hook #2266 adds) is a
  **permission-gate event, not a landing-path change** — the write still lands in the working tree and lane→PR
  still governs how it reaches `main`, so it creates **no** new sanctioned-direct carve-out.
- **No other close-out path direct-commits edit work.** `/batch` close, `calibrate`, and the cost-on-card splice
  either fold into an already-PR'd lane commit or are session-meta under this carve-out. The `check:health` /
  closeout audit reports any residual uncommitted edit work for awareness — it does not auto-commit it to `main`.

**Rider — solo/interactive sessions lane uniformly (#2123, ratified 2026-07-02).** The "every automated
writing session" scope above covers **solo** agent sessions too — a lone `/next` build, a `/prepare`, a
`resolve` — not just `/workflow`: the writer in an agent session *is* the agent, so the human-writes-`main`
carve-out does not rescue them. Ruling: **every edit-action session runs in a lane clone and lands via the
flow, with no permanent content-session (`backlog/`/`reports/`/research) carve-out** — a "content" session
that then codifies a doc or regenerates a derived artifact silently crosses the line mid-session, and the
proven collision (`batch-2026-06-29e` clobbering a live `/prepare`) sat on that very file class, so
misclassification-safety beats the carve-out's live-observability edge. **Phase-1 trigger (capability, not
calendar):** code-only writing sessions lane **now**; interactive/content sessions stay on the shared primary
until a lane can boot its own WE dev-pair on its band ports (the `.env.local` env-load link), then flip — a
when-the-capability-lands trigger, not a permanent exemption. This **ends the Rung-1 interim for solo
sessions**. The claim-locus and lane before-state-soundness *mechanics* are session-tooling carried in the
#2138 merge-queue line — which also owns the self-approved-PR / GitHub-merge-queue landing substrate (#2138
Fork 5 → #2151 CI-on-PR, #2152 branch protection, #2153 PR drain) — not part of this scope ruling.

**Rider — decision-authoring uses a preview lane; #2123 stays uniform (#2187, ratified 2026-07-03).** #2183
direction-point 4 carved decisions as *author-in-`main`, then lane-at-ratify* so a decision's rendered effect
stays live-previewable while it is authored — but the now-active #2123 guard blocks primary-tree `Edit`/`Write`,
so that carve-out needed reconciling. Ruling: **decisions author in a dedicated PREVIEW LANE — no guard
exemption; #2123 stays uniform (no decision-authoring carve-out).** The ergonomic case for an exemption
(edit/review the exact primary tree the human watches) is a **solved tooling problem**: at a decision **claim**
the skill provisions/reuses the preview lane, `map`s it to the #2139 page-port proxy (so `:3000` stays the
single review URL), launches its dev server, and **opens the rendered `/backlog/<NNN>/` page** — the
live-authoring loop, in a lane (validated by hand 2026-07-03). This realizes the #2123 rider's
"flip interactive/content sessions to a lane once it can boot its own WE dev-pair" trigger for the decision
case. **Rejected:** a scoped `DECISION_AUTHORING=1` guard exemption — even tightly scoped to decision
`backlog/*.md` + this file, it re-opens the exact content-session carve-out #2123 ruled *against*; the preview
lane holds the rule uniform at the cost of one auto-managed dev server. The **ratify → lane** helper (apply the
decision diff in a lane clone → `resolve --codified-to` → ready-to-merge PR; mirrors `we:scripts/pr-land.mjs`)
is the landing transport. Spin-off (a) of #2183; siblings #2189 (/workflow PR fan-out), #2190 (per-path
routing), #2188 (/merge↔drain label convergence) delivered the rest.

**Rider — pre-PR independent review at the landing seam (#2170, first layer of the lane review design).**
Before **any** lane opens its self-approved PR (`we:scripts/pr-land.mjs`) — a parallel `/workflow` lane **or**
a solo `#2123` lane — the lane session spawns an **independent subagent review over its diff** (the
/code-review model, given the diff and nothing else, no author framing). Findings are **fixed in the lane,
pre-PR** (the cheapest place — the author context is loaded), and findings the lane **dismisses** are
**recorded in the PR body** (never silently dropped): both the audit trail and a first-class input to the
drain's escalation rubric (#2171). Mechanized by [`we:scripts/lane-review.mjs`](../../scripts/lane-review.mjs)
(`diff` = the exact `base…HEAD` diff to hand the reviewer; `body` = render dismissals → the PR-body block)
feeding `pr-land --body-file`; the two mechanical halves live there so the seam is identical everywhere,
while the judgement half (spawn reviewer, accept-vs-dismiss, fix hot) stays the session's. The rationale: a
fresh subagent has the same independent-eyes property as a separate review session for *finding* issues; the
residual gap (the author judging its own findings) is covered by recording dismissals + the #2171
escalation/sampling layer. Wired at the workflow-lane seam (`laneItemPrompt` step 3a, dismissals →
`dismissedFindings`) and the solo-lane landing seam alike. The `{findings, verdict}` shape any of these
reviewers renders — and the accept/changes/needs-human derivation from a findings list — is the ONE canonical
contract in [`we:scripts/lib/review-core.mjs`](../../scripts/lib/review-core.mjs) (#2325): `/code-review` is
Claude Code's own built-in surface (no source in this repo, so it can't import the module directly), but every
reviewer this repo spawns or scripts renders into that same shape rather than a hand-rolled per-caller copy.
The drain auto-review re-point + the new `/review` human-verdict skill (#2326) consume it directly.

**Rider — deferred merge queue: producers stop at lane-push, a human-drained unified command lands (#2138, ratified 2026-07-02).** The "auto-merge on gate-green" landing above binds the merge **authority** (the gate is the sole landing decision — no per-item human review, no hand-resolved merge) and its green **precondition** — **not the trigger *instant*.** Drain *cadence* (inline / deferred-batch / later-scheduled) is a separate dimension the #1996 clause never addressed; **default deferred-batch**: every lane-producing session — parallel `/workflow` and solo #2123 lanes alike — stops at "lane pushed + marked ready-to-merge" and **never touches `main`**, and a **human-launched unified drain** lands the accumulated queue serially under the existing integrator contract (full gate on the merged tree per merge, impl-first/WE-last, rebase-and-retry). This removes the two-concurrent-run race on the shared primary checkout and decouples a session's end from the 20–70-min integration. A future reader citing the "auto-merge **on gate-green**" bullet must read it as authority + precondition, **not** a timing binding. Sub-mechanics: **(Fork 2)** each item's cross-repo shape lives in a standalone `we:.lane-manifest.json` committed in the WE lane commit (a one-sided add that preserves the #1869 conflict-free WE-lane merge; the drain deletes it at landing); **(Fork 4)** "ready-to-merge" is a **local** queued token written at push (`we:claims.json`-adjacent, read offline — preserves Rule #105 "claim ignores git state"), with `lane/*` refs deleted at a **single point** after the whole couple's WE resolve is confirmed reachable on `main` (no `ls-remote` on the ownership hot path, no `status:queued` main-write during the queued window); **(Fork 5)** ready lanes open **self-approved PRs** (0 required reviewers + a required CI check) purely as the review/CI surface, but the **GitHub native merge queue stays OFF** — it is a *branch-level* setting that would grab a couple's WE-half PR out of impl-first/WE-last order and split the gate into two non-identical environments — and the **custom drain owns every merge** in couple-order; pure local `git merge` is the retained fallback. **Fork 3** (merge-risk lock lifetime under deferred landing) is codified as an amendment against [#merge-risk-optimistic-with-targeted-lock](#merge-risk-optimistic-with-targeted-lock). Successor to #2123's carried claim-locus + lane before-state mechanics and owner of the #2138 Fork-5 substrate arm (#2151 CI-on-PR, #2152 branch protection, #2153 PR drain). Report `we:reports/2026-07-02-deferred-merge-queue-substrate.md`.

**Rider — all edits behind ready-to-merge PRs; the drain is fully decoupled (#2183, ratified 2026-07-03).**
Generalizes the deferred-queue rider to its endpoint. **Every** edit path — `/workflow`, `/next`, serial
`/batch`, `/slice`, `/pr` — routes edit work through a lane clone → **ready-to-merge PR**; the producer
**never** integrates inline, **never** commits to `main`, and **never** launches or waits on the drain. A run
completes when every item is an open ready-to-merge PR, and the system is **correct with zero drains running**
— the PRs sit until *some* drain (`/merge`, `/drain`, or CI auto-merge) lands them, after which local `main`
pulls. This gives a **stable live-preview `main`** that changes only on merge (never churned mid-edit — the
core simplification). **Supersedes** #2138's / #2174's default-OFF-until-proven *inline-fallback* stance
(there is no inline integrate to fall back to once edits are PR-only) and **retires the disjoint-partition
producer machinery** (#1933) — with PR-per-item + a serial drain that rebase-retries, git-at-drain-time is the
sole arbiter. The ready-to-merge **signal is a PR label** (F1), so `/merge` and the drain converge on one
label-scoped lander that merges in cross-item `blockedBy` order (#2188). **Decision-authoring** is the one
special case — see the #2187 rider (preview lane; #2123 stays uniform). Delivered by **#2189** (/workflow PR
fan-out, drop partition), **#2190** (per-path routing for `/next` / serial `/batch` / `/slice`), **#2188**
(/merge↔drain label-lander convergence), **#2187** (decision preview lane). Reshapes #104
(commit-on-current-branch → lane-clone-HEAD; `main` advances only via PR merge).

**Rider — the solo frontmatter lifecycle rides the lane→PR; the prepare-window lock re-homes to a
hard-excluding local token (#2219, ratified 2026-07-04).** Residual of #2123: that ruling laned the solo
skills' *work* but left their **frontmatter lifecycle** straddling two trees — `/prepare`'s `claim`/`release`
status splice ran on the **primary** tree via the guard-exempt CLI, while the body + `preparedDate` could only
land via the **lane PR**. **Ruling (Fork 1, direction): every item-file frontmatter transition — `status` *and*
`preparedDate` — is authored in the lane and lands in the one PR; nothing splices to the primary item file.**
The item stays `open` on `main` through the prepare window and flips to `open + preparedDate` (= "✓ ready to
ratify") atomically when the PR lands — the same net-state shape #2138 Fork 4 ratified for the batch
`active→resolved` case, lifted to the solo `open→preparing→open` / `preparedDate` case. **Option (a) — keep a
primary-tree status splice — is REFUTED:** the item-file `status` is git-tracked backlog content, which #2191
rules onto the lane→PR path ("never widens to … backlog edits"); the CLI's `guard-lane` exemption is a property
of the enforcement hook, **not** a licence in the rule, and (a) reintroduces the primary↔`main` divergence
[#primary-read-only-lanes-only](#primary-read-only-lanes-only) forbids. **Ruling (sub-fork, concurrency):**
dropping the `open→preparing` splice removes a **hard selection-exclusion** (`we:scripts/readiness/engine.mjs`
filters selection to `status==='open'`), not a cosmetic board-state — and no existing local signal replaces it
(`claim` *clears* the reservation; a `reserve` hold only *deprioritizes*, TTL 120 min, local-only). So the
guarantee is **re-homed into a strengthened *local* prepare-hold token that HARD-excludes** — the
#2138-Fork-4 queued-token shape (selection skips it + `claim` refuses it, read offline per Rule #105) with a
lease longer than a real prepare, owned by a small **lane-run CLI verb** (`prepare-hold`/`prepare-stamp`/
`prepare-release`). The bare `reserve` soft-hold is the **named fallback / interim** only (its thin-pool,
TTL-expiry, and cross-clone double-prepare gaps are real, not hand-waved). **Downstream (forced):** the
`/prepare`, `/next-backlog-item`, `/resolve` close-out prose is rewritten to the (b) flow — *hard local
prepare-hold → provision/enter lane → author body + research + `status`/`preparedDate` in-lane → land the one
PR → release the hold*; the item-file `status` splice drops. Anchored on **#2123's defer-clause** (which hands
the claim-locus mechanics to this line) + **#2138 Fork 4** (the queued-token precedent); #2191's carve-out is
the general backlog-edit-scope authority. **Build arm:** #2264 (**shipped 2026-07-07**) delivers the token
(`we:scripts/readiness/prepare-hold-state.mjs` — a lease-bearing, offline, self-pruning hold), the three
lane-run verbs (`we:scripts/backlog.mjs` `prepare-hold`/`prepare-stamp`/`prepare-release`), the selection
HARD-exclusion (`we:scripts/check-readiness.mjs` drops a live-held item from every `--select` surface) + the
`claim` refusal, and the guard classification — `prepare-stamp` (the in-lane `status`/`preparedDate` splice)
joins the `we:scripts/guard-bash.mjs` primary-mutation set (blocked from a primary cwd, allowed in a lane —
the actual gate for a CLI splice, since `guard-lane` only sees the Edit/Write tools), while
`prepare-hold`/`prepare-release` write only the local token and stay unguarded. The bare `reserve` (b-plain)
soft-hold is retired as the named interim. Same lifecycle applies, weaker-form, to solo `/next` (`resolve`).
Report `we:reports/2026-07-02-deferred-merge-queue-substrate.md`.

**Rider — self-modifying items never edit the run's own executing tooling in the checkout a live run executes it from (#2077, ratified 2026-07-10).** A `/workflow` run may not apply a self-modifying item's edits — edits whose touch-set includes the run's *own* executing tooling — to a checkout that run is executing that tooling from; the observed wedge (`batch-2026-07-01-1947-2071`, commit `34a26a39`: #2073's lane edited the live orchestrator file mid-run, sandbox-locked, 5/17 landed) is structural, not bad luck. **The invariant:** the run's own executing tooling is never modified in the checkout a live run executes it from — the *edit itself* is ordinary work that lands like any other change and takes effect on the **next** run (the uniform CI prior art: pin the run's definition at run-start, land tool changes for the next run). **Fork 1 (detection) — ruling (a):** the predicate is a declared **`RUN_TOOLING` pathspec** in the canonical, unit-tested partition module ([`we:scripts/readiness/lane-partition.mjs`](../../scripts/readiness/lane-partition.mjs)), inline-mirrored in the workflow sandbox per the #2086 mirror pattern, matched against the **probe's predicted touch-set** at Phase 1 **after probes, before the Phase-2 pre-claim** (nothing claimed/pushed when a flagged item is turned away). Scope = the full run-tooling surface: the `.claude/skills/batch-backlog-items/` skill dir (the executing script) **plus** the scripts the run shells out to mid-run (`we:scripts/backlog.mjs`, `we:scripts/lane-pool.mjs`, `we:scripts/readiness/*`, `we:scripts/push-if-green.mjs`, `we:scripts/backlog-renumber-collisions.mjs`, `we:scripts/dev/render-check.mjs` + `we:scripts/lib/render-check.mjs`) — **not** the batch state files (already governed: lanes never touch `we:claims.json`) and **not** build config (#2149's separate merge-risk axis). Three detection seats + a drift test: (i) the probe-time match is the authoritative front door; (ii) a **post-hoc** check over each lane's reported `changedFiles` at integrate time catches a probe-under-reported self-modifier (carry the refs, don't merge in-run); (iii) the serial-lane agent prompt gains a hard *stop-revert-report-`dropped`* instruction closing the `mustSerialize` probe-less residual; and (iv) a **coverage-parity unit test** derives the run's shell-out set from the workflow source and asserts `RUN_TOOLING` covers it — fails-open-at-runtime → fails-closed-at-test-time, with the declared list staying authoritative (#2074). **Amendment folded at ratification:** the coverage-parity test must walk **transitive** shell-outs (a script invoked by another `RUN_TOOLING` script, not only those named directly in the workflow source), else the drift gap it closes re-opens. **Rejected:** a frontmatter `selfModifying` flag (**fails open** on omission — the unflagged orchestrator-feature item is exactly the failure case); a loader/engine `batchable:false` (**over-excludes** — blocks safe serial `/batch`, where no run executes the file). **Fork 2 (routing) — ruling:** **today (a)** the probe-time drop reports the item `dropped: "self-modifying"` pre-claim; it is then worked **solo or as the LAST item of a serial `/batch`** (a mid-batch edit to a shelled script changes what later items' seams execute — same mixed-version hazard, minus the sandbox lock), costing only scheduling. **Steady state (c)** — an *entailment of the #2138 deferred-queue rider above*, cited not re-ruled: once the drain substrate holds, a producing session never touches `main`, the clone edit never touches the executing file, and the drain lands it for the next run — no special routing needed. **Sunset (a)→(c) is capability-keyed**, not dated: the #2153 PR drain is live **and** the in-run integrator + serial lane are retired onto the queue (#2153 currently `blockedBy: 2160`, so not imminent). **Rejected (b):** the in-run serial lane — the observed wedge; unfixable by ordering (later phases still shell out to the just-edited tooling). **Drain-era residual (recorded for the #2153 build):** the drain is itself a live run that shells out to `RUN_TOOLING` (`we:scripts/push-if-green.mjs`, `we:scripts/readiness/*`), so within a drain pass `RUN_TOOLING`-touching queued items land **last** (or a dedicated final pass) and the drain invokes no `RUN_TOOLING` script after landing one; likewise an interim serial/solo re-route must not land a `RUN_TOOLING` change into the primary while a `/workflow` run is live (the sandbox lock makes that fail loud). Composes with [#merge-risk-optimistic-with-targeted-lock](#merge-risk-optimistic-with-targeted-lock) (different failure class — mid-run self-modification, not clean-but-wrong merges — disambiguated in the `RUN_TOOLING` code comment). Related but orthogonal to epic #2289 (NNN id allocation). Build arm: successor item filed at ratification. Research topic `self-modifying-run-tooling-exclusion`; report [`we:reports/2026-07-02-self-modifying-run-tooling-exclusion.md`](../../reports/2026-07-02-self-modifying-run-tooling-exclusion.md).

---

### A long-lived divergent branch is a declared "POC branch" delivery mode — landing inside it skips review; the full review runs once, at graduation {#poc-branch-declared-delivery-mode}

**Ratified 2026-09-12 (operator, in conversation; #3637, amending epic #3383's own doctrine rule 10).** A
long-lived divergent branch is a **DECLARED delivery mode** — a **"POC branch"** — not temporary scaffolding
that must be wound down. What is forbidden is an **UNDECLARED, unreconciled** one. The operator's own words,
verbatim: *"I do want N POC as new feature. then goal is to be able to delivery quickly into a POC, so we must
not be slow by the same slow PR process, otherwise there is not benefit. real review will happen when the POC
graduate."* Four clauses:

1. **N POC branches may stand concurrently.** Each is a first-class delivery target an item declares
   (`deliveryTarget: <branch>`), validated against a registry at filing time; each graduates to `main` on its
   own timeline. This is a **durable, cross-cutting rule**, not a one-epic quirk scoped to `#3383` — any
   epic/session may declare and use a POC branch as a delivery mode.
2. **Landing INSIDE a POC branch skips the review gate entirely.** The item's own tests/build validation
   (`we:scripts/operations/run.mjs verify` / `we:scripts/verify-lane.mjs`) is the **only** gate — no judge
   panel, no escalation label, no per-landing review pass of any shape, not even a cheap direct-diff
   `converge` pass. A landing tax of any shape, however small, is exactly the latency the operator ruled out.
3. **The full review process runs once, undiluted, at graduation.** Moving a POC branch's content to `main`
   goes through the FULL existing process, unchanged — a real PR to `main`,
   [#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism)'s gate, the jury/judge panel, and `review:human`
   where the diff touches gate machinery or the statute file. Nothing about landing INSIDE a POC branch
   touches graduation.
4. **What the original (narrower) framing got right, and still holds:** (a) the runner's own steady state is
   still tracking `main` — a POC branch is a delivery TARGET for items that declare it, never the default
   tracking ref (amended 2026-09-23 by [#resident-daemon-reload-lifecycle](#resident-daemon-reload-lifecycle),
   #3681, operator: *"3681 ratified"* … *"once we have merge into main, we will still want to be able to run
   fixes of a darmon live and switch back to main once it merges"* … *"ratified"*: a **resident daemon clone**
   may additionally run **live overlays** — an explicit per-clone list of fix branches merged onto `main` at
   each rebuild, each dropped automatically once `main` has it — under that anchor's clause 5; a daemon still
   never tracks a POC branch as its steady state, and the drain and `merge-orphan-sweep` stay `main`-only);
   (b) build no more machinery than the POC in front of you actually needs; (c) every POC
   branch must NAME what it is for and who graduates it — a registry entry: branch, graduation target, scope,
   graduation item — an **unnamed** divergent branch is still exactly the failure mode that cost a ~40-minute
   manual reconciliation and 15 hand-resolved conflicts when `origin/lane/mechanical-dispatcher` drifted 97
   commits behind `main` behind a silently-failing auto-sync loop; (d) drift is still actively reconciled per
   branch, never tolerated (`we:scripts/conveyor/branch-drift.mjs`) — a drifted branch still holds its own
   items, **except its graduation slices to the target** (amended 2026-09-21 by
   [#poc-branch-mechanical-sync](#poc-branch-mechanical-sync), #3804).
5. **A POC branch is not a pull-request target, so it gets no CI of its own and the drain never lands a
   pull request against one (#3805, ratified 2026-09-21).** Work lands inside a POC branch by direct push or
   `we:scripts/operations/poc-land.mjs`, gated by the item's own tests (clause 2); CI runs where it is
   load-bearing, at the graduation pull request to `main` (clause 3). So neither the workflows' `pull_request`
   filters nor the drain's `requiredCheck = 'test'` contract
   ([#repo-drain-check-contract](#repo-drain-check-contract)) is widened for a POC base. Instead the drain
   **holds, with a named reason,** any pull request whose base is not the repo's default branch
   (`base is not <default> (<base>)`), rather than waiting forever on a check that cannot run. A human who
   opened one on purpose merges it by hand or re-targets it; the drain never closes it.

**What this amendment DELETES from the prior rule.** The claim that a divergent branch is inherently "a
temporary build tool, not the default steady state" that must be wound down, and the assumption that there is
only ever one such branch at a time.

**Lineage:** #3637 (ratified 2026-09-12, operator, in conversation; `bornAs: x7ppgg6`), amending epic
`#3383`'s own operating doctrine rule 10 — the before/after and full design (transport, completion signal,
registry shape) sit on `#3637` itself and in `we:skills-src/mechanical-delivery-doctrine/SKILL.md` (rule 10),
which carries the epic-scoped operational detail and cites this anchor as the canonical statute. Clause 5:
`#3805` (ratified 2026-09-21, operator: Fork 1 (c) neither CI nor a relaxed drain, Fork 2 (a) hold with a named
reason; supersedes `#3653`, resolves `#3674` through its Fork 2 build). Composes
with [#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism) (the mechanism this rule exempts a POC landing
from, and the one graduation still uses undiluted) and
[#deterministic-core-thin-judgment](#deterministic-core-thin-judgment) (tests/build validation is the
deterministic gate that survives; judgment is deferred, not skipped).

---

### A POC branch is kept current with `main` mechanically — prompt merges, a reconcile agent on a staging ref, an ops-branch alert, and slices graduate any time {#poc-branch-mechanical-sync}

**Ratified 2026-09-21 (operator, in conversation; #3804).** Composes with
[#poc-branch-declared-delivery-mode](#poc-branch-declared-delivery-mode) and amends its clause 4(d). The
operator's merge-shape ruling (#3772) stands: `main` is merged into the POC branch by a MERGE COMMIT, never a
rebase and never a force-push of the shared branch; a clean merge is pushed fast-forward-only; a conflict
freezes the sync merge. Who resolves the conflict and when the operator is alerted are points 2 and 3. Four
points, ruled here:

1. **Lag.** Whenever `main` has commits the branch lacks, the next sync pass merges them. The 40-commit
   ceiling (`DEFAULT_MAX_BEHIND`) stays only as a backstop for the `branch-drift-blocked` hold; it is never
   the trigger. A clean sync merge is pushed with no test gate, by design; the cover is a `check:standards`
   run on each push to the branch (#3768 design point 6). What triggers a pass (the runner tick, for example) is a
   build choice.
2. **Conflicts.** A dispatched reconcile agent resolves on a throw-away **staging ref**
   (`lane/mechanical-dispatcher-catchup` for the prototype) by merge commits only, never touching the shared
   branch. The sync pass, not a person, then promotes it by a plain fast-forward push, only when the push is
   a true fast-forward AND the branch's own tests are green at that exact commit as the pass itself sees
   them (never the agent's report), under the same per-branch lock and `autoSync` gate as the clean-merge
   push. At most one attempt is in flight, and the cap is one attempt per set of conflicting files
   (`git merge-tree --name-only`), each attempt pinned to one (branch tip, main tip) pair. When a condition
   is not met, nothing is pushed, and in the #3804 ruling's words: "If the shared branch moved meanwhile, the
   newer commits are merged into the staging ref and the tests run again; a conflict there is a new conflict.
   A red result, or an agent that gave up, raises the alert (Fork 3) and nothing is pushed. The one-attempt
   cap per conflicting file set means a red result is not retried on its own; the alert goes to the
   operator, who decides the next step. If `main` moved while the agent worked, the promotion still goes
   ahead and the next pass takes the new `main` commits as an ordinary merge. A held lock or a switched-off
   `autoSync` makes the pass skip and try again on the next tick." Only those two states alert (point 3); a
   held lock, `autoSync` off, or a moved branch does not. Only the sync merge freezes; direct pushes to the branch
   continue and the existing `branch-drift-blocked` hold on overlapping queued cards is unchanged. A
   resolution the agent cannot make on merit, including one that changes a test's assertions, comes back as a
   decision card. This amends #3556 (merge only; staging ref only; promotion by the pass). Two open
   decisions may add to this point, and do not change it until ruled: what the pass checks about test and
   gate files before it promotes (`3841`), and how the agent is kept from pushing to the shared branch
   (`3847`).
3. **Alert.** The operator is alerted only when they must act (the agent's one attempt failed, or the tests
   on the resolved staging ref are red). Nothing is raised while the agent works. It is a line in the every-turn turn digest plus a row in the wip
   report, and it fails visible: an unreadable record is "status unknown", never "all clear". The record is
   one small file per branch on an `ops/` branch on origin, committed on a state change only. The exact
   wording is the spec under #3804 Fork 3. The build is `blockedBy` #3726; the desktop notice stays until
   then.
4. **Graduation.** A slice may graduate to `main` at any time, whatever the sync state, through the normal
   lane and pull-request path (clause 3 of the delivery-mode statute is unchanged: the full review runs
   there). **Graduation slices are exempt from the `branch-drift-blocked` hold** (the clause 4(d)
   amendment). A ported file is applied as a diff onto `main`'s current file and never copied when `main`
   has moved it since the merge base; a ported file in the open conflict set takes the staging ref's
   resolution when one exists, else the port's version is recorded as the resolution the reconcile agent
   must adopt. This overrides rule 1 of epic #3383's Priority order ("nothing may graduate before the health
   chain") for slices; each slice's PR runs `check:standards`, `test` and `smoke` on `main`'s tree instead.

**Lineage:** #3804 (ratified 2026-09-21, operator, in conversation; `bornAs: 3804`), the four points left
open by #3772. Amends #3556's brief and clause 4(d) above.

---

### PR ci-lifecycle state is a total, deterministic label function — no state read from a label's absence {#ci-lifecycle-total-label-function}

**Ratified 2026-07-10 (#2281).** The **directive** (a 2026-07-04 user call, settled statute): a PR's lifecycle status is always reflected by a **deterministically-applied label**, never inferred from the *absence* of one. Today three ci-lifecycle states break this — a `--no-wait` open PR is left **unlabelled** (`we:scripts/pr-land.mjs:577-579`), a red required check is left **unlabelled** (`we:scripts/pr-land.mjs:603`), and **blocked-ness carries no label at all** (it lives only in the uncommitted `we:.lane-manifest.json`, re-derived per drain pass at `we:scripts/merge-ai-prs.mjs:756-758`). **Scope:** this governs the **ci-lifecycle dimension** (checks / blocked) — a *different axis* from the `ready-to-merge` **landing-gate**, whose absence-semantics (#2183 F1 "the signal is a PR label"; #2138 F4 "a local queued token") are **preserved, not overridden**; the two compose. **Fork 1 (granularity) — ratified (b) total coverage:** every ci-lifecycle state carries a deterministic label — `checking` (in-flight) / `ci:failed` (red) / `blocked` (manifest `blockedBy` open) / `ready-to-merge` (green) — and **exactly one** is present on every open AI PR. The labels are set by **generalizing the existing CI-truth reconcile pass** (`reconcileGreenLabels`, `we:scripts/merge-ai-prs.mjs:702-718`, already run every drain pass + `--watch` interval) from green-only to *all* lifecycle labels — a self-healing sweep, **not** a per-check-tick write path in `pr-land`. The lighter **(a) terminal-only** (leave "checks-in-flight" bare) was the directive-author's available *relaxation* but was **declined**: it reads one state from absence (the directive's exact prohibition), and it fails its own "bare ⟺ in-flight" totality claim anyway — a check going red *after* `pr-land` exits strands a **bare terminal** PR, and the fix for that is the very reconcile-pass generalization (b) needs, so (a)'s only advantage (less label churn) collapses. **Fork 2 (names) — ratified `ci:failed` + bare `blocked`:** `ci:failed` names the *deterministic* red-check fact and opens a `ci:*` state family (`checking` may namespace as `ci:running`); `blocked` stays **bare** to match its true lifecycle sibling, the also-bare `ready-to-merge` landing-gate label (the lifecycle family's precedent is *no* namespace, not `review:*`'s). Rejected: `needs-fix` (reads as human judgment, not "`test` is red") and `blocked:deps` (YAGNI — the manifest `blockedBy` is the only block source that exists). **Composition (codified, not re-decided):** lifecycle labels are **mutually exclusive among themselves** and **orthogonal to `review:*`** (a PR can be `blocked` + `review:pending`) — already how the code composes `ready-to-merge` + `review:*` (`we:scripts/pr-land.mjs:625-630`). **Build arm (successor, agent-ready — #2421):** generalize the reconcile transition table to `lifecycleLabelFromCiTruth` + mint the new labels idempotently in the existing `gh label create` loop (`we:scripts/merge-ai-prs.mjs:870-881`) + extend the transition-table tests (`we:scripts/__tests__/pr-land.test.mjs`, `we:scripts/__tests__/merge-ai-prs.test.mjs`). Relates #2199 (the on-green `ready-to-merge` precedent this generalizes), #2216 (the reconcile pass that makes (b) cheap and (a) unsound), #2262 (the `review:*` mint step the new labels join), #2183 F1 / #2138 F4 (the landing-gate absence-semantics preserved).

---

### Agent fix/convergence: peer-agreement is not validation — independence rests on a distinct fresh validator, and the deterministic land-gate must be gaming-proofed {#agent-convergence-independent-validation}

**Ratified 2026-07-10 (#2398, graduated to epic #2410, successor to #2285). Clause 2 amended 2026-08-27 by the
operator (Nicolas Gilbert) — #3354, the model-consumer sentence.** When the drain converges an agent-authored fix
in-process (the editor↔reviewer negotiation loop shipped by #2311/#2310, wired live by #2326), the loop is one
**convergence bar**, not two paths: it lands only when *all* hold — **approach agreed · an independent validator
accepts · `check:standards` green · required `test` (CI) green · no test-tampering.** "CI green" is the
deterministic clause of that bar, not a separate feature; a red required `test` is just one open issue the loop
must fix before it may declare agreement (retiring the separate `lane-resume` `test-red` strand).

Two invariants govern *how* it converges (option **B** over "fresh reviewer every round"; both preserve the
core invariant — **a landed PR is accepted by an agent that did not author the fix**):

1. **Peer-agreement ≠ validation.** Two agents co-negotiating a fix share priors; their mutual agreement is
   consensus, not independent review. The non-author invariant therefore rests **entirely on a distinct fresh
   validator** — adversarial ("find the reason to reject") persona, rubric-anchored verdict, fresh context, given
   *diff + tests + rubric only* (never the peers' self-assessment — sycophancy → it ratifies). The stronger form
   is a small **diverse panel/jury** (different model/provider) to dilute self-preference/position/verbosity bias.
2. **A deterministic gate must be protected from the agents trying to pass it.** "CI green" is directly gameable
   (documented reward-hacking: agents weaken/delete tests or special-case outputs). The gate is only sound with
   **anti-test-gaming guards** — test files read-only to the author peers (or diff-gate any test change), fail the
   land if coverage drops or tests are removed/skipped, require a test that fails on pre-change behavior for logic
   fixes, and have the validator inspect for test tampering.
   Where the code under review **acts on a value that came from a model**, the same requirement binds on the
   consumer's **existence**, not only on a fix: such a module carries a standing adversarial fixture set, and a
   fixture counts only if a named line of guard code, removed, makes it fail. Structural validity is not the
   untrusted part — meaning is; schema validation and constrained decoding do not discharge this.

Applies to any AI-review/convergence surface in the constellation, not just the drain. Non-convergence (round cap)
or `needs-human` escalates to `review:human`, unchanged. Ship unattended auto-fix behind an off-by-default flag,
scoped to small/non-security diffs first, graduating per-repo on a clean track record (staged autonomy). Grounded
by `we:reports/2026-07-10-ai-code-review-best-practices.md`; the build lands under epic #2410 (successor to #2285).

---

### A reviewer may answer "unverifiable as submitted" for a load-bearing claim the creator left unproven — a gated disposition that earns a round and is counted apart from a blocker {#creator-owed-proof-not-reviewer-rederivation}

**Ratified 2026-09-21 by the operator (Nicolas Gilbert) (#3375, under [#3318](/backlog/3318/)).** Sibling of
[`#agent-convergence-independent-validation`](#agent-convergence-independent-validation), which guards the CI
gate against test-gaming; this rule governs a different subject — what a reviewer may demand *before* it
re-derives a claim about the creator's own code. Composes with
[`#claim-accuracy-advisory-blocks-on-impact`](#claim-accuracy-advisory-blocks-on-impact) (a typed `impactIfUnfixed`,
never a bare assertion, is what makes a finding load-bearing). Grounded by
[/research/creator-owed-proof-not-reviewer-rederivation/](/research/creator-owed-proof-not-reviewer-rederivation/).

**The burden of proof for a claim about code sits with whoever wrote the code.** A reviewer cannot answer
"is this a blocker?" about a claim it cannot verify at all; asking it to guess is the failure. So the review
vocabulary carries a fourth per-finding disposition — **unverifiable as submitted** — distinct from
accept/changes, alongside `blocker`/`carve-out`/`nit`.

1. **It is a per-finding disposition, gated in front of the existing routing.** A precondition question ("can
   this be verified as submitted?") is asked *before* the three direction questions (introduced / worse than base
   / parallelizable), which presuppose the reviewer already knows the claim is real. `unverifiable` short-circuits
   them; anything else falls through to the existing routing unchanged. There is **no new panel-level verdict**: the
   disposition composes with the verdict reduction as it stands, and the render layer surfaces the distinction in
   prose from the findings list.
2. **The gate is conjunctive — all three, or it is not a refusal.** (a) **Load-bearing**: the finding's typed
   `impactIfUnfixed` is at or above a named bar for this gate (a constant *distinct* from the prevention bar, so
   the two can diverge); a cosmetic or degraded claim stays plain advisory assertion. (b) **Cost-asymmetric**:
   re-deriving the claim would cost the reviewer materially more than the creator including the proof would have
   cost — a judgment answer, not a numeric threshold. (c) **Attempted and stated**: the reviewer names what it
   tried and why that was not enough. A refusal missing (c) is incomplete, reads as undecided, and fails closed as
   an ordinary blocking finding, so silence costs a round rather than saving one. Cost-asymmetry alone is rejected
   as the test (it has no floor: "I would have to read three files" clears it), and so is a category allowlist
   (a maintenance surface that duplicates the narrower mechanism-claim and completeness-claim rules).
3. **The refusal is friction, not enforcement, and says so.** All three legs are self-declared; a pure function
   can check that an attempt was *stated*, never that it was *reasonable*. This matches every other
   self-declared judgment field in the review vocabulary: fail closed on absence, never machine-verify honesty.
   The backstop is architectural: a refusal earns a round, so a gamed one does not ship silently, and a reviewer
   that over-refuses is itself a recurring pattern the harvest pipeline can surface.
4. **It earns a round like a blocker, and is counted separately.** A load-bearing, unproven claim must not land
   silently, so an outstanding `unverifiable` finding earns a round. It is never folded into the `blocker` count:
   "a reviewer found a bug" and "a creator skipped proof" have different root causes and different fixes, and
   the review-efficacy metrics are per finding category.
5. **A demonstrated red-before/green-after test outranks a citation as creator-proof evidence.** The evidence
   ladder gains one top rung above a quoted citation, fed as **caller-supplied ground truth** (a mutation-check
   `killed` outcome), never a juror's own word. The ladder's existing cap was a *reviewer-budget* constraint that
   does not bind a creator. The rung extends the **shared** evidence enum, never a parallel boolean field: one
   ladder, one floor mechanism, one totality assertion.
6. **Its durable signal reuses two existing pipelines, with no new mechanism.** Every finding's disposition is
   already recorded in the jury ledger. A recurring *gate-shaped* pattern is mined by the review-corpus pipeline;
   a recurring *convention-shaped* gap routes through the learnings pool as an existing `kind` with an `area`
   naming the creator-facing artifact. No new pool `kind` and no new schema field.

Scope: agent-machinery governance for this repo's own review surfaces. No consumer-visible contract, so hard
rule 6 (WE holds zero implementation) does not apply.

---

### Blast-radius is advisory care-level, not a park-gate; the trust-chain gate fires on a *spec* change, not any path touch; the high-blast backstop is a diversity-selection AI panel + an active point-level human check {#blast-radius-advisory-care-not-a-gate}

**Ratified 2026-07-18 (#2563).** Composes with — does not alter — [`#agent-convergence-independent-validation`](#agent-convergence-independent-validation): a *care* signal routes **into** that convergence bar; this rule governs *which* signals gate a human vs run advisorily, and *how* the human check is delivered. Cite both together.

1. **Scored signals are advisory, not a gate.** Blast-radius, size, dismissed-findings, cross-repo, and 1-in-N sampling **annotate a care-level** that raises the convergence loop's scrutiny; they do **not** block the land on a review verdict. Gating a computed *risk score* is a documented anti-pattern (advisory dominates: CODEOWNERS/SonarQube gate *ownership*, not scores); the review still happens (via the loop), just not a human park. A repo may *tighten* a scored signal to a gate as config — where **`gate` means route-to-a-human, never hard-block-with-no-reviewer**.

2. **The trust-chain / statute gate fires on a *spec* change, not any path touch (Fork 1).** `gate-self`/`statute` stay human-gated, but narrowed from "any edit to a trust-chain path" to "a change to the trust-chain **spec**" — a **schema / executable contract, not prose** (only contract-as-spec makes "did the spec change?" a deterministic yes/no; prose forces interpretation, and no tool auto-detects prose drift). An implementation change under a *fixed* spec is agent-clearable on **conformance-green + independent review**; a diff touching the contract file itself is always human; ambiguous → human. Size is not the metric (a 1-char threshold flip is a spec change; a 200-line behaviour-preserving refactor is impl). First instance of the spec-based-programming direction (#2564).

3. **The high-blast backstop is a diversity-selection AI panel + an *active* point-level human check (Fork 2).** Humans review large changes *worse* (Cisco/SmartBear); a diverse AI panel does **not** decorrelate (LLMs share failure modes — the LLM analogue of Knight & Leveson 1986); a *passive* human monitor catches *fewer* defects than an unaided one (automation bias). So: high-blast auto-lands run a diverse panel **aggregated by diversity-selection, not majority vote**, plus a human check delivered **point-level** through the codified ruling console — a specific line/point, plain-language + example, **ratify / fork / challenge** — never a blanket "escalate the whole PR." An **always-review file blacklist** and **full-diff on demand** sit alongside. A **non-zero decorrelated human axis** must exist (the panel can't cover blind spots it shares): the operator's direct oversight satisfies it at current scale, and an automated **post-land audit sample** of AI-*cleared* content is a config option, enabled when throughput outgrows manual watch.

**Invariants preserved:** the conflict-of-interest / non-author rule (#2439); non-convergence hard-escalates to `review:human`; one shared review core (`we:scripts/lib/review-core.mjs`). Applies to any AI-review/convergence surface in the constellation. Grounded by `we:reports/2026-07-18-blast-radius-advisory-review-gating.md`, `we:reports/2026-07-18-spec-based-programming-deep-research.md`, `we:reports/2026-07-18-human-vs-ai-review-cognitive-science.md`. The point-level ruling surface is the **same** build as the decision-ruling console (#2494/#2555), not a duplicate.

---

### Build-lane self-review carries a non-zero floor; care scales its depth, never its existence {#build-lane-self-review-non-zero-floor}

**Ratified 2026-08-01 by the operator (Nicolas Gilbert) (the build-lane self-review-scope decision — under [#2804], carved from [#2819]).** Composes with — does not alter — [`#blast-radius-advisory-care-not-a-gate`](#blast-radius-advisory-care-not-a-gate) (#2563, which governs the *independent* Layer-2 review's advisory care) and [`#agent-convergence-independent-validation`](#agent-convergence-independent-validation) (#2398, that a builder may not *clear* its own diff). Three turfs, one anti-drift rule: the care *band* stays single-sourced in `deriveCareLevel`; this anchor adds only a floored depth table for the Layer-1 author-run pass.

1. **Every delegated build carries a non-zero self-review floor.** No build reaches the PR having run zero adversarial self-review — even a `none`-care leaf edit gets one fast pass. "Floor > 0" is the platform default, not one value of a preference. It closes the under-specified-brief failure class (a leaf edit whose hidden edge slipped because nothing looked adversarially before the PR).
2. **The floor is a non-clearing FIX pass, not a clearance.** It converges nits pre-PR while the lane is warm and hands a cleaner diff to the independent Layer-2 clear (unchanged, per #2398). It never claims to be the safety net.
3. **The visual self-review floor is locus-gated, not care-gated.** It fires for UI-locus items regardless of care band (a small UI diff can still be visually wrong — the console-board failure class, #2804). Care scales its *depth*, never gates its *existence*.
4. **Depth above the floor is a config dimension, not a fork.** How many extra adversarial rounds/lenses a build earns as care rises is tunable; default = a light floor at `none`/`low`, deepening at `elevated`/`high` (reuses the shape of the [#2567] care model, not its table). A conservative repo raises the floor or the per-band depth.

**Invariants preserved:** layer separation (self-review = Layer 1 author-run #2672; independent clear = Layer 2 #2398/#2567); one shared care model (`deriveCareLevel`), only the depth *table* differs by layer. Grounded by `we:reports/2026-08-01-risk-based-care-scaled-review-gating.md`. Governs Layer 1 only; the Layer-2 panel's `none→0` mapping stays a separate concern under #2567 — **since
settled**, by [`#every-pr-gets-a-look-advisory-floor`](#every-pr-gets-a-look-advisory-floor) (#3313, ratified
2026-08-26), which extends this anchor's *care scales depth, never existence* rule to Layer 2: the floor there
is a cheap advisory pass over every PR, non-blocking, never a random sample of a few.

**Lineage:** 2828 (ratified 2026-08-01 — the build-lane self-review-scope decision, under epic #2804, carved from #2819; report `we:reports/2026-08-01-risk-based-care-scaled-review-gating.md`).

---

### Behaviour/event attribute *names* are colon-namespaced — a collision-safe internal authoring spelling, not the platform-shaped standard proposal {#attribute-name-colon-namespacing}

Decided **per surface** (separators track what each namespace permits, not uniformity — [registry-name-guard](#registry-name-guard-namespace) `:672`). **(Fork 1)** Behaviour/event attribute **names** stay **colon-namespaced** *when they belong to a family* (`view:*`, `on:*`, `nav:*`, `droplist:*`, `route:*`, `grid:*`) — collision-safe by construction (a native HTML attribute name never contains a colon). **A *family-less* behaviour keeps the simplest possible name — a bare single hyphen (`type-ahead`, `focus-delegation`) — and takes no colon** (amended by #1991, 2026-07-01): native HTML separates multi-word attribute names by **smashing, not hyphenating** (`shadowrootmode`, `contenteditable`, `crossorigin`), and bare hyphenated native attrs are two legacy cases (`accept-charset`, `http-equiv`) plus the `data-*`/`aria-*` prefix families — so a bare single-hyphen author attr is not at meaningful native-collision risk, and a colon on a *singleton* buys neither sibling-disambiguation nor readability. The colon is reserved for where it pays off: a **family** = a surface/domain with ≥2 related members (or an established control-flow/event group). A family-less name that later gains a sibling colon-ifies then (a one-time mechanical rename). The load-bearing **framing**: colon is WE's *current collision-safe **internal authoring** spelling* for namespaced directives, **not** WE's claimed *platform-shaped standard proposal*. A colon on an HTML attribute spec-*connotes* an XML namespace (`xml:lang`); WE's `:` is the ownership-colon idiom (`:672` + #1913), **not** an XML-namespace declaration. The closest *proposed* author-attribute standard is **hyphen** (`enh-*`, WICG#1029/whatwg#2271); WE **declines to chase it while unshipped** (don't-chase-a-draft), and the separator is intended to be **app-configurable** (the reconciliation bridge to the eventual ratified spelling — mechanism deferred to #1992). If a hyphen form is ever adopted it is **`enh-*`**, **never `we-*`** (a pure vendor prefix contradicts proposing-in-platform-shape). **(Fork 2)** Third-party `<template type=…>` **values** are **`owner-kind` hyphen** (`type="acme-card"`; bare `type="if"` reserved for **core**) — native `type` values are never colon-namespaced, hyphen matches the custom-element idiom and keeps RFC 6648 ownership-not-status without reopening #1983's no-native-analog defect. **Settled by precedent (not forks):** native-aligned attrs → **bare** (`multiple`); author data → **`data-*`**; comment-directive names → colon `ns:name` (grammar-locked, no native-attribute collision risk). Detail codified in `conventions.md#attributes`.

**Lineage:** #1987 (ratified 2026-06-30 — Fork 2 then Fork 1; report `we:reports/2026-06-30-we-naming-convention.md`). Fork 1 skeptic **landed** a propose-in-platform-shape hit, **absorbed by amendment not overturn** (the framing above; `:672` cites `nav:list` not only `xml:lang`; the skeptic itself concluded defer-don't-migrate). Fork 2 skeptic **flipped** the default colon→hyphen. Rests on [registry-name-guard](#registry-name-guard-namespace) (`:672`) + [#1913 ownership-not-status](#custom-intents-namespace-by-ownership) (`:1516`, principle only — its colon is scoped to intent IDs); #1983 carved value-namespacing here (`block-standard.md:382-401`). Triggers conformance cleanup #1991. **#1991 (ratified 2026-07-01) amended Fork 1:** colon is **family-only**; family-less behaviours stay bare single-hyphen — grounded in native's smash-not-hyphenate word-joining, so the singleton colon (`list:type-ahead`) was DevX cost for no collision benefit (`type-ahead` stays `type-ahead`). Sibling marker-grammar question = #1989.

### Subscription-funded headless agent-spawning uses the CLI backend behind a backend-agnostic runner interface, composing with the write-time deny gates {#agent-runner-cli-backend}

The Plateau Loop's supervised builder (#2530) spawns Claude agents as supervised children. Two forced
invariants + three ratified fork calls (#2444, ratified 2026-07-16):

- **Auth/backend (settled by research) — spawn the `claude` CLI on the user's subscription; the Agent SDK is a
  later API-key backend, never the phase-1 path.** `claude setup-token` mints a CLI credential the CLI honors
  on Pro/Max; SDK subscription use is undocumented + terms-restricted, so SDK-on-subscription is *broken*, not
  merely worse.
- **The interface is backend-agnostic** — `spawn/steer/stop/resume/observe` are backend-neutral ops, so an
  SDK/API-key backend slots in later with no UI or orchestration change.
- **(Fork 1) `steer(text)` rules on the delivery GUARANTEE, not the channel: boundary-delivery, queued,
  non-dropping** (impl: a queued `{"type":"user",…}` message on the child's open `--input-format stream-json`
  stdin). Earliest-possible mid-turn delivery (a PreToolUse deny-with-reason) is a deferred enhancement *behind
  the same op*, never the guarantee — it silently misses pure-reasoning stretches and a repeat-deny aborts a
  headless session.
- **(Fork 2) The headless permission model = a static per-task-type `--allowedTools` baseline PLUS the
  constellation's existing non-blocking write-time deny hooks** (`we:scripts/guard-bash.mjs`, lane-guard,
  locus-prefix). A deny *is* a resolution (it reaches the model, which routes around it), so nothing goes
  unresolved and a headless `-p` session cannot abort on a permission — strictly more abort-resistant than a
  bare allowlist. **This COMPOSES WITH the write-time shared gate (#883) — the runner inherits those gates, it
  does not define a rival mid-run policy nor move all gating to launch.** A *human-blocking* per-tool UI
  approval is excluded (a slow/absent click aborts the session).
- **(Fork 3) Stop = graceful-boundary-first, escalate to `SIGTERM` on a timeout; `--resume` continues a clean
  pause, a redirect FRESH-SPAWNS.** Never `--resume` a turn killed for looping (it re-injects the poisoned
  context). Discarding a killed turn is cheap only because edit-work lands in a throwaway lane clone
  ([PR-flow rollout](#pr-flow-rollout-mechanism)), so nothing durable is lost.

**Lineage:** #2444 (ratified 2026-07-16; report `we:reports/2026-07-12-claude-cli-agent-runner-headless-contract.md`;
research `/research/claude-cli-agent-runner-headless-contract/`). Each fork survived an independent skeptic +
a fresh-context two-confusion screen: Fork 1 re-cast channel→guarantee (screen fix); Fork 2's default flipped
bare-allowlist→allowlist+inherited-write-time-gates (skeptic REFUTED the bare allowlist as
under-provision-aborts / over-provision-theater); Fork 3 amended to graceful→SIGTERM + fresh-spawn-on-redirect
+ the lane-clone citation (skeptic). Consumed by the runner interface built in #2530.

---

### Spec-based programming: the spec is a schema-skeleton + a prose layer; human-gates-spec / agent-implements, in a federated constitution→law→impl hierarchy {#spec-is-schema-human-gates-spec}

**Ratified 2026-07-19 (#2564).** The constellation adopts spec-based programming: the human's attention is
spent on the few **spec** artifacts, and an **implementation** under a fixed spec is agent-clearable on
conformance-green + independent review. Load-bearing rules:

- **A spec is a schema *skeleton* + a first-class, permanent *prose* layer, in one artifact.** An empirical
  audit (`we:reports/2026-07-19-schema-prose-expressibility-audit.md`) found pure-schema is ~0% of real specs:
  the machine-checkable part is the axis/enum/shape vocabulary; the contract's meaning (semantics, defaults,
  behavior, a11y, judgment) is prose, inside the same artifact (`we:src/_data/*.json` `summary`/`description`).
  So "schema, not prose" is **reframed** to *schema where faithfully expressible, disciplined prose for the
  rest*. **"Did the spec change?" stays deterministic** — any diff to a contract artifact (prose included)
  trips the path/artifact test → human (composes with [#blast-radius-advisory-care-not-a-gate](#blast-radius-advisory-care-not-a-gate)).
  Prose ambiguity is **mitigable** (controlled vocabulary, glossary-anchored terms, EARS phrasing,
  one-fact-per-statement, a per-statement `[@test]` binding) — a rigor spectrum, not a fatality.
- **Human-gates-spec / agent-implements, in a *federated* three-tier hierarchy: constitution → law/spec →
  implementation.** The **constitution** (core principles — non-author invariant, WE-holds-zero-impl,
  segregation of duties) is **never applied to a diff directly**; only the derived law is. Tiers exist at
  **platform scope (supreme)** and **per-project scope (subordinate — a project constitution derives from and
  may not contradict the platform one)**; the amendment gate and consistency check scale with scope.
- **WE holds the spec + the meta-schema + static conformance; the behavioral conformance suite is Plateau/FUI**
  (composes with [#intent-conformance-is-block-compliance](#intent-conformance-is-block-compliance) and
  [#surface-contract-not-computation](#surface-contract-not-computation)). The prose layer is governed by
  **per-statement check-binding** (attach a machine check to each statement that admits one; hold the rest to
  the rigor discipline) — not an executable-by-default ratchet.
- **The auto-clear path is measured, not trusted.** The independent AI reviewer's false-clear rate is obtained
  by a purpose-built instrument (stratified sample + a **shadow-harness** seeded-defect audit that never enters
  the merge path); a **permanent non-zero human sample** stays as the backstop (the human is the only
  decorrelated axis — [#agent-convergence-independent-validation](#agent-convergence-independent-validation)'s
  staged-autonomy clause governs graduation; not re-declared here).
- **Constitutional amendment is substantively entrenched** — exempt from the ordinary supersede-with-lineage of
  the statute layer (the *Platform Decisions = Statute Layer* rule, #911), plus a cooling period in days and a
  committed external record; a headcount quorum is adopted when the polity grows. **Constitutional-consistency
  of a new spec is human-decided, never machine-decided** (an advisory per-principle critique may assist).

**Lineage:** #2564 (ratified 2026-07-19; first concrete instance #2563 Fork 1). Reports
`we:reports/2026-07-18-spec-based-programming-deep-research.md` + `we:reports/2026-07-19-schema-prose-expressibility-audit.md`;
research `/research/spec-based-programming-constellation/` + `/research/schema-prose-expressibility-audit/`.
Every fork survived an independent skeptic + a fresh-context two-confusion screen; the reframe + Fork-4 flip
came from the expressibility audit during ratification discussion. Composes with (does not re-declare)
[#agent-convergence-independent-validation](#agent-convergence-independent-validation),
[#blast-radius-advisory-care-not-a-gate](#blast-radius-advisory-care-not-a-gate),
[#intent-conformance-is-block-compliance](#intent-conformance-is-block-compliance), and #911.

**Extended 2026-09-21 (operator; #3144)** — the constitutional-amendment gate quantified. Reconciles
#2564 Fork 5's three entrenchment clauses with #2561 F4's rejection of a standalone constitution artifact
(form/membership delegated to #2568) and grounds the gate in the 2026-07-28→08-02 governance cluster —
[#review-human-declarative-leash-only](#review-human-declarative-leash-only),
[#human-is-principle-surface-not-path](#human-is-principle-surface-not-path),
[#principle-and-impl-two-pr](#principle-and-impl-two-pr), and
[#human-required-is-judgment-only](#human-required-is-judgment-only) — none of which #2564, #2561 or #2568
cited. Three clauses:

1. **The conferring surface is a class, not a file: a `POLICY_SPEC` (example) leash member.** The entrenchment
   declaration — the exempt-anchor list, the cooling interval, the record requirement — is DATA on a
   surface registered in the leash roster (`we:scripts/lib/gate-config.mjs`'s `POLICY_SPEC_BASENAMES` /
   `we:scripts/lib/review-policy.contract.json`), human-only and whole-file pinned by
   [#human-is-principle-surface-not-path](#human-is-principle-surface-not-path) trigger 3. The derivation
   code (`we:scripts/lib/review-escalation.mjs`) only *reads* the declaration, as a predicate feeding
   `isPrincipleSurface` — it never defines the exemption, matching its own ratified agent-clearable status
   ([#review-human-declarative-leash-only](#review-human-declarative-leash-only) clause 1). An unregistered
   surface (a new index file, or a statute block that only asserts its own protection) is agent-clearable
   by construction and confers no entrenchment, whatever it claims about itself.
2. **The cooling clock reads the forge-side PR-merge timestamp, never an emitter-written date.** A
   substantive change to the proposed amendment text **cancels** the period — a new record starts a new
   clock, it does not resume. The floor is ruled, not configured: the interval must exceed one continuous
   working stretch. An un-ripe amendment **parks** with its ripe-at date stated, on the existing
   `review:human` hold, never a hard refusal
   ([#blast-radius-advisory-care-not-a-gate](#blast-radius-advisory-care-not-a-gate)'s route-to-a-human
   clause applied). The interval's *value* is a platform-default flavor, not a ratified pick
   ([#config-extends-platform-default](#config-extends-platform-default)): `P10D`, declared alongside the
   clauses above.
3. **A project joins the constitution tier only by platform-scope listing, never by self-declaration.** A
   subordinate project constitution (this anchor's federated tiers, above) enters or leaves the
   constitution tier through the same leash-registered surface as clause 1 — an entry in its `projects`
   map — never through the project's own `we:src/_data/projects/<id>.json`. The map starts empty:
   constitution-tier project scope is defined but unpopulated, and stays that way until a project asserts
   a principle beyond the platform's.

**Lineage:** #3144 (ratified 2026-09-21, operator; reconciles #2564 Fork 5 with #2561 F4 / #2568; report
`we:reports/2026-08-17-constitutional-amendment-gate-quantification.md`; research
`/research/constitutional-amendment-gate-quantification/`). Composes with — does not re-declare —
[#review-human-declarative-leash-only](#review-human-declarative-leash-only),
[#human-is-principle-surface-not-path](#human-is-principle-surface-not-path),
[#principle-and-impl-two-pr](#principle-and-impl-two-pr), and
[#human-required-is-judgment-only](#human-required-is-judgment-only). #2568 owns which leash file and the
anchor list; this clause governs the *class* of surface, not the file choice. Building clause 1 (the leash
declaration) and clause 1's derivation-code read are separate follow-on PRs per
[#principle-and-impl-two-pr](#principle-and-impl-two-pr), carved as their own backlog items rather than
built here.

---

### Deterministic core, thin judgment — delivery-loop machinery scripts every script-decidable decision, single-sourced in we:scripts {#deterministic-core-thin-judgment}

**Ratified 2026-07-22 (#2607).** In delivery-loop machinery (skills, the conveyor, the console), every
**script-decidable** decision lives as a **deterministic, tested script single-sourced in `we:scripts`** —
model judgment is reserved for genuinely judgment-shaped work. Three clauses:

1. **Script-decidable → a deterministic, tested script in `we:scripts`.** If a rule can be computed from
   readable state (queue × scope-leases × free slots → a launch/held dispatch plan, tick state reads, merge
   watchers, idle/stop clocks, health checks), it is a script with unit tests — never a policy the model
   re-derives at run time. The ratified split's judgment side: scope prediction (a probe agent, written to a
   `scope:` frontmatter field), building the item, escalation review, the readiness discussion with the human.
2. **Judgment is reserved for judgment-shaped work.** Spending model context re-deriving a computable plan
   is both a latency source and a drift source (a prose rule re-interpreted per tick gives non-reproducible,
   untestable decisions) — the rejected alternative on #2607.
3. **One source — skills and UIs SHELL the same script.** A skill body never carries a prose copy of a
   scripted rule, and a UI never re-implements it: plateau's dev server shells
   `we:scripts/readiness/scope-lease-collect.mjs` for `/api/scope-lease` (`plateau:vite.config.mts`), and the
   resident drain daemon (#2449) keeps all drain logic in `we:scripts`, scheduling
   `we:scripts/merge-ai-prs.mjs` passes — those precedents are the norm, not exceptions. A second
   implementation of a scripted rule is the dead-end duplication this rule exists to forbid.

This is the delivery-loop application of the hookable-vs-judgment discipline (script-decidable → hook;
judgment stays in context — already applied by [merge-risk](#merge-risk-optimistic-with-targeted-lock)'s
duplicate-key lint), extended from agent-context management to **product/skill design**. The
[throughput program](backlog-workflow.md)'s watch (#2606) reviews adherence: judgment-work in the loop
that has become script-decidable is a conversion item, not a norm.

**Lineage:** #2607 (ratified in-session 2026-07-22, conveyor design; parent program #2606, loop epic
#2527). Composes with [#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism) (landing is fully automatic)
and [#agent-runner-cli-backend](#agent-runner-cli-backend) (the runner interface the loop's judgment agents
ride).

---

### Conveyor per-lane orchestration is mechanics + a headless runner, not a per-lane agent — novelty escalates {#conveyor-orchestration-mechanics-not-per-lane-agent}

**Ratified 2026-07-27 (operator; #2701, bornAs 2701).** The [#deterministic-core-thin-judgment](#deterministic-core-thin-judgment)
split, applied to the conveyor's **own** per-lane orchestration. Driving one lane through its cycle —
dispatch → watch → release → tick, plus the guard bookkeeping — is **pure deterministic mechanics stepped by a
headless runner**, not a per-lane LLM agent that re-derives the loop each tick. Three clauses:

1. **The per-lane driver is a headless runner over the tested tick-core state machine.** The whole per-lane
   cycle is a reproducible state machine (`we:scripts` tick core) with unit tests; a lane is driven by a
   **headless runner** that reads state and steps that machine — **no model context is spent per tick**. This is
   the same "script-decidable → a deterministic tested script" clause of the parent statute, now naming the
   conveyor's per-lane loop as script-decidable in full.
2. **No per-lane conducting agent (Option B rejected).** Giving each lane its own always-on LLM "conductor"
   that re-decides dispatch/watch/release every tick is rejected on the merits: it re-introduces exactly the
   non-reproducible, untestable, latency-and-drift path the parent statute forbids, at N× the cost (one agent
   per lane). Judgment in the loop is reserved for genuinely judgment-shaped work (scope prediction at
   readiness, building the item, escalation review) — not for stepping a mechanical cycle.
3. **A single supervisor is deferred behind a measured trigger (Option C), and genuine novelty escalates.**
   A single cross-lane supervisor agent is **not** built now — it is deferred until a *measured* trigger shows
   the headless runners need cross-lane coordination the mechanics can't express. Until then, a case the
   mechanics genuinely don't cover **escalates to the main-session judgment layer**, exactly as the parent
   statute escalates novelty — the runner never improvises a ruling.

**Lineage:** #2701 (ratified 2026-07-27, operator; bornAs 2701; the DEFER-the-boundary fork de-buried from
central fork #2677). A **child application** of [#deterministic-core-thin-judgment](#deterministic-core-thin-judgment)
(#2607) — it extends that split from delivery-loop machinery in general to the conveyor's per-lane orchestration
in particular; it does **not** re-declare or compete with it. Governs the per-lane orchestrator slice #2702 (now
a headless runner, singleton-locked, no per-lane LLM) and the main-session retirement #2703. Composes with
[#agent-runner-cli-backend](#agent-runner-cli-backend) (the runner interface).

---

### Delivery operations are declared once; every caller is a generated adapter {#operations-declared-once-callers-generated}

**Ratified 2026-08-08 (operator, in session; #3031).** The [#deterministic-core-thin-judgment](#deterministic-core-thin-judgment)
one-source clause, carried one step further: it already forbids a second *implementation*, and this forbids a
second *wiring*. A delivery-loop operation — review a PR, claim an item, ratify a decision, dispatch a lane — is
**declared once** (input schema + ordered steps + guards), and every caller is **generated** from that
declaration. Four clauses:

1. **One declaration, derived callers.** The command-line caller (agents, any clone, no server), the HTTP caller
   (the console), the typed-tool caller, the input validation and the tests all fall out of the declaration. A
   hand-written route or argv parser for an operation that *could* be declared is a defect, not a style choice.
   This closes the gap the parent statute leaves open: today `plateau:tools/dev-panel/vite-plugin.ts` (the
   console's review routes, mounted from `plateau:vite.config.mts`) and `plateau:tools/drain-daemon/cli.mjs` each
   hand-roll their own argv and route glue over the same single-sourced scripts.
2. **Four step kinds, closed.** `compute` (pure fn + declared reads, no model), `judge` (needs a model, needs
   **no** tools), `confirm` (needs a person — the engine **suspends**, resumable from any surface), `effect`
   (declares what should happen; the executor applies it keyed by run + step, so replay is safe). **An operation
   that appears to need a fifth kind is a signal to change the model, not to extend the vocabulary.**
3. **Model work splits on tools, never on surface.** Tool-free judgment (a mandate over a diff) is one turn with
   no tools granted, identical wherever it was started; work needing a tree is an agent session per
   [#agent-runner-cli-backend](#agent-runner-cli-backend). **The in-session reviewer is retired** — it inherits
   the host session's instructions, memory and cwd, so the same operation behaves differently depending on who
   started it, which is precisely what one-source exists to prevent. Granting a judge step **no** tools also turns
   the review mandate's *never check the branch out in a shared tree* rule from prose the model must recall into
   something it cannot do — and, deliberately, goes further: it also forecloses the throwaway clone that mandate
   permits, so a repro that genuinely needs a tree is an agent session, never a judge step.
4. **Two tiers, one seam, nothing metered in tier one.** The solo tier spawns the subscription-funded
   command-line backend on the operator's own machine; the hosted tier is key-billed behind the same seam. These
   are two permanent products for different people — *not* a migration — so the seam is load-bearing from the
   start rather than a deferred escape hatch.

**Consequences worth naming.** The human stop stops being prose in `we:skills-src/review/SKILL.md` and becomes a
suspend the engine performs; idempotent declared effects subsume both the *"a non-zero exit means re-run the same
command"* instruction and the [#2964](/backlog/2964-post-the-review-verdict-comment-before-the-label-swap-the-un/)
write-ordering rule; a run started on one surface can be finished on another, because the run record — not the
caller — holds the state.

**Lineage:** #3031 (ratified in-session 2026-08-08; report
`we:reports/2026-08-08-operation-engine-one-declaration-every-caller.md`; epic #3029 under program #2606).
**Reconciled by citation, not competition:** this *applies* #deterministic-core-thin-judgment to the caller-wiring
turf that statute does not reach, and composes with [#agent-runner-cli-backend](#agent-runner-cli-backend) (the
backend a judge step spawns), [#conveyor-orchestration-mechanics-not-per-lane-agent](#conveyor-orchestration-mechanics-not-per-lane-agent)
(no model in the mechanical loop) and [#state-lives-where-its-nature-dictates](#state-lives-where-its-nature-dictates)
(the run record is a session-local sidecar behind a store module — the store-seam discipline #2626 proposes,
cited as a direction because #2626 is still an **open** decision; this rule rests on rule-105's animating
principle, not on #2626 being ruled). The
rejected branch — agents calling HTTP services — fails on lane clones (N checkouts, N ports, no answer to "which
server acts on which clone") and on the session-free direction of #2701/#2703.

**Extended 2026-09-01 (operator; #3400)** — clause 4's hosted tier gets a named shape, ratified ahead of being
built. Metering, for the `judge` step kind, is not open: real per-run dollar telemetry already ships
(`we:scripts/operations/run-record.mjs`'s `TELEMETRY_NUMBERS`, populated from every juror spawn's own reported
cost). Two forks fill the actual gaps: **(1)** a `dispatch: true` effect's cost — unknown at apply-time because
the spawned work hasn't finished — is captured where it resolves, at `resolveInFlight`, never by a new generic
hook over effect application; **(2)** a caller authenticates via a bearer API key checked at the transport
adapter (`we:scripts/operations/http-adapter.mjs`), resolved to a `callerId`, with `resolveCaller` (proposed) undefined by
default so solo-local's implicit trust is untouched — never OAuth/end-user identity, which presupposes a login
ceremony this caller shape (an account, not a person) doesn't have. Attribution ("whose key, which run") falls
out of composing the two: Fork 2's resolved `callerId` threaded onto Fork 1's existing telemetry. **The shape is
ratified; building it is not** — a **NOT-YET** validation gate stands over all of it except the one slice with
no dependency on either trigger (threading `callerId` onto the already-shipped judge telemetry, buildable
whenever convenient but left unscaffolded pending a real second caller to attribute against). Un-gates on
either: the operational-state store going shared per
[#state-lives-where-its-nature-dictates](#state-lives-where-its-nature-dictates)'s own #2626/#2742 trigger, or a
real second off-machine caller of the HTTP adapter materializing. Full reasoning, skeptic passes and the
prior-art survey: [#3400](/backlog/3400-the-ratified-hosted-key-billed-delivery-mode-has-no-metering/).

**Extended 2026-09-01 (operator; #3427)** — two more clauses, on catalog scope and on call-visibility
telemetry. **(1) Candidacy scope.** The operation catalog stays bounded to delivery-loop operations, growing
organically only through the already-ratified missing-operation mechanism
([#dispatched-agent-never-runs-commands-directly](#dispatched-agent-never-runs-commands-directly), #3421,
#3422) — never "every command in the repo." A raw inspection command (`git status`, `ls`, an ad hoc `grep`) is
not a declaration candidate on its own; it becomes one only when a dispatched agent actually halts on it as a
gap. **(2) Call-visibility telemetry is a separate, purpose-built signal, never a run record.** Every operation
call, regardless of step kind, emits a lightweight, access-log-shaped record — operation name, timestamp,
caller kind, and an `outcome` carrying a compact digest of the result (never bare success/failure) — kept
structurally distinct from the run-record store (`we:scripts/operations/run-record.mjs`/`run-store.mjs`). The
schema is a categorical mismatch, not a cost one: a `compute`-only call never suspends and has no `run+step` to
key a resume off, so it never earns a run record no matter how cheap persistence gets. This closes the measured
blind spot of `compute`-only operations (`gate-health`, `suggest-next`, `verify`, `pr-status`) leaving zero
trace of being called. A per-declaration opt-in to full run-record persistence for specific high-value
`compute` operations remains a live, un-foreclosed option layered on top of the lightweight signal, not a
replacement for it. Build tracked at
[the follow-on item](/backlog/3451-build-the-lightweight-call-visibility-signal-for-every-opera/). Full
reasoning, skeptic passes and prior art:
[#3427](/backlog/3427-design-an-operation-manager-a-real-execution-chokepoint-ever/).

**Extended 2026-09-07 (operator; #3174)** — the git-forge provider seam (`gh` / GitHub REST+GraphQL), ratified
across two forks, neither a new competing rule. **Fork 1 (where the seam binds) = (c) split on mutation vs.
read.** A mutating forge call stays inside the operation's single home and is never importable elsewhere —
this clause's own "one declaration, derived callers" doctrine carried to the outbound provider axis: a home's
mutating `gh` call is exactly the sole route a second importer would bypass, the same shape
[#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism)'s sole-writer invariant already polices on the inbound
side. A read that owns no operation (the roughly thirty conveyor/readiness watchers) binds instead through a
**named shared module** (`we:scripts/lib/forge-reader.mjs`), reusing the label port's `PR_STATE_FIELDS`
(`we:scripts/lib/review-label-provider.mjs:37`) rather than minting a second field list — a module import is
not a second mutation route, so it does not re-open the "hand-written glue over a declared operation" defect
clause 1 above names. **Fork 2 (how wide a contract is declared) = (b) per-arc ports fitted to their actual
callers**, extending the `we:scripts/lib/review-label-provider.mjs` precedent — never one repo-wide neutral
`ForgeProvider` interface. This is
[#state-lives-where-its-nature-dictates](#state-lives-where-its-nature-dictates)'s own #2626 vendor-abstraction
generalization ("the same seam discipline applies to any future vendor-specific infrastructure integration,
not only this store") *applied* to the git forge, not re-ruled here: a repo-wide interface derived from one
implementation (GitHub) would encode that vendor's model — integer PR numbers, `mergeStateStatus`, `gh`'s
check buckets — as though neutral, the exact lock-in the vendor-abstraction seam exists to keep out. The
completion condition is part of the ratified default, not a footnote: every bare `gh` invocation in
`we:scripts/` ends up behind one of the named ports (`review-label-provider.mjs`, `forge-reader.mjs`, and the
per-arc ports the land and drain arcs still need), and the port enumeration is lint-assertable. Full reasoning,
the fork-existence tests, and the confirmed *Already answered* list:
[#3174](/backlog/3174-git-hosting-pr-provider-abstraction-define-the-interface-now/).

---

### The conveyor's headless dispatch starts agents by CALLING the declared `dispatch-lane` operation — never a second spawn implementation, never a cross-process call into a sibling repo's server {#conveyor-dispatch-calls-the-declared-operation}

**Ratified 2026-08-26 by the operator (Nicolas Gilbert) (#3118).** The conveyor's headless runner surfaces
dispatch decisions; the thing that turns a surfaced decision into a running agent is the **declared
`dispatch-lane` operation**, called once per dispatch. Three clauses:

1. **One spawn implementation, and it is the declared operation.** The repo has exactly one place that starts
   a delivery agent — `dispatch-lane`'s sink. A second module that spawns `claude` for the conveyor is the
   same second-implementation shape [#deterministic-core-thin-judgment](#deterministic-core-thin-judgment)'s
   one-source clause forbids, and it is forbidden whether the rival lives in this repo or a sibling one.
   Widening dispatch to a new kind of work extends the declared operation; it does not fork a new spawner.
2. **The runner becomes a caller, not a backend.**
   [#operations-declared-once-callers-generated](#operations-declared-once-callers-generated) says an
   operation is declared once and its callers are adapters over that declaration. The conveyor's runner is
   one such caller. It supplies the item and the dispatch kind; the operation owns the argv, the brief, the
   handle, the run record and the observation.
3. **Steering is stop-then-resume, and that is accepted as sufficient — but reaching the mechanism is
   UNVERIFIED.** The [#agent-runner-cli-backend](#agent-runner-cli-backend) contract names `steer(text)` as a
   boundary-delivered write to a live child's stdin. A detached background session reaches the same end by
   being stopped and resumed with new instructions, which preserved the session's context in **one manual
   observation on 2026-08-25**. The conveyor's requirement is **"steer while keeping the work"**, not **"steer
   without ever interrupting"** — so the coarser verb satisfies it, and the finer one does not earn a second
   spawner. *That sufficiency is the operator's ruling and it stands.* What does **not** stand on the same
   footing is the separate factual claim that the conveyor can reach the mechanism at all:
   **`claude --resume` addresses a session by its id, so stop-then-resume presupposes that the dispatcher
   knows the id of the agent it started.** The same 2026-08-25 run recorded the opposite result for that
   presupposition — `--session-id` was **ignored** on a `--bg` spawn — and `#3331` is the probe that
   settles it. No code here resumes or steers anything yet:
   `grep -rnE -- '--resume|resumeAgent|steer'` over `we:scripts/operations/dispatch-lane-io.mjs`,
   `we:scripts/operations/dispatch-lane.mjs` and `we:scripts/conveyor/tick-core.mjs` returns **nothing**
   (re-run 2026-08-26, on both `main` at `3b2aeded` and `main` at `1ed16d63`). **This clause is the hinge,
   and two triggers revisit it**, not one:
   (i) if the requirement ever becomes steering a *running* agent without interrupting it — no
   stop-then-resume backend can reach that; or (ii) **if `#3331`'s probe comes back negative** — if
   `claude --bg` really does discard `--session-id`, the dispatcher cannot address the session it started,
   and stop-then-resume is unreachable as designed until `#3331`'s own remedy (reading the real id back
   off `claude agents --json`) exists. Trigger (i) is hypothetical; **trigger (ii) is live today.**
   **RESOLVED 2026-09-11 (`#3331`), and the ruling is unchanged by it.** The probe came back negative — `claude
   --bg` discards `--session-id`, 5/5 across CLI 2.1.246 and 2.1.269 — so trigger (ii) did fire, and `#3331`'s
   remedy has now landed. The dispatcher addresses the session it started by the id the CLI **prints back**
   (`backgrounded · <id> · <name>`, parsed by `we:scripts/operations/dispatch-lane-io.mjs#parseBackgroundedId`),
   which is narrower and cheaper than the "read it back off `claude agents --json`" this clause anticipated: it
   is the spawn's own synchronous output, so it needs neither the before/after listing diff the `#3030` spike
   rejected as racy nor a wait on a listing measured to lag 26+ seconds. Clause 3's acceptance of
   stop-then-resume therefore stands on a presupposition that is now TRUE rather than unverified. Nothing here
   implements steering; this records that the mechanism is reachable, not that it is built.

**Lineage:** #3118 (ratified 2026-08-26, operator), resolving its single fork as **(c)** over (a) a WE-native
port of the CLI-spawn runner and (b) a cross-process HTTP call into `plateau-app`'s dev server. (b) was
rejected on the same grounds #3031's reconciliation footnote already gives — lane clones mean N checkouts and
N ports with no answer to "which server acts on which clone". (a) was rejected by the fork's own opening
argument, which forbids two live spawn implementations behind one contract and lands on (a) as squarely as on
(b). **Composes with, and does not re-declare,**
[#conveyor-orchestration-mechanics-not-per-lane-agent](#conveyor-orchestration-mechanics-not-per-lane-agent)
(the runner spends no model context per tick; calling a declared operation spends none either),
[#operations-declared-once-callers-generated](#operations-declared-once-callers-generated) (this names one
more caller of one already-declared operation) and
[#agent-runner-cli-backend](#agent-runner-cli-backend) (that ruling governs what a spawn backend must offer;
this one governs who is allowed to call it). The costs this ruling accepts rather than waives — the dispatch
kinds the operation does not yet route, and the handle assumption that both the observer *and* clause 3's
stop-then-resume rest on — are tracked on #3118 and the items it links (`#3165`, `#3332`, `#3331`,
`#3096`), per
[#statute-anchor-states-rule-not-status](#statute-anchor-states-rule-not-status).

---

### A mechanically-dispatched agent never runs a command directly — denylist by verb-class, halt-and-surface on a gap {#dispatched-agent-never-runs-commands-directly}

**Ratified 2026-08-30 (Nicolas Gilbert; #3405).** `#3383`'s own spec states the doctrine — *"Subagents only
edit code. Every command they'd otherwise run themselves is delegated to the mechanical layer, which queues
it and reports the result back."* `#3105` already enforces one narrow instance of it
(`we:scripts/guard-bash.mjs`'s `dispatchedAgentVerificationReason`, gated on `WE_DISPATCH_KIND`, denying a
dispatched agent from running the verification suite directly). This ruling generalizes it into a repo-wide
rule with a scope and an escape hatch, rather than leaving it piecemeal-enforced one command at a time with
no rule behind it.

1. **Scope (Fork 1) — (a) denylist by verb-class, expand as each concrete case forces it.** `guard-bash.mjs`
   gains a new `WE_DISPATCH_KIND`-gated rule per command class a dispatched agent should never run directly,
   one at a time, each with its own named reason — mirroring exactly how `#3105`'s rule was built. Rejected:
   (b) an allowlist of safe read-only commands, structurally closer to `#3383`'s letter but with a real
   enumeration cost and a real risk of silently breaking a dispatch flow nobody remembered to allowlist; (c)
   leaving it as `#3105` built it (one command, no general rule) — the piecemeal-enforcement gap this ruling
   exists to close.
2. **The missing-operation fallback (Fork 2) — (a) halt and surface a `missing-operation` finding.** A
   dispatched agent has nobody watching it turn-by-turn — that is the whole premise of `#3383` — so silently
   blocking or working around an undelegated command is worse here than for an interactive session, where a
   human could at least notice. Mirrors the already-landed `no-hand-rolling-around-a-missing-operation` rule.
   Rejected: (b) a human-approved break-glass — there is no human in the loop to approve one synchronously
   for a headless dispatch, so it would have to route through the escalation/notification path `#3398`
   builds, adding a real latency cost to every uncovered case.

**Distinct from two adjacent cards, deliberately not settled by this ruling.** `#3188` (should an
interactive operator session be restricted to declared operations) is about **prompt-injection blast
radius** for the human-driven session — a different population and a different motivation, ratified or not
independently of this one. `#3401` (the dispatch loop's own code is unregistered in TRUST_CHAIN) is about
**review scrutiny on the code that enforces this doctrine**, not about what a dispatched agent may do at
runtime — a dispatched agent can be perfectly doctrine-compliant while the code implementing that compliance
is under-scrutinized. Neither is subsumed or resolved by this entry.

**Mechanism left open on purpose.** A new `we:scripts/guard-bash.mjs` rule per newly-scoped command is the
assumed default (matching `#3105`'s own precedent), but a `PreToolUse` hook or a harness-level permission
mode remain live alternatives with different bypass properties for whichever command forces the next
concrete case — this ruling fixes the doctrine's *scope*, not each future command's enforcement mechanism.

**Lineage:** #3405 (ratified 2026-08-30, operator), resolving Fork 1 as (a) over (b)/(c) and Fork 2 as (a)
over (b). Composes with, and does not re-declare,
[#conveyor-dispatch-calls-the-declared-operation](#conveyor-dispatch-calls-the-declared-operation) (that
ruling governs how a dispatch starts; this one governs what the dispatched agent may do once running).

---

### State lives where its nature dictates — transient intent goes session-local, durable readiness goes committed-upstream {#state-lives-where-its-nature-dictates}

**Ratified 2026-07-22 (Nicolas, merit-based; #2615 + #2617).** *Where* a piece of state lives is
decided by *what the state is* — its nature — not by which surface first happened to need it. Two kinds,
two homes:

1. **Transient operator / session intent → a session-local sidecar the lane guard does NOT police.** A
   per-operator, this-session-only signal — the conveyor's clear-for-build queue is the type case — lives in
   a **gitignored sidecar** (`we:.conveyor/queue.json`, the drain's `we:skills-src/batch-backlog-items/queued.json`,
   `we:.claude/lane-ports.json`), **never committed frontmatter**. It is session scratch, so it is exempt from
   the card-mutation guard and writable straight from the primary/main checkout — which is exactly why #2615
   moved the conveyor's `buildQueued` here: the guarded committed-frontmatter path (#2302) blocks the main
   session from ever clearing work, so operator intent had to leave git to be usable at all.

2. **Durable spec / readiness of an item → committed frontmatter, guarded and human-reviewable.** An item's
   predicted `scope` and its `size` — the *shape* of the work — are shared repo truth authored **upstream** at
   the moment the item is made ready (`/prepare`, `/scaffold`, `/split` — shape time), **reviewable by a human
   before the item is cleared**. Its `status` and `blockedBy` are the same kind of durable, committed truth,
   but mutate across the lifecycle (claim, resolve, re-block), not only at shape time. What unifies all four —
   and is the load-bearing point — is that every one lives in **committed frontmatter** and mutates **only**
   through the guard-gated card-mutation path (#2302 — a lane→PR, never a primary-cwd splice).

3. **A dispatcher/scheduler CONSUMES readiness; it never PRODUCES it.** Predicting an item's `scope` is a
   **readiness/shaping act** — it belongs in `/prepare`, not at dispatch time. A runtime scope-probe *inside*
   the conveyor is rejected on the merits (#2617): it puts shaping in the dispatcher, produces the
   prediction late and blind to human review, and hides a second PR; its only edge — freshness — is already
   covered by the observed-scope breach detector. The dispatcher reads the authored `scope`; it does not
   author it.

4. **Consistent with PR #663's empty-scope hold (the empty-scope contract; durable home #2609) — resolved by
   auto-prepare, never by a blind build.** An item that reaches dispatch without a predicted `scope` is
   `needs-probe` / **unshaped**: it is **held**, never launched blind (exactly PR #663's rule — unscoped =
   held, never launched unprotected). The conveyor's response to the hold is to **auto-prepare** the item — it
   dispatches a *prepare-scope* task that predicts the item's touch-set and writes `scope:` into the item's own
   `backlog/<num>.md`. That prepare task needs no scope prediction of its own: its touch-set is known a priori
   — it *is* the story's own file — so it is parallel-safe (each prepare touches a different story file) and
   free of any chicken-and-egg. So scope is **always** authored (at readiness) before a build: never predicted
   at build time, never dispatched blind. The dispatcher still only *consumes* scope (clause 3); auto-prepare
   is a separate readiness step that *produces* it.

5. **The guard line is the same line.** The card-mutation guard (#2302) protects **committed durable state**
   and leaves **session sidecars** alone — the same principle in both directions: the guard exists to protect
   *shared repo truth*, not *session scratch*. Committed ⇒ guarded + reviewable; sidecar ⇒ unguarded + private.
   Which side a signal falls on is settled by clause 1 vs. clause 2 — its nature — never by convenience.

**Lineage:** ratified 2026-07-22 (Nicolas, merit-based), codifying #2615 (buildQueued → session-local
sidecar) and #2617 (predicted scope authored at readiness, not at dispatch). Consistent with the empty-scope
contract of PR #663 (durable home #2609: unscoped = held, never launched blind) — the conveyor resolves the
held state by auto-preparing the item (authoring its `scope`), never by building it blind. Applies the
card-mutation guard #2302, and governs the `scope:` field (#2609) the conveyor (#2612/#2613) reads. Composes
with
[#deterministic-core-thin-judgment](#deterministic-core-thin-judgment): scope *prediction* is the judgment
half authored once upstream; dispatch is the deterministic half that only consumes it.

**Extended 2026-08-17 (Nicolas, operator; #2626)** — a third home this clause's two-home taxonomy never
contemplated: a **shared durable store at product**, for operational state a session-local sidecar can no
longer serve once a session-free/multi-actor product surface exists. Per-artifact by nature, not
lift-and-shift: shared-truth sidecars (the cleared-for-build queue #2613, the jury ledger #2641, infra-blocked
recovery #2659) migrate; machine-local artifacts (advisory locks, `we:.claude/lane-ports.json`, the learnings
drop-box #2614) never do. The migration is accepted on merit, gated on a tracked trigger — it fires when the
first session-free product surface must read/write conveyor operational state with no main session present
(concretely, #2703 retiring the main-session loop) — not by an open-ended "later." The runner lease (#2702) —
today one indivisible machine-local lock fusing a process singleton with cross-actor write arbitration —
**splits**: the process guard stays local forever (a remote store cannot see whether a process is alive on
this machine); the arbitration half becomes a single-writer Durable Object lease, but only conditionally, if
runners ever run multi-host. **Vendor abstraction is a hard requirement of this migration, not an
implementation nicety**: every shared-truth sidecar already sits behind a pure-core store module
(`we:scripts/conveyor/queue-store.mjs`, `we:scripts/lib/jury-ledger.mjs`, `we:scripts/conveyor/infra-blocked.mjs`)
— the migration must keep Cloudflare-specific SDK/API calls confined entirely to each module's io-shell, never
leaking into the pure core or into any consuming code path, so a future substrate swap away from Cloudflare
(should one ever be needed) touches one shell per artifact, not a rewrite. This generalizes: the same seam
discipline applies to any future vendor-specific infrastructure integration, not only this store. Store choice
(Durable Objects + D1 over MongoDB) is a settled lean, not itself a ratified fork.

**Extended 2026-08-20 (Nicolas, operator; #3214)** — a **fourth home**, and the first one that is
*interim by construction*: a **git transport branch**, for operational state that must be **durable and
shared BEFORE the trigger above fires**. The case that forced it is the verdict ledger
(`we:scripts/lib/verdict-ledger.mjs`): `#3007` Phase 2 makes it the authority the drain merges on, but it is
written to a machine-global `~/.claude/` path, and on a credential-less host the only writer that works runs
inside ephemeral CI — six verdicts recorded in one session wrote six rows that no longer exist. A merge
authority cannot wait on the `#2703` trigger, so it does not.

Three clauses, and the first is what keeps this from becoming a fifth taxonomy by drift:

1. **It is a WAITING ROOM, not a destination.** State placed here is state that has already been classified
   as belonging in the shared durable store; the branch holds it until that store exists. Anything whose
   nature says *session-local* or *committed frontmatter* stays where clause 1 or 2 put it — this home is
   not a general-purpose escape from the taxonomy, and an artifact may only use it while naming the
   shared-store row it is destined for.
2. **The same vendor-abstraction requirement applies, unchanged.** The git specifics live in the artifact's
   io-shell, never in its pure core — so the eventual move to Durable Objects + D1 touches one shell, which
   is the whole reason clause 3 above exists. `we:scripts/operations/record-verdict.mjs` is the worked
   example: a pure declaration over a shell that pushes.
3. **Append-only means append-only, including under contention.** A git branch is not automatically an
   append-only store: two writers pushing concurrently is a non-fast-forward, and a writer that drops the
   row on rejection has silently lost a verdict — precisely the failure class `#3007` exists to close. So an
   artifact using this home MUST carry a fetch-append-retry loop with bounded retries and a LOUD failure on
   exhaustion, proven by a two-writer concurrency test, before it may be called append-only or relied on as
   an authority.

The migration trigger is the same one clause 3 above names (`#2703`); this home simply does not wait for it.
Ratified against a two-round skeptic pass that landed both times — the fourth-home governance gap and the
contention defect above are findings it forced, not afterthoughts.

**Extended 2026-09-21 (Nicolas, operator; #3605, bornAs xn7yaiz)** — a rule for **any session-local sidecar that
stores a backlog id**, from the cleared-for-build queue (`we:.conveyor/queue.json`) drifting when the drain
JIT-renumbers a card from its birth hash to `#NNN` (#2288). A stored id is a *reference*, and a reference can
outlive the spelling it was written under. Three clauses:

1. **Translate at the reader, through `bornAs`.** The store module's pure core owns one translation step
   (birth-hash → current number, using the `bornAs` proof-of-land #2392 on the backlog the reader already loads).
   Every reader applies it once, right after reading the file, so a new reader gets it by reusing the loader
   rather than re-deriving it. The stored spelling is never trusted to match a current number.
2. **The drain never rewrites a conveyor sidecar.** Re-keying at JIT-number time reaches only a runner that is
   live at that moment, misses entries already stale and hashes typed later, and adds a second unsynchronized
   writer to a file whose store is last-write-wins by design. (Supporting context, not authority: the drain
   already keeps its own writes inside its own clone, [#drain-daemon-self-hosting-boundary](#drain-daemon-self-hosting-boundary).)
3. **Only an operator write corrects the file, and the dispatch tick never does.** The operator CLIs apply the
   translation before they add or remove and write the result back, so any operator action leaves correct ids
   on disk and `remove <NNN>` removes an entry stored under its hash. A read-repair write from the tick is
   rejected: an operator `add` landing between the tick's read and its write is silently lost, and under a
   fixture `--backlog-dir` the tick would translate against the wrong corpus. Display shows both spellings
   (`#NNN (cleared as <hash>)`) so an unfamiliar hash is never a mystery.

This composes with, and does not amend, the two homes above: the sidecar stays session-local and unguarded; this
rule only fixes how a stored id is *matched*. Build: [3786](/backlog/3786-translate-birth-hash-ids-to-current-numbers-when-the-conveyo/).

---

### Event-driven land is WAKE-only — one polling drain stays the sole writer; a webhook may wake it, never add a second writer; the merge-queue build defers behind measured saturation {#event-driven-land-is-wake-only}

**Ratified 2026-07-27 (operator; #2692, bornAs 2692).** How "event-driven land" (Lever C) may and may not be
built, on top of the sole-writer-to-`main` invariant ([#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism)).
Four clauses:

1. **Landing stays ONE logical writer — a single polling drain.** An event or webhook (a PR reaching ready, a
   `POST /nudge`) may **WAKE** that one daemon so it lands sooner; it may **never** add a second writer or a fence.
   The **second-writer / fencing-failover / borrow-the-lease** path is **closed on the merits — do not reopen**: it
   is *unbuildable-safely on GitHub* (the merge-API `sha` guards the PR *head*, not base `main`; there is no
   token-fenced main-write) **and** dominated by simply supervising one live writer. A wake signal is never a
   trusted land order — the daemon's own pre-land gate is still re-derived server-side
   (`we:scripts/lib/pr-merge-gate.mjs`); authority does not move earlier just because the trigger does.

2. **The cheap WAKE ships now, independent of everything below.** Shorten the drain poll default (60s → ~5–10s,
   one constant) and fire the daemon's `/nudge` on a PR-reaching-ready event. One constant plus one event wire —
   **no second writer, no transaction question.** The interval floor **stays** (push is an accelerator, not a
   replacement — #2605). Tracked as the WAKE-remainder story (built on the #2605 `/nudge` seam and the #2683
   conveyor fast-drain trigger).

3. **The full event-driven MERGE-QUEUE build is DEFERRED, not cancelled, behind a MEASURED saturation trigger.**
   The deep build — speculative merge-commit preserving the signed-off SHA, per-step CAS/idempotent
   transaction-tail guards, and the batching rider — is a real merge-queue-with-sign-off-integrity, not a quick
   lever. It waits on **measured `land-serialization` saturation** (#2680's metric: **k > 1 ready PRs queued behind
   the sole writer, sustained over the window** — not a one-off spike). Until the trigger fires, the deferral is
   legitimate; the ruled defaults are pre-attached so no re-litigation is needed when it does.

4. **The tripwire SURFACES-AND-ROUTES — it never silent-fires an unattended build.** On sustained saturation the
   tripwire (#2740) **surfaces / flips #2683's `buildQueued`** *and* **routes the build through the criticality
   decision-routing (#2704, `we:scripts/lib/decision-routing.mjs`)** — which may require **operator confirm** for a
   safety-critical merge-queue build. It does **not** autonomously execute the build. "Plan to undefer" means *auto-surface +
   route by stakes*, never *auto-execute*: the un-gate becomes visible and correctly-routed on measured evidence,
   and a human still owns the go on a high-stakes build.

**Lineage:** #2692 (ratified 2026-07-27, operator; bornAs 2692; ten-round high-care design-jury red-team,
`we:reports/2026-07-27-lever-c-landing-merge-queue-design.md`). **Closes the second-writer / fencing branch on the
merits** (clause 1). WAKE ships now (clause 2) = #2605 (drain-daemon `/nudge` seam) + #2683 (conveyor fast-drain
trigger, resolved) + the WAKE-remainder story `#2743`. Deferred merge-queue build (clause 3) = slice #2683's
successor, gated behind tripwire **#2740** reading #2680's `land-serialization` saturation metric, **routed** by
**#2704** (clause 4). Program #2606 / epic #2612. Extends [#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism)
(sole-writer-to-`main`) and composes with
[#deterministic-core-thin-judgment](#deterministic-core-thin-judgment) (the wake/land mechanics are script-decidable;
the high-stakes un-gate stays a routed judgment call).

### A constellation repo owes the drain a green required check named `test` {#repo-drain-check-contract}

The boundary contract between a constellation repo (web-everything / frontierui / plateau-app) and the
merge-queue drain is exactly one thing: **the repo exposes a green required check named `test`.** The drain
consumes only the check's **name + conclusion** — `isRequiredCheckGreen(pr, 'test')`
([`we:scripts/merge-ai-prs.mjs:207-213`](../../scripts/merge-ai-prs.mjs)) finds the status-rollup entry named
`test` and lands the PR iff its conclusion is `SUCCESS`. **How** a repo turns that check green — which CI job
shape produces it — is **repo-private impl, invisible across the repo↔drain boundary:** the drain never
inspects the job's steps, only its name and result. So the contract is met by *any* green check named `test`,
and what WE ratifies is the **contract**, never a particular job shape. frontierui satisfies it via its landed
[`fui:.github/workflows/ci.yml`](../../../frontierui/.github/workflows/ci.yml) `test` job — a **tokenless**
sibling-checkout of *public* WE, then `build:tools`/`build:packages` + `test:unit` + `check:standards`, green
on FUI PR #24 — which is **one valid impl** of the contract, not the contract itself. A scoped no-sibling job
(a `test` job behind an exclude list) would be an inferior-on-merit but equally-**valid** impl; the drain
cannot tell the two apart. **Accepted, symmetric caveat:** a repo whose `test` job builds against the WE
sibling pins no `ref`, so WE-`main` drift can turn the check red for unrelated reasons. Making the `test` check
GitHub-*required* via branch protection is a separate credentialed step (#2246); this rule governs only the
name+conclusion contract the drain matches — **not** the CI job shape, which stays repo-private.

**Lineage:** #2315 (ratified 2026-07-28, operator; prepared 2026-07-09). A one-off CI-transport ratify,
reframed at the fresh-context screen from FUI's *job shape* to the repo↔drain **boundary contract** (the job
shape is FUI-private impl the drain can't see). Ratifies shipped, proven code (green on FUI PR #24). Composes
with [#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism) (the drain is the sole `main` writer) and
[#primary-read-only-lanes-only](#primary-read-only-lanes-only) (the lane→PR transport the check gates);
complementary to #2246 (branch protection makes the check GitHub-*required*). Two follow-ups filed separately:
a deferred `classifyPr` "no-check vs red" reporting split, and authoring the missing maas authoring artifact.

---

### The drain never auto-resolves a card carrying a `## Slice ` heading — an explicit TEMPORARY fix, not the final delivery-strategy design {#drain-multi-slice-card-interim-hold}

**Ratified 2026-09-21 (operator, in conversation; #3820, decision card; explicitly ratified as a temporary
fix).** The resolve-on-land extractor credits any `lane/<NNN>[a-z]?-<slug>` ref with item NNN
([`we:scripts/lib/open-pr-items.mjs`](../../scripts/lib/open-pr-items.mjs)) and nothing on the card side checks
whether the card is fully built before `we:scripts/lane-drain.mjs`'s `resolveLandedItem` sets
`status: resolved`. That silently closed #3779 on its first slice landing (PR #2392, 2026-09-21) while all four
of its Done-when items and four of its five design points were unbuilt.

1. **The rule.** A backlog card that holds a `## Slice <label>` heading is never auto-resolved by the drain on
   a PR land; the drain reports `deferred: multi-slice card` instead and the card is resolved deliberately.
2. **The marker is the heading alone.** No new frontmatter field is added to declare a card's slices.
3. **Weak spot, accepted.** This protects only a card whose `## Slice ` heading already exists when a slice PR
   lands (#3779's own slice-A PR added the heading itself, so this rule would have caught it) — a first slice
   PR that adds no heading is not protected. An explicit `Resolves #N` / `Refs #N` PR marker is a later,
   additive backstop, not built here.
4. **Why this is explicitly temporary.** It answers only "how does the drain know a card isn't finished," not
   the broader question of how a split card is delivered and which event counts as "finished" (child cards vs.
   a feature flag vs. an integration branch vs. stacked PRs, operator-configurable, agent-chosen at slicing
   time). That broader question is Fork 5 on `#3575` (open, unprepared) and is deliberately out of scope here.
   Once Fork 5 is researched and ruled, re-examine whether this narrow hold is still needed as a fallback or
   can be retired.

**Lineage:** `#3820` (ratified 2026-09-21, operator, in conversation; `bornAs: 3820`), copying #3816's own
proposed default without re-researching it. Build tracked on `#3816`. Composes with
[#repo-drain-check-contract](#repo-drain-check-contract) (a different axis of the same drain: what makes a
check land-worthy, not what makes a card resolve-worthy) and with `#3575` Fork 5 (the durable replacement this
rule defers to).

---

### Drain-daemon self-hosting boundary — its own source runs from a dedicated clone, reloads via clean-exit + KeepAlive, and self-updates through the same graduated review as any change, only with independent (never self-) approval {#drain-daemon-self-hosting-boundary}

**Ratified 2026-07-27 (operator; #2501, bornAs 2501).** How the resident drain daemon may safely
**self-update-then-reload** without ever `reset --hard`-ing the user's primary tree. Three coupled clauses,
built on the sole-writer-to-`main` invariant ([#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism)) and the
isolated-clone rule ([#pool-siblings-real-built-clones](#pool-siblings-real-built-clones)):

1. **Supervisor clone location — a DEDICATED single-lane plateau-app clone (Fork A).** The daemon's OWN source
   runs from a provisioned `plateau-app-drain-daemon` pool (`--count=1`), mirroring the already-shipped
   `we-drain-daemon` clone pattern. `install()` resolves the launchd plist's `daemonPath`/`workingDir` to that
   clone, not `dirname(import.meta.url)`; self-update is then the SAME `fetch` + `reset --hard origin/main` +
   `clean -fdq` the daemon already runs on its WE clone, applied to its own source — the user's primary tree is
   never touched. Running from primary (b) is **closed on the forced invariant**: a self-update `reset --hard`
   would clobber the user's uncommitted work, so "self-update" and "run from primary" cannot coexist.

2. **Reload primitive — `process.exit(0)` + launchd `KeepAlive` relaunch (Fork B).** After the clone updates,
   the daemon resumes on the new code by calling its existing clean-shutdown path (`releaseAndExit(0)` — SIGTERM
   the in-flight child, release the drain lease, then exit) and letting launchd's `RunAtLoad + KeepAlive`
   relaunch it from the updated clone. The reload fires only BETWEEN passes (the loop's delay window), never
   mid-pass; GitHub is the source of truth, so unlanded `ready-to-merge` PRs ride the next pass. The operator
   `restart` primitive (`launchctl bootout` + `bootstrap`) is **external-only and unusable for self-reload** — a
   self-issued `bootout` kills the daemon before `bootstrap` runs. `kickstart -k` (b) is redundant with KeepAlive
   (its SIGTERM runs the same clean handler) and exec-in-place (c) discards supervision; (a) wins on simplicity.
   (amended 2026-09-23 by [#resident-daemon-reload-lifecycle](#resident-daemon-reload-lifecycle) clause 1: the
   "same clean handler" premise is wrong mid-tick — a tick inside a synchronous child call cannot run the handler,
   so the lease is never released. Never `kickstart -k` a daemon mid-tick.)

3. **Self-source review — the SAME size/complexity-graduated committee as any change, with the ONE retained
   invariant that the review is INDEPENDENT (Fork C, OPERATOR-MODIFIED).** A PR that changes the daemon's own
   source (`tools/drain-daemon/`) is **NOT** special-cased to always-human review, and is **NOT** promoted to the
   policy tier. It goes through the **standard size/complexity-scaled review committee** — the jury / producer
   review rubric — exactly like any other change. The single special rule: the review must be **INDEPENDENT** —
   the self-updating daemon and its authoring agent may **never self-approve their own daemon-code change** (the
   #809-class self-approval hole). Operationally this is already largely honored: the daemon **never self-clears
   its own parked reviews** (it surfaces them for a separate session), and daemon source sits in `TRUST_CHAIN`
   ([we:scripts/lib/gate-config.mjs](../../scripts/lib/gate-config.mjs)) at `tier: 'engine'`, so every self-source
   PR escalates to an independent adversarial panel ([we:scripts/lib/review-escalation.mjs](../../scripts/lib/review-escalation.mjs)).
   Independence — not a human tier and not blanket escalation — is the invariant that closes the self-approval
   hole. **Superseded the preview's Fork-C default** (rely on #2480 + a light in-daemon assertion) and **rejected**
   the always-human policy-tier alternative — the operator's words (2026-07-27): *"I do not want to human review
   every daemon change; use a good review committee depending on the size and complexity of change, like for other
   changes."* A directory-keyed (never basename-keyed) in-daemon tripwire that DEFERS a self-source PR so THIS
   daemon's pass is never the one to land it remains a sound belt-and-braces implementation detail, but the
   binding rule is the graduated-committee-with-independence above, not any single guard.

**Lineage:** #2501 (ratified 2026-07-27, operator; bornAs 2501; prep
`we:reports/2026-07-14-plateau-loop-self-hosting-boundary.md`, research `/research/plateau-loop-self-hosting-boundary/`).
Parent epic #2468 (drain-daemon supervisor). Fork A reuses the `we-drain-daemon` clone pattern and honors
#2197/#2123 (a drain runs from an isolated clean clone, never a user tree). Fork C's independence invariant is the
#809-class self-approval rule applied to daemon self-update, composing with the existing #2445/#456 two-tier
trust-chain (engine = agent-clearable on a converged independent panel) and #2480 (daemon source registered in
`TRUST_CHAIN`) — it **rejects** promoting daemon source to the policy tier. Concurrent self-lane-edit exclusion
(#2077-style) stays deferred to #2444/#2418 (no self-edit scheduler exists in phase 1). Extends
[#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism), [#pool-siblings-real-built-clones](#pool-siblings-real-built-clones),
and [#agent-convergence-independent-validation](#agent-convergence-independent-validation) (independence rests on a
distinct validator, never peer/self agreement).

**Rider — the independence invariant extends to an automated run-quality judge's own findings, on a non-PR
path (#3649, ratified 2026-09-13).** #3649's run-quality auditor scores a dispatched agent's transcript and can
auto-apply low-risk fixes for a **bounded one-off work agent** — but when the reviewed subject is itself a
**conveyor/driver-class process** (a runner or driver that queues, dispatches, or supervises other work as
part of its own operation), the auditor is **report-only, always**, regardless of how low-risk a finding
looks: it emits findings and a score and hands them off, never applying a fix directly. This is not a
stricter rival rule but an **entailment** of this anchor's clause-3 independence invariant, reached by a
different route: an auditor auto-applying its own finding against a live driver would be the same
self-approval hole clause 3 closes (judge and approver of the same change), reached through an automated-judge
path instead of a PR. `subjectClass` is stamped on the dispatch record at launch time and read back, never
re-derived from the transcript afterward; a transcript with no dispatch record is driver-class by default
(fail-closed). Composes with, and does not subsume, [#pr-flow-rollout-mechanism](#pr-flow-rollout-mechanism)'s
`#2077` rider (`RUN_TOOLING` touch-set test): the two key on different tests — this rider on the **subject
class** that produced the transcript, `#2077` on the **edit's touch-set** — and an auto-applied fix must clear
both. Lineage: [#3649](/backlog/3649-run-quality-benchmark-score-a-dispatched-agent-s-own-transcr/).

---

### "Which trust tier owns X" defaults to a contract-split — engine-tier the impl, policy-tier a `*.contract.json` for the definition {#contract-split-for-tier-ownership}

**The reusable pattern (this is the ruling's point, not the one gate).** For *any* "which trust tier
owns X" decision where **X is a gate, validator, or definition an agent could quietly weaken and then
self-clear** (the [#809](/backlog/809-)-class self-approval hole — an autonomous builder softening the
very thing that judges its work, with no independent human in the loop), the **default path is
CONTRACT-SPLIT**:

1. **Keep the implementation code in the ENGINE tier** — agent-clearable. This is deliberately where
   the repo's *hottest, most-churned* files live; the code still ALWAYS escalates (gets an independent
   review) and a converged verdict may land it, so it is protected, just not stranded behind a human.
2. **Move the DEFINITION — what counts as green / valid — into a POLICY-tier `*.contract.json`**, a
   small, rarely-edited data file. A diff to it trips the policy-tier path test and forces
   `review:human`; a conformance suite proves the impl realizes the contract, so a behaviour-preserving
   impl refactor stays green and agent-clearable while a *definition* change goes red → forces a
   contract edit → a human. The split isolates **exactly** the part that must not be self-weakened, and
   nothing else.

**Why this beats promoting the whole gate to policy/always-human.** An always-human promotion of the
entire gate **over-gates** the churny impl (a human on every routine lint/rule tweak) and — per the
#2625 skeptic — has **no real review-clearance conflict-of-interest** for a conformance gate: unlike
the trust-chain *lander* ([#2448](/backlog/2448-)) whose engine an agent-reviewer would be policing as
its own leash, a conformance gate's impl is ordinary code. So the minimal, correct cut is the split,
not the blanket promotion. It closes the hole **without** the friction (unlike a full-policy promotion)
and **without** leaving it open (unlike status-quo blast-radius, where protection is incidental to a
path regex).

**How to apply.** For the next "which tier owns this gate/definition" fork, **propose contract-split
first** and cite this rule — it should resolve fast (a small, patterned micro-decision, not fresh
research). These rulings are good candidates to surface **inline on the item card** in the future
decision UI ([#2577](/backlog/2577-)) rather than run through a full prepare/preview cycle.

**Precedent this generalizes.** The already-ratified `review-policy.contract.json` / loader split —
the review-escalation policy extracted into a machine-diffable contract with a conformance suite
([#2566](/backlog/2566-) under spec-based programming [#2564](/backlog/2564-),
[#spec-is-schema-human-gates-spec](#spec-is-schema-human-gates-spec)) — is the first instance; the
`check:standards` gate ([#2625](/backlog/2625-)) is the second, and the one that generalized it into
this default. Kin to [#blast-radius-advisory-care-not-a-gate](#blast-radius-advisory-care-not-a-gate)
(the gate fires on a *spec* change, not any path touch) and
[#deterministic-core-thin-judgment](#deterministic-core-thin-judgment).

**Lineage:** #2625 (ratified 2026-07-28, operator — fork (d) contract-split, the option the raw a/b
fork missed and prep surfaced; the operator's explicit instruction was to codify it as a *reusable*
precedent, "exactly the path to take in similar decisions," a micro-decision "easily brought forward
… on card in the future UI") · precedent #2566/#2564 (`review-policy.contract.json` split) · #2448
(the lander's engine-tier ruling that boomerangs the axis-2 precedent toward the split, not blanket
policy) · #809 (the self-approval hole this closes) · #2577 (the decision-surface work that should
host this class inline). Parent #2445.

### Prefer small, single-responsibility, decoupled files; split god-files — soft-warn on a size+collision composite, never deny {#small-file-preference}

**Files should be small, single-responsibility, and decoupled; when a file grows into a god-file — many
responsibilities, a wide surface many items must touch — the default is to split it along its
responsibility seams.** This is a *throughput* lever, not tidiness: the scope-lease engine (#2560) keeps
unrelated lanes apart by the files they touch, but a lease is only as fine as the files are small. One
file carrying many responsibilities is a single lock point — **every** item that touches **any** of them
declares a scope over it, so they serialize against each other even with zero real overlap. Splitting
god-files is the enabler that makes finer-grained leases (#2679) actually deliver parallelism. Delivery
agents apply this as a standing authoring default when they build, not as a special project.

**Cohesion outranks line count — the rule is a default, not a cap.** Do not fragment a genuinely
single-responsibility file into a scatter of tiny coupled files just to hit a number; over-fragmentation
trades a wide lock for a diffuse surface with hidden cross-file coupling. Split only where the
responsibilities are genuinely separable *and* the split aids parallelism.

**Enforcement is a soft-warn gate, keyed on a size+collision composite — never a hard deny.** `check:standards`
**warns** (never errors, never denies the write) on a file that is *both* oversized *and*
scope-collision-heavy — the signal is the **composite** (large **and** touched by many items' scopes), not
raw line count, so a big-but-cohesive file that nothing else contends for stays quiet. A `// @cohesive: <reason>`
escape-hatch comment in the file silences the warning for a legitimately-cohesive large file (the author
asserts the seams aren't real). The two rejected alternatives fix the shape of the rule: a **hard deny**
(fork-1 option c) is rejected as a *footgun on high-churn files* — the god-files are exactly the
highest-traffic files, and a blocking gate there would deny the very edits that split them; a
**guideline-only** note (option a) is rejected as too weak to change default behavior. Warn-not-deny keeps
the pressure visible and steady without ever blocking a legitimate edit. Kin to
[#blast-radius-advisory-care-not-a-gate](#blast-radius-advisory-care-not-a-gate) (advisory signal, not a
park-gate) and [#deterministic-core-thin-judgment](#deterministic-core-thin-judgment) (the composite +
escape-hatch are script-decidable; the cohesion judgment stays with the author).

**Lineage:** #2678 (ratified 2026-07-28, operator — fork 1 ruled **(b) soft-warn gate**: size+collision
composite, `// @cohesive:` escape hatch, warn-not-deny; option (c) hard-deny rejected as a high-churn
footgun, option (a) guideline-only rejected as too weak). Enabler for finer scope-lease granularity
#2679; first split targets are the god-files ranked by scope-collision frequency (`scripts/merge-ai-prs.mjs`,
`scripts/lib/review-core.mjs`, `scripts/lib/review-escalation.mjs`, …). Throughput program #2606; sibling
#2677 (conveyor orchestration). Reflected in the delivery-agent brief
(`we:.claude/skills/conveyor/delivery-agent-brief.md`).

---

### review:human is reserved for the declarative leash and un-ratified judgment — gate-self derivation code and codification of an already-ruled decision route to the independent committee {#review-human-declarative-leash-only}

**Ratified 2026-07-28 (#2771, operator — adopt b + c).** Generalizes [#blast-radius-advisory-care-not-a-gate](#blast-radius-advisory-care-not-a-gate) (which narrowed the *scored* signals to advisory care-level) and [#contract-split-for-tier-ownership](#contract-split-for-tier-ownership) (engine-tier the impl, policy-tier the definition) to the escalation rubric's last two `review:human` triggers — both on one line, `humanRequired = gateSelfFiles.length > 0 || statuteFiles.length > 0` (`we:scripts/lib/review-escalation.mjs`). `review:human` means *genuine human judgment is essential* — a novel/irreversible change to the declarative leash, a raw new statute rule, or an un-ratified decision — **not** "an agent might be policing its own leash." Cite all three together.

1. **Gate-self / policy-tier DERIVATION CODE → the sized independent committee, not always-`review:human` (Fork A / b).** Split the policy tier. The **declarative leash** stays `review:human`: the machine-diffable contract (`we:review-policy.contract.json`), the roster (`we:gate-config.mjs`), and the invariant/conformance suites (`we:gate-invariants.test.mjs`, `we:review-policy.conformance.test.mjs`) — a diff here is a genuine policy change (the deterministic "did the spec change?" test, per the sibling anchor). The **derivation CODE** — `we:review-escalation.mjs`, `we:review-core.mjs`, `we:review-policy.mjs`, and the two land seams — routes to the sized independent committee (review-to-convergence, no self-approval): a behaviour-preserving change that keeps the #2566 conformance suite green may be committee-cleared, with a human reached ONLY on non-convergence. Any change that alters the gate's *behaviour* necessarily reddens conformance, forcing a contract diff — which is the human-gated declarative branch. Mechanically: narrow `humanRequired` from "any `isPolicyCorePath`" to "any `POLICY_SPEC` basename"; derivation-code basenames still ESCALATE (`review:pending`, full committee) but no longer force a human. Authorizes and extends #2573.

2. **Codification of an already-ruled decision → committee (`review:pending`), not `review:human` re-review (Fork B / c).** A PR whose diff *resolves a `kind:decision` (status → `resolved` + `codifiedIn` set to a `we:platform-decisions.md#anchor`)* AND whose ONLY `we:platform-decisions.md` edit is the addition/extension of exactly that anchor is the mechanical codification of a call the human already made at ratification — detected **script-decidably** from that resolve+codify diff shape, NOT a raw "touches `we:platform-decisions.md`" test. It is committee-clearable, not human-gated (the #882/#885 re-bounce). The committee still reviews it: an independent panel checks the anchor faithfully records the resolved decision's ruling. A `we:platform-decisions.md` diff with NO accompanying resolve+`codifiedIn` (an author writing a NEW rule) stays `review:human`.

**Invariants preserved:** the final landed diff is signed off by an agent that did NOT author it (#2439); aggregation is diversity-selection (strictest juror wins, never majority vote); non-convergence hard-escalates to `review:human`. No self-approval, ever. The sticky-veto semantics (#2309/#2365) and no-agent-clears-a-human-label (#2416) keep holding for whatever remains human-gated. **Out of scope / untouched:** the scored signals (already advisory, #2563), the ENGINE tier (already agent-reviewable, #2445/#2501 Fork C), and the committee mechanism itself (jury size / roster timing, #2636/#2285) — this rule routes work *to* the committee, it does not redesign it.

**Lineage:** #2771 (ratified 2026-07-28, operator — adopt b + c; bornAs `2771`, prepared 2026-07-28, filed on PR #895). Parent #2405 (harden the PR-validation gate). Generalizes #2501 Fork C (ENGINE-tier daemon-source → independent committee) from that one tier to the whole rubric; builds on #2566/#2564 (the machine-diffable contract + conformance suite that make "did behaviour change?" deterministic). Implementation follow-on: `2785` (`blockedBy` #2771) splits the roster in `we:gate-config.mjs` + `we:review-escalation.mjs` and adds the codify-shape exemption in `we:scripts/pr-land.mjs`. relatedTo #2625 #2307 #2636 #2563 #2445 #2573.

---

### Stop-the-line: the conveyor orchestrator never absorbs a non-mechanical case {#orchestrator-stops-line-never-absorbs}

**Ratified 2026-08-02 by the operator (Nicolas Gilbert) (#2851).** The conveyor orchestrator — the main session driving the mechanized delivery tick — is a **mechanical conveyor, not smart glue**. It must **never absorb a non-mechanical case to keep delivery moving**: quietly doing by hand the case the mechanic couldn't handle *feels* like progress but hides the gap and perpetuates manual operation. On any case the mechanic can't handle the orchestrator **stops the line (Andon)** — it HALTS that delivery, **FILES the gap as its own item**, and the class is **mechanized, or explicitly routed to a human** ([#human-required-is-judgment-only](#human-required-is-judgment-only)), before that class flows again. Rationale: hidden glue is invisible manual work that never gets automated because it never gets counted; accept a short-term slowdown (one stopped delivery) to buy long-term mechanical speed (the whole class runs itself next time). The mechanical clearers a stopped line hands off to are the [fix↔review convergence loop](#fix-review-convergence-independent-root-cause) and the [deterministic oracle](#deterministic-oracle-clears-slice); only genuine judgment goes to a human.

**Lineage:** ratified by #2851 (operator, 2026-08-02). Composes the three sibling anchors — [#human-required-is-judgment-only](#human-required-is-judgment-only), [#fix-review-convergence-independent-root-cause](#fix-review-convergence-independent-root-cause), and [#deterministic-oracle-clears-slice](#deterministic-oracle-clears-slice) — into one stop-the-line (Andon) cluster; the Andon framing is the operator's stated principle, not a prior rule.

---

### Human-required means judgment, not convergent review {#human-required-is-judgment-only}

**Ratified 2026-08-02 by the operator (Nicolas Gilbert) (#2851).** A human gate is reserved for **genuine judgment** — the `review:human` trigger set [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771) owns. This anchor does **not** re-list those triggers (see that rule for their exact wording); it only draws the judgment-vs-convergent-review distinction *inside* the boundary #2771 already draws. **Composes with — does not alter — [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771):** that rule owns the script-decidable trigger set and the leash-vs-derivation-code split; this anchor adds no trigger and re-draws no split. What it contributes: **convergent review is not judgment.** Iterating on a reviewer's findings until the diff is clean is **MECHANICAL** — the criteria are known, the loop terminates, and no new call is created each round. Convergent fix/review therefore runs as the [fix↔review convergence loop](#fix-review-convergence-independent-root-cause), never as a standing human step. Treating convergent review as human work is exactly the "smart glue" a [stopped line](#orchestrator-stops-line-never-absorbs) is meant to eliminate: it converts a mechanizable loop into permanent manual labour. The test is "does clearing this require a *new* call a person alone can make?" — if yes, human; if it is only "apply the known bar until green," it is mechanical.

**Lineage:** ratified by #2851 (operator, 2026-08-02). Composes with — does not alter — [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771, resolved — the three `review:human` triggers and the declarative-leash / derivation-code split) and [#agent-convergence-independent-validation](#agent-convergence-independent-validation) (#2398, resolved — a builder never clears its own diff).

---

### Fix↔review convergence loop — independent reviewer, root-cause every round {#fix-review-convergence-independent-root-cause}

**Ratified 2026-08-02 by the operator (Nicolas Gilbert) (#2851).** The **target mechanical clearer** for `review:pending` and for the gate-self derivation-code branch that [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771) routes to the independent committee **script-decidably**. This anchor only *names* that loop; it does not re-list #2771's leash-vs-derivation-code file roster (see #2771 for the exact paths) and adds no prose "non-judgment" predicate over it. **Composes with — does not alter — #2771.** **The path narrowing is live; the independence check is not:** #2771's implementation #2785 is now `status: resolved`, so the live gate reads `humanRequired = leashFiles.length > 0 || statuteFiles.length > 0` (`we:scripts/lib/review-escalation.mjs`) — only the **declarative-leash** half of the policy tier plus every statute touch still park `review:human`, while the derivation half routes to the independent committee (`gate-derivation` → `clearance: agent`, `we:scripts/lib/review-policy.contract.json`, where `gate-self` and `statute` keep `clearance: human`). What #2785 did **not** bring is the independence check below. Until that is enforced, **routing to `review:human` remains the interim rail for the branches that still carry it** — this loop does not yet auto-clear them. Three invariants govern the loop once it does:

1. **Independence rests on a distinct fresh validator — this anchor APPLIES that bar to the conveyor (target state; enforcement build-pending).** [#agent-convergence-independent-validation](#agent-convergence-independent-validation) (#2398, resolved) sets the non-author invariant: peer-agreement is not validation, so independence rests **entirely on a distinct fresh validator** — adversarial persona, rubric-anchored verdict, fresh context, given diff+tests+rubric only. #2398 permits that validator to be an **in-process role-separated subagent**, *provided* it has that fresh context. This anchor **applies** #2398 to the conveyor's stop-the-line context — it does not tighten the bar: *the same orchestrator wearing a reviewer hat*, a subagent sharing the orchestrator's live priors, is exactly the non-fresh-context case #2398 already rejects, so it does not clear. The stop-the-line contribution is naming the orchestrator-as-its-own-reviewer as that rejected case and driving its ENFORCEMENT (below); the bar itself is #2398's, unaltered. (#2439, resolved, ships the interim independence rail — the distinct fresh-context validator plus the `redteam:accepted` acceptance label — it is **not** a ruling that same-orchestrator subagents fail independence.) **Build-pending — not yet current fact:** no label, PR field, or gate records the reviewer's session/service identity today, and current reviewers are same-orchestrator subagents given fresh context (#2398-compliant but unverified — nothing checks the fresh-context claim). The enforcement — the clearing actor writes its id into the verdict, and the land seam refuses a clear whose reviewer id equals the author's — is **still owed**: it was filed against the conveyor-mechanization line (#2840 — narrow gate-self to principle-surface; #2785 — the narrowed-rubric build), and both of those have since resolved without building it, so it stands as an outstanding prevention on #2851 while **#2853 re-points this sentence at the items that actually own the work**. Until it lands, this invariant is the state the loop is built toward; the interim rail (route to `review:human`, above) holds meanwhile.
2. **Every round addresses root cause.** Each pass **DIAGNOSES AND ADDRESSES THE ROOT CAUSE** (prevention-introspection — the #2823 discipline that every review round generalize its finding to the class), never a surface patch that leaves the defect class live.
3. **Escalate only on judgment or deadlock.** The loop escalates to a human **ONLY** on **non-convergence** (the round cap is hit) or a **genuine-judgment finding** (a novel fork surfaces mid-review) — the [#human-required-is-judgment-only](#human-required-is-judgment-only) boundary. A clean convergence never touches a person.

**Lineage:** ratified by #2851 (operator, 2026-08-02). Composes with — does not alter — [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771, resolved — the leash-vs-derivation split this loop clears the derivation branch of; its implementation #2785 is `status: resolved`, so the split is ruled and live). **Composes with — applies (does not alter)** [#agent-convergence-independent-validation](#agent-convergence-independent-validation) (#2398, resolved — independence rests on a distinct fresh validator, in-process role-separated subagents allowed): invariant 1 applies that bar to the conveyor — the orchestrator wearing a reviewer hat is #2398's own non-fresh-context reject case — and cites #2398's actual sentence rather than restating a stricter one. Cites #2439 (resolved — the distinct fresh-context validator + `redteam:accepted` interim rail). Invariant 2 applies the prevention-introspection review discipline (#2823, still `status: active` — cited as the discipline this loop adopts, not settled precedent). The independence-enforcement and reviewer-id checks are **still owed** — filed against #2840/#2785, both since resolved without carrying them — and stand as outstanding preventions on #2851 pending #2853's re-point.

---

### The converge editor may push at care `low` only — every other band is review-only, and an unresolvable band fails closed {#converge-editor-enabled-at-low-only}

**Ratified 2026-08-08 by the operator (Nicolas Gilbert) (#2908).** The convergence loop's **editor** — the subagent that rewrites the diff and pushes to the author's branch — may push at care band **`low`, and nowhere else**. `elevated`, `high`, `none` and any band that cannot be resolved are **review-only**: the panel still runs and its findings still reach the operator, but the author's branch is left untouched. **Mechanical fixes get repaired and re-judged; anything carrying a blast-radius or trust-chain signal gets a report and a person.** `elevated` is excluded **on evidence, not on caution** — it is the band of the loop's one observed editor failure (PR #1018: a 15-file "repair" that the next round faulted three ways, including a fail-open in the very gate the fix had just written). **The gate reads the RESOLVED band the panel already dialed** (`careLevelFromReasons` → one band → both `panelRigorForCareLevel` and `editorPolicyForCareLevel`) — ONE derivation, so there is nothing for a second one to drift against — and it is the ONLY door to the editor step. **Where that band arrives across an agent boundary it is not taken on trust: an agent may VETO the editor, never GRANT it.** In the parked-PR loop the band is echoed back by the rigor agent, so the loop additionally re-derives the enablement from the escalation reasons it holds itself, and derives the round budget from `EDITOR_MIN_ROUNDS` rather than from the echoed number — every conjunct must say yes. **The gate is also evaluated on EVERY round, not only at loop start:** a juror invite (#2640) that raises care mid-run turns the editor off for the rest of that PR. **Rider — enablement and round budget are ONE decision, carried on a DEDICATED knob.** An editor-enabled band needs **≥ 2 rounds** (one to push, one for a fresh panel to judge the push): at `roundCap: 1` the loop forces `escalate` before the editor step is reached (`we:scripts/workflows/review-parked-prs.mjs`), and a push no panel re-read would break the loop's invariant that a `land` means a non-author panel signed off the final diff. That minimum lives on `EDITOR_MIN_ROUNDS` / `editorPolicyForCareLevel` (`we:scripts/lib/jury-core.mjs`) and **must never** be bought by raising `panelRigorForCareLevel`'s `low` entry — that dial is shared with `/jury`, `/review` and `/converge`, so raising it would silently double every other consumer's round budget to buy a property only this loop needs. The shared dial stays at `low` = 1 panel round. **FAIL CLOSED.** An absent, malformed or unresolvable care level means **review-only**, never editor-on. This is load-bearing: the escalation-reason list reaches the loop through a fetch agent and fails open to `[]`, and the loop's only statute signal is that reason prose — so an empty reason list must read as "the signal did not arrive", never as "no signals fired". **`[]` is ambiguous, not merely broken, and that is why it fails closed rather than resolves.** It has two producers the loop cannot tell apart: a degraded read, and a genuinely reason-less parked PR — `pr-land.mjs --park=review:pending` (#2622) applies the review label **at open** and writes no `## Escalation reason` block at all (the block is appended only on the separate `scoreEscalation` verdict path, and `buildEscalationReasonBlock([])` returns `''`). *It is therefore NOT true that a parked PR always has a reason* — that claim is withdrawn, and the rule does not rest on it. **The consequence is accepted deliberately: a `--park=review:pending` PR opened with no reason block is permanently review-only — its panel runs and its findings reach the operator, it is simply never machine-edited.** Before this rule the `low`/1-round fallback protected against the degraded-read case **by accident** (the editor was unreachable at `low` anyway); giving `low` its 2-round floor removes the accident, so the protection has to be deliberate. **Mutating someone else's branch is not reversible from their side.** **Care is still advisory for RIGOR.** Blast-radius, size, cross-repo and dismissed-findings raise how hard the panel looks and, separately, whether a machine may write to the branch; they do **not** park a PR for a human. Diff size still never routes to the operator by label (#2563, PR #1095). **Exhaustively, what reaches the operator:** a review-only band whose panel wants changes; loop **deadlock** (rounds spent, panel still at `changes`); loop **breakage** (the editor could not push, a mandatory correctness/security lens did not run, or the diff could not be fetched — a dead reviewer never reads as an accept). Prevention strategies for the last two are **out of scope of this rule** and filed separately.

**Lineage:** ratified by #2908 (operator, 2026-08-08), implemented in PR #1106. The prepared default ("editor at `low`, review-only above") was first **withdrawn as unimplementable** — `low` carried a 1-round cap, so it selected the one band where the editor cannot run — and its repair **(c′)** (bind to the band, give `low` two rounds on a dedicated knob) was then withdrawn mid-turn on a diff-size challenge, in favour of **(d)** "editor everywhere except a `humanRequired` diff". **The operator reversed that and ratified (c′).** (d) was **looser, not narrower**: `deriveCareLevel` forces `high` on `humanRequired`, so `{humanRequired} ⊊ {high}` and (d) left the editor ON at `elevated` and at non-`humanRequired` `high` — including the exact band of the observed failure. (d)'s insight — a machine editing its *own constraints* is the sharpest conflict of interest — is **preserved**, because statute and declarative-leash diffs are forced to `high`, which is review-only: every diff (d) would have excluded is excluded here too, and then some. The diff-size challenge is answered on #2908 rather than deleted: what #2563/#1095 bar is size *parking a PR for a human by label*, and a review-only band still gets the full AI panel — the band decides whether a **machine writes to the branch**, which is a different question from who reviews. Grounded in the loop's first real run, PR #1018 (`care: elevated`): 16 agents, 1.08M tokens, 56 minutes, nothing cleared, and a branch handed to a human with a self-inflicted defect. Composes with [#fix-review-convergence-independent-root-cause](#fix-review-convergence-independent-root-cause) (#2851 — escalate only on judgment or deadlock), [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771), [#human-required-is-judgment-only](#human-required-is-judgment-only) (#2851) and [#blast-radius-advisory-care-not-a-gate](#blast-radius-advisory-care-not-a-gate) (care stays advisory for the park-gate; this rule adds a SECOND, separate use of the same resolved band — the editor gate — and does not turn it into a routing dial). Mechanisms: `we:scripts/workflows/review-parked-prs.mjs` (the gate + the fail-closed `careRigorFor`), `we:scripts/lib/jury-core.mjs` (`editorPolicyForCareLevel`, `EDITOR_ENABLED_CARE_LEVELS`, `EDITOR_MIN_ROUNDS`), `we:scripts/lib/review-core.mjs` (`editorPolicyFromReasons`, and the loop guards `editorAllowedByReasons` / `editorMayPush` / `growOnlyCareLevel`), `we:scripts/review-core-cli.mjs` (`rigor --json` prints the `editor` block), `we:scripts/fetch-parked.mjs` (the bundle carries a DETERMINISTICALLY parsed `escalationReason` — `parseEscalationReason`, `we:scripts/review-detail.mjs` — so the band is never re-read out of prose by an agent).

---

### A slice with a deterministic oracle is cleared by the oracle, not a human {#deterministic-oracle-clears-slice}

**Ratified 2026-08-02 by the operator (Nicolas Gilbert) (#2851).** When a slice carries a **deterministic acceptance oracle** — a test whose green/red is unambiguous — a **GREEN oracle mechanically clears the slice**. No human verification is owed once such an oracle exists and is green: verifying a deterministic pass/fail is not judgment ([#human-required-is-judgment-only](#human-required-is-judgment-only)), it is reading the result. The `human-verify` tag on such a slice applies **only until that oracle exists** — its purpose is to hold the slice while the acceptance criterion is still a matter of human eyeballing, and it retires the moment the criterion becomes a deterministic check. (`human-verify` is a documented convention today with **no code reader** — the retirement is a prose discipline; a gate that observes it is an outstanding prevention on #2851 — still owed, filed against the #2840/#2785 line, both since resolved, pending #2853's re-point.)

**Anti-self-clearing (inherits [#agent-convergence-independent-validation](#agent-convergence-independent-validation), #2398).** A green oracle clears a slice **only when that same slice did not author or relax the oracle**. The slice that writes or weakens an acceptance oracle is **never** cleared by that oracle's own green — that is the #2398 anti-test-gaming guard, whose actual clauses are: test/oracle files read-only to the author peers (or any test change diff-gated), the land fails if coverage drops or tests are removed/skipped, a logic fix must carry a test that fails on the pre-change behaviour, and the validator inspects for tampering. Absent that independence a green is consensus with oneself, not validation, and the slice escalates. (Registering acceptance-oracle files as spec-tier so weakening one is gate-visible, and a non-author signal on the oracle diff, are the **owed** enforcement here — outstanding preventions on #2851, not present #2398 guards.)

**Intended endpoint (not yet a settled precedent).** The in-flight console-board render-slice work aims to build exactly such an oracle: #2811 (the real-route render-slice conformance test, still `status: active` / `human-verify` on `main`) is the oracle being made deterministic, and #2834 (the console-board remediation, also `status: active`) is the slice meant to flip it RED→GREEN. Neither is resolved on `main`, so this rule states the **principle** ahead of the first slice that lands it — it does **not** assert #2834 as already cleared by an oracle. That RED→GREEN transition — "a person must look" becoming "the oracle is green" — is the mechanization endpoint a [stopped line](#orchestrator-stops-line-never-absorbs) drives toward.

**Lineage:** ratified by #2851 (operator, 2026-08-02). Composes with — does not alter — [#agent-convergence-independent-validation](#agent-convergence-independent-validation) (#2398, resolved — the deterministic-gate + anti-test-gaming rule this anchor inherits; the non-author signal is owed, not one of its present clauses). Names #2811 and #2834 as the in-flight case it looks toward (both `status: active` / `human-verify` — cited as intended endpoint, not settled precedent). A `human-verify`-retirement gate and the oracle-authoring non-author signal are outstanding preventions on #2851 — **still owed**, filed against the conveyor-mechanization line (#2840/#2785), both since resolved without carrying them, pending #2853's re-point.

---

### Principle change and its implementation never travel in one diff — the two-PR rule {#principle-and-impl-two-pr}

**Ratified 2026-08-02 by the operator (Nicolas Gilbert) (#2839).** A single diff may **never** touch both a **principle surface** and **implementation code**. A **principle surface** is defined canonically by [#human-is-principle-surface-not-path](#human-is-principle-surface-not-path) (#2840); this split gate's `assertNotPrincipleAndImpl` evaluates that definition at ONE grain — the **edit of a pre-existing guarantee**: a statute-anchor rule-text edit, or an edit / removal of a `@principle`/`@invariant` marker already present on the base version of the file. It does NOT evaluate at the `POLICY_SPEC` whole-file floor — that floor is the *escalation* gate's membership (#2840 trigger 3), not the split gate's — so a routine impl PR that adds a gate rule AND updates its `POLICY_SPEC` conformance test is never refused as "both". Implementation is executable code — *including adding a brand-new marked invariant that enforces an already-ratified principle, or touching a `POLICY_SPEC` conformance suite to add a new gate assertion* (both are `implTouch`). Authoring or weakening a principle is the **human** step: it lands FIRST, in a decisions-only PR the operator ratifies (`review:human`). Enforcing that ratified principle in code is the **mechanical** step: it lands SECOND, in a follow-on impl PR the independent committee clears, and that impl PR must cite a `codifiedIn:` anchor already `status: resolved` on `main` — so an enforcing invariant can never precede the ruling it enforces. **Crucial grain:** *adding* a new marked invariant is impl (it enforces a ruled principle), while *editing or removing* a marked assertion already present on the base is the principle touch — the distinction is computed base-vs-head, which is why the prescribed impl PR is never mis-refused as "both". This very decision is authored under its own rule: it rides a decisions-only PR carrying zero enforcement code; the write-time `assertNotPrincipleAndImpl(changedFiles, diffHunks)` gate (plus the sequencing check) that enforces it is a separate impl follow-on.

**Lineage:** ratified by #2839 (operator, 2026-08-02). Extends [#human-required-is-judgment-only](#human-required-is-judgment-only) (#2851 — the human step is judgment: authoring or weakening a principle, not mechanically enforcing one) and the codification split of [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771 — mechanically codifying an already-ruled call is committee work). Structural precondition for [#human-is-principle-surface-not-path](#human-is-principle-surface-not-path) (#2840) and [#enforce-flip-triple-gated](#enforce-flip-triple-gated) (#2838), ratified together in this pass. Enforcement placement mirrors the write-time `PreToolUse(Edit|Write)` deny gate (memory rule #43) and the shared-gate shape of `we:scripts/lint-locus-prefix.mjs`; the gate itself is a follow-on impl PR under this very rule.

---

### review:human fires on a principle surface, not on a trust-chain file path {#human-is-principle-surface-not-path}

**Ratified 2026-08-02 by the operator (Nicolas Gilbert) (#2840).** A human is required for a **principle**, not for the implementation that carries it. `review:human` therefore fires on a **principle surface** — **the canonical definition of that term for the whole governance cluster** (the two-PR rule [#principle-and-impl-two-pr](#principle-and-impl-two-pr) cites this one, it does not restate a narrower set) — the union of three triggers: **(1)** a **statute-anchor edit** that adds, removes, or alters a `### … {#anchor}` rule heading or its ruling body in this document (a whitespace / reflow / typo touch that changes no rule text no longer fires); **(2)** an edit to a `@principle`/`@invariant`-marked assertion **already present on the base version of the file** — editing an encoded guarantee is editing the principle, while *adding* a new marked invariant is implementation per [#principle-and-impl-two-pr](#principle-and-impl-two-pr); and **(3)** the **declarative-leash path floor** — every `POLICY_SPEC` file (the policy contract, the roster, the invariant / conformance suites) stays human-gated as a whole file, **permanently pinned**, because those files *are* the encoded principle and have no behaviour-preserving edit. A trust-chain file that carries no marked guarantee this diff still ESCALATES, but routes to the independent committee, not a human: behaviour-preserving impl is mechanical. This extends #2771 / #2785's path narrowing with an orthogonal *guarantee* axis; the human trigger is a superset of the **post-#2785** path gate — not of today's whole-file statute gate — and the one intended narrowing is the **statute term**, from whole-file to rule-text edits (a whitespace / reflow / typo touch to this document no longer fires). Every other axis only *adds* human-gating above the post-#2785 line, so the transition is safe with no per-file "until-encoded" race. The `isPrincipleSurface(changedFile, diffHunks)` composition, the producer-side `diffHunks` plumbing, the leash-pin `check:standards` rule, and the first `@principle` invariants are a separate impl follow-on under the two-PR rule.

**Lineage:** ratified by #2840 (operator, 2026-08-02). Mechanizes [#human-required-is-judgment-only](#human-required-is-judgment-only) (#2851) on the review gate and **extends** [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771 — narrowed the gate by *path* to the declarative leash; this adds the *edit / guarantee* axis on top), composing [#fix-review-convergence-independent-root-cause](#fix-review-convergence-independent-root-cause) (#2851 — the mechanical clearer the shed behaviour-preserving work routes to). Depends on impl #2785 (the base `POLICY_SPEC` path narrowing, `status: resolved` — landed), and on the shared producer-side `diffHunks` plumbing. Current mechanism it replaces: `we:scripts/lib/review-escalation.mjs#isGateSelfPath`, `we:scripts/lib/gate-config.mjs#isPolicyCorePath`. Composes with [#principle-and-impl-two-pr](#principle-and-impl-two-pr) (#2839) and [#enforce-flip-triple-gated](#enforce-flip-triple-gated) (#2838).

---

### The review-seam enforce-flip (`landMode: shadow → enforce`) is triple-gated and defaults closed {#enforce-flip-triple-gated}

**Ratified 2026-08-02 by the operator (Nicolas Gilbert) (#2838).** The scheduled review runner may clear `review:pending` **mechanically** — writing `review:accepted` so the drain merges — **only** once the global `careJury.disposition.landMode` flips from `shadow` (observe-only) to `enforce`. That flip is the ONE switch that reduces human oversight, so it is gated by a readiness predicate, `enforceFlipReady({ ciStatus, reviewShadowLedger })`, that arms `enforce` only when **ALL THREE** hold: **(a)** the #2820 merge-hold conformance test is GREEN on `main` (a `review:*` hold label blocks merge regardless of `ready-to-merge`), read via a live **CI-status probe**, not a vacuous file-exists check that would pass once the test file merely exists; **(b)** the #2823 prevention-field conformance test is GREEN on `main` (every finding-bearing review emits its prevention-introspection block), likewise probed; and **(c)** a **durable review-seam ledger** shows a clean shadow-mode track record — N consecutive shadow-vs-human agreements with 0 divergences over the trailing window (the proven `computeAgreementMetric` bar), a single divergence resetting it. Until the flip, the seam runs in shadow: it computes the would-clear decision and logs it, but a human still clears every `review:pending` PR. Anything not exactly `enforce` normalizes to shadow, so an unset / unknown / corrupted mode fails safe to observe-only. The flip edit is itself **`review:human`** — `landMode` lives in the declarative-leash contract, kept human-gated as a whole file by [#human-is-principle-surface-not-path](#human-is-principle-surface-not-path)'s pinned floor — so a person makes the call the machine merely *permits*. The predicate, the CI-status probe, the durable ledger, and the `landMode: enforce` write gate are a separate impl follow-on under the two-PR rule.

**Lineage:** ratified by #2838 (operator, 2026-08-02). Composes [#human-required-is-judgment-only](#human-required-is-judgment-only) (#2851 — mechanical convergent review need not stay human once the flip is safe) and reuses the shadow→enforce readiness *metric* `we:scripts/lib/decision-routing.mjs#computeAgreementMetric` / `resolveLandMode` (`ENFORCE_FLIP_TRIGGER`) plus the auto-land seam `we:scripts/lib/auto-land-seam.mjs#applyAutoLand` (the #2675 shadow default). **Load-bearing dependency on [#human-is-principle-surface-not-path](#human-is-principle-surface-not-path) (#2840):** the flip edit stays human-gated only because that rule *pins* the declarative-leash files as whole files — if the contract could leave the gate, the single most oversight-reducing edit would become agent-clearable. Preconditions of the impl follow-on: #2820 (PR #975) and #2823 (PR #976) landed (now true); the durable review-seam ledger built (today the seam only logs to stderr).

---

### A clean, independent verdict clears `review:pending` mechanically; `review:human` stays human-only {#review-pending-clean-verdict-mechanical-accept}

**Ratified 2026-09-01 by the operator (Nicolas Gilbert) (#3434).** The operator, mid this epic's own live-fire
test (real independent verdicts landing on real PRs all night): "I want the acceptance to be mechanical from
the verdict." This **reverses** the prior 2026-08-31 ruling encoded in `reviewLoopAutoConfirm`
(`we:scripts/lib/review-loop-policy.mjs`), which forbade an unattended AGENT-addressed run from ever
answering `accept` — found live, against two real PRs (`#1764`, `#1765`) that reduced to a clean `accept` and
sat queued for a human for no reason but that refusal. **New rule:** when a genuinely independent verdict on a
`review:pending` PR comes back a clean `accept`, the mechanism records `review:accepted` unattended and lets
the drain land it — no human step, full stop, for that tier. **`review:human` is UNCHANGED** — "yes review
human are for human" (operator, same conversation): that tier's human-only ceremony (`--to=clear-human`) is
untouched: `reviewLoopAutoConfirm`'s own actor check declines a `review:human`-addressed confirm before the
accept branch is ever reached, so the tier structurally never sees this rule at all. **`prevention-outstanding`
gets its own branch, not the bounce/retry loop.** The `VERDICTS` enum (`we:scripts/lib/jury-core.mjs`, #2823)
has a fourth member for the case where every real finding is already fixed but a finding's own "Prevention
(OWED — file it)" note was never filed as its own item — `reviewLoopAutoConfirm` used to fold that into the
generic `changes` answer, bouncing and retrying a PR whose code has nothing wrong with it (the exact thing
`#1764`/`#1765` suffered, repeatedly, the night this was ratified). Ruled: file the named prevention(s) first
(reusing the file-then-notify shape `buildAcceptQueueEntry` already established), THEN treat the PR as
accept-worthy — never re-enter the bounce loop over a documentation debt the code itself doesn't have.

**A distinct mechanism from the enforce-flip above — not a loosening of it.**
[#enforce-flip-triple-gated](#enforce-flip-triple-gated) (#2838) gates a *different* code path — the
**scheduled shadow review runner**'s `landMode` (`we:scripts/lib/auto-land-seam.mjs` /
`we:scripts/lib/decision-routing.mjs`), which stays `shadow`-default and triple-gated exactly as ruled there.
This rule governs the **live dispatched review-loop's own unattended-confirm seam**
(`we:scripts/operations/review-loop-cli.mjs` → `review-pr.mjs` → `reviewLoopAutoConfirm`) — a narrower,
already-independent verdict-driven confirm, not the scheduled runner's broader auto-land sweep. The two compose
without conflict: neither reads the other's gate, and nothing here arms or bypasses `landMode`.

**Lineage:** ratified by #3434 (operator, 2026-09-01). Item 1 (the `accept` branch, `reviewLoopAutoConfirm`)
shipped in PR #1768. Items 2-4 — the `prevention-outstanding` branch (#3442, `PREVENTION_QUEUE_AREA`),
updating `we:skills-src/review/review-agent-brief.md`'s "never resume yourself" instruction to scope to
`review:human` only, and reconciling [#3433](/backlog/3433-technically-enforce-review-dispatch-s-never-self-accept-neve.md)
(re-scoped, not superseded: narrowed to `review:human`'s never-self-accept and never-merge on both tiers, since
this rule removed `review:pending`'s self-accept as a thing to harden against) — shipped in PR #1784, with
`#3433`'s own narrowed technical enforcement (a `--disallowedTools` deny list baked into every dispatched
review session's argv) landing separately in PR #1829. Composes with
[#agent-convergence-independent-validation](#agent-convergence-independent-validation) (#2398 — the independence
this rule leans on rests on a distinct fresh validator, unchanged by this ruling) and
[#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771 — defines what stays
`review:human`; this rule never touches that boundary, it only removes the human step from the tier that was
never `review:human` to begin with).

---

### `clear-human` refuses unless an independent advisory review has already posted for the PR's current head {#clear-human-requires-current-head-advisory-review}

**Ratified 2026-09-14 by the operator (Nicolas Gilbert) (#3589).** PR #2011 (`WE #3174`, a ratify+codify
touching the declarative-leash/statute surface) was parked `review:human` by the escalation rubric; the
operator said "I approve 2011", the session ran `we:scripts/review-set-label.mjs --to=clear-human` (the
sanctioned #2895 ceremony), and the drain landed it **before** the independent `advise` step's (#3453)
advisory-note comment had posted — the one clearance, of five that same night, where the operator's own
approval outran the mechanism. **This was a race, not a design choice: nothing in `clear-human`'s
preconditions ever checked whether that advisory note existed.** Two rulings close it:

1. **Scope — every `clear-human` clearance, no sub-scoping.** `review:human` is already the narrow,
   high-blast-radius tier by ratified design ([#review-human-declarative-leash-only](#review-human-declarative-leash-only),
   #2771/#2840): a statute-anchor edit, an edit to an already-present `@principle`/`@invariant` marker, or the
   declarative-leash path floor. There is no larger population within that tier to protect against by
   sub-scoping a narrower incident-shaped subset — the leash-contract / gate-config / conformance-suite files
   the tier also catches are at least as sensitive as a statute-anchor prose edit.
2. **Mechanism — a precondition, not a relabel.** `clear-human`'s decision function
   (`decideSetLabel`'s `clear-human` target, `we:scripts/review-set-label.mjs`) MUST gain ONE more guard,
   the same shape as its existing `--actor`/`--reason` honesty-tax checks: it refuses unless the PR already
   carries the `advise` step's advisory-note comment for its **current** head. An absent note refuses with
   the fix named — dispatch `we:scripts/operations/review-dispatch.mjs --pr=<n>` (or wait for the next
   conveyor tick, which already auto-dispatches `advise` for every `needs-review` PR), then retry. Nothing
   about `advise`, `we:scripts/operations/review-dispatch.mjs`, or the conveyor's existing dispatch cadence
   is meant to change — this is specified as a refusal-with-actionable-fix, never a synchronous
   dispatch-and-block: blocking a CLI call for the minutes a real independent review takes would be exactly
   the passive-wait shape this repo's own agents are barred from sitting on. The clearing operator (or
   session) keeps full authority to clear over real findings — the note only has to have **posted**, not be
   acted on — because the incident was about ordering, never about overruling the operator. **This guard is
   RULED here; no implementation of it exists anywhere in the codebase** — see the Residual paragraph and
   Lineage below for exactly what code this ratification obligates and where that obligation is tracked.

**Config posture (not a third ratified fork — a config dimension, both values legitimate end-states):** the
precondition is gated by a `WE_REQUIRE_REVIEW_AFTER_OPERATOR_CLEARANCE`-style env var (name TBD at build
time, the existing `WE_MERGE_BREAK_GLASS` convention, `we:scripts/merge-ai-prs.mjs`), **operational default
ON.** The night of the incident, 4 of 5 `clear-human` clearances already had the advisory note land first —
"on" asks nothing new of the common case and only makes the ordering that already usually holds guaranteed;
an operator in genuinely time-sensitive incident response is one flag away from the old fast path.

**Residual — build status lives on the follow-on item, not this rule (#2854):** `we:scripts/review-set-label.mjs`'s
`decideSetLabel` carries no advisory-note check of any kind, coarse or exact, until the follow-on item below
ships it — this anchor rules what `clear-human` must do, it does not claim any of it runs. That build owes
two things, in order: first, the guard clause itself (an absent-note refusal); second, an exact "is this the
CURRENT head's note" test, which depends on `renderAdvisoryNote` (`we:scripts/operations/review-pr.mjs`)
gaining a durable per-head marker (an `<!-- advisory-sha: … -->` marker, mirroring `buildReviewedShaMarker`
in `we:scripts/lib/review-escalation.mjs`). The ratified, accepted interim shape — usable between those two
steps landing — is a coarser "does any advisory comment exist" proxy: a PR force-pushed after its note would
pass it on stale grounds, a real but narrower gap than having no guard clause at all. Neither the guard nor
the marker is built in this ratifying PR (see Lineage) — this decisions-only PR ships zero code.

**Lineage:** ratified by #3589 (operator, 2026-09-14; bornAs `3589`, prepared 2026-09-14 — Screen pass +
review jury charter, filed on PR #2011's own incident). Cites [#review-human-declarative-leash-only](#review-human-declarative-leash-only)
(#2771/#2840 — the `review:human` trigger set this rule's scope leans on being already narrow) and
[#review-pending-clean-verdict-mechanical-accept](#review-pending-clean-verdict-mechanical-accept) (#3434 —
the sibling `review:pending` tier this rule does not touch; `clear-human`'s human-only ceremony stays
human-only). Implementation follow-on: the guard clause in `we:scripts/review-set-label.mjs`, the
`advisory-sha` marker in `we:scripts/operations/review-pr.mjs`, and the config toggle — filed as `3692`
("Gate `clear-human` on a posted advisory review for the current head"), `blockedBy` nothing (ratified in
the same lane it was filed from), numbered on land.

---

### A proven self-authored `review:pending` PR clears through `clear-operator` — `clear-human`'s twin one tier down, gated to a proven self-clear {#clear-operator-proven-self-clear-only}

**Ratified 2026-09-21 by the operator (Nicolas Gilbert), Fork 1(a) approved as prepared, no amendment
(`#3048`).** An operator's verbal approval of a PR whose author actor is the approving session itself had **no
recording route**: `--to=accepted` refuses as a self-clear (#2439/#2398), and `--to=clear-human` refuses
because the PR carries `review:pending`, not `review:human` — the human-ceremony exemption exists only one
tier up. Two ways to close the gap were forked; only one is ratified.

1. **Mint `clear-operator`.** `REVIEW_LABEL_TARGETS` (`we:scripts/review-set-label.mjs`) gains a
   `'clear-operator'` member. `decideSetLabel` grows a branch parallel to the existing `clear-human` one, keyed
   on `REVIEW_LABELS.pending` instead of `REVIEW_LABELS.human`: label-shape only, refused when the PR does not
   carry `review:pending`, otherwise clearing it to `review:accepted` (never touching `review:human` —
   INVARIANT 2 stays untouched).
2. **Gated to a PROVEN self-clear, never a general bypass.** `review:pending` is the default parked state
   nearly every PR passes through, unlike the rare `review:human` label `clear-human` guards — so
   `clear-operator` reuses the same `decideClearerIndependence` call `--to=accepted` already makes, but
   **inverts** the requirement: `clear-operator` is refused **unless** independence reads `SELF_CLEAR`. This
   keeps its blast radius scoped to exactly the reported gap; it can never be used on a PR someone else
   authored.
3. **Inherits the existing honesty tax, unchanged.** `--actor=<name>` and a quoted `--reason=<...>` stay
   mandatory and are posted verbatim, exactly as `clear-human` already requires. The durable comment gains a
   **third** phrasing alongside "a human ceremony cleared it" / "an established-independent agent cleared it":
   *"an operator ceremony cleared it (review:pending tier, proven self-authored)"*.
4. **The residual is pre-existing, not new.** The unforgeable-actor-signal gap `#2895` already deferred to
   `#2946` applies here unchanged — `clear-operator` grants no capability an unforged `--to=accepted` call
   didn't already grant, so no new residual is introduced at this tier.

**Rejected — (b) auto-escalate self-authorship into `review:human`.** Adding self-authorship as a third
`humanRequired` trigger in `scoreEscalation` (`we:scripts/lib/review-escalation.mjs`) would re-litigate
[#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771), which closed the
`review:human` trigger set at exactly three members and explicitly rejected "an agent might be policing its
own leash" — the same structural case as an actor clearing its own PR. Widening that closed set, or amending
the ratified statute outright, is a larger decision this item has no authority to make on its own; (a) never
touches that boundary.

**What this ruling does not do.** It builds nothing (no `clear-operator` branch, no independence-inversion
check, no new comment phrasing) and changes no gate by itself; the build is separately-scoped follow-on work
tracked on the backlog.

**Lineage:** ratified via `#3048` (2026-09-21), grounded in the item's own prior-art check against
`we:scripts/lib/gate-config.mjs`'s `TRUST_CHAIN` and `we:scripts/lib/review-policy.contract.json`; re-validated
for currency at ratification (statutes #3434/#3589 ratified since prep compose without conflict; the item's
`file:line` citations had drifted from unrelated commits but the underlying mechanism they describe was
unchanged) and re-attacked by a fresh independent skeptic pass, which found nothing that survived. Composes
with — does not alter — [#review-human-declarative-leash-only](#review-human-declarative-leash-only) (#2771,
the trigger set (b) would have widened) and
[#review-pending-clean-verdict-mechanical-accept](#review-pending-clean-verdict-mechanical-accept) (#3434, the
sibling mechanical-accept path for a genuinely independent verdict — orthogonal, since this rule's gate fires
only on `SELF_CLEAR`, never on independent review). Full reasoning and the rejected option:
[#3048](/backlog/3048-an-operator-approval-has-no-recording-route-on-a-self-author.md).

---

### A learning is admitted to agent memory by verified grounding; recurrence diagnoses and ranks, never admits {#memory-admission-verified-grounding}

**Ratified 2026-08-08 by the operator (Nicolas Gilbert) (#2978).** The learnings pipeline **consolidates and prioritizes**; it is not an authentication checkpoint and no human stands in its path. Four rules, ruled together because each makes the next affordable. **(1) Admission is verified grounding, plus the red-team.** A note reaches agent memory only if it carries the **quoted grounding turn** plus a **transcript pointer**, and the harvest confirms the quote is really in that file — a check against a file the *harness* writes, not one the emitter controls. Grounding proves the **moment**, never the **merit**, so admission reads *grounded **and** survives the red-team*; a note that cannot be tied to a real moment routes to `we:backlog/`, never to memory. A **recurrence count may never gate admission**: `session` and `ts` are emitter-written, so counting authenticates nothing (four hand-written lines manufacture "2 sessions across 2 days"), and a recurrence bar structurally excludes the **one-off user directive** — the source that produced essentially the entire existing `feedback_*` corpus. **(2) Recurrence is a diagnostic signal first, a ranking key second.** N similar notes are evidence of **one cause with N symptoms**, so a cluster's output is a design-level **story naming that cause**, not N patches on a faulty design — and the cluster reaches synthesis with all its members, never an elected "representative" (which elects the best-described *symptom*). A single grounded note becomes a memory rule; a cluster becomes a backlog story. Those are different destinations. No admission floor: a one-session cluster is a real signal that merely sorts lower. **(3) While single-tenant, the pool entry carries the full evidence, uncapped** — storing the real context beats storing a digest and hoping it reconstructs, and cause-synthesis is impossible from a count alone. The secret/entropy scrub therefore **relocates rather than dies**: it moves from the *append* seam to the **publish seam**, because the pool is untracked machine-local state but harvest *output* is committed and pushed. Size limits belong on **what the harvest sends per cluster** (a model-context budget) — never on what is stored. **(4) The harvest fires on a cadence, with the manual command retained**, the two sharing one lock so a tick and a manual run cannot double-file; and a harvest **may defer** a cluster whose cause is not yet clear, re-emitting it to the pool with a reason and a deferral count rather than draining everything. A repeatedly-deferred cluster is itself a finding.

**Lineage:** ratified by #2978 (operator, 2026-08-08), superseding the recurrence-threshold admission gate built in #1068 (which is **shrunk**, not repaired — the sessions/days axes survive as ranking inputs; the admission floor, the `--min-sessions` gate semantics, and the prose defending them go). Grounded in the falsification that convened it: 4,481 session transcripts exist under the harness project directory, 4,477 modified within 30 days — faithfulness was never structurally impossible, the judge simply moved across a seam and left the evidence behind. Complies with `we:agent-memory-src/autonomous-loops-non-blocking-red-team-not-prompts.md` (the red-team is the reviewer; human oversight is retrospective) and applies [#deterministic-core-thin-judgment](#deterministic-core-thin-judgment) — verification and clustering are script-decidable, cause-synthesis is judgment. Mechanisms: `we:scripts/conveyor/learnings-drop.mjs` (append + scrub), `we:scripts/conveyor/learnings-dedup.mjs` (clustering, kept), `we:scripts/conveyor/learnings-harvest.mjs` (rank / archive / defer), `we:scripts/conveyor/tick-core.mjs` (the cadence hook). Does **not** close the failure class that convened it — a filter *weakened in place* rather than deleted is still caught by nothing; that hole needs its own item. Defers to #2610 (multi-tenant feedback channel) and records the schema migration as accepted cost.

---

### A statute anchor states only the timeless rule; point-in-time build status lives on the decision item and open guards, never in the anchor's prose {#statute-anchor-states-rule-not-status}

**Ratified 2026-08-17 by the operator (Nicolas Gilbert) (#2854).** A ratified rule is timeless; what is built
so far is not, so the two do not share a home. An anchor states the rule and remains cite-able authority that
should read the same in a year; build status — what is enforced today, what is still owed, which item retires
a gap — belongs on the backlog item and the open guards that already track it, linked by id, never narrated in
the anchor body. This is not a hypothetical risk: `#fix-review-convergence-independent-root-cause` grew
427 → 655 → 714 words (corpus median 324) in successive rounds asked to CUT duplication, specifically because
point-in-time status prose kept needing correction in place, and its own claims have already gone stale twice
in two weeks — at one point stating an enforcement gap the invariant catalogue had already recorded as closed.
Three mature rule-documentation systems (ADR, IETF RFC+errata, MDN/web-features Baseline) independently arrived
at the same separation; none hand-maintains "not yet built" prose inside citable rule text.

**What this does not settle.** A narrower, already-shipped mechanism — `we:scripts/lib/invariant-catalogue.json`
recording `status`/`owedTo`/an optional `anchor` back-link per catalogued invariant — could in principle
generalize from a curated catalogue to arbitrary anchor prose, closing the in-place-warning gap this ruling
otherwise leaves open. That generalization is **not ruled here**: it is a conditional follow-on, gated on
whether heuristically classifying free-text claims is reliable enough to trust (the anchor-validator already
measured that class of classifier at 5 false positives over ~117 clusters on a first pass) — a correctness
question for whoever picks it up, not assumed away by this ruling.

**Lineage:** ratified 2026-08-17 (operator; #2854), resolving Fork 1 of that item as (a) over (b) — inside the
anchor, as an earlier PR (#982) did, is the rejected branch. Fixes the shape of #2849 (a statute anchor-shape
lint) as a fully-derived consequence: for a catalogued operational invariant, #2849 needs no new mechanism
(`validateInvariantEnforcers`/#2844 already requires a real enforcer or an open `owedTo`); for uncatalogued
anchor prose, #2849 should error on point-in-time tokens (`today`, `not yet`, `build-pending`, `still parks`)
and direct the author to the item instead, with a transition exemption list for the ~15 pre-existing uses on
`main`. Composes with [#memory-admission-verified-grounding](#memory-admission-verified-grounding)'s own
practice of separating a ratified rule from its point-in-time enforcement mechanisms list, which this statute
now applies as an explicit, general rule rather than an implicit per-anchor habit.

---

### A large diff earns more reviewers, never fewer lines — size never refuses a PR, and the response to size is scoped fan-out {#size-adds-reviewers-never-refuses}

**Ratified 2026-08-26 by the operator (Nicolas Gilbert) (#3320).** Refines — does not alter —
[`#blast-radius-advisory-care-not-a-gate`](#blast-radius-advisory-care-not-a-gate) (#2563), whose clause 1
already forbids a scored signal from becoming a hard block with no reviewer. Cite both together.

**The ~400-line figure is an *attention* ceiling, and attention is the one property an agent panel does not
share with a human reviewer.** The empirical result behind it — defect-detection rate collapsing past roughly
400 lines in one sitting — measures how much a *single* reader can hold at one altitude. It is therefore a
proxy for "the reviewer cannot hold this," and the proxy stops measuring anything the moment the reviewer
stops being one context. A panel is not one context, so a diff-size **refusal** is not a stricter version of
the same finding; it is the finding applied outside its domain.

**A size refusal also has exactly one escape, and that escape is the sanctioned workflow.** The only way past
a line ceiling is to slice one change into two PRs — which the constellation already asks authors to do. So
the ceiling never prevents a large change; it taxes the author for relabelling it, and it buys *worse*
review than it replaced, because each half is now judged without sight of the other. A gate whose sole
effect is to split the evidence is not a safety mechanism.

**What size means instead.** Size is a care-level signal that dials review *capacity* — how many reviewers,
how many rounds, how much rigor — never review *permission*. The correct response to a diff too large for one
reader is **scoped fan-out**: every reviewer receives the whole diff and full repository context, and each is
made accountable for a disjoint, named subset of it. Disjoint **accountability**, shared **context** — the
two must not be conflated, because handing a reviewer a truncated diff reintroduces the very blindness the
fan-out exists to remove, and reading is cheap relative to reasoning. Fan-out is lossy in two known
directions, and both are covered by scope rather than by trimming: a defect spanning a shard boundary is
owned by a reviewer whose scope **is** the boundaries, and a defect of *omission* has no shard at all — an
absent test belongs to no slice by construction — so it is owned by a whole-diff pass asking only what is
missing. Reduction over shard verdicts treats a **contradiction** between two shards as a seam signal in its
own right, not as noise to dedup away.

**Lineage:** ratified by #3320 (operator, 2026-08-26) under the Review-efficacy watch (#3318). #3320 was
convened as a fork — refuse-versus-escalate — and dissolves as **contract-derived**: `#2563` clause 1 had
already ruled the class, so no branch remained to weigh. The `thresholds.diffLines` entry in
`we:scripts/lib/review-policy.contract.json` states this rule correctly today and needs no amendment; this
anchor exists so a future reader proposing a refuse threshold finds the reasoning rather than re-deriving it.
Composes with [`#build-lane-self-review-non-zero-floor`](#build-lane-self-review-non-zero-floor) (care scales
depth, never existence) — this rule extends the same shape from depth to breadth. Cumulative-basis
recomputation (#3317) is owed independently of this ruling: it makes the size *measurement* honest under
stacked lanes, which matters for dialling capacity even though nothing refuses on it.

---

### Every PR gets a look — the independent floor is a cheap advisory pass over all of them, never a random sample of a few {#every-pr-gets-a-look-advisory-floor}

**Ratified 2026-08-26 by the operator (Nicolas Gilbert) (#3313).** Extends
[`#build-lane-self-review-non-zero-floor`](#build-lane-self-review-non-zero-floor) (#2828, *care scales depth,
never existence*) from Layer 1 to Layer 2 — closing the `none → 0 reviewers` mapping that anchor explicitly
left open as "a separate concern". Composes with
[`#size-adds-reviewers-never-refuses`](#size-adds-reviewers-never-refuses) (#3320): that rule says size dials
review *capacity* upward, this one says the capacity floor is never zero.

**A PR that trips no escalation reason still gets an independent look — and the economizing axis is *depth*,
never *coverage*.** The residue that reaches no reviewer is not a safe class, it is an *unmeasured* one, and
"unmeasured" is precisely the population a floor exists for. Where budget is tight the correct response is a
shallower pass over everything, never a deep pass over a random few.

**A random sampler is the wrong instrument, for three separate reasons.** It is non-deterministic, so
"was this PR looked at?" has no answer a reader can give. It is unauditable in aggregate, since coverage is a
distribution rather than a fact. And it yields a trickle of recorded verdicts where full coverage yields the
whole population — starving the very measurement a sampler is usually justified by.

**Looking and blocking are separate decisions, and fusing them is what made the earlier sampler unaffordable.**
#2631 dropped the random sampler under the throughput program (#2606) because a park *stops the merge* — a
correct diagnosis of **blocking**, mistaken for a verdict on **looking**, only because every recorded review
was necessarily a hold. So the floor pass records its verdict and bears on nothing: no `review:*` label, no
`REVIEW_HOLD_LABELS` member, no path from a finding to a merge condition. A review that cannot park cannot
cost latency.

**The floor's bar is "catch the obvious", not "converge" — and this bound is load-bearing.** The floor
replaces *no* review, so it is measured against zero, not against a full reviewer. A pass scoped to what a
full reviewer would find *is* a full reviewer, and reintroduces the cost and latency argument the advisory
framing exists to answer. Concretely: one tool-free juror, one round, the diff and the item card, a capped
finding count, one question — *does this plainly not do what the card says, or plainly break something visible
in the diff?*

**Two obligations come with it, and neither is optional.** A finding must **file a follow-up item**, because a
review nobody is required to act on decays into noise. And the floor's own cost and yield must be
**measured and reported** to the owning program — a floor whose cost approaches a real review's has failed its
premise, and one whose findings are never right is retired under the standing auto-disable contract, not
deepened into the reviewer this rule declined.

**The accepted cost, stated rather than hidden:** an advisory pass finds things *after* the merge, so the
response is fixing forward. That is acceptable only for the class this floor covers — small, single-repo, no
sensitive paths, nothing that tripped a reason — and is never a template for an escalating class.

**Lineage:** ratified by #3313 (operator, 2026-08-26) under the Review-efficacy watch (#3318). Convened as a
go/no-go on restoring the #2631 sampler; the ruling took **neither** branch, on the finding that "not yet"
was circular (#3313 waiting on #3315, which needs the verdicts only coverage produces). Built by `#3329`
(a non-bearing `observed` verdict — `we:scripts/lib/verdict-ledger.mjs`'s closed set had no value that neither
clears nor holds) then `#3330` (the pass). Deliberately **not** blocked on #3158: `judgePanel`'s tool-free
jurors are a cost for a deep reviewer and the specification for a diff-only one. #3315 remains owed
independently — this rule feeds it the whole population instead of a sampled trickle; it does not build it.

### What blocks a land is the impact of a finding, not the lens that found it — a prose-judging lens stays advisory and blocks only above the bar {#claim-accuracy-advisory-blocks-on-impact}

**Ratified 2026-08-26 by the operator (Nicolas Gilbert) (#3314).** Leaves
[`#2310`](/backlog/2310/)'s mandatory/advisory split intact — `claim-accuracy` stays **out** of
`MANDATORY_LENSES` — and refines what an advisory lens may nonetheless do. Cite alongside
[`#blast-radius-advisory-care-not-a-gate`](#blast-radius-advisory-care-not-a-gate) (#2563).

**A lens pointed at prose returns mostly prose findings, and mandatory means unanimity.** `claim-accuracy`
judges the writing *about* the repo — card bodies, Done-when criteria, docs, agent-memory notes, code
comments, PR descriptions. Its finding population is therefore dominated by low-impact prose *by
construction*, not as an accident of some sample. Promoting such a lens wholesale to the mandatory set makes
a wrong figure in a paragraph nobody depends on sufficient to stop a land. That is review **permission**
scaling with a signal — **the same principle** #2563 clause 1 applies to scored signals, **extended** here
to a lens's mandate. The argument does **not** depend on the lens's measured hit rate, and would not change
if the lens got better: the objection is structural.

> **Retracted — the #2563 citation was an overstatement.** This paragraph used to read *"That is review
> **permission** scaling with a signal, which #2563 clause 1 already forbids."* **#2563 clause 1 does not
> forbid it.** Its subject is *scored signals* — it names blast-radius, size, dismissed-findings, cross-repo
> and 1-in-N sampling, and says those annotate a care level rather than gate a land. A lens's mandate is not
> a scored signal, so this ruling **extends** the principle to a new object rather than deriving from a
> clause that already covered it. The argument stands on its own either way; only the "already forbids" was
> wrong. The same wording was corrected in `we:scripts/lib/jury-core.mjs`.

**The right axis is already typed, and it is `impactIfUnfixed`.** What should stop a land is what shipping
the finding *costs*, not which reviewer noticed it. `IMPACT_LEVELS` / `IMPACT_GLOSS` in
`we:scripts/lib/jury-core.mjs` already carry that, enum-constrained and fail-loud, and
`PREVENTION_IMPACT_BAR` (`broken`) already dials the panel's other findings-derived block. So the blocking
sub-class is **`impactIfUnfixed >= broken`** and needs no new field: a wrong acceptance criterion or a wrong
`file:line` a card directs work to is `broken` (*"real work is lost, duplicated, or silently skipped"*); a
wrong figure no criterion depends on is `cosmetic`. **A sub-class defined by a typed field is the whole
point** — the objection to a sometimes-blocking advisory lens ("mandatory with extra steps") holds only
where the sub-class is reviewer discretion, so any future rule of this shape must name a typed field or take
plain advisory instead.

> **Retracted — the field name.** This paragraph used to read *"The right axis is already typed, and it is
> `impact`"* and *"the blocking sub-class is `impact >= broken`"*. **There is no `impact` field on a
> finding.** The typed field is **`impactIfUnfixed`** (`we:scripts/lib/jury-core.mjs:53`, normalized at
> `:384`, read by `blocksAcceptance` at `:532`). The named constants were and are correct — `IMPACT_LEVELS`,
> `IMPACT_GLOSS`, `PREVENTION_IMPACT_BAR`, `impactStrictness` all resolve. Corrected here, on
> `we:backlog/3314-should-claim-accuracy-be-a-mandatory-lens.md`, on `#3339` and `#3338`, and in the
> `ADVISORY_LENSES` comment — the name has to be right because `#3339` tells a builder to read the level
> off a finding. Unbackticked *impact* in this anchor means the axis, not a field.

**A ruling that needs a build says so on its face.** `derivePanelVerdict` blocks on an advisory lens's
findings only for **resolved** ones owing an uncaptured guard; an **outstanding** above-bar advisory finding
still rides the accept. Until that third scan ships (`#3339`), this rule's blocking half is inert and the
lens behaves as plain advisory. The two-stage form is part of the ruling, not a caveat on it — a decision
recorded as if it binds while nothing enforces it is worse than one recorded as pending.

**The bar is unconditional on prevention — the scan may not be built on `blocksAcceptance`.** That existing
predicate (`we:scripts/lib/jury-core.mjs:530`) opens `if (!hasUncapturedPrevention(finding)) return false;`,
so it blocks only where a *named, uncaptured* guard is also owed. Reusing it for this rule would let the
worked example above through — a wrong `file:line` declared `broken` whose prevention is the already-existing
`check:standards` locus gate (`preventionCaptured: true`) would ride the accept, as would any above-bar
finding naming no guard at all. The predicate this rule requires reads impact and nothing else: outstanding
**and** `impactStrictness(impactIfUnfixed) >= impactStrictness(bar)`, **fail-closed on an undeclared level**,
matching `blocksAcceptance`'s own undeclared-blocks contract. `#3339` carries it verbatim, with a
Done-when case that goes red on a prevention-coupled implementation.

**Scope held deliberately narrow.** The blocking set is an explicit one-member set, not `ADVISORY_LENSES`.
Whether the bar should govern every advisory lens — which would leave little of #2310's split standing — is
`#3338`, and generalizing it as a side effect of a single lens's promotion would reverse a ratified
decision without convening it, the move [`#size-adds-reviewers-never-refuses`](#size-adds-reviewers-never-refuses)
refused for size.

**Lineage:** ratified by #3314 (operator, 2026-08-26) under the Review-efficacy watch (#3318); implemented by
`#3339`. The preparation argued the mandatory case from two figures since retracted (*"3 of 13"*, *"30
verdicts / roughly 24"*); the measured values are **5 of 39** (12.8%) and a cross-tab of **27 of 92**, and
both corrections strengthen the mandatory case the ruling declined. The ruling stands because it never rested
on the backstop's recall. Nor does it rest on the two-round result on PR #1569 — one PR cannot establish a
lens's profile; that grounding belongs to the omission seat under `#size-adds-reviewers-never-refuses`.

---

### Dispatch cross-checks real merged-PR history before treating an open item as needing work — enforced at both current spawn chokepoints, not one {#dispatch-status-ground-truth-check}

**Ratified 2026-09-02** — per the operator's explicit in-conversation instruction to ratify this card,
delegated to the driving session's own call (epic #3383's own standing kanban-style doctrine); both rulings
below accepted as the prepared card's own bold defaults, no alternative picked, no amendment beyond what each
fork's own `Skeptic:` pass already folded in (#3457).

Motivated by a real, measured gap, not a hypothetical: `#3434`'s double-dispatch (two separate
`prepare-decision` agents spawned against an item whose implementation had already merged hours earlier,
discoverable with one `gh pr list --search` call) and `#3433` reproducing the identical shape live, within the
same session that filed the fix. Two clauses:

1. **Ruling 1 — WHERE the check runs: support-both, not a fork.** The manual operator path
   (`we:scripts/operations/dispatch-lane.mjs`, the sole callee of `dispatch-lane --num=<N>`) and the automatic
   per-tick sweep (`we:scripts/readiness/dispatch-plan.mjs`'s enrichment, read directly by
   `we:skills-src/conveyor/SKILL.md`'s spawn steps) are two currently-independent chokepoints — neither
   dispatch path routes through the other yet (that convergence is `#3096`'s own, still-open, follow-on).
   Guarding only one leaves the other completely unguarded, which is the exact shape `#3434`'s double-dispatch
   fell through (one of its two dispatches WAS the automatic sweep). **The check is implemented at BOTH**: (b)
   `we:scripts/readiness/dispatch-plan.mjs`'s enrichment step, and (c) a guard inside
   `we:scripts/operations/dispatch-lane.mjs` immediately before spawn. A cheap, optional, non-authoritative
   nicety at (a) `we:scripts/conveyor/queue.mjs add`-time remains allowed but not required — it is
   session-local and gates neither dispatch path on its own. **Contingent on the current architecture, not
   permanent:** once `#3096` lands, a single guard at (c) would cover both paths and (b) could be retired as
   redundant — whether/when to retire it is `#3096`'s own concern, not this ruling's.
2. **Ruling 2 (Fork 2) — how the check stays cheap.** At (c), the `dispatch-lane.mjs` guard: check once,
   immediately before spawn, never on a tick cadence — one `gh pr list --search` call per dispatch attempt. At
   (b), `dispatch-plan.mjs`'s enrichment: age-gated — only items that have sat `open`/`active` past a minimum
   age get enriched with the check, so a freshly-opened item never pays the cost while a long-stale one is
   still caught within a bounded delay on the automatic path. Both avoid the rejected shape this fork exists
   to rule out: a per-tick, per-item, unconditional `gh pr list` call.

**Lineage:** ratified via #3457 (2026-09-02). The exact `gh pr` search query shape, the specific age
threshold, and what happens to a flagged item (hold, auto-resolve, or surface) are left to the follow-on build
item, [Wire the dispatch already-done ground-truth check into `we:scripts/operations/dispatch-lane.mjs` and
`we:scripts/readiness/dispatch-plan.mjs`](/backlog/3460-wire-the-dispatch-already-done-ground-truth-check-into-we-sc/)
(parent #3457). Full reasoning, prior-art survey and skeptic passes:
[#3457](/backlog/3457-dispatch-must-cross-check-an-open-item-s-status-against-real/).

---

### A capacity-aware admission queue caps concurrent heavy commands across dispatched lanes — distinct from lane leasing {#heavy-command-admission-queue}

**Ratified 2026-09-02** — per the operator's explicit in-conversation instruction to ratify this card,
delegated to the driving session's own call (epic #3383's own standing kanban-style doctrine); all three forks
plus the two supported-by-default items accepted as the prepared card's own bold defaults, no alternative
picked, no amendment beyond what each fork's own `Skeptic:` pass already folded in (#3456).

Lane availability (`we:scripts/lane-pool.mjs`'s slot count) and CPU/heavy-command capacity are two different
resources; today only the first is throttled. Four clauses:

1. **What counts as "heavy" (Fork 1): an explicit named list, v1 equal-cost.** `check:standards`,
   `verify-lane`/`test:unit`, `npm ci`/`npm install`, and the Playwright visual-capture pass — the same
   closed, enumerable set every dispatched-agent brief already routes through, per
   [#dispatched-agent-never-runs-commands-directly](#dispatched-agent-never-runs-commands-directly). v1 ships
   as a plain named SET, not weighted. A blanket cap over every command is rejected on merit, not cost: it
   would permanently serialize genuinely cheap `compute` calls (`gate-health`, `suggest-next`, `pr-status`)
   alongside real heavy ones, a defect that holds even at zero build cost.
2. **Where the cap applies (Fork 2): at heavy-command-invocation time, not at lane-acquire time.** A lane may
   always be acquired freely; the heavy command itself queues on a capacity semaphore right before it runs —
   an idle-but-leased lane is never itself the expensive thing. **Named wrinkle, not resolved by this
   ruling:** `npm ci` already runs inside `we:scripts/lane-pool.mjs`'s `acquire` today (via `ensureDeps`)
   unless the caller passes `--no-install`, and no dispatched-agent brief currently passes it. The follow-on
   build resolves this concretely — either dispatched-agent acquire call sites gain `--no-install` and `npm
   ci` becomes its own gated step, or the acquire-time exception is documented as a narrow, named one.
3. **How "waiting for capacity" surfaces (Fork 3): a new, distinct signal in the runner's own tick JSON**, via
   the existing `notes` array's `{ kind, ... }` pattern (`we:scripts/conveyor/tick-core.mjs`, e.g. `{ kind:
   'waiting-for-capacity', num, text }`) — never folded into `#3451`'s call-visibility telemetry (a schema
   mismatch: that signal is after-the-fact access-log telemetry, not a live, pollable status a caller can
   check before deciding what to do next) and never silent.
4. **Supported by default, not separately ratifiable.** Heavy-command classification stays the fixed named
   list for v1 — no adaptive/measured classifier yet; real, separately-prioritized future work once real usage
   shows the fixed list insufficient. The admission cap is a fixed number, env/config-overridable per machine,
   sized **conservatively below measured host capacity** — not Bazel-style near-full-utilization, since a dev
   workstation's baseline headroom is itself volatile from processes the queue never controls (other lanes'
   dev servers, a concurrent review session). **Named residual risk, not overstated as solved:** a fixed cap
   alone reduces but does not fully eliminate the contention failure mode #3383's own finding-4 already hit
   live with only a handful of concurrent lanes — accepted for v1, not claimed closed.

**Lineage:** ratified via #3456 (2026-09-02). The concrete throttle mechanism (semaphore shape, enforcement
point, regression test) is left to the follow-on build item, [Build the heavy-command admission queue: a
capacity semaphore for check:standards, verify-lane, npm ci, and Playwright
visual-capture](/backlog/3461-build-the-heavy-command-admission-queue-a-capacity-semaphore/) (parent
#3456), which must land — or be concretely scheduled to land — before the dispatcher's parallel lane count
increases further, per the operator's own sequencing ("we need the queue there first before merging" further
parallelism). Composes with
[#operations-declared-once-callers-generated](#operations-declared-once-callers-generated) (#3427/#3451 — the
call-visibility telemetry this ruling's Fork 3 deliberately does not reuse) and `#3449` (the closest sibling
shape, for lane leases rather than heavy-command capacity). Full reasoning, prior-art survey and skeptic
passes: [#3456](/backlog/3456-cap-concurrent-heavy-commands-across-dispatched-lanes-a-capa/).

**Every heavy command goes through the pool (2026-09-21, operator: "Yes to routing heavy cmd").** Until then
only `we:scripts/verify-lane.mjs` was admitted. Now `package.json`'s `test:unit`, `test:coverage`,
`check:standards` and the vitest step of `verify` run as `node scripts/readiness/heavy-admission.mjs run --
<cmd>`, and every script that spawns vitest, check-standards or the regression Playwright suite itself goes
through the same wrapper (`admittedArgv` / `admittedShellCommand` in `we:scripts/readiness/heavy-admission.mjs`).
The wrapper is a **pass-through** when `CI=true`, when `WE_HEAVY_ADMISSION=off` (the switch for a machine or a
one-off run), or when there is no lane-pool directory. It is **re-entrant**: it gives its child
`WE_HEAVY_ADMISSION_HELD=1`, and a nested wrapper that sees the flag never asks for a second slot (so
`verify-lane` → `npm run test:unit` takes one slot, not two). `we:scripts/guard-bash.mjs` denies the raw
spellings (`npx vitest run|related`, `npm run verify`, `node scripts/check-standards.mjs`, `npx playwright
test`) to dispatched agents and blocks backgrounding them for everyone; the deliberate exception stays
`lane-pool.mjs acquire`'s `npm ci` (clause 2). A `waiting` marker whose owner is gone and that is older than
30 minutes is reaped by the next admission attempt (`heavy-admission.mjs reap [--apply]` previews/applies it).
Card: #3785.

**Core budget (PROVISIONAL — to be re-evaluated from telemetry, not a ratified constant).** On the 12-core
workstation: about **2 cores reserved** for the system and VS Code; the **heavy pool** is cap 2 × 4 vitest
threads (the #3650 thread cap) = **8 cores**; lanes themselves are light and share what is left; the worker
dispatch cap is **3**. Evidence it rests on (host sampler, 18.6 h, 2026-09-20/21): the pool held 0/1/2 slots in
89 / 9.5 / 1.2 % of samples; a worker process uses about 0.4 % of a core; a running vitest lifts load1 p50 from
4.8 to 10.3. The telemetry that re-evaluates these numbers is the host sampler (`we:scripts/operations/host-sampler.mjs`,
samples under `.operations/host-sampler/`, read by `we:scripts/operations/load-report-cli.mjs` and
`load-review.mjs`) — on the `lane/mechanical-dispatcher` prototype branch today — under the review cadence of
[#3737](/backlog/3737-set-concurrency-limits-from-host-sampler-data-dated-checkpoi/) and the staged project
[#3611](/backlog/3611-hardware-usage-aware-heavy-command-capacity-control-a-staged/). **No load-average gate:**
the operator rejected point-in-time load gating; a smoothed brake built on the sampler's `pressure` command is a
separate, later slice on the prototype branch, not part of this rule. The lane ceiling
([#3612](/backlog/3612-cap-concurrent-dispatched-lanes-with-a-max-concurrent-lanes/)) is also separate.

---

### Automated transcript-based introspection at session close/reap runs detached, covers every session, and reuses the existing learnings pool with a reinstated privacy scrub {#automated-session-introspection}

**Ratified 2026-09-04** — per the operator's explicit in-conversation instruction to ratify this card
("I ratify 3475"); all three forks accepted as the prepared card's own bold defaults, no alternative picked, no
amendment beyond what each fork's own `Skeptic:` pass already folded in. The toggle location and the
trigger-per-session-kind question were already ruled (not forked) in the card itself and are not restated here.
Single-tenant precursor to #2610's multi-tenant generalization. Three clauses:

1. **Fork 1 — execution mode: detached, uniformly across all three trigger kinds.** The judge pass never blocks
   its trigger point — forced outright for the `SessionEnd` hook (a 1.5s default timeout budget cannot fit a
   Sonnet call), and matching the existing best-effort convention `session-reaper.mjs` already established for
   the other two trigger kinds rather than inventing a second execution model. A lost introspection entry is a
   strictly lower-stakes failure than a stalled dispatch tick, a slowed human turn, or a hung subagent.
2. **Fork 2 — coverage: every terminal session, unconditionally.** Matches the operator's own explicit words
   ("every background session is inspected… same for main session and subagent"). A cheap, mechanical
   (non-LLM) pre-check that short-circuits a structurally-trivial judge call is a sanctioned build-time
   efficiency, never a coverage exclusion.
3. **Fork 3 — destination: the existing `#2614` pool/schema, with the wide `scrubReasons` detector (unwired
   since `#3015`) reinstated for judge-authored entries specifically, plus one new optional `origin` field.**
   Reuses the whole downstream `/harvest` pipeline rather than forking a second pool. Stated honestly as
   *narrowing* the privacy gap an automated judge reading a raw transcript reopens, not closing it completely
   — `scrubReasons` is field-local and has a 16-character entropy floor, both residual, both accepted for v1.

**A settled requirement carried into the follow-on build, not left open:** the judge's rubric must scan for the
raw-command/missing-operation pattern (`we:agent-memory-src/act-as-if-a-ui-were-the-one-filing-changing-items.md`'s
"would a UI button be able to do this?" test) and emit `kind: missing-convention` naming `#3029` when found.

**Lineage:** ratified via `#3475` (2026-09-04). The `WE_INTROSPECTION_ENABLED` read helper's exact shape, the
judge prompt/chunking strategy for an oversized transcript, and true OS-level detachment for the spawned judge
process are left to the follow-on build item scaffolded under `#3475`. Full reasoning, prior-art survey and
skeptic passes: [#3475](/backlog/3475-automated-transcript-based-introspection-at-session-close-re/), research
topic [`automated-transcript-introspection-at-close-reap`](/research/automated-transcript-introspection-at-close-reap/).

---

### Agent-run commands split by mutation — reads stay free and sandboxed, mutations route only through a strictly-typed, fail-closed operation catalog; a capability gap rides the existing learnings pool {#agent-mutations-through-typed-operations}

**Ratified 2026-09-04** — per the operator's explicit in-conversation instruction to ratify this card
("Ratified"); both forks accepted as the prepared card's own bolded recommended defaults, no alternative
picked, no amendment beyond what each fork's own prepared reasoning already folded in. Grounded in a
measurement of all 64,752 `Bash` calls across 4,485 local sessions
([the sizing report](../../reports/2026-08-08-agent-command-surface-sizing.md)). Two clauses:

1. **Fork 1 — how an agent session runs a mutating command: split by mutation.** Reads and inspection stay
   free, broad, and sandboxed — the agent runs them itself (measured at 72.2% of call volume, with no
   catastrophic failure mode). Anything that **mutates state outside the agent's own lane clone** — writes to
   the primary checkout, `git push`, `gh`, network calls, installs, deploys — goes only through a named
   operation, executed by the mechanical layer, failing **closed**: an operation with no covering declaration
   is refused, not allowed by default. This buys the fail-closed property where it matters (measured at 6.7%
   of call volume) without paying the coverage cost across the 72.2% that carries no comparable risk. A full
   allow-list over everything, reads included, was considered and rejected — the coverage burden would land
   almost entirely where the risk is not, which is where operation-catalog designs usually die; keeping the
   status-quo deny-list over everything was also rejected — six review rounds on the command guard
   demonstrated the failure is structural (an enumeration cannot be completed from inside the thing being
   enumerated), not a matter of more effort.
   **Sub-decision ratified with the fork: operation parameters are strictly typed.** An operation like
   `run(script, args)` that passes strings through to a shell re-imports the entire enumeration problem
   behind a friendlier name; `pr.merge(number: int)` does not. Typed parameters are the whole difference
   between an allow-list and a rename, and this is ratified as part of the fork rather than left to each
   operation's own implementation to decide.
2. **Fork 2 — how an agent reports a capability gap: the existing learnings pool, no new channel.** Same
   shape as the harvest pipeline: the session **emits** (what it was trying to do, what it would have run,
   what it did instead) and never adjudicates in-session; a periodic pass dedups, ranks by recurrence, and
   routes survivors to catalog additions. A dedicated gap channel was considered and rejected as a second
   emit/dedup/route pipeline duplicating a seam that already works.

**Sandboxing is not a substitute for either fork.** A sandbox bounds *damage*; the operation catalog bounds
*authority*. A sandbox does not stop a force-push to `main` or a `gh pr merge` — legal actions performed with
real credentials, and the ones that hurt here. Both are wanted; neither substitutes for the other.

**What this ruling does not settle.** The `curl`/`net.fetch` host-allow-list question is an open sub-question,
not ratified here — it needs its own survey of what agents actually fetch. Nor does this ruling build the
enforcement mechanism: `we:scripts/guard-bash.mjs` stays a deny-list until its own follow-on flips it, and the
typed-operation catalog itself is not yet closed for every mutating family the sizing report measured — both
are named, scoped follow-on build items, deliberately not attempted in the same change as this statute edit.

**Lineage:** ratified via `#3001` (2026-09-04). Full reasoning, prior-art survey and the sizing report:
[#3001](/backlog/3001-should-agents-call-named-operations-instead-of-writing-shell/). Follow-on build:
[close the operation-catalog gaps](/backlog/3490-close-the-gaps-in-the-typed-mutation-operation-catalog-finis/),
then [flip `we:scripts/guard-bash.mjs` to a fail-closed allow-list](/backlog/3491-flip-we-scripts-guard-bash-mjs-from-a-deny-list-to-a-fail-cl/)
(`blockedBy` the first). Composes with
[#dispatched-agent-never-runs-commands-directly](#dispatched-agent-never-runs-commands-directly) (the
narrower, already-ratified dispatched-agent case this fork generalizes) and
[#operations-declared-once-callers-generated](#operations-declared-once-callers-generated) (`#3029`, the
engine the closing catalog builds onto).

---

### Build-brief discipline: name edge-cases, require integration tests, forbid overclaiming — caught by a deterministic proposer gap AND a build-time habit, not a human re-read {#build-brief-discipline}

**Every delegated build brief — the backlog item body a build lane implements to spec — must (1) name the
edge-cases it wants handled or explicitly rejected, (2) require an integration/wiring test and not only a
unit test, and (3) never claim to "close" something the slice does not close end-to-end (whether that claim
lives in the body's prose or in the item's own title).** This closed the root cause traced from the
UI-Fidelity foundation PRs (#2805/#2802, PRs #951/#952, both ACCEPT-WITH-NITS): the build agents built
faithfully to spec, but the spec itself under-specified the edge-cases to reject, asked for tests without
naming which kind, and echoed a slice title ("closes the data-layer dodge") as a scope claim it hadn't
earned. The nits were the brief's gaps, reproduced faithfully — no amount of build-time care fixes a spec
that never named the case.

**Enforcement is two-sided — an authoring-time gate plus a build-time habit, not one mechanism doing both
jobs.** `we:scripts/readiness/proposer.mjs` carries the deterministic half: its existing
`selectProposalCandidates` already flags a decided-but-thin item on two structural proxies — missing
acceptance criteria, missing a concrete file path — and drafts (never auto-applies) candidate fixes. This
statute adds four more proxies to the same pure, quarantined engine, same conservative bias throughout (a
missed real gap only means the human isn't nudged to add one; it never blocks a build), same
never-splices-prose boundary:

- `edge-cases` — the body names no edge-case to handle or explicitly reject.
- `integration-tests` — the body's testing language never rises above "unit test" (also accepts
  "integration"/"wiring"/"end-to-end"/"e2e" as satisfying synonyms).
- `overclaim-scope` — the BODY's prose claims to "close" something without demonstrating it end-to-end in
  the same paragraph as the claim (excludes the bare verb "close", the "closes over" JS-closure idiom, and
  a GitHub-style "closes #123" auto-link — none of those are a prose scope claim).
- `overclaim-title` — the item's own TITLE claims full closure ("closes"/"fixes"/"resolves"/"solves") while
  the item is a slice of a parent — the exact "closes the data-layer dodge" shape from the diagnosis above,
  independent of whatever the body says. A standalone item (no parent) claiming its own closure is not a
  slice-vs-whole mismatch and is not flagged.

A readiness-time gate cannot rewrite an already-thin upstream spec, so the build-time half lives in the
delegated-agent templates themselves (`we:skills-src/conveyor/delivery-agent-brief.md`,
`fix-agent-brief.md`, `fix-agent-ci-brief.md`) as a standing instruction to the executing agent: name the
concrete edge-cases yourself when the spec under-specifies them, cover the change with an
integration/wiring test exercising the real call path, and never echo a title or slice name back as an
earned "closes X" claim.

**Lineage:** #2819 (traced from #2805/#2802's ACCEPT-WITH-NITS foundation PRs). Fixes #2563 (advisory
care-level / convergence) — the warm-lane-convergence half of that fix is the pre-existing `/converge` step
already in `delivery-agent-brief.md` (#2971/#2969); this statute closes the remaining root cause (the
under-specified brief itself). Reuses the spec-gap proposer #252 and its quarantine-from-`check:readiness`
boundary. Reflected in `we:scripts/readiness/proposer.mjs` (the four detectors above) and in all three
conveyor build-brief templates named above — the delivery-agent brief applies this lens both when
scaffolding a new leftover-work item and to its own current build, and the fix-agent briefs apply it to a
repair. Composes with [#deterministic-core-thin-judgment](#deterministic-core-thin-judgment) (the gap
detection is script-decidable; drafting a fix and accepting it stay human/model judgment).

---

### A parked PR's real merge conflict is resolved by dispatching an agent through the existing bounce+fix pipeline — never a bespoke script, never a second dispatcher {#parked-pr-conflict-dispatched-not-scripted}

**Ratified 2026-09-06** — per the operator's explicit instruction to ratify this card ("ratified"); all four
forks accepted as the prepared card's own bolded recommended defaults, no alternative picked, no amendment
beyond what each fork's own prepared reasoning (a skeptic pass and an independent two-confusion screen, both
already folded into the card) already settled. `we:scripts/conveyor/parked-pr-conflict-watch.mjs` (`#3494`)
already detects a parked PR drifting into a real `CONFLICTING` state and refused to auto-resolve it — correctly,
for a deterministic script with no way to choose which side of an overlapping hunk wins. Dispatching a real
*agent* at the same conflict is a different, lower-risk shape: the result still lands through the identical
independent-review gate `#3494` itself protects. Four clauses:

1. **Fork 1 — dispatch prefers resuming the PR's original builder session, through the ONE declared spawn
   implementation, gated on a build-time probe.** An opt-in `resumeSessionId` branch lives INSIDE the existing
   `we:scripts/operations/dispatch-lane-io.mjs#buildAgentArgv` (never a second spawn path — per
   [#conveyor-dispatch-calls-the-declared-operation](#conveyor-dispatch-calls-the-declared-operation)). The
   session id is read from the PR's own `authored-by-actor` body stamp and looked up in
   `claude agents --json --all`; if found, the dispatcher attempts `claude --bg --resume <id>` and compares the
   id the CLI actually resumes under against the id requested — a mismatch means the CLI silently forked a copy,
   which is `claude stop`-ped and the dispatch falls back to fresh. **This fork's build owed a real probe, not an
   assumption**, given `#3331`'s own open, adjacent finding that `--bg` discards a request-side `--session-id`.
   The probe ran live (CLI 2.1.263, 2026-09-06) and found: `claude --bg --resume <id>` genuinely continues the
   named session with NEW work injected into the SAME context (a second prompt sent after the first had finished
   produced a fresh reply, with both turns present in the transcript) — a real resume, not a mere re-attach to
   old output — but **only when no other flag accompanies `--resume`**. Passing `-n`, `--model`,
   `--append-system-prompt-file`, or any other flag alongside `--resume` makes the CLI fork an unrelated copy
   under a fresh id instead of continuing the named session, every time it was tried, regardless of whether the
   original session was still live. The build therefore issues a bare `['--bg', '--resume', <id>, <prompt>]` for
   the resume attempt (no `-n`, no system-prompt file, no extra args) and relies on the id-mismatch check named
   above to catch every fork this causes — both the "session already running" fork and the "flags differed" fork
   are the same observable failure and the same recovery.
2. **Fork 2 — scope is every parked PR the existing conflict-watch predicate already targets, including
   `review:human`, except a statute-tier hunk.** No blanket `review:human` carve-out: the fix-agent brief already
   never touches that label for any reason, so a merge conflict is no more dangerous to dispatch at than an
   ordinary reviewer finding on DISPATCH-ELIGIBILITY grounds. The one real exception is by file CONTENT, not by
   PR label — a conflict whose overlapping hunk touches a declarative-leash or statute-tier path
   (`we:scripts/lib/review-escalation.mjs#isDeclarativeLeashPath` / `#isStatutePath`) routes straight to a human
   stand-down with no dispatch attempt at all, because choosing which side of that hunk wins is drafting
   principle content, not ordinary code.
3. **Fork 3 — retry/escalation reuses the existing durable rearm cap and `stand-down.mjs`, with one named brief
   gap closed.** No dedicated conflict-retry counter: once a conflict is posted as a `review:changes` bounce
   (Fork 4), it is an ordinary bounced PR to `we:scripts/conveyor/reconcile-core.mjs`, sharing ONE cap
   (`countRearmComments` against `NEGOTIATION_ROUND_CAP`) across every bounce cause — splitting the counter would
   silently raise the total unsupervised-repair ceiling for a PR that hits both a conflict and an ordinary
   finding, the opposite of what the cap exists to prevent. The brief gap this fork's build closed: the
   fix-agent brief's AUTOMATIC dispatch path only ever posted a completion record
   (`operations/completion-cli.mjs report --outcome=escalated-conflict`), never the durable
   `stand-down.mjs --reason=conflict` PR comment the MANUAL `/finish` path already posts — so an auto-dispatched
   agent that gave up on a conflict was silently re-dispatched at the same unresolved conflict next tick, bounded
   only by the 5-attempt cap rather than the terminal stand-down exit. The brief now posts the same stand-down
   call on both paths.
4. **Fork 4 — the dispatch mechanism is the existing bounce+fix-dispatch pipeline, with a broadened shared
   banner, never a second dispatcher.** No new, parallel conflict-dispatch pass: when
   `parked-pr-conflict-watch.mjs` detects a fresh conflict (outside Fork 2's statute-tier exception), it posts
   the conflict as a `review:changes` bounce via `we:scripts/conveyor/reconcile-finding.mjs` — the exact shape
   already built for "a mechanical pass found this PR conflicts with a decision made elsewhere." That flips
   `classifyPr`'s phase to `bounced`, which the EXISTING `reconcile-core.mjs`/`reconcile-fix-dispatch.mjs` already
   pick up and dispatch against, through the SAME `fix-agent-brief.md`. Two independent dispatchers that could
   both fire on one PR is the exact double-dispatch hazard `#3416` already found and fixed once; funnelling every
   "this PR needs a fix agent" decision through one pipeline is the same one-implementation principle
   [#conveyor-dispatch-calls-the-declared-operation](#conveyor-dispatch-calls-the-declared-operation) already
   states one layer up. The one wording fix this fork's build owed: `reconcile-finding.mjs`'s shared banner was
   worded specifically around a semantic/sequencing conflict (its own motivating incident); it is broadened to
   also name a raw git merge conflict against `main`, rather than forking a second, near-identical banner.

**What this ruling does not settle.** Whether an ORDINARY (non-conflict) `review:changes` fix should also prefer
resuming its original builder is a real, separate, larger question this item does not answer — the new
`resumeSessionId` parameter defaults OFF for every existing caller and is turned on only for the new
conflict-triggered call site.

**Lineage:** ratified via `#3544` (2026-09-06), filed under the background mechanical dispatcher epic `#3383`.
Full reasoning, prior-art survey, the skeptic pass and the two-confusion screen:
[#3544](/backlog/3544-automate-merge-conflict-resolution-on-parked-prs-dispatch-an/), research topic
[parked-pr-conflict-auto-resolution](/reports/2026-09-06-parked-pr-conflict-auto-resolution-research/). Composes
with [#conveyor-dispatch-calls-the-declared-operation](#conveyor-dispatch-calls-the-declared-operation) (the
one-spawn-implementation statute this item's Fork 1 and Fork 4 both implement within, not alongside).
**Extended by `#3556` — see below.**

### A bare-branch merge conflict from `we:scripts/conveyor/branch-sync.mjs`'s escalation is resolved the same way — dispatch a reconciliation agent, never a bespoke script — with a mechanism adapted for having no PR {#branch-sync-conflict-dispatched-not-scripted}

**Ratified 2026-09-07** — the operator ratified `#3556`'s prepared card: all four of its own bolded
recommended-default forks, with one amendment to Fork 3. Extends
[#parked-pr-conflict-dispatched-not-scripted](#parked-pr-conflict-dispatched-not-scripted) (`#3544`) from a
PR-scoped conflict to a bare-branch conflict with no PR, no reviewer, and no comment thread to key state off
of — composes with that statute rather than replacing it. Four clauses:

1. **Fork 1 — same one declared spawn implementation, fresh dispatch only.** `#3556`'s dispatch calls
   `we:scripts/operations/dispatch-lane-io.mjs#buildAgentArgv` / `#defaultSpawnAgent` directly — the exact
   primitives `#3544`'s own Fork 1 already established as the one spawn implementation — with no
   `resumeSessionId`: a branch-wide drift has no "original builder" session the way a single authored PR
   does, so the resume branch `#3544` added is simply never exercised here.
2. **Fork 2 — the dispatched agent takes its own lane, exactly like every other dispatch.** Not a new fork;
   standing doctrine (`we:docs/agent/backlog-workflow.md`, "Work in a lane, not the primary checkout") already
   settles it, unconditionally, with no primary-checkout carve-out for this dispatch kind either.
3. **Fork 3 — dispatch is capped at once per distinct conflict signature, and the cap is a CONFIGURABLE
   product setting, not a bare hardcoded constant.** `we:branch-sync.mjs`'s own existing durable state
   (`we:.git/branch-sync-state.json` or a sibling file it owns) is extended with a `dispatchedFor: <signature>`
   marker; a later escalation carrying the identical signature is terminal for auto-dispatch and falls through
   to the existing human-alert path, upgraded to note an auto-fix was already attempted. Unlike `#3544`'s
   PR-based flow (which shares the durable, comment-derived `NEGOTIATION_ROUND_CAP` across every bounce
   cause), a branch-sync dispatch has no PR to carry a durable attempt count and no visible per-attempt audit
   trail, so it owns its own cap — read from a new env-override constant rather than an inline literal:
   `Number(process.env.WE_BRANCH_SYNC_DISPATCH_RETRY_CAP || 1)`, following this repo's established
   env-override convention (default baked in, overridable via `process.env`, e.g.
   `we:skills-src/batch-backlog-items/workflow-progress.mjs`'s `STALL_S`). Default stays `1` — heavier than a
   single-PR fix-agent retry, with no per-attempt comment trail to audit — but is now a product setting an
   operator can raise once real usage data says otherwise, with no code edit.
4. **Fork 4 — a new, small, generic brief, never a forced reuse of the PR-shaped brief.**
   `we:skills-src/conveyor/branch-sync-fix-brief.md`, filled only with `{{BRANCH}}`/`{{BASE}}`/`{{REPO_DIR}}`
   tokens through the same `we:scripts/operations/dispatch-lane.mjs#fillBrief` mechanism every other brief
   already uses — `we:fix-agent-brief.md` assumes a `{{PR_NUM}}`/`{{ITEM_NUM}}`/`{{SCOPE}}` that don't exist
   for a branch-wide drift, so it is the wrong shape here, not the reusable one.

**Landing-target note.** `we:scripts/conveyor/branch-sync.mjs` already lives on `main` (confirmed
byte-identical against `origin/lane/mechanical-dispatcher` at ratification time) — mechanical-delivery-doctrine
rule 4's ceremony-free direct-push path does not apply merely because the feature *operates on* the prototype
branch; this build lands on `main` through the normal lane → PR → independent-review pipeline.

**Lineage:** ratified via `#3556` (2026-09-07), filed under the background mechanical dispatcher epic `#3383`,
extending [#parked-pr-conflict-dispatched-not-scripted](#parked-pr-conflict-dispatched-not-scripted) (`#3544`).
Full reasoning: [#3556](/backlog/3556-auto-dispatch-a-reconciliation-agent-when-we-branch-sync-mjs/).

### A model/provider graduates out of probation on a selection-bias-proof trial bar with an independent calibration veto, scaled by role authority, under one uniform floor {#model-probation-graduation-criteria}

**Ratified 2026-09-13 by the operator (Nicolas Gilbert), all four forks approved as prepared, no
amendments (`#3654`).** Extends the already-ratified probation mechanism
(`we:scripts/lib/model-probation.mjs`, epic `#3383`; PR #2182: every new `{provider, model}` identity
starts `unvalidated`→`probation` before any blocking/gating authority, promotion is always an explicit
human decision grounded in accumulated data, never automatic, never inherited by a model upgrade) with
the shape of the bar that decision itself left undefined. Four clauses; **no concrete numeric threshold
is fixed by any of them** — each names what a follow-on ordinary (batched) finding must propose once
real trial-count data exists per role, never a separate ceremony:

1. **Volume/mix — a minimum trial count PLUS at least one informative trial, never count alone.** A
   trial is "informative" only for a checkable event — a confirmed miss the agent should have caught, or
   a documented cross-reviewer disagreement over severity — never a vibe call. A pure count is rejected
   as provably gameable by selection bias — the `advisory-review` role's own recorded trial history
   already clears a pure-count bar despite carrying a confirmed missed blocker inside it (`#2107`, PR
   #2182; the live record and its evidentiary detail live on `#3654`, not restated here).
2. **What's measured — success rate is a floor; a confirmed calibration miss is an INDEPENDENT VETO,
   never diluted into a blended score.** Raw accept/reject rate alone is rejected as blind by
   construction to the one failure mode already observed (a PR can go `review:accepted` while the same
   agent, unsupervised, would have waved through something dangerous). A single composite score blending
   success, calibration and cost is rejected **as the gate** for the same reason — it would let volume
   mathematically dilute a real miss — though publishing such a composite purely as an informational
   trend metric alongside the veto is not foreclosed.
3. **Per-role, never one global bar — the bar scales with the role's eventual authority.**
   `advisory-review` (structurally non-gating, per `NEVER_BLOCKING_ROLES`) earns the lightest bar;
   `delivery` (unattended code lands) a moderate bar; any future blocking/gating reviewer role would earn
   the strictest bar, should one come to exist. Proportionality between evidence required and authority
   granted is the ratified default; only the *shape* (scale by authority) is ratified now, any tier's
   specific N is deferred exactly as clauses 1–2 defer theirs. (Whether such a role exists yet, and what
   still needs building, is tracked on `#3654` itself, not restated here.)
4. **One uniform FLOOR for every `{provider, model}` identity; no identity buys an easier bar on
   reputation.** Directly grounded in PR #2182's own text: promotion never inherits authority "by vendor
   reputation, or by benchmark claims made outside this system." A project MAY still configure a
   *stricter* bar for a provider class it independently distrusts — an optional per-project tightening,
   not a rival branch — consistent with
   [#blast-radius-advisory-care-not-a-gate](#blast-radius-advisory-care-not-a-gate)'s already-ratified "a
   repo may tighten a scored signal to a gate as config" precedent. Differentiation across identities
   happens only through the *data* each identity accumulates against the one shared floor, never through
   a differently defined bar.

**Not built here, by design.** No graduation-check function is written and no threshold is wired into
`we:model-probation.mjs` by this ruling — it rules on the shape of the bar; wiring a concrete threshold
is separately-scoped future work, proposed only once a real trial-count distribution exists per role.

**Lineage:** ratified via `#3654` (2026-09-13), filed under the background mechanical dispatcher epic
`#3383`, grounded in `we:reports/2026-09-12-run-quality-benchmark-for-dispatched-agent-runs.md` and
composing with (not duplicating)
[#agent-convergence-independent-validation](#agent-convergence-independent-validation) (`#2398`: staged
auto-fix autonomy is a sibling axis keyed by repo, not by provider/model trust). Full reasoning:
[#3654](/backlog/3654-define-graduation-criteria-for-a-model-provider-to-exit-prob/).

### A triggered calibration veto clears only through a root-caused, similarity-matched trial bar — decay and trust never substitute for it {#calibration-veto-clearing}

**Ratified 2026-09-14 by the operator (Nicolas Gilbert), all four forks approved as prepared, no
amendments (`#3673`).** Extends
[#model-probation-graduation-criteria](#model-probation-graduation-criteria)'s independent calibration
veto (`#3654` clause 2: a confirmed calibration miss is an INDEPENDENT VETO, never diluted into a blended
score) with the shape of how a triggered veto is ever lifted — a question that ruling's own "Done when"
left as an out-of-scope follow-on, not a re-litigation of the veto rule itself. Four clauses; **no
concrete numeric threshold is fixed by any of them** — each names what a follow-on ordinary (batched)
finding must propose once real trial-count data exists, never a separate ceremony:

1. **Root-cause precondition — a documented root-cause finding is required before any post-miss trial
   counts toward clearing.** The finding must name which of `we:scripts/lib/jury-core.mjs`'s
   `deriveFindingDisposition` sub-answers (`introduced`, `worseThanBase`, `parallelizable`) diverged
   between reviewers and why (or the equivalent diagnostic for a future non-jury-core review mechanism).
   Trial volume alone is rejected as gameable without ever diagnosing why the miss happened — a fix whose
   relevance to the calibration mechanism is plausible but unestablished does not itself count as a
   root-cause finding, whatever coverage gap it separately closes.
2. **Trial evidence bar — a fixed minimum count PLUS at least one similarity-matched trial, never count
   alone.** Once eligible, clearing requires a minimum trial count N and at least one trial specifically
   targeting a case similar in kind to the trigger (a severity-ambiguous, borderline-blocker-vs-carve-out
   case); a deliberately constructed test scenario satisfies this when a naturally-occurring one is
   scarce. N dissimilar clean trials never suffice — the same selection-bias objection
   [#model-probation-graduation-criteria](#model-probation-graduation-criteria) clause 1 already applies to
   initial graduation, reused here by direct analogy. Exact N deferred.
3. **Decay alone never clears the veto.** A cooling-off/decay window may narrow which trials are eligible
   to count (for example, only trials run since a relevant fix landed) but never substitutes for the
   affirmative clean-trial evidence clauses 1–2 require. Elapsed trial count or elapsed time alone, with no
   clean/relevant requirement, is temporal dilution of the same kind
   [#model-probation-graduation-criteria](#model-probation-graduation-criteria) clause 2 already forecloses
   for a blended composite score.
4. **Human override only as a narrow, documented factual reclassification — never a trust grant.** An
   override is available only on identity/evidentiary grounds: the cited finding fails independent
   verification, the "same bug" framing does not actually hold (the two reviewers were not in fact looking
   at the same finding), or a bookkeeping error in how the trigger was recorded. Re-answering the
   disposition sub-judgments themselves — `introduced`/`worseThanBase`/`parallelizable`, or the equivalent
   severity sub-judgments for a future non-jury-core mechanism — on confidence or trust alone is explicitly
   out of scope for any override, at any point; doing so case-by-case would let every future miss be argued
   away on the same substantive grounds the veto exists to catch.

**Not built here, by design.** No `calibrationMiss` (proposed) field is added to `we:model-probation.json` and no
clearing-check function is wired by this ruling — it rules on the shape of clearing; wiring a concrete
mechanism is separately-scoped future work. The live PR #2107 veto on Codex's `advisory-review` role is
not cleared by this ruling itself: clearing it requires either clause 1's root-cause finding followed by
clause 2's similarity-matched trials, or clause 4's narrow reclassification override on its own facts —
never the tooling-asymmetry finding alone.

**Lineage:** ratified via `#3673` (2026-09-14), filed under the background mechanical dispatcher epic
`#3383`, extending [#model-probation-graduation-criteria](#model-probation-graduation-criteria) (`#3654`)
and grounded in `we:reports/2026-09-14-calibration-veto-clearing-grounding.md`. Full reasoning:
[#3673](/backlog/3673-define-what-clears-a-triggered-calibration-veto-so-a-role-ca/).

### A delegated agent's trial record governs every read of it; the bar is a shape, demotion is computed, promotion is ratified, and the independent look gets shallower but never goes away {#delegation-trial-record-graduation}

**Ratified 2026-09-21 by the operator (Nicolas Gilbert), all five forks approved as prepared, no
amendments (`#3690`).** Applies [#model-probation-graduation-criteria](#model-probation-graduation-criteria)
and [#calibration-veto-clearing](#calibration-veto-clearing) to the delegation-trial record — the
`dispatchKind: "session-delegation"` rows in `we:scripts/conveyor/run-scorecards.json`, written through
`we:scripts/conveyor/log-delegation-trial.mjs` and read by `we:scripts/lib/provider-routing.mjs`. The unit
of trust is the triple `{provider, model, taskType}`, and trust never carries across triples. **No numeric
threshold is fixed by any clause below.** Seven rules:

1. **What the record governs — every read of it.** One record has two consumers: choosing *which provider
   gets the work* (`selectProvider` and its fitness test) and choosing *how much checking the result gets*
   (`selectSupervisionLevel`). Both read the same predicates, so this ruling binds both. Changing what counts
   as a clean or an informative trial is a governed change wherever the record is read, never a local edit
   to one consumer.
2. **Authority is not earned by a streak.** What a delegated agent may DO — commit, push, open a PR, land —
   comes only from the typed-operation catalog, per
   [#agent-mutations-through-typed-operations](#agent-mutations-through-typed-operations). Neither a trial
   streak nor a transport's prompt text or sandbox grants it. A streak moves supervision depth and provider
   fitness, nothing else.
3. **The evidence bar is a shape: a trailing clean streak, plus a positive control, plus a clean most recent
   verified trial, with a confirmed miss as a hard veto — per triple.** The streak length N is a
   `backdownThresholds` config default (`DEFAULT_BACKDOWN_THRESHOLDS` in
   `we:scripts/lib/provider-routing.mjs`), proposed and changed by an ordinary batched finding against real
   data, never by a decision ceremony. A confirmed miss resets the triple at once; it is never averaged into
   a score — **except when rule 5's tooling-caused-and-fixed path applies to that miss, in which case the
   reset is superseded and the triple keeps its graduated level.** A concurrent-baseline comparison (the same
   task run through Claude and through the delegated provider, judged on the difference) is the preferred
   evidence shape over raising N.
4. **What makes a trial informative — its own recorded field.** A trial is the positive control only when a
   separate `informative` field on the row says so, meaning *independent review found a real problem on this
   trial that was then fixed*. It is never inferred from `outcome` (which means only "did this trial land")
   or from the free-text `findings`.
5. **Re-graduation after a miss — automated attribution first, then a fix or a bar, never a human gate by
   default.** After a miss, an automated classification step — run by a model distinct from the delegated
   triple, never the triple itself, never inferred from free text — records a `rootCauseClass` (`tooling` or
   `vendor`) alongside the existing root-cause note. **A missing or invalid class fails closed to `vendor`. A
   `tooling` class must cite a concrete landed fix (`rootCauseFixRef`, a PR or commit reference), never bare
   prose.** A narrow human override exists, mirroring [#calibration-veto-clearing](#calibration-veto-clearing)'s
   own override: a human may correct a classification or a recurrence tag only on identity/evidentiary grounds
   (the cited fix does not actually exist or does not match the miss, the classifier misread the row) — never
   to re-litigate whether a landed fix is good enough, and never as a routine step. When the class is
   `tooling` and the fix has landed, **the triple keeps its graduated level — no demotion, no post-miss bar,
   no reentry streak.** The automatic step-back to `full` fires only when the miss is both **critical** (the
   existing dispatch-risk / never-spot-check / human-required proxy already computed for the work — never a
   new bespoke scale) **and cannot be improved by tooling** (no fix nameable, or a fix landed and the same
   failure class recurred — recurrence detected by the same distinct classifier, never a proactive proof-trial
   requirement) — **or a named tooling-miss cap (a lifetime count, not a decaying one, tunable only by a
   future ordinary batched finding, the same mechanism that tunes `minCleanStreak`/`k`) has been reached for
   the triple, which reclassifies the pattern as vendor-caused regardless of any single incident's own
   criticality.** A tooling fix proven for one triple never clears or extends to another triple's
   classification, fix credit, or cap count; the same root-cause finding may be referenced across triples that
   share the cause, but each accumulates its own evidence. This is the same principle as
   [#calibration-veto-clearing](#calibration-veto-clearing), applied to a delivery trial rather than a
   reviewer's disposition, with independence satisfied by a distinct automated validator rather than a
   required human (per
   [#agent-convergence-independent-validation](#agent-convergence-independent-validation)).
6. **Who moves a level — the data demotes when the bar above is met, the operator promotes.** Demotion is
   computed from the record **exactly as rule 5 above gates it** — never unconditional on a bare confirmed
   miss — and takes effect immediately once the criticality-and-unfixable test (or the repeated-miss cap) is
   met. Promotion to a lighter level takes an explicit ratified act naming the triples promoted, done in
   batches against accumulated data, never per dispatch and never per trial. **This includes restoring a
   triple that was actually stepped back under rule 5's critical-and-unfixable path**: meeting whatever bar
   applies is never itself sufficient — the ratified act also confirms the classification and cap state that
   put it there. With no such act, a stepped-back triple stays at `full`. This triple axis composes with the
   repo axis of [#agent-convergence-independent-validation](#agent-convergence-independent-validation): the
   repo axis says whether a repo permits staged autonomy at all, the triple axis says how much checking a
   delegated draft gets inside a repo that permits it, and a repo-level `none` is never overridden by any
   triple's level.
7. **The verification floor — shallower, never absent.** At every level the orchestrator reads the real diff
   and rules on it, and runs the close-out gate itself and reads its output
   ([#model-routing](backlog-workflow.md#model-routing) Inline (2) and (5)); a delegated run's exit code is
   never the verdict. The separate independent pass keeps full coverage and moves only in depth: a full
   independent review at `full`; at `spot-check`, the
   [#every-pr-gets-a-look-advisory-floor](#every-pr-gets-a-look-advisory-floor) shape (one tool-free juror,
   one round, the diff and the item card, capped findings, non-blocking). A finding from that pass files a
   follow-up item, and the floor's cost and yield are measured and reported. Any provider may fill the
   reviewer seat; a different provider from the builder is preferred, never required.

   **A level below `spot-check` — lighter or absent — was proposed and declined (#3867):** `spot-check` is
   the delegated PR's own review at the
   [#every-pr-gets-a-look-advisory-floor](#every-pr-gets-a-look-advisory-floor) shape, and a producer's
   record never exempts a PR from that floor. The spot-check pass runs **asynchronously, off the landing
   path**: it never holds or delays a merge — it may run after land — and it records its verdict; a finding
   files a follow-up item (#3867).

**Reach.** Mechanical provider routing binds the mechanical dispatch path only. An interactive orchestrating
loop keeps its own inline routing verdict under [#model-routing](backlog-workflow.md#model-routing) Inline (3)
and [#effort-routing](backlog-workflow.md#effort-routing); the router may inform that verdict, never replace
it.

**What this ruling does not do.** It sets no threshold value and does not itself switch on any dispatch gate
that reads the supervision level; turning such a gate on is separately-scoped work tracked on the backlog.

**Lineage:** ratified via `#3690` (2026-09-21), filed under the background mechanical dispatcher epic
`#3383`, grounded in `/research/delegation-graduation-and-supervision-tiers/` and
`we:reports/2026-09-20-delegation-graduation-model-grounding.md`, extending
[#model-probation-graduation-criteria](#model-probation-graduation-criteria) (`#3654`) and composing with
[#calibration-veto-clearing](#calibration-veto-clearing) (`#3673`). Full reasoning:
[#3690](/backlog/3690-track-and-consider-graduating-session-initiated-codex-delega/).

### An agent vendor registers by one descriptor module in one explicit static index; a descriptor declares mechanics only; a marked vendor that cannot run a kind is refused for `build` and repaired-around for `fix`/`ci-heal`, recorded apart from routing {#agent-vendor-registry}

**Ratified 2026-09-21 by the operator (Nicolas Gilbert), all four forks approved as prepared, no
amendments (`#3658`).** Governs how an agent *vendor* (Claude, Codex, Antigravity, and any later one) is added
to the mechanical dispatch path. The card as filed named the launch-kind table
(`DISPATCH_PROVIDER_REGISTRY`); the prep found the collision is on the vendor axis, in three per-wrapper
vendor tables, not in that table. Five rules:

1. **The rule governs the vendor axis; the kind table stays a closed, hand-edited, load-checked table.** A
   kind exists because `we:scripts/operations/dispatch-lane.mjs` names it in `LAUNCH_KINDS`,
   `BRIEF_REQUIRED_BY_KIND` and `sessionSlugFor`. A per-kind descriptor could not make a kind exist, so it
   would only look like ownership of a set it cannot change. Converting only the kind table (the card as
   filed) leaves the vendor collision untouched.
2. **One descriptor module per vendor, listed in one explicit static index.** Each vendor is one file,
   `we:scripts/operations/agent-providers/<vendor>.mjs`, holding its per-kind spawn adapters.
   `we:scripts/operations/agent-provider-registry.mjs` imports every descriptor statically and checks them at
   load; every wrapper and every `*-run.mjs` selector resolves a vendor through it, per kind. The set of
   vendors that can run is therefore visible in source and in the import graph. **Runtime directory discovery
   is rejected**: a stray, half-written or leftover file would become a live dispatch path with no line that
   says so, and graph-derived checks would go blind. **Three per-wrapper tables are rejected**: tests hold
   them equal, so every vendor must cover every kind or none, and a vendor's per-kind capability cannot be
   stated. The index is hand-written, with a test that it and the `agent-providers/` directory list the same
   vendors.
3. **A descriptor declares mechanics only.** Its fields are `name`, `routingProvider` (the provenance id in
   `PROVIDERS`), `kinds` (one spawn adapter per launch kind it can run; a missing kind is a hard *cannot*) and
   informational `sandbox` facts that no gate reads. A descriptor **never** declares its own fitness, trust,
   supervision level or cascade rank: that would be self-certification, against
   [#model-probation-graduation-criteria](#model-probation-graduation-criteria) and
   [#delegation-trial-record-graduation](#delegation-trial-record-graduation), and a rank spread across files
   would make the routing order depend on which files merged. Which vendor is *offered* stays the router's
   call (`we:scripts/lib/provider-routing.mjs`, fixed criteria); a descriptor never makes, weighs or orders it,
   and registering a vendor grants it no operation
   ([#agent-mutations-through-typed-operations](#agent-mutations-through-typed-operations)).
4. **A marked vendor that cannot run this kind: refuse for `build`, fall back for repairs, and record it in
   its own fields.** For `build` the `deliveryAgent:` marker is a per-item choice of who *delivers*, so a
   vendor without a `build` adapter is refused by name **before a lane is acquired**. Quietly delivering with
   Claude would replace the human's explicit choice for the one kind the marker exists for. For `fix` and
   `ci-heal` the dispatch falls back to `claude-restricted`, because a repair to an open PR should still
   happen and who delivered the item is not at stake. The fallback is recorded as `requestedVendor`,
   `executedVendor` and `reason`, kept **apart** from the router's `routedProvider`/`executedProvider`, so a
   marker fallback is never counted as a router delegation gap in the trial data.
5. **A broken descriptor fails loudly at load, naming the file.** Every descriptor is checked when the
   registry loads (`name` unique, `routingProvider` in `PROVIDERS`, every `kinds` key in `LAUNCH_KINDS`, every
   adapter has a `spawn`), and a failure throws a `TypeError` naming the file, the field and the rule. It is
   never skipped and never checked only on first use. An unknown vendor name is refused by name before a lane
   is acquired. The registry is imported only by the wrappers and the `*-run.mjs` entry points, never by
   `we:scripts/lib/dispatch-contracts.mjs` or `we:scripts/operations/dispatch-lane-io.mjs`, so no import cycle
   forms and spawn code stays out of the pure library.

**Reach.** Governs vendor registration on the mechanical dispatch path, and only that. The kind table, the
routing call, the trial record and the typed-operation catalog keep their existing homes and owners; the
conveyor still starts agents only through the `dispatch-lane` operation
([#conveyor-dispatch-calls-the-declared-operation](#conveyor-dispatch-calls-the-declared-operation)), and a
descriptor's spawn adapter runs only inside the wrapper that operation launches.

**Where it is built.** The three vendor tables, the kind registry and `we:scripts/lib/dispatch-contracts.mjs`
exist only on the declared POC branch `lane/mechanical-dispatcher`
([#poc-branch-declared-delivery-mode](#poc-branch-declared-delivery-mode)). The refactor lands there and
reaches main through `#3443`'s small reviewed slices; only this codification lands on main.

**Lineage:** ratified via `#3658` (2026-09-21), filed under the background mechanical dispatcher epic `#3383`,
grounded in `/research/dispatch-provider-registration/` and
`we:reports/2026-09-21-provider-registration-grounding.md`. Full reasoning:
[#3658](/backlog/3658-self-registering-provider-descriptors-for-dispatch-provider/).

### Every reviewer seat holds the same tool surface — declared operations only — inside a provider-independent container; the mandatory seats move only after a replay parity gate; the Codex seat inherits the calibration veto {#reviewer-tool-surface-and-containment}

**Ratified 2026-09-21 by the operator (Nicolas Gilbert), all four forks as prepared, no amendments
(`#3675`).** The card's two 2026-09-19 steers (one tool surface for every reviewer whatever the provider;
"allow some tools, ideally only codified operations"), relayed through a peer session, stand ratified with
it. Extends [#agent-mutations-through-typed-operations](#agent-mutations-through-typed-operations) and
[#operations-declared-once-callers-generated](#operations-declared-once-callers-generated) to the review
seat, and composes with [#calibration-veto-clearing](#calibration-veto-clearing) and
[#model-probation-graduation-criteria](#model-probation-graduation-criteria). Four clauses:

1. **Surface — a reviewer's only tools are declared operations, delivered as typed MCP tools; every
   built-in shell, read, write and edit tool is removed, for every provider.** One operation server serves
   Claude and Codex alike. The catalog gains four operations (`inspect-file`, `inspect-search`,
   `inspect-git` with typed subcommands only, `run-suite`), and `mutation-check` gains confinement: the
   server, never the model, pins the checkout and `--target` must resolve inside it. This is the
   reviewer-seat form of #agent-mutations-through-typed-operations clause 1 — the operation catalog is how a
   reviewer's reads become sandboxed, since neither provider's native sandbox confines them — and the
   typed-tool caller clause 1 of #operations-declared-once-callers-generated names. A capability gap is a
   `missing-operation` finding: halt and surface, never a workaround
   ([#dispatched-agent-never-runs-commands-directly](#dispatched-agent-never-runs-commands-directly)).
   **Enforcement differs in kind and is stated, not hidden:** for Claude it is preventive (`--tools ""` with
   the `system/init` tool list asserted in the run record); for Codex it is detective (every tool executed
   appears as an item in the `--json` stream, and any item that is not a server call voids the run and fails
   closed) plus a per-release canary that fails when a release changes the tool list. A provider that cannot
   be reduced to the operation server's tools cannot seat a tool-bearing review. **Raw shell and writes for
   the reviewer stay the pre-declared escalation, never the default:** a raw surface adds an exfiltration
   path under prompt injection from PR text, leaves the model's "I ran it and it reddened" claim
   unverifiable where `mutation-check`'s typed outcome cannot be forged, and conflicts with clause 1's
   network-and-installs rule; it may be invoked only inside the clause 2 container, with a network policy and
   no token in the guest, and only if the clause 3 replay shows the operations surface missing findings the
   raw surface catches.
2. **Containment — every tool-bearing seat's model and its operation server run inside a container over a
   history-stripped, throwaway full clone (siblings included), never a pooled lane.** The container is the
   only preventive boundary that does not depend on enumerating a provider's tools, and it also contains the
   operation server, which runs outside Codex's own sandbox. It is ruled as a **backend-neutral OS-level
   isolation provider** behind the seam in `we:scripts/lib/isolation-provider.mjs`, so it does not pre-empt
   the open Apple-`container`-versus-other-backend choice on
   [#3621](/backlog/3621-real-os-level-resource-isolation-per-dispatched-lane-is-appl/). Conditions: a
   network policy for the guest; no auth token inside the guest (a host-side proxy, not the interim in-guest
   path); the mount is the stripped clone only. Until the container backend exists, a tool-bearing seat runs
   on the host only where its tool list is preventively verified (Claude); a provider whose list is only
   detectively verifiable does not seat a tool-bearing review on the host. Where the PR's own test suite
   executes is a separate, coexisting matter: it routes through `we:scripts/readiness/heavy-admission.mjs run
   --container` wherever one is available.
3. **Evidence — the mandatory Claude seats (correctness, security) do not move onto the new surface until a
   replay parity gate passes, then a non-blocking shadow run.** Replay the recorded review corpus
   (`we:scripts/review-corpus/mine-review-corpus.mjs`) through the operations surface and the raw-tool surface the jurors use now;
   the new surface must not miss a confirmed label the old one caught. The replay includes PR #2107 and a
   constructed severity-ambiguous case. Codex's advisory seat moves first because it blocks nothing.
   Moving every seat on ratification is rejected as an unmeasured reduction on the land gate.
4. **Veto — the tool-bearing Codex seat inherits the #2107 calibration veto; it is the same role.**
   [#calibration-veto-clearing](#calibration-veto-clearing) governs: replaying #2107 through the
   operations-only Codex seat is the clause 1 root-cause diagnostic (record which of `introduced` /
   `worseThanBase` / `parallelizable` diverged and whether tools changed it). Trials before that finding do
   not count; trials after carry the tool surface, the pinned `-m` and the `codex --version` (Codex reports
   no model id), and a tool-bearing trial gets no easier bar
   ([#model-probation-graduation-criteria](#model-probation-graduation-criteria) clause 4). A fresh role
   identity that starts clean is rejected: it would let a configuration change wipe a veto.

**Supported by default, not decisions.** Re-seat Codex on the `correctness` lens (tools on the `simplicity`
lens change nothing); context isolation is composed (`-c project_doc_max_bytes=0`, a history-stripped
clone, the native deny for the doctrine file, a path denial inside `inspect-file`); the Codex seat stays
advisory and `--judge-provider=codex` stays refused, pointing at the per-request pin
`REVIEW_PR_CODEX_ADVISORY=1`.

**Not built here, by design.** This ruling builds nothing: the operation server, the four declarations, the
`mutation-check` confinement, the launch recipes with their per-release canary, the container provider, and
the juror-replay harness are separately-scoped, separately-prioritized items. Known defect to fix before the
`inspect-git` operation is built: it needs history, but the strip factory clones with `--depth 1`
(`we:scripts/lib/isolation-provider.mjs:261`). Not verified at ratification: whether the Apple guest network
can be restricted, whether `--restricted` keeps `we:CLAUDE.md` out of a Claude reviewer's context, and
whether Antigravity can be reduced to the server's tools at all (`#3633` found its in-process tools ignore
its sandbox), which would make clause 1's same-surface rule unhonourable for that provider.

**Lineage:** ratified via `#3675` (2026-09-21), filed under the background mechanical dispatcher epic
`#3383`, grounded in `/research/codex-review-seat-tool-surface-and-isolation/` and
`we:reports/2026-09-19-codex-review-seat-tool-surface.md`; Forks 1 and 2 were re-derived on merit and
red-teamed on 2026-09-21 before ratification. Full reasoning:
[#3675](/backlog/3675-give-codex-s-review-seat-container-scoped-write-access-to-a/).

### A caller-supplied string that becomes a spawned CLI's argv is validated at its own seam in the argv builder — a whole-argv denylist records a trap, it is never the boundary {#argv-builder-validates-caller-strings-at-its-own-seam}

**Ratified 2026-09-21 by the operator (Nicolas Gilbert), the one fork approved as prepared, no amendment
(`#3056`).** The situation: a helper builds an argv **array** for a spawned CLI (no shell), and one or more
options are free strings the caller supplies. A value spelled like a flag lands in the array where the CLI's
own parser may read it as a flag. The rule has four clauses:

1. **Validate each free-string option where the argv is built, and refuse a value whose first character is
   `-`.** No real value of such an option starts with `-` (a model name, a prose mandate), and every CLI flag
   does, so the refusal loses nothing. An option with a closed value set (an enum, a number, a UUID, a plain
   identifier) is checked against that set instead — the same per-field discipline, a stricter test. The check
   runs at the source, so the helper never depends on how the third-party CLI parses a flag-shaped value.
2. **A whole-argv denylist is a trap record, never the defense.** It can only name traps someone has already
   found, so it is always one measured spawn behind the next flag-shaped value. It may stay layered underneath
   the per-field checks as the named record of a specific trap; it must not be the only thing standing.
3. **Do not build a position-aware allowlist over the assembled argv to do this job.** To be correct it must
   know which tokens are value slots, which is a fact the builder already has when it writes them — rebuilding
   it after assembly duplicates the builder's fixed-order shape and couples the guard to it.
4. **The recurring cost is paid by a test, not by memory.** Every future free-string option must add its own
   check, and nothing structural notices a forgotten one — so the builder carries a test that walks its options
   and fails on an unguarded free-string one. An outer layer that also refuses such a value must call the same
   predicate, never a second rule for the same field.

**Scope, so the rule is not stretched.** It governs option *values* that reach flag positions. It does not
decide which executable is spawned, or the child's working directory or environment — none of those is parsed
by the CLI's flag grammar, so they are a different question and get their own ruling when a caller-influenced
value for one exists. Cited as **supporting precedent, not binding authority**:
[#guard-unresolvable-reexecution-denies](#guard-unresolvable-reexecution-denies) rules that an enumeration
cannot be completed from inside the thing being enumerated; that anchor's scope is unbounded shell text, whereas
a CLI's flag names are a finite documented set, so it does not by itself rule out an allowlist here — this rule
is decided on the merits above, and the shared lesson is only that an enumerate-and-extend defense is the wrong
shape for a boundary.

**Lineage:** ratified via `#3056` (2026-09-21), under the operation-engine epic `#3029`, grounded in
`we:reports/2026-08-16-3056-judge-spawn-argv-guard-prep.md`; the prepared grounding was re-checked against the
tree at ratification and the ruling did not change. Full reasoning and the rejected options:
[#3056](/backlog/3056-the-judge-spawn-argv-guard-is-a-one-token-denylist-a-flag-sh/).

### An approval carries across a push only when the drain replays the merge of main itself and gets the pushed tree; a conflict, a non-merge commit, or main touching the PR's files re-parks {#merge-only-push-approval-carry}

**Ratified 2026-09-21 by the operator (Nicolas Gilbert), all four forks approved as prepared, with the
prepared guardrails, no amendment (`#3735`).** The situation: a PR holds a `review:accepted` acceptance
(including one turned from `review:human` by `--to=clear-human`), and its head then moves because someone
merged `main` into it. Without a proof, a head move the content digests cannot cover re-parks the PR and costs
a second approval (#2365, #2347). The rule:

1. **What proves a push only merged main — replay each merge.** Resolve the acceptance's `reviewed-sha` to a
   full SHA and walk from the live head back to it. Every commit on that path must be a merge with exactly two
   parents: one parent is (or descends from) the reviewed SHA — the PR side, **found by ancestry, never by
   parent position** — and the other is an ancestor of `origin/main`. Each link's PR-side parent must be the
   next commit on the path (a disconnected chain does not carry), and the path must end at `reviewed-sha`. For
   each merge, `git merge-tree --write-tree <parent 1> <parent 2>` must exit 0 (no conflict) and print a tree
   **equal** to the merge's own tree. A commit message, a commit's shape or its pusher proves nothing.
2. **A non-merge commit anywhere on the path means no carry.** An author commit followed by a merge of main
   re-parks. A true rebase (rewritten history) is out of this rule's scope and stays with the digest tiers of
   `#3054`.
3. **The replay is hermetic.** It runs with no rerere (`-c rerere.enabled=false`), no configured merge
   drivers, the default strategy with no `-X` option, rename detection pinned to git's default
   (`-c merge.renames=true`, so the drain clone's own config cannot change the result), and attributes read
   from the empty tree (`-c attr.tree=<empty tree>`). `attr.tree` hides only the in-tree `.gitattributes`: a
   driver (or git's built-in `union`, which needs no driver config) can still be selected through
   `$GIT_DIR/info/attributes`, `core.attributesFile` (default `$XDG_CONFIG_HOME/git/attributes`), the system
   attributes file, or local, global, system or environment config. So "no configured merge drivers" also
   needs `-c core.attributesFile=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, `GIT_CONFIG_NOSYSTEM=1`,
   `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS` unset, and a replay run
   outside the drain clone's `$GIT_DIR` (a scratch repository that borrows its objects through
   `objects/info/alternates`), so the clone's own config and `info/attributes` do not apply. With every route
   closed, an author's custom driver, rerere or `-X` option can only cause a missed carry, never a wrong one.
4. **A clean merge that touches files main changed does not carry; it re-parks.** Carry only when the files
   main's side brought in (`git diff --name-only --no-renames <PR-side parent> <merge>`) share nothing with the
   files the reviewed PR changed. Otherwise the PR re-parks. Both file sets are read with `--no-renames`, so a
   rename counts as its old path plus its new path: a main-side rename of a PR-touched file A to a new path B
   lists A and re-parks, instead of collapsing to B alone and slipping past the overlap test.
5. **The drain's own merges obey the same rule.** A `rebaseDropContent` merge (content auto-resolution) on an
   accepted PR re-parks instead of re-stamping. A `rebaseDropManifest` merge (manifest only, no PR file
   touched) still re-stamps, but only when the lane tip it merged in is itself covered by the current
   acceptance (the same SHA or digest test `acceptanceCoversHead` applies); otherwise it re-parks.
6. **`review:human` and `review:accepted` follow the same rule.** A carry of a human clearance never copies
   the `cleared-human` marker; its comment may name its origin with a distinct `carried-human-from: <sha>`
   marker, which no gate parses. The carry reaches the anti-test-tampering gate only through the local,
   CLI-written ledger of `#3179`; until that ledger exists, a carried human clearance **does not** suppress the
   anti-test-tampering re-park.
7. **Fail closed when the proof cannot run.** A failed git read, a reviewed commit that cannot be resolved, or
   any error means **no carry**, and the gate judges the head as if no carry route existed.
8. **The stamp is bound to the proven head.** `we:scripts/review-set-label.mjs --to=restamp` takes
   `--expect-head=<full sha>`, **required** for a restamp: it refuses (non-zero exit, no comment, no label
   move) when the flag is missing, is not a full 40-hex SHA (a prefix refuses), or the live head differs from
   it. The carry passes the head its proof reached; the drain's own rebase passes the commit it pushed. The
   `reviewed-sha` marker the restamp writes **is** the `--expect-head` value, never a re-read of the live head:
   comparing the head and then stamping a second read would reopen the same race. The same holds for every
   other head-derived marker it writes: `reviewed-diff` and `reviewed-contribution` are computed from the
   `--expect-head` commit, never from a live fetch of the branch, or the restamp refuses. The carry comment
   records both the source `reviewed-sha` it carries from and the destination head it stamps.
9. **Who verifies, and where it is recorded.** The drain decides, inside the one staleness authority
   `decideReviewGate` (`#2409`), and records through the existing re-stamp path (`--to=restamp`) with its own
   comment heading, stamped `--actor=drain` and naming the original clearer. The pusher never certifies its own
   push. A carry never creates an acceptance: `restamp` still refuses with no `review:accepted`, with
   `review:human` present, or with `review:changes`.

**What still re-parks, unchanged.** A conflicted merge gets full re-clearance through the `review:changes`
bounce of [#parked-pr-conflict-dispatched-not-scripted](#parked-pr-conflict-dispatched-not-scripted). The
statute and gate-self tiers are re-derived on the live net diff every pass; the required `test` check runs on
the new head. The `reviewed-diff` / `reviewed-contribution` digest routes stay beside this one. A carry is not
the `clear-human` act, so
[#clear-human-requires-current-head-advisory-review](#clear-human-requires-current-head-advisory-review) does
not reach it. The rule does not bless outside merges of queued PRs (`#3350`); it decides only what an approval
survives when one happens anyway.

**What this ruling does not do.** It builds nothing (no carry code, no `--expect-head` flag) and changes no
gate by itself; the build is separately-scoped work tracked on the backlog.

**Lineage:** ratified via `#3735` (2026-09-21), under the acceptance-coverage epic `#3054`, grounded in
`/research/merge-only-approval-carry/` and `we:reports/2026-09-21-merge-only-approval-carry-grounding.md`,
extending `#2409` (the SHA binding). Full reasoning and the rejected options:
[#3735](/backlog/3735-may-a-review-human-approval-carry-across-a-push-that-only-me/).

### Five rulings on the #3717 dispatch-routing build's open forks: a single-worker launch routes as the work-doer, no path defaults to `other`, role dispatches are subject classes in the one graduation core, an unsized card blocks for prepare rather than assuming a size, and the per-item delivery-agent marker is the one provider override {#dispatch-routing-fork-rulings}

**Ratified 2026-09-21 by the operator (Nicolas Gilbert), all five forks reviewed interactively (`#3801`).**
Forks 1, 2 and 5 keep or settle the #3717 build's own direction, with the skeptic-pass amendments folded in;
Forks 3 and 4 reverse the build and are multi-part. Five rules:

1. **A single-worker code-change launch is routed and recorded as the work-doer (Fork 1).** A `dispatch-lane`
   launch of `build`, `fix` or `ci-heal` passes `stage: 'task'`, runs the provider-selection cascade, and its
   trial counts against its own `{provider, model, taskType}` — because the launch starts one worker that
   writes the whole card, so the launched agent is honestly the task agent, not a supervisor. Carried: the
   trial row records when a Claude converge editor also edited the lane after the agent (a single-worker lane
   is not necessarily single-editor); what satisfies a `full` supervision route for a single-worker lane is
   left to `#3784` and must be ruled before supervision enforcement is switched on. Reopens only if a
   `dispatch-lane` build ever launches separate agents per task under it (the G2 planner build) — that event
   is the trigger to file a new decision, not this one.
2. **No dispatch path produces `self-fix` or a default `other` (Fork 2).** `self-fix` and `other` are never
   produced; `conflict-resolution` is produced only from a `fix` dispatch with the `conflict` cause. A
   mechanical route never runs on trust earned on unlabelled work. Carried: any derivation that still falls
   back to `other` by default is removed or made to refuse, in the same change that builds this rule — never
   left to route silently on "we did not know."
3. **Role dispatches are subject classes inside the one graduation and routing model (Fork 3).** A role
   dispatch (`prepare`, `prepare-decision`, `investigate`, `review`) is not outside the trust model with its
   own separate mechanism; it is routed and recorded by the same core as work, with the subject key being the
   role kind or the review lens rather than a `taskType`. Trust is per `{provider, model, subject}` and never
   carries across subjects, work and reviewer evidence stay in separate subject classes, and the evidence bar
   and promotion rule are the same ones
   [#delegation-trial-record-graduation](#delegation-trial-record-graduation) already states (rules 3 and 6).
   The entry gate for a tool-bearing seat is capability — the declared-operations surface under
   [#reviewer-tool-surface-and-containment](#reviewer-tool-surface-and-containment) clauses 1–2 — never a
   streak alone. No graduated candidate for a subject means Claude, the same absent-evidence handling
   `build-new-feature` and `doc-fix` already get. Carried, as an interim: `prepare`, `prepare-decision` and
   `investigate` stay on Claude (no subject key or positive control exists for them yet) until a follow-up
   prepares one; `review-dispatch` becomes a router caller now.
4. **A code-change card that declares no size is blocked and sent to prepare, not dispatched on an assumed
   size (Fork 4).** The default is `unsizedCardPolicy: block`: an unsized card is held and routed to prepare,
   which authors a declared size (or, for a task, a declared estimate in its own field, distinct from story
   points so the burndown is not double-counted) — real, reviewed evidence beats a constant. The operator may
   instead set `default-size` (a settable fallback, an explicit ratified act, not a code constant); any
   `default-size` below the `13` band required #3784's promotion-threshold fixes to land first — the
   placeholder thresholds promoted automatically before that, so a low `default-size` would have delegated
   on an unmeasured number. **#3784 landed 2026-09-23** (the checked-in promotion record, failing closed,
   plus the enforcement flip), so this precondition is now satisfied; the constraint is recorded here for
   history, not as a live blocker. `fix` and `ci-heal` dispatches, which pass no
   size at all, are never held by this block: their size comes from the ordered fallback chain
   `card-size` → `measured-diff` → `assumed`, itself a settable option. Every dispatch that used a fallback
   records `sized: false` and where the number came from, so an assumed size is never mistaken for a declared
   one.
5. **The per-item `deliveryAgent:` marker, with a required reason, is the one provider override (Fork 5).**
   `deliveryAgent:` plus a required `deliveryAgentReason:` field is the only override surface; a marker with
   no reason is refused. Both process-wide override variables are retired for the reason a process-wide
   variable is always wrong for a per-item choice — it silently re-routes every dispatch the process launches,
   not one item: `WE_DISPATCH_PROVIDER_OVERRIDE` / `WE_DISPATCH_OVERRIDE_REASON`
   (`we:scripts/operations/dispatch-lane-io.mjs`) and `DELIVERY_AGENT_PROVIDER`
   (`we:scripts/operations/fix-run.mjs`). The marker's fields stay the
   [#agent-vendor-registry](#agent-vendor-registry) rule-4 fields (`requestedVendor`, `executedVendor`,
   `reason`); the routing record references them rather than copying them into `routed`, which stays the
   router criteria's own choice. An override never bypasses Fork 4's block on an unsized card — admission is
   decided before routing, so an unsized card with a `deliveryAgent:` marker is still held for prepare. A
   marker-driven run is a real trial of its own triple, starting at `full` supervision.

**Also settled by this review, not itself a fork, and built with the ruling whatever each fork said:**
supervision is computed for the triple that actually runs, never inherited from an override or another
triple's history; `executed` records the vendor actually spawned rather than a constant, so a Claude-only
assumption never writes a false trial row; and `routed` stays the criteria's own choice, with a human override
recorded beside it, never written over it. All three apply
[#delegation-trial-record-graduation](#delegation-trial-record-graduation) rules 1 and 3 to defects the review
found in the #3717 build, not to a new principle.

**Reach.** Forks 1 and 2 rule the dispatch-routing build's own implementation surface —
`we:scripts/lib/dispatch-contracts.mjs` and `we:scripts/lib/dispatch-task-type.mjs`, which exist only on the
prototype branch `lane/mechanical-dispatcher`, not on `main` — and bind that build's stage argument and
task-type derivation specifically. Forks 3, 4 and 5 state general principles (subject-class graduation over
role dispatches, admission policy for an unsized code-change card, and the one provider-override mechanism)
that reach beyond this one build to any mechanical dispatch path built afterward.

**What this ruling does not do.** It does not itself build the child that lands these forks (predicted
touch-set: `we:scripts/lib/dispatch-contracts.mjs`, `we:scripts/lib/dispatch-task-type.mjs`,
`we:scripts/operations/dispatch-lane-io.mjs`, `we:scripts/operations/dispatch-providers/`, and siblings) or
switch on supervision enforcement (`WE_DISPATCH_SUPERVISION_ENFORCE`, `#3784`'s work); it rules only what the
build must do when it lands.

**Lineage:** ratified via `#3801` (2026-09-21), filed under the background mechanical dispatcher epic `#3383`,
reviewing the five forks the `#3717` dispatch-routing build left open, extending
[#delegation-trial-record-graduation](#delegation-trial-record-graduation) (`#3690`) and
[#agent-vendor-registry](#agent-vendor-registry) (`#3658`), grounded in
`/research/dispatch-routing-build-review/` and
`we:reports/2026-09-21-dispatch-routing-review-and-branch-health-grounding.md`. Full reasoning:
[#3801](/backlog/3801-decision-review-the-five-choices-the-3717-dispatch-routing-b/).

---

### The conveyor serves every constellation repo through one per-repo profile — refusal is a missing capability, never "not WE" {#conveyor-multi-repo-model}

**Ratified 2026-09-23** (`3965`, operator: "I ratify") — all six forks accepted as the card's recommended
defaults. Grounded in the 2026-09-23 multi-repo audit (`we:reports/2026-09-23-conveyor-multi-repo-gap-map.md`),
which found review, verify and the drain already serving all three repos while fix and CI-heal never ran for
frontierui or plateau-app. Six clauses:

1. **Capability, not repo identity.** A conveyor stage refuses a repo only when that repo's profile
   (`we:scripts/lib/constellation-repos.mjs`) lacks the capability for the stage. A refusal keyed on "not WE"
   is the defect this rule removes. This supersedes #3803 Fork 5's acceptance of the fix-path refusal.
2. **One backlog.** Work for every constellation repo lives in the WE backlog; the repo is carried by the
   scope prefix (`we:` / `fui:` / `plateau:`), never by a second backlog.
3. **Item-less PRs are fixable.** A PR that maps to no backlog item is attributed to the PR itself, with scope
   taken from its own diff under its own repo's prefix.
4. **A fix runs its own repo's gate.** The gate comes from the target repo's profile; WE's `check:standards`
   runs additionally only when the change touches a WE half.
5. **CI-heal covers every repo.** A red required check on any constellation repo's PR is owed a CI-heal,
   capped by the durable heal-mark count.
6. **Order.** The repo profile, resolver and repo-aware-brief slices land first; turning on frontierui/plateau
   fixes and item-less-PR fixes follows them directly, without waiting on #3908 (amended 2026-09-23: #3908 is
   on HOLD, and its port rebases over these slices instead).

### A build runs as a plan of typed steps: code runs the plan, each step works in its own leased lane under its own permissions, heavy checks run once, and the design ships on probation {#planner-build-plan-and-execute}

**Ratified 2026-09-23 by the operator (Nicolas Gilbert), after an interactive review that amended Forks 2 to 6,
plus two skeptic rounds whose amendments are folded in (`#3922`).** The rule:

1. **Code runs the plan, never a model.** The build wrapper asks a planner for a JSON plan, validates it, routes
   each step through the router, runs it, and asks a checker where rule 5 requires. A model never picks which
   models do the work.
2. **Every build gets a plan,** so every build shows live steps. A single-file card gets a one-step plan built by
   code, with no model call. The planner's model follows the card's size: Sonnet below size 8, Opus at 8 and up and
   for high-risk or statute-tier work. A card with a `deliveryAgent:` marker is the hand override: that vendor
   builds it whole and no plan runs.
3. **Each step works in its own lane leased from the shared pool** (`purpose: plan-step`), started from the item
   lane's committed tip. Its diff is applied to the item lane on a temporary index and committed only after it is
   accepted, in dependency order. Parallel steps must have non-overlapping file lists. Step sessions count toward
   the existing lane-dispatch ceiling; lanes are not the CPU limit.
4. **A step's task type is derived, never declared:** from why the step exists first (planned; an apply clash is
   `conflict-resolution`; a repair of already-accepted work is `bugfix`), then from its files for planned steps.
   A path is a doc only on an allowlist of reader-facing doc places.
5. **Planner and checker are two roles** with separate trust records. A checker (Sonnet by default) gives a
   verdict on every step a non-Claude model built; a recorded miss moves that cell up to Opus; moving back down is
   the operator's act. Any delegated step parks the PR for the review panel.
6. **The router gains one exploration rule:** while a task type has no qualifying non-Claude model, a few
   low-risk steps a day, counted fleet-wide, go to the next model on an ordered table (Gemini Flash first). The
   existing cascade takes over once one qualifies.
7. **A step session is scoped:** it may edit only its own files and run only pre-approved declared operations,
   with no free shell. Anything else is a request the wrapper checks and runs (`request-run`, `request-scope`).
   Every call is an operation, so every call is tracked. Permissions are passed at launch, so a lane's trust flag
   never matters. This is stricter than, and composes with,
   [#agent-mutations-through-typed-operations](#agent-mutations-through-typed-operations); widening it to all
   agent work is a separate decision.
8. **Splitting never multiplies heavy checks:** per step only its related tests run; the full suite,
   `check:standards`, `verify-lane` and converge run once per build. The Bash guard enforces this for step
   sessions.
9. **The design ships on probation:** `planBuild` starts at `shadow`; `on` is a ratified settings change. Scripted
   tripwires compare each week's build records with the shadow baseline and file a review card, never switching
   anything off; a dated review follows 30 days after `on`. Settings change by a ratified settings change; a
   design rule changes only by reopening this decision. Exit from probation is the operator's act.

**Composes with.** [#delegation-trial-record-graduation](#delegation-trial-record-graduation) (exploration steps
are ordinary trials; no rule-1 change), [#model-probation-graduation-criteria](#model-probation-graduation-criteria)
(the probation pattern, to be generalised by a follow-up decision), and [#agent-vendor-registry](#agent-vendor-registry)
(the marker's meaning is unchanged).

**Accepted residual.** Gemini's agent can write outside its folder. Until containers (`#3621`), the launch
function checks every constellation checkout before and after each Gemini step; writes elsewhere stay accepted.

**Lineage:** ratified via `#3922` (2026-09-23), under epic `#3383`, extending `#3801` follow-up 1 (G2), grounded
in `/research/planner-build-plan-and-execute/` and `we:reports/2026-09-22-planner-build-g2-prep.md`. Full
reasoning and the rejected options:
[#3922](/backlog/3922-decision-the-planner-build-g2-a-planner-splits-a-build-into/).

---

### Every resident daemon updates itself from `main` plus opt-in live overlays — rebuilt fresh each tick, restarted between ticks, never hand-merged {#resident-daemon-reload-lifecycle}

**Ratified 2026-09-23** (`3681`, bornAs `3681`, operator, in session, in order: *"3681 ratified"* ·
*"seems simpler all on prototype for now, no?"* · *"once we have merge into main, we will still want to be able
to run fixes of a darmon live and switch back to main once it merges"* · *"yes"* (to the live-overlay design) ·
*"ratified"*). Forks 2 and 4 as re-prepared; Fork 5 amended by the operator to the live-overlay design below.
Grounding: `we:reports/2026-09-23-daemon-lifecycle-staleness-reload-prep.md` (evening addendum) and
[/research/resident-daemon-staleness-and-reload/](/research/resident-daemon-staleness-and-reload/). Seven
clauses:

1. **Reload is a clean exit at the safe point between ticks.** launchd `KeepAlive` or the supervisor relaunches
   the daemon on the new code (Node cannot unload modules, so there is no in-place reload). A restart request
   is a request file the daemon reads before its next tick. Never `launchctl kickstart -k` a daemon mid-tick:
   while a tick is inside a synchronous child call, the SIGTERM cannot run the clean handler, the lease is never
   released, and every relaunch fails until its TTL expires. This corrects the premise in
   [#drain-daemon-self-hosting-boundary](#drain-daemon-self-hosting-boundary) clause 2 that `kickstart -k`'s
   SIGTERM "runs the same clean handler".
2. **Stale = the inputs this process booted from have moved (Fork 2).** At boot every daemon records, for each
   repo it loads code from, the input heads its clone was built from: the `origin/main` sha plus each active
   overlay's head. Every tick, every daemon compares them with the clone's current inputs, whoever moved the
   clone, and exits for relaunch when they differ. Inputs are compared, not HEAD, so re-merging an unchanged
   overlay never causes a restart loop. A **5-minute restart floor**, counted from process start, applies to
   every daemon; crash loops are bounded separately by launchd's `ThrottleInterval` and the supervisor's
   backoff.
3. **The daemons move their own clone, automatically (Fork 4).** No person promotes a daemon clone. Every
   self-updating clone meets four conditions: (i) a **coded refusal of the operator's primary checkout**,
   compared after resolving symlinks, and a check that the checkout is the designated daemon clone; the
   designated-root setting ships in the plists before the check does; (ii) a **cross-daemon mutex** — a
   per-clone reader/writer lock: each tick holds a shared hold, the one process that moves the clone holds an
   exclusive one, so the tree never moves under a running tick and never has two movers; (iii) **pinned state
   paths** — state found by script location (the `.conveyor/` queue, the tracked scorecard file, the overlay
   list) lives at a root given by env or flag, per
   [#state-lives-where-its-nature-dictates](#state-lives-where-its-nature-dictates); (iv) the restart floor.
4. **The clone is rebuilt, never accumulated (Fork 4's rebuild-from-main sub-question).** Each tick the tree is
   rebuilt fresh: `origin/main`, then each active overlay merged in, in list order — the rebuild form of
   [#drain-daemon-self-hosting-boundary](#drain-daemon-self-hosting-boundary) clause 1. Before any rebuild, if the
   tree has uncommitted changes or local commits that are in none of its inputs, the daemon **refuses and
   alerts; it never wipes them**. A hand merge into a daemon clone is not a delivery path.
5. **Live overlays: a daemon may run a fix before `main` has it (Fork 5, as amended by the operator).** A
   daemon clone tracks `main` plus an **explicit list of overlay fix branches**, kept in a per-clone state file
   under its pinned state root (clause 3 (iii)), not checked in.
   - (a) **Tests pass before new overlay code is picked up** — the daemon's own tests run on the rebuilt tree
     before the live clone moves.
   - (b) **An overlay drops automatically once `main` has it**: `git cherry` against `origin/main` shows only
     `-` lines, or the overlay's PR is merged or closed. With no overlays left, the daemon is plain `main`.
   - (c) **An overlay that no longer merges cleanly is dropped with an alert**, never frozen at an old head.
   - (d) **Rollback = remove the overlay.** The trigger lives outside the daemon (new code may crash at
     import): a crash loop or a stalled heartbeat after an overlay change removes that overlay and alerts.
   - (e) **Scope: every daemon may run overlays, the review daemon included** — the operator's explicit choice
     over the re-prep's "never in a clone that reviews, labels or merges PRs". **Carve-out:** the drain daemon
     and the `merge-orphan-sweep` pass merge to `main`, so they stay `main`-only and never share a clone that
     runs overlays.
   - (f) **Graduation is unchanged.** Overlay code reaches `main` only through its own normal PR and review.
   - (g) **This supersedes the long-lived POC-branch approach for daemons** (`lane/daemon-poc`, tracking epic
     3999): a daemon never tracks a POC branch as its steady state. It is the daemon exception written into
     [#poc-branch-declared-delivery-mode](#poc-branch-declared-delivery-mode) clause 4(a).
6. **What runs is visible, and hangs are caught from outside.** Each daemon publishes its boot input heads and
   active overlays in its heartbeat or lease record, read by `runner-activity`. Every child call a tick makes
   has a timeout, and a check outside the daemon alerts when its heartbeat stops moving.
7. **Left open.** How [#drain-daemon-self-hosting-boundary](#drain-daemon-self-hosting-boundary) clause 3 (a
   daemon never approves its own daemon-code change) applies to a review daemon running an overlay whose
   graduation PR it would review was not ruled. Clause 3 stands unamended until decision card 4043 rules it.

**Lineage:** #3681 (ratified 2026-09-23; first prepared the morning of 2026-09-23, re-prepared the same evening
in PR #2546 against the live self-sync of #3954). Supersedes the POC-branch framing of 3992 and the
`lane/daemon-poc` registry entry (to be removed by 4042). Composes with
[#drain-daemon-self-hosting-boundary](#drain-daemon-self-hosting-boundary) (clause 1's rebuild form kept, clause 2's
premise corrected, clause 3 unchanged), [#poc-branch-declared-delivery-mode](#poc-branch-declared-delivery-mode)
(clause 4(a) amended) and [#state-lives-where-its-nature-dictates](#state-lives-where-its-nature-dictates).

---

## Standing process & method rules (codified in the topical docs — pointers)

These are already enforced/written elsewhere; listed here so the platform's rules are findable from
one place:

- **Design-first / materialization** → [design-first.md](design-first.md): document in JSON/njk
  before implementing; plan → discrete homes (reports + JSON + research topics).
- **Native-first default; config extends a platform default** → [conventions.md](conventions.md),
  [architecture.md](architecture.md).
- **Minimize lock-in; the protocol is the only lock** — devtools = zero lock-in; protocols =
  impl-swappable + graceful degradation. Forward (generation) adapters reach polyglot/enterprise
  (#463); adapter-as-normalization-hub for ingest.
- **Baseline-2024 substrate floor; polyfills opt-in** → AGENTS.md hard rule 6 (#031).
- **Backlog & decision workflow** (fork-existence test, fork-is-not-prioritization, support-all,
  prepared=DoR, reversibility, no decision+epic conflation, resolve-by-parent-edges) →
  [backlog-workflow.md](backlog-workflow.md).
- **Backlog hold model** — two mechanisms for two jobs (#1620, amends #1392): `priority: low` *demotes*
  from auto-select but stays visible (settled-but-low-value-now); `maturityGated` (+ a typed, external
  `maturityTrigger`) *removes* until build-now-stops-being-worse. Parking is never a prioritisation escape →
  [backlog-workflow.md#hold-model](backlog-workflow.md#hold-model).
- **Program definition — the strict bar for a perpetual `ongoing` epic** (four-part Program Test:
  standing goal + conformance front + currency front + cadence; watch mode is a lifecycle state;
  L0→L2 maturity ladder; "evergreen" = the property a program maintains) →
  [backlog-workflow.md#program-definition](backlog-workflow.md#program-definition).
- **Prove claims by observation** → AGENTS.md hard rule 7 / [testing.md](testing.md).
- <a id="memory-optimization-strategy"></a>**Memory-optimization strategy — right-home / prune only; eviction closed** (#1868, under watch #1855): shrink the always-loaded memory surface via rule-1 right-homing of durable rules into this doc + the AGENTS.md router (agent-read on-demand). **Evict-to-recall-only is CLOSED** — a fresh-session recall test (2026-06-27) read NEGATIVE: the harness auto-loads only the `MEMORY.md` index, so an *unindexed* topic file is unreachable and eviction would lose the fact. The index is the sole recall surface; the gate's error on any unindexed topic file is correct. Realistic reclaim is modest (most memories carry nuance beyond canon, #1881). Gate tracks the documented ~24.4 KB limit (22 KB ceiling). Full strategy → [memory-management.md#strategy--direction-the-target-architecture](memory-management.md). **Amended by #1893 — see below.**
- <a id="memory-index-tree"></a>**Memory index is a router-tree** (#1893, amends [#memory-optimization-strategy](#memory-optimization-strategy)/#1868): `MEMORY.md` is a three-tier tree — an always-loaded **category map** + a ~12-rule **core-invariants** block; recall-gated `index-<category>.md` **sub-indexes**; numbered leaf files `N-slug.md` reached by the `we:scripts/memory-resolve.mjs` router (by number or slug). #1868's eviction-closed test covered only *fully-unindexed* files; every sub-index here is reachable from the always-loaded map via the **same explicit-read router pattern** this doc already endorses, so the index drops ~20 KB → ~3 KB while the core invariants stay always-loaded. `we:scripts/check-memory.mjs` enforces the shape: the map links **only** `index-*` sub-indexes (a leaf link there is denied — the anti-regression guard), and every leaf must be reachable. Residual to watch: reliability of opening the right sub-index for *subtle* relevance. Full spec → [memory-management.md#index-tree](memory-management.md).
