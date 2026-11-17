import { agentResumeId, launchAgentToCompletion } from '../lib/agent-launch.mjs';
/**
 * @file scripts/operations/codex-delivery-provider.mjs
 * @description The REAL Codex implementation of `we:scripts/operations/deliver-item-wrapper.mjs`'s
 * `DeliveryAgentProvider` port (#3580 / #3627 FIRM REQUIREMENT 6) — a WRITE-CAPABLE, foreground-blocking
 * delivery agent, not the tool-FREE schema-constrained judge role (`we:scripts/lib/codex-judge-spawn.mjs`)
 * and not the operator's manual escape hatch (`we:scripts/codex-direct-task.mjs`).
 *
 * ── SEQUENCING NOTE, STATED PLAINLY ──────────────────────────────────────────────────────────────────────
 * `#3581` ratified that Codex proves itself as a REVIEWER before it does delivery work. The operator
 * explicitly chose to build this ahead of that gate — a deliberate, informed call, recorded here rather than
 * left to look like an oversight. Nothing below makes Codex the DEFAULT: `deliverItem`'s default provider is
 * still `CLAUDE_RESTRICTED_PROVIDER`, and reaching this file requires naming `--provider=codex` (the
 * dispatcher passes it for an item's `deliveryAgent: codex` marker + reason) on purpose.
 *
 * ── EVERY FLAG BELOW WAS CONFIRMED LIVE, NOT ASSUMED (codex-cli 0.153.4, 2026-09-12) ─────────────────────
 * The previous `CODEX_PROVIDER` stub named three unknowns and threw rather than guess. All three are now
 * answered by real invocations, each reproduced in a scratch git repo before a line of this file was written
 * (the `we:docs/agent/prototype-based-dev.md` discipline: mock the spawn in the TEST, but ground the argv in
 * a real run first, because the spawn seam is exactly where every real bug has lived).
 *
 * UNKNOWN 1 — "does Codex have a write-capable invocation, and what turns it on?"  ANSWERED.
 *   Two shapes work, and this file deliberately picks the SECOND:
 *     (a) `-s workspace-write` — the obvious one. REJECTED, for two independent measured reasons below.
 *     (b) `-c default_permissions=locked -c 'permissions={locked={extends=":workspace", …}}'` — the named
 *         permission profile. `extends=":workspace"` grants the SAME write access `-s workspace-write` does
 *         (live: a file was created in the working root under (b) with no `-s` flag present at all).
 *   WHY (b) AND NOT (a), on evidence:
 *     1. `codex exec resume` DOES NOT ACCEPT `-s` AT ALL — confirmed against the real `codex exec resume
 *        --help`, whose entire flag list is `-c --last --all --enable --disable -i --strict-config -m
 *        --dangerously-* --thread-source --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
 *        --output-schema --json -o`. There is no `-s` and no `-C`. This port's contract needs ONE sandbox
 *        posture that holds across BOTH a fresh spawn and a resume (`resumeAgentWithGateFailure` hands the
 *        agent a new turn on the same thread), and `-c` is the only mechanism that spans both. A `-s`-based
 *        provider would silently run its resume turn under a DIFFERENT, un-chosen sandbox.
 *     2. `-s` silently DEFEATS the deny map. `we:scripts/lib/isolation-provider.mjs#buildNativeDenyCodexArgs`
 *        documents this from #3371 Probe 14f's own re-verification: `-s workspace-write` and
 *        `-s danger-full-access` each made the `permissions` deny entries have ZERO effect. `-s` is Codex's
 *        selector for one of its three BUILT-IN profiles and wins over a custom `default_permissions`
 *        selection rather than composing with it — the two are alternatives, not a combination.
 *   So this file passes NO `-s`, ever, on either branch. See {@link buildCodexDeliveryArgv}.
 *
 * UNKNOWN 2 — "is there a blocking/foreground invocation this port's `spawn` contract can rely on?"  YES.
 *   `codex exec` is non-interactive by design and returns when the turn ends. Confirmed through the EXACT
 *   primitive this file uses — a real `execFileSync('codex', argv, { stdio: ['ignore','pipe','pipe'] })` from
 *   Node — which blocked for 8.5s, exited 0, and left the requested file on disk. Two earlier shell-level
 *   runs behaved identically (12s and 11s). There is no `--bg`, no detach, no poll.
 *   THE ONE REAL TRAP, AND WHY `stdio[0]` IS `'ignore'` AND NOT INHERITED: `codex exec`'s own `--help` says
 *   "If not provided as an argument (or if `-` is used), instructions are read from stdin. If stdin is piped
 *   and a prompt is also provided, stdin is appended as a `<stdin>` block." A spawn that supplies BOTH a
 *   positional prompt AND a piped, never-closed stdin HANGS FOREVER — reproduced and documented by
 *   `we:scripts/lib/codex-judge-spawn.mjs`'s own header. That module dodges it by passing no positional
 *   prompt and closing stdin itself; it can, because it uses async `spawn`. This port's contract is a
 *   SYNCHRONOUS blocking call (`execFileSync` cannot write to a child's stdin at all), so the dodge here is
 *   the other one: a positional prompt plus `stdio[0] = 'ignore'`, which hands the child `/dev/null` and an
 *   immediate EOF. That exact combination is what the 8.5s live run above exercised. NEVER change `stdio[0]`
 *   here — an inherited or piped stdin turns a 60-minute timeout into the only thing that ends the run.
 *
 * UNKNOWN 3 — "does Codex have any hook-equivalent, i.e. what replaces guard-lane.mjs / guard-bash.mjs?"
 *   ANSWERED, and the answer is that it needs no PORT of those two hooks, because its NATIVE permission
 *   profile already enforces the same two protections at the OS layer, more strongly. Measured, not reasoned:
 *   with `-c default_permissions=locked -c 'permissions={locked={extends=":workspace"}}'` rooted at a real
 *   lane clone, via `codex sandbox -P locked` (a raw command wrapper with NO model in the loop, so this is a
 *   syscall result and not model cooperation):
 *     • write into the PRIMARY checkout (`~/workspace/webeverything/PWNED.txt`) → `Operation not permitted`.
 *       `we:scripts/guard-lane.mjs`'s whole first arm, enforced by Seatbelt instead of a `PreToolUse` hook —
 *       and STRICTLY STRONGER, because that hook matches `Edit|Write` TOOL calls and cannot stop a shell
 *       redirect, which this does.
 *     • write into a SIBLING lane (`…/.lanes/web-everything/lane-18/PWNED.txt`) → `Operation not permitted`.
 *       This closes `guard-lane.mjs`'s OWN documented residual #2 ("an `Edit` into a sibling's lane therefore
 *       still passes"), which is open today under the Claude provider.
 *     • write inside its own lane → allowed (exit 0, file present). The build still works.
 *     • network: `git ls-remote origin` → `ssh: Could not resolve hostname github.com`; a `curl` to
 *       api.github.com → exit 6, HTTP 000. The `:workspace` profile has NO network. So `git push` — the
 *       single most important thing `we:scripts/guard-bash.mjs` denies (the `main`-push block) — is not
 *       denied by a rule the agent could argue with; it is STRUCTURALLY IMPOSSIBLE. Nothing in the delivery
 *       brief needs the network (the wrapper owns the gate, converge, the PR and the labels — FIRM
 *       REQUIREMENTS 1-3 — and the lane arrives with deps already installed), so this costs nothing.
 *   WHAT IS THEREFORE *NOT* BUILT HERE, AND WHY THAT IS THE RIGHT CALL: no re-implementation of
 *   `guard-bash.mjs`'s destructive-git-op table. What that table protects against — `git reset --hard`,
 *   `git clean -fdx`, a broad `git add` — is, for an agent Seatbelt has confined to one lane clone, damage
 *   to a DISPOSABLE, ISOLATED directory and nothing else. The lane IS the blast radius, and the lane is
 *   rebuilt by `lane-pool.mjs` as a matter of course. Building a guard for that would be building a guard for
 *   a risk that is already bounded to the thing it would protect.
 *   THE HONEST RESIDUAL, stated rather than papered over: `:workspace` confines WRITES, not READS. A Codex
 *   delivery agent can still READ outside its lane. {@link defaultDeliveryDenyPaths} closes the one read
 *   that actually matters (the shared primary checkout, which routinely holds another session's in-flight
 *   uncommitted work) via the `filesystem` deny map, and `denyPaths` is a parameter so a caller can close
 *   more. Sibling-lane READS remain open — their committed content is identical to the agent's own lane copy,
 *   so the marginal leak is another agent's uncommitted diff, and expressing "every sibling lane but mine" as
 *   a glob is exactly the kind of fragile guess this file refuses to make. Read isolation in the adversarial
 *   sense is `we:scripts/lib/isolation-provider.mjs`'s territory (#3371) and #3621's read-allowlist work, not
 *   this port's.
 *   A FURTHER HONEST LIMIT on the deny map specifically, carried over verbatim from `isolation-provider.mjs`
 *   because it applies here unchanged: inside `codex exec` the deny is surfaced to the MODEL, which
 *   self-declines (live: "the active permission policy explicitly denies reading that path"). That is a
 *   model-cooperation signal. The OS-enforced half of the identical profile is what `codex sandbox -P locked`
 *   proves above. Treat the `codex exec` read-deny as strong-in-practice, and the write/network confinement
 *   as the genuinely OS-level guarantee — they are different strengths and this file does not conflate them.
 *
 * ── THE MINIMAL-CONTEXT HALF (FIRM REQUIREMENT 5) ────────────────────────────────────────────────────────
 * `-c project_doc_max_bytes=0` is Codex's `--restricted`-equivalent for doctrine: it suppresses the CLI's
 * automatic startup read of `we:AGENTS.md` into the model's context. Live-confirmed here a third time, in
 * write mode, by asking a real run whether any instructions file had been auto-loaded: *"No `AGENTS.md` was
 * automatically loaded into my startup context."* It is also MANDATORY alongside any `filesystem` deny, not
 * an optional extra — #3371 Probe 14f found the AGENTS.md auto-loader trips its own denial and kills session
 * startup outright ("failed to load AGENTS.md instructions … Operation not permitted") without it. Both
 * reasons point the same way, so it is passed unconditionally.
 * `--strict-config` is passed for the reason Probe 14h found the hard way: plain `-c` keys are NOT validated
 * without it, which makes "this key had no effect" and "this key does not exist" indistinguishable. With it, a
 * key that a future Codex release renames fails LOUD instead of silently dropping the sandbox.
 *
 * ── NATIVE THREAD ID ───────────────────────────────────────────────────────────────────────────────────
 * Codex announces its id in thread.started. New receipts are keyed by that same id and carry only
 * sessionId; the wrapper persists it in the delivery report and supplies it unchanged on resume.
 * readCodexThreadId also reads old { sessionSlug, threadId } receipts for recovery of existing runs.
 *
 * PURE / IMPURE SPLIT, the same discipline `codex-judge-spawn.mjs` and `minimal-context-provider.mjs` keep:
 * `buildCodexDeliveryArgv`, `parseCodexThreadId` and `assertDenyPathsUsable` are PURE — no fs, no spawn, no
 * clock — so the argv, which IS the contract with the CLI, is assertable by a test with no subprocess at all.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CODEX_EFFORT_MAP, CODEX_MODEL, assertCodexModel, resolveCodexEffort,
} from '../lib/codex-model-routing.mjs';
import { buildNativeDenyCodexArgs } from '../lib/isolation-provider.mjs';
import { REPO_ROOT } from './minimal-context-provider.mjs';
import { usageReportSecretDir } from '../lib/usage-report-secret-paths.mjs';
import { recordTokenUsage } from './telemetry-store.mjs';

/** The binary. Named, not inlined, for the same reason `codex-judge-spawn.mjs#CODEX_CLI` is. */
export const CODEX_CLI = 'codex';

/**
 * The Codex model pin — NOW AN IMPORT, discharging this constant's own follow-up note.
 *
 * It shipped as a hand-copied `'gpt-6-astra'` literal with a header that flagged the duplication and said
 * *"CONSOLIDATE to that single source when this branch merges — that is a real follow-up, not a note to
 * ignore."* The blocker it named (#x8wbivt's constants landed on `main` AFTER this prototype branch forked,
 * so the import would not resolve) is gone: `origin/main` is merged into this branch and the constants now
 * live in `we:scripts/lib/codex-model-routing.mjs`, the single source all three Codex call sites share.
 *
 * The BEHAVIOUR here is unchanged — this provider already passed `-m` unconditionally, so it was never the
 * Fork-1 hole that `codex-judge-spawn.mjs` was. What changes is that a re-ratification of the pin (a new
 * model, a retired catalogue entry) now reaches this file on its own, instead of needing someone to remember
 * a third copy existed. `CODEX_DELIVERY_MODEL` is KEPT as a name — it is this module's published surface and
 * its tests use it — but it is now an alias of the ratified constant, not a second declaration of it.
 */
export const CODEX_DELIVERY_MODEL = CODEX_MODEL;

/**
 * The `model_reasoning_effort` levels this provider accepts — the keys of the shared `CODEX_EFFORT_MAP`,
 * derived rather than retyped, so this list cannot drift from the one `codex-direct-task.mjs` and
 * `codex-judge-spawn.mjs` validate against.
 *
 * IDENTITY, not a clamp: `#x8wbivt` re-checked the older clamp-to-`high` convention against the CLI's own
 * server-fetched catalogue AND against execution — `gpt-6-astra`'s `supported_reasoning_levels` are all six,
 * and a live ping at each of `xhigh`/`max`/`ultra` completed normally. Clamping was therefore silently
 * DOWNGRADING an explicit choice and recording nothing. A caller who overrides `model` may name a level that
 * model does not offer; Codex answers that with its own error. This validates the VOCABULARY, not the
 * entitlement.
 */
export const CODEX_DELIVERY_EFFORT_LEVELS = Object.freeze(Object.keys(CODEX_EFFORT_MAP));

/**
 * The delivery agent's default reasoning effort. `'medium'` is the `sonnet` rung of #x8wbivt's ratified
 * three-rung ladder — the rung that card's routing rule makes the default for ordinary build-shaped work, and
 * chosen EXPLICITLY here rather than inherited (the same card refuses an implicit default). Resolved THROUGH
 * `resolveCodexEffort` rather than retyped as `'medium'`, so re-ratifying the ladder moves this too.
 * Overridable per call via `buildCodexDeliveryArgv`'s `effort`.
 */
export const CODEX_DELIVERY_EFFORT = resolveCodexEffort({ tier: 'sonnet' });

/**
 * The `.operations/` sidecar holding receipts keyed by the native Codex thread id — the same sidecar family
 * `delivery-report-store.mjs` and `persistSpawnFailure` already write into, so a Codex delivery leaves its
 * durable crumbs in the one place an operator already looks.
 */
export const CODEX_THREAD_DIR_NAME = 'codex-delivery-threads';

/**
 * The default `filesystem` deny entries for a delivery run — the shared PRIMARY checkout, which is the one
 * off-lane READ that carries real risk (it routinely holds another session's uncommitted work; see the file
 * header's residual note for what this deliberately does NOT cover). A caller may pass its own `denyPaths`.
 *
 * A FUNCTION, not a frozen constant, because the answer depends on where the WRAPPER process is running:
 * `REPO_ROOT` is this module's own checkout, which in a lane-clone deployment is itself a lane.
 */
export function defaultDeliveryDenyPaths(repoRoot = REPO_ROOT) {
  const root = String(repoRoot).replace(/\/+$/, '');
  // epic #3383 — the usage-report tool's external admin-key directory is ALWAYS included here, unconditionally,
  // alongside the caller's own repo root: a Codex delivery/repair agent must never be able to read
  // ~/.we-usage-report/ even if a caller overrides denyPaths for its own reasons. Imported from the SAME shared
  // constant usage-report.mjs itself resolves (scripts/lib/usage-report-secret-paths.mjs), so the two can never
  // drift — see that module's own header for why this directory sits outside the repo entirely in the first
  // place (a lane clone would otherwise carry it on disk regardless of any deny-list).
  return [`${root}/**`, `${usageReportSecretDir()}/**`];
}

/**
 * PURE guard. A deny entry that covers the agent's OWN lane would deny the build itself — an impossible
 * configuration that must fail loudly at argv-build time rather than as a baffling mid-run permission error.
 * Compares resolved path PREFIXES only (the deny entries this file produces are always `<dir>/**`), which is
 * exactly the shape `defaultDeliveryDenyPaths` emits; a caller passing an exotic glob is trusted, because
 * re-implementing Codex's own glob matcher to second-guess them would be a guess, not a check.
 *
 * @param {string[]} denyPaths
 * @param {string} lanePath - the resolved, absolute lane clone the agent will work in.
 */
export function assertDenyPathsUsable(denyPaths, lanePath) {
  if (typeof lanePath !== 'string' || !lanePath.trim()) {
    throw new TypeError('codex-delivery-provider: `lanePath` must be a non-empty absolute path');
  }
  const lane = lanePath.replace(/\/+$/, '');
  for (const entry of denyPaths) {
    const prefix = entry.replace(/\/\*\*$/, '').replace(/\/+$/, '');
    if (lane === prefix || lane.startsWith(`${prefix}/`)) {
      throw new Error(
        `codex-delivery-provider: refusing to deny ${JSON.stringify(entry)} — it covers the agent's own lane `
        + `(${lane}), which would make the build itself unreadable. Pass a \`denyPaths\` that excludes the lane.`,
      );
    }
  }
  return denyPaths;
}

/**
 * The repo-relative path of `fix-report-cli.mjs` and its own complete (small, pure) dependency closure — every
 * file it, or a file it imports, needs at runtime. Order does not matter to {@link stageFixReportCliIntoLane};
 * it is listed here in import order purely for a human reader.
 */
export const FIX_REPORT_CLI_REL_FILES = Object.freeze([
  'scripts/operations/fix-report-cli.mjs',
  'scripts/operations/fix-report-store.mjs',
  'scripts/operations/fix-report-record.mjs',
  'scripts/lib/write-all-sync.mjs',
]);

/** Repo-relative staging root, INSIDE the agent's own lane — a sibling of `.operations/fix-reports/` etc.,
 *  same gitignored `.operations/` family (never committed, never read by anything but this dispatch). */
export const CODEX_FIX_REPORT_CLI_STAGING_SUBDIR = '.operations/codex-fix-report-cli';

/**
 * THE FIX for mechanical-dispatcher (#3383) Bug 1 — a Codex fix/ci-heal dispatch was BLOCKED BY CONSTRUCTION,
 * on every real trial, before the agent could report even a `started` check-in. Root cause, confirmed live
 * (real PR #2115, then reproduced deterministically): `fix-dispatch-wrapper.mjs#FIX_REPORT_CLI_PATH` resolves
 * to an ABSOLUTE path inside the PRIMARY checkout (`${REPO_ROOT}/scripts/operations/fix-report-cli.mjs`) — by
 * design, because the target PR's own lane, reconstituted from its pre-merge `headRefName`, structurally lacks
 * that file until this branch merges (see that constant's own docblock). But {@link defaultDeliveryDenyPaths}
 * denies the Codex sandbox READ access to the ENTIRE primary checkout root (`${REPO_ROOT}/**`) — ALSO by
 * design, to stop a delivery/repair agent reading another session's uncommitted work (this file's own header,
 * UNKNOWN 3). Those two by-design choices collide: the one file every Codex fix/ci-heal agent must invoke to
 * report ANY outcome is a path the same provider denies itself the right to read. Deterministic, not
 * `#2115`-specific — every dispatch hits it.
 *
 * THE FIX SHAPE, and why this one over the alternative (widening the deny-list): copy the CLI's own
 * dependency closure ({@link FIX_REPORT_CLI_REL_FILES}) into the agent's OWN lane, preserving each file's path
 * RELATIVE TO THE REPO ROOT exactly (`scripts/operations/fix-report-store.mjs`, `scripts/lib/
 * write-all-sync.mjs`, …) so their existing relative `import`s resolve completely unchanged — nothing about
 * the copied files' own source is rewritten, so there is exactly one copy of this logic to ever audit or
 * drift. The lane is inside `:workspace` — the one location every Codex sandbox profile this provider builds
 * always grants read+write on, the same as the agent's own repair edits — so a path under it is reachable BY
 * CONSTRUCTION, the same way `defaultDeliveryDenyPaths` made the primary checkout UNREACHABLE by construction.
 * Narrowing the deny-list instead (letting Codex read exactly this one primary-checkout file) was rejected: it
 * would need the deny-list to special-case one path inside the very root it exists to seal off, on every
 * future primary-checkout file a wrapper might someday hand down the same way — a widening, recurring risk to
 * the read-isolation guarantee, for a problem this copy fully solves without touching the deny-list at all.
 *
 * Runs on EVERY Codex fix/ci-heal spawn (fresh or resume) — cheap (four small pure files with no dependencies
 * of their own beyond `node:fs`/`node:path`/`node:url`) and idempotent (plain overwrite), so re-staging on a
 * resume costs nothing and self-heals a lane whose staged copy was somehow removed mid-dispatch.
 *
 * UNLIKE this module's telemetry helpers, this THROWS on failure rather than swallowing it: a failed copy
 * reproduces the EXACT defect this function exists to fix, one layer later, and a caller that let that pass
 * silently would ship the same bug back under a different, more confusing error (a Codex agent unable to
 * explain why its own report command is missing, instead of a wrapper that fails loud before ever spawning).
 *
 * @param {string} lanePath - the resolved, absolute lane clone the Codex agent will run in.
 * @param {object} [io]
 * @param {string} [io.repoRoot] - defaults to {@link REPO_ROOT} (mirrors every other function in this module).
 * @param {(path: string) => string} [io.readFile] - injectable `readFileSync(path, 'utf8')`, for tests.
 * @param {(path: string) => void} [io.ensureDir] - injectable `mkdirSync(path, {recursive: true})`, for tests.
 * @param {(path: string, data: string) => void} [io.writeFile] - injectable `writeFileSync`, for tests.
 * @returns {string} the absolute, staged path to the copied `fix-report-cli.mjs` — the new
 *   `FIX_REPORT_CLI_PATH` for this one dispatch, reachable from inside the Codex sandbox.
 */
export function stageFixReportCliIntoLane(lanePath, {
  repoRoot = REPO_ROOT,
  readFile = (p) => readFileSync(p, 'utf8'),
  ensureDir = (p) => mkdirSync(p, { recursive: true }),
  writeFile = (p, data) => writeFileSync(p, data),
} = {}) {
  if (typeof lanePath !== 'string' || !lanePath.trim()) {
    throw new TypeError('codex-delivery-provider: `lanePath` must be a non-empty absolute path');
  }
  const root = String(repoRoot).replace(/\/+$/, '');
  const lane = lanePath.replace(/\/+$/, '');
  const stagingRoot = join(lane, CODEX_FIX_REPORT_CLI_STAGING_SUBDIR);
  let stagedCliPath = null;
  for (const relPath of FIX_REPORT_CLI_REL_FILES) {
    const dest = join(stagingRoot, relPath);
    ensureDir(dirname(dest));
    writeFile(dest, readFile(join(root, relPath)));
    if (relPath === 'scripts/operations/fix-report-cli.mjs') stagedCliPath = dest;
  }
  return stagedCliPath;
}

/**
 * PURE. The `codex` argv — the fresh-`exec` shape, or the `exec resume <thread-id>` shape when
 * `resumeThreadId` is given. THE ARGV IS THE CONTRACT WITH THE CLI, so this is separated out and exported for
 * the same reason `buildRestrictedProviderArgv` and `buildAgentArgv` are: a flag rename upstream must break a
 * test, not a production delivery.
 *
 * DIFFERENCES BETWEEN THE TWO BRANCHES ARE NOT STYLISTIC — they are what the real CLI accepts (verified
 * against `codex exec --help` and `codex exec resume --help` on 0.153.4):
 *   - `-C <cwd>` appears ONLY on the fresh branch. `exec resume` has no `-C`; the resume's working root comes
 *     from the spawned process's own `cwd` option instead (live-confirmed: a resume run from inside the
 *     working root wrote its file there correctly).
 *   - NO `-s` on EITHER branch, deliberately — see the file header, UNKNOWN 1.
 *   - NO `--ephemeral` on either branch, deliberately: `--ephemeral` writes no session to disk, and a session
 *     that was never persisted cannot be resumed. This port REQUIRES resume (the gate-failure hand-back), so
 *     persistence is load-bearing here, unlike in the fire-and-forget judge role which does pass it.
 *   - The prompt is POSITIONAL on both branches, which is safe only because the spawn closes stdin — see the
 *     file header's stdin-trap note before changing either half of that pair.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} o.cwd - the resolved lane clone.
 * @param {string[]} o.denyPaths - `filesystem` deny entries, non-empty.
 * @param {string|null} [o.resumeThreadId] - Codex's own thread id; the resume branch when present.
 * @param {string[]} [o.writableRoots] - #4348: extra writable roots beyond `cwd` (a cross-locus item's WE
 *   lane, which holds the spec while `cwd` is the impl lane). Carried in the permission profile, not
 *   `--add-dir`, so the resume branch keeps the same grant. Omitted → argv unchanged.
 * @param {string} [o.model]
 * @param {string} [o.effort]
 * @returns {string[]} argv AFTER the binary name.
 */
export function buildCodexDeliveryArgv({
  prompt, cwd, denyPaths, resumeThreadId = null, writableRoots = [],
  model = CODEX_DELIVERY_MODEL, effort = CODEX_DELIVERY_EFFORT,
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('codex-delivery-provider: `prompt` must be a non-empty string');
  }
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new TypeError('codex-delivery-provider: `cwd` must be the resolved lane clone path');
  }
  const pinnedModel = assertCodexModel(model, 'codex-delivery-provider');
  if (!CODEX_DELIVERY_EFFORT_LEVELS.includes(effort)) {
    throw new TypeError(
      `codex-delivery-provider: \`effort\` must be one of ${CODEX_DELIVERY_EFFORT_LEVELS.join('|')}, `
      + `got ${JSON.stringify(effort)}`,
    );
  }
  // `buildNativeDenyCodexArgs` (`we:scripts/lib/isolation-provider.mjs`, #3371 Probe 14f/14h) is REUSED, not
  // re-derived: it already emits exactly `--strict-config -c permissions={locked={extends=":workspace",
  // filesystem={…}}} -c default_permissions=locked -c project_doc_max_bytes=0`, which is the whole sandbox +
  // doctrine-suppression posture this provider needs, and it already validates its input. Re-typing that
  // string here would be a second copy of a contract that has been burned into once already.
  const sandboxArgs = buildNativeDenyCodexArgs(denyPaths, { writableRoots });
  const common = [
    '--json',
    '--skip-git-repo-check',
    // #3635 Fork 1: unconditional, on BOTH the fresh-spawn and the `exec resume` path (`common` is shared by
    // construction, so a resume can never silently drop the pin the first turn was run under).
    '-m', pinnedModel,
    '-c', `model_reasoning_effort=${effort}`,
    ...sandboxArgs,
  ];
  return resumeThreadId
    ? ['exec', 'resume', String(resumeThreadId), ...common, prompt]
    : ['exec', '-C', cwd, ...common, prompt];
}

/**
 * PURE. Pull Codex's own thread id out of a `--json` run's stdout. The stream is JSONL — one object per line —
 * and the id arrives in the FIRST `thread.started` event (live shape, verbatim:
 * `{"type":"thread.started","thread_id":"01a09887-f68c-7352-b8b3-5da35f7d0b68"}`). A resume re-announces the
 * SAME id, which is how the resume was confirmed to be a genuine continuation rather than a new session.
 *
 * Tolerant of unparseable lines on purpose: the stream is Codex's, not ours, and a single malformed line must
 * not cost the caller the thread id that a later line still carries.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
export function parseCodexThreadId(stdout) {
  if (typeof stdout !== 'string' || !stdout) return null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
      return event.thread_id;
    }
  }
  return null;
}

/** The sidecar path for one session's Codex thread id. Exported so a test can assert the location rather
 *  than re-derive it, and so an operator can find it. */
export function codexThreadIdPath(sessionSlug, repoRoot = REPO_ROOT) {
  return `${repoRoot}.operations/${CODEX_THREAD_DIR_NAME}/${sessionSlug}.json`;
}

/**
 * Record the native id a fresh spawn minted, under that same id. Best-effort:
 * a failure to write the crumb must not fail a delivery that has otherwise just succeeded — the only thing
 * lost is the ability to resume, which `readCodexThreadId`'s own caller reports clearly if it comes to that.
 */
export function writeCodexThreadId(sessionId, repoRoot = REPO_ROOT) {
  try {
    const path = codexThreadIdPath(sessionId, repoRoot);
    mkdirSync(`${repoRoot}.operations/${CODEX_THREAD_DIR_NAME}`, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ sessionId, at: new Date().toISOString() }, null, 2)}\n`);
    return path;
  } catch { return null; }
}

/** Read back the thread id a previous fresh spawn recorded, or `null` when there is none. */
export function readCodexThreadId(sessionSlug, repoRoot = REPO_ROOT) {
  try {
    const parsed = JSON.parse(readFileSync(codexThreadIdPath(sessionSlug, repoRoot), 'utf8'));
    // Old on-disk receipts carried { sessionSlug, threadId }; new receipts carry only the native id.
    const sessionId = parsed?.sessionId ?? parsed?.threadId;
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
  } catch { return null; }
}

/**
 * The blocking spawn primitive — the Codex counterpart to `dispatch-lane-io.mjs#spawnAgentToCompletion`, which
 * hardcodes `'claude'` and so cannot be reused. Resolves `{stdout, stderr, resourceUsage}` (unlike the Claude
 * one's own `spawnAgentToCompletion`, whose caller discards `stdout`), because the thread id this port's resume
 * branch depends on exists nowhere else.
 *
 * #3383 follow-up — ASYNC now, built on `scripts/lib/spawn-to-completion.mjs#spawnToCompletion` (was
 * `execFileSync`; see that module's own header for the full execFileSync-equivalence contract this inherits
 * unchanged — stdout/stderr capture, exit-code/signal/timeout/maxBuffer handling — and for why the `resourceUsage`
 * field it also returns is honestly `null` on real Node, not a real per-child CPU reading: `ChildProcess` has no
 * `resourceUsage()` method at all, contrary to an earlier assumption). Every EXISTING caller already awaits
 * this (`CODEX_PROVIDER.spawn` and its `fix`/`ci-heal` siblings, all async), so this conversion is a drop-in:
 * the same blocking-until-done semantics, just implemented via an awaited promise instead of a synchronous
 * return.
 *
 * `stdio: ['ignore', 'pipe', 'pipe']` is LOAD-BEARING, not housekeeping — see the file header's stdin-trap
 * note. `killSignal: 'SIGKILL'` mirrors `dispatch-lane-io.mjs#spawnAgentToCompletion`: a wedged agent is still
 * reclaimed when the caller's `timeout` fires.
 */
export function defaultSpawnCodexAgent(argv, opts = {}, io = {}) {
  return launchAgentToCompletion({ mode: agentResumeId(argv) ? 'codex-exec-resume' : 'codex-delivery', resumeId: agentResumeId(argv) }, CODEX_CLI, argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    killSignal: 'SIGKILL',
    ...opts,
  }, io);
}


// ── SELF-TRACKED TOKEN USAGE (epic #3383, usage-ledger follow-up) ──────────────────────────────────────────
// Codex has no official OpenTelemetry usage export (unlike Claude Code — see `claude-otel-collector.mjs` and
// `telemetry-store.mjs#recordTokenUsage`'s own header), so this reads the ONE thing Codex already gives every
// `--json` run: its own `turn.completed`/`turn.failed` event's `usage` block — the SAME field
// `scripts/lib/codex-judge-spawn.mjs#parseCodexJudgeOutcome` already scans for, re-derived here (not
// imported) because that module's own parser THROWS on a delivery agent's free-form text answer (it expects a
// `--json-schema`-constrained JSON reply, which no delivery/fix/ci-heal turn produces) — a usage-only reader
// must never share a failure mode with an answer-shape reader it has nothing in common with.
/**
 * PURE. Best-effort, never-throw scan of a Codex `--json` run's JSONL stdout for its terminal event's own
 * token counts. Scans from the END (mirrors `parseCodexJudgeOutcome`'s own `turn.completed`/`turn.failed`
 * reasoning: a retry's earlier `error`/`turn.started` lines are never terminal). Returns `null` when no
 * terminal event or no `usage` block is found — a caller that gets `null` records nothing, rather than a
 * caller ever seeing a thrown error over a usage-only read.
 * @param {string} stdout
 * @returns {{tokensIn: number, tokensOut: number, tokensCacheRead: number, tokensCacheWrite: number}|null}
 */
export function parseCodexTurnTokenUsage(stdout) {
  try {
    const lines = String(stdout ?? '').split('\n');
    let terminal = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      let event;
      try { event = JSON.parse(trimmed); } catch { continue; }
      if (event?.type === 'turn.completed' || event?.type === 'turn.failed') { terminal = event; break; }
    }
    const usage = terminal?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const n = (k) => (typeof usage?.[k] === 'number' ? usage[k] : 0);
    return {
      tokensIn: n('input_tokens'), tokensOut: n('output_tokens'),
      tokensCacheRead: n('cached_input_tokens'), tokensCacheWrite: 0, // Codex reports no separate cache-write figure
    };
  } catch {
    return null;
  }
}

/**
 * Parse + record one Codex delivery/fix/ci-heal turn's token usage against the ACTIVE telemetry recorder, via
 * the shared `recordTokenUsage` (`telemetry-store.mjs`) — same ambient pattern `acquireLane` uses. Never
 * throws; a parse miss (no terminal event, non-JSON stdout) simply records nothing. `model` defaults to
 * {@link CODEX_DELIVERY_MODEL} — the model this port's own argv already requested — rather than trying to
 * re-derive it from the JSONL stream, which does not reliably carry it on every event observed.
 * @param {string} stdout
 * @param {{model?: string}} [o]
 */
export function recordCodexTurnUsage(stdout, { model = CODEX_DELIVERY_MODEL } = {}) {
  try {
    const usage = parseCodexTurnTokenUsage(stdout);
    if (usage) recordTokenUsage({ provider: 'codex', model, ...usage });
  } catch { /* telemetry must never mask a real spawn result */ }
}
