#!/usr/bin/env node
/**
 * progress-board.mjs — the operator's published progress board (item `x9t5i5a`).
 *
 * WHAT IT IS. A single fixed-path HTML page that answers "what is the plan, and where is it?" — published
 * once as an Artifact and then REFRESHED MECHANICALLY. The model never sees or writes the markup: this
 * script owns every byte of the page. One update costs exactly **one Bash call** (a verb below) plus
 * **one Artifact call** (re-publish the same fixed path).
 *
 * WHERE THE CONTENT COMES FROM — two halves, deliberately split by who can know it:
 *   • DERIVED (live, free): open + recently-merged pull requests, read through `gh pr list`, each reduced
 *     to ONE status by `classifyPr` — needs-human / bounced / ci-red / conflicted / needs-review / queued /
 *     landed. Nothing about PR state is ever typed by hand, so the board cannot drift from GitHub.
 *   • DERIVED (live, free): the weekly OUTPUT MIX — lines added to product vs to delivery machinery and
 *     backlog bookkeeping, read from `git log --numstat` by `we:scripts/lib/output-mix.mjs` (#3012). Like the
 *     PR half it is never typed: the classification is the committed, first-match-wins rule list in
 *     `we:scripts/lib/output-mix-paths.json`, so disagreeing with the number means editing one rule there.
 *   • HAND-MAINTAINED (tiny): `reports/progress-board.json` — the plan items and the decisions waiting on
 *     the operator. These are intentions; no API knows them. The model edits them ONLY through the verbs
 *     below, never by hand — a hand-edited state file is how the "mechanical" property gets lost.
 *
 * DEGRADATION IS A FEATURE. `gh` missing, unauthenticated, offline or rate-limited must not lose the page.
 * Every successful fetch is cached to a sidecar (`reports/.progress-board-cache.json`, gitignored); a failed
 * fetch renders the cache behind a visible "stale" banner, and with no cache at all the page still renders
 * with an empty PR section and an honest note. A stale-but-rendered board beats a crash.
 *
 * The HAND-MAINTAINED half degrades the same way, and it has to: that file is git-tracked, so an unresolved
 * merge-conflict marker is enough to make it invalid JSON. `loadState` never throws. It distinguishes TWO
 * degradations, and the difference is load-bearing:
 *   • FATAL (`[STATE_FATAL]`) — the file did not parse at all, so NOTHING survived. The empty state is
 *     returned, the page renders behind a red banner, and every verb is refused (saving an empty plan over a
 *     recoverable one is the single unrecoverable move here). There are no decisions, so there is nothing the
 *     answerability guard could wave through.
 *   • PARTIAL — the file parsed and has the right shape; one key held the wrong type and was normalised FOR
 *     RENDERING ONLY. The surviving items and decisions ARE the plan, so the verbs stay available (that is
 *     the repair route) and the answerability guard runs on them exactly as it would on a clean file. A soft
 *     type error is never a licence to publish an unanswerable ask. The normalisation NEVER reaches the file:
 *     the raw value of the key is re-emitted verbatim on save (`STATE_UNREADABLE`) and the verbs that write
 *     to that one key are refused. Writing an emptied stand-in back over the operator's plan is the same
 *     unrecoverable move the fatal branch exists to refuse, and it used to happen here on a no-op verb.
 * Both are a DIFFERENT failure from an unanswerable decision — see `validateDecisions`, which runs
 * UNCONDITIONALLY on whatever decisions reached the model.
 *
 * WHERE IT MAY WRITE. `--out=` and `--state=` are caller-controlled, so `assertWritablePath` refuses any path
 * that lands inside this repository but outside `reports/` — a tracked file must never be overwritten.
 * Outside the repository is allowed and normal: the board is published from a scratchpad path.
 *
 * THE URL-STABILITY RULE (why `artifactUrl` lives in the state file). Re-publishing the same file path keeps
 * the artifact URL only WITHIN the conversation that first published it. From any other session the publisher
 * must pass the stored URL as the Artifact `url` parameter or a NEW url is minted and the operator's bookmark
 * dies. So the URL is stored (`--url=…`) and printed on every render — see `we:skills-src/progress-board/SKILL.md`.
 *
 * CLI (every mutation re-renders; all verbs are idempotent; output is one line):
 *   node scripts/progress-board.mjs                      # re-render from live state
 *   node scripts/progress-board.mjs --start=<id>         # item → in-progress (also clears a blocker)
 *   node scripts/progress-board.mjs --done=<id>          # item → done
 *   node scripts/progress-board.mjs --block=<id> --why="…"
 *   node scripts/progress-board.mjs --note=<id> --text="…"   # empty text clears the note
 *   node scripts/progress-board.mjs --add="<title>" [--phase=<n>]
 *   node scripts/progress-board.mjs --retitle=<id> --to="<title>"   # the id (the join key) never moves
 *   node scripts/progress-board.mjs --remove=<id>        # drop a plan item
 *   node scripts/progress-board.mjs --link=<id> --pr=<n> # join a plan item to its pull request
 *   node scripts/progress-board.mjs --unlink=<id>
 *   node scripts/progress-board.mjs --phase-title=<n> --to="<title>"
 *   node scripts/progress-board.mjs --board-title="<title>" · --repo=<owner/name>
 *   node scripts/progress-board.mjs --decide=<id>        # a decision was taken by the operator
 *   node scripts/progress-board.mjs --url=<artifact-url> # store the published URL (do this once, after publishing)
 *
 * DECISIONS ARE THE PAGE'S ONLY ASK, so they carry more than a title, and that is ENFORCED rather than asked
 * for. Anything marked `awaiting` must be answerable from the page alone — a `question`, at least two real
 * `options` with exactly one recommended, and `ifNothing`. The tool refuses the flip to `awaiting` and
 * refuses to render a board that carries an incomplete one (exit 1, naming the id and every missing field);
 * an unfinished decision waits in `draft`, which never reaches the operator's section. `why` and `evidence`
 * are strongly encouraged and not blocking. Every field has a verb; none is ever hand-typed into JSON:
 *   node scripts/progress-board.mjs --decision-add="<title>" --question="…" --if-nothing="…" [--id=<id>] [--status=<s>]
 *   node scripts/progress-board.mjs --decision-set=<id> --field=<name> --value="…"   # empty --value clears
 *   node scripts/progress-board.mjs --decision-option=<id> --label="…" --detail="…" [--recommend]
 *   node scripts/progress-board.mjs --decision-evidence=<id> --text="…"              # empty --text clears all
 *   node scripts/progress-board.mjs --decision-remove=<id>                          # retires its R-number with it
 *
 * Flags: --state=<path> --out=<path> --no-gh --no-git --json --help.
 * Env:   WE_BOARD_NO_GH=1 (never shell out to gh), WE_BOARD_NO_GIT=1 (skip the weekly output-mix
 *        derivation), WE_BOARD_NOW=<iso> (freeze the stamp AND the week window, for tests).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOutputMix, ratioLabel } from './lib/output-mix.mjs';
import { CI_TRUTH_EXCLUDED_CHECKS, FAILING_CONCLUSIONS } from './operations/pr-status.mjs';
// #4260-ish (epic #3383/#4075) — LIVE INCIDENT 2026-09-26, PRs #2748/#2749/#2753: the SAME `latestRequiredCheck`
// read `merge-ai-prs.mjs`'s own ci-lifecycle label reconcile already trusts (#xkfv491's latest-run-wins rule),
// reused here so `classifyPr`'s stale-label fallback (below) can tell "the label is our only signal" apart from
// "the label is outdated — THIS read's own rollup already proves the required check green". Side-effect-free
// import (`merge-ai-prs.mjs`'s CLI is behind an `IS_CLI` guard, mirrored by `pr-watch.mjs`'s identical import).
import { isRequiredCheckGreen, isRequiredCheckPending } from './merge-ai-prs.mjs';
// #2925/#xkfv491 (we:backlog/fix-review-ciheal-deadlock) — sourced from its own dependency-free module rather
// than re-imported from `./merge-ai-prs.mjs` (where it also lives, re-exported) — see that lib module's own
// header for why `./operations/pr-status.mjs` needed this split; this file has no such constraint itself
// (it already imports `./merge-ai-prs.mjs` above) but there is no reason to prefer the heavier path either.
import { collapseRollupToLatestPerName } from './lib/rollup-collapse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STATE = join(ROOT, 'reports', 'progress-board.json');
const DEFAULT_OUT = join(ROOT, 'reports', 'progress-board.html');
const cachePathFor = (statePath) => join(dirname(statePath), '.progress-board-cache.json');

// ── Where this script may write ───────────────────────────────────────────────

/** Lexical `..` cannot escape a symlinked directory, so resolve the PARENT for real and re-attach the name. */
function realish(p) {
  const abs = resolve(p);
  const parent = dirname(abs);
  try {
    return join(realpathSync(parent), basename(abs));
  } catch {
    return abs; // the directory does not exist yet — nothing to follow, and mkdir will create it under ROOT rules
  }
}

const within = (dir, p) => {
  const rel = relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Repo-relative inside the repo, absolute outside it — never a wall of `../..` back out of the checkout. */
const shortPath = (p) => (within(ROOT, resolve(p)) ? relative(ROOT, resolve(p)) : resolve(p));

/**
 * `--out=` and `--state=` are the only paths a caller controls, and the thing worth protecting is a TRACKED
 * repository file: `--out=./package.json` would silently overwrite it. Writing OUTSIDE the repo is not the
 * danger and is in active use — the board is published from a scratchpad path — so the rule is deliberately
 * narrow: inside the repo, only `reports/` is writable; outside the repo, anywhere.
 *
 * @returns {string} the resolved path to use.
 */
export function assertWritablePath(p, flag) {
  const abs = realish(p);
  const root = realish(ROOT);
  if (!within(root, abs)) return abs; // outside the repository entirely — the caller's own disk, their call
  if (within(join(root, 'reports'), abs)) return abs;
  throw new Error(
    `refusing ${flag}=${p} — it resolves to ${relative(root, abs)} inside the repository, and the board may only write ` +
      `inside reports/ or to a path outside the repository entirely (overwriting a tracked file is never the intent).`,
  );
}

// ── State ─────────────────────────────────────────────────────────────────────

/** Item lifecycle. `blocked` is the only one that pulls an item into the operator's section. */
export const ITEM_STATUSES = ['todo', 'in-progress', 'blocked', 'done'];

/**
 * Decision lifecycle — four states, and the two middle ones carry the whole design:
 *   • `draft`    — being prepared. Not yet answerable, so it may NOT sit in the operator's section; it
 *                  renders low-emphasis near the bottom. This is the only place an incomplete decision may live.
 *   • `awaiting` — outstanding, and therefore COMPLETE: see `decisionGaps`. The operator has not ruled.
 *   • `queued`   — RULED, but deliberately deferred ("do it, when the priority is right"). It must stay on
 *                  the page (the ruling is a fact worth seeing) while reading as settled, so it renders in
 *                  its own section and is NEVER counted as needing the operator.
 *   • `taken`    — ruled and absorbed into the plan; the plan item now carries it, so it leaves the board.
 */
export const DECISION_STATUSES = ['draft', 'awaiting', 'queued', 'taken'];

/** The scalar decision fields `--decision-set` may write. `options` and `evidence` have their own verbs. */
export const DECISION_FIELDS = ['title', 'question', 'why', 'ifNothing', 'detail', 'status', 'preparedDate'];

/**
 * A list field, read defensively. `d.options ?? []` is NOT enough: a string has a `.length` (so the
 * "at least two" guard falls straight through) and then `.filter` throws a raw TypeError out of the
 * renderer — dying on the operator's data instead of degrading on it, which is the opposite of the
 * contract `loadState` states. `loadState` normalises the CONTAINER keys but deliberately never rewrites
 * the inside of a decision, so a wrong type one level down reaches every reader raw. Every reader goes
 * through here; the writers refuse instead (see `requireListField`).
 */
const asList = (v) => (Array.isArray(v) ? v : []);

/**
 * THE ENFORCED CONTRACT. A decision presented to the operator has to be ANSWERABLE FROM THE PAGE — that is
 * the whole reason the board exists, and it is not left to whoever writes the next entry to remember.
 *
 * Optional context is the same as no context: the next entry goes in as a bare title, the page slides back
 * into a list of one-liners nobody can act on, and a convention in the skill will not stop it. So the fields
 * are REQUIRED on anything marked `awaiting`, the tool refuses the run when one is missing, and the only way
 * to hold an unfinished decision is `draft` — which never reaches the operator's section.
 *
 * `why` and `evidence` are strongly encouraged and deliberately NOT blocking: a decision can be genuinely
 * self-evident in its question, and a hard requirement there would only train people to type filler.
 *
 * @returns {string[]} the missing pieces, in the order the operator would need them. Empty = answerable.
 */
export function decisionGaps(d) {
  const gaps = [];
  if (!d?.question) gaps.push('question (--decision-set --field=question)');
  const options = asList(d?.options);
  if (options.length < 2) {
    // One option is not a decision, it is an announcement — and two is a perfectly good answer. The rule is
    // "at least two", never "pad to three".
    gaps.push(`options: at least two, this has ${options.length} (--decision-option --label=… --detail=…)`);
  } else if (options.filter((o) => o.recommended).length !== 1) {
    gaps.push('exactly one option marked recommended (--decision-option --label=… --recommend)');
  }
  if (!d?.ifNothing) gaps.push('ifNothing — what breaks if it is never answered (--decision-set --field=ifNothing)');
  return gaps;
}

/** Every unanswerable `awaiting` decision on the board, as one message each. Empty = the board may render. */
export function validateDecisions(state) {
  return (state.decisions ?? [])
    .filter((d) => (d.status ?? 'awaiting') === 'awaiting')
    .map((d) => [d, decisionGaps(d)])
    .filter(([, gaps]) => gaps.length)
    .map(([d, gaps]) => `decision "${d.id}" is awaiting the operator but cannot be answered from the page — missing ${gaps.join(' · ')}`);
}

const EMPTY_STATE = {
  title: 'Progress board',
  repo: null,
  artifactUrl: null,
  nextRuling: 1,
  phases: {},
  items: [],
  decisions: [],
};

/**
 * RULING NUMBERS — `R1`, `R2`, … — exist because the operator answers these in chat: "R6 — as recommended".
 * A number derived from position (whatever order a message happened to list them in) means nothing the next
 * day, so the number is IDENTITY, not position:
 *   • assigned once, at creation, from a counter that lives in the state file, and persisted;
 *   • never renumbered when the list is reordered or filtered;
 *   • never reused. A decision that is taken or dropped RETIRES its number with it — the counter only ever
 *     moves forward, so "R2" can never later mean something else.
 * A decision that predates the scheme is backfilled once, on the next run, and then never moves again.
 *
 * "NEVER REUSED" IS STRUCTURAL, NOT A CONVENTION. Two things could regress the counter, and both are closed
 * here rather than left to whoever writes the next verb:
 *   • a MISSING counter key. `nextRuling` absent used to mean "start at 1", which re-issued R1/R2/R3 over
 *     decisions that already held them. The floor is therefore `highest R-number present + 1`, always.
 *   • a REMOVED decision. Deleting R2 drops it out of that `highest` scan, so the floor alone is not enough:
 *     the stored counter is the memory of numbers that are gone. The counter is written as the MAXIMUM of
 *     (what was read, the floor, where we got to) — it is monotonic by construction and can only move up.
 *   • a NORMALISED `decisions` key. `loadState` empties a wrong-typed container, so a floor computed from
 *     `state.decisions` is a floor over what SURVIVED normalisation, not over what the file said. With
 *     `decisions` as an object map that floor was 1 and `R1` — already in use — was handed out again. The
 *     floor is therefore also taken from the RAW value, whatever shape it had (`rulingFloor`).
 * `main` reconciles the counter before any verb runs, so a removal cannot delete the evidence either.
 *
 * @returns {number} how many numbers were assigned (non-zero means the state needs saving).
 */
export function ensureRulingNumbers(state) {
  let assigned = 0;
  const numberOf = (r) => {
    const m = /^R(\d+)$/i.exec(String(r ?? ''));
    return m ? Number(m[1]) : 0;
  };
  const stored = Number.isInteger(state.nextRuling) && state.nextRuling > 0 ? state.nextRuling : 1;
  const asRead = Number.isInteger(state[STATE_RULING_FLOOR]) ? state[STATE_RULING_FLOOR] : 1;
  const floor = Math.max(asRead, Math.max(0, ...(state.decisions ?? []).map((d) => numberOf(d?.ruling))) + 1);
  let next = Math.max(stored, floor);
  // Never hand back a number that is already in use — a hand-edited counter must not create a duplicate.
  const taken = new Set((state.decisions ?? []).map((d) => d?.ruling).filter(Boolean));
  for (const d of state.decisions ?? []) {
    if (d.ruling) continue;
    while (taken.has(`R${next}`)) next += 1;
    d.ruling = `R${next}`;
    taken.add(d.ruling);
    next += 1;
    assigned += 1;
  }
  state.nextRuling = Math.max(stored, floor, next);
  return assigned;
}

/**
 * The lowest ruling number that is safe to hand out, read from the `decisions` value AS IT WAS IN THE FILE —
 * before any normalisation, and whatever shape it took. This exists because a wrong-typed container is
 * emptied for rendering, and a counter reconciled from the emptied view re-issues numbers that are still in
 * use elsewhere in the file. A reused R-number is worse than an ordinary bug: the operator answers "R4 — as
 * recommended" in chat, so a number that means two things lands a ruling on the wrong decision.
 *
 * Deliberately shape-blind: an array, an object map (values AND keys — a hand-authored file keyed by ruling
 * number is a real shape), and a bare string entry (`"R1 should we ship?"`) all give up their numbers.
 */
export function rulingFloor(rawDecisions) {
  const candidates = Array.isArray(rawDecisions)
    ? rawDecisions
    : rawDecisions && typeof rawDecisions === 'object'
      ? [...Object.values(rawDecisions), ...Object.keys(rawDecisions)]
      : [];
  let max = 0;
  for (const v of candidates) {
    // An object's number lives in `ruling` and must match exactly; a scalar entry is free text, so a leading
    // `R<n>` token counts. Both directions only ever raise the floor, never lower it.
    const m = v && typeof v === 'object' ? /^R(\d+)$/i.exec(String(v.ruling ?? '')) : /^R(\d+)\b/i.exec(String(v ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * Carries "this state file could not be read" alongside the fallback state. A SYMBOL on purpose:
 * `JSON.stringify` and `Object.keys` both skip it, so `saveState` can never write the complaint back into
 * the file it is complaining about.
 */
export const STATE_ERROR = Symbol('progress-board.stateError');

/**
 * Set alongside `STATE_ERROR` when NOTHING survived the read — the file did not parse, so the returned state
 * is the empty fallback and not a partial view of the operator's plan. This is the ONLY case in which a verb
 * is refused, and it is exactly the case in which there is no surviving decision to validate. A partial
 * (right-shape, wrong-type) read carries `STATE_ERROR` WITHOUT this, because its data is real.
 */
export const STATE_FATAL = Symbol('progress-board.stateFatal');

/**
 * THE KEYS WHOSE NORMALISED VIEW IS A LIE, mapped to the value the file actually held. A `Map` under a
 * symbol for the same reason as above: `saveState` must be able to reach it, and `JSON.stringify` must not.
 *
 * This is the fix for the worst bug this tool has had. `loadState` normalises a wrong-typed `items` or
 * `decisions` to `[]` so the page can render — and `saveState` then wrote that `[]` back over the file.
 * A single IDEMPOTENT NO-OP verb (`--board-title` on a board already so titled, which reported "already
 * titled") permanently destroyed every plan row, at exit 0, with the page's own banner insisting that
 * "the rest of the plan half below is the file as written". That is exactly the destruction the fatal
 * branch refuses verbs to prevent, happening in the branch that told itself nothing was lost.
 *
 * So the normalisation is now RENDER-ONLY. Two rules, and they are the whole of it:
 *   • `saveState` re-emits the raw value for every key in here, so a key the board could not read is
 *     written back exactly as the operator wrote it. A key we do not understand is not ours to delete.
 *   • `main` refuses any verb that writes to such a key (`VERB_TARGET`) — because the alternative is a verb
 *     that reports success onto the emptied view and then has its work silently dropped by the re-emit.
 * Verbs that write anywhere ELSE stay open, so the board stays usable and the deadlock stays closed.
 */
export const STATE_UNREADABLE = Symbol('progress-board.stateUnreadable');

/** The ruling-number floor computed from the RAW `decisions` value — see `rulingFloor`. */
export const STATE_RULING_FLOOR = Symbol('progress-board.stateRulingFloor');

/**
 * Read the hand-maintained half — and DEGRADE rather than die, the same contract the `gh` half already
 * honours. The realistic trigger is not exotic: this file is git-tracked, so an unresolved merge-conflict
 * marker makes it invalid JSON, and a crash there loses the whole page over a fixable typo.
 *
 * An UNPARSEABLE file yields the empty state plus `[STATE_ERROR]` and `[STATE_FATAL]`: a loud banner ON THE
 * PAGE and a refusal to write verbs (writing an empty plan over a recoverable file is the one genuinely
 * unrecoverable move). A file that parsed but held one wrong-typed key yields `[STATE_ERROR]` ALONE — its
 * items and decisions are the operator's real data, so the verbs stay open and the answerability guard
 * applies in full. A well-formed file with an unanswerable decision is a DIFFERENT failure and is not routed
 * through here at all — see `validateDecisions`.
 */
export function loadState(statePath) {
  if (!existsSync(statePath)) return { ...EMPTY_STATE };

  let raw;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    const broken = { ...EMPTY_STATE };
    broken[STATE_ERROR] = `${shortPath(statePath)} is not valid JSON — ${e.message}`;
    broken[STATE_FATAL] = true;
    return broken;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const broken = { ...EMPTY_STATE };
    broken[STATE_ERROR] = `${shortPath(statePath)} does not hold a JSON object`;
    broken[STATE_FATAL] = true;
    return broken;
  }

  // Right shape, wrong types: a string where a list belongs takes out every `.filter`/`.map` downstream.
  // Normalise to something renderable and say which key was wrong — never guess at what it meant, and
  // (see STATE_UNREADABLE) never write the guess back over the file either.
  const state = { ...EMPTY_STATE, ...raw };
  const wrong = [];
  const unreadable = new Map();
  for (const key of ['items', 'decisions']) {
    if (!Array.isArray(state[key])) {
      wrong.push(key);
      unreadable.set(key, raw[key]);
      state[key] = [];
    } else {
      state[key] = state[key].filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      // ABSENT is not WRONG. `items` omitted leaves the `[]` from EMPTY_STATE, and `0 !== undefined` used to
      // report a type error for a key the file was simply allowed to leave out — a lie in the banner, and
      // (before the guard was made unconditional) one absent optional key was enough to disarm it.
      if (Array.isArray(raw[key]) && state[key].length !== raw[key].length) {
        wrong.push(`${key} (entries that were not objects)`);
        // The dropped entries are unreadable, not disposable: re-emit the whole array as it was read. The
        // surviving objects are shared by reference with it, so a verb's edit to one still persists.
        unreadable.set(key, raw[key]);
      }
    }
  }
  if (!state.phases || typeof state.phases !== 'object' || Array.isArray(state.phases)) {
    wrong.push('phases');
    unreadable.set('phases', raw.phases);
    state.phases = {};
  }
  // One level DOWN, inside a decision. Not normalised — rewriting the inside of an entry is guessing, and
  // guessing is what destroyed data here before. It is named in the banner, read through `asList`, and the
  // writers refuse; the entry itself is left exactly as written, so it round-trips through `saveState`.
  for (const d of state.decisions) {
    for (const field of ['options', 'evidence']) {
      if (d[field] !== undefined && !Array.isArray(d[field])) wrong.push(`decision "${d.id}".${field}`);
    }
  }
  if (wrong.length) state[STATE_ERROR] = `${shortPath(statePath)} has the wrong type for: ${wrong.join(', ')} — ignored`;
  if (unreadable.size) state[STATE_UNREADABLE] = unreadable;
  // Reconciled from the RAW value, so a container the board could not read still cannot cause a reissue.
  state[STATE_RULING_FLOOR] = rulingFloor(raw.decisions);
  return state;
}

export function saveState(statePath, state) {
  // A key the read could not understand is written back EXACTLY as it was found — the normalisation that
  // made the page renderable never reaches the file. See STATE_UNREADABLE for what this is protecting.
  const unreadable = state[STATE_UNREADABLE];
  // `_`-prefixed keys are notes to the next human reader; keep them at the TOP where they are read, rather
  // than wherever the merge with the defaults happens to leave them.
  const keys = Object.keys(state);
  const ordered = Object.fromEntries(
    [...keys.filter((k) => k.startsWith('_')), ...keys.filter((k) => !k.startsWith('_'))].map((k) => [
      k,
      unreadable?.has(k) ? unreadable.get(k) : state[k],
    ]),
  );
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(ordered, null, 2) + '\n');
}

/** A stable, readable id from a title — the `--add` verb's key, so re-adding the same title is a no-op. */
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
}

// ── Live PR derivation ────────────────────────────────────────────────────────

const PR_FIELDS = 'number,title,labels,mergeStateStatus,statusCheckRollup,state,mergedAt';

/** Shell out to `gh`. Returns parsed JSON, or null on ANY failure (missing binary, auth, network, rate limit). */
function ghPrList(repo, args) {
  const argv = ['pr', 'list', '--json', PR_FIELDS, ...args];
  if (repo) argv.push('--repo', repo);
  try {
    const out = execFileSync('gh', argv, { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the check rollup carries at least one hard failure (vs merely pending). By default IGNORES any
 *  check named in {@link CI_TRUTH_EXCLUDED_CHECKS} (`we:scripts/operations/pr-status.mjs`) — those checks
 *  report review/merge-gate state, not code health; see that constant's docblock for the full incident.
 *
 *  `requiredChecks`, WHEN A CALLER SUPPLIES ONE, REPLACES THAT EXCLUSION LIST WITH THE INVERSE (and stronger)
 *  QUESTION: a check counts toward "failed" only if its name is in `requiredChecks` — i.e. only a REQUIRED
 *  check (per branch protection, `we:scripts/lib/required-status-checks.mjs`) can make this read failed at
 *  all. This is deliberately future-proof in a way the exclusion list structurally cannot be: a brand-new
 *  advisory workflow is, by construction, not yet in branch protection's required set, so it can never cause
 *  a false red here even before anyone thinks to add its name to {@link CI_TRUTH_EXCLUDED_CHECKS} — exactly
 *  the gap the exclusion list left open (LIVE INCIDENT 2026-09-26, PR #2748 (web-everything/web-everything): the new
 *  `soak-replay-gate` advisory check, PR #2775, went red on a PR whose every required check was green, and
 *  every exclusion-list-based reader misread it as a genuine CI failure until `soak-replay-gate` was added to
 *  the list by hand). `requiredChecks` omitted/empty falls back to the exclusion-list behaviour unchanged, so
 *  every existing one-argument call site keeps its exact prior behaviour with no code change required.
 *
 *  SINGLE-SOURCED off {@link FAILING_CONCLUSIONS} (`we:scripts/operations/pr-status.mjs`, #xznd5za) — this used
 *  to hand-roll its OWN, narrower conclusion list (`FAILURE`/`TIMED_OUT`/`ACTION_REQUIRED`/`STARTUP_FAILURE`
 *  only) that silently OMITTED `CANCELLED` (and `STALE`), while `FAILING_CONCLUSIONS` and
 *  `we:scripts/merge-ai-prs.mjs#isRequiredCheckFailed` both already treat a cancelled run as failing ("a real
 *  hang/kill leaves no readable verdict, so it must not read as clean" — see that function's own docblock).
 *  LIVE INCIDENT 2026-09-25, PR #2636 (web-everything/web-everything): the daemon's own hung-ci-recovery cancelled the
 *  hung `test-shard (1)` run once its OWN cap was exhausted (`cancelled-no-rerun`, cap-exhausted, never re-run)
 *  — `classifyPr` (which calls this function, and ONLY this function, for CI truth) then read the rollup as
 *  having zero failing checks and returned phase `'open'` instead of `'ci-red'`, so `reconcile-core.mjs`'s
 *  entire `ci-red` branch (the ci-heal dispatch AND its cap-exhausted escalation) was skipped outright — the PR
 *  fell straight through to `nothing-owed`, forever, despite `we:scripts/conveyor/main-red-recovery.mjs`'s own
 *  attribution check (fed by the DIFFERENT, already-correct `isRequiredCheckFailed`) independently confirming
 *  "the required check failed … owed a ci-heal, not a rebase" on the very same tick. Two predicates for the same
 *  question, one of them wrong, is the defect — reusing `FAILING_CONCLUSIONS` here removes the second
 *  derivation entirely.
 *
 *  COLLAPSED TO THE LATEST RUN PER CHECK NAME FIRST (`collapseRollupToLatestPerName`, #2925/#xkfv491) —
 *  LIVE DEADLOCK 2026-09-28/29, PR #2878 (web-everything/web-everything): `review-gate` re-runs on every `labeled`/
 *  `unlabeled` event (`.github/workflows/review-gate.yml`), and once a repo's branch protection grows a SECOND
 *  gate-shaped required check that reruns more than once per head (here `soak-replay-gate`, added to
 *  `required_status_checks.contexts` after the earlier `CI_TRUTH_EXCLUDED_CHECKS`-only era — see that
 *  constant's own header), a single HEAD can carry BOTH a stale `FAILURE` run and a later `SUCCESS` rerun of the
 *  SAME required check name in one `statusCheckRollup` fetch. `requiredChecks` (live branch protection,
 *  `we:scripts/lib/required-status-checks.mjs`) REPLACES the exclusion list once supplied (see this function's
 *  own header above) — so a required-check name that is ALSO on `CI_TRUTH_EXCLUDED_CHECKS` is no longer excused
 *  by that list, and a bare `.some()` over the raw array found the stale, already-superseded `FAILURE` run and
 *  read the PR `ci-red` forever, even though its LATEST run (and every OTHER required check: `test`, `smoke`,
 *  `daemon-soak`) was green — dispatching a ci-heal that could only ever escalate "not a CI break — the only
 *  red check is review-gate", which then durably blocked review dispatch too (`reconcile-core.mjs`'s
 *  `ci-heal-escalated` refusal). `we:scripts/merge-ai-prs.mjs#isRequiredCheckGreen`/`isRequiredCheckFailed`
 *  already fixed this exact class of defect for their own (single-check) reads under #2925/#xkfv491 — this is
 *  that SAME collapse, applied here so a wholesale "did anything fail" scan cannot re-derive the bug the
 *  per-check reader already closed.
 *  @param {Array<{name?: string, conclusion?: string, state?: string}>} rollup
 *  @param {string[]} [requiredChecks] - the repo's required status-check names (branch protection); when
 *    given and non-empty, ONLY these names can count as CI truth (see above).
 */
export function ciFailed(rollup, requiredChecks) {
  const required = Array.isArray(requiredChecks) && requiredChecks.length ? requiredChecks : null;
  return collapseRollupToLatestPerName(rollup).some((c) => {
    const name = String(c?.name ?? '');
    if (required) {
      if (!required.includes(name)) return false;
    } else if (CI_TRUTH_EXCLUDED_CHECKS.includes(name)) {
      return false;
    }
    const v = String(c?.conclusion ?? c?.state ?? '').toLowerCase();
    return FAILING_CONCLUSIONS.includes(v);
  });
}

/** True while any check is still running — the difference between "queued" and "queued, green". */
export function ciPending(rollup) {
  return (rollup ?? []).some((c) => {
    const v = String(c?.conclusion ?? c?.state ?? '').toUpperCase();
    return v === '' || v === 'PENDING' || v === 'IN_PROGRESS' || v === 'QUEUED' || v === 'WAITING';
  });
}

/**
 * The board's PR vocabulary, ranked by who is holding the ball. Lower `rank` = more consequential.
 *
 * `needs-human` is the ONLY status that means "the operator personally". Note that a reviewer-wants-changes
 * PR outranks it deliberately: `review:changes` moves the ball to the AUTHOR LANE, so a PR carrying both
 * labels is the author's problem, not the operator's — putting it in the operator's section would bury the
 * one PR that genuinely awaits their clear.
 */
export const PR_STATUS = Object.freeze({
  'needs-human': { rank: 0, sev: 'crit', label: 'awaiting your clear', gloss: 'a human must review this before it can land' },
  bounced: { rank: 1, sev: 'warn', label: 'changes requested', gloss: 'back with the author lane to fix and re-push' },
  'ci-red': { rank: 2, sev: 'warn', label: 'CI red', gloss: 'a required check failed' },
  conflicted: { rank: 3, sev: 'warn', label: 'conflicted', gloss: 'needs a rebase before it can merge' },
  'needs-review': { rank: 4, sev: 'info', label: 'awaiting review', gloss: 'parked for an independent review pass' },
  queued: { rank: 5, sev: 'info', label: 'queued to land', gloss: 'reviewed and waiting on the merge queue' },
  open: { rank: 6, sev: 'muted', label: 'open', gloss: 'in progress, no hold recorded' },
  landed: { rank: 7, sev: 'ok', label: 'landed', gloss: '' },
});

/** Reduce one raw `gh` PR record to a single board status. Pure — the whole derivation lives here.
 *  @param {object} pr
 *  @param {string[]} [requiredChecks] - threaded straight through to {@link ciFailed}; see its own docblock. */
export function classifyPr(pr, requiredChecks) {
  const labels = new Set((pr?.labels ?? []).map((l) => l?.name).filter(Boolean));
  const merge = String(pr?.mergeStateStatus ?? '').toUpperCase();
  if (String(pr?.state ?? '').toUpperCase() === 'MERGED') return 'landed';
  if (labels.has('review:changes')) return 'bounced';
  // `review:accepted` SUPERSEDES `review:human`: the human hold has already been cleared, so the PR is
  // waiting on the merge queue, not on the operator. Without this an accepted PR sits in their section forever.
  if (labels.has('review:human') && !labels.has('review:accepted')) return 'needs-human';
  // xx6kg3f (epic #3383/#4075) — LIVE INCIDENT 2026-09-26, PR #2739 (web-everything/web-everything): `ciFailed`
  // is ONLY as current as the ONE `statusCheckRollup` a caller happened to fetch this tick. This file's own
  // header already treats a degraded `gh` read as a normal, expected mode ("`gh` missing, unauthenticated,
  // offline or rate-limited must not lose the page") — but `classifyPr` itself never carried that principle
  // into the ci-red branch: a caller whose OWN read came back with an empty or partial rollup (a rate limit,
  // a partial GraphQL page, a `gh` hiccup — never a proof the check is actually green) had `ciFailed([])`
  // read `false`, and an ALREADY-failed, ALREADY-accepted PR fell straight through to `queued` — reading as
  // safe to land. The durable `ci:failed` label (`we:scripts/merge-ai-prs.mjs#CI_LIFECYCLE_LABELS.failed`,
  // reconciled from `isRequiredCheckFailed`'s own LATEST-run read of the SAME required check, #2421) is a
  // SEPARATE, independently-refreshed record of the identical fact — trusting it here costs nothing when the
  // live rollup already agrees (the common case) and closes exactly this gap when it does not: a stale
  // `ci:failed` label can at worst cost one wasted, harmless ci-heal dispatch (ci-heal never touches a
  // `review:*` label and stands down once it finds nothing red — `we:scripts/operations/ci-heal-pr-dispatch.mjs`'s
  // own header) against the alternative this incident lived through — an accepted, genuinely red PR reading
  // as `queued`/nothing-owed indefinitely. OR'd with the live scan, never a replacement for it.
  if (ciFailed(pr?.statusCheckRollup, requiredChecks)) return 'ci-red';
  // xg790dh-follow-up (epic #3383/#4075) — LIVE INCIDENT 2026-09-26, PRs #2748/#2749/#2753 (chalbert/web-
  // everything): six ci-heal sessions in a row correctly found "no CI break — only `review-gate` is red (by
  // design, while `review:pending` stands)" and stood down, yet the PR kept reading `ci-red` and kept getting
  // re-dispatched, because the line above trusted a STALE `ci:failed` label UNCONDITIONALLY — even on a read
  // whose OWN rollup affirmatively proves the required check green right now. The xx6kg3f fix (above this
  // block's history) added the label fallback for the OPPOSITE gap — a rollup that came back empty/degraded and
  // so could not prove anything — and that gap still needs the fallback: for a MISSING check specifically, both
  // `isRequiredCheckGreen` and `isRequiredCheckPending` read `false` (see the latter's own docblock), so an
  // empty rollup still falls through to trust the label exactly as xx6kg3f fixed it (see the two pinned tests,
  // `pr2739Labels`, immediately below).
  //
  // we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — `!isRequiredCheckGreen(pr)` ALONE is true
  // for BOTH "concluded failed" and "restarted, not concluded yet" — the second is exactly what a mechanical
  // rebase produces the instant it re-triggers CI, and it is not evidence of a defect, it is evidence CI has
  // not spoken yet. LIVE INCIDENT 2026-09-26/27: `main` went red then green, the mechanical rebase
  // (`ci-red-recovery-watch.mjs`) rebased each stuck PR onto the new tip and re-ran CI, and every one of them
  // still carried this stale `ci:failed` label from before the rebase — this line trusted it while the new run
  // was still `pending` (or had already gone green by the time a ci-heal session actually looked), dispatching
  // a wasted Opus/Sonnet ci-heal each time (of ~10 such sessions inside one hour, 7 — PRs #2782/#2778/#2772/
  // #2779/… — ended "no change needed"). Only a rollup that POSITIVELY reports the required check's LATEST run
  // as either green OR a COMPLETED failure may settle the question at all; a rollup that shows it merely
  // in flight must wait for it to conclude, exactly like an empty rollup already does — the label alone is
  // never enough once the live read has ANY opinion.
  if (labels.has('ci:failed') && !isRequiredCheckGreen(pr) && !isRequiredCheckPending(pr)) return 'ci-red';
  if (merge === 'DIRTY' || merge === 'BEHIND') return 'conflicted';
  if (labels.has('review:pending')) return 'needs-review';
  if (labels.has('review:accepted') || labels.has('ready-to-merge')) return 'queued';
  return 'open';
}

/** A one-line human detail under a PR row: the extra fact the status alone does not carry. */
function prDetail(pr, status) {
  const merge = String(pr?.mergeStateStatus ?? '').toUpperCase();
  if (status === 'landed') return pr.mergedAt ? `merged ${pr.mergedAt.slice(0, 10)}` : 'merged';
  if (status === 'conflicted') return merge === 'BEHIND' ? 'behind main — needs a rebase' : 'conflicting with main';
  // A bounced PR is going to be re-pushed, so whatever its checks are doing right now is noise against the
  // one fact that matters (a reviewer wants changes).
  if (status !== 'bounced' && ciPending(pr?.statusCheckRollup)) return 'checks still running';
  if (merge === 'BLOCKED') return 'merge blocked by branch protection';
  return '';
}

/** Shrink a raw `gh` record to what the page needs (this is also the cache shape). */
const toRow = (pr) => ({
  number: pr.number,
  title: pr.title,
  labels: (pr.labels ?? []).map((l) => l.name).filter(Boolean),
  status: classifyPr(pr),
  detail: prDetail(pr, classifyPr(pr)),
});

/** How many open PRs one page of the board can hold. At the limit the list may be truncated — say so. */
export const OPEN_LIMIT = 30;

/**
 * Fetch open + recently-merged PRs, cache on success, fall back to the cache on failure.
 *
 * TWO CALLS, SO THREE OUTCOMES, NOT TWO. Treating anything short of a total failure as success is how a board
 * renders a confident-looking lie: with only the merged list failing, "Landed" said "Nothing landed yet",
 * the header said the state was read live, and the truncated snapshot then OVERWROTE the last good cache —
 * destroying the very rows the next failure would have fallen back to. So a partial read:
 *   • keeps the landed rows from the cache rather than showing none,
 *   • reports `fresh: false` with a reason that names what could not be read, and
 *   • does NOT write the cache. A less complete snapshot must never replace a more complete one.
 *
 * @returns {{ rows: object[], fresh: boolean, partial: boolean, fetchedAt: string|null, reason: string|null, truncated: boolean }}
 */
export function fetchPrs({ repo, statePath, useGh = true }) {
  const cacheFile = cachePathFor(statePath);
  const readCache = () => {
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
      return Array.isArray(c?.rows) ? c : null;
    } catch {
      return null;
    }
  };

  if (!useGh) {
    const c = readCache();
    return {
      rows: c?.rows ?? [],
      fresh: false,
      fetchedAt: c?.fetchedAt ?? null,
      reason: 'live PR lookup disabled for this run',
      truncated: false,
      partial: false,
    };
  }

  const open = ghPrList(repo, ['--state=open', '--limit', String(OPEN_LIMIT)]);
  const merged = ghPrList(repo, ['--state=merged', '--limit', '6']);
  if (open === null) {
    const c = readCache();
    return {
      rows: c?.rows ?? [],
      fresh: false,
      fetchedAt: c?.fetchedAt ?? null,
      reason: c ? 'GitHub was unreachable — showing the last good snapshot' : 'GitHub was unreachable and no snapshot was cached',
      truncated: false,
      partial: false,
    };
  }

  const openRows = open.map(toRow);
  const truncated = openRows.length >= OPEN_LIMIT;

  if (merged === null) {
    const c = readCache();
    const cachedLanded = (c?.rows ?? []).filter((r) => r?.status === 'landed');
    return {
      rows: [...openRows, ...cachedLanded],
      fresh: false,
      fetchedAt: c?.fetchedAt ?? null,
      truncated,
      partial: true,
      reason: cachedLanded.length
        ? 'the merged-pull-request list could not be read — open pull requests below are live, but "Landed" is from the last good snapshot'
        : 'the merged-pull-request list could not be read — open pull requests below are live, but "Landed" is MISSING, not empty',
    };
  }

  const rows = [...openRows, ...merged.map((pr) => ({ ...toRow(pr), status: 'landed', detail: prDetail(pr, 'landed') }))];
  const fetchedAt = nowIso();
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt, rows }, null, 2) + '\n');
  } catch {
    /* the cache is an optimisation — never fail a render over it */
  }
  return { rows, fresh: true, fetchedAt, reason: null, truncated, partial: false };
}

// ── Model ─────────────────────────────────────────────────────────────────────

const nowIso = () => (process.env.WE_BOARD_NOW || new Date().toISOString());

/** "2026-08-08 14:23 UTC" — one unambiguous stamp, no locale surprises. */
function stampOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const ITEM_CHIP = Object.freeze({
  blocked: { sev: 'crit', label: 'blocked' },
  'in-progress': { sev: 'info', label: 'in progress' },
  todo: { sev: 'muted', label: 'not started' },
  done: { sev: 'ok', label: 'done' },
});

/**
 * Join the hand-maintained state to the live PR rows and sort everything by consequence.
 * Pure — takes the already-fetched rows, returns exactly what the renderer prints.
 */
export function buildModel(state, prs, outputMix = null) {
  const rows = [...prs.rows].sort(
    (a, b) => (PR_STATUS[a.status]?.rank ?? 9) - (PR_STATUS[b.status]?.rank ?? 9) || b.number - a.number,
  );
  const byPr = new Map(rows.map((r) => [r.number, r]));
  const items = (state.items ?? []).map((it) => ({ ...it, prRow: it.pr ? byPr.get(Number(it.pr)) ?? null : null }));

  // A decision with no status recorded is outstanding — the safe default, since an un-set status must never
  // quietly hide something the operator has not actually ruled on.
  const decisions = (state.decisions ?? []).map((d) => ({ ...d, status: d.status ?? 'awaiting' }));
  const needsYou = {
    decisions: decisions.filter((d) => d.status === 'awaiting'),
    prs: rows.filter((r) => r.status === 'needs-human'),
    items: items.filter((i) => i.status === 'blocked'),
  };
  // Ruled-and-queued decisions are shown, but OUTSIDE the operator's section and out of its count: the ask
  // has already been answered, and re-presenting it as outstanding is exactly the noise the board exists to cut.
  const ruled = decisions.filter((d) => d.status === 'queued');
  // Drafts are the only place an unanswerable decision may sit, and they sit far away from the operator's
  // section on purpose — a half-written question in "needs you" is worse than no entry at all.
  const drafts = decisions.filter((d) => d.status === 'draft');
  // An in-progress item whose PR is on the board is ALREADY represented by that PR row (with a live status
  // the item cannot have). Listing both says the same thing twice, so only PR-less items appear here; the
  // plan table below is where every item, joined to its PR, is enumerated.
  const inFlight = {
    prs: rows.filter((r) => !['needs-human', 'landed'].includes(r.status)),
    items: items.filter((i) => i.status === 'in-progress' && !i.prRow),
  };
  const landed = { prs: rows.filter((r) => r.status === 'landed'), items: items.filter((i) => i.status === 'done') };

  const phaseOrder = [...new Set(items.map((i) => Number(i.phase) || 0))].sort((a, b) => a - b);
  const plan = phaseOrder.map((n) => ({
    phase: n,
    title: state.phases?.[String(n)] ?? (n ? `Phase ${n}` : 'Unphased'),
    items: items.filter((i) => (Number(i.phase) || 0) === n),
  }));

  return {
    title: state.title ?? EMPTY_STATE.title,
    repo: state.repo ?? null,
    artifactUrl: state.artifactUrl ?? null,
    stateError: state[STATE_ERROR] ?? null,
    stateFatal: Boolean(state[STATE_FATAL]),
    generatedAt: nowIso(),
    prs: { ...prs, rows },
    // Derived like the PR half and, like it, allowed to be absent: a git read that failed renders an honest
    // note rather than taking the page down or showing a stale number from some other tree.
    outputMix,
    counts: {
      needsYou: needsYou.decisions.length + needsYou.prs.length + needsYou.items.length,
      inFlight: inFlight.items.length + inFlight.prs.length,
      done: landed.items.length,
      total: items.length,
    },
    needsYou,
    ruled,
    drafts,
    inFlight,
    landed,
    plan,
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The palette lives ONCE per theme and is emitted into four places (`:root`, the
 * `prefers-color-scheme` block, and both `data-theme` overrides) so the viewer's own toggle wins in
 * BOTH directions. Components style through the tokens only — never a raw colour.
 *
 * The neutral is a cool graphite (a considered grey with a blue cast), not the default mid-grey; the
 * accent is a muted steel-teal that stays legible on both surfaces without competing with the severity
 * colours, which are the only saturated things on the page.
 */
const LIGHT = {
  '--bg': '#f5f7f8',
  '--surface': '#ffffff',
  '--surface-2': '#eef1f3',
  '--ink': '#12171b',
  '--ink-2': '#59646c',
  '--line': '#dde3e7',
  '--accent': '#0e6a74',
  '--crit': '#a32b28',
  '--crit-bg': '#fbebea',
  '--warn': '#8a5708',
  '--warn-bg': '#fbf2e2',
  '--ok': '#1d6b46',
  '--ok-bg': '#e8f4ed',
  '--info': '#2f5a78',
  '--info-bg': '#ecf2f7',
  '--muted': '#59646c',
  '--muted-bg': '#eef1f3',
};

const DARK = {
  '--bg': '#12171a',
  '--surface': '#191f23',
  '--surface-2': '#212a2f',
  '--ink': '#e4eaee',
  '--ink-2': '#95a2aa',
  '--line': '#2a343a',
  '--accent': '#5bbcc6',
  '--crit': '#f5938c',
  '--crit-bg': '#38201f',
  '--warn': '#e0b064',
  '--warn-bg': '#352a16',
  '--ok': '#78cfa1',
  '--ok-bg': '#173226',
  '--info': '#93c2df',
  '--info-bg': '#1a2b36',
  '--muted': '#95a2aa',
  '--muted-bg': '#212a2f',
};

const vars = (t) =>
  Object.entries(t)
    .map(([k, v]) => `    ${k}: ${v};`)
    .join('\n');

const css = () => `
:root {
${vars(LIGHT)}
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
${vars(DARK)}
  }
}
:root[data-theme="dark"] {
${vars(DARK)}
}
:root[data-theme="light"] {
${vars(LIGHT)}
}

* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1.25rem 4rem;
  background: var(--bg);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  overflow-x: hidden;
}
.wrap { max-width: 62rem; margin: 0 auto; }
code, .mono, .pr-num, .lbl { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }

header.board { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.5rem; line-height: 1.2; margin: 0 0 .4rem; letter-spacing: -0.01em; }
.meta { display: flex; flex-wrap: wrap; gap: .4rem 1rem; color: var(--ink-2); font-size: .8125rem; }
.meta .mono { color: var(--ink-2); }
.stamp strong { color: var(--ink); font-weight: 600; }

.tiles { display: flex; flex-wrap: wrap; gap: .625rem; margin: 1.25rem 0 2rem; }
.tile {
  flex: 1 1 8rem; background: var(--surface); border: 1px solid var(--line);
  border-radius: 6px; padding: .625rem .75rem;
}
.tile .n { font-size: 1.5rem; font-weight: 650; line-height: 1.1; }
.tile .k { font-size: .75rem; color: var(--ink-2); text-transform: uppercase; letter-spacing: .06em; }
.tile.crit .n { color: var(--crit); }
.tile.info .n { color: var(--info); }
.tile.ok .n { color: var(--ok); }

section { margin-bottom: 2.25rem; }
h2 { font-size: .8125rem; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-2); margin: 0 0 .25rem; font-weight: 650; }
.sub { color: var(--ink-2); font-size: .8125rem; margin: 0 0 .875rem; }

.row {
  display: flex; gap: .75rem; align-items: flex-start;
  background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--muted);
  border-radius: 5px; padding: .625rem .75rem; margin-bottom: .5rem;
}
.row.crit { border-left-color: var(--crit); }
.row.warn { border-left-color: var(--warn); }
.row.info { border-left-color: var(--info); }
.row.ok { border-left-color: var(--ok); }
.row .body { flex: 1 1 auto; min-width: 0; }
.row .t { font-weight: 550; }
.row .d { color: var(--ink-2); font-size: .8125rem; margin-top: .125rem; }
.pr-num { color: var(--ink-2); font-size: .8125rem; }

.chip {
  flex: 0 0 auto; font-size: .6875rem; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;
  padding: .1875rem .4375rem; border-radius: 3px; white-space: nowrap;
}
.chip.crit { color: var(--crit); background: var(--crit-bg); }
.chip.warn { color: var(--warn); background: var(--warn-bg); }
.chip.info { color: var(--info); background: var(--info-bg); }
.chip.ok { color: var(--ok); background: var(--ok-bg); }
.chip.muted { color: var(--muted); background: var(--muted-bg); }

.lbl { font-size: .6875rem; color: var(--ink-2); background: var(--surface-2); border-radius: 3px; padding: .0625rem .3125rem; margin-right: .25rem; }

/* Decisions are the only thing on the page that ask the operator for an answer, so theirs is the only row
   that earns more than two lines. Same stripe, same chips, same tokens — just the full case, stacked. */
.row.decision { padding: .8125rem .875rem; }
.row.decision .t { font-size: 1rem; line-height: 1.35; font-weight: 650; }
/* The ruling number is how the operator ANSWERS — they read it off the page and reply "R6 — as recommended".
   It has to be findable at a glance, so it is the one accent-coloured thing inside a decision card. */
.rnum {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: .8125rem; font-weight: 700; letter-spacing: .02em; color: var(--accent);
  border: 1px solid var(--accent); border-radius: 3px; padding: .0625rem .3125rem; margin-right: .4375rem;
  white-space: nowrap; vertical-align: .0625rem;
}
.dwhy { font-size: .8125rem; color: var(--ink-2); margin-top: .375rem; }
.opts { list-style: none; margin: .625rem 0 0; padding: 0; }
.opts li { background: var(--surface-2); border-radius: 4px; padding: .4375rem .5625rem; margin-bottom: .3125rem; font-size: .8125rem; color: var(--ink-2); }
.opts li:last-child { margin-bottom: 0; }
.opts li.rec { background: var(--ok-bg); }
.opts .ol { color: var(--ink); font-weight: 650; }
.opts .chip { margin-right: .375rem; vertical-align: .0625rem; }
.breaks { margin-top: .625rem; font-size: .8125rem; color: var(--crit); }
.breaks b { font-weight: 650; }
/* On a ruled or still-draft decision the cost of inaction is context, not an alarm — keeping it red would
   make a settled or unfinished row read as outstanding, which is what those two sections exist to prevent. */
.row.ok .breaks, .row.muted .breaks { color: var(--ink-2); }
.ev { margin-top: .5rem; }
.ev .e { display: block; font-size: .6875rem; line-height: 1.45; color: var(--ink-2); overflow-wrap: anywhere; }
.ev .e::before { content: "· "; }

.banner { border: 1px solid var(--warn); background: var(--warn-bg); color: var(--warn); border-radius: 5px; padding: .5rem .75rem; font-size: .8125rem; margin-bottom: 1.5rem; }
.banner.crit { border-color: var(--crit); background: var(--crit-bg); color: var(--crit); }

.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; min-width: 34rem; font-size: .875rem; }
th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .6875rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); font-weight: 650; }
tbody tr:last-child td { border-bottom: 0; }
td .note { color: var(--ink-2); font-size: .8125rem; }
.phase-row td { background: var(--surface-2); font-weight: 650; font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
.done .t, .done td.title { color: var(--ink-2); }

/* The output-mix table is all figures, so the columns line up under each other and the eye can read DOWN a
   column to see a trend — which is the entire point of putting four prior weeks next to this one. */
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.now td { font-weight: 650; }
tr.now td:first-child { color: var(--ink); }

.empty { color: var(--ink-2); font-size: .875rem; font-style: italic; }
footer.board { border-top: 1px solid var(--line); padding-top: 1rem; color: var(--ink-2); font-size: .75rem; }
footer.board a { color: var(--accent); }
`;

const chip = (sev, label) => `<span class="chip ${sev}">${esc(label)}</span>`;

function prRowHtml(r) {
  const meta = PR_STATUS[r.status] ?? PR_STATUS.open;
  const detail = [r.detail, meta.gloss].filter(Boolean).join(' · ');
  const labels = (r.labels ?? []).map((l) => `<span class="lbl">${esc(l)}</span>`).join('');
  return `      <div class="row ${meta.sev}">
        <div class="body">
          <div class="t"><span class="pr-num">#${esc(r.number)}</span> ${esc(r.title)}</div>
          <div class="d">${esc(detail)}</div>
          <div class="d">${labels}</div>
        </div>
        ${chip(meta.sev, meta.label)}
      </div>`;
}

function itemRowHtml(it) {
  const c = ITEM_CHIP[it.status] ?? ITEM_CHIP.todo;
  const detail = [it.blocker && `blocked: ${it.blocker}`, it.note, it.pr && `PR #${it.pr}`].filter(Boolean).join(' · ');
  return `      <div class="row ${c.sev}">
        <div class="body">
          <div class="t">${esc(it.title)}</div>
          ${detail ? `<div class="d">${esc(detail)}</div>` : ''}
          <div class="d"><span class="lbl">${esc(it.id)}</span></div>
        </div>
        ${chip(c.sev, c.label)}
      </div>`;
}

/**
 * A decision, in full. The standard the page has to hit is that the operator can ANSWER it here — without
 * opening a backlog file, a PR or a diff. So when the rich fields are present this renders, in order: the
 * question as the heading, why it is a judgment call at all, the real options with the recommended one
 * marked, what breaks if nothing is done, and the grounding (loci, counts, prior rulings).
 *
 * Every field is optional and `detail` remains the fallback, so a bare `{id, title, detail}` entry — the
 * shape the board shipped with — still renders exactly as it did.
 */
function decisionRowHtml(d, { sev = 'crit', chipLabel = 'decide', handle = 'answer as' } = {}) {
  // With a question present, the title stops being the heading and becomes the short handle for the
  // decision; with no question the title IS the heading and `detail` carries whatever context exists.
  const sub = [d.question ? d.title : d.detail, d.preparedDate && `prepared ${d.preparedDate}`]
    .filter(Boolean)
    .join(' · ');

  const options = asList(d.options).length
    ? `          <ul class="opts">
${asList(d.options)
  .map(
    (o) =>
      `            <li${o.recommended ? ' class="rec"' : ''}>${o.recommended ? chip('ok', 'recommended') : ''}<span class="ol">${esc(o.label)}</span>${o.detail ? ` — ${esc(o.detail)}` : ''}</li>`,
  )
  .join('\n')}
          </ul>`
    : '';

  const evidence = asList(d.evidence).length
    ? `          <div class="ev">${asList(d.evidence)
        .map((e) => `<span class="mono e">${esc(e)}</span>`)
        .join('')}</div>`
    : '';

  // Both handles, deliberately: the R-number is what the operator quotes back in conversation, the backlog
  // number is what the record is filed under. They are different things and neither substitutes for the other.
  const rnum = d.ruling ? `<span class="rnum">${esc(d.ruling)}</span>` : '';
  const filedAs = /^\d+$/.test(String(d.id)) ? `#${d.id}` : d.id;

  const body = [
    `          <div class="t">${rnum}${esc(d.question || d.title)}</div>`,
    sub ? `          <div class="d">${esc(sub)}</div>` : '',
    d.why ? `          <div class="dwhy">${esc(d.why)}</div>` : '',
    options,
    d.ifNothing ? `          <div class="breaks"><b>If nothing is done:</b> ${esc(d.ifNothing)}</div>` : '',
    evidence,
    // "answer as R6" only where an answer is actually being asked for. In the ruled and draft sections it
    // would contradict the section's own subtitle ("Nothing here is asking you anything"), so those say what
    // the number IS rather than what to do with it.
    `          <div class="d">${d.ruling ? `<span class="lbl">${esc(handle)} ${esc(d.ruling)}</span>` : ''}<span class="lbl">filed as ${esc(filedAs)}</span></div>`,
  ]
    .filter(Boolean)
    .join('\n');

  return `      <div class="row decision ${sev}">
        <div class="body">
${body}
        </div>
        ${chip(sev, chipLabel)}
      </div>`;
}

function planTableHtml(plan) {
  if (!plan.length) return '      <p class="empty">No plan items yet.</p>';
  const body = plan
    .map((p) => {
      const head = `        <tr class="phase-row"><td colspan="4">${esc(p.phase ? `Phase ${p.phase} — ${p.title}` : p.title)}</td></tr>`;
      const rows = p.items
        .map((it) => {
          const c = ITEM_CHIP[it.status] ?? ITEM_CHIP.todo;
          const note = [it.blocker && `blocked: ${it.blocker}`, it.note].filter(Boolean).join(' · ');
          const prCell = it.pr
            ? `<span class="mono">#${esc(it.pr)}</span>${it.prRow ? `<div class="note">${esc((PR_STATUS[it.prRow.status] ?? PR_STATUS.open).label)}</div>` : ''}`
            : '<span class="note">—</span>';
          return `        <tr class="${it.status === 'done' ? 'done' : ''}">
          <td class="title">${esc(it.title)}<div class="note"><span class="mono">${esc(it.id)}</span></div></td>
          <td>${chip(c.sev, c.label)}</td>
          <td>${prCell}</td>
          <td class="note">${esc(note)}</td>
        </tr>`;
        })
        .join('\n');
      return `${head}\n${rows}`;
    })
    .join('\n');
  return `      <div class="scroll">
        <table>
          <thead><tr><th>Item</th><th>State</th><th>PR</th><th>Note</th></tr></thead>
          <tbody>
${body}
          </tbody>
        </table>
      </div>`;
}

/** "+47,014" — grouped, signed, and never a bare `0` that reads like a missing value. */
const plusNum = (n) => `+${Number(n ?? 0).toLocaleString('en-US')}`;

/**
 * THE OUTPUT MIX (#3012) — the one standing number on the page that is about the SHAPE of the work rather
 * than its state: how much of this week went into the product versus into the machinery that delivers it.
 *
 * It is rendered as a section rather than a header tile on purpose. The three header tiles answer "what is
 * waiting on me right now"; this answers "what have we been building lately", which is a slower question and
 * would dilute them. Product leads because it is the number the metric exists to protect.
 *
 * The `other` column is shown, not hidden: it is how a reader checks that the two headline numbers actually
 * cover the tree. A remainder that stops being small is a missing rule in `output-mix-paths.json`, and the
 * page should say so rather than quietly under-reporting one side.
 */
function outputMixHtml(mix) {
  if (!mix || !mix.fresh || !mix.current) {
    return `      <p class="empty">The weekly output mix could not be computed — ${esc(mix?.reason ?? 'the derivation did not run')}.</p>`;
  }
  const cur = mix.current;
  const ratio = ratioLabel(cur);
  const rows = mix.weeks
    .map((w) => {
      const now = w.start === cur.start;
      return `          <tr${now ? ' class="now"' : ''}>
            <td class="mono">${esc(w.start)}${now ? ' <span class="lbl">this week, still running</span>' : ''}</td>
            <td class="num">${esc(plusNum(w.product))}</td>
            <td class="num">${esc(plusNum(w.machinery))}</td>
            <td class="num">${esc(plusNum(w.other))}</td>
            <td class="num">${esc(ratioLabel(w).text)}</td>
          </tr>`;
    })
    .join('\n');

  return `      <div class="tiles">
        <div class="tile ${cur.product ? 'ok' : 'crit'}"><div class="n">${esc(plusNum(cur.product))}</div><div class="k">Product lines this week</div></div>
        <div class="tile info"><div class="n">${esc(plusNum(cur.machinery))}</div><div class="k">Machinery + bookkeeping</div></div>
      </div>
      <div class="row ${esc(ratio.sev)}"><div class="body"><div class="t">${esc(ratio.text)}</div><div class="d">Week of ${esc(cur.start)} so far. Product = the spec data, the site that renders it, the blocks and the demos. Machinery = the scripts, skills, agent config and the backlog cards. Every path is charged by the first matching rule in <span class="mono">we:scripts/lib/output-mix-paths.json</span>, and each rule says why in one line.</div></div></div>
      <div class="scroll">
        <table>
          <thead><tr><th>Week from</th><th class="num">Product</th><th class="num">Machinery</th><th class="num">Other</th><th class="num">Mix</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>`;
}

const sectionHtml = (title, sub, inner) =>
  `    <section>
      <h2>${esc(title)}</h2>
      <p class="sub">${esc(sub)}</p>
${inner}
    </section>`;

/**
 * THE PROVENANCE MARKER — AND EXACTLY WHAT IT IS WORTH.
 *
 * The template lives in exactly one place — this file — and there is no example page anywhere for a future
 * session to fork. Every generated page carries a marker whose fingerprint covers the marker's own fields
 * AND the body, so `--verify=<path>` catches: a page with no marker at all, a marker copied onto different
 * content, a body edited after generation, and a rewritten `at=` or `decisions=` (those used to sit outside
 * the hash, so a genuine page could claim any date and any count).
 *
 * WHAT IT CANNOT DO, STATED PLAINLY: **this is not proof of authorship, and it cannot be made into one.** The
 * digest is UNKEYED and the algorithm is published in this very file — the same file the skill tells an agent
 * to read. Anyone who can write the page can recompute a matching marker, so a deliberately forged page
 * verifies. A keyed digest would need a secret that neither the repository nor the published Artifact can
 * hold (the page is public and self-contained; any key shipped with it is not a key).
 *
 * So `--verify` answers "was this file edited or hand-assembled by ACCIDENT?" — a real and common failure —
 * and NOT "did the generator write this?". It is a tripwire, not an authorisation. The thing that actually
 * keeps the board honest is the rule in the skill: publish only what the generator just wrote, this turn.
 */
const MARKER_RE = /^<!-- progress-board:generated schema=(\d+) at=(\S+) decisions=(\d+) fingerprint=([0-9a-f]+) -->\n/;
const SCHEMA = 1;

/** Hash the marker's own claims together with the body, so none of them can be rewritten independently. */
const fingerprint = (schema, at, decisions, body) =>
  createHash('sha256').update(`progress-board:${schema}\n${at}\n${decisions}\n`, 'utf8').update(body, 'utf8').digest('hex').slice(0, 16);

/**
 * Is this file internally consistent with the board's own generated format? See the caveat above: a `true`
 * here rules out an accidental edit or a copied marker, NOT a deliberate forgery.
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyPage(html) {
  const m = MARKER_RE.exec(String(html ?? ''));
  if (!m) return { ok: false, reason: 'no progress-board marker — this page was NOT generated by the board script' };
  const body = String(html).slice(m[0].length);
  if (Number(m[1]) !== SCHEMA) return { ok: false, reason: `marker is schema ${m[1]}, this script writes schema ${SCHEMA} — re-render it` };
  const actual = fingerprint(m[1], m[2], m[3], body);
  if (actual !== m[4]) {
    return { ok: false, reason: `fingerprint ${m[4]} does not match the marker and body (${actual}) — the page or its marker was edited after it was generated` };
  }
  return {
    ok: true,
    reason:
      `generated ${m[2]}, ${m[3]} decision${m[3] === '1' ? '' : 's'}, fingerprint ${actual} — the marker and body agree. ` +
      `The digest is UNKEYED, so this rules out an edit or a copied marker, NOT a deliberately forged page.`,
  };
}

/** The whole page. A self-contained fragment: no external font, script, image or stylesheet (strict CSP). */
export function renderPage(m) {
  const needsYou = [
    ...m.needsYou.decisions.map((d) => decisionRowHtml(d)),
    ...m.needsYou.prs.map(prRowHtml),
    ...m.needsYou.items.map(itemRowHtml),
  ].join('\n');

  // Only rendered when there is something to show — an empty "Ruled" heading would read as a fourth thing
  // the operator has to look at, which is the opposite of why it exists.
  const ruled = m.ruled.length
    ? sectionHtml(
        'Ruled, queued',
        'Already decided — kept visible because the ruling is the fact, but deliberately waiting behind other work. Nothing here is asking you anything.',
        m.ruled.map((d) => decisionRowHtml(d, { sev: 'ok', chipLabel: 'ruled · queued', handle: 'ruled as' })).join('\n'),
      ) + '\n'
    : '';

  // Deliberately far from "Needs you" and deliberately quiet: a draft is not an ask, it is a note that
  // somebody is still assembling one.
  const drafts = m.drafts.length
    ? sectionHtml(
        'Decisions being prepared',
        'Not answerable yet, so not asked. The board will not let one of these into "Needs you" until it carries a question, at least two options with one recommended, and what breaks if nothing is done.',
        m.drafts.map((d) => decisionRowHtml(d, { sev: 'muted', chipLabel: 'draft', handle: 'reserved as' })).join('\n'),
      ) + '\n'
    : '';

  const inFlight = [...m.inFlight.items.map(itemRowHtml), ...m.inFlight.prs.map(prRowHtml)].join('\n');
  const landed = [...m.landed.prs.map(prRowHtml), ...m.landed.items.map(itemRowHtml)].join('\n');

  const banner =
    // The plan half failing is worse than the PR half failing — a page that quietly shows an empty plan
    // reads as "nothing is happening" rather than "I could not read the plan". Say it first and say it loud.
    // TWO different failures, so two different sentences: "missing, not empty" is only true when NOTHING
    // parsed. In the wrong-type case the plan half below is real, minus the key that was ignored.
    (m.stateError
      ? `    <div class="banner crit"><strong>The plan and decisions could not be read</strong> — ${esc(m.stateError)}. ${
          m.stateFatal
            ? 'Everything below this line is the live pull-request half only; the plan half is missing, not empty.'
            : 'The key named above is not SHOWN below — but it is kept in the state file exactly as written, and any verb that would write to it is refused until it is repaired. The rest of the plan half below is the file as written, and is still held to the same rules.'
        }</div>\n`
      : '') +
    (m.prs.fresh
      ? ''
      : `    <div class="banner">Pull-request state is <strong>stale</strong> — ${esc(m.prs.reason ?? 'the live lookup did not run')}${
          m.prs.fetchedAt ? ` (snapshot from ${esc(stampOf(m.prs.fetchedAt))})` : ''
        }.</div>\n`) +
    // A silently truncated list under-reports rather than saying it under-reported, which is the same class
    // of lie as a partial fetch rendering as a complete one.
    (m.prs.truncated
      ? `    <div class="banner">Only the first ${OPEN_LIMIT} open pull requests were read — the list may be <strong>truncated</strong>.</div>\n`
      : '');

  const body = `<title>${esc(m.title)}</title>
<style>${css()}</style>
<div class="wrap">
  <header class="board">
    <h1>${esc(m.title)}</h1>
    <div class="meta">
      ${m.repo ? `<span class="mono">${esc(m.repo)}</span>` : ''}
      <span class="stamp">Last refreshed <strong>${esc(stampOf(m.generatedAt))}</strong></span>
      <span>${m.prs.fresh ? 'pull-request state read live' : m.prs.partial ? 'pull-request state read live IN PART' : 'pull-request state from cache'}</span>
    </div>
  </header>

${banner}  <div class="tiles">
    <div class="tile crit"><div class="n">${m.counts.needsYou}</div><div class="k">Needs you</div></div>
    <div class="tile info"><div class="n">${m.counts.inFlight}</div><div class="k">In flight</div></div>
    <div class="tile ok"><div class="n">${m.counts.done}/${m.counts.total}</div><div class="k">Plan done</div></div>
  </div>

${sectionHtml(
  'Needs you',
  'Nothing here moves without the operator: decisions to take, reviews only a human can clear, work that is stuck. Answer a decision by its ruling number — "R6 — as recommended" is enough.',
  needsYou || '      <p class="empty">Nothing is waiting on you.</p>',
)}
${ruled}
${sectionHtml(
  'In flight',
  'Work under way. Ordered by how hard it is stuck — bounced and red first, quietly-queued last.',
  inFlight || '      <p class="empty">Nothing in flight.</p>',
)}

${sectionHtml(
  'Output mix',
  'Lines ADDED this week to the product versus to the delivery machinery and backlog bookkeeping, with the four completed weeks beside it. Additions only — the question is output, not churn. Derived from git on every render; nothing here is typed by hand.',
  outputMixHtml(m.outputMix),
)}

${sectionHtml('The plan', 'Every item, by phase, joined to its pull request where one exists.', planTableHtml(m.plan))}
${drafts}
${sectionHtml('Landed', 'Recently merged pull requests and finished plan items.', landed || '      <p class="empty">Nothing landed yet.</p>')}

  <footer class="board">
    Generated by <span class="mono">we:scripts/progress-board.mjs</span> from <span class="mono">we:reports/progress-board.json</span> plus live pull-request state.
    Every decision here was rendered from data that the script refuses to leave incomplete — a hand-written page cannot say this, and is not the board.
    Pull-request state moves continuously — this page is a snapshot taken at the stamp above, not a live feed. Re-run the board to refresh it.
  </footer>
</div>
`;

  const count = m.needsYou.decisions.length + m.ruled.length + m.drafts.length;
  const fp = fingerprint(SCHEMA, m.generatedAt, count, body);
  return `<!-- progress-board:generated schema=${SCHEMA} at=${m.generatedAt} decisions=${count} fingerprint=${fp} -->\n${body}`;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

const findItem = (state, id) => (state.items ?? []).find((i) => i.id === id);

/**
 * Apply one verb to the state. Pure-ish (mutates + returns the state) and IDEMPOTENT: re-running a verb
 * that already holds re-states it without moving a date or duplicating a row.
 * @returns {string} the one-line confirmation
 */
export function applyVerb(state, verb, args = {}) {
  const today = nowIso().slice(0, 10);
  // `--date` corrects the three dates the board sets for you. They are `??=`-set at the first transition, so
  // without this a `--done` on an item that was never `--start`ed pinned BOTH dates to the same day with no
  // route back — the last three fields in the file that no verb could reach.
  const on = dateArg(args.date, verb);
  switch (verb) {
    case 'start': {
      const it = requireItem(state, args.id);
      it.status = 'in-progress';
      delete it.blocker;
      if (on) it.startedAt = on;
      else it.startedAt ??= today;
      return `started ${it.id}${on ? ` (started ${on})` : ''}`;
    }
    case 'done': {
      const it = requireItem(state, args.id);
      it.status = 'done';
      delete it.blocker;
      it.startedAt ??= on ?? today;
      if (on) it.doneAt = on;
      else it.doneAt ??= today;
      return `done ${it.id}${on ? ` (done ${on})` : ''}`;
    }
    case 'block': {
      const it = requireItem(state, args.id);
      if (!args.why) throw new Error('--block requires --why="<reason>"');
      it.status = 'blocked';
      it.blocker = args.why;
      return `blocked ${it.id} — ${args.why}`;
    }
    case 'note': {
      const it = requireItem(state, args.id);
      if (args.text) it.note = args.text;
      else delete it.note;
      return args.text ? `noted ${it.id}` : `note cleared on ${it.id}`;
    }
    case 'add': {
      const id = slugify(args.title);
      const existing = findItem(state, id);
      if (existing) {
        if (args.phase != null) existing.phase = Number(args.phase);
        return `already on the board: ${id}`;
      }
      state.items.push({ id, title: String(args.title), phase: Number(args.phase ?? 0) || 0, status: 'todo' });
      return `added ${id}`;
    }
    // Re-phasing an existing row was only reachable as `--add="<the exact title>" --phase=n` — keyed on the
    // title rather than the id every other verb takes, and presented in the usage text as an add-time option.
    // Correct, and undiscoverable. This is the same field, reached the same way as everything else.
    case 'rephase': {
      const it = requireItem(state, args.id);
      const n = Number(args.phase === true ? NaN : args.phase);
      if (!Number.isInteger(n) || n < 0) throw new Error('--rephase requires --phase=<n>');
      if ((it.phase ?? 0) === n) return `${it.id} is already in phase ${n}`;
      it.phase = n;
      return `moved ${it.id} → phase ${n}`;
    }
    // `items[].pr` IS THE JOIN between the two halves — the stored plan row and the live pull-request row.
    // Without a verb for it the only way to populate the field the plan table reads was a hand edit of the
    // very file the skill forbids hand-editing, so the docs forbade the only thing that could produce them.
    case 'link': {
      const it = requireItem(state, args.id);
      const n = Number(args.pr === true ? NaN : args.pr);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--link requires --pr=<pull-request number>');
      if (it.pr === n) return `${it.id} is already linked to PR #${n}`;
      it.pr = n;
      return `linked ${it.id} → PR #${n}`;
    }
    case 'unlink': {
      const it = requireItem(state, args.id);
      if (it.pr == null) return `${it.id} has no pull request linked`;
      const had = it.pr;
      delete it.pr;
      return `unlinked ${it.id} (was PR #${had})`;
    }
    // `--add` keys on slugify(title), so a typo'd title was otherwise a permanent row inflating counts.total
    // forever. Retitling deliberately does NOT move the id: the id is the handle every other verb and the
    // PR join use, and renaming it under them would break exactly what makes the row stable.
    case 'retitle': {
      const it = requireItem(state, args.id);
      const to = args.to === true ? '' : String(args.to ?? '');
      if (!to) throw new Error('--retitle requires --to="<new title>"');
      if (it.title === to) return `${it.id} is already titled "${to}"`;
      it.title = to;
      return `retitled ${it.id} → "${to}"`;
    }
    case 'remove': {
      const id = String(args.id);
      const before = (state.items ?? []).length;
      state.items = (state.items ?? []).filter((i) => i.id !== id);
      if (state.items.length === before) {
        return `no item "${id}" on the board — nothing to remove (known ids: ${state.items.map((i) => i.id).join(', ') || '(none)'})`;
      }
      return `removed ${id}`;
    }
    case 'phase-title': {
      const n = String(args.phase === true ? '' : (args.phase ?? ''));
      if (!/^\d+$/.test(n)) throw new Error('--phase-title=<n> takes the phase NUMBER, e.g. --phase-title=2 --to="Merge-gate correctness"');
      const to = args.to === true ? '' : String(args.to ?? '');
      state.phases ??= {};
      if (!to) {
        if (!(n in state.phases)) return `phase ${n} has no title`;
        delete state.phases[n];
        return `phase ${n} title cleared`;
      }
      if (state.phases[n] === to) return `phase ${n} is already titled "${to}"`;
      state.phases[n] = to;
      return `phase ${n} titled "${to}"`;
    }
    case 'board-title': {
      const to = args.title === true ? '' : String(args.title ?? '');
      if (!to) throw new Error('--board-title requires a value');
      if (state.title === to) return `the board is already titled "${to}"`;
      state.title = to;
      return `board titled "${to}"`;
    }
    // `repo` is what `gh pr list --repo` is given, so bootstrapping a board used to need a hand edit before
    // the live half could work at all.
    case 'repo': {
      const to = args.repo === true ? '' : String(args.repo ?? '');
      if (!to) {
        if (state.repo == null) return `no repository recorded`;
        state.repo = null;
        return `repository cleared — pull requests will be read from the current checkout`;
      }
      if (!/^[\w.-]+\/[\w.-]+$/.test(to)) throw new Error(`--repo must be <owner>/<name> — got "${to}"`);
      if (state.repo === to) return `repository is already ${to}`;
      state.repo = to;
      return `repository set to ${to}`;
    }
    case 'decide': {
      const d = requireDecision(state, args.id);
      d.status = 'taken';
      if (on) d.takenAt = on;
      else d.takenAt ??= today;
      return `decided ${d.id}${on ? ` (taken ${on})` : ''}`;
    }
    case 'decision-add': {
      // Keyed on the id, so re-running the same add is a no-op rather than a second copy of the question.
      const id = args.id && args.id !== true ? String(args.id) : slugify(args.title);
      // `R<n>` is the ruling-number namespace, handed out by the counter alone. Letting an --id squat there
      // would make two different decisions answer to the same thing the operator types in chat.
      if (/^R\d+$/i.test(id)) throw new Error(`--id="${id}" is reserved — R-numbers are assigned by the board, never chosen`);
      const question = args.question === true ? '' : String(args.question ?? '');
      const ifNothing = args.ifNothing === true ? '' : String(args.ifNothing ?? '');
      const status = args.status && args.status !== true ? String(args.status) : 'draft';
      if (!DECISION_STATUSES.includes(status)) throw new Error(`--status must be one of: ${DECISION_STATUSES.join(', ')}`);

      // A decision that will need answering must arrive with the two fields only its author knows. Everything
      // else can be built up afterwards, but a bare title is exactly the entry this board refuses to carry.
      // Recording an already-RULED decision (`--status=queued|taken`) is a different act — it is a record of
      // an answer, not a question, so it is not held to the same bar.
      if ((status === 'draft' || status === 'awaiting') && (!question || !ifNothing)) {
        throw new Error(
          `--decision-add requires --question="…" and --if-nothing="…" (a title is not a decision). ` +
            `Use --status=queued or --status=taken to record one that has already been ruled.`,
        );
      }

      state.decisions ??= [];
      const existing = state.decisions.find((x) => String(x.id) === id);
      if (existing) {
        if (question) existing.question = question;
        if (ifNothing) existing.ifNothing = ifNothing;
        return `already on the board: decision ${id}`;
      }
      const d = { id, title: String(args.title), status };
      if (question) d.question = question;
      if (ifNothing) d.ifNothing = ifNothing;
      if (status === 'awaiting') requireAnswerable(d, 'add');
      state.decisions.push(d);
      return `added decision ${id} (${status})`;
    }
    case 'decision-set': {
      const d = requireDecision(state, args.id);
      const field = String(args.field ?? '');
      if (!DECISION_FIELDS.includes(field)) {
        throw new Error(`--field must be one of: ${DECISION_FIELDS.join(', ')} (options and evidence have their own verbs)`);
      }
      const value = args.value === true ? '' : String(args.value ?? '');
      if (field === 'status' && value && !DECISION_STATUSES.includes(value)) {
        throw new Error(`status must be one of: ${DECISION_STATUSES.join(', ')}`);
      }
      // The flip to `awaiting` is the moment a decision starts asking the operator for something, so it is
      // the moment the contract is checked. Refusing here — before anything is written — is what keeps a
      // half-built decision out of their section without ever needing a person to notice.
      if (field === 'status' && value === 'awaiting') requireAnswerable({ ...d, status: 'awaiting' }, 'flip');
      // Empty clears, exactly like `--note --text=` — one way to unset a field, not two.
      if (value) d[field] = value;
      else delete d[field];
      return value ? `set ${field} on ${d.id}` : `cleared ${field} on ${d.id}`;
    }
    case 'decision-option': {
      const d = requireDecision(state, args.id);
      requireListField(d, 'options');
      const label = args.label === true ? '' : String(args.label ?? '');
      if (!label) throw new Error('--decision-option requires --label="<option>"');
      d.options ??= [];
      const detail = args.detail === true ? '' : String(args.detail ?? '');
      const existing = d.options.find((o) => o.label === label);
      const o = existing ?? { label };
      if (!existing) d.options.push(o);
      if (detail) o.detail = detail;
      // Exactly one option can be the recommendation — a second `--recommend` MOVES it rather than adding one.
      if (args.recommend) {
        for (const other of d.options) delete other.recommended;
        o.recommended = true;
      }
      return `${existing ? 'option updated on' : 'option added to'} ${d.id}: ${label}`;
    }
    // Options match on the exact label, so re-wording one ADDS a second row rather than replacing the
    // first — and the page then shows the operator the same choice twice. Without this verb the only
    // repair is a hand-edit of the state file, which the board forbids.
    case 'decision-option-remove': {
      const d = requireDecision(state, args.id);
      requireListField(d, 'options');
      const label = args.label === true ? '' : String(args.label ?? '');
      if (!label) throw new Error('--decision-option-remove requires --label="<option>"');
      const before = d.options?.length ?? 0;
      d.options = (d.options ?? []).filter((o) => o.label !== label);
      // Idempotent, like every other verb: a second removal of the same label is a no-op, not an error. The
      // labels that ARE there are named, so a typo is still visible in the one line the model reads.
      if (d.options.length === before) {
        return `no option labelled "${label}" on ${d.id} — nothing to remove (options: ${d.options.map((o) => o.label).join(', ') || 'none'})`;
      }
      return `option removed from ${d.id}: ${label}`;
    }
    case 'decision-evidence': {
      const d = requireDecision(state, args.id);
      requireListField(d, 'evidence');
      const text = args.text === true ? '' : String(args.text ?? '');
      if (!text) {
        delete d.evidence;
        return `evidence cleared on ${d.id}`;
      }
      d.evidence ??= [];
      if (d.evidence.includes(text)) return `evidence already on ${d.id}`;
      d.evidence.push(text);
      return `evidence added to ${d.id}`;
    }
    // A decision can be filed in error, superseded, or duplicated, and until now removing one meant the hand
    // edit the design forbids. Its R-number RETIRES with it and is never handed out again — `ensureRulingNumbers`
    // makes the counter monotonic, and `main` reconciles it from the file as read, BEFORE this verb runs.
    case 'decision-remove': {
      const d = findDecision(state, args.id);
      if (!d) {
        const known = (state.decisions ?? []).map((x) => (x.ruling ? `${x.ruling}/${x.id}` : x.id)).join(', ') || '(none)';
        return `no decision "${args.id}" on the board — nothing to remove (known: ${known})`;
      }
      state.decisions = (state.decisions ?? []).filter((x) => x !== d);
      return `removed decision ${d.ruling ? `${d.ruling}/${d.id}` : d.id} — ${d.ruling ?? 'its number'} is retired and will never be reissued`;
    }
    // The loudest warning in the skill is that a minted duplicate URL cannot be undone, so this verb — the
    // one that decides which URL the next session republishes to — gets a shape check and refuses to
    // overwrite a different stored URL without being told to.
    case 'url': {
      const url = args.url === true ? '' : String(args.url ?? '');
      if (!/^https?:\/\/\S+$/.test(url)) {
        throw new Error(`--url takes the full published URL (https://…) — got ${url ? `"${url}"` : 'no value at all'}`);
      }
      if (state.artifactUrl === url) return `artifact URL already stored`;
      if (state.artifactUrl && args.force) {
        const was = state.artifactUrl;
        state.artifactUrl = url;
        return `artifact URL replaced (was ${was})`;
      }
      if (state.artifactUrl) {
        throw new Error(
          `${state.artifactUrl} is already stored as this board's URL. Replacing it orphans the operator's bookmark, ` +
            `and a minted duplicate cannot be undone — pass --force only if the board really was re-published to a new URL.`,
        );
      }
      state.artifactUrl = url;
      return `artifact URL stored`;
    }
    default:
      throw new Error(`unknown verb "${verb}"`);
  }
}

/** `--date=YYYY-MM-DD`, or null when it was not passed. A loose date would silently mis-sort the board. */
function dateArg(v, verb) {
  if (v === undefined) return null;
  const s = v === true ? '' : String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`--date takes a calendar date as YYYY-MM-DD (e.g. --${verb}=… --date=2026-08-01) — got ${s ? `"${s}"` : 'no value at all'}`);
  }
  return s;
}

/**
 * A writer's half of `asList`. A reader can degrade around a wrong-typed field; a writer cannot, because
 * `d.options ??= []` does not fire on a string and `.push`/`.filter` then throws a raw stack trace — and by
 * then a verb has already reported success. Refuse cleanly instead, and name the two routes out.
 */
function requireListField(d, field) {
  if (d[field] === undefined || Array.isArray(d[field])) return;
  throw new Error(
    `decision "${d.id}" has a ${field} field that is not a list (${JSON.stringify(d[field])}) — the board will not guess at what it meant, ` +
      `and will not overwrite it. Repair that one field by hand, or drop the decision with --decision-remove=${d.id} and re-add it.`,
  );
}

function requireItem(state, id) {
  const it = findItem(state, id);
  if (!it) throw new Error(`no item "${id}" — known ids: ${(state.items ?? []).map((i) => i.id).join(', ') || '(none)'}`);
  return it;
}

/**
 * Find a decision by EITHER handle: the ruling number the operator quotes in chat (`R4`, case-insensitive)
 * or the id under which it is filed (a backlog number, or a slug). Both are printed on the card precisely so
 * that either one works here.
 */
export function findDecision(state, handle) {
  const key = String(handle);
  const lower = key.toLowerCase();
  return (
    (state.decisions ?? []).find((x) => String(x.id) === key) ??
    (state.decisions ?? []).find((x) => String(x.ruling ?? '').toLowerCase() === lower) ??
    null
  );
}

function requireDecision(state, id) {
  const d = findDecision(state, id);
  if (!d) {
    const known = (state.decisions ?? []).map((x) => (x.ruling ? `${x.ruling}/${x.id}` : x.id)).join(', ') || '(none)';
    throw new Error(`no decision "${id}" — known: ${known}`);
  }
  return d;
}

/** Refuse to put an unanswerable decision in front of the operator, naming the id and every missing field. */
function requireAnswerable(d, at) {
  const gaps = decisionGaps(d);
  if (!gaps.length) return;
  const how = at === 'add' ? 'add "%s" as awaiting' : 'mark "%s" awaiting';
  throw new Error(
    `cannot ${how.replace('%s', d.id)} — it must be answerable from the page. Missing ${gaps.join(' · ')}. ` +
      `Build it up first (it can sit as --field=status --value=draft meanwhile).`,
  );
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

const USAGE = `progress-board — the operator's published status page (one Bash call + one Artifact call per update)

  node scripts/progress-board.mjs                    re-render from live state
  node scripts/progress-board.mjs --start=<id>       item → in progress (clears any blocker)
  node scripts/progress-board.mjs --done=<id>        item → done
        --date=YYYY-MM-DD on --start/--done/--decide CORRECTS the date the board set for you (it is
        otherwise stamped once, at the first transition, and a --done on a never-started item pins both)
  node scripts/progress-board.mjs --block=<id> --why="<reason>"
  node scripts/progress-board.mjs --note=<id> --text="<note>"    (empty --text clears it)
  node scripts/progress-board.mjs --add="<title>" [--phase=<n>]
  node scripts/progress-board.mjs --rephase=<id> --phase=<n>      move an existing row to another phase
  node scripts/progress-board.mjs --retitle=<id> --to="<title>"   the id never moves — it is the join key
  node scripts/progress-board.mjs --remove=<id>      drop a plan item
  node scripts/progress-board.mjs --link=<id> --pr=<n>            join the item to its pull request
  node scripts/progress-board.mjs --unlink=<id>
  node scripts/progress-board.mjs --phase-title=<n> --to="<title>"   (empty --to clears it)
  node scripts/progress-board.mjs --board-title="<title>"
  node scripts/progress-board.mjs --repo=<owner>/<name>           what \`gh pr list --repo\` is given
  node scripts/progress-board.mjs --decide=<id>      a decision was taken
  node scripts/progress-board.mjs --url=<url>        store the published artifact URL (once; --force to replace)

  A decision the operator can ANSWER FROM THE PAGE. Enforced, not requested: anything marked "awaiting" must
  carry a question, two or more real options with exactly one recommended, and ifNothing — or the run exits 1
  naming the id and the missing field. Park an unfinished one as "draft"; it never reaches "needs you".

  node scripts/progress-board.mjs --decision-add="<title>" --question="<one line>" --if-nothing="<what breaks>"
                                  [--id=<id>] [--status=<s>]   (adds as draft; --status=queued|taken records a ruling)
  node scripts/progress-board.mjs --decision-set=<id> --field=<name> --value="<text>"   (empty --value clears)
        --field: ${DECISION_FIELDS.join(' | ')}
        status:  ${DECISION_STATUSES.join(' | ')}
                 draft = being prepared, kept out of "needs you" · queued = ruled but deferred
  node scripts/progress-board.mjs --decision-option=<id> --label="<option>" --detail="<tradeoff>" [--recommend]
  node scripts/progress-board.mjs --decision-option-remove=<id> --label="<option>"   (labels match exactly, so
        re-wording an option ADDS a second one — remove the superseded label rather than hand-editing state)
  node scripts/progress-board.mjs --decision-evidence=<id> --text="<locus, count or prior ruling>"
  node scripts/progress-board.mjs --decision-remove=<id>   drop it; its R-number retires and is never reissued
        then, once it is answerable: --decision-set=<id> --field=status --value=awaiting

  <id> is EITHER handle: the ruling number the operator quotes ("R6", the board assigns it and never reuses
  it) or the id it is filed under. So --decide=R6 and --decide=2978 reach the same decision.

  node scripts/progress-board.mjs --verify=<path>    does that file's marker still match its own content?
        A TRIPWIRE, NOT AN AUTHORISATION. The digest is unkeyed and its algorithm is in this file, so exit 0
        rules out an accidental edit or a copied marker — it cannot rule out a deliberately forged page.

  --state=<path>  --out=<path>  --no-gh  --no-git  --json  --help`;

/**
 * Which state key each verb WRITES — the lookup behind the scoped refusal in `main`. `board-title`, `repo`
 * and `url` write top-level scalars and are absent on purpose: they stay available while a container key is
 * unreadable, because their save is now non-destructive. Anything added here later gets the guard for free;
 * anything forgotten defaults to "writes nothing", so keep it in step with `applyVerb`.
 */
const VERB_TARGET = {
  start: 'items',
  done: 'items',
  block: 'items',
  note: 'items',
  add: 'items',
  rephase: 'items',
  retitle: 'items',
  remove: 'items',
  link: 'items',
  unlink: 'items',
  decide: 'decisions',
  'decision-add': 'decisions',
  'decision-set': 'decisions',
  'decision-option': 'decisions',
  'decision-option-remove': 'decisions',
  'decision-evidence': 'decisions',
  'decision-remove': 'decisions',
  'phase-title': 'phases',
};

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  let statePath;
  let outPath;
  try {
    statePath = args.state ? assertWritablePath(String(args.state), '--state') : DEFAULT_STATE;
    outPath = args.out ? assertWritablePath(String(args.out), '--out') : DEFAULT_OUT;
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 1;
  }
  // The two caller-controlled paths must not be the same file. They are written by different code at
  // different moments, so the collision was not a no-op: the page landed ON TOP of the state file and the
  // plan was gone — including in the fatal branch, the one place the design promises never to overwrite a
  // recoverable plan. Checked BEFORE the state is even read, so neither write can have happened.
  if (outPath === statePath) {
    console.error(`✗ --out and --state both point at ${shortPath(outPath)} — the page would be written over the state file. Give them different paths.`);
    return 1;
  }
  // `--verify` is a read-only question about a FILE, not about the board's state — answer it and stop.
  if (args.verify) {
    const target = resolve(String(args.verify));
    let html;
    try {
      html = readFileSync(target, 'utf8');
    } catch (e) {
      console.error(`✗ cannot read ${shortPath(target)} — ${e.message}`);
      return 1;
    }
    const v = verifyPage(html);
    // The two directions are NOT equally strong, and the wording says so. A failure is conclusive: this file
    // is definitely not an untouched generated board. A pass is not: it means the marker and the body agree,
    // which an unkeyed digest published in this same file cannot turn into proof of who wrote them.
    console[v.ok ? 'log' : 'error'](
      `${v.ok ? '✓' : '✗'} ${shortPath(target)}: ${v.ok ? 'marker and body agree' : 'is NOT the generated board'} — ${v.reason}`,
    );
    return v.ok ? 0 : 1;
  }

  const state = loadState(statePath);

  const verbs = [];
  if (args.start) verbs.push(['start', { id: String(args.start), date: args.date }]);
  if (args.done) verbs.push(['done', { id: String(args.done), date: args.date }]);
  if (args.block) verbs.push(['block', { id: String(args.block), why: args.why === true ? '' : args.why }]);
  if (args.note) verbs.push(['note', { id: String(args.note), text: args.text === true ? '' : args.text }]);
  if (args.add) verbs.push(['add', { title: String(args.add), phase: args.phase }]);
  if (args.rephase) verbs.push(['rephase', { id: String(args.rephase), phase: args.phase }]);
  if (args.retitle) verbs.push(['retitle', { id: String(args.retitle), to: args.to }]);
  if (args.remove) verbs.push(['remove', { id: String(args.remove) }]);
  if (args.link) verbs.push(['link', { id: String(args.link), pr: args.pr }]);
  if (args.unlink) verbs.push(['unlink', { id: String(args.unlink) }]);
  if (args['phase-title']) verbs.push(['phase-title', { phase: args['phase-title'], to: args.to }]);
  if (args['board-title']) verbs.push(['board-title', { title: args['board-title'] }]);
  if (args.repo !== undefined) verbs.push(['repo', { repo: args.repo }]);
  if (args.decide) verbs.push(['decide', { id: String(args.decide), date: args.date }]);
  if (args['decision-add'])
    verbs.push([
      'decision-add',
      { title: String(args['decision-add']), id: args.id, question: args.question, ifNothing: args['if-nothing'], status: args.status },
    ]);
  if (args['decision-set']) verbs.push(['decision-set', { id: String(args['decision-set']), field: args.field, value: args.value }]);
  if (args['decision-option'])
    verbs.push([
      'decision-option',
      { id: String(args['decision-option']), label: args.label, detail: args.detail, recommend: args.recommend !== undefined && args.recommend !== 'false' },
    ]);
  if (args['decision-option-remove'])
    verbs.push(['decision-option-remove', { id: String(args['decision-option-remove']), label: args.label }]);
  if (args['decision-evidence']) verbs.push(['decision-evidence', { id: String(args['decision-evidence']), text: args.text }]);
  if (args['decision-remove']) verbs.push(['decision-remove', { id: String(args['decision-remove']) }]);
  if (args.url) verbs.push(['url', { url: args.url, force: Boolean(args.force) }]);

  // A file NOTHING survived is a file we must not overwrite: applying a verb here would save the EMPTY
  // fallback state over a plan that is very likely one merge-conflict marker away from fine. Refuse the
  // write, keep rendering (below) so the page still exists and says why.
  //
  // A PARTIAL read is deliberately NOT refused. Its items and decisions are the operator's real data, so a
  // verb writes onto real data — and refusing here while the render guard (below) also refuses would leave
  // the hand edit the whole design forbids as the only way out. The verbs ARE the repair route.
  const broken = state[STATE_ERROR];
  const fatal = Boolean(state[STATE_FATAL]);
  if (fatal && verbs.length) {
    console.error(`✗ refusing to write: ${broken}. Fix the file by hand — applying a verb now would overwrite the plan with an empty one.`);
    return 1;
  }

  // THE SAME REFUSAL, SCOPED TO ONE KEY. A verb that writes to a key the read could not understand would be
  // writing onto the emptied stand-in, and `saveState` re-emits the raw value over the top — so the verb
  // would report success and lose the work. Refuse it by name. Verbs that write anywhere else are unaffected,
  // which is what keeps this from becoming the deadlock the fatal branch used to be.
  const unreadable = state[STATE_UNREADABLE];
  if (unreadable) {
    const blocked = [...new Set(verbs.map(([v]) => VERB_TARGET[v]).filter((k) => k && unreadable.has(k)))];
    if (blocked.length) {
      console.error(
        `✗ refusing to write ${blocked.join(' and ')}: ${broken}. That key is preserved in the state file exactly as written and will not be ` +
          `overwritten — repair its type by hand, then the verb will apply. Verbs that do not write to ${blocked.join('/')} still work.`,
      );
      return 1;
    }
  }

  // Reconcile the ruling counter from the file AS READ — before any verb can delete the decision that is the
  // only surviving evidence a number was ever used. This is what makes "never reused" structural rather than
  // a convention `--decision-remove` has to remember.
  const rulingBefore = state.nextRuling;
  let numbered = fatal ? 0 : ensureRulingNumbers(state);

  const confirmations = [];
  try {
    for (const [verb, a] of verbs) confirmations.push(applyVerb(state, verb, a));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 1;
  }
  // Backfill anything a verb just added. Idempotent after the first run, which is why it can safely trigger a
  // save even when no verb ran — and the counter itself moving is a change worth persisting too.
  numbered += fatal ? 0 : ensureRulingNumbers(state);
  const counterMoved = !fatal && state.nextRuling !== rulingBefore;

  // Save FIRST, validate second. The verbs are how an incomplete decision gets completed, so refusing to
  // persist them would deadlock the only route out of a board that is already failing this check.
  //
  // On a partial read, save only when a verb actually ran. A plain re-render must not silently rewrite the
  // file and drop the wrong-typed key the operator may still want to look at.
  if (verbs.length || ((numbered || counterMoved) && !broken)) saveState(statePath, state);

  // THE RENDER GUARD, and a DIFFERENT failure from an unreadable file: this one means a decision reached the
  // model that the operator cannot answer from the page. It catches what the verb guards cannot — an entry
  // that predates the rule, or one an editor wrote around the CLI. It hard-fails rather than warning,
  // because a warning is read once and then never again.
  //
  // IT RUNS UNCONDITIONALLY, on whatever decisions actually reached the model. It used to be skipped whenever
  // STATE_ERROR was set, which meant one wrong-typed key — a key the soft branch normalises while PRESERVING
  // every decision — turned the guard off and published the exact unanswerable card this board exists to make
  // impossible, at exit 0, on every run. A fatal read has no decisions, so this is simply empty there.
  const invalid = validateDecisions(state);
  if (invalid.length) {
    console.error(`✗ ${invalid.length} decision${invalid.length === 1 ? '' : 's'} cannot be answered from the page — refusing to render:`);
    for (const line of invalid) console.error(`    ${line}`);
    console.error(
      `  Fill the gaps with the verbs named above, or park it until it is ready:\n` +
        `    node scripts/progress-board.mjs --decision-set=<id> --field=status --value=draft`,
    );
    return 1;
  }

  const useGh = !args['no-gh'] && process.env.WE_BOARD_NO_GH !== '1';
  const prs = fetchPrs({ repo: state.repo, statePath, useGh });
  // Local git only — no network, no cache, and it never throws (a failure comes back as `fresh: false`).
  // `WE_BOARD_NOW` already freezes the page stamp; reuse it so the week window freezes with it.
  //
  // `--no-git` exists for the same reason `--no-gh` does: the read costs ~0.8s over this history, which is
  // nothing on a real render next to two `gh` calls, but is the whole runtime of a test suite that spawns
  // the CLI sixty times. Skipping it degrades exactly like a failed read — an honest note, never a zero.
  const useGit = !args['no-git'] && process.env.WE_BOARD_NO_GIT !== '1';
  const mix = useGit
    ? computeOutputMix({ today: nowIso().slice(0, 10) })
    : { fresh: false, reason: 'the weekly git derivation was disabled for this run', weeks: [], current: null, trend: [] };
  const model = buildModel(state, prs, mix);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderPage(model));

  if (args.json) {
    process.stdout.write(JSON.stringify(model, null, 2) + '\n');
    return 0;
  }

  const rel = (p) => (p.startsWith(ROOT) ? relative(ROOT, p) : p);
  const head = confirmations.length ? confirmations.join('; ') : 'rendered';
  const url = model.artifactUrl ? ` · publish to ${model.artifactUrl}` : ' · no artifact URL stored yet (--url=<url> after the first publish)';
  const staleness = prs.fresh ? '' : ' · PR state STALE';
  // The page carries the loud version; this is the one line the model actually reads, so it has to carry it too.
  // Two different failures keep two different words: UNREADABLE means nothing survived; PARTLY IGNORED means
  // the plan below is real and only the named key was dropped.
  const stateNote = broken ? ` · STATE FILE ${fatal ? 'UNREADABLE' : 'PARTLY IGNORED'}: ${broken}` : '';
  console.log(`${broken ? '⚠' : '✓'} ${head} → ${rel(outPath)} (${model.counts.needsYou} needs you, ${model.counts.inFlight} in flight)${stateNote}${staleness}${url}`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('progress-board.mjs')) process.exitCode = main();
