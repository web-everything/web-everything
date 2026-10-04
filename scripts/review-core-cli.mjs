#!/usr/bin/env node
/**
 * review-core-cli.mjs — a thin impure CLI over the PURE review-verdict core in
 * `we:scripts/lib/review-core.mjs` (#2435, slice of epic #2418).
 *
 * NOTE ON THE NAME: this file is deliberately NOT named `review-core.mjs`. That basename belongs to the
 * policy-tier trust-chain member `we:scripts/lib/review-core.mjs` (see `scripts/lib/gate-config.mjs`
 * TRUST_CHAIN, which matches by BASENAME, not path). A CLI wrapper over pure fns is engine-tier, not
 * policy-tier, so it must keep a distinct basename — otherwise pr-land mis-stamps `review:human` (gate-self)
 * on it. The `-cli` suffix keeps it engine-tier and matches the backlog slug `2435-review-core-cli`.
 *
 * WHY: the drain's review loop (`we:skills-src/drain/SKILL.md`) reduced a review round the same handful of
 * ways over and over — normalize findings → verdict, reduce a panel's per-lens verdicts to one, derive the
 * next negotiation/plan step, derive the escalation disposition, render the per-lens verdict table — each done
 * as a throwaway inline `node -e` that re-imports the lib and re-hand-rolls the glue. Five of them. That glue
 * was untested (you can't unit-test a `node -e` string) and drifted per caller. This CLI is the ONE place that
 * glue lives: a `reduce` subcommand that combines those pure fns into one machine object, and a `mandate`
 * subcommand that emits the reviewer/editor/validator mandate text. The CLI does I/O (read stdin/--file, print);
 * the REDUCTION itself is the pure `reduceReview` / `buildMandateText` layer below, unit-tested without spawning.
 *
 * This module NEVER re-implements any derivation — it only imports from `./lib/review-core.mjs`. The judgment
 * (spawning a subagent, reading a diff, deciding `conflict`/`humanRequired`) stays with the caller, exactly as
 * the lib documents; this is the mechanical half.
 *
 * SCOPE (#2435): `reduce` + `mandate`. #2432 adds the `comment` subcommand — the full PR-comment body rendered
 * from a panel's structured result via `renderPanelComment` (`we:scripts/lib/review-render.mjs`, a SEPARATE
 * engine-tier module so the pure renderer stays off the policy-tier `review-core.mjs` and agent-clearable). The
 * dispatch below stays easy to extend.
 *
 * Usage:
 *   node scripts/review-core-cli.mjs reduce --file=findings.json          # human: verdict/disposition/outcome + table
 *   cat round.json | node scripts/review-core-cli.mjs reduce --json       # machine object on stdout
 *   node scripts/review-core-cli.mjs reduce --file=r.json --round=2        # also derive the negotiation outcome
 *   node scripts/review-core-cli.mjs reduce --file=r.json --round=2 --phase=plan   # ...the plan-handshake outcome
 *   node scripts/review-core-cli.mjs mandate --lens=correctness           # a panel reviewer mandate for one lens
 *   node scripts/review-core-cli.mjs mandate --validator --lens=security  # the independent-validator mandate
 *   cat findings.json | node scripts/review-core-cli.mjs mandate --editor --round=2   # the editor-round mandate
 *   cat result.json | node scripts/review-core-cli.mjs comment            # the full PR-comment markdown body
 *   node scripts/review-core-cli.mjs comment --file=result.json --json     # { markdown } on stdout
 *   node scripts/review-core-cli.mjs rigor --reasons='blast-radius (x),size (500 …)'  # care-level + panel rigor (#2567)
 *   cat invite.json | node scripts/review-core-cli.mjs invite --json       # juror-invite-on-discovery delta (#2640)
 *   gh pr view 1580 --json files --jq '[.files[].path]' \
 *     | node scripts/review-core-cli.mjs shape --json                      # the shape a TOUCH-SET earns (#3335)
 *   node scripts/review-core-cli.mjs shape --files=docs/agent/platform-decisions.md
 *
 * `shape` input (#3335) is the PR's changed-file list: `--files=a,b,c`, or a JSON array / `{changedFiles}` /
 * `{files}` on --file/stdin — so `gh pr view --json files --jq '[.files[].path]'` pipes straight in.
 *
 * `reduce` input (JSON, from --file or stdin) is the option bag `reduceReview` consumes — any subset of:
 *   { findings, humanRequired, lensVerdicts, mandatoryLenses, conflict, reason, reasons, round, roundCap, phase }
 * Flags `--round` / `--roundCap` / `--phase` / `--reason` / `--reasons` (comma-sep) override the JSON's fields.
 *
 * `comment` input (JSON, from --file or stdin) is `{ findings, verdict, disposition }` (plus optional
 * `lensVerdicts` / `mandatoryLenses` / `lenses` / `heading` for the embedded verdict table). When `verdict` or
 * `disposition` is absent it is DERIVED from the findings (`deriveVerdict` / `deriveDispositionLenient` when a
 * `reason`/`reasons` set is supplied — retired/unknown tokens dropped, never thrown, #2632) — matching how
 * `reduce` reads its input. Flags `--reason` / `--reasons`
 * (comma-sep) override the JSON's fields, same as `reduce`.
 * #2447 — `comment` also renders the graduatedTo RESOLUTION BASIS banner up front: pass a pre-derived
 * `resolutionBasis`, or the raw carriers `deriveResolutionBasis` reads — `changedFiles` plus any of `graduatedTo` /
 * `manifest` / `diff` / `body` (and `crossRepo`). `--graduated-to=<value>` overrides the JSON's `graduatedTo`. The
 * banner fires only for a backlog-only diff, so a normal code resolve renders exactly as before.
 *
 * Exit codes: 0 = ok; 2 = usage error (unknown subcommand / bad flags / no input); 1 = a derivation threw
 * (e.g. a missing mandatory-lens verdict) — the message is printed as `{error}`. NOTE (#2632): a RETIRED or
 * otherwise unrecognized escalation reason no longer throws — the disposition guard drops it and keeps the
 * disposition from the recognized reasons (or omits it entirely when none is recognized).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  normalizeFindings,
  deriveVerdict,
  deriveReviewDisposition,
  derivePanelVerdict,
  renderPanelVerdictTable,
  deriveNegotiationOutcome,
  derivePlanOutcome,
  buildPanelMandate,
  buildEditorMandate,
  buildValidatorMandate,
  careLevelFromReasons,
  panelRigorFromReasons,
  editorPolicyFromReasons,
  deriveJurorInvite,
  // #3335 — read to say whether `review-pr --lens=` can actually SEAT the lens #3309's router picked. Its
  // `input.lens` enum is `[...PANEL_LENSES]`, and the decision-prose lens set is not in it.
  PANEL_LENSES,
} from './lib/review-core.mjs';
import { renderPanelComment, deriveResolutionBasis } from './lib/review-render.mjs';
// #3335 — the two pure derivations the `shape` subcommand COMPOSES and never restates. `scoreEscalation` turns a
// file list into `{reasons, signals, humanRequired, careLevel}`; `routeReviewShape` (#3309) turns that same list
// plus the care level into the lens VOCABULARY and the `panelRigorForCareLevel` dial. Neither is re-implemented
// here — see `buildShapePlan`'s docblock for the scope carve between #3309 and this item.
import { CARE_LEVELS, scoreEscalation } from './lib/review-escalation.mjs';
import { routeReviewShape } from './lib/decision-routing.mjs';
import { reviewNeedFor } from './lib/review-need.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';

// ── tiny flags parser (matches push-if-green.mjs) ─────────────────────────────────────────────────────
/**
 * Parse `--k=v` / bare `--flag` argv into a plain object. Pure. Non-flag positionals are ignored (the
 * subcommand is `argv[0]`, dispatched separately). `--flag` with no `=` is `true`.
 * @param {string[]} argv
 * @returns {Object<string, string|true>}
 */
export function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

// ── lenient disposition guard (the retired/unknown-reason fix, #2632) ─────────────────────────────────
/**
 * Derive the review disposition, but DROP any reason token the core cannot canonicalize — keeping the
 * disposition from the reasons it DOES recognize (#2632). `deriveReviewDisposition` is all-or-nothing: it
 * throws `unknown reason(s)` on ANY unrecognized token. So a legacy PR whose `## Escalation reason` block still
 * lists a RETIRED reason (`sampling floor (1-in-10)`, removed with the review-sampling floor in #2631) — or any
 * future free-text reason a new escalation source stamps — would throw `unknown reason` straight through the
 * review workflow, nulling a whole disposition that its OTHER, recognized reasons could still have produced.
 *
 * This guards BOTH call sites (`reduceReview`, `buildComment`) the SAME lenient way `careLevelFromReasons`
 * already tolerates unknowns: an unrecognized reason contributes NOTHING rather than crashing. It partitions
 * known from unknown WITHOUT re-implementing `canonicalizeReason` (exported from review-core.mjs since #xonzpym,
 * but only so the conformance suite can drive it over an injected vocabulary — production code, this CLI
 * included, never passes it one. The conformance suite sweeps every tree in the repo for such a call, resolving
 * the imported binding and matching across line breaks; the exact bounds of that sweep, including what it does
 * NOT reach, are stated on the test itself in `we:scripts/lib/__tests__/review-policy.conformance.test.mjs`):
 * a reason is "known" iff `deriveReviewDisposition({ reason })` does not throw for it alone. The strictest-wins
 * precedence is preserved by the final combined call over just the recognized reasons.
 *
 * Returns `undefined` when NO reason is recognized (or none supplied) — the caller then behaves exactly as it
 * does for the reasons-absent case (no disposition line), rather than surfacing a partial/garbage one.
 * @param {{reason?: string, reasons?: string[]}} [o]
 * @returns {{mode: string, autoLand: boolean}|undefined}
 */
export function deriveDispositionLenient({ reason, reasons } = {}) {
  const raw = (Array.isArray(reasons) ? reasons : reason != null ? [reason] : []).filter(Boolean);
  const known = raw.filter((r) => {
    try {
      deriveReviewDisposition({ reason: r });
      return true;
    } catch {
      return false;
    }
  });
  if (!known.length) return undefined;
  return deriveReviewDisposition({ reasons: known });
}

// ── PURE reduction layer (the testable core the 5× inline node -e calls collapse into) ────────────────
/**
 * Reduce one review round's raw inputs into the derived contract, combining the pure fns from
 * `./lib/review-core.mjs` in the ONE order the drain loop needs. Pure — no I/O, no spawning. Each derived
 * field is computed only when the input supports it, so a partial input (just findings, or just a reason set)
 * yields a partial result rather than throwing.
 *
 *   - `findings`/`findingsCount` — always: the normalized findings list (empty when none supplied).
 *   - `verdict` — `derivePanelVerdict` when per-lens `lensVerdicts` are supplied (the v3 panel reduction),
 *     else `deriveVerdict` over the findings (+ `humanRequired`, which always wins).
 *   - `verdictTable` — the per-lens markdown table, only when `lensVerdicts` are supplied.
 *   - `disposition` — `deriveDispositionLenient` (the #2632 guard over `deriveReviewDisposition`) when a
 *     `reason`/`reasons` escalation set is supplied — retired/unknown tokens are dropped, never thrown; omitted
 *     entirely when none is recognized.
 *   - `careLevel` / `rigor` — the advisory care-level and the panel rigor it dials (#2567), also only when a
 *     `reason`/`reasons` set is supplied (same trigger as `disposition`).
 *   - `outcome` — the next negotiation step (`deriveNegotiationOutcome`) or, when `phase: 'plan'`, the
 *     plan-handshake step (`derivePlanOutcome`), only when a `round` is supplied — derived from `verdict`. When
 *     `requiredTestGreen` is supplied (#2410 slice D) it folds the CI-green land clause into that step — an
 *     `accept` over a not-green required `test` yields `continue`/`escalate`, never `land`.
 *
 * @param {{findings?: Array<object>, humanRequired?: boolean, lensVerdicts?: Object<string,string>,
 *   mandatoryLenses?: string[], conflict?: boolean, reason?: string, reasons?: string[],
 *   round?: number, roundCap?: number, requiredTestGreen?: boolean, phase?: 'negotiation'|'plan'}} [input]
 * @returns {{findings: object[], findingsCount: number, verdict: string, verdictTable?: string,
 *   disposition?: {mode: string, autoLand: boolean}, outcome?: string}}
 */
export function reduceReview(input = {}) {
  const {
    findings,
    humanRequired = false,
    lensVerdicts,
    mandatoryLenses,
    conflict = false,
    reason,
    reasons,
    round,
    roundCap,
    requiredTestGreen,
    phase = 'negotiation',
  } = input || {};

  const normalized = normalizeFindings(findings);
  /** @type {any} */
  const out = { findings: normalized, findingsCount: normalized.length };

  const hasPanel = lensVerdicts && typeof lensVerdicts === 'object';
  if (hasPanel) {
    // #2823 round-2 finding 4 — pass the whole panel's `findings` so the prevention gate is derived from findings
    // (immune to per-lens verdict flattening), not just the per-lens verdicts.
    out.verdict = derivePanelVerdict({ lensVerdicts, humanRequired, conflict, mandatoryLenses, findings: normalized });
    out.verdictTable = renderPanelVerdictTable({ lensVerdicts, mandatoryLenses });
  } else {
    out.verdict = deriveVerdict({ findings: normalized, humanRequired });
  }

  const hasReasons = reason != null || (Array.isArray(reasons) && reasons.length > 0);
  if (hasReasons) {
    // Lenient (#2632): drop any retired/unknown reason token, keep the disposition from the recognized ones.
    // Omit the key entirely when none is recognized — matching the reasons-absent case, never a null disposition.
    const disposition = deriveDispositionLenient({ reason, reasons });
    if (disposition) out.disposition = disposition;
    // #2567 — the advisory care-level + the panel rigor it dials, from the SAME reason set (lenient: never throws).
    const reasonList = Array.isArray(reasons) ? reasons : (reason != null ? [reason] : []);
    out.careLevel = careLevelFromReasons(reasonList);
    out.rigor = panelRigorFromReasons(reasonList);
  }

  if (round != null) {
    const args = { verdict: out.verdict, round: Number(round), roundCap };
    // #2410 slice D — fold the CI-green land clause through: when the caller supplies `requiredTestGreen`, pass it
    // to `deriveNegotiationOutcome` so an `accept` over a red/pending required `test` does NOT land (it re-enters
    // the loop). Omitting it keeps the pre-#2410 land-on-accept behaviour (the reducer defaults it to green). The
    // plan handshake has no diff yet, so it never carries a CI clause.
    if (phase !== 'plan' && requiredTestGreen !== undefined) args.requiredTestGreen = requiredTestGreen;
    out.outcome = phase === 'plan' ? derivePlanOutcome(args) : deriveNegotiationOutcome(args);
  }

  return out;
}

/**
 * Build the mandate text for one review role, dispatching on `kind` (the pure half of the `mandate`
 * subcommand). Pure — the lib builders it calls are pure; this only routes to the right one. `lens` mandates
 * seed a panel reviewer or the independent validator; `editor` seeds the negotiation-round editor.
 * @param {{kind: 'lens'|'editor'|'validator', lens?: string, findings?: Array<object>, round?: number,
 *   roundCap?: number, diffBasis?: string}} o
 * @returns {string}
 */
export function buildMandateText({ kind, lens, findings, round, roundCap, diffBasis } = {}) {
  switch (kind) {
    case 'lens':
      // #2914 — forwarded ONLY on the `lens` branch: the `editor`/`validator` mandate kinds have no diff-basis
      // concept (the independent validator never sees peer context at all; the editor mandate is round-scoped
      // findings prose, not a diff-provenance signal).
      return buildPanelMandate({ lens, diffBasis });
    case 'validator':
      return buildValidatorMandate({ lens });
    case 'editor':
      // `fenced: true` (#2967) — `findings` is juror prose read from `--file`/stdin, and the editor it seeds has
      // WRITE TOOLS on a live tree, so the finding list travels inside the #2438 labelled data fence (the same
      // call `we:scripts/lib/converge-transports.mjs:206` already makes). Established: the text reached the
      // mandate unfenced. NOT established: that it could steer the editor — nobody has measured that.
      return buildEditorMandate({ findings, round: round != null ? Number(round) : undefined, roundCap, fenced: true });
    default:
      throw new Error(`buildMandateText: unknown mandate kind "${kind}" — must be one of lens, editor, validator`);
  }
}

/**
 * Build the full PR-comment markdown from a panel's structured result (the pure half of the `comment`
 * subcommand, #2432). Pure — no I/O, no dates. `verdict` and `disposition` are used as supplied; when either is
 * absent it is DERIVED from the same core fns `reduceReview` uses (so a raw findings dump renders a complete
 * comment): `verdict` from `deriveVerdict({findings, humanRequired})`, and `disposition` from
 * `deriveDispositionLenient` (the #2632 guard over `deriveReviewDisposition`) ONLY when a `reason`/`reasons`
 * escalation set is supplied — retired/unknown tokens are dropped, never thrown. The disposition line is omitted
 * when no reason is supplied OR none is recognized. Delegates the markdown to the pure
 * `renderPanelComment` (`./lib/review-render.mjs`).
 * @param {{findings?: Array<object>, verdict?: string, disposition?: object|string, humanRequired?: boolean,
 *   reason?: string, reasons?: string[], lensVerdicts?: Object<string,string>, mandatoryLenses?: string[],
 *   lenses?: string[], heading?: string, resolutionBasis?: object|null, graduatedTo?: string,
 *   changedFiles?: string[], manifest?: object, diff?: string, body?: string, crossRepo?: boolean}} [input]
 * @returns {string} the markdown PR-comment body.
 */
export function buildComment(input = {}) {
  const {
    findings,
    verdict,
    disposition,
    humanRequired = false,
    reason,
    reasons,
    lensVerdicts,
    mandatoryLenses,
    lenses,
    heading,
    resolutionBasis,
    graduatedTo,
    changedFiles,
    manifest,
    diff,
    body,
    crossRepo,
  } = input || {};

  const normalized = normalizeFindings(findings);
  const resolvedVerdict = verdict != null && verdict !== ''
    ? verdict
    : deriveVerdict({ findings: normalized, humanRequired });

  let resolvedDisposition = disposition;
  if (resolvedDisposition == null) {
    const hasReasons = reason != null || (Array.isArray(reasons) && reasons.length > 0);
    // Lenient (#2632): a retired/unknown reason token is dropped, not thrown — the disposition line falls off only
    // when NO reason is recognized (`deriveDispositionLenient` returns undefined), same as supplying no reasons.
    if (hasReasons) resolvedDisposition = deriveDispositionLenient({ reason, reasons });
  }

  return renderPanelComment({
    findings: normalized,
    verdict: resolvedVerdict,
    disposition: resolvedDisposition,
    lensVerdicts,
    mandatoryLenses,
    lenses,
    heading,
    // #2447 — a supplied basis wins; otherwise derive it from whichever raw carriers the caller passed.
    resolutionBasis: resolutionBasis !== undefined
      ? resolutionBasis
      : deriveResolutionBasis({ graduatedTo, changedFiles, manifest, diffText: diff, body, crossRepo }),
  });
}

// ── thin impure CLI ───────────────────────────────────────────────────────────────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) main(process.argv.slice(2));

/** Read the JSON input for a subcommand — from `--file=<path>` or, absent that, piped stdin. Returns `null`
 *  when neither is present (a TTY with no pipe is treated as "no input", never a hang). */
function readJsonInput(flags) {
  if (typeof flags.file === 'string') return JSON.parse(readFileSync(flags.file, 'utf8'));
  if (!process.stdin.isTTY) {
    const raw = readFileSync(0, 'utf8').trim();
    if (raw) return JSON.parse(raw);
  }
  return null;
}

function fail(msg, code) {
  writeAllSync(1, `${JSON.stringify({ error: msg })}\n`);
  process.exit(code);
}

function main(argv) {
  const subcommand = argv[0];
  const flags = parseFlags(argv.slice(1));
  const asJson = !!flags.json;

  if (subcommand === 'reduce') return runReduce(flags, asJson);
  if (subcommand === 'mandate') return runMandate(flags, asJson);
  if (subcommand === 'comment') return runComment(flags, asJson);
  if (subcommand === 'rigor') return runRigor(flags, asJson);
  if (subcommand === 'invite') return runInvite(flags, asJson);
  if (subcommand === 'shape') return runShape(flags, asJson);
  return fail(
    'usage: review-core-cli.mjs <reduce|mandate|comment|rigor|invite|shape> [flags] — see the header for options',
    2,
  );
}

function runReduce(flags, asJson) {
  let json;
  try {
    json = readJsonInput(flags);
  } catch (e) {
    return fail(`could not read/parse findings JSON: ${String(e && e.message || e)}`, 2);
  }
  if (json == null) return fail('reduce: no input — pass --file=<path> or pipe JSON on stdin', 2);

  // Flag overrides on top of the JSON option bag (round/phase/reasons are often ergonomic to pass as flags).
  const input = { ...json };
  if (flags.round != null) input.round = Number(flags.round);
  if (flags.roundCap != null) input.roundCap = Number(flags.roundCap);
  // #2410 slice D — the CI-green clause as a flag: `--required-test-green` (green) / `--required-test-green=false`
  // (red/pending → an accept won't land). Ergonomic override on top of the JSON option bag, same as round/roundCap.
  if (flags['required-test-green'] != null) input.requiredTestGreen = flags['required-test-green'] !== 'false';
  if (typeof flags.phase === 'string') input.phase = flags.phase;
  if (typeof flags.reason === 'string') input.reason = flags.reason;
  if (typeof flags.reasons === 'string') input.reasons = flags.reasons.split(',').map((s) => s.trim()).filter(Boolean);

  let result;
  try {
    result = reduceReview(input);
  } catch (e) {
    return fail(String(e && e.message || e), 1);
  }

  if (asJson) {
    writeAllSync(1, `${JSON.stringify(result)}\n`);
    return process.exit(0);
  }

  const summary = [`verdict: ${result.verdict}`];
  if (result.disposition) summary.push(`disposition: ${result.disposition.mode} (autoLand=${result.disposition.autoLand})`);
  if (result.outcome) summary.push(`outcome: ${result.outcome}`);
  summary.push(`findings: ${result.findingsCount}`);
  const lines = [summary.join('   ')];
  if (result.verdictTable) lines.push('', result.verdictTable);
  writeAllSync(1, `${lines.join('\n')}\n`);
  return process.exit(0);
}

function runComment(flags, asJson) {
  let json;
  try {
    json = readJsonInput(flags);
  } catch (e) {
    return fail(`could not read/parse result JSON: ${String(e && e.message || e)}`, 2);
  }
  if (json == null) return fail('comment: no input — pass --file=<path> or pipe JSON on stdin', 2);

  // Flag overrides on top of the JSON option bag (reason/reasons mirror `reduce`, for the derived disposition).
  const input = { ...json };
  if (typeof flags.reason === 'string') input.reason = flags.reason;
  if (typeof flags.reasons === 'string') input.reasons = flags.reasons.split(',').map((s) => s.trim()).filter(Boolean);
  if (typeof flags.heading === 'string') input.heading = flags.heading;
  if (typeof flags['graduated-to'] === 'string') input.graduatedTo = flags['graduated-to'];

  let markdown;
  try {
    markdown = buildComment(input);
  } catch (e) {
    return fail(String(e && e.message || e), 1);
  }

  if (asJson) {
    writeAllSync(1, `${JSON.stringify({ markdown })}\n`);
    return process.exit(0);
  }
  writeAllSync(1, `${markdown}\n`);
  return process.exit(0);
}

/**
 * #2567 — the `rigor` subcommand: given the escalation reasons, print the advisory care-level and the panel rigor
 * it dials (rounds / lenses / jurorsPerLens / aggregation). The review-parked-prs workflow (and the future
 * scheduled runner) call this BEFORE fanning out the panel — they hold the parked PR's reasons but no findings
 * yet, so they cannot use `reduce`. Reasons come from `--reasons` (comma-separated) or `--reason`, or a JSON
 * `{reasons}` / `{reason}` on --file/stdin. Never throws on an unknown reason (the dial is lenient/advisory).
 *
 * #2908 — ALSO prints `editor: { careLevel, resolved, editorEnabled, rounds, reason }`, the convergence loop's
 * EDITOR gate on its own knob (`editorPolicyFromReasons`). Two separate `rounds` on purpose: `rigor.rounds` is
 * the SHARED panel dial every consumer reads and is untouched by #2908; `editor.rounds` is only the parked-PR
 * loop's round cap, floored at `EDITOR_MIN_ROUNDS` when — and only when — the editor may push at that band. An
 * EMPTY reason list resolves the editor gate to `resolved: false, editorEnabled: false` (fail closed).
 */
function runRigor(flags, asJson) {
  let reasons = [];
  if (typeof flags.reasons === 'string') reasons = flags.reasons.split(',').map((s) => s.trim()).filter(Boolean);
  else if (typeof flags.reason === 'string') reasons = [flags.reason];
  else {
    let json = null;
    try { json = readJsonInput(flags); } catch { json = null; }
    if (json && Array.isArray(json.reasons)) reasons = json.reasons;
    else if (json && typeof json.reason === 'string') reasons = [json.reason];
    else if (Array.isArray(json)) reasons = json;
  }

  const careLevel = careLevelFromReasons(reasons);
  const rigor = panelRigorFromReasons(reasons);
  // #2908 — the EDITOR gate, on its own knob. `rigor.rounds` is the SHARED panel dial (`/jury`, `/review`,
  // `/converge` all read it) and stays exactly as it was; `editor.rounds` is the convergence loop's own cap,
  // which is the shared value floored at `EDITOR_MIN_ROUNDS` only for a band where the editor may push. Printed
  // from the SAME resolved band as `careLevel` above, never re-derived by the caller.
  const editor = editorPolicyFromReasons(reasons);

  if (asJson) {
    writeAllSync(1, `${JSON.stringify({ careLevel, rigor, editor })}\n`);
    return process.exit(0);
  }
  writeAllSync(1,
    `care-level: ${careLevel}   rounds: ${rigor.rounds}   jurorsPerLens: ${rigor.jurorsPerLens}   `
    + `lenses: ${rigor.lenses.join(', ') || '(none)'}   aggregation: ${rigor.aggregation}\n`
    + `editor: ${editor.editorEnabled ? 'ENABLED' : 'review-only'} (${editor.reason})   `
    + `editor-rounds: ${editor.rounds}\n`,
  );
  return process.exit(0);
}

/**
 * #3335 — THE SHAPE A TOUCH-SET EARNS. PURE. The derivation a review CALLER runs BEFORE it composes the run
 * command, because the caller is the only actor that holds the touch-set at that moment: `review-pr`'s `read` is
 * step 1 and is what computes `netChangedFiles`, and `--resume` refuses input flags on purpose, so the shape
 * cannot be revised once the run has started.
 *
 * IT COMPOSES; IT DOES NOT RE-TAXONOMIZE. Two calls, no third opinion:
 *   • `scoreEscalation({changedFiles})` (`we:scripts/lib/review-escalation.mjs`) → `reasons` / `humanRequired`;
 *   • `routeReviewShape({changedFiles, escalation})` (`we:scripts/lib/decision-routing.mjs`) → the care level,
 *     `panelRigorForCareLevel`'s `rounds` / `jurorsPerLens`, the lens set and the mandatory floor.
 * The care level this returns is `scoreEscalation`'s own, so it agrees with `rigor --reasons=<these reasons>` by
 * construction rather than by coincidence — `careLevelFromReasons` is the reasons→care bridge for a consumer
 * that holds only the decorated strings, and both roads end at `deriveCareLevel`. A named test drives both.
 *
 * WHAT IS #3309's AND NOT THIS ITEM'S. `routeReviewShape` / `classifyReviewSubject` decide WHICH SUBJECT is under
 * review (code vs prose) and therefore which lens VOCABULARY the seats draw from; they deliberately do not dial
 * rigor. That axis is REUSED here, not re-derived — `subject`, `earnedLenses` and `mandatoryFloor` are its output
 * passed through. This item owns the caller-side half: reaching that derivation from a file list, declaring the
 * result to the operation, and letting `read` refuse a declaration the PR contradicts.
 *
 * `--lens` SUBSTITUTES, IT DOES NOT ADD, which is why `seatLens` is reported separately from `earnedLenses`.
 * `review-pr` has exactly ONE caller-chosen seat (`judge`); `--lens` replaces what that seat judges under, and
 * pointing it at an advisory lens DISPLACES the mandatory `correctness` seat rather than adding a check. So the
 * honest reading for a one-seat operation is TWO BANDS, not four:
 *   • `careLevel === 'none'` — the dial asks for no panel at all, so the floor lens is proportionate.
 *   • anything escalated — one seat cannot deliver what the dial asks, so the seat goes to a MANDATORY lens
 *     (`seatLens`) and the SHORTFALL (`earnedLenses` minus what actually sat) is recorded rather than implied away.
 *
 * @param {{changedFiles?: string[], careLevel?: string}} o - `changedFiles` is the PR's touch-set, from
 *   `gh pr view <pr> --json files --jq '[.files[].path]'`; `careLevel` overrides the derived band and is ignored
 *   unless it names a real one (`routeReviewShape`'s own rule).
 * @returns {{careLevel: string, reasons: string[], humanRequired: boolean, earnedLenses: string[],
 *   mandatoryFloor: string[], subject: string, rounds: number, jurorsPerLens: number, seatLens: string,
 *   escalated: boolean, changedFiles: string[], trail: string[]}}
 */
export function buildShapePlan({ changedFiles = [], careLevel, commits = null } = {}) {
  const files = (Array.isArray(changedFiles) ? changedFiles : [])
    .filter((f) => typeof f === 'string' && f.trim().length > 0)
    .map((f) => f.trim());
  const escalation = scoreEscalation({ changedFiles: files });
  // The score is handed ACROSS so the router does not pay for a second `scoreEscalation` over the same list —
  // and, more importantly, so the reasons printed below and the subject routed here are provably one score.
  const plan = routeReviewShape({ changedFiles: files, escalation, careLevel });
  return {
    careLevel: plan.careLevel,
    reasons: [...escalation.reasons],
    humanRequired: escalation.humanRequired === true,
    earnedLenses: [...plan.lenses],
    mandatoryFloor: [...plan.mandatoryLenses],
    subject: plan.subject,
    rounds: plan.rounds,
    jurorsPerLens: plan.jurorsPerLens,
    seatLens: plan.seatLens,
    // STATED, NOT ASSUMED: `review-pr`'s `input.lens` enum is `[...PANEL_LENSES]`, and #3309's decision-prose
    // lens set (`root-cause` / `completeness`) is not in it. So on the prose route the seat lens this reports is
    // the RIGHT one and is not reachable from the command line today — wiring that vocabulary into the operation
    // is #3309's follow-on, not this item, and a caller must be told rather than handed a flag that is refused.
    seatLensReachable: PANEL_LENSES.includes(plan.seatLens),
    escalated: plan.careLevel !== CARE_LEVELS.NONE,
    changedFiles: files,
    trail: [...plan.trail],
    need: reviewNeedFor({ changedFiles, careLevel, commits }),
  };
}

/**
 * #3335 — the `shape` subcommand: given a PR's changed-file list, print the shape its TOUCH-SET earns. The
 * caller runs this BEFORE it composes `run.mjs review-pr …` and passes the derived `careLevel` back to the
 * operation as `--careLevel=`, where `read` re-scores the NET file list and refuses a declaration the PR
 * contradicts. Input is `--files=a,b,c`, or a JSON array / `{changedFiles}` / `{files}` on --file/stdin, so
 * `gh pr view <pr> --json files --jq '[.files[].path]'` pipes in unmodified.
 * Optional `--commits-file` reads a JSON array or `gh pr view --json commits` output for author routing.
 */
function runShape(flags, asJson) {
  let files = [];
  if (typeof flags.files === 'string') files = flags.files.split(',').map((s) => s.trim()).filter(Boolean);
  else {
    let json = null;
    try { json = readJsonInput(flags); } catch { json = null; }
    if (Array.isArray(json)) files = json;
    else if (json && Array.isArray(json.changedFiles)) files = json.changedFiles;
    else if (json && Array.isArray(json.files)) {
      // `gh pr view --json files` UNJQ'd: `{files:[{path,…}]}`. Accepted so a caller that forgot the `--jq` gets
      // the right answer rather than an empty touch-set — which would silently read as care `none`.
      files = json.files.map((f) => (typeof f === 'string' ? f : f && f.path));
    }
  }
  // The refusal tests for at least one READABLE path, but the list handed on stays unfiltered: an entry that
  // yielded no path is kept as-is so `buildShapePlan` sees the touch-set was partly unreadable (fail-closed `need`),
  // while a list with NO readable entry (`{files:[{}]}`, `[null]`, `['']`) is still refused rather than scored `none`.
  if (!files.some((f) => typeof f === 'string' && f.trim().length > 0)) {
    return fail(
      'shape: no changed files — pass --files=a,b,c, or pipe `gh pr view <pr> --json files --jq \'[.files[].path]\'` '
      + 'on stdin. An EMPTY touch-set is refused rather than scored, because it scores `none` (no panel at all) and '
      + 'a failed read would then buy the cheapest review there is.',
      2,
    );
  }

  let commits = null;
  if (typeof flags['commits-file'] === 'string') {
    try {
      // fd 0 rather than the `/dev/stdin` path: on Linux a piped stdin is a socket, and opening it by path fails (ENXIO).
      const source = flags['commits-file'] === '/dev/stdin' ? 0 : flags['commits-file'];
      const input = JSON.parse(readFileSync(source, 'utf8'));
      commits = Array.isArray(input) ? input : input?.commits;
    } catch { commits = null; }
  }
  let plan;
  try {
    plan = buildShapePlan({ changedFiles: files, commits, careLevel: typeof flags.careLevel === 'string' ? flags.careLevel : undefined });
  } catch (e) {
    return fail(String(e && e.message || e), 1);
  }

  if (asJson) {
    writeAllSync(1, `${JSON.stringify(plan)}\n`);
    return process.exit(0);
  }
  writeAllSync(1,
    `care-level: ${plan.careLevel}   humanRequired: ${plan.humanRequired}   subject: ${plan.subject}\n`
    + `earned: ${plan.earnedLenses.length} lens(es) (${plan.earnedLenses.join(', ') || '(none)'}) `
    + `× ${plan.jurorsPerLens} juror(s)/lens × ${plan.rounds} round(s)\n`
    + `tier: ${plan.need.tier} (${plan.need.tierReasons.join('; ')})  tools: ${Object.entries(plan.need.needsTools).map(([lens, tools]) => `${lens}=${tools}`).join(',')}  cross-provider seat: ${plan.need.crossProvider.required ?? 'none'}\n`
    + `mandatory floor: ${plan.mandatoryFloor.join(', ') || '(none)'}\n`
    + `reasons: ${plan.reasons.join('; ') || '(none)'}\n`
    + (plan.seatLensReachable
      ? `--lens=${plan.seatLens}   --careLevel=${plan.careLevel}\n`
      : `--careLevel=${plan.careLevel}   (seat lens \`${plan.seatLens}\` is NOT reachable from \`review-pr --lens=\`, `
        + `whose enum is [${PANEL_LENSES.join(', ')}] — #3309 routed this to the ${plan.subject} subject and wiring `
        + 'that vocabulary into the operation is not this item.)\n')
    + (plan.escalated
      ? '  ESCALATED — one caller-chosen seat cannot deliver the fan-out above. `--lens` SUBSTITUTES that seat\'s\n'
        + `  lens, it does not add one, so spend it on the mandatory floor (\`${plan.seatLens}\`); whatever the run\n`
        + '  does not seat is a SHORTFALL the verdict must state, not imply away.\n'
      : '  care `none` — the dial asks for no panel at all, so the floor lens is proportionate.\n'),
  );
  return process.exit(0);
}

/**
 * #2640 — the `invite` subcommand: given a mid-review juror's grounded discovery, print the jury-growth DELTA
 * (`deriveJurorInvite` — the care recompute + delta). The review-parked-prs convergence loop (#2639) shells this
 * BEFORE spawning the invited juror so the growth decision (raise care → recompute rigor → spawn only the delta,
 * bounded by the per-care-band ceiling) is single-sourced, never re-derived in the sandbox. Input comes from a
 * JSON `{careLevel, seatedLenses, jurorsPerLens, invitedLens, citedFinding}` on --file/stdin (the injection-safe
 * path — `citedFinding` is untrusted PR text), with `--flag` overrides for ergonomics.
 */
function runInvite(flags, asJson) {
  let json = null;
  try { json = readJsonInput(flags); } catch { json = null; }
  const input = (json && typeof json === 'object' && !Array.isArray(json)) ? { ...json } : {};
  if (typeof flags.careLevel === 'string') input.careLevel = flags.careLevel;
  if (typeof flags.invitedLens === 'string') input.invitedLens = flags.invitedLens;
  if (typeof flags.citedFinding === 'string') input.citedFinding = flags.citedFinding;
  if (flags.jurorsPerLens != null) input.jurorsPerLens = Number(flags.jurorsPerLens);
  if (typeof flags.seatedLenses === 'string') input.seatedLenses = flags.seatedLenses.split(',').map((s) => s.trim()).filter(Boolean);

  let result;
  try {
    result = deriveJurorInvite(input);
  } catch (e) {
    return fail(String(e && e.message || e), 1);
  }

  if (asJson) {
    writeAllSync(1, `${JSON.stringify(result)}\n`);
    return process.exit(0);
  }
  const added = result.addedLenses.map((a) => `${a.lens}+${a.addedJurors}(${a.kind})`).join(', ') || '(none)';
  writeAllSync(1,
    `invite: ${result.accepted ? 'ACCEPTED' : `rejected (${result.reason})`}   `
    + `care: ${result.fromCareLevel} → ${result.toCareLevel}   jurorsPerLens: ${result.jurorsPerLens}   `
    + `delta: ${added}\n`,
  );
  return process.exit(0);
}

function runMandate(flags, asJson) {
  const kind = flags.validator ? 'validator' : flags.editor ? 'editor' : flags.lens ? 'lens' : null;
  if (!kind) {
    return fail('mandate: pass --lens=<lens> (reviewer), --validator --lens=<lens>, or --editor', 2);
  }

  let findings;
  if (kind === 'editor') {
    let json;
    try {
      json = readJsonInput(flags);
    } catch (e) {
      return fail(`could not read/parse findings JSON: ${String(e && e.message || e)}`, 2);
    }
    // The editor mandate reads the reviewer's findings — an array, or an object carrying `{findings}`.
    findings = Array.isArray(json) ? json : (json && Array.isArray(json.findings) ? json.findings : []);
  }

  let text;
  try {
    text = buildMandateText({
      kind,
      lens: typeof flags.lens === 'string' ? flags.lens : undefined,
      findings,
      round: flags.round,
      roundCap: flags.roundCap != null ? Number(flags.roundCap) : undefined,
      diffBasis: typeof flags.diffBasis === 'string' ? flags.diffBasis : undefined,
    });
  } catch (e) {
    return fail(String(e && e.message || e), 1);
  }

  if (asJson) {
    writeAllSync(1, `${JSON.stringify({ kind, lens: typeof flags.lens === 'string' ? flags.lens : null, mandate: text })}\n`);
    return process.exit(0);
  }
  writeAllSync(1, `${text}\n`);
  return process.exit(0);
}
