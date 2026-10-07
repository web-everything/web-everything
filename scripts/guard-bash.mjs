#!/usr/bin/env node
/**
 * PreToolUse(Bash) guard — project banned-command table (webeverything; AI-optimisation program).
 *
 * Moves mechanical footguns that previously relied on the model remembering a MEMORY.md line into
 * deterministic write-time enforcement. Denials (each a recurring real incident):
 *   • heavy-enforce — every direct vitest/test or check-standards execution must use host-wide heavy admission.
 *   • `build:plugs` / `tsc -p tsconfig.plugs.json` (no --noEmit) — emits shadow .js/.d.ts, breaks
 *     vitest, fakes a red gate. Typecheck plugs with `tsc --noEmit`.
 *   • `pkill`/`killall` of vite|node — never tear down the user's running dev server.
 *   • `rm`/`git rm` of a backlog/*.md — done items resolve (status:resolved); the file stays.
 *   • `mv`/`git mv` of a backlog/*.md that CHANGES its NNN prefix — NNN is immutable.
 *   • `>>` / `tee -a` / `sed -i` / `perl -*pi` into backlog|reports/*.md — bypasses the Edit/Write
 *     locus-prefix hook; use the Edit/Write tools so the check fires.
 *   • #4070 — the TRUNCATING half of the same rule: a `>`/heredoc redirect, `cp`/`install`, or a `mv` from
 *     outside the corpus onto a backlog|reports/*.md (`corpusOverwriteTargets`).
 *   • `git push` to a constellation `main` branch — strict lane-only enforcement (#2203): every change
 *     reaches main through a `lane/*` ref → PR → CI, so a DIRECT push bypasses the gate (observed
 *     2026-07-03: an ungated direct push landed a check:standards error on main). Escape: `MAIN_PUSH_OK=1`.
 *   • a BACKGROUNDED verification-set run (`verify-lane` / `check:standards` / `test:unit`) — via the Bash
 *     `run_in_background` param OR a shell `&`/nohup. Backgrounding the suite run then yielding is the exact
 *     #2833 subagent stall (the lane sits mid-flight, produces nothing, never errors). Run it synchronously in
 *     the foreground; no override.
 *   • #x36vidg — in an AGENT session only (subagent `agent_id` on the payload, or `WE_DISPATCH_KIND`), a
 *     WAIT-POLL: a sleep loop over PR merge/label or CI-check state (or a blocking `gh pr checks --watch` /
 *     `gh run watch`) — the drain/pr-watch own merge+CI, report and exit — or a sleep loop over a background
 *     task's `tasks/<id>.output` / a `subagents/*.jsonl` transcript — re-run the gate in the foreground with an
 *     explicit timeout instead. The interactive main session gets a WARN (`systemMessage`), never a deny.
 *   • NO-POLLING — a shell loop (`for|while|until`) whose body sleeps/waits (`sleep`, `perl -e 'sleep'|select(undef…)`,
 *     `node -e` setTimeout, `python -c time.sleep`, `read -t`), or ANY single wait longer than `maxSleepSeconds`
 *     (scripts/guard-bash-polling.json, default 30), in EVERY session kind. A session stuck in a wait cannot be
 *     messaged (incident: a build agent sat ~20 min in such a loop). Allowlist: a bare background `sleep N<=120`
 *     heartbeat only. Alternatives: end the turn (#5137 await-verify), one `verify-lane check --wait=`, report pending. No override.
 *   • a BACKGROUNDED codex-direct-task.mjs / gemini-direct-task.mjs invocation — both scripts are
 *     synchronous by contract (see their FOREGROUND ONLY banners). No override (#3383).
 *   • a backlog item-mutation (claim/scaffold/…) run in a lane clone whose HEAD is BEHIND origin/main —
 *     a stale checkout runs stale `scripts/` against a stale backlog view (observed 2026-07-07: a lane
 *     19 commits behind ran the pre-#2288 "next free NNN" allocator and minted a colliding/low-gap
 *     number, #2323). Refuse and tell the caller to refresh (`git fetch && git reset --hard origin/main
 *     && git clean -fd`) rather than silently proceeding. Escape: `STALE_LANE_OK=1`.
 *   • a destructive git op (`reset --hard`, `clean -f[d]`, `checkout/restore/switch` that discards the tree,
 *     a force-push — normalized past wrapper/path/global-flag disguises by `canonicalGitOp`) run with cwd
 *     inside a `.lanes/<repo>/lane-N/` clone whose LIVE lease (`scripts/lib/lane-lease.mjs`) is held by
 *     ANOTHER session — the hole behind a 2026-07-09 incident: a `/slice` ran `git reset --hard` in a lane a
 *     concurrent session had just leased; the acquire correctly refused, but the `;`-chained reset ran
 *     regardless and clobbered the peer's clone. Ownership is decided by `isForeignLease` from the DURABLE
 *     session id ALONE (`CLAUDE_CODE_SESSION_ID`, stamped as `ownerSession` at `acquire`, read here from the
 *     same env first): a live lease whose `ownerSession` differs from mine ⇒ FOREIGN ⇒ deny; equal ⇒ my lane ⇒
 *     allow. Stale/absent lease, a lease with no `ownerSession`, or no session id here ⇒ allow (the documented
 *     fail-open degraded mode — r2 removed the earlier pid-ancestry fallback, which over-matched two independent
 *     sessions sharing an upper process ancestor and so failed open while looking protective). Escape:
 *     `LANE_CLOBBER_OK=1`.
 *   • the SAME destructive git op in a lane holding a LIVE MARKED (`workflowLane`) lease (#2413) — the
 *     parallel-/workflow case where every sibling lane shares `ownerSession`, so the compare above fails OPEN
 *     exactly where it matters. Fail-CLOSED instead: the op must ASSERT the lease's own minted slug inline
 *     (`LANE_SESSION=<slug>`, stamped by the acquiring orchestrator); absence OR mismatch ⇒ deny. This
 *     supersedes the `ownerSession` compare for marked lanes only; unmarked leases keep the fail-open behavior
 *     above. The owning lane re-asserts the slug it acquired under and passes; a sibling never holds it and is
 *     denied. Same escape: `LANE_CLOBBER_OK=1`.
 *   • the SAME destructive git op in a lane whose LIVE UNMARKED lease is CONTESTED (#2997) — another live lease
 *     in the same pool carries the SAME `ownerSession`, i.e. a SIBLING AGENT of the caller's own session is
 *     holding a lane right now. #2413's fail-closed regime was gated on the `workflowLane` marker, which only
 *     `--purpose=workflow-lane` sets, so every other concurrent topology (ad-hoc subagents, the conveyor's
 *     `conveyor-*` dispatch) fell back to the `ownerSession` compare — which answers "mine" for every sibling.
 *     Same remedy as #2413 and the same minted-slug channel: assert the lease's own `holder` slug inline
 *     (`LANE_SESSION=<slug>`, printed by `lane-pool.mjs acquire`); absence OR mismatch ⇒ deny. Scoped to the
 *     CONTESTED case ONLY, so the ordinary solo topology (one session, one lane) is completely unaffected — a
 *     lease nobody else's live lease shares an `ownerSession` with keeps the plain #2367 compare. Escape:
 *     `LANE_CLOBBER_OK=1`.
 *   • a build that WRITES the shared PRIMARY tree, run at primary cwd (#2749/#2788 — the 4th arm under
 *     `#primary-read-only-lanes-only`) — an `npm run build`/`build:docs`/`build:demo` (or the `pnpm`/`yarn`/
 *     `run-s`/`run-p`/`npm-run-all` equivalent; `build:check` and `build:plugs` are excluded — the former
 *     writes only `/tmp`, the latter is already its own arm above), an fs-writing `node <generate*|scaffold*>`
 *     script, or a `sed -i`/`perl -pi`/`tee`/shell-redirect writing a file other than a `/tmp`|`/dev` scratch
 *     path. Keys on the TREE-WRITE and the cwd the write LANDS IN, never on who is asking — no session/agent
 *     identity is consulted, so it is the same rule for the main session and a delegated subagent. The
 *     reported cwd resets to primary between calls (#2335), so a lane-scoped build must make its lane cwd
 *     explicit (`cd <lane> && …`, which `resolveEffectiveCwd` honours) — without that the build really does
 *     run in the primary, which is exactly what this denies, and the deny message says so. Escape:
 *     `MAIN_SESSION_BUILD_OK=1` (mirrors `MAIN_PUSH_OK`/`LANE_GUARD_OFF`).
 *   • (WARN, never deny) a verification-set command (`test:unit`/`check:standards`/`verify-lane`) run at
 *     primary cwd — the un-script-decidable residual half of #2749 ("this session should have delegated
 *     mechanical work to a lane", #2677). Doesn't write the tree, so the hard arm above doesn't catch it, and
 *     there is no reliable way to tell a delegated subagent's own primary-reporting verify apart from the main
 *     session's own laziness (#2335) — so this is a stderr nudge only, never a deny.
 *
 *   • a raw `gh pr create` — omits the author stamp and silently voids mandatory referral rulings
 *     (plateau-app #204). Use the cross-repo `open-pr` operation. Escape: `RAW_PR_CREATE_OK=1`.
 *   • a raw `gh pr merge <n>` or its REST equivalent `gh api repos/<owner>/<repo>/pulls/<n>/merge -X PUT` —
 *     found this session (2026-08-31): `scripts/lib/pr-merge-gate.mjs`'s `assertMayMerge` is the documented
 *     ONE place a PR may merge to `main` (#2290's sole-writer invariant), and it sits upstream of the
 *     review-escalation check (`review:pending`/`review:human`) that only runs inside the drain's own
 *     `classifyPr` call path (merge-ai-prs.mjs). But `assertMayMerge` is a plain JS function — nothing stops
 *     an agent's Bash tool from shelling the merge directly, which skips BOTH the sole-writer invariant and
 *     the review gate behind it, with no malice required (a carelessly-run command, or an ambiguous
 *     mandate). Every PR this repo opens targets `main` (`pr-land.mjs` defaults `--base` to `main`;
 *     `lane-stack.mjs`'s stacking rebases a lane's LOCAL git history onto a parent lane's tip — it never
 *     changes a PR's GitHub base ref), so this is a blanket deny, not one gated on reading the PR's actual
 *     base. Sanctioned path: label `ready-to-merge` and let the drain land it (`pr-land.mjs` / `/drain`) —
 *     those call `assertMayMerge` internally and are untouched. Escape: `WE_MERGE_BREAK_GLASS=1` — reused
 *     verbatim from `pr-merge-gate.mjs`'s own break-glass rather than inventing a second one; the CLI section
 *     below writes a LOUD stderr audit line whenever it actually disarms this deny, mirroring
 *     `assertMayMerge`'s own loud line.
 *
 *   • a command the PARSER CANNOT REPRESENT — today that is exactly one state: an unterminated quoted run
 *     (#2994 review r3). Every loosening found across three rounds of that review reduced to ONE mechanism:
 *     the scanner hit a state it had no representation for, silently degraded to "consume to end of
 *     string", and handed every arm above a single opaque blob in which nothing sits at command position —
 *     so the tree-write arm, the push arm, the rm-backlog arm and (through `hasDestructiveLaneOp`) the whole
 *     lane-clobber lease check all missed at once, and another session's uncommitted work could be wiped.
 *     The parser now FAILS CLOSED instead. This denies nothing real: bash rejects the identical input
 *     (`unexpected EOF while looking for matching quote`), verified against `bash -c`. No override.
 *
 *   • a WRAPPER-OWNED AGENT (#3627 `delivery`, #3640 `repair`) — `WRAPPER_OWNED_AGENT_KINDS.has(dispatchKind)`
 *     (`WE_DISPATCH_KIND=delivery` stamped by `deliver-item-wrapper.mjs`'s `CLAUDE_RESTRICTED_PROVIDER.spawn`,
 *     `WE_DISPATCH_KIND=repair` stamped by `fix-dispatch-wrapper.mjs`'s `buildFixAgentEnv`, onto the agent's
 *     own process env; the SAME channel #3105's dispatched-verification arm above already reads) may never
 *     run, ITSELF, any of the mechanical lifecycle commands its own wrapper drives end to end: `lane-pool.mjs`,
 *     `backlog.mjs claim`/`release`, `gh pr`, `run.mjs open-pr`/`open-pr.mjs`, `pr-land.mjs`,
 *     `learnings-drop.mjs`, `converge-cli.mjs`, `verify-lane.mjs` (in any mode, including `request`/`check`),
 *     and `review-core-cli.mjs`. The briefs (`we:skills-src/conveyor/delivery-agent-brief-v2.md`,
 *     `we:skills-src/conveyor/fix-agent-brief-v2.md`) already told the agent this in prose; nothing enforced
 *     it. Every other session (interactive, or any LAUNCH-kind `WE_DISPATCH_KIND` — `build`, `fix`, `ci-heal`,
 *     …, which name an agent running its OWN lifecycle from a full brief) is unaffected. No override.
 *
 *   • the DECISION-AUTHORING AGENT (#3644) — `dispatchKind === 'decision-authoring'`
 *     (`WE_DISPATCH_KIND=decision-authoring`, stamped by `prepare-decision-wrapper.mjs`'s
 *     `CLAUDE_RESTRICTED_PREPARE_PROVIDER.spawn`) — the SAME table for the SAME reason, plus this kind's own
 *     three verbs (`backlog.mjs prepare-hold`/`prepare-stamp`/`prepare-release`) and `backlog.mjs resolve`.
 *     Note the KIND VALUE: it is NOT the launch kind `prepare-decision`, deliberately — see that block's own
 *     comment at the table below for why the distinction is what makes this arm writable at all.
 *
 *   • epic #3383 — a DISPATCHED agent (any `WE_DISPATCH_KIND`, every wrapper-owned and launch kind alike)
 *     referencing the usage-report tool's external admin-key location — the directory
 *     `~/.we-usage-report/` (`we:scripts/lib/usage-report-secret-paths.mjs`) or its macOS Keychain service
 *     name (`we-usage-report`) — in a Bash segment. `--restricted` already confines the FILE tools
 *     (Read/Edit/Write/Glob/Grep) to the lane cwd, a directory this external path is never under, but it
 *     explicitly RE-ENABLES Bash (`RESTRICTED_PROVIDER_TOOLS`), and a raw shell command is not confined by
 *     that same cwd rule — this arm closes that one gap. Scoped to a dispatched agent only (`dispatchKind`
 *     truthy); the operator's own interactive session is the sanctioned caller of that tool and is
 *     unaffected, same scoping `dispatchedAgentVerificationReason` (#3105) already uses. HONEST LIMIT: a
 *     text-pattern match over the command string, same class as this file's other content checks — real,
 *     additional enforcement layered on top of `--restricted`'s own cwd confinement and Codex's OS-enforced
 *     native `filesystem` deny (`we:scripts/lib/isolation-provider.mjs`), never the only thing standing in
 *     the way. See `we:scripts/usage-report/README.md` for the full threat-model writeup.
 *
 *   • the SCOPE-AUTHORING AGENT (#3642) — `dispatchKind === 'scope-authoring'`
 *     (`WE_DISPATCH_KIND=scope-authoring`, stamped by `prepare-scope-wrapper.mjs`'s
 *     `CLAUDE_RESTRICTED_PREPARE_PROVIDER.spawn`) — same shape again, with this kind's own two differences:
 *     it is denied `git commit` (uniquely among the four — its wrapper commits the one backlog file itself,
 *     and only after reading `git status --porcelain`, which an agent that committed first would leave
 *     empty), and its `converge-cli`/`review-core-cli` denies say there is NO converge loop on this arc
 *     rather than "the wrapper drives it". Same kind-value rule as the two above: NOT the launch kind
 *     `prepare`, which `dispatch-lane-io.mjs#defaultClaudeProvider` stamps on the fallback agent that runs
 *     `lane-pool acquire`/`verify-lane`/`open-pr` ITSELF. That collision is why this arm did not exist before
 *     #3642 and why the wrapper's stamp had to move first.
 *
 * Every deny above is ALL-OR-NOTHING — PreToolUse refuses the tool CALL, so a refusal aimed at one segment of
 * a chain discards every other segment with it. #3311 makes that visible rather than changing it: the CLI
 * appends a COLLATERAL notice naming the state-producing steps (heredocs, file writes, git mutations) that
 * did not run either. Strictly additive to the MESSAGE — `decide` is untouched, so no allow/deny moves. See
 * `collateralStepsNotice` for why "gate at the offending step and run the rest" was rejected.
 *
 * Input: PreToolUse JSON on stdin. Output: a deny decision (JSON) when blocked; nothing otherwise.
 * Fails open on unparseable INPUT ENVELOPE (bad JSON on stdin — a guard bug must never wedge the agent);
 * fails CLOSED on an unparseable COMMAND (see above). The pure `reason`/`decide` are unit-tested
 * (guard-bash.test.mjs), and the whole table is differentially fuzzed against `origin/main` across the
 * three cwd/lease contexts.
 */
import { readFileSync, realpathSync, appendFileSync, mkdirSync } from 'node:fs';
import { DECLARED_HOMES } from './operations/declared-homes.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { LEASE_FILENAME, isLeaseStale, isForeignLease, laneMarkedSlug, assertedLaneSlug, requiredAssertionSlug } from './lib/lane-lease.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
import { usageReportSecretDir, USAGE_REPORT_KEYCHAIN_SERVICE } from './lib/usage-report-secret-paths.mjs';
import { classifySession } from './operations/session-role.mjs';
// #xpt9fvd — the shared daemon-clone registry `guard-lane.mjs`'s Edit/Write arm also reads, so the two guards
// can never disagree about which paths are a resident daemon's OWN clone.
import { daemonCloneRoots, isDaemonCloneRealpath } from './lib/daemon-clone-registry.mjs';

const BACKLOG_MD = /(?:^|[\s'"=(])(?:\.\/)?backlog\/(\d+)-[^\s'")]*\.md/;
const CORPUS_MD = /(?:^|[\s'"=(])(?:\.\/)?(?:backlog|reports)\/[^\s'")]*\.md/;
// #2302 — a `node …/backlog.mjs <sub>` invocation that MUTATES an item's file/frontmatter (as opposed to the
// session/label-state verbs reserve/unreserve/queue/unqueue/calibrate AND the local prepare-hold/prepare-release
// tokens, which don't touch an item's .md). Run from the PRIMARY checkout it slips past guard-lane (a Bash call,
// not an Edit/Write) and stamps the item on primary — the exact hole guard-lane closes for the file tools.
// Blocked only when cwd is a primary (see isPrimaryCwd). The verb set is EVERY subcommand that reaches
// writeBacklogMd: claim/resolve/RELEASE (all three via transition), retype, yield, scaffold, settle, COST
// (accrual write), and PREPARE-STAMP (#2264 — the (b)-flow status:open+preparedDate splice, authored in a lane
// and landed via the one PR, never a primary splice). prepare-hold/prepare-release write only the local token.
const BACKLOG_MUTATION = /\bnode\s+\S*backlog\.mjs\s+(?:claim|resolve|release|scaffold|settle|retype|yield|cost|prepare-stamp)\b/;

/** Does this segment INVOKE a backlog item-mutation subcommand? Pure (unit-tested). */
export function isBacklogMutation(segment) { return BACKLOG_MUTATION.test(String(segment || '')); }

// An IDENTITY OVERRIDE on a commit: `git -c user.email=… commit`, `git commit --author=…`, or the env pair
// `GIT_AUTHOR_EMAIL=`/`GIT_COMMITTER_EMAIL=`. `-c` may appear before the subcommand (git's own placement) and
// the value may be quoted, so this matches the FLAG rather than a position. The `--author` form is included
// because it forges the same field by a different door.
//
// WHY DENY RATHER THAN CORRECT. The container already ships the right identity — `noreply@anthropic.com` at
// `--global`. Nothing here is misconfigured, so no bootstrap step and no `git config` write can help: the only
// way to get the wrong author is for the session to OVERRIDE a correct default, which is precisely what
// happened on 2026-08-24 (four commits landed on `main` attributed to the operator, for work the operator did
// not write). That is a rule, not machine state, and #51's hookable-vs-judgment statute puts a
// script-decidable rule in a deterministic hook.
//
// NOT REPLACEABLE BY AN OPERATION. There is no `commit` operation today, and one would not close this: an
// operation offers a correct path, it cannot stop a raw `git commit` beside it. The repo already runs both
// patterns together — `open-pr` exists AND this file still denies direct pushes.
/**
 * Does this segment commit under a HAND-SET identity? Pure (unit-tested).
 *
 * TOKEN-POSITIONAL, NOT A REGEX OVER THE RAW TEXT — the same lesson the `pkill` arm above already paid for.
 * A regex reading the whole segment denies `git commit -m "docs: never pass -c user.email=foo"`, i.e. the
 * commit that DOCUMENTS this rule (caught by probe while writing this arm). `shellTokens` is quote-aware, so a
 * message body is ONE token and cannot be mistaken for argv.
 *
 * Deliberately narrow: fires on the override, never on `git commit` itself, and never on a `git config` write
 * — setting the machine's identity is legitimate; smuggling one past it for a single commit is not.
 */
export function isCommitIdentityOverride(segment) {
  // `shellTokens` yields {text, quoted, op} records, not strings — read `.text`.
  //
  // QUOTED-NESS IS NOT THE DISCRIMINATOR, and the first cut's use of it was a REAL BYPASS (#1550 correctness
  // juror, confirmed by probe): shell quoting is invisible to git, so `git -c user.email=x "commit"`,
  // `git "-c" user.email=x commit` and `GIT_AUTHOR_EMAIL="a@b" git commit` all override authorship while
  // reading as "quoted, therefore prose". Requiring unquoted tokens made the arm trivially evadable.
  //
  // The only place prose legitimately appears in a commit's argv is the VALUE OF A MESSAGE FLAG, so that is
  // what is skipped — precisely, by position. Everything else is argv and is checked regardless of quoting.
  // This still lets `git commit -m "docs: never pass -c user.email=foo"` through, which is the false positive
  // the token walk exists to avoid.
  const argv = argvTokens(segment);
  // It must be GIT that is committing. Checking only for a `commit` token denied any tool whose argv happens
  // to carry the same shapes — `npm run commit -- --author=me`, `my-tool commit --author=x` (#1550 juror r4,
  // confirmed by probe). `canonicalCommand` peels wrappers and path-qualification, so `/usr/bin/git` and
  // `env git` still resolve.
  if (programWord(segment) !== 'git') return false;
  if (!argv.some((t) => t.text === 'commit')) return false;
  // CASE-INSENSITIVE, because git's own config parsing is: section and variable names fold, so
  // `-c User.Email=…` and `-c USER.NAME=…` set the identity exactly as the lowercase spellings do. Verified
  // against real git — `git -c User.Email=case@test.invalid commit` records that address (#1550 juror r2).
  // The `-c` flag itself stays case-SENSITIVE: `-C` is git's change-directory flag, a different thing
  // entirely, and folding it would deny an innocent `git -C <path> commit`.
  const isIdentityConfig = (v) => /^user\.(?:email|name)=/i.test(v);
  for (let i = 0; i < argv.length; i++) {
    const text = argv[i].text;
    // `-c user.email=…` (separate) and `-cuser.email=…` (glued) — git accepts both.
    if (text === '-c' && isIdentityConfig(argv[i + 1]?.text || '')) return true;
    if (text.startsWith('-c') && isIdentityConfig(text.slice(2))) return true;
    // `--author=…` / `--author …` forges the same field by another door.
    if (text === '--author' || text.startsWith('--author=')) return true;
    // The env pair, as its own leading token (`GIT_AUTHOR_EMAIL=a@b git commit …`).
    if (/^GIT_(?:AUTHOR|COMMITTER)_(?:EMAIL|NAME)=/.test(text)) return true;
  }
  return false;
}

/**
 * A segment's ARGV tokens with message VALUES removed — the one view both halves of the identity arm must
 * read. Prose only ever reaches argv as the value of a message flag, so exempting those by POSITION is what
 * separates "the command does X" from "the command mentions X".
 *
 * Extracted because three separate raw-text reads each re-learned this the hard way: the `-c` match (r1), the
 * cross-segment `setsIdentity` scan and the sanctioned-escape test (both #1551 juror). The last was a real
 * BYPASS — `git -c user.email=evil commit -m "COMMIT_IDENTITY_OK=1"` spoofed the escape and was allowed.
 */
function argvTokens(seg) {
  const tokens = shellTokens(String(seg || '')).filter((t) => !t.op);
  const MESSAGE_FLAG = /^(?:-m|--message|-F|--file|-t|--template)$/;
  const CARRIES_VALUE = /^(?:-m.|--message=|--file=|--template=)/;
  const isValue = new Array(tokens.length).fill(false);
  for (let i = 0; i < tokens.length; i++) {
    if (MESSAGE_FLAG.test(tokens[i].text) && i + 1 < tokens.length) isValue[i + 1] = true;
  }
  return tokens.filter((_, i) => !isValue[i]).filter((t) => !CARRIES_VALUE.test(t.text));
}

/**
 * Is the sanctioned escape genuinely SET here — an env-assignment PREFIX, the only position in which bash
 * actually exports it? Pure.
 *
 * Two earlier cuts were bypasses. The first was a raw substring test, so quoting the escape in `-m` disarmed
 * the arm. The second exempted message values but still accepted the token ANYWHERE in argv — so
 * `git -c user.email=evil commit -m hi -- COMMIT_IDENTITY_OK=1` (a pathspec) and
 * `git -c user.email=evil commit COMMIT_IDENTITY_OK=1` (a stray operand) both spoofed it (#1551 juror r2).
 *
 * Position is what makes it real: bash only treats `NAME=value` as an environment assignment when it PRECEDES
 * the command word. So every token before the escape must itself be an assignment, and the escape must come
 * before the program word. `COMMIT_IDENTITY_OK=1 git … commit` passes; the same text after `commit` does not.
 */
function hasIdentityEscape(text) {
  const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
  return parseSegments(String(text || '')).segments.some((seg) => {
    const toks = argvTokens(seg).map((t) => t.text);
    const lead = toks.findIndex((t) => !ASSIGNMENT.test(t));      // the command word, or -1 if all assignments
    const prefix = lead < 0 ? toks : toks.slice(0, lead);
    return prefix.includes('COMMIT_IDENTITY_OK=1');
  });
}

/**
 * The PROGRAM WORD of a segment. `canonicalCommand` returns the whole canonicalized command string, not the
 * head — reading its result as the program name denied nothing and allowed everything (caught by probe).
 */
function programWord(seg) {
  return String(canonicalCommand(String(seg || '')) || '').trim().split(/\s+/)[0] || '';
}

/** Is this segment GIT committing? Pure. `programWord` peels wrappers, so `/usr/bin/git` resolves. */
function isGitCommitSegment(seg) {
  if (programWord(seg) !== 'git') return false;
  return shellTokens(String(seg || '')).some((t) => !t.op && t.text === 'commit');
}

/**
 * The WHOLE-COMMAND half of the identity arm: an override established in one segment and consumed by a
 * `git commit` in another. Pure (unit-tested).
 *
 * `reason` sees one segment at a time, so `export GIT_AUTHOR_EMAIL=x && git commit -m hi` slips through —
 * neither segment alone both sets the identity and commits (#1550 juror r3, confirmed by probe). The shape of
 * the fix is precedented: `backgroundedVerificationReason` is likewise whole-command, for the same reason
 * (backgrounding is a property of the command, not a segment).
 *
 * Covers the env pair set by `export` or bare assignment, and a `git config user.{email,name}` write in the
 * same command as a commit. The latter is the one deliberate widening: a standalone `git config` write is
 * legitimate and stays allowed — the machine's identity is the operator's to set — but chaining it to a
 * commit in one breath is an override for that commit wearing a different hat.
 */
export function commitIdentityCommandReason(command) {
  const text = String(command || '');
  if (hasIdentityEscape(text)) return null;
  const segs = parseSegments(text).segments;
  if (segs.length < 2) return null;                       // single segment is `reason`'s business
  if (!segs.some((s) => isGitCommitSegment(s))) return null;
  const setsIdentity = segs.some((s) => {
    const toks = argvTokens(s).map((t) => t.text);
    if (toks.some((t) => /^GIT_(?:AUTHOR|COMMITTER)_(?:EMAIL|NAME)=/.test(t))) return true;
    // `git config [--global] user.email <VALUE>` — a WRITE only. A bare `git config user.email` is a READ
    // and changes nothing, so denying it was pure over-reach (#1550 juror r4, confirmed by probe). The write
    // is distinguished structurally: the key must be followed by a non-flag token, its value.
    if (programWord(s) !== 'git' || !toks.includes('config')) return false;
    const key = toks.findIndex((t) => /^user\.(?:email|name)$/i.test(t));
    if (key < 0) return false;
    return toks.slice(key + 1).some((t) => !t.startsWith('-'));
  });
  if (!setsIdentity) return null;
  return 'This command sets the git author/committer identity in one segment and commits in another (`export GIT_AUTHOR_EMAIL=… && git commit`, or a `git config user.email` write chained to a commit). The machine already has the right identity configured, so this can only mis-attribute the commit — and unsigned commits in someone else\'s name land on `main` and stay there. Commit with the ambient identity instead. Sanctioned override (rare — replaying another author\'s patch, a `--reset-author` repair): prefix `COMMIT_IDENTITY_OK=1`.';
}

// #2833 finding 3 — the VERIFICATION set that must never be backgrounded. The whole point of #2833 is that a
// build subagent BACKGROUNDED its long verification and then yielded mid-run — the lane sat mid-flight, produced
// nothing, and never errored, so nothing reclaimed it. The delivery brief only asks for this in PROSE; this hook
// makes it structural. A command is a verification RUN when it actually invokes one of: `scripts/verify-lane.mjs`,
// the declared `run.mjs verify` operation (#3105 — it shells the SAME synchronous suite run under the hood, so
// backgrounding it carries the identical stall risk), `check:standards`, or `test:unit` (via a package runner,
// or the bare `npm test` alias). Anchored to a runner / the script path so a mere MENTION (grep/echo
// "check:standards") is not matched.
const VERIFICATION_RUN =
  /\bnode\s+\S*\bverify-lane\.mjs\b|\bnode\s+\S*\brun\.mjs\s+verify\b|\b(?:npm|pnpm|yarn|run-s|run-p|npm-run-all)\b[^|;&]*\b(?:check:standards|test:unit)\b|\bnpm\s+(?:run\s+)?test\b/;

// THE OPERATION FORM OF THE SAME RUN (2026-09-06). The regex above anchors on the RAW HOME, and every
// operation that declares over one is a second spelling of the identical command that the guard did not
// see: `run.mjs verify` shells `verify-lane.mjs` through `verify-io.mjs`, so backgrounding it is the
// #2833 stall exactly as backgrounding the home is. Measured the day this landed — four backgrounded
// `run.mjs verify` calls in one session, two of which returned `unrun` and were nearly reported green.
//
// DERIVED from DECLARED_HOMES, never hand-listed, for the reason the #3224 scan's own map states: a second
// list of the same relationship drifts from the moment it is written. An operation that declares over a
// guarded home is covered the day it is declared, with no edit here.
const OPERATIONS_OVER_VERIFICATION = Object.entries(DECLARED_HOMES)
  .filter(([, homes]) => homes.some((h) => VERIFICATION_RUN.test(`node ${h.replace(/^[a-z-]+:/, '')}`)))
  .map(([op]) => op);

const VERIFICATION_OPERATION = OPERATIONS_OVER_VERIFICATION.length
  // Anchored to the RUNNER + script path, exactly as VERIFICATION_RUN is, so a mere MENTION
  // (`echo "run.mjs verify …"`, a grep pattern, prose in a heredoc) is not matched as a run.
  ? new RegExp(`\\bnode\\s+\\S*\\brun\\.mjs\\s+(?:${OPERATIONS_OVER_VERIFICATION.join('|')})\\b`)
  : null;

// xaipsbs (2026-09-21) — the RAW spellings of the same heavy work, which the regex above never saw: vitest
// run/related through npx (or its bin), `npm run verify`, `node scripts/check-standards.mjs` and
// `npx playwright test`. Matched on each segment's CANONICAL head (the program actually run, wrappers peeled),
// never on the raw string, so a mention is not a run: `git commit -m "npx vitest run"`, `grep "npx vitest run"`,
// and `npx vitest --version` all stay unmatched. The admitted form (`node …heavy-admission.mjs run -- <cmd>`)
// has `node heavy-admission.mjs` as its head, so it is NOT a raw run — it is the sanctioned spelling.
const HEAVY_RAW_HEADS = [
  /^(?:npx|pnpx|bunx)\s+(?:-{1,2}\S+\s+)*vitest\s+(?:run|related)\b/,
  /^vitest\s+(?:run|related)\b/,
  /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?)\s+verify(?=\s|$)/,
  /^node\s+(?:\S*\/)?check-standards\.mjs\b/,
  /^(?:npx|pnpx|bunx)\s+(?:-{1,2}\S+\s+)*playwright\s+test\b/,
  /^playwright\s+test\b/,
];
const ADMISSION_WRAPPER_HEAD = /^node\s+(?:\S*\/)?heavy-admission\.mjs\s+run\b/;

/** Run `test` over each segment's canonical head. Heredoc bodies are data, never commands. */
function someSegmentHead(command, test) {
  return parseSegments(heredocScan(String(command || '')).text).segments.some((seg) => test(canonicalCommand(seg)));
}

/** Does this command run a raw heavy command the regex above does not cover (vitest, `npm run verify`,
 *  check-standards.mjs, playwright test)? Pure. */
export function isHeavyRawRun(command) {
  return someSegmentHead(command, (head) => HEAVY_RAW_HEADS.some((re) => re.test(head)));
}

/** Does this command run something through the admission wrapper (`heavy-admission.mjs run -- …`)? Pure. */
export function isAdmittedWrapperRun(command) {
  return someSegmentHead(command, (head) => ADMISSION_WRAPPER_HEAD.test(head));
}

/** Does this command INVOKE a member of the verification set (verify-lane / check:standards / test:unit, and
 *  since xaipsbs the raw heavy spellings above)? Pure. Matches the raw home, the declared operation that shells
 *  it, and the raw heavy commands. */
export function isVerificationRun(command) {
  const c = String(command || '');
  return VERIFICATION_RUN.test(c) || (VERIFICATION_OPERATION !== null && VERIFICATION_OPERATION.test(c)) || isHeavyRawRun(c);
}

/** Recognize the actual Node script operand, never an echoed/commented filename or a substring. Pure. */
export function isDirectTaskInvocation(command) {
  return parseSegments(heredocScan(String(command || '')).text).segments.some((segment) => {
    let head = canonicalCommand(segment);
    // canonicalCommand peels env/exec wrappers, but leaves these background launchers intact.
    while (/^(?:nohup|setsid)\s+/.test(head)) {
      head = canonicalCommand(head.replace(/^(?:nohup|setsid)\s+(?:--\s+)?/, ''));
    }
    const words = headWords(head).map((word) => word.text);
    if (words[0] !== 'node') return false;
    const script = words[1] === '--' ? words[2] : words[1];
    return /(?:^|\/)(?:codex|gemini)-direct-task\.mjs$/.test(script || '');
  });
}

/** Whole-command check: retain both the shell background operator and the Bash tool parameter. Pure. */
export function backgroundedDirectTaskReason(command, runInBackground = false) {
  if (!isDirectTaskInvocation(command) || !isBackgrounded(command, runInBackground)) return null;
  return 'codex-direct-task.mjs and gemini-direct-task.mjs are SYNCHRONOUS: they already block until the delegated Codex/Antigravity task completes. Their FOREGROUND ONLY banner comments forbid backgrounding and Monitor/nested waits. Invoke as a normal FOREGROUND Bash call and wait for it to return; backgrounding has no legitimate use and there is no override.';
}

// A TRUNCATING PIPE on an operation's `--json` (2026-09-06). `--json` emits the whole payload — every
// finding's failure_scenario, rootCause and prevention prose — so it overflows a terminal and invites a
// `| tail -N` to make it fit. That does not truncate a VIEW, it corrupts the VALUE: the JSON no longer
// parses, so the verdict is lost entirely rather than partially. Three times in one session, twice
// recovered only from the durable run record.
//
// The fix is free and already built: DROP `--json` and the default render prints exactly the compact
// verdict (run id, stop reason, verdict, spend, the pending ask, the owning skill). Keep `--json` only to
// PARSE, and redirect it to a file.
// THE PRODUCER HALF, anchored on the RUNNER exactly as `VERIFICATION_RUN` is (`node <path>run.mjs`), so a
// MENTION is not a run. The first cut omitted that anchor while the PR body claimed it had it, and
// `echo "run.mjs verify --json" | tail -5` — prose ABOUT a command — was denied as if it were the command.
const OPERATION_JSON_PRODUCER = /\bnode\s+\S*\brun\.mjs\b[\s\S]*--json\b/;
/** THE CONSUMER HALF: a segment whose command word is `head`/`tail`, past any leading `VAR=…` assignments. */
const TRUNCATING_CONSUMER = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:head|tail)\b/;

/**
 * Is an operation's `--json` piped into head/tail — corrupting the payload rather than trimming a view? Pure.
 *
 * PIPELINE-SCOPED, via `parseSegments`' `pipedFrom`, and that is the correctness of it rather than a tidiness
 * (#1961 review r3, CONFIRMED against the running code). The first cut approximated "the same pipeline" as a
 * whole-string regex with `[^|]*` runs, which is wrong in BOTH directions:
 *   • FALSE POSITIVE across a statement separator — `run.mjs verify --json > /tmp/r.json; git log | tail -5`
 *     was denied. The payload is already safely redirected to a file and the `tail` belongs to an unrelated
 *     statement; `[^|]*` excludes other PIPES but says nothing about `;` / `&&` / `||`.
 *   • FALSE NEGATIVE through a longer pipeline — `run.mjs verify --json | jq . | tail -5` was ALLOWED, because
 *     the intervening `|` broke the `[^|]*` run. That is the exact corruption this guard exists to stop,
 *     walking straight through it.
 * `pipedFrom[i]` is true only for a real data pipe from the previous segment, so a run of consecutive true
 * values IS one pipeline and a false value starts a new one. Walk it once, carrying whether the pipeline in
 * hand is currently transporting an operation's JSON.
 */
export function isTruncatedOperationJson(command) {
  // Heredoc bodies are DATA, not commands — same treatment `unparseableReason` gives them, so a payload that
  // happens to quote this shape is not read as an invocation of it.
  const { segments, pipedFrom } = parseSegments(heredocScan(String(command || '')).text);
  let carryingJson = false;
  for (let i = 0; i < segments.length; i++) {
    if (!pipedFrom[i]) carryingJson = false;                                    // a new pipeline starts here
    else if (carryingJson && TRUNCATING_CONSUMER.test(segments[i])) return true; // …and it eats the payload
    if (OPERATION_JSON_PRODUCER.test(segments[i])) carryingJson = true;
  }
  return false;
}

/**
 * Is `command` being BACKGROUNDED? Pure. Two channels the #2833 stall can arrive through:
 *   • the Bash tool's `run_in_background: true` parameter (the harness detaches it) — passed in as `runInBackground`;
 *   • a shell background operator in the command text — a trailing/embedded `&` (NOT `&&`), or `nohup`/`setsid`/
 *     `disown`. `&&`/`||` and redirections (`&>`, `2>&1`, `>&2`) are neutralized first so only a real background
 *     `&` remains.
 */
export function isBackgrounded(command, runInBackground = false) {
  if (runInBackground === true) return true;
  let c = String(command || '');
  if (/\b(?:nohup|setsid|disown)\b/.test(c)) return true;
  c = c
    .replace(/&&/g, ' ')            // logical AND — not backgrounding
    .replace(/\|\|/g, ' ')          // logical OR
    .replace(/[0-9]*>&[0-9-]*/g, '') // fd redirection: 2>&1, >&2, 1>&-
    .replace(/&>/g, '');            // bash `&>file` combined redirect
  return /&/.test(c);
}

/**
 * The #2833 finding-3 deny reason: a verification-set command that is being backgrounded. Pure. Returns a reason
 * string when BOTH true (it's a verification run AND it's backgrounded), else null. Checked at whole-command level
 * (backgrounding is a property of the whole command / the tool param, which the per-segment split would lose).
 */
export function backgroundedVerificationReason(command, runInBackground = false) {
  // xaipsbs — the admitted wrapper form is still the suite run, so backgrounding it is the same stall.
  if (!(isVerificationRun(command) || isAdmittedWrapperRun(command)) || !isBackgrounded(command, runInBackground)) return null;
  return 'the verification set (verify-lane / check:standards / test:unit / vitest / playwright test, raw or through heavy-admission.mjs run) must run SYNCHRONOUSLY in the FOREGROUND — never backgrounded (run_in_background, a trailing `&`, nohup/setsid/disown). Backgrounding the suite run and then yielding is the EXACT #2833 subagent stall: the lane sits mid-flight, produces nothing, and never errors, so nothing reclaims it. Re-run it in the foreground and WAIT for it to exit before landing (`node scripts/verify-lane.mjs …`, blocking). There is no override — a synchronous run is the whole point.';
}

/**
 * #3105 — a MECHANICALLY DISPATCHED agent (build/fix/ci-heal, launched by `dispatch-lane` — marked via the
 * `WE_DISPATCH_KIND` env var {@link ../operations/dispatch-lane-io.mjs} sets on the spawn) may never run the
 * verification set directly AT ALL, foreground or background: the gate legitimately takes 150–350s, well past
 * the agent tool's ~120s foreground window, so a directly-run gate is auto-backgrounded and the agent stalls
 * with no error — the #2833 shape, just reached without ever typing `&`. `request` + poll `check` is the only
 * sanctioned path (`scripts/verify-dispatch.mjs`, the runner's own process, runs the gate with no such
 * ceiling). Scoped to a DISPATCHED agent only — the operator's own interactive session (no `WE_DISPATCH_KIND`)
 * legitimately runs these commands directly, e.g. to hand-verify a fix before committing. No override: a
 * dispatched agent has no legitimate reason to run the gate itself, ever.
 */
// `verify-lane.mjs request`/`check`/`reset` are fast, non-blocking marker reads/writes — the SANCTIONED path
// this rule exists to steer a dispatched agent toward, not something to deny alongside the actual suite run.
// Only the `check:standards`/`test:unit` alternatives (which have no such non-blocking mode at all) and a bare
// `verify-lane.mjs` invocation (its DEFAULT mode runs the suites) are the ones this rule must catch.
const SANCTIONED_VERIFY_LANE_QUERY = /\bnode\s+\S*\bverify-lane\.mjs\b\s+(?:request|check|reset)\b/;

/** A wrapped `vitest` / `vitest related` (no `run` subcommand) with no one-shot flag can drop into watch mode and
 *  hang inside the admission wrapper (#4449). Returns a reason, else null. Pure. */
export function admittedVitestWatchReason(command) {
  const offending = parseSegments(heredocScan(String(command || '')).text).segments.some((seg) => {
    if (!ADMISSION_WRAPPER_HEAD.test(canonicalCommand(seg))) return false;
    const words = shellTokens(String(seg || '')).filter((t) => !t.op).map((t) => t.text);
    const dash = words.indexOf('--');
    if (dash < 0) return false;
    const wrapped = words.slice(dash + 1);
    const at = wrapped.findIndex((w) => w === 'vitest');
    if (at < 0 || (at > 0 && !/^(?:npx|pnpx|bunx)$/.test(wrapped[0]))) return false;
    const rest = wrapped.slice(at + 1);
    if (rest[0] === 'run') return false;
    return !rest.some((w) => w === '--run' || w === '--no-watch' || /^--watch=false$/.test(w));
  });
  if (!offending) return null;
  return 'a `vitest` run inside the admission wrapper without `--run` (or `--watch=false`) can drop into watch mode and hang the agent — add `--run`, e.g. `… run -- npx vitest related <file> --run --passWithNoTests` (the delivery brief\'s "Keep `--run --passWithNoTests`" paragraph).';
}

export function dispatchedAgentVerificationReason(command, dispatchKind) {
  if (dispatchKind) {
    const watch = admittedVitestWatchReason(command);
    if (watch) return watch;
  }
  if (!dispatchKind || !isVerificationRun(command)) return null;
  if (SANCTIONED_VERIFY_LANE_QUERY.test(String(command || ''))) return null;
  return `a mechanically-dispatched ${dispatchKind} agent may not run the verification set (verify-lane / check:standards / test:unit / vitest / npm run verify / playwright test) directly — the gate legitimately takes 150–350s, well past this tool's ~120s foreground window, so a direct run gets silently auto-backgrounded and the agent stalls with no error (#3105), and a raw run also skips the host's heavy-command admission pool (xaipsbs). For the full gate, request it and poll for the result: \`node scripts/verify-lane.mjs request\` then \`node scripts/verify-lane.mjs check\` across your own turns — the runner's own process (unbound by this window) actually runs the gate. For one short, targeted run, use the admitted form: \`node scripts/readiness/heavy-admission.mjs run -- <cmd>\` (e.g. \`… run -- npx vitest run <one test file>\`). There is no override.`;
}

/**
 * A truncating pipe on an operation's `--json`. Pure. Returns a reason when the command pipes a
 * `run.mjs … --json` into `head`/`tail`, else null.
 *
 * Whole-command, like its neighbours above: the pipe is the defect, and a per-segment split would see the
 * producer and the consumer separately and match neither.
 */
export function truncatedOperationJsonReason(command) {
  if (!isTruncatedOperationJson(command)) return null;
  return 'an operation\'s `--json` piped into `head`/`tail` does not truncate a VIEW, it corrupts the VALUE — '
    + 'the payload stops being parseable, so the verdict is lost ENTIRELY rather than partially (three times in '
    + 'one session, 2026-09-06; twice recovered only from the durable run record). Two fixes, both free: to READ '
    + 'the outcome, DROP `--json` — the default render already prints the compact verdict (run id, stop reason, '
    + 'verdict, spend, the pending ask, and the owning skill). To PARSE it, redirect to a file '
    + '(`--json > /tmp/run.json`) and query that. The run record under `.operations/runs/<runId>.json` is durable '
    + 'either way and survives whatever happens to stdout.';
}

// #2749/#2788 — the 4th `#primary-read-only-lanes-only` guard arm: a build that WRITES the shared PRIMARY
// tree, run at primary cwd. Three shapes; each pure/unit-tested below. Gated by `primaryCwd` in `reason()` —
// i.e. by where the write LANDS, not by who is asking (no session/agent identity is read, #2335). A lane
// build must carry its `cd <lane> &&`; without it the write really does hit the primary.

// ── shared command normalization (#2788 review r3 finding 1) ──────────────────────────────────────────
// The arms below MUST normalize a segment through the SAME wrapper-peeling `canonicalGitOp` uses (#2367),
// not a weaker local stripper. The first cut peeled only `VAR=`/`sudo`, so ONE leading wrapper word
// (`env`/`time`/`command`/`nice`/`npx`/`xargs`) disarmed all three arms completely — a total bypass beside a
// hardened normalizer that already knew about the whole class. `wrapperPrefixLength` is now the single
// source of truth for both.

/** How many LEADING tokens of `words` are wrapper/assignment noise before the real program word? Pure.
 *  Peels `VAR=val`, `env [VAR=v…]`, `time`/`command`/`builtin`/`nice`, `sudo [-n] [-u <user>]`,
 *  `xargs [opts]` and `npx`/`bunx` `[opts]`. Bounded — every branch advances by ≥1 token. Callers pass
 *  `' '` for a token that must never count as a wrapper (a quoted word, a redirect operator). */
function wrapperPrefixLength(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_]\w*=/.test(w)) { i += 1; continue; }                       // bare `FOO=1 <cmd>` assignment
    if (w === 'env') {                                                        // env VAR=val … <cmd>
      i += 1;
      while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i += 1;
      continue;
    }
    if (w === 'time' || w === 'command' || w === 'builtin' || w === 'nice') { i += 1; continue; }
    if (w === 'sudo') {                                                       // sudo -n -u <user> … <cmd>
      i += 1;
      while (i < words.length && words[i].startsWith('-')) {
        const opt = words[i]; i += 1;
        if (opt === '-u' || opt === '-g' || opt === '-U') i += 1;              // option that takes an argument
      }
      continue;
    }
    if (w === 'xargs') {                                                      // xargs -n1 -I{} … <cmd>
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += 1;
      continue;
    }
    if (w === 'npx' || w === 'bunx') {                                        // npx [-y] [-p <pkg>] <cmd>
      i += 1;
      while (i < words.length && words[i].startsWith('-')) {
        const opt = words[i]; i += 1;
        if (opt === '-p' || opt === '--package' || opt === '-c') i += 1;
      }
      continue;
    }
    break;
  }
  return i;
}

/** Normalize a raw command segment to `<program-basename> <args…>`, or '' when there is no program word.
 *  Pure. Peels the wrapper prefix (`wrapperPrefixLength`), strips surrounding quotes / a leading backslash
 *  off the program word and resolves a path-qualified program to its basename
 *  (`./node_modules/.bin/eleventy` → `eleventy`). Accidental-disguise forms only, matching the #2367
 *  threat model — it deliberately does NOT chase `$(echo git)` / `bash -c "…"`.
 *
 *  #2994 review r3 (parser audit) — the word split used to be a quote-BLIND `c.split(/\s+/)`, a state the
 *  splitter could not represent: a quoted word containing a space became TWO tokens, which desynced the
 *  wrapper peel and so disarmed every arm downstream. `sudo -u "some user" npm run build` and
 *  `env "FOO=a b" npm run build` both read as safe. `headWords` is the same quote-aware scanner the runner
 *  parse uses; the ARGUMENT TAIL is sliced RAW off the original string so quoting survives for the callers
 *  that need it (`sed -i ''`, a quoted redirect target). */
export function canonicalCommand(segment) {
  let c = String(segment || '').trim();
  if (!c) return '';
  c = c.replace(/^[({]\s*/, '').trim();                 // unwrap a leading subshell `(…` / brace group `{ …`
  // …and its CLOSER. r3 audit (found by the differential fuzz) — only the opener was unwrapped, so the
  // closing bracket stayed glued to the last argument and defeated every arm that anchors on a word
  // boundary at end-of-segment: `(pnpm --filter web exec vite build)` reached the vite arm as `vite build)`,
  // which `(?:^|\s)build(?:\s|$)` does not match, and a real tree-writing build read as safe. Quote-safe: a
  // bracket inside a quoted argument (`echo "a)"`) leaves the string ending in the quote, not the bracket.
  // …plus a LONE trailing backslash, which bash simply drops (`echo a \` prints `a`). Peeled in a loop so
  // `(vite build) \` reduces all the way to `vite build`.
  for (;;) {
    const next = c.replace(/\s+$/, '').replace(/(?<!\\)[)}]$/, '').replace(/(?<!\\)\\$/, '');
    if (next === c) break;
    c = next;
  }
  if (!c) return '';
  const words = headWords(c);
  const k = wrapperPrefixLength(words.map((w) => w.text));
  if (k >= words.length) return '';
  const prog = words[k].text.replace(/^\\+/, '').replace(/^.*\//, '');
  if (!prog) return '';
  return (prog + c.slice(words[k].end)).trim();
}

// (a) an actual RUN of the tree-writing `build` family. `build:check` (writes only `/tmp`, see package.json's
// `--output=/tmp/…`) and `build:plugs` (already its own arm above, different message/reason) are excluded —
// neither is a primary-tree write in the sense this arm cares about.
const BUILD_RUNNER = /^(?:npm|pnpm|yarn|run-s|run-p|npm-run-all)\b/;
/** Every `build`/`build:<target>` token in a segment. `\b` keeps `rebuild-cache` / `prebuild` out. */
const BUILD_TARGETS_G = /\bbuild(?::[-\w]+)?\b/g;
// #2788 review r2 — the exclusion is tested against EVERY build target in the segment, and the arm fires if
// ANY of them is tree-writing. Two earlier cuts were both bypassable:
//   r0 tested the exclusion against the WHOLE segment, so merely MENTIONING `build:check` anywhere disarmed
//      a real build (`npm run build && echo build:check` read as safe).
//   r1 tested it against ONE extracted target — the FIRST in a greedy match — so an excluded target placed
//      BEFORE a real one disarmed it (verified: `run-s build:check build` read as safe). Same bypass, new
//      spelling. Checking all targets removes the ordering dependency entirely.
const BUILD_RUN_EXCLUDED = /^build:(?:check|plugs)$/;

// (a2) the build TOOLS the `build` aliases delegate to. #2788 review r3 finding 5 — `build = build:docs &&
// build:demo`, `build:docs = eleventy`, `build:demo = vite build`, so denying only the npm alias blocked the
// NAME, not the effect: `vite build` / `eleventy` / `./node_modules/.bin/eleventy` wrote the same `dist/`
// and `_site/` at the shared checkout and walked straight through. `eleventy --output=<scratch>` is the
// `build:check` spelling and stays allowed.
// r5 F2 — the terminator used to be `(?:\s|$)` alone, which is why an exec remainder of
// `vite build) >/dev/null` missed: the `)` is neither whitespace nor end-of-line. The npm-SCRIPT path
// survived the same shape only because it matches with `\bbuild\b`. A GROUP CLOSER is now a terminator
// too — and only a closer, so `vite --outDir build-out` still does not read as a build subcommand.
const VITE_BUILD_SUBCOMMAND = /(?:^|\s)build(?:[\s)}]|$)/;
const OUTPUT_FLAG = /--(?:output|outDir|out-dir)(?:=|\s+)(\S+)/;

// #2986(3) — bare `eleventy` writes `_site/`, so the arm denies it; but `--version`/`--help`/`--dryrun`
// write NOTHING, and the arm allowed only an explicit scratch `--output=`. A small allowlist of flags that
// suppress the write. `--serve`/`--watch` stay DENIED and take precedence — they really do write the site
// directory (and keep writing it), so their presence overrides anything else on the line.
// r5 F2 (same class as VITE_BUILD_SUBCOMMAND above) — a GROUP CLOSER terminates the flag too, or
// `(eleventy --version) >/dev/null` reads `--version)` as an unknown flag and the no-write allowlist
// misses, denying a command that writes nothing. `--serve)` must keep DENYING, so both get the closer.
const ELEVENTY_NO_WRITE_FLAG = /(?:^|\s)--(?:version|help|dryrun|dry-run)(?=[\s=)}]|$)/;
const ELEVENTY_WRITES_FLAG = /(?:^|\s)--(?:serve|watch)(?=[\s=)}]|$)/;

// #2986(2) — what a package-runner invocation ACTUALLY runs: either a COMMAND (`exec`/`dlx`) or a set of
// SCRIPT NAMES. Pure.
// `BUILD_TARGETS_G` used to be matched against the WHOLE segment, so the word `build` ANYWHERE in a runner
// line fired the arm: `npm run test:unit -- src/build-graph.test.ts`, `npm run lint src/build/`,
// `npm install --build-from-source …`, `pnpm add node-gyp-build`. Scanning only the positions a runner
// treats as a script name keeps every real alias (`npm run build`, `yarn build`, `run-s build:check build`)
// while dropping the incidental mentions. An `exec`/`dlx` form is not a script name at all — the caller
// re-canonicalizes its remainder so `pnpm exec vite build` still reaches the `vite` arm below.
//
// #2994 review r2 — the first cut of that narrowing was a regex (`^<runner> (exec|dlx) (--\s+)?(.+)$`) plus a
// "first non-flag word is the script name" scan, and BOTH under-matched real, tree-writing builds that the
// pre-#2986 guard denied:
//   • any flag between `exec`/`dlx` and the tool made the FLAG the recursed program —
//     `npm exec --package=vite vite build`, `npm exec --yes vite build`, `pnpm exec --silent vite build`,
//     `pnpm dlx --package=vite vite build`, `yarn dlx -q eleventy` all read as safe.
//   • `-c '<command>'` (npm's `--call`) hides the command in a quoted argument entirely.
//   • a runner-level selector before the subcommand desynced the script-name scan —
//     `pnpm --filter web exec vite build` (the `--filter` VALUE became the subcommand), and
//     `yarn workspace web build` (the workspace NAME became the script name).
// The replacement walks the invocation word by word, quote-aware, the way the runner itself does: skip
// runner-level flags (consuming the VALUE of the ones that take a separate value word), see through
// `workspace <name>`, then classify what is left as an `exec` command or a `run`/bare script name.
const RUNNER_NAMES = new Set(['npm', 'pnpm', 'yarn', 'bun', 'run-s', 'run-p', 'npm-run-all']);
const MULTI_SCRIPT_RUNNERS = new Set(['run-s', 'run-p', 'npm-run-all']);
/** Runner-level flags whose VALUE is a separate following word (so the value is not a subcommand/program). */
const RUNNER_VALUE_FLAGS = new Set(['--package', '-p', '--filter', '-F', '--workspace', '-w', '--prefix', '-C', '--dir', '--cwd']);
/** npm `exec --call/-c '<command>'` — the value is a COMMAND LINE, so it is recursed, not skipped. */
const RUNNER_CALL_FLAGS = new Set(['--call', '-c']);

/** Quote-aware word split of a command head that also reports each word's RAW `start`/`end` offsets in
 *  `head`, so the `exec` remainder (and `canonicalCommand`'s argument tail) can be handed on VERBATIM —
 *  rejoining unquoted words would drop a `sed -i ''` empty argument and re-open #2986/1. Shares the ONE
 *  low-level run scanner below (`scanRun`), so `\"`, a `#` comment and a `\`+newline continuation are all
 *  read the way bash reads them and can never desync a word boundary. */
function headWords(s) {
  const out = [];
  let cur = '';
  let start = -1;
  let end = -1;
  let quoted = false;
  let dq = false;
  let inComment = false;
  const flush = () => { if (start >= 0) out.push({ text: cur, start, end, quoted, dq }); cur = ''; start = -1; end = -1; quoted = false; dq = false; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) { flush(); if (ch === '\n') inComment = false; continue; }
    const run = inComment ? null : scanRun(s, i, start < 0);
    if (run && run.kind === 'continuation') { i = run.end; continue; }   // `\`+newline: spliced away entirely
    if (run && run.kind === 'comment') inComment = true;                 // quoting is OFF from here to EOL
    if (start < 0) start = i;
    if (run && run.kind !== 'comment') {
      cur += run.body;
      if (run.kind === 'quote' || run.kind === 'unterminated') quoted = true;
      // …and WHICH quote kind. A `"…"`/`$"…"` run resolves `\"`→`"` when bash reads the word; a `'…'` run
      // resolves nothing. Only the re-execution recursion needs the distinction (r5), so `body` stays the
      // verbatim inner text and the caller un-escapes when — and only when — bash would have.
      if (run.raw[0] === '"' || run.raw.startsWith('$"')) dq = true;
      end = run.end + 1;
      i = run.end;
      continue;
    }
    cur += ch;
    end = i + 1;
  }
  flush();
  return out;
}

/**
 * Classify a package-runner invocation `head`. Pure. Returns:
 *   • `{ exec: '<command line>' }` — an `exec`/`dlx`/`--call` form; the caller re-canonicalizes the command.
 *   • `{ names: [...] }`          — the script-name argument positions (possibly empty).
 *   • `null`                      — not a package runner at all.
 */
export function runnerInvocation(head) {
  const words = headWords(String(head || ''));
  if (!words.length) return null;
  const runner = words[0].text;
  if (!RUNNER_NAMES.has(runner)) return null;

  if (MULTI_SCRIPT_RUNNERS.has(runner)) {                   // EVERY positional arg is a script name
    const names = [];
    for (let i = 1; i < words.length; i++) {
      if (words[i].text === '--') break;
      if (!words[i].text.startsWith('-')) names.push(words[i].text);
    }
    return { names };
  }

  let i = 1;
  let sawExec = false;
  let sawRun = false;
  while (i < words.length) {
    const w = words[i].text;
    if (w === '--') { i += 1; if (sawExec) break; continue; }   // `npm exec -- vite build`
    if (w.startsWith('-')) {
      const eq = w.indexOf('=');
      const flag = eq === -1 ? w : w.slice(0, eq);
      if (RUNNER_CALL_FLAGS.has(flag)) {                       // the value IS a command line
        return { exec: eq === -1 ? (words[i + 1] ? words[i + 1].text : '') : w.slice(eq + 1) };
      }
      if (eq === -1 && RUNNER_VALUE_FLAGS.has(flag)) i += 1;   // consume the flag's separate value word
      i += 1;
      continue;
    }
    if (w === 'exec' || w === 'dlx') { sawExec = true; i += 1; continue; }
    if (w === 'workspace' || w === 'workspaces') { i += 2; continue; }  // `yarn workspace <name> <rest…>`
    if (w === 'run' || w === 'run-script') { sawRun = true; i += 1; continue; }
    break;                                                    // the subcommand / script-name position
  }
  if (i >= words.length) return { names: [] };
  if (sawExec) return { exec: head.slice(words[i].start) };
  if (sawRun) return { names: [words[i].text] };               // `npm run <script>` — ONLY the script name
  // yarn/pnpm/bun accept a BARE script name (`yarn build`); npm does not (`npm install …` is never a script).
  return { names: runner === 'npm' ? [] : [words[i].text] };
}

/**
 * #2788 review — is `name=1` present as a LEADING env-assignment prefix of `segment` (the documented
 * "prefix `VAR=1`" spelling), rather than merely appearing somewhere in the text? Pure.
 *
 * A sanctioned escape hatch that matches anywhere is not an escape hatch, it is a bypass: any command that
 * quotes, echoes, greps for, or documents the token would disarm the guard. Scan ONLY the `VAR=val` run at
 * the head of the segment (the sole position a shell treats as an assignment for the following command) and
 * stop at the first token that is not an assignment.
 */
export function hasLeadingEnvEscape(segment, name) {
  // A leading `env` is part of the assignment prefix too (`env VAR=1 npm run build`) — the wrapper peel above
  // now sees through `env`, so the escape must see through it as well or the wrapper form would be a
  // deny-with-no-way-out.
  const s = String(segment || '').replace(/^\s+/, '').replace(/^env\s+/, '');
  const re = /^(\w+)=(\S*)\s+/;
  let rest = s;
  for (;;) {
    const m = rest.match(re);
    if (!m) return false;
    if (m[1] === name && m[2] === '1') return true;
    rest = rest.slice(m[0].length);
  }
}

/** Is `segment` an actual RUN (not a mention — anchored at command position, not a quoted/echoed string) of
 *  the tree-writing `build` family — `npm run build`/`build:docs`/`build:demo`/the bare `pnpm`/`yarn`/
 *  `run-s`/`run-p`/`npm-run-all` equivalent — excluding the non-tree-writing `build:check` (`/tmp` output)
 *  and the separately-handled `build:plugs`? Pure. */
export function isTreeWritingBuildRun(segment) {
  const cmd = canonicalCommand(segment);
  if (!cmd) return false;
  // Stay inside THIS segment — QUOTE-AWARELY. A blind `cmd.split(/[|;&]/)[0]` truncated the head at a
  // separator that only exists INSIDE a quoted argument (`npm exec -c 'a && vite build'`), which silently
  // shrank what the arms below could see. `splitSegments` is a no-op on an already-split segment. (r3 audit)
  const head = splitSegments(cmd)[0];
  const prog = head.split(/\s+/)[0];
  // `npm exec … ` / `pnpm dlx …` / `npm exec -c '…'` runs its remainder as a COMMAND, not as a script name —
  // re-canonicalize it so the tool arms below still see `vite build` / `eleventy`.
  const inv = runnerInvocation(head);
  if (inv && inv.exec !== undefined) return isTreeWritingBuildRun(inv.exec);
  if (inv && BUILD_RUNNER.test(head)) {                      // a package runner at command position
    // #2986(2) — only the runner's SCRIPT-NAME positions, never the whole segment.
    const targets = inv.names.flatMap((n) => n.match(BUILD_TARGETS_G) || []);
    // Fire if ANY target is tree-writing — order-independent, so no placement of an excluded name disarms it.
    if (targets.some((t) => !BUILD_RUN_EXCLUDED.test(t))) return true;
  }
  // …and the same effect reached WITHOUT the alias (r3 finding 5).
  if (prog === 'vite') return VITE_BUILD_SUBCOMMAND.test(head.slice(prog.length));
  if (prog === 'eleventy' || prog === '11ty') {
    const args = head.slice(prog.length);
    if (ELEVENTY_WRITES_FLAG.test(args)) return true;        // `--serve`/`--watch` DO write the site dir
    if (ELEVENTY_NO_WRITE_FLAG.test(args)) return false;     // #2986(3) `--version`/`--help`/`--dryrun`
    const out = (head.match(OUTPUT_FLAG) || [])[1];
    return !(out && isScratch(out));                         // `--output=<scratch>` is the build:check shape
  }
  return false;
}

// (b) an fs-writing GENERATOR/SCAFFOLD script — the exact hole guard-lane.mjs misses (a `node` script writes
// the tree via `fs`, never touching the Edit/Write tools). Keyed on the script's own path, not a hardcoded
// list. #2788 review r3 finding 3 — the first cut required `generate`/`scaffold` in the name and so matched
// NOTHING in this tree: every fs-writing generator here is spelled `gen-*` (`gen-inventory.mjs` rewrites
// AGENTS.md, plus `gen-reference-index`, `gen-maas-openapi`, `gen-cem`, `gen-dogfooding-progress`,
// `gen-webdirectives-ssr-vectors`, `gen-wrapper/`). A `gen-`/`gen_` PATH SEGMENT covers the convention as it
// actually is (including the `gen-wrapper/` directory), and `generate`/`scaffold` anywhere in the path keeps
// the forward-looking half.
const GENERATOR_SCRIPT_PATH = /(?:^|\/)gen[-_]|generate|scaffold/i;

/** Is `segment` a `node <path>` invocation (anchored at command position, not a quoted/echoed string) of a
 *  script whose OWN path says it generates/scaffolds files (a `gen-*`/`gen_*` path segment, or
 *  `generate`/`scaffold` anywhere in the path; any extension of `.mjs`/`.cjs`/`.js`)? Pure — matches the
 *  SCRIPT PATH only, so a `scaffold` SUBCOMMAND argument (`node scripts/backlog.mjs scaffold 1234`) is not
 *  this arm's business (it is #2302's). */
export function isGeneratorScriptRun(segment) {
  const head = splitSegments(canonicalCommand(segment))[0];   // quote-aware (r3 audit — see the build arm)
  if (!head) return false;
  // the package-runner ALIAS for the same effect (`npm run gen:inventory`) — same alias-vs-effect pair as the
  // build arm above; blocking only the direct `node` spelling would block the name, not the write.
  if (BUILD_RUNNER.test(head) && /\bgen:[-\w]+\b/.test(head)) return true;
  const m = head.match(/^node\s+(?:--\S+\s+)*(\S+\.(?:mjs|cjs|js))(?:\s|$)/i);
  return !!m && GENERATOR_SCRIPT_PATH.test(m[1]);
}

// (c) a shell redirect/`tee`/`sed -i`/`perl -pi` writing a file — generalizes the existing backlog|reports-
// scoped CORPUS_MD rule (further down in `reason()`) to ANY path, excluding a `/tmp`|`/dev` scratch target
// (the pattern every lane/skill in this very workflow already uses for scratch files, e.g. the manifest/
// PR-body files under `/tmp/`). Anchored the same way as the existing rules: `sed`/`perl`/`tee` must be the
// command word itself, not merely mentioned in a quoted commit message.
// #2788 review r3 findings 2/4/6 — this arm is now parsed, not regex-sniffed. Three bugs shared one root
// (a pattern tuned on one example spelling):
//   • the redirect matcher was anchored to END of segment, so ANYTHING after the target hid it —
//     `cat > config/app.json <<'EOF'`, `> config/app.json echo hi`, `>| config/app.json` all read as safe,
//     and a heredoc is the one idiom an agent reaches for to write a file without the Edit/Write tools.
//   • `sed`/`perl`/`tee` tested ONE argument as a proxy for the whole write set, so a second target
//     (`sed -i s/x/y/ config/app.json /tmp/x`, `tee /tmp/x config/app.json`) fell through the proxy.
//   • `tee`'s flags were one hardcoded spelling (`-a`), so `tee --append /tmp/x` / `tee -a -- /tmp/x` — the
//     STANDARD safe idiom — tested the flag as the filename and were wrongly DENIED.
// `shellTokens` gives quote-aware tokens with redirect operators split out, so the trailing anchor (a
// precision hack for `git commit -m "fix > bug"`) is replaced by the real rule: a `>` inside quotes is not a
// redirect. Every file operand is checked, and the arm fires if ANY of them is a non-scratch path.
// #2788 review — a scratch target is any of the REAL temp roots this platform hands an agent, not just the
// literal `/tmp/` spelling. On macOS `/tmp` is a symlink to `/private/tmp`, and the sanctioned per-session
// scratchpad the harness hands every agent is spelled `/private/tmp/claude-<uid>/…`; `$TMPDIR` resolves to
// `/var/folders/<xx>/<yy>/T/…`. Matching only `^/tmp/` DENIED the agent's own scratchpad (verified: a write to
// `/private/tmp/claude-501/…` flagged as a primary-tree write), turning the guard into a false-positive on the
// single most common legitimate write. Keep this list literal + anchored — a loose `/tmp/` ANYWHERE would let
// `./not-tmp/x` or `foo/tmp/bar` pass as scratch.
const SCRATCH_TARGET = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/tmp\/|\/var\/folders\/|\/dev\/)/;

// #2788 review r2 — a target must be UNQUOTED before the scratch allowlist sees it. `SCRATCH_TARGET` is
// anchored (`^/tmp/`…), so testing the raw shell token made every QUOTED scratch write read as a primary-tree
// write — verified: `tee "/tmp/x"` and `sed -i s/a/b/ "/tmp/x"` were both denied. Quoting a path is ordinary
// shell hygiene (it is what you do for a path with a space), so this was the same false-positive class as the
// scratchpad denial, just one spelling further out.
const unquote = (t) => String(t || '').replace(/^(['"])(.*)\1$/, '$2');
const isScratch = (t) => SCRATCH_TARGET.test(unquote(t));

// ── the ONE quoted-run scanner both quote-aware parsers below share (#2994 review r2) ──────────────────
// `shellTokens` and `splitSegments` each used to find the end of a quoted run with a bare
// `s.indexOf(quote, i + 1)`. That is not how bash ends a quoted run, and the disagreement was a total
// guard bypass rather than a rounding error:
//   `git commit -m "guard: reject \"a|b\" input" && npm run build`
// bash reads `\"` as a LITERAL quote inside the double-quoted run (verified: `bash -c 'echo "a\"b"'`
// prints `a"b`), so the run ends at the FINAL `"`. `indexOf` stopped at the `"` of the `\"`, which left the
// parser one quote out of phase; the NEXT `"` then opened a run with no closer and swallowed the entire
// rest of the line as one blob. Every downstream arm — the tree-write deny, the `git push origin main`
// deny, the `pkill`/`rm backlog/*.md` denies, and (via `hasDestructiveLaneOp`) the whole lane-clobber
// lease check — reads that blob and sees nothing to deny. An EVEN number of escaped quotes does not
// re-sync it either: each `\"` shifts the phase again.
// The rules this encodes are bash's actual ones, and they are NOT uniform across quote kinds:
//   • `"…"`   — a backslash escapes the next character; `\"` does not close the run.
//   • `'…'`   — NOTHING is special, not even a backslash; the run ends at the very next `'`.
//               (`echo 'a\'` is a complete word `a\`, so applying the double-quote rule here would be a
//               NEW desync in the opposite direction.)
//   • `$'…'`  — ANSI-C quoting; backslash escapes ARE honoured, so `\'` does not close the run.
//   • `$"…"`  — locale translation; escapes behave as in `"…"`.
// Same non-shell-parser threat model as before: no expansion, no command substitution.

/** Does a quoted run START at `s[i]` — a `"`/`'`, or the `$` of a `$'…'`/`$"…"` run? Pure. */
function quoteStartsAt(s, i) {
  const ch = s[i];
  if (ch === '"' || ch === "'") return true;
  return ch === '$' && (s[i + 1] === "'" || s[i + 1] === '"');
}

/** Index of the CLOSING quote of the run starting at `s[i]`, or -1 if unterminated. Pure. */
function quotedRunEnd(s, i) {
  const dollar = s[i] === '$';
  const q = dollar ? s[i + 1] : s[i];
  // `"…"`, `$'…'` and `$"…"` honour a backslash escape; a plain `'…'` does not.
  const escapes = dollar || q !== "'";
  for (let j = (dollar ? i + 2 : i + 1); j < s.length; j++) {
    if (escapes && s[j] === '\\' && j + 1 < s.length) { j += 1; continue; }
    if (s[j] === q) return j;
  }
  return -1;
}

// ── the ONE run scanner: FAIL CLOSED, never silently degrade (#2994 review r3) ─────────────────────────
// Rounds 1–3 of this review each closed one SHAPE and opened another of the same CLASS. The mechanism was
// always identical: the scanner reached a state it could not represent, silently degraded to "consume to
// end of string", and handed every deny arm downstream ONE opaque blob in which nothing is anchored at
// command position — so the tree-write arm, the `git push origin main` arm, the `rm backlog/*.md` arm and
// (via `hasDestructiveLaneOp`) the whole lane-clobber lease check all miss at once. A 600k-pair differential
// fuzz produced 13 loosening signatures and every one reduced to that single mechanism.
//
// `scanRun` is the one place a "run" (a stretch of input that is not ordinary literal text) is recognised,
// and it names every state EXPLICITLY, including the one that cannot be parsed:
//   • 'quote'        — a terminated quoted run. bash's rules are NOT uniform across quote kinds:
//                        `"…"`  a backslash escapes the next char; `\"` does not close the run.
//                        `'…'`  NOTHING is special, not even a backslash; the run ends at the very next `'`.
//                        `$'…'` ANSI-C quoting — backslash escapes ARE honoured.
//                        `$"…"` locale translation — escapes behave as in `"…"`.
//   • 'unterminated' — a quoted run with NO closer. bash itself REJECTS this input
//                      (`bash -c "echo 'abc"` → "unexpected EOF while looking for matching `''"), so it is
//                      not a command at all — the guard reports it and `decide` denies, rather than
//                      degrading to the blob. Verified against real bash, not assumed.
//   • 'comment'      — an unquoted `#` that BEGINS a word runs to end-of-line, and NOTHING inside it is
//                      quoting. `# don't forget` ⏎ `npm run build` used to open a phantom quoted run at the
//                      apostrophe and swallow the second line whole (F1). Verified against real bash:
//                      `a#b` and `${#x}` are NOT comments (no word boundary); `a #b`, `a;#b`, `(#b` are.
//                      NOTE the comment TEXT is deliberately still handed to the callers — only QUOTING is
//                      switched off inside it. Suppressing the text as well would drop it from the
//                      non-anchored deny rules and would itself be a loosening.
//   • 'continuation' — `\` + newline is a LINE SPLICE: bash removes both characters and the next physical
//                      line continues the same logical one (verified: `echo a && \`⏎`echo b` prints a then
//                      b). Keeping it verbatim left the next segment starting with a literal `\`⏎ so every
//                      `^`-anchored rule in `reason()` missed (F2).
//   • 'escape'       — `\` + any other character. A LONE trailing `\` at end of input is NOT a run at all
//                      (bash drops it); it falls through as literal text.
// Same non-shell-parser threat model as before: no expansion, no command substitution.

/** End-of-line index for a `#` comment starting at `i` (the newline, or end of string). Pure. */
function commentEnd(s, i) {
  const nl = s.indexOf('\n', i);
  return nl === -1 ? s.length : nl;
}

/** Classify the run starting at `s[i]`, or null when `s[i]` is ordinary literal text. Pure.
 *  `{ kind, end, raw, body }` — `end` is the index of the LAST consumed character, `raw` the verbatim text,
 *  `body` the resolved (unquoted / unescaped) text. `atWordStart` is the caller's own word-boundary state:
 *  bash only starts a comment at a `#` that BEGINS a word. */
function scanRun(s, i, atWordStart) {
  if (quoteStartsAt(s, i)) {
    const close = quotedRunEnd(s, i);
    if (close === -1) {
      // The state the parser CANNOT represent. Report it; callers must deny, never degrade.
      return { kind: 'unterminated', end: s.length - 1, raw: s.slice(i), body: s.slice(s[i] === '$' ? i + 2 : i + 1) };
    }
    return { kind: 'quote', end: close, raw: s.slice(i, close + 1), body: s.slice(s[i] === '$' ? i + 2 : i + 1, close) };
  }
  if (s[i] === '\\' && s[i + 1] === '\n') return { kind: 'continuation', end: i + 1, raw: '', body: '' };
  if (s[i] === '\\' && i + 1 < s.length) return { kind: 'escape', end: i + 1, raw: s.slice(i, i + 2), body: s[i + 1] };
  if (s[i] === '#' && atWordStart) {
    const e = commentEnd(s, i);
    return { kind: 'comment', end: e - 1, raw: s.slice(i, e), body: s.slice(i, e) };
  }
  return null;
}

/**
 * Split a command segment into quote-aware tokens. Pure. Each token is `{ text, quoted, op }`:
 *   • quoting is resolved (the surrounding quotes are removed and `quoted` is set) — so a `>` inside a
 *     quoted argument is ordinary TEXT, never a redirect (this is what makes `git commit -m "fix > bug"`
 *     safe, replacing the old end-of-segment anchor that only worked by accident);
 *   • redirect operators are split out as their own `op` tokens even when glued to their neighbours, with
 *     any fd prefix attached: `2>&1` → `2>&` + `1`, `>|file` → `>|` + `file`, `cmd>x` → `cmd` + `>` + `x`.
 * Not a shell parser — no expansion, no command substitution; the #2367 accidental-collision threat model.
 */
export function shellTokens(segment) {
  const s = String(segment || '');
  const out = [];
  let cur = '';
  let started = false;
  let quoted = false;
  let atWordStart = true;
  let inComment = false;
  const flush = () => { if (started) out.push({ text: cur, quoted, op: false }); cur = ''; started = false; quoted = false; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // Inside a `#` comment ONLY quoting is switched off — whitespace still splits words and a redirect
    // operator is still tokenized, so this changes nothing a caller can observe except that an apostrophe
    // in a comment can no longer open a phantom quoted run (F1).
    const run = inComment ? null : scanRun(s, i, atWordStart);
    if (run && run.kind === 'comment') { inComment = true; }
    else if (run && run.kind === 'continuation') { i = run.end; atWordStart = true; continue; }
    else if (run && run.kind !== 'escape') {                    // 'quote' | 'unterminated'
      cur += run.body;                                          // body only — the quotes are resolved away
      started = true;
      quoted = true;
      atWordStart = false;
      i = run.end;
      continue;
    } else if (run) {                                           // 'escape'
      cur += run.body; started = true; atWordStart = false; i = run.end; continue;
    }
    if (ch === '>' || ch === '<') {
      let fd = '';
      if (started && !quoted && /^(?:[0-9]+|&)$/.test(cur)) { fd = cur; cur = ''; started = false; }  // `2>` / `&>`
      flush();
      let op = fd + ch;
      let j = i + 1;
      if (s[j] === ch) { op += ch; j += 1; }                       // `>>` / `<<`
      if (ch === '<' && op.endsWith('<<') && s[j] === '<') { op += '<'; j += 1; } // here-string
      if (s[j] === '|' || s[j] === '&') { op += s[j]; j += 1; }    // `>|` (noclobber override) / `>&` (fd dup)
      out.push({ text: op, quoted: false, op: true });
      i = j - 1;
      atWordStart = true;
      continue;
    }
    if (/\s/.test(ch)) { flush(); atWordStart = true; if (ch === '\n') inComment = false; continue; }
    cur += ch;
    started = true;
    atWordStart = false;
  }
  flush();
  return out;
}

/**
 * Split a command line into its `&&`/`||`/`;`/`&`/`|`/newline-separated SEGMENTS, honouring quotes. Pure.
 * Returns the RAW text of each segment (quotes intact) — every caller re-parses it (`canonicalCommand`,
 * `shellTokens`, the anchored regexes in `reason`), so this must not consume the quoting it is respecting.
 *
 * #2994 — the whole point. The previous split was a quote-BLIND regex (`/(?:&&|\|\||[;&|]|\n)+/`) applied
 * BEFORE the quote-aware `shellTokens` ever ran, so a `|` inside a quoted argument tore the command in two.
 * The fragment after the tear starts in an unquoted tokenizer state, which broke BOTH ways:
 *   • false DENY — `gh pr list --jq '.[] | select(.n > 5)'` tore at the jq pipe and the `>` in the tail
 *     fragment read as a real redirect to a non-scratch path. That is *the* house idiom for reading GitHub
 *     state, and every jq filter that both pipes and compares hit it.
 *   • false ALLOW — `gh pr list --jq '.[] | .number' > config/app.json` tore at the same pipe, leaving the
 *     tail fragment with an UNBALANCED quote that swallowed the REAL trailing redirect, so a genuine
 *     primary-tree write walked through. Tokenizing quotes first closes the hole and the false deny at once.
 *
 * A redirect operator run (`>`, `>>`, `>|`, `>&`, `&>`, `<`, `<<`) is consumed whole, so the `|`/`&` glued
 * into it is never mistaken for a separator (this is what retires `decide`'s old `>|`→`>` pre-normalization).
 * Same non-shell-parser threat model as `shellTokens`: no expansion, no command substitution.
 *
 * #2994 review r3 — this is the function every loosening signature reduced to, so it no longer hides what it
 * could not parse. It reports its own parse state alongside the segments:
 *   • `unterminated` — a quoted run with no closer was hit. The old code consumed to end-of-string and
 *     returned ONE blob in which nothing is at command position, so every deny arm missed. `decide` now
 *     DENIES on this flag (fail closed) — and denies nothing real, because bash rejects the same input.
 *   • `continued`    — a `\`+newline line splice was spliced away (bash's reading). `decide` also evaluates
 *     the NAIVE per-physical-line reading of such a command, so the splice can never be a net loosening
 *     against the pre-#2994 behaviour: whatever either reading denies, the command is denied.
 * `splitSegments` stays as the segments-only view every existing caller and test uses.
 */
export function parseSegments(command, { spliceContinuations = true } = {}) {
  const s = String(command || '');
  const segs = [];
  // `pipedFrom[i]` — is `segs[i]` fed by a bare `|` (a real data pipe) from `segs[i - 1]`? `segs[0]` has no
  // predecessor, so `pipedFrom[0]` is always false. #2968 — needed to tell `git ls-files … | xargs git add`
  // (one pipeline, the RIGHT side's paths come from the LEFT) apart from `git ls-files …; git add path` (two
  // unrelated commands) — a distinction every OTHER caller of this function has never needed (#2994's own
  // callers only ask "where does one command end"), so it rides as an extra field rather than a second parser.
  // `||` (logical or, not a pipe) is excluded: its second `|` is what the very next char test below reads.
  const pipedFrom = [];
  let pendingPiped = false;      // segs[0] (the first segment) has no predecessor
  let cur = '';
  let unterminated = false;
  let continued = false;
  let atWordStart = true;
  let inComment = false;
  // A comment switches quoting off until END OF LINE — a separator does NOT end it (bash agrees: `# a; b`
  // is all comment). Only a newline clears it.
  const cut = () => { segs.push(cur); pipedFrom.push(pendingPiped); cur = ''; atWordStart = true; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // Inside a `#` comment ONLY quoting is switched off; the comment TEXT and every separator in it are
    // still processed exactly as before, so this can never hide input from a deny rule (F1).
    const run = inComment ? null : scanRun(s, i, atWordStart);
    if (run && run.kind === 'comment') { inComment = true; }        // fall through: the `#` is literal text
    else if (run && run.kind === 'continuation') {
      continued = true;
      i = run.end;                                                  // `\`+newline: both characters vanish
      // …unless we're taking the NAIVE per-physical-line reading, which must reproduce the pre-#2994
      // segment text EXACTLY — trailing `\` included — or it is not the superset it claims to be.
      if (!spliceContinuations) { cur += '\\'; cut(); inComment = false; }
      continue;
    } else if (run) {                                               // 'quote' | 'unterminated' | 'escape'
      if (run.kind === 'unterminated') unterminated = true;
      cur += run.raw;                                               // kept VERBATIM — callers re-parse it
      i = run.end;
      atWordStart = false;
      continue;
    }
    if (ch === '>' || ch === '<' || (ch === '&' && s[i + 1] === '>')) {
      let j = i;
      if (ch === '&') { cur += s[j]; j += 1; }                     // `&>` / `&>>`
      cur += s[j]; j += 1;                                         // the `>` / `<`
      if (s[j] === s[j - 1]) { cur += s[j]; j += 1; }               // `>>` / `<<`
      if (s[j] === '|' || s[j] === '&') { cur += s[j]; j += 1; }    // `>|` (noclobber) / `>&` (fd dup)
      i = j - 1;
      atWordStart = true;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      cut();
      // The NEXT segment's pipedFrom: a bare `|` (not the first `|` of a `||`) — recorded now, consumed by
      // the `cut()` that finalizes THIS next segment.
      pendingPiped = ch === '|' && s[i + 1] !== '|';
      if (ch === '\n') inComment = false;
      while (i + 1 < s.length && /[;&|\n]/.test(s[i + 1])) { if (s[i + 1] === '\n') inComment = false; i += 1; }
      continue;
    }
    cur += ch;
    atWordStart = /[\s()]/.test(ch);      // bash starts a comment at a `#` that BEGINS a word (`(#c` counts)
  }
  segs.push(cur);
  pipedFrom.push(pendingPiped);
  return { segments: segs, unterminated, continued, pipedFrom };
}

/** The segments-only view of `parseSegments` (the raw text of each `&&`/`||`/`;`/`&`/`|`/newline-separated
 *  segment). Pure. Callers that must not silently trust an unparseable command use `parseSegments` and read
 *  its `unterminated` flag. */
export function splitSegments(command) {
  return parseSegments(command).segments;
}

/** The fail-closed deny reason for a command the parser CANNOT represent, or null. Pure.
 *  Today there is exactly one such state: an unterminated quoted run. It is not a judgement call — bash
 *  rejects the identical input with `unexpected EOF while looking for matching quote`, so this denies
 *  nothing that would ever have run, and it removes the only way a command can reach the deny arms as one
 *  opaque blob. Deliberately has NO escape hatch: there is no legitimate command in this state. */
export function unparseableReason(command) {
  const hd = heredocScan(command);
  if (!hd.unterminated && !parseSegments(hd.text).unterminated) return null;
  return 'this command cannot be parsed — it contains an UNTERMINATED quote (a `\'`, `"`, `$\'` or `$"` run with no closing quote), so the guard cannot tell where one command ends and the next begins. bash rejects the same input outright (`unexpected EOF while looking for matching quote`), so nothing that would actually have run is being blocked. The guard fails CLOSED here rather than degrading to a single opaque blob in which no deny rule is anchored at command position (#2994 review r3) — that degradation is the mechanism behind every loosening found in this review. Fix the quoting and re-run. If the text is prose (a commit message, a PR body), pass it via a quoted heredoc (`<<\'EOF\'`), where an apostrophe is data.';
}

// ── #2994 review r5 — the text bash RE-EXECUTES ────────────────────────────────────────────────────────
// The quote-aware split of r1–r4 is correct, and correctness LOST coverage the quote-BLIND split had by
// accident. Base tore `bash -c "git status && git push origin main"` in half at the `&&` inside the quoted
// argument, and the tail fragment (`git push origin main"`) landed on the `git push` arm at command
// position — a right answer for a wrong reason. Reading the quoting properly keeps the whole thing as ONE
// argument of `bash`, which no arm inspects, so the deny disappeared while bash still really pushed.
// Confirmed under real bash in a PATH-stubbed sandbox, not inferred: `bash -c "…"`, `sh -c "…"`,
// `eval "…"`, `$( … )` and `` ` … ` `` all execute their text as commands.
//
// The fix is the one the runner arm already uses for `pnpm exec` / `npm exec --call`: RECURSE into the
// positions that are a script string, and hand what comes out back to the same deny arms at command
// position. That is strictly more coverage than base had (base only ever saw a nested command that
// happened to contain a SEPARATOR; `bash -c "npm run build"` walked through it), and it is structural
// rather than accidental, so it does not depend on where the separators fall.
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox']);
/** `-c`, `-ec`, `-xc`… — the flag whose VALUE is a command line the shell executes. */
const SHELL_C_FLAG = /^-[A-Za-z]*c$/;
// Bounded so a pathological nest can never wedge the guard (the deep-`exec` RangeError is a known,
// separately-filed follow-up; this expansion must not add a second one).
const NESTED_DEPTH_CAP = 4;
const NESTED_NODE_CAP = 64;

/** Index of the `)` that closes the group / command substitution opened at `s[open]` (a `(`), or -1.
 *  Quote-aware and nesting-aware. Pure. */
function groupEnd(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i += 1; continue; }
    if (quoteStartsAt(s, i)) {
      const e = quotedRunEnd(s, i);
      if (e === -1) return -1;
      i = e;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Every COMMAND-SUBSTITUTION body in `s` — `$( … )` and `` ` … ` ``, at any nesting depth, INCLUDING
 *  inside a double-quoted run (bash still expands there, which is exactly how `echo "$(git push origin
 *  main)"` really pushes) but never inside a single-quoted one (bash expands nothing there). Pure.
 *
 *  Double quoting is tracked as a STATE, not consumed as a run: inside `"…"` a substitution is still
 *  recognised, and the quotes INSIDE that substitution are its own. Treating the double-quoted run as
 *  one opaque span instead lost `echo "`+"`"+`find . -name "*.ts"; yarn build`+"`"+`"` — the `"` before
 *  `*.ts` read as the run's closer, so the substitution's tail (a real `yarn build`) was never seen.
 *  `$'…'` is ANSI-C quoting, not a substitution, and falls through to the single-quote branch. */
function substitutionBodies(s, out = []) {
  let inDouble = false;
  // …and it must read a `#` COMMENT the way the rest of the parser already does. Without this, the
  // apostrophe in `# a note — don't forget` ⏎ `echo \`pnpm exec vite build\`` opened a phantom
  // single-quoted run that swallowed the substitution on the NEXT line — the same F1 desync `scanRun`
  // was built to end, re-introduced in a new scanner.
  let inComment = false;
  let atWordStart = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') { if (!inDouble) { inComment = false; atWordStart = true; } continue; }
    if (inComment) continue;
    if (ch === '\\') { i += 1; atWordStart = false; continue; }
    if (!inDouble && ch === '#' && atWordStart) { inComment = true; continue; }
    if (!inDouble && ch === "'") { const e = s.indexOf("'", i + 1); if (e === -1) return out; i = e; atWordStart = false; continue; }
    if (ch === '"') { inDouble = !inDouble; atWordStart = false; continue; }
    if (ch === '$' && s[i + 1] === '(') {
      const e = groupEnd(s, i + 1);
      const body = s.slice(i + 2, e === -1 ? s.length : e);
      out.push(body);
      substitutionBodies(body, out);
      if (e === -1) return out;
      i = e;
      continue;
    }
    if (ch === '`') {
      let e = -1;
      for (let j = i + 1; j < s.length; j++) { if (s[j] === '\\') { j += 1; continue; } if (s[j] === '`') { e = j; break; } }
      const body = s.slice(i + 1, e === -1 ? s.length : e).replace(/\\([`$\\])/g, '$1');
      out.push(body);
      substitutionBodies(body, out);
      if (e === -1) return out;
      i = e;
      continue;
    }
    atWordStart = /[\s();&|]/.test(ch);   // bash starts a comment at a `#` that BEGINS a word
  }
  return out;
}

/** The body of a GROUP (`( … )` / `{ … ; }`) that opens at the head of `s`, or null. Pure.
 *  Structural, not positional — that is the r5 F2 fix. `canonicalCommand` peeled a `)` only when it was
 *  the LAST character of the segment, so `(pnpm exec vite build) >/dev/null`, `… 2>/dev/null` and
 *  `… #x` each re-hid a real build behind one trailing token. When the closer is not in this text at all
 *  (the split cut the group in half at a separator inside it) the REMAINDER after the opener is the
 *  body — strictly the same rule, just missing its right edge. */
function leadingGroupBody(s) {
  const t = String(s || '').replace(/^\s+/, '');
  if (t.startsWith('(')) {
    const e = groupEnd(t, 0);
    return e === -1 ? t.slice(1) : t.slice(1, e);
  }
  if (t.startsWith('{') && /\s/.test(t[1] || '')) return t.slice(1);   // `{ …` (bash needs the space)
  return null;
}

/** The command text before a `)` that closes a group opened in an EARLIER segment, or null. Pure.
 *  The other half of the F2 class: when the split cuts a group at a separator inside it, the group's
 *  LAST command keeps the closer glued to its final token — `(gh pr list …; pnpm dlx eleventy) >/dev/null`
 *  reaches the arms as `pnpm dlx eleventy) >/dev/null`, whose exec remainder canonicalizes to the program
 *  word `eleventy)` and matches nothing. Quote-aware, and a BALANCED `( … )` inside the segment (a
 *  substitution, a `func()` header) is not a dangling closer. */
function trailingGroupTail(s) {
  const t = String(s || '');
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\') { i += 1; continue; }
    if (quoteStartsAt(t, i)) { const e = quotedRunEnd(t, i); if (e === -1) return null; i = e; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { if (depth === 0) return t.slice(0, i); depth -= 1; }
  }
  return null;
}

/**
 * Every command line `segment` hands to a shell for RE-EXECUTION. Pure. Four positions, all verified
 * against real bash:
 *   • a command substitution — `$( … )` / `` ` … ` ``, at any depth, including inside `"…"`.
 *   • a leading SUBSHELL group — `( … )`. Matched STRUCTURALLY (to its balanced closer), not
 *     positionally, which is the r5 F2 fix: `canonicalCommand` only peeled a `)` that was the LAST
 *     character of the segment, so any trailing token re-opened the hole — `(pnpm exec vite build)
 *     >/dev/null`, `… 2>/dev/null`, `… #x` all read as safe while bash really built.
 *   • an explicit script STRING — `eval "…"`, and `sh`/`bash`/`zsh`/`dash`/`ksh`/`ash` `-c "…"`.
 *   • the package runner's own `exec`/`dlx`/`--call` remainder — the recursion `isTreeWritingBuildRun`
 *     already did for the build arm, generalized so EVERY arm sees it (`npm exec -c 'git push origin
 *     main'` reached no arm before).
 * Deliberately NOT a shell: no expansion, no `$VAR` resolution — the #2367 accidental-collision threat
 * model. It only reads text that bash will re-parse as a command, which is the coverage r1–r4 lost.
 */
export function nestedCommandStrings(segment) {
  const s = String(segment || '');
  if (!s.trim()) return [];
  const out = substitutionBodies(s);

  const group = leadingGroupBody(s);
  if (group !== null) out.push(group);
  const tail = trailingGroupTail(s);
  if (tail !== null && tail.trim()) out.push(tail);

  const cmd = canonicalCommand(s);
  if (!cmd) return out;
  // …and a group behind a WRAPPER (`time (npm run build)`, `sudo (…)`) — `canonicalCommand` peels the
  // wrapper, so the opener is at the head of what it returns even when it was not at the head of `s`.
  const wrapped = cmd === s ? null : leadingGroupBody(cmd);
  if (wrapped !== null) out.push(wrapped);

  // A leading `VAR=val` prefix is EXPORTED into the environment of the command it prefixes, so the
  // sanctioned escapes (`MAIN_SESSION_BUILD_OK=1`, `MAIN_PUSH_OK=1`, …) really do reach a `-c`/`eval`
  // string — verified: `FOO=1 bash -c 'echo $FOO'` prints 1. Carry the prefix onto the re-executed text,
  // or `MAIN_SESSION_BUILD_OK=1 bash -c "npm run build"` becomes a deny with no way out. Deliberately NOT
  // carried onto a `$( … )` body: bash expands a substitution BEFORE applying the prefix, so it does not
  // see it there (`FOO=1 echo "$(echo $FOO)"` prints empty) — and assuming it did would be a loosening.
  const envPrefix = (s.replace(/^\s+/, '').match(/^(?:env\s+)?((?:[A-Za-z_]\w*=\S*\s+)*)/) || [, ''])[1];
  // The prefix reaches EVERY command in the re-executed string (`FOO=1 sh -c "a && b"` runs both a and b
  // with FOO set), so it is stamped onto each SEGMENT rather than onto the string as a whole.
  const reexec = (text) => {
    if (!String(text).trim()) return;
    if (!envPrefix) { out.push(text); return; }
    for (const seg of parseSegments(text).segments) if (seg.trim()) out.push(envPrefix + seg);
  };
  /** The word as the inner shell RECEIVES it: a `"…"` word has already had `\"`, `\\`, `\$` and ``\` ``
   *  resolved by the outer shell. Skipping that step re-created the very #2994 false deny this PR
   *  removes, one level down: `sh -c "git commit -m \"fix: a | b > c\""` reached the arms with the
   *  backslashes intact, the `|` read as an UNQUOTED separator, and the tail `b > c\"` read as a real
   *  redirect to a non-scratch path. A `'…'` word resolves nothing, so it is passed through verbatim. */
  const asShellSees = (w) => (w.dq ? w.text.replace(/\\(["\\$`])/g, '$1') : w.text);

  const words = headWords(cmd);
  const prog = words.length ? words[0].text : '';
  if (prog === 'eval') {
    // bash concatenates eval's arguments with a space and executes the result.
    reexec(words.slice(1).map(asShellSees).join(' '));
  } else if (SHELL_PROGRAMS.has(prog)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i].text;
      if (SHELL_C_FLAG.test(w)) { if (words[i + 1]) reexec(asShellSees(words[i + 1])); break; }
      if (w.startsWith('-')) continue;
      if (prog === 'busybox' && SHELL_PROGRAMS.has(w)) continue;   // `busybox sh -c '…'`
      break;                                                        // a SCRIPT FILE, not a `-c` string
    }
  } else {
    const inv = runnerInvocation(cmd);
    if (inv && inv.exec) reexec(inv.exec);
  }
  return out;
}

/** `segments` plus every command line they hand to a shell for re-execution, transitively. Pure and
 *  BOUNDED (depth ≤ `NESTED_DEPTH_CAP`, ≤ `NESTED_NODE_CAP` expansions total) so no input can wedge it.
 *  A nested string that does not parse is NOT escalated to the unparseable deny — its segments are still
 *  handed to the arms, so this can only ever ADD coverage, never invent a denial. */
function withNestedCommands(segments, whole) {
  const out = segments.slice();
  let budget = NESTED_NODE_CAP;
  const push = (text, depth) => {
    if (budget <= 0 || depth > NESTED_DEPTH_CAP || !String(text).trim()) return;
    budget -= 1;
    const inner = parseSegments(text).segments;
    out.push(...inner);
    for (const seg of inner) for (const n of nestedCommandStrings(seg)) push(n, depth + 1);
  };
  // The WHOLE command first. A `$( … )` body — and a `( … )` group — may CONTAIN the very separators the
  // segment split just cut on (`echo $(gh pr list; node scripts/gen-inventory.mjs)`), so their contents
  // are not reachable from any single segment; only the unsplit text still has them intact.
  const w = String(whole || '');
  for (const n of substitutionBodies(w)) push(n, 1);
  const g = leadingGroupBody(w);
  if (g !== null) push(g, 1);
  for (const seg of segments) for (const n of nestedCommandStrings(seg)) push(n, 1);
  return out;
}

/** The file OPERANDS of a tokenized argument list — every non-flag token, honouring `--` and the options in
 *  `optsWithArg` (which swallow the token after them, e.g. `sed -e <script>`). Pure. A QUOTED token is never
 *  read as a flag (a quoted `-x` is a filename).
 *  #2986(1) — an EMPTY token is never a file operand either. BSD `sed -i '' <script> <file>` spells its
 *  in-place suffix as an empty quoted argument; counting it as an operand shifted the `files.slice(1)` below
 *  by one, so the sed SCRIPT read as the write target and a scratch-path edit was denied. */
function fileOperands(args, optsWithArg = new Set()) {
  const files = [];
  const push = (t) => { if (t !== '') files.push(t); };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.quoted && a.text === '--') { for (const t of args.slice(i + 1)) push(t.text); break; }
    if (!a.quoted && a.text.length > 1 && a.text.startsWith('-')) {
      if (optsWithArg.has(a.text)) i += 1;
      continue;
    }
    push(a.text);
  }
  return files;
}

/** sed's `w` write mechanism embedded in the SCRIPT TEXT itself — no `-i`/`--in-place` needed. Two shapes:
 *  a trailing `w <file>` flag on an `s///` command (`s/x/y/w file`, `s/x/y/gw file`), and a standalone
 *  address-command (`/pat/w file`, `3,5w file`) with no `s` at all. Either way sed opens `<file>` and writes
 *  to it on a match — a real write the flag-only scan above (in-place / tee operands) never looks at, because
 *  it only inspects ARGV flags, never the script TEXT. Command boundaries include blocks and semicolons;
 *  this is a conservative write scan, not a full sed parser. */
// #2108 review r4 — the two lazy groups MUST be disjoint: `(?:\\.|(?!\1).)` let a backslash match BOTH branches, so
// a run of N escapes backtracked ~Fibonacci(N) ways (n=40 took seconds, n=48 half a minute) in a hook that runs
// on every sed segment. `[^\\]` in the second branch makes each backslash consumable exactly one way.
// #2108 review r6 — an `s` COMMAND never follows a letter (`;s`, `{s`, ` s`, `1s`, `/x/s`, `!s`), so a start
// inside a run of letters (`sssss…`, `sasasa…`) is not one: without this lookbehind every `s` of such a run was a
// start that rescanned the rest of the run for flags (quadratic). The one letter that may precede it is an
// address flag (`/x/Is/a/b/w f`, `/x/Ms/…`), allowed explicitly.
// The flag run is only sed's real `s` flags (g p i I m M N): a wider `[a-zA-Z0-9]*` let a digit-delimited run
// (`s1s1s1…`) rescan the rest of the run from every start; `s` is not a flag, so a flag scan now ends at the next one.
const SED_SUB_START = String.raw`(?:(?<![A-Za-z])|(?<=\/[IM]{1,2}))s`;
const SED_SUB_W = new RegExp(String.raw`${SED_SUB_START}(.)(?:\\.|(?!\1)[^\\])*?\1(?:\\.|(?!\1)[^\\])*?\1[gpiImM0-9]*w[ \t]+(\S.*)$`);
const SED_SUB_E = new RegExp(String.raw`${SED_SUB_START}(.)(?:\\.|(?!\1)[^\\])*?\1(?:\\.|(?!\1)[^\\])*?\1[gpiImM0-9]*e`);
// #2108 review r3 — the address form also writes via a NEGATED address (`/pat/!w file`, `3,5!w file`),
// via GNU's `first~step` extension (`0~3w file`), and via the uppercase `W` command (writes only the
// pattern space's FIRST line, GNU sed) — none of which the original lowercase-only, negation-blind regex
// recognized, so a real write through any of those three shapes silently bypassed the guard.
const SED_ADDRESS = String.raw`(?:\$|\d+(?:~\d+)?|\/(?:\\.|[^\/\\])*\/[IM]*)`;
// #2108 review r6 — optional addresses/negation own their trailing spaces, avoiding cubic whitespace splits.
const SED_ADDR_W = new RegExp(String.raw`(?:^|[;{])[ \t]*(?:${SED_ADDRESS}(?:[ \t]*,[ \t]*(?:${SED_ADDRESS}|[+~]\d+))?[ \t]*)?(?:![ \t]*)?[wW][ \t]+(\S.*)$`);

const SED_EXEC = new RegExp(String.raw`(?:^|[;{}\s])(?:${SED_ADDRESS}(?:[ \t]*,[ \t]*(?:${SED_ADDRESS}|[+~]\d+))?)?!?e[ \t]+\S`);

/** The file(s) one sed SCRIPT TEXT writes via an embedded `w` — see `SED_SUB_W`/`SED_ADDR_W` above. Pure.
 *  Scanned per PHYSICAL LINE (`-e` script fragments join on `\n`, same as sed itself reads them) since `w`
 *  consumes the rest of its line as the filename, so a later command on the SAME line can never be its own
 *  match target. */
function sedWriteTargets(scriptText) {
  const out = [];
  for (const line of String(scriptText).split('\n')) {
    // group 1 of SED_SUB_W is the `s///` DELIMITER (`\1` backreferences need it captured); the filename is
    // group 2 — `sub[1]` would silently push the delimiter character itself as the "target" instead.
    const sub = line.match(SED_SUB_W);
    if (sub) out.push(sub[2].trim());
    const addr = line.match(SED_ADDR_W);
    if (addr) out.push(addr[1].trim());
  }
  return out;
}

/** A backlog|reports `.md` path, captured, for the fail-closed script-text scans below. */
const CORPUS_PATH = String.raw`((?:\.\/)?(?:backlog|reports)\/[^\s'")]*\.md)`;
/** Loose mention (no `.md` needed) — perl can build the path by concatenation (`"backlog/"."x.md"`). */
const CORPUS_MENTION = /(?:^|[^A-Za-z0-9_])(?:backlog|reports)\//;
// #2108 review r4/r5 — FAIL CLOSED on sed script writes. The `s///e` case additionally
// treats corpus operands as executable shell input even without `-i`. The structured `SED_SUB_W`/`SED_ADDR_W` scan above cannot cover sed's whole grammar
// (custom-delimiter addresses `\,a,w file`, a `[/]` bracket holding the delimiter, `s///gw`, the `e` command,
// an address flag, …), so ALSO treat the script as writing a corpus path when the script text itself has
// (1) a `w`/`W` command or `s///…w` flag right before a corpus path — the `w` may follow any non-letter (an
// address end, `;`, `{`, `,`, `/`) or an `s` flag letter — or (2) a shell redirect into a corpus path (what
// the `e` command / `s///e` executes: `e echo hi > backlog/a.md`). A purely read-only mention (`s/backlog\/x.md/y/`,
// `/backlog\/x.md/p`) has neither, so it stays allowed.
const SED_W_FAILCLOSED = new RegExp(String.raw`(?:^|[^A-Za-z_]|(?<=[gpIiMmeE]))[wW][ \t]*${CORPUS_PATH}`, 'g');
const SHELL_REDIRECT_CORPUS = new RegExp(String.raw`>>?[ \t]*${CORPUS_PATH}`, 'g');

/** Corpus paths a sed script names in a WRITE position, found by the fail-closed text scan above. Pure. */
function sedFailClosedTargets(scriptText) {
  const s = String(scriptText);
  const out = [...s.matchAll(SED_W_FAILCLOSED), ...s.matchAll(SHELL_REDIRECT_CORPUS)].map((m) => m[1]);
  if (CORPUS_MENTION.test(s) && s.split('\n').some((line) => SED_EXEC.test(line) || SED_SUB_E.test(line))) {
    out.push(corpusTarget(s));
  }
  return out;
}

/** Perl write primitives whose target is NOT a quoted-literal `open()` path: `rename`/`copy`/`cp`/`move`/`mv`
 *  (File::Copy / File::Slurp / Path::Tiny / File::Copy::Recursive), `write_file`/`spew`/`append_file`,
 *  and `system`/`exec`/`qx`/backticks running a mutating command. */
// A builtin name only counts as a CALL: not glued to a regex/quote/sigil (`/rename/`, `"unlink"`, `$link`), so a
// read-only `perl -ne 'print if /rename/' backlog/x.md` (a backlog doc that discusses renames) stays allowed.
const PERL_MUTATING = /\$\^I|\$INPLACE_EDIT\b|(?<![/\w"'.\-$@%])\b(?:unlink|chmod|chown|truncate|sysopen|utime|rename|syswrite|link|symlink)\b(?=\s*[(\w$@"'])/;
const PERL_WRITE_PRIMITIVE = new RegExp(PERL_MUTATING.source + String.raw`|\b(?:copy|cp|move|mv|write_file|append_file|spew)\b|\b(?:system|exec|qx)\b[^;]*?\b(?:cp|mv|tee|dd|install|ln|rsync|truncate|touch)\b|` + '`[^`]*\\b(?:cp|mv|tee|dd|install|ln|rsync|truncate|touch)\\b');
/** Literal script-text opens retain implicit read-mode compatibility; argv-fed opens fail closed. */
const PERL_WRITE_OPEN = /\bopen\b[^;]*?["']\s*\+?>/;
const PERL_OPEN_WORD = /\bopen\b/g;
// Only an explicit second-argument read mode proves an open read-only. Anchor the scan to each
// open and bound it by the next open/semicolon, avoiding repeated scans of overlapping suffixes.
const PERL_READ_OPEN = /^\s*(?:\(\s*)?(?:my\s+)?\$?[A-Za-z0-9_]+\s*,\s*(["'])\s*<(?::[^"'|\s]+)?\s*\1\s*[,)]/;
const PERL_OPEN_STRING = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;
// #2108 review r6 — corpus mentions need a read-only vocabulary; a write deny-list cannot cover arbitrary calls.
const PERL_READ_ONLY = new Set(`print say printf open close eof while until if unless else elsif for foreach
  my our local chomp chop lc uc lcfirst ucfirst length index substr split join map grep sort reverse keys values
  scalar defined exists last next return sprintf and or not eq ne lt gt le ge cmp x`.split(/\s+/));
function perlHasUnknownCode(script) {
  const code = script.replace(PERL_OPEN_STRING, (literal) =>
    literal.startsWith('"') && ['@{', '${\\', '$('].some((marker) => literal.includes(marker)) ? literal : ' ');
  for (const [identifier] of code.matchAll(/(?<![$@%\w])[A-Za-z_]\w*(?:::\w+)*/g)) {
    if (!PERL_READ_ONLY.has(identifier) && !/^[A-Z][A-Z0-9_]*$/.test(identifier)) return true;
  }
  return false;
}
function perlMutates(script, pipeOnly = false) {
  if (!pipeOnly && PERL_MUTATING.test(script)) return true;
  const opens = [...script.matchAll(PERL_OPEN_WORD)];
  for (let i = 0; i < opens.length; i++) {
    const start = opens[i].index + opens[i][0].length;
    const statement = script.slice(start, opens[i + 1]?.index ?? script.length).split(';', 1)[0];
    if (!pipeOnly && !PERL_READ_OPEN.test(statement)) return true;
    if ([...statement.matchAll(PERL_OPEN_STRING)].some((m) => m[0].includes('|'))) return true;
  }
  return false;
}
function corpusTarget(s) {
  return s.match(new RegExp(CORPUS_PATH))?.[1] || `${s.match(/(backlog|reports)\//)[1]}/computed-path.md`;
}

/** Corpus paths a perl script writes by a route `perlWriteTargets` cannot parse. Fail closed: the script
 *  text itself must MENTION a corpus path and pass every write check plus the read-only vocabulary.
 *  Computed/variable-held writes are caught; a read-only `open(F,"<","backlog/x.md")` or a bare
 *  `print "backlog/x.md"` remains allowed. Pure. */
function perlFailClosedTargets(scriptText) {
  const s = String(scriptText);
  if (!CORPUS_MENTION.test(s)) return [];
  const redirects = [...s.matchAll(SHELL_REDIRECT_CORPUS)].map((m) => m[1]);
  if (redirects.length) return redirects;
  if (PERL_WRITE_PRIMITIVE.test(s) || PERL_WRITE_OPEN.test(s) || perlMutates(s, true) || perlHasUnknownCode(s)) {
    const named = s.match(new RegExp(CORPUS_PATH));
    // A computed path (`"backlog/"."x.md"`) has no literal `.md` name to return; report the corpus dir it
    // mentions with a placeholder leaf so the deny arm's CORPUS_MD test still sees a corpus write.
    return [named ? named[1] : `${s.match(/(backlog|reports)\//)[1]}/computed-path.md`];
  }
  return [];
}

/** 3-arg perl open: open(FH, MODE, PATH) or open FH, MODE, PATH, where MODE is a quoted literal starting
 *  with `>`, `>>`, `+>`, `+>>`, or `+<` (optionally with an encoding layer like `>:utf8`), PATH a quoted literal. */
const PERL_OPEN_3ARG = /\bopen\s*(?:\(\s*)?(?:my\s+)?\$?[A-Za-z0-9_]+\s*,\s*(["'])\s*(\+>>|\+>|\+<|>>|>)(?::\S+)?\s*\1\s*,\s*(["'])([^$]*?)\3/g;
/** 2-arg perl open: open(FH, ">path") / open(FH, ">>path") / open FH, ">> path". Strip leading spaces after mode. */
// #2108 review r6 — consume leading path whitespace once, rather than retrying it inside an unterminated path.
const PERL_OPEN_2ARG = /\bopen\s*(?:\(\s*)?(?:my\s+)?\$?[A-Za-z0-9_]+\s*,\s*(["'])\s*(\+>>|\+>|\+<|>>|>)\s*(?!\s)([^$]*?)\1/g;

/** The string-literal file path(s) a Perl script writes via `open(...)`. Pure.
 *  Handles 3-arg open(FH, MODE, PATH) and 2-arg open(FH, ">path").
 *  Only literal paths can be returned; a path from a variable (`$f`), computed paths, or other write primitives
 *  are out of scope as a known limit. Read modes (`<`, no mode, `-|`) and prints without write opens return nothing. */
function perlWriteTargets(scriptText) {
  const out = [];
  const s = String(scriptText);
  for (const m of s.matchAll(PERL_OPEN_3ARG)) {
    const path = m[4].trim();
    if (path) out.push(path);
  }
  for (const m of s.matchAll(PERL_OPEN_2ARG)) {
    // If followed by a comma after the closing quote, it was the MODE of a 3-arg open, not a 2-arg open.
    const afterQuote = s.slice(m.index + m[0].length).trimStart();
    if (afterQuote.startsWith(',')) continue;
    const path = m[3].trim();
    if (path) out.push(path);
  }
  return out;
}

/** Parse editor options once: argument-taking letters own the rest of a cluster, and `i`
 * owns its backup suffix. Quoted words and words after `--` are operands; empty BSD suffixes
 * are skipped. Script files are recorded but never read by the guard. */
// #2108 review r6 — GNU long options accept only unambiguous prefixes, including argument-taking options.
const SED_LONG_OPTIONS = `binary debug expression file follow-symlinks help in-place line-length null-data
  zero-terminated posix quiet regexp-extended sandbox separate silent unbuffered version`.split(/\s+/);
function editorOperands(args, prog) {
  const files = [], texts = [];
  const perl = prog === 'perl';
  const scriptLetters = perl ? 'eE' : 'ef';
  const argTaking = perl ? 'eEIMmFxCVdD' : 'efl';
  let scriptFromFlag = false, stdinScript = false, inPlace = false, endFlags = false, varFlags = false;
  const scriptArg = (letter, value) => {
    scriptFromFlag = true;
    if (!perl && letter === 'f') stdinScript ||= value === '-' || value === '/dev/stdin';
    else if (value !== undefined) texts.push(value);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], word = a.text;
    if (!endFlags && !a.quoted && word === '--') { endFlags = true; continue; }
    if (!endFlags && !a.quoted && word.startsWith('-') && word.length > 1) {
      if (word.startsWith('--')) {
        const eq = word.indexOf('=');
        const flag = eq < 0 ? word : word.slice(0, eq);
        varFlags ||= /[$`]/.test(flag);
        const matches = perl ? [] : SED_LONG_OPTIONS.filter((option) => option.startsWith(flag.slice(2)));
        const name = matches.length === 1 ? `--${matches[0]}` : flag;
        if (!perl && (name === '--expression' || name === '--file')) {
          scriptArg(name === '--file' ? 'f' : 'e', eq < 0 ? args[++i]?.text : word.slice(eq + 1));
        } else if (!perl && name === '--line-length' && eq < 0) i += 1;
        else if (!perl && name === '--in-place') inPlace = true;
        continue;
      }
      for (let j = 1; j < word.length; j++) {
        const ch = word[j];
        varFlags ||= ch === '$' || ch === '`';
        if (ch === 'i') { inPlace = true; break; }
        if (!argTaking.includes(ch)) continue;
        let value = word.slice(j + 1);
        if (!value && (scriptLetters.includes(ch) || (perl && ch === 'I') || (!perl && ch === 'l'))) value = args[++i]?.text;
        if (scriptLetters.includes(ch)) scriptArg(ch, value);
        break;
      }
      continue;
    }
    if (word !== '') {
      // #2108 review r6 — unresolved operand expansions may supply flags; literal quoted scripts remain readable.
      varFlags ||= /[$`]/.test(word) && (!a.quoted || /^(?:\$\{[^}]+\}|\$[A-Za-z_]\w+|\$\(.*\))$/.test(word));
      files.push(word);
    }
  }
  return { files, texts, scriptFromFlag, stdinScript, inPlace, varFlags };
}

function perlScriptTexts(editor) { return editor.texts; }
function sedScriptTexts(editor) {
  return editor.scriptFromFlag ? editor.texts : editor.files.slice(0, 1);
}

/** EVERY file path `segment` writes via a shell redirect / `tee` / an in-place editor (`sed -i`, `perl -pi`),
 *  scratch paths INCLUDED. Pure.
 *
 *  #3311 — extracted verbatim out of `isFileWriteRedirect`, which is now a thin `.some(non-scratch)` over
 *  this list, so the #2749 arm's behaviour is unchanged by construction. It is a separate function because
 *  the two callers disagree about `/tmp` for opposite-but-both-correct reasons:
 *    • `isFileWriteRedirect` (the primary-tree-write deny) EXCLUDES scratch — a `/tmp` write is not a write
 *      to the shared checkout, which is the only thing that arm is about;
 *    • `collateralStepsNotice` (the dropped-step notice) INCLUDES it — the write whose loss cost a whole
 *      session three incidents in one day was `cat > /tmp/pr-body.md <<'EOF'`. Scratch-ness says nothing
 *      about whether the caller will notice the file is missing; if anything a `/tmp` file is LESS likely to
 *      be noticed, because nothing downstream is watching it.
 *  So the scratch filter belongs at the CALL SITE, not in the path scan. */
export function fileWriteTargets(segment) {
  // Keep every existing target, and add the canonical command view used by reason().
  // This unwraps shell groups; resolved option words also recognize glued empty quotes
  // (`-i''` / `-i""`). Quoting does not stop sed/perl from interpreting an argv option.
  return [...new Set([
    rawFileWriteTargets(segment),
    rawFileWriteTargets(canonicalCommand(segment), true),
  ].flat())];
}

function rawFileWriteTargets(segment, resolvedOptions = false) {
  const out = [];
  const toks = shellTokens(segment);
  if (!toks.length) return out;
  // Peel the same wrapper prefix the other arms peel (`env sed -i …` must not slip past). A quoted word or a
  // redirect operator can never BE a wrapper, so blank those out before measuring the prefix.
  const rest = toks.slice(wrapperPrefixLength(toks.map((t) => (t.op || t.quoted ? ' ' : t.text))));
  if (!rest.length) return out;

  // 1) A WRITE redirect ANYWHERE in the segment (not just at its end) — `>`, `>>`, `>|`, `&>`, `2> file`.
  //    An operator ending in `&` duplicates an fd (`2>&1`, `>&2`) and writes no file.
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!t.op || !t.text.includes('>') || t.text.endsWith('&')) continue;
    const target = rest[i + 1];
    if (target && !target.op) out.push(target.text);
  }

  // 2) An in-place editor / `tee` — every file operand, in any flag spelling.
  const prog = rest[0].quoted ? '' : rest[0].text.replace(/^.*\//, '');
  const args = [];
  for (let i = 1; i < rest.length; i++) {
    if (rest[i].op) { i += 1; continue; }                          // skip the operator AND its target
    const arg = rest[i];
    args.push(resolvedOptions && arg.text.startsWith('-') ? { ...arg, quoted: false } : arg);
  }
  const editor = ['sed', 'gsed', 'perl'].includes(prog) ? editorOperands(args, prog) : null;
  if (editor?.varFlags) out.push(...editor.files.filter((f) => CORPUS_MENTION.test(f)).map(corpusTarget));
  if (editor?.inPlace) {
    out.push(...(editor.scriptFromFlag ? editor.files : editor.files.slice(1)));
  }
  // A security review on #2108 found the block above blind to sed's OTHER write mechanism: a `w` write
  // embedded in the SCRIPT TEXT (a trailing `s///w file` flag, or a standalone `/addr/w file` command) needs
  // NO `-i`/`--in-place` — `sed 's/x/y/w backlog/x.md' file` and `sed -n '/pat/w backlog/x.md' file` both
  // genuinely write `backlog/x.md` with no in-place flag anywhere, so the `inPlace`-gated scan above (which
  // only ever reads ARGV FLAGS) misses both entirely. This runs unconditionally — not gated on `inPlace` —
  // and scans the actual script TEXT via `sedScriptTexts`/`sedWriteTargets` above. Similarly, perl `open()`-with-a-write-mode
  // literal path is detected via `perlScriptTexts`/`perlWriteTargets`, with conservative fail-closed scans.
  // KNOWN LIMITS: script files (`sed -f file`, `perl file.ext`) and paths assembled entirely at runtime
  // are not statically decidable. Perl .pl/.pm/.t scripts with corpus argv fail closed; other script-file
  // extensions remain an accepted limit, as do external sed scripts.
  if (prog === 'sed' || prog === 'gsed') {
    const scripts = [...sedScriptTexts(editor)];
    if (editor.stdinScript) {
      for (let i = 0; i < rest.length - 1; i++) {
        if (rest[i].op && rest[i].text === '<<<' && !rest[i + 1].op) scripts.push(rest[i + 1].text);
      }
    }
    for (const script of scripts) {
      out.push(...sedWriteTargets(script), ...sedFailClosedTargets(script));
      if (script.split('\n').some((line) => SED_SUB_E.test(line))) {
        out.push(...editor.files.filter((file) => CORPUS_MENTION.test(file)).map(corpusTarget));
      }
    }
  }
  if (prog === 'perl') {
    const scripts = perlScriptTexts(editor);
    for (const script of scripts) out.push(...perlWriteTargets(script), ...perlFailClosedTargets(script));
    if (scripts.some((script) => perlMutates(script))) out.push(...editor.files.filter((file) => CORPUS_MENTION.test(file)).map(corpusTarget));
    // #2108 review r6 — stdin scripts are as opaque as script files (heredoc bodies are not scanned).
    if (!scripts.length && !CORPUS_MENTION.test(editor.files[0] || '') && (editor.files[0] === '-' || /\.(?:pl|pm|t)$/i.test(editor.files[0] || ''))) {
      out.push(...editor.files.slice(1).filter((file) => CORPUS_MENTION.test(file)).map(corpusTarget));
    }
  }
  // GNU tee: neither `-p` nor `--output-error[=MODE]` takes a SEPARATE argument (the mode is `=`-attached), so
  // no flag swallows the next word — treating `-p` as arg-taking dropped the first real file operand.
  if (prog === 'tee') out.push(...fileOperands(args));
  return out;
}

/** Is `segment` a shell redirect/`tee`/`sed -i`/`perl -pi` that writes a file OTHER than a `/tmp`|`/dev`
 *  scratch path? Pure. Fires if ANY written path is non-scratch (never one argument as a proxy). */
export function isFileWriteRedirect(segment) {
  return fileWriteTargets(segment).some((f) => !isScratch(f));
}

/** A backlog|reports `.md` file as a WRITE TARGET — relative (`backlog/x.md`, `./reports/y.md`) or absolute
 *  (`/…/lane-3/backlog/x.md`). Anchored on a path boundary so `mybacklog/x.md` is not a card. */
const CORPUS_FILE_TARGET = /(?:^|\/)(?:backlog|reports)\/[^'")]*\.md$/;
const COPY_PROGRAMS = new Set(['cp', 'gcp', 'install', 'ginstall', 'mv', 'gmv']);

/** Lexical only: a trailing slash or the corpus directory itself identifies a directory.
 * Bare nested directories need filesystem knowledge and remain outside this detector. */
function copyDestinationTargets(sources, destination) {
  const dest = unquote(destination);
  const directory = /\/$/.test(dest) || /(?:^|\/)(?:backlog|reports)$/.test(dest);
  return directory
    ? sources.map((source) => `${dest.replace(/\/+$/, '')}/${unquote(source).replace(/^.*\//, '')}`)
    : [dest];
}

/** #4070 — every backlog|reports `.md` path `segment` OVERWRITES from the shell, scratch excluded. Pure.
 *  The `>>`/`tee`/`sed -i`/`perl -pi` arm in `reason()` already covered appends and in-place edits; a
 *  TRUNCATING write slipped past it, and a truncating write is the one that replaces a card wholesale:
 *    • any write redirect — `cat > backlog/x.md <<'EOF'`, `echo … > backlog/x.md`, `>|`, `&>`, `1>`;
 *    • `cp`/`install` with a corpus destination (the LAST operand), and `mv` onto a corpus path FROM a
 *      non-corpus source (a same-number `mv` between two corpus paths is a slug rename; the renumber arm owns
 *      those).
 *  Every one of these skips the Edit/Write hooks (`backlog-guard.mjs`, `lint-locus-prefix.mjs`) that would
 *  have validated the new content. KNOWN LIMIT: an interpreter writing through its own file API
 *  (`python -c "open(…,'w')"`, `node -e "fs.writeFileSync(…)"`) or a `-t <dir>` copy is not parsed here. */
export function corpusOverwriteTargets(segment) {
  const out = fileWriteTargets(segment).filter((f) => CORPUS_FILE_TARGET.test(unquote(f)) && !isScratch(f));
  const toks = shellTokens(canonicalCommand(segment));
  const rest = toks.slice(wrapperPrefixLength(toks.map((t) => (t.op || t.quoted ? ' ' : t.text))));
  const prog = rest[0] && !rest[0].quoted && !rest[0].op ? rest[0].text.replace(/^.*\//, '') : '';
  if (COPY_PROGRAMS.has(prog)) {
    const args = [];
    for (let i = 1; i < rest.length; i++) {
      if (rest[i].op) { i += 1; continue; }                          // a redirect and its target: handled above
      args.push(rest[i]);
    }
    const files = fileOperands(args, new Set(['-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']));
    const sources = files.slice(0, -1);
    const fromOutside = sources.some((f) => !CORPUS_FILE_TARGET.test(unquote(f)));
    if (files.length >= 2 && (!prog.endsWith('mv') || fromOutside)) {
      out.push(...copyDestinationTargets(sources, files[files.length - 1])
        .filter((dest) => CORPUS_FILE_TARGET.test(dest) && !isScratch(dest)));
    }
  }
  return [...new Set(out)];
}

/** The #2749 hard-tree-write deny reason for `segment` at a PRIMARY cwd, or null. Pure. Checked ONLY when
 *  `primaryCwd` is true (callers gate it); the `MAIN_SESSION_BUILD_OK=1` escape is checked by the caller
 *  (`reason()`), mirroring `MAIN_PUSH_OK`/`LANE_CLOBBER_OK`. */
export function primaryTreeWriteReason(segment) {
  const s = String(segment || '');
  // #2788 review r3 finding 7 — every message must name the ACTUAL remedy. This arm reads the cwd the command
  // will run in, and the harness resets the reported cwd to the primary between calls (#2335), so an agent
  // ALREADY in a lane trips it whenever it omits the `cd`. "Delegate to a lane clone" is useless advice to
  // that caller; the fix is to make the lane cwd explicit, which `resolveEffectiveCwd` then honours.
  const RUN_IN_LANE = 'Run it with the lane cwd made EXPLICIT — `cd <lane-path> && <cmd>` (a leading `cd` is what this guard resolves, #2335); if you have no lane, acquire one (`node scripts/lane-pool.mjs acquire`). Sanctioned override (rare): prefix `MAIN_SESSION_BUILD_OK=1`.';
  if (isTreeWritingBuildRun(s))
    return 'a build that WRITES the shared PRIMARY tree is blocked at primary cwd (#2749/#2788) — `npm run build`/`build:docs`/`build:demo` (and the `vite build`/`eleventy` they delegate to) emits into the tree (dist/_site) at the shared checkout. ' + RUN_IN_LANE;
  if (isGeneratorScriptRun(s))
    return 'an fs-writing generator/scaffold script is blocked at primary cwd (#2749/#2788) — a `node` script writes the tree via `fs`, slipping past the Edit/Write-tool guard (guard-lane.mjs) entirely. ' + RUN_IN_LANE;
  if (isFileWriteRedirect(s))
    return 'a shell redirect/`tee`/`sed -i`/`perl -pi` writing a file is blocked at primary cwd (#2749/#2788) — it writes the shared PRIMARY tree directly, bypassing the Edit/Write tools. Write scratch files under `/tmp` instead. ' + RUN_IN_LANE;
  return null;
}

// ── #xpt9fvd — DAEMON CLONE write protection ───────────────────────────────────────────────────────────────
//
// A resident daemon's OWN dedicated clone (wev-review-daemon, wev-merge-daemon, wev-health-watch, the drain's
// clone(s), …; the live registry is `daemon-clone-registry.mjs#daemonCloneRoots`) gets the SAME "no direct
// write" protection the PRIMARY-tree arm above gives a constellation checkout — see that module's header for
// why a hand-edit here is worse than a primary edit (it silently BLOCKS the daemon's own next rebuild until a
// person notices, #xpt9fvd; caught+reverted 3x on 2026-09-26).

/** git's `-C <path>` global-flag value, resolved against `cwd` — the effective directory a git invocation
 *  targets when it is NOT simply `cwd` itself (`git -C wev-review-daemon log` reads/writes that clone from
 *  wherever the shell actually sits). Pure — string-only, no fs. Returns `null` when `segment` is not a git
 *  invocation or carries no `-C`, so the caller falls back to `cwd`. Reads the SAME wrapper-peeled,
 *  basename-resolved `canonicalCommand` view `gitSubcommand` does, so a path-qualified/wrapped git
 *  (`/usr/bin/git -C … log`, `env git -C … log`) still resolves.
 *  KNOWN RESIDUAL: git allows REPEATED `-C` (each one relative to the previous); only the first is honoured
 *  here. Every daemon-clone-diagnosis shape this guard has ever seen (`git -C <clone> log`) is a single `-C`,
 *  so this is a documented simplification, not a hole any live shape has hit. */
function gitDashCTarget(segment, cwd) {
  const toks = shellTokens(canonicalCommand(segment)).filter((t) => !t.op);
  if (!toks.length || toks[0].text !== 'git') return null;
  for (let i = 1; i < toks.length - 1; i++) {
    if (toks[i].text === '-C') return resolve(cwd || '.', toks[i + 1].text);
  }
  return null;
}

/** The deny message for a write inside daemon clone `dir`. A plain function (not a template literal alone) so
 *  both call sites below — the git-subcommand arm and the FS-write arm — share one wording. */
function daemonCloneWriteMessage(dir) {
  return (
    `a write inside a DAEMON CLONE ("${dir}", a resident daemon's own dedicated checkout — rebuilt by the ` +
    `daemon itself, never by hand, #xpt9fvd) is blocked. This goes over the daemon's next rebuild invisibly, ` +
    `and a dirty clone BLOCKS that rebuild (its own live-smoke gate refuses to run over an unexpected local ` +
    `diff) until a person notices and reverts it by hand — caught+reverted 3x on 2026-09-26 before this guard ` +
    `existed. Land the change the sanctioned way instead: work it in a LANE, then push it live early:\n` +
    `  node scripts/daemon-overlay.mjs add --clone=${dir} --ref=<your lane branch> [--pr=<n>]\n` +
    `Or \`node scripts/lib/daemon-rebuild.mjs\` / \`node scripts/lib/daemon-load-overlay.mjs --clone=${dir}\` — ` +
    `both run from a LANE, targeting the clone by \`--clone=\`, never with cwd inside the clone itself and ` +
    `never via a direct git mutation on it. A read-only command (\`git -C ${dir} log\`, \`cat\`) and ` +
    `\`git fetch\` (diagnosis only — it never touches the working tree) are unaffected.`
  );
}

/**
 * The #xpt9fvd daemon-clone deny reason for `segment`, or null. Pure — reads only `cwd` (the caller's
 * already-resolved effective directory; #2335's `resolveEffectiveCwd` honours a leading `cd`, same as every
 * other cwd-gated arm in this file) and `roots` (the CLI-collected daemon-clone registry), both injected by
 * the CLI wrapper exactly like `primaryCwd`/`foreignLiveLease` above — this function does no fs I/O itself.
 *
 * TWO SHAPES, both real 2026-09-26 incidents:
 *   1. a git STATE-MUTATING subcommand (`GIT_STATE_SUBCOMMANDS`, minus `fetch`) whose EFFECTIVE directory —
 *      its own `-C <path>` if it has one, else `cwd` — resolves inside a daemon clone: `git reset`/
 *      `checkout`/`commit`/… run either with cwd already inside the clone, or from anywhere via
 *      `git -C <clone-path> reset --hard`.
 *   2. a non-git write — a shell redirect/`tee`/`sed -i`/`perl -pi` (`isFileWriteRedirect`, reused verbatim
 *      from the primary-tree arm above) or an FS-mutating program (`FS_MUTATING_PROGRAMS`: `cp`/`mv`/`rm`/…)
 *      — run with `cwd` already inside a daemon clone.
 *
 * `git fetch` IS ALLOWED — explicitly excluded from the deny set, checked before the daemon-directory test so
 * it is allowed EVEN WHEN targeting a daemon clone by `-C`/cwd. It only updates remote-tracking refs, never
 * the working tree or the index, so it cannot dirty a clone or race its rebuild — exactly the read-only
 * "diagnose from outside" shape the card asks to keep open. Every OTHER `GIT_STATE_SUBCOMMANDS` entry
 * (including `pull`, which fetches AND merges into the working tree) is denied. A pure READ op (`log`/
 * `status`/`diff`/`show`/`rev-parse`/…) is never in scope at all: `gitSubcommand` still returns it, but this
 * function only denies subcommands present in `GIT_STATE_SUBCOMMANDS`, so `git -C <clone> log` and `cat`
 * never match either arm below and pass through unmentioned.
 *
 * A non-git write resolves EVERY operand it can find (the redirect/tee/sed-i/perl-pi targets `fileWriteTargets`
 * already extracts, or an FS-mutating program's plain file operands) against `cwd` and denies if ANY lands in
 * a daemon clone — so both an ambient cwd already inside one (`cd wev-review-daemon && rm x`) and an outside
 * cwd naming one explicitly (`cp x /…/wev-review-daemon/y` run from a lane) are caught. Falls back to the
 * ambient-cwd test alone when no operand is found at all (e.g. a bare `rm` with nothing to resolve).
 */
export function daemonCloneWriteReason(segment, { cwd = null, roots = [] } = {}) {
  if (!roots.length) return null;
  const s = String(segment || '');
  const sub = gitSubcommand(s);
  if (sub) {
    if (sub === 'fetch') return null; // #xpt9fvd — diagnosis stays allowed; fetch never touches the working tree
    if (!GIT_STATE_SUBCOMMANDS.has(sub)) return null; // a read op (log/status/diff/show/…) — never denied
    const effectiveDir = gitDashCTarget(s, cwd) || cwd;
    return isDaemonCloneRealpath(effectiveDir, roots) ? daemonCloneWriteMessage(effectiveDir) : null;
  }
  const prog = programWord(s);
  const isWrite = isFileWriteRedirect(s);
  const isFsMutate = FS_MUTATING_PROGRAMS.has(prog);
  if (!isWrite && !isFsMutate) return null;
  const targets = isWrite
    ? fileWriteTargets(s)
    : fileOperands(shellTokens(canonicalCommand(s)).filter((t) => !t.op).slice(1));
  if (!targets.length) return isDaemonCloneRealpath(cwd, roots) ? daemonCloneWriteMessage(cwd) : null;
  for (const t of targets) {
    const abs = resolve(cwd || '.', t);
    if (isDaemonCloneRealpath(abs, roots)) return daemonCloneWriteMessage(abs);
  }
  return null;
}

/** The #2749 WARN-only nudge for the un-script-decidable "this session should have delegated mechanical
 *  work" half — never denies (a hard-deny here would false-wedge a delegated subagent whose bare verify
 *  reports primary cwd, #2335/#2677). Fires when a verification-set command (`test:unit`/`check:standards`/
 *  `verify-lane`, reusing `isVerificationRun`) runs at a PRIMARY cwd: it writes no tree (so
 *  `primaryTreeWriteReason` above doesn't catch it), but is exactly the mechanical work #2677 argues the main
 *  session should delegate to a lane. Pure + independent of `decide`/`reason` — never feeds the deny channel;
 *  the CLI writes the result to stderr only. */
export function mainSessionDelegateNudge(command, { primaryCwd = false } = {}) {
  if (!primaryCwd) return null;
  if (!isVerificationRun(String(command || ''))) return null;
  return "you're running mechanical verification work (test:unit/check:standards/verify-lane) from the PRIMARY checkout — the conveyor's main session should delegate mechanical work to a lane subagent (#2677). This is a WARN, not a denial (there's no reliable way to tell a delegated subagent's own primary-reporting verify apart from the main session's own laziness, #2335) — if this really is a delegated subagent's verify, ignore it.";
}

// ── #x36vidg — AGENT WAIT-POLLING ──────────────────────────────────────────────────────────────────────────
// Measured over ~600 transcripts (2026-09-24 10:23 ET → 09-25): two wait shapes cost ~17h of pure idle.
//   1. PR/CI poll — a sleep loop around `gh pr view … state|labels|mergedAt`, `gh pr checks`, `statusCheckRollup`,
//      `gh api …/check-runs`, `gh run list/watch` (or a blocking `gh pr checks --watch` / `gh run watch`). The
//      drain daemon is the SOLE merger and pr-watch / the conveyor observe merge+CI; a worker reports and exits.
//   2. Background-output poll — a sleep loop over the agent's OWN `tasks/<id>.output` (or a `subagents/*.jsonl`
//      transcript), almost always because a >2-min gating command was auto-backgrounded at the Bash default.
// SCOPE: DENY only in an AGENT session — a subagent (`agent_id` on the hook payload, the documented subagent
// marker `guard-monitor-subagent.mjs` already keys on) or a dispatched session (`WE_DISPATCH_KIND`). The
// operator's interactive main session only gets a WARN: the pinned CLAUDE.md rule explicitly lets it "actively
// poll" PR/merge state itself, so a hard deny there would contradict a standing rule.
// DETECTION: the loop keyword and `sleep` must sit at COMMAND position in the quote-MASKED text (so a commit
// message / jq / python string never reads as a loop), while the probe is matched on the raw text (a probe is
// routinely inside `"$(gh pr view …)"` or a quoted `out="…/tasks/x.output"` assignment). A loop polling
// anything else (a port coming up, a `verify-lane.mjs check` marker, a lock file) passes; so does a one-shot
// `gh pr view` / `gh pr checks` with no loop.
const CMD_POS = String.raw`(?:^|[;&|(){}\n]|\b(?:do|then|else)\b)\s*`;
const POLL_LOOP_KEYWORD = new RegExp(`${CMD_POS}(?:until|while|for)\\b`);
const POLL_SLEEP = new RegExp(`${CMD_POS}(?:\\S*/)?sleep\\s+\\S`);
const PR_CI_PROBE = [
  /\bgh\s+pr\s+(?:view|checks|status)\b/,
  /\bgh\s+run\s+(?:list|view|watch)\b/,
  /\bgh\s+api\b[^\n;|&]*(?:check-runs|check-suites|\/commits\/[^\s/]+\/status\b|\/pulls\/\d+)/,
  /\b(?:statusCheckRollup|mergedAt|mergeStateStatus)\b/,
];
/** A BLOCKING CI watch needs no loop at all — the CLI itself polls until the checks settle. */
const PR_CI_BLOCKING_WATCH = /\bgh\s+pr\s+checks\b[^\n;|&]*--watch\b|\bgh\s+run\s+watch\b/;
const BACKGROUND_OUTPUT_PROBE = /\btasks\/[^\s'"/]+\.output\b|\bsubagents\/[^\s'"]*\.jsonl\b/;

/** Which wait-poll shape (if any) does `command` run? Pure. Returns `'pr-ci'`, `'task-output'`, or null. */
export function waitPollKind(command) {
  const raw = heredocScan(String(command || '')).text;
  // The whole text, plus every script bash RE-EXECUTES (`bash -c '…'`, `timeout 580 sh -c "…"`, `$( … )`) —
  // a loop wrapped in a quoted `-c` script is fully masked in the outer view but is still the same poll.
  let nested = [];
  // `timeout <dur>` is not a wrapper `canonicalCommand` peels, and `timeout 580 bash -c '<poll>'` is a real
  // observed shape — peel it here so the `-c` script is reached.
  const peelTimeout = (seg) => seg.replace(/^\s*timeout\s+(?:-\S+\s+)*\S+\s+/, '');
  try { nested = parseSegments(raw).segments.flatMap((seg) => nestedCommandStrings(peelTimeout(seg))); } catch { nested = []; }
  for (const text of [raw, ...nested]) {
    const masked = maskQuoted(text);
    if (PR_CI_BLOCKING_WATCH.test(masked)) return 'pr-ci';
    if (!POLL_LOOP_KEYWORD.test(masked) || !POLL_SLEEP.test(masked)) continue;
    // The probe is matched on the WHOLE raw command: the output path is routinely assigned before the loop.
    if (PR_CI_PROBE.some((re) => re.test(raw))) return 'pr-ci';
    if (BACKGROUND_OUTPUT_PROBE.test(raw)) return 'task-output';
  }
  return null;
}

const WAIT_POLL_REASON = {
  'pr-ci': 'an agent session (subagent or dispatched worker) may not WAIT-POLL PR merge/label state or CI checks '
    + '(a sleep loop around `gh pr view … state|labels|mergedAt`, `gh pr checks`, `statusCheckRollup`, '
    + '`gh api …/check-runs`, `gh run list`, or a blocking `gh pr checks --watch` / `gh run watch`). The resident '
    + 'drain daemon is the SOLE merger and pr-watch / the conveyor own merge + CI observation — the drain/pr-watch '
    + 'owns merge+CI; report and exit (delivery-agent-brief.md step 10 "EXIT — do not merge, do not release, do not '
    + 'wait"; docs/agent/delivery-loop.md). Read the PR ONCE if you need its number/state for your report (a single '
    + '`gh pr view <n> --json state,labels` with no loop is allowed), return it, and END. Measured cost of this '
    + 'pattern: ~9.3h of idle across 26 worker sessions in one day (#x36vidg).',
  'task-output': 'an agent session (subagent or dispatched worker) may not SLEEP-POLL a background task\'s output file '
    + '(`tasks/<id>.output`) or a subagent transcript (`subagents/*.jsonl`) — you will be notified on completion. '
    + 'For a long gating command (test:unit, check:standards, verify-lane, pr-land, review-loop-cli) that the Bash '
    + 'tool auto-backgrounded at its 2-minute default, re-run it in the FOREGROUND with an explicit timeout '
    + '(e.g. timeout: 600000, the 10-minute max) instead of polling its output; if you still have other work, do it '
    + 'and read the output once the completion notification arrives — but never end your turn relying on that '
    + '(pinned CLAUDE.md rule). Measured cost of this pattern: ~7h of idle in one day (#x36vidg).',
};

/** The DENY reason for a wait-poll in an AGENT session (`agentSession` truthy), else null. Pure. */
export function agentWaitPollReason(command, { agentSession = false } = {}) {
  if (!agentSession) return null;
  const kind = waitPollKind(command);
  return kind ? WAIT_POLL_REASON[kind] : null;
}

/** The WARN-only twin for the operator's interactive main session (no deny — the pinned CLAUDE.md rule lets the
 *  main session poll PR/merge state itself). Pure; emitted on the CLI's `systemMessage` nudge channel. */
export function interactiveWaitPollNudge(command, { agentSession = false } = {}) {
  if (agentSession) return null;
  const kind = waitPollKind(command);
  if (kind === 'pr-ci') return 'this is a sleep-poll on PR/CI state (#x36vidg). Allowed in the interactive session, but the drain lands ready-to-merge PRs and pr-watch reports merges — prefer a one-shot read over a wait loop. (An agent session would be DENIED here.)';
  if (kind === 'task-output') return 'this sleep-polls a background task\'s output file (#x36vidg). You are notified when a background task finishes; for a long gating command prefer a FOREGROUND run with an explicit timeout (e.g. timeout: 600000). (An agent session would be DENIED here.)';
  return null;
}

// ── NO-POLLING — agents may not run wait/poll loops or long sleeps ──────────────────────────────────────────
// Incident: a build agent sat ~20 min in `for i in $(seq 1 38); do if grep … daemon.log …; then break; fi;
// perl -e 'select(undef,undef,undef,…)'; done` — unable to receive messages, and had to be killed. Other agents
// used `perl -e 'sleep 330'` and `until …; do …; perl -e 'sleep 120'; done`. A session that is inside a Bash
// call cannot be messaged or resumed, so a wait loop is a stall the harness cannot see. Rule: (1) a loop whose
// body (or condition) sleeps/waits is DENIED, however it waits — a shell `for|while|until … done`, or a loop
// inside a perl/python/node/ruby/php/awk one-liner or a heredoc fed to one; a wait OUTSIDE the loop's `done` is
// just a short sleep; (2) any SINGLE wait longer than `maxSleepSeconds` (scripts/guard-bash-polling.json,
// default 30), any wait whose length is not a plain literal (`sleep $N`, `1e3` is read, `0x10` is not), and the
// SUM of the waits in one command above that limit are DENIED. Applies to EVERY session kind (main,
// subagent, conveyor). No override. Sanctioned allowlist (see the json): a bare `sleep N` (N <=
// heartbeat.maxSeconds) run with run_in_background:true — the harness-tracked heartbeat of /workflow and
// /conveyor. `verify-lane check --wait=<ms>` contains no sleep (it polls internally) so it is simply not matched.
// COVERAGE is best-effort, the same accidental-collision threat model as the rest of this file (#2367), NOT a
// proof that polling is impossible. Scanned: the command, every `bash -c`/`$()` script it re-executes, wrapper
// prefixes (nohup/env/time/xargs/timeout/…), interpreter one-liners and heredocs fed to a shell or interpreter.
// Heredoc bodies fed to anything else (`cat`, `git commit -F -`, or a shell/interpreter given a script FILE) are
// data and never scanned. A script is only judged by CALL syntax (`sleep(5)`, `time.sleep(5)`, `system("sleep 5")`):
// the bare word `sleep` in a program that edits or searches text is not a wait. KNOWN GAPS: a script FILE written
// and then run, `find -exec sleep`, interpreters not listed, `bash <<< '…'` / `echo '…' | bash`, blocking waiters
// that are not a sleep (`tail -f`, `watch`, `inotifywait`, `kubectl wait`), `s=sleep; $s 100`, and a loop split
// across separate Bash calls — none of these is reliably detectable from one command line.
const POLLING_DEFAULTS = { maxSleepSeconds: 30, heartbeatMaxSeconds: 120 };
function loadPollingSettings() {
  try {
    const j = JSON.parse(readFileSync(new URL('./guard-bash-polling.json', import.meta.url), 'utf8'));
    const max = Number(j.maxSleepSeconds);
    const hb = Number(j.heartbeat && j.heartbeat.maxSeconds);
    return {
      maxSleepSeconds: Number.isFinite(max) && max > 0 ? max : POLLING_DEFAULTS.maxSleepSeconds,
      heartbeatMaxSeconds: Number.isFinite(hb) && hb >= 0 ? hb : POLLING_DEFAULTS.heartbeatMaxSeconds,
    };
  } catch { return { ...POLLING_DEFAULTS }; }
}
const POLLING_UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
const SLEEP_NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Seconds named by the args of a `sleep` (GNU/BSD: `30`, `1m`, `1h 30m`, `1e3`), Infinity for `infinity`, and NaN
 *  when ANY token is not a plain literal (`$N`, `$((60*10))`, `0x10`). NaN means "unbounded" — callers deny it. */
function sleepArgsSeconds(args) {
  // `args` is the RAW text after `sleep`, capped so a pathological line cannot make the strip below quadratic;
  // quotes are dropped (`sleep "5"` is `sleep 5`) and so are redirections (`2>/dev/null`, `2>&1`, `>&2`).
  const toks = args.slice(0, 512).replace(/['"]/g, '').replace(/\d*[<>]+&?\s*\S*/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return NaN;
  let total = 0;
  for (const t of toks) {
    if (/^--?(?:help|version)$/.test(t)) return 0;
    if (/^\+?(?:inf|infinity)$/i.test(t)) return Infinity;
    const unit = /[smhd]$/.test(t) ? t.slice(-1) : '';
    const num = unit ? t.slice(0, -1) : t;
    if (!SLEEP_NUMBER.test(num)) return NaN;
    total += Number(num) * POLLING_UNIT[unit || 's'];
  }
  return total;
}
/** Seconds a `read -t` blocks for, NaN when its value is not a literal, null when `read` has no timeout. `opts` is the
 *  quote-masked text after `read`. */
function readTimeoutSeconds(opts) {
  const toks = opts.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const m = toks[i].match(/^-[A-Za-z]*t(\S*)$/);
    if (m) { const arg = m[1] || toks[i + 1] || ''; return SLEEP_NUMBER.test(arg) ? Number(arg) : NaN; }
    if (!toks[i].startsWith('-') && !/^[\d.]+$/.test(toks[i])) break;     // first variable name ends the options
  }
  return null;
}
// Command wrappers that may stand in front of a wait (`nohup sleep 100`, `time sleep`, `xargs -n1 sleep`,
// `timeout 200 sleep`): each takes flags, `VAR=val`, or a bare number/duration before the real program.
// `command -v sleep` / `-V` is a lookup, not a run, so `command` is a wrapper only without that flag.
const WAIT_WRAPPERS = String.raw`(?:(?:nohup|env|time|command(?!\s+-\w*[vV])|exec|eval|builtin|nice|ionice|stdbuf|setsid|sudo|doas|caffeinate|xargs|timeout)\s+(?:-\S+\s+|[A-Za-z_]\w*=\S*\s+|\d+(?:\.\d+)?[smhd]?\s+)*)*`;
// Where a command may START: after a separator or backtick, after a loop/conditional keyword (`while sleep 1; do`,
// `if sleep 1; then`), and after a negating `!`. `\`` is a literal backtick.
const POLL_CMD_POS = String.raw`(?:^|[;&|(){}\n\`]|\b(?:do|then|else|elif|if|while|until)\b)\s*(?:!\s*)?`;
const WAIT_INTERPRETERS = String.raw`perl|ruby|python[\d.]*|node|nodejs|bun|deno|php|awk|gawk|mawk|nawk`;
/** Where each interpreter's inline script lives on its command line: `[program, regex → group 2 is the script]`. */
const INTERPRETER_SCRIPT = [
  [/^(?:perl|ruby)$/, /\s-\w*[eE]\s*(['"])([\s\S]*?)\1/],
  [/^python[\d.]*$/, /\s-\w*c\s*(['"])([\s\S]*?)\1/],
  [/^(?:node|nodejs|bun|deno)$/, /\s(?:-\w*[ep]|--eval|--print|eval)\s*(['"`])([\s\S]*?)\1/],
  [/^php$/, /\s-\w*r\s*(['"])([\s\S]*?)\1/],
  [/^(?:awk|gawk|mawk|nawk)$/, /\s(['"])([\s\S]*?)\1/],
];
/** A loop construct in some interpreter's script (a wait inside one is a polling loop whatever the language). */
const SCRIPT_LOOP = /\b(?:while|until|for|foreach|loop|forever|setInterval)\b/;
/** Every wait an interpreter SCRIPT (a one-liner body or a heredoc fed to the interpreter) performs, in seconds
 *  (NaN when not a literal), plus whether the script loops. Pure. Only CALL syntax counts, never a bare word — a
 *  script that merely MENTIONS sleep (`print('sleep deprivation')`, `/sleep/`, a `.replace("sleep 100", …)` edit of
 *  this very guard) is data: `sleep(N)` / `time.sleep(N)` / `asyncio.sleep(N)`, `usleep(N)`, `system("sleep N")` and
 *  friends, perl `select(undef,undef,undef,N)`, node `setTimeout(` / `setInterval(` / `Atomics.wait(`; plus the bare
 *  statement `sleep N` / `sleep $n` for `prog` perl/ruby only. */
function scriptWaits(body, prog = '') {
  body = body.slice(0, 65536);                    // bounded scan: the idiom regexes below are not linear on junk
  const waits = [];
  const lit = (s) => (s ? Number(String(s).replace(/_/g, '')) : NaN);
  const NUM = String.raw`(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
  for (const x of body.matchAll(new RegExp(String.raw`\bsleep\s*\(\s*(${NUM})?`, 'g'))) waits.push(lit(x[1]));
  if (/^(?:perl|ruby)$/.test(prog)) {
    for (const x of body.matchAll(new RegExp(String.raw`(?<![\w/"'.$@%:-])sleep\s+(?:(${NUM})|\$\w+)`, 'g'))) waits.push(lit(x[1]));
  }
  for (const x of body.matchAll(/\b(?:system|exec\w*|popen|qx|spawn\w*|call|run)\s*\(\s*\[?\s*['"`]\s*sleep\s+([^\s'"`)\]]+)/g)) {
    waits.push(new RegExp(`^${NUM}$`).test(x[1]) ? lit(x[1]) : NaN);
  }
  for (const x of body.matchAll(/\busleep\s*\(\s*([\d_.]+)?/g)) waits.push(lit(x[1]) / 1e6);
  for (const x of body.matchAll(/select\s*\(\s*undef\s*,\s*undef\s*,\s*undef\s*,\s*([^)]*)\)/g)) {
    const n = Number(x[1].trim());
    waits.push(Number.isFinite(n) ? n : NaN);
  }
  for (const x of body.matchAll(/setTimeout\s*\([^,]*,\s*([\d_.*\s]+)\)/g)) {
    let ms = NaN; try { ms = Function(`return (${x[1].replace(/_/g, '')})`)(); } catch { /* unknown */ }
    waits.push(Number.isFinite(ms) ? ms / 1000 : NaN);
  }
  if (/setTimeout\s*\(/.test(body) && !/setTimeout\s*\([^,]*,\s*[\d_.*\s]+\)/.test(body)) waits.push(NaN);
  if (/\bsetInterval\s*\(/.test(body)) waits.push(NaN);
  for (const x of body.matchAll(/Atomics\.wait\s*\([^,]*,[^,]*,[^,]*,\s*([\d_.]+)/g)) waits.push(Number(x[1].replace(/_/g, '')) / 1000);
  return { waits, loops: SCRIPT_LOOP.test(body) };
}
/** `[start, end)` offsets of every shell loop (`for|while|until` … matching `done`) in QUOTE-MASKED text; an unclosed
 *  loop runs to the end. A wait counts as a polling-loop wait only when it sits inside one of these (the loop's
 *  condition included) — a settle-sleep before or after a harmless loop is just a short sleep. Pure. */
function loopSpans(masked) {
  const stack = [];
  const spans = [];
  for (const m of masked.matchAll(new RegExp(`(${POLL_CMD_POS})(for|while|until|done)\\b`, 'g'))) {
    const at = m.index + m[1].length;
    if (m[2] === 'done') { const a = stack.pop(); if (a !== undefined) spans.push([a, at + 4]); }
    else stack.push(at);
  }
  for (const a of stack) spans.push([a, masked.length]);
  return spans;
}
/** Every wait in one shell text as `{ seconds, index, looping }` — `index` is the offset in `text`, `looping` marks a
 *  wait inside an interpreter script that itself loops. `seconds` NaN = not a literal. Pure. */
function shellWaits(text) {
  text = text.replace(/\\\n/g, '  ');            // a `\`+newline continuation is whitespace (same length: offsets hold)
  const masked = maskQuoted(text);
  const waits = [];
  const sleepRe = new RegExp(`(${POLL_CMD_POS})${WAIT_WRAPPERS}\\\\?((?:\\S*/)?(?:sleep|usleep))(?=[\\s;&|)\`]|$)([^;&|\\n)\`]*)`, 'g');
  for (const m of masked.matchAll(sleepRe)) {
    const index = m.index + m[1].length;
    const end = m.index + m[0].length;
    const args = text.slice(end - m[3].length, end);           // RAW args: `sleep "5"` is a literal 5
    if (/usleep$/.test(m[2])) {
      const t = args.slice(0, 512).replace(/['"]/g, '').trim().split(/\s+/)[0];
      waits.push({ seconds: SLEEP_NUMBER.test(t) ? Number(t) / 1e6 : NaN, index });
    } else waits.push({ seconds: sleepArgsSeconds(args), index });
  }
  // A condition-driven loop whose body does nothing (`while ! curl -sf x; do :; done`) is a spin-wait: no sleep word,
  // same stall. `for` loops are bounded and left alone.
  for (const m of masked.matchAll(/\b(?:while|until)\b[^;\n]*;\s*do\s*(?::|true)\s*;?\s*done\b/g)) waits.push({ seconds: 0, index: m.index, looping: true });
  const readRe = new RegExp(`(${POLL_CMD_POS})read(?=\\s)([^;&|\\n)<]*)`, 'g');
  for (const m of masked.matchAll(readRe)) {
    const seconds = readTimeoutSeconds(m[2]);
    if (seconds !== null) waits.push({ seconds, index: m.index + m[1].length });
  }
  // Interpreter one-liners: the script is the QUOTED argument, so find the command in the masked text (a commit
  // message that merely mentions `perl -e 'sleep 100'` is not one) and read its script out of the raw text.
  const interpRe = new RegExp(`(${POLL_CMD_POS})${WAIT_WRAPPERS}(?:\\S*/)?(${WAIT_INTERPRETERS})(?=[\\s;&|)]|$)`, 'g');
  for (const m of masked.matchAll(interpRe)) {
    const start = m.index + m[1].length;
    const stop = masked.slice(start).search(/[;&|\n)]/);
    const cmdRaw = text.slice(start, stop < 0 ? undefined : start + stop);
    const entry = INTERPRETER_SCRIPT.find(([re]) => re.test(m[2]));
    const body = entry && cmdRaw.match(entry[1]);
    if (!body) continue;
    const { waits: sw, loops } = scriptWaits(body[2], m[2].replace(/\d.*$/, ''));
    for (const seconds of sw) waits.push({ seconds, index: start, looping: loops });
  }
  return waits;
}
const HEREDOC_OPERATOR = /<<-?\s*(?:'[^']*'|"[^"]*"|\\?\w+)/g;
/** What does a heredoc's HEAD line feed its body to: `{ kind: 'shell', prog }` (bash/sh/…, the body is a script of
 *  commands), `{ kind: 'script', prog }` (python/node/perl/…, the body is a program), or null — `cat`,
 *  `git commit -F -`, or a shell/interpreter given a script FILE (`node x.mjs <<EOF`: the body is that script's
 *  stdin DATA). A `cat <<EOF | bash` pipe is followed to its consumer. */
function heredocInterpreter(head) {
  let segs;
  try { segs = parseSegments(String(head || '')).segments; } catch { return null; }
  const progOf = (words) => (words[0] || '').replace(/^.*\//, '');
  const wordsOf = (seg) => headWords(canonicalCommand(seg.replace(HEREDOC_OPERATOR, ' '))).map((w) => w.text);
  const interpreters = new RegExp(`^(?:${WAIT_INTERPRETERS})$`);
  const kindOf = (seg) => {
    const words = wordsOf(seg);
    const prog = progOf(words);
    const shell = SHELL_PROGRAMS.has(prog);
    if (!shell && !interpreters.test(prog)) return null;
    const rest = words.slice(1);
    if (shell && rest.includes('-s')) return { kind: 'shell', prog };
    if (rest.some((w) => w !== '-' && !w.startsWith('-'))) return null;   // a script file / `-c` string: stdin is data
    return { kind: shell ? 'shell' : 'script', prog };
  };
  const at = segs.findIndex((s) => s.includes('<<'));
  if (at < 0) return null;
  const direct = kindOf(segs[at]);
  if (direct) return direct;
  return /^(?:cat|tee|printf|echo)$/.test(progOf(wordsOf(segs[at]))) && segs.length > at + 1 ? kindOf(segs[segs.length - 1]) : null;
}
/** A segment as its command: drop the loop/conditional keyword (`do bash -c '…'`) and a `timeout <dur>` prefix. */
const peelPollingSegment = (seg) => seg.replace(/^\s*(?:(?:do|then|else|elif|if|while|until)\s+)+(?:!\s*)?/, '').replace(/^\s*timeout\s+(?:-\S+\s+)*\S+\s+/, '');
/** The shell texts `command` really executes: itself with heredoc bodies stripped (they are data), plus every script
 *  it re-executes (`bash -c '…'`, `$( … )`, backticks), recursively. Each view carries `inLoop` when the text that
 *  spawned it sits inside a loop of its parent, and the stripped `heredocs` so interpreter-fed ones can be scanned. */
function pollingViews(command) {
  const views = [];
  const seen = new Set();
  const add = (t, depth, inLoop) => {
    if (depth > 4 || seen.has(t)) return;
    seen.add(t);
    const hs = heredocScan(t);
    views.push({ text: hs.text, heredocs: hs.heredocs || [], inLoop });
    const masked = maskQuoted(hs.text);
    const spans = loopSpans(masked);
    let nested = [];
    try { nested = parseSegments(hs.text).segments.flatMap((seg) => nestedCommandStrings(peelPollingSegment(seg))); } catch { nested = []; }
    for (const n of nested) {
      // A body that is visible UNQUOTED in this view (`$(sleep 20)`, a `( … )` group, backticks) is already scanned
      // by it — scanning it again as its own view would count the same wait twice. Quoted ones (`bash -c '…'`,
      // `"$( … )"`) are blanked in the masked view and are only reached here.
      if (masked.includes(n)) continue;
      const at = hs.text.indexOf(n);
      add(n, depth + 1, inLoop || (at >= 0 && spans.some(([a, b]) => at >= a && at < b)));
    }
  };
  add(String(command || ''), 0, false);
  return views;
}
/** `{ loopWait, waits }` for a command: `loopWait` = some wait sits inside a loop (shell or interpreter), `waits` =
 *  every wait's seconds (NaN = not a literal). Pure. */
function analyzePolling(command) {
  let loopWait = false;
  const waits = [];
  for (const view of pollingViews(command)) {
    const spans = loopSpans(maskQuoted(view.text));
    const inSpan = (i) => spans.some(([a, b]) => i >= a && i < b);
    for (const w of shellWaits(view.text)) {
      waits.push(w.seconds);
      if (view.inLoop || w.looping || inSpan(w.index)) loopWait = true;
    }
    for (const h of view.heredocs) {
      const fed = heredocInterpreter(h.head);
      if (!fed) continue;
      const at = Math.max(0, view.text.indexOf(h.head));
      const carried = view.inLoop || inSpan(at);
      if (fed.kind === 'shell') {
        const sub = analyzePolling(h.body);
        if (sub.loopWait || (carried && sub.waits.length)) loopWait = true;
        waits.push(...sub.waits);
      } else {
        const { waits: sw, loops } = scriptWaits(h.body, fed.prog.replace(/\d.*$/, ''));
        if (sw.length && (loops || carried)) loopWait = true;
        waits.push(...sw);
      }
    }
  }
  return { loopWait, waits };
}
/** Is `command` the allowlisted heartbeat: a bare `sleep N` (N <= limit), run in the background? Pure. */
function isSanctionedHeartbeat(command, { runInBackground = false, heartbeatMaxSeconds }) {
  if (!runInBackground) return false;
  const m = String(command || '').trim().match(/^sleep\s+(\d+)$/);
  return !!m && Number(m[1]) <= heartbeatMaxSeconds;
}
const POLLING_ADVICE = ' Do not wait in a shell. Instead: (a) END YOUR TURN and let the harness/daemon resume you (the #5137 await-verify flow — '
  + 'request the gate, report what is pending, stop); (b) for the verify gate use ONE bounded foreground call, '
  + '`node scripts/verify-lane.mjs check --wait=540000 --json` (it polls internally); or (c) report what is still pending and finish. '
  + 'Ordinary non-waiting loops (`for f in *.mjs; do …; done`) and a short `sleep` (<= the limit) are fine. No override.';
/** The DENY reason for a polling loop / long sleep, else null. Pure; every session kind. `settings` is injectable for tests. */
export function pollingLoopReason(command, { runInBackground = false, settings = loadPollingSettings() } = {}) {
  const raw = heredocScan(String(command || '')).text;
  if (!raw.trim()) return null;
  if (isSanctionedHeartbeat(raw, { runInBackground, heartbeatMaxSeconds: settings.heartbeatMaxSeconds })) return null;
  const { loopWait, waits } = analyzePolling(command);
  if (loopWait) {
    return `a loop (shell for/while/until, or one inside a perl/python/node/ruby/php/awk script) whose body sleeps or waits is a POLLING LOOP — denied (an agent stuck in one cannot receive messages; a build agent sat ~20 min in exactly this and had to be killed).${POLLING_ADVICE}`;
  }
  const max = settings.maxSleepSeconds;
  const long = waits.find((s) => !(s <= max));      // `!(<=)`, not `>`: a non-literal duration is NaN and must deny
  if (long !== undefined) {
    return `a single wait of ${Number.isFinite(long) ? `${Math.round(long)}s` : 'unbounded or non-literal length'} exceeds the ${max}s limit (scripts/guard-bash-polling.json) — denied (a session blocked in a long sleep cannot receive messages).${POLLING_ADVICE}`;
  }
  const total = waits.reduce((a, s) => a + s, 0);
  if (total > max) {
    return `${waits.length} waits in one command total ${Math.round(total)}s, which exceeds the ${max}s limit (scripts/guard-bash-polling.json) — denied (chaining short sleeps is still one long block).${POLLING_ADVICE}`;
  }
  return null;
}

/**
 * Is `cwd` a constellation PRIMARY checkout (not a lane clone)? Pure. A lane clone lives under `/.lanes/` so
 * it is always allowed; otherwise cwd must sit at/under one of the `primaries` roots. `primaries` is injected
 * (the CLI derives + realpaths them from this script's location) so the test stays pure/unit-testable.
 */
export function isPrimaryCwd(cwd, primaries = []) {
  if (!cwd) return false;
  const c = String(cwd);
  if (c.includes('/.lanes/')) return false;                         // a lane clone → always allowed
  return primaries.some((p) => p && (c === p || c.startsWith(p.endsWith('/') ? p : p + '/')));
}

/** Is `cwd` inside a pool lane clone (`~/workspace/.lanes/<repo>/lane-N/…`)? Pure — string test only, no
 *  git call (the CLI does the actual "how far behind" git call and passes the count in via ctx). */
export function isLaneCwd(cwd) {
  return !!cwd && String(cwd).includes('/.lanes/');
}

// #2367 — the destructive-git-op guard for a lane clone leased by ANOTHER session ─────────────────────

/** The lane clone ROOT (`…/.lanes/<repo>/lane-N`) a `cwd` sits at or under, or null. Pure — string test
 *  only; the CLI resolves the `.git/<LEASE_FILENAME>` marker path from this. */
export function laneRootFromCwd(cwd) {
  if (!cwd) return null;
  const m = String(cwd).match(/^(.*\/\.lanes\/[^/]+\/lane-\d+)(?:\/.*)?$/);
  return m ? m[1] : null;
}

/** Normalize the leading git invocation of a single command segment to a canonical `git <subcommand> …`
 *  string, or '' if the segment is not a git invocation. Pure — closes the #2367 matcher-BYPASS holes an
 *  `^git`-anchored test misses (accidental-collision threat model, NOT adversarial evasion): it unwraps a
 *  leading subshell `(`/group `{`, peels wrapper commands (`env [VAR=v…]`, `time`, `command`, `builtin`,
 *  `nice`, `xargs [opts]`, `sudo [-n] [-u <user>]`), strips surrounding quotes / a leading backslash off the
 *  program word (`"git"`/`'git'`/`\git`→`git`) and resolves a path-qualified git to its basename
 *  (`/usr/bin/git`→`git`), then skips git's leading GLOBAL flags (`-C <path>`, `-c <k=v>`, `--git-dir=…`, …) so
 *  the REAL subcommand is what the danger patterns match. Deliberately does NOT chase adversarial disguises
 *  (`git$IFS…`, `$(echo git)`, `bash -c "…"`, `ssh host git`): this guard is advisory with a one-env-var escape
 *  (`LANE_CLOBBER_OK=1`), so an actor bent on evasion never needs them — see #2367 r2 dismissal. */
export function canonicalGitOp(cmd) {
  // Wrapper-peeling + program-word normalization is shared with the #2788 tree-write arms via
  // `canonicalCommand` (r3 finding 1 — the new arms reimplemented a strictly weaker stripper beside this one).
  // r3 audit — the global-flag skip walks QUOTE-AWARE words, not a blind `/\s+/` split: a quoted value with a
  // space (`git -c "user.name=a b" reset --hard`) desynced the skip by one and the whole op read as harmless.
  // The subcommand tail is sliced RAW so quoting survives for the danger patterns below.
  const c = canonicalCommand(cmd);
  const words = headWords(c);
  if (!words.length || words[0].text !== 'git') return '';
  let i = 1;
  while (i < words.length) {
    const t = words[i].text;
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { i += 2; continue; }
    if (t.startsWith('-')) { i += 1; continue; }        // `--git-dir=…` / `--no-pager` / `--paginate` / `-p`
    break;
  }
  return i >= words.length ? 'git ' : 'git ' + c.slice(words[i].start);
}

/** Is this command segment a destructive git op that would CLOBBER a lane clone (working tree or its remote
 *  branch) in place — `reset --hard`; `clean` with a force flag (`-fd`, and `-f`/`-fx` alone still deletes
 *  untracked FILES); `checkout`/`restore`/`switch` that discard the tree (`checkout [<ref>] [--] .`,
 *  `checkout -f <ref>`, `restore [--worktree/--staged/--] .`, `switch -f`); or a force-push (flag OR a
 *  leading-`+` refspec)? Normalizes via `canonicalGitOp` first (so wrappers / path-qualified git / global
 *  flags can't slip past). Pure (unit-tested); the #2367 danger table in `reason()` gates behind `ctx.foreignLiveLease`. */
export function isDestructiveLaneGitOp(cmd) {
  const c = canonicalGitOp(cmd);
  if (!c) return false;
  // r3 audit — these used `[^|;&]*` as a "stay inside this segment" fence. The segment split is now
  // quote-aware, so the ONLY `|`/`;`/`&` that can still appear here is one inside a QUOTED argument, where
  // the fence stops the scan early and the op reads as harmless. The real fence is the line.
  if (/^git\s+reset\b[^\n]*--hard\b/.test(c)) return true;
  // `clean` with a FORCE flag — deletes untracked files (`-f`/`-fx`) and, with `-d`, untracked dirs. A force
  // flag is the destructive trigger; `-d` alone (no force) is a no-op, so force-present is the whole test.
  if (/^git\s+clean\b/.test(c) && /(?:^|\s)(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?=\s|$)/.test(c)) return true;
  if (/^git\s+checkout\s+(?:\S+\s+)?(?:--\s+)?\.(?:\s|$)/.test(c)) return true;   // checkout [<ref>] [--] .
  if (/^git\s+checkout\b[^\n]*\s(?:-f|--force)(?=\s|$)/.test(c)) return true;    // checkout -f <ref>
  if (/^git\s+restore\b[^\n]*\s\.(?:\s|$)/.test(c)) return true;                 // restore [--worktree/--staged/--] .
  if (/^git\s+switch\b[^\n]*\s(?:-f|--force|--discard-changes)(?=\s|$)/.test(c)) return true; // switch -f <branch>
  if (/^git\s+push\b/.test(c) &&
      (/(?:^|\s)(?:-f|--force|--force-with-lease)(?=\s|$)/.test(c) || /(?:^|\s)\+\S/.test(c))) return true; // force-push (flag or +refspec)
  return false;
}

/** Does ANY `&&`/`|`/`;`-separated segment of `command` look like a destructive lane git op? Pure — mirrors
 *  `decide`'s segment split. The CLI uses this as a cheap pre-filter so the `fs` lease-ownership check below
 *  only runs when it could possibly matter (the overwhelming majority of Bash calls skip it). Passes each raw
 *  segment straight to `isDestructiveLaneGitOp` — `canonicalGitOp` strips env/sudo/wrapper disguises itself. */
export function hasDestructiveLaneOp(command) {
  if (!command) return false;
  const parsed = parseSegments(command);
  // r3 audit — this is a PRE-FILTER for the (impure) lease read, so its only failure mode that matters is a
  // false NEGATIVE: no lease is read, `reason()` gets no lease context, and the lane-clobber arm cannot fire.
  // An unparseable command therefore answers YES (pay for one lease read) rather than degrading to NO.
  if (parsed.unterminated) return true;
  const segments = parsed.segments.concat(
    parsed.continued ? parseSegments(command, { spliceContinuations: false }).segments : [],
  );
  return segments.some((seg) => isDestructiveLaneGitOp(seg.trim()));
}

// #2335 — the harness resets the reported Bash cwd to the PRIMARY checkout between tool calls, so the
// standard lane invocation `cd <lane> && node …/backlog.mjs claim` reports cwd=primary and gets misclassified
// as a primary mutation (denied) AND makes the #2323 git call run in the primary (a false "behind" count).
// Recover the cwd the command will ACTUALLY run in by honouring a leading `cd <target>` — resolving a
// `cd "$LANE"` against a literal `LANE=/abs` assignment earlier in the same command (the exact lane idiom).
// Pure + unit-tested. Fails safe: an unresolvable target (unknown var, command-subst) → the reported cwd,
// i.e. today's behaviour. #2339 removed the BACKLOG_MUTATE_OK override, so there is now no escape hatch for
// that residual case — never a wrong ALLOW of a real primary mutation, but a genuine lane mutation whose `cd`
// target this resolver can't statically resolve (e.g. a command-substitution path) will be wrongly denied.
// The fix is to invoke with a directly-resolvable `cd` (a literal absolute path, or `LANE=/abs; cd "$LANE"` —
// the standard lane idiom every skill already teaches), not to reach for a removed override.
export function resolveEffectiveCwd(command, reportedCwd, resolvePath = resolve) {
  // r3 audit — a heredoc BODY is data. A `cd /elsewhere` line (or an apostrophe that desyncs the quote
  // scanner) inside a PR-body heredoc must not steer, or break, the cwd resolution; `decide` already strips
  // them before it parses, and this must agree with it. An unparseable command keeps the REPORTED cwd, which
  // is the conservative answer (the primary-cwd arms stay armed) — and `decide` denies it outright anyway.
  const cmd = stripHeredocBodies(String(command || ''));
  if (!cmd) return reportedCwd;
  const parsed = parseSegments(cmd);
  if (parsed.unterminated) return reportedCwd;
  // Collect simple literal `VAR=value` / `export VAR=value` assignments (no command-subst/globs) in order.
  const vars = Object.create(null);
  for (const stmt of parsed.segments) {
    const m = stmt.trim().match(/^(?:export\s+)?([A-Za-z_]\w*)=(.+)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (/[`$(]/.test(val)) continue;                          // command-subst / nested expansion → skip
    val = val.replace(/^(['"])(.*)\1$/, '$2');                // strip matching surrounding quotes
    if (!/\s/.test(val)) vars[m[1]] = val;                    // single-token literal only
  }
  // First `cd <target>` statement wins (that is where the command lands before the mutation runs).
  for (const stmt of parsed.segments) {
    const cd = stmt.trim().match(/^cd\s+(.+)$/);
    if (!cd) continue;
    let target = cd[1].trim().split(/\s+/)[0];                // first arg only (ignore trailing redirs/opts)
    target = target.replace(/^(['"])(.*)\1$/, '$2');          // strip surrounding quotes
    const v = target.match(/^\$\{?([A-Za-z_]\w*)\}?$/);       // whole target is $VAR / ${VAR}
    if (v) target = vars[v[1]] ?? '';
    if (!target || /[`$(*?]/.test(target)) return reportedCwd; // still unexpanded / globby → fail safe
    return target.startsWith('/') ? target : resolvePath(reportedCwd || '.', target);
  }
  return reportedCwd;
}

// ── #2968 — `git add` of an ENUMERATED path set, matched by EFFECT not flag spelling ──────────────────────
// PR #1064: a `git add --intent-to-add --all` was blocked, then RE-SPELLED as
// `git ls-files --others --exclude-standard -z | xargs -0 git add --intent-to-add --` — same effect (a broad
// stage that sweeps up a concurrent session's in-flight work), different letters. Left-behind intent-to-add
// entries also make `git restore <path>` TRUNCATE a swept file to 0 bytes and every `pull --ff-only
// --autostash` in the repo die. Four sink shapes reach the same effect: the flag ITSELF enumerates (`-A`,
// `--all`, a bare `.`) — no pipe needed, so this is a per-segment arm in `reason()` below; or the path set
// comes from an ENUMERATION the `git add` invocation's own text never named — a pipe from a listing command
// into an (optionally `xargs`-wrapped) `git add`, a `while … read` loop body, or a `find -exec`. Those three
// need whole-command context `reason()`'s per-segment walk doesn't have (the enumeration source is a
// DIFFERENT segment, or the `git add` sits inside a compound whose head word is `while`/`find`, not `git`),
// so they are one whole-command function called from `decide()`, the same shape as
// `commitIdentityCommandReason`/`backgroundedVerificationReason` above.
//
// KNOWN RESIDUAL GAPS (an adversarial review found these; scoped OUT of this item's four named shapes —
// `pipe-to-xargs, while-read, -exec, direct` — deliberately, not by oversight, so a NEXT re-spelling has a
// named place to land rather than a silent hole):
//   • `git add $(git ls-files --others)` / `` git add `git ls-files --others` `` — the SAME effect (an
//     enumeration feeds the add) reached via command substitution rather than a pipe. No `|` exists for
//     `pipeGitAddEnumerationReason` to key on.
//   • `for f in $(git ls-files --others); do git add "$f"; done` — the same loop-variable shape as WHILE-READ,
//     spelled with `for` instead of `while … read`.
//   • `git diff --name-only | xargs git add`, a bare `git status | xargs git add` — `isPathEnumerationSource`
//     below is scoped to the sources #1064's incident and this item's DoD actually name.
//
// PR #1816 review (2026-09) found and fixed a NARROWER class in the same family — not a new sink, but
// EQUIVALENT SPELLINGS of the four shapes ABOVE this list slipping past an exact-token/exact-`\b` match
// (`./` for a bare `.`, `-Av`/`-vA` for `-A`, `-su` for `-s`) — see `gitAddEnumeratesUnnamedPaths` and
// `statusClusterHasShort` below. That review is exactly the class of recurrence this comment exists to warn
// about, so a fuzz/property test guarding it going forward is filed as backlog#x63kvwg (parent #3383).
const GIT_ADD_ENUMERATION_MESSAGE =
  '`git add` here stages a path set you did not name — the operand is an ENUMERATION (a wildcard `-A`/`--all`/`.` '
  + 'flag, a piped `ls-files`/`status`/`find`/`ls` listing feeding an `xargs` sink, a `while read` loop variable, '
  + 'or a `find -exec`), not paths written out in the command itself (#2968). A broad/enumerated add sweeps up '
  + "whatever a CONCURRENT session has in flight — the exact incident PR #1064 reproduced by RE-SPELLING a "
  + 'blocked `git add --all --intent-to-add` as `git ls-files --others --exclude-standard -z | xargs -0 git add '
  + '--intent-to-add --`, same effect, different letters. Left-behind intent-to-add entries also make `git '
  + 'restore <path>` TRUNCATE a swept file to 0 bytes and make every `pull --ff-only --autostash` in the repo '
  + 'die. Stage the EXACT paths you mean: `git add path/a path/b`. There is no override — an unnamed path set '
  + 'is never the right add here.';

/** The DIRECT shape: does this `git add` invocation's OWN text enumerate an unnamed, unbounded path set —
 *  `-A`/`--all` (the whole index+worktree) or a bare `.` operand (everything under cwd)? Pure. No pipe/xargs/
 *  while-read/-exec needed here: the flag itself is what does the enumerating. Quoting is IRRELEVANT to every
 *  operand tested here — `git add "-A"` and `git add -A` reach git's argv identically, so `t.quoted` is never
 *  read (an adversarial review caught an earlier draft that guarded ONLY the `-A`/`--all` arm on `!t.quoted`,
 *  inconsistently with the `.` arm three tokens later — `git add "-A"`/`git add "--all"` slipped through).
 *
 *  Also equivalent-spelling widened (PR #1816 review — confirmed bypass, same class as the two gaps above):
 *  `./` and `./.` are the same "everything under cwd" operand as a bare `.` — git resolves all three
 *  identically. And `-A` is a POSIX-combinable short flag: `-Av`/`-vA`/any single-dash letter CLUSTER
 *  containing `A` reaches git's argv exactly as a bare `-A` would (`git add -Av` == `git add -A -v`) — matching
 *  only the exact two-character token `-A` let `-Av`/`-vA` slip through untouched. */
function gitAddEnumeratesUnnamedPaths(seg) {
  if (gitSubcommand(seg) !== 'add') return false;
  const toks = shellTokens(canonicalCommand(seg)).filter((t) => !t.op);
  const addIdx = toks.findIndex((t) => !t.quoted && t.text === 'add');
  if (addIdx < 0) return false;
  return toks.slice(addIdx + 1).some((t) => {
    const text = t.text;
    if (text === '--all' || text === '.' || text === './' || text === './.') return true;
    // A single-dash cluster of bare letters (never `--long`, the leading `(?!-)` excludes that) is a POSIX
    // short-flag COMBINATION — every letter in it reaches argv as if passed separately, so any cluster
    // containing `A` enumerates just as much as a lone `-A` does.
    return /^-(?!-)[A-Za-z]+$/.test(text) && text.includes('A');
  });
}

/** Enumeration-SOURCE commands whose output is a bare path/status listing — the LEFT side of the #2968
 *  pipe-to-`git add` sink shape. Scoped to the sources the incident and this item's own definition-of-done
 *  name (`ls-files`, `status --porcelain`/`--short`/`-s`, `find`, `ls`), not every read-only command, so
 *  `git log --oneline | xargs …` reading commit hashes is not swept in. */
function isPathEnumerationSource(seg) {
  const sub = gitSubcommand(seg);
  if (sub === 'ls-files') return true;
  if (sub === 'status') {
    const cmd = canonicalCommand(seg);
    if (/(?:^|\s)(?:--porcelain\b|--short\b)/.test(cmd)) return true;
    // `-s` is a POSIX short flag too, so it can ride inside a combined cluster (`-su`, `-sb`, …) that the
    // bare `-s\b` word-boundary regex above can never see (`\b` never fires between two letters) — PR #1816
    // review's confirmed bypass. Token-scanned, not regexed, so the cluster is examined letter-by-letter.
    return shellTokens(cmd).some((t) => !t.op && statusClusterHasShort(t.text));
  }
  const prog = programWord(seg);
  return prog === 'find' || prog === 'ls';
}

/** Does this `git status` token's short-flag CLUSTER effectively enable `-s`/`--short`? Pure. Verified
 *  against real git (git 2.50.1): `-u` takes an OPTIONAL attached argument, so once `-u` appears in a cluster,
 *  every character AFTER it is consumed as `-u`'s mode value rather than parsed as further short flags —
 *  `git status -us` really means `--untracked-files=s` and git itself rejects it ("Invalid untracked files
 *  mode 's'"), so it is deliberately NOT treated as `-s` here. `-su` (the `-s` flag comes first, `-u` is last
 *  and takes no attached value) has no such consumption and genuinely IS `-s -u` — the PR #1816 review's
 *  confirmed bypass (`git status -su | xargs git add`). */
function statusClusterHasShort(text) {
  if (!/^-(?!-)[A-Za-z]+$/.test(text)) return false;
  const chars = text.slice(1);
  const uIdx = chars.indexOf('u');
  const effective = uIdx < 0 ? chars : chars.slice(0, uIdx + 1);
  return effective.includes('s');
}

/** The PIPE/`xargs`-SINK shape: a bare `|` (real data pipe, not `||`) from a path-enumeration source into a
 *  `git add` — directly, or through an `xargs` wrapper (`canonicalCommand`/`gitSubcommand` already peel that
 *  wrapper, #2367, so the sink segment resolves to `git add` either way). Pure. */
function pipeGitAddEnumerationReason(command) {
  const parsed = parseSegments(String(command || ''));
  if (parsed.unterminated) return null;
  const segs = parsed.segments;
  for (let i = 1; i < segs.length; i++) {
    if (!parsed.pipedFrom[i]) continue;
    if (gitSubcommand(segs[i]) === 'add' && isPathEnumerationSource(segs[i - 1])) return GIT_ADD_ENUMERATION_MESSAGE;
  }
  return null;
}

/** `command` with every QUOTED run (`'…'`, `"…"`, `$'…'`, `$"…"`) and `#` COMMENT blanked out — length
 *  preserved (so a `\b` word boundary lands where it would in the original), quote-aware via the same
 *  `scanRun` scanner every other parser in this file shares. The WHILE-READ/`-exec` regexes below scan THIS
 *  view, never the raw command: an adversarial review found the first cut ran them against raw text, so
 *  `git commit -m "while read f; do git add \"$f\"; done"` — a commit MESSAGE, never executed as shell syntax
 *  at all — read as a real while-loop and was wrongly denied (#2968 r1). `pipeGitAddEnumerationReason` above
 *  needs no such mask: it already goes through `parseSegments`/`gitSubcommand`/`canonicalCommand`, which
 *  resolve quoting token-by-token rather than pattern-matching raw text. */
function maskQuoted(command) {
  const s = String(command || '');
  let out = '';
  let i = 0;
  let atWordStart = true;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\n') { out += ch; i += 1; atWordStart = true; continue; }
    const run = scanRun(s, i, atWordStart);
    if (run && (run.kind === 'quote' || run.kind === 'unterminated' || run.kind === 'comment')) {
      out += ' '.repeat(run.end - i + 1);
      i = run.end + 1;
      atWordStart = false;
      continue;
    }
    if (run && (run.kind === 'escape' || run.kind === 'continuation')) {
      out += s.slice(i, run.end + 1);
      i = run.end + 1;
      atWordStart = false;
      continue;
    }
    out += ch;
    atWordStart = /[\s()]/.test(ch);
    i += 1;
  }
  return out;
}

/** The WHILE-READ-SINK shape: a `while … read …` loop whose body runs `git add` before the loop's OWN `done`.
 *  Bounded to one loop body (the negative lookahead stops at the first `done`), so an unrelated LATER loop —
 *  or an unrelated `git add` after this loop closes — can't be implicated. Matched against `maskQuoted`'s
 *  output, not raw text (#2968 r1). Same accidental-collision threat model as the rest of this file (#2367)
 *  — not adversarial-proof. */
const WHILE_READ_GIT_ADD = /\bwhile\b(?:(?!\bdone\b)[\s\S])*?\bread\b(?:(?!\bdone\b)[\s\S])*?\bgit\s+add\b(?:(?!\bdone\b)[\s\S])*?\bdone\b/;

/** The `-exec`-SINK shape: a `find … -exec[dir] … git add … ;`/`+` clause. Each `-exec` clause is scoped to
 *  the text BETWEEN it and its OWN terminator (`\;`, or `{}`-then-`+`, or a bare `+`), so an unrelated `git
 *  add` elsewhere on the same line can't be implicated. `masked` is `maskQuoted`'s output (#2968 r1) — a
 *  quoted `-exec`/`git add` inside a string is never mistaken for shell syntax. */
const EXEC_CLAUSE = /-exec(?:dir)?\b([\s\S]*?)(?:\\;|\{\}\s*\+|\+)/g;
function hasExecGitAdd(masked) {
  let m;
  EXEC_CLAUSE.lastIndex = 0;
  while ((m = EXEC_CLAUSE.exec(masked))) {
    if (/\bgit\s+add\b/.test(m[1])) return true;
  }
  return false;
}

/** The #2968 whole-command deny reason for the three sink shapes that need more than one segment to see
 *  (pipe/xargs, while-read, `-exec`) — the DIRECT shape (`-A`/`--all`/`.`) needs none of this and lives as a
 *  per-segment arm in `reason()` instead. Pure; called from `decide()` alongside the other whole-command
 *  checks (`commitIdentityCommandReason`, `backgroundedVerificationReason`). */
export function gitAddEnumerationReason(command) {
  const text = String(command || '');
  const p = pipeGitAddEnumerationReason(text);
  if (p) return p;
  const masked = maskQuoted(text);
  if (WHILE_READ_GIT_ADD.test(masked)) return GIT_ADD_ENUMERATION_MESSAGE;
  if (hasExecGitAdd(masked)) return GIT_ADD_ENUMERATION_MESSAGE;
  return null;
}

// ── xxna58l (#3383) — a session's direct raw invocation of a heavy command that SKIPS the #3461 admission
// queue entirely: the eleventy site build, a playwright run, any vitest test run, or a direct standards check. Each
// has a wrapped npm script that already routes through `heavy-admission.mjs run` (`build`, `test:unit`,
// `test:integration`/`test:e2e`/`test:smoke`/`test:a11y`/`test:interaction`) — this arm's job is to steer a
// session toward that wrapped script, not to reimplement the queue itself. Anchored on the ACTUAL RUNNER at
// command position (`canonicalCommand`'s npx/wrapper peel, same as every other arm here) — never a bare
// substring test, or the wrapped script's own `-- vitest run …` tail (which legitimately contains this text
// as an ARGUMENT, not a command) would be denied too.
//
// heavy-enforce (2026-10-04): even one test file spawns workers outside the host cap.
const PLAYWRIGHT_TEST_HEAD = /^playwright\s+test\b/;
const ELEVENTY_HEAD = /^(?:@11ty\/)?eleventy\b/;

/** Count positional test filters for full-suite detection. Known flag values, redirects, numbers,
 *  booleans and match-all filters do not select files; unknown options are handled conservatively. */
export function vitestRunFileTargetCount(tail) {
  const toks = shellTokens(String(tail || ''));
  let n = 0;
  for (let i = 0; i < toks.length; i += 1) {
    const { text: t, op } = toks[i];
    if (!t) continue;
    // #3383 (found live 2026-09-23): a redirection is not a file target — `shellTokens` marks `>`/`2>&` as an
    // operator and its target is the next word — and neither is the separately-worded VALUE of a flag that takes
    // one (`--root <dir>`, `-t <name>`). Counting them pushed a one-file run over the limit.
    if (op) { i += 1; continue; }
    if (t.startsWith('-')) {
      if (VITEST_VALUE_FLAGS.has(t)) { i += 1; continue; }
      // PR #2680 review — the value-flag list can never be complete, so also treat the word after an UNKNOWN
      // `--flag` (no `=`) as its value when that word cannot be a file target anyway: a number / boolean, or the
      // value of a dotted option (`--typecheck.tsconfig x.json`). Errs toward "not a target" (a deny).
      const next = toks[i + 1];
      if (next && !next.op && next.text && !next.text.startsWith('-') && !t.includes('=')
        && (t.startsWith('--') && t.slice(2).includes('.') || /^(?:\d+(?:\.\d+)?%?|true|false)$/.test(next.text))) i += 1;
      continue;
    }
    if (/^(?:\d+(?:\.\d+)?|true|false)$/.test(t)) continue;
    // xpnhz4o review — `.`, `./`, `..`, `*`, `**` filter NOTHING (vitest substring-matches every path), so they
    // are not a target: `npx vitest run .` is the whole suite and must count as zero.
    if (/^[./*]+$/.test(t)) continue;
    n += 1;
  }
  return n;
}

/** The vitest flags whose value may be a separate word. A value written `--flag=value` is one token and needs no entry. */
const VITEST_VALUE_FLAGS = new Set(['--root', '-r', '--dir', '--config', '-c', '--testNamePattern', '-t', '--reporter', '--project', '--outputFile', '--environment', '--shard', '--pool',
  // xpnhz4o review — a missing value flag let its VALUE read as a file target (`vitest run --exclude x/**`).
  '--exclude', '--testTimeout', '--hookTimeout', '--maxWorkers', '--minWorkers', '--retry', '--bail', '--mode', '--sequence.seed', '--browser.name', '--coverage.provider', '--coverage.reporter',
  '--maxConcurrency', '--slowTestThreshold', '--teardownTimeout']);

/**
 * Does a direct (unqueued) invocation of vitest/playwright/eleventy skip the #3461 admission queue? Pure,
 * unit-tested. Returns a reason naming the wrapped npm script to use instead, or null when the segment is not
 * one of these runners. All direct vitest test runs require admission.
 * `eleventy --version`/`--help`/`--dryrun` (no write at all — reuses
 * the SAME `ELEVENTY_NO_WRITE_FLAG` the tree-write arm already defines, one source of truth) and
 * `--serve`/`--watch` (a long-running dev server with no wrapped equivalent — wrapping it would hold an
 * admission slot for the whole dev session) are both exempt.
 *
 * THE ELEVENTY CHECK IS SKIPPED AT PRIMARY CWD (`primaryCwd: true`) — deliberately, not an oversight. A raw
 * `eleventy` invocation at primary cwd is ALREADY denied by the older, more specific #2749/#2788 tree-write
 * arm (`isTreeWritingBuildRun`/`primaryTreeWriteReason`), whose own message explains the PRIMARY-tree-safety
 * reason and is extensively pinned by the `#2788 r3: equivalent spellings decide identically` regression
 * corpus (dozens of eleventy spellings — subshells, `bash -c`, runner exec/dlx forms — each asserted to
 * produce that exact message at primary cwd). Firing this arm's DIFFERENT message there would silently
 * change what that whole corpus asserts for no behavioral gain (the command is denied either way). At a LANE
 * cwd the tree-write arm never fires at all (#2335 — a lane build is legitimate), which is exactly the gap
 * THIS arm exists to close: a raw eleventy call in a lane previously skipped the host-wide #3461 queue with
 * zero guard coverage. Vitest/playwright have no such competing arm, so they are NOT cwd-gated — the queue
 * concern is identical at primary and in a lane for those.
 */
export function rawHeavyCommandReason(segment, { primaryCwd = false } = {}) {
  const ungated = ungatedHeavyRunReason(segment);
  if (ungated) return ungated;
  const s = String(segment || '').trim();
  if (!s) return null;
  const cmd = s.replace(/^(?:\w+=\S+\s+)*(?:sudo\s+)?/, '');
  const canon = canonicalCommand(s);
  const heads = canon && canon !== cmd ? [cmd, canon] : [cmd];

  for (const h of heads) {
    if (PLAYWRIGHT_TEST_HEAD.test(h)) {
      return 'a direct `playwright test` run skips the #3461 heavy-command admission queue (xxna58l, #3383). Use the wrapped script instead — `npm run test:integration` / `test:e2e` / `test:smoke` / `test:a11y` / `test:interaction`, whichever matches what you need (each already routes through `node scripts/readiness/heavy-admission.mjs run`). No targeted-run exception here: playwright has no fast single-spec mode cheap enough to justify skipping the queue.';
    }
    const eleventyMatch = primaryCwd ? null : h.match(ELEVENTY_HEAD);
    if (eleventyMatch) {
      const args = h.slice(eleventyMatch[0].length);
      // Same three-way precedence `isTreeWritingBuildRun` already uses for this exact runner: `--serve`/
      // `--watch` always write (and are exempt from THIS arm regardless, see the function doc); a no-write
      // flag (`--version`/`--help`/`--dryrun`) writes nothing; otherwise an `--output=<scratch>` (the
      // `build:check` shape) writes nothing either — anything else is a real site-build write.
      const writesSite = ELEVENTY_WRITES_FLAG.test(args)
        ? false // long-running dev server — exempt from the QUEUE arm (see function doc), even though it DOES write
        : ELEVENTY_NO_WRITE_FLAG.test(args)
          ? false
          : !(() => { const out = (h.match(OUTPUT_FLAG) || [])[1]; return out && isScratch(out); })();
      if (writesSite) return 'a direct `eleventy` run (the site build) skips the #3461 heavy-command admission queue (xxna58l, #3383). Use the wrapped script instead: `npm run build` (routes through `node scripts/readiness/heavy-admission.mjs run`).';
    }
  }
  return null;
}

const VITEST_WORD = /^vitest(?:@\S*)?$/;
/** vitest's own entry scripts when run through `node` (`vitest/vitest.mjs`, `vitest/dist/cli.js`, `.bin/vitest`). */
const VITEST_NODE_ENTRY = /(?:^|\/)node_modules\/(?:vitest\/(?:vitest\.mjs|dist\/cli\.js)|\.bin\/vitest)$/;
/** vitest's watch mode spelled as a flag (`-w` is its short form); `--watch=false`/`=0` is NOT watch. */
const VITEST_WATCH_FLAG = /^(?:--watch|-w)(?:=(?:true|1|yes|on))?$/i;
/** npm options that choose WHICH package's `test` script runs; a replacement that drops them tests another package. */
const NPM_SCOPE_VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix', '-C']);
const NPM_SCOPE_BARE_FLAG = /^(?:-ws|--workspaces|--include-workspace-root|-iwr)$/;
const NODE_SCRIPT_WORD = /\.(?:[cm]?js|ts)$/;
const NODE_SCRIPT_VALUE_FLAGS = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader']);

/** How many leading words of a canonical head are exec wrappers `canonicalCommand` does not peel
 *  (`timeout [opts] <duration>`, and the `-n <N>` it leaves behind after peeling `nice`)? `nohup` is left
 *  alone on purpose: the background-run guard owns it, and a queued replacement keeping it would be denied there. */
function execWrapperWords(w) {
  if (w[0] === 'timeout') {
    let i = 1;
    while (w[i]?.startsWith('-')) i += /^(?:-s|-k|--signal|--kill-after)$/.test(w[i]) ? 2 : 1;
    return i + 1; // the duration
  }
  if (w[0] === '-n' && /^-?\d+$/.test(w[1] || '')) return 2;
  if (/^(?:-\d+|--adjustment=-?\d+)$/.test(w[0] || '')) return 1;
  return 0;
}

/** The raw source text of the given `headWords` entries, space-joined (quoting survives; only the gaps are normalised). */
function rawWords(src, words) {
  return words.map((word) => src.slice(word.start, word.end)).join(' ');
}

/** Is this word an npm scope option, and if so how many words does it span (the flag plus a separate value)? */
function npmScopeSpan(words, j) {
  const text = words[j]?.text || '';
  const name = text.split('=')[0];
  if (NPM_SCOPE_BARE_FLAG.test(name)) return 1;
  if (!NPM_SCOPE_VALUE_FLAGS.has(name) && !/^--(?:workspaces?|include-workspace-root)$/.test(name)) return 0;
  return text.includes('=') || !words[j + 1] ? 1 : 2;
}

/** Drop watch-mode flags (and a separate `true`/`false` value) from vitest argument words. A value flag's own
 *  separate value (`-t -w`) is a pattern, not a flag, so the pair is kept whole. */
function dropWatchFlags(words) {
  const out = [];
  for (let k = 0; k < words.length; k += 1) {
    const text = words[k].text;
    if (VITEST_VALUE_FLAGS.has(text) && words[k + 1]) { out.push(words[k], words[k + 1]); k += 1; continue; }
    if (VITEST_WATCH_FLAG.test(text)) { if (/^(?:true|false)$/i.test(words[k + 1]?.text || '')) k += 1; continue; }
    out.push(words[k]);
  }
  return out;
}

/** Drop every watch-mode flag from a forwarded vitest argument string (unchanged when it has none). */
function withoutWatchFlags(args) {
  const words = headWords(args);
  const kept = dropWatchFlags(words);
  return kept.length === words.length ? args : rawWords(args, kept);
}

/**
 * Turn a vitest command line (any head: `npx vitest`, `pnpm vitest`, `node …/vitest.mjs`) into a one-shot run:
 * watch flags are dropped, a `watch`/`dev` subcommand becomes `run`, and `run` is added when nothing names a mode
 * (a bare `vitest <file>` would start watch mode in a TTY). `related` has no `run`; it takes `--run` instead.
 */
function oneShotVitest(command) {
  const words = headWords(command);
  const at = words.findIndex((word) => VITEST_WORD.test(word.text) || VITEST_NODE_ENTRY.test(word.text));
  if (at < 0) return command;
  const head = words.slice(0, at + 1);
  const rest = dropWatchFlags(words.slice(at + 1));
  let out = rawWords(command, head);
  const sub = rest[0]?.text;
  if (sub === 'watch' || sub === 'dev') out += ' run' + (rest.length > 1 ? ' ' + rawWords(command, rest.slice(1)) : '');
  else if (sub === 'related') out += ' ' + rawWords(command, rest) + (rest.some((word) => word.text === '--run') ? '' : ' --run');
  else if (sub === 'run' || VITEST_NON_RUN_SUBCOMMANDS.has(sub)) out += ' ' + rawWords(command, rest);
  else out += ' run' + (rest.length ? ' ' + rawWords(command, rest) : '');
  return out;
}

/** Classify only the executable head, never a tool name mentioned in an argument. */
function ungatedHeavyHead(head, depth = 0) {
  if (depth > 8) return null;
  const words = headWords(head);
  const w = words.map((word) => word.text);
  const wrapped = execWrapperWords(w);
  if (wrapped && words[wrapped]) return ungatedHeavyHead(canonicalCommand(head.slice(words[wrapped].start)), depth + 1);
  if (VITEST_WORD.test(w[0] || '')) {
    // `related` selects tests, but still starts workers; --changed does too.
    if (VITEST_NON_RUN_SUBCOMMANDS.has(w[1]) && w[1] !== 'related') return null;
    if (w.slice(1).some((arg) => /^(?:--version|-v|--help|-h)$/.test(arg))) return null;
    return { kind: 'vitest', watch: w[1] === 'watch' || w[1] === 'dev' || w.slice(1).some((arg) => VITEST_WATCH_FLAG.test(arg)) };
  }
  if (w[0] === 'node') {
    // Only the script position is executable. --check/-c and eval arguments are not scripts.
    let i = 1;
    while (w[i]?.startsWith('-') && w[i] !== '--') {
      if (/^(?:--check|-c|--eval|-e|--print|-p)(?:=|$)/.test(w[i])) return null;
      const flag = w[i];
      i += 1;
      if (NODE_SCRIPT_VALUE_FLAGS.has(flag)) i += 1;
      // a separate option value (`--title standards`, `--env-file .env`, `--max-old-space-size 4096`) is not the script
      else if (!flag.includes('=') && w[i] && !w[i].startsWith('-') && !NODE_SCRIPT_WORD.test(w[i])) i += 1;
    }
    if (w[i] === '--') i += 1;
    if (/(?:^|\/)check-standards\.mjs$/.test(w[i] || '')) {
      return { kind: 'standards', tail: head.slice(words[i].end).trim() };
    }
    if (VITEST_NODE_ENTRY.test(w[i] || '')) {
      return ungatedHeavyHead('vitest' + head.slice(words[i].end), depth + 1);
    }
    return null; // Includes heavy-admission: its child is an argument, not the executable.
  }
  const inv = runnerInvocation(head);
  if (inv?.exec) return ungatedHeavyHead(canonicalCommand(inv.exec), depth + 1);
  // pnpm/yarn/bun resolve a bare `vitest` script name to the vitest bin (npm does not).
  if (w[0] !== 'npm' && inv?.names?.length === 1 && VITEST_WORD.test(inv.names[0])) {
    return ungatedHeavyHead('vitest' + head.slice(words[w.indexOf(inv.names[0], 1)].end), depth + 1);
  }
  let at = -1;
  const scope = []; // npm's package-selecting options (`-w x`, `--prefix x`, …), kept in the replacement
  if (w[0] === 'npm') { // runner flags may precede the subcommand: `npm -s test`, `npm --prefix . test`
    let j = 1;
    while (w[j]?.startsWith('-')) {
      const span = npmScopeSpan(words, j);
      if (span) scope.push(rawWords(head, words.slice(j, j + span)));
      j += span || (!w[j].includes('=') && RUNNER_VALUE_FLAGS.has(w[j]) ? 2 : 1);
    }
    if (['test', 't', 'tst'].includes(w[j])) at = j;
  }
  if (at < 0 && inv?.names?.length === 1) at = w.indexOf(inv.names[0], 1);
  if (at < 0 || !['test', 't', 'tst'].includes(w[at])) return null;
  const i = at;
  // Options between the script name and `--` still belong to npm (`npm test -w x -- a.test.mjs`): keep its scope
  // flags and any positional filter, drop the rest; only what follows `--` is forwarded to vitest verbatim.
  const after = words.slice(i + 1);
  const dd = after.findIndex((word) => word.text === '--');
  // With no `--`, npm still parses every option, so scope flags anywhere after the script name are npm's.
  const kept = [];
  for (let k = 0; k < (dd < 0 ? after.length : dd); k += 1) {
    const span = npmScopeSpan(after, k);
    if (span) { scope.push(rawWords(head, after.slice(k, k + span))); k += span - 1; }
    else if (dd < 0 || !after[k].text.startsWith('-')) kept.push(after[k]);
  }
  let forwarded = [rawWords(head, kept), dd < 0 ? '' : head.slice(after[dd].end).trim()].filter(Boolean).join(' ');
  forwarded = withoutWatchFlags(forwarded.replace(/^--(?:\s+|$)/, ''));
  // A forwarded vitest subcommand (`related`, `list`, `bench`, ...) has no `test:unit` equivalent: after
  // `vitest run` it would degrade to a filename filter (`related a.mjs --passWithNoTests` silently runs nothing).
  if (VITEST_NON_RUN_SUBCOMMANDS.has(forwarded.split(/\s+/)[0])) return { kind: 'test', subcommand: true, tail: forwarded, scope };
  // `npm test -- run <f>` forwards vitest's own mode word; `test:unit` already runs `vitest run`, so drop it.
  return { kind: 'test', tail: forwarded.replace(/^(?:run|watch|dev)(?:\s+|$)/, ''), scope };
}

/** Deny any unqueued test/standards execution, with a runnable replacement. Pure; no escape. */
export function ungatedHeavyRunReason(segment) {
  const s = String(segment || '').trim();
  const run = ungatedHeavyHead(canonicalCommand(s));
  if (!run) return null;
  // Keep assignment spelling/quoting intact, placing it before node so it remains shell syntax. A leading
  // `WE_FULL_SUITE_OK=1` is kept too: the queued full-suite form still needs it to pass the xpnhz4o arm.
  const words = headWords(s);
  let i = words[0]?.text === 'env' ? 1 : 0;
  const prefix = i ? ['env'] : [];
  while (/^[A-Za-z_]\w*=/.test(words[i]?.text || '')) {
    prefix.push(s.slice(words[i].start, words[i].end));
    i += 1;
  }
  const env = prefix.length ? prefix.join(' ') + ' ' : '';
  const command = i ? s.slice(words[i]?.start ?? s.length) : s;
  const queued = 'node scripts/readiness/heavy-admission.mjs run -- ';
  const scope = run.scope?.length ? run.scope.join(' ') + ' ' : '';
  const replacement = run.kind === 'test'
    ? run.subcommand
      ? queued + (scope ? 'npm ' + scope + 'exec -- vitest ' : 'npx vitest ') + run.tail
      : 'npm ' + scope + 'run test:unit' + (run.tail ? ' -- ' + run.tail : '')
    : run.kind === 'standards'
      ? 'npm run check:standards' + (run.tail ? ' -- ' + run.tail : '')
      // a watch/dev process would hold one of the host's 2 admission slots until killed, so queue `run` instead
      : queued + (run.watch ? oneShotVitest(command) : command);
  // A replacement the full-suite arm would itself deny (a whole-suite `npm -s test`, `timeout 5 npm test`, or a
  // flag-only tail like `-- --coverage`, which still selects every file) is a deny loop: give that arm's message,
  // which already names the runnable alternatives. Its escape, when present, is kept in `env` above. (A bare
  // vitest run never reaches here from `decide`: the full-suite arm runs first and denies it with that message.)
  if (run.kind === 'test' && !hasLeadingEnvEscape(s, FULL_SUITE_ESCAPE_ENV) && fullSuiteRunReason(replacement)) {
    return FULL_SUITE_DENY_MESSAGE;
  }
  return `heavy-enforce: each direct run spawns ~6–11 workers outside the host cap of 2 queued heavy runs; load hit 25–48 on a 12-core host. There is no admission override. Use: \`${env}${replacement}\`.`;
}

// ── xpnhz4o — a BARE FULL-SUITE run from an agent session ─────────────────────────────────────────────────
// Operator instruction 2026-09-25: "run the minimum of unit tests … and ideally enforce". Observed that day:
// dispatched fixers each ran `npm run test:unit` (10+ minutes), several at once, host load 1.8/core — lane pickup
// starved and every review blocked. The admission queue (#3461) only SERIALISES that cost; this arm removes it:
// the local gate is `verify-lane` (diff-selected tests, `test-selection.mjs#decideLocalSelection`, full-suite
// fallback stated in its own output), and CI runs the full suite on every PR as the backstop.
//
// SCOPE — every session this hook runs in. A PreToolUse hook only ever runs inside a Claude Code session, so CI,
// the drain, the verify runner (`verify-lane` spawns the suite as its own child, never through a Bash tool call)
// and the operator's own terminal are untouched by construction. The existing `WE_DISPATCH_KIND` signal is NOT
// enough here: the live offenders (reconcile-dispatched fixers) carry no `WE_DISPATCH_KIND` at all.
//
// ESCAPE — `WE_FULL_SUITE_OK=1` as a LEADING assignment on the segment (`hasLeadingEnvEscape`, so a mention
// never disarms it). Every use is logged by the CLI (stderr, the hook's systemMessage, and a JSON line in the
// gitignored `.conveyor/full-suite-escape.log`).

/** The npm scripts that run the whole unit suite when given no file target. */
const FULL_SUITE_SCRIPTS = new Set(['test', 'test:unit', 'test:coverage']);
/** vitest subcommands that are not a suite run (or already select by diff). */
const VITEST_NON_RUN_SUBCOMMANDS = new Set(['related', 'list', 'bench', 'init', 'typecheck']);
const VITEST_INFO_FLAG = /^(?:--version|-v|--help|-h|--changed(?:=.*)?)$/;
const HEAVY_ADMISSION_SCRIPT = /(?:^|\/)heavy-admission\.mjs$/;

/**
 * Does this canonical command head run the WHOLE unit suite (no file target)? Pure. Recognises `npm test` /
 * `npm run test:unit` / `test:coverage` (and the pnpm/yarn/bun spellings), `vitest` / `vitest run` / `vitest
 * watch` with no positional file filter, and any of those behind `heavy-admission.mjs run [--]`. A positional
 * file target (after `--` for a runner) makes it a targeted run and it is NOT matched.
 * @param {string} head a `canonicalCommand` result
 * @returns {boolean}
 */
export function isFullSuiteHead(head, depth = 0) {
  const h = String(head || '');
  const words = headWords(h);
  if (!words.length || depth > 3) return false;
  const w = words.map((x) => x.text);
  if (w[0] === 'node' && HEAVY_ADMISSION_SCRIPT.test(w[1] || '') && w[2] === 'run') {
    const k = w[3] === '--' ? 4 : 3;
    return k < words.length && isFullSuiteHead(canonicalCommand(h.slice(words[k].start)), depth + 1);
  }
  // PR #2680 review — `run-s test:unit` / `npm-run-all --parallel lint test:unit` run the same whole suite; a
  // multi-script runner cannot forward a file target to one of its scripts, so any full-suite name is a deny.
  if (MULTI_SCRIPT_RUNNERS.has(w[0])) {
    const inv = runnerInvocation(h);
    return !!(inv && Array.isArray(inv.names) && inv.names.some((n) => FULL_SUITE_SCRIPTS.has(n)));
  }
  // vitest's own entry scripts behind `node` (`node node_modules/vitest/dist/cli.js`) are the same bare run.
  if (w[0] === 'node' && VITEST_NODE_ENTRY.test(w[1] || '')) return isFullSuiteHead('vitest' + h.slice(words[1].end), depth + 1);
  if (RUNNER_NAMES.has(w[0])) {
    let idx = -1;
    if (w[0] === 'npm' && ['test', 't', 'tst'].includes(w[1])) { idx = 1; w[1] = 'test'; }
    else {
      const inv = runnerInvocation(h);
      const name = inv && Array.isArray(inv.names) && inv.names.length === 1 ? inv.names[0] : null;
      if (name) idx = w.indexOf(name, 1);
      if (idx > 0 && (name === 't' || name === 'tst')) w[idx] = 'test';
    }
    if (idx < 0 || !FULL_SUITE_SCRIPTS.has(w[idx])) return false;
    // `npm test -- run` forwards vitest's own `run` subcommand — a mode word, not a file target.
    let from = idx + 1;
    if (w[from] === '--') from += 1;
    if (['run', 'watch', 'dev'].includes(w[from])) from += 1;
    return vitestRunFileTargetCount(from < words.length ? h.slice(words[from].start) : '') === 0;
  }
  if (w[0] === 'vitest') {
    if (VITEST_NON_RUN_SUBCOMMANDS.has(w[1])) return false;
    if (w.slice(1).some((t) => VITEST_INFO_FLAG.test(t))) return false;
    const from = ['run', 'watch', 'dev'].includes(w[1]) ? words[1].end : words[0].end;
    return vitestRunFileTargetCount(h.slice(from)) === 0;
  }
  return false;
}

/**
 * Deny reason for a bare full-suite run, or null. Pure. See the block comment above for scope and escape.
 * @param {string} segment
 * @returns {string|null}
 */
export function fullSuiteRunReason(segment) {
  const s = String(segment || '').trim();
  if (!s || hasLeadingEnvEscape(s, FULL_SUITE_ESCAPE_ENV)) return null;
  const stripped = s.replace(/^(?:\w+=\S*\s+)*/, '');
  const canon = canonicalCommand(s);
  if (!isFullSuiteHead(stripped) && !isFullSuiteHead(canon)) return null;
  // No heavy-enforce replacement is appended: for a bare (no file target) run it would be this arm's own deny
  // again, or a literal `<test-file>` placeholder. The message already names the runnable alternatives.
  return FULL_SUITE_DENY_MESSAGE;
}

const FULL_SUITE_DENY_MESSAGE = 'a bare FULL-SUITE unit run (`npm run test:unit` / `npm test` / `vitest` or `vitest run` with no file target, raw or through heavy-admission.mjs) is not allowed from an agent session (xpnhz4o). It takes 10+ minutes; several at once starved the host on 2026-09-25; CI already runs the full suite on every PR as the backstop. Run the diff-selected gate instead: `node scripts/verify-lane.mjs run` — only the tests your diff reaches, plus a scoped check:standards; it falls back to the full suite BY ITSELF, and says so, when a config / setup / dependency / shared-test-helper file changed (use plain `node scripts/verify-lane.mjs` to also record the landing marker). For one or two files: `node scripts/readiness/heavy-admission.mjs run -- npx vitest run <file>`. Escape, only when you truly need the whole suite here (logged): prefix the command with `WE_FULL_SUITE_OK=1`.';

/** The leading-assignment escape for {@link fullSuiteRunReason}. */
export const FULL_SUITE_ESCAPE_ENV = 'WE_FULL_SUITE_OK';

/** Did this (allowed) command use the full-suite escape on a segment that would otherwise be denied? Pure. */
export function fullSuiteEscapeUsed(command) {
  const { segments } = parseSegments(heredocScan(String(command || '')).text);
  return segments.some((seg) => {
    const s = String(seg || '').trim();
    if (!hasLeadingEnvEscape(s, FULL_SUITE_ESCAPE_ENV)) return false;
    return isFullSuiteHead(s.replace(/^(?:env\s+)?(?:\w+=\S*\s+)*/, '')) || isFullSuiteHead(canonicalCommand(s));
  });
}

/** Return a deny reason for one shell segment, or null to allow. Pure. `ctx.primaryCwd` = the Bash cwd is a
 *  constellation primary checkout (computed by the CLI via isPrimaryCwd) — gates the #2302 backlog-mutation rule.
 *  `ctx.staleBehind` = how many commits the lane's HEAD sits behind its upstream (computed by the CLI via a git
 *  call — kept out of this pure function so it stays unit-testable with a plain number) — gates the #2323 rule.
 *  `ctx.foreignLiveLease` = this lane clone carries a LIVE UNMARKED lease held by a DIFFERENT session (computed
 *  by the CLI via a lease-file read + a durable session-id compare — kept out of this pure function for the same
 *  reason) — gates the #2367 destructive-op rule. `ctx.markedLeaseSlug` = this lane clone carries a LIVE MARKED
 *  (workflowLane) lease whose minted slug is this string (computed by the CLI via the lease read) — gates the
 *  #2413 fail-closed destructive-op rule, which SUPERSEDES the #2367 ownerSession compare for a marked lane.
 *  `ctx.contestedHolderSlug` = this lane clone carries a LIVE UNMARKED lease that is CONTESTED (a SIBLING live
 *  lease in the same pool shares its `ownerSession`) and whose minted per-holder slug is this string (computed
 *  by the CLI via the lease read + a sibling-lease scan) — gates the #2997 fail-closed destructive-op rule,
 *  which supersedes the #2367 ownerSession compare in exactly the topology where that compare cannot answer. */
/**
 * THE WRAPPER-OWNED AGENT KINDS, and — per kind — who owns each lifecycle command the table below denies.
 *
 * KEYED ON `WE_DISPATCH_KIND`'s WRAPPER-AGENT HALF (#3627 `delivery`, #3640 `repair`), never on a LAUNCH kind.
 * See the deny block in {@link reason} for the full reasoning; in one line: a value in
 * `we:scripts/operations/dispatch-lane.mjs#LAUNCH_KINDS` names an agent that IS the dispatch and runs its own
 * lifecycle from a full brief, and a value here names a restricted worker whose wrapper runs that lifecycle
 * for it. Only the second may be denied its own first step.
 *
 * THE PER-KIND TEXT IS NOT DECORATION. Each entry names the function in that kind's own wrapper that actually
 * runs the denied command, so an agent that hits a deny is told who does the thing instead of it — and so a
 * later reader can check the claim. The two kinds genuinely differ (a repair updates an EXISTING PR and never
 * claims an item; a delivery opens a PR and does claim one), and a shared message would be false for one of
 * them, which is precisely the class of stale note #3645 had to come back and correct here.
 *
 * THE KEYS ARE RE-STATED AS LITERALS RATHER THAN IMPORTED — the same trade `dispatch-lane-io.mjs`'s own
 * `BUILD_DISPATCH_MODE_ENV` documents. This file is a `PreToolUse` hook that runs on EVERY Bash call in every
 * session; it deliberately has no imports at all, and pulling in `dispatch-lane.mjs` (and its registry and
 * step-kinds graph) to read two strings would put that whole graph on the hook's startup path. The no-drift
 * guarantee is bought back by a test instead (`./__tests__/guard-bash.test.mjs` asserts these keys equal
 * `WRAPPER_AGENT_KINDS`), which is where a static fact belongs.
 */
export const WRAPPER_OWNED_AGENTS = Object.freeze({
  delivery: Object.freeze({
    agent: 'delivery',
    wrapper: 'deliver-item-wrapper.mjs',
    laneFns: '`acquireLane`/`releaseClaimAndLane`',
    gateFn: 'runGateWithOneRetry',
    claim: 'the wrapper claims the item before the agent is ever spawned (`claimItem`); a second claim from inside the agent is redundant at best and a race at worst',
    release: 'release is decided by the wrapper reading the agent\'s own structured report (`releaseClaimAndLane`), never by the agent releasing its own claim mid-build',
    ghPr: 'it never opens, watches, labels, or merges its own PR (FIRM REQUIREMENT 2 in deliver-item-wrapper.mjs; `openPr` is the only caller, and only after the gate and converge have both run)',
    openPr: 'opening the PR is the wrapper\'s own job (`openPr`), driven by a park decision the agent never computes',
    converge: 'it never initiates review of its own diff (FIRM REQUIREMENT 1 in deliver-item-wrapper.mjs; the wrapper\'s `runConverge` drives the whole loop, after the agent has already exited)',
  }),
  repair: Object.freeze({
    agent: 'repair (fix / ci-heal)',
    wrapper: 'fix-dispatch-wrapper.mjs',
    laneFns: '`acquireLane`/`releaseAllPools`',
    gateFn: 'runFixGateWithOneRetry',
    claim: 'a repair dispatch never claims a backlog item at all — it repairs an EXISTING PR, whose item was claimed (and is still held, or was already released) by the build that opened it',
    release: 'a repair dispatch never holds a backlog claim to release — see `backlog.mjs claim` above; releasing one it does not hold would strip it from whoever does',
    ghPr: 'the wrapper reads the PR itself (`resolveFixTarget`\'s own `gh pr view`) and hands the agent the reviewer\'s finding as a plain file in its lane, and it owns every label move through `rearm-review.mjs`/`stand-down.mjs`',
    openPr: 'a repair never opens a PR — it re-pushes HEAD to the existing PR\'s own `lane/*` ref (`pushLaneRef`), and even that is the wrapper\'s call, made only after the gate and converge have both passed',
    converge: 'it never initiates review of its own diff — that self-review-inside-the-agent\'s-own-turn step is exactly what #3629 moved OUT of the fixer\'s brief; the wrapper\'s own `runConverge` pass is the ratified replacement, and it runs after the agent has exited',
  }),
});

/**
 * #3383 — deny a DISPATCHED agent's Bash segment that names the usage-report tool's external admin-key
 * location. See the header bullet above for the full reasoning; in one line: `--restricted` confines the
 * FILE tools to the lane cwd already, but re-enables Bash, and this arm closes the resulting gap for the one
 * remaining tool. Pure, text-pattern match — the SAME class of honest limit this file's other content checks
 * carry (never proven un-obfuscatable, real additional enforcement regardless). Scoped to `dispatchKind`
 * truthy ONLY; returns null unconditionally for the operator's own interactive session.
 *
 * PR #2570 review — the match is made against the text the SHELL would hand the program, not the literal
 * spelling, because each of these still reaches the real file and a literal match missed all of them:
 *   • case: compared lowercased — macOS APFS is case-insensitive, so `~/.WE-USAGE-REPORT/.env` IS the file;
 *   • quoting/escaping: quotes and escaping backslashes are dropped (`~/.we\-usage\-report`,
 *     `~/.we'-'usage-report`), but a glob char, `$` or backtick the shell would NOT expand (single-quoted,
 *     escaped; globs also double-quoted) is neutralized first — so `rg 'import .* from'` is not a glob;
 *   • expansion: a HOME-rooted path (`~`, `~user`, `$HOME`, `${HOME…}`, the literal home dir) whose first
 *     component — or any component after a `..` — carries `$` or a backtick is denied outright: its final
 *     spelling is unknowable to a text check (`~/.${P1}-${P2}`, `$HOME/$D`, `~/.$(… | base64 -d)`);
 *   • globs/braces: any dot-leading word whose glob/brace pattern MATCHES the secret dir's name is denied
 *     (`.w*-usage-report`, `.[w]e-usage-*`, `.we-usage-{report,x}`), home-rooted or not. The matcher is a
 *     linear-time scan, never a generated regex (a `*`-run regex backtracks for minutes on this hot path);
 *   • Keychain: `security dump-keychain`, or a `security find-*-password` whose arguments carry an expansion.
 * Still a text check (the honest limit above): e.g. `cd ~; X=.we-usage; cat $X-report/.env` is not caught.
 */
export function usageReportSecretReadReason(segment, dispatchKind) {
  if (!dispatchKind) return null;
  const dir = usageReportSecretDir();
  const text = shellVisibleText(String(segment || ''));
  const lowerDir = dir.toLowerCase();
  const namesSecret = text.includes(lowerDir) || text.includes(USAGE_REPORT_KEYCHAIN_SERVICE.toLowerCase());
  if (!namesSecret && !homeRootedExpansion(text, lowerDir) && !secretDirGlobMatch(text, lowerDir)
    && !keychainExpansion(text)) return null;
  return `a mechanically-dispatched ${dispatchKind} agent may not reference the usage-report tool's external admin-key location (${dir}, or its Keychain service \`${USAGE_REPORT_KEYCHAIN_SERVICE}\`) at all (#3383) — that key must never reach a dispatched agent's process. There is no override.`;
}

// Lowercased text with quoting removed. A char the shell passes through LITERALLY despite looking special
// (a glob char / `$` / backtick inside single quotes or after `\`; a glob char inside double quotes) becomes
// NEUTRAL, which no later check treats as a wildcard or an expansion.
const NEUTRAL = '\u0001';
const GLOB_CHARS = new Set(['*', '?', '[', ']', '{', '}']);
function shellVisibleText(raw) {
  let out = '';
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else out += GLOB_CHARS.has(c) || c === '$' || c === '`' ? NEUTRAL : c;
    } else if (c === '\\' && i + 1 < raw.length) {
      const n = raw[++i];
      out += GLOB_CHARS.has(n) || n === '$' || n === '`' ? NEUTRAL : n;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else out += GLOB_CHARS.has(c) ? NEUTRAL : c;
    } else if (c === "'" || c === '"') quote = c;
    else out += c;
  }
  return out.toLowerCase();
}

function homeRootedExpansion(text, lowerDir) {
  const home = lowerDir.slice(0, lowerDir.lastIndexOf('/')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `~` only at a word start (not `HEAD~1:src/$F`), which also keeps the scan linear on a run of `~`.
  const rooted = new RegExp(`(?:(?<![^\\s=:])~[^/\\s~]{0,32}|\\$home|\\$\\{home[^}]{0,32}\\}|${home})/([^\\s;|&<>()]*)`, 'g');
  for (const m of text.matchAll(rooted)) {
    const comps = m[1].split('/').filter((c) => c && c !== '.');
    if (/[$`]/.test(comps[0] || '')) return true;
    const up = comps.indexOf('..');
    if (up >= 0 && comps.slice(up).some((c) => /[$`]/.test(c))) return true;
  }
  return false;
}

function keychainExpansion(text) {
  if (!/\bsecurity\s/.test(text)) return false;
  if (/\bdump-keychain\b/.test(text)) return true;
  return /\bfind-(?:generic|internet)-password\b/.test(text) && /[$`]/.test(text);
}

// Does a dot-leading glob/brace path component that could sit directly in a home dir — a word's first
// component, or the one right under a home root — expand to the secret dir's own name? (`src/.*` cannot reach
// it.) A component not starting with `.` cannot either: bash never lets `*`/`?`/`[…]` match a leading dot.
function secretDirGlobMatch(text, lowerDir) {
  const name = lowerDir.slice(lowerDir.lastIndexOf('/') + 1);
  const home = lowerDir.slice(0, lowerDir.lastIndexOf('/') + 1);
  for (const word of text.split(/[\s;|&<>()=`]+/)) {
    const rest = word.startsWith(home) ? word.slice(home.length) : word;
    const comps = rest.split('/').filter((c) => c && c !== '.');
    const underHome = rest !== word || /^(?:~|\$home|\$\{home)/.test(rest);
    const part = (underHome ? comps[1] : comps[0]) || '';
    if (part.length > 256 || !/[*?[{]/.test(part)) continue;
    for (const alt of expandBraces(part)) {
      if (alt.startsWith('.') && globMatch(globTokens(alt), name)) return true;
    }
  }
  return false;
}

// Bash brace expansion, capped. A sequence (`{a..z}`) becomes `*` — fail closed rather than enumerate it.
function expandBraces(word, cap = 64) {
  const open = word.indexOf('{');
  if (open < 0) return [word];
  let depth = 0;
  const cuts = [];
  for (let i = open; i < word.length; i++) {
    if (word[i] === '{') depth++;
    else if (word[i] === '}' && --depth === 0) {
      const body = word.slice(open + 1, i);
      const alts = [];
      let d = 0; let from = 0;
      for (let j = 0; j < body.length; j++) {
        if (body[j] === '{') d++;
        else if (body[j] === '}') d--;
        else if (body[j] === ',' && d === 0) { alts.push(body.slice(from, j)); from = j + 1; }
      }
      alts.push(body.slice(from));
      const head = word.slice(0, open);
      const tails = expandBraces(word.slice(i + 1), cap);
      const mids = alts.length > 1 ? alts.flatMap((a) => expandBraces(a, cap))
        : body.includes('..') ? ['*'] : [`{${body}}`];
      for (const mid of mids) for (const tail of tails) {
        if (cuts.length >= cap) return cuts;
        cuts.push(head + mid + tail);
      }
      return cuts;
    }
  }
  return [word]; // unbalanced — bash leaves it literal
}

// A glob as tokens: '*' | a per-char predicate. `[…]` handles `!`/`^`, a leading `]`, ranges, and treats a
// POSIX `[:class:]` as matching anything (fail closed).
function globTokens(glob) {
  const tokens = [];
  // Once a `[` finds no closing `]`, no later `[` can either — stop rescanning (keeps a `[[:[[:…` run linear).
  let unclosed = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (tokens[tokens.length - 1] !== '*') tokens.push('*'); continue; }
    if (c === '?') { tokens.push(() => true); continue; }
    if (c === '[' && !unclosed) {
      let j = i + 1;
      const negate = glob[j] === '!' || glob[j] === '^';
      if (negate) j++;
      const start = j;
      if (glob[j] === ']') j++;
      const lastColonClose = glob.lastIndexOf(':]');
      while (j < glob.length && glob[j] !== ']') {
        const close = glob.startsWith('[:', j) && lastColonClose > j + 1 ? glob.indexOf(':]', j + 2) : -1;
        j = close > 0 ? close + 2 : j + 1;
      }
      if (j >= glob.length) unclosed = true;
      else {
        const body = glob.slice(start, j);
        const any = body.includes('[:');
        tokens.push((ch) => negate !== (any || inClass(body, ch)));
        i = j;
        continue;
      }
    }
    tokens.push((ch) => ch === c);
  }
  return tokens;
}

function inClass(body, ch) {
  for (let k = 0; k < body.length; k++) {
    if (body[k + 1] === '-' && k + 2 < body.length) {
      if (ch >= body[k] && ch <= body[k + 2]) return true;
      k += 2;
    } else if (body[k] === ch) return true;
  }
  return false;
}

// Classic single-backtrack wildcard match — O(pattern × name), no regex.
function globMatch(tokens, s) {
  let t = 0; let i = 0; let starT = -1; let starI = 0;
  while (i < s.length) {
    if (tokens[t] === '*') { starT = t++; starI = i; continue; }
    if (t < tokens.length && tokens[t](s[i])) { t++; i++; continue; }
    if (starT < 0) return false;
    t = starT + 1;
    i = ++starI;
  }
  while (tokens[t] === '*') t++;
  return t === tokens.length;
}

export function reason(segment, { primaryCwd = false, staleBehind = 0, foreignLiveLease = false, markedLeaseSlug = null, contestedHolderSlug = null, dispatchKind = null, cwd = null, daemonCloneRoots = [], fixClaimedBranches = [], pushTargets = [], fixPushes = [] } = {}) {
  const s = segment.trim();
  if (!s) return null;

  // #3383 — checked FIRST, unconditionally on the segment text: cheap, and must fire regardless of cwd/lease
  // context (unlike the arms below, which are gated on primaryCwd or a specific WE_DISPATCH_KIND value).
  const usageSecret = usageReportSecretReadReason(s, dispatchKind);
  if (usageSecret) return usageSecret;

  // #xpt9fvd — a write targeting a DAEMON CLONE. Checked early and unconditionally (independent of
  // `primaryCwd`/lease context — a daemon clone is neither a primary checkout nor an ordinary leased lane):
  // see `daemonCloneWriteReason`'s own doc for the two shapes it catches and the one it deliberately does not.
  const daemonWrite = daemonCloneWriteReason(s, { cwd, roots: daemonCloneRoots });
  if (daemonWrite) return daemonWrite;

  // xpnhz4o — a bare full-suite run. Before the raw-heavy arm so a bare `vitest run` gets THIS message (which
  // names the selected gate) rather than one steering to `npm run test:unit`, itself now denied here.
  const fullSuite = fullSuiteRunReason(s);
  if (fullSuite) return fullSuite;

  // xxna58l (#3383) — a raw, unqueued vitest/playwright/eleventy invocation. Checked next, right after the
  // usage-report check above: cheap, unconditional (the only cwd-gating is eleventy's own, INSIDE
  // rawHeavyCommandReason — see its doc), and independent of everything below it.
  const rawHeavy = rawHeavyCommandReason(s, { primaryCwd });
  if (rawHeavy) return rawHeavy;

  // #2302 — a backlog item-mutation (claim/resolve/scaffold/…) run from the PRIMARY checkout stamps the item on
  // primary and bypasses lane isolation (found working #2095: a primary `claim` flipped open→active, reverted +
  // re-run in the lane). Deny it and steer to a lane — the same invariant guard-lane enforces for Edit/Write.
  // Only fires when cwd is a primary (a lane clone is allowed). #2219 ratified that NO item-file frontmatter
  // transition ever splices to primary (everything rides the lane→PR) — so unlike MAIN_PUSH_OK/STALE_LANE_OK,
  // there is no legitimate direct-to-primary case left to escape-hatch for. #2339 — the former
  // `BACKLOG_MUTATE_OK=1` override was itself the hole (used in error 2026-07-09, defeating this very guard);
  // removed. This denial is now UNCONDITIONAL — primary stays read-only in fact, not just by convention.
  if (primaryCwd && isBacklogMutation(s))
    return 'Backlog item-mutations (claim/resolve/scaffold/settle/retype/yield/prepare-stamp) must run in a LANE clone, not the primary checkout — running backlog.mjs here mutates the item on primary and bypasses lane isolation (#2302/#104/#2219). cd into your lane clone (~/workspace/.lanes/<repo>/lane-N) and run it there. There is no override — #2219 ratified that nothing ever splices to primary (#2339).';

  // #2323 — a backlog item-mutation run in a lane clone that is BEHIND its upstream runs STALE `scripts/`
  // against a STALE backlog view: a pool lane handed out N commits behind origin/main once ran the pre-#2288
  // "next free NNN" allocator and minted a colliding/low-gap number. Only fires when cwd is a lane (never a
  // primary — that path is already denied above) AND the CLI found it behind. Sanctioned override: STALE_LANE_OK=1.
  if (!primaryCwd && staleBehind > 0 && isBacklogMutation(s) && !/\bSTALE_LANE_OK=1\b/.test(s))
    return `This lane clone is ${staleBehind} commit(s) behind origin/main — a mutation here would run STALE scripts/ against a STALE backlog view and can mint a colliding/wrong NNN (#2323). Refresh first: \`git fetch origin --prune && git reset --hard origin/main && git clean -fd\`. Sanctioned override (rare): prefix \`STALE_LANE_OK=1\`.`;

  // A commit under a HAND-SET identity. The box already ships the correct one (`noreply@anthropic.com` at
  // `--global`), so an override can only make authorship WRONG — and it lands in history, on `main`, past
  // review, attributing an agent's work to a human who did not write it and cannot have signed it. Observed
  // 2026-08-24: four such commits merged before the tip-commit check noticed. Escape: `COMMIT_IDENTITY_OK=1`,
  // for the rare legitimate re-attribution (replaying someone else's patch, a `--reset-author` repair).
  if (isCommitIdentityOverride(s) && !hasIdentityEscape(s))
    return 'This commit sets the author/committer identity by hand (`-c user.email=`, `--author=`, or `GIT_*_EMAIL=`). The machine already has the right identity configured, so an override can only mis-attribute the commit — and unsigned commits in someone else\'s name land on `main` and stay there. Drop the override and commit with the ambient identity (`git config user.email` shows what it is). Sanctioned override (rare — replaying another author\'s patch, a `--reset-author` repair): prefix `COMMIT_IDENTITY_OK=1`.';

  // The command word(s) of this segment, after stripping leading env-assignments / sudo — so we match
  // actual INVOCATIONS (anchored at command position), not mentions buried in a quoted arg like a commit
  // message. `git commit -m "...pkill vite..."` has command `git`, so the pkill rule no longer fires.
  const cmd = s.replace(/^(?:\w+=\S+\s+)*(?:sudo\s+)?/, '');
  // r5 — …and the SAME segment as `canonicalCommand` reads it. That stripper peels the full wrapper set
  // (`env`/`time`/`command`/`builtin`/`nice`/`xargs`/`npx`/`sudo -u`), unwraps a leading `(`/`{`, and
  // resolves a path-qualified or quoted program word to its basename, where the hand-rolled prefix above
  // peels only `VAR=v` and `sudo`. `time rm backlog/2986-x.md`, `(pkill vite)` and `/usr/bin/git push
  // origin main` all reached these arms with the wrapper still glued to the command word and read as
  // safe — a hole base only ever covered by ACCIDENT, when its quote-blind split happened to tear the
  // line somewhere useful. Both readings are tested, so this can only ever add a deny, never remove one.
  const canon = canonicalCommand(s);
  const heads = canon && canon !== cmd ? [cmd, canon] : [cmd];
  const atCommand = (re) => heads.some((h) => re.test(h));

  // A destructive git op (reset --hard / clean -f[d] / checkout/restore/switch discard / force-push) run with
  // cwd inside a leased lane clone can clobber in-flight work. Two lease regimes, checked in precedence order:
  if (!primaryCwd && isDestructiveLaneGitOp(s)) {
    const clobberOk = /\bLANE_CLOBBER_OK=1\b/.test(s);
    // #2413 — a LIVE MARKED (workflowLane) lease: fail-CLOSED, and this SUPERSEDES the #2367 ownerSession
    // compare below. In the parallel-/workflow topology every sibling lane shares `ownerSession`, so it can't
    // tell a lane's OWN destructive op from a sibling's — a `reset --hard` in the wrong lane silently clobbers
    // a peer. So the op must ASSERT this lease's own minted slug inline (`LANE_SESSION=<slug>`, the slug the
    // acquiring orchestrator stamped into the lease); ABSENCE or MISMATCH ⇒ deny. The owning lane proves
    // itself by re-asserting the slug it acquired under; a sibling (which never holds that slug) is denied.
    if (markedLeaseSlug) {
      if (clobberOk) return null; // the deliberate escape wins even for a marked lane
      const asserted = assertedLaneSlug(s);
      if (asserted !== markedLeaseSlug)
        return `This lane clone holds a LIVE workflow-lane lease (#2413) — a destructive git op here must ASSERT the lease's own slug inline: prefix \`LANE_SESSION=${markedLeaseSlug}\` (e.g. \`LANE_SESSION=${markedLeaseSlug} git reset --hard origin/main\`). The slug was ${asserted ? `asserted as "${asserted}" — a MISMATCH` : 'ABSENT'}, so this is denied fail-closed: a sibling parallel lane cannot be told apart by ambient session identity, so only the minted slug proves ownership. If this really is your lane, re-assert its slug; otherwise pick another lane. Sanctioned override (rare): prefix \`LANE_CLOBBER_OK=1\`.`;
      return null; // slug asserted and matches → this is the owning lane's own op → allow
    }
    // #2997 — a LIVE UNMARKED but CONTESTED lease: another live lease in this pool carries the SAME
    // `ownerSession`, so a SIBLING AGENT of my own session is holding a lane right now and the #2367 compare
    // below reads "mine" for every one of us. This is the #2413 mechanism with its `workflowLane`-marker gate
    // removed — the residual that gate left open, and the one a 2026-08-08 `reset --hard` and a 2026-08-14
    // `release --lane=5` both walked straight through. Fail CLOSED on the same minted-slug channel: assert the
    // lease's own `holder` slug inline, absence OR mismatch ⇒ deny. Only reached when the lease is NOT foreign
    // (a different session's lease is already the #2367 case below) and IS contested — the solo topology never
    // gets here, which is what keeps this off the normal flow.
    if (contestedHolderSlug) {
      if (clobberOk) return null; // the deliberate escape wins here too, exactly as for a marked lane
      const asserted = assertedLaneSlug(s);
      if (asserted !== contestedHolderSlug)
        return `This lane clone holds a LIVE lease that is CONTESTED (#2997) — a SIBLING agent of your own session is holding another lane right now, so the durable session id says "mine" for BOTH of you and cannot tell your lane from theirs. A destructive git op here must ASSERT this lease's own minted holder slug inline: prefix \`LANE_SESSION=${contestedHolderSlug}\` (e.g. \`LANE_SESSION=${contestedHolderSlug} git reset --hard origin/main\`) — \`lane-pool.mjs acquire\` printed that slug when this lane was leased. The slug was ${asserted ? `asserted as "${asserted}" — a MISMATCH` : 'ABSENT'}, so this is denied fail-closed. If this really is your lane, re-assert its slug; if it is not, you are about to clobber a sibling's in-flight work — run this in the lane YOU acquired instead. Sanctioned override (rare): prefix \`LANE_CLOBBER_OK=1\`.`;
      return null; // slug asserted and matches → this is the holder's own op → allow
    }
    // #2367 — a LIVE UNMARKED lease held by ANOTHER session (serial topology; the durable `ownerSession`
    // compare, fail-OPEN with no id). Unchanged for unmarked leases. Escape: `LANE_CLOBBER_OK=1`.
    if (foreignLiveLease && !clobberOk)
      return 'This lane clone carries a LIVE lease held by ANOTHER session — a destructive git op here (reset --hard/clean -fd/checkout -- ./force-push) would clobber their in-flight work (#2367). If this really is your own lane, release it first (or re-acquire) rather than running this here; otherwise pick a different lane. Sanctioned override (rare): prefix `LANE_CLOBBER_OK=1`.';
  }

  // #2749/#2788 — the 4th `#primary-read-only-lanes-only` guard arm: a build that writes the shared PRIMARY
  // tree, run at primary cwd. Keys on the tree-write alone (never session identity, #2335) — only fires when
  // cwd IS a primary; a lane clone (main session or a delegated subagent, both build in a lane) is untouched.
  // #2788 review — the escape must be a LEADING env-assignment prefix, exactly how it is documented
  // ("prefix `MAIN_SESSION_BUILD_OK=1`"), never a bare substring test. Matching it anywhere meant a command
  // that merely MENTIONED the token — inside a quoted string, a commit message, an echoed doc line — silently
  // disarmed the whole arm. `hasLeadingEnvEscape` walks only the `VAR=val …` prefix, so the token must be in
  // assignment position ahead of the command word to count.
  if (primaryCwd && !hasLeadingEnvEscape(s, 'MAIN_SESSION_BUILD_OK')) {
    const treeWriteReason = primaryTreeWriteReason(s);
    if (treeWriteReason) return treeWriteReason;
  }

  // Only an actual RUN of build:plugs (a runner invocation), not a mention (grep/echo/read).
  if (/\b(?:npm|pnpm|yarn|run-s|run-p|npm-run-all)\b[^\n]*\bbuild:plugs\b/.test(s) || (/\btsc\b[^\n]*-p\s+\S*tsconfig\.plugs\.json/.test(s) && !/--noEmit/.test(s)))
    return 'build:plugs / `tsc -p tsconfig.plugs.json` emits shadow .js/.d.ts into the tree (breaks vitest, fakes a red gate). To typecheck plugs use `tsc --noEmit`.';

  if (atCommand(/^(?:pkill|killall)\b[^\n]*\b(?:vite|node)\b/))
    return "Never kill the running dev server (pkill/killall vite|node). It's the user's own server — detect the already-running instance and probe its port (3000/4000/8080) instead.";

  if (atCommand(/^(?:git\s+)?rm\b/) && BACKLOG_MD.test(s))
    return "Never delete a backlog/*.md — a done item becomes status:resolved (the file stays as the record). Resolve it, don't rm it.";

  // #2968 DIRECT shape — the `-A`/`--all`/`.` flag itself enumerates an unnamed path set; no pipe needed, so
  // this is a per-segment check (the three pipe/while-read/-exec sink shapes are `decide()`'s whole-command
  // gitAddEnumerationReason, called below before this segment loop runs).
  if (gitAddEnumeratesUnnamedPaths(s))
    return GIT_ADD_ENUMERATION_MESSAGE;

  for (const h of heads) {
    const mv = h.match(/^(?:git\s+)?mv\s+(.+)/);
    if (!mv) continue;
    // r5 — compare the first and last BACKLOG-numbered operand, not the first and last TOKEN. Taking the
    // last token made any trailing word shift the destination off the end and disarm the rule outright:
    // `mv backlog/2986-x.md backlog/9999-y.md # trailing note` read the comment word `note` as the
    // destination, found no NNN in it, and allowed a real renumber (confirmed executing under real bash).
    const nums = mv[1].split(/\s+/)
      .filter((p) => p && !p.startsWith('-'))
      .map((p) => (p.match(/backlog\/(\d+)-/) || [])[1])
      .filter(Boolean);
    if (nums.length < 2) continue;
    const srcN = nums[0];
    const dstN = nums[nums.length - 1];
    if (srcN !== dstN)
      return `Never renumber a backlog item (${srcN} → ${dstN}) — NNN is immutable. A new item takes the next free number; yield this one.`;
  }

  // #3390 — the sed/tee/perl half used to test CORPUS_MD against the WHOLE command string `s`, so a
  // purely read-only invocation that merely NAMES a backlog/reports path (`sed -n '1,200p' backlog/x.md`,
  // `perl -ne 'print' backlog/x.md`) was denied even with no `-i`/`--in-place`/write flag anywhere — a
  // false positive on a benign read, reproduced live twice in one night on two different files. Reuse
  // `fileWriteTargets`, the SAME real-write-target extractor `primaryTreeWriteReason` above already calls
  // via `isFileWriteRedirect(s)` for this exact segment — it correctly parses `-i`/`--in-place`/a short
  // cluster containing `i` for sed/perl and real `tee` targets, so only an ACTUAL write target is tested
  // against CORPUS_MD, never the raw command text. `atCommand` still scopes this to sed/tee/perl
  // invocations (a `>>` from any other command is caught by the first half of this OR, untouched).
  if (/>>\s*(?:\.\/)?(?:backlog|reports)\//.test(s) || (atCommand(/^(?:sed|gsed|tee|perl)\b/) && fileWriteTargets(s).some((f) => CORPUS_MD.test(f))))
    return "Don't append/in-place-edit backlog|reports/*.md from the shell (>>, tee -a, sed -i, perl -pi) — it bypasses the locus-prefix write hook so bare code-paths leak to the gate. Use the Edit/Write tools.";
  // #4070 — the truncating half of the same rule (a heredoc/`>` redirect, a `cp`/`mv` over a card).
  const overwritten = corpusOverwriteTargets(s);
  if (overwritten.length)
    return `Don't overwrite backlog|reports/*.md from the shell (${overwritten.join(', ')}: a \`>\`/heredoc redirect, \`cp\`, or \`mv\` onto it) — it skips the Edit/Write hooks (backlog-guard, locus-prefix) that validate a card's content. Use the Edit/Write tools; a new item is minted with \`node scripts/backlog.mjs scaffold\`.`;

  // A raw PR-BODY rewrite DISARMS the self-clear guard. `pr-land` stamps `authored-by-actor` into the body at
  // open; `review-independence.mjs` reads it to refuse an author clearing its own PR. Replacing the body drops
  // the stamp, and the guard then reads `unknown-author` — a state the invoked CLI deliberately permits (it
  // would otherwise strand every PR opened before the stamp existed). That tolerance is right for an OLD PR
  // and wrong for a STRIPPED one, and after the fact nothing tells them apart. So keep the stamp rather than
  // weaken the rule that depends on it.
  //
  // MATCHED ON TOKENS, NOT THE RAW STRING. The first cut regexed `\s--body(-file)?[\s=]` and was bypassable
  // three ways, all found by review: `gh` documents `-b`/`-F` as exact equivalents of `--body`/`--body-file`
  // and neither matched; a quoted `"--body-file"` has a quote before the dashes, not whitespace; and `gh api
  // -X PATCH …/pulls/<n> -f body=…` is not `gh pr edit` at all. `shellTokens` unquotes, so the first two
  // collapse into one token test. `-B` is `--base` and must NOT match — the check is case-sensitive.
  if (!/\bPR_BODY_STAMP_OK=1\b/.test(s)) {
    // NO `$` AFTER `-[bF]`. pflag lets `gh` glue the value onto the shorthand, so `-F/tmp/b.md`, `-F=/tmp/b.md`,
    // `-bhello` and `-b=hello` are all real body writes in one token. Anchoring to an exact `-b`/`-F` matched
    // none of them — the fourth bypass found in review, each verified against `gh` itself. Case-sensitive, so
    // `-B` (`--base`) still does not match, and no other `gh pr edit` shorthand starts with `b` or `F`.
    const BODY_FLAG = /^(?:--body(?:-file)?(?:=|$)|-[bF])/;
    // `shellTokens` yields `{text, quoted, op}` records, not strings — test `.text`, or every token
    // stringifies to `[object Object]` and the rule denies nothing at all.
    const bodyish = (seg) => shellTokens(seg).some((t) => BODY_FLAG.test(t.text));
    if (atCommand(/^gh\s+pr\s+edit\b/) && bodyish(s))
      return 'a raw `gh pr edit --body`/`-b`/`-F` drops the `authored-by-actor` stamp pr-land wrote at open, which disarms the self-clear refusal in review-independence.mjs (this is how #1162 landed on its own author\'s clearance). Use `node scripts/pr-body-edit.mjs --pr=<n> --body-file=<f>`, which carries the stamp across. Sanctioned override: prefix `PR_BODY_STAMP_OK=1`.';
    // The REST route to the same field. `gh api` writes it with `-f body=…`/`--field`/`--raw-field`, and the
    // graphql form names the mutation instead of a path.
    if (atCommand(/^gh\s+api\b/)
      && (/\bpulls\/\d+/.test(s) || /\bupdatePullRequest\b/.test(s))
      // `[^\w-]` and not `[\s'"]`: in the graphql form the field is nested — `input:{body:"x"}` — so the
      // character before `body` is `{`, and a whitespace-or-quote boundary missed it entirely. Excluding `-`
      // keeps `--body` out of this arm; that spelling belongs to the `gh pr edit` arm above.
      && /(?:^|[^\w-])body\s*[=:]/.test(s))
      return 'a `gh api` write to a PR body drops the `authored-by-actor` stamp, disarming the self-clear refusal (same hole as `gh pr edit --body`, one API layer down). Use `node scripts/pr-body-edit.mjs --pr=<n> --body-file=<f>`. Sanctioned override: prefix `PR_BODY_STAMP_OK=1`.';
    // `--input <file>` carries the JSON payload in a FILE, so no `body=` ever appears in argv and the arm
    // above cannot see what is being written. Refused on the shape rather than the content: a PATCH to a
    // pulls endpoint whose payload is unreadable from here MIGHT set the body. That over-denies a title- or
    // base-only patch, which is what the escape is for — the alternative is a route the guard provably
    // cannot inspect.
    // `graphql` is included because it has NO `pulls/<n>` path to key on: with the mutation in a file, neither
    // the endpoint nor `updatePullRequest` appears in argv, so both other arms miss it. Verified against real
    // `gh` — the command reaches GitHub's `updatePullRequest` resolver. `-F key=@file` reads a field value from
    // a file and is the same hole by another spelling.
    if (atCommand(/^gh\s+api\b/)
      && (/\bpulls\/\d+/.test(s) || /(?:^|\s)graphql\b/.test(s))
      && /(?:^|\s)(?:--input\b|-{1,2}[a-zA-Z-]*\s*[\w.]+=@)/.test(s))
      return 'a `gh api` call whose payload comes from a FILE (`--input`, or a `field=@file` value) cannot be inspected by this guard, and it may rewrite a PR body — which drops the `authored-by-actor` stamp. Refused on shape. Use `node scripts/pr-body-edit.mjs`, or prefix `PR_BODY_STAMP_OK=1` if the payload genuinely does not touch a body.';
  }

  // Direct push to a constellation `main` — blocked (strict lane-only, #2203). Everything reaches main via a
  // `lane/*` ref → PR → CI gate; a direct `git push … main` (or a bare `git push` from a checkout on main)
  // skips CI entirely. Only an explicit `lane/*` destination is allowed. Sanctioned override: prefix
  // `MAIN_PUSH_OK=1` (e.g. pr-land --fallback-git, or an emergency the user directs).
  if (atCommand(/^git\s+push\b/) && !/\bMAIN_PUSH_OK=1\b/.test(s)) {
    const pushHead = heads.find((h) => /^git\s+push\b/.test(h));
    const rest = pushHead.replace(/^git\s+push\b/, '');
    const targetsMain = /(?::(?:refs\/heads\/)?main\b)|(?:\s(?:refs\/heads\/)?main\b)/.test(rest);
    const targetsLane = /lane\//.test(rest);
    if (targetsMain || !targetsLane)
      return 'direct push to `main` is blocked (strict lane-only enforcement, #2203). Push to a `lane/*` ref and land via a PR so CI gates it: `git push origin HEAD:refs/heads/lane/<name>` then `pr-land`. Sanctioned override (rare): prefix `MAIN_PUSH_OK=1`.';
  }

  // fix procedure (operator-approved 2026-09-27, live incident PR #2811) — a push to a `lane/*` ref whose PR
  // someone ELSE holds the live fix claim on (`we:scripts/conveyor/fix-procedure.mjs`). `fixClaimedBranches` is
  // computed by the IO shell (claims NOT held by this caller, in the repo of the remote PUSHED TO) — empty
  // everywhere else, so this arm is inert for every caller that does not pass it. `pushTargets` is the IO shell's
  // resolution of what the push updates, including the IMPLICIT target of a bare `git push` that names no ref
  // (`fix-procedure.mjs#resolvePushDestination`). No override: wait for the holder's `fix-end`.
  // `canonicalGitOp` also reads `git -C <dir> push` / `git -c k=v push`, which agents use constantly. A `*`
  // target (from `--all` / `--mirror` / a glob refspec) matches every claimed branch (fail-closed).
  const pushHeads = [...heads, canonicalGitOp(s)];
  const pushHead = pushHeads.find((h) => /^git\s+push\b/.test(h));
  if (fixClaimedBranches.length && pushHead) {
    const targets = [...[...pushHead.matchAll(/(?:refs\/heads\/)?(lane\/[^\s:'"]+)/g)].map((m) => m[1]), ...pushTargets];
    const hit = fixClaimedBranches.find((c) => targets.includes(c.branch) || targets.includes('*'));
    if (hit) return hit.message;
  }
  // Per-push form (`computeFixClaimCtx`): EVERY `git push` in the command is resolved against the claims of ITS OWN
  // repo, so a claim on the second push's destination is not hidden behind an innocent first push. `decide` runs
  // this segment-wise but denies the whole command, so a segment holding any push checks every entry. A push whose
  // implicit target the hook could not see (it follows a `checkout`/`switch`) is refused outright when a foreign
  // claim is live in its repo — fail-closed, narrowed to that case so concurrent fixers' plain pushes still pass.
  if (fixPushes.length && pushHeads.some((h) => /^git\s+push\b/.test(h))) {
    for (const p of fixPushes) {
      if (p.segment != null && p.segment !== s) continue; // a push is judged only in the segment it runs in
      const claimed = p.claimed ?? [];
      if (!claimed.length) continue;
      const hit = claimed.find((c) => (p.targets ?? []).includes(c.branch) || (p.targets ?? []).includes('*'));
      if (hit) return hit.message;
      if (p.unreliable) return `${claimed[0].message} (this push follows a \`checkout\`/\`switch\`/\`cd\` in the same command, so its target cannot be resolved while a fix claim is live in the repo — run the checkout in its own command, or push an explicit \`HEAD:refs/heads/<lane>\`)`;
    }
  }

  // Reuse command-position normalization so paths/env wrappers match, but quoted prose does not.
  if (!hasLeadingEnvEscape(s, 'RAW_PR_CREATE_OK') && atCommand(/^gh\s+pr\s+create\b/))
    return 'raw `gh pr create` opens a PR with no `authored-by-actor` stamp, so the review gate cannot prove reviewer independence and the mandatory referral reviewer\'s rulings are ignored (plateau-app #204). Open it with `node <web-everything lane>/scripts/operations/run.mjs open-pr --ref=<branch> …` run from the target repo\'s lane clone (works for plateau-app and frontierui too), or repair an existing PR with `node scripts/pr-body-edit.mjs --pr=<n> --repair`. Escape hatch: prefix `RAW_PR_CREATE_OK=1`.';

  // A raw `gh pr merge` or its REST equivalent bypasses `pr-merge-gate.mjs`'s `assertMayMerge` — the ONE
  // place a PR may merge to `main` (#2290's sole-writer invariant) — and, upstream of it, the
  // review-escalation check (`review:pending`/`review:human`) that only runs inside the drain's own
  // `classifyPr` call path. Found this session: a perfectly drain-shaped PR can be merged straight past
  // review by an agent that just shells the merge itself — no malice required. Scoped narrowly: `gh pr view`/
  // `checks`/`comment`/`edit --add-label` and a read-only GET on the `.../merge` path (checking merged
  // status) are untouched; only an actual `gh pr merge` invocation or a MUTATING (`PUT`) REST call to the
  // merge endpoint fires. `atCommand`/`heads` (built above) already carry this segment through the same
  // wrapper/env/quote normalization (`canonicalCommand`) the push arm uses, and `decide`'s nested-command
  // recursion (`withNestedCommands`) re-runs `reason` on a `bash -c "gh pr merge …"` string the same way it
  // does for a disguised push — so this arm gets that coverage for free rather than re-implementing it.
  if (!/\bWE_MERGE_BREAK_GLASS=1\b/.test(s)) {
    if (atCommand(/^gh\s+pr\s+merge\b/))
      return 'a raw `gh pr merge` bypasses `scripts/lib/pr-merge-gate.mjs`\'s `assertMayMerge` — the ONE place a PR may merge to `main` (#2290\'s sole-writer invariant) — and, upstream of it, the review-escalation check (`review:pending`/`review:human`) that only runs inside the drain\'s own `classifyPr` call path (merge-ai-prs.mjs). That lets a drain-shaped PR merge straight past review. Apply the `ready-to-merge` label and let the drain land it (`node scripts/pr-land.mjs`, or the `/drain` skill) — that path calls `assertMayMerge` and is unaffected. Emergency-only escape (logged loudly): prefix `WE_MERGE_BREAK_GLASS=1`.';
    // The REST route to the same endpoint: `gh api repos/<owner>/<repo>/pulls/<n>/merge` MUTATED with `-X
    // PUT`/`--method PUT` (also the glued `-XPUT` form) — GitHub's merge endpoint requires PUT; a bare GET on
    // the same path only checks merged status and is left alone. `shellTokens` is quote-aware (same helper the
    // `gh pr edit --body` arm above uses), so a PUT value hiding in a quoted string is still seen.
    if (atCommand(/^gh\s+api\b/) && /(?:^|[\s'"/])repos\/[^\s'"]+\/pulls\/\d+\/merge\b/.test(s)) {
      const toks = shellTokens(s);
      const isPut = (t) => /^put$/i.test(t);
      const hasPutMethod = toks.some((t, i) => {
        if (/^-x$/i.test(t.text)) return isPut((toks[i + 1] || {}).text || '');
        if (/^-xput$/i.test(t.text)) return true;
        if (/^--method$/i.test(t.text)) return isPut((toks[i + 1] || {}).text || '');
        const eq = t.text.match(/^--method=(.+)$/i);
        return eq ? isPut(eq[1]) : false;
      });
      if (hasPutMethod)
        return 'a `gh api …/pulls/<n>/merge -X PUT` is the REST equivalent of a raw `gh pr merge` — the same bypass of `scripts/lib/pr-merge-gate.mjs`\'s `assertMayMerge` (#2290\'s sole-writer invariant) and the review-escalation check behind it. Apply the `ready-to-merge` label and let the drain land it (`node scripts/pr-land.mjs`, or the `/drain` skill). Emergency-only escape (logged loudly): prefix `WE_MERGE_BREAK_GLASS=1`.';
    }
  }

  // #3627 — the delivery agent's OWN Bash session (spawned by `scripts/operations/deliver-item-wrapper.mjs`'s
  // `CLAUDE_RESTRICTED_PROVIDER`, `--restricted --tools=Bash,Edit,Write,Read,Glob,Grep`) must never run any of
  // the mechanical lifecycle commands the WRAPPER itself owns end to end — acquire/claim, gate, converge, PR,
  // and learnings-drop. `we:skills-src/conveyor/delivery-agent-brief-v2.md` already tells the agent this in
  // PROSE ("build, report — nothing else"); nothing enforced it structurally until now.
  //
  // SCOPED VIA `dispatchKind === 'delivery'`, THE SAME CHANNEL #3105 ALREADY READS — not a second session-type
  // signal invented for this file. `dispatchKind` comes from `process.env.WE_DISPATCH_KIND`
  // (`dispatchedAgentVerificationReason`'s own docblock, above), and `CLAUDE_RESTRICTED_PROVIDER.spawn`
  // (`deliver-item-wrapper.mjs`) now stamps `WE_DISPATCH_KIND=delivery` onto the delivery agent's own process
  // env for exactly this reason — every hook that fires inside that agent's own turn inherits it, the same way
  // a mechanically-dispatched build/fix/ci-heal agent's env already does for the #3105 arm above. An
  // interactive operator session (no `WE_DISPATCH_KIND` at all) and every other dispatch kind are unaffected —
  // this whole block is a no-op unless `dispatchKind` is literally `'delivery'`.
  //
  // THIS TABLE IS LIVE AS OF #3645 (2026-09-12), AND WAS NOT WHEN IT WAS WRITTEN. The note that used to sit
  // here said `deliver-item-wrapper.mjs` was "still unwired, so nothing stamps `'delivery'` in production and
  // this whole table is, today, dead code". That is no longer true: a `build` dispatch now routes through
  // `dispatch-lane-io.mjs#deliverItemDetachedProvider` → `deliver-item-run.mjs` → `deliverItem`, whose
  // `CLAUDE_RESTRICTED_PROVIDER.spawn` stamps `WE_DISPATCH_KIND=delivery` on the minimal build agent it spawns.
  // Every deny below now fires for real, on that agent, on the default path.
  //
  // WHY THIS STAYS `'delivery'`-ONLY, AND MUST NOT BE "GENERALIZED TO EVERY DISPATCHED AGENT" (#xu2pp2m,
  // 2026-09-12 — recorded here because the generalization has now been proposed once and is superficially very
  // plausible). NOTE that the one thing that DID change with #3645 is the honesty note above, not this
  // scoping: `WE_BUILD_DISPATCH_MODE=agent` still spawns a full-brief `WE_DISPATCH_KIND=build` agent that runs
  // its own lifecycle, so `'build'` must keep being exempt here just as the other five kinds are.
  //
  // THE TABLE IS NOT "WHAT A DISPATCHED AGENT MAY NOT DO". It is "what the DELIVERY WRAPPER does on the
  // agent's behalf", and that ownership is the entire justification for every line in it. The other six
  // `LAUNCH_KINDS` (`we:scripts/operations/dispatch-lane.mjs`) have NO wrapper owning their lifecycle — their
  // briefs tell the agent to do these things ITSELF, and a `WE_DISPATCH_KIND=build|prepare|prepare-decision|
  // investigate|fix|ci-heal` agent is running one of those briefs. Verified command by command against the
  // live briefs rather than assumed: `lane-pool.mjs acquire` is step 1 of ALL SIX; `verify-lane.mjs
  // request`/`check` is the SANCTIONED gate path #3105's arm above deliberately exempts and every brief now
  // uses; `learnings-drop.mjs` is a named step in five of them; `gh pr view`/`gh pr checks` is how
  // `fix-agent-brief.md`/`fix-agent-ci-brief.md` read the finding they exist to repair; `run.mjs open-pr` is
  // how build/prepare/investigate open their PR at all. Flipping the gate to cover those kinds would deny
  // every dispatched agent its own first step.
  //
  // THAT AMBIGUITY IS NOW RESOLVED (#3640), AND THIS IS WHY THERE IS STILL NO `'fix'` ARM. The note that used
  // to sit here said `WE_DISPATCH_KIND=fix` was stamped by TWO spawners for two INCOMPATIBLE contracts —
  // `dispatch-lane-io.mjs#defaultClaudeProvider` (the full-brief agent, which runs its own lifecycle) and
  // `fix-dispatch-wrapper.mjs` (a restricted agent under a wrapper that owns the lifecycle) — and that a
  // `dispatchKind === 'fix'` arm could not be correct for both. It could not, and one was never written.
  // Instead the COLLISION was removed at the source: the fix wrapper now stamps `repair`, a WRAPPER-AGENT kind
  // (`we:scripts/operations/dispatch-lane.mjs#WRAPPER_AGENT_KINDS`), exactly as the delivery wrapper has always
  // stamped `delivery` rather than `build`. `WE_DISPATCH_KIND` therefore carries a LAUNCH kind when the agent
  // IS the dispatch and a WRAPPER-AGENT kind when the agent is a restricted worker inside a wrapper — two
  // disjoint lists, checked at module load by that file's `assertDispatchKindAxesDisjoint`. The table below
  // keys on the second list ONLY, so `fix` (and `ci-heal`, and `build`) stay exempt on the agent path where
  // their own briefs require these very commands.
  //
  // NO OVERRIDE. Every command below is something the WRAPPER runs itself, OUTSIDE the agent's own turn and
  // outside this hook's reach entirely (see this file's own `runGateWithOneRetry`/`runConverge`/`openPr`/
  // `dropLearning` — none of those are Claude Code Bash TOOL calls; they are the wrapper's own plain Node
  // child-process spawns, invisible to `PreToolUse` altogether). The agent has no legitimate reason to reach
  // for any of them from inside its own restricted turn, ever — not even the read-only-looking spellings
  // (`lane-pool.mjs status`, `verify-lane.mjs check`), because the agent has no business knowing any of this
  // machinery exists at all (FIRM REQUIREMENT 5 in `deliver-item-wrapper.mjs`'s own header).
  // `Object.hasOwn`, never a bare index — `dispatchKind` comes straight off the environment, and an inherited
  // `toString`/`constructor` must not read as a registered wrapper kind (it would deny with `undefined` text).
  // Same discipline `dispatch-provider-registry.mjs#dispatchProviderEntry` states for its own lookup.
  const owner = dispatchKind && Object.hasOwn(WRAPPER_OWNED_AGENTS, dispatchKind)
    ? WRAPPER_OWNED_AGENTS[dispatchKind]
    : null;
  if (owner) {
    if (/\bnode\s+\S*\blane-pool\.mjs\b/.test(s))
      return `a ${owner.agent} agent may never run \`lane-pool.mjs\` itself — acquiring/releasing the lane is the wrapper's own job (${owner.laneFns} in ${owner.wrapper}), done before the agent is spawned and after it reports. There is no override.`;
    if (/\bnode\s+\S*\bbacklog\.mjs\s+claim\b/.test(s))
      return `a ${owner.agent} agent may never run \`backlog.mjs claim\` itself — ${owner.claim}. There is no override.`;
    if (/\bnode\s+\S*\bbacklog\.mjs\s+release\b/.test(s))
      return `a ${owner.agent} agent may never run \`backlog.mjs release\` itself — ${owner.release}. There is no override.`;
    if (atCommand(/^gh\s+pr\b/))
      return `a ${owner.agent} agent may never run \`gh pr\` itself — ${owner.ghPr}. There is no override.`;
    if (/\bnode\s+\S*\bopen-pr\.mjs\b/.test(s) || /\bnode\s+\S*\brun\.mjs\s+open-pr\b/.test(s))
      return `a ${owner.agent} agent may never run \`open-pr.mjs\` / \`run.mjs open-pr\` itself — ${owner.openPr}. There is no override.`;
    if (/\bnode\s+\S*\bpr-land\.mjs\b/.test(s))
      return `a ${owner.agent} agent may never run \`pr-land.mjs\` itself — landing is the drain's job; neither the agent nor its own wrapper ever lands a PR. There is no override.`;
    if (/\bnode\s+\S*\blearnings-drop\.mjs\b/.test(s))
      return `a ${owner.agent} agent may never run \`learnings-drop.mjs\` itself — the agent REPORTS a learning on its structured report, and the wrapper is what drops it (\`dropLearning\`). There is no override.`;
    if (/\bnode\s+\S*\bconverge-cli\.mjs\b/.test(s))
      return `a ${owner.agent} agent may never run \`converge-cli.mjs\` itself — ${owner.converge}. There is no override.`;
    if (/\bnode\s+\S*\bverify-lane\.mjs\b/.test(s))
      return `a ${owner.agent} agent may never run \`verify-lane.mjs\` itself, in ANY mode (not even \`request\`/\`check\`) — the gate is run by the wrapper (\`${owner.gateFn}\`), synchronously, outside the agent's own turn; the agent reports \`done\` and is resumed with the result if the gate came back red. There is no override.`;
    if (/\bnode\s+\S*\breview-core-cli\.mjs\b/.test(s))
      return `a ${owner.agent} agent may never run \`review-core-cli.mjs\` itself — the invite-on-discovery step is driven by the wrapper's own converge loop (\`runConvergeInvite\`), never by the agent. There is no override.`;
  }

  // #3644 — the DECISION-AUTHORING agent's own Bash session (spawned by
  // `we:scripts/operations/prepare-decision-wrapper.mjs`'s `CLAUDE_RESTRICTED_PREPARE_PROVIDER`, the same
  // `--restricted --tools=Bash,Edit,Write,Read,Glob,Grep` shape). Same table, same justification as the
  // `'delivery'` block above — every command below is one the PREPARE WRAPPER runs itself, outside the agent's
  // own turn and outside this hook's reach entirely.
  //
  // WHY THE KIND VALUE IS `'decision-authoring'` AND NOT THE LAUNCH KIND `'prepare-decision'` — this is the
  // whole reason an arm can be written here at all, and it is exactly the collision the `'fix'` note above
  // says must be settled BEFORE any arm is added.
  //
  //   `WE_DISPATCH_KIND=prepare-decision` is stamped by `dispatch-lane-io.mjs#defaultClaudeProvider` on the
  //   FALLBACK path (`WE_PREPARE_DECISION_DISPATCH_MODE=agent`), which runs the full prose brief
  //   `we:skills-src/conveyor/prepare-decision-agent-brief.md` — an agent that runs its OWN lifecycle:
  //   `lane-pool acquire` (its step 1), `prepare-hold` (step 2), `verify-lane request`/`check` (step 4),
  //   `run.mjs open-pr` (step 6), `learnings-drop` + `prepare-release` (step 7). Denying that agent those
  //   commands would deny it its own first step, which is precisely what the `#xu2pp2m` non-generalization
  //   block in `we:scripts/__tests__/guard-bash.test.mjs` asserts must never happen.
  //
  //   So this wrapper stamps a DISTINCT value, exactly as #3645's build wrapper stamps `'delivery'` rather
  //   than `'build'` for the same reason. One env value, one contract. The two paths can now both be correct
  //   at once, and the fallback brief stays fully runnable.
  //
  // FOUR ARMS BEYOND THE DELIVERY TABLE, all `backlog.mjs` verbs specific to a decision's lifecycle:
  //   • `prepare-hold`/`prepare-release` — the wrapper takes and drops the hold (`prepareHold`/
  //     `prepareRelease`), before the agent is spawned and after it reports.
  //   • `prepare-stamp` — THE most important one. `preparedDate` is what makes readiness rank a decision
  //     `✓ ready to ratify`; the wrapper stamps it only after reading a `done` report, so an agent stamping
  //     its own half-finished authoring is a false "ready" the next ratify turn would trust.
  //   • `resolve` — a prepared decision is STILL OPEN. Resolving is the ratify turn's job (MEMORY #39), and
  //     a decision-authoring agent resolving the very decision it was asked to prepare is the single most
  //     damaging thing on this page.
  // NO OVERRIDE, for the same reason the delivery table has none.
  if (dispatchKind === 'decision-authoring') {
    if (/\bnode\s+\S*\blane-pool\.mjs\b/.test(s))
      return 'a decision-authoring agent may never run `lane-pool.mjs` itself — acquiring/releasing the lane is the wrapper\'s own job (`acquireLane`/`releaseHoldAndLane` in prepare-decision-wrapper.mjs), done before the agent is spawned and after it reports. There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+prepare-stamp\b/.test(s))
      return 'a decision-authoring agent may never run `backlog.mjs prepare-stamp` itself — `preparedDate` is what makes readiness rank a decision `✓ ready to ratify`, and the wrapper stamps it (`stampPreparedDate`) only after reading your `done` report. Stamping your own in-progress authoring is a false "ready" the next ratify turn will trust. There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+prepare-hold\b/.test(s))
      return 'a decision-authoring agent may never run `backlog.mjs prepare-hold` itself — the wrapper holds the decision before the agent is ever spawned (`prepareHold`); a second hold from inside the agent is redundant at best and a lease race at worst. There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+prepare-release\b/.test(s))
      return 'a decision-authoring agent may never run `backlog.mjs prepare-release` itself — the hold is dropped by the wrapper reading your own structured report (`releaseHoldAndLane`, or step 11 once the PR is open), never by the agent releasing mid-authoring. There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+resolve\b/.test(s))
      return 'a decision-authoring agent may never run `backlog.mjs resolve` — a PREPARED decision is still OPEN; the call has not been made. Resolving belongs to the later, human ratify turn (MEMORY #39 — never take an unprepared decision), never to the agent that prepared it. There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+claim\b/.test(s))
      return 'a decision-authoring agent may never run `backlog.mjs claim` — a prepare HOLDS its decision, it never CLAIMS it (a claim marks the item as being BUILT). The wrapper takes the hold itself (`prepareHold`). There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+release\b/.test(s))
      return 'a decision-authoring agent may never run `backlog.mjs release` — this arc never takes a claim, so there is none to release; the wrapper drops the HOLD (`prepareRelease`) off your own reported outcome. There is no override.';
    if (atCommand(/^gh\s+pr\b/))
      return 'a decision-authoring agent may never run `gh pr` itself — it never opens, watches, labels, or merges its own PR; the wrapper\'s `openPreparePr` is the only caller, and only after the stamp, the gate and converge have all run. There is no override.';
    if (/\bnode\s+\S*\bopen-pr\.mjs\b/.test(s) || /\bnode\s+\S*\brun\.mjs\s+open-pr\b/.test(s))
      return 'a decision-authoring agent may never run `open-pr.mjs` / `run.mjs open-pr` itself — opening the PR is the wrapper\'s own job (`openPreparePr`), on a `lane/<num>-prepare-<slug>` ref and a park decision the agent never computes. There is no override.';
    if (/\bnode\s+\S*\bpr-land\.mjs\b/.test(s))
      return 'a decision-authoring agent may never run `pr-land.mjs` itself — landing is the drain\'s job; neither the agent nor its own wrapper ever lands a PR. There is no override.';
    if (/\bnode\s+\S*\blearnings-drop\.mjs\b/.test(s))
      return 'a decision-authoring agent may never run `learnings-drop.mjs` itself — the agent REPORTS a learning on its structured report and the wrapper is what drops it (`dropLearning`). There is no override.';
    if (/\bnode\s+\S*\bconverge-cli\.mjs\b/.test(s))
      return 'a decision-authoring agent may never run `converge-cli.mjs` itself — it never initiates review of its own forks; the wrapper\'s `runConverge` drives the whole loop, after the agent has already exited. There is no override.';
    if (/\bnode\s+\S*\bverify-lane\.mjs\b/.test(s))
      return 'a decision-authoring agent may never run `verify-lane.mjs` itself, in ANY mode (not even `request`/`check`) — the gate is run by the wrapper (`runGateWithOneRetry`), synchronously, outside the agent\'s own turn; the agent reports `done` and is resumed with the result if the gate came back red. There is no override.';
    if (/\bnode\s+\S*\breview-core-cli\.mjs\b/.test(s))
      return 'a decision-authoring agent may never run `review-core-cli.mjs` itself — the invite-on-discovery step is driven by the wrapper\'s own converge loop (`runConvergeInvite`), never by the agent. There is no override.';
  }

  // #3642 — the SCOPE-AUTHORING agent's own Bash session (spawned by
  // `we:scripts/operations/prepare-scope-wrapper.mjs`'s `CLAUDE_RESTRICTED_PREPARE_PROVIDER`, the same
  // `--restricted --tools=Bash,Edit,Write,Read,Glob,Grep` shape). Same discipline as the two blocks above:
  // every command below is one the PREPARE-SCOPE WRAPPER runs itself, outside the agent's own turn.
  //
  // WHY THE KIND VALUE IS `'scope-authoring'` AND NOT THE LAUNCH KIND `'prepare'`, which is what that wrapper
  // used to stamp — this arm is exactly what the `'fix'` note above said must not be written until the
  // collision was settled, and #3642 settled it. `WE_DISPATCH_KIND=prepare` is ALSO stamped by
  // `dispatch-lane-io.mjs#defaultClaudeProvider` on the FALLBACK path (`WE_PREPARE_DISPATCH_MODE=agent`),
  // which runs the full prose brief `we:skills-src/conveyor/prepare-scope-agent-brief.md` — an agent that
  // runs its OWN lifecycle: `lane-pool acquire` (its step 1), `verify-lane request`/`check` (step 4),
  // `run.mjs open-pr` (step 6), `learnings-drop` (step 7). A `'prepare'` arm would deny that agent its own
  // step 1. So the wrapper now stamps a WRAPPER-AGENT kind and this arm keys on THAT; the fallback brief
  // stays fully runnable, and both paths are correct at once.
  //
  // THE TEXT IS THIS KIND'S OWN, NOT `delivery`'s OR `decision-authoring`'s, because their claims are FALSE
  // here — verified against `prepare-scope-wrapper.mjs` command-by-command rather than pattern-matched:
  //   * a prepare-scope arc NEVER claims a backlog item and never holds a decision. `prepareScope`'s own
  //     docblock: "Never merges, never resolves, never claims the item — a prepare only authors `scope:`."
  //     So `delivery`'s "the wrapper claims the item before you are spawned" and `decision-authoring`'s
  //     `prepare-hold`/`prepare-stamp` wording would both be untrue.
  //   * THE AGENT DOES NOT COMMIT. Unique among the four wrapper-owned kinds: `commitScopeEdit` is the
  //     wrapper's, run only AFTER `assertOnlyItemSpecTouched` has read `git status --porcelain` — which an
  //     agent that committed first would leave empty, so a self-commit does not merely duplicate work, it
  //     makes the one-file guardrail read "the agent left the file unmodified" and abort the whole arc. The
  //     v2 brief says "Do **not** commit" in prose; this is what enforces it.
  //   * THERE IS NO CONVERGE PASS ON THIS ARC AT ALL — deliberately (see that file's header: a converge is
  //     sized for a code diff, and this diff is one frontmatter key). So the deny's reason is "there is no
  //     loop for you to be spawning part of", not "the wrapper drives the loop".
  // NO OVERRIDE, for the same reason the other two tables have none.
  if (dispatchKind === 'scope-authoring') {
    if (/\bnode\s+\S*\blane-pool\.mjs\b/.test(s))
      return 'a scope-authoring agent may never run `lane-pool.mjs` itself — acquiring and releasing the lane is the wrapper\'s own job (`acquireLane`/`releaseLane` in prepare-scope-wrapper.mjs), done before the agent is spawned and after it reports. There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+claim\b/.test(s))
      return 'a scope-authoring agent may never run `backlog.mjs claim` — a prepare-scope dispatch never claims its item at all: it predicts where a build WOULD land and writes one `scope:` key. A claim marks the item as being BUILT, which is the very thing this arc has not done. There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+release\b/.test(s))
      return 'a scope-authoring agent may never run `backlog.mjs release` — this arc never takes a claim, so there is none to release; releasing one it does not hold would strip it from whoever does. There is no override.';
    if (/\bnode\s+\S*\bbacklog\.mjs\s+resolve\b/.test(s))
      return 'a scope-authoring agent may never run `backlog.mjs resolve` — predicting an item\'s `scope:` is not delivering it; the item is still open and still has to be built. There is no override.';
    if (atCommand(/^git\s+commit\b/))
      return 'a scope-authoring agent may never run `git commit` itself — the wrapper commits your one backlog file (`commitScopeEdit`), and only AFTER `assertOnlyItemSpecTouched` has read `git status --porcelain` to prove you touched nothing else. Committing first empties that read, so the guardrail concludes you left the file unmodified and the whole prepare aborts. Leave the edit uncommitted in your working tree and report `done`. There is no override.';
    if (atCommand(/^gh\s+pr\b/))
      return 'a scope-authoring agent may never run `gh pr` itself — it never opens, watches, labels, or merges its own PR; the wrapper\'s `openScopePr` is the only caller, and only after the gate and the one-file check have both passed. There is no override.';
    if (/\bnode\s+\S*\bopen-pr\.mjs\b/.test(s) || /\bnode\s+\S*\brun\.mjs\s+open-pr\b/.test(s))
      return 'a scope-authoring agent may never run `open-pr.mjs` / `run.mjs open-pr` itself — opening the PR is the wrapper\'s own job (`openScopePr`), on a `lane/<num>-scope-<slug>` ref and with a `--mode=label-on-green` decision the agent never computes. There is no override.';
    if (/\bnode\s+\S*\bpr-land\.mjs\b/.test(s))
      return 'a scope-authoring agent may never run `pr-land.mjs` itself — landing is the drain\'s job; neither the agent nor its own wrapper ever lands a PR. There is no override.';
    if (/\bnode\s+\S*\blearnings-drop\.mjs\b/.test(s))
      return 'a scope-authoring agent may never run `learnings-drop.mjs` itself — the agent REPORTS a learning on its structured report and the wrapper is what drops it (`dropLearning`). There is no override.';
    if (/\bnode\s+\S*\bconverge-cli\.mjs\b/.test(s))
      return 'a scope-authoring agent may never run `converge-cli.mjs` itself — a prepare-scope arc runs NO converge pass at all (a converge is sized for a code diff; this diff is one frontmatter key), so there is no loop here for you to be spawning part of. What replaces the old brief\'s self-review is two mechanical checks the wrapper runs: `assertOnlyItemSpecTouched` and the gate. There is no override.';
    if (/\bnode\s+\S*\bverify-lane\.mjs\b/.test(s))
      return 'a scope-authoring agent may never run `verify-lane.mjs` itself, in ANY mode (not even `request`/`check`) — the gate is run by the wrapper (`runPrepareGateWithOneRetry`), synchronously, outside the agent\'s own turn; the agent reports `done` and is resumed with the result if the gate came back red. There is no override.';
    if (/\bnode\s+\S*\breview-core-cli\.mjs\b/.test(s))
      return 'a scope-authoring agent may never run `review-core-cli.mjs` itself — the invite-on-discovery step belongs to a converge loop, and this arc has none. There is no override.';
  }

  return null;
}

/** Drop heredoc BODIES (and their terminator lines) from a multi-line command, keeping every real command
 *  line — including the opener that declares the heredoc. Pure. Without this, `decide`'s newline split reads
 *  each body line as a command segment, so prose containing `>`/`sed`/`npm run build` produces phantom
 *  denials. Only `<<`/`<<-` with a plain, quoted, or bare-word delimiter is recognised (the forms an agent
 *  actually writes); anything else is left untouched, i.e. today's behaviour. */
export function stripHeredocBodies(command) {
  return heredocScan(command).text;
}

/** `stripHeredocBodies` plus the parse state it reached. Pure. Returns `{ text, unterminated }`.
 *
 *  r3 audit — this pass is ITSELF a parser (it has to be: only an unquoted, un-commented `<<` opens a
 *  heredoc), so it has the same degrade-or-deny obligation as the splitter. An unterminated quoted run in
 *  the COMMAND text stops it from ever seeing a later opener, and the heredoc BODY then gets re-parsed as
 *  commands with the quoting one phase out — which the fuzz found reachable end-to-end (an apostrophe in
 *  the body re-balanced the run and swallowed a `git checkout -f main`). `unterminated` reports it and
 *  `decide` denies. Note this is deliberately scoped to the command text: an unterminated quote inside a
 *  heredoc BODY is data and is never reported (that is the whole point of a heredoc). */
export function heredocScan(command) {
  const text = String(command || '');
  if (!text.includes('<<')) return { text, unterminated: parseSegments(text).unterminated, heredocs: [] };
  const OPENER = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_]\w*))/;
  const kept = [];
  let line = '';
  let atWordStart = true;
  let inComment = false;
  let pending = null;
  let unterminated = false;
  const heredocs = [];
  let i = 0;
  // r3 audit — the opener used to be matched with a line-wide regex, so a `<<` that is not an operator at
  // all (`echo "a << b"`, `# see <<EOF`) minted a phantom heredoc and DROPPED every following line from
  // `decide`'s view: `echo "x << EOF"` ⏎ `npm run build` read as safe. The opener is now only recognised at
  // an UNQUOTED, un-commented position — strictly fewer heredocs are detected, so strictly fewer lines are
  // dropped. Text is otherwise preserved VERBATIM (a `\`+newline is left for the splitter to splice).
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      const head = line;
      kept.push(line);
      line = '';
      atWordStart = true;
      inComment = false;
      i += 1;
      if (pending !== null) {                                  // consume the heredoc BODY + its terminator
        const delim = pending;
        pending = null;
        const bodyLines = [];
        while (i < text.length) {
          const nl = text.indexOf('\n', i);
          const body = text.slice(i, nl === -1 ? text.length : nl);
          i = nl === -1 ? text.length : nl + 1;
          if (body.trim() === delim) break;
          bodyLines.push(body);
        }
        heredocs.push({ head, body: bodyLines.join('\n') });
      }
      continue;
    }
    const run = inComment ? null : scanRun(text, i, atWordStart);
    if (run && run.kind === 'comment') { inComment = true; }
    else if (run && run.kind === 'continuation') { line += '\\'; i += 1; continue; }  // keep raw; the `\n` ends the line
    else if (run) {
      if (run.kind === 'unterminated') unterminated = true;   // fail closed — `decide` denies, never degrades
      line += run.raw;
      i = run.end + 1;
      atWordStart = false;
      continue;
    } else if (!inComment && ch === '<' && text[i + 1] === '<' && pending === null) {
      const m = text.slice(i).match(OPENER);
      if (m) { pending = m[1] || m[2] || m[3]; line += m[0]; i += m[0].length; atWordStart = false; continue; }
    }
    line += ch;
    atWordStart = /[\s()]/.test(ch);
    i += 1;
  }
  kept.push(line);
  return { text: kept.join('\n'), unterminated, heredocs };
}

// ── #3311 — NAME THE COLLATERAL a refusal takes with it ────────────────────────────────────────────────
// A PreToolUse deny is ALL-OR-NOTHING: the harness never runs the tool call, so a refusal aimed at ONE
// segment of a chain also discards every other segment. That is correct and must stay correct — see the
// design note below — but today it is INVISIBLE. The deny message names the git violation; the caller fixes
// exactly that, retries the git command ALONE, and never learns that the `cat > file <<'EOF'` earlier in the
// same chain also never ran. Nothing at the write site records anything, so the loss surfaces later as a
// symptom with no stated cause.
//
// Three incidents in one session on 2026-08-26, all the same shape:
//   1. a `git add -A` refusal dropped the heredoc writing a PR body; `open-pr` then refused an EMPTY body,
//      and the caller had to trace backwards to find out why;
//   2. the same shape dropped a `pr-body-edit` fix that was then REPORTED AS APPLIED, because the tool was
//      pointed at a file that had never been written — a FALSE COMPLETION CLAIM, the expensive failure;
//   3. a `--force-with-lease` push refusal dropped both a heredoc AND a commit, so a "commit and push" step
//      silently did neither.
// The common cost is not the retype. It is that the caller does not KNOW, so downstream steps (and the
// caller's own report) proceed on state that does not exist.
//
// WHY THIS AND NOT "gate at the offending step so the unrelated ones still run". Considered and rejected on
// three grounds, in increasing order of weight:
//   • It is not additive. Executing part of a chain that is REFUSED TODAY is strictly more permissive than
//     refusing it whole — it would weaken every existing arm at once, which is the one thing a
//     security-adjacent guard may not do.
//   • It would make the guard a shell REWRITER. To run a subset it must reconstruct a command from its OWN
//     parse and hand that to bash. This file's history is a catalogue of places where that parse and bash
//     disagreed (#2994's quoted pipe, r3's phantom heredoc, r5's subshell closer, the wrapper peel). Under
//     the message-only fix a parse divergence costs an over- or under-deny; under a rewrite it costs
//     EXECUTING A COMMAND THE CALLER NEVER WROTE. Categorically worse.
//   • A chain the caller wrote as an atom may not be decomposable. `&&` carries ordering AND a success
//     precondition; dropping a middle step can leave a later one running against state it was promised
//     would exist (`rm -rf dist && npm run build`). The guard cannot tell which chains survive decomposition
//     and which do not, and a partial execution nobody asked for is a SUBTLER failure than a whole refusal —
//     it trades a loud, visible loss for a quiet, plausible-looking one. That is the wrong direction for a
//     defect whose entire cost was invisibility.
// Also considered: PERSISTING the dropped heredoc body to a scratch file so the content survives. Rejected
// as out of proportion — it gives a PreToolUse hook a side effect and a place to spill secrets, to solve the
// cheap half of the problem (retyping). The expensive half is not knowing, which the message solves.
//
// So: strictly additive to the deny MESSAGE, appended by the CLI at the deny site. `decide` is untouched —
// it still returns exactly the reason it returned before, which is what keeps the golden corpus
// (`scripts/golden-corpus/hook-guard-bash/*.json`, asserted byte-for-byte) and every deny/allow test honest.

/** git subcommands that CHANGE state — the read set (`status`, `log`, `diff`, `show`, `rev-parse`,
 *  `ls-files`, `describe`, …) is deliberately NOT enumerated. An explicit mutating list is the safe default
 *  here: an unknown subcommand goes unmentioned (a missing bullet), where an "everything not on the read
 *  list" rule would invent bullets for every new porcelain command git ships. */
const GIT_STATE_SUBCOMMANDS = new Set([
  'add', 'commit', 'tag', 'stash', 'apply', 'am', 'cherry-pick', 'revert', 'merge', 'rebase', 'push',
  'mv', 'rm', 'reset', 'restore', 'checkout', 'switch', 'branch', 'worktree', 'clone', 'init',
  'update-ref', 'notes', 'fetch', 'pull',
]);

/** Programs whose whole job is to change the filesystem. Same shape and same reasoning as the git set: a
 *  short explicit list, not a "not on the read list" rule. */
const FS_MUTATING_PROGRAMS = new Set([
  'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'install', 'rsync', 'chmod', 'chown', 'truncate', 'patch',
]);

/** git's own global flags that SWALLOW the next token, so the subcommand walk below does not mistake their
 *  VALUE for the subcommand (`git -C /some/path add -A` → `add`, never `/some/path`). */
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The git SUBCOMMAND of `segment`, or '' when it is not git. Pure. Reads the wrapper-peeled, basename-
 *  resolved `canonicalCommand` view, so `/usr/bin/git`, `env git` and `"git"` all resolve — the same
 *  normalization every deny arm above reads, rather than a second weaker one (the #2788 r3 lesson). */
function gitSubcommand(segment) {
  if (programWord(segment) !== 'git') return '';
  const toks = shellTokens(canonicalCommand(segment)).filter((t) => !t.op).map((t) => t.text);
  for (let i = 1; i < toks.length; i++) {
    if (GIT_VALUE_FLAGS.has(toks[i])) { i += 1; continue; }
    if (toks[i].startsWith('-')) continue;
    return toks[i];
  }
  return '';
}

/** What STATE would this segment have produced, in a few words — or null if it produces none. Pure.
 *
 *  Narrow on purpose: a dropped `git status` or `ls` costs nothing and the caller does not need telling, so
 *  naming it would only bury the bullets that matter. Five shapes, the first two being the ones that
 *  actually cost this session:
 *    1. a file WRITE (redirect / `tee` / `sed -i` / `perl -pi`), scratch paths included — see
 *       `fileWriteTargets` for why `/tmp` counts here and not in the #2749 arm;
 *    2. a HEREDOC, called out by name even with no redirect target (`git commit -F- <<'EOF'`), because its
 *       BODY exists ONLY inside the command text that is being discarded — it is the one part of a dropped
 *       step that the caller cannot recover by re-reading the file it was writing to;
 *    3. a git state mutation;
 *    4. a filesystem-mutating program;
 *    5. a tree-writing build or an fs-writing generator/scaffold script — recognised by REUSING the #2749
 *       predicates rather than a sixth hand-written list, so "what counts as writing the tree" has exactly
 *       one definition in this file and the notice cannot drift from the arm that denies it.
 */
function statefulStepEffect(segment) {
  const seg = String(segment || '');
  const targets = fileWriteTargets(seg);
  // A `<<`/`<<-` OPERATOR token — `shellTokens` only emits one at a real redirect position, so a `<<` inside
  // a quoted argument or a comment is text, not a heredoc (the same distinction `heredocScan` draws, and the
  // reason r3's phantom-heredoc bug is not reachable from here).
  const heredoc = shellTokens(seg).some((t) => t.op && t.text.startsWith('<<'));
  if (targets.length) {
    const shown = targets.slice(0, 3).join(', ');
    return `writes ${shown}${targets.length > 3 ? ', …' : ''}${heredoc ? ' — from a heredoc body that exists ONLY in this command text' : ''}`;
  }
  if (heredoc) return 'consumes a heredoc body that exists ONLY in this command text';
  const sub = gitSubcommand(seg);
  if (sub && GIT_STATE_SUBCOMMANDS.has(sub)) return `runs \`git ${sub}\` — a repository state change`;
  const prog = programWord(seg);
  if (FS_MUTATING_PROGRAMS.has(prog)) return `runs \`${prog}\` — a filesystem change`;
  if (isGeneratorScriptRun(seg)) return 'runs an fs-writing generator/scaffold script';
  if (isTreeWritingBuildRun(seg)) return 'runs a tree-writing build';
  return null;
}

/** A one-line excerpt of a segment for the notice: whitespace collapsed, truncated. Pure. */
function stepExcerpt(segment) {
  const s = String(segment || '').replace(/\s+/g, ' ').trim();
  return s.length > 72 ? s.slice(0, 71) + '…' : s;
}

/** How many dropped steps the notice lists before it summarises the rest — a bounded message. */
const MAX_LISTED_STEPS = 5;

/**
 * The #3311 COLLATERAL notice for a command that is about to be DENIED: the state-producing steps in the
 * same chain that will not run either, and that leave no trace of having been skipped. Pure. Returns '' when
 * there is nothing to name, so the caller can concatenate it unconditionally.
 *
 * STRICTLY ADDITIVE — it is appended to a deny message that has ALREADY been decided. It cannot allow
 * anything, it cannot deny anything, and it never reaches a command that was allowed. That is the whole
 * safety argument, and it is why this lives beside `decide` rather than inside it.
 *
 * Deliberately silent in three cases:
 *   • a command the parser cannot represent (an unterminated quote) — the segments would be a guess, and a
 *     guessed list of "what you lost" is worse than no list. That command has its own deny message anyway.
 *   • a SINGLE-segment command — there is no collateral; the refused step is the only step.
 *   • a step that `reason` would refuse ON ITS OWN — the deny message already names it, so repeating it as
 *     "collateral" would blur the one distinction the notice exists to draw. Note this is a best-effort
 *     attribution, not a claim of innocence: the whole-command arms (`backgroundedVerificationReason`,
 *     `commitIdentityCommandReason`) have no single offending segment, so under those a listed step may in
 *     fact be part of the reason. The wording says only that the step produces state and did not run, which
 *     is true either way.
 */
export function collateralStepsNotice(command, ctx = {}) {
  try {
    const hd = heredocScan(command);
    if (hd.unterminated) return '';
    const parsed = parseSegments(hd.text);
    if (parsed.unterminated) return '';
    const segments = parsed.segments.map((s) => s.trim()).filter(Boolean);
    if (segments.length < 2) return '';
    const dropped = [];
    for (const seg of segments) {
      if (reason(seg, ctx)) continue;                       // this step IS the refusal's subject — already named
      const effect = statefulStepEffect(seg);
      if (effect) dropped.push(`\n  • \`${stepExcerpt(seg)}\` — ${effect}`);
    }
    if (!dropped.length) return '';
    const listed = dropped.slice(0, MAX_LISTED_STEPS).join('');
    const rest = dropped.length > MAX_LISTED_STEPS ? `\n  • …and ${dropped.length - MAX_LISTED_STEPS} more.` : '';
    return `\n\nCOLLATERAL (#3311): a refusal blocks the WHOLE command, so NOTHING in it ran — not just the step named above. ${dropped.length} other step(s) in this chain produce state and were discarded with it, leaving no trace at the write site:${listed}${rest}\n`
      + 'Re-run those steps in their own Bash call BEFORE anything downstream reads what they were meant to produce — and do NOT report them as done. A heredoc body is gone with the command text; nothing on disk records that it was skipped.';
  } catch {
    return '';                                              // a fault in an ADVISORY note must never touch the deny
  }
}

/** Did `WE_MERGE_BREAK_GLASS=1` actually disarm the raw-gh-merge deny in this command? Pure. The CLI uses
 *  this to write a LOUD stderr audit line whenever the escape does something — mirroring `pr-merge-gate.mjs`'s
 *  own `assertMayMerge`, which logs every break-glass merge the same way, so this escape is never silent
 *  either. Strips the token and re-runs `decide`: if the command is ALLOWED as given but would have been
 *  denied by the raw-gh-merge arm specifically (its message is the only one that names `assertMayMerge`)
 *  with the token gone, the escape is what let it through — as opposed to a command that was going to be
 *  allowed regardless (no audit noise for an ordinary `WE_MERGE_BREAK_GLASS=1`-prefixed no-op) or one still
 *  denied by some other arm (the escape didn't do anything). */
export function mergeBreakGlassUsed(command, ctx = {}) {
  const s = String(command || '');
  if (!/\bWE_MERGE_BREAK_GLASS=1\b/.test(s)) return false;
  if (decide(s, ctx)) return false;
  const stripped = s.replace(/\bWE_MERGE_BREAK_GLASS=1\b/g, '');
  const wouldDeny = decide(stripped, ctx);
  return !!(wouldDeny && /assertMayMerge/.test(wouldDeny));
}

/**
 * The fix-claim half of the hook's context, per `git push` in `cmd`: `fixPushes: [{segment, repoKey, targets,
 * claimed, unreliable}]`, each push resolved in ITS OWN repo/checkout against the live claims the caller does not
 * hold. `segment` is the exact command segment the push sits in (the one `decide` later hands `reason`), so a push
 * is only ever judged in its own segment — a `git push` inside a later `echo "…"` cannot block an earlier, valid
 * push. `claimed` is empty (and the push therefore allowed) when no foreign claim is live in that repo. Lazy-loads
 * fix-procedure; `deps.fp` injects it (and `deps.lockRoot` the claim store) for tests. Fail-OPEN on any error.
 */
export async function computeFixClaimCtx(cmd, { caller = {}, cwd = process.cwd(), deps = {} } = {}) {
  try {
    const fp = deps.fp ?? await import('./conveyor/fix-procedure.mjs');
    const lockOpt = deps.lockRoot ? { lockRoot: deps.lockRoot } : {};
    const live = fp.listLiveFixClaims(lockOpt).filter((e) => !fp.isClaimHolder(e, caller));
    if (!live.length) return { fixPushes: [] };
    const execOpt = deps.exec ? { exec: deps.exec } : {};
    // The SAME segmentation `decide` uses (heredoc bodies dropped, quote-aware split, nested commands), so each
    // push can be tied to the segment it runs in. A command the parser cannot represent is denied by `decide`
    // before `reason` runs; here it just falls back to the whole text (`segment: null` = matches any segment).
    let segs = null;
    try {
      const hd = heredocScan(cmd);
      const parsed = parseSegments(hd.text);
      if (!hd.unterminated && !parsed.unterminated) {
        const list = parsed.segments.slice();
        if (parsed.continued) list.push(...parseSegments(hd.text, { spliceContinuations: false }).segments);
        segs = withNestedCommands(list, hd.text).map((x) => String(x).trim());
      }
    } catch { segs = null; }
    const units = segs ? segs.map((seg, i) => ({ seg, prefix: segs.slice(0, i).join(' ; ') })) : [{ seg: null, prefix: '' }];
    const fixPushes = [];
    for (const { seg, prefix } of units) {
      for (const dest of fp.resolvePushDestinations(seg ?? cmd, { cwd, prefix, ...execOpt })) {
        fixPushes.push({
          segment: seg,
          repoKey: dest.repoKey ?? null,
          targets: dest.branches ?? [],
          unreliable: Boolean(dest.unreliable),
          // The repo is the one the push GOES TO (its remote, or a URL), never assumed `origin`.
          claimed: live.filter((e) => e.meta?.branch && (dest.repoKey == null || e.meta.repo === dest.repoKey)).map((e) => ({
            branch: e.meta.branch,
            message: fp.pushRefusal({ repo: e.meta.repo, branch: e.meta.branch, ...caller, ...lockOpt })?.message
              ?? `push to ${e.meta.branch} refused: another fixer holds the fix claim on PR #${e.meta.pr}`,
          })),
        });
      }
    }
    return { fixPushes };
  } catch { return { fixPushes: [] }; }
}

/** First deny reason across a command's `&&`/`|`/`;`-separated segments, or null. Pure. `ctx` is passed to
 *  each `reason` call (carries `primaryCwd` for the #2302 rule, `staleBehind` for the #2323 rule,
 *  `foreignLiveLease` for the #2367 rule, and `dispatchKind` for the #3105/#3627 dispatched-session rules). */
export function decide(command, ctx = {}) {
  if (!command) return null;
  // #2788 review r3 finding 2 — a heredoc BODY is data, not commands. The segment split below treats every
  // newline as a separator, so a body line that happens to contain `>` (`Fix the > thing` in a PR-body
  // heredoc) would be read as a redirect. Drop the bodies first; the OPENER line stays, so
  // `cat > config/app.json <<'EOF'` is still caught as the tree write it is.
  const hd = heredocScan(command);
  // r3 audit — the heredoc pass is a parser too, and an unterminated quote in the COMMAND text derails it
  // (it never sees a later opener, and the body then re-parses as commands one quoting phase out). Deny
  // before trusting anything it produced.
  if (hd.unterminated) return unparseableReason(command);
  const fullCommand = command;      // heredoc bodies intact — the NO-POLLING arm scans the ones fed to an interpreter
  command = hd.text;
  // (`>|`, the noclobber-override redirect, used to be pre-normalized to `>` here because the quote-blind
  // split tore it in half at its `|` — r3 finding 2. `splitSegments` consumes a redirect operator run whole,
  // so the rewrite is no longer needed and no longer mangles a `>|` that appears inside a quoted argument.)
  // #2833 finding 3 — whole-command check FIRST: backgrounding is a property of the whole command (a trailing `&`
  // / the `run_in_background` tool param), which the per-segment split below would lose. Deny a backgrounded
  // verification-set run before anything else.
  const bg = backgroundedVerificationReason(command, ctx.runInBackground);
  if (bg) return bg;
  const directTask = backgroundedDirectTaskReason(command, ctx.runInBackground);
  if (directTask) return directTask;
  // #3105 — same whole-command timing as the check above: a dispatched agent's own gate call must be caught
  // before the per-segment split, since the property being checked (is this a verification-set invocation at
  // all) does not depend on which segment of a chained command it sits in.
  const dispatched = dispatchedAgentVerificationReason(command, ctx.dispatchKind);
  if (dispatched) return dispatched;
  // #1550 r3 — the identity override can also straddle segments (`export GIT_AUTHOR_EMAIL=… && git commit`),
  // which the per-segment loop below structurally cannot see. Whole-command, same as the check above it.
  const ident = commitIdentityCommandReason(command);
  if (ident) return ident;
  // 2026-09-06 — dispatched at WHOLE-COMMAND level because the truncating pipe spans the producer and the
  // consumer, which the per-segment loop below would see separately and match neither. The predicate itself
  // does its own pipeline-scoped segmentation (#1961 review r3) rather than reading the string as one blob.
  const trunc = truncatedOperationJsonReason(command);
  if (trunc) return trunc;
  // #x36vidg — a wait-poll is a property of the WHOLE command (the loop keyword, the `sleep`, and the probe
  // sit in different segments), so it is checked here, never per segment. Agent sessions only.
  const waitPoll = agentWaitPollReason(command, { agentSession: ctx.agentSession });
  if (waitPoll) return waitPoll;
  // NO-POLLING — every session kind; after the agent-specific wait-poll arm so that one keeps its sharper message.
  const polling = pollingLoopReason(fullCommand, { runInBackground: ctx.runInBackground });
  if (polling) return polling;
  // #2968 — the pipe/xargs, while-read, and `-exec` enumerate-then-`git add` sink shapes all need more than
  // one segment to see (the enumeration source is a DIFFERENT segment, or the `git add` sits inside a
  // compound whose head word is `while`/`find`). Whole-command, same shape as the two checks above it.
  const addEnum = gitAddEnumerationReason(command);
  if (addEnum) return addEnum;
  // #2994 — QUOTE-AWARE split: tokenize quotes first, cut only on UNQUOTED separators.
  const parsed = parseSegments(command);
  // #2994 review r3 — FAIL CLOSED on a command the parser cannot represent. Every loosening signature this
  // review found reduced to the opposite: the scanner degraded to "consume to end of string" and handed the
  // deny arms one opaque blob. An unterminated quote is not a command bash would run, so this denies nothing
  // real; it just removes the degradation path.
  if (parsed.unterminated) return unparseableReason(command);
  const segments = parsed.segments.slice();
  // A `\`+newline is spliced the way bash splices it (F2). Where the two readings of a continuation can
  // disagree — a MID-COMMAND splice joins a tail that the pre-#2994 per-line split saw as its own command —
  // BOTH readings are checked, so the splice can never be a net loosening. Only pays for itself on the rare
  // command that actually contains a line continuation.
  if (parsed.continued) segments.push(...parseSegments(command, { spliceContinuations: false }).segments);
  // #2994 review r5 — …and the text bash RE-EXECUTES: a `$( )`/backtick substitution, a subshell group's
  // body, an `eval`/`sh -c`/`bash -c` script string, a runner's `exec` remainder. Making the split
  // quote-CORRECT (r1–r4) lost the coverage the quote-BLIND split had by accident, because a nested
  // command stopped being torn open at its separators. Recursing into those positions restores it
  // structurally — and covers the `bash -c "npm run build"` shape base never caught at all.
  for (const seg of withNestedCommands(segments, command)) {
    const r = reason(seg, ctx);
    if (r) return r;
  }
  return null;
}

// #2323 — how many commits is `cwd`'s HEAD behind its upstream (`@{u}`)? Impure (a git call), so it lives in
// the CLI section, not the pure `reason`/`decide` — those stay unit-testable with a plain ctx.staleBehind
// number. A lane clone's local branch tracks `origin/<branch>` from its initial `checkout -B` (lane-pool.mjs
// cloneLane), so `@{u}` resolves there without hardcoding a branch name. Fails OPEN (0) on any error — no
// upstream configured, not a git repo, network hiccup on the fetch this reads (stale local knowledge is still
// informative, we don't fetch here) — a guard bug or an unusual checkout must never wedge the agent.
function commitsBehindUpstream(cwd) {
  try {
    return Number(execFileSync('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || 0;
  } catch {
    return 0;
  }
}

// #2367 — read a lane clone's lease marker (`.git/<LEASE_FILENAME>`, written by `lane-pool.mjs acquire`).
// Impure (fs read); mirrors lane-pool.mjs's own `readLease` (kept separate — this side has no reason to
// depend on the CLI-flags-shaped lane-pool.mjs module). A missing/corrupt marker is "no lease" — fail open.
// #2997 — EXPORTED so `guard-lane.mjs` (the PreToolUse(Edit|Write) gate, which had no lease read at all) reuses
// this exact reader together with `laneRootFromCwd`. The two guards must never drift on what "your lane" means,
// so there is deliberately ONE implementation of the lease-location + lease-read pair and both import it.
export function readLaneLease(laneRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(laneRoot, '.git', LEASE_FILENAME), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// #2997 — every OTHER lane's LIVE lease under the same `.lanes/` root as `laneRoot`. Impure (a readdir + a few
// small file reads); the input to `isContestedLease`, i.e. "is a sibling agent of this lease's session holding
// a lane right now?". Fails OPEN (empty list ⇒ never contested ⇒ today's behaviour) on any fs error — a guard
// fault must never wedge the agent. Only ever called from the already-narrow destructive-op slice, so the cost
// is paid on a tiny fraction of Bash calls.
//
// #2997 r2 (review F3, R2) — the scan is CROSS-POOL. A lane lives at `<…>/.lanes/<pool>/lane-N`, and the first
// cut scanned only `<pool>`. But a session's sibling agents routinely hold lanes in DIFFERENT pools (a
// cross-locus couple leases one lane in the web-everything pool and one in the plateau-app pool — the exact
// shape `release --all-pools` exists for), and the ambient session id is precisely as ambiguous there. Those
// read as UNcontested and the destructive op was allowed. Scanning every pool under `.lanes/` closes it.
//
// STILL OPEN, deliberately (review F3, R1): the sibling that holds NO lane of its own. A lane-less agent of
// session S running a destructive op in S's only leased lane produces no second live lease anywhere, so
// nothing is contested and the op is allowed. Closing that would mean demanding the minted slug for EVERY
// destructive op in EVERY leased lane — a fail-closed default whose false-deny cost lands on every ordinary
// solo flow. Not taken here; recorded on the card and in the PR body instead.
export function siblingLaneLeases(laneRoot, nowMs = Date.now()) {
  try {
    const poolsRoot = dirname(dirname(laneRoot)); // `<…>/.lanes` — the parent of every pool
    const out = [];
    for (const pool of readdirSync(poolsRoot)) {
      const poolDir = join(poolsRoot, pool);
      let entries;
      try { entries = readdirSync(poolDir); } catch { continue; } // a non-directory / unreadable entry: skip it
      for (const name of entries) {
        if (!/^lane-\d+$/.test(name) || join(poolDir, name) === laneRoot) continue;
        const lease = readLaneLease(join(poolDir, name));
        if (lease && !isLeaseStale(lease, nowMs)) out.push(lease);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// #2367/#2413 — the destructive-op lease context for `cwd` (a lane clone about to run what LOOKS like a
// destructive git op). Impure (fs + env); the CLI only calls this when both are already true (isLaneCwd +
// hasDestructiveLaneOp) so the cost is paid on a tiny slice of Bash calls. Reads the lease ONCE and returns
// { markedLeaseSlug, foreignLiveLease }:
//   • Stale / absent lease ⇒ { null, false } (allow — no live hold).
//   • LIVE MARKED (workflowLane) lease ⇒ { <its minted slug>, false } — the #2413 fail-closed slug-assertion
//     regime takes over; the ownerSession compare is NOT consulted (siblings share it, so it fails open in the
//     one topology that matters — the whole reason marked lanes exist).
//   • LIVE UNMARKED lease held by ANOTHER session ⇒ { null, null, true } — the #2367 regime, unchanged (r2's
//     durable-ownerSession-alone compare; degraded no-id ⇒ fail-open allow).
//   • LIVE UNMARKED lease that is MINE-or-indistinguishable AND CONTESTED (a sibling live lease in the pool
//     shares its ownerSession) ⇒ { null, <its minted holder slug>, false } — the #2997 fail-closed regime, the
//     residual #2413 left open by gating the same mechanism on the `workflowLane` marker.
const NO_LEASE_CTX = { markedLeaseSlug: null, contestedHolderSlug: null, foreignLiveLease: false };
function laneLeaseGuardCtx(cwd, mySessionId) {
  const laneRoot = laneRootFromCwd(cwd);
  if (!laneRoot) return NO_LEASE_CTX;
  const lease = readLaneLease(laneRoot);
  if (!lease || isLeaseStale(lease, Date.now())) return NO_LEASE_CTX;
  const marked = laneMarkedSlug(lease);
  if (marked) return { ...NO_LEASE_CTX, markedLeaseSlug: marked };
  // A lease belonging to a provably DIFFERENT session is the #2367 case and keeps its own (clearer) message —
  // so the #2997 contested arm below is only ever consulted for a lease this caller cannot be told apart from.
  if (isForeignLease({ lease, mySessionId })) return { ...NO_LEASE_CTX, foreignLiveLease: true };
  // `requiredAssertionSlug` is the ONE pure place that decides "must this op prove itself?", shared with
  // `lane-pool release` — so the Bash guard and the pool can never disagree about which leases are contested.
  return { ...NO_LEASE_CTX, contestedHolderSlug: requiredAssertionSlug({ lease, siblingLeases: siblingLaneLeases(laneRoot) }) };
}

// ── CLI: read the PreToolUse event, emit a deny decision when blocked ──────────────────────────────────
const IS_CLI = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_CLI) {
  let cmd = '';
  let primaryCwd = false;
  let staleBehind = 0;
  let foreignLiveLease = false;
  let markedLeaseSlug = null;
  let contestedHolderSlug = null;
  let runInBackground = false;
  let dispatchKind = null;
  let agentSession = false;
  let effectiveCwd = null;
  let daemonRoots = [];
  let hookSessionId = null;
  try {
    const ev = JSON.parse(readFileSync(0, 'utf8'));
    cmd = (ev.tool_input || {}).command || '';
    // #2833 finding 3 — the Bash tool's own `run_in_background` param is the primary channel the stall arrives
    // through (the harness detaches the process). Read it so a backgrounded verification run is denied even when
    // the command text carries no `&`.
    runInBackground = !!(ev.tool_input || {}).run_in_background;
    // #3105 — `WE_DISPATCH_KIND` is stamped by `dispatch-lane-io.mjs` onto a mechanically-dispatched agent's
    // `claude --bg` process env (inherited by every hook it runs, same channel `CLAUDE_CODE_SESSION_ID`
    // already relies on below); unset for an interactive operator session, which is unaffected.
    dispatchKind = process.env.WE_DISPATCH_KIND || null;
    // #x36vidg — an AGENT session: a subagent (the documented `agent_id` field Claude Code puts on a hook
    // payload only when the tool call originates inside a subagent) or a dispatched worker. Gates the
    // wait-poll deny; the interactive main session (neither) gets the WARN twin instead.
    // xgqz204 — OR the worker marker (`WE_CONVEYOR_WORKER=1`), which every `claude --bg` dispatch now carries in
    // `--settings` env (the only channel measured to reach a `--bg` session's hook env). Deliberately NOT keyed
    // on stamping `WE_DISPATCH_KIND` onto those sessions: that would also arm the #3105 verification deny, which
    // blocks the `verify-lane.mjs run` gate the fix/ci-heal briefs tell the agent to run.
    agentSession = (typeof ev.agent_id === 'string' && ev.agent_id !== '') || !!dispatchKind
      || classifySession(process.env).role === 'worker';
    // #2367 — the DURABLE session identity. Key on `CLAUDE_CODE_SESSION_ID` (env) FIRST — the SAME source
    // `lane-pool.mjs acquire` stamps into the lease's `ownerSession`, so my own lease can never read as foreign
    // due to a string-source mismatch (r2 correctness fix). The hook payload's `session_id` is only a secondary
    // cross-check/fallback for the rare call where the env is unset. Used to tell my own lease from a peer's.
    const mySessionId = process.env.CLAUDE_CODE_SESSION_ID || ev.session_id || null;
    hookSessionId = mySessionId;
    // #2302 — the Bash cwd decides primary-vs-lane. Derive the constellation primary roots from THIS script's
    // location (<workspace>/<repo>/scripts/guard-bash.mjs) and realpath both sides so a symlinked workspace
    // still matches. Fail-OPEN (leave primaryCwd=false) on any error — a guard bug must never wedge the agent.
    const rp = (p) => { try { return realpathSync(p); } catch { return p; } };
    // #2335 — the reported cwd resets to the primary between calls; honour a leading `cd <lane>` so a genuine
    // lane mutation isn't misread as a primary one (and the #2323 git call runs in the lane, not the primary).
    const cwd = rp(resolveEffectiveCwd(cmd, ev.cwd || process.cwd()));
    effectiveCwd = cwd;
    const weRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const workspace = dirname(weRoot);
    const primaries = ['webeverything', 'web-everything', 'frontierui', 'plateau-app'].map((r) => rp(join(workspace, r)));
    primaryCwd = isPrimaryCwd(cwd, primaries);
    // #xpt9fvd — the daemon-clone registry (seed ∪ every clone the overlay state dir has recorded), computed
    // from the same `workspace` the primaries above use. A fault here fails open (empty list ⇒
    // `daemonCloneWriteReason` denies nothing) rather than wedging the agent.
    try { daemonRoots = daemonCloneRoots(workspace); } catch { daemonRoots = []; }
    // #2323 — only pay for the git call when it could possibly matter: a lane cwd about to run a
    // backlog-mutation command. Every other Bash call (the overwhelming majority) skips it entirely.
    if (!primaryCwd && isLaneCwd(cwd) && isBacklogMutation(cmd)) staleBehind = commitsBehindUpstream(cwd);
    // #2367/#2413 — only pay for the lease read when it could possibly matter: a lane cwd about to run
    // something that LOOKS like a destructive git op. Every other Bash call skips it entirely.
    if (!primaryCwd && isLaneCwd(cwd) && hasDestructiveLaneOp(cmd)) ({ markedLeaseSlug, contestedHolderSlug, foreignLiveLease } = laneLeaseGuardCtx(cwd, mySessionId));
  } catch { process.exit(0); }
  // fix procedure — only pay for the claim-store read when the command could be a `git push` (a bare one names
  // no lane ref, so the gate cannot key on `lane/`). Loaded lazily so every other Bash call keeps this hook's
  // import graph unchanged; the git reads run only when some claim is live. Fail-OPEN on any error.
  let fixPushes = [];
  if (/\bgit\b/.test(cmd) && /\bpush\b/.test(cmd)) {
    ({ fixPushes } = await computeFixClaimCtx(cmd, { caller: { sessionId: hookSessionId, who: process.env.WE_FIX_WHO || null, token: process.env.WE_FIX_TOKEN || null }, cwd: effectiveCwd || process.cwd() }));
  }
  const guardCtx = { primaryCwd, staleBehind, foreignLiveLease, markedLeaseSlug, contestedHolderSlug, runInBackground, dispatchKind, agentSession, cwd: effectiveCwd, daemonCloneRoots: daemonRoots, fixPushes };
  const r = decide(cmd, guardCtx);
  if (r) {
    // #3311 — the deny is ALL-OR-NOTHING, so name the state-producing steps it takes down with it. Computed
    // OUTSIDE `decide` (which stays byte-stable for the golden corpus) and wrapped in its own try/catch: an
    // exception here would abort before the deny is written, turning a refusal into a SILENT ALLOW — the one
    // way an advisory note could weaken the guard. It cannot, now.
    let collateral = '';
    try { collateral = collateralStepsNotice(cmd, guardCtx); } catch { collateral = ''; }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked: ' + r + collateral },
    }));
  }
  // WE_MERGE_BREAK_GLASS=1 on a raw gh-merge command is never silent — mirrors `pr-merge-gate.mjs`'s own
  // `assertMayMerge`, which writes a LOUD line to stderr on every break-glass merge. try/catch: an audit-log
  // fault must never wedge the agent (same discipline as the nudge below).
  try {
    if (!r && mergeBreakGlassUsed(cmd, guardCtx))
      process.stderr.write(`guard-bash: BREAK-GLASS — WE_MERGE_BREAK_GLASS=1 disarmed the raw gh-merge deny (pr-merge-gate.mjs's own escape, reused here) for: ${cmd.trim()}\n`);
  } catch { /* never wedge on an audit-log fault */ }

  // #2749/#2788 — the WARN-only nudge for the un-script-decidable "should have delegated" half. Independent
  // of the deny channel above (fires even when `r` is null — this command wrote no tree); stderr only, never
  // blocks. try/catch: a guard bug here must never wedge the agent.
  try {
    const nudge = [mainSessionDelegateNudge(cmd, { primaryCwd }), interactiveWaitPollNudge(cmd, { agentSession })]
      .filter(Boolean).join(' | ') || null;
    // #2788 review — stderr on an exit-0 PreToolUse hook is NOT surfaced to the user or fed back to the
    // model, so the WARN half shipped as a no-op. Emit it on the structured stdout channel instead
    // (`systemMessage`, the documented field for a non-blocking hook message) and keep writing stderr as a
    // belt-and-braces fallback for a human tailing the hook log.
    // NOTE: the deny path (`hookSpecificOutput`) is proven by this file's own use; `systemMessage` delivery
    // is NOT independently verified here — it is additive and strictly no worse than today's stderr-only
    // behaviour (an unrecognised field is ignored), and it can never deny, so a wrong guess cannot wedge a
    // command. Confirm against the live hook contract before relying on it as the sole channel.
    if (nudge) {
      // #2788 review r2 — stdout must stay ONE JSON document per hook invocation. The deny path above may
      // already have written `hookSpecificOutput`; emitting a second `systemMessage` object after it produced
      // two concatenated JSON documents on one stream, which a strict reader cannot parse — and the deny is
      // the message that matters, so corrupting it to append a nudge is a strictly bad trade. When the
      // command is already denied, the nudge goes to stderr only.
      if (!r) writeAllSync(1, JSON.stringify({ systemMessage: 'guard-bash: ' + nudge }) + '\n');
      process.stderr.write('guard-bash: ' + nudge + '\n');
    }
  } catch { /* never wedge on a nudge-computation fault */ }
  // xpnhz4o — the full-suite escape is never silent: a line on stderr (the hook log) and a JSON line in the
  // gitignored `.conveyor/full-suite-escape.log` of this checkout (`WE_FULL_SUITE_ESCAPE_LOG` overrides). Not on
  // stdout: that channel carries at most ONE JSON document per call (the deny or the nudge above). try/catch: an
  // audit-log fault must never wedge the agent.
  try {
    if (!r && fullSuiteEscapeUsed(cmd)) {
      process.stderr.write(`guard-bash: ESCAPE — ${FULL_SUITE_ESCAPE_ENV}=1 allowed a bare full-suite unit run (xpnhz4o; logged): ${cmd.trim().slice(0, 300)}\n`);
      const logPath = process.env.WE_FULL_SUITE_ESCAPE_LOG
        || join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '.conveyor', 'full-suite-escape.log');
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify({
        at: new Date().toISOString(), session: process.env.CLAUDE_CODE_SESSION_ID || null,
        dispatchKind: dispatchKind || null, command: cmd.trim().slice(0, 500),
      }) + '\n');
    }
  } catch { /* never wedge on an audit-log fault */ }
  process.exit(0);
}
