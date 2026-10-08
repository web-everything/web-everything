#!/usr/bin/env node
/**
 * @file scripts/operations/deliver-item-wrapper.mjs
 * @description The wrapper a MINIMAL delivery agent (`we:skills-src/conveyor/delivery-agent-brief-v2.md`) runs
 * under — designed as a #3627 sketch, WIRED INTO THE LIVE `build` DISPATCH PATH by #3645 (2026-09-12).
 *
 * ================================================================================================
 * WIRING STATUS, READ THIS FIRST — CORRECTED 2026-09-12 (#3645, epic #3383). The paragraph that used to sit
 * here said this file "is NOT wired into `we:scripts/operations/dispatch-lane.mjs`, is NOT imported by
 * anything, and NOT covered by tests". Two of those three are now false, and the third was already:
 *   • {@link deliverItem} IS the default `build` dispatch path. `we:scripts/operations/dispatch-lane-io.mjs`'s
 *     sink routes a `build` launch to `deliverItemDetachedProvider`, which starts
 *     `we:scripts/operations/deliver-item-run.mjs` — a DETACHED per-dispatch process — and that file is this
 *     one's only production caller. `WE_BUILD_DISPATCH_MODE=agent` restores the old `claude --bg` + full-brief
 *     spawn; nothing else does.
 *   • WHY DETACHED, and not called inline the way the review wrapper is: the arc below BLOCKS for up to an hour
 *     and the dispatch path is a synchronous `execFileSync` inside the resident runner's own tick. See
 *     `deliver-item-run.mjs`'s own header for the full restart-survival reasoning — it is an acceptance
 *     criterion of #3645, not a style preference.
 *   • `we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs` has covered this file since #3627;
 *     `we:scripts/operations/__tests__/dispatch-lane-build-wiring.test.mjs` covers the wiring itself.
 *
 * The REAL/SKETCH/PLACEHOLDER labels below are kept verbatim and still mean what they say — several functions
 * are genuinely unverified against a live run, and per `we:docs/agent/prototype-based-dev.md` this path is not
 * trusted on passing tests alone. Every function below is marked with one of:
 *   REAL      — the shell-out uses a CLI surface this session read directly (usage strings, or a working
 *               example) from the live scripts it calls, and the call shape is correct as written.
 *   SKETCH    — the call shape is my best-informed guess at the real API (I read adjacent code, but not
 *               enough of the target file to be sure of every flag/return shape), and would need
 *               verification against the real function before this is wired in.
 *   PLACEHOLDER — deliberately unresolved design question, stubbed so the control flow reads top-to-bottom;
 *               see the inline TODO for what actually needs deciding.
 * ================================================================================================
 *
 * THE SHAPE, IN ONE PARAGRAPH. Today, `we:scripts/operations/dispatch-lane.mjs` spawns a `claude --bg`
 * process directly, handing it the ENTIRE 527-line brief as its prompt — acquire, claim, readiness, build,
 * gate-poll, converge, PR, label, escalate, learnings-drop are ALL the agent's own responsibility. This
 * wrapper is what runs INSTEAD of that spawn: it does the mechanical acquire/claim/gate/PR/label/escalation
 * work itself, in its OWN process (never inside the agent's turn budget, never subject to the
 * `PreToolUse(Bash)` guard that only fires inside a live Claude Code session's own tool calls — see the note
 * on `runGate` below), and only asks the agent to do the one thing that is actually judgment: build the item
 * and report a three-value outcome.
 *
 * SIX FIRM REQUIREMENTS, applied throughout (not open questions — stated by the operator across three rounds
 * of follow-up after this session's first draft, and this version is written to satisfy all six):
 *   1. The agent never initiates `/converge` or any review of its own diff — see `runConverge` below, called
 *      ONLY by this wrapper, never by the agent.
 *   2. The agent never opens or watches its own PR — see `openPr` below, likewise wrapper-only.
 *   3. The mechanical layer (this file) drives review, PR lifecycle, and verification, end to end. The
 *      agent's job is exactly: build, report. Nothing else appears in
 *      `we:skills-src/conveyor/delivery-agent-brief-v2.md`.
 *   4. NO POLLING anywhere in this flow — not by the agent, and not by this wrapper standing in for it. Every
 *      wait below is a single BLOCKING call (`execFileSync` inside `defaultSpawnAgent`/`run`) that returns
 *      exactly when the underlying process ends — the return itself IS the notification. Where the agent
 *      needs a result mid-run (the gate came back red), the wrapper does not re-poll the agent for progress —
 *      it RESUMES the agent's own session with the actual result already in hand (`resumeAgentWithGateFailure`),
 *      exactly once, and that resume call is itself blocking, not a fire-and-check loop. An earlier draft of
 *      this sketch had the wrapper poll a report file in a loop after a `--bg` spawn; that was wrong — it
 *      just moved the poll to a different process — and is corrected below (see `runAgentToCompletion`).
 *   5. The agent gets NO knowledge of the mechanical/delivery system at all — not "minimal doctrine", NOTHING:
 *      no lanes, no dispatch, no PR mechanics, not even that a "conveyor" exists. Not just the operator's
 *      PERSONAL `~/.claude/CLAUDE.md` (interactive-collaboration preferences, irrelevant to an autonomous
 *      build) — the repo's own `we:CLAUDE.md` → `we:AGENTS.md` → `we:docs/agent/*.md` doctrine chain and the
 *      project's `.claude/skills/` auto-discovery listing too. See `CLAUDE_RESTRICTED_PROVIDER` below for the
 *      concrete, VERIFIED mechanism (`--restricted` + an explicit `--tools` allowlist + `--strict-mcp-config`
 *      + `--disable-slash-commands` + a TRIMMED `--settings` file carrying ONLY `guard-lane.mjs`/
 *      `guard-bash.mjs`). A PRIOR revision of this file used `--bare` for this, then a REAL prerequisite gap
 *      surfaced (`--bare` requires `ANTHROPIC_API_KEY`/`apiKeyHelper` — it never reads the keychain, so it
 *      cannot ride the operator's own OAuth/subscription auth). The FIRST replacement candidate, `--safe-mode`,
 *      was independently smoke-tested (not just help-text-read) and FAILED the safety-hooks requirement: a
 *      `--settings=<hooks file>` layered on top of `--safe-mode` never fires — confirmed by running a real
 *      denied command (a hand-set git-commit identity override, which `guard-bash.mjs` denies) through
 *      `claude --safe-mode --settings=<real hooks file> -p ...` and observing it actually EXECUTE (git ran
 *      for real and failed only because nothing was staged — `permission_denials: []`, no hook fired) where
 *      the identical command under `--restricted --tools=<allowlist> --settings=<same file>` was correctly
 *      BLOCKED with `guard-bash.mjs`'s own deny text. `--restricted`'s own `claude --help` text is the reason:
 *      it explicitly documents "managed settings and --settings still apply", where `--safe-mode`'s help text
 *      lists hooks among the customizations it disables and makes no such carve-out for `--settings`. See
 *      `CLAUDE_RESTRICTED_PROVIDER`'s own docblock below for the full verification trail (auth-without-a-key,
 *      hooks-firing, and `--resume`, each independently re-run against the real CLI, not assumed from a single
 *      earlier text-only probe).
 *   6. PROVIDER PARITY — the minimal-context spawn mechanism must be a swappable PORT, not Claude-CLI flags
 *      hardcoded into this file's core control flow, mirroring the SAME provider-port pattern already
 *      extracted for `we:scripts/operations/dispatch-lane-io.mjs`'s dispatcher seam (#3579, `provider` param
 *      on `createDispatchSinks`) and `we:scripts/operations/cli-adapter.mjs`'s judge seam (#3370,
 *      `createDefaultJudge`'s injected implementation) — both landed, both real. Applied here: see
 *      `DeliveryAgentProvider` below — BOTH implementations are now REAL and independently CLI-verified:
 *      `CLAUDE_RESTRICTED_PROVIDER` (Claude, v2.1.266) and, since #3580, `CODEX_PROVIDER` (codex-cli 0.153.4).
 *      The Codex one was a deliberately-throwing named seam until its three unknowns — write-capable flags, a
 *      genuinely blocking foreground invocation, and what replaces the Claude-only `guard-lane.mjs`/
 *      `guard-bash.mjs` hooks — were each answered by real live invocations rather than guessed; the whole
 *      evidence trail lives in `we:scripts/operations/codex-delivery-provider.mjs`'s own file header. Claude
 *      remains the DEFAULT (see `DEFAULT_DELIVERY_AGENT_PROVIDER_NAME`); Codex is opt-in by name, and the
 *      operator chose to build it ahead of `#3581`'s ratified reviewer-first sequencing gate knowingly.
 */
import { machinePrTitle, readMainCard } from './machine-pr-title.mjs';
import { randomUUID } from 'node:crypto';
import { admissionLockRoot } from '../readiness/heavy-admission.mjs';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename, join, resolve as resolvePath } from 'node:path';

// REAL — every one of these is an existing exported function this session read directly.
// #3383 — delivery telemetry. `createTelemetryRecorder` mints this dispatch's trace; `setActiveRecorder`
// installs it so the shared helpers in `minimal-context-provider.mjs` emit into it without being passed one;
// `spanAround` wraps a single existing call in a span without changing its behaviour. All three are
// never-throwing by construction — see `telemetry-store.mjs`'s purity discipline.
import { recorderFor, setActiveRecorder, spanAround, resolveTurnCpuAttributes, recordChildResourceUsage } from './telemetry-store.mjs';
import { spawnAgentToCompletion, findItem, defaultLoadItems } from './dispatch-lane-io.mjs';
import { markWorkerEnv } from './session-role.mjs';
// #landing-freeze-2779 — `runConvergeEdit`'s own `claude` spawn (below) builds its env straight off
// `process.env` with no sanitize step at all, unlike this file's OTHER `claude`/`codex` spawns which already go
// through `spawnAgentToCompletion`'s own internal `sanitizeSpawnEnv` call. This wrapper's own process can live
// long enough (up to ~56 minutes for the converge loop alone, per this file's own docblock) for a static,
// daemon-minted `GH_TOKEN` inherited at wrapper-fork time to expire mid-round. See
// `../lib/gh-app-shim.mjs#sanitizeSpawnEnv`'s own docblock and `detached-dispatch.mjs#defaultSpawnDetached`'s
// (the fix for the sibling gap this same incident, #landing-freeze-2779, found in the wrapper's own fork).
import { sanitizeSpawnEnv } from '../lib/gh-app-shim.mjs';
import { extractSubmitResult } from './open-pr.mjs';
import { fillBrief } from './dispatch-lane.mjs';
import { tryReadDeliveryReport, resolveDeliveryReportsDir } from './delivery-report-store.mjs';
import { tryReadCompletion } from './completion-store.mjs';
import {
  STRUCTURED_OUTPUT_SUFFIX, runWorker, withStructuredOutput, workerWrapperEnabled,
} from './worker-wrapper.mjs';
import { isPolicyCorePath } from '../lib/gate-config.mjs';
import { isStatutePath, scoreEscalation, producerReviewLabel } from '../lib/review-escalation.mjs';
import { isAllowlistedLitterPath } from '../lib/lane-litter.mjs';
// xftsbsg (epic #3383) — WHICH REPO's own primary checkout the Codex sandbox deny-map must seal off, given
// nothing but the lane's own resolved path. See {@link primaryCheckoutForLanePath}'s own header: without this,
// `defaultDeliveryDenyPaths()` defaults to ITS OWN module's checkout root, which is always WE (these scripts
// live only in `we:scripts/operations/`), so a frontierui/plateau-app build denied the wrong repo's primary
// checkout entirely — the one the deny-map exists to seal off was left wide open to the Codex sandbox.
import { primaryCheckoutForLanePath, repoProfileForLanePath, deliveryLocusForScope, repoProfile } from '../lib/repo-profile.mjs';
// #4349 — settle this delivery's OWN run-store effect on exit (see that file's own header for why this is
// the thin seam, not a new store) and release/hold the build-dispatch claim a finished no-op dispatch used to
// leave stranded for hours (`we:scripts/conveyor/build-dispatch-claim.mjs`'s own #4349 note).
import { resolveRunsDir } from './run-store.mjs';
import { settleDispatchEffect } from './deliver-item-settle.mjs';
import { releaseBuildDispatchClaim, placeBuildDispatchHold } from '../conveyor/build-dispatch-claim.mjs';

/** The positional `outcome` always wins over anything `result` supplies — merge order enforces it rather than
 *  relying on every call site's convention of never putting `outcome` in `result` itself. Exported as its own
 *  pure function so that guarantee is directly testable without needing a real call site to break convention. */
export function mergeSettleResult(outcome, result) {
  return { ...(result || {}), outcome };
}
// #3383 mechanical-dispatcher fix (live #3565 trial) — the REAL locus-prefix detector, reused so
// `sanitizeOwnLocusMentions` below prefixes every bare mention the `lint:locus` pre-commit hook would
// itself flag, not just mentions of the delivery's own touched paths (see that function's own header).
import { findUnmarkedLocusRefs } from '../check-standards-rules.mjs';
// #xu2pp2m — EXTRACTED to the shared module both this wrapper and `we:scripts/operations/
// review-dispatch-wrapper.mjs` now import: the proven `CLAUDE_RESTRICTED_PROVIDER` argv shape, hooks-settings
// generation, lane acquire/release, and the gate-running pattern. See that file's own header for why. Every
// name below is a REAL, unit-tested export this file already trusted before the extraction — nothing about
// their own behaviour changed, only where they are defined.
import {
  REPO_ROOT, run, RESTRICTED_PROVIDER_TOOLS, buildRestrictedProviderArgv, createHooksSettingsWriter,
  persistSpawnFailure, acquireLane, resetStaleVerifyMarker, releaseLane, releaseAllPools, resolveLanePath,
  runVerifyOperation, laneHasCommitAhead,
} from './minimal-context-provider.mjs';
// #3580 — the REAL Codex implementation of the `DeliveryAgentProvider` port below. Its own file header carries
// the full live-verification trail (which flags, which invocation blocks, and what replaces the Claude-only
// `guard-lane.mjs`/`guard-bash.mjs` hooks); `CODEX_PROVIDER` further down is the thin composition of these.
import {
  buildCodexDeliveryArgv, defaultSpawnCodexAgent, parseCodexThreadId, readCodexThreadId, writeCodexThreadId,
  defaultDeliveryDenyPaths, assertDenyPathsUsable, recordCodexTurnUsage,
  CODEX_DELIVERY_MODEL, CODEX_DELIVERY_EFFORT,
} from './codex-delivery-provider.mjs';
// #3383 mechanical-dispatcher Bug 2 fix — THE missing run-quality recording call: `appendScorecard`
// (`run-scorecard-store.mjs`) had zero real callers before this; see `run-quality-record.mjs`'s own header.
import { recordCodexRunScorecard } from '../conveyor/run-quality-record.mjs';
// #3903 main adaptation — the #3690 delegation marker a non-Claude build's PR carries (see `delegationForBuild`).
import { buildDelegationMarker, DELEGATION_TASK_TYPES } from '../lib/delegation-marker.mjs';
import { taskTypeFor } from '../lib/dispatch-task-type.mjs';
// RE-EXPORTED so every existing caller/test that imports these names from THIS file (their pre-extraction
// home) keeps working unchanged — the extraction moved WHERE they are defined, never what imports them.
export {
  acquireLane, resetStaleVerifyMarker, resolveLanePath, runVerifyOperation, buildRestrictedProviderArgv,
  laneHasCommitAhead,
};

// #xu2pp2m — `RESTRICTED_PROVIDER_TOOLS` now imported from `./minimal-context-provider.mjs` (see the import
// block above) instead of declared here — `DELIVERY_HOOKS_SETTINGS`'s `permissions.allow` (bug 8, see that
// constant's own docblock) still derives from this SAME string, just from its shared home.

// ================================================================================================
// 0. The minimal-context hook settings file — REAL SCHEMA, closes the "cost 1" gap the first draft of this
//    sketch left open. `we:.claude/settings.json` (read directly from this repo, verbatim shape below) is
//    the REAL hook-registration schema Claude Code loads; this is the SAME shape, trimmed to carry ONLY the
//    FOUR hooks a delivery agent's own Bash/Edit/Write calls actually need for safety — `guard-lane.mjs`
//    (refuses an Edit/Write from a foreign session onto a lane it does not own), `guard-bash.mjs` (the
//    destructive-git-op / main-push / backgrounded-verification-set denials), `lint-locus-prefix.mjs --pre`
//    (denies an Edit/Write that would introduce a bare code-path reference — missing a `we:` locus prefix —
//    into `backlog/*.md`/`reports/*.md` before it lands), and `backlog-guard.mjs --pre` (denies an Edit/Write
//    with a derived-empty summary, or a hand-authored new backlog file, scoped to the same `backlog/*.md`
//    writes the agent legitimately makes) — dropping only the remaining two Edit|Write hooks the real
//    settings.json also carries (`check-memory.mjs`, `guard-backward-edge.mjs`), which stay dropped because
//    there is no evidence the delivery agent's own writes ever touch agent-memory or backward-edge-relevant
//    paths.
//
//    CORRECTED PREMISE (bug 11, live #3371 attempt 4, confirmed 2026-09-09) — an earlier revision of this
//    comment dropped `lint-locus-prefix.mjs`/`backlog-guard.mjs` too, on the claim that "none of [the four
//    dropped hooks] apply to a minimal delivery agent that never touches `backlog/*.md`/`reports/*.md`/
//    agent-memory files itself." That premise was factually wrong, and a real live run proved it: the brief
//    (`we:skills-src/conveyor/delivery-agent-brief-v2.md`) explicitly instructs the agent to "Keep its
//    `## Progress` section synced as you go" — i.e. the agent itself edits its own `backlog/NNNN-*.md` card,
//    not just the wrapper. Attempt 4 did exactly that and, in the same run, introduced a bare code-path
//    reference missing its `we:` locus prefix — a violation `lint-locus-prefix.mjs --pre` would have denied
//    at write-time had it been present, but which instead was only caught afterward via the agent's own
//    `check:standards` run, costing an avoidable extra fix-and-recheck cycle. Do not reintroduce the "agent
//    never touches backlog files" premise — it is disproved by the brief's own instructions and by this
//    real attempt.
//
//    `--restricted`'s own help text says explicitly that "managed settings and `--settings` still apply" even
//    though it "ignores user, project and local settings files" — and unlike an earlier draft's `--bare`
//    (which makes the same textual claim but was never checked against a real denied command), THIS claim was
//    checked for real: a command `guard-bash.mjs` denies, run through `--restricted --settings=<this file>`,
//    came back blocked with the hook's own deny text; the SAME command through `--safe-mode --settings=<this
//    file>` did NOT — it executed for real (see `CLAUDE_RESTRICTED_PROVIDER`'s own docblock below for the full
//    trail). So `--restricted --settings=<this file>` is REAL and VERIFIED as a combination, not a guess:
//    `--restricted` (plus the explicit `--tools` allowlist and `--strict-mcp-config` the provider below also
//    passes) strips CLAUDE.md/skill-discovery/stray-MCP-surface down to nothing, and this file re-adds ONLY
//    the four safety hooks above, nothing else — no memory, no doctrine, no skill discovery leaks back in
//    through the settings layer.
//
//    BUG 8 (live #3371 attempt, confirmed 2026-09-09) — this settings file ALSO now carries `permissions.allow`.
//    Under `--restricted` the CLI ignores the repo's normal project/user permissions files entirely (same
//    sentence in `--restricted`'s own help text as the settings carve-out above), so with no `permissions.allow`
//    in THIS file, an ordinary headless command — confirmed live: even `git --version`, `node -e ...` — comes
//    back "This command requires approval" with nobody there in a headless run to approve it. That blocked the
//    ONE sanctioned output channel the brief describes (`delivery-report-cli.mjs report`) outright.
//
//    THE SHAPE, AND WHY: `we:.claude/settings.json` (read again, for this specific question) shows this CLI's
//    real `permissions.allow` syntax accepts BARE tool names ("Bash", "Edit", "Write" appear literally, with no
//    `(pattern)` suffix) alongside narrower `Tool(sub-pattern:*)` entries — confirmed by `claude --help`'s own
//    `--allowedTools` doc, which gives exactly one example of each shape ("Bash(git *) Edit"). A bare tool name
//    is an unconditional allow for that whole tool, so `allow: RESTRICTED_PROVIDER_TOOLS.split(',')` grants
//    exactly the six tools `--tools` already exposed to this agent — nothing broader (there is no seventh tool
//    for a wider grant to reach) and nothing narrower (a hand-enumerated subset of "safe" argv patterns would
//    be the exact brittle, ever-incomplete allowlist the operator's own stated intent for this fix rejects).
//    The REAL safety boundary is deliberately left to `guard-bash.mjs`'s `PreToolUse(Bash)` hook (registered
//    just below) and `guard-lane.mjs`'s `PreToolUse(Edit|Write)` hook — both still fire on every call regardless
//    of what `permissions.allow` grants, matching this repo's own "hookable vs judgment: script-decidable stays
//    a hook" doctrine: `permissions.allow` only decides whether a human would be ASKED, never whether a command
//    is SAFE.
//
//    HONESTY CHECK, NOW RESOLVED (#xu2pp2m built the arm; #3645 made it fire). This paragraph used to say
//    `guard-bash.mjs` did NOT deny the mechanical CLIs (lane-pool, backlog claim/release, `gh pr`, `pr-land`,
//    `converge-cli`, `verify-lane`, `learnings-drop`, `review-core-cli`) for a `WE_DISPATCH_KIND=delivery`
//    session, so this settings file's `permissions.allow` was the only thing standing between a delivery agent
//    and the lifecycle commands this wrapper owns. Both halves are now closed: the `dispatchKind === 'delivery'`
//    deny table exists in `we:scripts/guard-bash.mjs` (search `WHY THIS STAYS`), and #3645 wired this wrapper
//    into the live `build` dispatch, so something finally stamps `'delivery'` in production and the table is no
//    longer dead code. `permissions.allow` is still deliberately the six tools `--tools` already exposed — the
//    hook, not the allowlist, is the safety boundary, exactly as the paragraph above argues.
// ================================================================================================
export const DELIVERY_HOOKS_SETTINGS = Object.freeze({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Edit|Write',
        hooks: [
          { type: 'command', command: 'node scripts/guard-lane.mjs' },
          { type: 'command', command: 'node scripts/lint-locus-prefix.mjs --pre' },
          { type: 'command', command: 'node scripts/backlog-guard.mjs --pre' },
        ],
      },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/guard-bash.mjs' }] },
    ],
    // #4070 — the agent's `done` report is its one sanctioned output; a turn may not end with it still `started`.
    Stop: [{ hooks: [{ type: 'command', command: 'node scripts/guard-stop-completion-record.mjs' }] }],
  },
  permissions: {
    allow: RESTRICTED_PROVIDER_TOOLS.split(','),
  },
});

/**
 * SKETCH (the write itself is straightforward REAL fs code; what's unverified is whether a real cutover
 * wants this materialized once per-repo, once per-lane, or fresh per-spawn — left as the simplest correct
 * choice for this sketch: written to a fixed path under the SAME `.operations/` sidecar family
 * `we:scripts/operations/delivery-report-store.mjs` already uses). Returns the settings file's path.
 *
 * #3627 bug 8 fix-adjacent correctness note: this now WRITES EVERY CALL rather than skipping when the path
 * already exists. The original `if (!existsSync(path))` guard meant that on any machine where a PRIOR run had
 * already materialized this file under the pre-bug-8 schema (hooks only, no `permissions`), this fix's new
 * `permissions.allow` block would never actually reach disk — the file would look "already there" and the
 * stale, pre-fix content would keep being handed to every future `--settings=<path>` spawn, silently. The
 * content is a pure function of `DELIVERY_HOOKS_SETTINGS` (a frozen constant), so re-writing it every call is
 * still idempotent in the sense that matters (same bytes out every time) and costs one cheap fs write per
 * delivery-agent spawn — not a real cost against a call that is about to block for up to an hour.
 */
// #xu2pp2m — GENERATED by the shared factory (`we:scripts/operations/minimal-context-provider.mjs
// #createHooksSettingsWriter`), not a re-derived copy: this IS the same write-every-call, no-`existsSync`-guard
// function body that used to live here verbatim, now produced once, in the shared module, and reused by every
// caller that needs a trimmed hooks-settings file materialized to disk.
export const ensureDeliveryHooksSettingsFile = createHooksSettingsWriter(
  'delivery-agent-hooks-settings.json', DELIVERY_HOOKS_SETTINGS,
);

/**
 * SKETCH — top-level entry the conveyor's tick would call in place of today's direct `claude --bg` spawn
 * (`we:scripts/operations/dispatch-lane.mjs`'s build-launch branch). One call = one item = one attempt.
 *
 * @param {{ item: string, lane: number, scope: string, sessionSlug: string, attemptTag: string, briefPath: string }} launch
 *   the SAME launch-entry shape `dispatch-lane.mjs` already receives from `planTick`'s `spawnBuilds` list —
 *   this wrapper does not change what feeds it, only what it does with it.
 * @param {DeliveryAgentProvider} [provider] — which CLI spawns and resumes this delivery agent (FIRM
 *   REQUIREMENT 6, provider parity). Defaults to `CLAUDE_RESTRICTED_PROVIDER`, the only real implementation today;
 *   pass `DELIVERY_AGENT_PROVIDERS.codex` once that provider is actually built. Threaded through unchanged to
 *   every call that spawns or resumes the agent (`runAgentToCompletion`, `runGateWithOneRetry` →
 *   `resumeAgentWithGateFailure`) — nothing else in this function's control flow is provider-specific.
 * @param {{ newSessionId?: () => string }} [deps] — REAL, bug-5 fix. `newSessionId` (default `randomUUID` from
 *   `node:crypto`) mints the Claude CLI's OWN `--session-id`/`--resume` value: the current CLI validates that
 *   flag as a real UUID and rejects a human-readable slug outright (confirmed live: a real #3371 attempt failed
 *   with `Error: Invalid session ID. Must be a valid UUID.` before any paid agent turn ran). This is a SEPARATE
 *   identifier from `sessionSlug` — `sessionSlug` keeps meaning exactly what it already means everywhere else in
 *   this file (claim/release, `tryReadDeliveryReport` lookup, the brief's own `$DELIVERY_SESSION` env value,
 *   lane-pool's `--session=`) and is never touched by this change. Minted ONCE per delivery attempt, here, and
 *   threaded down into both the fresh spawn (`runAgentToCompletion`) and its one resume (`runGateWithOneRetry` →
 *   `resumeAgentWithGateFailure`) as `claudeSessionId`, so a resume targets the SAME CLI session the fresh spawn
 *   used rather than minting a second one. `newSessionId` is injectable only so a test can assert on a
 *   deterministic value instead of a fresh random UUID every run.
 */
export async function deliverItem(launch, provider = CLAUDE_RESTRICTED_PROVIDER, { newSessionId = randomUUID } = {}) {
  // `runId`/`effectKey` name this delivery's own run-store dispatch effect, threaded through from the daemon's
  // dispatch sink. Either absent — an older dispatch, a hand-built test launch, a resumed dispatch that
  // predates this — and `settleTerminal` below just skips the run-store settle; it still releases/holds the
  // real build-dispatch claim this process took, because that claim exists whether or not a run-store row does.
  // build-orphan-adopt (#4131/#4382 fix) — `resume` (default false) rides straight through to
  // `runAgentToCompletion`'s own `resume` branch below; every other caller (every existing dispatch) never
  // sets it, so `deliverItem` is byte-identical for them.
  const { item, lane, scope, sessionSlug, attemptTag, runId, effectKey, resume = false } = launch;

  // Every terminal exit funnels through here (alongside `finish()`, never instead of it): settle this
  // delivery's own run-store effect with the outcome just produced, and — for a non-PR outcome only — release
  // the build-dispatch claim the daemon took before this process started. A PR outcome leaves the claim alone:
  // `build-dispatch-daemon.mjs#doneWhy`'s own PR-observed retirement owns "did this actually deliver the item",
  // not this wrapper. BEST-EFFORT throughout, like `releaseClaimAndLane` below — a run-store or claim-file
  // hiccup must never mask the real delivery outcome.
  //
  // FIRES AT MOST ONCE per delivery (`settledOnce`). Not just for the run-store settle, which is idempotent on
  // its own — claim release and the hold are NOT: `placeBuildDispatchHold` deletes+recreates the lock, so a
  // second call would overwrite an earlier, more specific hold reason, and a second release could free a claim
  // an earlier call deliberately left held (e.g. `pr-opened`). The outer catch below calls this unconditionally
  // on ANY escape, including a throw that lands after an earlier branch already settled — this guard is what
  // keeps that safe.
  //
  // `outcome` (the positional argument) always wins over `result` — see {@link mergeSettleResult}.
  let settledOnce = false;
  const settleTerminal = (outcome, { result = null, error = null, releaseClaim = false, hold = null } = {}) => {
    if (settledOnce) return;
    settledOnce = true;
    try {
      settleDispatchEffect({
        runId, key: effectKey, status: error ? 'failed' : 'applied', result: mergeSettleResult(outcome, result), error,
      });
    } catch { /* best-effort — never mask the real outcome */ }
    // Hold BEFORE release (red-team, round 2): a hold is what actually excludes the item from the daemon's
    // next-tick candidates (`build-dispatch-daemon.mjs`'s `heldNums` filter) — the claim's own absence is not
    // itself a re-dispatch guard. Releasing first opened a window (a crash between the two calls, or simply
    // the two calls straddling a tick) where the claim was gone and nothing yet excluded the item, so a tick
    // landing in that gap could re-dispatch it. Placing the hold first closes that window: from the moment
    // this line returns, the item is excluded even if the release below never runs.
    if (hold) {
      try { placeBuildDispatchHold({ num: item, reason: hold }); } catch { /* best-effort */ }
    }
    if (releaseClaim) {
      try { releaseBuildDispatchClaim({ num: item }); } catch { /* best-effort */ }
    }
  };
  let laneAcquired = false;
  let implLanePath = null;
  let restoreTelemetry = () => {};
  let root;
  let terminalOutcome = 'wrapper-threw';
  try {
    const claudeSessionId = newSessionId(); // the Claude CLI's own --session-id — see the docblock above.

    // build-path-codex-isolation-locus — WHICH REPO this item's own `scope:` actually names, resolved ONCE, up
    // front, before anything is acquired. See `resolveDeliveryLocus`'s own docblock for the couple-repo refusal
    // this can throw.
    const locus = resolveDeliveryLocus(scope);
    const implProfile = locus.profile && locus.profile.key !== 'we' ? locus.profile : null;
    if (locus.multiRepo) {
      terminalOutcome = 'unsupported-locus';
      throw new Error(
        `deliver-item-wrapper: #${item}'s scope spans more than one repo (${locus.keys.join(', ')}) — a `
        + 'multi-repo "couple" build (as opposed to a single non-we locus, which this wrapper already handles) '
        + 'is a design decision this wrapper defers rather than guesses at (merge order, which repo\'s gate '
        + 'governs, one PR or two) — see #4289. Multi-repo delivery is unsupported.',
      );
    }

    // ---- 0. Telemetry (#3383) — the root `dispatch` span for this whole delivery, and the ambient recorder
    // every shared helper below (`acquireLane`, `runVerifyOperation`) emits its own spans into. The trace id is
    // DERIVED from the item, so this delivery, a later fix dispatch against its PR, and the review that lands
    // it all join without anything being passed between those three separate processes. `attemptTag` rides as
    // an attribute rather than as part of the trace id — attempt 2 of #3441 belongs in the SAME trace as
    // attempt 1, which is what makes "how many attempts did this item take" answerable at all.
    //
    // Telemetry setup is inside the same settlement region as every other preflight step.
    // The outermost finally restores the ambient recorder even when setup fails.
    const tel = recorderFor({ kind: 'build', item, attributes: { item: String(item), sessionSlug } });
    restoreTelemetry = setActiveRecorder(tel);
    root = tel.startSpan('dispatch', {
      attributes: { item: String(item), lane: String(lane), attemptTag: attemptTag || null, scope: scope || null },
    });

    // ---- 1. Acquire + claim (REAL CLI surface, verbatim from the live brief's own step 1/2) -----------------
    // `claudeSessionId` threaded through — see `acquireLane`'s own docblock (#3627 secondary finding, live
    // #3371 attempt 4) for why `--adopt` needs the delivery agent's own future session id, not whatever this
    // wrapper process itself inherited.
    // PR #2921 review — a resume re-leases the SAME lane without resetting it (the reset would wipe the finished
    // commit being resumed), and skips the item claim below (the item is already `active` from the attempt being
    // resumed; re-claiming it is refused and would settle this resume as `wrapper-threw`).
    acquireLane({ lane, sessionSlug, scope, item, claudeSessionId, noReset: resume });
    laneAcquired = true;
    // build-path-codex-isolation-locus — a single non-`we` locus (`implProfile` set above) ALSO gets an
    // implementation lane in ITS OWN repo's own pool — see `acquireImplLane`'s own docblock. This is the fix
    // for the live #3604 finding: the wrapper used to acquire ONLY the WE lane above, for every item
    // regardless of locus, so a plateau-app/frontierui-scoped build's own agent turn, gate and PR all ran (or
    // tried to run) against WE's checkout instead of the repo the item actually edits.
    //
    // Refused here, BEFORE the claim, the same shape a saturated NUMBERED acquire would already refuse at —
    // `acquireLane`'s own unnumbered branch reports pool saturation as an empty string, never a throw (see its
    // docblock), so this reads that signal explicitly rather than letting a claim happen with nowhere for the
    // agent to actually work.
    if (implProfile) {
      implLanePath = acquireImplLane({ sessionSlug, claudeSessionId, item, profile: implProfile });
      if (!implLanePath) {
        releaseClaimAndLane({ item, lane, sessionSlug, best_effort: true });
        settleTerminal('blocked-on-infra', {
          result: { reason: `no free ${implProfile.key} lane` },
          releaseClaim: true,
          hold: `no free ${implProfile.key} lane`,
        });
        return finish(`blocked-on-infra (no free ${implProfile.key} lane)`, {
          status: 'error', outcome: 'blocked-on-infra', reason: `no free ${implProfile.key} lane`,
        });
      }
    }

    // pre-existing bug found live during the #3565 real-dispatch re-verification, fixed alongside it: the
    // claim must run with the LANE as cwd (see `claimItem`'s own docblock) or `run.mjs claim` resolves the
    // item onto the shared primary checkout and is refused outright.
    const claimLanePath = resolveLanePath(lane, { run });
    if (!resume) {
      spanAround('item.claim', { attributes: { item: String(item) } }, () => claimItem({ item, sessionSlug, lanePath: claimLanePath }));
    }

    // ---- 2. Spawn the MINIMAL agent, wait for its structured report (SKETCH) -----------------------------
    // THE EXPENSIVE SPAN. This is the single longest phase in the system (capped at 60 minutes by
    // `DELIVERY_AGENT_SPAWN_TIMEOUT_MS`) and until #3383 it was timed by nothing at all — the exact gap
    // `readiness/conveyor-instrument.mjs` reports as `authoring: {ms: null, reason: 'no-dispatch-signal'}`.
    // `lane`/`dispatchKind`/`provider` (#3383 per-process-attribution follow-on) tag the span so a per-agent
    // CPU rollup can be sliced by any of the three without a second lookup. `resolveTurnCpuAttributes` prefers
    // the REAL child `resourceUsage` `CLAUDE_RESTRICTED_PROVIDER.spawn`/`CODEX_PROVIDER.spawn` record via
    // `recordChildResourceUsage` (now that both spawn asynchronously — see `dispatch-lane-io.mjs
    // #spawnAgentToCompletion` / `codex-delivery-provider.mjs#defaultSpawnCodexAgent`'s own headers) over the
    // wrapper-only `process.cpuUsage()` fallback — see that function's own docblock in `telemetry-store.mjs`
    // for exactly what `cpu*Ms`/`cpuSource` do and do not measure before reading them as "what the agent cost".
    const turn = root.child('agent.turn', {
      attributes: {
        item: String(item), timeoutMs: DELIVERY_AGENT_SPAWN_TIMEOUT_MS,
        lane: String(lane), dispatchKind: 'build', provider: provider.name,
      },
    });
    const turnCpuStart = process.cpuUsage();
    let report;
    try {
      report = await runAgentToCompletion({
        item, sessionSlug, lane, attemptTag, provider, claudeSessionId, lanePathOverride: implLanePath, resume,
      });
      turn.ok({
        outcome: report && report.outcome ? String(report.outcome) : 'unreported',
        filesTouched: Array.isArray(report?.filesTouched) ? report.filesTouched.length : 0,
        ...resolveTurnCpuAttributes(turnCpuStart),
      });
    } catch (e) {
      turn.fail(e, { outcome: 'agent-spawn-failed', ...resolveTurnCpuAttributes(turnCpuStart) });
      throw e;
    }

    // ---- 3. Act on the report — every branch below is what USED TO be the agent's own job -----------------
    if (report.outcome === 'blocked' && (!report.filesTouched || report.filesTouched.length === 0)) {
      // Pre-build stop, same shape as today's brief's Escalations case 0 — but decided by the WRAPPER
      // reading the report, never by the agent reasoning about claim/release CLI mechanics.
      releaseClaimAndLane({ item, lane, sessionSlug, implLanePath });
      // A `not-ready` outcome is a KNOWN, RECURRING failure shape (a re-opened `blockedBy`, a stale/superseded
      // spec, …) — settling the effect and releasing the claim ALONE would leave the item eligible again on
      // the very next daemon tick (~2 minutes), tighter than the accidental ~90-120 minute gap this replaces.
      // The hold is what actually stops the loop (see `build-dispatch-claim.mjs`'s own note for the mechanism,
      // and `build-dispatch-daemon.mjs`'s tick for where it is read); `report.reason` can be empty for a
      // `not-ready` the agent reported with no detail, so it falls back to the outcome name itself rather than
      // placing a hold with no reason at all. EVERY non-PR terminal outcome below places the same kind of hold.
      settleTerminal('not-ready', { result: { reason: report.reason }, releaseClaim: true, hold: report.reason || 'not-ready' });
      return finish(`not-ready (${report.reason})`, { status: 'unset', outcome: 'not-ready', reason: report.reason });
    }

    if (report.outcome === 'blocked') {
      // A runtime blocker hit mid-build, with real (uncommitted or committed) work already in the lane.
      // TODO (PLACEHOLDER): today's brief has no analogous mid-build "blocked with partial work" case —
      // every existing exit either finishes the build or stops before writing anything. Decide: discard the
      // partial work and release (safest, matches "no PR is opened" bar 0 sets), or open a draft/park PR so
      // the partial diff is not silently lost? Left open for whoever actually specs this out.
      releaseClaimAndLane({ item, lane, sessionSlug, implLanePath });
      settleTerminal('blocked-mid-build', { result: { reason: report.reason }, releaseClaim: true, hold: report.reason || 'blocked-mid-build' });
      return finish(`blocked-mid-build (${report.reason})`, { status: 'error', outcome: 'blocked-mid-build', reason: report.reason });
    }

    // outcome is 'done' or 'needs-human-judgment' from here — both have a real diff. Run the gate FIRST in
    // either case: a needs-human-judgment report still needs a green gate before anyone reviews it.
    // (The `verify.gate` span itself is emitted one level down, inside `runVerifyOperation`, so it is
    // captured identically for every wrapper rather than six times over — see that function.)
    const gate = await runGateWithOneRetry({
      lane, item, sessionSlug, attemptTag, provider, claudeSessionId, lanePathOverride: implLanePath,
    });
    if (gate.status === 'red') {
      releaseClaimAndLane({ item, lane, sessionSlug, implLanePath });
      settleTerminal('gate-red', { releaseClaim: true, hold: 'gate-red' });
      return finish('gate-red', { status: 'error', outcome: 'gate-red' });
    }
    if (gate.status === 'gate-blocked') {
      // #3627 attempt-5 finding — the resumed agent's own honest `blocked` self-diagnosis (see
      // `runGateWithOneRetry`'s docblock), never collapsed into `gate-red`. Same release shape as a real red
      // gate — this attempt did not produce a landable diff either way — but the reported result names the
      // agent's own reason instead of pretending the gate itself failed.
      releaseClaimAndLane({ item, lane, sessionSlug, implLanePath });
      settleTerminal('gate-blocked', { result: { reason: gate.reason || null }, releaseClaim: true, hold: gate.reason || 'gate-blocked' });
      return finish(`gate-blocked (${gate.reason || 'no reason reported'})`, { status: 'error', outcome: 'gate-blocked', reason: gate.reason || null });
    }

    // ---- 4. Converge — driven BY THE WRAPPER, not the agent (this session's call on step 6, see the design
    // amendment on #3627: KEEP the substance, MOVE the driving). SKETCH — the exact init/step loop shape is
    // taken from the live brief's own step 6 prose, not verified against `converge-cli.mjs`'s real output. --
    // `provider` threaded through (mechanical-dispatcher follow-up to #3580) — see `runConvergeEdit`'s own
    // docblock ("VISIBILITY fix") for why this does not make Codex the converge editor; it only makes the
    // requested build provider visible to, and recorded by, the round that runs regardless.
    const convergeVerdict = spanAround('converge.round', { attributes: { item: String(item), buildProvider: provider.name } },
      () => runConverge({ lane: gate.lanePath, item }, { provider }));

    // ---- 5. Map outcome + convergeVerdict + statute-touch to a park mode, via the EXISTING deterministic
    // rubric (`review-escalation.mjs`) — REAL import, SKETCH call (the real `scoreEscalation` signature takes
    // more inputs — diff stats, dismissed-finding counts — than sketched here). -------------------------------
    // #3850 Fork 2 — `provider.vendor` is the REAL executed vendor: `provider` is the object that actually
    // spawned this turn (`runAgentToCompletion` above), never a prediction. Falls back to `'claude'` for a
    // provider object that predates this field (defence-in-depth only — every registered provider sets it).
    const parkDecision = decideParkMode({
      report, convergeVerdict, filesTouched: report.filesTouched, lanePath: gate.lanePath,
      executedVendor: provider.vendor ?? 'claude',
    });

    // ---- 6. Open the PR through the SAME canonical producer the live brief already uses — REAL CLI surface,
    // verbatim from the live brief's own step 8. `openPr` is a PURE function of its params (no hidden
    // `findItem`/backlog-loader dependency of its own) — the item's REAL slug is resolved ONCE, here, the SAME
    // way `resolveItemSpecPathBasename` resolves it for the brief, and passed straight through. -----------------
    const foundForPr = findItem(String(item), () => defaultLoadItems(REPO_ROOT));
    if (!foundForPr) {
      throw new Error(`deliver-item-wrapper: could not resolve a slug for item #${item} — findItem returned nothing`);
    }
    // #4348-open-pr-retry — a `blocked-on-infra` PR-open (a GitHub rate limit/outage hit AFTER the lane ref
    // was already pushed — pr-land's own #2659 handler already recorded the resumable {ref,sha,body} handle
    // in `.conveyor/infra-blocked.json` before it exited) is NOT the generic "something in this wrapper broke"
    // the outer catch below reports as `wrapper-threw`. Live incident: build #4348 finished, gate went green,
    // and ONLY this step hit the GitHub rate limit — yet it sat under an indistinguishable `wrapper-threw`
    // hold for 2+ hours, because nothing here told `open-pending` (a real, expected, self-recovering state)
    // apart from an actual bug. Settling it as its own outcome keeps that signal legible for a dry-run/status
    // read, while the hold below still excludes the item from re-dispatch — never a rebuild, exactly like
    // every other terminal outcome in this function. The actual RETRY is deliberately NOT this wrapper's job
    // (it is a one-shot process that is about to exit): `build-dispatch-daemon.mjs`'s own live tick now runs
    // `infra-blocked.mjs retry` every cycle (#2659's existing backoff/attempt-cap state machine, unchanged),
    // which resume-opens straight from the record pr-land already wrote — no lane, no rebuild, no second copy
    // of ref/sha/body kept here.
    if (!runId || !effectKey) throw new Error('builder PR requires a durable dispatch identity before publishing');
    let prResult;
    try {
      prResult = spanAround('pr.open', { attributes: { item: String(item), park: parkDecision.label } },
        () => openPr({
          item, attemptTag, runId, effectKey, lane: gate.lanePath, park: parkDecision, report, slug: foundForPr.slug,
          // #3903 main adaptation — the trial-evidence marker; see `delegationForBuild`.
          delegation: delegationForBuild(provider, scope),
        }));
    } catch (e) {
      const infra = classifyOpenPrFailure(e);
      if (!infra) throw e; // not the retryable class — falls through to the generic `wrapper-threw` catch below.
      releaseClaimAndLane({ item, lane, sessionSlug, implLanePath });
      settleTerminal('open-pending', { result: { reason: infra.reason }, releaseClaim: true, hold: 'open-pending' });
      return finish('open-pending (blocked-on-infra — the lane ref is already pushed; a later daemon tick '
        + 'resume-opens it, never a rebuild)', { status: 'error', outcome: 'open-pending', reason: infra.reason });
    }

    if (prResult.outcome !== 'opened') {
      // A learning or recovery-ref failure must never turn a refused submit into lane cleanup.
      try { if (report.learning) dropLearning({ sessionSlug, learning: report.learning }); } catch { /* best-effort */ }
      const { reason, detail, pr = null } = prResult;
      const result = { reason, detail, pr };
      if (pr == null) {
        let sha = null;
        let keepRef = null;
        try { sha = run('git', ['rev-parse', 'HEAD'], { cwd: gate.lanePath }).trim() || null; } catch { /* best-effort */ }
        if (sha) {
          const ref = `refs/keep/${item}-${sha.slice(0, 8)}`;
          try {
            run('git', ['update-ref', ref, sha], { cwd: gate.lanePath });
            keepRef = ref;
          } catch { /* best-effort; retain the lane even when recovery metadata cannot be written */ }
        }
        Object.assign(result, { lane: gate.lanePath, sha, keepRef });
        settleTerminal('open-refused', { result, releaseClaim: true, hold: `open-refused: ${reason}` });
      } else {
        // A live PR retains the existing PR-observed claim retirement policy.
        settleTerminal('open-refused', { result });
      }
      return finish(describeOpenPrRefusal(prResult), { status: 'error', outcome: 'open-refused', ...result });
    }

    // ---- 7. Forward the optional learning, if the agent supplied one (REAL CLI surface). --------------------
    if (report.learning) dropLearning({ sessionSlug, learning: report.learning });

    // ---- 8. Exit. Same "never merge, never release, the drain lands it" contract as today. -----------------
    // `prResult` is `open-pr.mjs`'s `classifySubmit` shape — `.pr`, never `.number` — because `openPr` (above)
    // now runs it through `extractSubmitResult` before returning. It did NOT used to: `openPr` used to hand
    // back `JSON.parse(out)` UNCHANGED, i.e. `run.mjs open-pr --json`'s own full run-outcome envelope, which
    // carries no top-level `pr`/`url` at all (the real value sits at `findings.submit.effects[0].result.pr`).
    // Renaming `.number` to `.pr` here (the first fix attempt) therefore did not close the bug — `prResult.pr`
    // was still reading past a field that was never there, off the wrong object. Confirmed live on real PR
    // #2109 ("PR #undefined" printed even though the PR opened correctly) and reproduced by actually running
    // `run.mjs open-pr --json` (bug 13; see `extractSubmitResult`'s own docblock for the full story).
    // #4349 — settle the effect on a real, opened PR too (never leave it `in-flight` for the waker to find
    // hours later), but the build-dispatch CLAIM is deliberately left alone here: an open PR can still be
    // closed/superseded before it merges, and `build-dispatch-daemon.mjs#doneWhy`'s own PR-observed retirement
    // already owns "is this PR the thing that actually delivers the item" — racing ahead of it with our own
    // "opened" signal would be trusting less information to save at most one ~2-minute tick.
    settleTerminal('pr-opened', { result: { pr: prResult.pr ?? null, park: parkDecision.label } });
    return finish(`PR #${prResult.pr} (${parkDecision.label})`, {
      status: 'ok', outcome: 'pr-opened', pr: prResult.pr ?? null, park: parkDecision.label,
    });
  } catch (e) {
    // Only this attempt's successful acquisition authorizes lane cleanup. Preflight and acquisition
    // refusals still settle the dispatch and release its build claim, without touching another lease.
    if (laneAcquired) releaseClaimAndLane({ item, lane, sessionSlug, best_effort: true, implLanePath });
    settleTerminal(terminalOutcome, { error: String(e?.message ?? e), releaseClaim: true, hold: terminalOutcome });
    root?.fail(e, { outcome: terminalOutcome });
    throw e;
  } finally {
    restoreTelemetry();
  }

  /** Close the root span and return the wrapper's own unchanged `{item, result}` shape. Declared as a
   *  hoisted function so every early return above reads as a one-line change from what it was. */
  function finish(result, { status = 'unset', ...attrs } = {}) {
    if (status === 'error') root.fail(attrs.outcome || result, attrs);
    else if (status === 'ok') root.ok(attrs);
    else root.end({ status: 'unset', statusMessage: String(result), attributes: attrs });
    return { item, result };
  }
}

// ================================================================================================
// 1. Lane + claim — REAL, lifted verbatim from the live brief's step 1/2 CLI surface.
// ================================================================================================

// #xu2pp2m — `acquireLane`/`resetStaleVerifyMarker` EXTRACTED to the shared module (`./minimal-context-
// provider.mjs`, imported above) unchanged in behaviour — a review dispatch needs the identical
// "stamp the eventual occupant's real session id, then best-effort clear a stale verify marker" shape, just
// for a `--purpose=review-loop` acquire rather than `conveyor-delivery`. `acquireLane`'s `purpose` parameter
// defaults to `'conveyor-delivery'`, so every call site in THIS file (and every existing test) is unchanged.
// See that module's own docblocks for the full #3627 live-run reasoning behind both functions.

/**
 * REAL — routed through the DECLARED `claim` operation (`scripts/operations/claim.mjs`, wired into
 * `run.mjs`) instead of a raw `backlog.mjs claim` shell-out (#3627 follow-up: `run.mjs <op>` is the
 * sanctioned, OS-agnostic, traceable interface for a mechanical caller — `openPr` below already does this
 * for `open-pr`). Exported, and takes an injectable `run` (mirrors `resolveLanePath`/`openPr`'s own
 * pattern), for the same "argv IS the contract" reason those are.
 *
 * THE REAL INPUT SCHEMA (read from `claimOperation` in `claim.mjs`, not guessed): `ref` (required string),
 * `as` (optional, default `'active'`, enum `active|preparing`), `force` (optional boolean, default `false`).
 * THERE IS NO `session` FIELD. The `--session` bookkeeping the raw `backlog.mjs claim` CLI does around this
 * SAME operation — the gate-attribution claims-registry baseline (`recordClaim`), the reservation-clear-on-
 * claim, `recordCliTouch`, and the background/stop-for-rename UX — all live in `backlog.mjs`'s OWN
 * `claimViaOperation` wrapper AROUND the operation, never in the operation itself, so none of it is reachable
 * through `run.mjs claim`. `sessionSlug` is accepted here only so the caller's shape is unchanged and is
 * deliberately not forwarded — this pipeline's own gate call (`runGateWithOneRetry` → `run.mjs verify`) does
 * not use claims-registry scoping either, so nothing this delivery flow depends on is lost by the omission,
 * but it IS a real behavioral difference from a raw `backlog.mjs claim --session=…` call and is called out
 * here rather than silently dropped.
 */
export function claimItem({ item, sessionSlug, lanePath } = {}, { run: runFn = run } = {}) {
  void sessionSlug; // accepted, not forwarded — see the docblock above for why.
  // BUG FOUND live during the #3565 real-dispatch re-verification (separate from, and pre-existing before,
  // the #3565 sandbox/commit redesign): `run.mjs claim` resolves the backlog item's path relative to the
  // CHILD PROCESS's own cwd. With no `cwd` at all here, that child inherited the WRAPPER's cwd (the primary
  // checkout), so the claim resolved onto the primary tree and was refused outright — "backlog item-mutation
  // BLOCKED ... resolves under the shared PRIMARY checkout ... There is no override." `lanePath`, when given,
  // fixes this the same way every other lane-scoped call in this file already does (`openPr`, `commitBuildTurn`,
  // `runVerifyOperation` all pass `{ cwd: lane }`) — optional only so every existing caller/test that predates
  // this fix, which never had a lane path to give, keeps calling this with the exact same two-argument shape.
  const args = ['scripts/operations/run.mjs', 'claim', `--ref=${item}`, '--json'];
  if (lanePath) runFn('node', args, { cwd: lanePath });
  else runFn('node', args);
}

// #3627 follow-up — both calls below are raw script calls, not routed through `run.mjs`: `release` has no
// registered operation (only `claim`, its OPEN, is declared — `resolve`/`scaffold` exist but neither is
// `release`) and `lane-pool` has no registered operation at all (same gap `acquireLane` notes above). Would
// need one — or two — built first (see #3627 follow-up); out of scope for this hardening pass.
/** REAL (release flags lifted from the live brief's Escalations case-0 mechanism).
 *
 * build-path-codex-isolation-locus — `implLanePath`, when given, means a NON-`we` locus's implementation lane
 * was also acquired (`acquireImplLane`, unnumbered) and must also be released on every exit path. That lane
 * has no NUMBER this file ever learns (the unnumbered acquire returns only its PATH), so there is no
 * `--lane=<N>` to release it by; `releaseAllPools(sessionSlug)` is the mechanism built for exactly this
 * (`lane-pool.mjs`'s own `release --all-pools --session=<slug>` sweeps EVERY pool under the pool root for
 * this session's leases in one call — "cross-locus couple cleanup", its own docstring's words). Best-effort,
 * always — a release failure here must never mask the real outcome this function's caller already decided. */
function releaseClaimAndLane({ item, lane, sessionSlug, best_effort = false, implLanePath = null }) {
  const opts = best_effort ? { stdio: 'ignore' } : {};
  try { run('node', ['scripts/backlog.mjs', 'release', String(item), `--session=${sessionSlug}`], opts); } catch { /* best-effort on the failure path */ }
  try { run('node', ['scripts/lane-pool.mjs', 'release', `--lane=${lane}`, `--session=${sessionSlug}`], opts); } catch { /* best-effort on the failure path */ }
  if (implLanePath) {
    try { releaseAllPools(sessionSlug); } catch { /* best-effort — see docblock above */ }
  }
}

// ================================================================================================
// 1b. Locus resolution + the implementation-lane acquire — build-path-codex-isolation-locus, the fix for the
//     live #3604 finding: this wrapper used to acquire ONLY a WE lane for every item, so a plateau-app- or
//     frontierui-scoped build's agent turn/gate/converge/PR all ran against WE's own checkout instead of the
//     repo the item actually edits, and Codex (whose OS sandbox confines writes to its own spawn `cwd`, never
//     a second declared root — see `codex-delivery-provider.mjs`'s own header) reported `blocked`.
// ================================================================================================

/**
 * PURE. Resolves the item's own declared `scope:` (the wrapper's `launch.scope` — a comma-joined string of
 * repo-qualified paths, e.g. `"plateau-app:src/foo.tsx,plateau-app:src/bar.tsx"`, per
 * `dispatch-lane-io.mjs#deliverItemDetachedProvider`'s own `String(request?.scope ?? '')` join) to exactly one
 * of three answers:
 *   - a single repo, `we` — today's only case, unchanged: `{ profile: repoProfile('we'), multiRepo: false }`.
 *   - a single NON-`we` repo (`frontierui` or `plateau-app`) — the new, single-locus case this file now
 *     handles: `{ profile: repoProfile(<key>), multiRepo: false }`.
 *   - TWO OR MORE distinct repos (e.g. a scope mixing `we:`/`plateau-app:` paths, or `frontierui:`/
 *     `plateau-app:` together) — a genuine multi-repo "couple" build. This wrapper does not guess at merge
 *     order, which repo's gate governs, or whether one PR or two is correct, so `deliverItem` refuses these
 *     before acquiring anything; see its own call site. `{ profile: null, multiRepo: true, keys }`.
 *
 * An entry whose `<repo>:` prefix is unrecognized (or a scope with no entries at all — `dispatch-lane.mjs`
 * refuses to dispatch a build with no `scope:` before this ever runs, so this is a defensive default, not a
 * real path) falls back to `we`, matching this wrapper's behavior before this function existed.
 *
 * @param {string} scope
 * @returns {{profile: ReturnType<typeof repoProfile>|null, multiRepo: boolean, keys?: string[]}}
 */
export function resolveDeliveryLocus(scope) {
  const { multiRepo, keys } = deliveryLocusForScope(scope);
  if (multiRepo) return { profile: null, multiRepo, keys };
  return { profile: repoProfile(keys[0]), multiRepo: false };
}

/** Bounded wait for the cross-repo impl-lane acquire (was zero-wait). */
export const IMPL_LANE_ACQUIRE_WAIT_MS = 60_000;

/**
 * REAL — acquires a single-locus item's implementation lane via `acquireLane`'s UNNUMBERED shape (no tick has
 * ever assigned this item a lane NUMBER in `profile`'s own pool — only WE's tick-planner does that, for the
 * WE lane every item still also gets), `--repo=<profile.checkoutPath>` picking the right pool. `--item=` is
 * passed (added to `acquireLane`'s unnumbered branch alongside this fix) so the drain's existing
 * `lane-pool.mjs release --all-pools --item=<num>` by-item sweep finds and releases THIS lane on land too,
 * with no further change needed there.
 *
 * Returns the acquired lane's real path, or `''` for the pool-saturation signal `acquireLane` already defines
 * (never throws for that case) — the caller decides what an empty path means (today: refuse before claiming,
 * exactly as a saturated WE acquire would).
 *
 * @param {{sessionSlug: string, claudeSessionId: string, item: string|number, profile: ReturnType<typeof repoProfile>}} o
 * @param {{run?: Function}} [io]
 * @returns {string}
 */
export function acquireImplLane({ sessionSlug, claudeSessionId, item, profile }, { run: runFn = run } = {}) {
  return acquireLane({
    sessionSlug, claudeSessionId, item, purpose: 'conveyor-delivery-impl', repo: profile.checkoutPath,
    // A zero-wait acquire failed outright whenever another acquire's shared scan held the lock (2 Codex builds
    // died as wrapper-threw, 2026-10-07); a bounded wait rides out that contention.
    waitMs: IMPL_LANE_ACQUIRE_WAIT_MS,
  }, { run: runFn });
}

/**
 * The delivery-report CLI's own small dependency closure (mirrors `codex-delivery-provider.mjs
 * #FIX_REPORT_CLI_REL_FILES`'s shape exactly — same problem, same fix, a different CLI) — every file
 * `delivery-report-cli.mjs` imports at runtime, repo-relative.
 */
export const DELIVERY_REPORT_CLI_REL_FILES = Object.freeze([
  'scripts/operations/delivery-report-cli.mjs',
  'scripts/operations/delivery-report-store.mjs',
  'scripts/operations/delivery-report-record.mjs',
  'scripts/lib/write-all-sync.mjs',
]);

/**
 * REAL — stages `delivery-report-cli.mjs` + its closure into a NON-`we` implementation lane, at the EXACT SAME
 * repo-relative paths the (unparameterized, hardcoded) `delivery-agent-brief-v2.md` already tells the agent to
 * invoke (`node scripts/operations/delivery-report-cli.mjs report ...`, four call sites, none templated) — so
 * this fix needs no brief change at all, unlike `codex-delivery-provider.mjs#stageFixReportCliIntoLane`, which
 * stages into a DEDICATED subdirectory because a fix/ci-heal lane is reconstituted from an EXISTING PR branch
 * that might predate the CLI's own existence and so cannot safely assume the real path is free. A delivery's
 * implementation lane has no such history — it is a plain clone of `frontierui`/`plateau-app`, a different
 * application entirely, which has never had a `scripts/operations/` directory of its own (confirmed by
 * listing a real lane of each: `we:scripts/` exists in both, `scripts/operations/` in neither) — so staging at
 * the real path is safe, not a guess, and keeps the agent's own sanctioned report command byte-identical
 * whichever repo its lane belongs to.
 *
 * Required for EVERY foreign-repo delivery: without it, the agent's very first
 * `delivery-report-cli.mjs report --status=started` call fails outright (`MODULE_NOT_FOUND`) before it ever
 * reaches the item's own spec, because the impl lane is that OTHER repo's clone and never carried this file to
 * begin with. Idempotent (plain overwrite) and cheap (four small files with no dependencies of their own
 * beyond `node:fs`/`node:path`/`node:url`), so re-staging on a gate-failure resume costs nothing.
 *
 * @param {string} lanePath - the resolved, absolute implementation-lane clone.
 * @param {{repoRoot?: string, readFile?: (p: string) => string, ensureDir?: (p: string) => void,
 *   writeFile?: (p: string, data: string) => void}} [io]
 */
export function stageDeliveryReportCliIntoLane(lanePath, {
  repoRoot = REPO_ROOT,
  readFile = (p) => readFileSync(p, 'utf8'),
  ensureDir = (p) => mkdirSync(p, { recursive: true }),
  writeFile = (p, data) => writeFileSync(p, data),
} = {}) {
  if (typeof lanePath !== 'string' || !lanePath.trim()) {
    throw new TypeError('deliver-item-wrapper: `lanePath` must be a non-empty absolute path');
  }
  const root = String(repoRoot).replace(/\/+$/, '');
  const lane = lanePath.replace(/\/+$/, '');
  for (const relPath of DELIVERY_REPORT_CLI_REL_FILES) {
    const dest = `${lane}/${relPath}`;
    ensureDir(dirname(dest));
    writeFile(dest, readFile(`${root}/${relPath}`));
  }
}

// ================================================================================================
// 2. Spawn + get the structured report, THROUGH A PROVIDER PORT — SKETCH shell over a REAL primitive, now
//    restructured (per operator follow-up) to mirror the SAME provider-port extraction already landed for
//    #3579 (`createDispatchSinks`'s `provider` param, `we:scripts/operations/dispatch-lane-io.mjs`) and #3370
//    (`createDefaultJudge`'s injected implementation, `we:scripts/operations/cli-adapter.mjs`). Those two
//    extractions named the SAME shape this file needs: "the CLI-specific argv construction and spawn call
//    stay exactly where they are; only what sits BETWEEN them and the call site becomes a named port." Here,
//    the port is `DeliveryAgentProvider` — one provider per CLI a delivery agent might run under.
//
//    `spawnAgentToCompletion` (REAL, imported below from `dispatch-lane-io.mjs`) does not RETURN — i.e. this
//    provider's own `await` does not resolve — until its child process exits: the fact this whole no-polling
//    design rests on (FIRM REQUIREMENT 4). #3383 mechanical-dispatcher follow-up converted it from a
//    synchronous `execFileSync` call to an awaited async `spawn()` (see that function's own header for why —
//    the sync call could not expose the child's real CPU usage), with the exact same blocking-until-done
//    semantics from this provider's own caller's perspective. It stays the shared low-level spawn primitive
//    every Claude-based provider's `spawn` ultimately calls; what varies PER PROVIDER is only the argv/settings
//    a given CLI needs to achieve "minimal context, no hooks lost, no polling."
// ================================================================================================

/**
 * @typedef {object} DeliveryAgentProvider
 * @property {string} name
 * @property {(request: {sessionId: string, prompt: string, resumeSessionId?: string|null}) => void} spawn
 *   BLOCKS until the agent's own turn ends (FIRM REQUIREMENT 4 — no polling, ever). No return value is
 *   needed: the delivery-report contract (`we:scripts/operations/delivery-report-cli.mjs`) is
 *   PROVIDER-AGNOSTIC BY DESIGN — whichever CLI a provider spawns, the AGENT shells the same report CLI
 *   inside its own run, so `runAgentToCompletion`/`resumeAgentWithGateFailure` always read the result via
 *   `tryReadDeliveryReport`, never via anything provider-specific. This is exactly why the port can be this
 *   small: "minimal-context spawn" is the only CLI-specific behavior a provider owns.
 */

/**
 * CLAUDE_RESTRICTED_PROVIDER — the REAL, INDEPENDENTLY-VERIFIED implementation of {@link DeliveryAgentProvider}.
 * This revision REPLACES an earlier `--bare`-based draft (`CLAUDE_BARE_PROVIDER`); see below for exactly why,
 * with evidence, not assertion — this file has already been burned once by an unverified assumption about
 * flag interaction, so every claim here was re-run against the real CLI (v2.1.266) immediately before writing
 * it in, several of them TWICE (once to confirm the defect, once against the fix).
 *
 * WHY NOT `--bare` (the previous draft). `--bare`'s own help text: "Anthropic auth is strictly
 * ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)." Confirmed on this
 * machine: no `ANTHROPIC_API_KEY` and no `apiKeyHelper` configured — every dispatched sessions today
 * authenticates via the operator's own OAuth/subscription login, which `--bare` cannot use at all. Switching
 * to `--bare` would require provisioning a separate, real, pay-per-token API key with no such budget line
 * today — a genuine added cost, not a config nit.
 *
 * WHY NOT `--safe-mode` either (the FIRST replacement candidate — REJECTED after real testing, not on the
 * operator's earlier text-only smoke test). `--safe-mode`'s own help text: "Start with all customizations
 * (CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents, output styles, workflows,
 * custom themes, keybindings, and more) disabled ... Admin-managed (policy) settings still apply." Unlike
 * `--bare`'s help text (which explicitly lists `--settings` among what may be layered back on top),
 * `--safe-mode`'s text makes NO such carve-out for an ad-hoc `--settings` file — only "admin-managed (policy)"
 * settings, a fixed system location this file never writes to. That reading was CONFIRMED empirically, not
 * left as a documentation ambiguity: ran a command `we:scripts/guard-bash.mjs` denies for real — a hand-set
 * git-commit identity override (`git commit --author=...`), which the deny table blocks with a named reason
 * — through `claude --safe-mode --settings=<the real ensureDeliveryHooksSettingsFile() output> -p ...`
 * (`ANTHROPIC_API_KEY` unset in the test shell). The command EXECUTED — `git` ran for real and only failed
 * because nothing was staged (`no changes added to commit`); `permission_denials` in the JSON result was
 * `[]`. No hook fired. This is exactly the gap the operator's OWN earlier smoke test could not have caught: it
 * used a pure-text prompt that never invoked the Bash tool at all, so it verified auth and nothing else. A
 * `--safe-mode` swap would have fixed auth while SILENTLY dropping `we:scripts/guard-lane.mjs`/
 * `we:scripts/guard-bash.mjs` protection entirely — destructive-git-op guard, the `main`-push block, lane
 * ownership — for every delivery agent it spawned, which is a regression, not a fix.
 *
 * THE ACTUAL FIX: `--restricted`. Its own help text: "removes the built-in tools that run commands or code
 * (Bash, PowerShell, REPL and the other code-running tools) and WebFetch unless `--tools` names them, and
 * ignores user, project and local settings files (**managed settings and `--settings` still apply**; add
 * `--strict-mcp-config` to skip MCP servers too)." That explicit `--settings`-still-applies carve-out is
 * exactly what `--safe-mode` lacked, and it was CONFIRMED to hold for hooks specifically, not just read from
 * the help text: the identical denied git-commit-identity-override command, run through
 * `claude --restricted --tools=Bash,Edit,Write,Read,Glob,Grep --strict-mcp-config --disable-slash-commands
 * --settings=<same real hooks file> -p ...` (again `ANTHROPIC_API_KEY` unset), came back BLOCKED with
 * `guard-bash.mjs`'s own deny text verbatim. A second, POSITIVE-path run of an undenied command
 * (`` `echo test` ``) through the same argv returned its real output (`` `test` ``) — confirming the hook
 * layer does not over-block ordinary commands either.
 *
 * `--tools` IS REQUIRED EXPLICITLY — verified, not assumed: `--restricted --tools=default` still reported "no
 * shell tool available" for a Bash request (`"default"` does not restore what `--restricted` removed); only a
 * literal tool-name allowlist does. `Bash,Edit,Write,Read,Glob,Grep` is the set this wrapper's agent actually
 * needs (build + report); extend it here, in one place, if a future brief needs more.
 *
 * `--strict-mcp-config` closes a DIFFERENT leak `--restricted` alone does NOT: without it, a `--restricted`
 * session still surfaced this operator's own personal MCP tool defs (Gmail/Calendar/Drive) in the agent's
 * tool list — `--restricted`'s own help text says as much ("add `--strict-mcp-config` to skip MCP servers
 * too"). With it, a follow-up probe asking the agent to list every skill/tool it could see in context showed
 * none of that — no skill names, no slash-command list, no personal MCP surface, and (separately probed) no
 * CLAUDE.md/AGENTS.md content either (confirmed by asking the agent directly whether either was loaded; it
 * reported neither was, and could only quote their contents after reading them itself, on request, via Bash —
 * i.e. a deliberate read it performed, not auto-loaded context). `--disable-slash-commands` ("Disable all
 * skills") is KEPT as defense in depth: `--restricted`'s own help text, unlike `--safe-mode`'s, never mentions
 * skills at all, so unlike under `--safe-mode` (where the two flags plausibly overlapped completely) this flag
 * is doing real, independent, unverified-to-be-redundant work here — cheap to keep, not proven safe to drop.
 *
 * `--resume` UNDER THIS COMBINATION — independently verified, not assumed from the `--bare` draft's own
 * unresolved flag. Started a real session with `-p --session-id <uuid>`, then resumed it with the FULL
 * `--restricted`/`--tools`/`--strict-mcp-config`/`--disable-slash-commands`/`--settings` argv plus
 * `--resume <same uuid>` and a fresh prompt (no `-p` in the resume branch, matching the code below) — it
 * returned the SAME `session_id` in its result (a genuine resume, not a fresh session), completed with no
 * hang despite the missing `-p` (this CLI treats non-TTY/redirected stdout as non-interactive on its own,
 * confirmed by inspecting `claude --help`'s own note on `-p`/print mode), and — run a second time with a
 * denied command instead of a benign one — the hook STILL fired on the resumed turn. All three (auth without
 * a key, hooks firing, `--resume` preserving both) hold for this exact argv, not inferred from the fresh-spawn
 * case alone.
 */
/**
 * DELIVERY_AGENT_SPAWN_TIMEOUT_MS — the timeout budget for {@link CLAUDE_RESTRICTED_PROVIDER}'s ONE blocking
 * `execFileSync` call (bug 6, live #3371 attempt, confirmed 2026-09-09 by source read, not inference).
 *
 * DELIBERATELY SEPARATE from `dispatch-lane-io.mjs`'s own `SPAWN_TIMEOUT_MS` (60s) — that constant is correctly
 * sized for its OTHER caller in that file, `defaultClaudeProvider`, which fires a fire-and-forget `claude --bg`
 * dispatch meant to return almost instantly. `CLAUDE_RESTRICTED_PROVIDER.spawn` is the OPPOSITE shape: per this
 * file's own comment at the call site below ("BLOCKS — the only 'wait'"), it is DESIGNED to block for the
 * delivery agent's entire real turn — build + the `verify-lane` gate + the full converge loop this same agent
 * drives inside that one turn (`runConverge`, further down this file). Passing no override here means silently
 * inheriting the 60s budget meant for the OTHER caller — exactly the confirmed bug: two real live #3371 attempts
 * both died at ~60-64s (`spawnSync claude ETIMEDOUT` / SIGKILL) before any real build work could complete. This
 * is load-bearing: no real delivery build can ever finish under the inherited 60s budget, regardless of how the
 * build itself is going.
 *
 * SIZING — grounded in a real observed number, not picked arbitrarily. Neither `verify-lane.mjs`'s own header
 * nor any other doc in this repo states a numeric upper bound for a full build+gate+converge cycle, but
 * `docs/agent/platform-decisions.md` (the #2908 amendment, ratified) cites the review-convergence loop's first
 * real run, PR #1018 (`care: elevated`): 16 agents, 1.08M tokens, **56 minutes**, for the converge loop ALONE.
 * This wrapper's one blocking spawn covers build + gate + that SAME converge loop end to end, so a 56-minute
 * figure for convergence by itself is a FLOOR, not a ceiling, for the whole call. 60 minutes is a generous but
 * still-bounded budget above that observed floor — not unlimited: `execFileSync`'s `killSignal: 'SIGKILL'`
 * still fires past it, so a genuinely wedged agent is still reclaimed, just on a realistic clock instead of one
 * sized for an unrelated fire-and-forget caller.
 *
 * NEVER collapse this back into `SPAWN_TIMEOUT_MS` — see that constant's own caller (`defaultClaudeProvider`,
 * `dispatch-lane-io.mjs`) for why 60s is correct THERE, and only there.
 */
export const DELIVERY_AGENT_SPAWN_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// #xu2pp2m — `buildRestrictedProviderArgv` EXTRACTED to `./minimal-context-provider.mjs` (imported above),
// unchanged: still the identical argv this docblock always described, just defined once, in the shared module,
// for both this wrapper and `review-dispatch-wrapper.mjs` (which does NOT use it today — the verified reviewer
// shape needs no Claude spawn at all, see that file's own header — but the export exists here so a future
// fixer mechanism, built on this same shared module, does not re-derive it).

/**
 * PURE. The real environment variables bug 7 (live #3371 attempt, confirmed 2026-09-09) found the delivery
 * brief genuinely needs — `we:skills-src/conveyor/delivery-agent-brief-v2.md` tells the agent these ARE real
 * shell env vars (`$LANE`, `$DELIVERY_SESSION`, `$DELIVERY_ITEM`; it even says to run `printenv LANE`) and uses
 * them directly inside bash commands (`--session=$DELIVERY_SESSION --item=$DELIVERY_ITEM`), but the wrapper was
 * only ever appending `[env: DELIVERY_SESSION=... LANE=...]` as literal TEXT at the end of the prompt string —
 * it reads like a shell env line and is not one. Confirmed live: the agent correctly diagnosed it had no real
 * `$LANE` to `cd` into. Exported for the same "the contract is the thing a test can pin" reason
 * `buildRestrictedProviderArgv` is.
 *
 * `lanePath` is the RESOLVED, absolute lane clone directory — the SAME value handed to `spawnAgent` as `cwd`
 * (see `CLAUDE_RESTRICTED_PROVIDER.spawn`) — never the bare lane NUMBER `deliverItem`'s own `launch.lane` field
 * carries: the brief's own prose ("`$LANE` is your working directory... `cd`'d you into it") means `$LANE` has
 * to be a real path an agent can `cd`/`printenv` into, not a number with nothing to resolve it against.
 * `WE_DISPATCH_KIND: 'delivery'` is carried alongside the other four (unchanged from the pre-bug-7 stamp) —
 * still the same channel `we:scripts/guard-bash.mjs` is INTENDED to read to deny the delivery agent the
 * mechanical lifecycle commands this wrapper owns itself; see `DELIVERY_HOOKS_SETTINGS`'s own docblock (bug 8,
 * above) for the honest state of that arm as of this commit — it is not built yet.
 *
 * `OPERATION_DELIVERY_REPORTS_DIR` (bug 9, live #3371 attempt 4, confirmed 2026-09-09 by source read) — the
 * env override `we:scripts/operations/delivery-report-store.mjs#resolveDeliveryReportsDir` checks FIRST, before
 * its script-location-relative default. That default resolves `import.meta.url` relative to WHICHEVER PHYSICAL
 * COPY of the script is running — the wrapper's own process (this repo's primary checkout, or wherever the
 * wrapper itself was started from) resolves to ITS root, while the spawned agent runs
 * `scripts/operations/delivery-report-cli.mjs` with `cwd=lanePath`, an entirely separate `git clone`
 * (`lane-pool.mjs`'s pooled lanes are clones, not worktrees — every lane has its OWN copy of every file under
 * `scripts/`), so ITS `import.meta.url` resolves to the LANE's root instead. Left unset, the two processes
 * silently agree on nothing: the agent's `done` report lands under `<lanePath>/.operations/delivery-reports/`
 * while `runAgentToCompletion`'s `tryReadDeliveryReport` call (running in the WRAPPER's own process) looks
 * under the wrapper's own root, finds nothing, and reports a false-negative "no done report (crash or refused
 * effect)" — even though the agent genuinely finished and wrote its report. Confirmed exactly this way against
 * real backlog item #3371 attempt 4: build, gate, and report all completed for real; the wrapper still rejected
 * ~11 minutes later. The fix: resolve the reports dir ONCE, in the WRAPPER's own process (so it always names
 * the SAME absolute directory `runAgentToCompletion`'s own `tryReadDeliveryReport` call resolves to by
 * default), and hand it down explicitly so the spawned agent's `delivery-report-cli.mjs` — regardless of which
 * clone's own physical copy of the script it runs — writes to that same directory instead of recomputing its
 * own, different, script-relative default.
 */
// build-path-codex-isolation-locus — `implLane`, when given (a non-`we` locus's implementation lane — see
// `resolveDeliveryLocus`/`acquireImplLane`), rides as its OWN env var, `IMPL_LANE` — omitted entirely (never an
// empty string) when this is an ordinary `we`-locus delivery, so `.toEqual`'s existing exact-shape assertions on
// this function's output are unaffected by a caller that never passes it.
// #4348 — `lanePath` is ALWAYS the WE lane (the clone holding `backlog/<spec>.md`), never the impl lane, even
// for a cross-locus item whose spawn cwd IS the impl lane. The brief's contract is `$LANE` = WE lane,
// `$IMPL_LANE` = impl lane; before #4348 both providers passed their cwd here, so a cross-locus agent got
// `LANE === IMPL_LANE`, could not find its spec, and every plateau-app/frontierui build ended `not-ready`.
export function buildDeliveryAgentEnv({ sessionSlug, item, lanePath, attemptTag, reportsDir, implLane = null }) {
  return {
    WE_DISPATCH_KIND: 'delivery',
    DELIVERY_SESSION: sessionSlug,
    DELIVERY_ITEM: String(item),
    LANE: lanePath,
    ATTEMPT_TAG: attemptTag ?? '',
    OPERATION_DELIVERY_REPORTS_DIR: reportsDir,
    ...(implLane ? { IMPL_LANE: implLane } : {}),
  };
}

/**
 * Observability fix — small, per the operator's own framing ("a capture-and-write, not a new subsystem").
 * `defaultSpawnAgent`'s `execFileSync` call discards the spawned child's stdout/stderr entirely today; the
 * live #3371 attempt's two real blocking bugs (7 and 8, both in this file) were only found by manually hunting
 * down the agent's own separately-persisted Claude Code session transcript by UUID — real diagnostic time this
 * would have saved outright. `execFileSync` attaches whatever the child wrote to `error.stdout`/`error.stderr`
 * on ANY thrown failure (a non-zero exit, or the `timeout`/`killSignal: 'SIGKILL'` path bug 6 already relies
 * on), so this captures both and writes them under `.operations/` (the same sidecar family
 * `ensureDeliveryHooksSettingsFile`/`delivery-report-store.mjs` already use), named by `sessionSlug` — with a
 * `-resume` suffix when this was a resume (so a resume's failure never clobbers the fresh spawn's own record)
 * plus a timestamp (so repeated failures for the same session don't clobber each other either). Best-effort,
 * on purpose: a failure to WRITE the capture must never mask the real spawn error it exists to explain, so this
 * never throws — it degrades to `null` and lets the original error propagate untouched.
 */
// #xu2pp2m — the actual write now lives in the shared `persistSpawnFailure(dirName, sessionSlug, error, opts)`
// (`./minimal-context-provider.mjs`, GENERALIZED only by an explicit `dirName` param in place of the
// hardcoded `'delivery-spawn-failures'` literal — byte-identical output otherwise). This name is kept as its
// own local function (rather than a direct re-export) because `CLAUDE_RESTRICTED_PROVIDER.spawn`'s own
// `persistFailure = persistDeliverySpawnFailure` default is a literal identifier its own test asserts on by
// name (source-level) — see that test for why.
function persistDeliverySpawnFailure(sessionSlug, error, opts = {}) {
  return persistSpawnFailure('delivery-spawn-failures', sessionSlug, error, opts);
}

const CLAUDE_RESTRICTED_PROVIDER = {
  name: 'claude-restricted',
  // #3850 Fork 2 — the CANONICAL vendor this provider actually spawns, in `DELIVERY_VENDOR_PROVIDERS`'s own
  // vocabulary (`we:scripts/lib/dispatch-contracts.mjs`, `#agent-vendor-registry`). `decideParkMode` reads
  // this — never `name` (which varies per wrapper: `claude-restricted`, `claude-restricted-fix`, …) — to
  // decide whether the PR that spawned it needs Fork 2's land-seam hold.
  vendor: 'claude',
  // `io` is injectable ONLY so a test can assert what this spawns without touching the real filesystem or a
  // real `claude` process — mirrors this file's existing `{ run: runFn = run }` pattern (e.g.
  // `runGateWithOneRetry`, `runConvergeEdit`). Real call sites (`runAgentToCompletion`,
  // `resumeAgentWithGateFailure`) pass `{ sessionId, prompt, resumeSessionId?, lane, sessionSlug, item,
  // attemptTag }` — `lane`/`sessionSlug`/`item`/`attemptTag` added by bug 7's fix, below.
  async spawn(
    {
      sessionId, prompt, resumeSessionId = null, lane, sessionSlug, item, attemptTag, model = 'sonnet', effort = 'medium',
      // build-path-codex-isolation-locus — see `runAgentToCompletion`'s own docblock for what sets this.
      lanePathOverride = null,
    } = {},
    {
      ensureSettingsFile = ensureDeliveryHooksSettingsFile,
      spawnAgent = spawnAgentToCompletion,
      resolveLane = resolveLanePath,
      run: runFn = run,
      persistFailure = persistDeliverySpawnFailure,
      resolveReportsDir = resolveDeliveryReportsDir,
      recordCpu = recordChildResourceUsage,
      stageDeliveryReportCli = stageDeliveryReportCliIntoLane,
      // 117 S3a (D7 FINAL) — the unified detached worker wrapper. OFF unless `WE_WORKER_WRAPPER=on` (or a test says
      // so): off is byte-identical to before this seam existed. See `worker-wrapper.mjs` for what on does.
      workerWrapper = workerWrapperEnabled(),
      runWorkerFn = runWorker,
    } = {},
  ) {
    const settingsFile = ensureSettingsFile();
    // #3627 bug 7(a) (live #3371 attempt) — resolve the REAL lane clone path through the SAME single source
    // of truth `resolveLanePath` already gives every other caller in this file (`runGateWithOneRetry`), never
    // a second, re-derived path computation. Without this the child inherited whatever directory the
    // WRAPPER's own node process happened to run from (this repo's primary checkout) — never the lane — and
    // `--restricted` confines its file tools to the process's OWN working directories (`claude --help`:
    // "confines the file tools to the working directories"), so a wrong cwd here is not cosmetic: the agent
    // is sandboxed into editing the wrong repo entirely. Confirmed live: the agent correctly diagnosed it had
    // no real `$LANE` to `cd` into and was sandboxed into the wrong directory under this exact model.
    // build-path-codex-isolation-locus — `lanePathOverride` wins when given: a non-`we` locus item's whole
    // agent turn (build + gate + converge + PR, downstream of this spawn) runs against the IMPLEMENTATION
    // lane, never the WE lane `lane` (a number in WE's own pool) would resolve to. See
    // `deliverItem`/`resolveDeliveryLocus`'s own docblocks for why.
    // #4348 — the WE lane is resolved EVEN WHEN overridden: it holds the spec, so a cross-locus agent gets it as
    // `$LANE` plus an `--add-dir` grant (`--restricted` confines file tools to the working directories).
    const weLanePath = resolveLane(lane, { run: runFn });
    const lanePath = lanePathOverride || weLanePath;
    const baseArgv = buildRestrictedProviderArgv({
      sessionId, prompt: workerWrapper ? `${prompt}${STRUCTURED_OUTPUT_SUFFIX}` : prompt, resumeSessionId, settingsFile, model, effort,
      addDirs: lanePathOverride ? [weLanePath] : [],
    });
    // 117 S3a — wrapped: `-p --output-format json --json-schema` on fresh AND resumed turns (the schema survives resume).
    const argv = workerWrapper ? withStructuredOutput(baseArgv) : baseArgv;
    // build-path-codex-isolation-locus — a foreign-repo lane never carried `delivery-report-cli.mjs` (it is a
    // plain clone of THAT repo, not WE) — stage it at its real repo-relative path before the agent's first
    // `report --status=started` call needs it. See `stageDeliveryReportCliIntoLane`'s own docblock for why the
    // real path is safe here (unlike the fix wrapper's dedicated-subdir staging).
    if (lanePathOverride) stageDeliveryReportCli(lanePath);
    // #3627 bug 9 (live #3371 attempt 4) — resolve the delivery-reports sidecar directory ONCE, in the
    // WRAPPER's OWN process, via the same `resolveDeliveryReportsDir` this file's own `tryReadDeliveryReport`
    // call (`runAgentToCompletion`) uses to read the report back — never leave it to the spawned agent's copy
    // of `delivery-report-store.mjs` to recompute its own script-location-relative default, which resolves to
    // a DIFFERENT directory because `lanePath` is a separate `git clone`, not a worktree (see
    // `buildDeliveryAgentEnv`'s own docblock for the full mechanism and the false-negative this fixes).
    //
    // #3383 mechanical-dispatcher FOLLOW-UP FIX — bug 9's own "resolve ONCE, hand down" shape was right, but
    // WHAT it resolved to was wrong: called with no argument, `resolveDeliveryReportsDir()` falls back to its
    // own SCRIPT-LOCATION default, which names wherever THIS WRAPPER's own physical copy of the file lives —
    // always the primary checkout (`deliver-item-run.mjs` is spawned with `cwd: REPO_ROOT`), never `lanePath`,
    // regardless of which lane the delivery is actually for. That silently told every spawned agent to write
    // its completion report OUTSIDE its own lane. Claude's `--restricted` mode never caught this because
    // `guard-lane.mjs`/`guard-bash.mjs` only gate the Edit/Write/Bash TOOLS, and `delivery-report-cli.mjs
    // report` runs as a plain child process the agent shells out to — invisible to those hooks either way —
    // so the wrong-directory write just silently succeeded. Codex's real OS-level lane sandbox has no such
    // blind spot: a write outside `lanePath` came back `EPERM`, which is exactly how this was found (item
    // #3476). Passing `lanePath` here makes the resolution LANE-AWARE — `deliveryReportsDir(lanePath)` inside
    // `resolveDeliveryReportsDir`, not the script-location default — for both providers, going forward.
    const reportsDir = resolveReportsDir(lanePath);
    // #3627 bug 7(b) — REAL env vars (see `buildDeliveryAgentEnv`'s own docblock), not the old text-appended
    // `[env: ...]` footer `fillMinimalBrief` still also appends below (kept — see that function's own comment
    // — the brief's prose reads naturally either way, and real env vars are what the CLI actually needs).
    const deliveryEnv = buildDeliveryAgentEnv({
      sessionSlug, item, lanePath: weLanePath, attemptTag, reportsDir, implLane: lanePathOverride,
    });
    if (workerWrapper) {
      // The wrapper owns the process, the timeout and the record; it never rejects on a worker failure (the v2
      // envelope IS the failure report) and returns the envelope for `runAgentToCompletion` to read the build
      // report from. `legacyRead` keeps the old delivery report working while the brief still asks for it.
      return runWorkerFn({
        role: 'build', launcher: 'claude-p', session: sessionSlug, command: 'claude', argv, cwd: lanePath,
        env: { ...process.env, ...deliveryEnv }, timeoutMs: DELIVERY_AGENT_SPAWN_TIMEOUT_MS, model, item, sessionId,
      }, {
        // keep the SAME env hygiene as the old path (GH_TOKEN stripped, worker marker) via the existing spawn primitive
        spawnToCompletionFn: (_cmd, a, opts, spawnIo) => spawnAgent(a, opts, spawnIo),
        legacyRead: () => tryReadDeliveryReport(sessionSlug, reportsDir),
      });
    }
    try {
      // #3627 bug 6 — explicit `timeout` override, distinct from (and far larger than) dispatch-lane-io.mjs's
      // `SPAWN_TIMEOUT_MS` (60s, correct only for that file's fire-and-forget `claude --bg` caller). Without
      // this override `spawnAgentToCompletion` silently applies its own 60s default here too, SIGKILLing a real
      // build+gate+converge turn before it can finish — see `DELIVERY_AGENT_SPAWN_TIMEOUT_MS`'s own docblock.
      // #3383 mechanical-dispatcher follow-up — ASYNC now (was `execFileSync`, blocking synchronously); see
      // `dispatch-lane-io.mjs#spawnAgentToCompletion`'s own header for the full contract this preserves. The
      // `await` IS the "wait" now, same as the sync call was — the caller still does not proceed until the
      // agent's turn has actually finished. `resourceUsage` is threaded through to `deliverItem`'s `agent.turn`
      // span via `recordChildResourceUsage`/`resolveTurnCpuAttributes` — honestly `null` on real Node today
      // (no `ChildProcess#resourceUsage()` exists; see `spawn-to-completion.mjs`'s own header), kept only for
      // forward compatibility.
      const { resourceUsage } = (await spawnAgent(argv, {
        cwd: lanePath,
        env: { ...process.env, ...deliveryEnv },
        timeout: DELIVERY_AGENT_SPAWN_TIMEOUT_MS,
      })) || {};
      recordCpu(resourceUsage);
    } catch (e) {
      // Observability fix — capture what the child actually said before this bubbles up further (see
      // `persistDeliverySpawnFailure`'s own docblock for why this exists and exactly what it captures).
      // `e.resourceUsage` (present whenever the child actually started — see `spawn-to-completion.mjs`'s own
      // header) is recorded too, so an agent turn that fails still reports its real CPU cost, not a fabricated
      // zero.
      recordCpu(e && e.resourceUsage);
      persistFailure(sessionSlug, e, { resumeSessionId });
      throw e;
    }
  },
};

/**
 * #4348 — the default Codex deny map for every lane a delivery agent can reach: each lane's OWN repo's primary
 * checkout (xftsbsg — read off the lane path, so a plateau-app lane seals `plateau-app`'s checkout, not WE's),
 * de-duplicated. One lane in → byte-identical to `defaultDeliveryDenyPaths(primaryCheckoutForLanePath(lane))`;
 * no recognised pool dir at all → `defaultDeliveryDenyPaths()`'s own default.
 */
function deliveryDenyPathsForLanes(lanePaths) {
  const roots = [...new Set(lanePaths.map((p) => primaryCheckoutForLanePath(p)).filter(Boolean))];
  if (roots.length === 0) return defaultDeliveryDenyPaths();
  return [...new Set(roots.flatMap((root) => defaultDeliveryDenyPaths(root)))];
}

/**
 * CODEX_PROVIDER — #3580. NO LONGER A SEAM: a REAL, live-verified implementation of
 * {@link DeliveryAgentProvider}, structurally parallel to `CLAUDE_RESTRICTED_PROVIDER` above (same `spawn`
 * signature, same injectable-`io` second parameter, same resolve-lane → build-argv → BLOCK → capture-failure
 * order). Everything CLI-specific — which flags, why not `-s`, what replaces the Claude-only
 * `guard-lane.mjs`/`guard-bash.mjs` hooks, and the evidence behind each — lives in
 * `we:scripts/operations/codex-delivery-provider.mjs`'s own file header, deliberately NOT restated here (the
 * same split this file already keeps with `minimal-context-provider.mjs`). The three short version:
 *   1. WRITE ACCESS is `-c default_permissions=locked` + `permissions={locked={extends=":workspace",…}}`,
 *      never `-s workspace-write` — because `codex exec resume` does not accept `-s` at all, so `-s` cannot
 *      give this port ONE sandbox posture across both the fresh spawn and the gate-failure resume.
 *   2. BLOCKING is real: `codex exec` is non-interactive and `execFileSync` returns when the turn ends
 *      (measured live through this exact primitive). `stdio[0]` MUST stay `'ignore'` — see that file.
 *   3. THE SAFETY NET is Codex's own permission profile, not a port of this repo's Claude hooks. Measured
 *      with no model in the loop (`codex sandbox -P locked`): a write into the primary checkout and a write
 *      into a sibling lane both come back `Operation not permitted`, and the profile has no network at all,
 *      so `git push` — `guard-bash.mjs`'s single most important deny — is structurally impossible rather
 *      than merely forbidden. What is left un-guarded is destructive git INSIDE the agent's own lane, whose
 *      blast radius is one disposable clone the pool rebuilds routinely.
 *
 * THE ONE THING SELECTING THIS PROVIDER DOES **NOT** CHANGE, stated so nobody discovers it by surprise: the
 * converge EDITOR this wrapper drives itself (`runConvergeEdit` / `buildConvergeEditorArgv`, further down) is
 * a separate Claude spawn that does NOT go through this port. Choosing `codex` swaps the BUILD agent only;
 * the convergence rounds still run under Claude. That is the port's real boundary today, not an oversight —
 * `DeliveryAgentProvider` was only ever defined over the build/resume spawn.
 */
const CODEX_PROVIDER = {
  name: 'codex',
  // #3850 Fork 2 — see `CLAUDE_RESTRICTED_PROVIDER.vendor`'s own comment; this is the non-Claude side.
  vendor: 'codex',
  // Same `(request, io?)` shape as `CLAUDE_RESTRICTED_PROVIDER.spawn` — `io` exists ONLY so a test can assert
  // what this spawns without a real `codex` process or a real filesystem.
  async spawn(
    {
      sessionId, prompt, resumeSessionId = null, lane, sessionSlug, item, attemptTag, model = CODEX_DELIVERY_MODEL, effort = CODEX_DELIVERY_EFFORT,
      // build-path-codex-isolation-locus — see `runAgentToCompletion`'s own docblock for what sets this.
      lanePathOverride = null,
    } = {},
    {
      spawnAgent = defaultSpawnCodexAgent,
      resolveLane = resolveLanePath,
      run: runFn = run,
      persistFailure = persistDeliverySpawnFailure,
      resolveReportsDir = resolveDeliveryReportsDir,
      readThreadId = readCodexThreadId,
      writeThreadId = writeCodexThreadId,
      denyPaths = null,
      recordCpu = recordChildResourceUsage,
      recordScorecard = recordCodexRunScorecard,
      stageDeliveryReportCli = stageDeliveryReportCliIntoLane,
    } = {},
  ) {
    // Identical resolution order to the Claude provider — the SAME single source of truth for the lane path
    // (#3627 bug 7(a)) and the SAME wrapper-process-resolved reports directory (#3627 bug 9). Both bugs are
    // provider-independent: they are about where the CHILD is and where its report lands, not about which CLI
    // the child is, so re-deriving either here would just be re-introducing them for the second provider.
    // build-path-codex-isolation-locus — `lanePathOverride` wins when given, exactly as in the Claude provider
    // above: THIS is the actual fix for the live #3604 finding — Codex's own OS sandbox extends `:workspace`
    // from THIS `cwd`, so a non-`we` item MUST spawn with cwd = its own implementation lane, never WE's.
    // #4348 — the WE lane is resolved EVEN WHEN overridden: it holds the spec and the `## Progress` bookkeeping,
    // so a cross-locus agent gets it as `$LANE` plus a `"<we-lane>"="write"` grant in the permission profile.
    const weLanePath = resolveLane(lane, { run: runFn });
    const lanePath = lanePathOverride || weLanePath;
    const extraLanes = lanePathOverride ? [weLanePath] : [];
    // build-path-codex-isolation-locus — see `CLAUDE_RESTRICTED_PROVIDER.spawn`'s identical call for why this
    // is required (never optional) whenever the agent's cwd is a foreign repo's lane.
    if (lanePathOverride) stageDeliveryReportCli(lanePath);
    // #3383 mechanical-dispatcher follow-up fix — SAME lane-aware resolution as CLAUDE_RESTRICTED_PROVIDER
    // above (see its own comment for the full root-cause account): `resolveReportsDir()` called with no
    // argument silently named the primary checkout regardless of `lanePath`, which Codex's real sandbox
    // correctly refused (`EPERM`) rather than tolerating like Claude's soft, hook-based one did.
    const reportsDir = resolveReportsDir(lanePath);
    const deliveryEnv = buildDeliveryAgentEnv({
      sessionSlug, item, lanePath: weLanePath, attemptTag, reportsDir, implLane: lanePathOverride,
    });
    // xftsbsg — the deny-map must seal off THIS BUILD'S OWN repo's primary checkout, not always WE's (this
    // module's own default `REPO_ROOT`). `primaryCheckoutForLanePath` reads it straight off the already-resolved
    // `lanePath` (`.lanes/<repo-pool-dir>/lane-<N>`), so a frontierui/plateau-app build denies
    // `$HOME/workspace/frontierui`/`plateau-app`'s real primary checkout instead of leaving it unguarded. `null`
    // (an unrecognized pool-dir basename — e.g. a synthetic test path) falls back to `defaultDeliveryDenyPaths`'s
    // own default, byte-identical to before this fix.
    // #4348 — a cross-locus build reaches BOTH lanes, so BOTH repos' primary checkouts are sealed, and the deny
    // map must cover neither lane.
    const deny = denyPaths ?? deliveryDenyPathsForLanes([lanePath, ...extraLanes]);
    for (const reachable of [lanePath, ...extraLanes]) assertDenyPathsUsable(deny, reachable);
    // Codex mints its OWN thread id and has no `--session-id`, so `resumeSessionId` (a CLAUDE-side UUID the
    // port hands every provider) is used as the SIGNAL that this is a resume, and the actual id is looked up
    // in this provider's own sidecar map. A resume with no recorded thread id is a hard error, never a silent
    // downgrade to a fresh session: the whole point of the gate-failure resume is that the agent still
    // remembers what it built, and a fresh turn would quietly lose that.
    const resumeThreadId = resumeSessionId ? readThreadId(sessionSlug) : null;
    if (resumeSessionId && !resumeThreadId) {
      throw new Error(
        `deliver-item-wrapper: CODEX_PROVIDER cannot resume session ${sessionSlug} — no Codex thread id was `
        + 'recorded for it (the fresh spawn never reached `thread.started`, or its sidecar was removed). '
        + 'Refusing to silently start a NEW session, which would lose the build context the resume exists to '
        + 'carry.',
      );
    }
    const argv = buildCodexDeliveryArgv({
      prompt, cwd: lanePath, denyPaths: deny, resumeThreadId, writableRoots: [...extraLanes, admissionLockRoot(lanePath)], model, effort,
    });
    let stdout;
    try {
      // #3383 mechanical-dispatcher follow-up — ASYNC now (was `execFileSync`); the `await` is still the only
      // "wait", exactly as the sync call was, and budgeted on the same clock (`DELIVERY_AGENT_SPAWN_TIMEOUT_MS`)
      // — see `codex-delivery-provider.mjs#defaultSpawnCodexAgent`'s own header for the full contract this
      // preserves. `resourceUsage` is threaded through to the `agent.turn` span — honestly `null` on real Node
      // today (no `ChildProcess#resourceUsage()` exists; see `spawn-to-completion.mjs`'s own header), kept only
      // for forward compatibility.
      const spawned = (await spawnAgent(argv, {
        cwd: lanePath,
        env: { ...process.env, ...deliveryEnv },
        timeout: DELIVERY_AGENT_SPAWN_TIMEOUT_MS,
      })) || {};
      stdout = spawned.stdout;
      recordCpu(spawned.resourceUsage);
    } catch (e) {
      recordCpu(e && e.resourceUsage);
      persistFailure(sessionSlug, e, { resumeSessionId });
      throw e;
    }
    // #3383 usage-ledger follow-up — best-effort, never throws; see that function's own header.
    recordCodexTurnUsage(stdout, { model });
    // #3383 mechanical-dispatcher Bug 2 fix — score + record THIS run's own scorecard; see
    // `fix-dispatch-wrapper.mjs#FIX_CODEX_PROVIDER`'s own equivalent call for the full root-cause account.
    // Best-effort, never throws (`recordCodexRunScorecard`'s own header).
    recordScorecard({
      stdout, dispatchKind: 'build', role: 'delivery', provider: 'codex', model,
      effort, item, handle: sessionSlug,
    });
    // Record the thread id on a FRESH spawn only — a resume re-announces the same id, so re-writing it is
    // noise. Best-effort by construction (`writeCodexThreadId` never throws): losing the crumb costs the
    // ability to resume, which the guard above then reports loudly, and must never fail a build that worked.
    if (!resumeThreadId) {
      const threadId = parseCodexThreadId(stdout);
      if (threadId) writeThreadId(sessionSlug, threadId);
    }
    // `sessionId` is unused by this provider — Codex has no caller-minted session id (see above). Named in
    // the destructure anyway so the port's request shape stays visible at both implementations.
    void sessionId;
  },
};

/** The provider registry — swap which CLI a delivery agent runs under by changing which key `deliverItem`
 *  is called with (default `'claude-restricted'`), never by editing this file's control flow. */
export const DELIVERY_AGENT_PROVIDERS = Object.freeze({
  'claude-restricted': CLAUDE_RESTRICTED_PROVIDER,
  codex: CODEX_PROVIDER,
});

/**
 * The selectable provider names, in the SAME shape the already-landed judge seam uses
 * (`we:scripts/operations/cli-adapter.mjs#JUDGE_PROVIDER_NAMES`) — one exported frozen list that both the
 * resolver below and every CLI flag validator can name, so "which providers exist" is stated once.
 */
export const DELIVERY_AGENT_PROVIDER_NAMES = Object.freeze(Object.keys(DELIVERY_AGENT_PROVIDERS));

/** The default, unchanged by #3580: Claude stays the delivery agent unless a caller names Codex on purpose. */
export const DEFAULT_DELIVERY_AGENT_PROVIDER_NAME = 'claude-restricted';

/**
 * Name → provider, refusing an unknown name by NAME rather than returning `undefined` for a caller to trip
 * over later. Deliberately mirrors `cli-adapter.mjs#resolveJudgeProvider` down to the error wording, because
 * the two seams are the same shape and an operator who has met one should not have to learn the other.
 *
 * @param {string} [name] - one of {@link DELIVERY_AGENT_PROVIDER_NAMES}.
 * @returns {DeliveryAgentProvider}
 */
export function resolveDeliveryAgentProvider(name = DEFAULT_DELIVERY_AGENT_PROVIDER_NAME) {
  const provider = DELIVERY_AGENT_PROVIDERS[String(name).trim()];
  if (provider) return provider;
  throw new Error(
    `deliver-item-wrapper: unknown delivery agent provider ${JSON.stringify(name)} — one of `
    + `${DELIVERY_AGENT_PROVIDER_NAMES.join('|')}`,
  );
}

/**
 * 117 S3a — derive the BUILD report (the exact shape `tryReadDeliveryReport` returns, which every branch of
 * `deliverItem` reads) from a worker-wrapper run. Behaviour-identical downstream; only the record format moved.
 *  - the OLD delivery report, when the wrapper had to fall back to it, is returned untouched (full fidelity);
 *  - `done` -> `done`; `blocked` + `needs-ruling` -> `needs-human-judgment`; any other `blocked` -> `blocked`;
 *  - `no-change` / `not-applicable` -> `blocked` with no files (the "not ready" branch), because a build that
 *    changed nothing has nothing to park;
 *  - `unparseable` / `aborted` throw the same "exited with no done report" error a crash always did.
 * @param {{envelope: object, legacyRecord?: object|null}} spawned
 * @param {string} sessionSlug
 */
export function buildReportFromEnvelope(spawned, sessionSlug) {
  const { envelope, legacyRecord } = spawned;
  if (legacyRecord && legacyRecord.status === 'done') return legacyRecord;
  const report = envelopeReportOrNull(envelope, sessionSlug);
  if (!report) {
    const why = envelope?.parse?.reason ?? envelope?.result?.outcome ?? 'no result';
    throw new Error(`deliver-item-wrapper: agent for ${sessionSlug} exited with no done report (crash or refused effect) — worker-result envelope: ${why}`);
  }
  return report;
}

/** The report for a finished v2 envelope, or `null` when it holds no usable result (not done, unparseable, aborted). */
export function envelopeReportOrNull(envelope, sessionSlug) {
  if (!envelope || envelope.v !== 2 || envelope.status !== 'done' || !envelope.result) return null;
  const r = envelope.result;
  const base = { v: 1, session: sessionSlug, item: envelope.item, status: 'done', learning: r.learning ?? null, startedAt: envelope.startedAt, updatedAt: envelope.updatedAt };
  const files = Array.isArray(r.filesTouched) ? r.filesTouched : [];
  const reason = [r.summary, r.blocker?.evidence?.text].filter(Boolean).join(' — ').slice(0, 2000);
  switch (r.outcome) {
    case 'done': return { ...base, outcome: 'done', reason: null, filesTouched: files };
    case 'no-change': case 'not-applicable':
      return { ...base, outcome: 'blocked', reason: `worker reported ${r.outcome}: ${r.summary}`, filesTouched: [] };
    case 'blocked':
      return { ...base, outcome: r.blocker?.kind === 'needs-ruling' ? 'needs-human-judgment' : 'blocked', reason: reason || 'blocked', filesTouched: files };
    default: return null; // unparseable / aborted: the caller treats it as a crash
  }
}

/**
 * SKETCH. Spawns the minimal-brief agent through the given provider and BLOCKS until it exits — no separate
 * wait step, because there is nothing left to wait for once the blocking call itself returns. This is the
 * wrapper side of true push (FIRM REQUIREMENT 4): the AGENT never polls anything — it runs once, reports
 * once, and exits — and neither does the WRAPPER; the single blocking call below IS the wait, and it costs
 * nothing extra because this process was already going to sit idle for exactly as long as the agent's run
 * takes, poll loop or not.
 *
 * BUG-5 FIX: `provider.spawn`'s `sessionId` is `claudeSessionId` — the caller-minted REAL UUID (see
 * `deliverItem`'s own docblock) — never `sessionSlug`. The current Claude CLI validates `--session-id` as a
 * UUID and rejects a human-readable slug like `conveyor-3371` outright; this is the exact failure a live
 * #3371 attempt hit. `sessionSlug` still drives everything it already drove — the brief fill
 * (`fillMinimalBrief`, unchanged below) and the `tryReadDeliveryReport` lookup, since the delivery-report
 * sidecar is keyed by the human-readable dispatch id, not the CLI's own session id.
 *
 * Exported (was module-private) so its wiring is directly testable; `readBrief`/`readReport` are injectable
 * (mirrors this file's own `{ run: runFn = run }` convention) so a test can assert on the exact `sessionId`
 * handed to `provider.spawn` without touching the real filesystem.
 */
export async function runAgentToCompletion(
  {
    item, sessionSlug, lane, attemptTag, provider = CLAUDE_RESTRICTED_PROVIDER, claudeSessionId,
    // build-path-codex-isolation-locus — `deliverItem`'s own resolved implementation-lane path for a non-`we`
    // locus item (`acquireImplLane`'s return value), or `null` for the unchanged `we`-locus case. Threaded
    // straight through to `provider.spawn` (both providers resolve their cwd as `lanePathOverride ??
    // resolveLane(lane)` — see either `spawn`'s own docblock) and re-used below so THIS function's own
    // report-read resolves the SAME directory the spawn actually wrote to.
    lanePathOverride = null,
    // build-orphan-adopt (#4131/#4382 fix) — true when this call is RESUMING an attempt whose own detached
    // wrapper died before it could settle anything further (see
    // scripts/conveyor/build-dispatch-orphan-adopt.mjs). A resume NEVER spawns a fresh agent turn — it trusts
    // the PRIOR attempt's own `done` report, provided the lane still holds the commit that report describes.
    // Neither check alone is enough evidence a prior attempt actually finished: a report with no surviving
    // commit means the lane was reset/reused since; a commit with no report means the agent never sent one (a
    // crash mid-turn) — either way this throws rather than guess at a synthetic report, and the caller (the
    // orphan-adopt pass) is expected to have already decided resumability BEFORE spawning this resume, so the
    // throw here is a defensive fallback, not the primary path.
    resume = false,
  },
  {
    readBrief = () => readFileSync(`${REPO_ROOT}/skills-src/conveyor/delivery-agent-brief-v2.md`, 'utf8'),
    readReport = tryReadDeliveryReport,
    resolveLane = resolveLanePath,
    resolveReportsDir = resolveDeliveryReportsDir,
    run: runFn = run,
    loadItems,
    isLaneCommitAhead = laneHasCommitAhead,
    readEnvelopeRecord = (session) => { try { return tryReadCompletion(session); } catch { return null; } },
  } = {},
) {
  // #3383 mechanical-dispatcher fix — read back from the SAME lane-scoped directory the provider itself just
  // resolved and handed to the spawned agent (see `CLAUDE_RESTRICTED_PROVIDER.spawn`/`CODEX_PROVIDER.spawn`),
  // never this process's own script-location default — which is always the primary checkout, not the lane.
  // `resolveLane`/`resolveReportsDir` mirror the exact same seams each provider already uses, so a test can
  // assert on this independently of which provider ran. Resolved up front (rather than only after the fresh
  // spawn below) so the `resume` branch can use it too — a pure function of `lane`/`lanePathOverride`, so
  // moving it earlier changes nothing about what it resolves to for the pre-existing, non-resume path.
  const lanePath = lanePathOverride || resolveLane(lane, { run: runFn });
  const reportsDir = resolveReportsDir(lanePath);

  if (resume) {
    // 117 S3a — a wrapped attempt left a v2 envelope instead of (or beside) the delivery report; read either.
    const existing = readReport(sessionSlug, reportsDir) ?? envelopeReportOrNull(readEnvelopeRecord(sessionSlug), sessionSlug);
    if (existing && existing.status === 'done' && isLaneCommitAhead({ lane: lanePath, run: runFn })) {
      return existing;
    }
    throw new Error(
      `deliver-item-wrapper: --resume requested for ${sessionSlug} but no resumable done report + lane commit `
      + `was found under ${lanePath} — nothing to resume from`,
    );
  }

  const briefTemplate = readBrief();
  const prompt = fillMinimalBrief(briefTemplate, { item, sessionSlug, lane, attemptTag }, { loadItems }); // SKETCH — see below

  // #3627 bug 7 — `lane`/`sessionSlug`/`item`/`attemptTag` threaded through so the provider can resolve the
  // real lane path (`cwd`) and mint the real env vars the brief needs (`buildDeliveryAgentEnv`) — see
  // `CLAUDE_RESTRICTED_PROVIDER.spawn`'s own docblock.
  const spawned = await provider.spawn({
    sessionId: claudeSessionId, prompt, lane, sessionSlug, item, attemptTag, lanePathOverride,
  }); // AWAITS — see DeliveryAgentProvider's own docblock.

  // 117 S3a — a provider that ran through the unified worker wrapper hands back its v2 envelope: the report the
  // rest of this file acts on is derived from THAT (same shape as the delivery report it replaces).
  if (spawned && spawned.envelope) return buildReportFromEnvelope(spawned, sessionSlug);

  const report = readReport(sessionSlug, reportsDir);
  if (!report || report.status !== 'done') {
    // The agent's process exited without ever sending a `done` report — a crash, per #3436's own precedent.
    // Nothing to poll for: the process is gone, so there is nothing further to wait on. This is itself a
    // result the wrapper acts on (treat as `blocked`, surface literally), never a reason to start waiting.
    throw new Error(`deliver-item-wrapper: agent for ${sessionSlug} exited with no done report (crash or refused effect)`);
  }
  return report;
}

/**
 * REAL (was PLACEHOLDER) — the v2 brief's ONLY placeholder (`{{ITEM_SPEC_PATH_BASENAME}}`,
 * `we:skills-src/conveyor/delivery-agent-brief-v2.md`) is a name `dispatch-lane.mjs`'s own
 * {@link BRIEF_PLACEHOLDERS} has never heard of — this fill does not need it to have: {@link fillBrief}'s
 * substitution branch keys on `requiredNames.includes(name)` for the EXACT-SPELLING match, never on the wider
 * canonical/misspelling table, so a v2-only name substitutes correctly through the SAME function every other
 * kind's fill already trusts. This is the fix the file's own prior docblock named: "real placeholder
 * substitution would reuse `dispatch-lane.mjs#fillBrief` against a v2-specific required-names list, not a
 * hand-rolled replace" — done exactly that way, not a second `String#replaceAll`.
 */
const V2_BRIEF_REQUIRED_NAMES = Object.freeze(['ITEM_SPEC_PATH_BASENAME']);
const V2_BRIEF_OPTIONAL_NAMES = Object.freeze([]);

/**
 * The item's own backlog filename basename (`we:backlog/<num>-<slug>.md`'s `<num>-<slug>.md`), resolved the
 * SAME way `we:scripts/operations/dispatch-lane-io.mjs#findItem` already resolves `ITEM_SPEC_PATH` for every
 * other launch kind — never a second, hand-rolled lookup. `loadItems` is injectable (mirrors `findItem`'s own
 * signature) so a test can hand this a synthetic backlog without touching `src/_data/backlog.js`.
 */
export function resolveItemSpecPathBasename(item, loadItems = () => defaultLoadItems(REPO_ROOT)) {
  const found = findItem(String(item), loadItems);
  if (!found) {
    throw new Error(`deliver-item-wrapper: could not resolve a backlog filename for item #${item} — findItem returned nothing`);
  }
  return found.specPath.split('/').pop();
}

/** REAL. Substitutes the v2 brief's ONE placeholder through `fillBrief`, then appends the same env footer the
 *  sketch already carried (not a placeholder — this repo has no shared "env footer" convention to reuse; it is
 *  plain text outside the brief's own template, never itself a `{{TOKEN}}`). */
export function fillMinimalBrief(template, { item, sessionSlug, lane, attemptTag }, { loadItems } = {}) {
  const basename = resolveItemSpecPathBasename(item, loadItems);
  const { prompt } = fillBrief(template, { ITEM_SPEC_PATH_BASENAME: basename }, V2_BRIEF_REQUIRED_NAMES, V2_BRIEF_OPTIONAL_NAMES);
  return `${prompt}\n\n[env: DELIVERY_SESSION=${sessionSlug} DELIVERY_ITEM=${item} LANE=${lane} ATTEMPT_TAG=${attemptTag ?? ''}]`;
}

// ================================================================================================
// 3. The gate — REAL insight, REAL call (#3627 follow-up graduated this from a raw `verify-lane.mjs` shell-out
//    to the declared `verify` operation — see `runVerifyOperation` below). The load-bearing claim is
//    unchanged: `we:scripts/guard-bash.mjs`'s verification-set deny is a `PreToolUse(Bash)` HOOK — it only
//    fires inside a live Claude Code session's OWN tool calls. This wrapper is a plain Node process the
//    conveyor runs; it is not a Claude Code session and has no Bash TOOL calls for any hook to intercept, so
//    it can run the gate SYNCHRONOUSLY and just block for the 150-350s it takes — no `request`/`check` split,
//    no polling, at all. This is the single biggest concrete win the #3621 push-not-poll idea buys here: the
//    request→poll dance in the live brief's steps 5/8 exists ONLY because the agent's own tool call is what's
//    constrained; a wrapper process was never subject to that constraint to begin with.
// ================================================================================================

// #xu2pp2m — `runVerifyOperation` EXTRACTED to `./minimal-context-provider.mjs` (imported above), unchanged:
// still the identical three-valued (pass/fail/unrun) read of the declared `verify` operation this docblock
// always described — "run one declared operation, read its structured verdict" is the SAME gate-running shape
// this item's shared module generalizes for a future consumer, even though `review-dispatch-wrapper.mjs` reads
// a DIFFERENT operation's own output (`review-loop-cli.mjs`, not `verify`) with its own outcome enum, so it
// does not call this function directly — see that file's own header.

/** One resume-and-retry, not an unbounded loop — mirrors the live brief's own "red gate is a hard stop" bar,
 *  but gives the agent exactly one chance to fix ITS OWN gate failure before that stop applies, since a
 *  transient/self-inflicted red on a fresh diff is common and cheap to hand back once.
 *
 *  #3627 attempt-5 live-run finding — the resumed agent's own SECOND report is now read and honored BEFORE a
 *  second failing/unrun verify is allowed to collapse straight to `red`. A resumed agent that correctly
 *  self-diagnoses the gate problem is not in its own diff — an environment/infra failure it cannot fix by
 *  editing code, e.g. the exact stale-marker `unrun` this fix's part A targets — reports `outcome: 'blocked'`
 *  with a precise `reason`, not a code fix; that honest self-report must survive to the caller as its own
 *  distinct `gate-blocked` status rather than being silently discarded and mapped to `red` regardless of what
 *  it said (the bug: `second.ok` used to be the ONLY thing this function looked at after the resume).
 *  `readReport` is injectable (mirrors `runAgentToCompletion`'s own `readReport = tryReadDeliveryReport`
 *  convention) so this second-report branch is testable without a real delivery-report sidecar on disk. */
export async function runGateWithOneRetry(
  {
    lane, item, sessionSlug, attemptTag, provider = CLAUDE_RESTRICTED_PROVIDER, claudeSessionId,
    // build-path-codex-isolation-locus — same meaning and same source as `runAgentToCompletion`'s own
    // `lanePathOverride`: `deliverItem` passes the SAME value to both, so the gate runs against exactly the
    // lane the agent's turn just edited.
    lanePathOverride = null,
  },
  {
    run: runFn = run, readReport = tryReadDeliveryReport, resolveReportsDir = resolveDeliveryReportsDir,
    commitTurn = commitBuildTurn,
  } = {},
) {
  const lanePath = lanePathOverride || resolveLanePath(lane, { run: runFn });
  // #3565 — the WRAPPER commits the agent's OWN build turn here, before the gate ever runs — the agent never
  // touches `.git` itself any more (see `commitBuildTurn`'s own header for the full redesign reasoning).
  commitTurn({ lane: lanePath, item, provider, phase: 'build' }, { run: runFn });
  const first = runVerifyOperation(lanePath, { run: runFn });
  if (first.outcome === 'pass') return { status: 'green', lanePath };

  // BUG-5 FIX: `claudeSessionId` is the SAME real UUID `runAgentToCompletion`'s fresh spawn used — threaded
  // through from `deliverItem` — never `sessionSlug`. A `--resume` must target the exact CLI session the fresh
  // spawn created; resuming with a fresh/different id (or a non-UUID slug) is exactly the class of bug this
  // fix closes. See `resumeAgentWithGateFailure` and `deliverItem`'s own docblocks for the full reasoning.
  // #3627 bug 7 — `item`/`attemptTag` threaded through too (both already in scope here), same reasoning as
  // `runAgentToCompletion`'s fresh-spawn call: the provider needs them to mint the real env vars.
  // #3627 attempt-5 finding — `gateOutcome` threaded through so the resume prompt itself can stop telling an
  // agent "your gate failed, fix it" when the true outcome is `unrun` (nothing in its diff to fix) — see
  // `resumeAgentWithGateFailure` below.
  await resumeAgentWithGateFailure({
    sessionSlug, lane, item, attemptTag, failureOutput: first.detail, gateOutcome: first.outcome, provider,
    claudeSessionId, lanePathOverride,
  }); // SKETCH — see below
  // #3383 mechanical-dispatcher fix — read back from the SAME lane-scoped directory the resume just used
  // (see `runAgentToCompletion`'s own comment for the full root-cause account), never the wrapper's own
  // script-location default.
  const retryReport = readReport(sessionSlug, resolveReportsDir(lanePath)); // agent's fresh report after the resume — 'done' (fixed) or 'blocked' (couldn't)
  // #3565 — commit whatever the resumed turn changed, same wrapper-owned reasoning as the build commit above,
  // BEFORE the second verify reads the lane. A `blocked` retry that touched nothing no-ops harmlessly here.
  commitTurn({ lane: lanePath, item, provider, phase: 'gate-fix' }, { run: runFn });
  const second = runVerifyOperation(lanePath, { run: runFn });
  if (second.outcome === 'pass') return { status: 'green', lanePath, retryReport };

  // THE FIX: honor the resumed agent's own second report before assuming `red`. An honest `blocked`
  // self-diagnosis outranks a second non-passing verify — it is reported as its OWN distinct status, carrying
  // the agent's own reason, rather than being silently collapsed into `gate-red`.
  if (retryReport && retryReport.outcome === 'blocked') {
    return { status: 'gate-blocked', lanePath, retryReport, reason: retryReport.reason || null };
  }
  return { status: 'red', lanePath, retryReport };
}

/** SKETCH — this is the concrete "push, don't poll" moment for the gate specifically, and it is a firm
 *  operator requirement, not a nice-to-have: the agent never requested this gate run and never checks on it —
 *  it built, reported `done`, and its process already exited (see `runAgentToCompletion`, above). THIS
 *  function is the mechanical layer actively handing the agent a NEW turn, carrying the actual result, only
 *  because there is now a real result to hand it — never a resume-to-ask-"are-you-done-yet". The call below
 *  BLOCKS (same reasoning as `runAgentToCompletion`) until that new turn itself ends, so the caller
 *  (`runGateWithOneRetry`) can safely read the agent's fresh report the very next line with no loop of its
 *  own either. Goes THROUGH THE SAME PROVIDER PORT the initial spawn used (`provider.spawn` with
 *  `resumeSessionId` set) rather than a second, resume-specific Claude-CLI code path — a provider owns BOTH
 *  its fresh-spawn and its resume shape, so `CODEX_PROVIDER` (once real) would supply both from one place. */
async function resumeAgentWithGateFailure({
  sessionSlug, lane, item, attemptTag, failureOutput, gateOutcome = 'fail', provider = CLAUDE_RESTRICTED_PROVIDER,
  claudeSessionId, lanePathOverride = null,
}) {
  // #3627 attempt-5 finding — an `unrun` gate gets an HONEST prompt, not "your gate failed, fix it": that
  // wording is nonsensical when the gate never ran at all (a wrapper/environment problem, e.g. the stale
  // verify marker part A now clears at acquire time), and it is exactly what pushed a real agent to spend a
  // turn correctly explaining there was nothing in its own diff to fix. Explicitly inviting a `blocked` report
  // here is what `runGateWithOneRetry` above now reads and honors, instead of that self-diagnosis happening
  // only by the agent's own initiative against a misleading prompt.
  // #3565 redesign — NEITHER branch asks the agent to commit any more. The agent's OWN job ends at "the
  // files in $LANE are correct"; `runGateWithOneRetry` commits this resumed turn's fix itself, the same
  // wrapper-owned way it already commits the original build (see `commitBuildTurn`'s own header for why —
  // this is the #3565 Codex sandbox finding applied as a structural fix, not a sandbox carve-out).
  const prompt = gateOutcome === 'unrun'
    ? `The verification gate could not RUN for your commit in $LANE (this looks like a wrapper/environment `
      + `problem, not necessarily a problem in your own diff):\n\n${failureOutput}\n\nIf you can see something `
      + `genuinely wrong in your own change, fix it in $LANE and send a fresh \`done\` report exactly as `
      + `before — do NOT run \`git commit\` yourself; the wrapper commits your fix for you. If you cannot find `
      + `anything wrong in your own diff, do not guess at a code change — send a report with `
      + `\`outcome: 'blocked'\` and a precise \`reason\` describing what you observed instead.`
    : `Your gate failed:\n\n${failureOutput}\n\nFix it in $LANE, then send a fresh \`done\` report exactly `
      + `as before — do NOT run \`git commit\` yourself; the wrapper commits your fix for you.`;
  // BUG-5 FIX: both `sessionId` and `resumeSessionId` are `claudeSessionId` — the real UUID minted once in
  // `deliverItem` and reused by the fresh spawn — never `sessionSlug`. `--resume <id>` must name the SAME CLI
  // session the fresh spawn created, and that id must itself be a UUID (CLI-enforced).
  // #3627 bug 7 — this prompt says `$LANE` above, same as the fresh brief, so this resume needs the SAME real
  // cwd/env treatment (`lane`/`sessionSlug`/`item`/`attemptTag` threaded through to the provider) or a resumed
  // agent hits the identical "no real $LANE to cd into" failure the fresh spawn did.
  await provider.spawn({
    sessionId: claudeSessionId, prompt, resumeSessionId: claudeSessionId, lane, sessionSlug, item, attemptTag,
    lanePathOverride,
  }); // AWAITS.
}

// #xu2pp2m — `resolveLanePath` EXTRACTED to `./minimal-context-provider.mjs` (imported above), unchanged: the
// same real `lane-pool.mjs status --json` lookup this docblock always described (never hardcoded path math).

// ================================================================================================
// 4. Converge — REAL LOOP (was SKETCH — a single `step` call mistaken for the whole loop). Verified against
//    `scripts/converge-cli.mjs`'s own source (not assumed): `init`'s action is always `read`; `step` prints
//    `{action, round, roundCap, verdict, outcome, reason, lensVerdicts, findings, dismissed, dialOverrides,
//    invite, ...instruction}`, where `instruction` carries exactly the field the printed `action` needs
//    (`read`/`panel`/`redTeam`/`edit`/`escalation`). This loop executes EVERY action
//    `we:skills-src/converge/SKILL.md`'s action table names and keeps calling `step` — stamped with the
//    `round` it just printed, per the SKILL's own bolded warning — until the action is genuinely `land` or
//    `escalate`, never stopping after the first call.
//
//    WHO RUNS EACH ACTION, AND WHY THAT MATCHES THE SKILL'S OWN INVARIANTS EVEN THOUGH THIS IS A PLAIN NODE
//    PROCESS WITH NO AGENT TOOL:
//      - `read`   — shell the printed `read.command` (verified real: `converge-transports.mjs#readMaterial`
//                    returns `{kind:'shell', command, cwd}` — read directly, not assumed).
//      - `panel` / `red-team` — seat headless jurors through `skills-src/jury/panel-fanout.mjs`, THE SAME shim
//                    the SKILL requires ("never the Agent tool") — this wrapper has no Agent tool to misuse
//                    either way, but the underlying reason (independence is a property of the JUDGE, not of
//                    who launched it) is identical, so the same non-subagent path applies.
//      - `edit`   — the ONE tool-bearing spawn. Goes through THIS FILE's own verified `--restricted` +
//                    hooks-settings argv (see `CLAUDE_RESTRICTED_PROVIDER`'s docblock above), NEVER
//                    `judge-spawn.mjs`'s `--safe-mode` argv — that combination was independently confirmed
//                    elsewhere in this file to drop `guard-lane.mjs`/`guard-bash.mjs` enforcement for a
//                    TOOL-BEARING spawn, which is exactly the protection an editor writing into the lane needs.
//      - `invite` — shell `scripts/review-core-cli.mjs invite` for the growth delta.
//    Every sub-driver takes an injectable `run` (mirrors this file's own `run` helper) so the loop is
//    unit-testable without spawning a real `claude`/`node` child.
// ================================================================================================

const CONVERGE_PANEL_DEPTH = 0; // this wrapper is the top-level driver, never itself a nested panel seat.
const CONVERGE_PANEL_MAX_DEPTH = 2; // `skills-src/converge/SKILL.md`'s own worked `panel-fanout.mjs` example.
const CONVERGE_PANEL_MAX_BUDGET_USD = 8; // same worked example's aggregate ceiling.
// Defensive backstop ONLY. The REAL termination bound is `converge-core.mjs`'s own round cap
// (`deriveNegotiationOutcome`), which guarantees a `land`/`escalate` verdict long before this could fire — if
// it ever does, that is a bug in this loop (or in the core), not a legitimately long real run.
const CONVERGE_MAX_LOOP_STEPS = 200;

function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/**
 * #4356 — WHERE CONVERGE BOOKKEEPING LIVES, AND WHY NOT IN THE LANE. Every `.converge-*` scratch file this
 * loop writes (state, obs, material, panel, red-team, invite, per-round commit message) used to live at
 * `${lane}/.converge-*` — inside the exact working tree `runConvergeEdit` hands a full Bash+Edit+Write agent
 * turn (`cwd: lane`) every round, with no hook protecting any of those paths from that turn. Live evidence:
 * on #4055/lane-4, three successive `converge-cli.mjs step` calls against `.converge-state.json` succeeded;
 * the fourth failed immediately after `runConvergeEdit` ran, `mustExist` reporting the file gone. #4348 hit
 * the same class of bug on a sibling file in this family.
 *
 * The fix relocates the whole family to a SIBLING of the lane (`dirname(lane)/.converge-scratch/
 * <lane-basename>/`), never a subdirectory of `lane` — the same "transient orchestration state belongs in a
 * sidecar, never inside the tree an autonomous turn can reach" principle
 * `we:docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates` already states for
 * `run-store.mjs#runsDir`. Resolved from `lane` itself, never this module's `REPO_ROOT` or `process.cwd()`:
 * `REPO_ROOT` does not resolve reliably inside a bundled/transformed module graph (confirmed live against
 * this file's own test suite), where `lane` is always a real, already-resolved absolute path.
 *
 * NOT A HARD SANDBOX BOUNDARY. The editor turn keeps its `Bash` tool, which is not confined to `cwd` — it can
 * still reach a sibling directory via `../` or an absolute path. What relocation actually buys: these files
 * are no longer sitting in the one directory the editor turn is handed and already operating in every round,
 * so a plain `ls`/`git status` inside the lane or a lane-wide cleanup sweep never touches them — no
 * path-based REASON to see or sweep them, not a guarantee they are unreachable. The `existsSync` check before
 * every `step` call (below) is the real backstop for the residual case; relocation just makes that backstop's
 * job rare instead of routine — the same principle `converge-daemon-pass.mjs`'s own `assertCloneNotInUse`
 * guard applies to a different clone-safety hazard.
 *
 * Exported so tests can compute the exact same path a real run would use, rather than re-deriving it.
 */
export function convergeScratchDir(lane) {
  const dir = resolveConvergeScratchDir(lane);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A lane slot (e.g. `lane-39`) recycled for a later, unrelated item would otherwise find whatever
 * `.converge-obs-*`/`.converge-material-*`/etc. the PREVIOUS item's run left behind still sitting in its
 * scratch dir — `init` always overwrites `.converge-state.json` fresh, so the state itself was never at risk
 * of going stale, but the round-scoped siblings restart their numbering at 1/0 every run and so accumulate
 * forever on a reused slot. Called ONCE, at the very start of a `runConverge` run (never per-write-site —
 * {@link convergeScratchDir} keeps doing that for every individual write), this wipes and recreates the
 * lane's scratch dir so a run never inherits anything from a previous occupant of the same slot.
 */
export function resetConvergeScratchDir(lane) {
  const dir = resolveConvergeScratchDir(lane);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `resetConvergeScratchDir` runs an unconditional recursive+force `rmSync` on whatever this resolves to, so it
 * must refuse a `lane` it cannot prove safe rather than trust every future caller. `resolvePath` normalizes
 * away a trailing `/..` or `/.` before `basename` ever sees the value (`resolvePath('/tmp/x/..')` is `/tmp`,
 * a normal basename — never a literal `..`), so the one shape that can still reach here is a missing/
 * non-string/empty/whitespace-only `lane` (which would otherwise silently resolve against `process.cwd()`) or
 * one that resolves to the filesystem root itself (`/`, whose basename is `''`). Every real caller hands in an
 * already-resolved absolute path (`lane-pool.mjs status --json`'s own `path` field, or a real `mkdtempSync`
 * result in tests), so this has never fired live — it is a backstop, not a reachable-today path.
 */
function resolveConvergeScratchDir(lane) {
  if (typeof lane !== 'string' || !lane.trim()) {
    throw new Error(
      `deliver-item-wrapper: refusing to resolve a converge scratch dir for an unsafe lane path (${JSON.stringify(lane)}) `
      + '— lane must be a non-empty path string; a missing one would silently resolve against process.cwd().',
    );
  }
  const resolvedLane = resolvePath(lane);
  const laneName = basename(resolvedLane);
  if (!laneName) {
    throw new Error(
      `deliver-item-wrapper: refusing to resolve a converge scratch dir for an unsafe lane path (${JSON.stringify(lane)} `
      + `→ resolved ${JSON.stringify(resolvedLane)}) — its basename is empty (the filesystem root), which would `
      + 'make the scratch dir collapse onto an ancestor directory.',
    );
  }
  return join(dirname(resolvedLane), '.converge-scratch', laneName);
}

/**
 * Seat one headless panel over the round's material, through `panel-fanout.mjs` (REAL — verified against that
 * file's own `panelFanout`/`panelJurors` source: payload is `{subject, subjectNoun, round, materialFile,
 * jurors:[{id, lens, mandate}]}`, the result's `seats` array carries `{lens, ok, findings, ...}` per seat).
 *
 * A touch-set perspective lens (`a11y`/`visual-vs-target`/`perf`) that `converge-cli.mjs` seated with a
 * GROUNDING METHOD instead of a mandate (`entry.mandate === null`) is reported `ok:false` with no findings —
 * this wrapper has no browser/vision tooling to run that method, and the SKILL states that is non-blocking for
 * an advisory lens ("the driver runs that tool and reports the lens `ok: false` if it cannot").
 */
function runConvergePanel(panelEntries, { lane, item, round, material, run: runFn, writeFile = writeJsonFile }) {
  const jurors = [];
  const groundingOnly = [];
  for (const entry of panelEntries || []) {
    if (entry.mandate === null) { groundingOnly.push({ lens: entry.lens, ok: false, findings: [] }); continue; }
    for (let slot = 1; slot <= (entry.jurors || 1); slot += 1) {
      jurors.push({ id: `${entry.lens}#${slot}`, lens: entry.lens, mandate: entry.mandate });
    }
  }
  if (!jurors.length) return { lensResults: groundingOnly };
  const scratchDir = convergeScratchDir(lane);
  const materialFile = `${scratchDir}/.converge-material-r${round}.txt`;
  writeFileSync(materialFile, material ?? '');
  const payloadFile = writeFile(`${scratchDir}/.converge-panel-r${round}.json`, {
    subject: 'pr-diff', subjectNoun: 'diff', round, materialFile, jurors,
  });
  // #3627 follow-up — raw script call, not routed through `run.mjs`: no `panel-fanout`/`jury` operation is
  // registered yet. Would need one built first (see #3627 follow-up); out of scope for this hardening pass.
  const out = runFn('node', [
    'skills-src/jury/panel-fanout.mjs', `--payload-file=${payloadFile}`, `--depth=${CONVERGE_PANEL_DEPTH}`,
    `--max-depth=${CONVERGE_PANEL_MAX_DEPTH}`, `--max-total-budget-usd=${CONVERGE_PANEL_MAX_BUDGET_USD}`,
    `--run-id=converge-${item}-r${round}`,
  ]);
  const result = JSON.parse(out);
  const seated = (result.seats || []).map((s) => ({ lens: s.lens, ok: s.ok, findings: s.findings || [] }));
  return { lensResults: [...seated, ...groundingOnly] };
}

/**
 * Ratify (or fail to ratify) the panel's accept — an independent adversary judging the SAME material with no
 * visibility into the panel's own reasoning (#2707). Same shim, a DISTINCT `--run-id` per the SKILL's stated
 * invariant: reusing the panel's run id would mint the red-team the identity of the juror it must be able to
 * contradict.
 */
function runConvergeRedTeam(redTeam, { lane, item, round, material, run: runFn, writeFile = writeJsonFile }) {
  const jury = (redTeam && Array.isArray(redTeam.jury)) ? redTeam.jury : [];
  if (!jury.length) return { ran: false, findings: [] };
  const scratchDir = convergeScratchDir(lane);
  const materialFile = `${scratchDir}/.converge-material-r${round}.txt`;
  writeFileSync(materialFile, material ?? '');
  const jurors = jury.map((j) => ({ id: `${j.lens}#redteam`, lens: j.lens, mandate: j.prompt }));
  const payloadFile = writeFile(`${scratchDir}/.converge-redteam-r${round}.json`, {
    subject: 'pr-diff', subjectNoun: 'diff', round, materialFile, jurors,
  });
  // #3627 follow-up — raw script call, not routed through `run.mjs`: no `panel-fanout`/`jury` operation is
  // registered yet. Would need one built first (see #3627 follow-up); out of scope for this hardening pass.
  const out = runFn('node', [
    'skills-src/jury/panel-fanout.mjs', `--payload-file=${payloadFile}`, `--depth=${CONVERGE_PANEL_DEPTH}`,
    `--max-depth=${CONVERGE_PANEL_MAX_DEPTH}`, `--max-total-budget-usd=${CONVERGE_PANEL_MAX_BUDGET_USD}`,
    `--run-id=converge-${item}-r${round}-redteam`,
  ]);
  const result = JSON.parse(out);
  const findings = (result.seats || []).flatMap((s) => (s.ok ? (s.findings || []) : []));
  return { ran: true, findings };
}

/** PURE. The argv for the converge editor's one-off, tool-bearing, `--output-format json` spawn — a SIBLING of
 *  {@link buildRestrictedProviderArgv}, not a reuse of it: the editor always spawns fresh (never `--resume`,
 *  a converge round is self-contained) and needs `--output-format json` for a parseable reply, which the
 *  delivery-agent argv has no reason to carry. Exported for the same "argv IS the contract" reason
 *  {@link buildRestrictedProviderArgv} is exported. */
export function buildConvergeEditorArgv({ sessionId, prompt, settingsFile }) {
  return [
    '--restricted', '--tools', RESTRICTED_PROVIDER_TOOLS, '--strict-mcp-config', '--disable-slash-commands',
    '--settings', settingsFile, '--output-format', 'json', '--model', 'sonnet',
    '-p', '--session-id', String(sessionId), prompt,
  ];
}

/**
 * Best-effort parse of the editor's `--output-format json` reply into `{advanced, dismissed}`. Two JSON
 * layers: the CLI's own envelope (`{result: "<the editor's own text>", ...}`), and the editor's own text —
 * the transport's prompt (`converge-transports.mjs#applyRevision`) told it to return PURE JSON. Either layer
 * failing to parse degrades to `{advanced:false, dismissed:[]}` rather than throwing — the SAME fail-closed
 * direction `deriveRoundObservations` already takes for a stalled editor (an unadvanced round escalates; it
 * does not crash the driver). Exported so this degradation is asserted directly, not only through the loop.
 */
export function parseConvergeEditResult(rawOut) {
  try {
    const envelope = JSON.parse(String(rawOut));
    const text = typeof envelope.result === 'string' ? envelope.result : String(rawOut);
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    return {
      advanced: parsed.advanced === true,
      dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
    };
  } catch {
    return { advanced: false, dismissed: [] };
  }
}

/**
 * Spawn ONE fresh restricted editor session for this round. See the section header above for why this goes
 * through this file's own `--restricted` argv rather than `judge-spawn.mjs`.
 *
 * BUG-5 FIX: `sessionId` was the human-readable `${item}-converge-editor-r${round}` string, which the current
 * Claude CLI's `--session-id` validation rejects (same failure class as `runAgentToCompletion`'s — see
 * `deliverItem`'s docblock). This spawn is always fresh (never `--resume` — a converge round is self-contained,
 * per this function's own header comment above), so unlike the delivery agent's single UUID reused across its
 * one resume, a NEW UUID minted per round is correct here — nothing downstream keys off the old readable id
 * (the editor's result comes back parsed straight from `--output-format json`, never looked up by session id).
 * `newSessionId` is injectable only so a test can assert a deterministic value.
 *
 * #3627 bug 7 — this spawn had the SAME real-cwd gap `CLAUDE_RESTRICTED_PROVIDER.spawn` did: no `cwd` was ever
 * passed, so the editor inherited the WRAPPER's own working directory (this file's module-level `run` helper
 * defaults `cwd` to `REPO_ROOT`), not the lane — and `--restricted` confines its file tools to the process's
 * own working directories, so this editor was sandboxed away from the very files `applyRevision`'s own prompt
 * (`converge-transports.mjs`) tells it to edit "in place" at an absolute lane path. Fixed the same way: `lane`
 * — ALREADY the real, resolved lane path here (`runConverge`'s own `lane` param is `gate.lanePath` from
 * `deliverItem`, never a bare lane number — see that function's own `const state = ${lane}/...` usage above,
 * which already assumes exactly this) — is passed straight through as `cwd`, no `resolveLanePath` call needed.
 * `WE_DISPATCH_KIND: 'delivery'` is stamped too, for the same reason `CLAUDE_RESTRICTED_PROVIDER.spawn` stamps
 * it (see `DELIVERY_HOOKS_SETTINGS`'s own honesty note on the state of `guard-bash.mjs`'s matching arm). The
 * OTHER three delivery env vars (`DELIVERY_SESSION`/`DELIVERY_ITEM`/`ATTEMPT_TAG`) are deliberately NOT added
 * here: unlike the delivery brief and `resumeAgentWithGateFailure`'s resume prompt, this editor's own prompt
 * (`applyRevision`, `converge-transports.mjs`) never references `$LANE`/`$DELIVERY_SESSION` — it hardcodes the
 * absolute lane path directly into the instruction text — so nothing in this call's actual prompt would read
 * them; adding unused env vars here would be padding, not a fix for a real gap this prompt has.
 *
 * `provider` (mechanical-dispatcher follow-up to #3580) — NOT a real second implementation, a VISIBILITY fix.
 * Before this, `deliverItem`/`fix-dispatch-wrapper.mjs`/`ci-heal-dispatch-wrapper.mjs` all resolve a real
 * {@link DeliveryAgentProvider} (`CLAUDE_RESTRICTED_PROVIDER` or `CODEX_PROVIDER`) for the BUILD spawn, hold it
 * in a local `provider` variable, and then called `runConverge`/`runConvergeEdit` with NO provider argument at
 * all — not "falls back to Claude", genuinely un-passed, so a Codex-delivered item's converge editor ran under
 * Claude with no record anywhere that a hand-off had even happened. `CODEX_PROVIDER`'s own docblock already
 * says this boundary is deliberate ("the port's real boundary today, not an oversight" — no Codex
 * implementation of the editor role has been built OR live-verified: it would need its own argv builder,
 * parallel to `codex-delivery-provider.mjs#buildCodexDeliveryArgv`, AND a parser that turns Codex's `--json`
 * event stream into the same `{advanced, dismissed}` shape `parseConvergeEditResult` extracts from Claude's
 * `--output-format json` envelope — neither exists, so building one here blind, with no live run to confirm
 * the JSON actually comes back in a parseable shape, would be exactly the kind of unverified claim this
 * codebase's own discipline refuses (see `codex-delivery-provider.mjs`'s file header, "measured, not
 * reasoned", throughout). So the spawn below is UNCHANGED — still always `claude` — but `provider` is now a
 * real parameter, and the requested build provider (which may be Codex) travels alongside the ACTUAL editor
 * provider (always `'claude-restricted'` today) in the return value, so this is a stated fact in the round's
 * own `.converge-obs-*.json` record and in `convergeVerdict`, not a silent gap. Building and live-verifying a
 * real Codex converge editor is a genuine follow-up (file it rather than guess at it here).
 */
export function runConvergeEdit(
  editInstruction,
  {
    item, round, lane, run: runFn, ensureSettingsFile = ensureDeliveryHooksSettingsFile, newSessionId = randomUUID,
    dispatchKind = 'delivery', provider = CLAUDE_RESTRICTED_PROVIDER,
  },
) {
  const settingsFile = ensureSettingsFile();
  const sessionId = newSessionId();
  const argv = buildConvergeEditorArgv({ sessionId, prompt: editInstruction.prompt, settingsFile });
  // `dispatchKind` GENERALIZED (#xu2pp2m fixer, mechanically-generalized, not behaviourally changed — default
  // stays `'delivery'`, so every existing caller of `runConverge`/`runConvergeEdit` is byte-identical). This
  // used to hardcode `WE_DISPATCH_KIND: 'delivery'` unconditionally, which was correct for the ONLY caller
  // that existed (the delivery wrapper's own converge loop) but would mislabel a FIX dispatch's converge-edit
  // round the same way if reused as-is — `scripts/guard-bash.mjs`'s dispatch-kind deny arm reads this exact
  // env var to decide which mechanical lifecycle commands a wrapper-owned agent may not run itself (see that
  // file's own header). CORRECTED BY #3640: this note used to say a fixer's converge-edit spawn "should
  // identify as `fix`, not `delivery`, once a matching `fix` arm exists there". It must NOT — `fix` is a
  // LAUNCH kind, which `dispatch-lane-io.mjs#defaultClaudeProvider` also stamps on the full-brief fix agent
  // that runs its OWN lifecycle, so an arm keyed on it would be wrong for one of the two (guard-bash's own
  // note refused to write one for exactly that reason). The fix wrapper passes `repair`, a WRAPPER-AGENT kind
  // (`dispatch-lane.mjs#WRAPPER_AGENT_KINDS`) — the same half of the value space this default's own
  // `'delivery'` has always been in. The gap that note called an open follow-up is closed.
  const out = runFn('claude', argv, { cwd: lane, env: markWorkerEnv(sanitizeSpawnEnv({ ...process.env, WE_DISPATCH_KIND: dispatchKind })) });
  // Additive fields only — see this function's own docblock ("VISIBILITY fix") for why these two are always
  // `requestedProvider !== editorProvider` on a Codex-selected delivery, on purpose, not a bug.
  return { ...parseConvergeEditResult(out), requestedProvider: provider.name, editorProvider: CLAUDE_RESTRICTED_PROVIDER.name };
}

/** Shell `review-core-cli.mjs invite` for the jury-growth delta (#2640), per the SKILL's `invite` row. A
 *  crashed/unparseable answer reports back as `null` — exactly what the SKILL says to do ("Report
 *  `inviteEcho: null` if the invite agent crashed"), extended here to any answer this driver could not parse. */
function runConvergeInvite(invite, { lane, round, careLevel, seatedLenses, jurorsPerLens, run: runFn, writeFile = writeJsonFile }) {
  const payloadFile = writeFile(`${convergeScratchDir(lane)}/.converge-invite-r${round}.json`, {
    careLevel, seatedLenses, jurorsPerLens, invitedLens: invite.lens, citedFinding: invite.citedFinding,
  });
  // #3627 follow-up — raw script call, not routed through `run.mjs`: no `review-core-cli`/`invite` operation
  // is registered yet. Would need one built first (see #3627 follow-up); out of scope for this hardening pass.
  try {
    const out = runFn('node', ['scripts/review-core-cli.mjs', 'invite', `--file=${payloadFile}`, '--json']);
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * BUG-14 FIX. The real, live-diffed touched-file list for ONE converge round's commit — `git status
 * --porcelain` in the lane, filtered to drop this wrapper's OWN `.converge-*` bookkeeping, this wrapper's OWN
 * `.delivery-commit-msg-<phase>.txt` bookkeeping (see #3383 fix note below), and the known lane-release
 * scratch litter (`we:scripts/lib/lane-litter.mjs#LANE_RELEASE_LITTER_ALLOWLIST` — `.pr-body.md`/
 * `.commit-msg.txt`/etc, in case any already exist in the lane at converge time). None of these is a real
 * edit the editor/agent made — committing any of them would bury the round's actual diff in wrapper noise.
 * `run` is injectable for tests, same pattern as {@link computeLaneDiffStats}.
 *
 * #4356 — the `.converge-*` family (`.converge-state.json` / `.converge-material-r*.txt` /
 * `.converge-panel-r*.json` / `.converge-redteam-r*.json` / `.converge-invite-r*.json` /
 * `.converge-obs-*-*.json` / `.converge-commit-msg-r*.txt`) no longer gets WRITTEN into the lane at all (see
 * {@link convergeScratchDir}) — it lives in a per-lane sidecar outside the working tree. The `.converge-*`
 * exclusion below is kept as a defensive backstop (a lane recycled from before this fix, or anything else
 * that happens to drop a same-shaped file in the lane, must still never get committed as a real edit), not
 * because this file writes them there any more.
 *
 * #3383 mechanical-dispatcher fix (live #3564 trial, 2026-09-13): `.delivery-commit-msg-build.txt` — the
 * message file {@link commitBuildTurn}'s OWN first (`phase: 'build'`) call writes to the lane, deliberately
 * left uncommitted (it is written AFTER `paths` is computed, so it never lands in that first commit) — used
 * to have NO exclusion here, so the SECOND `commitBuildTurn` call (`phase: 'gate-fix'`, after a resumed
 * agent fixes a red gate) picked it up as an untracked "touched" path and tried to commit it too. That failed
 * outright: `git commit -- <pathspec>` refuses a pathspec that is neither tracked nor already staged — CONFIRMED
 * directly (`git commit -m x -- new-untracked.txt` on a fresh untracked file: `error: pathspec 'new-untracked.txt'
 * did not match any file(s) known to git`) — so the gate-fix commit crashed with exactly that error, live,
 * mid-trial: `error: pathspec '.delivery-commit-msg-build.txt' did not match any file(s) known to git`, which
 * propagated uncaught and discarded the resumed agent's real gate-fix. Excluding it here (mirroring the
 * `.converge-*` exclusion) fixes BOTH problems at once: it can never crash a later commit's pathspec again,
 * and it stops leaking wrapper bookkeeping into the delivery's real diff.
 */
export function convergeRoundTouchedFiles(lane, { run: runFn = run } = {}) {
  const porcelain = runFn('git', ['status', '--porcelain'], { cwd: lane });
  const paths = [];
  for (const line of String(porcelain).split('\n')) {
    if (!line.trim()) continue;
    const path = line.slice(3).trim();
    if (!path) continue;
    if (path.startsWith('.converge-')) continue; // this wrapper's own per-round bookkeeping, not a real edit
    if (path.startsWith('.delivery-commit-msg-')) continue; // commitBuildTurn's OWN msg files — see #3383 note above
    if (isAllowlistedLitterPath(path)) continue; // known delivery-pipeline scratch litter, same reason
    paths.push(path);
  }
  return paths;
}

/**
 * BUG-14 FIX. Commit ONE converge round's genuinely accepted edits — explicit paths, one commit, message
 * written to a file rather than a bash heredoc (the SAME footgun `delivery-agent-brief.md` step 8 calls out:
 * backticks in a heredoc run as a subshell). Paths are staged explicitly first (`git add -- <paths>`) because
 * `git commit -- <paths>` cannot take untracked files. Mirrors that step's own "commit only this item's files, one
 * commit, never `git add -A`" convention, applied per round instead of once at the very end — this wrapper,
 * unlike a human/full-brief session, must commit BEFORE the next `converge-cli.mjs step` call reads the lane's
 * state and BEFORE `openPr`'s `--sha=HEAD` reads HEAD, or a genuinely accepted editor revision never reaches
 * the PR (#3627 bug 14, confirmed live on attempt 6: the backlog-card nuance section and the `.gitignore` line
 * the editor added were both real, accepted edits that PR #2109 shipped without, because nothing had committed
 * them). No-ops (returns `{committed: false}`) when there is nothing real to commit — an `advanced: false`
 * round, or a round whose only touched paths are this file's own `.converge-*` bookkeeping — so a round with
 * no accepted edit never creates an empty/spurious commit.
 *
 * #3383 mechanical-dispatcher fix (live #3564 trial) — `git add -- paths` now runs BEFORE `git commit`.
 * `git commit -F <msg> -- <paths>` alone silently REFUSES any path that is not already tracked or staged
 * (confirmed directly: `git commit -m x -- new-untracked.txt` on a fresh file errors `pathspec
 * 'new-untracked.txt' did not match any file(s) known to git`), so a round whose accepted edit created a
 * genuinely NEW file (not just a modification) would have crashed here uncaught — the same class of bug
 * that broke {@link commitBuildTurn}'s gate-fix commit live (see that function's own note). Staging first
 * makes both new and modified paths committable the same way, with the same "only these exact paths, never
 * `git add -A`" discipline this function's docblock already commits to.
 */
export function commitConvergeRound(
  { lane, item, round },
  { run: runFn = run, writeFile = writeFileSync, touchedFiles = convergeRoundTouchedFiles } = {},
) {
  const paths = touchedFiles(lane, { run: runFn });
  if (!paths.length) return { committed: false, paths: [] };
  const msgFile = `${convergeScratchDir(lane)}/.converge-commit-msg-r${round}.txt`;
  const message = `${machinePrTitle({ repo: repoProfileForLanePath(lane)?.canonicalPrefix?.toUpperCase() ?? 'WE', item, kind: 'fix',
    card: readMainCard(item, (args) => runFn('git', args, { cwd: lane })), subject: `revise ${paths.join(', ')}` })}\n\n`
    + `Commits the accepted editor findings from round ${round} of the #3627 delivery-pipeline converge loop `
    + '(runConvergeEdit reported advanced:true) before the loop continues and before the PR opens.\n';
  writeFile(msgFile, message);
  runFn('git', ['add', '--', ...paths], { cwd: lane });
  runFn('git', ['commit', '-F', msgFile, '--', ...paths], { cwd: lane });
  return { committed: true, paths };
}

/**
 * Map a {@link DeliveryAgentProvider}'s `.name` to the `Co-Authored-By` trailer for a commit made ON ITS
 * BEHALF (#3565's redesign — see `commitBuildTurn`'s own header). PURE, and defaults to the Claude trailer
 * for any name this does not recognize: a wrapper-authored commit must always carry SOME correctly-shaped
 * trailer, and silently omitting one for an unrecognized/future provider name would be worse than a
 * slightly-imprecise default.
 */
export function coAuthorTrailerFor(providerName) {
  if (providerName === 'codex') return 'Co-Authored-By: Codex <noreply@openai.com>';
  return 'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>';
}

/**
 * Commit the delivery agent's OWN turn ON ITS BEHALF — WRAPPER-OWNED, generalizing `commitConvergeRound`'s
 * already-proven "the wrapper computes the real diff and commits it, never the agent" pattern (bug 14, above)
 * to the FIRST commit in a delivery (the initial build, `phase: 'build'`) and to a gate-failure RESUME's own
 * fix (`phase: 'gate-fix'`) — not just a converge round's revision.
 *
 * WHY THIS MOVED OUT OF THE AGENT'S OWN JOB ENTIRELY (#3565). A real Codex delivery trial confirmed Codex's OS
 * sandbox denies `.git` writes inside its own lane. Traced to root cause, not guessed: every lane is
 * `git clone --reference <primary>` (`scripts/lane-pool.mjs#cloneLane`), so a lane's own
 * `.git/objects/info/alternates` file points AT the primary checkout's `.git/objects` verbatim — ordinary git
 * plumbing (`status`, `log`, `commit`) reads through that pointer. The sandbox's own `filesystem` deny map
 * (correctly) ALSO denies reading the primary checkout, so `git status`/`git commit` inside the lane failed
 * `fatal: bad object HEAD` (live-reproduced against real `codex exec` with the exact production argv this
 * repo's `codex-delivery-provider.mjs` builds). The fix on the table was carving `.git/objects` out of that
 * deny map — but the STRUCTURALLY BETTER fix is this one: the dispatched agent, Claude OR Codex, never needs
 * `.git` access at all, because it never runs git itself. Two independent reasons this beats a sandbox
 * carve-out:
 *   1. It GUARANTEES the commit-message/trailer convention mechanically (this function, {@link
 *      coAuthorTrailerFor}) instead of hoping every agent, on every provider, formats a commit correctly.
 *   2. It is a STRONGER isolation guarantee than any deny-list: a deny-list is only as good as what someone
 *      remembered to block, where no path to `.git` at all structurally blocks a force-push, a
 *      `reset --hard`, or a history rewrite from inside the agent's own turn — not by a rule the agent could
 *      misconfigure or a deny-list entry someone forgot, but because there is no `.git` to reach.
 * Applies UNIFORMLY to both providers — neither `CLAUDE_RESTRICTED_PROVIDER` nor `CODEX_PROVIDER` needs its
 * own sandbox carve-out for this any more, because neither one's agent turn touches `.git`. Codex's sandbox
 * denying `.git` writes is therefore not a bug any more — it is simply correct, and stays exactly as strict as
 * it already is.
 *
 * Reuses {@link convergeRoundTouchedFiles}'s real `git status --porcelain` read — its own logic was never
 * converge-specific (it is exactly "the real, live-diffed touched-file list in this lane, minus this
 * wrapper's own bookkeeping litter"), so a second, parallel implementation would just be the same read typed
 * twice. No-ops (`{committed: false, paths: []}`) when there is nothing to commit — an agent that reported
 * `done`/fixed the gate but genuinely left nothing new in the working tree never produces an empty, spurious
 * commit.
 *
 * @param {{lane: string, item: string|number, provider?: DeliveryAgentProvider, phase?: 'build'|'gate-fix'}} o
 * @param {{run?: Function, writeFile?: Function, touchedFiles?: Function}} [deps]
 */
// #3565 real-trial finding (live, 2026-09-13): the delivery agent is DELIBERATELY never taught the
// `we:`/`fui:`/`plateau:` locus-prefix citation convention (delivery-agent-brief-v2.md's own header — "no
// cited convention, no doctrine reference"), so its own `## Progress`/`## Done when` prose routinely quotes
// files by their BARE repo-relative path. Under the OLD design the agent's own `git commit` hit
// `.githooks/pre-commit`'s `npm run lint:locus` backstop (#883/#1574) directly and could fix its own text
// in the same turn; under this redesign the WRAPPER commits after the agent has already exited, so that
// same rejection had nowhere to go — it just failed the whole delivery (reproduced live: `git commit`
// exited non-zero, "2 bare code-path ref(s) ... lack a <repo>: prefix", the wrapper's own best-effort
// release then discarded a genuinely-passing build for a trivially-fixable citation nit).
//
// #3383 mechanical-dispatcher fix (SECOND live #3565 trial, still 2026-09-13, AFTER the first narrow fix
// above had already landed): the first fix only prefixed bare mentions of the delivery's OWN touched
// paths, on the theory that those are the only bare mentions an agent's prose would ever introduce. A
// fresh Codex trial disproved that theory directly — its own `## Progress` note cited an UNTOUCHED
// existing file bare (`queue-store.mjs`, named for context, never itself part of the diff), which the
// touched-paths-only fixer had no way to catch (it was never in that list), and `lint:locus` rejected the
// wrapper's commit again for exactly the same reason, just a different token. `sanitizeOwnLocusMentions`
// below now finds every bare mention `we:scripts/check-standards-rules.mjs#findUnmarkedLocusRefs` (the
// REAL gate's own detector, reused rather than re-approximated) would itself flag in the file's full
// content — touched or not, self-referencing or not — so nothing the gate would reject can slip past this
// fix. `LOCUS_MD_CORPUS_RE` still scopes WHICH touched files get scanned (only the delivery's own touched
// backlog/reports markdown — never every corpus file in the repo, which would be a different, unbounded
// job); it is only the CONTENT scan inside each one that widened.
const LOCUS_MD_CORPUS_RE = /(?:^|\/)(?:backlog|reports)\/[^/]+\.md$/;

/**
 * PURE. Prefix every BARE mention of one of `refs` inside `content` with `we:`, leaving an ALREADY-prefixed
 * mention (`we:<path>`, `fui:<path>`, …) untouched. Generic over its `refs` list — {@link
 * sanitizeOwnLocusMentions} is the only caller, and (as of the #3383 fix above) feeds it every unmarked
 * token `findUnmarkedLocusRefs` finds in the document's own content, not a caller-guessed subset.
 */
export function prefixOwnPathMentions(content, refs) {
  let next = String(content ?? '');
  for (const p of Array.isArray(refs) ? refs : []) {
    if (typeof p !== 'string' || !p) continue;
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<!(?:we|fui|plateau|webeverything|frontierui|plateau-app):)${escaped}`, 'g');
    next = next.replace(re, `we:${p}`);
  }
  return next;
}

/**
 * IMPURE shell around {@link prefixOwnPathMentions}: for every touched path that is itself a
 * `backlog/*.md`/`reports/*.md` document, rewrite it in place (only if it actually changed) so the pending
 * commit passes the repo's locus-prefix backstop. Errors reading/writing one file are swallowed (best-effort
 * — this is a convenience fix-up, never the reason a real build+commit fails for an unrelated fs hiccup);
 * `git commit` below is still the real, authoritative gate.
 *
 * #3383 mechanical-dispatcher fix — the ref list to prefix now comes from `findUnmarkedLocusRefs(before)`
 * (the real `lint:locus` detector run against THIS file's own current content), not from `paths` (the
 * delivery's touched-file list). See {@link LOCUS_MD_CORPUS_RE}'s own comment above for the live trial that
 * found the gap this closes.
 */
export function sanitizeOwnLocusMentions(lane, paths, { readFile = readFileSync, writeFile = writeFileSync } = {}) {
  for (const p of paths) {
    if (!LOCUS_MD_CORPUS_RE.test(p)) continue;
    try {
      const abs = `${lane}/${p}`;
      const before = readFile(abs, 'utf8');
      const refs = findUnmarkedLocusRefs(before);
      if (!refs.length) continue;
      const after = prefixOwnPathMentions(before, refs);
      if (after !== before) writeFile(abs, after);
    } catch { /* best-effort — see docblock */ }
  }
}

// #3383 mechanical-dispatcher fix (live #3564 trial, 2026-09-13) — `git add -- paths` now runs BEFORE
// `git commit`. `git commit -F <msg> -- <paths>` alone silently REFUSES any path that is not already
// tracked or staged (confirmed directly: `git commit -m x -- new-untracked.txt` on a fresh untracked file
// errors `pathspec 'new-untracked.txt' did not match any file(s) known to git`) — a real, reachable
// failure: the second (`phase: 'gate-fix'`) call in a real delivery crashed EXACTLY this way, live, because
// its OWN prior `phase: 'build'` message file (`.delivery-commit-msg-build.txt`, left uncommitted by
// design — see `convergeRoundTouchedFiles`'s own #3383 note) had no exclusion and leaked into `paths` as an
// untracked, never-added file. That specific leak is fixed separately (excluded at the source), but the
// underlying `git commit -- <pathspec>` limitation is general: ANY genuinely new file in a delivery's real
// diff (a new test fixture, a new module) would hit the identical crash. Staging first closes the whole
// class, not just the one leaked path.
export function commitBuildTurn(
  { lane, item, provider = CLAUDE_RESTRICTED_PROVIDER, phase = 'build' },
  {
    run: runFn = run, writeFile = writeFileSync, readFile = readFileSync,
    touchedFiles = convergeRoundTouchedFiles,
  } = {},
) {
  const paths = touchedFiles(lane, { run: runFn });
  if (!paths.length) return { committed: false, paths: [] };
  sanitizeOwnLocusMentions(lane, paths, { readFile, writeFile });
  const msgFile = `${lane}/.delivery-commit-msg-${phase}.txt`;
  // build-path-codex-isolation-locus — `WE #<item>` was hardcoded; a non-`we` implementation lane's own
  // commits should carry ITS repo's own canonical prefix (`PLATEAU #<item>`, `FUI #<item>`), matching the
  // convention `repo-profile.mjs#briefTokensForRepo`'s `ATTRIBUTION` field already establishes for fix/ci-heal.
  // `repoProfileForLanePath` returns `null` for a lane it cannot place (an unrecognized pool-dir basename, or a
  // synthetic test path) — falls back to `'WE'`, byte-identical to every existing caller/test.
  const repoTag = repoProfileForLanePath(lane)?.canonicalPrefix?.toUpperCase() ?? 'WE';
  const subject = machinePrTitle({ repo: repoTag, item, kind: phase === 'gate-fix' ? 'gate-fix' : 'build',
    card: readMainCard(item, (args) => runFn('git', args, { cwd: lane })),
    subject: `update ${paths.join(', ')}`,
  });
  const body = phase === 'gate-fix'
    ? "Commits the delivery agent's fix after a red gate resumed it for one retry (#3383/#3565) — the wrapper "
      + "makes this commit on the agent's behalf; the agent itself never runs git.\n"
    : "Commits the delivery agent's build turn (#3383/#3565) — the wrapper makes this commit on the agent's "
      + "behalf; the agent itself never runs git (see this function's own header for why that moved here).\n";
  const message = `${subject}\n\n${body}\n${coAuthorTrailerFor(provider?.name)}\n`;
  writeFile(msgFile, message);
  runFn('git', ['add', '--', ...paths], { cwd: lane });
  runFn('git', ['commit', '-F', msgFile, '--', ...paths], { cwd: lane });
  return { committed: true, paths };
}

/**
 * THE LOOP. Drives `converge-cli.mjs` `init` → repeated `step` calls, executing whatever action each call
 * prints, until the action is genuinely `land` or `escalate` — replacing the sketch's single `step` call.
 * `run` is injectable (defaults to this file's own `run`) so the whole loop is testable against a scripted
 * fake CLI without spawning real processes.
 *
 * #3848 (carried from #3801 Fork 1) — the returned verdict also carries `convergeEditedLane`: `true` when ANY
 * round across the whole loop actually committed a real edit ({@link commitConvergeRound}'s own `committed`,
 * which is `false` for a dismissed-only round or one whose only touched paths were this wrapper's `.converge-*`
 * bookkeeping), `false` when no round ever did (including a run that never reaches an `edit` action at all,
 * e.g. an `escalate` straight off `read`/`panel`). A Claude converge EDITOR is a separate spawn from the build
 * agent (this file's own header, above); this is the one fact that says whether it changed the diff the build
 * agent handed it.
 */
export function runConverge(
  { lane, item, goal },
  {
    run: runFn = run, ensureSettingsFile = ensureDeliveryHooksSettingsFile, dispatchKind = 'delivery',
    provider = CLAUDE_RESTRICTED_PROVIDER,
  } = {},
) {
  // #4356 — state/obs bookkeeping lives OUTSIDE the lane; see `convergeScratchDir`'s own docblock for why.
  // `resetConvergeScratchDir` (never plain `convergeScratchDir`) runs ONCE here, at the very top of a run, so
  // a lane slot recycled from a previous item's converge run never inherits its leftover scratch files.
  const state = `${resetConvergeScratchDir(lane)}/.converge-state.json`;
  // #3627 follow-up — raw script call, not routed through `run.mjs`: no `converge` operation is registered
  // yet. Would need one built first (see #3627 follow-up); out of scope for this hardening pass. Same for the
  // `step` call further down this loop.
  const initOut = JSON.parse(runFn('node', [
    'scripts/converge-cli.mjs', 'init', `--lane=${lane}`, `--state=${state}`, '--care=elevated',
    `--goal=${goal || `deliver item ${item} to spec`}`,
  ]));

  let step = initOut;
  const careLevel = initOut.careLevel;
  let seatedLenses = initOut.seatableLenses || initOut.lenses || [];
  let jurorsPerLens = initOut.jurorsPerLens;
  let material = '';
  let lastLensResults = [];
  // #3848 — accumulates across every round in the loop, not just the last one before land/escalate.
  let convergeEditedLane = false;

  for (let i = 0; i < CONVERGE_MAX_LOOP_STEPS; i += 1) {
    if (step.action === 'land' || step.action === 'escalate') return { ...step, convergeEditedLane };

    const obs = { round: step.round };
    if (step.action === 'read') {
      const out = runFn('bash', ['-c', step.read.command], { cwd: step.read.cwd, maxBuffer: 64 * 1024 * 1024 });
      material = out;
      obs.readResult = { material: out };
    } else if (step.action === 'panel') {
      const { lensResults } = runConvergePanel(step.panel, { lane, item, round: step.round, material, run: runFn });
      lastLensResults = lensResults;
      obs.lensResults = lensResults;
      // #2640 juror-invite-on-discovery needs a GROUNDED citation from a tool this wrapper ran — it runs no
      // grounding-method tooling of its own (see `runConvergePanel`'s docblock), so it has nothing to invite
      // on. REAL, not a stub: reporting none here is the honest answer for a driver with no such tool, exactly
      // as a human driver who ran no invite-eligible tool would report none.
      obs.invites = [];
    } else if (step.action === 'red-team') {
      obs.lensResults = lastLensResults;
      obs.redTeamResult = runConvergeRedTeam(step.redTeam, { lane, item, round: step.round, material, run: runFn });
    } else if (step.action === 'edit') {
      obs.editResult = runConvergeEdit(step.edit, { item, round: step.round, lane, run: runFn, ensureSettingsFile, dispatchKind, provider });
      // BUG-14 FIX — commit a genuinely accepted round's real edits NOW, before the `step` call below reads
      // the lane's state (`converge-cli.mjs`'s own `read` action re-reads the lane fresh each round, so a
      // later round must see THIS round's commit, not just uncommitted working-tree changes it happens to
      // still be sitting on) and before any later `openPr --sha=HEAD` could run against a stale HEAD. A
      // dismissed-only round (`advanced: false`) commits nothing — see {@link commitConvergeRound}.
      if (obs.editResult.advanced) obs.commitResult = commitConvergeRound({ lane, item, round: step.round }, { run: runFn });
      if (obs.commitResult?.committed) convergeEditedLane = true;
    } else if (step.action === 'invite') {
      obs.invite = step.invite;
      obs.inviteEcho = runConvergeInvite(step.invite, {
        lane, round: step.round, careLevel, seatedLenses, jurorsPerLens, run: runFn,
      });
    } else {
      throw new Error(`deliver-item-wrapper: converge-cli reported an action this loop does not know how to run: ${JSON.stringify(step.action)}`);
    }

    const obsPath = writeJsonFile(`${convergeScratchDir(lane)}/.converge-obs-${step.round}-${i}.json`, obs);
    // #4356 — fail CLEARLY and ATTRIBUTED, not with a raw child-process `Command failed` bubbling up from
    // `converge-cli.mjs step`'s own `mustExist` check. This is a defensive backstop, not the primary fix
    // (relocating the state file OUTSIDE the lane, above, is): even outside the lane, SOMETHING could still
    // remove this exact path (a stray `rm`, a scratch-dir recycle) between the action that just ran and this
    // call, and a bare `Command failed: node scripts/converge-cli.mjs step ...` gives an operator no way to
    // tell "the state vanished" from "the CLI itself is broken" without re-deriving it from a log timestamp.
    if (!existsSync(state)) {
      throw new Error(
        `deliver-item-wrapper: converge state file vanished for item #${item} after round ${step.round} `
        + `action '${step.action}' (before the next step call) — expected it at ${state}. This should not `
        + 'happen now that converge bookkeeping lives outside the lane\'s own working tree (#4356); treat as '
        + 'a bug in whatever removed it, not a normal converge outcome.',
      );
    }
    const stepOut = JSON.parse(runFn('node', ['scripts/converge-cli.mjs', 'step', `--state=${state}`, `--obs=${obsPath}`]));
    if (Array.isArray(stepOut.lenses)) seatedLenses = stepOut.lenses;
    if (Number.isFinite(stepOut.jurorsPerLens)) jurorsPerLens = stepOut.jurorsPerLens;
    step = stepOut;
  }
  throw new Error(
    `deliver-item-wrapper: the converge loop for item #${item} exceeded ${CONVERGE_MAX_LOOP_STEPS} steps `
    + 'without a land/escalate verdict — converge-core\'s own round cap should have terminated it long before '
    + 'this; treat as a bug in this loop (or in converge-core), not as a legitimately long real run.',
  );
}

// ================================================================================================
// 5. Escalation mapping — REAL rubric, REAL glue (was: real imports over a SKETCH two-input stand-in). Wires in
//    the FULL `scoreEscalation` (`we:scripts/lib/review-escalation.mjs`) — diff stats and dismissed-finding
//    count included, not just path-shape — via `producerReviewLabel`, the SAME mapping
//    `we:scripts/pr-land.mjs`'s own producer-time label derivation uses, so this wrapper's park decision agrees
//    with the label a normal `open-pr --mode=label-on-green` PR would have been scored with at open.
// ================================================================================================

/** Real, cheap diff stats for `scoreEscalation`'s `changedFiles`/`diffLines` inputs — the SAME shape
 *  `git diff --numstat` produces, read directly off the lane clone (mirrors `converge-cli.mjs`'s own
 *  `laneChangedFiles`, read above while verifying `runConverge`'s `read` action). `run` is injectable so this
 *  is testable without a real git checkout. Fails soft to an empty/zero reading — a wrapper-side git failure
 *  here must not crash the whole delivery; it just means `scoreEscalation` sees no size/blast-radius signal,
 *  which is the safe direction for a signal that only ever ADDS review capacity, never blocks (#3320). */
export function computeLaneDiffStats(lanePath, { run: runFn = run, baseRef = 'origin/main' } = {}) {
  try {
    const mergeBase = runFn('git', ['-C', lanePath, 'merge-base', 'HEAD', baseRef]).trim();
    const numstat = runFn('git', ['-C', lanePath, 'diff', '--numstat', mergeBase]);
    const changedFiles = [];
    let diffLines = 0;
    for (const line of numstat.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [add, del, ...pathParts] = trimmed.split('\t');
      const path = pathParts.join('\t');
      if (path) changedFiles.push(path);
      const a = Number(add);
      const d = Number(del);
      if (Number.isFinite(a)) diffLines += a;
      if (Number.isFinite(d)) diffLines += d;
    }
    return { changedFiles, diffLines };
  } catch {
    return { changedFiles: [], diffLines: 0 };
  }
}

/**
 * REAL. `touchesStatute` stays as a cheap, explicit up-front check — it is a DIFFERENT rubric surface from
 * `scoreEscalation`'s own statute/leash signal (`isPolicyCorePath`, from `gate-config.mjs`, is not one of
 * `scoreEscalation`'s own terms), so it is kept alongside the full rubric rather than folded into or replaced
 * by it. `report.outcome === 'needs-human-judgment'` and `convergeVerdict.verdict === 'escalate'` are likewise
 * kept as their own forcing reasons: they are signals `scoreEscalation` has no way to know about (the agent's
 * own self-reported call, and converge's own independent-panel verdict), not duplicates of anything it scores.
 * On top of all three, the FULL rubric now runs for real: diff stats read off the lane
 * ({@link computeLaneDiffStats}) plus the round's dismissed-finding count feed `scoreEscalation`, and
 * `producerReviewLabel` — the same function `pr-land.mjs` itself uses — turns its verdict into a label.
 *
 * #3850 Fork 2 (RATIFIED, (a); we:backlog/3850-…md) — ONE MORE forcing reason, checked last (after every
 * existing park reason, so a statute/human-judgment/escalate/score park is unchanged): a `full` route whose
 * ACTUAL executed vendor is not Claude may not land on `label-on-green` alone, whatever its escalation score
 * — "the PR of a `full` route opens parked `review:pending`… whatever its escalation score" (the card's own
 * ratified text). `executedVendor` is read from the REAL provider that just spawned (`deliverItem`'s own
 * `provider.vendor` — see `CLAUDE_RESTRICTED_PROVIDER`/`CODEX_PROVIDER`'s own comments), never from `routed`
 * (the criteria's recommendation): a `deliveryAgent:` marker that forces Codex despite a Claude-routed
 * criteria pick still spawns `provider.vendor === 'codex'` here, so it is still bound. Defaults to `'claude'`
 * so every existing caller (every test that does not pass it) is byte-identical — this is additive-only.
 */
export function decideParkMode({ report, convergeVerdict, filesTouched, lanePath, crossRepo = false, executedVendor = 'claude' }, { run: runFn = run } = {}) {
  const touchesStatute = (filesTouched || []).some((f) => isStatutePath(f) || isPolicyCorePath(f));
  if (touchesStatute) return { mode: 'park', label: 'review:human', reason: 'statute/policy-core path touched' };
  if (report.outcome === 'needs-human-judgment') return { mode: 'park', label: 'review:human', reason: report.reason };
  if (convergeVerdict.verdict === 'escalate') return { mode: 'park', label: 'review:human', reason: convergeVerdict.reason };

  const dismissedFindings = Array.isArray(convergeVerdict.dismissed) ? convergeVerdict.dismissed.length : 0;
  const diffStats = lanePath ? computeLaneDiffStats(lanePath, { run: runFn }) : { changedFiles: filesTouched || [], diffLines: 0 };
  const score = scoreEscalation({
    changedFiles: diffStats.changedFiles, diffLines: diffStats.diffLines, dismissedFindings, crossRepo,
  });
  const scoreLabel = producerReviewLabel(score);
  if (scoreLabel) {
    return { mode: 'park', label: scoreLabel, reason: `scoreEscalation: ${score.reasons.join('; ') || 'escalated'}`, score };
  }
  if (executedVendor !== 'claude') {
    return {
      mode: 'park',
      label: 'review:pending',
      reason: `#3850 Fork 2 — executed vendor is \`${executedVendor}\`, not Claude (a delegated run); a full `
        + 'route\'s PR may not land on label-on-green alone until an independent review accepts it',
      score,
    };
  }
  return { mode: 'label-on-green', label: 'ready-to-merge', reason: null, score };
}

// ================================================================================================
// 6/7. PR + learnings — REAL CLI surfaces, lifted verbatim from the live brief's own step 8/9.
// ================================================================================================

/**
 * REAL (was PLACEHOLDER) — `openPr`'s `--bodyFile` names `${lane}/.pr-body.md`, and this is the writer that
 * actually puts a real body there before `openPr` reads it. `open-pr.mjs#planOpen` REFUSES a create with no
 * body (`prCreateBodyGuard`, "the drain gate rejects a bodyless PR at land"), so the ENOENT this file's own
 * honesty label warned about was never merely cosmetic — the very next real run would have thrown here.
 *
 * MINIMAL, ON PURPOSE. `we:scripts/pr-land.mjs#composePrBody` is the FULLER body composer (it also embeds a
 * lane manifest and the #2844 author-actor stamp), but it is scoped to `pr-land.mjs`'s own CLI invocation —
 * it reads `process.argv`/`currentActorId()` at module load, so importing it here would run a second,
 * unrelated CLI's flag parsing as a side effect of this file's own import. `pr-land.mjs` (which `open-pr`
 * shells) applies its OWN author stamp to whatever body it is handed, so this generator does not need to
 * duplicate that half — only the human-readable content pr-land does not invent on its own.
 *
 * The one-line summary is pulled from the delivery agent's own report (`report.reason` — the only prose field
 * {@link DELIVERY_REPORT_VERSION}'s schema carries; optional on a `done` outcome, so a report that supplied
 * none falls back to a generic, still-accurate line rather than an empty body section).
 */
export function buildPrBody({ item, report, delegation = null }) {
  const summary = (report && typeof report.reason === 'string' && report.reason.trim())
    || `Delivers item #${item} per its backlog spec.`;
  const filesLine = (report && Array.isArray(report.filesTouched) && report.filesTouched.length)
    ? `\n\nFiles touched:\n${report.filesTouched.map((f) => `- ${f}`).join('\n')}`
    : '';
  // #3903 main adaptation — see {@link delegationForBuild}. `buildDelegationMarker` returns '' for an invalid
  // triple, so a malformed delegation adds nothing rather than a partial attribution.
  const marker = delegation ? buildDelegationMarker(delegation) : '';
  return `## #${item}\n\n${summary}${filesLine}\n\n---\nDelivered by the #3627 minimal delivery-agent pipeline `
    + '(the mechanical wrapper drove review/gate/PR — the agent only built and reported).\n'
    + (marker ? `${marker}\n` : '');
}

/**
 * #3903 MAIN ADAPTATION (not on the prototype) — THE TRIAL EVIDENCE HOOK. On main a delegated PR is recorded as a
 * session-delegation trial (#3690, evidence rows #3949) only when its body carries the `delegation` marker
 * (`we:scripts/lib/delegation-marker.mjs`); `review-set-label.mjs` reads it at review accept. A hand-delegated
 * PR gets it from `pr-land --delegation=`. A mechanical build opens its PR through `run.mjs open-pr` with a
 * body THIS wrapper writes, so the wrapper stamps it — from the provider that ACTUALLY ran the build turn, never
 * a prediction. A Claude build names no delegation (`null`): it is not delegated work.
 *
 * `taskType` is the delegation vocabulary (`DELEGATION_TASK_TYPES`), derived from the item's declared scope by
 * the SAME `taskTypeFor` the router uses: an all-docs scope is `doc-fix`; any other build is `other`, because a
 * build has no narrower delegation task type (`bugfix`/`conflict-resolution`/`self-fix` are repair kinds).
 *
 * @param {{vendor?: string}} provider - the delivery-agent provider that ran the build turn.
 * @param {string} scope - `launch.scope`, the comma-joined declared scope.
 * @returns {{provider: string, model: string, taskType: string}|null}
 */
export function delegationForBuild(provider, scope) {
  const vendor = String(provider?.vendor ?? 'claude');
  if (vendor === 'claude') return null;
  const model = provider?.model ?? (vendor === 'codex' ? CODEX_DELIVERY_MODEL : '');
  const scopePaths = String(scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const derived = taskTypeFor({ kind: 'build', scopePaths });
  const taskType = DELEGATION_TASK_TYPES.includes(derived?.taskType) ? derived.taskType : 'other';
  return { provider: vendor, model, taskType };
}

/** REAL — writes {@link buildPrBody}'s content to the exact path `openPr`'s `--bodyFile` reads, so the file
 *  genuinely exists (with real content) by the time `openPr` runs. `writeFile` is injectable for tests. */
export function writePrBody({ item, lane, report, delegation = null }, { writeFile = writeFileSync } = {}) {
  const bodyFile = `${lane}/.pr-body.md`;
  writeFile(bodyFile, buildPrBody({ item, report, delegation }));
  return bodyFile;
}

/** Format the classifier's refusal without inventing a PR when no PR exists. */
export function describeOpenPrRefusal({ reason, detail, pr }) {
  return `${pr == null ? '' : `PR #${pr} `}open-refused (${reason})${detail ? `: ${detail}` : ''}`;
}

/** REAL (was PLACEHOLDER — `<slug>` was dead, never-substituted text that would have produced an invalid ref
 *  like `lane/3371-<slug>`). PURE function of its params — deliberately does NOT call `findItem` or import the
 *  backlog loader itself; the caller (`deliverItem`) resolves the item's REAL slug ONCE, the SAME way
 *  `resolveItemSpecPathBasename` resolves it for the brief, and passes it straight through as `slug` (already
 *  the canonical `<num>-<slug>.md` basename's slug half — never re-derived from the title via
 *  `scaffold.mjs#slugFor`). `run` is injectable (mirrors `computeLaneDiffStats`/`decideParkMode`'s own
 *  pattern), so this is testable with no hidden dependency and no real `open-pr` process. Flags otherwise
 *  lifted verbatim from the live brief's step 8, both branches. */
export function openPr({ item, attemptTag, lane, park, report, slug, delegation = null, runId, effectKey }, { run: runFn = run } = {}) {
  if (!slug) {
    throw new Error(`deliver-item-wrapper: openPr needs the item's real slug for #${item} — never substitutes a literal placeholder`);
  }
  const ref = `lane/${item}${attemptTag ?? ''}-${slug}`;
  const bodyFile = writePrBody({ item, lane, report, delegation }); // REAL — was a PLACEHOLDER path nothing wrote.
  const args = [
    // build-path-codex-isolation-locus — ABSOLUTE, never the bare relative `scripts/operations/run.mjs`. This
    // call sets `cwd: lane` below so `run.mjs`'s OWN `process.cwd()` (which `pr-land.mjs`'s `REPO =
    // flags.repo || process.cwd()` reads) names the repo the PR is actually FOR — correct already for a WE
    // lane, because a WE lane clone happens to ALSO carry a copy of `scripts/operations/run.mjs` at that
    // relative path. It is NOT correct for a non-`we` implementation lane (`frontierui`/`plateau-app` — a
    // completely different application, confirmed by listing a real lane of each: neither carries a
    // `scripts/operations/` directory at all), where the relative path resolves to nothing and this call would
    // throw `MODULE_NOT_FOUND` before ever reaching `gh pr create`. An absolute path resolves this script's
    // own real location (WE's checkout) regardless of `cwd`, while `cwd: lane` still makes `pr-land.mjs`
    // itself operate against whichever repo `lane` is a clone of — the same "script always runs from WE,
    // target is an argument/cwd, never the calling process's own location" shape `runConverge`/
    // `runVerifyOperation` already use for the identical reason.
    `${REPO_ROOT}scripts/operations/run.mjs`, 'open-pr', `--ref=${ref}`, '--sha=HEAD', '--base=main',
    `--bodyFile=${bodyFile}`, '--requireVerified=true', '--json',
  ];
  args.push(park.mode === 'park' ? `--mode=park` : '--mode=label-on-green');
  if (park.mode === 'park') args.push(`--parkLabel=${park.label}`);
  const out = runFn('node', args, { cwd: lane, ...(runId && effectKey ? { env: { ...process.env,
    WE_BUILD_PR_CONTEXT: JSON.stringify({ runId, key: effectKey, dir: resolveRunsDir() }),
  } } : {}) });
  // #3627 bug 13 (real fix) — `run.mjs open-pr --json` prints the FULL run-outcome envelope, never a flat
  // `{pr, url}` object; the actual submit result (the only place `.pr`/`.url` live) is buried at
  // `findings.submit.effects[0].result`. See `extractSubmitResult`'s own docblock for the full story.
  return extractSubmitResult(JSON.parse(out));
}

/**
 * #4348-open-pr-retry — classify a caught `openPr()` failure: is it the ONE retryable class (#2659's
 * `blocked-on-infra`), or a genuine refusal/bug `deliverItem`'s generic `wrapper-threw` catch still owns?
 * Returns `{ reason: 'blocked-on-infra', detail }` or `null`.
 *
 * PURE over the error `execFileSync` throws. `run.mjs open-pr --json`'s `effect-halted` stop
 * (`cli-adapter.mjs#renderOutcome`) still prints the outcome envelope to stdout before exiting 1, so
 * `e.stdout` carries it — but the halted effect's own `result` is `null`
 * (`effect-executor.mjs#applyPendingEffects`'s catch branch sets only `error`, never `result`, on a throw), so
 * `extractSubmitResult` — built for the SUCCESS shape at `findings.submit.effects[0].result` — cannot read the
 * reason here. Confirmed against a REAL captured run record from the live #4348 incident, whose effect carries
 * `result: null` and the reason folded into a longer sentence at `.error`
 * (`"open-pr: pr-land did not report a result — blocked-on-infra. …"`, `open-pr-io.mjs`'s own sink text). This
 * reads that per-effect `.error` (falling back to the envelope's top-level `error`,
 * `cli-adapter.mjs#outcomePayload`'s field for the same stop) and matches pr-land's own bare reason token
 * inside it, rather than an exact-string compare against a sentence this file does not own the wording of.
 * Unparseable/absent `.stdout` (a spawn that never even started) classifies as not-retryable — it never guesses
 * an infra hiccup it has no evidence of.
 */
export function classifyOpenPrFailure(e) {
  let payload;
  try { payload = JSON.parse(String(e?.stdout ?? '')); } catch { return null; }
  const detail = String(payload?.findings?.submit?.effects?.[0]?.error ?? payload?.error ?? '');
  return /\bblocked-on-infra\b/.test(detail) ? { reason: 'blocked-on-infra', detail } : null;
}

// #3627 follow-up — raw script call, not routed through `run.mjs`: no `learnings-drop` operation is
// registered yet. Would need one built first (see #3627 follow-up); out of scope for this hardening pass.
/** REAL (flags lifted verbatim from the live brief's step 9).
 *
 *  EXPORTED by #3644, not rewritten: the prepare-decision wrapper
 *  (`we:scripts/operations/prepare-decision-wrapper.mjs`) forwards its agent's optional `learning` through the
 *  identical drop-box call with the identical four flags, and the function is already kind-independent —
 *  `sessionSlug` plus the report's own `learning` sub-object, nothing build-shaped. A second copy in that file
 *  would be literal duplication of a six-line shell-out whose flags are the contract. */
export function dropLearning({ sessionSlug, learning }) {
  run('node', [
    'scripts/conveyor/learnings-drop.mjs', `--kind=${learning.kind}`, `--summary=${learning.summary}`,
    `--area=${learning.area}`, `--suggestion=${learning.suggestion}`, `--session=${sessionSlug}`,
  ]);
}
