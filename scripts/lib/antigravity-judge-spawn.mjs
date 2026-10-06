/**
 * antigravity-judge-spawn.mjs — a THIRD `JudgeProvider` PRIMITIVE (#3383, sibling of `#xqa9ttq`'s Codex work),
 * Google's Antigravity CLI (`agy`) as a genuinely TOOL-FREE judge seat — the SAFEST possible slice of the three
 * providers this repo has now probed, and DELIBERATELY nothing more than that: this module is a standalone
 * primitive, proven to run a real judge request end to end, and is NOT wired into `we:scripts/operations/
 * cli-adapter.mjs#resolveJudgeProvider` or any `judge` step. Wiring it into the panel is a separate, later item
 * — the same build order `codex-judge-spawn.mjs` followed (seat the primitive, prove it standalone, wire it
 * only once that is proven).
 *
 * WHY TOOL-FREE, AND WHY THAT IS THE SAFEST STARTING SLICE. `backlog/3633-probe-antigravity-cli-against-the-
 * judge-contract.md` (probe 13, run live against `agy` 1.2.1) found `--sandbox` confines only the CLI's
 * SHELL — `run_command` — while `agy`'s 57 IN-PROCESS tools (`view_file`, `write_to_file`, `replace_file_
 * content`, …) walk around it entirely: a sandboxed agent was DENIED a `cat`/`head`/write via the shell and
 * then read and wrote the exact same files a heartbeat later using its own file tools, undetected by the
 * sandbox and self-reported (wrongly) as "denied" in its own final answer. That makes any WRITE-capable
 * Antigravity seat genuinely risky today: no flag combination the probe found actually confines it. A
 * tool-free seat sidesteps that hole STRUCTURALLY rather than by convention — this module never passes
 * `--dangerously-skip-permissions` (the flag that unlocks tool execution at all), so EVERY tool call the model
 * attempts — shell or in-process alike — is auto-denied by `agy`'s own headless permission check, confirmed
 * live twice while building this module (see "LIVE RE-CONFIRMATION" below): the same run that tries `list_dir`
 * or `run_command` gets `TOOL_ERROR` / "user denied permission" for EACH attempt, never a bypass. There is
 * nothing here for `--sandbox`'s known hole to exploit, because nothing is ever allowed to execute in the
 * first place — which is also why this module never passes `--sandbox` at all: it would be a false sense of
 * confinement layered over a seat that already cannot act.
 *
 * MIRRORS `we:scripts/lib/codex-judge-spawn.mjs`'S OWN SHAPE, DELIBERATELY. Same `JudgeProvider` port
 * (`(request: JudgeProviderRequest) => Promise<JudgeProviderOutcome>`, `we:scripts/lib/judge-spawn.mjs`), same
 * PURE-ARGV / PURE-PARSE split (`buildAntigravityJudgeArgv` / `parseAntigravityJudgeOutcome`, both spawn
 * nothing), same injectable `spawnFn`/temp-file helpers for testability, same "assertNoXToolAllowlist" guard
 * shape, same three unfillable port fields handled the same honest way. Where `agy`'s CONTRACT actually
 * differs from Codex's, it is recorded here rather than copied blind — see the numbered list below.
 *
 * EVERY CLAIM BELOW WAS PROVEN LIVE. `backlog/3633-...md`'s own 20 probes (2026-09-11, `agy` 1.2.1, a real
 * Google AI Pro subscription) are the evidentiary record for the CLI's general contract; this module ALSO
 * re-ran the specific probes its own design leans on WHILE BEING WRITTEN (same machine, same `agy` 1.2.1,
 * 2026-09-13) — see "LIVE RE-CONFIRMATION" below for exactly what was re-proven and what is new since #3633.
 *
 * WHAT DIFFERS FROM `codex-judge-spawn.mjs`, EACH RECORDED WHERE IT DIFFERS:
 *
 *   1. THE TRANSPORT IS `--input-format stream-json` / `--output-format stream-json`, NOT `agy`'s own default
 *      `--print '<prompt>' --output-format json`. #3633 probe 5 found `--print` takes the prompt as a FLAG
 *      VALUE (not a positional) with NO stdin route in plain `json` mode — the judged material would have to
 *      ride argv, which is the opposite of `judgeSpawn`'s "material on stdin" discipline. Probe 5b's
 *      UNDOCUMENTED stream-json route restores it: the prompt is an NDJSON `user` event on stdin
 *      (`{"event":"user","message":{"role":"user","content":"…"}}`), `--print ''` stays empty, and the
 *      answer arrives on the LAST line, an `{"event":"result","result":{…}}` object. Confirmed again live
 *      while building this module (see below).
 *
 *   2. THE ANSWER IS NESTED, one level deeper than #3633's own prose implied. In `--output-format json` mode
 *      (probe 1) the fields (`status`, `structured_output`, `usage`, …) sit at the TOP of the one JSON
 *      document. In `--output-format stream-json` mode — the route this module actually uses — those same
 *      fields sit ONE LEVEL DEEPER, under the `result` KEY of the `{"event":"result", ...}` line:
 *      `parsed.result.structured_output`, not `parsed.structured_output`. #3633's own prose ("the answer
 *      arrives on the `{"event":"result", …}` line, same `structured_output` field") is true but easy to
 *      misread as flat; `parseAntigravityJudgeOutcome` below reads `line.result.*`, confirmed against a real
 *      spawn's raw JSONL (see "LIVE RE-CONFIRMATION").
 *
 *   3. NO SCHEMA TRANSFORM, AT ALL — the single biggest difference from Codex. `#3371`'s Codex module exists
 *      largely to satisfy OpenAI's strict "every property must be `required`" structured-output dialect
 *      (`requireAllProperties`/`stripNulls`). #3633 probe 3 sent this repo's REAL `REVIEW_JUDGE_SHAPE` —
 *      fourteen `findings[]` properties, one (`summary`) required — to `agy` UNTRANSFORMED and it was
 *      accepted; probe 4 found an omitted optional field comes back ABSENT, never `null`. So this module's
 *      `shape` parameter is sent EXACTLY as given — no `requireAllProperties`-equivalent exists here, and none
 *      is needed.
 *
 *   4. NO SANDBOX FLAG (see the block above) and NO ALLOWLIST MECHANISM EITHER — the flag surface (`agy
 *      --help`, #3633) has no `--tools`/`--allowedTools` at all, only `--dangerously-skip-permissions` (all)
 *      or nothing (auto-deny). `assertNoAntigravityToolAllowlist` below refuses a request carrying
 *      `allowedTools` for the same reason `codex-judge-spawn.mjs`'s guard does: there is no configurable
 *      allow-list here for such a list to apply to, and this provider's ceiling — genuinely ZERO working
 *      tools — is fixed by simply never passing the one flag that would unlock any.
 *
 *   5. `--disable-slash-commands` IS MANDATORY, WITH NO CODEX COUNTERPART. #3633 probe 19: slash-command
 *      expansion is ON BY DEFAULT in print mode, and a prompt whose TEXT happens to start with `/settings` (or
 *      any registered slash command) can be answered by the CLI ITSELF, with NO model call at all
 *      (`conversation_id: ""`) — a prompt-injection surface with no analogue in either `judge-spawn.mjs` or
 *      `codex-judge-spawn.mjs`. This module passes `--disable-slash-commands` UNCONDITIONALLY; there is no
 *      parameter that can omit it.
 *
 *   6. THE SILENT-EMPTY-ANSWER FAILURE MODE (#3633 probe 7), THE MOST DANGEROUS SHAPE FOUND, AND THE ONE THIS
 *      MODULE IS BUILT AROUND. Because no tool is ever unlocked (see above), any prompt that leads the model to
 *      reach for one — even ordinarily, with no adversarial intent — ends the turn with exit 0, `result.status:
 *      "SUCCESS"`, `result.response: ""`, and `result.structured_output` KEY ABSENT ENTIRELY (never `null`,
 *      never an empty object — genuinely not present). `parseAntigravityJudgeOutcome` therefore checks for the
 *      KEY'S PRESENCE, not its truthiness, and THROWS `AntigravityToolDeniedError` — carrying `result.
 *      denied_actions` and stderr's own diagnostic line — whenever it is absent, regardless of `status` or
 *      exit code. Trusting either would silently record a juror that said nothing as a clean, empty-findings
 *      accept — precisely the `#x0p5k2q` class `we:scripts/lib/review-core.mjs`'s `REVIEW_JUDGE_SHAPE` guards
 *      against on the Claude path, reproduced here for a structurally different reason (auto-denial, not a
 *      juror choosing silence).
 *
 *   7. THREE PORT FIELDS CANNOT BE FILLED HONESTLY, same as Codex and for the same reasons: `costUsd` is always
 *      `0` (#3633 probe 18 — no USD figure anywhere, only token counts, and a `FetchQuotaStatus` RPC exists in
 *      the binary with no CLI surface); `sessionId` is OBSERVED off the `result.conversation_id` field (or the
 *      `init` event's own `conversation_id`, identical value), never derived up front the way `judgeSpawn`'s
 *      `deriveSessionId` is; a `budget` on the request is ACCEPTED but has NO EFFECT (`--max-budget-usd` has no
 *      `agy` equivalent) — kept as an accepted, unused option so a caller forwarding a whole
 *      `JudgeProviderRequest` need not special-case this provider just to omit one field.
 *
 * LIVE RE-CONFIRMATION (2026-09-13, this machine, `agy` 1.2.1, building this exact module — not quoted from
 * #3633, independently reproduced):
 *   - The stream-json route (item 1) ran end to end against `we:scripts/lib/__tests__/judge-spawn.integration.
 *     test.mjs`'s own toy schema: exit 0, a `result` event whose `structured_output` held the schema-shaped
 *     answer.
 *   - The nesting (item 2) was read directly off that raw JSONL — `result.result.structured_output`, not
 *     `result.structured_output` — confirming #3633's prose the hard way.
 *   - The silent-empty-answer failure (item 6) was reproduced on demand: a prompt asking the (tool-FREE, no
 *     `--dangerously-skip-permissions`) juror to run `git status` produced two `TOOL_ERROR` step events
 *     (`list_dir`, then `run_command`, each "permission check failed" / "user denied permission"), then a
 *     `result` event with `status: "SUCCESS"`, `response: ""`, `structured_output` ABSENT, and
 *     `denied_actions: [{"action":"command","display_name":"RunCommand"}]` — exit code 0 throughout, and
 *     stderr carried `jetski: no output produced — a tool required the "command" permission that headless
 *     mode cannot prompt for, so it was auto-denied. … re-run with --dangerously-skip-permissions to
 *     auto-approve all tools.` (which this module never does).
 *   - `--disable-slash-commands` (item 5) was re-tested against a bare `/settings` prompt: unlike #3633's own
 *     probe (which reported an immediate `rc=2` refusal on that exact input in stream-json mode), this run
 *     instead engaged the model normally — a real `conversation_id`, real tool reads, and a genuine schema-
 *     constrained answer about settings, rather than the CLI intercepting the string as a command. Recorded
 *     as an HONEST DISCREPANCY from #3633's own prose on that one sub-case, not silently smoothed over — but
 *     it does not weaken the mandatory-flag design: what actually matters (the string was judged as DATA, and
 *     no free CLI-internal answer bypassed the model) held either way.
 *   - `--effort` alone (no `--model`) was confirmed to work with no CLI complaint; an invalid `--effort` value
 *     produced BOTH a stderr line and a stream-json `result` event with `status: "ERROR"` before any API call,
 *     exit 1 — confirming #3633 probe 9's "fails fast, in the request event" finding survives the stream-json
 *     route too.
 *
 * PURE except `antigravityJudgeSpawn`, which spawns a subprocess and writes/removes a temp file, and takes an
 * injectable `spawnFn` exactly like `judgeSpawn`/`codexJudgeSpawn` do. `buildAntigravityJudgeArgv`,
 * `buildAntigravityPrompt`, `buildAntigravityStreamInput` and `parseAntigravityJudgeOutcome` are pure.
 *
 * A LEAF MODULE, DELIBERATELY — imports nothing from the review/jury seams, mirroring `judge-spawn.mjs`'s and
 * `codex-judge-spawn.mjs`'s own "A LEAF module" discipline (see the latter's header for the concrete
 * `markdown-it`/ephemeral-clone-CLI-test regression that discipline exists to prevent).
 */

import { agyRunEvidence, readAgyHold, saveAgyHold, agyEvidenceError } from './antigravity-run-evidence.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JUDGE_TIMEOUT_GRACE_MS, JUDGE_TIMEOUT_MS, JudgeTimeoutError } from './judge-spawn.mjs';
// #3383 mechanical-dispatcher Gap 1 fix — see the call site below, right after `transcriptFile` is known.
// Mirrors `codex-judge-spawn.mjs`'s own import of `recordCodexRunScorecard` verbatim.
import { recordAntigravityRunScorecard } from '../conveyor/run-quality-record.mjs';

/** The CLI this provider runs as. Named once, exactly like `judge-spawn.mjs`'s `JUDGE_CLI` and
 *  `codex-judge-spawn.mjs`'s `CODEX_CLI`. */
export const ANTIGRAVITY_CLI = 'agy';

/**
 * #3383 — THE PINNED MODEL for a review-panel seat backed by this provider (`review-pr.mjs`'s
 * `judgeAntigravityReview`, the fifth seat), mirroring `codex-direct-task.mjs#CODEX_MODEL`'s role for the
 * Codex seats: a stampable `{provider, model}` identity for `model-probation.json`, rather than whatever `agy`
 * resolves implicitly (#3633 probe 9 — the CLI's own undocumented default self-reports as "Gemini 3.8 Flash"
 * with NO exposed effort tier, so a run record could not even stamp what it actually asked for).
 *
 * `gemini-3.1-pro` — a BARE model id from `agy`'s own roster (#3633 probe 9's "ten models" enumeration) —
 * deliberately NOT one of the effort-SUFFIXED ids (`gemini-3.8-flash-medium` and friends). Probe 9 also found
 * effort is "either a model-id suffix or the flag, never both": a suffixed id conflicts with a separately
 * passed `--effort`, while a bare id like this one REQUIRES `--effort` as its own flag (available `low|high`
 * for this specific model). This module's seat always supplies one explicitly (see `ANTIGRAVITY_REVIEW_EFFORT`
 * in `review-pr.mjs`), so pinning a bare id here is what keeps the two flags from ever landing on the same
 * argv in a way `agy` refuses.
 *
 * NO LIVE COST/QUALITY COMPARISON HAS BEEN RUN across `agy`'s ten models for this role, unlike the Codex fourth
 * seat's measured medium-vs-max comparison (`CORRECTNESS_ADVISORY_EFFORT`'s own docblock) — stated honestly:
 * this is a deliberately modest, defensible starting pin for a seat with ZERO real review trials (see
 * `model-probation.json`'s own entry for this identity), not a benchmarked choice. Revisit once probation data
 * (#3649's run-quality recorder) accumulates.
 */
export const ANTIGRAVITY_MODEL = 'gemini-3.1-pro';

/**
 * The shared care→rigor dial's effort enum (`judge-spawn.mjs#EFFORT_LEVELS`) does not match `agy`'s own
 * `--effort` values one-to-one — #3633 probe 9: `agy --effort` accepts exactly `low`, `medium`, `high`.
 * `xhigh`/`max` CLAMP DOWN to `high` rather than being refused, mirroring `codex-judge-spawn.mjs`'s own
 * `CODEX_EFFORT_MAP` reasoning exactly: a clamp is a degraded-but-working request, a refusal is a request that
 * cannot run at all. RE-DERIVE if `agy` ever adds a level above `high`.
 */
export const ANTIGRAVITY_EFFORT_MAP = Object.freeze({
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
});

/**
 * #x5s8b47 — PER-MODEL `--effort` RESTRICTIONS, layered UNDER {@link ANTIGRAVITY_EFFORT_MAP}'s already
 * CLI-LEVEL clamp (xhigh/max -> high). That map normalizes across every model `agy` can run — the CLI's
 * `--effort` flag itself accepts low/medium/high universally — but a SPECIFIC model can still refuse a value
 * the flag otherwise accepts: a live run seating the pinned seat model ({@link ANTIGRAVITY_MODEL},
 * `gemini-3.1-pro`) at `medium` hit `status: "ERROR"` before any API call, `invalid model selection (--model
 * "gemini-3.1-pro" --effort "medium"): gemini-3.1-pro has no "medium" effort (available: low, high)` — this
 * seat's fallback path (`judgeAdvisory`/`judgeCorrectnessAdvisory` degrading onto `antigravity` when Codex is
 * quota-held) crashed on EVERY run as a result, exactly as `ANTIGRAVITY_MODEL`'s own docblock already
 * predicted ("REQUIRES `--effort`... available `low|high` for this specific model") but nothing enforced.
 *
 * A SEPARATE table from `ANTIGRAVITY_EFFORT_MAP` rather than folding model-awareness into it: most models on
 * `agy`'s own roster accept the full low/medium/high range (#3633 probe 9's "ten models" enumeration), so a
 * per-model entry here is the EXCEPTION, keyed only for a model actually known to restrict it — an unlisted
 * model falls through to the CLI-level map untouched. Each entry maps an UNSUPPORTED value to the NEAREST
 * supported one — a degrade, never a refusal, mirroring `ANTIGRAVITY_EFFORT_MAP`'s own xhigh/max -> high
 * clamp reasoning exactly: an unsupported request should still run, at the closest level the model actually
 * offers, rather than crash the seat outright.
 */
export const ANTIGRAVITY_MODEL_EFFORT_OVERRIDES = Object.freeze({
  [ANTIGRAVITY_MODEL]: Object.freeze({ medium: 'high' }),
});

/**
 * Resolve the FINAL `--effort` value for a given `model`, applying {@link ANTIGRAVITY_MODEL_EFFORT_OVERRIDES}
 * (when one exists for that model) ON TOP OF the CLI-level `mapped` value {@link ANTIGRAVITY_EFFORT_MAP}
 * already produced. PURE — no model, or a model with no override table, returns `mapped` unchanged.
 * @param {string|undefined} model
 * @param {string} mapped - already resolved through `ANTIGRAVITY_EFFORT_MAP`.
 * @returns {string}
 */
export function resolveAntigravityModelEffort(model, mapped) {
  const key = typeof model === 'string' ? model.trim() : '';
  const overrides = key ? ANTIGRAVITY_MODEL_EFFORT_OVERRIDES[key] : undefined;
  return overrides?.[mapped] ?? mapped;
}

/**
 * #3633 probe 7, reproduced live while building this module (see the file header's "LIVE RE-CONFIRMATION") —
 * the single most dangerous failure shape found across all three providers this repo has probed: a run that
 * reaches for a tool it structurally cannot use ends with exit 0, `status: "SUCCESS"`, an empty `response`,
 * and `structured_output` ABSENT rather than merely empty. A NEW CLASS with no Codex counterpart (Codex's
 * read-only shell lets `git status` succeed; `agy`'s auto-deny refuses the attempt outright) — collapsing it
 * into a generic "the juror failed" `Error` would read as "the model got it wrong" when the real fact is "the
 * model tried to act and this seat cannot act at all". Carries `deniedActions` (the CLI's own
 * `result.denied_actions` array, when present) so a caller can see WHAT was attempted without re-parsing
 * stderr.
 */
export class AntigravityToolDeniedError extends Error {
  constructor({ deniedActions, stderr, raw }) {
    const actions = Array.isArray(deniedActions) && deniedActions.length
      ? deniedActions.map((a) => a?.display_name || a?.action || JSON.stringify(a)).join(', ')
      : '(none reported)';
    const tail = String(stderr || '').trim().slice(-600);
    super(
      'antigravity-judge-spawn: the juror reached for a tool this TOOL-FREE seat cannot use, and headless mode '
      + 'auto-denied it — the turn still reports exit 0 and `status: "SUCCESS"`, but `structured_output` is '
      + `ABSENT (#3633 probe 7). Denied action(s): ${actions}.`
      + (tail ? `\nstderr[-600..]: ${tail}` : '\nstderr: <empty>')
      + '\nThis is a hard failure regardless of `status` — trusting either would silently record a juror that '
      + 'said nothing as a clean accept. Re-run with a mandate that does not invite tool use, or seat a '
      + 'tool-bearing provider instead.',
    );
    this.name = 'AntigravityToolDeniedError';
    this.deniedActions = Array.isArray(deniedActions) ? deniedActions : [];
    this.raw = raw;
  }
}

/**
 * Refuses a `JudgeProviderRequest` carrying `allowedTools` — mirrors `codex-judge-spawn.mjs#
 * assertNoCodexToolAllowlist` exactly, for the analogous reason: `agy`'s flag surface (#3633) has NO
 * per-tool allow-list mechanism at all, only the all-or-nothing `--dangerously-skip-permissions`, which this
 * module never passes. This provider's ceiling — genuinely ZERO working tools, stronger than Codex's
 * read-only shell — is fixed by that omission, not by a configurable list.
 * @param {string[]|null|undefined} allowedTools
 */
export function assertNoAntigravityToolAllowlist(allowedTools) {
  if (allowedTools === null || allowedTools === undefined) return;
  if (Array.isArray(allowedTools) && allowedTools.length === 0) return;
  throw new Error(
    'antigravity-judge-spawn: refusing a request with an `allowedTools` list — this provider has no '
    + 'configurable tool allow-list to apply it to. It never passes `--dangerously-skip-permissions`, so '
    + 'EVERY tool call (shell or in-process) is auto-denied by `agy` itself (#3633 probe 7) — the ceiling is '
    + 'fixed by that omission, not by an allow-list. Omit `allowedTools`, or use a tool-bearing provider for '
    + 'an allow-listed role.',
  );
}

/**
 * THE PURE HALF: the `agy` argv, translated from `#3633`'s probes (5b, 9, 19) and this module's own live
 * re-confirmation. Spawns nothing, writes no file, reads no environment.
 *
 * NEVER `--dangerously-skip-permissions` (there is no parameter that adds it — that is what keeps this seat
 * genuinely tool-free) and NEVER `--sandbox` (pointless here: with no tool ever unlocked, there is nothing for
 * `--sandbox`'s own known bypass — #3633 probe 13, `view_file`/`write_to_file` walking around a sandboxed
 * shell — to exploit; adding it would only imply a confinement this seat does not need).
 *
 * @param {object} opts
 * @param {string} opts.schemaFile - path a caller has ALREADY written the JSON Schema to (sent UNTRANSFORMED —
 *   see the file header's item 3; there is no `requireAllProperties`-equivalent for this provider).
 * @param {string} [opts.model] - `agy`'s `--model`.
 * @param {string} [opts.effort] - one of `judge-spawn.mjs`'s `EFFORT_LEVELS`; mapped via `ANTIGRAVITY_EFFORT_MAP`.
 * @returns {string[]} argv AFTER the binary name.
 */
export function buildAntigravityJudgeArgv({ schemaFile, model, effort } = {}) {
  if (typeof schemaFile !== 'string' || !schemaFile.trim()) {
    throw new TypeError('antigravity-judge-spawn: `schemaFile` must be a non-empty path');
  }
  const argv = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    // MANDATORY, UNCONDITIONALLY — #3633 probe 19's prompt-injection surface (see file header item 5). No
    // parameter here can omit this.
    '--disable-slash-commands',
    '--json-schema', schemaFile,
  ];
  if (model !== undefined) {
    if (typeof model !== 'string' || !model.trim() || model.trim().startsWith('-')) {
      throw new TypeError(`antigravity-judge-spawn: \`model\` must be a plain non-empty string, got ${JSON.stringify(model)}`);
    }
    argv.push('--model', model.trim());
  }
  if (effort !== undefined) {
    const mapped = ANTIGRAVITY_EFFORT_MAP[effort];
    if (!mapped) {
      throw new TypeError(`antigravity-judge-spawn: \`effort\` must be one of ${Object.keys(ANTIGRAVITY_EFFORT_MAP).join('|')}, got ${JSON.stringify(effort)}`);
    }
    // #x5s8b47 — a SECOND, model-specific clamp on top of the CLI-level one above (see
    // `ANTIGRAVITY_MODEL_EFFORT_OVERRIDES`'s own header for the live crash this fixes).
    argv.push('--effort', resolveAntigravityModelEffort(model, mapped));
  }
  // `--print ''` — the prompt rides stdin as a stream-json `user` event instead (see
  // `buildAntigravityStreamInput`); an EMPTY value is required in this mode (#3633 probe 5b), never omitted
  // (omitting `--print` entirely is plain-text mode, which has no stdin route at all — see the file header).
  argv.push('--print', '');
  return argv;
}

/**
 * #x5s8b47 — THE UNCONDITIONAL TOOL-FREE CORRECTION. Appended to EVERY mandate this spawn runs, regardless of
 * what the caller's own mandate text said, because a caller cannot be trusted to already know it is landing
 * on this seat: `review-pr.mjs`'s two Codex advisory seats (`judgeAdvisory`, `judgeCorrectnessAdvisory`) build
 * their mandates assuming a REAL, if read-only, Codex shell (`CODEX_ADVISORY_SANDBOX_CORRECTION`: "you are not
 * a tool-free juror... you can run non-mutating commands and read files") — true when Codex actually judges,
 * but silently WRONG the moment a quota hold degrades that same request onto this genuinely zero-tool
 * provider (the not-yet-landed `gracefulOnUnavailable`/`PROVIDER_QUOTA_FALLBACK` path, #x5s8b47's own sibling
 * card). Live evidence (2026-09-28, real `agy` 1.2.1 runs against open PRs): a request carrying that
 * shell-framing text reliably ended in the #3633 probe-7 silent-tool-denial shape — the model reached for
 * `list_dir`/`run_command`, both auto-denied, `structured_output` ABSENT.
 *
 * FIXED HERE, AT THE PROVIDER BOUNDARY, rather than by editing each caller's mandate: this spawn is the one
 * place that KNOWS, unconditionally and for every caller, that the seat about to run has genuinely zero tools
 * (see the file header's "WHY TOOL-FREE" section) — a fact no caller-supplied mandate text can be trusted to
 * already reflect correctly, since the SAME request object may otherwise be destined for a tool-bearing
 * provider (Codex's read-only shell) on a run where no quota hold ever fires. Appended LAST, after the
 * caller's own mandate, so it reads as an explicit correction/override of anything said above it — mirrors
 * `CODEX_ADVISORY_SANDBOX_CORRECTION`'s own "appended, not spliced in" shape (`review-pr.mjs`) for the
 * opposite direction (that one corrects "no tools" to "read-only shell"; this one corrects the reverse).
 */
export const ANTIGRAVITY_TOOL_FREE_CORRECTION = [
  'CORRECTION FOR THIS SEAT, OVERRIDING ANYTHING SAID ABOVE ABOUT A SHELL, TOOLS, OR THE ABILITY TO READ OR RUN',
  'ANYTHING: whatever this run is, on THIS seat you have NO tools at all — not a read-only shell, not a',
  'sandboxed one, nothing. Any tool call you attempt (a shell command, a file read, a directory listing,',
  'anything) is silently denied and can end this turn with an empty, useless answer instead of a real one. The',
  'diff and description you need are already given to you below, in full, and there is nothing more available',
  '— do not try to read, list, or run anything to get more. Answer ONLY from the material below, using the',
  'required structured output, and say so plainly whenever you cannot verify something rather than describing',
  'verification you did not (and cannot) perform.',
].join(' ');

/**
 * Fold the mandate into the prompt text — `agy` has no `--append-system-prompt` equivalent (#3633's flag
 * surface), same gap Codex has. A clearly-labelled two-part text, not a silent concatenation, mirroring
 * `codex-judge-spawn.mjs#buildCodexPrompt` exactly. {@link ANTIGRAVITY_TOOL_FREE_CORRECTION} rides between the
 * mandate and the material — see its own header for why it is unconditional.
 * @param {string} mandate
 * @param {string} input
 * @returns {string}
 */
export function buildAntigravityPrompt(mandate, input, { toolPolicy = 'none', readDir = null } = {}) {
  if (toolPolicy === 'read-cwd') {
    // Card 84 live run (PR #4133, 2026-10-06): with the correction only AFTER a tool-bearing panel mandate, the juror's
    // FIRST action was `run_command ls` — denied, turn over, no answer. So the correction leads AND closes the mandate.
    const correction = buildAntigravityReadOnlyCorrection(readDir);
    return `${correction}\n\n${mandate}\n\n${correction}\n\n---\n\nThe material to judge follows.\n\n${input}`;
  }
  return `${mandate}\n\n${ANTIGRAVITY_TOOL_FREE_CORRECTION}\n\n---\n\nThe material to judge follows.\n\n${input}`;
}

/**
 * Card 84 — THE READ-ONLY JUROR CORRECTION, for a seat that runs in its own throwaway checkout of the PR (an agy
 * review-seat juror, `we:scripts/lib/agy-review-juror.mjs`). Without `--dangerously-skip-permissions` agy's
 * headless check allows a file READ inside its cwd and denies every shell command and every write (re-probed live on
 * agy 1.3.0, 2026-10-06: `view_file` inside the cwd succeeded; `write_to_file` came back in `denied_actions`). A
 * denied call ends the turn with NO structured answer (#3633 probe 7), so the juror is told plainly not to try one.
 * @param {string|null} readDir - the checkout the juror may read.
 */
export function buildAntigravityReadOnlyCorrection(readDir) {
  const where = readDir ? ` (${JSON.stringify(readDir)})` : '';
  return [
    'CORRECTION FOR THIS SEAT, OVERRIDING ANYTHING SAID ABOVE ABOUT A SHELL OR TOOLS: your working directory is a',
    `checkout of this PR's head${where}. To look at code use ONLY these tools: list_dir, view_file, grep_search,`,
    'find_by_name — inside that directory. NEVER use run_command or any shell, not even `ls`, `cat`, `git` or a',
    'test run, whatever the instructions above say about running gates or mutation probes: a shell call is denied',
    'and a denied call ends your turn with NO answer. Never write, edit, create or delete any file anywhere — any',
    'change on disk voids this seat. Do not read outside that directory. Cite files by their path RELATIVE to that',
    'directory. Say plainly what you could not verify instead of describing checks you did not run. Answer with the',
    'required structured output.',
  ].join(' ');
}

/**
 * Wrap the prompt in the stream-json `user` event `agy --input-format stream-json` requires (#3633 probe 5b,
 * the undocumented route recovered by probing the binary's own validation errors). ONE line, newline-
 * terminated — `agy` reads NDJSON, one event per line.
 * @param {string} prompt
 * @returns {string}
 */
export function buildAntigravityStreamInput(prompt) {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;
}

/** One parsed JSONL line, or `null` for a blank/unparsable one. Never throws. Mirrors
 *  `codex-judge-spawn.mjs`'s own `parseJsonlLine`. */
function parseJsonlLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

/**
 * THE OTHER PURE HALF: `agy`'s raw stdout (stream-json JSONL) into a validated result or a throw. Mirrors
 * `parseJudgeOutcome`/`parseCodexJudgeOutcome`'s discipline — fail loud, fail with the spawn's own words.
 *
 * THE ANSWER IS THE `result` EVENT'S OWN `result` OBJECT (file header item 2) — `line.result.*`, not
 * `line.*`. Scanned from the END, mirroring `codex-judge-spawn.mjs`'s "terminal event is the last one" rule,
 * though in practice `agy` emits exactly one `result` event per turn, always last.
 *
 * @param {object} o
 * @param {string} o.stdout - raw stream-json JSONL stdout.
 * @param {string} [o.stderr] - folded in on any failure path — some `agy` failures never reach stdout at all
 *   (#3633 probe 8: a missing schema file), and the silent-empty-answer shape (probe 7) carries its own
 *   explanation on stderr only.
 * @returns {{value: object, sessionId: string, costUsd: number, numTurns: number, stopReason: string,
 *            usage: object}}
 * @throws {AntigravityToolDeniedError} on the silent-empty-answer shape (`status: "SUCCESS"`, no
 *   `structured_output`) — see the file header item 6.
 * @throws {Error} on any other terminal failure (`status: "ERROR"`), or on no terminal event at all.
 */
export function parseAntigravityJudgeOutcome({ stdout, stderr = '' } = {}) {
  const lines = String(stdout).split('\n').map(parseJsonlLine).filter(Boolean);

  let terminal = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.event === 'result' && lines[i]?.result && typeof lines[i].result === 'object') {
      terminal = lines[i].result;
      break;
    }
  }

  if (!terminal) {
    // No `result` event at all. #3633 probe 8: a missing/malformed schema file produces EMPTY stdout with the
    // reason on stderr only — fold it in, exactly as `parseJudgeOutcome`/`parseCodexJudgeOutcome` do.
    const tail = String(stderr).trim().slice(-600);
    throw new Error(
      'antigravity-judge-spawn: the juror produced no terminal `{"event":"result", ...}` line.\n'
      + `stdout[0..600]: ${String(stdout).slice(0, 600)}\n`
      + (tail ? `stderr[-600..]: ${tail}` : 'stderr: <empty>'),
    );
  }

  if (terminal.status === 'ERROR') {
    // THE CLI'S OWN WORDS, VERBATIM — never reworded, exactly like `parseJudgeOutcome`'s `--bare` passthrough
    // and `parseCodexJudgeOutcome`'s `turn.failed` handling. #3633 probe 9/17: an invalid model/effort
    // selection or an auth failure both land here, fast and with the reason already in `terminal.error`.
    const tail = String(stderr).trim().slice(-600);
    throw new Error(
      `antigravity-judge-spawn: the juror failed: ${terminal.error || '<no error message>'}`
      + (tail ? `\nstderr[-600..]: ${tail}` : ''),
    );
  }

  // #3633 probe 7, reproduced live (file header item 6) — THE SILENT EMPTY ANSWER. `status: "SUCCESS"` and
  // exit 0 are NOT enough: `structured_output` must be checked for PRESENCE, not truthiness (an honest zero-
  // findings answer is a present, non-empty OBJECT — `{findings: [], summary: '...'}` — never an absent key).
  if (!('structured_output' in terminal) || terminal.structured_output === undefined) {
    throw new AntigravityToolDeniedError({
      deniedActions: terminal.denied_actions, stderr, raw: terminal,
    });
  }
  const { structured_output: structuredOutput } = terminal;
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput)) {
    throw new Error(
      `antigravity-judge-spawn: the juror's \`structured_output\` was not a JSON object: `
      + `${JSON.stringify(structuredOutput).slice(0, 200)}`,
    );
  }

  return {
    value: structuredOutput,
    sessionId: typeof terminal.conversation_id === 'string' ? terminal.conversation_id : '',
    // #3633 probe 18 — no USD figure exists anywhere in `agy`'s output. Reported as 0, never estimated.
    costUsd: 0,
    numTurns: typeof terminal.num_turns === 'number' ? terminal.num_turns : 0,
    stopReason: terminal.status,
    usage: terminal.usage ?? {},
  };
}

/** Sum of the token fields `agy` reports as "loaded" — its own key names (#3633 probe 10: `input_tokens` +
 *  `cache_read_tokens` is the comparable "context" figure; `total_tokens` alone excludes the cache-read half). */
export function antigravityLoadedContextTokens(usage = {}) {
  const n = (k) => (typeof usage?.[k] === 'number' ? usage[k] : 0);
  return n('input_tokens') + n('cache_read_tokens');
}

/**
 * THE DURABLE TRANSCRIPT DIRECTORY — mirrors `we:scripts/lib/codex-judge-spawn.mjs#resolveCodexJudgeTranscriptDir`
 * exactly, for the SAME confirmed defect on this sibling seat (#3383): `antigravityJudgeSpawn` captured the
 * full raw stream-json JSONL stdout purely to parse the schema-constrained answer out of it, then discarded
 * the buffer — this seat has NO rollout-file fallback at all (unlike Codex's `--ephemeral`-suppressed one, `agy`
 * simply never writes one to a caller-visible path for THIS invocation shape), so nothing on disk held a
 * completed judge run's transcript unless this module puts it there itself. `ANTIGRAVITY_JUDGE_TRANSCRIPT_DIR`
 * honours an override (tests, or a caller wanting a different location); the default sits in the user's home
 * directory — NOT the OS tmpdir — for the same durability reason Codex's sibling default does.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveAntigravityJudgeTranscriptDir(env = process.env) {
  const override = env?.ANTIGRAVITY_JUDGE_TRANSCRIPT_DIR;
  return (typeof override === 'string' && override.trim()) ? override.trim() : join(homedir(), '.antigravity-judge-transcripts');
}

/**
 * The session identifier off `agy`'s own stream-json JSONL — extracted directly and independently of
 * {@link parseAntigravityJudgeOutcome}'s own success/failure, for the same reason
 * `extractCodexJudgeThreadId` is: the transcript must be persisted even when the run goes on to fail (the
 * silent-tool-denial shape, a `status: "ERROR"`, a kill) — those are exactly the runs a human or the run-quality
 * scorer most wants to read afterward.
 *
 * `agy` names this `conversation_id`, NOT `thread_id` (Codex's term) — read off the EARLIEST event that
 * carries one, the `{"event":"init", conversation_id, ...}` line (this module's own header item 7 and #3633
 * probe 20's raw JSON both confirm `init` carries it; `antigravity-judge-spawn.test.mjs`'s own fixtures put it
 * at that event's TOP level, not nested under `init`), falling back to the terminal `{"event":"result",
 * result: {conversation_id, ...}}` line for a stream that has no `init` event at all — both name the SAME
 * value per the file header, so either suffices. An empty string (the auth-failure shape's own
 * `conversation_id: ""`) counts as "no id", not a real one. PURE.
 * @param {string} stdout
 * @returns {string|null}
 */
export function extractAntigravityJudgeSessionId(stdout) {
  const lines = String(stdout).split('\n').map(parseJsonlLine).filter(Boolean);
  const init = lines.find((l) => l?.event === 'init' && typeof l.conversation_id === 'string' && l.conversation_id);
  if (init) return init.conversation_id;
  const result = lines.find((l) => l?.event === 'result' && l?.result && typeof l.result.conversation_id === 'string' && l.result.conversation_id);
  return result ? result.result.conversation_id : null;
}

/**
 * PERSIST THE RAW STREAM-JSON JSONL STDOUT `antigravityJudgeSpawn` already captures in memory to a durable
 * local file — mirrors `persistCodexJudgeTranscript` exactly (`we:scripts/lib/codex-judge-spawn.mjs`), same
 * fix for the same class of gap on this sibling seat. Writes to
 * `<dir>/antigravity-judge-<sessionId>.jsonl`, named by the same `conversation_id`/`sessionId`
 * `antigravityJudgeSpawn` already returns, so a later reader (`we:scripts/conveyor/run-quality-scorer.mjs`)
 * can find it from a run record's stamped `transcriptFile` path alone. Unscrubbed at rest, same discipline as
 * the Codex sibling and Claude's own local judge transcripts — scrubbing happens only at the point evidence is
 * EXCERPTED into a published finding (`we:scripts/lib/secret-scrub.mjs`).
 *
 * NEVER THROWS — a transcript that fails to write is a best-effort loss, not a reason to fail a judge call
 * that otherwise completed; the caller gets `null` back and the run proceeds exactly as it did before this
 * existed.
 *
 * @param {object} o
 * @param {string} o.stdout - the raw stream-json JSONL captured from the spawn, whatever its length.
 * @param {string|null} o.sessionId - from {@link extractAntigravityJudgeSessionId}; a run with none gets a
 *   random id so nothing is silently dropped, labelled `unknown-` so a reader can tell the difference from a
 *   real one.
 * @param {string} o.dir - the durable directory (see {@link resolveAntigravityJudgeTranscriptDir}).
 * @param {(dir: string) => void} [o.ensureDir] - injectable `mkdirSync`, for tests.
 * @param {(path: string, data: string) => void} [o.writeFile] - injectable `writeFileSync`, for tests.
 * @param {() => string} [o.mkId] - injectable id generator for the `sessionId == null` fallback, for tests.
 * @returns {string|null} the file path written, or `null` on any failure.
 */
export function persistAntigravityJudgeTranscript({
  stdout, sessionId, dir, ensureDir = (d) => mkdirSync(d, { recursive: true }), writeFile = writeFileSync, mkId = randomUUID,
} = {}) {
  try {
    ensureDir(dir);
    const name = `antigravity-judge-${sessionId || `unknown-${mkId()}`}.jsonl`;
    const file = join(dir, name);
    writeFile(file, String(stdout));
    return file;
  } catch {
    return null;
  }
}

/**
 * THE ONE FUNCTION AN ANTIGRAVITY-BACKED `judge` STEP CALLS — wired into `we:scripts/operations/
 * cli-adapter.mjs#resolveJudgeProvider`'s `'antigravity'` name (`review-pr.mjs`'s fifth seat). Spawns a
 * tool-free `agy` juror and returns its validated answer, in the same `JudgeProviderOutcome` shape
 * `judgeSpawn`/`codexJudgeSpawn` return.
 *
 * DOES NOT TRANSFORM `shape` — unlike `codexJudgeSpawn`, there is nothing to transform (file header item 3).
 *
 * @param {object} opts
 * @param {string} opts.mandate
 * @param {string} opts.input
 * @param {object} opts.shape - JSON Schema, sent EXACTLY as given.
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {number|null} [opts.budget] - ACCEPTED BUT IGNORED: `agy` has no `--max-budget-usd` equivalent
 *   (#3633 probe 18). Kept as an accepted (unused) option for the same reason `codexJudgeSpawn`'s is.
 * @param {string[]|null} [opts.allowedTools] - must be absent/empty; see `assertNoAntigravityToolAllowlist`.
 * @param {string|null} [opts.cwd] - a scratch directory. Defaults to a fresh `mkdtemp`. Genuinely inert here:
 *   with no tool ever unlocked, the juror cannot read OR write anything regardless of cwd — stronger than
 *   Codex's read-only shell, which can still read.
 * @param {Record<string,string>} [opts.env]
 * @param {string} [opts.cli]
 * @param {number} [opts.timeoutMs] - PARENT-IMPOSED wall; `agy`'s own `--print-timeout` (default 5m0s) exists
 *   but does NOT cap its internal 60s auth-wait (#3633 probe 17), so this remains the real ceiling, exactly as
 *   for the other two providers. Never passed to `agy` itself — this module relies solely on the SIGKILL below.
 * @param {Function} [opts.spawnFn]
 * @param {(prefix: string) => string} [opts.mkTempDir] - injectable `mkdtempSync`, for tests.
 * @param {(path: string, data: string) => void} [opts.writeFile] - injectable, for tests.
 * @param {(path: string, opts: object) => void} [opts.removeFile] - injectable, for tests.
 * @param {string} [opts.transcriptDir] - the durable directory {@link persistAntigravityJudgeTranscript}
 *   writes to; injectable (tests; a caller wanting a different location) but defaults to
 *   {@link resolveAntigravityJudgeTranscriptDir}'s real, durable default.
 * @param {Function} [opts.persistTranscript] - injectable for tests; defaults to the real
 *   {@link persistAntigravityJudgeTranscript}.
 * @param {Function} [opts.recordScorecard] - #3383 Gap 1 fix; injectable for tests, defaults to the real
 *   {@link recordAntigravityRunScorecard}. Mirrors `codex-judge-spawn.mjs#codexJudgeSpawn`'s own
 *   `recordScorecard` seam exactly.
 * @returns {Promise<{value: object, sessionId: string, costUsd: number, durationMs: number, wallMs: number,
 *                    numTurns: number, stopReason: string, usage: object, loadedContextTokens: number,
 *                    timedOut: boolean, argv: string[], transcriptFile: string|null}>} `transcriptFile` is the
 *   durable local path {@link persistAntigravityJudgeTranscript} wrote the raw stream-json JSONL to (or `null`
 *   if the write itself failed) — never the transcript content, per `we:scripts/operations/run-record.mjs`'s
 *   telemetry whitelist, which this field (reusing the SAME `transcriptFile` name the Codex sibling seat
 *   already added there) is designed to pass through unmodified.
 */
export async function antigravityJudgeSpawn({
  mandate,
  input,
  shape,
  model = ANTIGRAVITY_MODEL,
  effort,
  allowedTools = null,
  cwd = null,
  env = process.env,
  cli = ANTIGRAVITY_CLI,
  timeoutMs = JUDGE_TIMEOUT_MS,
  spawnFn = nodeSpawn,
  mkTempDir = (prefix) => mkdtempSync(prefix),
  writeFile = writeFileSync,
  removeFile = (p, o) => rmSync(p, o),
  // THE FIX (mirrors codex-judge-spawn.mjs's own persistence fix, #3383): the raw stream-json JSONL this
  // function already captures used to be discarded once parsed. `transcriptDir` + `persistTranscript` are
  // injectable (tests; a caller wanting a different location) but default to the real durable write — see
  // `persistAntigravityJudgeTranscript`'s own header.
  transcriptDir = resolveAntigravityJudgeTranscriptDir(env),
  persistTranscript = persistAntigravityJudgeTranscript,
  // #3383 mechanical-dispatcher Gap 1 fix — see the call site below, right after `transcriptFile` is known.
  recordScorecard = recordAntigravityRunScorecard,
  readHold = readAgyHold, saveHold = saveAgyHold,
  // Card 84 — `'read-cwd'` lets the juror read inside `cwd` (an agy review-seat juror's own checkout). Still no
  // `--dangerously-skip-permissions`, so shell and writes stay denied. `role` labels the scorecard row.
  toolPolicy = 'none',
  role = 'advisory-review',
} = {}) {
  if (toolPolicy !== 'none' && toolPolicy !== 'read-cwd') {
    throw new TypeError(`antigravity-judge-spawn: \`toolPolicy\` must be none|read-cwd, got ${JSON.stringify(toolPolicy)}`);
  }
  if (toolPolicy === 'read-cwd' && (typeof cwd !== 'string' || !cwd.trim())) {
    throw new TypeError('antigravity-judge-spawn: a read-cwd juror needs its own checkout as `cwd`');
  }
  if (typeof mandate !== 'string' || !mandate.trim()) {
    throw new TypeError('antigravity-judge-spawn: `mandate` must be a non-empty string');
  }
  if (typeof input !== 'string' || !input.trim()) {
    throw new TypeError('antigravity-judge-spawn: `input` must be a non-empty string — there is nothing to judge');
  }
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
    throw new TypeError('antigravity-judge-spawn: `shape` must be a JSON Schema object');
  }
  assertNoAntigravityToolAllowlist(allowedTools);

  const hold = readHold(model);
  if (hold) {
    recordScorecard({ provider: 'antigravity', model: 'unknown', ...hold, dispatchKind: role, kind: 'review', role });
    throw agyEvidenceError(hold);
  }
  const workDir = mkTempDir(join(tmpdir(), 'antigravity-judge-'));
  const spawnCwd = cwd || workDir;
  const schemaFile = join(workDir, 'schema.json');
  writeFile(schemaFile, JSON.stringify(shape));

  const argv = buildAntigravityJudgeArgv({ schemaFile, model, effort });
  const streamInput = buildAntigravityStreamInput(buildAntigravityPrompt(mandate, input, { toolPolicy, readDir: cwd }));

  const startedAt = Date.now();
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnFn(cli, argv, { cwd: spawnCwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new Error(`antigravity-judge-spawn: could not start \`${cli}\`: ${e.message}`));
        return;
      }
      let out = '';
      let err = '';
      let timer = null;
      let grace = null;
      let killed = false;
      let settled = false;
      const settle = (r) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        resolve(r);
      };
      if (timeoutMs > 0) {
        // PARENT-IMPOSED WALL — `agy` has no CLI-side timeout that covers every wait (#3633 probe 17: its own
        // `--print-timeout` does not bound the internal auth wait). Mirrors `judgeSpawn`/`codexJudgeSpawn`'s
        // own SIGKILL-then-settle discipline: the kill RESOLVES rather than rejects, since a killed run's
        // partial JSONL is still line-parseable.
        timer = setTimeout(() => {
          killed = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          grace = setTimeout(() => settle({ stdout: out, stderr: err, code: null, timedOut: true }), JUDGE_TIMEOUT_GRACE_MS);
          if (typeof grace.unref === 'function') grace.unref();
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        reject(new Error(`antigravity-judge-spawn: \`${cli}\` failed to run: ${e.message}`));
      });
      child.on('close', (c) => settle({ stdout: out, stderr: err, code: c, timedOut: killed }));
      // The prompt rides stdin as ONE stream-json event, and `.end()` CLOSES the stream — the same property
      // that keeps `judgeSpawn`/`codexJudgeSpawn` safe from a "prompt as argv + open stdin" deadlock (a class
      // #3633 probe 5 found `agy` does NOT actually have, but this module never relies on that being true).
      child.stdin?.on('error', () => { /* the child may exit before we finish writing; `close` reports it */ });
      child.stdin?.end(streamInput);
    });
  } catch (error) {
    const evidence = agyRunEvidence({ requestedModel: model });
    error.telemetry = evidence;
    recordScorecard({ ...evidence, model: 'unknown', provider: 'antigravity', dispatchKind: role, kind: 'review', role });
    throw error;
  } finally {
    try { removeFile(workDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }

  const wallMs = Date.now() - startedAt;

  // THE FIX — persist the raw stream-json JSONL BEFORE any parse can throw, keyed by the session id this run
  // reports (a random fallback id when even that is missing), so the transcript survives regardless of
  // whether the run went on to succeed, hit the silent-tool-denial failure, a `status: "ERROR"`, or the
  // timeout wall. Best-effort: `persistTranscript` never throws (see its own header), so a disk-write failure
  // here can never turn a completed judge call into a failed one.
  const judgeSessionId = extractAntigravityJudgeSessionId(result.stdout);
  const transcriptFile = persistTranscript({ stdout: result.stdout, sessionId: judgeSessionId, dir: transcriptDir });
  // #3383 mechanical-dispatcher Gap 1 fix — score + record THIS run's own scorecard, off the persisted
  // transcript FILE this function already just wrote (see `run-quality-record.mjs`'s own header for why this
  // seat scores a file path rather than raw stdout, unlike its Codex sibling). Placed BEFORE the timeout/parse
  // branches below (which may go on to THROW, e.g. `AntigravityToolDeniedError`) so a hung, denied, or
  // unparseable run is recorded too — exactly the run most worth capturing. Best-effort, never throws
  // (`recordAntigravityRunScorecard`'s own header) — a recording failure can never turn an otherwise-completed
  // judge call into a failed one.
  const evidence = agyRunEvidence({ ...result, requestedModel: model });
  let holdError;
  try { saveHold(evidence); } catch (error) { holdError = error; }
  recordScorecard({
    ...evidence,
    transcriptFile, dispatchKind: role, kind: 'review', role,
    provider: 'antigravity', model: evidence.servedModel, effort,
  });

  try {
    if (holdError) throw holdError;
    if (evidence.fallbackDecision !== 'none') throw agyEvidenceError(evidence);
    if (result.timedOut) {
      let outcome = null;
      try { outcome = parseAntigravityJudgeOutcome({ stdout: result.stdout, stderr: result.stderr }); } catch { outcome = null; }
      if (!outcome) throw new JudgeTimeoutError({ timeoutMs, wallMs, stdout: result.stdout, stderr: result.stderr });
      return {
        ...outcome, ...evidence, durationMs: wallMs, wallMs, timedOut: true,
        loadedContextTokens: antigravityLoadedContextTokens(outcome.usage), argv, transcriptFile,
      };
    }
    const outcome = parseAntigravityJudgeOutcome({
      stdout: result.stdout,
      stderr: result.stderr || (result.code === 0 ? '' : `exit code ${result.code}`),
    });
    return {
      ...outcome, ...evidence, durationMs: wallMs, wallMs, timedOut: false,
      loadedContextTokens: antigravityLoadedContextTokens(outcome.usage), argv, transcriptFile,
    };
  } catch (error) {
    error.telemetry = { ...evidence, transcriptFile, wallMs };
    throw error;
  }
}
