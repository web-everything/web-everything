#!/usr/bin/env node
/**
 * @file scripts/review-corpus/mine-review-corpus.mjs
 * @description Mine this repo's own recorded review verdicts into replayable fixtures, so a candidate
 * gate or reviewer can be scored against what the real reviews actually found. Same shape as
 * `we:scripts/mine-golden-corpus.mjs` (#2270): git history + recorded history in, deterministic
 * input+expected fixtures out, idempotent on rerun.
 *
 * WHY THIS EXISTS. Every structured `review-pr` verdict comment records `Net basis: <base>..<head>` —
 * the exact revision range that review judged. Those commits are all still reachable, so each historical
 * review is reconstructable EXACTLY: `git diff <base>..<head>` is the input the juror saw, and the
 * findings in that comment are the labels. That turns 92 structured verdicts — 87 DISTINCT revision
 * ranges, since a re-review at an unchanged head repeats a range — into a scored corpus.
 *
 * RETRACTED — this sentence used to read *"That turns 87 recorded verdicts into a scored corpus."* 87 is
 * the number of distinct RANGES, not of verdicts; `cases/index.json` records `cases: 92`, and 62 further
 * verdict comments were skipped as unstructured. Counted 2026-08-26 over `cases/*.json`.
 *
 * READ-ONLY, BY CONSTRUCTION — and the construction is TWO guards over ONE shell-out. Everything this file
 * reads from GitHub goes through `ghExec`, which calls:
 *   - `assertReadOnlyGh` — the `gh` subcommand must be one of TWO allowed reads, `gh api` or `gh pr list`;
 *   - `assertReadOnlyEndpoint` — for `gh api`, the argv must carry no write flag in ANY spelling `gh`
 *     accepts (`--method`/`-X`, `--field`/`-f`, `--raw-field`/`-F`, `--input`, each of them space-separated,
 *     `=`-joined, OR — because `gh` is cobra/pflag-based — concatenated as `-XPOST`; see
 *     `WRITE_FLAG_PATTERNS` and the retraction on it), and the endpoint must match one of a
 *     THREE-shape read allowlist: `/issues/{n}/comments`, `/pulls/{n}`, `/pulls/{n}/files`.
 * Of those three shapes the code today calls exactly ONE, `/issues/{n}/comments` (the single `ghJson` call
 * site, in `mineRepo`); the other two are allowlisted ahead of the callers that will read a PR's head/base
 * and its file list. The corpus is mined FROM the PRs and must never write back to them.
 *
 * RETRACTED — this paragraph used to read *"It calls `gh api` on `/issues/{n}/comments` and `/pulls/{n}` and
 * nothing else … `assertReadOnlyEndpoint` fails closed on any endpoint that is not a plain GET of those two
 * shapes."* Every clause of that was wrong. The guard allowlists THREE endpoint shapes, not two; the code
 * calls ONE of them, not two; and "nothing else" was false in a way the sentence hid — `mineRepo` shelled
 * `gh pr list` DIRECTLY, a second call site that reached GitHub without passing `assertReadOnlyEndpoint` at
 * all. The listing was a read, so nothing was ever written; but the guarantee the sentence advertised did not
 * hold, because one word (`gh pr edit`) would have been refused by nothing. `assertReadOnlyGh` + `ghExec` now
 * close that path, and `__tests__/mine-review-corpus.test.mjs` pins the allowlist shape by shape AND counts
 * the `gh` call sites, so neither claim can rot silently again.
 *
 * WHAT A LABEL IS, AND IS NOT — read this before dividing by any number out of this corpus. The cases
 * record what a review SAID, not what was true. A finding marked `CONFIRMED` is confirmed BY THE REVIEWING
 * SESSION ABOUT ITS OWN FINDING; no second party ever adjudicated it, and a peer session that authored many
 * of the underlying PRs reports finding real errors in several of those reviews after the fact. The labels
 * are therefore fallible INDIVIDUALLY as well as incomplete COLLECTIVELY — the pooling problem twice over.
 * Every rate derived from them is sound as a RELATIVE comparison between reviewers scored on the same pool,
 * and unsound as an absolute catch rate. `index.json.provenance` carries the same sentence, so a reader who
 * has only the mined tree and never saw the PR page still gets the weaker, correct reading (#1569 r3 f9).
 *
 * THE `presentAt` LABEL — the one that makes this worth building. A finding raised in round 4 was very
 * often already there in round 1; the reviewer just hadn't looked. We can prove that per finding rather
 * than assume it: a finding on `<path>` found at head `H_found` was PRESENT at an earlier head `H` iff
 * `git diff H H_found -- <path>` is empty, i.e. the file did not change between them. That gives each
 * round a defensible "what was findable here but not found" set, which is the recall baseline the whole
 * experiment is measured against.
 *
 * Usage:
 *   node scripts/review-corpus/mine-review-corpus.mjs [--repo=owner/name] [--limit=200]
 *                                                     [--out=scripts/review-corpus/cases]
 *                                                     [--comments-dir=<dir>]   # offline: pre-fetched comment dumps
 *
 * Output: `<out>/<pr>-r<round>.json` per verdict + `<out>/index.json` (counts, provenance, corpus as-of
 * marker taken from the newest mined commit date — never a wall clock, so a rerun is byte-stable).
 *
 * WHO REVIEWED (#3363) — every case carries `reviewerIdentity`, and `index.json` carries the roll-up. Read
 * the block comment above `IDENTITY_FIELDS` before comparing two rounds: the comment body records the
 * roster, the panel shape and the care level, and does NOT record the model id, the effort or the prompt
 * revision, so `sameReviewer` answers `unknown` — never `same` — for every pair in the corpus today.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/* ------------------------------------------------------------------ read-only guard */

/**
 * The read allowlist, as data. THREE shapes — the count the header states, and the count the test asserts.
 * Every entry is anchored at both ends so a path that merely CONTAINS an allowed shape cannot pass.
 */
export const ALLOWED_READ_ENDPOINTS = Object.freeze([
  /^repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/comments$/,
  /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/,
  /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/files$/,
]);

/**
 * A write flag, in EVERY shape `gh` accepts one. `gh` is built on cobra/pflag, which lets a SHORTHAND flag
 * carry its value with no separator at all — `-XPOST` is the same invocation as `-X POST`, the same
 * mechanism as `docker -p8080:80` — and lets shorthands cluster, so the value-taking letter can sit at the
 * end of a run of boolean ones (`-qXPOST`). Hence the short-flag pattern matches a LEADING single dash
 * followed by any run of letters ending in `X`, `f` or `F`, rather than the whole token: a token-equality
 * test only ever catches the space-separated spelling.
 *
 * The long forms are matched on `(=|$)` so `--methodical` (were there such a flag) is not mistaken for one.
 * `--input` is here because `gh api --input body.json` sends a body, which makes the request a POST without
 * `--method` ever appearing.
 *
 * RETRACTED — this test used to read
 * `/^--method(=|$)/.test(a) || /^-X$/.test(a) || /^--field(=|$)/.test(a) || /^-f$/.test(a)`, and the file
 * header claimed on the strength of it that the guard refuses "any argv carrying a write flag". That was
 * wrong. Anchoring the short flags at BOTH ends (`/^-X$/`, `/^-f$/`) meant the guard refused `-X POST` and
 * waved through `-XPOST`; verified live before the fix, `assertReadOnlyEndpoint(<allowlisted>, [..., '-XPOST'])`
 * returned true with no throw, as did `-fbody=…`. `-F`/`--raw-field` and `--input` — two more ways to put a
 * body on the request — were not tested for at all, in any spelling. So `gh api <allowlisted-endpoint> -XPOST`
 * would have reached GitHub as a WRITE against the very PRs this corpus is mined from (#1571 review, f6).
 * Exported so the test suite asserts the patterns rather than a reader trusting the sentence above them.
 */
export const WRITE_FLAG_PATTERNS = Object.freeze([
  /^--method(=|$)/,
  /^--field(=|$)/,
  /^--raw-field(=|$)/,
  /^--input(=|$)/,
  /^-[a-zA-Z]*[XfF]/,
]);

/**
 * Fail closed on anything that is not one of the THREE read shapes this miner is allowed to use (see the
 * header for the list, and for what is retracted). The point is not that `gh api` defaults to GET — it is
 * that a future edit adding `--method POST` or a `/comments` write must not silently start mutating the pull
 * requests this corpus is mined from.
 *
 * `ALLOWED_READ_ENDPOINTS` above is the ONLY statement of that set; anything describing it in prose — here, the header,
 * the PR body — is a restatement and must be checked against it. `ALLOWED_READ_ENDPOINTS` is exported so a
 * test can assert the count rather than a reader having to trust a sentence (#1569 review, `claim-accuracy`).
 *
 * @param {string} endpoint the `gh api` endpoint path.
 * @param {string[]} argv the full argv handed to `gh`.
 */
export function assertReadOnlyEndpoint(endpoint, argv = []) {
  const mutating = argv.some((a) => WRITE_FLAG_PATTERNS.some((re) => re.test(a)));
  if (mutating) {
    throw new Error(`mine-review-corpus: REFUSED — this miner is read-only; argv carries a write flag: ${argv.join(' ')}`);
  }
  const ok = ALLOWED_READ_ENDPOINTS.some((re) => re.test(endpoint));
  if (!ok) {
    throw new Error(`mine-review-corpus: REFUSED — endpoint is not an allowed read: ${endpoint}`);
  }
  return true;
}

/**
 * The `gh` subcommands this miner may run, as data. `api` is the guarded one — `assertReadOnlyGh` hands it
 * on to `assertReadOnlyEndpoint` for the endpoint check. `pr list` is a pure listing with no write form.
 */
export const ALLOWED_GH_COMMANDS = Object.freeze([['api'], ['pr', 'list']]);

/**
 * Fail closed on any `gh` invocation this miner is not allowed to make. PURE (throws or returns true).
 *
 * WHY IT IS SEPARATE FROM `assertReadOnlyEndpoint`. That guard only ever saw `gh api` argv. The PR-number
 * listing shelled `gh pr list` DIRECTLY, so a whole second `gh` call site sat outside the read-only guarantee
 * the header advertises — a later edit to that line (`gh pr edit`, `gh pr close`, and they are one word
 * apart) would have been refused by nothing. Both call sites now funnel through `ghExec`, which calls this.
 *
 * @param {string[]} argv the full argv handed to `gh`.
 * @returns {true}
 */
export function assertReadOnlyGh(argv = []) {
  const command = ALLOWED_GH_COMMANDS.find((c) => c.every((word, i) => argv[i] === word));
  if (!command) {
    throw new Error(
      `mine-review-corpus: REFUSED — this miner is read-only; \`gh ${argv.join(' ')}\` is not one of its `
      + `allowed reads (${ALLOWED_GH_COMMANDS.map((c) => `gh ${c.join(' ')}`).join(', ')}).`,
    );
  }
  if (command[0] === 'api') assertReadOnlyEndpoint(argv[1] ?? '', argv);
  return true;
}

/**
 * THE ONE PLACE THIS FILE SHELLS `gh`. Everything the miner reads from GitHub goes through here, so the
 * guards above are unbypassable by construction rather than by convention — a second `execFileSync('gh', …)`
 * anywhere in this file would route around them, and the test suite counts the call sites for exactly that
 * reason.
 * @param {string[]} argv the full argv handed to `gh`.
 * @returns {string} stdout.
 */
function ghExec(argv) {
  assertReadOnlyGh(argv);
  return execFileSync('gh', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function ghJson(endpoint, { paginate = false } = {}) {
  const argv = ['api', endpoint, ...(paginate ? ['--paginate'] : [])];
  const out = ghExec(argv);
  if (paginate) {
    // --paginate concatenates JSON arrays; normalise to one array.
    const chunks = out.replace(/\]\s*\[/g, ',').trim();
    return JSON.parse(chunks || '[]');
  }
  return JSON.parse(out || 'null');
}

/* ------------------------------------------------------------------ parsing */

/**
 * The provenance stamped into `index.json`, so the caveat travels WITH the corpus rather than living only
 * on a PR page a later consumer will never read. Exported and pinned by a test against the committed
 * `cases/index.json`, because the whole failure mode this file keeps hitting is a caveat that is stated in
 * one place and absent from the other.
 *
 * RETRACTED — this used to read *"Mined read-only from recorded review-pr verdict comments; revision ranges
 * are the verdicts' own `Net basis` lines."* Nothing in it was false, but it disclaimed nothing: a reader of
 * the tree had no way to learn that a `CONFIRMED` label is the reviewer's own unadjudicated self-assessment,
 * so the stronger reading — "39 verified defects" — was the one the file invited.
 */
export const PROVENANCE = 'Mined read-only from recorded review-pr verdict comments; revision ranges are the '
  + "verdicts' own `Net basis` lines. LABEL CAVEAT: a CONFIRMED label is the reviewing session's own "
  + 'unadjudicated self-assessment of its own finding, not an adjudicated fact — the labels are fallible '
  + 'individually and incomplete collectively, so rates derived from them are sound only as a RELATIVE '
  + 'comparison between reviewers scored on this same pool, never as an absolute catch rate.';

/* ------------------------------------------------------------------ reviewer identity (#3363) */

/**
 * WHO REVIEWED — the field #3310's number cannot be read without.
 *
 * #3310 measured, on this corpus, 5 pairs of rounds that ran against a BYTE-IDENTICAL head sha and found
 * 0 of 7 pooled findings recurring under the headline `defect` matcher (1 of 6 under the loosest `locus`
 * matcher), with 1 of the 5 pairs flipping its verdict — #1556 r6→r7 answered `accept` and then `changes`
 * on the same diff. Re-derived here 2026-08-27 by running `stability.mjs --mode=live-pairs`, not copied.
 *
 * That number has TWO readings and the corpus could not tell them apart: juror nondeterminism, or a
 * DIFFERENT REVIEWER between the two rounds — a changed model, a changed prompt, a different lens roster.
 * They call for opposite responses. So each round now carries what the record actually says about who
 * reviewed it, and — this is the half that matters — says `unknown` for the rest instead of leaving a
 * reader to assume sameness.
 *
 * WHAT THE MINER CAN ACTUALLY SEE, AND WHAT IT CANNOT. The miner's ONLY source is the verdict comment
 * body. Checked against live comment bodies on PRs #1556, #1580, #1632, #1635, #1638, #1641 and #1643
 * (2026-08-27):
 *
 *   OBSERVABLE — parsed below
 *     roster            the `**Lens:**` / `**Lenses:**` line and the panel table rows: which lenses sat.
 *     panelShape        `single-lens` vs `multi-lens`, as the write-up itself declares it.
 *     careLevel         the derived care level from the `**Earned vs seated:**` line (#3335).
 *     declaredCareLevel what the caller declared on that same line, or `none` when it declared nothing.
 *     operation         the `_Recorded through the declared \`<op>\` operation_` footer.
 *     writeUpMarkers    the `#NNNN` refs in the write-up's FIXED boilerplate lines. A coarse build
 *                       fingerprint of the RENDERER, nothing more: `review-pr.mjs` holds both the
 *                       renderer and the juror's model/mandate, so a changed marker set is evidence the
 *                       emitting build moved. It does NOT identify the prompt, and must not be read as
 *                       doing so — identical markers are entirely compatible with a changed mandate.
 *
 *   NOT OBSERVABLE — permanently `null`, because it is NEVER EMITTED
 *     model             `JUDGE_MODEL` (`we:scripts/operations/review-pr.mjs`) is a module literal that
 *                       reaches the juror's argv and never the comment body. No recorded verdict comment
 *                       contains it.
 *     effort            `JUDGE_EFFORT`, same story.
 *     promptRevision    the panel mandate is built per run and never echoed into the write-up.
 *
 * SO THIS CARD DOES NOT, BY ITSELF, MAKE #3310 READABLE. The model id is the field that would settle it
 * and it is not in the miner's input. Fixing that is a change at the EMITTING end
 * (`we:scripts/operations/review-pr.mjs` must write the model into the write-up), which is a different
 * file and a different item. What this file does is make the gap EXPLICIT and machine-checkable rather
 * than a caveat in prose: `sameReviewer` answers `unknown`, never `same`, for every round in the corpus
 * today, and starts answering `same` on its own the moment the emitter records a model id.
 *
 * BACK-FILL, STATED PRECISELY. The card says already-mined rounds cannot be back-filled. That is true of
 * the NOT-OBSERVABLE fields and only of those: the miner rebuilds `cases/` from scratch on every run, so
 * the OBSERVABLE fields are re-derived for every historical round on the next mine. The model id, effort
 * and prompt revision of every round recorded before the emitter changes are lost for good.
 */
export const IDENTITY_FIELDS = Object.freeze([
  'model', 'effort', 'promptRevision', 'roster', 'panelShape', 'careLevel', 'declaredCareLevel',
  'operation', 'writeUpMarkers',
]);

/**
 * The fields that must BOTH be recorded before two rounds may be called the same reviewer. Deliberately
 * the two that identify the reviewing SOFTWARE rather than the run's shape: an identical roster proves
 * nothing about which model read the diff, and it is the model that #3310's ambiguity turns on.
 *
 * Every one of them is `null` on every round in the corpus today (see the note above), which is why
 * `sameReviewer` returns `unknown` corpus-wide and why that is the CORRECT answer rather than a defect.
 */
export const IDENTITY_REQUIRED_FOR_SAMENESS = Object.freeze(['model', 'promptRevision']);

/** Fields the emitter never writes, so no amount of re-mining will recover them. Exported for the report. */
export const IDENTITY_NEVER_EMITTED = Object.freeze(['model', 'effort', 'promptRevision']);

/** The caveat stamped into `index.json`, so a reader of the mined tree alone gets it (same reason as `PROVENANCE`). */
export const IDENTITY_NOTE = 'Per-round reviewer identity (#3363). Parsed from the verdict comment body, the '
  + "miner's only source. The comment records the lens roster, the panel shape, the care level (when the "
  + 'write-up carries an "Earned vs seated" line) and a coarse renderer-build marker set. It does NOT record '
  + 'the model id, the reasoning effort or the prompt revision — those are module literals in '
  + 'scripts/operations/review-pr.mjs that never reach the comment — so `sameReviewer` answers `unknown` for '
  + 'every pair in this corpus and MUST NOT be read as `same`. A differing observable field still proves '
  + '`different`. Recording the model at the emitting end is a separate change to a separate file.';

const VERDICT_ACCEPT = '✅ review — accepted';
const VERDICT_CHANGES = '🔁 review — changes requested';

/**
 * The write-up's FIXED boilerplate lines — the ones whose text is a literal in `renderVerdictWriteUp`
 * rather than run data. The `#NNNN` refs inside them move when that renderer is edited, which is the only
 * build signal the comment carries. Anchored per-line so a finding that happens to cite `#3050` in its
 * prose cannot contaminate the fingerprint.
 */
const BOILERPLATE_LINE_PATTERNS = Object.freeze([
  /^\*\*Lens(?:es)?:\*\* .*$/gm,
  /^\*\*Earned vs seated:\*\* .*$/gm,
  /^Net basis: .*$/gm,
  /^_Recorded through the declared .*_$/gm,
]);

/**
 * What one verdict comment says about who reviewed it. PURE. Every field is either a value or `null`;
 * `unknown` lists the `null` ones by name, so a consumer can report the gap instead of inferring over it.
 *
 * `comparable` is false whenever ANY of `IDENTITY_REQUIRED_FOR_SAMENESS` is null — i.e. always, today.
 * It is a separate flag rather than a derived truthiness check because the failure this card exists to
 * prevent is precisely a consumer treating "no differences found" as "same reviewer".
 *
 * @param {string} body the verdict comment body.
 * @returns {{model: null, effort: null, promptRevision: null, roster: string[]|null,
 *   panelShape: string|null, careLevel: string|null, declaredCareLevel: string|null,
 *   operation: string|null, writeUpMarkers: string[]|null, unknown: string[], comparable: boolean}}
 */
export function parseReviewerIdentity(body = '') {
  const text = String(body ?? '');

  // The roster line, in both spellings the renderer has used. `**Lens:** \`correctness\` — a SINGLE-LENS
  // run.` (one seat) and `**Lenses:** \`correctness\` + \`security\` — 2 juror(s)…` (the #3319 panel).
  // ONLY the head of the line, before the em-dash. Everything after it is PROSE that also contains
  // backticked lowercase words — `judge`, `judgePanel` — and a naive sweep of the whole line mined
  // `["correctness", "judge"]` as the roster of a single-lens run. Verified against the committed
  // fixtures: the first cut of this parser did exactly that on `cases/1561-r2.json`.
  const lensLine = text.match(/^\*\*Lens(?:es)?:\*\* (.+)$/m);
  const seatHead = lensLine ? lensLine[1].split(/\s+—\s+/)[0] : '';
  const fromLine = [...seatHead.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1]);
  // The panel table is the fallback: an older write-up with no lens line still lists its rows.
  const fromRows = [...text.matchAll(/^\|\s*([a-z][a-z-]+)\s*\|\s*(?:mandatory|advisory)\s*\|/gm)].map((m) => m[1]);
  const roster = fromLine.length ? fromLine : (fromRows.length ? [...new Set(fromRows)] : null);

  const panelShape = /a SINGLE-LENS run/.test(text)
    ? 'single-lens'
    : (lensLine && /^\*\*Lenses:\*\*/.test(lensLine[0]) ? 'multi-lens' : null);

  // #3335's earned-vs-seated line. Absent from every round recorded so far, so both care fields read
  // `unknown` on today's corpus — which is the honest answer, not a parse failure.
  const care = text.match(/\*\*Earned vs seated:\*\* .*?touch-set scores care `([a-z-]+)`/);
  const declaredHit = text.match(/The caller declared `--careLevel=([a-z-]+)`/);
  const declaredNone = /The caller declared no `--careLevel`/.test(text);
  const declaredCareLevel = declaredHit ? declaredHit[1] : (declaredNone ? 'none' : null);

  const op = text.match(/_Recorded through the declared `([\w-]+)` operation/);

  const markers = new Set();
  for (const re of BOILERPLATE_LINE_PATTERNS) {
    for (const line of text.match(re) ?? []) {
      for (const m of line.matchAll(/#(\d{3,5})\b/g)) markers.add(`#${m[1]}`);
    }
  }

  const identity = {
    // NEVER EMITTED — see the block comment above. Present as explicit nulls so the shape is stable and
    // a later emitter change fills them in without any consumer having to learn a new field name.
    model: null,
    effort: null,
    promptRevision: null,
    roster,
    panelShape,
    careLevel: care ? care[1] : null,
    declaredCareLevel,
    operation: op ? op[1] : null,
    writeUpMarkers: markers.size ? [...markers].sort() : null,
  };
  identity.unknown = IDENTITY_FIELDS.filter((f) => identity[f] == null);
  identity.comparable = IDENTITY_REQUIRED_FOR_SAMENESS.every((f) => identity[f] != null);
  return identity;
}

/** True when two recorded identity values are equal. Arrays compare as ordered element lists. */
function identityValueEquals(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => x === b[i]);
  }
  return a === b;
}

/**
 * THE THREE-VALUED ANSWER. Were these two rounds reviewed by the same reviewer? PURE.
 *
 * Returns `same` | `different` | `unknown` — never a boolean, because a boolean has nowhere to put the
 * third case and every caller would then spell it `false`, i.e. "different", which is the exact wrong
 * answer for a round with no identity recorded.
 *
 * THE ASYMMETRY IS DELIBERATE, and it is the whole logic:
 *   - a field recorded on BOTH sides and DIFFERING proves `different`. One difference is enough, and it
 *     is sound even with every other field unknown.
 *   - `same` requires every field in `IDENTITY_REQUIRED_FOR_SAMENESS` recorded on both sides and equal.
 *     Absence never proves sameness, so "no differences found" reduces to `unknown`, not to `same`.
 *
 * On today's corpus this returns `unknown` for every pair, because `model` and `promptRevision` are not
 * emitted. That is the point: #3310's churn figure is reported against rounds whose reviewer sameness is
 * NOT established, and this makes a consumer say so rather than assume it.
 *
 * @param {object|null} a the first round's `reviewerIdentity` (or the case object itself).
 * @param {object|null} b the second round's.
 * @returns {{answer: 'same'|'different'|'unknown', differing: string[], agreeing: string[], unknown: string[]}}
 */
export function sameReviewer(a, b) {
  const idA = a && typeof a === 'object' ? (a.reviewerIdentity ?? a) : null;
  const idB = b && typeof b === 'object' ? (b.reviewerIdentity ?? b) : null;
  if (!idA || !idB || typeof idA !== 'object' || typeof idB !== 'object') {
    return { answer: 'unknown', differing: [], agreeing: [], unknown: [...IDENTITY_FIELDS] };
  }
  const differing = []; const agreeing = []; const unknown = [];
  for (const f of IDENTITY_FIELDS) {
    const va = idA[f]; const vb = idB[f];
    if (va == null || vb == null) { unknown.push(f); continue; }
    if (identityValueEquals(va, vb)) agreeing.push(f); else differing.push(f);
  }
  if (differing.length) return { answer: 'different', differing, agreeing, unknown };
  const proven = IDENTITY_REQUIRED_FOR_SAMENESS.every((f) => idA[f] != null && idB[f] != null);
  return { answer: proven ? 'same' : 'unknown', differing, agreeing, unknown };
}

/**
 * The corpus-level identity roll-up written into `index.json`. PURE.
 *
 * It reports how many rounds carry each field and — the number a reader of #3310 needs — how many of the
 * repeated-head pairs can actually be attributed to one reviewer. It deliberately does NOT compute a
 * churn rate; that is `we:scripts/review-corpus/stability.mjs`'s job and this file must not grow a second
 * copy of it.
 *
 * @param {object[]} cases every mined case.
 */
export function summariseIdentity(cases = []) {
  const recorded = Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, 0]));
  let withIdentity = 0;
  for (const k of cases) {
    const id = k && k.reviewerIdentity;
    if (!id) continue;
    withIdentity += 1;
    for (const f of IDENTITY_FIELDS) if (id[f] != null) recorded[f] += 1;
  }
  // Repeated-head pairs, the population #3310's headline rests on, classified by the three-valued answer.
  const byPr = new Map();
  for (const k of cases) {
    if (!byPr.has(k.pr)) byPr.set(k.pr, []);
    byPr.get(k.pr).push(k);
  }
  const pairAnswers = { same: 0, different: 0, unknown: 0 };
  for (const rounds of byPr.values()) {
    rounds.sort((x, y) => x.round - y.round);
    for (let i = 1; i < rounds.length; i += 1) {
      if (rounds[i].head !== rounds[i - 1].head) continue;
      pairAnswers[sameReviewer(rounds[i - 1], rounds[i]).answer] += 1;
    }
  }
  return {
    rounds: cases.length,
    roundsWithIdentity: withIdentity,
    recorded,
    neverEmitted: [...IDENTITY_NEVER_EMITTED],
    sameHeadPairs: pairAnswers,
    note: IDENTITY_NOTE,
  };
}

/** Split a raw comment body stream into individual verdict comments, in recorded order. */
export function verdictComments(bodies) {
  return bodies.filter((b) => typeof b === 'string' && (b.includes(VERDICT_ACCEPT) || b.includes(VERDICT_CHANGES)));
}

/**
 * Pull the structured facts out of one `review-pr` verdict comment. Returns null for the older
 * unstructured verdict format (no `Net basis:` line) — those carry no revision range, so they are not
 * replayable and are deliberately left out of the corpus rather than guessed at.
 * @param {string} body the comment body.
 */
export function parseVerdict(body) {
  const basis = body.match(/Net basis: `([0-9a-f]{40})\.\.([0-9a-f]{40})`/);
  if (!basis) return null;
  const decision = body.match(/\*\*Decision:\*\* `(\w+)`/);
  const headline = body.includes(VERDICT_ACCEPT) ? 'accepted' : 'changes';
  const findingsCount = body.match(/### Findings \((\d+)\)/);
  const singleLens = /a SINGLE-LENS run/.test(body);
  const lensRows = [...body.matchAll(/^\|\s*([a-z][a-z-]+)\s*\|\s*(mandatory|advisory)\s*\|\s*([a-z]+)\s*\|/gm)]
    .map(([, lens, weight, verdict]) => ({ lens, weight, verdict }));
  return {
    base: basis[1],
    head: basis[2],
    headline,
    decision: decision ? decision[1] : null,
    declaredFindings: findingsCount ? Number(findingsCount[1]) : null,
    singleLens,
    lensRows,
    // #3363 — WHO reviewed, beside WHAT they found. Never omitted: a round the parser can say nothing
    // about still gets the object, with every field null and `unknown` naming them, so a consumer meets
    // an explicit gap rather than a missing key it can read as "same as the other one".
    reviewerIdentity: parseReviewerIdentity(body),
    findings: parseFindings(body),
  };
}

/**
 * Parse the finding bullets under `### Findings (N)`. Each is rendered as
 *   **<category>** (n)
 *   - `path:line` — <what> — <consequence> _[CONFIRMED]_ _[impact if unfixed: <level>]_
 * A bullet with no leading `path` locus is a prose note, not a located finding, and is skipped: the
 * scorer can only check a gate against a place, so an unlocated finding is not a usable label.
 */
export function parseFindings(body) {
  const section = body.split(/### Findings \(\d+\)/)[1];
  if (!section) return [];
  const upto = section.split(/\n---\n/)[0];
  const out = [];
  let category = null;
  for (const line of upto.split('\n')) {
    const cat = line.match(/^\*\*([a-z][a-z-]+)\*\*\s*\((\d+)\)\s*$/);
    if (cat) { category = cat[1]; continue; }
    const bullet = line.match(/^- `([^`]+)`\s+—\s+(.*)$/);
    if (!bullet) continue;
    const locus = bullet[1];
    const rest = bullet[2];
    const m = locus.match(/^(.*?):(\d+)$/);
    const path = m ? m[1] : locus;
    const lineNo = m ? Number(m[2]) : null;
    // A locus must look like a repo path; `npm run check:standards` and bare `#3233` are prose, not places.
    if (!/^[\w.@-]+(\/[\w.@ -]+)+$/.test(path.replace(/^we:/, ''))) continue;
    const impact = rest.match(/\[impact if unfixed: ([a-z-]+)\]/);
    const confirmed = /_\[CONFIRMED\]_/.test(rest);
    const plausible = /_\[PLAUSIBLE\]_/.test(rest);
    if (!confirmed && !plausible) continue; // unverified narration, not a label
    out.push({
      path: path.replace(/^we:/, ''),
      line: lineNo,
      category,
      impact: impact ? impact[1] : null,
      verdict: confirmed ? 'CONFIRMED' : 'PLAUSIBLE',
      summary: rest.split(' — ')[0].slice(0, 400),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ git */

/**
 * A git PROBE. Every caller below asks git a yes/no question and treats a non-zero exit as "no", so git's
 * own stderr is never the answer to anything — it is only noise on the operator's terminal, interleaved
 * with the miner's report. `stderr: 'ignore'` keeps the failure (the throw) and drops the chatter.
 */
function git(args, { cwd = ROOT } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function commitExists(sha, { cwd = ROOT } = {}) {
  try { git(['cat-file', '-e', `${sha}^{commit}`], { cwd }); return true; } catch { return false; }
}

/**
 * Was `path` identical at `headA` and `headB`? Used to prove a later round's finding was already
 * present at an earlier round's head — if the file never changed between the two, whatever was found
 * later was findable earlier.
 */
export function pathUnchangedBetween(headA, headB, path, { cwd = ROOT } = {}) {
  if (headA === headB) return true;
  try {
    const out = git(['diff', '--name-only', headA, headB, '--', path], { cwd });
    return out === '';
  } catch { return false; }
}

export function changedFiles(base, head, { cwd = ROOT } = {}) {
  try { return git(['diff', '--name-only', base, head]).split('\n').filter(Boolean); } catch { return []; }
}

function commitDate(sha, { cwd = ROOT } = {}) {
  try { return git(['show', '-s', '--format=%cI', sha], { cwd }); } catch { return null; }
}

/* ------------------------------------------------------------------ mining */

/**
 * Build the case set for one PR from its ordered verdict comments. Rounds are 1-based in recorded
 * order. Each case gets `missedHere`: the findings raised in a LATER round whose file was byte-identical
 * at this round's head — i.e. present and findable at this round, and not found.
 */
export function buildCases(pr, verdicts, { cwd = ROOT } = {}) {
  const cases = [];
  for (let i = 0; i < verdicts.length; i += 1) {
    const v = verdicts[i];
    const missed = [];
    for (let j = i + 1; j < verdicts.length; j += 1) {
      for (const f of verdicts[j].findings) {
        if (pathUnchangedBetween(v.head, verdicts[j].head, f.path, { cwd })) {
          missed.push({ ...f, foundAtRound: j + 1, provenBy: `git diff ${v.head.slice(0, 8)} ${verdicts[j].head.slice(0, 8)} -- ${f.path} is empty` });
        }
      }
    }
    cases.push({
      pr,
      round: i + 1,
      totalRounds: verdicts.length,
      base: v.base,
      head: v.head,
      headline: v.headline,
      decision: v.decision,
      singleLens: v.singleLens,
      lensRows: v.lensRows,
      // #3363 — travels ON the case, so a scorer comparing two rounds has the identity in the same object
      // as the findings and cannot compare one without the other being in reach.
      reviewerIdentity: v.reviewerIdentity ?? parseReviewerIdentity(''),
      declaredFindings: v.declaredFindings,
      changedFiles: changedFiles(v.base, v.head, { cwd }),
      findings: v.findings,
      missedHere: missed,
    });
  }
  return cases;
}

function parseArgs(argv) {
  const o = { repo: 'web-everything/web-everything', limit: 200, out: 'scripts/review-corpus/cases', commentsDir: null };
  for (const a of argv) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[1] === 'repo') o.repo = m[2];
    if (m[1] === 'limit') o.limit = Number(m[2]);
    if (m[1] === 'out') o.out = m[2];
    if (m[1] === 'comments-dir') o.commentsDir = m[2];
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = resolve(ROOT, opts.out);
  const [owner, name] = opts.repo.split('/');

  let prNumbers = [];
  let bodiesFor = null;

  if (opts.commentsDir) {
    // Offline path: a directory of `<pr>.json` arrays previously fetched with the same GET endpoint.
    const dir = resolve(ROOT, opts.commentsDir);
    prNumbers = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.replace('.json', ''))).sort((a, b) => a - b);
    bodiesFor = (n) => JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8')).map((c) => c.body);
  } else {
    const list = ghExec(['pr', 'list', '--repo', opts.repo, '--state', 'all', '--limit', String(opts.limit), '--json', 'number']);
    prNumbers = JSON.parse(list).map((p) => p.number).sort((a, b) => a - b);
    bodiesFor = (n) => ghJson(`repos/${owner}/${name}/issues/${n}/comments`, { paginate: true }).map((c) => c.body);
  }

  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  let kept = 0; let skippedUnreachable = 0; let skippedUnstructured = 0;
  let newestDate = null;
  const perPr = [];
  const allCases = []; // #3363 — kept so the identity roll-up is computed over what was actually written.

  for (const n of prNumbers) {
    let bodies;
    try { bodies = bodiesFor(n); } catch { continue; }
    const parsed = verdictComments(bodies).map(parseVerdict);
    const structured = parsed.filter(Boolean);
    skippedUnstructured += parsed.length - structured.length;
    const reachable = structured.filter((v) => {
      const ok = commitExists(v.base) && commitExists(v.head);
      if (!ok) skippedUnreachable += 1;
      return ok;
    });
    if (!reachable.length) continue;

    const cases = buildCases(n, reachable);
    for (const c of cases) {
      writeFileSync(join(outDir, `${c.pr}-r${c.round}.json`), `${JSON.stringify(c, null, 2)}\n`);
      allCases.push(c);
      kept += 1;
      const d = commitDate(c.head);
      if (d && (!newestDate || d > newestDate)) newestDate = d;
    }
    perPr.push({ pr: n, rounds: cases.length, findings: cases.reduce((a, c) => a + c.findings.length, 0), missed: cases.reduce((a, c) => a + c.missedHere.length, 0) });
  }

  const identity = summariseIdentity(allCases);
  const index = {
    // 2 since #3363 — every case now carries `reviewerIdentity`. The committed `cases/` tree on the
    // branch that added this still reads `schema: 1`; it was NOT re-mined here, so a reader who sees 1
    // is looking at a corpus mined before the field existed and gets no identity block at all, which is
    // the correct signal rather than a silent absence.
    schema: 2,
    repo: opts.repo,
    corpusAsOf: newestDate,
    cases: kept,
    prs: perPr.length,
    skipped: { unreachableCommits: skippedUnreachable, unstructuredVerdicts: skippedUnstructured },
    totals: {
      findings: perPr.reduce((a, p) => a + p.findings, 0),
      provenMissed: perPr.reduce((a, p) => a + p.missed, 0),
    },
    provenance: PROVENANCE,
    reviewerIdentity: identity,
    perPr,
  };
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  process.stdout.write(`mined ${kept} cases across ${perPr.length} PRs → ${opts.out}\n`);
  process.stdout.write(`  findings labelled: ${index.totals.findings}   proven-missed labels: ${index.totals.provenMissed}\n`);
  process.stdout.write(`  skipped: ${skippedUnreachable} unreachable, ${skippedUnstructured} unstructured\n`);
  // #3363 — printed, not buried in the index, because the number that matters is how many same-head pairs
  // are attributable to ONE reviewer. `unknown` is expected here until the emitter records a model id.
  const p = identity.sameHeadPairs;
  process.stdout.write(`  reviewer identity: roster on ${identity.recorded.roster}/${kept} rounds, `
    + `care level on ${identity.recorded.careLevel}/${kept}; `
    + `model/effort/prompt never emitted (${identity.neverEmitted.join(', ')})\n`);
  process.stdout.write(`  same-head pairs by reviewer sameness: ${p.same} same, ${p.different} different, `
    + `${p.unknown} UNKNOWN — an unknown pair must not be quoted as a repeated run of ONE reviewer.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
}
