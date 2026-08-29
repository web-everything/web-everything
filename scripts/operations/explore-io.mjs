/**
 * @file scripts/operations/explore-io.mjs
 * @description THE IO SHELL of the `explore` declaration (#3150, under epic #3029) — the SINK that starts one
 *   panelist's investigation, the OBSERVER that later asks how it went, and the two TERMINAL sinks a run may
 *   end on.
 *
 * WHY IT IS A SEPARATE FILE. {@link ./explore.mjs} is the declaration: what the operation IS. This is the only
 * place it touches the world — the same pure-core / io-shell split {@link ./dispatch-lane-io.mjs} and
 * {@link ./review-pr-io.mjs} use, and what lets the declaration be unit-tested with a two-line stub spawner.
 *
 * EVERY BINDING HERE SHELLS SOMETHING THAT ALREADY EXISTS, or writes one file:
 *   - the panelist spawn is `claude --bg --session-id <uuid>` — `--session-id` is PASSED but PROVEN IGNORED by
 *     the real CLI on a `--bg` spawn (#3331), same as `dispatch-lane`'s sink now documents. The minted id is
 *     kept for a DIFFERENT reason here: {@link panelistReportPath} uses it (never the CLI's real session id,
 *     which does not exist until after the agent starts) to keep one attempt's report off a name a sibling
 *     panelist or a retry could guess. Liveness matching does not use it at all — see
 *     {@link investigatorSessionName} and the observer below;
 *   - the liveness axis is `claude agents --json`, asked exactly as the dispatch observer asks it, but matched
 *     by NAME (the deterministic `-n` this sink sets), not by id — #3331 again;
 *   - filing a story is `we:scripts/backlog.mjs scaffold --json`, the real CLI — so JIT hash numbering (#2288),
 *     the skeleton renderer and the guarded write are ONE implementation, not a second one that drifts.
 *
 * ── WHERE A PANELIST'S REPORT LIVES, AND WHY IT IS NOT IN THE CHECKOUT ───────────────────────────────────────
 *
 * A report is a file the DISPATCHED AGENT writes and this process later reads, which makes its location a
 * guard question rather than a taste question. `we:scripts/guard-lane.mjs` denies an `Edit`/`Write` whose real
 * path is inside a primary checkout, and (since #2997) also inside a lane clone whose live lease names a
 * DIFFERENT session as occupant. A panelist is by construction a different session from whoever started it, so
 * a report written under `<checkout>/.operations/` would be blocked in BOTH of the places an `explore` run
 * realistically executes — the primary checkout and an adopted lane.
 *
 * So the scratch root is a sibling of `.lanes/` at the WORKSPACE level: `<workspace>/.operations/explore/`.
 * {@link workspaceRootOf} is IMPORTED from the guard rather than re-derived, so the region this writes into and
 * the region the guard allows are one definition and cannot drift apart. It is transient session scratch, which
 * is where clause 1 of
 * [#state-lives-where-its-nature-dictates](../../docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates)
 * puts it; nothing durable is stored there and no parallel state store comes into existence (#2612) — the run
 * record remains the only bookkeeping, and the report text is folded ONTO it by the observer.
 *
 * IT IS SCRATCH BY NATURE AND NOT YET BY LIFECYCLE, which is a real gap rather than a turn of phrase (PR
 * review, nit 11): a run's directory is created here and NOTHING removes one — no sink, no observer, no waker
 * pass, no CLI. Every committee leaves its reports behind. That is a few markdown files per run, so it is
 * filed (#x7w2z4u) rather than solved inside the operation that noticed it; what must not happen meanwhile is
 * a reader taking the word *transient* as a promise something keeps.
 *
 * ── HOW A PANELIST IS KNOWN TO BE DONE ──────────────────────────────────────────────────────────────────────
 *
 * `dispatch-lane`'s observer could not answer `succeeded` from liveness alone, because `claude agents` reports
 * whether a session exists and never how it ended. This operation has a better signal available and uses it:
 * the panelist's own report, ending in {@link REPORT_END_MARKER}. Three answers fall out, and each uses the
 * word that means what happened (see `we:scripts/operations/effect-observer.mjs`'s `OBSERVATIONS`):
 *
 *   | what is on disk / in the listing                     | answer       | why                              |
 *   |------------------------------------------------------|--------------|----------------------------------|
 *   | a report ending in the marker                         | `succeeded`  | the panelist finished on purpose |
 *   | a non-empty report, no marker, session GONE           | `resolved`   | it ran to a known but UNCLEAN end |
 *   | session listed (or inside the listing grace)          | `running`    | ask again later                  |
 *   | no usable report and the session is gone              | `unresolved` | a person decides                 |
 *
 * The MARKER is what makes the file axis safe to run first. Without it, an investigator that saves a draft
 * halfway would be resolved mid-thought and its partial report synthesized as if final. With it, a partial file
 * reads as still-running — and the `resolved` row is the honest exit for the panelist that died holding one.
 *
 * IMPURE by construction: `node`, `claude`, `fs`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { laneGuardDecision, resolveReal, workspaceRootOf } from '../guard-lane.mjs';
import { assertPublishableContent } from '../backlog/guarded-write.mjs';
import { localToday } from '../lib/local-date.mjs';
import { inFlight, notApplied } from './effect-executor.mjs';
import { normalizeHandle } from './dispatch-lane-io.mjs';
import { isValidRunId } from './run-record.mjs';
import {
  DEFAULT_EXPECTED_WITHIN_MINUTES,
  FILE_STORY_EFFECT,
  INVESTIGATE_EFFECT,
  PUBLISH_RESEARCH_EFFECT,
} from './explore.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo root, resolved by SCRIPT LOCATION and never by cwd — same reason `run-store.mjs` does it. */
export const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * The line a panelist ends its report with. Its presence is the ONLY thing that distinguishes a finished
 * report from a draft on disk — see the header's table.
 *
 * An HTML comment so it is invisible when the report is read as markdown, and distinctive enough that a
 * panelist quoting the instruction back mid-report is not what ends it: the observer checks the LAST
 * non-blank line, not "does the text contain this anywhere".
 */
export const REPORT_END_MARKER = '<!-- explore:report-complete -->';

/** What a panelist label may be. Narrow because it becomes a path segment. */
export const PANELIST_RE = /^p[1-9][0-9]*$/;

/**
 * What a HANDLE may be, given it becomes half of a path segment. A minted `randomUUID()` matches; anything
 * with a separator, a dot or a space does not.
 */
export const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The env var that relocates the panelist scratch root (tests, and any out-of-tree caller). */
export const REPORT_DIR_ENV = 'WE_EXPLORE_REPORT_DIR';

/**
 * How long `claude --bg` gets to return. It is documented to return IMMEDIATELY, so anything near this is a
 * hang, and a hang here is synchronous inside the executor. A timeout kills it and the entry lands
 * INDETERMINATE (`in-flight`, no handle), which is the truthful state.
 */
export const SPAWN_TIMEOUT_MS = 60 * 1000;

/** How long `claude agents --json` gets. A read this cheap that blocks is a broken environment, not slow work. */
export const LIST_TIMEOUT_MS = 15 * 1000;

/**
 * How long `we:scripts/backlog.mjs scaffold` gets. It globs one directory and writes one file; a minute is far
 * past any honest run and short enough that a wedged filing does not stall a whole waker pass.
 */
export const SCAFFOLD_TIMEOUT_MS = 60 * 1000;

/**
 * How long after a spawn a session that is NOT yet listed still reads as `running`. `claude --bg` returns
 * before its session is necessarily visible, so a poll inside this window cannot tell *not yet listed* from
 * *already finished*, and closing a panelist out there would discard an investigation that had not started.
 */
export const LISTING_GRACE_MS = 2 * 60 * 1000;

/**
 * THE PANELIST SCRATCH ROOT — `<workspace>/.operations/explore`, or {@link REPORT_DIR_ENV}.
 *
 * Read the header for why this is at the workspace level rather than inside the checkout. `workspaceRootOf`
 * comes from the guard itself, so "the region a dispatched agent may write to" has exactly one definition.
 *
 * @param {string} [root] - this repo's root.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function exploreScratchRoot(root = REPO_ROOT, env = process.env) {
  const override = String(env[REPORT_DIR_ENV] ?? '').trim();
  return override ? resolve(override) : join(workspaceRootOf(root), '.operations', 'explore');
}

/** One run's report directory. REFUSES a run id that is not filename-safe — it is a path segment. */
export function panelistReportDir(runId, { root = REPO_ROOT, env = process.env } = {}) {
  if (!isValidRunId(runId)) throw new TypeError(`explore-io: invalid run id ${JSON.stringify(runId)}`);
  return join(exploreScratchRoot(root, env), runId);
}

/**
 * ONE PANELIST ATTEMPT'S REPORT PATH. Derived, never stored — which is what lets the SINK (which writes the
 * brief naming it) and the OBSERVER (which reads it back, in a different process, possibly days later) agree
 * without a field on the run record that could go stale. Both call this.
 *
 * ── THE HANDLE IS IN THE PATH, AND IT IS THE WHOLE SECURITY OF THE COMMITTEE (PR review, blocker 1) ──────────
 *
 * The first cut keyed the path on `(runId, panelist)` alone, and that was breakable in two ways that share one
 * root cause: the path was DERIVABLE by anything that knew the run id and the seat number.
 *
 *   - **One panelist could author the whole committee.** The executor serializes the seats, so p1 runs to
 *     completion BEFORE p2 is dispatched. Its brief hands it the absolute path of its own report, from which
 *     `p2.md` and `p3.md` are a substitution away. A panelist subverted by the untrusted material it was told
 *     to fetch could therefore pre-write both, and both would resolve `succeeded` on their first poll — while
 *     the synthesis mandate calls agreement across independent lenses *"the strongest signal this shape
 *     produces"*. The reports still travel fenced, so the juror treats them as data; what was forged is the
 *     AGREEMENT, and on a `file-stories` run forged agreement becomes real backlog items.
 *   - **A retried seat inherited its predecessor's report.** Close a seat out `failed` and the re-dispatch
 *     writes to the same path — where the previous attempt's finished report already sits, marker and all. The
 *     new investigator would be resolved on work it did not do, before it had done any.
 *
 * A MINTED `randomUUID()` closes both. The sink knows the id because it minted it; the observer knows it
 * because it is the entry's `handle` (which it already reads, and which `planObservations` guarantees is
 * present — a handle-less entry is skipped as `NO_HANDLE` and never observed at all). A retry mints a fresh
 * one, so a superseded attempt's report is addressed by a name nothing looks at any more.
 *
 * ── WHAT IT DOES **NOT** CLOSE, STATED BECAUSE THE FIRST DRAFT CLAIMED OTHERWISE (PR review r2, should-fix 1) ─
 *
 * That draft said *"nothing else can derive it"*. That is false, and a false security claim is worse than a
 * documented residual — the next reader stops looking. A sibling seat's handle is reachable through two live
 * channels, both of which need a panelist to go looking rather than to substitute one token:
 *
 *   1. **The run record sits inside the panelist's own cwd.** It is started in the checkout it investigates,
 *      and `we:scripts/operations/run-store.mjs` puts records at `<that checkout>/.operations/runs/<id>.json` —
 *      plain JSON carrying every seat's `handle`. The brief forbids reading it; an instruction is not
 *      enforcement, and nothing mechanically prevents a `cat` from an agent that was handed the checkout and
 *      told to read code and run commands.
 *   2. **`claude agents --json` set-differencing.** A panelist is not killed when its report resolves — the
 *      observer resolves off the FILE, and a session lingers. Because the executor serializes the seats,
 *      exactly one new session appears when the next one is dispatched, so a still-running panelist can
 *      attribute it with certainty.
 *
 * So the attack is raised from a one-token substitution to a multi-step read-then-write, and the retry case is
 * gone outright — but a determined subverted panelist can still forge its neighbours. The two halves of the
 * proportionate response are HERE (this note, so nobody trusts a closure that does not exist) and in the
 * brief's blindness paragraph (`we:scripts/operations/explore.mjs#buildPanelistBrief`, which now forbids
 * WRITING anywhere but the one path it was given, and forbids reading the run record and the agent listing).
 * The structural close — putting the run store outside the panelist's cwd, or not letting a reported panelist
 * keep running — changes machinery this operation does not own, and is filed (#xvpy20j) rather than improvised.
 */
export function panelistReportPath(runId, panelist, handle, { root = REPO_ROOT, env = process.env } = {}) {
  const seat = String(panelist ?? '');
  if (!PANELIST_RE.test(seat)) throw new TypeError(`explore-io: invalid panelist label ${JSON.stringify(panelist)}`);
  const id = String(handle ?? '');
  if (!HANDLE_RE.test(id)) {
    throw new TypeError(
      `explore-io: ${JSON.stringify(handle)} is not a usable report-path handle — the attempt's session id is `
      + 'what keeps a panelist\'s report path off the derivable name its fellow panelists could guess. Refusing '
      + 'to fall back to a derivable path.',
    );
  }
  return join(panelistReportDir(runId, { root, env }), `${seat}-${id}.md`);
}

/**
 * THE WHOLE PROMPT one panelist is started with: the declaration's brief, plus the destination. PURE.
 *
 * WHY THE DESTINATION IS APPENDED HERE rather than built into the brief. The path contains the RUN ID, which is
 * minted after input validation and is not visible to any `compute` step — a step's view holds only
 * `input`/`findings`/`verdict`. The sink is the first place in the whole run that knows it (`ctx.runId`). So
 * the SUBSTANCE of the brief stays pure and on the run record verbatim, and only this mechanical line is added
 * where the id first exists.
 *
 * @param {string} brief - the declaration's `buildPanelistBrief` output.
 * @param {string} reportPath - absolute.
 * @returns {string}
 */
export function composeInvestigationPrompt(brief, reportPath) {
  const body = String(brief ?? '').trim();
  if (!body) throw notApplied('explore: refusing to start an investigator with an empty brief');
  return [
    body,
    `WRITE YOUR REPORT TO EXACTLY THIS PATH, as markdown: ${reportPath}\n`
    + 'Write it ONCE, as the last thing you do — not a draft you revise. Everything before that is your working '
    + 'process and belongs nowhere else.\n'
    + `END THE FILE WITH THIS LINE, alone, and nothing after it: ${REPORT_END_MARKER}\n`
    + 'That line is how the committee knows your report is finished rather than half-written. A report without '
    + 'it is read as an investigation that died mid-sentence.',
  ].join('\n\n');
}

/**
 * The `claude` argv for one panelist. PURE and exported, because the argv IS the contract with the CLI and a
 * test that asserts it is the only thing standing between a flag rename and a silent non-dispatch.
 *
 * A prompt beginning with `-` is REFUSED rather than trusted to positional placement: commander accepts
 * options intermixed with operands, so a leading dash can be read as a flag. Same refusal, same reason, as
 * `dispatch-lane-io.mjs#buildAgentArgv`.
 */
/**
 * THE DETERMINISTIC `-n` NAME for one panelist's session — the run and the seat, which together are the only
 * identity this operation has. Trimmed of leading separators on the id's tail so the name reads
 * `explore-<tail>-p1` rather than `explore--fixture-p1` when the cut lands on a dash.
 *
 * PURE AND SHARED (#3331), deliberately: {@link buildInvestigatorArgv} sets this via `-n` at dispatch time, and
 * `createExploreObservers`'s liveness axis recomputes the SAME value from `(runId, panelist)` to find the
 * session in `claude agents --json` by name — the real handle `--bg` reports is unknown to the dispatcher, and
 * proven unaddressable from `--session-id` (#3331), but the name is CLI-respected and needs no round trip.
 * One function, not two independent literals that could drift.
 *
 * @param {string} runId
 * @param {string} panelist
 * @returns {string}
 */
export function investigatorSessionName(runId, panelist) {
  return `explore-${String(runId).slice(-8).replace(/^[^A-Za-z0-9]+/, '')}-${String(panelist ?? 'p')}`;
}

export function buildInvestigatorArgv({ sessionId, runId, payload, prompt, extraArgs = [] }) {
  const text = String(prompt || '');
  if (!text.trim()) throw notApplied('explore: refusing to start an investigator with an empty prompt');
  if (text.trimStart().startsWith('-')) {
    throw notApplied('explore: refusing a brief that begins with `-` — an argument parser can read it as a flag');
  }
  return [
    '--bg',
    '--session-id', String(sessionId),
    '-n', investigatorSessionName(runId, payload?.panelist),
    ...extraArgs.map(String),
    text,
  ];
}

/**
 * Extra `claude` flags from the environment, or `[]`. REFUSES a malformed value rather than spawning with flags
 * the operator thinks are set and are not — the same refusal, and the same env var, `dispatch-lane-io.mjs`
 * uses, because a committee panelist and a delivery agent are the same kind of spawned session and an operator
 * setting the permission mode for one means it for both.
 */
export const AGENT_ARGS_ENV = 'WE_DISPATCH_AGENT_ARGS';

/** @param {Record<string, string|undefined>} [env] @returns {string[]} */
export function agentArgsFromEnv(env = process.env) {
  const raw = String(env[AGENT_ARGS_ENV] || '').trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!Array.isArray(parsed) || parsed.some((a) => typeof a !== 'string')) {
    throw new TypeError(`operations: ${AGENT_ARGS_ENV} must be a JSON array of strings, e.g. '["--model","sonnet"]'`);
  }
  return parsed;
}

/**
 * Errors that PROVE no agent started. Matching one marks the entry `failed` (retried on the next pass) instead
 * of the default INDETERMINATE. Deliberately tiny: a `claude` invocation that failed for a reason we do not
 * recognise may still have started a session, and guessing otherwise is how one seat gets two investigators.
 */
const PRE_SPAWN_REFUSALS = Object.freeze(['ENOENT', 'EACCES']);

/** Is this spawn failure one we can PROVE happened before any agent existed? */
export function isPreSpawnRefusal(error) {
  return PRE_SPAWN_REFUSALS.includes(String(error?.code || ''));
}

/**
 * THE SINKS — one panelist spawn, and the two terminal writers.
 *
 * NO LANE REFUSAL HERE, AND THAT IS A DELIBERATE DIVERGENCE FROM `dispatch-lane`. That sink refuses to spawn
 * from inside a lane clone because a delivery agent's FIRST instruction is to acquire a lane, and acquiring one
 * from inside another nests two checkouts. An investigator acquires nothing and changes nothing — its mandate
 * is explicitly read-only and its single write goes to the workspace scratch root, outside every checkout — so
 * the condition that refusal exists for does not arise. Copying it across would have refused every `explore`
 * run started from a lane, which is where agent-driven runs actually happen.
 *
 * @param {object} [o]
 * @param {string} [o.root] - the cwd a panelist starts in: the checkout it investigates.
 * @param {Function} [o.spawnAgent] - injectable `(argv, opts) => stdout`; the default shells `claude`.
 * @param {Function} [o.exec] - the `execFileSync`-shaped call the DEFAULT spawner/scaffolder go through.
 * @param {() => string} [o.mintSessionId]
 * @param {() => Date} [o.now] - injectable clock, for `expectedBy`.
 * @param {string[]} [o.extraArgs]
 * @param {Record<string, string|undefined>} [o.env]
 * @returns {Record<string, Function>} effect type → `async (payload, ctx) => result`.
 */
export function createExploreSinks({
  root = REPO_ROOT,
  exec = execFileSync,
  spawnAgent = (argv, opts) => defaultSpawnAgent(argv, opts, { exec }),
  scaffoldItem = (args) => defaultScaffoldItem(args, { exec, root }),
  writeText = (path, text) => writeFileSync(path, text, 'utf8'),
  readTextIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  ensureDir = (dir) => mkdirSync(dir, { recursive: true }),
  mintSessionId = () => randomUUID(),
  now = () => new Date(),
  today = localToday,
  extraArgs = [],
  env = process.env,
} = {}) {
  return {
    [INVESTIGATE_EFFECT]: async (payload, ctx) => {
      // EVERYTHING BEFORE THE SPAWN IS `notApplied` (PR review, finding 5). These four steps happen before any
      // agent can exist, so a failure in one PROVES nothing started — and the executor's word for that is
      // `failed`, which is retried on the next pass. A bare throw would instead record the entry `in-flight`
      // with a NULL handle, which the replay guard REFUSES from then on: an unwritable scratch directory or a
      // full disk would wedge the whole run behind a manual `wake --resolve`, for an agent that provably never
      // existed. `mkdirSync` throwing `EACCES` was exactly that case.
      const sessionId = String(mintSessionId());
      let reportPath;
      try {
        reportPath = panelistReportPath(ctx.runId, payload?.panelist, sessionId, { root, env });
        // The directory is created BEFORE the spawn: a panelist told to write to a path whose parent does not
        // exist has to invent a `mkdir`, and an agent inventing filesystem work is an agent doing something
        // nobody asked it to.
        ensureDir(panelistReportDir(ctx.runId, { root, env }));
      } catch (e) {
        throw notApplied(
          `explore: could not prepare ${payload?.panelist ?? 'the panelist'}'s report location — `
          + `${String((e && e.message) || e).split('\n')[0]}. No agent was started.`,
        );
      }
      const argv = buildInvestigatorArgv({
        sessionId,
        runId: ctx.runId,
        payload,
        prompt: composeInvestigationPrompt(payload?.brief, reportPath),
        extraArgs,
      });
      try {
        spawnAgent(argv, { cwd: root });
      } catch (e) {
        if (isPreSpawnRefusal(e)) {
          throw notApplied(`claude could not be started (${String(e.code)}) — no investigator exists`, { sessionId });
        }
        // INDETERMINATE. The entry stays `in-flight` with a NULL handle: something may be running and cannot
        // be observed. `inFlightEntries` reports that under `unknown` and the replay guard refuses it, which is
        // exactly right — a person finds out what happened and closes it out.
        throw new Error(
          `claude --bg failed and whether an investigator started is UNKNOWN: ${String((e && e.message) || e).split('\n')[0]}`,
        );
      }
      const minutes = Number(payload?.expectedWithinMinutes) > 0
        ? Number(payload.expectedWithinMinutes)
        : DEFAULT_EXPECTED_WITHIN_MINUTES;
      return inFlight({
        handle: sessionId,
        expectedBy: new Date(now().getTime() + minutes * 60 * 1000).toISOString(),
      });
    },

    [FILE_STORY_EFFECT]: async (payload) => scaffoldItem(payload),

    [PUBLISH_RESEARCH_EFFECT]: async (payload) => publishResearchTopic(payload, {
      root, writeText, readTextIfPresent, ensureDir, today,
    }),
  };
}

/**
 * The default `claude --bg` spawner — named and exported so the TIMEOUT it sets is reachable by a test. A fix
 * no test asserts is a fix the next refactor removes for free (the lesson `dispatch-lane-io.mjs` records at
 * `defaultSpawnAgent`).
 */
export function defaultSpawnAgent(argv, opts = {}, { exec = execFileSync } = {}) {
  return exec('claude', argv, {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts,
  });
}

/** `claude agents --json` — ACTIVE sessions only. `--all` would list completed ones too, so a finished
 *  investigation would read as `running` forever: the one mistake that makes an observer worse than none. */
export function defaultListAgents({ exec = execFileSync } = {}) {
  const out = exec('claude', ['agents', '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    timeout: LIST_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  return JSON.parse(String(out || '[]'));
}

/**
 * FILE ONE STORY through the real CLI. `we:scripts/backlog.mjs scaffold --json` owns JIT hash numbering (#2288),
 * the skeleton renderer and the guarded write; re-implementing any of that here is how two ways to file an item
 * come to disagree about what an item is.
 *
 * ARGV, NEVER A SHELL STRING. `execFileSync` with an argument array means a title carrying a quote, a backtick
 * or a `;` is one argument and not three commands — so the value guard `dispatch-lane` needs (its brief is
 * pasted into a shell command) has no equivalent here.
 *
 * A `die()` INSIDE THE CLI IS PROVABLY NOTHING-WRITTEN. Every refusal in `scaffold` happens before the single
 * `writeBacklogMd`, and `--json` makes it print `{"ok":false,"error":…}` and exit 1. So that case throws
 * `notApplied` — marked `failed`, retried on the next pass — while any OTHER failure (a killed process, a
 * timeout, unparseable output) stays INDETERMINATE, because the write may have landed.
 *
 * THE REFUSAL AN OPERATOR WILL ACTUALLY SEE is the #883 locus-prefix scan inside `writeBacklogMd`: a juror's
 * digest naming `scripts/foo.mjs` rather than `we:scripts/foo.mjs` is refused, and refused identically on every
 * retry until a person acts. That is why {@link CODE_PATH_PREFIX_RULE} is in the synthesis mandate — the cheap
 * half of the fix is authoring the prefix, not catching its absence. Passing the CLI's own message through
 * verbatim is what makes the retry loop legible rather than mysterious.
 */
export function defaultScaffoldItem(payload, { exec = execFileSync, root = REPO_ROOT } = {}) {
  const argv = [
    join(root, 'scripts', 'backlog.mjs'), 'scaffold', '--json',
    `--kind=${payload.kind}`,
    `--size=${payload.size}`,
    `--title=${payload.title}`,
    `--digest=${payload.digest}`,
    ...(payload.parent ? [`--parent=${payload.parent}`] : []),
    ...(Array.isArray(payload.scope) && payload.scope.length ? [`--scope=${payload.scope.join(',')}`] : []),
  ];
  let stdout;
  try {
    stdout = String(exec(process.execPath, argv, {
      cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      timeout: SCAFFOLD_TIMEOUT_MS, killSignal: 'SIGKILL',
    }));
  } catch (e) {
    const out = String(e?.stdout ?? '');
    const refusal = parseCliRefusal(out);
    if (refusal) {
      // NEARLY, BUT NOT QUITE, A PROVEN NON-WRITE (PR review r3, nit C). Every guard in the CLI runs before its
      // single `writeFileSync`, so a `{"ok":false}` line is normally a refusal that landed nothing. The narrow
      // exception is a refusal raised BY a failing write (a full disk mid-`writeFileSync`), which surfaces
      // through the same `die()` and is indistinguishable from here — it would leave a truncated card behind,
      // and the retry `notApplied` licenses would file a second one under a fresh hash. Stated rather than
      // papered over, because the alternative — calling every `{"ok":false}` indeterminate — would refuse the
      // common, genuinely-retryable case (a juror digest with a bare code path) on the strength of a rare one.
      throw notApplied(
        `explore: backlog.mjs refused to scaffold — ${refusal} The CLI's guards all run before its single `
        + 'write, so this is a proven non-write unless the write ITSELF failed (a full disk), in which case a '
        + `truncated card may be on disk — check before retrying. ${ABANDON_HINT}`,
      );
    }
    throw new Error(
      `explore: backlog.mjs scaffold failed and whether the item was written is UNKNOWN: `
      + `${String((e && e.message) || e).split('\n')[0]}`,
    );
  }
  let parsed;
  try { parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() || 'null'); } catch { parsed = null; }
  if (!parsed || parsed.ok !== true || !parsed.num) {
    // The CLI exited 0 and said something this code cannot read. It very likely wrote — so this is
    // INDETERMINATE (a bare throw), never `notApplied`.
    throw new Error(`explore: backlog.mjs scaffold exited 0 with unreadable output: ${stdout.slice(0, 200)}`);
  }
  return { num: String(parsed.num), file: String(parsed.file), title: payload.title };
}

/** The `error` off a `--json` refusal line, or null when the output is not one. Pure. */
export function parseCliRefusal(stdout) {
  for (const line of String(stdout || '').split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.ok === false && parsed.error) return String(parsed.error);
    } catch { /* not the JSON line */ }
    break;
  }
  return null;
}

/**
 * HOW TO ABANDON A RUN WEDGED ON A DETERMINISTIC TERMINAL REFUSAL — appended to those refusals.
 *
 * The engine has no abandon surface: past the `confirm` the verdict is frozen, `advance` returns unchanged, the
 * waker skips a run with nothing in-flight, and `wake --resolve` accepts only an `in-flight` entry. Deleting
 * the record is therefore the only exit, and it is safe HERE precisely because every gate that produces this
 * message runs before any write — there is no half-applied effect to strand. Saying so is cheaper than letting
 * an operator learn it by exhausting the CLI.
 */
export const ABANDON_HINT =
  'If you would rather drop the run than fix this, delete its record (`.operations/runs/<runId>.json`) — the '
  + 'engine has no abandon verb, and a refusal that landed nothing leaves no half-applied effect to strand.';

/**
 * Escape text for the HTML body of a research description. Pure.
 *
 * SECURITY (PR #1457 review, finding 1) — `renderResearchTopic` wraps every field this escapes inside a
 * Nunjucks `{% raw %}...{% endraw %}` block, so HTML-escaping alone is not enough: `%` and `{`/`}` used to pass
 * through untouched, and a juror-authored finding whose title/detail/evidence carries the literal text
 * `{% endraw %}` (verbatim or paraphrased from attacker-influenceable material — a fetched page, a repo file,
 * an issue body) would prematurely close the raw block once `publishResearchTopic` writes it to disk, letting
 * whatever followed be parsed as live Nunjucks by the next Eleventy build. Encoding `{` (as `&#123;`) defuses
 * ALL THREE Nunjucks delimiter openers at once (`{%`, `{{`, `{#`), not just the one shape this was found with —
 * a literal `{` has no other meaning in this rendered HTML, so the encoded form is visually identical.
 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\{/g, '&#123;');
}

/**
 * The `dateOpened` / `lastReviewed` an ALREADY-WRITTEN spec at this id carries, or `null` per field. PURE.
 *
 * WHY THE DATES ARE INHERITED RATHER THAN RESTAMPED (PR review, finding 3). The publish effect is declared
 * `idempotent: true`, and the justification was *"the same verdict renders the same two files"* — which was
 * false across a date boundary, and false in exactly the case the flag exists for. A run that wrote the spec
 * and then died before the description leaves a `pending` entry; the replay `idempotent: true` licenses then
 * re-renders with TODAY's date, so the bytes no longer match what is on disk, the overwrite guard below refuses
 * it as somebody else's research, and every retry refuses identically. The run could never complete and an
 * operator had to hand-delete a half-written topic.
 *
 * Reading the two dates off the existing spec makes the claim true rather than nearly true, and is also the
 * honest value: a topic's `dateOpened` is when it was opened, not when the second half of its write landed.
 *
 * @param {string|null} existingSpec - the spec file's current text, or null.
 * @returns {{dateOpened: (string|null), lastReviewed: (string|null)}}
 */
export function inheritedTopicDates(existingSpec) {
  if (existingSpec == null) return { dateOpened: null, lastReviewed: null };
  let parsed;
  try { parsed = JSON.parse(String(existingSpec)); } catch { return { dateOpened: null, lastReviewed: null }; }
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return { dateOpened: iso(parsed?.dateOpened), lastReviewed: iso(parsed?.lastReviewed) };
}

/**
 * RENDER the `/research/` topic pair a published synthesis becomes: the spec JSON and its description partial.
 * PURE, so the exact bytes are testable without a filesystem — which is also what makes the write idempotent
 * (see the effect's `idempotent: true`): the same verdict plus the same inherited dates render the same two
 * files, whatever day the replay happens on.
 *
 * BOTH FILES, ALWAYS. `we:scripts/check-standards.mjs` errors on a topic with no
 * `src/_includes/research-descriptions/<id>.njk`, so writing the spec alone would publish a topic that reddens
 * the gate for whoever lands next.
 *
 * @param {object} payload - the terminal effect's payload.
 * @param {string} todayIso - `YYYY-MM-DD`, injected so this stays pure.
 * @param {{dateOpened?: string|null, lastReviewed?: string|null}} [inherited] - see {@link inheritedTopicDates}.
 * @returns {{spec: string, description: string}}
 */
export function renderResearchTopic(payload, todayIso, inherited = {}) {
  const findings = Array.isArray(payload?.findings) ? payload.findings : [];
  const spec = {
    id: String(payload.topicId),
    title: String(payload.title),
    status: 'open',
    summary: String(payload.summary || '').replace(/\s+/g, ' ').trim(),
    dateOpened: inherited.dateOpened || todayIso,
    lastReviewed: inherited.lastReviewed || todayIso,
    reviewHorizon: 'P12M',
    tags: ['explore-committee', ...(Array.isArray(payload.lenses) ? payload.lenses.map(String) : [])],
    relatedBlocks: [],
    relatedPlugs: [],
    relatedProject: '',
  };
  const items = findings.map((f) => [
    '    <li>',
    `        <strong>${escapeHtml(f.title)}</strong> <em>(${escapeHtml(f.kind)}, ${escapeHtml(f.confidence)} confidence`,
    `${(f.agreedBy || []).length ? `; agreed by ${escapeHtml((f.agreedBy || []).join(', '))}` : ''})</em>`,
    `        <p>${escapeHtml(f.detail)}</p>`,
    ...((f.evidence || []).length
      ? ['        <ul>', ...(f.evidence || []).map((e) => `            <li><code>${escapeHtml(e)}</code></li>`), '        </ul>']
      : []),
    '    </li>',
  ].join('\n'));
  const description = [
    '{% raw %}',
    '<h2>The question</h2>',
    `<p>${escapeHtml(payload.title)}</p>`,
    '',
    '<h2>What the committee found</h2>',
    `<p>${escapeHtml(spec.summary)}</p>`,
    ...(items.length ? ['<ol>', ...items, '</ol>'] : ['<p>The panel reported no findings.</p>']),
    '',
    '<h2>How this was produced</h2>',
    `<p>A blind investigation committee of ${(payload.lenses || []).length} panelist(s) —`,
    `    lenses <code>${escapeHtml((payload.lenses || []).join(', '))}</code> — synthesized by a tool-free juror.`,
    '    No panelist read another\'s report.</p>',
    '{% endraw %}',
    '',
  ].join('\n');
  return { spec: `${JSON.stringify(spec, null, 2)}\n`, description };
}

/**
 * WRITE the topic pair — through the SAME guard chain every other code-written committed file in this repo
 * passes, and never a bare `writeFileSync`.
 *
 * ── THIS IS THE ONE WRITE IN THIS FILE THAT LANDS IN A COMMITTED TREE (PR review, blocker 2) ─────────────────
 *
 * The panelist reports live at the workspace scratch root, outside every checkout (see the header). These two
 * files do not: they are tracked `src/…` paths, and the first cut wrote them with a bare `writeFileSync`. Run
 * `explore --terminal=publish-research` from the primary checkout and it would have written straight into
 * primary — which `laneGuardDecision` denies for exactly this reason, and which it never got the chance to,
 * because a CLI writing to `fs` is never seen by the `PreToolUse(Edit|Write)` hooks. That is the mechanism gap
 * `we:scripts/backlog/guarded-write.mjs`'s header names: *enforce at the SOURCE*.
 *
 * The two terminal sinks were also inconsistent about it — `defaultScaffoldItem` shells `backlog.mjs`, which
 * DOES enforce it, so filing a story from primary already refused while publishing research did not.
 *
 * THREE GATES, ALL BEFORE EITHER WRITE, ALL `notApplied`:
 *   1. `laneGuardDecision` — lane isolation (#2302/#104/#2219/#2339), the same decider `guarded-write` calls;
 *   2. `assertPublishableContent` — the #3015 secret scrub and the #883 locus-prefix scan, imported rather
 *      than re-derived. The second matters here more than it does for a hand-written card: this content is
 *      JUROR PROSE, summarizing panelists who were told to cite *"a file and line"*, and
 *      `we:scripts/check-standards.mjs` scans both of these directories. Without the gate a successful publish
 *      REDDENS THE GATE FOR WHOEVER LANDS NEXT — one instance up from the failure the "BOTH FILES, ALWAYS"
 *      note above already guards against;
 *   3. the overwrite guard — a topic id that already belongs to somebody else's research is not this run's to
 *      replace, and a silent overwrite there is unrecoverable data loss.
 *
 * All three are `notApplied` because all three run before anything is written, so all three are PROVABLY
 * nothing-landed and the entry is `failed` (retried) rather than indeterminate. A gate that keeps refusing —
 * a juror that keeps writing bare paths, a topic id already taken — retries identically until a person acts,
 * which is the same bounded-but-repeating shape `dispatch-lane-io.mjs#assertNotALaneCheckout` records: nothing
 * is ever written, and the refusal names what to fix.
 *
 * AND WHAT "A PERSON ACTS" MEANS HERE IS THINNER THAN IT SOUNDS (PR review r2, nit 5). Past the `confirm` the
 * verdict is frozen on the record, so a deterministic content refusal has no supported way out: the executor
 * refuses, `advance` returns unchanged, the waker skips the run (nothing is in-flight), and `wake --resolve`
 * accepts only an `in-flight` entry. There is no abandon-a-run surface in the engine at all — `review-pr`'s
 * `record` step shares the gap; this is just the first operation whose terminal refusal is deterministic
 * enough to hit it reliably. So the refusals below NAME the manual exit rather than leaving an operator to
 * discover there isn't one. {@link ABANDON_HINT}.
 */
export function publishResearchTopic(payload, {
  root = REPO_ROOT,
  writeText = (path, text) => writeFileSync(path, text, 'utf8'),
  readTextIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  ensureDir = (dir) => mkdirSync(dir, { recursive: true }),
  laneGuard = (abs) => laneGuardDecision(resolveReal(abs), root),
  assertContent = assertPublishableContent,
  today = localToday,
} = {}) {
  const id = String(payload?.topicId ?? '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw notApplied(
      `explore: ${JSON.stringify(id)} is not a usable research-topic id — refusing to write it. ${ABANDON_HINT}`,
    );
  }
  const specRel = `src/_data/researchTopics/${id}.json`;
  const descRel = `src/_includes/research-descriptions/${id}.njk`;
  const specPath = join(root, 'src', '_data', 'researchTopics', `${id}.json`);
  const descPath = join(root, 'src', '_includes', 'research-descriptions', `${id}.njk`);
  // The dates are inherited from an already-written spec so a replay renders the SAME bytes on a later day —
  // see `inheritedTopicDates`. Read BEFORE rendering, because the render depends on it.
  const existingSpec = readTextIfPresent(specPath);
  const { spec, description } = renderResearchTopic(payload, today(), inheritedTopicDates(existingSpec));

  for (const [abs, rel, next, existing] of [
    [specPath, specRel, spec, existingSpec],
    [descPath, descRel, description, readTextIfPresent(descPath)],
  ]) {
    const denied = laneGuard(abs);
    if (denied) {
      throw notApplied(
        `explore: refusing to publish /research/ topic \`${id}\` — ${denied.split('\n')[0]} An operation's `
        + 'effect sink writes straight to `fs`, so the PreToolUse hooks never see it; the same lane-isolation '
        + `rule is enforced here instead. Re-run this operation from a lane clone. Nothing was written. ${ABANDON_HINT}`,
      );
    }
    // The content gates, with the abandon hint appended — a locus-prefix refusal here is DETERMINISTIC (the
    // verdict is frozen, so every retry re-renders the same offending prose) and is the likeliest wedge this
    // sink produces.
    try {
      assertContent(rel, next);
    } catch (e) {
      throw notApplied(`explore: refusing to publish /research/ topic \`${id}\` — ${String(e?.message ?? e)} ${ABANDON_HINT}`);
    }
    if (existing != null && existing !== next) {
      throw notApplied(
        `explore: /research/ topic \`${id}\` already exists at ${rel} with different content — refusing to `
        + 'overwrite research this run did not write. Re-run with a question that yields a distinct topic id, '
        + `or fold the findings into the existing topic by hand. ${ABANDON_HINT}`,
      );
    }
  }
  ensureDir(dirname(specPath));
  ensureDir(dirname(descPath));
  writeText(specPath, spec);
  writeText(descPath, description);
  return { topicId: id, spec: specRel, description: descRel };
}

/**
 * How much of a panelist's report is kept ON THE RUN RECORD, in characters.
 *
 * WHY THERE IS A CAP AT ALL (PR review, nit 7). The observer's `result` is folded into the effect entry and
 * `store.write` RE-SERIALIZES the whole record on every subsequent transition — so a verbose panelist that
 * wrote megabytes would be paid for again at each of them, and again on every waker pass over the parked run.
 * `REPORT_EXCERPT_CHARS` in the declaration caps what reaches the JUROR; this caps what reaches the DISK, and
 * they are separate numbers because they bound different costs.
 *
 * Generous relative to the juror's cap so a truncation here is never the one the synthesis notices first, and
 * the FULL report is always still on disk at `reportPath`, which the result names.
 */
export const REPORT_RECORD_CHARS = 64_000;

/**
 * The observer's `result` for one panelist, with the stored report bounded. PURE.
 *
 * `bytes` is the length of what the panelist actually wrote, never of the excerpt — a truncated copy that
 * reported its own length would make a 300 KB report look like a 64 KB one on the record.
 */
export function reportResult({ panelist, lens, reportPath, body, endedCleanly }) {
  const full = String(body ?? '');
  const truncated = full.length > REPORT_RECORD_CHARS;
  return {
    panelist,
    lens,
    reportPath,
    report: truncated
      ? `${full.slice(0, REPORT_RECORD_CHARS)}\n\n[…truncated on the run record at ${REPORT_RECORD_CHARS} characters; the whole report is at ${reportPath}]`
      : full,
    bytes: full.length,
    truncated,
    endedCleanly,
  };
}

/**
 * Does this text read as a FINISHED report? True only when its last non-blank line is the marker. Pure.
 *
 * The LAST LINE rather than "contains" is what stops a panelist that quoted its own instructions back mid-report
 * from resolving itself early — see {@link REPORT_END_MARKER}.
 */
export function isReportComplete(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines[lines.length - 1] === REPORT_END_MARKER;
}

/**
 * THE OBSERVER — the #3084 half that asks how one panelist's investigation is going. Read the header's table
 * before changing an answer here: each of the four words means something different to the executor, and two
 * earlier vocabularies re-ran real work by choosing the wrong one.
 *
 * THE REPORT AXIS RUNS FIRST, deliberately. A panelist's last act is to write its report and exit, and the
 * session lingers in the listing for some seconds after. Ordering liveness first would report a finished
 * investigation as `running` for as long as that lasted — i.e. the axis that can actually answer would be a
 * fallback the common case never reaches. (`dispatch-lane`'s observer orders its PR axis first for the same
 * reason.)
 *
 * ONE LISTING PER PASS, MEMOIZED, and NONE when every entry resolved off its report file — the common case is a
 * panelist that finished, and shelling `claude` to ask about a session we already have the answer for would put
 * a subprocess on every observation. A THROW is not memoized, so a transient failure is retried next pass
 * rather than poisoning it.
 *
 * @param {object} [o]
 * @param {Function} [o.exec]
 * @param {() => object[]} [o.listAgents] - injectable `claude agents --json` reader.
 * @param {(path: string) => (string|null)} [o.readReport] - injectable report reader.
 * @param {() => Date} [o.now]
 * @param {string} [o.root]
 * @param {Record<string, string|undefined>} [o.env]
 * @returns {Record<string, Function>} effect type → `async (entry, ctx) => {status, result?, error?}`.
 */
export function createExploreObservers({
  exec = execFileSync,
  listAgents = () => defaultListAgents({ exec }),
  readReport = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  now = () => new Date(),
  root = REPO_ROOT,
  env = process.env,
} = {}) {
  let listed;
  return {
    [INVESTIGATE_EFFECT]: async (entry, ctx) => {
      const panelist = String(entry?.payload?.panelist ?? '');
      const lens = String(entry?.payload?.lens ?? '');
      const handle = String(ctx?.handle ?? entry?.handle ?? '');

      // ── AXIS 1: THE REPORT. The only axis that can say the investigation is DONE. ──────────────────────
      //
      // A read that FAILS is not a verdict: an unreadable scratch root degrades this axis to off and falls
      // through to liveness, rather than closing out an investigation on a filesystem hiccup.
      let reportPath = null;
      let text = null;
      try {
        // THE HANDLE IS PART OF THE PATH — see `panelistReportPath`. It is THIS attempt's session id, so a
        // predecessor attempt's report (or a fellow panelist's forgery) is addressed by a name this never asks
        // for. A handle-less entry cannot reach here: `planObservations` skips it as `NO_HANDLE`.
        reportPath = panelistReportPath(ctx.runId, panelist, handle, { root, env });
        text = readReport(reportPath);
      } catch { text = null; }
      const body = String(text ?? '').trim();
      if (body && isReportComplete(body)) {
        return { status: 'succeeded', result: reportResult({ panelist, lens, reportPath, body, endedCleanly: true }) };
      }

      // ── AXIS 2: LIVENESS. What answers while no finished report exists — which is every investigation for
      //    most of its life.
      if (listed === undefined) listed = listAgents();
      const sessions = listed;
      if (!Array.isArray(sessions)) {
        throw new TypeError('explore-io: `claude agents --json` did not return an array');
      }
      // #3331: matched by NAME, not by `handle` — the CLI ignores `--session-id` on a `--bg` spawn, so the
      // minted id `handle` carries (needed for the report path, above) is never the id the listing reports.
      // `-n` IS respected, and `investigatorSessionName` recomputes the exact value the sink set it to.
      const expectedName = normalizeHandle(investigatorSessionName(ctx.runId, panelist));
      if (sessions.some((s) => s && normalizeHandle(s.name) === expectedName)) return { status: 'running', result: null };

      // NOT-YET-LISTED IS NOT GONE. `--bg` returns before the session is necessarily visible.
      const started = entry?.startedAt ? Date.parse(entry.startedAt) : NaN;
      if (!Number.isNaN(started) && now().getTime() - started < LISTING_GRACE_MS) {
        return { status: 'running', result: null };
      }

      // THE SESSION IS GONE AND THE REPORT IS UNFINISHED. `resolved` (#3085), not `succeeded`: the effect DID
      // run and its outcome is KNOWN, but nothing here claims it was clean — the run advances, the synthesis
      // reads a truncated report, and the accompanying `error` says so on the record. That is strictly better
      // than `unresolved`, which would park the whole committee behind one panelist that died two paragraphs
      // from the end.
      if (body) {
        return {
          status: 'resolved',
          result: reportResult({ panelist, lens, reportPath, body, endedCleanly: false }),
          error: `session ${handle} is gone and ${panelist}'s report does not end with the completion marker — `
            + 'it is being synthesized as a TRUNCATED report. Check the session if the synthesis looks thin.',
        };
      }
      return {
        status: 'unresolved',
        error: `session ${handle} is no longer listed by \`claude agents\` and ${panelist} wrote no report at `
          + `${reportPath ?? 'its expected path'} — whether it investigated anything cannot be told from here. `
          + 'Check the session, then close the entry out '
          + '(`node scripts/operations/wake.mjs --resolve=<runId> --key=<effectKey> --status=failed`).',
      };
    },
  };
}
