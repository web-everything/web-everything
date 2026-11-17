// Canonical home of the delivery-simulator engine (Longshore). Copied 2026-11-16 from the Simulator session's engine/engine.mjs (handoff sim folder); this copy is now canonical, the sim build inlines from here.
// Plateau delivery engine (extracted from simulator.html v30.3-C.3 for v30.3-D). Pure ES module: no DOM, no storage, no network.
// Inputs and outputs are plain data: settings/state in, results out. The page (src/shell.js) and the Node tests (tests/engine.node.mjs)
// both consume this one file; build.mjs inlines it into simulator.html (names after the import line in src/shell.js).
// Page-owned context reaches the engine only through `hooks` and the setters below (setPS: the project-settings snapshot).
// Contents: hold tree + compute (capacity model), defaults/presets/migrate, the plan at a date (ptStateAt and helpers),
// the placement walk (just-in-time levers, Forge B/C, tokens), the lever catalogue (PT_JIT, TOKEN_OPTS, variants).
'use strict';
/* Page-owned context. The page sets these; Node callers leave the defaults. statePlan(): the page's current plan, used by ptHL when no plan is passed. cacheKey(): a string that changes when the plan inputs change (null = no cache). */
let PS = null; /* project-settings snapshot (page loads project-settings.json and calls setPS) */
const hooks = {statePlan: () => null, cacheKey: () => null};
const DAY = 1440;
const TIER = {light:1, mid:2, top:3};
const TIER_LABEL = {top:'Top', mid:'Mid', light:'Light'};

const M = t => ['m', t], A = t => ['a', t], D = t => ['d', t];
/* Opus share of Claude spend: today's measured mix is the calibration point (Claude $ per PR unchanged at 63%). */
const OPUS_REF = 63;
const OPUS_SRC = M('measured ~62–65% Opus / 35–38% Sonnet in every period, Oct 26 – Nov 14 (README: account findings, v22). 63 = today, the calibration point');

function defaults(){ return baseDefaultsImpl(); }
function baseDefaultsImpl(){
  return {
    v:22, waste:0, tokenSave:0, pools:[],
    value:{worth:100, reuse:0, rcr:0.2, precedent:0, months:0, growth:8, learning:0,
      src:{worth:A('share of merged work worth building. Unknown here; controlled experiments at large web companies find about a third of ideas move their metric (Kohavi et al.)'),
        reuse:M('0 = the measured profile as it is today. 59% of code PRs mostly edit existing files, but only 15 of 1,631 touched shared src/ components'),
        rcr:['d','relative cost of reusing a part vs building it new: ~0.2 (Poulin; COCOMO II reuse model gives 0.1–0.3)'],
        precedent:M('0: past decisions are not injected into live reviews yet (card 6151 open; 0 of 2,235 run records). Without them: 2.9 rounds per code PR'),
        months:A('look ahead: growth and learning compound monthly'),
        growth:D('CI/test time growth per month while the code grows: scripts/ +80%/month, CI median 14.6 → 23.9 → 18.7 min over 6 weeks'),
        learning:M('no learning curve yet: Claude $ per code PR rose in October (Opus share 30% → ~65%) and has been flat at $18–20 since')}},
    compute:{kwh:0.15, util:75, options:[
      {id:'forge', name:'Forge A: Hetzner EX101 (rented)', kind:'rent', monthly:100, vcpus:32, speed:1, note:'i9-13900 24C/32T, 64 GB; Hetzner list €84/mo + VAT (check your invoice)'},
      {id:'msa2', name:'Forge B: Minisforum MS-A2 (owned)', kind:'own', capex:1200, months:36, vcpus:32, idleW:25, loadW:80, speed:1, note:'Ryzen 9 9955HX 16C/32T; ~$799 barebone + 64 GB RAM + SSD; ~25 W idle, 68–90 W load'},
      {id:'msa2c', name:'Forge C: Minisforum MS-A2 (owned)', kind:'own', capex:1200, months:36, vcpus:32, idleW:25, loadW:80, speed:1, note:'a second MS-A2, 64 GB; same price as Forge B (A)'},
      {id:'gh', name:'GitHub-hosted standard (public repo)', kind:'meter', perVcpuMin:0, speed:1, note:'free for public repos; concurrency set by plan'},
      {id:'ghl', name:'GitHub larger runner x64', kind:'meter', perVcpuMin:0.0028, speed:1, note:'≈ $0.012/min for 4-core after the Jan 2026 price cut'},
      {id:'ubi', name:'Ubicloud', kind:'meter', perVcpuMin:0.000625, speed:1, note:'$0.00125/min for 2 vCPU standard'},
      {id:'ns', name:'Namespace', kind:'meter', perVcpuMin:0.001, speed:1.5, note:'$0.002/min for 2 vCPU prepaid; speed is a vendor-style claim'},
      {id:'bs', name:'Blacksmith', kind:'meter', perVcpuMin:0.002, speed:2, note:'$0.004/min for 2 vCPU; claims ~2× faster (vendor claim)'}
    ]},
    platform:{
      tokPerUnit:3.2, reqPerUnit:17.4,
      ghConcurrency:500, ghJobsPerRun:10, ghUtil:70, ciSpeed:1, ciSelfHosted:0, ciCoresPerJob:2,
      apiPerHour:75000, apiCallsPerPr:300, apiUtil:80, apiApps:5, apiBusiest:0.6, apiPerOpenPr:19, apiPerRepo:98, apiDaemons:6, apiRepos:3,
      supplyHours:24, rateRef:46, redScale:1, mqFailScale:1,
      laneGb:1.07, laneSpare:115, tempGb:5, diskFreeGb:89, diskLaneGb:130,
      humanMinPerPr:0, humanShare:100, humanHours:2, closedPerMerged:0, ghMinutesQuota:0, ghOveragePerMin:0.006, ciPaidPerMin:0.016,
      mergeMin:4, mergeUtil:80, mqBuilds:8, mqCiMin:18.4, mqGroup:1, mqMergeMax:5, mqWaitMin:2, ciGrowth:4.45, ciTestGrow:0.4, fullScale:1, mqFail:0.145, redMain:0.027, localAvail:90, mergeBatch:1, poolUtil:85, forgeShare:0.72, forgeShareStudio:0.72, macTestMin:72, forgeThreadMin:240, localDrop:0.379, hqKappa:1.055, hqGamma:0.349, hqCh:1.256, hqRefLq:0.15, satDip:0.38, calClaude:0.95, calCodex:1, calCodexFit:2.22, conflictPair:0.0077, conflictN0:19, conflictRounds:1.38, conflictMin:21,
      /* v30.2-A: scope hold time engine (R = P × 24 / H), census machine footprint, PR size, scope supply */
      holdOn:1, hTestMin:26.5, hTestInBuild:11.4, hTestInFix:10.3, hHeavyRef:3.55, hCmdMin:63, hFixMin:25.9, hFixRounds0:1.33, hWaitReview:140, hWaitFix:39.7, hWaitCi:28, hHeal:87.7, hWaitMq:74, hTail:330,
      hMqClean:21.5, hMqEntries:1.3, hEjectPrShare:0.177, hEjectRework:559, hCounted:0.762, openRef:692, cpuRefRho:0.746, cpuRefC:12, waitPlan:15,
      prLines:210, prLines0:210, ptsPerPr0:1.6, roundsKnee:250, roundsExp:0.77,
      dynCap:0.73, openPrCap:0, scopeTol:13, qMul:1, prepStock:257, cardShare:0.21, prepRate:5.33, freshDays:3, packA:1.14, packB:0.783, prepRate0:5.33, prepTokUsd:0.43,
      /* v30.2-B.4: the Laptop and the Studio at their busy hour, scope share, the Laptop -> Studio route, token reserve */
      u90:1.157, scopeShareStudio:0.85, cannotMove:0.10, laptopToStudio:1, rootsPerTest:5.7, gbTest:2.45, gbTestHi:3.53, daemonMergeCapHr:3, sugMinPts:2, sugMaxUsdPerPt:150, hqMinAdmit:2, hqRhoMax:0.98, studioRampDays:5, daemonRampDays:3, spinDays:7, leadDays:7, rampDays:14, hqSat:1.05,
      staleK:0.004, ideasPerDay:0,
      ramFloorGb:4, ramAdjGb:3.2, ramAdjDaemonGb:-2.0, gbScope:0.93, gbRoot:0.62, ramBurst:1, laneScriptsGb:2.8, ramCacheGb:16.1, scopes90:8.5, scopes90Ref:48, rootsPerCore:9.6, bankDays:21, forgeBWait:15,
      footOn:1, fPoll:3.0, pollMul:1, fProc:1.67, fReview:0.44, reviewMul:1, fLane:0.21, rbPerMerge:3.45, rbFixed:11, rbCpuS:220, rbShare:1, provPerMerge:17.8, provCpuS:13, provMul:1, opCpuS:130, agentScale:0.217,
      src:{
        holdOn:D('v30.2-A: 1 = merged PRs a day come from parallel scopes ÷ scope hold time (Little: R = P × 24 / H), H built from its measured parts with utilisation waits, solved as a fixed point'),
        hTestMin:M('command census (Nov 8–14, 321 merged PRs): agent heavy-test + targeted vitest wall per held scope, 20.2 + 6.3 min (n = 4,581 + 2,947 calls). Scales with the local test-run length (suite growth, reuse)'),
        hTestInBuild:M('command census: builder-worker heavy 36 h + vitest 25 h over 321 scopes = 11.4 min per scope inside the build wall (moved to the tests term, not counted twice)'),
        hTestInFix:M('command census: fixer-round heavy-test wall 55 h over 321 scopes = 10.3 min per scope inside fix rounds (moved to the tests term)'),
        hHeavyRef:M('local test run wall today (Local test runs stage, 3.55 min): the tests term scales with this stage wall'),
        hCmdMin:M('command census: ~63 min of local command wall per merged PR (217 calls: tests, node scripts, git, gh, rg). This local work slows down as the lane machine gets busy (machine wait term)'),
        hFixMin:M('op-durations Nov 1–14: conveyor fix round, active time mean 25.9 min (n = 873; gaps >10 min removed). Its test runs move to the tests term'),
        hFixRounds0:M('fix rounds per code PR today (review rounds − 1, n = 227): the fix test wall is per scope at this round count'),
        hWaitReview:D('flow-mq Nov 7–13 (n = 216 merged code PRs): created → first review 119.9 min − first PR CI 17.5 − review run, plus CI green → review 28.5 × 1.96 per PR − review runs ≈ 140 min of review hand-off waits'),
        hWaitFix:M('flow-mq: changes → fix 37.9 min × 1.05 per PR = 39.7 min of fix dispatch waits'),
        hWaitCi:D('flow-mq: fix → CI 43.1 min × 1.19 per PR, minus the re-CI runs counted on their own = 28 min'),
        hHeal:M('flow-mq: CI red → heal 93.3 min × 0.94 per PR = 87.7 min (heal dispatch, heal work, re-run)'),
        hWaitMq:M('flow-mq: accepted → enqueued 76.1 min × 0.97 per PR = 74 min (drain batching, ready checks, red-main pauses)'),
        hTail:D('flow-mq: accepted → merged 532.8 min − accepted → enqueued 76.1 − merge-queue trip 127.2 = 330 min held after acceptance (approvals, stacked PRs, parked, red main). The long tail of open time'),
        hMqClean:M('op-durations Nov 1–14: merge-queue trip without ejection, mean 21.5 min (n = 513). Scales with the full suite'),
        hMqEntries:M('op-durations: merge-queue entries per merged PR, mean 1.3 (n = 623): 0.3 retries at today\'s 14.5% ejections'),
        hEjectPrShare:M('op-durations: 110 of 623 merged PRs were ejected at least once (17.7%) at 14.5% ejections per entry. Follows the ejection rate'),
        hEjectRework:D('per ejected PR: (MQ trip incl. ejections 127.2 − clean trip 21.5 × 1.3 entries) ÷ 17.7% = 559 min of rework, re-review and re-queue'),
        hCounted:M('flow-mq: open time counted created → review:accepted (mean 692) of the 908-min open → merge mean: 0.762'),
        openRef:M('Code PR open time stage today (692 counted min): its tuning ramp (692 → 300 tuned) and the open-time cut scale the hand-off waits'),
        cpuRefRho:M('command census: laptop busy 8.95 of 12 cores (7-day mean): the local command wall above was measured at this load'),
        cpuRefC:M('Laptop cores at the measured load'),
        waitPlan:D('v30.2-B.6: no longer part of plan for (plan for = the machine targets only); kept as a readout of the delivery where utilisation waits reach 15% of the no-wait hold time'),
        prLines:M('lines added per code PR, median Nov 1–14 = 210 (p90 938; size-delivered.json). Bigger PRs: more review rounds above ~250 lines, more conflicts and ejections (∝ √lines)'),
        prLines0:M('reference PR size the round, conflict and ejection numbers were measured at (210 lines, Nov)'),
        ptsPerPr0:A('card points per code PR at the reference size: 1.6 (Sep, while cards were named; Oct–Nov points are a tagging gap). Points/day = PRs/day × this × size ratio'),
        roundsKnee:M('size-delivered (n = 1,449 code PRs): review rounds flat up to ~250 lines (mean max round 0.96–1.12), then rising'),
        roundsExp:D('rounds grow ∝ (lines ÷ 250)^0.77 above 250 lines (fit through 251–800: 1.86 and >800: 4.38 mean max round)'),
        scopeTol:D('v30.2-A2: no longer a ceiling. The random-pair overlap model (conflictPair) only sets the conflict rate among the scopes held (extra fix rounds and minutes above 19 open); the dispatcher picks disjoint sets, so overlap does not cap parallel scopes at ~19'),
        qMul:A('file overlap × this (module boundaries, hot-file splits, shared-append files; repo splits multiply it by (1 − s)² + s²). Disjoint sets grow ∝ 1/√overlap (N50 = √(2 ln 2 / q)). 1 = today'),
        prepStock:M('prepared, open, scoped, unblocked cards on origin/main now: 257, which pack into 88 disjoint sets (80 clear of open PRs); scope-contention.md §5. Dispatch-time scope checks reject 3 of ~1,820'),
        cardShare:M('share of held scopes that start from a backlog card: merged WE code PRs whose branch names a backlog card, 20.3% in October (244 of 1,201) and 21.7% Nov 1–14 (99 of 457); read-only from the PR cache + backlog/. Includes a few false hits (rule numbers like r497). The rest are fixes and tooling that do not wait on prepare'),
        prepRate:M('cards prepared per day: 16 fresh prepared cards within the 3-day freshness window (scope-contention.md, Nov 14) = 5.3/day'),
        freshDays:M('a prepared card goes stale after 3 days (prepare-stale) and cycles back to prepare'),
        dynCap:M('the adaptive cap (operator 2026-11-15 06:32 ET) holds the machine that runs the daemons and lanes at its working load: measured 8.95 of 12 Laptop cores, 7-day mean = 75%; the command-census load model puts the Laptop at 72.8% at today\'s 45/day, so 73% on the model scale. Commands the agents cause (tests, git, pnpm, provisioning, rebuilds) fill it; the delivery system does not wait on PRs, so this load is the limit'),
        openPrCap:D('0 = off. Hidden switch, never shown; the Laptop load limit replaces any fixed cap on open PRs.'),
        prepRate0:M('today\'s prepare rate (5.33 cards a day): its tokens are already inside the measured spend; only preparing above it adds token demand'),
        prepTokUsd:D('op-durations Nov 1–14: conveyor prepare run (Sonnet, n = 98) mean 1.38M tokens (mostly cache reads) ÷ 3.2M tokens per API-$ = 0.43 API-$ per prepared card, on Claude'),
        packA:D('disjoint packing of ready cards, D = 1.14 × n^0.783: 16 fresh → 10 disjoint sets, 257 prepared → 88 (greedy, scope-contention.md)'), packB:D('see packA'),
        u90:M('peak-load.json: busy-hour uplift = p90 of 5-minute busy / daily mean = 1.157 (sd 0.071, 9 full days Nov 5–13; hold-out error 4.1%, 5.4% off the calibration prediction). The 65% / 75% / 85% machine targets apply to this p90, not to the daily mean'),
        scopeShareStudio:A('share of scopes (agent sessions, lanes and the heavy commands they cause) that run on the Studio once it is on (operator 2026-11-15 07:47 ET: Studio ~0.8–0.9, Laptop small). Measure in week 1'),
        cannotMove:A('share of each machine\'s heavy commands that cannot leave the machine that owns the lane (git, install, provisioning, rebuilds, standards runs, fallbacks). Measured floor 0.04 for never-sent kinds; git/install/provisioning are not counted in runs, so 0.10'),
        laptopToStudio:A('1 = the Laptop\'s movable heavy commands go to the Studio (operator ruling 2026-11-15 07:47 ET). The Laptop keeps its cannot-move share'),
        rootsPerTest:D('heavy-test process trees per running heavy test: 11.4 roots at the busy hour ÷ 2 tests running on the Laptop = 5.7 (v30.2-B.5: waiting runs hold no memory, only admitted runs have roots)'),
        hqMinAdmit:M('heavy tests the capacity gate still runs when a machine is at or over its targets: 2 (the Laptop at 86% busy-hour CPU, heavy-queue snapshots Nov 4–14). A floor under the derived number, not a cap'),
        studioRampDays:A('days the Studio takes to receive its share of scopes and of the Laptop\'s movable heavy commands after it arrives (ends at the week-1 measures, Sun Nov 22)'),
        spinDays:A('start-up ramp: merged PRs a day double every N days after the plan starts (more cards to prepare, lanes to provision, sessions to start); the cap is on merged PRs a day, not on scopes. A time ceiling in the plan only; the row is dropped once it is far above delivery'),
        leadDays:A('days from deciding a proposed change to its first effect: build, review, merge, roll out to the daemons (v30.2-B.5)'),
        rampDays:A('days a proposed change then takes to reach its full effect (daemons restart in turn, lanes rebuild as they are leased)'),
        gbTest:A('GB of RAM per running heavy test: 4.9 GB for about 2 running tests at the busy hour = 2.45 GB measured (peak-load.md process-family table); the earlier 5.7 trees × 0.62 GB = 3.53 GB is the top of the range (2.45–3.53). Beyond the measured range this stays A until the Studio\'s week-1 numbers'),
        gbTestHi:A('upper end of the GB-per-running-heavy-test range: 5.7 process trees × 0.62 GB per tree = 3.53 GB (the Forge B order date is also given at this end)'),
        daemonMergeCapHr:A('merges an hour the daemon RAM slope is applied to: the 1.06 GB per merge-an-hour fit was measured near 2 merges an hour (R² 0.10), so past about 3 an hour the term stays flat; beyond the measured range is A'),
        sugMinPts:A('Suggest adds a milestone only if it raises Velocity by at least this many points a day at its own date'),
        sugMaxUsdPerPt:A('Suggest adds a milestone only if it costs no more than this many dollars a month per point a day it adds at its own date (a 3rd Claude seat is about $40; $500 for +4 points is about $125, $500 for nothing is out)'),
        hqRhoMax:A('queue stability line: a heavy-test queue past this share of its admitted capacity grows without bound, so delivery stops there (a ceiling, not a clipped wait)'),
        hqSat:M('calibration κ: heavy-test offered load = 1.05 × local heavy cores ÷ 1.26 (÷ the tests the machine admits)'),
        staleK:A('staleness: share of prepared cards made stale by merges that change their files = 0.4% per merged PR a day (18% at 44 a day, capped 60%). Churn cost: re-checking them re-spends prep tokens'),
        ideasPerDay:A('operator-provided card ideas a day; 0 = unlimited. The only non-token cap on preparing cards (operator 2026-11-15 08:32 ET)'),
        ramFloorGb:M('capacity gate (capacity-gate.mjs, R702): a machine is full when free + inactive memory is under 4 GB'),
        ramAdjGb:D('peak-load.md: base 15.0 + daemons 17.9 + 8.5 scopes × 0.93 + 2 running heavy tests × 2.45 = 45.3 GB against 46.5 GB measured at the busy hour, then re-based for the v30.2-B.6 test count (running tests = the queue load, not the offered trees): +3.2 GB so the Laptop still reads its measured 46.5 GB today (inside the ±4 GB unmodelled error), applied to the Laptop'),
        ramAdjDaemonGb:D('the daemons\' per-merge RAM (+1.06 GB per merge/hour = 2.0 GB at 48 a day) is already inside the measured 17.9 GB of daemon trees and lane scripts, so it is taken off once (moves with the daemons)'),
        gbScope:M('peak-load.md: 0.93 GB per active scope (Claude worker process tree; range 0.6–1.45)'),
        gbRoot:M('peak-load.md: 0.62 GB per local heavy root (vitest or verify tree; range 0.4–1.0)'),
        ramBurst:A('5-minute means hide peaks: ×1.00–1.15 on the variable RAM'),
        laneScriptsGb:M('peak-load.md: 2.8 GB of lane scripts (node) on top of the 15.1 GB daemon trees'),
        ramCacheGb:M('peak-load.md: file cache and compressor the machine lends back: total − free is 16.1 GB above the gate definition at the p90 (62.6 vs 46.5 GB)'),
        scopes90:M('peak-load.md: active scopes (leased lanes) at the busy hour: 8.5 at 48 merged a day (mean 5.0), scales with merged a day'),
        scopes90Ref:M('merged a day at which scopes90 and the heavy-root count were measured (Nov 5–14)'),
        rootsPerCore:D('11.4 local heavy roots at the busy hour ÷ 1.19 local heavy cores on average at 48 merged a day = 9.6 roots per core'),
        bankDays:A('days a banked reset can be used before it expires: the operator counts 3 Codex resets as about 3 weeks. Expiry date not known'),
        forgeBWait:D('no longer used (operator 09:53 ET): Forge B is offered when the Studio CPU or RAM is the binding limit, not by a wait share'),
        footOn:D('v30.2-A: the daemon machine\'s load comes from the command census (per tick, per open PR, per merge, per rebuild, per lane acquire) instead of the fitted "unattributed" term (not counted twice)'),
        fPoll:D('command census: short-lived git/gh/node spawns from daemon tick loops, ~3.0 of the 3.46 short-lived cores (4,679 spawns/min × 0.043 CPU-s); the rest is per merge. Lever: batch or cache polling (−1.2 to −1.7 cores)'),
        pollMul:A('1 = today; 0.5 = git/gh polling batched or cached in tick loops (census lever 2)'),
        fProc:D('command census: the rest of the daemon trees and detached jobs per tick and per time (health-watch, lease-reaper, pass readers, samplers), calibrated so the laptop totals 8.95 cores at today\'s load'),
        fReview:M('command census: review daemon per-tick PR-facts refresh, ~half of its 0.88 cores. Lever: refresh only on change (−0.4 core)'),
        reviewMul:A('1 = today; 0.1 = the review daemon refreshes PR facts only on change'),
        fLane:M('command census: lane-pool-health ×3, per lane per tick (0.23 cores live × 0.9 to the 7-day mean)'),
        rbPerMerge:M('command census: daemon self-sync rebuilds/day = 3.45 × merges + 11 (r = 0.96, n = 7 days), 7 daemon clones each rebuilding'),
        rbFixed:M('command census: the 11 rebuilds a day that do not follow merges'),
        rbCpuS:D('CPU-s per rebuild + smoke at the margin: bounded by the two-load slope (laptop +1.18 cores from 24 to 54 merged, of which heavy tests ≈ 0.8); the census upper bound 1,475 CPU-s is the average incl. fixed detached work'),
        rbShare:A('1 = every daemon clone rebuilds on its own; 1/7 = one shared rebuild + smoke per main commit (census lever 1)'),
        provPerMerge:M('command census: 818 lane acquires a day = 17.8 per merged PR (r = 0.84; smoke 19%, card-batch-seal, review-loop)'),
        provCpuS:A('CPU-s per lane acquire + release: 3.1 ps-visible in the first 120 s (census) + ~10 of short-lived git children (not separable)'),
        provMul:A('1 = today; 0.3 = prebuilt lane images / shared stores / reflinked clones'),
        opCpuS:D('other per-merge daemon work (drain, verify gates, guard sync), CPU-s per merged PR: the rest of the hourly fit\'s +0.281 cores per merge/hour'),
        agentScale:D('command census: agents are light (Claude + Codex clients 0.2 cores + their own cheap commands 0.05 at today\'s load = 11.6 CU per code PR); the stage core inputs are scaled by this to match'),
        tokPerUnit:D('7-day otel: ~12.7B tokens processed (mostly cache reads) for $3,958 = 3.2M tokens per API-$'),
        reqPerUnit:D('7-day otel: 69,027 requests / $3,958'),
        ghConcurrency:['s','org plan = enterprise (gh api orgs/web-everything): 500 concurrent standard Linux jobs; public repo, so standard runners are free'],
        ciSpeed:A('CI speed vs GitHub standard runners: 1 = same; paid fast runners claim 1.5–2×'), ciSelfHosted:A('share of CI jobs run on self-hosted test boxes (Forge/MS-A2) instead of GitHub; 2 workflows already use [self-hosted, hetzner, we]'), ciCoresPerJob:A('cores one CI job holds on a self-hosted box'),
        ghJobsPerRun:M('job-minutes per run ÷ wall: ~1,324 job-min per code PR over 7.5 runs of ~17.5 min ≈ 10 jobs in parallel'),
        ghUtil:A('target load on the runner pool'),
        apiPerHour:M('5 GitHub Apps (worker, reviewer, merger, ledger, observer) × 15,000 core calls/h; peak use 22.6% of the busiest'),
        apiCallsPerPr:A('GitHub calls per merged PR (opening, labels, merge, checks). The measured ~4,100 calls/h is mostly polling, so most of it moved to the per-open-PR and per-repo terms; this split is assumed, calibrated so today totals ~4,100/h'),
        apiApps:M('5 GitHub Apps (worker, reviewer, merger, ledger, observer), each with its own 15,000 calls/h'),
        apiBusiest:A('share of all calls made by the busiest App. Fits the measured peak of 22.6% of one App at ~4,100 calls/h in total'),
        apiPerOpenPr:A('calls/h per open PR per polling daemon (status, checks, labels). Calibrated with the per-repo term so today ≈ 4,100 calls/h; not measured per PR'),
        apiPerRepo:A('calls/h per polling daemon per repo (list open PRs, queue, branch state), whatever the PR count'),
        apiDaemons:M('daemons that poll GitHub: watchers, review, build, fix, drain, conveyor (daemon-tasks.json)'),
        apiRepos:M('repos on the shared pipeline: web-everything, frontierui, plateau-app (plateau-params.json)'),
        supplyHours:M('hours a day pools, machines and CI do work. Merges by hour, Nov 5–14 (n=400): 37% land in 22:00–07:00 ET, the same as a flat day (9 of 24 h = 37.5%). Quiet hours (#5600) hold alerts, not work, so 24'),
        rateRef:M('merged PRs/day when red main (2.7%) and ejections (14.5%) were measured, Nov 7–13'),
        redScale:A('1 = the share of the day main is red grows with PRs/day: red ≈ 1 − e^(−k·R), k set so it is 2.7% at 46/day (each merge carries the same chance of breaking main, each break takes as long to fix). 0 = fixed at 2.7%'),
        mqFailScale:A('1 = merge-queue ejections grow with PRs/day the same way, 14.5% at 46/day (more PRs in the queue together, so a failure ejects more of them). 0 = fixed'),
        laneGb:M('du -sh over the lane pool directory 2026-11-14: 130 GB over 122 lane clones ≈ 1.07 GB each (web-everything 0.77, frontierui 0.36, plateau-app 0.37, plus build output and temp files). Grows with the code: months ahead × the growth rate'),
        laneSpare:M('host-sampler lane pool, Nov 11–13: 111–120 lanes kept, ~5 leased on average, so ~115 sit idle on disk'),
        tempGb:A('temporary clones and verify copies outside the lane pool'),
        diskFreeGb:M('df on the laptop data volume 2026-11-14 17:10 ET: 89 GB free (36–162 GB over Nov 7–13)'),
        diskLaneGb:M('lane clones on disk today (130 GB). Hard cap = free space + what the lanes already use'),
        apiUtil:A('headroom kept on the API budget'),
        mergeMin:A('serial time on main per merge (rebase + merge gate 0.93 min measured + push); merge-queue wait not measured'),
        mergeBatch:A('PRs merged per trip through the merge lane'), humanMinPerPr:M('web-everything: no human approval in the loop (0). Typical team: 10–20 min'), humanShare:A('share of code PRs a human must review'), humanHours:A('reviewer hours available per day'), closedPerMerged:M('extra abandoned PRs per merged code PR, on top of the measured profile (which already includes the measured 0.037: per-PR costs are total spend ÷ merged PRs)'), ghMinutesQuota:['s','0 = unlimited (public repo). Private repos: included minutes per month on the plan'], ghOveragePerMin:A('$ per extra hosted Linux minute beyond the quota (2-core standard)'), mqBuilds:['s','merge-queue ruleset: build up to 8 groups in parallel'], mqCiMin:M('merge-group CI p50 17.4 min (n=339)'), mqGroup:M('observed PRs per group 1.06 (queue waits for arrivals; GitHub allows up to 5)'), mqFail:M('14.5% of queue entries ejected by failed checks (n=344)'), redMain:M('main red 2.7% of Nov 7–13 (9 episodes); dispatch pauses while red'), conflictPair:M('chance two open code PRs conflict; calibrated so 13% of code PRs conflict at ~19 open (n=60 sample; 9.3% of open pairs share a file)'), conflictN0:M('mean open code PRs, Oct 31–Nov 13'), conflictRounds:M('extra fix rounds per conflicted PR (1.38, fix-loop ledger)'), conflictMin:M('extra minutes open per conflict (median 21)'), forgeShare:['s','forge-share.json target: share of heavy test runs sent to test boxes'], poolUtil:A('share of the day a protect-the-Mac cap can be busy (gaps between runs, retries)'),
        mergeUtil:A('share of the day the merge lane can be busy'),
        mqCiMin:M('v30: full-suite CI (ci.yml, merge_group success) p50 18.4 min, mean 19.3 (n=698, Nov 1–14, op-durations.json). This is the full suite today; it grows with merged work (ciGrowth)'),
        mqMergeMax:['s','live GitHub merge queue (mq-research.md, 2026-11-14): max 8 entries built in parallel, max 5 merged together, ALLGREEN grouping, 2-min wait. With ALLGREEN every entry is still tested in its own CI run, so throughput = 8 builds at once × 1 PR per run: the same as "8 groups, batch 1"'],
        mqWaitMin:['s','merge queue waits up to 2 min to fill a group (live setting); counted as open time, not capacity'],
        ciGrowth:D('full-suite minutes added per 1,000 merged PRs: +4.45 (WE, Jul–Oct fit vs cumulative merged PRs, R² 1.00, n=4; efficiency-2026.json CI growth). Linear on 4 months: treat as a worst case; the Nov sharding drop (−25%) shows levers bend it'),
        ciTestGrow:D('share of local heavy-test time that grows with the suite: FULL + selected runs = ~41% of local run minutes (op-durations: files 810 × 2.7, FULL 61 × 8.9, selected 87 × 11.5 min); scoped "files" runs stay flat'),
        fullScale:A('full-suite time multiplier from CI levers (sharding, test-impact selection, caching, repo split): 1 = none applied'),
        macTestMin:D('calibration (calibration.json): heavy tests cost 72 CU per code PR, all local (ch 1.26 × 57 measured; 95% range 18–118)'),
        forgeThreadMin:M('calibration: Forge pays ~240 thread-min per code PR per unit of Forge share (Nov 12–14 alone 251; range 170–288). 3.3× the Mac cost for the same work: heavier FULL/soak runs routed there, transport, hyper-threads'),
        localDrop:D('calibration: local heavy CPU per code PR fell only 28% (57 → 41.2 CU) at a 73% Forge share, so each unit of share removes 0.379 of the local test load (cheap capacity added runs)'),
        hqKappa:M('calibration: heavy-queue runs held per local heavy-episode core, κ = 1.05 (0.95–1.15)'),
        hqGamma:M('calibration: heavy-test wait curve, waiters = γ·ρ^e(c)/(1−ρ), γ = 0.35 (0.19–0.64). e(c) = √(4(c+1)/3) is the Sakasegawa M/M/c exponent scaled to equal 2 at c = 2, where the curve was measured (plain M/M/2 over-predicts waits near saturation). c = the tests the machine admits (derived from RAM and CPU headroom)'),
        hqCh:M('calibration: Laptop cores per sampled heavy-episode core, 1.26 (the sampler misses short-lived children)'),
        hqRefLq:D('waiters at the Today preset (ρ ≈ 0.48): the queue term adds open time only above this, so Today is unchanged'),
        satDip:D('calibration: merges per hour dip 28% in hours with the Laptop ≥85% busy (1.67 vs 2.31/h, 12 hours): open time stretches up to +38% as the laptop goes from 85% to 100% busy. Weak signal'),
        calClaude:M('calibration kC = 0.95 (0.80–1.10): per-PR Claude API-$ on the engine stages × 0.95 matches otel over Oct 28 – Nov 14 (hold-out 14% per day, 5–17% on 3-day blocks). The $240/day babysitting is not scaled'),
        calCodex:D('1 = central. The calibration fit kX = 2.22 (1.66–2.79) mixes the October promo resets and the Nov 11 routing change; the Codex weekly cap was measured as quota share in the current window (Nov 11–14) at today\'s per-PR use, so applying 2.22 on top would count it twice. The range (Codex limit ±50%) is shown under How sure'),
        calCodexFit:M('calibration fit across Oct 28 – Nov 14 (unstable: hold-out error 112% per day). Shown as a what-if only'),
        localAvail:A('share of the day a local model instance is serving')
      }
    },
    hosts:[
      {id:'macbook', name:'Laptop', role:'general', on:true, fixed:true, cores:12, ramGb:64, util:65, baseCores:1.27, baseRamGb:14.9, monthlyUsd:0,
        daemons:true, daemonCores:1.53, daemonOpenCores:0.0123, daemonMergeCores:0.281, daemonGb:15.1, daemonMergeGb:1.06, unattribCores:0, unattribScale:0,
        src:{cores:M('sysctl hw.ncpu'), ramGb:M('sysctl hw.memsize'), util:M('operator 2026-11-14: laptop target 65%. The one target for this machine: "plan for" keeps it at or under 65%; nothing else cuts it'),
          baseCores:M('command census (7-day class means): macOS system 0.83 + other apps 0.44 cores. Lane tooling and the short-lived spawns are now counted per class on the daemon machine (v30.2-A; was 2.2)'),
          baseRamGb:A('always-on use outside the daemons: 30 GB measured always-on minus 15.1 GB of daemons'),
          daemonCores:M('daemon-load.json fit (n=190 h, Nov 7–14): 1.53 cores fixed (SE 0.17)'),
          daemonOpenCores:M('daemon-load.json: +0.0123 cores per open PR. WEAK: 1.7 standard errors and mixed up with merges; open PRs from Little\'s law (PRs/day × hours open ÷ 24)'),
          daemonMergeCores:M('daemon-load.json: +0.281 cores per merge/hour (trailing 3 h; 7 standard errors)'),
          daemonGb:M('daemon-load.json: 15.1 GB fixed (R² 0.10: RAM is nearly flat)'), daemonMergeGb:M('daemon-load.json: +1.06 GB per merge/hour (SE 0.24)'),
          unattribCores:D('v30.2-A: 0. The command census attributes the old "unattributed" 1.68 cores (calibration a) and the ~3.5-core spawn storm to daemon classes (polling, rebuilds, lane acquires), counted under Footprint; keeping it here would count it twice'),
          unattribScale:A('1 = the unattributed load grows with merges (3 cores at 46/day) instead of staying fixed'),
          daemons:M('daemon-tasks.json places every daemon on the laptop'), monthlyUsd:A('owned, sunk cost')}},
      {id:'studio', name:'Studio', role:'general', on:true, fixed:true, cores:30, speed:1.1, ramGb:96, util:75, baseCores:1, baseRamGb:12, monthlyUsd:0, diskFreeGb:900,
        src:{speed:A('per-core speed vs the Laptop (Apple Silicon, unmeasured): 1.1, calibration range 0.8–1.4'), diskFreeGb:A('free disk for lane clones if the lanes move here: 1 TB base configuration assumed, minus OS and apps (not measured)'), cores:M('operator 2026-11-14'), ramGb:M('operator 2026-11-14'), util:A('target load (no operator target given; kept at 75%)'), baseCores:A('OS + light use; no daemons placed here (daemon-tasks.json)'), baseRamGb:A('OS'), monthlyUsd:A('owned, sunk cost')}},
      {id:'forge', name:'Forge A', role:'tests', on:true, fixed:false, cores:32, ramGb:64, util:85, baseCores:0.5, baseRamGb:6, monthlyUsd:0, costFrom:'forge',
        src:{costFrom:A('monthly cost from the "Test and CI compute" option: Hetzner EX101 rented, $100/month (one source, v28)'), cores:M('operator: 24C/32T; counted as 32 threads, the unit the calibration measured (sar busy threads)'), ramGb:M('operator'), util:M('operator 2026-11-14: Forges 85%'), baseCores:A('runner agent only (ruling: test/compute only); not measured'), baseRamGb:A('OS'), monthlyUsd:A('owned, sunk cost')}},
      {id:'msa2', name:'Forge B', role:'tests', on:false, fixed:false, cores:32, ramGb:64, util:85, baseCores:0.5, baseRamGb:6, monthlyUsd:0, costFrom:'msa2',
        src:{costFrom:A('monthly cost from the "Test and CI compute" option: $1,200 over 36 months + power at its load (one source, v28; the old row said $60)'), cores:M('spec sheet 16C/32T; 32 threads, treated as Forge-equivalent per thread (calibration, A)'), ramGb:M('candidate config'), util:M('operator 2026-11-14: Forges 85%'), baseCores:A('test box'), baseRamGb:A('OS'), monthlyUsd:A('about $1,400 spread over 24 months, plus power')}},
      {id:'msa2c', name:'Forge C', role:'tests', on:false, fixed:false, cores:32, ramGb:64, util:85, baseCores:0.5, baseRamGb:6, monthlyUsd:0, costFrom:'msa2c',
        src:{costFrom:A('a second MS-A2 at the Forge B price: $1,200 over 36 months + power (A)'), cores:A('same as Forge B: 16C/32T, 32 threads'), ramGb:A('64 GB (operator 14:22 ET)'), util:M('operator 2026-11-14: Forges 85%'), baseCores:A('test box'), baseRamGb:A('OS'), monthlyUsd:A('same as Forge B')}}
    ],
    providers:[
      {id:'claude', name:'Claude (top plan)', kind:'sub', on:true, tier:'top', count:2, maxCount:3, monthlyUsd:200, weeklyCap:2600, fiveHourCap:450, rpm:0, useShare:100, windowDays:7, resetsBanked:1, bankAccounts:2, usedWeek:4300, usedWeekCap:5200, resetRefillDays:0, surprisePerMonth:0, surpriseUse:50, opusShare:63, sonnetRatio:0.2, sonnetExtraRounds:10,
        src:{maxCount:M('operator limit 2026-11-14: at most 3 Claude subscription accounts, ever (Claude allows 3 per phone; no workaround)'), opusShare:OPUS_SRC, sonnetRatio:A('Sonnet cost per unit of work vs Opus (list price per token ≈ 0.2). Assumes the same tokens for the same task'), sonnetExtraRounds:A('extra review/fix rounds on work moved from Opus to Sonnet (quality allowance). Not measured'), count:M('operator: 2 accounts'), monthlyUsd:M('US$200 per account per month, confirmed by the operator 2026-11-14 19:17 ET (billed in USD)'), weeklyCap:M('API-$ per account per week. Measured 2026-11-14: account B ran out after $2,710 (Sun Nov 8 7pm reset → Thu Nov 13 12:32); account A at 26% after $660 ≈ $2,540. Mix ~62% Opus'), windowDays:M('weekly window; A resets Fri 3pm, B Sun 7pm (operator 2026-11-14)'), resetsBanked:M('1 banked reset per account (operator 2026-11-14)'), resetRefillDays:A('days to earn a new banked reset; 0 = never refills, so banked resets are a one-off boost. Unknown'), surprisePerMonth:A('unannounced resets the provider grants now and then'), surpriseUse:A('share of a surprise reset the pipeline can actually use'), useShare:A('share of each account\'s weekly cap that can be used. 100% = both accounts carry work (v30.2-B.4: the 81% haircut is gone: the logs show $4,300 spent in Nov 7–13 against $5,200 of weekly cap, so both accounts are used). Spill-over to Codex and Google lifts what Claude cannot carry'),
          usedWeek:M('usage logs (calibration days.json, otel): Claude API-$ in the 7 days Nov 7–13 = $4,300, 314 merged PRs (44.9 a day). Cap = 2 accounts × $2,600 = $5,200, so 83% of the cap was used and 17% was left'),
          bankAccounts:M('operator 2026-11-14: 1 banked reset on each of the 2 accounts. A third account starts with none'), fiveHourCap:A('API-$ per account per 5-hour window')}},
      {id:'codex', name:'Codex', kind:'sub', on:true, tier:'top', count:1, monthlyUsd:500, weeklyCap:1500, fiveHourCap:0, rpm:0, windowDays:7, resetsBanked:3, bankAccounts:1, usedWeek:861, usedWeekCap:1500, usedWeekNow:534, resetRefillDays:0, surprisePerMonth:0, surpriseUse:50,
        src:{count:M('operator: 1 account'), monthlyUsd:M('US$500 per month, confirmed by the operator 2026-11-14 19:17 ET (billed in USD)'), weeklyCap:M('codex-usage ledger, current window (Nov 11–14, after the routing tweak): 270 work units = 18% → ~1,500 per 100%. 5.3% of the week used per day at 46 merges/day. The quota mostly counts uncached tokens (~5.5–6.2M per 1%), so the cap in work units moves with the cache mix: last week it was ~2,500'), resetsBanked:M('3 banked resets (operator 2026-11-14): each is one more full week, ≈ 3 weeks of Codex. Expiry date not known'), usedWeek:M('codex-usage ledger (calibration days.json): 861 work units in Nov 7–13 (57% of 1,500). Since the Nov 11 routing change it is 305 units in 4 days = 534 a week (36%), which matches the model at 44 merged a day'), usedWeekNow:M('Nov 11–14 only, scaled to a week'), resetRefillDays:A('days to earn a new banked reset; 0 = never refills. Unknown'), surprisePerMonth:A('unannounced resets the provider grants now and then. October 2026 promo (reset ~every 2 days) is not counted'), surpriseUse:A('share of a surprise reset the pipeline can actually use before the next regular reset')}},
      {id:'google', name:'Google AI', kind:'sub', on:true, tier:'mid', count:1, monthlyUsd:200, weeklyCap:800, fiveHourCap:0, rpm:0, windowDays:7, resetsBanked:0, resetRefillDays:0, surprisePerMonth:0, surpriseUse:0,
        src:{count:M('operator: 1 account (Google AI Ultra)'), monthlyUsd:M('Google AI Ultra CA$279.99 per month ≈ US$200 at ~0.71–0.72 USD/CAD (operator 2026-11-14 19:17 ET; the only plan billed in CAD)'), weeklyCap:A('cap unknown: Gemini CLI / Code Assist / Jules usage limits not published'), resetsBanked:M('Google does not do resets (operator 2026-11-14)'), surprisePerMonth:M('no resets')}},
      {id:'claudeapi', name:'Claude API (pay-as-you-go)', kind:'paygo', on:false, tier:'top', count:1, pricePerMtok:0.31, budget:3000, rpm:0,
        src:{pricePerMtok:D('measured blend: $3,958 / 12.7B tokens; mostly cache reads'), budget:A('monthly spend limit you would set')}},
      {id:'openweight', name:'Open-weight API (pay-as-you-go)', kind:'paygo', on:false, tier:'mid', count:1, pricePerMtok:0.06, budget:1000, rpm:0,
        src:{pricePerMtok:A('blended $/Mtok with caching for a hosted open-weight model'), budget:A('monthly spend limit'), tier:A('quality tier is a judgment call')}},
      {id:'local1', name:'Local model on the Studio', kind:'local', on:false, tier:'light', count:2, host:'studio', ramGb:24, cores:2, tokPerSec:3500,
        src:{count:A('model instances running in parallel'), ramGb:A('~32B model at 4-bit plus KV cache, per instance'), cores:A('CPU per instance; the GPU does most of the work'), tokPerSec:A('tokens processed per second per instance, prompt + output, with cache reuse. Measure this on the Studio'), tier:A('light stages only')}}
    ],
    mix:{on:true, cardsPerCode:0.465,
      src:{cardsPerCode:M('backlog card PRs per code PR: 14.0 vs 30.1 merged/day (Nov 7–13, n=339). 0 if the project does not keep its backlog as code')}},
    stages:[
      {id:'babysit', name:'Human-in-the-loop overhead (per day)', kind:'daily', tier:'top', provider:'claude', countToday:1, countTuned:1, ai:0, perDay:240, perDayTuned:92, wall:0, cores:0, ramGb:0, cardShare:0, movable:false,
        src:{perDay:M('otel by session, Nov 7–13: orchestrator main thread $240/day (logged as query_source sdk). Its helper agents ($91/day) count as Build. Fixed per day, not per PR'), perDayTuned:A('shrinks as delivery gets smoother (−62%): fewer status checks, rescues and manual pushes')}},
      {id:'build', name:'Build', kind:'ai', tier:'top', provider:'claude', countToday:1, countTuned:0.85, ai:2.77, aiTuned:2.21, wall:60, cores:0.3, ramGb:1, cardShare:0.2,
        src:{ai:M('otel by session: orchestrator helper agents $91/day, per code PR'), wall:M('build workers p50 34 / p90 180 min (n=49); mean ≈ 60'), aiTuned:['s','builder daemon instead of orchestrator workers (paused today: --max-concurrent=0): −20% per build (operator 2026-11-14)'], countTuned:A('15% of build effort is waste'), wall:A('not mapped'), cardShare:A('cards are mostly prepared by Codex (112 of 207)')}},
      {id:'codexbuild', name:'Codex prepare and check', kind:'ai', tier:'mid', provider:'codex', countToday:1.15, countTuned:1, ai:0.39, wall:4, cores:0.5, ramGb:1, cardShare:0.5,
        src:{countToday:M('codex-usage ledger, Nov 11–14 (after the routing tweak): 0.97 worker runs per merged PR, rebased to per code PR'), ai:M('1.24M tokens per run'), countTuned:A('fewer repeat audits'), wall:A('not measured'), cardShare:A('one prepare run per card PR')}},
      {id:'reviewc', name:'Review seats (Claude)', kind:'ai', tier:'top', provider:'claude', countToday:2.72, countTuned:2, ai:0.42, wall:5.3, cores:0.4, ramGb:1.5, cardShare:0,
        src:{countToday:M('review runs per code PR, mean 2.72 (median 2, n=227)'), countTuned:A('one run per round, no repeats'), ai:M('Claude review seats $1.14 per code PR over 2.72 runs'), wall:M('panel wall per run'), cardShare:M('card PRs use one Codex seat and no Claude seat')}},
      {id:'reviewx', name:'Review seats (Codex)', kind:'ai', tier:'mid', provider:'codex', countToday:2.72, countTuned:2, ai:0.53, wall:0, cores:0, ramGb:0, cardShare:0.26,
        src:{countToday:M('same review runs as above'), ai:M('codex-usage ledger Nov 11–14: 12.9 Codex review-seat runs per merged PR, 0.27M tokens each; review is 64% of Codex tokens and the main quota user (16% uncached)'), cardShare:M('card PRs average 0.72 review runs vs 2.72 (57 of 111 had none)')}},
      {id:'fix', name:'Fix rounds (Claude)', kind:'ai', tier:'top', provider:'claude', countToday:1.33, countTuned:1, ai:2.35, wall:100, wallTuned:50, cores:0.1, ramGb:1, cardShare:0.18,
        src:{countToday:M('fix rounds per code PR = review rounds − 1, mean 1.33 (n=227)'), countTuned:A('slightly fewer rounds from better first builds'), ai:D('worker sessions $191 + headless jobs $75 = $266/day of daemon work, split over review/fix/red-team/passes'), wall:M('fix run held p50 66 / p90 246 min (waiting on tests and CI); active work p50 13 min'), wallTuned:A('half the waiting once tests and CI are faster and less queued'), cardShare:M('card PRs average 0.23 fix rounds')}},
      {id:'fixx', name:'Fix rounds (Codex)', kind:'ai', tier:'mid', provider:'codex', countToday:0.38, countTuned:0.3, ai:0.91, wall:0, cores:0, ramGb:0, cardShare:0.18,
        src:{countToday:M('codex-usage ledger Nov 11–14: 0.28 Codex fix runs per merged PR, rebased to per code PR. Fix executor order: codex → codex-alt → claude'), ai:M('2.91M tokens per run'), wall:A('not measured'), cardShare:M('as Claude fix rounds')}},
      {id:'redteam', name:'Red-team + re-check', kind:'ai', tier:'top', provider:'claude', countToday:1, countTuned:1, ai:1.59, wall:30, cores:0.3, ramGb:1, cardShare:0,
        src:{ai:A('share of unattributed Claude spend, per code PR'), wall:A('no timing recorded'), cardShare:M('red-team skips card-only PRs (redTeam.skipCardOnly)')}},
      {id:'passes', name:'Automated passes (verify, triage, health)', kind:'ai', tier:'light', provider:'claude', countToday:1, countTuned:0.6, ai:2.11, wall:5, cores:0.3, ramGb:0.8, cardShare:0.5,
        src:{ai:D('remainder of daemon spend, per code PR'), countTuned:A('40% of pass work is repeat or idle polling'), tier:A('mechanical work'), cardShare:A('cards skip local verify')}},
      {id:'misc', name:'Plan, explore, compact, summaries', kind:'ai', tier:'light', provider:'claude', countToday:1, countTuned:1, ai:0.095, wall:0, cores:0, ramGb:0, cardShare:0.5,
        src:{ai:M('otel Plan + Explore + compact + summaries'), cardShare:A('half')}},
      {id:'heavy', name:'Local test runs', kind:'test', tier:'', provider:'', countToday:32.3, countTuned:17.6, ai:0, wall:3.55, cores:0.628, ramGb:1.5, cardShare:0,
        src:{countToday:M('9.2 Mac (2d) + 12.85 Forge (7d) runs per merged PR, rebased to per code PR. 72% of heavy runs ran on Forge'), countTuned:A('drop repeat full and soak runs'), wall:D('wall includes queue time'), cores:D('v30 calibration: 0.628 Laptop cores per run, so a code PR today costs 72 CU of heavy tests (ch 1.26 × 57 measured). Test boxes pay 240/72 = 3.3× that per unit of work (forgeThreadMin)'), ramGb:M('vitest p50 1.0 GiB, lane verify 3.0 GiB'), ramGb:A('no peak memory recorded'), cardShare:M('no Mac heavy runs on card PRs (verify.skipLocalForCardOnly); Forge not attributable')}},
      {id:'ci', name:'CI runs on PRs (PR-scoped)', kind:'ci', tier:'', provider:'', countToday:6, countTuned:1.5, ai:0, wall:17.5, wallTuned:13, cores:0, ramGb:0, cardShare:0.07,
        src:{countToday:M('per merged code PR: 6 pull_request runs (one per new push, n=30)'), countTuned:A('one PR run per fix round (+0.5)'), wall:M('ci.yml PR runs p50 18.3 min (n=56, op-durations); branch runs run the whole suite today; roughly flat per PR'), wallTuned:['s','end state −25%: optimization and repo splits could halve CI, but the codebase keeps growing (operator 2026-11-14); Stretch uses the full half'], cardShare:D('card PRs: light PR CI; set so card + code job-minutes match the measured 344 vs 1,324 per PR')}},
      {id:'cifull', name:'Full-suite CI (merge queue)', kind:'ci', full:true, tier:'', provider:'', countToday:1.54, countTuned:1, ai:0, wall:18.4, cores:0, ramGb:0, cardShare:1,
        src:{countToday:M('1.54 merge-group runs per merged code PR (Nov 7–13; 1.3 queue entries per merged PR, op-durations)'), countTuned:A('one merge-group run per PR (no re-queue)'), wall:M('full suite today: merge_group p50 18.4 min (n=698). Grows with merged work: +ciGrowth min per 1,000 merged PRs, × full-suite levers'), cardShare:M('card PRs go through the full merge-group CI (6534: cards capped by 20–30 min full MQ CI)')}},
      {id:'open', name:'Code PR open time', kind:'wip', tier:'', provider:'', countToday:1, countTuned:1, ai:0, wall:692, wallTuned:300, cores:0, ramGb:0, cardShare:0,
        src:{wall:M('time from PR created to review:accepted, mean 692 min (p50 164, p90 1,437; n=216). Total open → merge mean 908'), wallTuned:A('end state: hand-off waits cut (p50 waits: first review 53 min, fix 18, CI 22, heal 22; long tail is the cost)'), cardShare:M('share of merged PRs that are card (planning-change) PRs, from the merged-PR log')}}
    ]
  };
}

/* ---------- model ---------- */
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmtN0 = n => Math.round(n).toLocaleString('en-US');
function stageCount(st, w){ return num(st.countTuned) + w * (num(st.countToday) - num(st.countTuned)); }
function stageAi(st, w){ return st.aiTuned == null ? num(st.ai) : num(st.aiTuned) + w * (num(st.ai) - num(st.aiTuned)); }
function stageDaily(st, w){ return st.perDayTuned == null ? num(st.perDay) : num(st.perDayTuned) + w * (num(st.perDay) - num(st.perDayTuned)); }
function stageWall(st, w){ return st.wallTuned == null ? num(st.wall) : num(st.wallTuned) + w * (num(st.wall) - num(st.wallTuned)); }
function mixRho(s){ return s.mix && s.mix.on ? Math.max(0, num(s.mix.cardsPerCode)) : 0; }
/* runs of a stage per CODE PR, including the card PRs that ride along with it */
let CLOSED = 0; /* abandoned code PRs per merged code PR, set per compute */
function stageRuns(st, w, rho){ const waste = (st.kind === 'wip' || st.kind === 'daily') ? 0 : CLOSED; return Math.max(0, stageCount(st, w)) * (1 + waste + rho * (st.cardShare == null ? 1 : num(st.cardShare))); }

/* v30.3-D.1 (Codex audit, fix 4): a quota field that is present but not a finite number >= 0 (weeklyCap "corrupt", NaN, negative) used to read as 0, which means "no cap":
   the plan then looked unlimited. Fail closed: it counts as invalid, the default value for that plan is used (no default: the plan gets no capacity), and the plan carries a warning. */
function provQuota(p, k, bad){
  const v = p[k]; if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (Number.isFinite(n) && n >= 0) return n;
  let dv = NaN; try { const dp = defaults().providers.find(x=>x.id === p.id); if (dp && dp[k] != null) dv = Number(dp[k]); } catch(e){}
  bad.push(`${k} "${String(v).slice(0, 24)}" is not a number` + (Number.isFinite(dv) && dv >= 0 ? `; the default ${dv} is used` : '; this plan gets no capacity until it is fixed'));
  return Number.isFinite(dv) && dv >= 0 ? dv : -1; /* -1: no valid default, fail closed */
}
function provCap(p, P, hostsById){
  const c = Math.max(0, num(p.count));
  const perUnitReq = num(P.reqPerUnit) || 17.4;
  const caps = []; let bankOf = 0; const bad = [];
  const wk = p.kind === 'sub' ? provQuota(p, 'weeklyCap', bad) : 0, fh = p.kind === 'sub' ? provQuota(p, 'fiveHourCap', bad) : 0, rq = p.kind === 'sub' ? provQuota(p, 'rpm', bad) : 0;
  if (wk < 0 || fh < 0 || rq < 0) return {cap:0, why:'a quota value is invalid (' + bad.join('; ') + ')', bad};
  if (p.kind === 'sub'){
    const use = p.useShare == null ? 1 : Math.max(0, num(p.useShare))/100;
    const win = num(p.windowDays) > 0 ? num(p.windowDays) : 7, refill = num(p.resetRefillDays);
    const surprise = Math.max(0, num(p.surprisePerMonth))/30 * (p.surpriseUse == null ? 0.5 : Math.max(0, num(p.surpriseUse))/100);
    const perDay = 1/win + (refill > 0 ? 1/refill : 0) + surprise;
    /* v30.2-B.4: banked resets are a one-off reserve with an expiry (bankDays from the plan start): each is one more full week of an account,
       spread over the days it can be used. The plan drops it after that date (ptStateAt sets resetsBanked to 0). */
    const bankN = num(p.resetsBanked) > 0 && num(P.bankDays) > 0 ? num(p.resetsBanked)*(p.bankAccounts == null ? c : Math.min(c, num(p.bankAccounts))) : 0, bank = bankN*wk/num(P.bankDays);
    bankOf = bank;
    if (wk > 0) caps.push([wk*perDay*c*use + bank, 'weekly cap' + (bank > 0 ? ` + ${fmtN(bankN, 0)} banked reset${bankN === 1 ? '' : 's'} (${fmtN(num(P.bankDays), 0)} days)` : '') + (refill > 0 ? ' + resets every ' + refill + 'd' : '') + (surprise > 0 ? ' + surprise resets' : '') + (use < 1 ? ', ' + Math.round(use*100) + '% usable' : '')]);
    if (fh > 0) caps.push([fh*24/5*c, '5-hour window']);
    if (rq > 0) caps.push([rq*DAY/perUnitReq*c, 'request rate']);
  } else if (p.kind === 'paygo'){
    const unitPrice = num(p.pricePerMtok) * num(P.tokPerUnit);
    if (num(p.budget) > 0 && unitPrice > 0) caps.push([num(p.budget)/30/unitPrice, 'monthly budget']);
    if (num(p.rpm) > 0) caps.push([num(p.rpm)*DAY/perUnitReq, 'request rate']);
  } else if (p.kind === 'local'){
    const h = hostsById[p.host];
    if (!h || !h.on) return {cap:0, why:'its machine is off'};
    caps.push([c * num(p.tokPerSec) * 86400 * num(P.localAvail)/100 / (num(P.tokPerUnit)*1e6), 'token throughput']);
  }
  if (!caps.length) return {cap:Infinity, why:'no cap set'};
  caps.sort((a,b)=>a[0]-b[0]);
  return {cap:caps[0][0], why:caps[0][1], bank:/^weekly cap/.test(caps[0][1]) ? bankOf : 0, bad}; /* v30.2-B.6 (m2): the banked-reset part of the cap, so the share can be read without it */
}

/* v30.2-B.5: largest R with g(R) <= f (g rising in R). Illinois on a doubling bracket. */
function limitOfFn(g, f){
  if (g(0) > f + 1e-9) return 0;
  let hi = 1; while (g(hi) <= f && hi < 1e6) hi *= 2; if (hi >= 1e6) return Infinity;
  let lo = 0, glo = g(0) - f, ghi = g(hi) - f, side = 0;
  for (let i = 0; i < 60 && hi - lo > 1e-11*hi; i++){
    let mid = ghi - glo > 1e-300 ? hi - ghi*(hi - lo)/(ghi - glo) : (lo + hi)/2; if (!(mid > lo && mid < hi)) mid = (lo + hi)/2;
    const v = g(mid) - f;
    if (v <= 0){ lo = mid; glo = v; if (side === -1) ghi /= 2; side = -1; } else { hi = mid; ghi = v; if (side === 1) glo /= 2; side = 1; }
  }
  return lo;
}
/* v30.2-B.5: waiters in a heavy-test queue of c admitted tests at load rho (M/M/c, Sakasegawa exponent calibrated at c = 2) */
const hqLq = (rho, c, g) => { const r = Math.min(0.99, Math.max(0, rho)), e = Math.sqrt(4*(Math.max(1, c) + 1)/3); return g*Math.pow(r, e)/(1 - r); };
const effOf = p => (p && p.effMult != null && num(p.effMult) > 0) ? num(p.effMult) : 1;
/* v30: the heavy-pool queue and Laptop saturation feed PR open time (calibration). Waiters Lq = γ·ρ²/(1−ρ) on the pool's
   offered load; extra open minutes per code PR = (Lq − Lq at Today) × 1,440 ÷ code PRs a day (Little). In hours the laptop is
   ≥85% busy merges dip: open time × (1 + satDip × how far it is from 85% to 100%). Solved as a damped fixed point. */
function queueExtra(s, r){
  const P = s.platform || {}, w = Math.min(100, Math.max(0, num(s.waste)))/100, o = s.stages.find(x=>x.kind==='wip'); if (!o || !(r.R > 0)) return 0;
  let ex = 0;
  const hq = r.cons.find(c=>c.heavyQ);
  if (hq && hq.cap > 0){ const A = r.R*hq.demand/r.parts.SUP, rho = Math.min(0.97, A/Math.max(1e-9, hq.slots)), Lq = num(P.hqGamma)*rho*rho/(1 - rho);
    ex += Math.max(0, Lq - num(P.hqRefLq))*DAY/r.R; r.heavyQ = {A, rho, Lq}; }
  const lap = (r.machines || []).find(m=>m.id === 'macbook' && m.active);
  if (lap && num(P.satDip) > 0){ const f = Math.min(1, Math.max(0, (lap.busy - 0.85)/0.15)); ex += stageWall(o, w)*num(P.satDip)*f; if (f > 0) r.sat = {busy:lap.busy, f}; }
  return ex;
}
/* v30.1: engine results are memoised by the exact input state (a plan render, Suggest and the just-in-time walk ask for the
   same state many times; a milestone move leaves every state before it unchanged). Results are shared: callers must not
   mutate them (checked in the test run with frozen results). */
const ENG_MEMO = new Map(); let ENG_FREEZE = false; const ENG_MEMO_MAX = 6000;
function engFreeze(o){ if (o && typeof o === 'object' && !Object.isFrozen(o)){ Object.freeze(o); for (const k of Object.keys(o)) engFreeze(o[k]); } return o; }
function compute(s){ const key = JSON.stringify(s); const hit = ENG_MEMO.get(key); if (hit){ ENG_MEMO.delete(key); ENG_MEMO.set(key, hit); return hit; }
  const r = computeRaw(s); if (ENG_MEMO.size >= ENG_MEMO_MAX) ENG_MEMO.delete(ENG_MEMO.keys().next().value); ENG_MEMO.set(key, ENG_FREEZE ? engFreeze(r) : r); return r; }
function computeRaw(s){ const v = applyValue(s), core = x => x.route === 'fill' ? computeFill(x) : computeFixed(x);
  const r = num((v.platform || {}).holdOn) > 0 ? withHold(v, core) : withRate(v, y => withConflicts(y, core)); const V = s.value || {}; r.worth = Math.min(100, Math.max(0, V.worth == null ? 100 : num(V.worth)))/100; r.useful = r.total*r.worth; r.perUseful = r.useful > 0 ? r.month/(r.useful*30) : Infinity; return r; }
/* Value & reuse lens: reuse makes each PR cheaper (cost of a reused part ≈ rcr of new), precedents cut review/fix rounds,
   months ahead compound growth (CI/test time) and learning (AI cost). Worth only scales the "useful" output. */
/* Opus share: Claude API-$ per unit of work scales as o + (1 − o) × ratio, normalised to today's mix (OPUS_REF), so 63% leaves
   every number as measured. Work moved to Sonnet adds a quality allowance of extra review/fix rounds (all review/fix stages).
   Independent of "tokens saved" (that cuts tokens; this cuts the price per token), so the two multiply. Applies to stages routed to Claude. */
function opusFactor(p){
  if (!p || p.opusShare == null || p.opusShare === '') return {k:1, moved:0, q:0};
  const r = Math.min(1, Math.max(0, p.sonnetRatio == null ? 0.2 : num(p.sonnetRatio))), f = o => o + (1 - o)*r;
  const o = Math.min(1, Math.max(0, num(p.opusShare)/100)), o0 = OPUS_REF/100;
  return {k: f(o)/f(o0), moved: Math.max(0, o0 - o), q: Math.max(0, num(p.sonnetExtraRounds == null ? 10 : p.sonnetExtraRounds))/100};
}
function applyOpus(s){
  const F = opusFactor((s.providers||[]).find(p=>p.id==='claude'));
  if (Math.abs(F.k - 1) < 1e-12 && F.moved === 0) return s;
  const s2 = Object.assign({}, s, {stages:s.stages.map(st=>Object.assign({}, st))}), rx = 1 + F.q*F.moved; /* v30.1: only stage numbers change */
  for (const st of s2.stages){
    if (st.provider === 'claude' && st.kind === 'ai' && !(st.model && MODELS[st.model])){ st.ai = num(st.ai)*F.k; if (st.aiTuned != null) st.aiTuned = num(st.aiTuned)*F.k; }
    if (st.provider === 'claude' && st.kind === 'daily'){ st.perDay = num(st.perDay)*F.k; if (st.perDayTuned != null) st.perDayTuned = num(st.perDayTuned)*F.k; }
    if (st.kind === 'ai' && /^(review|fix)/.test(st.id) && !(st.model && MODELS[st.model])){ st.countToday = num(st.countToday)*rx; st.countTuned = num(st.countTuned)*rx; }
  }
  return s2;
}
/* v30: full-suite CI time at a cumulative merged-PR count (merged since the plan start; outside a plan, months ahead × 30.44 ×
   today's rate). Grows +ciGrowth min per 1,000 merged PRs from today's level, times the CI levers (fullScale). */
function ciCumOf(s){ const P = s.platform || {}; if (P.ciCum != null && P.ciCum !== '') return Math.max(0, num(P.ciCum)); const V = s.value || {}; return Math.max(0, num(V.months))*30.44*(num(P.rateRef) || 46); }
function fullMinOf(s, base){ const P = s.platform || {}; return (num(base) + num(P.ciGrowth)*ciCumOf(s)/1000)*(P.fullScale == null || P.fullScale === '' ? 1 : Math.max(0.05, num(P.fullScale))); }
/* v30 per-model profile (op-durations.json, Nov 1–14): cost per unit of work vs Opus, task time vs Opus, extra rounds.
   'mix' = the measured mix (63% Opus): every measured number already is the mix, so a stage on 'mix' is unchanged. */
const MODELS = {
  opus:{name:'Claude Opus 5.5', cost:1, speed:1, sonnet:0, src:'reference'},
  sonnet:{name:'Claude Sonnet 5.5', cost:null, speed:0.58, sonnet:1, src:'task time: conveyor fix round wall p50 35.2 vs Opus 60.6 min (n=616 / 257; active 16.3 vs 35.5). Opus gets the harder rounds, so this mixes speed with difficulty. Tokens per fix round 2.53M vs 7.35M (0.34×, same caveat); cost uses the same tokens per task (A) × the Sonnet price ratio'}
};
function modelK(p, model){
  const r = Math.min(1, Math.max(0, p && p.sonnetRatio != null ? num(p.sonnetRatio) : 0.2)), o0 = OPUS_REF/100, f0 = o0 + (1 - o0)*r;
  const q = Math.max(0, num(p && p.sonnetExtraRounds != null ? p.sonnetExtraRounds : 10))/100, M0 = MODELS[model]; if (!M0) return null;
  const cost = model === 'sonnet' ? r : 1, sp0 = o0 + (1 - o0)*MODELS.sonnet.speed;
  return {k:cost/f0, wall:M0.speed/sp0, rounds:1 + q*(M0.sonnet - (1 - o0))};
}
function applyValue(s0){
  let s = applyOpus(s0);
  const P = s.platform || {}, kC = P.calClaude == null ? 1 : num(P.calClaude), kX = P.calCodex == null ? 1 : num(P.calCodex);
  const cum = ciCumOf(s), cg = num(P.ciGrowth), fsc = P.fullScale == null || P.fullScale === '' ? 1 : num(P.fullScale);
  const anyModel = s.stages.some(st=>(st.model && MODELS[st.model]) || st.modelTo);
  const V = s.value || {};
  const r = Math.min(1, Math.max(0, num(V.reuse)/100)), k = 1 - r*(1 - Math.min(1, Math.max(0, num(V.rcr))));
  const pr = Math.min(0.9, Math.max(0, num(V.precedent)/100)), m = Math.max(0, num(V.months));
  const lm = Math.pow(1 - Math.min(0.9, num(V.learning)/100), m), rel = P.relFactor == null || P.relFactor === '' ? 1 : Math.max(0.05, num(P.relFactor));
  const lr = linesRatio(P), rf = roundsF(P);
  if (k === 1 && pr === 0 && lm === 1 && kC === 1 && kX === 1 && !(cum > 0 && cg) && fsc === 1 && !anyModel && rel === 1 && lr === 1) return s;
  s = Object.assign({}, s, {stages:s.stages.map(st=>Object.assign({}, st))}); /* v30.1: only stage numbers change below */
  /* v30.2-A PR size: review/fix rounds above ~250 lines, ejections ∝ √lines (conflicts: q ∝ √lines in the hold engine) */
  if (lr !== 1){ s.platform = Object.assign({}, P, {mqFail:Math.min(0.9, num(P.mqFail)*Math.sqrt(lr))});
    for (const st of s.stages) if (st.kind === 'ai' && /^(review|fix)/.test(st.id)){ st.countToday = num(st.countToday)*rf; st.countTuned = num(st.countTuned)*rf; } }
  const cl = s.providers.find(p=>p.id==='claude');
  /* the suite grows: full-suite CI (wall) and the growing share of local heavy-test time */
  const fullBase = num(P.mqCiMin) || 18.4, suite = fullMinOf(s, fullBase)/fullBase;
  let dOpen = 0;
  for (const st of s.stages){
    if (st.kind === 'ai'){
      const sc = (st.provider === 'claude' ? kC : st.provider === 'codex' ? kX : 1)/rel;
      st.ai = num(st.ai)*k*lm*sc; if (st.aiTuned != null) st.aiTuned = num(st.aiTuned)*k*lm*sc;
      if (/^(review|fix)/.test(st.id)){ st.countToday = num(st.countToday)*(1-pr); st.countTuned = num(st.countTuned)*(1-pr); }
      let mk = st.model && st.provider === 'claude' ? modelK(cl, st.model) : null;
      if (st.modelTo && st.provider === 'claude'){ const m1 = modelK(cl, st.modelTo), m0 = mk || {k:1, wall:1, rounds:1}, f = Math.min(1, Math.max(0, num(st.modelF))); if (m1) mk = {k:m0.k + f*(m1.k - m0.k), wall:m0.wall + f*(m1.wall - m0.wall), rounds:m0.rounds + f*(m1.rounds - m0.rounds)}; } /* v30.2-B.6: a model move in progress */
      if (mk){ st.ai = num(st.ai)*mk.k; if (st.aiTuned != null) st.aiTuned = num(st.aiTuned)*mk.k;
        const w0 = num(st.wall); st.wall = w0*mk.wall; if (st.wallTuned != null) st.wallTuned = num(st.wallTuned)*mk.wall; st.mkWall = mk.wall;
        if (/^(review|fix)/.test(st.id)){ st.countToday = num(st.countToday)*mk.rounds; st.countTuned = num(st.countTuned)*mk.rounds; }
        if (/^fix/.test(st.id)) dOpen += num(st.countToday)*(st.wall - w0); }
    }
    if (st.kind === 'daily' && rel !== 1){ st.perDay = num(st.perDay)/rel; if (st.perDayTuned != null) st.perDayTuned = num(st.perDayTuned)/rel; }
    if (st.kind === 'ci'){ const f = st.full ? fullMinOf(s, st.wall)/Math.max(1e-9, num(st.wall)) : 1; st.wall = num(st.wall)*k*f; if (st.wallTuned != null) st.wallTuned = num(st.wallTuned)*k*f; }
    if (st.kind === 'test'){ const f = 1 + Math.min(1, Math.max(0, num(P.ciTestGrow)))*(suite - 1); st.wall = num(st.wall)*k*f; if (st.wallTuned != null) st.wallTuned = num(st.wallTuned)*k*f; }
  }
  /* slower or faster fix rounds keep the PR open longer or shorter */
  if (dOpen){ const o = s.stages.find(x=>x.kind==='wip'); if (o){ o.wall = Math.max(30, num(o.wall) + dOpen); if (o.wallTuned != null) o.wallTuned = Math.max(30, num(o.wallTuned) + dOpen); o.dOpen = dOpen; } }
  return s;
}
/* ---------- v30.2-A: scope hold time engine ---------- */
/* PR size: lines per code PR vs the reference the rounds, conflicts and ejections were measured at */
function linesRatio(P){ const L = num(P && P.prLines), L0 = num(P && P.prLines0); return L > 0 && L0 > 0 ? L/L0 : 1; }
function roundsF(P){ const L = num(P && P.prLines), L0 = num(P && P.prLines0), kn = num(P && P.roundsKnee) || 250, e = P && P.roundsExp != null ? num(P.roundsExp) : 0.77;
  if (!(L > 0 && L0 > 0)) return 1; const g = x => Math.pow(Math.max(1, x/kn), e); return g(L)/g(L0); }
/* Sakasegawa's M/M/c approximation of the queue wait in units of the service time: Wq/S = ρ^(√(2(c+1)) − 1) / (c (1 − ρ)) */
function sak(rho, c){ const p = Math.min(0.995, Math.max(0, num(rho))), k = Math.max(1, num(c) || 1); return p <= 0 ? 0 : Math.pow(p, Math.sqrt(2*(k + 1)) - 1)/(k*(1 - p)); }
/* pairwise file overlap q now (module levers, repo splits, PR size) and the parallel open scopes the tolerance allows */
function scopeQ(P){ return Math.min(0.5, Math.max(1e-6, num(P.conflictPair)*(P.qMul == null || P.qMul === '' ? 1 : Math.max(0.01, num(P.qMul)))*Math.sqrt(linesRatio(P)))); }
function scopeN(P){ const x = Math.min(0.95, Math.max(0.001, (P.scopeTol == null ? 13 : num(P.scopeTol))/100)); return 1 + Math.log(1 - x)/Math.log(1 - scopeQ(P)); }
/* v30.2-A2: the overlap ceiling = disjoint sets among the prepared cards (the dispatcher packs disjoint sets): D(257) = 88 today,
   ∝ 1/√(overlap) for module and repo levers and PR size */
function overlapP(P){ const n = Math.max(0, num(P.prepStock == null ? 257 : P.prepStock)), D = num(P.packA)*Math.pow(Math.max(1e-9, n), num(P.packB) || 0.783);
  const k = (P.qMul == null || P.qMul === '' ? 1 : Math.max(0.01, num(P.qMul)))*Math.sqrt(linesRatio(P)); return n > 0 ? D/Math.sqrt(k) : 0; }
/* fresh prepared card supply: disjoint sets D(n) = a·n^b of the n fresh cards, over the share of scopes that start from a card */
function supplyP(P){ const n = Math.max(0, num(P.prepRate))*Math.max(0, num(P.freshDays)), D = num(P.packA)*Math.pow(Math.max(1e-9, n), num(P.packB) || 0.783), sh = Math.min(1, Math.max(0.01, num(P.cardShare)));
  return {n, D, P:n > 0 ? D/sh : 0}; }
/* the census footprint on the daemon machine: fixed cores (per tick / per time / per lane) and cores per merged PR a day */
function footFixed(P){ return num(P.fPoll)*(P.pollMul == null ? 1 : num(P.pollMul)) + num(P.fProc) + num(P.fReview)*(P.reviewMul == null ? 1 : num(P.reviewMul)) + num(P.fLane) + num(P.rbFixed)*num(P.rbCpuS)*(P.rbShare == null ? 1 : num(P.rbShare))/86400; }
function footPerMerge(P){ return (num(P.rbPerMerge)*num(P.rbCpuS)*(P.rbShare == null ? 1 : num(P.rbShare)) + num(P.provPerMerge)*num(P.provCpuS)*(P.provMul == null ? 1 : num(P.provMul)) + num(P.opCpuS))/86400; }
/* The hold-time tree, minutes per code PR from claim to merge. Every term is a measured part (sources on the inputs);
   hand-off waits and the after-acceptance tail follow the tuning ramp; utilisation waits (machine, the Forges, merge
   queue, CI runners, people) come from the busy level of the previous fixed-point pass (r), Sakasegawa M/M/c. */
function holdTree(s, w, r, dp){
  const P = s.platform || {}, st = id => s.stages.find(x=>x.id === id), T = {};
  const open = s.stages.find(x=>x.kind === 'wip'), b = st('build'), fx = st('fix'), rv = st('reviewc'), hv = st('heavy');
  const ci = s.stages.find(x=>x.kind === 'ci' && !x.full) || s.stages.find(x=>x.kind === 'ci'), cf = s.stages.find(x=>x.kind === 'ci' && x.full);
  const ft = open ? Math.max(0.05, (stageWall(open, w) - num(open.dOpen))/Math.max(1, num(P.openRef) || 692)) : 1;
  const rounds = fx ? Math.max(0, stageCount(fx, w)) : num(P.hFixRounds0), r0 = Math.max(0.01, num(P.hFixRounds0) || 1.33);
  const ciMin = (ci ? stageWall(ci, w) : 17.5)/Math.max(0.1, num(P.ciSpeed) || 1);
  const testK = hv && num(P.hHeavyRef) > 0 ? stageWall(hv, w)/num(P.hHeavyRef) : 1;
  const sF = cf ? stageWall(cf, w)/Math.max(0.1, num(P.mqCiMin) || 18.4) : 1;
  const ejRef = 0.145 /* ejections per entry when hMqEntries / hEjectPrShare were measured (Nov 1–14) */, ejEff = P.mqFailEff != null ? num(P.mqFailEff) : num(P.mqFail), ejK = ejEff/ejRef;
  const cS = num(P.cpuRefC) || 12, Sref = sak(num(P.cpuRefRho), cS), cmd0 = num(P.hCmdMin)/(1 + Sref);
  /* work */
  T.build = Math.max(0, (b ? stageWall(b, w) : 60) - num(P.hTestInBuild) - cmd0*Sref);
  T.tests = num(P.hTestMin)*testK;
  T.ci = ciMin;
  T.review = rv ? Math.max(0, stageCount(rv, w))*stageWall(rv, w) : 14.4;
  T.fix = Math.max(0, rounds*(num(P.hFixMin)*(fx && fx.mkWall ? num(fx.mkWall) : 1) - num(P.hTestInFix)/r0));
  T.reci = rounds*ciMin;
  /* hand-off waits and the tail (tuning ramp) */
  T.wReview = num(P.hWaitReview)*ft; T.wFix = num(P.hWaitFix)*ft; T.wCi = num(P.hWaitCi)*ft; T.heal = num(P.hHeal)*ft; T.wMq = num(P.hWaitMq)*ft; T.tail = num(P.hTail)*ft;
  /* merge queue trip × (1 + retries) and ejection rework (both follow the ejection rate) */
  T.mq = num(P.hMqClean)*sF*(1 + Math.max(0, num(P.hMqEntries) - 1)*ejK);
  T.eject = num(P.hEjectPrShare)*ejK*num(P.hEjectRework)*Math.max(ft, 0.25);
  T.conflict = Math.max(0, num(dp))*num(P.conflictMin);
  /* utilisation waits */
  const Q = T.q = {};
  const lane = r && r.machines ? (r.machines.find(m=>m.id === (r.parts && r.parts.dh)) || r.machines.find(m=>m.active && m.role !== 'tests')) : null;
  const laneH = lane && s.hosts.find(h=>h.id === lane.id);
  Q.cpu = {name:'Lane machine CPU (local commands)', rho: lane ? lane.cpu : num(P.cpuRefRho), c: laneH ? hCores(laneH) : cS, S: cmd0, visits:1};
  const tm = r && r.machines ? r.machines.filter(m=>m.active && m.role === 'tests') : [], tb = tm.length ? tm.reduce((a, m)=>m.cpu > a.cpu ? m : a, tm[0]) : null, tbH = tb && s.hosts.find(h=>h.id === tb.id);
  const fsh = Math.min(1, Math.max(0, num(P.forgeShare)));
  if (lane) Q.cpu.rho0 = lane.cpu0 || 0;
  /* v30.2-B.4: heavy-test queues on the machines (calibration γ, κ). Waiters Lq = γ ρ² ÷ (1 − ρ), ρ = κ × local heavy cores ÷ ch ÷ the pool size.
     Cost per code PR = (Lq − the Lq already inside the measured hold) × 1,440 ÷ code PRs a day (Little). It is part of the hold, so it lowers merged a day. */
  if (r && r.machines && r.R > 0) for (const m of r.machines){ if (!m.on || m.parked || !m.active || m.role === 'tests' || !m.ws) continue;
    const adm = Math.max(0.5, num(m.ws.admit)), rho = num(P.hqSat)*m.ws.heavyCores/Math.max(0.1, num(P.hqCh) || 1.256)/adm;
    if (rho > 0) Q['heavy:' + m.id] = {name:`Heavy-test queue, ${m.name} (runs are admitted while headroom lasts: ${fmtN(adm, 1)} running)`, rho, rho0:0, lq:true, ref:m.id === 'macbook' ? num(P.hqRefLq) : 0, g:num(P.hqGamma) || 0.35, c:adm, S:0, visits:1, slots:adm, R:r.R}; }
  if (tb) Q.tbox = {name:'Test servers (remote test runs)', rho:tb.cpu, rho0:tb.cpu0 || 0, c:tbH ? num(tbH.cores) : 32, S:T.tests*fsh, visits:1};
  const mc = r && r.cons ? r.cons.find(c=>c.key === 'merge') : null;
  if (mc) Q.mq = {name:'Merge queue (builds in flight)', rho:mc.util, c:Math.max(1, num(P.mqBuilds) || 1), S:(mc.suiteMin || 18.4)/Math.max(1, num(P.mqGroup) || 1), visits:Math.max(1, num(P.hMqEntries))};
  const cc = r && r.cons ? r.cons.find(c=>c.key === 'ci') : null;
  if (cc) Q.ci = {name:'Actions runners', rho:cc.util, c:Math.max(1, num(P.ghConcurrency)/Math.max(1, num(P.ghJobsPerRun) || 10)), S:ciMin, visits:1 + rounds};
  const hc = r && r.cons ? r.cons.find(c=>c.key === 'human') : null;
  if (hc) Q.people = {name:'Human review', rho:hc.util, c:Math.max(1, num(P.humanHours)/8), S:num(P.humanMinPerPr), visits:1};
  let U = 0; for (const k of Object.keys(Q)){ const q = Q[k]; if (q.lq){ q.W = Math.max(0, hqLq(q.rho, q.c, q.g) - q.ref)*DAY/Math.max(1, q.R); } else q.W = q.visits*q.S*sak(q.rho, q.c); U += q.W; }
  T.U = U;
  T.base = T.build + T.tests + T.ci + T.review + T.fix + T.reci + T.wReview + T.wFix + T.wCi + T.heal + T.wMq + T.tail + T.mq + T.eject + T.conflict;
  T.pre = T.build + num(P.hTestInBuild)*testK; /* claim → PR open */
  T.ft = ft; T.rounds = rounds; T.sF = sF; T.ejK = ejK;
  return T;
}
/* utilisation waits at another delivery level (linear busy scaling from the fixed load), for the plan-for search */
function holdUAt(T, r, Rx){
  if (!(r && r.R > 0)) return T.U; let U = 0;
  for (const k of Object.keys(T.q)){ const q = T.q[k]; let rho = q.rho;
    if (q.rho0 != null){ const r0 = Math.min(q.rho, num(q.rho0)); rho = r0 + (q.rho - r0)*Rx/r.R; }
    else rho = q.rho*Rx/r.R;
    if (q.lq){ U += Math.max(0, hqLq(rho, q.c, q.g) - q.ref)*DAY/Math.max(1, Rx); continue; }
    U += q.visits*q.S*sak(rho, q.c); }
  return U;
}
/* One fixed point solves R (merged PRs a day), the hold time H (through utilisation waits and conflicts) and the red-main /
   ejection shares (they grow with R). Damped, at most 12 passes; the residual is reported. Replaces withRate + withConflicts. */
function withHold(s, run){
  const P = s.platform || {}, w = Math.min(100, Math.max(0, num(s.waste)))/100, per = 1 + mixRho(s);
  const q = scopeQ(P), q0 = Math.max(1e-6, num(P.conflictPair)), N0 = num(P.conflictN0), useC = num(P.conflictPair) > 0 && N0 > 0;
  const pOf = (x, N) => 1 - Math.pow(1 - x, Math.max(0, N - 1));
  const ref = num(P.rateRef) > 0 ? num(P.rateRef) : 46, rateOn = num(P.redScale) > 0 || num(P.mqFailScale) > 0;
  let r = null, Rt = ref, Rp = ref, dp = 0, U = null, T = null, H = 0, it = 0, res = 1, hist = [], g0 = 0, bP = null, bN = null, side = 0;
  for (it = 0; it < 16; it++){
    const rp = rateOn ? rateParams(P, Rt) : {};
    const P2 = Object.assign({}, P, rp), sR = Object.assign({}, s, {platform:P2});
    T = holdTree(sR, w, r, dp);
    /* utilisation waits at the level being tried (busy levels scaled from the last pass), so one number (Rt) carries the loop */
    U = r ? holdUAt(T, r, Rt/per) : T.U;
    H = T.base + U;
    const openMin = Math.max(1, H - T.pre);
    P2.holdH = H; P2.holdOpen = openMin; P2.holdN = scopeN(P2); P2.prepR = Rt/per;
    const s2 = Object.assign({}, sR, {stages:s.stages.map(x=>x.kind === 'wip' || (x.id === 'fix' && dp) ? Object.assign({}, x) : x)});
    const o2 = s2.stages.find(x=>x.kind === 'wip'); if (o2){ o2.wall = openMin*num(P.hCounted || 0.762); o2.wallTuned = null; o2.dOpen = 0; }
    const f2 = dp ? s2.stages.find(x=>x.id === 'fix') : null; if (f2){ f2.countToday = Math.max(0, num(f2.countToday) + dp*num(P.conflictRounds)); f2.countTuned = Math.max(0, num(f2.countTuned) + dp*num(P.conflictRounds)); }
    const rn = run(s2);
    const N = rn.R*openMin/DAY, dpN = useC ? pOf(q, N) - pOf(q0, N0) : 0;
    const g = rn.total - Rt;
    res = Math.max(Math.abs(g)/Math.max(1, rn.total), Math.abs(dpN - dp), Math.abs(holdTree(sR, w, rn, dp).U - U)/Math.max(1, H)); /* A2: the waits at this pass's own busy levels must agree too */
    hist.push(rn.total); r = rn;
    r.conflict = {N, p:pOf(q, N), dp};
    if (it > 0 && res < 2e-3) break;
    /* full steps until g(Rt) = R(Rt) − Rt changes sign, then Illinois regula falsi inside that bracket (waits make g very steep
       near a machine's 100%: a plain secant or damped step can cycle there), bisection if a step leaves the bracket */
    let nx;
    if (g >= 0){ if (side === 1 && bN) bN.g /= 2; bP = {x:Rt, g}; side = 1; } else { if (side === -1) bP && (bP.g /= 2); bN = {x:Rt, g}; side = -1; }
    if (bP && bN){ nx = bP.x - bP.g*(bN.x - bP.x)/(bN.g - bP.g); const lo = Math.min(bP.x, bN.x), hi = Math.max(bP.x, bN.x); if (!(nx > lo && nx < hi)) nx = (lo + hi)/2; }
    else nx = rn.total;
    Rp = Rt; g0 = g; Rt = Math.max(0, nx); dp = dp + (it < 2 ? 1 : 0.6)*(dpN - dp);
  }
  { /* the waits at the solution, from its own busy levels (reported; the residual includes them) */
    const Tf = holdTree(Object.assign({}, s, {platform:Object.assign({}, P, rateOn ? rateParams(P, Rt) : {})}), w, r, dp);
    res = Math.max(res, Math.abs(Tf.U - U)/Math.max(1, H)); }
  if (rateOn) r.rate = Object.assign({Rt}, rateParams(P, Rt));
  /* the parallelism limits, in held scopes (P = R × H ÷ 1,440) */
  const toP = R => Number.isFinite(R) ? R*H/DAY : Infinity, lim = k => { const c = r.cons.find(z=>z.key === k); return c && c.demand > 0 ? c.limit : Infinity; };
  const machC = r.cons.filter(c=>c.group === 'Machines' && c.demand > 0).reduce((m, c)=>!m || c.limit < m.limit ? c : m, null), machR = machC ? machC.limit : Infinity;
  const machPlanR = r.machines ? r.machines.filter(m=>m.active).reduce((m, x)=>Math.min(m, x.planR), Infinity) : Infinity;
  const aiR = r.fill && r.fill.Rai != null ? r.fill.Rai : r.cons.filter(c=>c.group === 'AI' && c.demand > 0).reduce((m, c)=>Math.min(m, c.limit), Infinity);
  const sp = {n:0, D:0, P:Infinity}, Nn = scopeN(P), openMin = Math.max(1, H - T.pre);
  const Ps = {scope:overlapP(P), supply:Infinity, machine:toP(machR), machineTarget:toP(machPlanR), token:toP(aiR), policy:toP(lim('pool:openprs'))};
  const rate = r.cons.filter(c=>c.demand > 0 && ['merge', 'ci', 'api', 'human', 'spin'].includes(c.key)).map(c=>({key:c.key, name:c.name, R:c.limit, P:toP(c.limit)}));
  /* v30.2-B: one name per limit (the same words in the hero, the levels, the hover and the plan list) */
  const fam = [['scope', 'Disjoint files'], ['machine', machC ? limitName(machC) : 'Machines'], ['token', (()=>{ const cc = r.cons.find(c=>c.key === 'p:claude'), pp = r.parts && r.parts.pipe; return cc && pp && pp.extraUsd > 0.15*Math.max(1, cc.demand*r.R + (cc.fixed || 0)) ? 'AI tokens (card prep)' : 'AI tokens'; })()]]; /* v30.2-B: no open-PR cap family */
  /* ties (within 1%) break by this fixed order, so the same plan always names the same limit; the others are counted */
  const Pmin = fam.reduce((m, [k, nm])=>Ps[k] < m.v*0.99 ? {k, nm, v:Ps[k]} : m, {k:'', nm:'nothing', v:Infinity});
  Pmin.tied = fam.filter(([k])=>k !== Pmin.k && Number.isFinite(Ps[k]) && Ps[k] <= Pmin.v*1.01).map(([, nm])=>nm);
  Ps.names = Object.fromEntries(fam);
  const heldNow = r.R*H/DAY;
  /* plan for: the most code PRs a day whose utilisation waits stay ≤ waitPlan% of the no-wait hold time */
  const H0 = H - U, cap = Math.max(0, num(P.waitPlan == null ? 15 : P.waitPlan))/100*H0;
  let planWaitR = r.R; if (U > cap && r.R > 0){ let lo = 0, hi = r.R; for (let i = 0; i < 40; i++){ const mid = (lo + hi)/2; if (holdUAt(T, r, mid) <= cap) lo = mid; else hi = mid; } planWaitR = lo; }
  const planWait = planWaitR*per;
  r.planMach = r.planTotal; /* v30.2-B.6 (m3): plan for is the machine targets only; the wait share is a readout (planWait), never part of the definition */
  const coresHeld = r.R > 0 && r.cons ? (()=>{ const cs = r.cons.filter(z=>/^cpu(:|$)/.test(z.key)); return cs.reduce((a, c)=>a + c.demand, 0)/Math.max(1, H); })() : 0;
  /* B.4 (operator 07:16 ET): every machine reads at its busy hour (p90 of 5-minute samples = u90 × the mean). The daily mean is a second line. */
  for (const m of r.machines || []){ m.busyShown = m.busy; m.basis = 'busy hours'; }
  r.hold = {H, U, H0, T, terms:holdTerms(T, U), open:openMin, pre:T.pre, it:it + 1, residual:res, hist, P:Ps, Pmin, rate, held:heldNow, N:Nn, q, supply:sp,
    pointsDay:Math.max(0, r.R*num(P.ptsPerPr0)*linesRatio(P) - num(P.buildPts)), buildPts:num(P.buildPts), prsDay:r.total, planWait, coresHeld, per};
  return r;
}
/* the tree as rows (minutes per code PR), grouped the way the waterfall shows them; they sum to H */
function holdTerms(T, U){
  const q = T.q || {}, W0 = k => q[k] ? q[k].W : 0, wHeavy0 = Object.keys(q).filter(k=>/^heavy:/.test(k)).reduce((a, k)=>a + q[k].W, 0);
  /* v30.3-D.1: the queue rows are shares of the total queue wait U; "Waits for reviewers (busy)" is what is left. When the merge-queue wait alone was larger than U (a saturated
     queue on some days) the leftover went negative (-9 h on Dec 20 from a Nov 16 start) and a band showed a negative number. Scale the queue rows to U instead; the rows still sum to H. */
  const wSum = W0('cpu') + W0('tbox') + wHeavy0 + W0('mq') + W0('ci'), sc = wSum > U && wSum > 0 ? Math.max(0, U)/wSum : 1, W = k => W0(k)*sc, wHeavy = wHeavy0*sc;
  return [
    {k:'build', name:'Build (claim → PR open)', min:T.build, kind:'work'},
    {k:'tests', name:'Local tests', min:T.tests, kind:'work'},
    {k:'ci', name:'PR CI (first run)', min:T.ci, kind:'work'},
    {k:'review', name:'Review runs', min:T.review, kind:'work'},
    {k:'fix', name:`Fix rounds (${fmtN(T.rounds, 2)})`, min:T.fix, kind:'work'},
    {k:'reci', name:'Re-CI after fixes', min:T.reci, kind:'work'},
    {k:'heal', name:'CI-red heals', min:T.heal, kind:'handoff'},
    {k:'wReview', name:'Waits for review', min:T.wReview, kind:'handoff'},
    {k:'wFix', name:'Waits for a fixer', min:T.wFix, kind:'handoff'},
    {k:'wCi', name:'Waits for CI after a fix', min:T.wCi, kind:'handoff'},
    {k:'wMq', name:'Accepted → enqueued', min:T.wMq, kind:'handoff'},
    {k:'tail', name:'Held after acceptance (approvals, stacks, parked)', min:T.tail, kind:'handoff'},
    {k:'mq', name:'Merge-queue trip × (1 + retries)', min:T.mq, kind:'work'},
    {k:'eject', name:'Ejection rework', min:T.eject, kind:'handoff'},
    {k:'conflict', name:'Extra conflicts', min:T.conflict, kind:'handoff'},
    {k:'wMach', name:'Waiting for our own machines (Laptop, Studio, Forge)', min:W('cpu') + W('tbox') + wHeavy, kind:'util'},
    {k:'wMqQ', name:'Merge-queue CI run: busy', min:W('mq'), kind:'handoff'},
    {k:'wRun', name:'Waits for a GitHub runner', min:W('ci'), kind:'handoff'},
    {k:'wPeople', name:'Waits for reviewers (busy)', min:U - W('cpu') - W('tbox') - wHeavy - W('mq') - W('ci'), kind:'handoff'}
  ];
}
/* Conflicts grow with open code PRs (N, from Little's law). Today's counts already include today's conflicts,
   so only the change from the baseline N0 is added: extra fix rounds and extra minutes open. Iterated to a fixed point. */
function withConflicts(s, run){
  const P = s.platform || {}, q = num(P.conflictPair), N0 = num(P.conflictN0);
  const pOf = N => 1 - Math.pow(1 - q, Math.max(0, N - 1)), useC = q > 0 && N0 > 0;
  const w = Math.min(100, Math.max(0, num(s.waste)))/100;
  const open = s.stages.find(x=>x.kind==='wip');
  let r = run(s), N = N0, cur = 0, ex = queueExtra(s, r);
  if (!useC && !(ex > 0.5)){ r.qExtra = Math.max(0, ex); return r; }
  /* v30: one loop solves conflicts and the heavy-queue / saturation open time together (damped for the queue term) */
  for (let i = 0; i < 6 && open; i++){
    N = r.R * (stageWall(open, w) + cur) / DAY;
    const dp = useC ? pOf(N) - pOf(N0) : 0, nx = i ? 0.5*(cur + ex) : ex;
    if (Math.abs(dp - (r.conflict ? r.conflict.dp : (i ? dp : 1e9))) < 1e-4 && Math.abs(nx - cur) < 0.5 && i){ r.conflict = {N, p:pOf(N), dp}; r.qExtra = cur; return r; }
    cur = nx > 0.5 ? nx : 0;
    const s2 = Object.assign({}, s, {stages:s.stages.map(st=>st.kind === 'wip' || st.id === 'fix' ? Object.assign({}, st) : st)}); /* v30.1: copy only what changes */ const o2 = s2.stages.find(x=>x.kind==='wip'), f2 = s2.stages.find(x=>x.id==='fix');
    const add = dp*num(P.conflictMin) + cur;
    o2.wall = num(o2.wall) + add; if (o2.wallTuned != null) o2.wallTuned = num(o2.wallTuned) + add;
    if (f2 && dp){ f2.countToday = Math.max(0, num(f2.countToday) + dp*num(P.conflictRounds)); f2.countTuned = Math.max(0, num(f2.countTuned) + dp*num(P.conflictRounds)); }
    r = run(s2); r.conflict = {N, p:pOf(N), dp}; ex = queueExtra(s, r);
    if (!useC && Math.abs(ex - cur) < 0.5) break;
  }
  if (!r.conflict) r.conflict = {N, p:pOf(N), dp:pOf(N)-pOf(N0)};
  r.qExtra = cur;
  return r;
}
/* v26: red main and merge-queue ejections grow with PRs/day. Each merge carries the same chance of breaking main (or of
   failing in the queue), so the share of the day lost grows with the rate: x = 1 − e^(−k·R), k set so x equals the measured
   value at rateRef (2.7% red, 14.5% ejected at 46/day). Solved as a fixed point in R (secant steps; R lowers capacity). */
const supplyMin = P => Math.min(24, Math.max(1, P && P.supplyHours != null && P.supplyHours !== '' ? num(P.supplyHours) : 24))*60;
function rateParams(P, Rt){
  const ref = num(P.rateRef), k = (x0) => -Math.log(1 - Math.min(0.95, Math.max(0, x0)))/ref;
  const red0 = num(P.redMain), ej0 = num(P.mqFail);
  return {redMainEff: num(P.redScale) > 0 && ref > 0 ? 1 - Math.exp(-k(red0)*Math.max(0, Rt)) : red0,
          mqFailEff: num(P.mqFailScale) > 0 && ref > 0 ? 1 - Math.exp(-k(ej0)*Math.max(0, Rt)) : ej0};
}
function withRate(s, run){
  const P = s.platform || {}, ref = num(P.rateRef);
  if (!(ref > 0) || !(num(P.redScale) > 0 || num(P.mqFailScale) > 0)) return run(s);
  const at = Rt => { const s2 = Object.assign({}, s, {platform:Object.assign({}, P, rateParams(P, Rt))}); const r = run(s2); r.rate = Object.assign({Rt}, rateParams(P, Rt)); return r; };
  let x0 = ref, r0 = at(x0), g0 = r0.total - x0;
  if (Math.abs(g0) < 0.05) return r0;
  let x1 = r0.total, r1 = at(x1), g1 = r1.total - x1;
  for (let i = 0; i < 8 && Math.abs(g1) >= 0.05; i++){
    let x2 = Math.abs(g1 - g0) > 1e-9 ? x1 - g1*(x1 - x0)/(g1 - g0) : (x1 + r1.total)/2;
    const lo = Math.min(x1, r1.total), hi = Math.max(x1, r1.total);
    if (!Number.isFinite(x2) || x2 < lo - 1e-9 || x2 > hi + 1e-9) x2 = (x1 + r1.total)/2;
    x0 = x1; g0 = g1; x1 = Math.max(0, x2); r1 = at(x1); g1 = r1.total - x1;
  }
  return r1;
}

/* Max flow (Edmonds-Karp) on a tiny dense graph. cap is an n×n matrix; returns {value, flow}. */
function maxFlow(cap, src, sink, init){
  const n = cap.length, flow = init || cap.map(r=>r.map(()=>0)); let value = 0;
  if (init) for (let v = 0; v < n; v++) value += flow[src][v];
  for (let it = 0; it < 200; it++){
    const prev = new Array(n).fill(-1); prev[src] = src; const q = [src];
    while (q.length && prev[sink] < 0){ const u = q.shift(); for (let v = 0; v < n; v++) if (prev[v] < 0 && cap[u][v] - flow[u][v] > 1e-9){ prev[v] = u; q.push(v); } }
    if (prev[sink] < 0) break;
    let aug = Infinity; for (let v = sink; v !== src; v = prev[v]) aug = Math.min(aug, cap[prev[v]][v] - flow[prev[v]][v]);
    for (let v = sink; v !== src; v = prev[v]){ flow[prev[v]][v] += aug; flow[v][prev[v]] -= aug; }
    value += aug;
  }
  return {value, flow};
}

/* "Fill every subscription": route movable AI stages across providers (respecting quality tiers) to maximise PRs/day. */
function computeFill(s){
  CLOSED = Math.max(0, num((s.platform||{}).closedPerMerged));
  const base = computeFixed(Object.assign({}, s, {route:'fixed'}));
  const nonAI = base.active.filter(c=>c.group !== 'AI').reduce((m,c)=>Math.min(m, c.limit), Infinity);
  const w = Math.min(100, Math.max(0, num(s.waste)))/100, tk = 1 - Math.min(90, Math.max(0, num(s.tokenSave)))/100, rho = mixRho(s);
  const provs = s.providers.map(p=>{ const c = base.cons.find(x=>x.key==='p:'+p.id); return {p, cap: c ? c.cap : (p.on ? provCap(p, s.platform, Object.fromEntries(s.hosts.map(h=>[h.id,h]))).cap : 0), eff: effOf(p)}; })
    .filter(x=>x.p.on && x.cap > 0);
  const stages = s.stages.filter(st=>st.kind==='ai' && stageAi(st, w) > 0).map(st=>({st, work: stageRuns(st, w, rho)*stageAi(st, w)*tk}));
  for (const pr of provs){ const c = base.cons.find(x=>x.key==='p:'+pr.p.id); if (c && c.fixed) pr.cap = Math.max(0, pr.cap - c.fixed); }
  const fixed = {}, mov = [];
  for (const x of stages){
    if (x.st.movable === false){ const pr = provs.find(z=>z.p.id===x.st.provider); fixed[x.st.provider] = (fixed[x.st.provider]||0) + x.work; }
    else mov.push(x);
  }
  const allowed = (st, pr) => TIER[pr.p.tier] >= TIER[st.tier];
  const solve = R => {
    const N = 2 + mov.length + provs.length, S = 0, T = N-1, cap = Array.from({length:N}, ()=>new Array(N).fill(0));
    for (const pr of provs){ const left = pr.cap - R*(fixed[pr.p.id]||0); if (left < -1e-6) return null; }
    let need = 0;
    mov.forEach((x,i)=>{ cap[S][1+i] = R*x.work; need += R*x.work; provs.forEach((pr,j)=>{ if (allowed(x.st, pr)) cap[1+i][1+mov.length+j] = 1e15; }); });
    provs.forEach((pr,j)=>{ cap[1+mov.length+j][T] = Math.max(0, pr.cap - R*(fixed[pr.p.id]||0))/pr.eff; });
    // start from the current routing (each stage on its own provider, up to that provider's room), then reroute only the overflow
    const init = cap.map(r=>r.map(()=>0)), room = provs.map((pr,j)=>cap[1+mov.length+j][T]);
    mov.forEach((x,i)=>{ const j = provs.findIndex(pr=>pr.p.id===x.st.provider); if (j < 0 || !allowed(x.st, provs[j])) return;
      const a = Math.min(cap[S][1+i], room[j]*provs[j].eff); if (a <= 0) return; room[j] -= a/provs[j].eff;
      const P = 1+mov.length+j; init[S][1+i] += a; init[1+i][S] -= a; init[1+i][P] += a; init[P][1+i] -= a; init[P][T] += a; init[T][P] -= a; });
    const f = maxFlow(cap, S, T, init);
    return f.value >= need*(1-1e-7) - 1e-9 ? f : null;
  };
  let lo = 0, hi = Number.isFinite(nonAI) ? nonAI : 1e5;
  /* v30.1: the largest feasible R in closed form (Hall's condition on this bipartite graph). The quality tiers nest, so every
     stage's allowed providers form a chain of sets and only one cut per distinct set matters:
     R·W(stages whose set ⊆ M) ≤ Σ_{j∈M} (cap_j − R·fixed_j)/eff_j, and cap_j − R·fixed_j ≥ 0. Same answer as the 60-step
     bisection (to ~1e-7, its own tolerance) with one max-flow instead of ~60. Falls back to the bisection otherwise. */
  let Rc = null, Rai = null;
  { const masks = mov.map(x=>provs.reduce((m, pr, j)=>allowed(x.st, pr) ? m | (1 << j) : m, 0));
    const dm = [...new Set(masks)], chain = provs.length < 30 && dm.every(a=>dm.every(b=>(a & b) === a || (a & b) === b));
    if (chain){ /* v30.2-A: the same closed form without the non-AI cap = the AI token limit on its own (P_token) */
      let Ri = Infinity; provs.forEach(pr=>{ const fx = fixed[pr.p.id] || 0; if (fx > 0) Ri = Math.min(Ri, pr.cap/fx); });
      for (const M of dm){ let W = 0, C = 0, F = 0; mov.forEach((x, i)=>{ if ((masks[i] & M) === masks[i]) W += x.work; });
        provs.forEach((pr, j)=>{ if (M & (1 << j)){ C += pr.cap/pr.eff; F += (fixed[pr.p.id] || 0)/pr.eff; } }); if (W > 0) Ri = Math.min(Ri, M === 0 ? 0 : C/(W + F)); }
      Rai = Math.max(0, Ri); }
    if (chain){ let R = hi;
      provs.forEach(pr=>{ const fx = fixed[pr.p.id] || 0; if (fx > 0) R = Math.min(R, pr.cap/fx); });
      for (const M of dm){ let W = 0, C = 0, F = 0; mov.forEach((x, i)=>{ if ((masks[i] & M) === masks[i]) W += x.work; });
        provs.forEach((pr, j)=>{ if (M & (1 << j)){ C += pr.cap/pr.eff; F += (fixed[pr.p.id] || 0)/pr.eff; } });
        if (W > 0) R = Math.min(R, M === 0 ? 0 : C/(W + F)); }
      Rc = Math.max(0, R); } }
  let R, f;
  if (Rc != null && (Rc === hi ? solve(hi) : Rc > 0 ? solve(Rc*(1-1e-9)) : true)){ R = Rc; f = R > 0 ? solve(R*(1-1e-9)) : null; }
  else { if (solve(hi)) lo = hi; else for (let i = 0; i < 60; i++){ const mid = (lo+hi)/2; if (solve(mid)) lo = mid; else hi = mid; }
    R = lo; f = R > 0 ? solve(R*(1-1e-9)) : null; }
  const s2 = Object.assign({}, s, {route:'fixed', stages:s.stages.map(st=>Object.assign({}, st))}); /* v30.1: only stage.split is set below */
  if (f){
    mov.forEach((x,i)=>{
      const tot = R*x.work, split = {};
      provs.forEach((pr,j)=>{ const v = f.flow[1+i][1+mov.length+j]; if (v > tot*1e-6) split[pr.p.id] = v/tot; });
      const st2 = s2.stages.find(z=>z.id===x.st.id); if (st2 && Object.keys(split).length) st2.split = split;
    });
  }
  const r = computeFixed(s2);
  /* v30.3-D.3.1 (audit items 4, 5): after the split, an AI limit of 0 (a stage no provider can take, or fixed daily use over a provider's cap) is the real rate whatever the flow found */
  if (r.R === 0 && r.binding && r.binding.group === 'AI' && R > 0){ R = 0; Rai = 0; }
  r.fill = {R, nonAI, Rai:Rai != null ? Rai : (R < nonAI*(1-1e-6) ? R : null), aiLimited: R < nonAI*(1-1e-6), splits: Object.fromEntries(s2.stages.filter(z=>z.split).map(z=>[z.id, z.split]))};
  /* v30.2-A: when the AI plans could carry more (not AI-limited), a plan the fill filled to the brim is not what limits
     delivery: name the non-AI limit (scope, policy, machines…) and leave the full AI plans out of "tied" */
  if (!r.fill.aiLimited && num((s.platform || {}).holdOn) > 0){
    const na = r.active.filter(c=>c.group !== 'AI' && Number.isFinite(c.limit));
    if (na.length && r.binding && r.binding.group === 'AI'){ r.binding = na[0]; }
    if (r.binding) r.tied = na.filter(c=>c !== r.binding && c.limit <= r.binding.limit*1.01 + 1e-9);
  }
  if (r.fill.aiLimited){
    const full =r.cons.filter(c=>c.group==='AI' && (c.demand > 0 || (c.fixed||0) > c.cap) && c.util > 0.995).map(c=>c.name);
    r.binding = {key:'ai-fill', group:'AI', name:'Every usable AI subscription is full', why: full.join(' + ') || 'all subscriptions', limit:r.R, cap:1, demand:1, util:1};
  }
  return r;
}
/* v30: a machine's cores in CU (compute units) (per-core speed; test boxes count threads in their own units) */
const hCores = h => num(h.cores)*(h.role !== 'tests' && num(h.speed) > 0 ? num(h.speed) : 1);
function computeFixed(s){
  CLOSED = Math.max(0, num((s.platform||{}).closedPerMerged));
  const w = Math.min(100, Math.max(0, num(s.waste)))/100;
  const tk = 1 - Math.min(90, Math.max(0, num(s.tokenSave)))/100;
  const rho = mixRho(s), per = 1 + rho;
  const P = s.platform;
  const hostsById = Object.fromEntries(s.hosts.map(h=>[h.id,h]));
  const provById = Object.fromEntries(s.providers.map(p=>[p.id,p]));
  const warnings = [];
  /* v30.2-A: outside the hold fixed point (direct callers), the hold tree at reference waits gives H and the open time */
  const holdOn = num(P.holdOn) > 0, foot = num(P.footOn) > 0, aSc = foot && P.agentScale != null ? num(P.agentScale) : 1;
  let hH = num(P.holdH), hOpen = num(P.holdOpen);
  if (holdOn && !(hH > 0)){ const T0 = holdTree(s, w, null, 0); hH = T0.base + T0.U; hOpen = Math.max(1, hH - T0.pre); }
  let cpu = 0, ram = 0, ci = 0, aiTotal = 0, tcpu = 0, tram = 0, dailyTotal = 0; const daily = {}, orphans = [];
  const ai = {};
  for (const st of s.stages){
    const n = stageRuns(st, w, rho);
    const wall = stageWall(st, w);
    if (st.kind === 'ci'){ ci += n*wall/Math.max(0.1, num(P.ciSpeed) || 1); continue; }
    if (st.kind === 'test'){ tcpu += n*wall*num(st.cores); tram += n*wall*num(st.ramGb); }
    cpu += n*wall*num(st.cores)*(st.kind === 'test' ? 1 : aSc);
    ram += n*wall*num(st.ramGb);
    if (st.kind === 'daily'){ const p = provById[st.provider]; if (p){ const d = stageDaily(st, w)*tk; daily[p.id] = (daily[p.id]||0) + d; dailyTotal += d; } continue; }
    if (st.kind === 'ai' && num(st.ai) > 0){
      const targets = st.split ? Object.entries(st.split) : [[st.provider, 1]];
      /* v30.3-D.3.1 (audit item 5): no provider able to take the stage means no capacity for it (a zero-capacity limit, below), never "its work is not counted" with throughput still positive.
         A local model covers a stage when it is the stage's provider (fixed route) or a quality-fit provider of the fill; the fill gives such a stage a split, so it is not an orphan here. */
      if (!targets.some(([pid, share]) => provById[pid] && share > 0)){ warnings.push(`${st.name} has no AI provider selected, so it gets no capacity.`); orphans.push({st, work:n*stageAi(st, w)*tk}); continue; }
      for (const [pid, share] of targets){
        const p = provById[pid]; if (!p || !(share > 0)) continue;
        const work = n*stageAi(st, w)*tk*share;
        ai[p.id] = (ai[p.id]||0) + work*(pid === st.provider ? 1 : effOf(p));
        aiTotal += work;
        if (TIER[p.tier] < TIER[st.tier]) warnings.push(`${st.name} needs ${TIER_LABEL[st.tier]} quality but goes to ${p.name} (${TIER_LABEL[p.tier]}).`);
      }
    }
  }
  /* v30.2-B: preparing cards above today's rate costs tokens (a Sonnet prepare run = 1.38M tokens ≈ 0.43 API-$), on Claude */
  /* v30.2-B.4 (operator 08:32/08:33 ET): card supply is not a limit. Preparing holds no files; it costs tokens (prepTokUsd per card) and runs as fast as the token budget and the
     optional Ideas input allow. Cards needed a day = cardShare × code PRs a day; merges that change the files a prepared card touches make cards stale, and re-checking them
     re-spends prep tokens (staleness is a churn cost, not a cap). Today's prep tokens are already inside the measured spend (prepRate0), only the extra is added here. */
  const pipe = (()=>{ const Rp = P.prepR != null ? num(P.prepR) : num(P.rateRef || 46)/per, stale = Math.min(0.6, Math.max(0, num(P.staleK))*Rp*per), need = Math.max(0, num(P.cardShare))*Rp*(1 + stale);
    return {Rp, stale, need, staleDay:need*stale/(1 + stale), fresh:need*Math.max(0, num(P.freshDays)), tokUsd:need*num(P.prepTokUsd)*tk, extraUsd:Math.max(0, need - (P.prepRate0 == null ? 5.33 : num(P.prepRate0)))*num(P.prepTokUsd)*tk}; })();
  { const xp = pipe.extraUsd; const pc = provById.claude || s.providers.find(p=>p.on && p.kind === 'sub');
    if (xp > 0 && pc){ daily[pc.id] = (daily[pc.id]||0) + xp; dailyTotal += xp; } }
  const cons = [];
  for (const p of s.providers){
    const d = ai[p.id] || 0;
    let {cap, why, bank, bad} = provCap(p, P, hostsById);
    if (bad && bad.length) warnings.push(`${p.name}: ${bad.join('; ')}.`);
    if (!p.on){ cap = 0; why = 'turned off'; }
    if (d > 0 && cap === 0) warnings.push(`Stages are routed to ${p.name}, but ${why}.`);
    if (d > 0 || p.on || daily[p.id]) cons.push({key:'p:'+p.id, group:'AI', name:p.name, why: daily[p.id] ? `${why}, ${fmtN0(daily[p.id])}/day fixed` : why, cap, bankCap:bank || 0, fixed: daily[p.id]||0, demand:d, unit:'API-$/day', provider:p});
  }
  for (const o of orphans) cons.push({key:'noprov:'+o.st.id, group:'AI', name:o.st.name + ' (no AI provider)', why:'no AI provider can take this stage', cap:0, demand:o.work, unit:'API-$/day'});
  /* v26 machines: hard capacity = physical cores/RAM minus fixed load; "plan for" = each machine's own target (laptop 65%,
     Forges 85%). The 85% planning ceiling does NOT apply on top of a machine target (one target per machine). */
  const SUP = supplyMin(P), redEff = P.redMainEff != null ? num(P.redMainEff) : num(P.redMain), ejEff = P.mqFailEff != null ? num(P.mqFailEff) : num(P.mqFail);
  const V = s.value || {}, gmo = Math.pow(1 + num(V.growth)/100, Math.max(0, num(V.months)));
  const openSt = s.stages.find(x=>x.kind==='wip'), nOpen = holdOn ? hOpen/DAY : openSt ? Math.max(0, stageCount(openSt, w))*stageWall(openSt, w)/DAY : 0; /* open code PRs per code PR/day (Little; v30.2-A: the whole open time) */
  const dh = s.hosts.find(h=>h.on && h.daemons);
  const unScaled = h => num(h.unattribScale) > 0;
  const fFix = foot ? footFixed(P) : 0, fMerge = foot ? footPerMerge(P) : 0;
  /* v30.2-B.5: the daemons move over a few days (P.daemonPhase 0..1, P.daemonBack = the machine they leave): that machine keeps (1 − phase) of the daemon load */
  const dPh = P.daemonPhase == null || !P.daemonBack ? 1 : Math.min(1, Math.max(0, num(P.daemonPhase))), backId = dPh < 1 ? P.daemonBack : null;
  const hostFixC = h => num(h.baseCores) + (unScaled(h) ? 0 : num(h.unattribCores)) + (h.daemons ? dPh*(foot ? fFix : num(h.daemonCores)) : 0) + (h.id === backId ? (1 - dPh)*(foot ? fFix : num((dh || {}).daemonCores)) : 0);
  const hostFixR = h => num(h.baseRamGb) + (h.daemons ? dPh*(num(h.daemonGb) + num(P.laneScriptsGb) + num(P.ramAdjDaemonGb)) : 0) + (h.id === backId ? (1 - dPh)*(num((dh || {}).daemonGb) + num(P.laneScriptsGb) + num(P.ramAdjDaemonGb)) : 0) + (h.id === 'macbook' ? num(P.ramAdjGb) : 0); /* v30.2-B.4: + lane scripts, + the fit that puts the Laptop on its measured busy-hour RAM */
  const ref = num(P.rateRef) > 0 ? num(P.rateRef) : 46;
  const dUn = dh && unScaled(dh) ? num(dh.unattribCores)*SUP/ref*per : 0;
  const dCpu = dh ? num(dh.daemonOpenCores)*nOpen*SUP + (foot ? fMerge*DAY*per : num(dh.daemonMergeCores)*60*per) + dUn : 0;
  const dRam = dh ? num(dh.daemonMergeGb)*60*per : 0;
  /* v30.2-B.6 (B2b): the daemon RAM slope (1.06 GB per merge an hour, measured near 2 an hour) stops at daemonMergeCapHr merges an hour (R at the cap = cap × SUP ÷ 60 ÷ per); beyond it the term is flat (A) */
  const mcap = num(P.daemonMergeCapHr) > 0 ? num(P.daemonMergeCapHr) : Infinity, Rcap = mcap*SUP/60/Math.max(1e-9, per);
  let cpuCap = 0, ramCap = 0; const grp = {tests:{c:0, r:0, cp:0, rp:0, names:[]}, general:{c:0, r:0, cp:0, rp:0, names:[]}};
  const hostRows = [];
  for (const h of s.hosts){
    if (!h.on || h.parked) continue; /* parked = on and paid for, but its work moved elsewhere (v28 replacement) */
    let lc = 0, lr = 0;
    for (const p of s.providers) if (p.kind==='local' && p.on && p.host===h.id){ lc += num(p.cores)*num(p.count); lr += num(p.ramGb)*num(p.count); }
    const fixC = hostFixC(h), fixR = hostFixR(h);
    /* v30.2-B (operator 06:32 ET): the delivery system does not wait on PRs; an adaptive cap holds the machine that runs the
       daemons and lanes at its measured working load (dynCap), so that load, not a static open-PR cap, is the limit */
    /* v30.2-B.4: the machine targets apply to the busy hour (p90 = u90 × the mean); RAM is full under the gate floor of 4 GB free + inactive */
    const u90 = Math.max(1, num(P.u90) || 1), fl = Math.max(0, num(P.ramFloorGb));
    const dShare = h.daemons ? dPh : h.id === backId ? 1 - dPh : 0, dynU = num(P.dynCap) > 0 ? dShare*Math.min(1, num(P.dynCap)) + (1 - dShare)/u90 : 1/u90; /* the adaptive cap follows the daemons while they move */
    const fc = hCores(h)*dynU - fixC - lc, fr = num(h.ramGb) - fl - fixR - lr;
    const fcP = hCores(h)*num(h.util)/100/u90 - fixC - lc, frP = fr;
    if (fc < 0 || fr < 0){
      warnings.push(`${h.name} is over-committed: fixed load plus local models exceed its ${fc<0?'cores':'RAM'}.`);
      cons.push({key:'h:'+h.id, group:'Machines', name:h.name+' over-committed', why:'fixed load does not fit', cap:0, demand:1, unit:''});
    } else if (fcP < 0 || frP < 0) warnings.push(`${h.name}: fixed load alone is above its ${fmtN0(num(h.util))}% target (${fcP<0?'CPU':'RAM'}), so "plan for" is 0 until it moves.`);
    hostRows.push({h, lc, lr, fc, fr, fcP, frP, fixC, fixR});
    cpuCap += Math.max(0,fc)*SUP; ramCap += Math.max(0,fr)*SUP;
    const g = grp[h.role === 'tests' ? 'tests' : 'general']; g.c += Math.max(0,fc)*SUP; g.r += Math.max(0,fr)*SUP; g.cp += Math.max(0,fcP)*SUP; g.rp += Math.max(0,frP)*SUP; g.names.push(h.name + ' (target ' + fmtN0(num(h.util)) + '%)');
  }
  const onNames = s.hosts.filter(h=>h.on).map(h=>h.name).join(' + ') || 'no machines';
  // test boxes take forgeShare of heavy-test load; everything else (agents, the rest of the tests, daemons) runs on the general machines
  const fsh0 = grp.tests.c > 0 ? Math.min(1, Math.max(0, P.forgeShare == null ? 0.9 : num(P.forgeShare))) : 0;
  const tN = grp.tests.names.join(' + '), gN = grp.general.names.join(' + ') || 'none';
  /* v30 calibration: tests are counted in CU (compute units: one Laptop performance-core-minute). What stays local is not (1 − share): each unit of test-box share
     removes only localDrop of it (cheap capacity added runs). A test box pays forgeThreadMin/macTestMin (3.3×) per unit moved. */
  const drop = Math.min(1, Math.max(0, P.localDrop == null ? 1 : num(P.localDrop))), sF = num(P.macTestMin) > 0 && num(P.forgeThreadMin) > 0 ? num(P.forgeThreadMin)/num(P.macTestMin) : 1;
  const dGen = dh && dh.role !== 'tests';
  const dRow = dh && hostRows.find(x=>x.h === dh);
  /* v30.2-B.4 (operator 2026-11-15 07:16 and 07:47 ET): the Laptop and the Studio, each with its own scope share, its own share of heavy
     commands sent to the Forge, and a floor of commands that cannot leave it. Laptop work that can move goes to the Studio. */
  const gRows = hostRows.filter(x=>x.h.role !== 'tests'), multi = gRows.length > 1, stOn = gRows.some(x=>x.h.id === 'studio'), nOther = gRows.filter(x=>x.h.id !== 'studio').length;
  const c01 = v => Math.min(1, Math.max(0, num(v)));
  const stPh = P.studioPhase == null ? 1 : c01(P.studioPhase), sS = (P.scopeShareStudio == null ? 0.85 : c01(P.scopeShareStudio))*stPh, cm = c01(P.cannotMove == null ? 0.1 : P.cannotMove);
  const shareOf = h => !multi ? 1 : stOn ? (h.id === 'studio' ? (nOther ? sS : 1) : (1 - sS)/Math.max(1, nOther)) : 1/gRows.length;
  const fsOf = h => grp.tests.c > 0 ? c01(h.id === 'studio' && P.forgeShareStudio != null ? P.forgeShareStudio : (P.forgeShare == null ? 0.9 : P.forgeShare)) : 0;
  const route = multi && stOn && num(P.laptopToStudio) > 0;
  const u90 = Math.max(1, num(P.u90) || 1), burst = P.ramBurst == null ? 1 : Math.max(1, num(P.ramBurst)), sc90 = num(P.scopes90)*per/Math.max(1, num(P.scopes90Ref) || 48);
  /* v30.2-B.5 (operator ruling: concurrency is limited by machine capacity, never a slot count). Heavy runs queue. Only ADMITTED runs use RAM and CPU.
     A machine admits heavy tests while its RAM headroom (free + inactive) stays over the gate floor and its busy-hour CPU stays under its target.
     c = min(RAM headroom ÷ GB per running test, CPU headroom ÷ cores per running test), never under the floor the gate measured (hqMinAdmit).
     Waiting runs hold nothing: resident roots = min(roots the offered load would start, c × roots per test). */
  const hqCh = Math.max(0.1, num(P.hqCh) || 1.256), rpt = Math.max(0.5, num(P.rootsPerTest) || 5.7), gbRt = num(P.gbRoot)*burst, gbTest = num(P.gbTest) > 0 ? num(P.gbTest)*burst : rpt*gbRt, cMin = Math.max(0, num(P.hqMinAdmit));
  /* v30.2-B.6 (M1): ONE basis for trees per test and trees per core. Offered load A = hqSat × heavy cores ÷ hqCh (the Erlang load: the mean number of busy admission
     servers); the tests running are A (the mean busy servers), capped by what the machine admits (c); their trees = A × trees per test. Before, offered tests were
     counted as roots (9.6 per heavy core) ÷ 5.7, 2× the queue's own load. */
  const admitAt = (x, w, R) => {
    const nC = x.fixC + x.lc + (w.cpuVar - w.heavy)/SUP*R, nG = x.fixR + x.lr + (w.ramVar - w.roots*gbRt)*R + w.dRamAt(R), t = num(x.h.util)/100;
    const cRam = (num(x.h.ramGb) - num(P.ramFloorGb) - nG)/gbTest, cCpu = (t*hCores(x.h) - u90*nC)/(hqCh*u90/Math.max(0.1, num(P.hqSat) || 1)); /* v30.2-B.6: a running test's busy-hour CPU is read the same way as the readout (heavy mean × u90 ÷ the saturation factor), so admitted tests never push CPU past the target */
    const c = Math.max(cMin, Math.min(cRam, cCpu)), A = num(P.hqSat)*w.heavy/SUP*R/hqCh, offered = A;
    return {c, cRam, cCpu, A, rho:A/Math.max(1e-9, c), offered, running:Math.min(offered, c), nC, nG, byRam:cRam <= cCpu};
  };
  /* the per-machine busy-hour loads for a share of heavy commands sent to the test boxes (fOv = null: each machine's own measured share) */
  const mkWS = fOv => {
    const WS = {}; let tBox = 0, moved = 0, rGen = 0;
    for (const x of gRows){ const id = x.h.id, share = shareOf(x.h), base = tcpu*share, fs0 = fOv != null ? fOv : fsOf(x.h), fs = drop > 0 ? Math.min(fs0, (1 - cm)/drop) : fs0, local = base*(1 - fs*drop), sent = base*fs*sF; /* the cannot-move floor: local ≥ cannotMove of its heavy commands even at a Forge share of 1 */
      const keep = route && id !== 'studio' ? local - (local - Math.min(local, base*cm))*stPh : local; moved += local - keep; WS[id] = {id, share, base, fs, local, sent, keep, moved:0}; tBox += sent; rGen += tram*share*(1 - fs*drop); }
    if (route && WS.studio){ WS.studio.keep += moved; WS.studio.moved = moved; for (const id in WS) if (id !== 'studio') WS[id].movedOut = WS[id].local - WS[id].keep; }
    const tGen = Object.values(WS).reduce((a, w)=>a + w.keep, 0);
    for (const x of gRows){ const w = WS[x.h.id], isD = x === dRow && dGen;
      w.heavy = w.keep; w.scopes = sc90*w.share; w.roots = num(P.rootsPerCore)*w.heavy/SUP;                     /* busy-hour scopes and heavy roots, per code PR a day */
      const dF = isD ? dPh : x.h.id === backId ? 1 - dPh : 0;
      w.cpuVar = (cpu - tcpu)*w.share + w.heavy + dF*dCpu;                                             /* CU a day per code PR a day */
      w.ramVar = (w.scopes*num(P.gbScope) + w.roots*num(P.gbRoot))*burst;                            /* GB at the busy hour per code PR a day (daemon merge term apart: it is capped) */
      w.dRamK = dF*dRam/SUP; w.dRamAt = R => w.dRamK*Math.min(R, Rcap); w.dRamFix = Number.isFinite(Rcap) ? w.dRamK*Rcap : 0; w.dRamSlope = Number.isFinite(Rcap) ? 0 : w.dRamK; /* for the linear RAM limit: the capped term is its value at the cap (fixed) */
      w.admitAt = R => admitAt(x, w, R); w.gbTest = gbTest; w.rpt = rpt; w.floorTests = w.heavy > 0.15*Math.max(1e-9, w.base) ? cMin : 0; }
    return {WS, tBox, moved, rGen, tGen};
  };
  /* v30.2-B.6 (B1): once the Studio and a test box (Forge B) are both on, heavy commands go to the Forge by the share that makes the Studio/Laptop limit and the Forge limit meet
     (they fill together), never a fixed number: the old fixed 0.72 share made Forge B lower delivery (151 vs 158 merged a day on Oct 4). It is never above what the cannot-move
     floor allows. Forge A keeps the share measured on it (0.72) for the days it still exists (cancelled Nov 23, never kept). */
  const ciSelf = grp.tests.c > 0 ? Math.min(1, Math.max(0, num(P.ciSelfHosted))) : 0, ciJobMin = ci*num(P.ghJobsPerRun), ciT = ciSelf*ciJobMin*num(P.ciCoresPerJob);
  let fOv = null, fLimits = null;
  if (grp.tests.c > 0 && stOn && stPh > 0 && !hostRows.some(x=>x.h.id === 'forge') && num(P.routeOverflow == null ? 1 : P.routeOverflow) > 0){
    const rhoMax = num(P.hqRhoMax) || 0.98;
    const lim = F => { const m = mkWS(F); let Rg = Infinity;
      for (const x of gRows){ const w = m.WS[x.h.id];
        if (w.cpuVar > 0) Rg = Math.min(Rg, Math.max(0, x.fc)*SUP/w.cpuVar);
        const dem = (w.ramVar + w.dRamSlope - w.roots*gbRt)*SUP; if (dem > 0) Rg = Math.min(Rg, Math.max(0, (num(x.h.ramGb) - num(P.ramFloorGb) - x.lr - x.fixR - w.floorTests*gbTest - w.dRamFix)*SUP)/dem);
        if (w.heavy > 0) Rg = Math.min(Rg, limitOfFn(R=>w.admitAt(R).rho, rhoMax)); }
      const dT = m.tBox + ciT, rT = tram*F, Rt = Math.min(dT > 0 ? (grp.tests.cp > 0 ? grp.tests.cp : grp.tests.c)/dT : Infinity, rT > 0 ? grp.tests.r/rT : Infinity);
      return {Rg, Rt}; };
    let hi = 1, lo = 0; const top = lim(hi);
    if (top.Rg <= top.Rt) fOv = hi;
    else { for (let i = 0; i < 16; i++){ const mid = (lo + hi)/2, q = lim(mid); if (q.Rg < q.Rt) lo = mid; else hi = mid; } fOv = (lo + hi)/2; }
    fLimits = lim(fOv);
  }
  const wsR = mkWS(fOv), WS = wsR.WS, tBox = wsR.tBox, moved = wsR.moved, rGen = wsR.rGen, tGen = wsR.tGen, fsh = fOv != null ? fOv : fsh0;
  const rBox = tram*fsh;
  const shText = w => `${Math.round(w.share*100)}% of scopes, ${Math.round(w.heavy/Math.max(1e-9, w.base || 1)*100)}% of their heavy commands here`;
  for (const x of gRows){ const h = x.h, w = WS[h.id], isD = x === dRow && dGen, sfx = multi ? ':' + h.id : '', hot = isD && num(P.dynCap) > 0, nm = h.name + ' load';
    cons.push({key:'cpu' + sfx, group:'Machines', dynName:nm, hot, name:'CPU, ' + h.name, why:shText(w) + (isD ? ' + daemons' : '') + ' · target ' + fmtN0(num(h.util)) + '% at the busy hour (p90)', cap:Math.max(0, x.fc)*SUP, planCap:Math.max(0, x.fcP)*SUP, demand:w.cpuVar, unit:'CU/day', wsId:h.id});
    cons.push({key:'ram' + sfx, group:'Machines', name:'RAM, ' + h.name, why:shText(w) + (isD ? ' + daemons' : '') + ` · free + inactive stays over ${fmtN0(num(P.ramFloorGb))} GB at the busy hour`, cap:Math.max(0, num(h.ramGb) - num(P.ramFloorGb) - x.lr)*SUP, fixed:(x.fixR + w.floorTests*gbTest + w.dRamFix)*SUP, planCap:Math.max(0, num(h.ramGb) - num(P.ramFloorGb) - x.lr)*SUP, demand:(w.ramVar + w.dRamSlope - w.roots*gbRt)*SUP, unit:'GB-min/day', wsId:h.id});
    /* the heavy-test queue's stability ceiling (operator 09:53 ET: a wait is a symptom, never a limit name). Past it the offered load outgrows what the machine admits and the
       queue grows without bound; the limit is named for its root cause, the machine resource that sets the admitted count (RAM headroom or CPU target), and its lever is hardware. */
    if (w.heavy > 0){ const Rq = limitOfFn(R=>admitAt(x, w, R).rho, num(P.hqRhoMax) || 0.98);
      if (Number.isFinite(Rq)){ const byRam = admitAt(x, w, Math.max(1e-6, Rq)).byRam, sib = cons.find(c=>c.key === (byRam ? 'ram' : 'cpu') + sfx), cut = Rq > 0 ? 1/Rq : 1;
        if (sib){ const old = sib.demand > 0 ? Math.max(0, sib.cap - (sib.fixed||0))/sib.demand : Infinity;
          if (Rq < old){ sib.cap = 1; sib.fixed = 0; sib.planCap = null; sib.demand = cut; sib.unit = 'admitted-test load'; sib.hq = true;
            sib.why = `heavy tests are admitted while ${byRam ? `free + inactive RAM stays over ${fmtN0(num(P.ramFloorGb))} GB` : 'busy-hour CPU stays under its target'}; at ${fmtN0((num(P.hqRhoMax) || 0.98)*100)}% of what it admits the heavy runs outgrow the machine (hardware lever: Forge B, or move work)`; } } } } }
  /* disk on the daemon machine: idle spare lanes + busy lanes (builds and fixers at once, from Little's law) + temp clones */
  let laneMin = 0;
  { const ids = new Set(); for (const pl of (s.pools||[])) if (pl.id === 'lanes' || pl.id === 'fixers') for (const id of pl.stages||[]) if (id !== 'open') ids.add(id);
    if (!ids.size){ ids.add('build'); ids.add('fix'); }
    for (const id of ids){ const st = s.stages.find(x=>x.id===id); if (st) laneMin += stageRuns(st, w, rho)*stageWall(st, w); } }
  const cloneGb = num(P.laneGb)*gmo;
  /* v28: disk follows the machine that holds the lanes (the daemon machine). The laptop's numbers are the measured
     platform inputs; another machine uses its own free space (diskFreeGb on its row) and starts with no lanes on it. */
  const dOwn = dh && dh.diskFreeGb != null, dCap = dh ? (dOwn ? num(dh.diskFreeGb) : num(P.diskFreeGb) + num(P.diskLaneGb)) : 0;
  /* v30.3-D.1 (Codex audit, fix 5): 0 GB free means the disk is full, not unlimited. The constraint stays whenever the machine is known (cap 0 gives a limit of 0). */
  if (dh && num(P.laneGb) > 0 && dCap >= 0)
    cons.push({key:'disk', group:'Machines', name:'Disk, ' + dh.name, why:`${fmtN0(num(P.laneSpare))} spare lanes + busy lanes × ${cloneGb.toFixed(2)} GB + ${fmtN0(num(P.tempGb))} GB temp` + (dOwn ? ` · ${fmtN0(dCap)} GB free on ${dh.name}` : ''), cap:dCap, fixed:num(P.laneSpare)*cloneGb + num(P.tempGb), demand:laneMin/SUP*cloneGb, unit:'GB'});
  if (grp.tests.c > 0){
    cons.push({key:'cpu-t', group:'Machines', name:'CPU, ' + tN.replace(/ \(target \d+%\)/g, ''), why:Math.round(fsh*100) + '% of heavy tests' + (ciSelf > 0 ? ` + ${Math.round(ciSelf*100)}% of CI` : '') + ' · target ' + tN, cap:grp.tests.cp > 0 ? grp.tests.cp : grp.tests.c, planCap:grp.tests.cp, demand:tBox + ciSelf*ciJobMin*num(P.ciCoresPerJob), unit:'CU/day'});
    cons.push({key:'ram-t', group:'Machines', name:'RAM, ' + tN.replace(/ \(target \d+%\)/g, ''), why:Math.round(fsh*100) + '% of heavy tests', cap:grp.tests.r, planCap:grp.tests.rp, demand:rBox, unit:'GB-min/day'});
  }
  if (num(P.spinCap) > 0) cons.push({key:'spin', group:'Concurrency', name:'Start-up ramp', why:`merged PRs a day double every ${fmtN(num(P.spinDays) || 7, 0)} days at most (A) while cards are prepared and lanes provisioned`, cap:1, demand:per/num(P.spinCap), unit:'merged/day'});
  cons.push({key:'ci', group:'GitHub', name:'Actions runners', why:'concurrent jobs', cap:num(P.ghConcurrency)*num(P.ghUtil)/100*SUP, demand:ciJobMin*(1-ciSelf), unit:'job-min/day'});
  if (num(P.humanMinPerPr) > 0) cons.push({key:'human', group:'People', name:'Human review', why:`${fmtN0(num(P.humanHours))} h/day available`, cap:num(P.humanHours)*60, demand:num(P.humanMinPerPr)*num(P.humanShare)/100, unit:'min/day'});
  const ghq = num(P.ghMinutesQuota);
  { /* GitHub API, busiest App: per merged PR + per open PR × polling daemons + per repo × polling daemons (fixed) */
    const apps = Math.max(1, num(P.apiApps) || 1), b = Math.min(1, Math.max(1/apps, P.apiBusiest == null ? 1/apps : num(P.apiBusiest)));
    /* v30.3-C.3: batching (pollMul) cuts the polling calls too, not only laptop CPU; the three API levers (Apps, ETag, webhooks) change the same terms */
    const pm = P.pollMul == null ? 1 : num(P.pollMul), mergedCalls = num(P.apiCallsPerPr)*per, openCalls = num(P.apiPerOpenPr)*pm*num(P.apiDaemons)*nOpen*24;
    const perCode = mergedCalls + openCalls, fixedCalls = num(P.apiPerRepo)*pm*num(P.apiDaemons)*num(P.apiRepos)*24, capC = num(P.apiPerHour)/apps*24*num(P.apiUtil)/100, Rlim = perCode > 0 ? Math.max(0, (capC/b - fixedCalls)/perCode) : 0, totCalls = Rlim*perCode + fixedCalls, pollShare = totCalls > 0 ? (Rlim*openCalls + fixedCalls)/totCalls : 0; /* share of calls at the cap */
    cons.push({key:'api', group:'GitHub', name:'GitHub API, busiest App', why:`${fmtN0(num(P.apiPerHour)/apps)} calls/h per App · daemon polling is ${Math.round(pollShare*100)}% of calls`, badge:'A', note:`A: the polling share (${Math.round(pollShare*100)}%) is derived from assumed per-PR and per-repo call rates; some gh calls may use a separate personal token (census ~10k/h vs 4,100 measured); GitHub's write (~80/min, 500/h) and 100-concurrent-request limits are not modelled`, cap:num(P.apiPerHour)/apps*24*num(P.apiUtil)/100, fixed:b*fixedCalls, demand:b*perCode, unit:'calls/day'}); }
  const mb = Math.max(1, num(P.mergeBatch) || 1);
  /* v30: the merge queue runs the full suite (cifull stage: grows with merged work, × CI levers). Live queue: 8 entries built at
     once, ALLGREEN (one CI run per entry), so capacity = builds × PRs per run (mqGroup; HEADGREEN batching raises it) / suite time */
  const ciSt = s.stages.find(x=>x.kind==='ci' && x.full) || s.stages.find(x=>x.kind==='ci');
  const mqMin = Math.max(0.5, (ciSt && ciSt.full ? stageWall(ciSt, w) : num(P.mqCiMin)*(ciSt && num(ciSt.wall) > 0 ? stageWall(ciSt, w)/num(ciSt.wall) : 1))/Math.max(0.1, num(P.ciSpeed)||1));
  const mqCap = num(P.mqBuilds) > 0 ? num(P.mqBuilds)*SUP/mqMin*Math.max(1, num(P.mqGroup))*(1 - Math.min(0.9, ejEff))*(1 - redEff) : SUP*num(P.mergeUtil)/100/Math.max(0.1, num(P.mergeMin)/mb);
  const mqMul = P.mqCapMul == null || P.mqCapMul === '' ? 1 : Math.max(0.1, num(P.mqCapMul));
  cons.push({key:'merge', group:'GitHub', name:'Merge queue', why: `${num(P.mqBuilds)} built in parallel × ${fmtN(Math.max(1, num(P.mqGroup)), 1)} PR per run, ${fmtN0(mqMin)} min full suite, ${Math.round(ejEff*100)}% ejected, main red ${(redEff*100).toFixed(1)}%`, cap:mqCap*mqMul, demand:per, unit:'merges/day', suiteMin:mqMin});
  /* v30.2-A: scope is a real constraint. Open scopes ≤ N (file-overlap tolerance), held scopes ≤ the fresh card supply */
  if (holdOn){ const Nn = scopeN(P);
    const Po = overlapP(P); cons.push({key:'scope', group:'Concurrency', name:'Disjoint files', why:`${fmtN(num(P.prepStock), 0)} prepared cards pack into ${fmtN(Po, 0)} disjoint sets (file overlap × ${fmtN(num(P.qMul == null ? 1 : P.qMul), 2)})`, cap:Po*DAY, demand:hH, unit:'held-scope-min/day', scopeN:Po});
    if (num(P.ideasPerDay) > 0) cons.push({key:'ideas', group:'Concurrency', name:'Ideas', why:`${fmtN(num(P.ideasPerDay), 0)} ideas a day from you (A), ${fmtN(num(P.cardShare)*100, 0)}% of scopes start from a card`, cap:num(P.ideasPerDay), demand:num(P.cardShare)*per/Math.max(1e-9, per), unit:'cards/day'}); }
  for (const pool of (s.pools||[])){
    if (!pool.on || (pool.id === 'openprs' && !(num(P.openPrCap) > 0))) continue; /* v30.2-B: the static open-PR cap is gone (an adaptive cap follows machine load); hidden switch platform.openPrCap, off */
    let d = 0;
    for (const id of pool.stages||[]){ const st = s.stages.find(x=>x.id===id); if (st) d += stageRuns(st, w, rho)*stageWall(st, w); }
    d *= pool.share == null ? 1 : num(pool.share);
    const sl = pool.slotsTuned == null || pool.slotsTuned === '' ? num(pool.slots) : num(pool.slotsTuned) + w*(num(pool.slots) - num(pool.slotsTuned));
    const span = (pool.stages||[]).includes('open') ? DAY : SUP; /* open PRs count around the clock */
    if (pool.id === 'heavy-mac'){ /* v30.2-B.5: no fixed heavy-test count; each machine admits what its RAM and CPU hold (see "Heavy tests" per machine) */
      /* v30.3-D.1 (Codex audit, fix 2): "Protect the Mac" turned on with 0 slots means no local heavy run at all: the pool is a zero-capacity limit on the work that would run there.
         v30.3-D.3.1 (audit item 2): a positive count caps local heavy runs too while Protect is on (this block only runs for a pool that is on); off, the pool never reaches here. */
      if (sl <= 0){ if (d > 0) cons.push({key:'pool:heavy-mac', group:'Concurrency', name:pool.name, why:'0 at a time (protect the Mac): no local heavy test runs', cap:0, demand:d, unit:'slot-min/day', slots:0});
        continue; } }
    cons.push({key:'pool:'+pool.id, group:'Concurrency', name:pool.name, why:`${Math.round(sl*10)/10} at a time (protect the Mac)` + (redEff > 0.03 ? `, main red ${(redEff*100).toFixed(1)}% of the day` : ''), cap:sl*span*num(P.poolUtil||85)/100*(1 - redEff), demand:d, unit:'slot-min/day', slots:sl});
  }

  for (const c of cons) c.limit = c.demand > 0 ? Math.max(0, c.cap - (c.fixed||0))/c.demand : ((c.fixed||0) > c.cap ? 0 : Infinity);
  /* v30.2-B.6 (M2): a start-up ramp that is more than 10× above every other limit no longer constrains anything; it is dropped, never listed with a nonsense number (1,791,802/day in March) */
  { const sp = cons.find(c=>c.key === 'spin'); if (sp){ const o = cons.filter(c=>c !== sp && c.demand > 0 && Number.isFinite(c.limit)).reduce((m, c)=>Math.min(m, c.limit), Infinity); if (sp.limit > 10*o) cons.splice(cons.indexOf(sp), 1); } }
  /* v30.3-D.3.1 (audit item 4): a provider whose fixed daily use is already over its cap binds at 0 even with no routed work (it used to drop out because its demand is 0) */
  const overrun = c => c.group === 'AI' && c.provider && (c.fixed||0) > c.cap;
  const active = cons.filter(c=>c.demand>0 || overrun(c));
  active.sort((a,b)=>a.limit-b.limit);
  /* v30.1 tie rule: limits equal to within 1e-6 (the fill makes AI plans run out together) are ordered by their fixed list
     position, not by rounding noise, so the same weeks always name the same limit; limits within 1% are listed as tied */
  if (active.length > 1 && Number.isFinite(active[0].limit)){ const l0 = active[0].limit, eq = active.filter(c=>c.limit <= l0*(1 + 1e-6) + 1e-9);
    if (eq.length > 1){ const pick = eq.reduce((m, c)=>cons.indexOf(c) < cons.indexOf(m) ? c : m, eq[0]); active.splice(active.indexOf(pick), 1); active.unshift(pick); } }
  const binding = active[0] && Number.isFinite(active[0].limit) ? active[0] : null;
  const tied = binding ? active.slice(1).filter(c=>Number.isFinite(c.limit) && c.limit <= binding.limit*1.01 + 1e-9) : [];
  const R = binding ? Math.max(0, binding.limit) : 0;
  const PLAN = holdOn ? 1 : 0.85; // v30.2-A: plan for comes from the wait inflation (withHold) + machine targets; the flat 85% line is gone
  for (const c of cons){ if (c.planCap == null) c.planCap = PLAN*c.cap; c.target = c.cap > 0 && Number.isFinite(c.cap) ? c.planCap/c.cap : PLAN; }
  const pooledPlanR = active.reduce((m,c)=>Math.min(m, c.demand > 0 ? Math.max(0, c.planCap - (c.fixed||0))/c.demand : Infinity), Infinity);
  const parts0 = {SUP, dCpu, dRam, agentCpu:cpu - tcpu, testGenCpu:tGen, agentRam:ram - tram, testGenRam:rGen, dh:dh && dGen ? dh.id : null, WS, tBox, tcpu, sF, drop, multi, route};
  const machines = machineRows(s, hostRows, parts0, cons, R);
  /* v28: each machine is also checked against its own target (a shared pool can sit under its plan line while one machine is past its own) */
  const machPlan = machines.reduce((m, x)=>x.active ? Math.min(m, x.planR) : m, Infinity);
  const planR = Math.min(pooledPlanR, machPlan);
  for (const c of cons) c.util = (c.demand > 0 || c.fixed) && c.cap > 0 && Number.isFinite(c.cap) ? (R*c.demand + (c.fixed||0))/c.cap : ((c.demand>0 || overrun(c)) && c.cap===0 ? 1 : 0);

  let month = 0;
  for (const p of s.providers){
    if (!p.on) continue;
    if (p.kind==='sub') month += num(p.monthlyUsd)*num(p.count);
    if (p.kind==='paygo') month += (ai[p.id]||0)*R*30*num(p.pricePerMtok)*num(P.tokPerUnit);
  }
  for (const h of s.hosts) if (h.on) month += hostMonthly(s, h, machines.find(x=>x.id === h.id));
  const ghMonthMin = R*ciJobMin*(1-ciSelf)*30; if (ghq > 0 && ghMonthMin > ghq) month += (ghMonthMin - ghq)*num(P.ghOveragePerMin);
  if (num(P.ciSpeed) > 1) month += ghMonthMin*(P.ciPaidPerMin == null ? 0.016 : num(P.ciPaidPerMin)); /* v30.3-C (operator 13:25 ET): fast runners are paid runners: every billed minute at the larger-runner list price (A) */
  const perPr = R > 0 ? month/(R*per*30) : Infinity;
  // per code PR summary (minutes and API-$ per code PR alone, cards excluded)
  const sum = {ci:0, test:0, review:0, open:0, ai:0};
  for (const st of s.stages){
    const n1 = Math.max(0, stageCount(st, w)), wl = stageWall(st, w);
    if (st.kind==='ci') sum.ci += n1*wl; else if (st.kind==='test') sum.test += n1*wl; else if (st.kind==='wip') sum.open += n1*wl;
    else if (st.kind==='ai'){ if (/^review/.test(st.id)) sum.review += n1*wl; sum.ai += n1*stageAi(st, w)*tk; }
  }
  sum.daily = dailyTotal;
  const parts = {fOv, pipe, SUP, nOpen, dCpu, dRam, dUn, agentCpu:cpu - tcpu, testGenCpu:tGen, testBoxCpu:tBox, agentRam:ram - tram, testGenRam:rGen, dh:dh ? dh.id : null, laneMin, cloneGb, fsh, redEff, ejEff, WS, tBox, tcpu, sF, drop, multi, route};
  const planBy = machPlan < pooledPlanR - 1e-9 ? machines.filter(x=>x.active).sort((a, b)=>a.planR - b.planR)[0] : null;
  return {R, total:R*per, planTotal: Number.isFinite(planR) ? Math.min(R, planR)*per : 0, rho, per, sum, daily, binding, tied, cons, active, month, perPr, aiTotal, ai, cpu, ram, warnings, hostRows, parts, machines, planBy};
}
/* v30.2-B.4 per-machine busy-hour load. Each general machine (Laptop, Studio) carries its own scope share, its own heavy commands
   (the Forge share it sends, the floor that cannot move, what the Laptop hands to the Studio) and, if it hosts them, the daemons.
   CPU is judged at the busy hour (p90 = u90 × the mean, operator 2026-11-15 07:16 ET); RAM is the capacity gate's own measure
   (free + inactive, floor 4 GB). Heavy tests go to the test boxes as before. A machine's limit = the most code PRs a day (R)
   before it passes its own target (planR) or its hard line (hardR: the admission cap on the daemon machine, p90 100% elsewhere). */
function machineRows(s, hostRows, pt, cons, Rnow){
  const P = s.platform || {}, SUP = pt.SUP, u90 = Math.max(1, num(P.u90) || 1), fl = Math.max(0, num(P.ramFloorGb)), WS = pt.WS || {};
  const tC = cons.find(c=>c.key==='cpu-t'), tRm = cons.find(c=>c.key==='ram-t');
  const tst = hostRows.filter(x=>x.h.role === 'tests'), sum = (a, f) => a.reduce((m, x)=>m + Math.max(0, x[f]), 0);
  const Ft = sum(tst, 'fc'), FtR = sum(tst, 'fr'), tc = tC ? tC.demand/SUP : 0, trr = tRm ? tRm.demand/SUP : 0;
  const load = (x, R) => {
    const fc0 = x.fixC + x.lc, fr0 = x.fixR + x.lr;
    if (x.h.role === 'tests') return {c:fc0 + tc*R*(Ft > 0 ? Math.max(0, x.fc)/Ft : 0), g:fr0 + trr*R*(FtR > 0 ? Math.max(0, x.fr)/FtR : 0)};
    const w = WS[x.h.id] || {cpuVar:0, ramVar:0};
    const a = w.admitAt ? w.admitAt(R) : null;
    return {c:fc0 + (w.cpuVar - (a && a.A > 0 ? w.heavy*(1 - Math.min(1, a.running/a.A)) : 0))/SUP*R, g:a ? a.nG + a.running*w.gbTest : fr0 + w.ramVar*R + (w.dRamAt ? w.dRamAt(R) : 0)};
  };
  const cores = x => Math.max(1e-9, hCores(x.h)), ramT = x => Math.max(1e-9, num(x.h.ramGb));
  const cpu90 = (x, R) => Math.min(9, u90*load(x, R).c/cores(x)), ramG = (x, R) => load(x, R).g;
  const hardCpu = x => x.h.daemons && num(P.dynCap) > 0 ? Math.min(1, num(P.dynCap))*u90 : 1; /* the admission cap is on the mean; at the p90 it reads × u90 */
  /* largest R with g(R) ≤ f (Illinois on the same bracket) */
  const limitOf = (g, f) => {
    if (g(0) > f + 1e-9) return 0;
    let hi = 1; while (g(hi) <= f && hi < 1e6) hi *= 2; if (hi >= 1e6) return Infinity;
    let lo = 0, glo = g(0) - f, ghi = g(hi) - f, side = 0;
    for (let i = 0; i < 60 && hi - lo > 1e-11*hi; i++){
      let mid = ghi - glo > 1e-300 ? hi - ghi*(hi - lo)/(ghi - glo) : (lo + hi)/2; if (!(mid > lo && mid < hi)) mid = (lo + hi)/2;
      const v = g(mid) - f;
      if (v <= 0){ lo = mid; glo = v; if (side === -1) ghi /= 2; side = -1; } else { hi = mid; ghi = v; if (side === 1) glo /= 2; side = 1; }
    }
    return lo;
  };
  const out = [];
  for (const h of s.hosts){
    const x = hostRows.find(z=>z.h === h);
    const w = WS[h.id], carries = !x ? [] : h.role === 'tests' ? [tc > 0 ? 'heavy tests' + (tC && /CI/.test(tC.why) ? ' + CI' : '') : 'nothing yet'] : [h.id === pt.dh ? 'daemons + lane tooling' : null, w && w.share > 0 ? 'agent sessions' + (w.heavy > 0 ? ' + tests' : '') : null].filter(Boolean);
    if (!x){ out.push({id:h.id, name:h.name, role:h.role, on:!!h.on, parked:!!(h.on && h.parked), active:false, planR:0, hardR:0, busy:0, cpu:0, cpu90:0, ram:0, target:num(h.util)/100, carries}); continue; }
    const t = num(h.util)/100, l = load(x, Rnow);
    const variable = h.role === 'tests' ? tc > 0 || trr > 0 : !!(w && (w.cpuVar > 0 || w.ramVar > 0 || w.dRamK > 0));
    const planCpu = limitOf(R=>cpu90(x, R), t), hardCpuR = limitOf(R=>cpu90(x, R), hardCpu(x)), ramLim = limitOf(R=>w && w.admitAt ? w.admitAt(R).nG + w.floorTests*w.gbTest : ramG(x, R), ramT(x) - fl), hqLim = w && w.admitAt && w.heavy > 0 ? limitOf(R=>w.admitAt(R).rho, num(P.hqRhoMax) || 0.98) : Infinity;
    const c90 = cpu90(x, Rnow), gate = ramG(x, Rnow), cacheGb = Math.min(ramT(x)*0.98, gate + num(P.ramCacheGb));
    const row = {id:h.id, name:h.name, role:h.role, on:true, parked:false, active:variable, planR:variable ? Math.min(planCpu, ramLim, hqLim) : Infinity, hardR:variable ? Math.min(hardCpuR, ramLim, hqLim) : Infinity,
      busy:Math.max(c90, h.role === 'tests' ? l.g/ramT(x) : gate/ramT(x)), cpu:l.c/cores(x), cpu0:load(x, 0).c/cores(x), cpu90:c90, ram:gate/ramT(x), target:t, carries,
      /* the busy-hour readout (one source for every panel) */
      ws:{cores:hCores(h), cpuMeanCores:l.c, cpuP90Cores:l.c*u90, cpuMean:l.c/cores(x), cpuP90:c90, target:t, ramGb:ramT(x), ramGate:gate, ramCache:cacheGb, ramHead:ramT(x) - gate, ramFloor:fl, ramFree:ramT(x) - cacheGb,
        share:w ? w.share : 0, heavyCores:w ? w.heavy/SUP*Rnow : 0, sent:w ? w.sent/SUP*Rnow : 0, forgeShare:w ? w.fs : 0, cannotMove:num(P.cannotMove), scopes:w ? w.scopes*Rnow : 0, roots:w && w.admitAt ? w.admitAt(Rnow).running*w.rpt : (w ? w.roots*Rnow : 0), rootsOffered:w ? w.roots*Rnow : 0, hosts:h.id === pt.dh,
        admit:w && w.admitAt ? w.admitAt(Rnow).c : 0, admitBy:w && w.admitAt ? (w.admitAt(Rnow).byRam ? 'RAM' : 'CPU') : '', queueRho:w && w.admitAt ? w.admitAt(Rnow).rho : 0, running:w && w.admitAt ? w.admitAt(Rnow).running : 0}};
    out.push(row);
  }
  return out;
}
/* v28: one source for a machine's monthly cost. A machine linked to a "Test and CI compute" option (costFrom) costs what
   that option costs (rent, or purchase spread over its months + power at its load); otherwise its own $/month input. */
function hostMonthly(s, h, m){
  const o = h.costFrom && s.compute && (s.compute.options || []).find(z=>z.id === h.costFrom);
  if (!o) return num(h.monthlyUsd);
  return optMonthly(o, m ? Math.min(1, Math.max(0, m.cpu)) : 0, num(s.compute.kwh));
} /* v30.1: the plan waits for the project settings (a plan built before them used another Today and kept its dates: 1 load in 6 differed) */
const baseDefaults = defaults;
/* Plateau preview vocabulary (rename table, preview-spec.md). Display names only; ids and numbers are unchanged. */
const renOld2 = t => renOld(t).replace(/card PRs do not count toward the open-PR cap/g, 'share of merged PRs that are card (planning-change) PRs');
function renOld(t){ if (typeof t !== 'string') return t; return t.replace(/MS-A2 beside (Test server 1|Forge A) \(keep both test boxes\)/g, 'Forge B beside Forge A (keep both)').replace(/Place MS-A2 workload/g, 'Place work on Forge B').replace(/Buy MS-A2/g, 'Buy Forge B').replace(/MS-A2 decision/g, 'Forge B decision')
  .replace(/Test server 1/g, 'Forge A').replace(/Test server 2/g, 'Forge B').replace(/\b[Tt]est servers\b/g, 'the Forges').replace(/\b[Tt]est server\b/g, 'Forge').replace(/Mac Studio arrives/g, 'Studio arrives').replace(/[Ww]orkstation/g, 'Studio'); }
const SAFETY_POOLS = new Set(['lanes', 'fixers', 'reviews', 'heavy-mac', 'workers']);
const POOL_NAMES = {lanes:'Protect the Mac: builds', fixers:'Protect the Mac: fixes', reviews:'Protect the Mac: reviews', 'heavy-mac':'Protect the Mac: local tests', workers:'Protect the Mac: workers'};
const OLD_NAMES = {MacBook:'Laptop', 'Mac Studio M5 Ultra':'Studio', Workstation:'Studio', 'Forge (i9-13900)':'Forge A', 'Test server 1':'Forge A', 'MS-A2 (Ryzen 9 9955HX)':'Forge B', 'Test server 2':'Forge B',
  'Babysitting & assistant sessions (per day)':'Human-in-the-loop overhead (per day)', 'Build (orchestrator workers today → builder daemon)':'Build', 'Codex prepare / build / audit':'Codex prepare and check',
  'Daemon passes (verify, triage, health)':'Automated passes (verify, triage, health)', 'Heavy test runs':'Local test runs', 'GitHub CI runs (PR pushes + merge queue)':'CI runs (PR pushes + merge queue)', 'Code PR open time (WIP)':'Code PR open time'};
function pathTarget(s, path){
  const [sec, id, f] = path.split('.');
  if (s[sec] && !Array.isArray(s[sec]) && f === undefined) return {row:s[sec], f:id};
  const row = (s[sec]||[]).find(r=>r.id===id);
  return row ? {row, f} : null;
}
function applyProject(s){
  if (!PS) return s;
  for (const x of PS.set||[]){
    const t = pathTarget(s, x.path); if (!t) continue;
    t.row[t.f] = x.value;
    t.row.src = Object.assign({}, t.row.src||{}, {[t.f]:['s', x.from + (x.source && x.source!=='repo' ? ' (' + x.source + ')' : '')]});
  }
  /* v30.2: slot caps (builds, fixers, reviews, local test slots at once) are not constraints: concurrency is what fits on the
     machines. They stay as an optional "protect the Mac" safety cap, off by default. The open-PR cap is a policy (on, live). */
  s.pools = (PS.pools||[]).filter(p=>p.id !== 'openprs').map(p=>({id:p.id, name:POOL_NAMES[p.id] || p.name, slots:p.slots, slotsTuned:p.slotsTuned == null ? null : p.slotsTuned, stages:p.stages.slice(), share:p.share == null ? 1 : p.share, enforced:!!p.enforced, on:!!p.enforced && !SAFETY_POOLS.has(p.id), safety:SAFETY_POOLS.has(p.id), from:p.from}));
  return s;
}
/* v30 calibration on top of the project snapshot: the measured Forge share of heavy WORK (72–75%, not the 0.9 run-count
   target) and the heavy pool cap the calibration measured (2 slots) */
function applyCal(s){
  s.platform.forgeShare = 0.72; s.platform.src = Object.assign({}, s.platform.src, {forgeShare:M('Laptop forgeShare 0.72 (0.58–0.76), peak-load.md by wall-hours Nov 12–15. Calibration: Forge share of heavy test WORK, measured 72–75% Nov 12–14 (wall-hour share from the run logs). forge-share.json targets 0.9 of run counts, but early Forge runs were small "files" runs')});
  /* v30.2-B.4 token refit: the project snapshot sets Claude's "usable share" to 81%, which is what the accounts SPENT in Nov 7–13 (use, not a limit).
     The cap is the 2 accounts' weekly caps; spill-over to Codex and Google and the banked resets carry what Claude cannot. */
  { const cl = s.providers.find(p=>p.id === 'claude'); if (cl){ cl.useShare = 100; cl.src = Object.assign({}, cl.src, {useShare:D('v30.2-B.4: 100 = both accounts\' weekly caps are usable. The snapshot\'s 81% is what was spent in Nov 7–13 ($4,212 of $5,200), a use, not a limit: the logs show $4,300 (83%) with 17% left, and every account carries work')}); } }
  const hp = (s.pools || []).find(p=>p.id === 'heavy-mac'); if (hp){ hp.slots = 2; hp.slotsTuned = null; hp.share = 1; hp.from = 'calibration: heavy pool cap 2 slots (heavy-queue snapshots, Nov 4–14); settings snapshot says heavyAdmissionCap 3'; }
  return s;
}
defaults = function(){ return applyCal(applyProject(baseDefaults())); };
function presetToday(){ const s = defaults(); s.waste = 100; s.hosts.find(h=>h.id==='studio').on = false; return s; }
function presetRecs(){ const s = presetEnd(); s.value = Object.assign({}, s.value, {precedent:15}); s.value.src = Object.assign({}, s.value.src, {precedent:A('assumed: card 6151 wired (past decisions injected into live reviews), 15% fewer review/fix rounds')});
  const c = s.providers.find(p=>p.id==='claude'); if (c){ c.opusShare = 35; c.src = Object.assign({}, c.src, {opusShare:A('Recommendations applied: Opus share lowered from 63% (measured) to 35% (target, assumed)')}); }
  return s; }
function presetPlatform(){ const s = presetEnd(); s.value = Object.assign({}, s.value, {reuse:40, precedent:15}); return s; }
function presetStretch(){ const s = presetEnd(); s.tokenSave = 36; for (const pl of (s.pools||[])) if (pl.id==='lanes') pl.slotsTuned = 24; const c = s.stages.find(x=>x.kind==='ci'); if (c) c.wallTuned = num(c.wall)/2; return s; }
function presetEnd(){ const s = defaults(); s.tokenSave = 20; for (const pl of (s.pools||[])){ if (pl.id==='openprs') pl.on = false; if (pl.id==='lanes'){ pl.stages = ['build']; } } const c = s.providers.find(p=>p.id==='claude'); if (c){ c.useShare = 100; c.src = Object.assign({}, c.src, {useShare:A('end state: both accounts used at once (ruling 37, account split)')}); }
  /* v30.2-B: the tuned presets include the confirmed move of the daemons to the Studio (Nov 19), so the laptop's 65% target no longer sets plan for */
  { const v = variants().find(x=>x.label === 'Daemons move to the Studio'); if (v) v.apply(s); }
  return s; }
/* v30.1: a JSON-equivalent deep copy (same result as JSON.parse(JSON.stringify(o)): undefined/functions dropped, NaN/±Infinity
   → null, key order kept) without the string round trip; the engine clones a state ~30 times per run, so this was ~25% of it */
function jclone(v){ if (v === null) return null; const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? v : null; if (t === 'string' || t === 'boolean') return v; if (t !== 'object') return undefined;
  if (typeof v.toJSON === 'function') return JSON.parse(JSON.stringify(v));
  if (Array.isArray(v)){ const n = v.length, a = new Array(n); for (let i = 0; i < n; i++){ const x = jclone(v[i]); a[i] = x === undefined ? null : x; } return a; }
  const o = {}; for (const k of Object.keys(v)){ if (k === '_cx') continue; const x = jclone(v[k]); if (x !== undefined){ if (k === '__proto__') Object.defineProperty(o, k, {value:x, enumerable:true, writable:true, configurable:true}); else o[k] = x; } } return o; }
const clone = o => o === undefined ? JSON.parse(undefined) : jclone(o);
function migrate(s){
  const d = defaults();
  if (!s || typeof s !== 'object' || !Array.isArray(s.stages)) return d;
  s.platform = Object.assign({}, d.platform, s.platform||{});
  s.hosts = Array.isArray(s.hosts) ? s.hosts : d.hosts;
  s.providers = Array.isArray(s.providers) ? s.providers : d.providers;
  if (typeof s.waste !== 'number') s.waste = 0;
  if (typeof s.tokenSave !== 'number') s.tokenSave = 0;
  if (!(s.v >= 2)){
    const c = s.providers.find(p=>p.id==='claude'), dc = d.providers.find(p=>p.id==='claude');
    if (c && dc){ if (num(c.weeklyCap) === 2400) c.weeklyCap = dc.weeklyCap; if (c.useShare == null) c.useShare = 100; c.src = dc.src; }
    s.v = 2;
  }
  if (s.v < 3){
    for (const id of ['reviewc','reviewx','fix']){
      const st = s.stages.find(x=>x.id===id), ds = d.stages.find(x=>x.id===id);
      if (st && ds && num(st.countToday) === 2){ for (const k of ['countToday','countTuned','ai','wall','src']) st[k] = ds[k]; }
    }
    s.v = 3;
  }
  if (s.v < 4){ if (!Array.isArray(s.pools)) s.pools = applyProject({pools:[], stages:[], providers:[], hosts:[], platform:{}}).pools || []; s.v = 4; }
  if (!Array.isArray(s.pools)) s.pools = [];
  if (s.v === 5){ s.stages = d.stages; s.mix = d.mix; s.v = 6; }
  if (s.v < 5){ for (const p of s.providers){ const dp = d.providers.find(x=>x.id===p.id); if (p.kind==='sub'){ if (p.windowDays == null) p.windowDays = 7; if (p.resetsBanked == null) p.resetsBanked = dp ? dp.resetsBanked||0 : 0; if (p.resetRefillDays == null) p.resetRefillDays = 0; if (dp) p.src = Object.assign({}, dp.src, p.src && p.src.count && p.src.count[0]==='s' ? {count:p.src.count} : {}); } } s.stages = d.stages; s.mix = d.mix; s.v = 6; }
  if (!s.mix) s.mix = d.mix;
  if (!s.compute) s.compute = d.compute;
  if (s.v < 9){ if (num(s.platform.ghConcurrency) === 20) s.platform.ghConcurrency = d.platform.ghConcurrency; for (const k of ['ciSpeed','ciSelfHosted','ciCoresPerJob']) if (s.platform[k] == null) s.platform[k] = d.platform[k]; s.platform.src = Object.assign({}, s.platform.src, d.platform.src); }
  if (s.v < 7){
    for (const h of s.hosts) if (!h.role) h.role = (h.id==='forge' || h.id==='msa2') ? 'tests' : 'general';
    if (s.platform.forgeShare == null) s.platform.forgeShare = 0.9;
    for (const id of ['codexbuild','reviewx','fixx']){ const st = s.stages.find(x=>x.id===id), ds = d.stages.find(x=>x.id===id); if (st && ds) for (const k of ['countToday','countTuned','ai','src']) st[k] = ds[k]; }
    const cx = s.providers.find(p=>p.id==='codex'), dcx = d.providers.find(p=>p.id==='codex'); if (cx && dcx && num(cx.weeklyCap) === 1700){ cx.weeklyCap = dcx.weeklyCap; cx.src = Object.assign({}, cx.src, {weeklyCap:dcx.src.weeklyCap}); }
    s.v = 7;
  }
  if (s.v < 8){
    const oi = s.stages.findIndex(x=>x.id==='orch'), db = d.stages.find(x=>x.id==='babysit');
    if (oi >= 0) s.stages.splice(oi, 1, db); else if (!s.stages.find(x=>x.id==='babysit')) s.stages.unshift(db);
    const b = s.stages.find(x=>x.id==='build'), dbu = d.stages.find(x=>x.id==='build'); if (b && dbu){ b.name = dbu.name; if (b.aiTuned == null) b.aiTuned = dbu.aiTuned; b.src = Object.assign({}, b.src, {ai:dbu.src.ai, aiTuned:dbu.src.aiTuned}); }
    s.v = 8;
  }
  if (s.v < 9) s.v = 9;
  if (s.v < 10){ const b = s.stages.find(x=>x.id==='build'), db = d.stages.find(x=>x.id==='build'); if (b && db && (b.aiTuned == null || num(b.aiTuned) === 2.4)){ b.aiTuned = db.aiTuned; b.src = Object.assign({}, b.src, {aiTuned:db.src.aiTuned}); }
    const c = s.stages.find(x=>x.id==='ci'), dc = d.stages.find(x=>x.id==='ci'); if (c && dc && c.wallTuned == null){ c.wallTuned = dc.wallTuned; c.src = Object.assign({}, c.src, {wallTuned:dc.src.wallTuned}); }
    s.v = 10; }
  if (s.v < 11){
    for (const id of ['babysit','build','fix','fixx','redteam','passes','codexbuild','heavy']){ const st = s.stages.find(x=>x.id===id), ds = d.stages.find(x=>x.id===id); if (st && ds) for (const k of ['ai','aiTuned','perDay','perDayTuned','wall','wallTuned','cores','ramGb','src']) if (ds[k] !== undefined) st[k] = ds[k]; }
    const mb = s.hosts.find(h=>h.id==='macbook'), dmb = d.hosts.find(h=>h.id==='macbook'); if (mb && dmb && num(mb.baseCores) === 3){ mb.baseCores = dmb.baseCores; mb.util = dmb.util; mb.src = Object.assign({}, mb.src, {baseCores:dmb.src.baseCores}); }
    for (const k of ['apiPerHour','apiCallsPerPr','conflictPair','conflictN0','conflictRounds','conflictMin']) if (s.platform[k] == null || k.startsWith('api')) s.platform[k] = d.platform[k];
    s.platform.src = Object.assign({}, s.platform.src, d.platform.src);
    s.v = 11;
  }
  if (s.v < 12){
    for (const id of ['ci','open']){ const i2 = s.stages.findIndex(x=>x.id===id), ds = d.stages.find(x=>x.id===id); if (ds){ if (i2 >= 0) s.stages[i2] = clone(ds); else s.stages.push(clone(ds)); } }
    for (const k of ['ghJobsPerRun','mqBuilds','mqCiMin','mqGroup','mqFail','redMain']) s.platform[k] = d.platform[k];
    s.platform.src = Object.assign({}, s.platform.src, d.platform.src);
    s.v = 12;
  }
  if (!s.value) s.value = d.value;
  if (s.v < 13) s.v = 13;
  { const c = s.providers.find(p=>p.id==='claude'), dc = d.providers.find(p=>p.id==='claude');
    if (c && dc && c.opusShare == null){ for (const k of ['opusShare','sonnetRatio','sonnetExtraRounds']){ c[k] = dc[k]; c.src = Object.assign({}, c.src, {[k]:dc.src[k]}); } } }
  /* v14 (preview): rename old default display names; numbers untouched */
  for (const r of [].concat(s.hosts||[], s.stages||[])) if (r && OLD_NAMES[r.name]) r.name = OLD_NAMES[r.name];
  for (const pl of (s.pools||[])) if (POOL_NAMES[pl.id] && /^(Builder lanes|Fix slots|Live review rounds|Heavy test slots|Worker capacity|Open code PRs)/.test(pl.name||'')) pl.name = POOL_NAMES[pl.id];
  if (s.v < 14) s.v = 14;
  /* v15 (artifact v26): measured laptop daemon load replaces the fixed 6 cores; machine targets 65% / 85%; API split; disk */
  if (s.v < 15){
    const mb = s.hosts.find(h=>h.id==='macbook'), dmb = d.hosts.find(h=>h.id==='macbook');
    if (mb && dmb && !mb.daemons){
      if (num(mb.baseCores) === 6){ mb.baseCores = dmb.baseCores; mb.baseRamGb = num(mb.baseRamGb) === 30 ? dmb.baseRamGb : mb.baseRamGb; }
      for (const k of ['daemons','daemonCores','daemonOpenCores','daemonMergeCores','daemonGb','daemonMergeGb','unattribCores','unattribScale']) mb[k] = dmb[k];
      if (num(mb.util) === 85) mb.util = dmb.util;
      mb.src = Object.assign({}, mb.src, dmb.src);
    }
    for (const h of s.hosts) if (h.role === 'tests' && num(h.util) === 75 && !(h.src && h.src.util && h.src.util[0] === 'y')){ h.util = 85; const dh = d.hosts.find(x=>x.id===h.id); if (dh) h.src = Object.assign({}, h.src, {util:dh.src.util}); }
    if (num(s.platform.apiCallsPerPr) === 2140) s.platform.apiCallsPerPr = d.platform.apiCallsPerPr;
    s.platform.src = Object.assign({}, s.platform.src, d.platform.src);
    s.v = 15;
  }
  { const c = s.providers.find(p=>p.id==='claude'), dc = d.providers.find(p=>p.id==='claude'); if (c && dc && c.maxCount == null){ c.maxCount = dc.maxCount; c.src = Object.assign({}, c.src, {maxCount:dc.src.maxCount}); } }
  if (s.plan && !Array.isArray(s.plan.milestones)) delete s.plan;
  /* v16 (artifact v28): the Forges take their cost from the compute options; the Studio gets its own disk */
  if (s.v < 16){
    for (const h of s.hosts || []){ const dh0 = d.hosts.find(x=>x.id === h.id); if (!dh0) continue;
      if (dh0.costFrom && h.costFrom == null){ h.costFrom = dh0.costFrom; h.src = Object.assign({}, h.src, {costFrom:dh0.src.costFrom}); }
      if (dh0.diskFreeGb != null && h.diskFreeGb == null){ h.diskFreeGb = dh0.diskFreeGb; h.src = Object.assign({}, h.src, {diskFreeGb:dh0.src.diskFreeGb}); } }
    if (!s.compute) s.compute = clone(d.compute);
    if (s.plan && s.plan.axis === 'date') s.plan.axis = 'auto';
    s.v = 16;
  }
  /* v17 (artifact v30): calibration fold-in, CI split into PR-scoped + full suite, per-host test cost, confirmed prices */
  if (s.v < 17){
    const P = s.platform, dP = d.platform;
    if (num(P.forgeShare) === 0.9) P.forgeShare = dP.forgeShare;
    if (num(P.mqCiMin) === 17.4) P.mqCiMin = dP.mqCiMin;
    P.src = Object.assign({}, P.src, {forgeShare:dP.src.forgeShare, mqCiMin:dP.src.mqCiMin});
    for (const k of Object.keys(dP.src)) if (!(P.src && P.src[k])) P.src[k] = dP.src[k];
    const mb = s.hosts.find(h=>h.id==='macbook'), dmb = d.hosts.find(h=>h.id==='macbook'); if (mb && dmb && num(mb.unattribCores) === 3){ mb.unattribCores = dmb.unattribCores; mb.src = Object.assign({}, mb.src, {unattribCores:dmb.src.unattribCores}); }
    for (const id of ['forge', 'msa2', 'studio']){ const h = s.hosts.find(x=>x.id===id), dh0 = d.hosts.find(x=>x.id===id); if (!h || !dh0) continue;
      if ((id === 'forge' && num(h.cores) === 24) || (id === 'msa2' && num(h.cores) === 16)){ h.cores = dh0.cores; h.src = Object.assign({}, h.src, {cores:dh0.src.cores}); }
      if (id === 'studio' && h.speed == null){ h.speed = dh0.speed; h.src = Object.assign({}, h.src, {speed:dh0.src.speed}); } }
    const hv = s.stages.find(x=>x.id==='heavy'), dhv = d.stages.find(x=>x.id==='heavy'); if (hv && dhv && num(hv.cores) === 1){ hv.cores = dhv.cores; hv.src = Object.assign({}, hv.src, {cores:dhv.src.cores}); }
    const ci = s.stages.findIndex(x=>x.id==='ci'), dci = d.stages.find(x=>x.id==='ci'), dfull = d.stages.find(x=>x.id==='cifull');
    if (ci >= 0 && !s.stages.find(x=>x.id==='cifull')){ const old = s.stages[ci], nc = clone(dci); if (old.halved){ nc.wall /= 2; nc.wallTuned /= 2; nc.halved = true; } if (num(old.wallTuned) && num(old.wall) && num(old.wallTuned)/num(old.wall) < 0.6) nc.wallTuned = nc.wall/2; s.stages.splice(ci, 1, nc, clone(dfull)); }
    for (const id of ['claude', 'codex', 'google']){ const p = s.providers.find(x=>x.id===id), dp = d.providers.find(x=>x.id===id); if (p && dp && p.src) p.src = Object.assign({}, p.src, {monthlyUsd:dp.src.monthlyUsd}); }
    const hp = (s.pools || []).find(p=>p.id === 'heavy-mac'), dhp = (d.pools || []).find(p=>p.id === 'heavy-mac'); if (hp && dhp && num(hp.slots) === 3){ hp.slots = dhp.slots; hp.slotsTuned = null; hp.share = 1; hp.from = dhp.from; }
    s.v = 17;
  }
  /* v18 (v30.2-A): census footprint replaces the unattributed laptop term; slot caps become optional safety caps (off) */
  if (s.v < 18){
    const P = s.platform, dP = d.platform; P.src = Object.assign({}, P.src); for (const k of Object.keys(dP.src)) if (!P.src[k] || k === 'agentScale') P.src[k] = dP.src[k];
    const mb = s.hosts.find(h=>h.id==='macbook'), dmb = d.hosts.find(h=>h.id==='macbook');
    if (mb && dmb){ if (num(mb.baseCores) === 2.2) mb.baseCores = dmb.baseCores; if ([1.68, 3].includes(num(mb.unattribCores))) mb.unattribCores = 0;
      mb.src = Object.assign({}, mb.src, {baseCores:dmb.src.baseCores, unattribCores:dmb.src.unattribCores}); }
    /* INTENDED (operator ruling 2026-11-15, "Concurrency is limited by machine capacity, never by a slot count" and the v19 safety rule below): saved slot caps are never constraints, so this switches them off even when the saved pool says enforced:true. "Protect the Mac" is off by default and only the user turns it back on. Tested in tests/engine.node.mjs. */
    for (const pl of (s.pools || [])) if (SAFETY_POOLS.has(pl.id)){ pl.safety = true; pl.on = false; }
    s.v = 18;
  }
  /* v19 (v30.2-B fix, operator 2026-11-15): states saved at v18 before the safety flag existed kept fixers/builds/reviews/local-test caps on; force them off once ("Protect the Mac" turns them back on) */
  if (s.v < 19){
    for (const pl of (s.pools || [])) if (SAFETY_POOLS.has(pl.id)){ pl.safety = true; pl.on = false; }
    s.v = 19;
  }
  /* v20 (v30.2-B.2): the plan keeps its own start-setup snapshot (plan.base) while a milestone is viewed; it was never migrated, so old slot caps came back on the timeline */
  if (s.v < 20){
    for (const t of [s, s.plan && s.plan.base]) if (t) for (const pl of (t.pools || [])) if (SAFETY_POOLS.has(pl.id)){ pl.safety = true; pl.on = false; }
    s.v = 20;
  }
  /* v21 (v30.2-B.3): the worker ceiling joins the "Protect the Mac" set (off); the retired open-PR cap row and its milestones are dropped (never renamed);
     machines are named Forge A / Forge B / Studio (operator 2026-11-15 07:06 ET) in saved milestones and their change labels */
  if (s.v < 21){
    for (const t of [s, s.plan && s.plan.base, s.plan && s.plan.inputs]) if (t && Array.isArray(t.pools)){ t.pools = t.pools.filter(p=>p.id !== 'openprs'); for (const pl of t.pools) if (SAFETY_POOLS.has(pl.id)){ pl.safety = true; pl.on = false; } }
    { const deep = o => { if (Array.isArray(o)){ for (let i = 0; i < o.length; i++) o[i] = typeof o[i] === 'string' ? renOld2(o[i]) : deep(o[i]); } else if (o && typeof o === 'object'){ for (const k of Object.keys(o)){ const v = o[k]; if (typeof v === 'string') o[k] = renOld2(v); else if (v && typeof v === 'object') deep(v); } } return o; };
      deep(s); }
    if (s.plan && Array.isArray(s.plan.milestones)){
      const openPr = x => /open[- ]PRs? (cap|allowed)/i.test(String(x || ''));
      s.plan.milestones = s.plan.milestones.filter(m=>!openPr(m.name) && !(m.ch || []).some(op=>openPr(op.label)));
      for (const m of s.plan.milestones){ m.name = renOld(m.name); if (m.note) m.note = renOld(m.note); if (m.why) m.why = renOld(m.why); if (m.suggested) m.suggested = renOld(m.suggested); for (const op of (m.ch || [])) if (op && op.label) op.label = renOld(op.label); }
      if (Array.isArray(s.plan.dismissed)) for (const m of s.plan.dismissed) if (m && m.name) m.name = renOld(m.name);
    }
    s.v = 21;
  }
  /* v22 (v30.2-B.4): token refit (Claude's "usable share" 81% was last week's spend, not a limit; measured weekly use and the banked-reset owners are recorded),
     busy-hour machine model (parameters come from the platform defaults), Forge A is never kept (plans are upgraded by ptUpgrade) */
  if (s.v < 22){
    for (const p of s.providers){ const dp = d.providers.find(x=>x.id === p.id); if (!dp) continue;
      for (const k of ['usedWeek', 'usedWeekCap', 'usedWeekNow', 'bankAccounts']) if (p[k] == null && dp[k] != null){ p[k] = dp[k]; p.src = Object.assign({}, p.src, dp.src && dp.src[k] ? {[k]:dp.src[k]} : {}); } }
    { const c = s.providers.find(x=>x.id === 'claude'), dc = d.providers.find(x=>x.id === 'claude'); if (c && dc && num(c.useShare) === 81){ c.useShare = 100; c.src = Object.assign({}, c.src, {useShare:dc.src.useShare}); } }
    const P = s.platform, dP = d.platform; P.src = Object.assign({}, P.src); for (const k of Object.keys(dP.src)) if (!P.src[k]) P.src[k] = dP.src[k];
    if (num(P.forgeShare) === 0.73) P.forgeShare = dP.forgeShare;
    { const mb0 = x => typeof x === 'string' ? x.replace(/MacBook core-min/g, 'CU').replace(/\bcore-min\b/g, 'CU').replace(/MacBook/g, 'Laptop').replace(/AI tokens \(Claude \+ Codex \+ Google AI\)/g, 'AI tokens').replace(/Fresh card supply( \/ disjoint files)?/g, 'Disjoint files').replace(/the fresh card supply/g, 'the disjoint files') : x;
      const deep2 = o => { if (Array.isArray(o)){ for (let i = 0; i < o.length; i++) o[i] = typeof o[i] === 'string' ? mb0(o[i]) : deep2(o[i]); } else if (o && typeof o === 'object'){ for (const k of Object.keys(o)){ const v = o[k]; if (typeof v === 'string') o[k] = mb0(v); else if (v && typeof v === 'object') deep2(v); } } return o; };
      deep2(s); }
    if (s.plan && Array.isArray(s.plan.milestones)){ const mb = x => typeof x === 'string' ? x.replace(/MacBook/g, 'Laptop') : x;
      for (const m of s.plan.milestones){ m.name = mb(m.name); if (m.note) m.note = mb(m.note); if (m.why) m.why = mb(m.why); if (m.suggested) m.suggested = mb(m.suggested); for (const op of (m.ch || [])) if (op && op.label) op.label = mb(op.label); } }
    s.v = 22;
  }
  /* v30.3-C.1: Forge C (a 2nd MS-A2, off until the plan places it) and its cost option, added once to older saved states */
  { const dc = d.hosts.find(h=>h.id === 'msa2c'); if (dc && !s.hosts.some(h=>h.id === 'msa2c')) s.hosts.push(clone(dc));
    const op = d.compute && (d.compute.options || []).find(o=>o.id === 'msa2c'); if (op && s.compute && Array.isArray(s.compute.options) && !s.compute.options.some(o=>o.id === 'msa2c')) s.compute.options.push(clone(op)); }
  if (s.plan && s.plan.base && s.plan.base !== s && (s.plan.base.v || 0) < s.v){ s.plan.base = migrate(s.plan.base); }
  return s;
}
const FMT_NF = []; /* v30.1: one formatter per digit count (toLocaleString built one per call: 7% of a plan render) */
function fmtN(n, d=0){ if (!Number.isFinite(n)) return '∞'; const f = FMT_NF[d] || (FMT_NF[d] = new Intl.NumberFormat('en-US', {maximumFractionDigits:d, minimumFractionDigits:d})); return f.format(n); }
function fmtUsd(n){ if (!Number.isFinite(n)) return '-'; return '$' + (n >= 100 ? fmtN(n,0) : fmtN(n,2)); }
/* v26: load at a given delivery level L (merged PRs/day) on setup s. Red main, ejections and conflicts are set for L;
   AI routing keeps the split found at the setup's own limit. Returns busy share per limit and the laptop split. */
function loadAt(s0, L, rr){
  const v = applyValue(s0), P0 = v.platform || {};
  const s = clone(v); s.route = 'fixed'; Object.assign(s.platform, rateParams(P0, L)); s.platform.prepR = L/(1 + mixRho(s));
  if (rr && rr.fill && rr.fill.splits) for (const st of s.stages){ const sp = rr.fill.splits[st.id]; if (sp) st.split = sp; }
  const w = Math.min(100, Math.max(0, num(s.waste)))/100, per = 1 + mixRho(s), Rc = L/per;
  const q = num(s.platform.conflictPair), N0 = num(s.platform.conflictN0), open = s.stages.find(x=>x.kind==='wip'), fix = s.stages.find(x=>x.id==='fix');
  if (num(s.platform.holdOn) > 0){ /* v30.2-A: open time from the hold tree (reference waits), as the engine sees it */
    const T = holdTree(s, w, rr, 0), H = T.base + T.U; s.platform.holdH = H; s.platform.holdOpen = Math.max(1, H - T.pre);
    if (open){ open.wall = s.platform.holdOpen*num(s.platform.hCounted || 0.762); open.wallTuned = null; } }
  else if (q > 0 && N0 > 0 && open){
    const pOf = N => 1 - Math.pow(1 - q, Math.max(0, N - 1)); let N = Rc*stageWall(open, w)/DAY, dp = 0;
    for (let i = 0; i < 4; i++){ dp = pOf(N) - pOf(N0); N = Rc*(stageWall(open, w) + dp*num(s.platform.conflictMin))/DAY; }
    open.wall = num(open.wall) + dp*num(s.platform.conflictMin); if (open.wallTuned != null) open.wallTuned = num(open.wallTuned) + dp*num(s.platform.conflictMin);
    if (fix){ fix.countToday = Math.max(0, num(fix.countToday) + dp*num(s.platform.conflictRounds)); fix.countTuned = Math.max(0, num(fix.countTuned) + dp*num(s.platform.conflictRounds)); }
  }
  const r = computeFixed(s), u = {};
  for (const c of r.cons){ if (!(c.cap > 0) || !Number.isFinite(c.cap)) continue; if (!(c.demand > 0) && !c.fixed) continue; u[c.key] = {util:(Rc*c.demand + (c.fixed||0))/c.cap, target:c.target, name:c.name}; }
  const pt = r.parts, out = {L, Rc, u, r, laptop:null};
  const mr = machineRows(s, r.hostRows, pt, r.cons, Rc); out.ws = mr; /* v30.2-B.4: every machine at this delivery level, busy-hour basis */
  const dh = s.hosts.find(h=>h.id===pt.dh) || s.hosts.find(h=>h.on && h.role !== 'tests');
  if (dh){
    const m = mr.find(z=>z.id === dh.id), w = (pt.WS || {})[dh.id] || {share:1, heavy:0}, k = Rc/pt.SUP, isD = !!dh.daemons && dh.role !== 'tests';
    const dC = isD ? (pt.dCpu - pt.dUn)*k : 0;
    const sys = num(dh.baseCores) + (num(dh.unattribScale) > 0 ? pt.dUn*k : num(dh.unattribCores));
    const dmn = isD ? (num(s.platform.footOn) > 0 ? footFixed(s.platform) : num(dh.daemonCores)) + dC : 0, tests = w.heavy*k, builds = pt.agentCpu*w.share*k;
    out.laptop = {id:dh.id, name:dh.name, cores:num(dh.cores), target:num(dh.util)/100, sys, dmn, tests, builds, total:sys + dmn + tests + builds, ramGb:m ? m.ws.ramGate : 0, ram:num(dh.ramGb), nOpen:pt.nOpen*Rc, u90:Math.max(1, num(s.platform.u90) || 1), p90:m ? m.cpu90 : 0, ws:m && m.ws};
  }
  return out;
}

function optMonthly(o, load, kwh){
  if (o.kind === 'rent') return num(o.monthly);
  if (o.kind === 'own') return num(o.capex)/Math.max(1, num(o.months)) + (num(o.idleW) + (num(o.loadW) - num(o.idleW))*load)*730/1000*kwh;
  return 0;
}

/* ---------- limit kinds (growth path, chip colour) ---------- */
const kindOf = c => !c ? 'flow' : c.group === 'AI' ? 'ai' : c.group === 'People' ? 'people' : (c.group === 'Machines' || c.key === 'ci') ? 'hw' : 'flow';
const short = t => String(t||'').replace(/ \([^)]*\)/g, '');
/* v30.2-B: one name per limit everywhere (hero, hover, plan list, levels) */
function limitName(c){ if (!c) return 'nothing'; if (c.key === 'ai-fill') return 'AI tokens'; if (c.group === 'AI') return short(c.name) + ' tokens';
  if (c.dynName) return c.dynName;
  const m = /^(CPU|RAM|Disk), (.+)$/.exec(String(c.name || '')); if (m) return m[2] === 'Laptop' ? 'Laptop load' : `${m[2]} · ${m[1]}`; return c.name; }

/* ---------- growth path: run the engine step by step ---------- */
function pickMove(s, r, opts, minGain){
  let best = null;
  for (const v of variants()){
    if (v.noPath || (!opts.all && !v.cap) || (opts.skip && opts.skip.has(v.label))) continue;
    const s2 = clone(s); if (v.apply(s2)) continue;
    let r2; try { r2 = compute(s2); } catch(e){ continue; }
    const d = r2.total - r.total; if (!(d >= minGain)) continue;
    const dm = Math.max(0, r2.month - r.month), cost = d > 0.5 ? dm/d : dm*1e3 + 1e-6;
    /* "lifts that limit": the binding limit's own capacity per PR rises (for "every AI subscription full", the AI ceiling rises) */
    const b = r.binding, c2 = b && b.key !== 'ai-fill' ? r2.cons.find(x=>x.key===b.key) : null;
    const lifts = !b || b.key === 'ai-fill' ? r2.R > r.R*1.001 || (r2.fill && !r2.fill.aiLimited) : (!c2 || !(c2.demand > 0) || c2.limit > b.limit*1.001);
    if (minGain < 0.5 && !lifts) continue;
    const cand = {v, s2, r2, d, dm, cost, lifts};
    const better = (x, y) => !y || (x.lifts && !y.lifts) || (x.lifts === y.lifts && (x.cost < y.cost - 1e-9 || (Math.abs(x.cost - y.cost) < 1e-9 && x.d > y.d)));
    if (better(cand, best)) best = cand;
  }
  return best;
}
function growthPath(start, opts){
  opts = opts || {}; const maxSteps = opts.steps || 10, goal = opts.goal || 300;
  let s = clone(start); const steps = [];
  for (let i = 0; i <= maxSteps; i++){
    const r = compute(s);
    const step = {state:clone(s), total:r.total, plan:r.planTotal, month:r.month, binding:r.binding, kind:kindOf(r.binding), name:limitName(r.binding)};
    /* limits that run out together (within 1%) belong to the same phase */
    const tied = r.active.filter(c=>Number.isFinite(c.limit) && c.limit*r.per <= r.total*1.01 + 0.5 && kindOf(c) !== step.kind);
    step.kinds = [step.kind]; const extra = [];
    for (const c of tied){ const k = kindOf(c); if (!step.kinds.includes(k)){ step.kinds.push(k); extra.push(limitName(c)); } }
    if (extra.length) step.name += ' and ' + extra.join(' and ');
    steps.push(step);
    if (r.total >= goal || i === maxSteps) break;
    /* one change if it lifts the total; otherwise up to three changes that each lift the limit in the way (tied limits) */
    let cur = s, rc = r; const labels = [], used = new Set(); let people = false, done = false;
    for (let k = 0; k < 3 && !done; k++){
      let m = pickMove(cur, rc, opts, 0.5);
      if (!m || !m.lifts){ const m2 = pickMove(cur, rc, opts, -0.01); if (m2 && !used.has(m2.v.label)) m = m2; else if (!m) break; }
      used.add(m.v.label); labels.push(m.v.label); people = people || !!m.v.people; cur = m.s2; rc = m.r2;
      if (rc.total - r.total >= 0.5) done = true;
    }
    if (!done) break;
    step.lever = {label:labels.join(', then '), dm:Math.max(0, rc.month - r.month), d:rc.total - r.total, people};
    s = cur;
  }
  return steps;
}
/* v30.2-B.6 (m2): Claude's share of its weekly cap, read without the banked resets (they are an expiring reserve, A). Today it is the measured share (M: 4,300 of 5,200 = 83%); the share
   with the banked resets (the model's own cap) is labelled beside it. */
function claudeShare(c, today){
  const p = c && c.provider; if (!p || p.id !== 'claude' || !(c.bankCap > 0) || !Number.isFinite(c.cap) || !(c.cap > c.bankCap)) return null;
  const withB = c.util, noB = c.util*c.cap/(c.cap - c.bankCap), meas = p.usedWeek != null && num(p.usedWeekCap) > 0 ? num(p.usedWeek)/num(p.usedWeekCap) : null;
  return {shown:noB, withB, text:`${Math.round(noB*100)}% of the weekly cap (${Math.round(withB*100)}% with banked resets)`, meas}; }
/* v30.3-C.1 (review item 5): one figure for an AI plan's use everywhere (strip, Readout, Why?, phone): the cap without the expiring banked resets */
const aiShown = c => { const cs = claudeShare(c, false); return cs ? cs.shown : c.util; };

/* v27: most accounts allowed per subscription (Claude: 3, operator limit 2026-11-14); unset = no limit */
const atMax = p => p && num(p.maxCount) > 0 && num(p.count) >= num(p.maxCount);
const maxWhy = p => `${short(p.name)} is at its limit of ${num(p.maxCount)} accounts` + (p.id === 'claude' ? ' (operator limit: at most 3 Claude accounts, ever)' : '');
/* v30.2-B Suggest realism: Suggest grows the fresh card supply only up to the measured capacity envelope (the 257 prepared
   cards pack into 88 disjoint sets today, so ~90 parallel scopes); a plan point above it is labelled "ceiling (needs …)" */
const ZV_ENV = 90; let ptSuggestCap = false;
function ptSupplyCapOld(P){ return ptSuggestCap && supplyP(P).P > ZV_ENV + 1e-9 ? `not suggested: it would lift the fresh card supply to ${fmtN(supplyP(P).P, 0)} scopes, past the measured envelope (~${ZV_ENV} scopes = the disjoint sets 257 prepared cards make today)` : undefined; }
/* v30.2-B (operator 2026-11-15): the run-cap and open-PR-cap levers are gone from the page; old plans drop them on upgrade */
const PT_GONE = new Set(['Builds at once 8 → 24', 'Fixers at once +2', 'Reviews at once +2', 'Open PRs allowed +4', 'Builds released at PR open', 'Open PRs allowed: no cap', 'Local test slots 2 → 6 (the Studio takes tests)']);
function variants(){
  return [
    {label:'+1 top-model seat', cap:true, apply:s=>{ const p = s.providers.find(x=>x.on && x.kind==='sub' && x.tier==='top' && x.id==='claude') || s.providers.find(x=>x.on && x.kind==='sub' && x.tier==='top'); if(!p) return 'no top-tier subscription to add to'; if (atMax(p)) return maxWhy(p); p.count = num(p.count)+1; p.on = true; }},
    {label:'Use the idle Google AI Ultra for top-tier work', cap:true, apply:s=>{ const p = s.providers.find(x=>x.id==='google'); if (!p) return 'no Google AI row'; if (p.on && p.tier === 'top') return 'already used for top-tier work'; p.on = true; p.tier = 'top'; }},
    {label:'+1 Codex seat', cap:true, apply:s=>{ const p = s.providers.find(x=>x.id==='codex'); if (!p) return 'no Codex row'; if (atMax(p)) return maxWhy(p); p.count = num(p.count)+1; p.on = true; }},
    {label:'+1 test server (16 cores)', cap:true, apply:s=>{ const b = s.hosts.find(x=>x.id === 'msa2'); if (!b) return 'no Forge B'; if (b.on) return 'Forge B is already on'; if (s.hosts.some(x=>x.role === 'tests' && x.on)) return 'Forge A is on: never run both Forges'; b.on = true; }},
    {label:'+1 Studio (30 cores, $150/month)', cap:true, apply:s=>{ const h = s.hosts.find(x=>x.role!=='tests' && !x.on); if (h){ h.on = true; return; } s.hosts.push({id:'ws'+s.hosts.length, name:'Extra Studio', role:'general', on:true, cores:30, ramGb:96, util:75, baseCores:1, baseRamGb:12, monthlyUsd:150}); }},
    {label:'Human review twice as fast', cap:true, people:true, apply:s=>{ if (!(num(s.platform.humanMinPerPr) > 0)) return 'no human review step'; s.platform.humanMinPerPr = num(s.platform.humanMinPerPr)/2; }},
    {label:'+1 reviewer hour a day', cap:true, people:true, apply:s=>{ if (!(num(s.platform.humanMinPerPr) > 0)) return 'no human review step'; s.platform.humanHours = num(s.platform.humanHours) + 1; }},
    {label:'Forge A off', noPath:true, apply:s=>{ const h = s.hosts.find(x=>x.id==='forge'); if(!h) return 'no Forge A'; if (!h.on) return 'already off'; h.on = false; }},
    {label:'Local model for light stages', apply:s=>{
      let p = s.providers.find(x=>x.kind==='local');
      if (!p){ p = defaults().providers.find(x=>x.kind==='local'); s.providers.push(p); }
      if (p.on) return 'already on';
      p.on = true; const h = s.hosts.find(x=>x.id===p.host); if (h) h.on = true;
      for (const st of s.stages) if (st.kind==='ai' && st.tier==='light') st.provider = p.id; }},
    {label:'Top-model reset earned every 30 days', apply:s=>{ const p = s.providers.find(x=>x.id==='claude'); if(!p) return 'no Claude row'; if (num(p.resetRefillDays) > 0) return 'already'; p.resetRefillDays = 30; }},
    {label:'CI 2× faster (paid runners)', cap:true, needsOk:true, apply:s=>{ if (num(s.platform.ciSpeed) >= 2) return 'already'; s.platform.ciSpeed = 2; }},
    {label:'Half of CI on a Forge', cap:true, apply:s=>{ if (num(s.platform.ciSelfHosted) >= 0.5) return 'already'; s.platform.ciSelfHosted = 0.5; }},
    {label:'Faster build agent (build −20%)', apply:s=>{ const b = s.stages.find(x=>x.id==='build'); if (!b) return 'no build stage'; if (b.fasterBuild) return 'already'; b.fasterBuild = true; b.ai = num(b.ai)*0.8; }},
    {label:'CI time halved', apply:s=>{ const c = s.stages.find(x=>x.kind==='ci'); if (!c) return 'no CI stage'; if (c.halved) return 'already'; c.halved = true; c.wall = num(c.wall)/2; if (c.wallTuned != null) c.wallTuned = num(c.wallTuned)/2; }},
    {label:'Human-in-the-loop overhead halved', apply:s=>{ const b = s.stages.find(x=>x.kind==='daily'); if (!b) return 'no overhead row'; if (b.halved) return 'already'; b.halved = true; b.perDay = num(b.perDay)/2; b.perDayTuned = b.perDayTuned == null ? null : num(b.perDayTuned)/2; }},
    {label:'Let work move between AI providers', cap:true, apply:s=>{ if (s.route === 'fill') return 'already filling'; s.route = 'fill'; }},
    {label:'Reuse 40% of each PR from open standards', apply:s=>{ s.value = s.value || baseDefaults().value; if (num(s.value.reuse) >= 40) return 'already at 40% or more'; s.value.reuse = 40; }},
    {label:'Show past team decisions in review (−15% rounds)', apply:s=>{ s.value = s.value || baseDefaults().value; if (num(s.value.precedent) >= 15) return 'already on'; s.value.precedent = 15; }},
    {label:'Top-model share 63% → 35%', apply:s=>{ const p = s.providers.find(x=>x.id==='claude'); if (!p) return 'no Claude row'; if (p.opusShare != null && num(p.opusShare) <= 35) return 'already at 35% or lower'; p.opusShare = 35; if (p.sonnetRatio == null) p.sonnetRatio = 0.2; if (p.sonnetExtraRounds == null) p.sonnetExtraRounds = 10; }},
    {label:'Unattributed laptop load grows with merges', noPath:true, apply:s=>{ const h = s.hosts.find(x=>x.daemons); if (!h) return 'no daemon machine'; if (num(h.unattribScale) > 0) return 'already'; h.unattribScale = 1; }},
    {label:'Daemons move to the Studio', noPath:true, apply:s=>{ const a = s.hosts.find(x=>x.daemons), b = s.hosts.find(x=>x.id==='studio'); if (!a || !b) return 'no laptop or Studio'; if (a === b) return 'already there'; b.on = true; for (const k of ['daemons','daemonCores','daemonOpenCores','daemonMergeCores','daemonGb','daemonMergeGb']){ b[k] = a[k]; delete a[k]; } }},
    {label:'Red main and ejections stay at today\'s share', noPath:true, apply:s=>{ if (!(num(s.platform.redScale) > 0 || num(s.platform.mqFailScale) > 0)) return 'already fixed'; s.platform.redScale = 0; s.platform.mqFailScale = 0; }},
    {label:'Six months of growth', noPath:true, apply:s=>{ s.value = s.value || baseDefaults().value; s.value.months = num(s.value.months) + 6; }},
    {label:'Builds held until merge (current code)', noPath:true, apply:s=>{ const p = (s.pools||[]).find(x=>x.id==='lanes'); if (!p) return 'no build limit loaded'; if ((p.stages||[]).includes('open')) return 'already held until merge'; p.on = true; p.stages = (p.stages||[]).concat('open'); }},
    {label:'1 surprise reset a month (half usable)', apply:s=>{ let ch = false; for (const id of ['claude','codex']){ const p = s.providers.find(x=>x.id===id); if (p && !(num(p.surprisePerMonth) >= 1)){ p.surprisePerMonth = 1; p.surpriseUse = 50; ch = true; } } if (!ch) return 'already'; }},
    {label:'No planning-change PRs', noPath:true, apply:s=>{ if (!s.mix || !s.mix.on) return 'already off'; s.mix.on = false; }},
    {label:'Top-model fix rounds → Codex', apply:s=>{ const a = s.stages.find(x=>x.id==='fix'), b = s.stages.find(x=>x.id==='fixx'); if (!a||!b) return 'no fix stages'; if (!(num(a.countToday) > 0)) return 'already'; b.countToday = num(b.countToday)+num(a.countToday); b.countTuned = num(b.countTuned)+num(a.countTuned); a.countToday = 0; a.countTuned = 0; }},
    {label:'Codex ×2.2 (calibration fit, unanchored)', noPath:true, apply:s=>{ if (num(s.platform.calCodex) >= 2) return 'already'; s.platform.calCodex = num(s.platform.calCodexFit) || 2.22; }},
    {label:'Fix rounds (Claude) → Sonnet', apply:s=>ptApply(s, {k:'model', stage:'fix', model:'sonnet'})},
    {label:'Automated passes → Sonnet', apply:s=>ptApply(s, {k:'model', stage:'passes', model:'sonnet'})},
    /* v30.2-A levers: scope (overlap, supply, PR size) and the census footprint (what the agents' commands cost the daemon machine) */
    {label:'Module boundaries: split the hot shared files (overlap −30%)', cap:true, apply:s=>{ const P = s.platform; if (P.qModules) return 'already'; P.qModules = true; P.qMul = (P.qMul == null || P.qMul === '' ? 1 : num(P.qMul))*0.7; }},
    {label:'Shared-append files not exclusive (overlap −5%)', cap:true, apply:s=>{ const P = s.platform; if (P.qAppend) return 'already'; P.qAppend = true; P.qMul = (P.qMul == null || P.qMul === '' ? 1 : num(P.qMul))*0.95; }},
    {label:'One shared daemon rebuild per main commit', cap:true, foot:true, apply:s=>{ const P = s.platform; if (num(P.rbShare) <= 1/7 + 1e-9) return 'already shared'; P.rbShare = 1/7; P.provPerMerge = num(P.provPerMerge)*(1 - 0.19*6/7); }},
    {label:'Batch git/gh polling in daemon ticks', cap:true, foot:true, apply:s=>{ const P = s.platform; if (num(P.pollMul) <= 0.5 + 1e-9) return 'already batched'; P.pollMul = 0.5; }},
    {label:'Review daemon refreshes PR facts on change', cap:true, foot:true, apply:s=>{ const P = s.platform; if (num(P.reviewMul) <= 0.1 + 1e-9) return 'already'; P.reviewMul = 0.1; }},
    {label:'Prebuilt lane images (provisioning −70%)', cap:true, foot:true, apply:s=>{ const P = s.platform; if (num(P.provMul) <= 0.3 + 1e-9) return 'already'; P.provMul = 0.3; }},
    {label:'PRs half the size', noPath:true, apply:s=>{ const P = s.platform; P.prLines = num(P.prLines)/2; }},
    {label:'Leaner prompts −30%', apply:s=>{ if (num(s.tokenSave) >= 30) return 'already at 30% or more'; s.tokenSave = 30; }},
    {label:'Tuned target (no repeat work or waiting)', cap:true, apply:s=>{ if (num(s.waste)===0) return 'already at the tuned target'; s.waste = 0; }}
  ];
}

/* ---------- v27 plan timeline (timeline-spec.md): variation points along efficiency progress ----------
   X = efficiency progress 0–100% (waste = 100 − X). Point 0 = this setup at its own efficiency. Each later point holds changes.
   Discrete changes (seats, machines, limits, routing) step at the point and stay. Continuous ones (tokens saved, top-model
   share, open-time cut) ramp linearly from the previous point's value and reach the new value at the point.
   Every number on the chart and the cards is a plain engine run (compute) on the state built for that X. */
const FOOT_LEVERS = new Set(['One shared daemon rebuild per main commit', 'Batch git/gh polling in daemon ticks', 'Review daemon refreshes PR facts on change', 'Prebuilt lane images (provisioning −70%)']);
const ptHwOp = op => op.k === 'host' || op.k === 'place' || (op.k === 'v' && FOOT_LEVERS.has(op.label));
const PT_CONT = {tokenSave:'Leaner prompts, % of tokens saved', opus:'Top-model share, %', open:'PR open time cut, %'};
const PT_LEVER_CONT = {'Leaner prompts −30%':['tokenSave', 30], 'Top-model share 63% → 35%':['opus', 35]};
const PT_SKIP = new Set(['Tuned target (no repeat work or waiting)', 'Fully tuned (no repeat work or waiting)',
  /* v30.1 (H5): token additions go through one path, the "Add tokens (best value)" ranking (operator order), never as loose seat moves */
  '+1 top-model seat', 'Use the idle Google AI Ultra for top-tier work', '+1 Codex seat',
  /* v30.2-B.4: paid GitHub runners need the operator's OK (Your project), and Forge B is only ever placed just in time (ptPlaceForgeB), never by the growth search */
  'CI 2× faster (paid runners)', '+1 test server (16 cores)']);
/* v30.1 (H5): the limits a change actually lifts: of what binds at r (and what is tied with it), those whose limit rises */
function ptLifted(r, r2){
  const bs = [r.binding, ...(r.tied || [])].filter(Boolean), out = [], ai = [];
  for (const c of bs){ if (c.key === 'ai-fill'){ if (r2.total > r.total + 0.5) ai.push(''); continue; }
    const c2 = r2.cons.find(z=>z.key === c.key); if (c2 && Number.isFinite(c.limit) && c2.limit > c.limit*1.01 + 1e-6){ if (c.group === 'AI') ai.push(short(c.name)); else out.push(limitName(c)); } }
  if (ai.length){ const nm = [...new Set(ai.filter(Boolean))], fill = ai.includes(''); out.unshift(fill ? 'AI tokens (every usable plan is full)' : `AI tokens (${nm.join(', ')})`); }
  if (!out.length && r2.binding && r.binding && r2.binding.key !== r.binding.key) out.push(limitName(r.binding));
  return out.length ? [...new Set(out)].join(' + ') : limitName(r.binding);
}
const ptBindTxt = r => { const tied = (r.tied || []).filter(c=>!(r.binding && r.binding.key === 'ai-fill' && c.group === 'AI')); return limitName(r.binding) + (tied.length ? `, tied with ${tied.map(c=>limitName(c)).join(', ')}` : ''); };
const ptRunOut = x => `${x} ${/ \+ |, tied with /.test(x) ? 'run' : 'runs'} out first`;
let ptSeq = 0;
const ptId = () => 'pt' + (hooks.stamp ? hooks.stamp() : '') + (ptSeq++); /* v30.3-D.1: the engine reads no clock; the page supplies a uniqueness stamp (hooks.stamp) */
/* Milestones carry dates. Efficiency progress runs linearly from the start date (milestone 0, this setup at its own
   efficiency) to the "fully tuned by" date, so a date and an efficiency level are the same position on the plan. */
const PT_DAY = 864e5;
const isoDay = d => { const z = new Date(d); return `${z.getFullYear()}-${String(z.getMonth()+1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`; };
const dayMs = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN; };
const fmtDay = s => { const t = dayMs(s); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}) : ''; };
/* v30.3-D.1: the clock is an input. `today` is an ISO day 'YYYY-MM-DD' (or a ms timestamp / Date the caller read from its own clock). No default: the engine never reads the time. */
function ptTodayIso(today){ if (today == null) throw new Error('engine: `today` is required (ISO day or ms); the engine does not read the clock'); const t = typeof today === 'string' ? dayMs(today) : (today instanceof Date ? today.getTime() : Number(today)); if (!Number.isFinite(t)) throw new Error('engine: bad `today`: ' + today); return isoDay(t); }
function planOf(s){ const p = s && s.plan; return p && Array.isArray(p.milestones) && p.milestones.length ? p : null; }
/* v30.2-A seeds: scope levers and the census footprint levers (proposed, engine-dated; off with the reason if they never add 1/day) */
const PT_V302_SEEDS = [['m-modules', 'Module boundaries: split the hot shared files', {k:'v', label:'Module boundaries: split the hot shared files (overlap −30%)'}],
  ['m-rebuild', 'One shared daemon rebuild per main commit', {k:'v', label:'One shared daemon rebuild per main commit'}],
  ['m-poll', 'Batch git/gh polling in daemon ticks', {k:'v', label:'Batch git/gh polling in daemon ticks'}],
  ['m-reviewref', 'Review daemon refreshes PR facts on change', {k:'v', label:'Review daemon refreshes PR facts on change'}],
  ['m-laneimg', 'Prebuilt lane images', {k:'v', label:'Prebuilt lane images (provisioning −70%)'}]];
function newPlan(base, today){
  const start = ptTodayIso(today), pl = {milestones:[{id:'m0', name:'Today', date:start, ch:[]}], start, tunedBy:isoDay(dayMs(start) + 140*PT_DAY), sel:[0, 1], cur:0, axis:'auto', v28:true, v30:true, halfLife:PT_HL_DEF};
  pl.until = ptDefUntil(pl.tunedBy);
  const st = (base.hosts || []).find(h=>h.id === 'studio');
  pl.show = 'all';
  /* real, dated (operator 2026-11-14): the Studio arrives Tue 11-17; the daemons move to it Thu 11-19 */
  if (st && !st.on) pl.milestones.push({id:'m-studio', name:'Studio arrives', date:isoDay(Math.max(dayMs('2026-11-17'), dayMs(start))), realDate:'2026-11-17', ch:[{k:'host', id:'studio', on:true}], status:'confirmed', seed:true});
  if (st && (base.hosts || []).some(h=>h.daemons && h.id !== 'studio') ) pl.milestones.push({id:'m-daemons', name:'Daemons move to the Studio', date:isoDay(Math.max(dayMs('2026-11-19'), dayMs(start))), realDate:'2026-11-19', ch:[{k:'v', label:'Daemons move to the Studio'}], status:'confirmed', seed:true});
  /* v30.2-B.4 (operator 2026-11-15 07:47 ET): Studio first, then cancel Forge A. The Hetzner is never kept; Forge B is a just-in-time proposal only if Studio test waits stay high at 8 heavy tests at a time */
  ptSeedStudioFirst(base, pl);
  ptSeedForgeB(base, pl);
  ptSeedForgeC(base, pl);
  if ((base.providers || []).some(p=>p.id === 'claude')) pl.milestones.push({id:'m-claude3', name:'3rd Claude top-plan subscription', date:'', ch:[{k:'seat', id:'claude', n:1}], status:'proposed', on:true, seed:true, note:'price is the assumed plan price (A): not confirmed'});
  if ((base.providers || []).some(p=>p.kind === 'sub' || p.kind === 'paygo')) pl.milestones.push({id:'m-tokens', name:'Add tokens (best value)', date:'', ch:[{k:'tokens'}], status:'proposed', on:true, seed:true, notBefore:'m-claude3', note:'once Claude is at its 3 accounts: the operator\'s order (idle Google Ultra → 2nd Codex → open-weight trial → Claude API last); winner and runner-up shown; pick another in the card'});
  /* efficiency work is milestones too (proposed, engine-suggested dates); each is skipped where it changes nothing */
  /* v30.2: no slot-cap milestones (Fixers +2, Local test slots, builder lane release): slots are not constraints any more */
  const eff = [['m-precedent', 'Wire past decisions into reviews', {k:'v', label:'Show past team decisions in review (−15% rounds)'}],
    ['m-opus', 'Top-model share → 35%', {k:'num', f:'opus', v:35}], ['m-model-fix', 'Move fix rounds to Sonnet', {k:'model', stage:'fix', model:'sonnet'}], ...PT_V302_SEEDS];
  for (const [id, name, op] of eff){ const t = clone(base); if (id === 'm-heavyslots'){ const st0 = t.hosts.find(h=>h.id==='studio'); if (st0) st0.on = true; }
    const note = op.k === 'v' || op.k === 'model' ? ptApply(t, op) : (contGet(base, op.f) === op.v ? 'already' : '');
    if (!note) pl.milestones.push(Object.assign({id, name, date:'', ch:[op], status:'proposed', on:true, seed:true, ramp:true})); }
  ptSeedReleases(pl);
  ptSuggestDates(base, pl);
  pl.v302 = true; pl.v302b = true; pl.v302c = true; pl.v302d = true; pl.v302e = true; pl.v303 = true;
  return pl;
}
/* v30.2-B.4 (operator 2026-11-15 07:47 ET, README "Operator limits"): Studio first. The Studio takes the Laptop's movable heavy commands and most scopes;
   after the week-1 measures (the Nov 21–22 weekend) it takes the whole Laptop load and Forge A (the Hetzner) is cancelled right after. The Hetzner is never kept. */
function ptSeedStudioFirst(base, pl){
  const f = (base.hosts || []).find(h=>h.id === 'forge'); if (!f || !f.on) return;
  const start = dayMs(pl.start), d1 = isoDay(Math.max(dayMs('2026-11-22'), start + PT_DAY)), d2 = isoDay(Math.max(dayMs('2026-11-23'), start + 2*PT_DAY)), gone = id => (pl.dismissed || []).some(z=>z.id === id);
  if (!pl.milestones.some(m=>m.id === 'm-takeload') && !gone('m-takeload'))
    pl.milestones.push({id:'m-takeload', name:'Studio takes the Laptop load', date:d1, ch:[{k:'place', host:'forge', what:'park'}], status:'proposed', on:true, seed:true, gate:'week-1 measures',
      note:'Proposed Nov 21–22, gated on the week-1 measures of the Studio (CPU and RAM per merged PR at the busy hour, heavy-test waits, git/pnpm/provisioning that cannot move). The Studio runs its own heavy tests, so nothing is sent to Forge A; it stays paid until the next step.'});
  if (!pl.milestones.some(m=>m.id === 'm-cancel-forge') && !gone('m-cancel-forge'))
    pl.milestones.push({id:'m-cancel-forge', name:'Cancel Forge A (Hetzner)', date:d2, ch:[{k:'host', id:'forge', on:false}], status:'proposed', on:true, seed:true, after:'m-takeload', cancel:true,
      note:'Right after the Studio has taken the load: Forge A is cancelled, −$100/month. The Hetzner is never kept (operator 2026-11-15 07:47 ET); the end state is no Forge, or Forge B only if Studio test waits stay high.'});
  ptSort(pl);
}
/* Forge B: never alongside Forge A, only if the Studio's CPU or RAM is the binding root cause (operator 09:53 ET).
   Dated just in time (two weeks' lead, A) on the plan without it; never reached in the plan -> off, with the peak it reached. */
function ptSeedForgeB(base, pl){
  const ms = (base.hosts || []).find(h=>h.id === 'msa2'); if (!ms || ms.on) return;
  const gone = id => (pl.dismissed || []).some(z=>z.id === id);
  if (!pl.milestones.some(m=>m.id === 'm-msa2') && !gone('m-msa2')) pl.milestones.push({id:'m-msa2', name:'Buy Forge B (only if Studio CPU or RAM binds)', date:'', ch:[{k:'host', id:'msa2', on:true}], status:'proposed', on:false, seed:true, fb:true, note:'cost from the Forge B inputs'});
  if (!pl.milestones.some(m=>m.id === 'm-msa2-place') && !gone('m-msa2-place')) pl.milestones.push({id:'m-msa2-place', name:'Place work on Forge B', date:'', ch:[{k:'place', host:'msa2', what:'tests'}], status:'proposed', on:false, seed:true, after:'m-msa2', fb:true, note:'tests only: both machines send their heavy tests to Forge B. Never beside Forge A.'});
  /* v30.3-C (operator ruling 14:10 ET): Forge B (MS-A2, 96 GB) is ORDERED on Nov 15, a hedge against RAM price rises. The order is a confirmed milestone (its cost runs from the order date);
     arrival and setup follow about two weeks later (A: the operator confirms the date). Forge A is still cancelled Nov 23, after the Studio check; Forge B takes the overflow only. Once per plan. */
  if (!pl.fbOrdered){ pl.fbOrdered = true;
    const o = pl.milestones.find(m=>m.id === 'm-msa2'), q = pl.milestones.find(m=>m.id === 'm-msa2-place');
    if (o && !o.ordered){ Object.assign(o, {name:'Buy Forge B (MS-A2, ordered)', date:'2026-11-15', status:'confirmed', on:true, pinned:true, ordered:true, ch:[{k:'host', id:'msa2', on:true}, {k:'place', host:'msa2', what:'park'}], note:'Ordered Nov 15 by the operator, as a hedge against RAM price rises (needed likely Dec to Jan). Paid from the order date, idle (parked) until it arrives and is set up.'}); delete o.fb; delete o.autoOff; delete o.suggested; }
    if (q && !q.ordered){ Object.assign(q, {name:'Forge B arrives and is set up (tests only)', date:'2026-11-29', status:'proposed', on:true, pinned:true, ordered:true, after:'m-msa2', note:'A: about two weeks after the order; the operator confirms the date. Tests only: Forge B takes the overflow the Studio and Laptop cannot admit.'}); delete q.fb; delete q.autoOff; delete q.suggested; } }
}
function ptPlaceForgeB(base, pl){
  const a = pl.milestones.find(m=>m.id === 'm-msa2' && m.fb), b = pl.milestones.find(m=>m.id === 'm-msa2-place' && m.fb); if (!a || !b || a.pinned || a.status !== 'proposed') return false;
  const sig = JSON.stringify([a.date, a.on, b.date, b.on, a.suggested]);
  const tr = clone(pl); tr.milestones = tr.milestones.filter(m=>m.id !== 'm-msa2' && m.id !== 'm-msa2-place'); ptSort(tr); tr._ownCum = true; /* v30.2-B.6: the plan without Forge B grows the suite with its own merges (so the date equals the one a daily scan of that plan finds) */
  const x0 = ptX0(base), XE = ptEnd(pl), step = Math.max(2, (XE - x0)/45), thr = Math.max(0, num((base.platform || {}).forgeBWait == null ? 15 : base.platform.forgeBWait))/100;
  const cx = tr.milestones.find(m=>m.id === 'm-cancel-forge'), Xmin = cx && cx.date && ptActive(tr, cx) ? ptXOfDate(tr, x0, cx.date) : x0;
  let hit = null, peak = {v:0, X:Xmin, cpu:0, ram:0};
  /* operator 09:53 ET: Forge B is offered exactly when the Studio's CPU or RAM is the binding root cause (never because of a wait). Queue waits are a readout. */
  const studioBound = r => { const bs = [r.binding, ...(r.tied || [])].filter(Boolean); return bs.some(c=>/^(cpu|ram):studio$/.test(c.key)); };
  /* v30.2-B.6 (m1): the walk samples every few days; once a sample binds, the days since the one before it are scanned one by one, so the date is the first day the Studio binds */
  const dayX = (100 - x0)*PT_DAY/ptSpan(pl);
  const walk = (bs, keepPeak) => { let h = null, prev = Xmin;
    for (let X = Xmin; X <= XE + 1e-9; X = X >= XE ? XE + 1 : Math.min(XE, X + step)){
      const {r} = ptRun(bs, tr, X), st = (r.machines || []).find(m=>m.id === 'studio'), u = st && st.ws ? Math.max(st.cpu90/Math.max(1e-9, st.target), (st.ws.ramGate)/Math.max(1, st.ws.ramGb - st.ws.ramFloor)) : 0;
      if (keepPeak && u > peak.v) peak = {v:u, X, cpu:st ? st.cpu90 : 0, ram:st && st.ws ? st.ws.ramGate : 0};
      if (studioBound(r)){ let hx = X; const dOf = Z => Math.round((Z - x0)/dayX); for (let d = dOf(prev) + 1; d < dOf(X); d++){ const Y = ptXOfDate(pl, x0, isoDay(dayMs(pl.start) + d*PT_DAY)); if (studioBound(ptRun(bs, tr, Y).r)){ hx = Y; break; } }
        const rr = hx === X ? r : ptRun(bs, tr, hx).r;
        h = {X:hx, why:(rr.binding && /^ram:/.test(rr.binding.key)) || (rr.tied || []).some(c=>/^ram:studio$/.test(c.key)) ? 'RAM' : 'CPU'}; break; }
      prev = X; }
    return h; };
  hit = walk(base, true);
  /* B2: the order date also at the top of the GB-per-running-test range (A), so the note shows how far the date moves */
  let hitHi = null; { const hiGb = num((base.platform || {}).gbTestHi); if (hit && hiGb > 0 && hiGb !== num((base.platform || {}).gbTest)){ const bh = clone(base); bh.platform.gbTest = hiGb; hitHi = walk(bh, false); } }
  const lead = 14*PT_DAY;
  if (!cx || !cx.date || !ptActive(tr, cx)){ a.date = isoDay(dayMs(ptUntil(pl))); b.date = a.date; a.on = false; b.on = false; a.autoOff = true; a.suggested = 'not placed: Forge A is not cancelled in this plan, and Forge B is never run beside it (switch "Cancel Forge A (Hetzner)" on first)'; b.suggested = 'follows Buy Forge B'; return sig !== JSON.stringify([a.date, a.on, b.date, b.on, a.suggested]); }
  if (hit){ const dt = Math.max(dayMs(pl.start) + PT_DAY, dayMs(cx.date) + PT_DAY, dayMs(ptDateOfX(pl, x0, hit.X)) - lead); /* never before Forge A is cancelled: never both Forges */
    a.date = isoDay(dt); b.date = isoDay(Math.min(dayMs(ptUntil(pl)), dt + 7*PT_DAY)); a.on = true; b.on = true; delete a.autoOff;
    a.suggested = `just in time: from ${fmtDay(ptDateOfX(pl, x0, hit.X))} the Studio's ${hit.why} is the limit that holds delivery (its heavy tests wait for it; the answer is hardware: Forge B takes the tests); two weeks' lead (A). Range: the order date is ${fmtDay(isoDay(Math.max(dayMs(pl.start) + PT_DAY, dayMs(cx.date) + PT_DAY, dayMs(ptDateOfX(pl, x0, hit.X)) - lead)))} at ${fmtN(num((base.platform || {}).gbTest), 2)} GB per running heavy test (measured) and ${hitHi ? fmtDay(isoDay(Math.max(dayMs(pl.start) + PT_DAY, dayMs(cx.date) + PT_DAY, dayMs(ptDateOfX(pl, x0, hitHi.X)) - lead))) : 'later than the plan end'} at ${fmtN(num((base.platform || {}).gbTestHi), 2)} GB (A, 5.7 trees × 0.62 GB)`; b.suggested = `a week after ${a.name}`; }
  else { a.date = isoDay(dayMs(ptUntil(pl))); b.date = a.date; a.on = false; b.on = false; a.autoOff = true;
    a.suggested = `not needed before ${fmtDay(ptUntil(pl))}: the Studio's CPU and RAM are never the binding limit (closest ${fmtDay(ptDateOfX(pl, x0, peak.X))}: CPU ${fmtN(peak.cpu*100, 0)}% busy-hour p90, RAM ${fmtN(peak.ram, 0)} GB used); waits there cost nothing while another limit binds; switched off`; b.suggested = 'follows Buy Forge B'; }
  return sig !== JSON.stringify([a.date, a.on, b.date, b.on, a.suggested]);
}
/* v30 (efficiency-2026.json): 2027 repeats 2026's model-release windows (first seen in our records). Step per major release:
   mid ×1.00 on AI cost per PR (no release lowered $/code PR in the 2 months we can measure), 80% band 0.80–1.25 each. Shown as
   automatic Proposed milestones; the band is drawn around the delivery line. Process gains between releases are the tuning ramp. */
const PT_RELEASES = [
  ['2027-05-29', 1, 'Opus 4.8 analogue'], ['2027-07-01', 2, 'Fable 5 + Sonnet 5 analogues'], ['2027-08-01', 1, 'Opus 5 analogue'],
  ['2027-09-10', 3, 'Codex gpt-6-astra, Opus 5.5, Sonnet 5.5 analogues'], ['2027-10-12', 1, 'gpt-6.1-sol analogue'], ['2027-11-14', 1, 'Fable 5.1 analogue']];
const PT_REL_SIG = Math.log(1.25); /* ln of the per-release band edge; k releases → exp(±σ√k) */
function ptSeedReleases(pl){
  for (const [d, n, what] of PT_RELEASES){ const id = 'm-rel-' + d; if (pl.milestones.some(m=>m.id === id) || (pl.dismissed || []).some(z=>z.id === id)) continue;
    if (dayMs(d) <= dayMs(pl.start) || dayMs(d) > dayMs(ptUntil(pl))) continue;
    pl.milestones.push({id, name:'Model release' + (n > 1 ? 's' : '') + ': ' + what, date:d, ch:[{k:'release', n, step:1, what}], status:'proposed', on:true, release:true, auto:false,
      note:`automatic (efficiency-2026.json): repeats a 2026 release window. AI cost per PR × 1.00 (no measured gain), band 0.80–1.25 per major release; 2026 releases raised PRs/day ×0.96–1.71 when not confounded (capacity signal, not modelled)`}); }
  ptSort(pl);
}
/* v28: the plan runs past "fully tuned by" (default + 6 months, "Show until"); after it, growth comes only from
   milestones and the value lens's code growth (CI/test time per month, counted from the start date). */
function ptDefUntil(tb){ const d = new Date(dayMs(tb)); d.setMonth(d.getMonth() + 6); return isoDay(d.getTime()); }
function ptUntil(pl){ const u = dayMs(pl.until); return Number.isFinite(u) && u > dayMs(pl.tunedBy) ? pl.until : pl.tunedBy; }
function ptEnd(pl){ return 100 + Math.max(0, dayMs(ptUntil(pl)) - dayMs(pl.tunedBy))/ptSpan(pl)*100; }
/* v27 plans: add the v28 parts once (end date, Drop Hetzner, ramping efficiency work, axis auto) */
/* v30 backlog-driven milestones (_survey/backlog-milestones.md + mq-research.md), placed JUST IN TIME: each is dated the
   week the limit it lifts would reach 85% busy (on the plan without it), minus its lead time (card points → delivery weeks
   at 5 points a week per chain, A; stated dual-run days where the card gives them), and never before the card it is
   blocked by has landed plus its own lead. Never needed before the end → not placed (off), with the reason. Re-placed on
   every plan change unless you moved or pinned it. Effect badges: E = external evidence (10-03 survey), D = derived, A = assumed. */
const PT_JIT = [
  {id:'j-5599', grp:'mq', sh:'batching', cards:'#5599 (+ enablers #5600, #5803)', name:'Merge-queue batching + bisection (HEADGREEN, batch 3)', lifts:'merge', chain:[['5600', 5], ['5803', 5], ['5599', 5]], status:'open',
    ch:[{k:'plat', f:'mqGroup', set:3, max:true, text:'merge queue: 3 PRs per CI run (HEADGREEN grouping: one full-group test, bisect on failure)'}], badge:'E', eff:'batch 2–4 to start, growing on success (Zuul); GitHub MQ groups 30+ cut wait 33%; Shopify v2 batch 8; optimal batch ~6 at our 16% failure rate (Ericsson)'},
  {id:'j-batch6', grp:'mq', sh:'batch 6', cards:'#5599 (window grows)', name:'Merge-queue batch grows to 6 on success', lifts:'merge', after:'j-5599', chain:[['5599', 3]], status:'open',
    ch:[{k:'plat', f:'mqGroup', set:6, max:true, text:'merge queue: 6 PRs per CI run (window grows on success, halves on failure)'}], badge:'E', eff:'Zuul window grows on success; ~6–8 at our failure rate (Ericsson, Shopify)'},
  {id:'j-5742', grp:'mq', sh:'tiered CI', cards:'#5742', name:'Tiered CI: affected tests on PRs, full suite only in the merge queue', lifts:'ci', chain:[['5742', 5]], status:'open',
    ch:[{k:'stg', id:'ci', fs:['wall', 'wallTuned'], mul:0.5, text:'PR-scoped CI × 0.5'}], badge:'E', eff:'predictive selection ~½ the test cost (Meta); PR CI was 36 min wall, ~10 min testing (#5027)'},
  {id:'j-7800', grp:'mq', sh:'test selection', liftsAll:['merge', 'pool:heavy-mac'], cards:'#7800 (+ #5733 correctness)', name:'Test-impact selection on the full suite', lifts:'merge', chain:[['5733', 3], ['7800', 5]], status:'open',
    ch:[{k:'plat', f:'fullScale', mul:0.5, def:1, text:'full suite × 0.5'}], badge:'E', eff:'Meta predictive test selection: >99.9% of faulty changes caught at ~½ the test cost'},
  {id:'j-4999', grp:'mq', sh:'flake quarantine', cards:'#4999', name:'Flake score + quarantine', lifts:'merge', chain:[['4999', 8]], status:'open',
    ch:[{k:'plat', f:'mqFail', mul:0.6, text:'ejections × 0.6'}, {k:'plat', f:'redMain', mul:0.6, text:'red main × 0.6'}], badge:'E', eff:'Google: ~40% of breakages are flakes; prior art 20% → 96% main stability'},
  {id:'j-3348', grp:'mq', sh:'sharding', liftsAll:['merge', 'pool:heavy-mac'], cards:'#3348 (+ #7544, #7817)', name:'Rebalance long-pole shards', lifts:'merge', chain:[['3348', 3]], status:'open',
    ch:[{k:'plat', f:'fullScale', mul:0.8, def:1, text:'full suite × 0.8'}], badge:'D', eff:'critical path ~6.2 min, shard 4 = 3.2× shard 2; the Nov sharding change cut the suite 25%'},
  {id:'j-6534', grp:'mq', sh:'card-group CI', cards:'#6534', name:'Lighter merge-queue CI for card-only groups', lifts:'merge', chain:[['6534', 3]], status:'open',
    ch:[{k:'stg', id:'cifull', f:'cardShare', mul:0.3, text:'card PRs: 30% of the full-suite CI'}], badge:'A', eff:'cards capped ~2/h by 20–30 min full MQ CI (no effect size)'},
  {id:'j-7171', grp:'mq', sh:'red-main pause', cards:'#7171 (2 pts)', name:'Pause the merge queue while main is red', lifts:'merge', chain:[['7171', 2]], status:'open',
    ch:[{k:'plat', f:'redMain', mul:0.7, text:'red-main time × 0.7'}], badge:'A', eff:'no number on the card: fewer queue runs wasted while main is red'},
  {id:'j-5484', grp:'mq', sh:'Plateau split', liftsAll:['merge', 'pool:heavy-mac', 'scope'], cards:'#5484 (constellation split #5488)', name:'Repo split: Plateau-bound code → plateau-app', lifts:'merge', chain:[['5484', 5]], status:'open',
    ch:[{k:'plat', f:'fullScale', mul:0.85, def:1, text:'WE suite × 0.85 (that code tests in plateau-app)'}, {k:'plat', f:'qMul', mul:0.745, def:1, text:'scope overlap × 0.745 (~15% of PRs land in another repo: 0.85² + 0.15²)'}], badge:'A', eff:'shrinks the WE suite (card gives no number); PRs in another repo never overlap WE scopes'},
  {id:'j-5497', grp:'mq', sh:'Longshore split', liftsAll:['merge', 'pool:heavy-mac', 'scope'], cards:'#5497 (chain #5493 → #5494 → #5495 → #5497; epic #5488)', name:'Repo split: Longshore flip (own check + merge queue)', lifts:'merge', chain:[['5493', 5], ['5494', 5, 12], ['5495', 5, 6], ['5497', 5]], status:'open',
    ch:[{k:'split', share:0.3, text:'Longshore: ~30% of the suite and its PRs leave WE CI for their own merge queue; daemons poll one more repo; scope overlap × 0.58'}], badge:'A', eff:'the main CI-length milestone; card gives no number (30% assumed)'},
  {id:'j-5490', grp:'mq', sh:'everstandards split', liftsAll:['merge', 'pool:heavy-mac', 'scope'], cards:'#5490 (chain #5482 → #5485 → #5489 rule-pack split → #5490)', name:'Repo split: conformance runner → everstandards', lifts:'merge', chain:[['5482', 3], ['5485', 5], ['5489', 8], ['5490', 5]], status:'open',
    ch:[{k:'split', share:0.15, text:'everstandards: ~15% of the suite and its PRs get their own queue; daemons poll one more repo; scope overlap × 0.745'}], badge:'A', eff:'rule-pack split has identical output, no speed-up by itself; share assumed'},
  {id:'j-groups', grp:'mq', sh:'more builds', cards:'not filed (maxGroupsInFlight > 1)', name:'More merge-queue builds in flight: 8 → 16', lifts:'merge', chain:[['—', 3]], status:'never filed',
    ch:[{k:'plat', f:'mqBuilds', set:16, max:true, text:'merge queue: up to 16 entries built in parallel (live setting 8)'}], badge:'A', eff:'no measured number; GitHub allows up to 100'},
  {id:'j-cache', grp:'mq', sh:'CI caching', liftsAll:['merge', 'pool:heavy-mac'], cards:'not filed (CI caching)', name:'CI caching (deps + build output)', lifts:'merge', chain:[['—', 3]], status:'never filed',
    ch:[{k:'plat', f:'fullScale', mul:0.9, def:1, text:'full suite × 0.9'}, {k:'stg', id:'ci', fs:['wall', 'wallTuned'], mul:0.9, text:'PR CI × 0.9'}], badge:'A', eff:'no measured number'},
  {id:'j-apps', sh:'spread Apps', cards:'not filed (move daemons to separate GitHub Apps)', name:'Spread daemons across GitHub Apps (busiest App 60% → 40% of calls)', lifts:'api', chain:[['—', 1]], status:'never filed',
    ch:[{k:'plat', f:'apiBusiest', mul:0.667, def:0.6, text:'busiest App makes 40% of calls (was 60%)'}], badge:'A', eff:'free: each daemon already has its own App identity to move to; the 40% share is assumed'},
  {id:'j-etag', sh:'ETag requests', cards:'not filed (conditional requests in daemon polling)', name:'ETag conditional requests (unchanged replies do not count)', lifts:'api', chain:[['—', 2]], status:'never filed',
    ch:[{k:'plat', f:'apiPerOpenPr', mul:0.4, def:19, text:'open-PR polling calls × 0.4'}, {k:'plat', f:'apiPerRepo', mul:0.4, def:98, text:'per-repo polling calls × 0.4'}], badge:'A', eff:'a 304 reply does not count against the primary limit; assumes 60% of polls return unchanged'},
  {id:'j-webhooks', sh:'webhooks', cards:'not filed (webhooks / event-driven refresh)', name:'Webhooks instead of polling', lifts:'api', chain:[['—', 8]], status:'never filed',
    ch:[{k:'plat', f:'apiPerOpenPr', mul:0.25, def:19, text:'open-PR polling calls × 0.25'}, {k:'plat', f:'apiPerRepo', mul:0.25, def:98, text:'per-repo polling calls × 0.25'}], badge:'A', eff:'events replace most status polling; keeps a slow poll as a safety net; 75% cut assumed'},
  {id:'j-7743', hw:true, sh:'Longshore runners', cards:'#7743 (held; after the Longshore flip)', name:'Longshore CI runners on a Forge (needs Forge B)', lifts:'ci', after:'j-5497', chain:[['7743', 2]], status:'held',
    ch:[{k:'plat', f:'ciSelfHosted', set:0.3, max:true, text:'30% of CI jobs on the Forges'}], badge:'A', eff:'card gives no number'},
  {id:'j-affected', grp:'tl', sh:'affected tests', cards:'#3774 + #5733 + #4593 (3 + 3 + 5 pts)', name:'Affected-test fallback: no full suite for docs-only or narrow diffs', lifts:'pool:heavy-mac', chain:[['3774', 3], ['5733', 3], ['4593', 5]], status:'open',
    ch:[{k:'stg', id:'heavy', fs:['countToday', 'countTuned'], mul:0.8, text:'local test runs × 0.8'}, {k:'stg', id:'heavy', fs:['wall', 'wallTuned'], mul:0.9, text:'each run × 0.9'}], badge:'A', eff:'docs-only diffs run the full suite today (#3774: 509 files, 14,171 tests, ~320 s); affected builder tests were broad runs (#4593); share of local runs assumed'},
  {id:'j-8256', grp:'tl', sh:'main-sync', cards:'#8256 (3 pts, HIGH)', name:'Daemon main-sync without the full suite', lifts:'pool:heavy-mac', chain:[['8256', 3]], status:'open',
    ch:[{k:'stg', id:'heavy', fs:['countToday', 'countTuned'], mul:0.85, text:'local test runs × 0.85'}], badge:'A', eff:'overlay-main-sync runs the full suite from 3 daemons (#8256, high priority); the share of local runs is not measured'},
  {id:'j-lean', grp:'tl', sh:'leaner verify', cards:'#5740 (3 pts; with #5138)', name:'Leaner rebuild and prototype verification', lifts:'pool:heavy-mac', chain:[['5740', 3]], status:'open',
    ch:[{k:'stg', id:'heavy', fs:['countToday', 'countTuned'], mul:0.92, text:'local test runs × 0.92'}], badge:'A', eff:'skip the local gate when it is not faster (#5740); the share of rebuild and prototype runs is not measured'},
  {id:'j-redrepro', grp:'tl', sh:'red-main repro', cards:'#5138 (5 pts; with #5001)', name:'Red-main reproduction off our machines (CI)', lifts:'pool:heavy-mac', chain:[['5138', 5]], status:'open',
    ch:[{k:'stg', id:'heavy', fs:['countToday', 'countTuned'], mul:0.95, text:'local test runs × 0.95'}], badge:'A', eff:'route heavy runs to CI by strategy (#5138, CI ~45 min vs 7-35 local); the share of red-main repro runs is not measured'}
];
const PT_JIT_LIM = {scope:'scope overlap (parallel scopes; PRs in another repo never overlap)', merge:'merge-queue capacity (full-suite length feeds it)', 'pool:heavy-mac':'protect-the-Mac local test cap (local full-suite runs grow with the suite)', ci:'Actions runners (job-minutes)', api:'GitHub API (daemon polling)'};
const ptJitLead = j => Math.max(1, j.chain.reduce((a, [, pts, days])=>a + Math.max(num(pts)/5, num(days)/7), 0)); /* weeks */
const ptMonday = t => { const d = new Date(t); const k = (d.getDay() + 6) % 7; return t - k*PT_DAY; };
/* v30.3-C.1 (operator 14:05-14:33 ET): levers are placed just in time when they PAY IN VELOCITY (points a day, which includes the queue minutes that hold scopes and the ejection rework),
   and the merge-queue levers also whenever the queue run (the full suite) grows more than 10% in 4 weeks while one is available. Test-load cuts sit in the same walk.
   Strategies come before hardware: the walk never sees Forge C (hardware is placed on the plan that has every strategy), and a "Strategies only" plan drops new hardware. */
const PT_GROW = 0.10, PT_BIG = 20; /* queue run growth that counts as unchecked (per 4 weeks); 4 weeks in plan units (1.4 days each) */
const ptMinPts = base => { const P = base.platform || {}; return P.sugMinPts == null ? 2 : num(P.sugMinPts); };
const ptSuiteOf = r => { const c = r && r.cons ? r.cons.find(z=>z.key === 'merge') : null; return c && c.suiteMin ? c.suiteMin : 0; };
function ptCoreH(s, r){ const hv = s.stages.find(x=>x.id === 'heavy'); if (!hv) return 0; const w = Math.min(100, Math.max(0, num(s.waste)))/100; return num(r.R)*stageCount(hv, w)*stageWall(hv, w)*num(hv.cores)/60; } /* local test core-hours a day (CU/60) */
/* the points a day a lever adds on state s if it had landed (every op applied, no phase) */
function ptPayOf(base, s, r, j){ const s2 = clone(s); let bad = false; for (const op of j.ch) if (ptApply(s2, op) === 'unknown change') bad = true; if (bad) return {dp:0}; const r2 = compute(s2); return {dp:ptPtsOf(base, r2) - ptPtsOf(base, r), r2}; }
/* a milestone that adds hardware (a new machine, CI on a Forge); an ordered, confirmed or placed-away one is not "new" */
const ptNewHw = m => !!m && m.status === 'proposed' && !m.ordered && !!(m.hw || (m.ch || []).some(op=>(op.k === 'host' && op.on) || (op.k === 'place' && op.what !== 'park') || (op.k === 'plat' && op.f === 'ciSelfHosted')));
/* a strategy: a proposed change that is not hardware, a seat, tokens or a model release (software, process, routing) */
const ptIsStrat = m => !!m && m.status === 'proposed' && !m.release && !ptNewHw(m) && (m.ch || []).length > 0 && (m.ch || []).every(op=>['v', 'stg', 'plat', 'split', 'num', 'model'].includes(op.k)) && !m.ordered;
/* the strategies in the plan by a date (before a hardware milestone), names only */
function ptStratsBefore(pl, m){ const t = dayMs(m.date); return pl.milestones.filter((z, i)=>i && z !== m && ptActive(pl, z) && ptIsStrat(z) && z.date && dayMs(z.date) <= t); }
function ptLimCls(c){ if (!c) return 'other'; if (c.key === 'ai-fill' || c.group === 'AI') return 'token'; if (/^(cpu|ram)(:|-|$)/.test(c.key) || /^pool:/.test(c.key)) return 'machine'; if (c.key === 'merge' || c.key === 'ci') return 'mq'; if (c.key === 'scope') return 'scope'; return 'other'; }
function ptJitPlace(base, pl){
  if (pl.jit === false) return false;
  const before = JSON.stringify(pl.milestones.filter(m=>m.jit).map(m=>[m.id, m.date, m.on])) + JSON.stringify(pl.unplaced || []);
  const pins = new Set(pl.milestones.filter(m=>m.jit && m.pinned).map(m=>m.id));
  const keep = pl.milestones.filter(m=>!m.jit || m.pinned), dismissed = new Set((pl.dismissed || []).map(d=>d.id));
  const prev = pl.milestones.filter(m=>m.jit && !m.pinned); /* last round's placements: other groups' cards count while a group is walked */
  pl.milestones = keep; const unplaced = []; pl._jitLog = [];
  const strat = pl.show === 'strategies', minPts = ptMinPts(base);
  const x0 = ptX0(base), XE = ptEnd(pl), step = Math.max(4, (XE - x0)/26), dpx = ptSpan(pl)/PT_DAY/(100 - x0);
  /* one walk along the plan: at the first point any limit a remaining card lifts reaches 85%, or a test-load / merge-queue card pays at least the points bar,
     or the queue run has grown 10% in 4 weeks, the next card (catalogue order, blockedBy respected) is placed there minus its lead; the walk then goes on with it applied. */
  const cards = PT_JIT.filter(j=>!dismissed.has(j.id) && !(strat && j.hw)), liftsOf = j => j.liftsAll || [j.lifts];
  const left = new Set(cards.filter(j=>!pins.has(j.id)).map(j=>j.id)), peaks = {}, bestPay = {}, grewMax = {};
  const trialOf = others => { const t = Object.assign({}, pl, {milestones:pl.milestones.concat(others).filter(m=>!m.fc && (pl._tokIn || !(m.ch || []).some(o=>o.k === 'tokens' || o.k === 'seat')))}); /* v30.3-D.2: the late pass (pl._tokIn) walks on the plan with its settled token moves */ /* v30.3-C.2: levers are placed before token moves (as strategies before hardware), so the 3rd Claude does not move them */ ptSort(t); return t; }; /* hardware (Forge C) is placed after every strategy: never seen here */
  let from = x0, guard = 0; const dead = new Set();
  ptStepJit = true; /* v30.3-C.2: while walking, a placed lever steps in whole at its build start + lead (no ramp, no build charge): the plan's own run phases it in */
  try {
  while (left.size && guard++ < 40){
    const watch = new Set(); for (const j of cards) if (left.has(j.id)) for (const k of liftsOf(j)) if (!dead.has(k)) watch.add(k);
    const el = cards.filter(j=>left.has(j.id) && j.grp && !(j.after && left.has(j.after))), mqNext = el.find(j=>j.grp === 'mq' && j.status === 'open'), payC = el.filter(j=>j.status === 'open' && (j.grp === 'tl' || j === mqNext));
    if (!watch.size && !payC.length) break;
    const others = prev.filter(m=>!pl.milestones.some(z=>z.id === m.id) && !left.has(m.id));
    const trial = trialOf(others);
    let hit = null;
    for (let X = from; X <= XE + 1e-9; X = X >= XE ? XE + 1 : Math.min(XE, X + step)){
      const {s, r} = ptRun(base, trial, X);
      for (const k of watch){ const c = r.cons.find(z=>z.key === k), u = c && c.demand > 0 ? c.util : 0; if (!peaks[k] || u > peaks[k].u) peaks[k] = {u, X}; if (u >= 0.85 - 1e-9 && (!hit || u > hit.u)) hit = {X, key:k, u}; }
      if (!hit){
        for (const j of payC){ const g = ptPayOf(base, s, r, j); if (!bestPay[j.id] || g.dp > bestPay[j.id].dp) bestPay[j.id] = {dp:g.dp, X}; if (g.dp >= minPts - 1e-9){ hit = {X, card:j, key:j.lifts, why:'pays', dp:g.dp}; break; } }
        if (!hit && mqNext && X - x0 >= PT_BIG - 1e-9){ const rb = ptRun(base, trial, X - PT_BIG).r, a = ptSuiteOf(rb), b = ptSuiteOf(r), gr = a > 0 ? b/a - 1 : 0; if (!grewMax[mqNext.id] || gr > grewMax[mqNext.id].g) grewMax[mqNext.id] = {g:gr, X};
          if (gr > PT_GROW){ hit = {X, card:mqNext, key:mqNext.lifts, why:'grew', g:gr, suite:b, was:a}; } }
      }
      if (hit) break;
    }
    if (!hit) break;
    (pl._jitLog = pl._jitLog || []).push([ptDateOfX(pl, x0, hit.X), hit.key, hit.u != null ? Math.round(hit.u*100) : hit.why]);
    const j = hit.card || cards.find(z=>left.has(z.id) && !z.grp && liftsOf(z).includes(hit.key) && (!z.after || !left.has(z.after))) || cards.find(z=>left.has(z.id) && liftsOf(z).includes(hit.key) && (!z.after || !left.has(z.after)));
    if (!j){ dead.add(hit.key); from = hit.X; continue; } /* only blocked cards left for this limit: stop watching it */
    left.delete(j.id);
    const key = hit.key, lead = ptJitLead(j), need = ptMonday(dayMs(ptDateOfX(pl, x0, hit.X)));
    const trig = hit.why === 'pays' ? `it adds ${fmtN(hit.dp, 1)} points a day from the week of ${fmtDay(isoDay(need))} (the bar is ${fmtN(minPts, 0)}; queue minutes hold scopes, ejection rework costs tokens)` : hit.why === 'grew' ? `the queue run grew ${fmtN(hit.g*100, 0)}% in 4 weeks (${fmtN(hit.was, 0)} → ${fmtN(hit.suite, 0)} min) the week of ${fmtDay(isoDay(need))}, and this card is open` : `${PT_JIT_LIM[key] || key} reaches 85% (the just-in-time trigger, before this card lifts it) the week of ${fmtDay(isoDay(need))}`;
    let t = need - Math.round(lead*7)*PT_DAY, why = `just in time: ${trig}; lead ${fmtN(lead, 1)} wk (A: ${j.chain.map(c=>c[0] + ' ' + c[1] + ' pts' + (c[2] ? ', ~' + c[2] + ' d' : '')).join(' → ')})`;
    const blk = j.after && pl.milestones.find(z=>z.id === j.after);
    /* v30.3-C.2: the date is the BUILD START; the effect begins one lead later. A blocked card starts when its blocker has landed (blocker start + its own lead). */
    if (blk && blk.date){ const land = dayMs(blk.date) + Math.round(num(blk.lead)*7)*PT_DAY; if (t < land){ t = land; why += `; build starts after ${blk.name} lands (blocked by)`; } }
    if (t < dayMs(pl.start) + PT_DAY){ t = dayMs(pl.start) + PT_DAY; why += `; already late: build starts now and it takes effect after its ${fmtN(lead, 1)}-week lead`; }
    t = Math.min(t, dayMs(ptUntil(pl)));
    why += `; the date is the build start, the effect begins ${fmtDay(isoDay(t + Math.round(lead*7)*PT_DAY))} (then ramps in over a week)`;
    const m = {id:j.id, name:j.name, date:isoDay(t), ch:clone(j.ch), status:'proposed', on:true, jit:true, buildPts:j.chain.reduce((a, c)=>a + num(c[1]), 0), cards:j.cards, lifts:key, lead, badge:j.badge, cardStatus:j.status, grp:j.grp || '', hw:!!j.hw,
      suggested:why, note:`${j.badge === 'E' ? 'E (external evidence)' : j.badge === 'D' ? 'D (derived)' : 'A (assumed)'}: ${j.eff}. Card ${j.cards}, status ${j.status}.`};
    pl.milestones.push(m); ptSort(pl);
    from = Math.max(x0, Math.min(hit.X, ptXOfDate(pl, x0, m.date)));
  }
  } finally { ptStepJit = false; }
  /* peaks of what is left, on the final plan (all placements applied) */
  if (cards.some(j=>left.has(j.id))){ for (const k of Object.keys(peaks)) delete peaks[k]; const fin = trialOf([]);
    const keys = new Set(); for (const j of cards) if (left.has(j.id)) for (const k of liftsOf(j)) keys.add(k);
    for (let X = x0; X <= XE + 1e-9; X = X >= XE ? XE + 1 : Math.min(XE, X + step*2)){ const {s, r} = ptRun(base, fin, X); for (const k of keys){ const c = r.cons.find(z=>z.key === k), u = c && c.demand > 0 ? c.util : 0; if (!peaks[k] || u > peaks[k].u) peaks[k] = {u, X}; }
      for (const j of cards) if (left.has(j.id) && j.grp && j.status === 'open' && !(j.after && left.has(j.after))){ const g = ptPayOf(base, s, r, j); if (!bestPay[j.id] || g.dp > bestPay[j.id].dp) bestPay[j.id] = {dp:g.dp, X}; } } }
  for (const j of cards) if (left.has(j.id)){
    if (j.grp && (bestPay[j.id] || grewMax[j.id] || j.status !== 'open')){ const bp = bestPay[j.id], gm = grewMax[j.id];
      unplaced.push({id:j.id, name:j.name, cards:j.cards, why:j.status !== 'open' ? `not placed: the card is ${j.status}; it would be placed when it pays ${fmtN(minPts, 0)} points a day` : `not placed: at best it adds ${fmtN(bp ? Math.max(0, bp.dp) : 0, 1)} points a day (${bp ? fmtDay(ptDateOfX(pl, x0, bp.X)) : 'never'}), under the ${fmtN(minPts, 0)}-point bar${j.grp === 'mq' ? `, and the queue run never grew 10% in 4 weeks (most ${fmtN(gm ? Math.max(0, gm.g)*100 : 0, 0)}%) while it was the next card` : ''}`}); continue; }
    const pk = liftsOf(j).map(k=>[k, peaks[k]]).filter(z=>z[1]).sort((a, b)=>b[1].u - a[1].u)[0];
    unplaced.push({id:j.id, name:j.name, cards:j.cards, why:(pk && pk[1].u >= 0.85 ? `not placed: ${PT_JIT_LIM[pk[0]] || pk[0]} reaches ${Math.round(pk[1].u*100)}% (${fmtDay(ptDateOfX(pl, x0, pk[1].X))}), but another limit binds first there, so it would add nothing yet` : `not needed before ${fmtDay(ptUntil(pl))}: `) + (pk && pk[1].u >= 0.85 ? '' : pk ? `${PT_JIT_LIM[pk[0]] || pk[0]} peaks at ${Math.round(pk[1].u*100)}% (${fmtDay(ptDateOfX(pl, x0, pk[1].X))}, on the final plan with the cards placed before it, so under the 85% trigger)` : 'the limit it lifts is not in use') + (pk && pk[1].u >= 0.85 ? '' : '; it would be placed when that reaches 85%')}); }
  /* product value, not capacity (operator 19:43 ET): not placed for capacity */
  if (!dismissed.has('j-newprov')) unplaced.push({id:'j-newprov', name:'New provider (Grok, …): multi-provider support', cards:'tag: product value', why:'not placed for capacity: tied to Plateau\'s public launch (no date yet); adds product value (Plateau multi-provider support), not a priority for early 2027'});
  pl.unplaced = unplaced; ptSort(pl);
  /* what each placed lever pays, with and without it, at the day it has landed: points a day, queue minutes, ejection rework, local test core-hours */
  for (const m of pl.milestones) if (m.jit && !m.pinned && m.grp && ptActive(pl, m)){ const e = ptLevEffect(base, pl, m); m.pay = {date:e.date, dp:e.dp, dMq:e.dMq, dEj:e.dEj, dH:e.dH, coreH:e.coreH}; }
  return before !== JSON.stringify(pl.milestones.filter(m=>m.jit).map(m=>[m.id, m.date, m.on])) + JSON.stringify(pl.unplaced || []);
}
/* a lever's effect at the day it has landed: the plan with it against the plan without it (and the milestones linked after it) */
function ptLevEffect(base, pl, m){
  const x0 = ptX0(base), d = ptMsEffDate(base, pl, m), X = ptXOfDate(pl, x0, d), wo = Object.assign({}, pl, {milestones:pl.milestones.filter(z=>z !== m && z.after !== m.id)}); ptSort(wo);
  const a = ptRun(base, pl, X), b = ptRun(base, wo, X), Ta = a.r.hold && a.r.hold.T || {}, Tb = b.r.hold && b.r.hold.T || {};
  return {date:d, dp:ptPtsOf(base, a.r) - ptPtsOf(base, b.r), dH:(b.r.hold && a.r.hold ? b.r.hold.H - a.r.hold.H : 0), dMq:num(Tb.mq) + num(Tb.wMq) - num(Ta.mq) - num(Ta.wMq), dEj:num(Tb.eject) - num(Ta.eject), coreH:ptCoreH(b.s, b.r) - ptCoreH(a.s, a.r)};
}
/* the first day the Studio's CPU or RAM binds on the plan without Forge B (weekly scan, then daily inside the first week): the day Forge B is needed */
const ptNeedC = new Map();
function ptForgeBNeed(base, pl){
  const key = JSON.stringify(base).length + ':' + ptCumSig(pl) + '|fbn'; if (ptNeedC.has(key)) return ptNeedC.get(key);
  const tr = clone(pl); delete tr.base; delete tr.at; tr.milestones = tr.milestones.filter(m=>m.id !== 'm-msa2' && m.id !== 'm-msa2-place' && !m.fc); ptSort(tr); tr._ownCum = true;
  const x0 = ptX0(base), t0 = dayMs(tr.start) + PT_DAY, t1 = dayMs(ptUntil(tr));
  const bound = t => { const r = ptRun(base, tr, ptXOfDate(tr, x0, isoDay(t))).r, bs = [r.binding, ...(r.tied || [])].filter(Boolean); return bs.some(c=>/^(cpu|ram):studio$/.test(c.key)); };
  let out = null, prevT = t0 - 7*PT_DAY;
  for (let t = t0; t <= t1 + 1; t += 7*PT_DAY){ if (bound(t)){ out = isoDay(t); for (let u = Math.max(t0, prevT + PT_DAY); u < t; u += PT_DAY) if (bound(u)){ out = isoDay(u); break; } break; } prevT = t; }
  if (ptNeedC.size > 40) ptNeedC.clear(); ptNeedC.set(key, out); return out;
}
/* a test-load lever's shift of the day Forge B is needed (A until the heavy-run records give each share) */
const ptShiftC = new Map();
function ptLevShift(base, pl, m){
  const key = JSON.stringify(base).length + ':' + ptCumSig(pl) + '|' + m.id; if (ptShiftC.has(key)) return ptShiftC.get(key);
  const wo = ptTrialOf(pl); delete wo.base; delete wo.at; wo.milestones = wo.milestones.filter(z=>z.id !== m.id); ptSort(wo);
  const a = ptForgeBNeed(base, pl), b = ptForgeBNeed(base, wo), end = ptUntil(pl);
  const out = {with:a, without:b, days:Math.round((dayMs(a || end) - dayMs(b || end))/PT_DAY), beyond:!a};
  if (ptShiftC.size > 60) ptShiftC.clear(); ptShiftC.set(key, out); return out;
}
/* v30.3-C.1: Forge C (a 2nd MS-A2, 64 GB). Hardware comes after strategies: it is placed only when Forge B's CPU binds on the plan that already has every strategy,
   and only if no unplaced strategy still pays there. Forge B and Forge C share the overflow the Studio and Laptop cannot admit (both are test boxes in one pool). */
function ptSeedForgeC(base, pl){
  const hc = (base.hosts || []).find(h=>h.id === 'msa2c'); if (!hc || hc.on) return;
  if (pl.milestones.some(m=>m.id === 'm-msa2c') || (pl.dismissed || []).some(z=>z.id === 'm-msa2c')) return;
  pl.milestones.push({id:'m-msa2c', name:'Buy Forge C (2nd MS-A2, 64 GB)', date:'', ch:[{k:'host', id:'msa2c', on:true}], status:'proposed', on:false, seed:true, fc:true, hw:true, note:'A: placed only when Forge B CPU binds and no strategy lifts it (operator 14:22 ET); takes overflow with Forge B; order about 2 weeks ahead.'});
  ptSort(pl);
}
/* strategies that would still pay on state s (a proposed lever not yet in the plan, or in it later than the date) */
function ptStratPaying(base, pl, X, s, r, cls){
  const minPts = ptMinPts(base), out = [];
  for (const j of PT_JIT){ if (j.hw || !j.grp || j.status !== 'open') continue; if (cls === 'machine' && j.grp !== 'tl') continue; if (cls === 'mq' && j.grp !== 'mq') continue;
    const m = pl.milestones.find(z=>z.id === j.id); if (m && ptActive(pl, m) && m.date && ptXOfDate(pl, 0, m.date) <= X + 1e-9) continue; /* already landed (or about to) */
    if ((pl.dismissed || []).some(z=>z.id === j.id)) continue;
    const g = ptPayOf(base, s, r, j); if (g.dp >= minPts - 1e-9) out.push({id:j.id, name:j.name, dp:g.dp}); }
  return out;
}
function ptPlaceForgeC(base, pl){
  const a = pl.milestones.find(m=>m.id === 'm-msa2c' && m.fc); if (!a || a.pinned || a.status !== 'proposed') return false;
  const sig = JSON.stringify([a.date, a.on, a.suggested, a.autoOff]), end = isoDay(dayMs(ptUntil(pl)));
  const off = why => { a.date = end; a.on = false; a.autoOff = true; a.suggested = why; return sig !== JSON.stringify([a.date, a.on, a.suggested, a.autoOff]); };
  if (pl.show === 'strategies') return off('not placed in "Strategies only": no new hardware');
  const fb = pl.milestones.find(m=>m.id === 'm-msa2'), fp = pl.milestones.find(m=>m.id === 'm-msa2-place');
  if (!fb || !fb.date || !ptActive(pl, fb)) return off('not placed: Forge B is not in this plan, so there is no Forge B CPU to run out first');
  if (!ptActive(pl, a) && a.on === false && a.autoOff !== true && a.suggested === undefined){ /* first look: fall through to the placement */ }
  const tr = clone(pl); delete tr.base; delete tr.at; tr.milestones = tr.milestones.filter(m=>m.id !== 'm-msa2c' && !m.fc); ptSort(tr); tr._ownCum = true;
  const x0 = ptX0(base), XE = ptEnd(pl), tStart = Math.max(dayMs(pl.start) + PT_DAY, dayMs((fp && fp.date) || fb.date) + PT_DAY), t1 = dayMs(ptUntil(pl));
  const boundAt = t => { const X = ptXOfDate(tr, x0, isoDay(t)), {s, r} = ptRun(base, tr, X), bs = [r.binding, ...(r.tied || [])].filter(Boolean); return bs.some(c=>c.key === 'cpu-t') ? {X, s, r} : null; };
  let hit = null, prevT = tStart - 7*PT_DAY, peak = {u:0, t:tStart};
  for (let t = tStart; t <= t1 + 1; t += 7*PT_DAY){ const {s, r} = ptRun(base, tr, ptXOfDate(tr, x0, isoDay(t))); const c = r.cons.find(z=>z.key === 'cpu-t'), u = c && c.demand > 0 ? c.util : 0; if (u > peak.u) peak = {u, t};
    const h = boundAt(t); if (h){ hit = {t, h}; for (let u2 = Math.max(tStart, prevT + PT_DAY); u2 < t; u2 += PT_DAY){ const h2 = boundAt(u2); if (h2){ hit = {t:u2, h:h2}; break; } } break; } prevT = t; }
  if (!hit) return off(`not needed before ${fmtDay(end)}: Forge B's CPU never binds (closest ${fmtDay(isoDay(peak.t))}, ${fmtN(peak.u*100, 0)}% of its target); switched off`);
  const pay = ptStratPaying(base, tr, hit.h.X, hit.h.s, hit.h.r, 'machine');
  if (pay.length) return off(`not placed: Forge B's CPU binds on ${fmtDay(isoDay(hit.t))}, but ${pay[0].name} still adds ${fmtN(pay[0].dp, 1)} points a day there, so it comes first (strategies before hardware)`);
  const dt = Math.max(tStart, hit.t - 14*PT_DAY);
  a.date = isoDay(dt); a.on = true; delete a.autoOff;
  a.suggested = `just in time: from ${fmtDay(isoDay(hit.t))} Forge B's CPU is the limit and no strategy lifts it (${ptStratsBefore(pl, {date:isoDay(hit.t)}).length} strategies are applied by then); two weeks' lead (A); Forge B and Forge C share the overflow`;
  return sig !== JSON.stringify([a.date, a.on, a.suggested, a.autoOff]);
}
/* ----- the plan reacts to a decline: more than 5% velocity lost over 4 weeks under a named limit places the next lever for it (strategies, then hardware, then tokens) ----- */
function ptDeclineScan(base, pl){
  const x0 = ptX0(base), t0 = dayMs(pl.start) + PT_DAY, t1 = dayMs(ptUntil(pl)), rows = [];
  for (let t = t0; t <= t1 + 1; t += 7*PT_DAY){ const iso = isoDay(t), {s, r} = ptRun(base, pl, ptXOfDate(pl, x0, iso)); rows.push({t, iso, pts:ptPtsOf(base, r), s, r, X:ptXOfDate(pl, x0, iso)}); }
  const ev = []; let lastK = -9;
  for (let k = 4; k < rows.length; k++){ const a = rows[k - 4], b = rows[k], d = b.pts/Math.max(1e-9, a.pts) - 1; if (!(d < -0.05)) continue;
    if (ev.length && k - lastK <= 1){ const e = ev[ev.length - 1]; e.end = b.iso; e.worst = Math.min(e.worst, d); } else ev.push({start:a.iso, date:b.iso, end:b.iso, drop:d, worst:d, k, key:b.r.binding ? b.r.binding.key : '', name:limitName(b.r.binding), cls:ptLimCls(b.r.binding), tied:(b.r.tied || []).map(c=>c.key), X:b.X}); lastK = k; }
  return {rows, ev};
}
function ptReactPick(base, pl, e, sc){
  const x0 = ptX0(base), row = sc.rows[e.k], minGain = 0.5, strat = pl.show === 'strategies', dismissed = new Set((pl.dismissed || []).map(d=>d.id));
  const startT = dayMs(e.start), place = (j, why) => { const lead = ptJitLead(j); let t = startT - Math.round(lead*7)*PT_DAY, w = why; const blk = j.after && pl.milestones.find(z=>z.id === j.after);
    if (blk && blk.date){ const land = dayMs(blk.date) + Math.round(num(blk.lead)*7)*PT_DAY; if (t < land){ t = land; w += `; build starts after ${blk.name} lands`; } }
    if (t < dayMs(pl.start) + PT_DAY){ t = dayMs(pl.start) + PT_DAY; w += '; already late: build starts now, it takes effect after its lead'; }
    const m = {id:j.id, name:j.name, date:isoDay(Math.min(t, dayMs(ptUntil(pl)))), ch:clone(j.ch), status:'proposed', on:true, jit:true, react:true, buildPts:j.chain.reduce((a, c)=>a + num(c[1]), 0), cards:j.cards, lifts:j.lifts, lead, badge:j.badge, cardStatus:j.status, grp:j.grp || '', hw:!!j.hw,
      suggested:`reacts to a decline: ${w}; lead ${fmtN(lead, 1)} wk (A)`, note:`${j.badge === 'E' ? 'E (external evidence)' : j.badge === 'D' ? 'D (derived)' : 'A (assumed)'}: ${j.eff}. Card ${j.cards}, status ${j.status}.`};
    pl.milestones.push(m); ptSort(pl); return {kind:'strategy', id:j.id, name:j.name, date:m.date}; };
  const pct = fmtN(-e.drop*100, 1);
  if (e.cls === 'machine' || e.cls === 'mq' || e.cls === 'scope'){
    for (const j of PT_JIT){ if (j.hw || dismissed.has(j.id) || pl.milestones.some(z=>z.id === j.id)) continue; if (j.status !== 'open' && j.status !== 'never filed') continue;
      const cls = j.grp === 'tl' ? 'machine' : (j.liftsAll || [j.lifts]).includes('scope') && e.cls === 'scope' ? 'scope' : j.grp === 'mq' ? 'mq' : '';
      if (cls !== e.cls || j.status !== 'open') continue;
      const g = ptPayOf(base, row.s, row.r, j); if (g.dp >= minGain) return place(j, `velocity fell ${pct}% in 4 weeks under ${e.name}; it adds ${fmtN(g.dp, 1)} points a day there`); }
  }
  if (e.cls === 'machine' && !strat){ /* hardware: Forge C, only when Forge B's CPU binds and no strategy lifts it */
    const a = pl.milestones.find(m=>m.id === 'm-msa2c' && m.fc), fb = pl.milestones.find(m=>m.id === 'm-msa2'), bs = [row.r.binding, ...(row.r.tied || [])].filter(Boolean);
    if (a && !a.pinned && fb && ptActive(pl, fb) && !ptActive(pl, a) && bs.some(c=>c.key === 'cpu-t')){ a.on = true; delete a.autoOff; a.date = isoDay(Math.max(dayMs(pl.start) + PT_DAY, startT - 14*PT_DAY));
      a.suggested = `reacts to a decline: velocity fell ${pct}% in 4 weeks under ${e.name}; Forge B's CPU binds and no strategy lifts it; two weeks' lead (A)`; ptSort(pl); return {kind:'hardware', id:a.id, name:a.name, date:a.date}; } }
  if (e.cls === 'token'){ /* tokens: the 3rd Claude first, then the next best (the 2nd Codex comes after the 3rd Claude) */
    for (const id of ['m-claude3', 'm-tokens']){ const m = pl.milestones.find(z=>z.id === id); if (!m || m.pinned || ptActive(pl, m) || (m.status !== 'proposed') || (m.on === false && !m.autoOff)) continue; /* v30.3-C.2: a token move you switched off stays off */ if (id === 'm-tokens'){ const c3 = pl.milestones.find(z=>z.id === 'm-claude3'); if (c3 && !ptActive(pl, c3)) continue; }
      const t = ptTrialOf(pl); delete t.base; delete t.at; const mm = t.milestones.find(z=>z.id === id); mm.on = true; mm.date = isoDay(Math.max(dayMs(pl.start) + PT_DAY, startT - 7*PT_DAY)); ptSort(t);
      const g = ptRun(base, t, e.X).r, g0 = row.r; if (ptPtsOf(base, g) - ptPtsOf(base, g0) < minGain) continue;
      m.on = true; delete m.autoOff; m.date = mm.date; m.suggested = `reacts to a decline: velocity fell ${pct}% in 4 weeks under ${e.name}; next in the order strategies, hardware, tokens`; ptSort(pl); return {kind:'tokens', id, name:m.name, date:m.date}; } }
  return null;
}
/* one pass: scan, react to the first decline not yet handled, rescan; what no lever can lift is flagged for a decision. The flags are the plan's own record (pl.declines). */
function ptReact(base, pl){
  const before = JSON.stringify([pl.declines || [], pl.milestones.filter(m=>m.react).map(m=>[m.id, m.date])]);
  pl.milestones = pl.milestones.filter(m=>!m.react); pl.declines = [];
  if (pl.jit === false || pl.show === 'confirmed') return before !== JSON.stringify([[], []]);
  const acts = [], flags = [];
  for (let it = 0; it < 14; it++){
    const sc = ptDeclineScan(base, pl), e = sc.ev.find(z=>!flags.some(f=>Math.abs(dayMs(f.date) - dayMs(z.date)) <= 28*PT_DAY)); if (!e) break;
    const a = ptReactPick(base, pl, e, sc);
    if (a){ acts.push({date:e.date, start:e.start, drop:e.drop, limit:e.name, cls:e.cls, action:a}); continue; }
    flags.push({date:e.date, start:e.start, end:e.end, drop:e.drop, limit:e.name, cls:e.cls, flag:true, text:`No lever left for ${e.name} — needs a decision`});
  }
  pl.declines = acts.concat(flags).sort((p, q)=>dayMs(p.date) - dayMs(q.date));
  return before !== JSON.stringify([pl.declines, pl.milestones.filter(m=>m.react).map(m=>[m.id, m.date])]);
}
/* v30.3-D.2: does an open strategy that is not in the plan (or not yet landed) still pay the points bar on the settled plan, weekly along it? */
function ptLateStrat(base, pl){
  const x0 = ptX0(base), t1 = dayMs(ptUntil(pl)), un = new Set((pl.unplaced || []).filter(u=>u.id).map(u=>u.id));
  if (!PT_JIT.some(j=>!j.hw && j.grp && j.status === 'open' && un.has(j.id) && !(pl.dismissed || []).some(z=>z.id === j.id))) return false;
  for (let t = dayMs(pl.start) + PT_DAY; t <= t1 + 1; t += 7*PT_DAY){ const X = ptXOfDate(pl, x0, isoDay(t)), {s, r} = ptRun(base, pl, X); if (ptStratPaying(base, pl, X, s, r).some(p=>un.has(p.id))) return true; }
  return false;
}
/* everything the plan settles after a change (just-in-time cards, Forge B and C, tokens, the reaction to a decline); the one place renderPlan and the Strategies-only run both use */
function ptSettle(base, pl, P){
  P = P || {}; const t0 = performance.now();
  if (pl.jit !== false) pl.milestones = pl.milestones.filter(m=>!m.jit || m.pinned);
  ptCumBuild(base, pl); P.cum = performance.now() - t0; let it = 0; for (; it < 3 && (ptJitPlace(base, pl) | ptPlaceForgeB(base, pl) | ptPlaceForgeC(base, pl)); it++) ptCumBuild(base, pl); /* JIT dates and the suite growth they cause settle together (≤3 rounds) */
  P.jit = performance.now() - t0 - P.cum; P.rounds = it; const t1 = performance.now(); for (let k = 0; k < 3 && (ptRecheck(base, pl) | ptSettleTokens(base, pl)); k++){ ptResolveTokens(base, pl); ptCumBuild(base, pl); }
  /* v30.3-D.2: placement to a fixed point. The first walk judges the strategies before the token moves exist (levers before tokens), so a strategy that pays only once the AI limit is lifted
     stays unplaced and hardware (Forge C) lands where it would pay. While an unplaced strategy pays on the settled plan, walk again on that plan (token moves kept in the trial), then settle hardware and tokens again.
     Capped at 4 late passes; the result no longer depends on the start day. */
  if (pl.jit !== false){ try { for (let pass = 0; pass < 4 && ptLateStrat(base, pl); pass++){
    pl._tokIn = true; let it2 = 0; for (; it2 < 3 && (ptJitPlace(base, pl) | ptPlaceForgeB(base, pl) | ptPlaceForgeC(base, pl)); it2++) ptCumBuild(base, pl); ptCumBuild(base, pl);
    for (let k = 0; k < 3 && (ptRecheck(base, pl) | ptSettleTokens(base, pl)); k++){ ptResolveTokens(base, pl); ptCumBuild(base, pl); } P.late = (P.late || 0) + 1; }
  } finally { delete pl._tokIn; } P.recheck = performance.now() - t1; }
  const t2 = performance.now(); if (ptReact(base, pl)){ ptCumBuild(base, pl); } P.react = performance.now() - t2;
}
/* "Strategies only": the same plan with no new hardware, settled on its own; where it runs out and what limit stops it */
const ptStratC = new Map();
function ptStratOnly(base, pl){
  const key = JSON.stringify(base).length + ':' + JSON.stringify([pl.milestones.filter(m=>!m.jit && !m.react).map(m=>[m.id, m.date, m.on, m.status, m.ch]), pl.start, pl.until, pl.halfLife, pl.grow, pl.dismissed]); if (ptStratC.has(key)) return ptStratC.get(key);
  const cxS = ptCx(pl), keepT = cxS.cum;
  let out = null;
  try { const t = ptTrialOf(pl); delete t.base; delete t.at; delete t.ww; t.show = 'strategies'; t._ownCum = false; ptSettle(base, t);
    const x0 = ptX0(base), XE = ptEnd(t); let pk = {v:0, X:x0}, last = null;
    for (let X = x0; X <= XE + 1e-9; X = X >= XE ? XE + 1 : Math.min(XE, X + 4)){ const v = ptPtsOf(base, ptRun(base, t, X).r); if (v > pk.v) pk = {v, X}; last = v; }
    const fl = (t.declines || []).find(d=>d.flag);
    out = {peak:pk.v, peakDate:ptDateOfX(t, x0, pk.X), end:last, endDate:ptUntil(t), date:fl ? fl.date : null, limit:fl ? fl.limit : '', drop:fl ? fl.drop : 0, text:fl ? `Strategies only: ${fmtN(pk.v, 0)} points a day at best (${fmtDay(ptDateOfX(t, x0, pk.X))}); runs out ${fmtDay(fl.date)} at ${fl.limit}` : `Strategies only: ${fmtN(pk.v, 0)} points a day at best (${fmtDay(ptDateOfX(t, x0, pk.X))}); does not run out before ${fmtDay(ptUntil(t))}`, plan:t}; }
  finally { cxS.cum = keepT; }
  if (ptStratC.size > 6) ptStratC.clear(); ptStratC.set(key, out); return out;
}
/* test hook: hardware milestones placed while a strategy on the same limit still pays at that date */
function ptHwViolations(base, pl){
  const out = [], x0 = ptX0(base);
  for (const m of pl.milestones) if (m.date && ptActive(pl, m) && (ptNewHw(m) || m.fc) && ptNewHw(m)){
    const X = ptXOfDate(pl, x0, m.date), tr = Object.assign({}, pl, {milestones:pl.milestones.filter(z=>z !== m && !z.fc)}); ptSort(tr); const {s, r} = ptRun(base, tr, X);
    const cls = m.fc || (m.ch || []).some(op=>op.k === 'host') ? 'machine' : 'mq';
    for (const p of ptStratPaying(base, tr, X, s, r, cls)) out.push({hw:m.id, date:m.date, strategy:p.id, dp:p.dp}); }
  return out;
}
/* v30: engine-suggested proposals are re-checked on the final plan (after the just-in-time placements and the suite growth
   they cause): one that no longer adds 1 PR a day (or plan for, for machines) where it sits is switched off and says why */
/* v30.2-B.5: the 3rd Claude is dated to the day tokens bind on the settled plan (just in time, never earlier). Its note carries the basis of the cap. */
function ptTokenBasis(base){ const pv = id => (base.providers || []).find(p=>p.id === id) || {}, c = pv('claude'), x = pv('codex'), g = pv('google'), per = id => { const a = pv(id); return a.usedWeek != null && num(a.weeklyCap) > 0 ? Math.round(num(a.usedWeek)/num(a.weeklyCap)*100) : null; };
  return `Cap and use basis. Claude: measured ${fmtUsd(num(c.weeklyCap))} a week per account (M; account B ran out at $2,710), 83% used in Nov 7–13 at 45 merged a day (M). Google: ${num(g.weeklyCap)} units a week is an A-badged guess (no measured cap) and Google takes mid and light stages only. Codex: ${num(x.weeklyCap)} units a week (M); the units per 1% move between 1,500 and 2,500 with the cache mix, so the cap is a range. Banked resets: ${num(x.resetsBanked)} Codex resets with an unknown expiry (A: assumed gone by day ${num((base.platform || {}).bankDays)}, expected value fading over the two weeks around it). Price of the seat is the assumed plan price (A).`; }
function ptSettleTokens(base, pl){
  const c3 = pl.milestones.find(m=>m.id === 'm-claude3'); if (!c3) return false;
  c3.note = ptTokenBasis(base);
  let ch = false;
  if (!(c3.pinned || c3.status !== 'proposed' || !/^suggested: /.test(c3.suggested || '') || c3.on === false)){
    const tb = ptTokenBind(base, pl); if (tb && tb.date !== c3.date){ c3.date = tb.date; c3.suggested = `suggested: ${fmtDay(tb.date)}, the day AI tokens start to bind (${tb.why}); not earlier`; ptSort(pl); ch = true; }
    /* v30.3-C.2: on the plan as built (levers placed, 3rd Claude in), never before the first day a plan is full or AI binds */
  }
  if (ptPlaceTokens(base, pl)) ch = true;
  return ch;
}
/* v30.3-C.2 (review C.1 item 1): "Add tokens" is placed just in time on the SETTLED plan: once the 3rd Claude is in and tokens still bind, in the first week the best option adds the points bar
   within the dollars-per-point bar. It used to be dated before the levers were placed (tokens did not bind yet, so it was switched off) and never looked again. */
function ptFirstFull(base, pl){
  const x0 = ptX0(base), t0 = dayMs(pl.start), t1 = dayMs(ptUntil(pl));
  const full = t => { const {r} = ptRun(base, pl, ptXOfDate(pl, x0, isoDay(t))); return /AI tokens/.test(limitName(r.binding)) || (r.cons || []).some(c=>c.group === 'AI' && c.util >= 0.995); };
  let prev = t0 - 7*PT_DAY;
  for (let t = t0; t <= t1 + 1; t += 7*PT_DAY){ if (full(t)){ for (let u = Math.max(t0, prev + PT_DAY); u <= t; u += PT_DAY) if (full(u)) return isoDay(u); return isoDay(t); } prev = t; }
  return null;
}
/* the first full day on the plan re-settled with the 3rd Claude off (the plan is built the way it would be without the seat) */
let ptInOff = false;
function ptFirstFullOff(base, pl){
  if (ptInOff) return null; ptInOff = true; const cxO = ptCx(pl), keepT = cxO.cum;
  try { const tr = ptTrialOf(pl); delete tr.base; delete tr.at; delete tr.ww; tr._ownCum = false; const c = tr.milestones.find(m=>m.id === 'm-claude3'); if (c) c.on = false; ptSettle(base, tr); return ptFirstFull(base, tr); }
  catch(e){ console.error(e); return null; } finally { cxO.cum = keepT; ptInOff = false; }
}
function ptPlaceTokens(base, pl){
  const m = pl.milestones.find(z=>z.id === 'm-tokens'); if (!m || m.pinned || m.status !== 'proposed' || pl.jit === false) return false;
  const c3 = pl.milestones.find(z=>z.id === 'm-claude3'), sig = JSON.stringify([m.date, m.on, m.suggested, m.autoOff]), end = isoDay(dayMs(ptUntil(pl)));
  if (m.date && m.date !== m.placedDate && m.date !== end) return false; /* a date you set (not the one placed here, not the "off" end date) is kept */
  const x0 = ptX0(base), ops = ptOpsOf(pl, m), t1 = dayMs(ptUntil(pl)), c3on = c3 && ptActive(pl, c3) && c3.date;
  const tr = clone(pl); delete tr.base; delete tr.at; tr.milestones = tr.milestones.filter(z=>z.id !== m.id && z.after !== m.id); ptSort(tr); tr._ownCum = true;
  const pays = t => { const {s, r} = ptRun(base, tr, ptXOfDate(tr, x0, isoDay(t))), g = ptGain(s, r, ops), dp = ptPtsOf(base, g.r2) - ptPtsOf(base, r), dm = g.r2.month - r.month;
    return g.d >= 1 && ptSugOk(base, dp, dm) ? {t, dp, dm, s} : null; };
  let hit = null, prev = null;
  const t0 = Math.max(dayMs(pl.start) + PT_DAY, c3on ? dayMs(c3.date) : 0);
  for (let t = t0; t <= t1 + 1 && !hit; t += 7*PT_DAY){ const h = pays(t); if (h){ hit = h; for (let u = Math.max(t0, (prev == null ? t0 : prev) + PT_DAY); u < t; u += PT_DAY){ const h2 = pays(u); if (h2){ hit = h2; break; } } } else prev = t; }
  if (c3 && !c3on) hit = null;
  if (!hit){ m.date = end; m.placedDate = end; m.on = false; m.autoOff = true; m.suggested = `not suggested: ${c3on ? 'no token option adds the points bar within the dollars bar' : 'the 3rd Claude is not in the plan'} before ${fmtDay(end)}; switched off`; }
  else { const id = ptTokenBest(hit.s), o = TOKEN_OPTS.find(z=>z.id === id);
    m.date = isoDay(hit.t); m.placedDate = m.date; m.on = true; delete m.autoOff; m.pickLabel = o ? o.label : '';
    /* v30.3-C.3: the gain is reported where it lasts (placement + 4 weeks), not on its first day, when tokens only just bind */
    const t4 = Math.min(t1, hit.t + 28*PT_DAY), r4 = ptRun(base, tr, ptXOfDate(tr, x0, isoDay(t4))), g4 = ptGain(r4.s, r4.r, ops), dp4 = Math.max(hit.dp, ptPtsOf(base, g4.r2) - ptPtsOf(base, r4.r)), dm4 = Math.max(0, g4.r2.month - r4.r.month);
    m.gain4 = {dp:dp4, dm:dm4, now:hit.dp};
    m.suggested = `suggested: ${fmtDay(m.date)}, tokens still bind after the 3rd Claude; ${o ? o.label : 'the best option'} adds +${fmtN(hit.dp, 0)} points a day now, +${fmtN(dp4, 0)} by ${fmtDay(isoDay(t4))}, for ${fmtUsd(Math.max(0, hit.dm))}/month (${fmtUsd(dm4/Math.max(1e-9, dp4))} per point a day at +4 weeks, under the ${fmtUsd(num((base.platform || {}).sugMaxUsdPerPt == null ? 150 : base.platform.sugMaxUsdPerPt))} bar)`; }
  const changed = sig !== JSON.stringify([m.date, m.on, m.suggested, m.autoOff]); if (changed) ptSort(pl); return changed;
}
function ptRecheck(base, pl){
  const x0 = ptX0(base); let redo = false;
  pl.milestones.forEach((m, i)=>{ if (!i || m.jit || m.release || m.status !== 'proposed' || m.on === false || !/^suggested: /.test(m.suggested || '') || m.pinned) return;
    if (/a week after|first day dropping/.test(m.suggested)) return;
    const ops = ptOpsOf(pl, m), hw = ops.some(ptHwOp), X = ptXOfDate(pl, x0, m.date);
    const others = Object.assign({}, pl, {milestones:pl.milestones.filter(z=>z !== m && !(z.after === m.id))}); ptSort(others);
    const sx = ptStateAt(base, others, X), r = compute(sx), g = ptGain(sx, r, ops);
    if (!(g.d >= 1 || (hw && g.dp >= 1))){ m.date = ''; delete m.suggested; redo = true; for (const z of pl.milestones) if (z.after === m.id && z.suggested && !z.pinned){ z.date = ''; delete z.suggested; } } });
  if (redo){ ptSuggestDates(base, pl); for (const m of pl.milestones) if (m.suggested && /^suggested: /.test(m.suggested) && !/re-dated/.test(m.suggested)) m.suggested += ' (re-dated on the final plan)'; }
  return redo;
}
function ptUpgrade(base, pl){
  if (!pl.v302c){ pl.v302c = true; pl.milestones = pl.milestones.filter((m, i)=>!i || !(m.ch || []).length || !m.ch.every(op=>op.k === 'v' && PT_GONE.has(op.label))); }
  if (!pl.v302){ pl.v302 = true; /* v30.2-A: drop the slot-cap seeds, add the MS-A2 decision and the scope / footprint seeds */
    const slotL = PT_GONE;
    pl.milestones = pl.milestones.filter(m=>!(m.seed && ['m-fixers', 'm-heavyslots', 'm-release'].includes(m.id)) && !(m.auto && (m.ch || []).length && m.ch.every(op=>op.k === 'v' && slotL.has(op.label))));
    for (const [id, name, op] of PT_V302_SEEDS) if (!pl.milestones.some(m=>m.id === id) && !(pl.dismissed || []).some(z=>z.id === id)){ const t = clone(base); if (!ptApply(t, op)) pl.milestones.push({id, name, date:'', ch:[op], status:'proposed', on:true, seed:true, ramp:true}); }
    ptSort(pl); }
  /* v30.2-B.4: the Hetzner is never kept. Saved plans lose "keep both", the old Drop-Hetzner and the Nov 21 decision marker, and gain Studio first → cancel Forge A, Forge B just in time and the free Studio pool lever */
  if (!pl.v302d){ pl.v302d = true;
    const had = pl.milestones.find(m=>m.id === 'm-drop-forge');
    pl.milestones = pl.milestones.filter(m=>!['m-msa2-both', 'm-drop-forge', 'm-msa2-dec'].includes(m.id));
    pl.milestones = pl.milestones.filter(m=>!(m.id === 'm-prep2' || (m.ch || []).some(op=>op.k === 'v' && /^(Prepare rate|Freshness window)/.test(op.label || ''))));
    for (const m of pl.milestones){ if (m.id === 'm-msa2' && !m.fb){ m.fb = true; m.name = 'Buy Forge B (only if Studio CPU or RAM binds)'; m.date = ''; m.on = false; delete m.suggested; delete m.pinned; }
      if (m.id === 'm-msa2-place' && !m.fb){ m.fb = true; m.date = ''; m.on = false; delete m.suggested; delete m.pinned; m.note = 'tests only: both machines send their heavy tests to Forge B. Never beside Forge A.'; } }
    if (had && had.pinned && had.date && had.on !== false && !pl.milestones.some(m=>m.id === 'm-cancel-forge')) pl.dismissed = (pl.dismissed || []).filter(z=>z.id !== 'm-cancel-forge');
    ptSeedStudioFirst(base, pl); ptSeedForgeB(base, pl);
    ptSort(pl); }
  if (!pl.v302e){ pl.v302e = true; /* v30.2-B.5: no heavy-test count to raise; Studio ramp and token dates are re-derived */ pl.milestones = pl.milestones.filter(m=>m.id !== 'm-pool8'); for (const m of pl.milestones) if (m.id === 'm-claude3' && m.suggested && !m.pinned){ m.date = ''; delete m.suggested; } }
  if (!pl.v303){ pl.v303 = true; ptSeedForgeC(base, pl); }
  if (!pl.v303b){ pl.v303b = true; const o = pl.milestones.find(m=>m.id === 'm-msa2' && m.ordered); if (o && !(o.ch || []).some(op=>op.k === 'place' && op.what === 'park')) o.ch = [{k:'host', id:'msa2', on:true}, {k:'place', host:'msa2', what:'park'}]; } /* v30.3-C.1: ordered = paid and idle until it arrives */
  if (!pl.v30){ pl.v30 = true; if (pl.halfLife == null) pl.halfLife = PT_HL_DEF; ptSeedReleases(pl); }
  if (pl.v28) return; pl.v28 = true;
  if (!pl.until) pl.until = ptDefUntil(pl.tunedBy);
  if (!pl.axis || pl.axis === 'date') pl.axis = 'auto';
  for (const m of pl.milestones) if (['m-release', 'm-precedent', 'm-opus', 'm-fixers'].includes(m.id)) m.ramp = true;
}
/* the gain of applying ops (and the milestones linked after it) on state s: PRs a day and plan for */
function ptOpsOf(pl, m){ const out = (m.ch || []).slice(); for (const z of pl.milestones) if (z.after === m.id) out.push(...(z.ch || [])); return out; }
function ptGain(s, r, ops){ const s2 = clone(s); for (const op0 of ops){ const op = op0.k === 'tokens' && !op0.pick ? {k:'tokens'} : op0; if (op.k === 'num') contSet(s2, op.f, num(op.v)); else ptApply(s2, op); } const r2 = compute(s2); return {d:r2.total - r.total, dp:r2.planTotal - r.planTotal, r2}; }
/* Proposed milestones without a date (v28): the first day it lifts what binds there by at least 1 PR a day (PRs a day or
   plan for); no lead is subtracted (order ahead yourself). One that never adds 1 PR a day before the plan's end is not
   suggested: it is switched off and says why. A linked milestone ("Place MS-A2 workload") goes one week after the one it
   follows; "Drop Hetzner" goes a week after the tests move, or (alone) the first day dropping it costs under 1 PR a day. */
/* v30.2-B: seeds are dated one by one, each against the milestones already dated; one switched off as "never adds" while a
   later undated seed (e.g. Prepare rate ×2) was still out of the plan said "never adds" only because of the order. Seeds that
   grow the card supply are dated first (they decide whether tokens, machines or supply bind later); a full second pass cost
   ~0.4 s of Suggest */
const PT_SUPPLY_OP = op => op && op.k === 'v' && /^(Prepare rate|Freshness window)/.test(op.label || '');
function ptSuggestDates(base, pl){ ptSuggestDates0(base, pl); }
function ptSuggestDates0(base, pl){
  const x0 = ptX0(base), start = dayMs(pl.start), XE = ptEnd(pl);
  const todo = pl.milestones.slice(1), sup = m => (m.ch || []).some(PT_SUPPLY_OP) ? 0 : 1; todo.sort((p, q)=>sup(p) - sup(q));
  const one = m => {
    if (m.fc){ if (!m.date) m.date = isoDay(dayMs(ptUntil(pl))); return; } /* Forge C is dated by ptPlaceForgeC (after every strategy) */
    if (m.date || m.after) return;
    if (m.autoOff){ m.on = true; delete m.autoOff; }
    const others = Object.assign({}, pl, {milestones:pl.milestones.filter(z=>z !== m && z.date)}); ptSort(others);
    const nb = m.notBefore && pl.milestones.find(z=>z.id === m.notBefore);
    if (m.drop){
      if (nb && nb.date && ptActive(pl, nb)){ m.date = isoDay(Math.min(dayMs(ptUntil(pl)), dayMs(nb.date) + 7*PT_DAY)); m.suggested = `suggested: a week after ${nb.name}`; return; }
      if (nb && !ptActive(pl, nb)){ m.date = nb.date || ptUntil(pl); m.suggested = 'not suggested: the MS-A2 is not taking the tests, so dropping Hetzner moves them onto the Studio and laptop (calibration: keep Hetzner for the 7-day Studio measurement first); switched off'; if (m.status === 'proposed'){ m.on = false; m.autoOff = true; } return; }
      let when = null;
      for (let X = x0 + 1e-6; X <= XE + 1e-9; X = X >= XE ? XE + 1 : Math.min(XE, X + 8)){
        const sx = ptStateAt(base, others, X), r = compute(sx), g = ptGain(sx, r, m.ch || []);
        if (g.d > -1 && g.dp > -1){ when = X < XE - 1e-6 ? X : null; break; }
      }
      m.date = isoDay(Math.max(start + PT_DAY, dayMs(ptDateOfX(pl, x0, when == null ? XE : when))));
      m.suggested = when == null ? 'not suggested: dropping it costs PRs a day all through this plan; switched off' : 'suggested: the first day dropping it costs under 1 PR a day';
      if (when == null && m.status === 'proposed'){ m.on = false; m.autoOff = true; } /* v30: a drop that always costs delivery is not proposed on */
      return;
    }
    let when = null, lastBind = '';
    /* machines lift plan for (they bind at their targets); everything else must lift PRs a day */
    const ops = ptOpsOf(pl, m), hw = ops.some(ptHwOp), xnb = nb && nb.date && ptActive(pl, nb) ? ptXOfDate(pl, x0, nb.date) : x0; /* v30.1: an off "not before" milestone does not hold this one back */
    const test = X => { const sx = ptStateAt(base, others, X), r = compute(sx); lastBind = ptBindTxt(r); const g = ptGain(sx, r, ops);
      const tokOk = !ops.some(op=>op.k === 'tokens') || ptSugOk(base, ptPtsOf(base, g.r2) - ptPtsOf(base, r), g.r2.month - r.month); /* v30.2-B.6 (M3): added tokens must clear the points / dollars bar where they would land */
      return tokOk && (g.d >= 1 || (hw && g.dp >= 1)) ? {X, name:g.d >= 1 ? `it adds ${fmtN(g.d, 0)} PRs/day (lifts ${ptLifted(r, g.r2)})` : `it adds ${fmtN(g.dp, 0)}/day to plan for`} : null; };
    /* coarse walk (10% steps), then the first day inside the step where it first pays (2% steps) */
    let prev = Math.max(x0, xnb);
    for (let X = prev; X <= XE + 1e-9; X = X >= XE ? XE + 1 : Math.min(XE, X + 10)){
      const h = test(X); if (h){ when = h; for (let Y = Math.max(prev, X - 8); Y < X - 1e-9; Y += 2){ const h2 = test(Y); if (h2){ when = h2; break; } } break; }
      prev = X;
    }
    let t = when ? dayMs(ptDateOfX(pl, x0, when.X)) : dayMs(ptUntil(pl));
    if (nb && nb.date && ptActive(pl, nb)) t = Math.max(t, dayMs(nb.date) + 7*PT_DAY);
    if (when && ptIsPhased(m)) t -= num((base.platform || {}).leadDays == null ? 7 : base.platform.leadDays)*PT_DAY; /* built ahead: it takes effect leadDays after its date, then ramps in */
    m.date = isoDay(Math.min(dayMs(ptUntil(pl)), Math.max(start + PT_DAY, t)));
    if (when) m.suggested = when.X <= x0 + 1e-9 ? `suggested: as soon as possible (${when.name} already today)` : `suggested: ${when.name} from ${fmtDay(m.date)}; order ahead if it has a lead time`;
    else { m.suggested = `not suggested: it never adds 1 PR a day before ${fmtDay(ptUntil(pl))} (${ptRunOut(lastBind)}${/tied with/.test(lastBind) ? ': lifting one of them alone adds nothing' : ''}); switched off`; if (m.status === 'proposed'){ m.on = false; m.autoOff = true; } }
  };
  /* v30.2-B.5: the 3rd Claude lands the day tokens bind on the finished plan (just in time), and what follows it is dated after it */
  const defer = m => m.id === 'm-claude3' || m.notBefore === 'm-claude3';
  for (const m of todo) if (!defer(m)) one(m);
  { const c3 = pl.milestones.find(m=>m.id === 'm-claude3');
    if (c3 && !c3.date && !c3.after){ if (c3.autoOff){ c3.on = true; delete c3.autoOff; }
      const tb = ptTokenBind(base, pl);
      if (tb){ c3.date = tb.date; c3.suggested = `suggested: ${fmtDay(tb.date)}, the day AI tokens start to bind (${tb.why}); not earlier`; }
      else { c3.date = isoDay(dayMs(ptUntil(pl))); c3.suggested = `not suggested: AI tokens never bind before ${fmtDay(ptUntil(pl))} in this plan; switched off`; if (c3.status === 'proposed'){ c3.on = false; c3.autoOff = true; } } } }
  for (const m of todo) if (defer(m) && m.id !== 'm-claude3') one(m);
  for (const m of pl.milestones) if (m.after && !m.date){ const p = pl.milestones.find(z=>z.id === m.after); if (p && p.date){ m.date = isoDay(Math.min(dayMs(ptUntil(pl)), dayMs(p.date) + 7*PT_DAY)); m.suggested = `suggested: a week after ${p.name}`; if (p.autoOff && m.status === 'proposed'){ m.on = false; m.autoOff = true; } } }
  ptSort(pl);
}
/* v30.2-B.5: the one date AI tokens start to bind: the first day, on the plan without any token or seat addition, that the binding limit (or one tied with it) is an AI plan.
   Every panel that says when tokens bind reads this; the 3rd Claude is dated to it (just in time, never earlier). Weekly scan, then daily inside the first week that binds. */
const ptBindCache = new Map();
function ptTokenBind(base, pl){
  const key = ptCumSig(pl) + '|' + JSON.stringify(base).length; if (ptBindCache.has(key)) return ptBindCache.get(key);
  const tr = ptTrialOf(pl); tr.milestones = tr.milestones.filter((m, i)=>!i || !(m.ch || []).some(o=>o.k === 'tokens' || o.k === 'seat') ); ptSort(tr);
  const x0 = ptX0(base), t0 = dayMs(tr.start), t1 = dayMs(ptUntil(tr));
  const aiAt = t => { const iso = isoDay(t), {r} = ptRun(base, tr, ptXOfDate(tr, x0, iso)); const bs = [r.binding, ...(r.tied || [])].filter(Boolean); const hit = bs.find(c=>c.key === 'ai-fill' || c.group === 'AI'); if (hit && !(r.cons || []).some(c=>c.group === 'AI' && c.util >= 0.995) && !/AI tokens/.test(limitName(r.binding))) return null; /* v30.3-C.2: a tie with the all-plans line counts once a plan is full */ return hit ? {iso, r, why:r.binding && r.binding.key === 'ai-fill' ? 'every usable plan is full' : short(hit.name) + ' is full'} : null; };
  let out = null, prev = t0 - 7*PT_DAY;
  for (let t = t0; t <= t1 + 1; t += 7*PT_DAY){ if (aiAt(t)){ for (let u = Math.max(t0, prev + PT_DAY); u <= t; u += PT_DAY){ const h = aiAt(u); if (h){ out = {date:h.iso, why:h.why}; break; } } break; } prev = t; }
  if (ptBindCache.size > 20) ptBindCache.clear(); ptBindCache.set(key, out); return out;
}
function planBase(s){ const b = clone(s); delete b.plan; return b; }
/* v29: the plan starts from the measured Today preset by default (milestone 0 = what you deliver now); "Your inputs"
   (plan.from = 'inputs') starts it from the first-screen inputs instead. v28 always used the inputs, so a page showing
   the Tuned preset (or an edited one) drew milestone 0 at e.g. 87/day. */
let ptTodayC = {k:'', s:null};
function ptToday(){ const k = PS ? 'ps' : 'nops'; if (ptTodayC.k !== k){ const t = presetToday(); t.route = 'fill'; delete t.plan; ptTodayC = {k, s:t}; } return clone(ptTodayC.s); }
function ptStartBase(s){ return s.plan && s.plan.from === 'inputs' ? planBase(s) : ptToday(); }
function ptBase(s){ return s.plan && s.plan.base ? clone(s.plan.base) : ptStartBase(s); }
/* plan position 0–100 runs from the start date to the fully-tuned date; efficiency = the setup's own level at 0 rising
   linearly to 100% (fully tuned) at 100. A setup already fully tuned keeps 100% all along, and its milestones still spread by date. */
function ptX0(base){ return 0; }
/* v29: measured merged PRs a day (web-everything, ET days), gh pr list --state merged, read 2026-11-14 ~19:00 ET.
   Oct 17 → Nov 13 = 28 full days; Nov 14 (today, partial) is left out. */
const PT_HIST = {from:'2026-10-17', to:'2026-11-14', days:[68,98,67,64,44,11,19,47,48,27,33,22,27,39,34,51,72,39,31,43,42,47,50,45,44,25,54,49]};
/* the measured 7- and 28-day averages belong with the data (the page used to set them after the fact; the spin-up cap reads avg7) */
PT_HIST.avg7 = PT_HIST.days.slice(-7).reduce((a, b)=>a + b, 0)/7; PT_HIST.avg28 = PT_HIST.days.reduce((a, b)=>a + b, 0)/PT_HIST.days.length;
/* v30: no "fully tuned" date. Tuning approaches its target slowly and never completes: the remaining waste halves every
   halfLife months (seeded 2.4 from 2026's between-release process gain: $/PR ×0.75 a month, Oct 19 – Nov 2; code-PR cost was
   flat, ×1.00, so the true value may be slower) and keeps improving after any date. X keeps its old scale (100 = start + 140 days). */
const PT_HL_DEF = 2.4, PT_HL_CONS = 6; /* v30.3-C.2: the Conservative efficiency scenario halves the remaining waste every 6 months */ 
const ptHL = pl => { const p = pl || hooks.statePlan() || {}; const n = num(p.halfLife); return n > 0.1 ? n : PT_HL_DEF; };
const ptMoOfX = (X, pl) => { const p = pl || hooks.statePlan(); return Math.max(0, X)/100*140/30.44*(p && p.tunedBy && p.start ? ptSpan(p)/(140*PT_DAY) : 1); };
function ptEff(base, X, pl){ return 100*(1 - Math.pow(0.5, ptMoOfX(X, pl)/ptHL(pl))); }
function ptPosOfEff(base, E, pl){ const e = Math.min(99.9, Math.max(0, E)); const mo = -ptHL(pl)*Math.log2(1 - e/100); return mo/(ptMoOfX(100, pl)/100); }
function ptSpan(pl){ return Math.max(PT_DAY, dayMs(pl.tunedBy) - dayMs(pl.start)); }
function ptXOfDate(pl, x0, d){ const t = dayMs(d); if (!Number.isFinite(t)) return x0; return Math.max(x0, Math.min(ptEnd(pl), x0 + (t - dayMs(pl.start))/ptSpan(pl)*(100 - x0))); }
function ptDateOfX(pl, x0, X){ return isoDay(dayMs(pl.start) + Math.round((X - x0)/Math.max(1e-9, 100 - x0)*ptSpan(pl)/PT_DAY)*PT_DAY); }
function ptPts(pl, x0){ return pl.milestones.map((p, i)=>({p, i, x: i === 0 ? x0 : ptXOfDate(pl, x0, p.date)})); }
function ptSort(pl){
  /* a linked milestone never comes before the one it follows */
  for (const m of pl.milestones){ const p = (m.after || m.notBefore) && pl.milestones.find(z=>z.id === (m.after || m.notBefore)); if (p && p.date && m.date && dayMs(m.date) < dayMs(p.date)) m.date = p.date; }
  const p0 = pl.milestones[0], rest = pl.milestones.slice(1).map((m, i)=>({m, i})).sort((a, b)=>((dayMs(a.m.date) || 0) - (dayMs(b.m.date) || 0)) || (a.m.after === b.m.id ? 1 : b.m.after === a.m.id ? -1 : a.i - b.i)).map(z=>z.m);
  pl.milestones = [p0, ...rest];
}
function contGet(s, f){
  if (f === 'tokenSave') return num(s.tokenSave);
  if (f === 'opus'){ const c = s.providers.find(p=>p.id==='claude'); return c && c.opusShare != null ? num(c.opusShare) : OPUS_REF; }
  return 0;
}
function contSet(s, f, v){
  if (f === 'tokenSave') s.tokenSave = v;
  else if (f === 'opus'){ const c = s.providers.find(p=>p.id==='claude'); if (c){ c.opusShare = v; if (c.sonnetRatio == null) c.sonnetRatio = 0.2; if (c.sonnetExtraRounds == null) c.sonnetExtraRounds = 10; } }
  else if (f === 'open' && v > 0){ const o = s.stages.find(x=>x.kind==='wip'); if (o){ const k = 1 - Math.min(90, v)/100; o.wall = num(o.wall)*k; if (o.wallTuned != null) o.wallTuned = num(o.wallTuned)*k; } }
}
function ptApply(s, op){
  if (op.k === 'v'){ const lb = op.label === 'Fully tuned (no repeat work or waiting)' ? 'Tuned target (no repeat work or waiting)' : op.label; const v = variants().find(x=>x.label === lb); return v ? v.apply(s) : 'unknown change'; }
  if (op.k === 'tokens'){ const id = op.pick || (op.best !== undefined ? op.best : ptTokenBest(s)); const o = TOKEN_OPTS.find(z=>z.id === id); return o ? o.apply(s) : 'no option carries more work'; }
  if (op.k === 'plat'){ const P = s.platform; const v0 = P[op.f] == null || P[op.f] === '' ? (op.def == null ? 0 : op.def) : num(P[op.f]);
    if (op.set != null){ if (op.max ? v0 >= op.set : v0 === op.set) return 'already'; P[op.f] = op.set; } else if (op.mul != null) P[op.f] = v0*op.mul; else if (op.add != null) P[op.f] = v0 + op.add; return; }
  if (op.k === 'stg'){ const st = s.stages.find(x=>x.id === op.id); if (!st) return 'no such stage'; for (const f of op.fs || [op.f]){ if (st[f] == null) continue; st[f] = op.set != null ? op.set : num(st[f])*op.mul; } return; }
  if (op.k === 'split'){ const P = s.platform, sh = Math.min(0.49, Math.max(0, num(op.share))); P.fullScale = (P.fullScale == null || P.fullScale === '' ? 1 : num(P.fullScale))*(1 - sh); P.mqCapMul = (P.mqCapMul == null || P.mqCapMul === '' ? 1 : num(P.mqCapMul))/(1 - sh); P.apiRepos = num(P.apiRepos) + 1;
    P.qMul = (P.qMul == null || P.qMul === '' ? 1 : num(P.qMul))*((1 - sh)*(1 - sh) + sh*sh); /* v30.2-A: two repos' PRs never share files */ return; }
  if (op.k === 'release'){ s.platform.relFactor = (s.platform.relFactor == null || s.platform.relFactor === '' ? 1 : num(s.platform.relFactor))*(op.step == null ? 1 : num(op.step)); s.platform.relN = num(s.platform.relN) + Math.max(1, num(op.n)); return; }
  if (op.k === 'model'){ const st = s.stages.find(x=>x.id === op.stage); if (!st) return 'no such stage'; if (st.provider !== 'claude') return 'runs on ' + st.provider + ', not Claude'; if (!MODELS[op.model]) return 'unknown model'; if (st.model === op.model) return 'already'; st.model = op.model; return; }
  if (op.k === 'seat'){ const p = s.providers.find(x=>x.id === op.id); if (!p) return 'no such plan'; if (num(op.n) > 0 && atMax(p)) return maxWhy(p); /* v30.3-D.1 (Codex audit, fix 1): clamp on the RESULT, so +2 on 2 Claude seats stops at maxCount 3, not 4 */ { const want = Math.max(0, num(p.count) + num(op.n)), top = num(p.maxCount) > 0 && num(op.n) > 0 ? Math.max(num(p.count), num(p.maxCount)) : Infinity; p.count = Math.min(want, top); } if (num(op.n) > 0) p.on = true; return; }
  if (op.k === 'host'){ const h = s.hosts.find(x=>x.id === op.id); if (!h) return 'no such machine'; h.on = !!op.on; if (!h.on) h.parked = false; return; }
  if (op.k === 'place'){ /* what moves onto a new machine */
    const h = s.hosts.find(x=>x.id === op.host); if (!h) return 'no such machine';
    if (op.what === 'tests'){ /* v28 replacement: every heavy test run goes to this machine; the other Forges are parked (still paid until dropped) */
      if (!h.on) return 'its machine is off'; /* the heavy-test share moves as it is (forgeShare unchanged) */
      for (const x of s.hosts) if (x !== h && x.role === 'tests' && x.on) x.parked = true; h.parked = false; return; }
    if (op.what === 'park'){ const f = s.hosts.find(x=>x.id === op.host); if (!f) return 'no such machine'; if (!f.on) return 'already off'; f.parked = true; return; } /* v30.2-B.4: the Studio runs its own heavy tests; the Forge carries nothing (still paid until cancelled) */
    if (op.what === 'ci'){ if (num(s.platform.ciSelfHosted) < 0.5) s.platform.ciSelfHosted = 0.5; return; } /* half of CI self-hosted */
    if (op.what === 'daemons'){ const a = s.hosts.find(x=>x.daemons); if (!a || a === h) return 'already there'; h.on = true; h.role = 'general';
      for (const k of ['daemons','daemonCores','daemonOpenCores','daemonMergeCores','daemonGb','daemonMergeGb']){ h[k] = a[k]; delete a[k]; } return; }
    return 'unknown placement';
  }
}
/* "Add tokens (best value)": the ways to carry AI work Claude cannot take once it is at its account limit */
/* v30 order (operator 2026-11-14 19:43 ET, README "Operator limits"): use the idle Google AI Ultra first, then a 2nd Codex,
   then an open-weight trial on low-tier stages, Claude API last. The ranking follows that order among the options that add
   ≥1 PR/day; the measured $ per extra PR/day, the stages each can take and the quality cost are shown beside it.
   A new provider (Grok, …) is product value (Plateau multi-provider), not capacity: a Proposed milestone tied to the launch. */
const TOKEN_OPTS = [
  {id:'google-idle', pref:1, label:'Use the idle Google AI Ultra (Antigravity Opus seats; already paid)', prov:'google', quality:'top-tier work through Antigravity (model = Opus, 1,431 judge seats measured, 0.93 min p50); weekly limit unknown (A)',
    apply:s=>{ const p = s.providers.find(x=>x.id==='google'); if (!p) return 'no Google AI row'; if (p.on && p.tier === 'top') return 'already used for top-tier work'; p.on = true; p.tier = 'top'; p.src = Object.assign({}, p.src, {tier:A('Antigravity seats run Opus (op-durations: agy seat model=opus); usage limits unknown')}); }},
  {id:'codex', pref:2, label:'2nd Codex seat (+US$500/month)', prov:'codex', quality:'mid tier; review seats 2.2 min vs Sonnet 1.0 (op-durations). Codex limit ±50% (calibration unstable)',
    apply:s=>{ const p = s.providers.find(x=>x.id==='codex'); if (!p) return 'no Codex row'; if (atMax(p)) return maxWhy(p); if (num(p.count) >= 2) return 'already 2 or more'; p.count = num(p.count) + 1; p.on = true; }},
  {id:'openweight', pref:3, label:'Open-weight trial on low-tier stages (+$1,000/month budget)', prov:'openweight', quality:'light stages only (passes, summaries) while on trial; tier is a judgment call (A)',
    apply:s=>{ const p = s.providers.find(x=>x.id==='openweight'); if (!p) return 'no open-weight row'; if (p.on) p.budget = num(p.budget) + 1000; else { p.on = true; p.budget = 1000; p.tier = 'light'; } }},
  {id:'claudeapi', pref:4, label:'Claude API pay-as-you-go (+$3,000/month budget step; last)', prov:'claudeapi', quality:'same models as the subscriptions; $0.31/Mtok measured blend (mostly cache reads)',
    apply:s=>{ const p = s.providers.find(x=>x.id==='claudeapi'); if (!p) return 'no Claude API row'; if (p.on) p.budget = num(p.budget) + 3000; else { p.on = true; p.budget = 3000; } }},
  {id:'google', pref:5, label:'+1 Google AI seat', prov:'google', quality:'mid tier (A)', apply:s=>{ const p = s.providers.find(x=>x.id==='google'); if (!p) return 'no Google AI row'; if (atMax(p)) return maxWhy(p); p.count = num(p.count) + 1; p.on = true; }},
  {id:'local', pref:6, label:'Local model on the Studio (light stages)', prov:'local1', quality:'light stages; takes Studio RAM/cores', apply:s=>{ const p = s.providers.find(x=>x.kind==='local'); if (!p) return 'no local model row'; if (p.on) return 'already on'; const h = s.hosts.find(x=>x.id===p.host); if (!h || !h.on) return 'its machine is off'; p.on = true; }}
];
/* rank them on state s: PRs a day gained, $/month, $ per extra PR a day, the stages each can take (quality tier and pins) */
/* v30.1: the ranking's first valid option only (same rule as ptTokenOptions: operator order, adds ≥1/day, plan for not
   dropping), stopping at the first hit; used wherever only the choice is needed (Suggest, suggested dates) */
function ptTokenBest(s){
  let r0; try { r0 = compute(s); } catch(e){ return ''; }
  for (const o of TOKEN_OPTS.slice().sort((a, b)=>a.pref - b.pref)){ const s2 = clone(s); if (s2.route !== 'fill') s2.route = 'fill'; if (o.apply(s2)) continue;
    let r2; try { r2 = compute(s2); } catch(e){ continue; } if (r2.total - r0.total >= 1 && !(r2.planTotal < r0.planTotal*0.98 - 0.5)) return o.id; }
  return '';
}
function ptTokenOptions(s, withRange){
  let r0; try { r0 = compute(s); } catch(e){ return []; }
  const w = Math.min(100, Math.max(0, num(s.waste)))/100;
  const out = TOKEN_OPTS.map(o=>{
    const base0 = {id:o.id, label:o.label, pref:o.pref, quality:o.quality};
    const s2 = clone(s); if (s2.route !== 'fill') s2.route = 'fill';
    const note = o.apply(s2); if (note) return Object.assign(base0, {ok:false, why:note, d:0, dm:0, per:Infinity, stages:[]});
    let r2; try { r2 = compute(s2); } catch(e){ return Object.assign(base0, {ok:false, why:'model error', d:0, dm:0, per:Infinity, stages:[]}); }
    const p = s2.providers.find(x=>x.id === o.prov) || s2.providers.find(x=>x.kind === 'local');
    const stages = p ? s2.stages.filter(st=>st.kind === 'ai' && stageAi(st, w) > 0 && TIER[p.tier] >= TIER[st.tier] && (st.movable !== false || st.provider === p.id)).map(st=>st.name) : [];
    const d = r2.total - r0.total, dm = Math.max(0, r2.month - r0.month);
    const planDrop = r2.planTotal < r0.planTotal*0.98 - 0.5; /* e.g. a local model pushing its machine past its target */
    const ok = d >= 1 && !planDrop; /* v28: an option must add at least 1 PR a day */
    let range = null;
    if (o.id === 'codex' && ok && withRange){ const at = k => { const s3 = clone(s2); const c = s3.providers.find(x=>x.id==='codex'); c.weeklyCap = num(c.weeklyCap)*k; const s4 = clone(s); const c4 = s4.providers.find(x=>x.id==='codex'); if (c4) c4.weeklyCap = num(c4.weeklyCap)*k; s4.route = 'fill'; return compute(s3).total - compute(s4).total; }; range = [at(0.5), at(1.5)].sort((a, b)=>a - b); }
    return Object.assign(base0, {ok, why:ok ? '' : planDrop ? `plan for drops ${fmtN(r0.planTotal, 0)} → ${fmtN(r2.planTotal, 0)} (a machine passes its target)` : (stages.length ? 'does not lift delivery here' : 'no stage it may take'), d, dm, per:ok ? dm/d : Infinity, stages, range});
  });
  out.sort((a, b)=>(b.ok - a.ok) || a.pref - b.pref || a.per - b.per);
  const ok = out.filter(o=>o.ok), cheap = ok.slice().sort((a, b)=>a.per - b.per || b.d - a.d)[0];
  if (ok[0]) ok[0].rank = 'winner'; if (ok[1]) ok[1].rank = 'runner-up'; if (cheap && cheap !== ok[0]) cheap.cheapest = true;
  return out;
}
const PT_PLACE = {tests:'both machines send their heavy tests here (tests only)', park:'nothing is sent here: the Studio runs its own heavy tests (still paid until cancelled)', ci:'half of CI self-hosted', daemons:'daemons and lane tooling (it becomes a general machine)'};
/* a milestone counts when it is confirmed, or proposed and switched on (and the plan shows proposed ones) */
/* v30.3-C.1: show = 'all' (confirmed + proposed), 'confirmed', or 'strategies' (confirmed + proposed strategies: no new hardware) */
const ptActive = (pl, m) => !m || (m.on === false && m.status !== 'proposed' ? false : m.status !== 'proposed') || (m.status === 'proposed' && m.on !== false && pl.show !== 'confirmed' && !(pl.show === 'strategies' && ptNewHw(m)));
function ptOpLabel(op, s){
  if (op.k === 'v') return op.label;
  if (op.k === 'seat'){ const p = s && s.providers.find(x=>x.id === op.id); return `${num(op.n) > 0 ? '+' : ''}${num(op.n)} ${p ? short(p.name) : op.id} seat`; }
  if (op.k === 'host'){ const h = s && s.hosts.find(x=>x.id === op.id), o = h && h.costFrom && s.compute && (s.compute.options || []).find(z=>z.id === h.costFrom);
    const cost = !op.on ? '' : o && o.kind === 'own' ? ` (buy once ${fmtUsd(num(o.capex))}; counted as ${fmtUsd(num(o.capex)/Math.max(1, num(o.months)))}/month over ${num(o.months)} months, plus power)` : o && o.kind === 'rent' ? ` (rent ${fmtUsd(num(o.monthly))}/month)` : h && h.fixed && !(num(h.monthlyUsd) > 0) ? ' (already bought: no new cost)' : h && num(h.monthlyUsd) > 0 ? ` (${fmtUsd(num(h.monthlyUsd))}/month)` : '';
    return `${h ? h.name : op.id} ${op.on ? 'on' : 'off'}${cost}`; }
  if (op.k === 'num') return `${PT_CONT[op.f] || op.f} → ${fmtN(num(op.v), 0)} (ramps from the milestone before)`;
  if (op.k === 'plat') return op.text || `${op.f} ${op.set != null ? '→ ' + op.set : op.mul != null ? '× ' + op.mul : '+ ' + op.add}`;
  if (op.k === 'stg') return op.text || `${op.id} ${op.fs ? op.fs.join('/') : op.f} × ${op.mul}`;
  if (op.k === 'split') return op.text || `repo split: ${Math.round(num(op.share)*100)}% of the suite and its PRs get their own merge queue; daemons poll one more repo`;
  if (op.k === 'release') return `Model release${num(op.n) > 1 ? 's' : ''} (${op.what || 'analogue'}): AI cost per PR × ${fmtN(op.step == null ? 1 : num(op.step), 2)} (each major 0.80–1.25)`;
  if (op.k === 'model'){ const st = s && s.stages.find(x=>x.id === op.stage); return `Move ${st ? st.name : op.stage} to ${(MODELS[op.model] || {name:op.model}).name}`; }
  if (op.k === 'tokens'){ const o = TOKEN_OPTS.find(z=>z.id === (op.pick || op.best)), o2 = !op.pick && TOKEN_OPTS.find(z=>z.id === op.second); return 'Add tokens: ' + (o ? o.label + (op.pick ? '' : ' (first in the order that adds ≥1/day)') + (o2 ? '; runner-up: ' + o2.label : '') : 'nothing carries more work here'); }
  if (op.k === 'place'){ const h = s && s.hosts.find(x=>x.id === op.host); return `Onto ${h ? h.name : op.host}: ${PT_PLACE[op.what] || op.what}`; }
  return '?';
}
/* the scenario at efficiency X; before = just before a point's changes (left limit) */
/* a proposed numeric lever (footprint, model, review, scope work) is phased; machines, seats, cancels, releases and token moves are steps */
const ptSpinCap = (tNow, pl, dbl) => PT_HIST.avg7*Math.pow(2, Math.max(0, tNow - dayMs(pl.start))/PT_DAY/(num(dbl) > 0 ? num(dbl) : 7)); /* (the daemon phase only matters once the move has happened) */
/* v30.3-C.2: a just-in-time lever is dated at its BUILD START; it takes effect after its build lead (card points, weeks), then ramps in over a week */
let ptStepJit = false;
const ptIsPhased = m => !!m && m.status === 'proposed' && !m.release && (m.ch || []).length > 0 && ((m.jit && !m.hw) || (m.ch || []).every(op=>op.k === 'v' || op.k === 'model'));
const ptLeadDaysOf = (PP, m) => m.jit ? Math.round(num(m.lead)*7) : num(m.lead != null ? m.lead : PP.leadDays == null ? 7 : PP.leadDays);
const ptRampDaysOf = (PP, m) => Math.max(1, num(m.rampDays != null ? m.rampDays : m.jit ? 7 : PP.rampDays == null ? 14 : PP.rampDays));
/* card points a lever's build costs (the chain of its cards); charged to delivery capacity while it is built */
const ptBuildPts = m => { if (m.buildPts != null) return num(m.buildPts); const j = PT_JIT.find(z=>z.id === m.id); return j ? j.chain.reduce((a, c)=>a + num(c[1]), 0) : 0; };
function ptStateAt(base, pl, X, before, kAt, cumIn){
  const x0 = ptX0(base), pts = ptPts(pl, x0);
  X = Math.max(x0, Math.min(ptEnd(pl), X));
  let k = 0; for (let i = 1; i < pts.length; i++) if (before ? pts[i].x < X - 1e-9 : pts[i].x <= X + 1e-9) k = i;
  if (kAt != null) k = kAt; /* milestone i on a day shared with others: only the milestones up to i */
  const s = clone(base);
  /* v30.2-B.5 (review B.4 blocker 2): a proposed change is not built yet. It takes effect leadDays after its date and then ramps in over rampDays;
     a confirmed or one-off step (a machine, a seat, a cancel, a release) lands at its date. The Studio phases in over its first week. */
  const tNow = dayMs(pl.start) + (X - x0)/Math.max(1e-9, 100 - x0)*ptSpan(pl), PP = (base.platform || {});
  const phaseOf = m => { if (!ptIsPhased(m)) return 1; if (ptStepJit && m.jit) return tNow >= dayMs(m.date) + ptLeadDaysOf(PP, m)*PT_DAY - 1e-6 ? 1 : 0; const lead = ptLeadDaysOf(PP, m), rd = ptRampDaysOf(PP, m);
    return Math.max(0, Math.min(1, (tNow - dayMs(m.date) - lead*PT_DAY)/(rd*PT_DAY))); };
  for (let i = 0; i <= k; i++) if (ptActive(pl, pts[i].p)){ const f = i ? phaseOf(pts[i].p) : 1, ops = (pts[i].p.ch || []).filter(op=>op.k !== 'num');
    if (f >= 1) for (const op of ops) ptApply(s, op); else if (f > 0){ const s2 = clone(s); for (const op of ops) ptApply(s2, op); ptLerp(s, s2, f);
      /* v30.2-B.6 (B2c): a model move is not a number, so it used to switch in one day when its ramp ended (AI cost per PR −10% overnight). It now blends: the stage costs the mix of both models while it ramps */
      for (const op of ops) if (op.k === 'model'){ const st = s.stages.find(x=>x.id === op.stage), st2 = s2.stages.find(x=>x.id === op.stage); if (st && st2 && st.model !== st2.model && MODELS[op.model]){ st.modelTo = op.model; st.modelF = f; } } } }
  { const md = pl.milestones.find(m=>m.id === 'm-daemons' && m.date && ptActive(pl, m)), bk = base.hosts.find(h=>h.daemons && h.id !== 'studio');
    if (md && bk && tNow >= dayMs(md.date) && s.platform){ const rd = Math.max(0, num(s.platform.daemonRampDays == null ? 3 : s.platform.daemonRampDays)); s.platform.daemonPhase = Math.max(0, Math.min(1, ((tNow - dayMs(md.date))/PT_DAY + 1)/(rd + 1))); s.platform.daemonBack = bk.id; } }
  if (!ptStepJit){ let bp = 0; for (const m of pl.milestones) if (m.jit && !m.hw && m.date && ptActive(pl, m)){ const t0 = dayMs(m.date), ld = Math.max(1, ptLeadDaysOf(PP, m)); if (tNow >= t0 && tNow < t0 + ld*PT_DAY){ const r = Math.min(7, ld/2), f = Math.min(1, (tNow - t0)/(r*PT_DAY)); bp += ptBuildPts(m)/ld*f*ld/(ld - r/2); } } /* code PRs start landing over the first week of a build (the charge ramps in, total = the card points) */ s.platform.buildPts = bp; } /* v30.3-C.2: lever build effort is code PRs that deliver the lever: charged to delivery points while it is built */
  s.platform.spinDays = num(PP.spinDays) || 7; s.platform.spinCap = ptSpinCap(tNow, pl, s.platform.spinDays);
  { const ms = pl.milestones.find(m=>m.id === 'm-studio' && m.date && ptActive(pl, m)); if (ms && tNow >= dayMs(ms.date) && s.platform){ const rd = Math.max(1, num(s.platform.studioRampDays == null ? 5 : s.platform.studioRampDays)); s.platform.studioPhase = Math.max(0, Math.min(1, ((tNow - dayMs(ms.date))/PT_DAY + 1)/(rd + 1))); } }
  const F = Object.keys(PT_CONT), vals = []; let cur = Object.fromEntries(F.map(f=>[f, contGet(base, f)]));
  for (const q of pts){ cur = Object.assign({}, cur); if (ptActive(pl, q.p)) for (const op of q.p.ch || []) if (op.k === 'num' && PT_CONT[op.f]) cur[op.f] = num(op.v); vals.push(cur); }
  const a = vals[k], nx = pts[k+1], b = nx ? vals[k+1] : null;
  const t = nx && nx.x > pts[k].x ? Math.max(0, Math.min(1, (X - pts[k].x)/(nx.x - pts[k].x))) : 0;
  for (const f of F){ const v = b && t > 0 ? a[f] + t*(b[f] - a[f]) : a[f]; if (v !== contGet(base, f)) contSet(s, f, v); }
  s.waste = 100 - ptEff(base, X, pl);
  /* v30.2-B.4: banked resets are usable for bankDays from the plan start, then gone (an expiring reserve) */
  { const dd = (dayMs(ptDateOfX(pl, x0, X)) - dayMs(pl.start))/PT_DAY; const bd = Math.max(0, num((s.platform || {}).bankDays)), fb = Math.max(0, Math.min(1, (bd + 7 - dd)/14)); /* expiry unknown (A): the expected reserve fades over ±7 days around the assumed date */
    if (fb < 1) for (const p of s.providers) if (num(p.resetsBanked) > 0) p.resetsBanked = num(p.resetsBanked)*fb; }
  /* v28: efficiency work ramps in from the milestone before (a slope, not a step): its numbers move part of the way */
  if (nx && t > 0 && kAt == null && nx.p.ramp && !ptIsPhased(nx.p) && ptActive(pl, nx.p)){
    const s2 = clone(s); let ok = true; for (const op of nx.p.ch || []) if (op.k !== 'num' && ptApply(s2, op)) ok = false;
    if (ok) ptLerp(s, s2, t);
  }
  /* v28: code growth (value lens: CI/test time +growth%/month) counts the months since the plan's start */
  if (pl.grow !== false){ const mo = Math.max(0, dayMs(ptDateOfX(pl, x0, X)) - dayMs(pl.start))/(30.44*PT_DAY);
    s.value = Object.assign({}, ptVDef(), s.value || {}); s.value.months = mo;
    /* v30: the full suite grows with the merged PRs since the start (this plan's own delivery, integrated) */
    s.platform.ciCum = cumIn != null ? cumIn : ptCumFor(base, pl, X); }
  /* v29: the plan owns time: months since the start replace the setup's own "months ahead" (v28 added them on top, so a
     setup with months ahead set counted them twice and grew clones/CI far too fast: the disk limit hit 0 by July) */
  return s;
}
let ptVD = null; const ptVDef = () => ptVD || (ptVD = clone(baseDefaults().value));
/* move numbers in a toward b by t (same shape); anything else switches only at the milestone itself */
function ptLerp(a, b, t){
  for (const k of Object.keys(b)){ const x = a[k], y = b[k];
    if (typeof x === 'number' && typeof y === 'number'){ if (x !== y) a[k] = x + t*(y - x); }
    else if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y) && (!Array.isArray(x) || x.length === y.length)) ptLerp(x, y, t); }
}
/* v30: cumulative merged PRs along the plan (integrated from its own delivery, coarse steps), so faster delivery grows the
   suite sooner; and the forecast band from the model-release range (releases before X: exp(±σ√k) on AI cost per PR) */
/* v30.3-D.1: the suite-growth table lives in a context object on the plan (pl._cx = {cum}); it is not module state. A plain clone() starts with no context. A trial plan that should
   reuse the plan's table (the old module table was shared by every trial) is made with ptTrialOf(pl) or Object.assign({}, pl, ...), which share the context object; JSON and the saved state never carry it (toJSON returns undefined). ptCumMap is a pure memo keyed by content. */
const ptCumMap = new Map();
const ptCx = pl => pl._cx || (pl._cx = {cum:null, toJSON(){ return undefined; }});
const ptTrialOf = pl => { const t = clone(pl); t._cx = ptCx(pl); return t; };
/* the main plan uses the table built in renderPlan; a "Confirmed only" view and the with / without plans get their own (their
   delivery, so their suite growth, differs); just-in-time trial plans reuse the main one */
const ptCumSig = pl => JSON.stringify([pl.show, pl.start, pl.until, pl.halfLife, pl.grow, pl.milestones.map(m=>[m.id, m.date, m.on, m.status, m.ch])]);
function ptCumFor(base, pl, X){
  const main = ptCx(pl).cum, own = pl._ownCum || (main && main.show != null && (pl.show || 'all') !== (main.show || 'all'));
  if (!own) return ptCumAt(main, X);
  const sig = JSON.stringify(base).length + ':' + ptCumSig(pl); let t = ptCumMap.get(sig);
  if (!t){ t = ptCumTable(base, pl, true); if (ptCumMap.size > 12) ptCumMap.clear(); ptCumMap.set(sig, t); }
  return ptCumAt(t, X);
}
function ptCumAt(T, X){ if (!T || !T.xs.length) return 0; if (X <= T.xs[0]) return T.cum[0]; for (let i = 1; i < T.xs.length; i++) if (X <= T.xs[i]){ const t = (X - T.xs[i-1])/Math.max(1e-9, T.xs[i] - T.xs[i-1]); return T.cum[i-1] + t*(T.cum[i] - T.cum[i-1]); } const n = T.xs.length - 1; return T.cum[n] + (T.cum[n] - T.cum[Math.max(0, n-1)])/Math.max(1e-9, T.xs[n] - T.xs[Math.max(0, n-1)])*(X - T.xs[n]); }
function ptCumBuild(base, pl, noBand){ const t = ptCumTable(base, pl, noBand); ptCx(pl).cum = t; return t; }
function ptCumTable(base, pl, noBand){
  const x0 = ptX0(base), XE = ptEnd(pl), step = Math.max(5, (XE - x0)/26), xs = [], cum = [], tot = [], lo = [], hi = [];
  const dpx = ptSpan(pl)/PT_DAY/(100 - x0);
  let c = 0;
  for (let X = x0; ; X = Math.min(XE, X + step)){
    const st = ptStateAt(base, pl, X, false, undefined, c), r = compute(st);
    xs.push(X); cum.push(c); tot.push(r.total);
    const k = num(st.platform.relN);
    if (k > 0 && !noBand){ const band = f => { const s2 = clone(st); s2.platform.relFactor = (s2.platform.relFactor == null ? 1 : num(s2.platform.relFactor))*f; return compute(s2).total; };
      lo.push(band(Math.exp(-PT_REL_SIG*Math.sqrt(k)))); hi.push(band(Math.exp(PT_REL_SIG*Math.sqrt(k)))); } else { lo.push(r.total); hi.push(r.total); }
    if (X >= XE - 1e-9) break;
    c += r.total*Math.min(step, XE - X)*dpx;
  }
  return {xs, cum, tot, lo, hi, show:pl.show || 'all'};
}
function ptRun(base, pl, X, before, kAt){ const s = ptStateAt(base, pl, X, before, kAt); return {s, r:compute(s)}; }
/* one growth-path step (same rules as growthPath: one change if it lifts the total, else up to three that lift the limit in the way) */
function growthStep(s, r, opts){
  let cur = s, rc = r; const labels = []; const used = new Set(); let done = false;
  for (let k = 0; k < 3 && !done; k++){
    let m = pickMove(cur, rc, opts, 0.5);
    if (!m || !m.lifts){ const m2 = pickMove(cur, rc, opts, -0.01); if (m2 && !used.has(m2.v.label)) m = m2; else if (!m) break; }
    used.add(m.v.label); labels.push(m.v.label); cur = m.s2; rc = m.r2;
    if (rc.total - r.total >= 0.5) done = true;
  }
  return done ? {labels, s2:cur, r2:rc} : null;
}
const ptLabelOp = l => PT_LEVER_CONT[l] ? {k:'num', f:PT_LEVER_CONT[l][0], v:PT_LEVER_CONT[l][1]} : {k:'v', label:l};
/* Auto-place: walk efficiency up from the last point (2% steps). A point goes where a limit that was under its plan line
   (85%, machines at their own target) reaches it, or where what runs out first changes. There the growth-path search
   applies the cheapest change that lifts what runs out. Stops at 100% efficiency, 8 points, or when nothing lifts it. */
/* v30.2-B.6 (M3): Suggest weighs dollars against points at the milestone's own date. A milestone stays only if it adds at least sugMinPts points a day there AND costs at most
   sugMaxUsdPerPt dollars a month per point a day (free or saving money passes). A phased lever (lead + ramp) counts at the date its effect is complete. */
const ptPtsOf = (base, r) => r && r.hold && r.hold.pointsDay != null ? r.hold.pointsDay : r.total*num((base.platform || {}).ptsPerPr0 || 1.6);
const ptSugOk = (base, dp, dm) => { const P = base.platform || {}, mp = P.sugMinPts == null ? 2 : num(P.sugMinPts), mu = P.sugMaxUsdPerPt == null ? 150 : num(P.sugMaxUsdPerPt); return dp >= mp - 1e-9 && (dm <= 0.5 || dm/Math.max(1e-9, dp) <= mu + 1e-9); };
function ptMsEffDate(base, pl, m){ const PP = base.platform || {}; let t = dayMs(m.date);
  if (ptIsPhased(m)) t += (ptLeadDaysOf(PP, m) + ptRampDaysOf(PP, m))*PT_DAY;
  return isoDay(Math.min(t, dayMs(ptUntil(pl)))); }
function ptMsGain(base, pl, m){ const x0 = ptX0(base), d = ptMsEffDate(base, pl, m), X = ptXOfDate(pl, x0, d), wo = Object.assign({}, pl, {milestones:pl.milestones.filter(z=>z !== m && z.after !== m.id)}); ptSort(wo);
  const a = ptRun(base, pl, X).r, b = ptRun(base, wo, X).r; return {date:d, X, dp:ptPtsOf(base, a) - ptPtsOf(base, b), dm:a.month - b.month}; }
/* the milestones Suggest added: switched on or created by it (not on in the plan before it), proposed, dated, not yours (pinned), not a just-in-time card, release or Forge B placement */
const ptSugAdded = (pl, wasOn) => pl.milestones.filter(m=>m.status === 'proposed' && m.on !== false && m.date && !m.pinned && !m.jit && !m.release && !m.fb && !m.fc && (m.auto || !wasOn.has(m.id)));
function ptPruneAuto(base, pl, wasOn){
  for (let pass = 0; pass < 4; pass++){ let drop = null;
    for (const m of ptSugAdded(pl, wasOn).sort((a, b)=>dayMs(a.date) - dayMs(b.date))){ const g = ptMsGain(base, pl, m); m.gainPts = g.dp; m.gainUsd = g.dm; if (!ptSugOk(base, g.dp, g.dm)){ drop = {m, g}; break; } }
    if (!drop) break;
    if (drop.m.auto) pl.milestones = pl.milestones.filter(z=>z !== drop.m);
    else { drop.m.on = false; drop.m.suggested = `not suggested: at its date it adds ${fmtN(drop.g.dp, 1)} points a day for ${fmtUsd(Math.max(0, drop.g.dm))}/month (the bar: at least ${fmtN(num((base.platform || {}).sugMinPts == null ? 2 : base.platform.sugMinPts), 0)} points a day and at most ${fmtUsd(num((base.platform || {}).sugMaxUsdPerPt == null ? 150 : base.platform.sugMaxUsdPerPt))}/month per point a day)`; }
    ptSort(pl); }
}
/* v30.3-D.2: Suggest finishes on the SETTLED plan. The prune inside ptAutoPlace measures gains before the page settles the plan (token cards re-resolve there), so a card could pass at +3.7 points and add 0 points and $0 after it.
   The page calls this on the plan Suggest returned: settle, then prune at the bar (0 points and $0 never pass), then switch off any Suggest-added token card whose option resolved empty; settle again if that changed anything (cap 3). */
function ptSuggestFinish(base, pl, from){
  const wasOn = new Set((from ? from.milestones : []).filter(m=>ptActive(from, m)).map(m=>m.id));
  for (let k = 0; k < 3; k++){
    ptPrepare(base, pl); ptSettle(base, pl, {}); ptResolveTokens(base, pl);
    const sig = JSON.stringify(pl.milestones.map(m=>[m.id, m.on, m.date]));
    ptPruneAuto(base, pl, wasOn);
    for (const m of ptSugAdded(pl, wasOn)) if ((m.ch || []).some(o=>o.k === 'tokens' && !o.pick && o.best === '')){ m.on = false; m.suggested = 'no token option adds work; switched off'; }
    if (sig === JSON.stringify(pl.milestones.map(m=>[m.id, m.on, m.date]))) break;
  }
  ptPrepare(base, pl); ptSettle(base, pl, {}); return pl;
}
function ptAutoPlace(base, maxPts, from){ ptSuggestCap = true; try { return ptAutoPlace0(base, maxPts, from); } finally { ptSuggestCap = false; } }
function ptAutoPlace0(base, maxPts, from){
  const pl = from ? clone(from) : newPlan(base), x0 = ptX0(base), opts = {skip:PT_SKIP}; maxPts = maxPts || 8; const XE = ptEnd(pl);
  delete pl.base; delete pl.at;
  pl.milestones = pl.milestones.filter((m, i)=>i === 0 || !m.auto); /* keep your own milestones, replace the auto ones */
  let xc = x0, guard = 0;
  let added = 0; const tried = new Set();
  while (added < maxPts && xc < XE && guard++ < 40){
    const r0 = ptRun(base, pl, xc).r;
    const under = new Set(r0.cons.filter(c=>c.demand > 0 && Number.isFinite(c.cap) && c.cap > 0 && c.util < c.target - 1e-6).map(c=>c.key));
    const b0 = r0.binding ? r0.binding.key : '';
    let hit = null;
    for (let X = Math.min(XE, Math.floor(xc/2)*2 + 2); X <= XE + 1e-9; X = X >= XE ? XE + 1 : Math.min(XE, X + 2)){
      const {s, r} = ptRun(base, pl, X);
      const c = r.cons.find(c=>under.has(c.key) && c.demand > 0 && c.util >= c.target - 1e-6);
      if (c){ hit = {X, s, r, why:`${limitName(c)} reaches its plan line (${Math.round(c.target*100)}%)`}; break; }
      if (r.binding && r.binding.key !== b0 && !tried.has(r.binding.key)){ hit = {X, s, r, why:`${limitName(r.binding)} now runs out first`}; break; }
      if (r.binding && !tried.has(r.binding.key)){ hit = {X, s, r, why:`${limitName(r.binding)} runs out first and nothing has lifted it yet`}; break; }
    }
    if (!hit) break;
    if (hit.r.binding) tried.add(hit.r.binding.key);
    const aiBind = [hit.r.binding, ...(hit.r.tied || [])].some(c=>c && c.group === 'AI');
    /* v30.2-B.4 (operator 07:42 ET): the 3rd Claude account comes first, just in time; "Add tokens" only once Claude is at its 3 accounts */
    const cl3 = hit.s.providers.find(p=>p.id === 'claude'), c3m = pl.milestones.find(m=>m.id === 'm-claude3');
    if (aiBind && cl3 && !atMax(cl3) && c3m && ptActive(pl, c3m)){ xc = hit.X; continue; }
    if (aiBind && !(pl.dismissed || []).some(d=>d.name === 'Add tokens (best value)')){ /* v30.1 (H5): one token path */
      const z = clone(hit.s), note = ptApply(z, {k:'tokens'}), r2 = note ? null : compute(z);
      if (r2 && ptSugOk(base, ptPtsOf(base, r2) - ptPtsOf(base, hit.r), r2.month - hit.r.month)){ const date = ptDateOfX(pl, x0, hit.X);
        pl.milestones.push({id:ptId(), name:pl.milestones.some(m=>(m.ch || []).some(o=>o.k === 'tokens') && ptActive(pl, m)) ? 'Add more tokens (next best value)' : 'Add tokens (best value)', date, ch:[{k:'tokens'}], why:`${ptRunOut(ptLifted(hit.r, r2))} here; the token ranking's first option that adds ≥1/day lifts it`, auto:true, status:'proposed', on:true, gain:r2.total - hit.r.total});
        ptSort(pl); added++; xc = ptXOfDate(pl, x0, date); continue; } }
    const st = growthStep(hit.s, hit.r, opts);
    if (!st){ xc = hit.X; continue; }
    /* v28: drop any change that adds nothing on its own; the rest must lift what binds here by at least 1 PR a day */
    let labels = st.labels.slice();
    const runL = ls => { const z = clone(hit.s); for (const l of ls){ const op = ptLabelOp(l); if (op.k === 'num') contSet(z, op.f, op.v); else ptApply(z, op); } return compute(z); };
    let full = runL(labels);
    for (const l of st.labels.slice()){ if (labels.length < 2) break; const rest = labels.filter(z=>z !== l), rr = runL(rest); if (rr.total >= full.total - 0.5 && rr.planTotal >= full.planTotal - 0.5){ labels = rest; full = rr; } }
    const date = ptDateOfX(pl, x0, hit.X);
    const cand = {id:ptId(), name:labels.join(', then '), date, ch:labels.map(ptLabelOp), why:`lifts ${ptLifted(hit.r, full)}, which runs out first here` + (/reaches its plan line/.test(hit.why) ? ` (found where ${hit.why})` : ''), auto:true, status:'proposed', on:true};
    if ((pl.dismissed || []).some(d=>d.name === cand.name || d.name === labels.join(', then '))){ xc = hit.X; continue; } /* v29: you deleted it before */
    const trial = ptTrialOf(pl); trial.milestones.push(cand); ptSort(trial);
    const Xd = Math.max(hit.X, ptXOfDate(trial, x0, date)), r0d = ptRun(base, pl, Xd).r, rt = ptRun(base, trial, Xd).r, gain = rt.total - r0d.total, gainP = rt.planTotal - r0d.planTotal;
    /* machines count when they lift plan for (they bind at their targets); anything else must add 1 PR a day */
    const hwL = labels.some(l=>/server|Studio|machine|CI on|[Dd]aemon|lane images/.test(l));
    if (!ptSugOk(base, ptPtsOf(base, rt) - ptPtsOf(base, r0d), rt.month - r0d.month)){ xc = hit.X; continue; } /* not suggested: under the points / dollars bar here (v30.2-B.6) */
    cand.gain = gain;
    pl.milestones.push(cand);
    ptSort(pl); added++;
    xc = ptXOfDate(pl, x0, date);
  }
  /* engine-suggested dates of proposed milestones are re-suggested on the new plan (dates you set are kept) */
  for (const m of pl.milestones) if (m.suggested && !m.auto){ m.date = ''; }
  ptSuggestDates(base, pl);
  ptPruneAuto(base, pl, new Set((from ? from.milestones : []).filter(m=>ptActive(from, m)).map(m=>m.id))); /* v30.2-B.6 (M3): on the final plan, every milestone Suggest added must clear the bar at its own date */
  /* B.4: Suggest never keeps Forge A past its cancel milestone and never adds Forge B beside it (Forge B is placed just in time by ptPlaceForgeB) */
  pl.sel = [0, Math.min(1, pl.milestones.length - 1)];
  return pl;
}
/* chart samples: every 2% (5% while dragging) plus both sides of every point */
const PT_HW = {has:k=>/^(cpu|ram)(:|-|$)/.test(k)}; /* pooled machine limits: shown per machine instead */
function ptSamples(base, pl, coarse){
  const x0 = ptX0(base), pts = ptPts(pl, x0), XE = ptEnd(pl), step = coarse ? 5 : 2, xs = [];
  for (let x = x0; x < XE - 1e-9; x += step) xs.push({X:x, before:false});
  xs.push({X:XE, before:false}); if (XE > 100) xs.push({X:100, before:false});
  for (const q of pts.slice(1)){ xs.push({X:q.x, before:true}); xs.push({X:q.x, before:false}); }
  /* short stages still get a few points inside, so their slope shows on the milestone axis */
  if (!coarse){ const ks = [...new Set([x0, ...pts.map(q=>q.x), 100, XE])].sort((a, b)=>a - b);
    for (let i = 0; i + 1 < ks.length; i++) for (const f of (ks.length > 16 ? [0.5] : [0.25, 0.5, 0.75])) if (ks[i+1] - ks[i] > 0.05) xs.push({X:ks[i] + f*(ks[i+1] - ks[i]), before:false}); }
  xs.sort((a, b)=>a.X - b.X || (a.before === b.before ? 0 : a.before ? -1 : 1));
  const out = []; const seen = new Set();
  for (const e of xs){ const k = e.X.toFixed(4) + (e.before ? 'b' : 'a'); if (seen.has(k)) continue; seen.add(k);
    out.push(ptSampleOf(base, e.X, e.before, ptRun(base, pl, e.X, e.before).r, pl)); }
  return out;
}
/* one chart sample from an engine result (v29.1: shared by the chart and the hover readout's exact value at rest) */
function ptSampleOf(base, X, before, r, pl){
  const lim = {};
  for (const c of r.cons) if (c.demand > 0 && Number.isFinite(c.limit) && !PT_HW.has(c.key) && !/^h:/.test(c.key)) lim[c.key] = {v:c.limit*r.per, name:limitName(c), kind:kindOf(c), grp:c.group === 'AI' ? 'ai' : 'flow'};
  const u = {}; /* v30 usage panel: CI / merge queue / API and flow slots, % of capacity */
  for (const c of r.cons) if ((c.group === 'GitHub' || c.group === 'Concurrency' || c.group === 'People') && c.demand > 0 && Number.isFinite(c.cap) && c.cap > 0) u[c.key] = {u:c.util, name:limitName(c), kind:kindOf(c)};
  const mq = r.cons.find(c=>c.key === 'merge');
  return Object.assign({X, before, total:r.total, plan:r.planTotal, month:r.month, kind:kindOf(r.binding), bind:limitName(r.binding), lim, u, suite:mq ? mq.suiteMin : null, eff:ptEff(base, X, pl), h:zvH(r)}, ptMachSample(r));
}
/* per machine: the most PRs a day before it passes its own target (engine machineRows), and busy share now; AI plans: busy */
function ptMachSample(r){
  const mach = {}, ai = {};
  for (const m of r.machines || []) mach[m.id] = {name:m.name, on:m.on, parked:m.parked, active:m.active, v:m.on && !m.parked && m.active && Number.isFinite(m.planR) ? m.planR*r.per : null, busy:m.busyShown != null ? m.busyShown : m.busy, basis:m.basis, target:m.target, carries:m.carries, cpu90:m.cpu90, ram:m.ws ? {gate:m.ws.ramGate, total:m.ws.ramGb, floor:m.ws.ramFloor, admit:m.ws.admit, by:m.ws.admitBy, running:m.ws.running} : null};
  for (const c of r.cons) if (c.group === 'AI' && c.provider && (c.demand > 0 || c.fixed)) ai[c.key] = {name:short(c.name), busy:c.util, shown:aiShown(c), target:c.target};
  return {mach, ai, planBy:r.planBy ? r.planBy.name : ''};
}
/* busy share per limit at a point's own delivery level (v26 "Load by delivery level" computation) */
function ptBusy(s, r){
  const x = loadAt(s, r.total, r), rows = {};
  /* v30.2-B.4: one reading per machine and resource, always the busy hour (p90); the daily mean is a second line elsewhere */
  for (const m of x.ws || []) if (m.on && !m.parked && m.active && m.role !== 'tests' && m.ws){
    rows['cpu90:' + m.id] = {name:`${short(m.name)} load, busy hours (p90)`, u:m.cpu90, t:m.target};
    rows['ram90:' + m.id] = {name:`${short(m.name)} RAM, busy hours`, u:m.ws.ramGate/m.ws.ramGb, t:1 - m.ws.ramFloor/m.ws.ramGb}; }
  for (const m of r.machines || []) if (m.on && !m.parked && m.active && m.role === 'tests' && Number.isFinite(m.busy)) rows['mach:' + m.id] = {name:`${short(m.name)} load, busy hours (p90)`, u:m.busy, t:m.target};
  for (const [k, c] of Object.entries(x.u)) if (k !== 'cpu-d' && k !== 'ram-d' && !PT_HW.has(k)) rows[k] = {name:/^p:/.test(k) ? short(c.name) + ' tokens' : String(c.name).replace(/^(CPU|RAM|Disk), (.+)$/, '$2 · $1'), u:c.util, t:c.target};
  const dk = r.cons.find(c=>c.key === 'disk');
  return {rows, nOpen:x.laptop ? x.laptop.nOpen : r.parts.nOpen*r.R, diskGb:dk ? r.R*dk.demand + (dk.fixed||0) : null};
}
/* ---------- v30.2-B: semantic zoom, levels L0 and L1 (Fable round 5 design, approved by the operator 21:13 ET) ----------
   L0: the hero pair (time to merge, parallel scopes, = merged PRs a day), one bold merged line, two thin lanes (H and P), a
   colour strip for what limits merged PRs, and milestone chips (−X h / +Y scopes). L1 "Time to merge": the six bands of H over
   time (they sum to H), the waterfall at the chosen date and the levers that cut the most hours. L1 "Parallel scopes": held
   scopes and the parallelism limits (scope, machines, tokens, plus the open-PR policy), the limits at the date and the levers
   that add the most scopes. Rule: ≤1 bold + ≤6 series per level. Route in the hash (#z=…&d=…&t=…): breadcrumbs, Esc and Back.
   L2/L3 (term drills, per-machine and per-plan families, the full inspector) are the next steps: chevrons say "more below". */
const ZV_BANDS = [
  {k:'work', name:'Build + local tests', terms:['build', 'tests'], what:'the builder writes the change and runs the local tests', col:'var(--zb1)', params:['hTestMin', 'hTestInBuild', 'hCmdMin', 'prLines']},
  {k:'ci', name:'CI + red-CI heals', terms:['ci', 'reci', 'heal'], what:'the first PR CI run, the re-runs after each fix, and healing red CI', col:'var(--zb2)', params:['hHeal', 'ciSpeed', 'hFixRounds0', 'ciGrowth']},
  {k:'rev', name:'Review + fix rounds', terms:['review', 'fix', 'conflict'], what:'review runs, fix rounds and extra conflicts', col:'var(--zb3)', params:['hFixMin', 'hFixRounds0', 'prLines', 'conflictMin']},
  {k:'hand', name:'Hand-off waits', terms:['wReview', 'wFix', 'wCi', 'wRun', 'wPeople'], what:'waiting for a reviewer, a fixer, CI after a fix, a GitHub runner or a busy reviewer', col:'var(--zb4)', params:['hWaitReview', 'hWaitFix', 'hWaitCi', 'openRef']},
  {k:'tail', name:'After acceptance', terms:['wMq', 'tail', 'wMqQ', 'mq', 'eject'], what:'held after acceptance (approvals, stacked PRs, parked, red main), the merge-queue CI run (the full suite) with its ejections and retries, and the landing', col:'var(--zb5)', params:['hWaitMq', 'hTail', 'hMqClean', 'hMqEntries', 'mqFail', 'mqCiMin', 'hEjectPrShare', 'hEjectRework']},
  {k:'util', name:'Waiting for our own machines', terms:['wMach'], what:'heavy tests admitted one by one on the Laptop, Studio or Forge: the busier the machine, the longer a test run waits for its turn; it grows with load', col:'var(--zb6)', params:['cpuRefRho', 'hCmdMin', 'forgeShare', 'ciGrowth']}
];
/* the hold summary carried by every chart sample */
function zvH(r){
  const h = r && r.hold; if (!h) return null;
  const tm = {}; for (const t of h.terms) tm[t.k] = t.min;
  const b = ZV_BANDS.map(B=>B.terms.reduce((a, k)=>a + (tm[k] || 0), 0));
  const RP = Number.isFinite(h.Pmin.v) ? h.Pmin.v*DAY/h.H : Infinity;
  let rl = null; for (const x of h.rate) if (!rl || x.R < rl.R) rl = x;
  const rateB = !!(rl && rl.R < RP*0.99), rc = rateB ? r.cons.find(c=>c.key === rl.key) : null;
  const pk = rateB ? 'rate' : h.Pmin.k === 'supply' ? 'scope' : (h.Pmin.k || 'scope');
  const rnm = x => limitName(r.cons.find(c=>c.key === x.key) || {name:x.name});
  const tied = rateB ? h.rate.filter(x=>x !== rl && x.R <= rl.R*1.01).map(rnm).concat(RP <= rl.R*1.01 ? [h.Pmin.nm] : []) : (h.Pmin.tied || []).concat(h.rate.filter(x=>x.R <= RP*1.01).map(rnm));
  return {H:h.H, open:h.open, pre:h.pre, held:h.held, R:r.R, total:r.total, pts:h.pointsDay, b, P:{scope:Math.min(h.P.scope, h.P.supply), overlap:h.P.scope, supply:h.P.supply, machine:h.P.machine, token:h.P.token, policy:h.P.policy},
    pk, pnm:rateB ? limitName(rc) : h.Pmin.nm, tied, scopeBy:'disjoint files', machNm:(h.P.names || {}).machine || 'Machines'};
}
/* B.4 (operator ruling 07:47 ET): the only two end states are no Forge ("Studio only") and Forge B alone ("Studio + Forge B, tests only"); both side by side at the end of the plan */
let zvDecC = null, ptFbC = null;
/* v30.2-B.6 (M4): the ONE Forge B number. Forge B's effect = the plan with Forge B minus the plan without it, on the same date (the plan's end), each plan growing the suite with its own merges.
   The decision line, the "Should I do this?" card for Forge B and the test hook all read it from here. */
function ptForgeBEffect(base, pl){
  const ck = hooks.cacheKey(), key = ck == null ? null : ck + '|' + (pl.show || ''); if (key != null && ptFbC && ptFbC.key === key) return ptFbC.v;
  let v = null;
  try { const fb = pl.milestones.find(m=>m.id === 'm-msa2'), pm = pl.milestones.find(m=>m.id === 'm-msa2-place');
    if (fb && pm){ const X = ptEnd(pl), d = ptUntil(pl);
      const run = withB => { const tr = clone(pl); delete tr.base; delete tr.at; delete tr.view; delete tr.ww; for (const z of tr.milestones){ if (z.id === 'm-msa2' || z.id === 'm-msa2-place'){ z.on = withB; z.pinned = true; if (withB && (!z.date || dayMs(z.date) >= dayMs(ptUntil(pl)) - PT_DAY)){ const cx = tr.milestones.find(q=>q.id === 'm-cancel-forge'); z.date = isoDay(Math.min(dayMs(ptUntil(pl)), (cx && cx.date ? dayMs(cx.date) : dayMs(pl.start)) + (z.id === 'm-msa2' ? 14 : 21)*PT_DAY)); } } }
        ptSort(tr); tr._ownCum = true; const at = XX => { const r = ptRun(base, tr, XX).r; return {n:r.total, pts:ptPtsOf(base, r), h:r.hold ? r.hold.H/60 : NaN, m:r.month}; }; return at; };
      const aw = run(true), ao = run(false), w = aw(X), o = ao(X); v = {date:d, with:w, without:o, dn:w.n - o.n, dpts:w.pts - o.pts, dm:w.m - o.m};
      /* v30.3-C.2 (review C.1 item 7): the answer reads Dec 1, the peak benefit and the end (it said only the end: +0 while Dec 1 was +5) */
      const x0 = ptX0(base), pt = XX => { const a = aw(XX), b = ao(XX); return {X:XX, date:ptDateOfX(pl, x0, XX), with:a.pts, without:b.pts, dpts:a.pts - b.pts}; };
      v.dec = pt(Math.min(X, ptXOfDate(pl, x0, '2026-12-01'))); let pk = v.dec; const st = Math.max(4, (X - x0)/24); for (let XX = x0 + st; XX < X - 1e-9; XX += st){ const q = pt(XX); if (q.dpts > pk.dpts + 1e-9) pk = q; } v.peak = pk; v.end = pt(X); } } catch(e){ v = null; }
  if (key != null) ptFbC = {key, v}; return v;
}
/* the "Add tokens (best value)" milestones: rank the options on the state just before each one; the cheapest valid one
   is the default (op.best, stored so every run of the plan uses the same choice); op.pick is your override */
const ptTokOpts = {}; let ptTokSig = '';
function ptResolveTokens(base, pl){
  const sig = JSON.stringify(base) + JSON.stringify(pl.milestones.map(m=>[m.id, m.date, m.status, m.on, (m.ch || []).map(o=>o.k === 'tokens' ? ['tokens', o.pick || ''] : o)])) + pl.show + pl.tunedBy;
  if (sig === ptTokSig) return; ptTokSig = sig;
  const x0 = ptX0(base), pts = ptPts(pl, x0);
  pts.forEach((q, i)=>{ for (const op of q.p.ch || []) if (op.k === 'tokens'){ const sAt = ptStateAt(base, pl, q.x, false, i - 1), opts = ptTokenOptions(sAt); ptTokOpts[q.p.id] = opts; opts.state = sAt; const okO = opts.filter(o=>o.ok); op.best = okO[0] ? okO[0].id : ''; op.second = okO[1] ? okO[1].id : '';
      if (!okO.length && !op.pick && !q.p.pinned && q.p.status === 'proposed' && q.p.on !== false && q.p.auto){ q.p.on = false; q.p.autoOff = true; q.p.suggested = 'not suggested: on the final plan no token option adds 1 PR a day here; switched off'; } } });
}
/* ---------- accessors for module state the page needs (module variables cannot be re-assigned from outside) ---------- */
const getPS = () => PS;
const setPS = d => { PS = d; };
const getCum = pl => ptCx(pl).cum; /* the suite-growth table last built for this plan (or the plan it was derived from) */
/* the plan stored on a state, created from its start base on first use (was ptPlan() in the page) */
function ensurePlan(s, today){ if (!planOf(s)){ const from = s.plan && s.plan.from; s.plan = {from}; s.plan = newPlan(ptStartBase(s), today); if (from) s.plan.from = from; } return s.plan; }
/* the steps the page runs before it settles a plan (was inline in renderPlan): upgrade seeds, date the open cards, resolve token options, set the current plan */
function ptPrepare(base, pl){ ptUpgrade(base, pl); if (pl.milestones.some((m, i)=>i && !m.date)) ptSuggestDates(base, pl); ptResolveTokens(base, pl); }

export {planOf, ZV_ENV, ptSupplyCapOld, fmtN, FMT_NF, supplyP, M, A, D, num, applyCal, ptFirstFullOff, ptFirstFull, PT_DAY, limitName, short, isoDay, ptXOfDate, ptSpan, dayMs, ptEnd, ptUntil, ptRun, compute, engFreeze, ENG_MEMO_MAX, computeRaw, withConflicts, DAY, stageWall, queueExtra, withRate, rateParams, withHold, linesRatio, holdTerms, overlapP, scopeN, scopeQ, holdUAt, sak, hqLq, holdTree, hCores, stageCount, mixRho, computeFixed, hostMonthly, optMonthly, machineRows, limitOfFn, footPerMerge, footFixed, supplyMin, fmtN0, provCap, TIER_LABEL, TIER, effOf, stageAi, stageDaily, stageRuns, computeFill, maxFlow, applyValue, modelK, MODELS, OPUS_REF, fullMinOf, ciCumOf, roundsF, applyOpus, opusFactor, ENG_MEMO, ptStateAt, ptCumFor, ptCumBuild, PT_REL_SIG, clone, jclone, ptX0, ptCumMap, ptCumSig, ptCumAt, ptVDef, baseDefaults, defaults, baseDefaultsImpl, OPUS_SRC, ptDateOfX, ptEff, ptHL, PT_HL_DEF, PT_HL_CONS, ptMoOfX, contSet, contGet, PT_CONT, ptSpinCap, PT_HIST, ptBuildPts, PT_JIT, ptLerp, ptApply, maxWhy, atMax, TOKEN_OPTS, ptTokenBest, variants, ptActive, ptNewHw, ptRampDaysOf, ptLeadDaysOf, ptIsPhased, ptPts, ptSettle, ptReact, ptReactPick, ptPtsOf, ptPayOf, ptSort, ptJitLead, ptDeclineScan, ptLimCls, ptResolveTokens, ptTokOpts, ptTokenOptions, ptSettleTokens, ptPlaceTokens, fmtUsd, fmtDay, ptSugOk, ptGain, ptOpsOf, ptTokenBind, ptBindCache, ptTokenBasis, ptRecheck, ptSuggestDates, ptSuggestDates0, ptRunOut, ptLifted, ptBindTxt, ptHwOp, FOOT_LEVERS, PT_SUPPLY_OP, ptPlaceForgeC, ptStratsBefore, ptIsStrat, ptStratPaying, ptMinPts, ptPlaceForgeB, ptJitPlace, ptLevEffect, ptCoreH, ptMsEffDate, PT_JIT_LIM, ptMonday, PT_GROW, PT_BIG, ptSuiteOf, ptMachSample, aiShown, claudeShare, ptBusy, PT_HW, loadAt, ptId, ptTrialOf, ptSeedReleases, PT_RELEASES, ptDefUntil, ptPosOfEff, ptSugAdded, ptPruneAuto, ptMsGain, growthStep, pickMove, growthPath, kindOf, applyProject, SAFETY_POOLS, POOL_NAMES, pathTarget, ptToday, presetToday, planBase, ptStartBase, ptBase, ptSampleOf, zvH, ZV_BANDS, ptSamples, ptOpLabel, PT_PLACE, ptHwViolations, ptStratOnly, ptStratC, ptLevShift, ptForgeBNeed, ptNeedC, ptShiftC, ptForgeBEffect, ptAutoPlace, ptAutoPlace0, ptSuggestFinish, ptLabelOp, PT_LEVER_CONT, PT_SKIP, newPlan, PT_V302_SEEDS, ptSeedForgeC, ptSeedForgeB, ptSeedStudioFirst, ptUpgrade, PT_GONE, presetStretch, presetEnd, presetPlatform, presetRecs, migrate, renOld, renOld2, OLD_NAMES, hooks, getPS, setPS, getCum, ptCx, ptCumTable, ensurePlan, ptPrepare};
