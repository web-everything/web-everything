#!/usr/bin/env node
/**
 * @file scripts/pr-status.mjs
 * @description `pr-status` — for every open PR, the PHASE it is in RIGHT NOW, its round counts, and who (if
 *   anyone) is actually working on it this second. Run: `npm run pr-status`.
 *
 * ── NOT THE SAME QUESTION AS `we:scripts/operations/pr-status.mjs` ───────────────────────────────────────────
 *
 * That operation asks whether CI actually RAN on the head that is there now (`green`/`red`/`pending`/`unchecked`)
 * — a question about the machine. THIS asks who is working on the PR and what is owed — a question about the
 * PEOPLE and AGENTS. They share a name because they share a subject, and they answer to different failures: that
 * one caught #1510/#1511 sitting twelve hours with no check run; this one catches a PR sitting with no WORKER.
 * Neither subsumes the other and neither should grow into the other.
 *
 * ONE MEASURED SIDE EFFECT OF SHARING THE BASENAME, recorded in BOTH headers so nobody re-discovers it as a
 * mystery from either side (the twin note lives in that file's header): the #2967 test-only-export scan matches
 * imports and shelled files by specifier BASENAME, and `npm run pr-status` shells `pr-status.mjs`, so BOTH files
 * are now treated as shelled and the scan stops reporting `CHECK_STATES` in the operations module. That export
 * is no more wired than it was; the finding is HIDDEN, not fixed. The scan's own header calls basename merging
 * a deliberate one-way trade ("can only ever HIDE a finding, never invent one"), so this is that trade being
 * paid, not a new defect — but if #2967's coverage of that module is wanted back, this note is why it went.
 *
 * ── RULE 1: THE PHASE IS DERIVED, NEVER SELF-REPORTED ────────────────────────────────────────────────────────
 *
 * A marker file, a status line, a lease record or a label saying "fixing" OUTLIVES the agent that wrote it, and
 * from that moment on it lies — confidently, and in the exact direction that stops anyone looking. The whole
 * point of this command is to require observed activity. Managed busy/working sessions now supplement lane
 * process evidence through pr-state-core; claims alone never earn FIXING. The original lane probe accepts
 * a LIVE PROCESS whose cwd is a lane that carries the PR branch's history. Nothing this command prints as
 * `FIXING` or `REVIEWING` can outlive the process that earns it, because the process IS the evidence.
 *
 * The ownership test is ANCESTRY (`git merge-base --is-ancestor <branch-head> <lane-head>`), never sha equality.
 * Equality is the tempting version and it is wrong in the precise case you care about most: the moment the fixer
 * commits locally, the lane HEAD moves ahead of the pushed branch head, equality goes false, and the report says
 * "nobody is working on it" about a lane that is, at that instant, working on it. Ancestry stays true across
 * every local commit and only goes false when the lane genuinely moves to other work. `selectOwningLane` takes the
 * ancestry probe as an injected callback so this rule is unit-tested with no git and no live process at all.
 *
 * ── RULE 2: ROUNDS COME FROM THE LEDGER ──────────────────────────────────────────────────────────────────────
 *
 * Counting the string "verdict" in comment bodies is the obvious shortcut and it OVER-COUNTS badly: a review
 * write-up quotes its own verdict two or three times and a triage table restates every previous round's, so a
 * PR reads several rounds higher than it has had. Measured on this repo's own open PRs, #1563 on 2026-08-26:
 * 15 of its 15 comments contain the string, against 9 rounds by ledger. BOTH figures climb as that PR takes
 * further rounds — the standing fact is the GAP, not this particular pair of numbers, and a reader re-running
 * the count later should expect different ones.
 *
 * So rounds are read from the APPEND-ONLY LEDGERS, where one round is one record, written once. There are two of
 * them and both are read, because they are two writers recording the same negotiation from different paths:
 *
 *   · the JURY ledger (`we:scripts/lib/jury-ledger.mjs`) — the per-subject event stream the #2639 convergence
 *     loop writes, read through the ONE shared fold (`foldJuryLedger`), never a second copy of that reduction.
 *     `we:scripts/lib/auto-land-seam.mjs` treats it as the authority with the label as derived intent, and so
 *     does this. Its `round` is 0-based, so the display number is `round + 1`.
 *   · the VERDICT ledger (`we:scripts/lib/verdict-ledger.mjs`) — one row per recorded verdict per PR, written by
 *     `review-set-label` and the declared `review-pr` operation. This is the one that actually holds today's open
 *     PRs; the jury logs cover the subjects the convergence loop ran.
 *
 * A PR reviewed through one path has no records in the other, so the reported figure is the higher of the two:
 * the most rounds any ledger can ACCOUNT FOR. Neither is inflated by the other because a given review writes to
 * one of them, not both.
 *
 * NOT every verdict row is a round, and the exclusions come from `verdict-ledger.mjs`'s own definitions rather
 * than from taste: `pending` is the drain parking the PR ("a HOLD awaiting an independent review, not a verdict
 * on the contribution"), `restamped` is an acceptance carried across a drain-authored rebase ("no review was run,
 * and a reader counting acceptances must not count this as one"), and `clear-human` is the human ceremony
 * lifting a hold. A round is a reviewer JUDGING THE DIFF: `accepted`, `changes`, `human`.
 *
 * `r0` therefore means "no ledger has a round for this PR", which is a finding in itself and must not print the
 * same as one round.
 *
 * `FIX` is deliberately a different kind of number and is labelled `c<n>`: commits on the branch ahead of its
 * merge base with main. That is a git FACT, not a count of strings either, and it is the cheapest honest answer
 * to "how much fixing has actually happened" — the ledgers record review rounds, not pushes.
 *
 * ── RULE 3: THE PHASES, AND WHY THE STUCK REASON IS NOT DECORATION ──────────────────────────────────────────
 *
 * `READY` · `FIXING` · `REVIEWING` · `STUCK: <reason>`. The reason is the part that makes the report actionable:
 * "a PR sitting there" is one appearance with several different causes, and they need OPPOSITE interventions.
 * `bounced, no fixer` wants a fixer sent to the lane; `no reviewer` wants a reviewer — the reason that stranded
 * #1567; `prevention unfiled` wants a GUARD FILED, and wants no fixer and no reviewer at all (#2823's
 * `prevention-outstanding`: every finding on the diff is already resolved, so there is nothing for either to
 * do). Collapsing them into one `STUCK` would leave a reader doing the triage by hand on every row, which is
 * the work this command is supposed to have already done. The full set is in `STUCK_REASONS` below.
 *
 * ── RULE 4: `STUCK: needs human` IS DETECTED NARROWLY, AND HERE IS EXACTLY HOW FAR IT REACHES ────────────────
 *
 * An agent that correctly STOPPED TO ASK looks, from outside, identical to one that crashed — and restarting it
 * re-runs the question forever, which is the failure this phase exists to prevent. It is detected from the
 * lane's own transcript, and ONLY in this shape (`detectPendingQuestion`):
 *
 *   · the LAST main-chain entry in the transcript is an assistant turn (a sidechain / sub-agent turn never
 *     counts — a sub-agent's closing question is not the session stopping);
 *   · that turn's `stop_reason` is `end_turn` — an ABSENT stop_reason is treated as unknown and reports nothing,
 *     never as a stop;
 *   · its last content block is text (so no `tool_use` follows it — the turn ended on words, not on an action);
 *   · that text's last non-empty line ends in `?`.
 *
 * WHAT THAT DOES NOT REACH, stated plainly because a wrong `needs human` is worse than none:
 *   · FALSE POSITIVE — a run that FINISHED and happened to end its closing summary on a question mark is
 *     reported as `needs human`. From the transcript alone the two are the same bytes; nothing in the record
 *     distinguishes "I am waiting for you" from "…and that is the last open question, done." This is the one
 *     wrong answer the rule can give, and it is bounded to that shape.
 *   · FALSE NEGATIVE — a question phrased without a question mark ("let me know which you prefer.", "tell me
 *     whether to proceed.") is NOT detected and the PR reports its label-derived stuck reason instead.
 *   · A question asked and then ANSWERED is not detected, because the answer is a later main-chain entry and the
 *     rule requires the assistant turn to be last.
 *
 * The narrow shape is the deliberate choice: it is the half of the space that IS decidable from the record. The
 * rest is left to the label-derived reasons rather than guessed at.
 *
 * A `review:human` LABEL is a different thing and gets its own reason, `STUCK: human gate` — that is the gate
 * saying only a human may clear this diff, not an agent stopping to ask a question. Collapsing them would make
 * the one phase that must mean "someone is blocked on your answer" mean "this is policy-tier code" as well.
 *
 * ── RULE 5: THE LIVE-ACTIVITY LINE IS BEST-EFFORT AND CANNOT BREAK THE REPORT ────────────────────────────────
 *
 * The `└─ now:` line is the last `tool_use` or text from the working lane's transcript under `~/.claude/projects/`.
 * Transcripts are another process's append-only file: it can be missing, half-written, rotated, or a line can be
 * truncated mid-JSON. Every read is wrapped and every parse failure is skipped per line, so the worst a broken
 * transcript can do is omit one decorative line. The phase never depends on it.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Everything that DECIDES is pure and exported (`reviewRounds`, `selectOwningLane`, `detectPendingQuestion`,
 * `lastActivity`, `derivePhase`, `renderReport`, `compactElapsed`, `projectDirName`, …) and unit-tested over
 * fixtures in `we:scripts/__tests__/pr-status.test.mjs` — no live process, no gh, no network, no git. The impure
 * shell at the bottom is only the probes that feed them: `gh pr list` · `git` · `pgrep`/`lsof`/`ps` · the two
 * ledger reads · the transcript read. Every one of them fails soft, and a probe that cannot answer costs a
 * column, never the run. Managed-session probe failures are reported as unknown, never proof of a stall.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readJuryLog, foldJuryLedger } from './lib/jury-ledger.mjs';
import { readVerdictLedger, VERDICTS as LEDGER_VERDICTS } from './lib/verdict-ledger.mjs';
import { REVIEW_LABELS } from './lib/review-escalation.mjs';
import { defaultPoolRoot } from './lib/lane-pool-paths.mjs';
import { DEFAULT_REPO_KEY, CONSTELLATION_REPOS } from './lib/constellation-repos.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
import { readPrFacts } from './lib/pr-state-io.mjs';
import { derivePrState, settingsFromEnv } from './lib/pr-state-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — the default root for the per-checkout `.conveyor/jury` ledger. */
const REPO_ROOT = resolve(HERE, '..');
/** The jury-ledger subject key prefix — subjects are keyed `<repoKey>#<pr>` (#2500 keying). Taken from the ONE
 *  constellation mapping rather than a local `'we'` literal, which is exactly the drift that module exists to
 *  prevent. `gh` itself is run with `cwd` at this checkout, so the slug is never hardcoded here at all. */
const SUBJECT_PREFIX = DEFAULT_REPO_KEY;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE PHASE VOCABULARY
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The four phases. `FIXING` and `REVIEWING` are the only two that assert somebody is WORKING, and neither is
 * reachable without a live process (see `derivePhase`) — that is rule 1 expressed as a type.
 */
export const PHASES = Object.freeze({
  READY: 'READY',         // accepted / ready-to-merge — nothing is owed, the drain may take it
  FIXING: 'FIXING',       // a LIVE process in a lane carrying this branch, and the owed work is a fix
  REVIEWING: 'REVIEWING', // a LIVE process in a lane carrying this branch, and the owed work is a review
  STUCK: 'STUCK',         // nobody is working on it — the reason says why
});

/**
 * The stuck reasons. `BOUNCED_NO_FIXER` and `NO_REVIEWER` are the two the report exists to tell apart: both look
 * like "a PR sitting there", and they need opposite interventions (send a fixer vs send a reviewer).
 */
export const STUCK_REASONS = Object.freeze({
  BOUNCED_NO_FIXER: 'bounced, no fixer',  // review:changes — a reviewer asked for changes and no lane is fixing
  NO_REVIEWER: 'no reviewer',             // review:pending — the drain parked it and no lane is reviewing
  NEEDS_HUMAN: 'needs human',             // an agent stopped to ASK — restarting it re-runs the question forever
  HUMAN_GATE: 'human gate',               // review:human — only a human may clear this diff (a LABEL, not a question)
  PREVENTION_UNFILED: 'prevention unfiled', // the jury CONVERGED but a named prevention guard is still unfiled
  NO_LABEL: 'no review label',            // never parked, and the ledger says nothing either
});

/** Labels that mean the PR is done being worked: nothing is owed and the drain may merge it. */
const READY_LABELS = Object.freeze([REVIEW_LABELS.accepted, 'ready-to-merge']);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE — ROUNDS FROM THE LEDGER
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The number of REVIEW ROUNDS this PR has been through, read from its append-only jury ledger through the ONE
 * shared fold (`foldJuryLedger`) — never a second copy of that reduction, per the #2641 guardrail.
 *
 * Ledger rounds are 0-BASED (the roster is seated at round 0 and `round-advanced` fires for rounds 1..n-1, per
 * `buildReviewLedgerEvents`), while the review loop counts from 1. So a folded `round` of 0 with a seated roster
 * IS one round, and the display number is `round + 1`. An empty or wholly unusable stream is 0 rounds, not 1 —
 * "no ledger" and "one round" must not print the same, or a PR nobody has ever reviewed reads as reviewed once.
 *
 * PURE and total: a malformed event is dropped by the fold, never thrown.
 *
 * @param {Array<object>} events - raw append-only jury events for one subject.
 * @returns {number} review rounds, 1-based; 0 when the ledger holds nothing usable.
 */
export function reviewRoundsFromLedger(events) {
  const stream = Array.isArray(events) ? events : [];
  if (!stream.length) return 0;
  const ledger = foldJuryLedger(stream);
  // A stream that folds to neither a roster nor a single juror carried no jury run — foreign lines, or events
  // whose every juror reference was unattributable. Report 0 rather than crediting it with round+1 = 1.
  if (!ledger.rosterKnown && ledger.jurors.length === 0) return 0;
  return ledger.round + 1;
}

/**
 * The panel's strictest verdict from the same fold, or null. Used ONLY as the fallback for what is owed when a
 * PR carries no review label at all — the ledger is the authority and the label is derived intent, so when the
 * derived thing is missing, ask the authority. PURE.
 *
 * @param {Array<object>} events - raw append-only jury events for one subject.
 * @returns {'accept'|'changes'|'needs-human'|'prevention-outstanding'|null}
 */
export function ledgerPanelVerdict(events) {
  const stream = Array.isArray(events) ? events : [];
  if (!stream.length) return null;
  return foldJuryLedger(stream).panelVerdict;
}

/**
 * The verdict-ledger rows that COUNT AS A REVIEW ROUND — a reviewer judging the diff. The three exclusions are
 * `verdict-ledger.mjs`'s own, quoted in the file header: `pending` is the drain parking the PR, `restamped` is an
 * acceptance carried across a rebase with no review run, and `clear-human` is a hold being lifted by ceremony.
 * Counting any of them would put a round on the board that nobody reviewed.
 */
export const ROUND_VERDICTS = Object.freeze([LEDGER_VERDICTS.ACCEPTED, LEDGER_VERDICTS.CHANGES, LEDGER_VERDICTS.HUMAN]);

/**
 * Review rounds for one PR from the append-only VERDICT ledger: one qualifying row, one round. No fold is needed
 * — the ledger's own rule is latest-wins per PR and every row is already a distinct recorded verdict, so counting
 * rows IS counting rounds. PURE.
 *
 * @param {Array<object>} records - the repo's verdict records, in append order.
 * @param {number|string} pr
 * @returns {number}
 */
export function reviewRoundsFromVerdictLedger(records, pr) {
  const n = Number(pr);
  return (Array.isArray(records) ? records : [])
    .filter((r) => r && Number(r.pr) === n && ROUND_VERDICTS.includes(r.verdict)).length;
}

/**
 * The LIVE verdict for one PR from the verdict ledger — latest-wins, the ledger's only rule. Unlike the round
 * count this includes every row: a `pending` re-arm or a `restamped` clear is not a round, but it IS the PR's
 * current recorded state. PURE.
 *
 * @param {Array<object>} records
 * @param {number|string} pr
 * @returns {string|null}
 */
export function latestLedgerVerdict(records, pr) {
  const n = Number(pr);
  let latest = null;
  for (const r of Array.isArray(records) ? records : []) if (r && Number(r.pr) === n && r.verdict) latest = r.verdict;
  return latest;
}

/**
 * The reported REV figure: the most rounds any ledger can account for. A PR reviewed through the convergence
 * loop has jury events and no verdict rows; one reviewed through `review-set-label` has verdict rows and no jury
 * events — so the higher of the two is not double-counting, it is picking the ledger that saw the review. PURE.
 *
 * @param {{ juryEvents?: Array<object>, verdictRecords?: Array<object>, pr: (number|string) }} o
 * @returns {number}
 */
export function reviewRounds({ juryEvents = [], verdictRecords = [], pr } = {}) {
  return Math.max(reviewRoundsFromLedger(juryEvents), reviewRoundsFromVerdictLedger(verdictRecords, pr));
}

/**
 * What each ledger verdict says is OWED, normalized across BOTH ledgers' vocabularies (the jury panel speaks
 * `accept`/`changes`/`needs-human`/`prevention-outstanding`, the verdict ledger speaks `accepted`/`changes`/
 * `pending`/`human`/`clear-human`/`restamped`). One table so `derivePhase` never has to know which ledger
 * answered, and so an unknown word can only be absent — never a guess.
 *
 * A TABLE, NOT A SWITCH, AND THAT IS THE FIX FOR PR #1574's REVIEW. The switch this replaces had no arm for
 * `prevention-outstanding`, so a labelless PR whose jury ledger already sat at that verdict fell to `null` and
 * printed `STUCK: no review label` — "never reviewed" about a PR that had CONVERGED. The reason nothing caught
 * it is structural: #2823's derive-based totality gate (`we:scripts/lib/verdict-totality.mjs`) discovers a
 * `VERDICTS` consumer by seeing its members in OBJECT-KEY position, and `case 'changes':` is not key position,
 * so this function was invisible to the gate that exists for exactly this defect class. Written as a keyed
 * table it is discovered, must carry `@verdicts-total`, and `check:standards` now FAILS if a fifth `VERDICTS`
 * member is added without an arm here. That is the prevention the review asked for, taken as a gate rather
 * than as a one-off assertion.
 *
 * NULL PROTOTYPE (jury-core's `freezeTable` rule): the key is free-form ledger text, so a plain frozen literal
 * would answer `TABLE['constructor']` with an inherited member and the guard would fail OPEN. Nothing is
 * inherited here, and the read goes through `Object.hasOwn` as well.
 *
 * @verdicts-total — every `VERDICTS` member is a key (the `check:standards` verdict-totality gate enforces it).
 */
const OWED_BY_LEDGER_VERDICT = Object.freeze(Object.assign(Object.create(null), {
  // ── the JURY panel vocabulary (`we:scripts/lib/jury-core.mjs`'s `VERDICTS`) ──
  accept: 'none',
  changes: 'fix',
  'needs-human': 'human',
  // #2823's fourth member: every finding IS resolved, but a named prevention guard is neither captured by an
  // existing gate nor filed as an item, so a clean accept is withheld. `deriveNegotiationOutcome` escalates it
  // STRAIGHT to the operator rather than re-entering the round loop — nothing is owed to a fixer and nothing is
  // owed to a reviewer, so it is its own owed value and gets its own stuck reason. Folding it into `human`
  // would print `human gate`, which this file's rule 3 reserves for the `review:human` LABEL (policy-tier
  // code); folding it into `none` would call an un-landable PR READY.
  'prevention-outstanding': 'prevention',
  // ── the VERDICT ledger vocabulary (`we:scripts/lib/verdict-ledger.mjs`) ──
  accepted: 'none',
  pending: 'review',
  human: 'human',
  'clear-human': 'none',
  restamped: 'none',
}));

/**
 * What a ledger verdict says is OWED — a lookup into `OWED_BY_LEDGER_VERDICT`. PURE; an unknown verdict is
 * `null`, never a guess.
 *
 * @param {string|null} verdict
 * @returns {'fix'|'review'|'human'|'prevention'|'none'|null}
 */
export function owedFromLedgerVerdict(verdict) {
  const key = String(verdict ?? '');
  return Object.hasOwn(OWED_BY_LEDGER_VERDICT, key) ? OWED_BY_LEDGER_VERDICT[key] : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE — WHICH LIVE LANE OWNS THIS BRANCH (rule 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LiveProcess
 * @property {number|string} pid - the live process's pid.
 * @property {string} elapsed - how long it has been running, already compacted (`4m`, `1h02m`).
 *
 * @typedef {Object} Lane
 * @property {string} lane - the lane directory basename, e.g. `lane-26`.
 * @property {string} dir - the lane's absolute path.
 * @property {LiveProcess[]} [live] - the live `claude` processes sitting in this lane, if any.
 *
 * @typedef {Object} LaneOwner
 * @property {string} lane
 * @property {string} dir
 * @property {LiveProcess|null} live - the live process in this lane, or null when the lane is idle.
 */

/**
 * Which lane owns this PR branch, and is anyone alive in it. THE ancestry rule (rule 1), isolated so it is
 * testable with no git and no processes: `headOf` and `isAncestor` are injected probes.
 *
 * A lane owns the branch when the branch's pushed head is an ANCESTOR OF (or equal to) the lane's HEAD. Equality
 * alone is the bug this exists to avoid: a fixer that has committed locally but not yet pushed has a lane HEAD
 * strictly ahead of the branch head, and an equality test calls that lane a stranger at the exact moment it is
 * doing the work. Ancestry covers equality, so there is no case where equality is right and ancestry is not, and
 * no second code path to drift.
 *
 * OWNERSHIP AND LIVENESS ARE SEPARATED ON PURPOSE, and it is not a nicety. If ownership were only ever computed
 * for lanes that hold a live process, an agent that STOPPED TO ASK — whose process has since exited — would have
 * no findable lane, and rule 4's `needs human` could never fire in the case it exists for. So this returns the
 * owning lane either way and reports `live: null` when nobody is in it; `derivePhase` is what refuses to call an
 * idle lane `FIXING`.
 *
 * Among owning lanes a LIVE one wins: if two lanes carry the branch's history (a stale lane and the one actually
 * working), the working one is the answer. A lane whose HEAD cannot be read, or whose probe throws, is SKIPPED
 * rather than claimed — an unreadable lane is not evidence of anything.
 *
 * @param {{ branchHead: string|null, lanes: Lane[],
 *           headOf: (dir:string)=>(string|null),
 *           isAncestor: (dir:string, ancestor:string, descendant:string)=>boolean }} o
 * @returns {LaneOwner|null}
 */
export function selectOwningLane({ branchHead, lanes = [], headOf, isAncestor } = {}) {
  if (!branchHead || !Array.isArray(lanes) || typeof headOf !== 'function' || typeof isAncestor !== 'function') {
    return null;
  }
  const owners = [];
  for (const l of lanes) {
    if (!l || !l.dir) continue;
    let laneHead = null;
    try { laneHead = headOf(l.dir); } catch { laneHead = null; }
    if (!laneHead) continue;
    let owns = false;
    try { owns = isAncestor(l.dir, branchHead, laneHead) === true; } catch { owns = false; }
    if (!owns) continue;
    const live = Array.isArray(l.live) && l.live.length ? l.live[0] : null;
    owners.push({ lane: l.lane, dir: l.dir, live });
  }
  if (!owners.length) return null;
  return owners.find((o) => o.live) || owners[0];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE — THE TRANSCRIPT (rules 4 and 5)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `~/.claude/projects/` directory name for a working directory. Claude Code encodes the absolute cwd by
 * replacing every non-alphanumeric character with `-`, so `/Users/x/workspace/.lanes/web-everything/lane-1`
 * becomes `-Users-x-workspace--lanes-web-everything-lane-1` (the leading `/` and the `.` of `.lanes` each
 * contribute one `-`, which is where the doubled dash comes from). PURE.
 *
 * @param {string} cwd - an absolute working directory.
 * @returns {string} the project directory basename.
 */
export function projectDirName(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Parse a transcript's JSONL into entries, SKIPPING any line that does not parse. Another process is appending
 * to this file while we read it, so a truncated final line is normal, not corruption — rule 5 says a bad
 * transcript costs at most one decorative line. PURE.
 *
 * @param {string} text - raw `.jsonl` contents.
 * @returns {object[]} the entries that parsed, in file order.
 */
export function parseTranscript(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch { /* a half-written or rotated line — skip it, never fail the report */ }
  }
  return out;
}

/** The content blocks of a transcript entry, always an array (a string content becomes one text block). */
function contentBlocks(entry) {
  const c = entry && entry.message && entry.message.content;
  if (Array.isArray(c)) return c.filter((b) => b && typeof b === 'object');
  if (typeof c === 'string' && c.trim()) return [{ type: 'text', text: c }];
  return [];
}

/** Collapse whitespace and cut to `max`, appending `…` when it actually cut. PURE. */
function squeeze(s, max) {
  const t = String(s ?? '').split(/\s+/).filter(Boolean).join(' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * What the agent in this lane is doing at this moment: the LAST `tool_use` or non-empty text in its transcript.
 * Sidechain (sub-agent) entries are INCLUDED here on purpose — when the session has fanned out, the sub-agent's
 * tool call is the truthful answer to "what is happening right now", and this line is display only. PURE.
 *
 * @param {object[]} entries - parsed transcript entries in file order.
 * @returns {string} a one-line description, or '' when the transcript says nothing usable.
 */
export function lastActivity(entries) {
  let last = '';
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const b of contentBlocks(entry)) {
      if (b.type === 'tool_use') {
        const input = (b.input && typeof b.input === 'object') ? b.input : {};
        const detail = input.description || input.command || input.file_path || input.pattern || '';
        const name = b.name || 'tool';
        last = detail ? `${name}: ${squeeze(detail, 70)}` : String(name);
      } else if (b.type === 'text' && String(b.text || '').trim()) {
        last = `says: ${squeeze(b.text, 70)}`;
      }
    }
  }
  return last;
}

/**
 * Did the agent in this lane STOP TO ASK? Rule 4, in its narrow decidable shape — see the file header for the
 * exact conditions and, more importantly, for the two things this deliberately cannot see.
 *
 * Sidechain entries are EXCLUDED here (unlike `lastActivity`): a sub-agent ending on a question is a sub-agent
 * reporting back, not the session waiting on a person, and counting it would strand PRs whose main loop is fine.
 *
 * PURE and conservative in every uncertain direction — an absent `stop_reason`, a trailing `tool_use`, a text
 * block that does not end in `?`, or a later main-chain entry of any kind all report `asked: false`.
 *
 * @param {object[]} entries - parsed transcript entries in file order.
 * @returns {{ asked: boolean, question: string }} `question` is '' unless `asked`.
 */
export function detectPendingQuestion(entries) {
  const none = { asked: false, question: '' };
  const chain = (Array.isArray(entries) ? entries : []).filter((e) => e && e.isSidechain !== true && e.message);
  const last = chain[chain.length - 1];
  if (!last || last.type !== 'assistant') return none;

  // An UNKNOWN stop_reason is not a stop. Only the explicit `end_turn` — the model chose to hand back — counts;
  // `tool_use`, `max_tokens`, a null, or a missing field all mean we cannot say the agent is waiting on anybody.
  if (last.message.stop_reason !== 'end_turn') return none;

  const blocks = contentBlocks(last).filter((b) => b.type !== 'thinking');
  const tail = blocks[blocks.length - 1];
  // The turn must have ENDED ON WORDS. A trailing tool_use means the turn ended on an action, and whatever the
  // text before it said, the agent was not handing the floor to a human.
  if (!tail || tail.type !== 'text') return none;

  const lines = String(tail.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const closing = lines[lines.length - 1];
  if (!closing || !closing.endsWith('?')) return none;
  return { asked: true, question: squeeze(closing, 70) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE — THE PHASE (rule 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Normalize a gh labels array (objects `{name}` or plain strings) to a name array. PURE. */
function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter((n) => typeof n === 'string');
}

/**
 * THE DERIVATION. Given what the PR's labels say is OWED, whether a live process is PROVABLY working on it, and
 * what the lane's transcript shows, return the phase.
 *
 * The one invariant, and the reason this function is separate and tested: `FIXING` and `REVIEWING` are reachable
 * ONLY when `worker` is non-null. There is no label, no ledger state and no marker that can produce them. A
 * `review:changes` PR with nobody on it is STUCK, and saying so is the entire product.
 *
 * The label is not being trusted to say what is HAPPENING — only what is OWED, which is what a label can honestly
 * carry (the same relation `we:scripts/lib/auto-land-seam.mjs` draws: ledger as authority, label as derived
 * intent). "Someone is working" comes from the process; "on what" comes from the label. Neither alone is enough.
 *
 * Precedence, and THE CODE BELOW IS IN THIS ORDER so the two cannot drift: READY (nothing is owed, so no one
 * needs to be working) → an unanswered question (nobody is progressing regardless of whether a process is still
 * parked at the prompt, and a restart would re-ask it) → a live worker → the owed-work stall.
 *
 * PR #1574's REVIEW FOUND THAT ORDER BROKEN, and it is worth saying how. READY used to be reachable only two
 * ways: a READY label (checked first, so fine) or the `owed === 'none'` arm of the trailing switch — and that
 * switch ran only in the `else` of `if (worker)`. So `{labels: [], worker: <live>, ledgerOwed: 'none'}` reported
 * FIXING: the ledger had already recorded the acceptance, no label contradicted it because none was present,
 * and a fixer's session merely happened to still be alive in the lane. That is not a hypothetical state — it is
 * `verdict-ledger.mjs`'s own `AGREEMENT.UNLABELED`, the divergence its Phase-1 shadow checker exists to catch
 * (the label write lagging behind the ledger append). The `owed === 'none'` test is therefore hoisted to sit
 * beside the label test, where the docblock always said it was: nothing owed outranks everything, INCLUDING a
 * live worker, because a worker is evidence that someone is working, never evidence that anything is owed.
 *
 * @param {{ labels?: Array<string|{name:string}>, worker?: {lane:string,pid:(number|string),elapsed:string}|null,
 *           pendingQuestion?: {asked:boolean, question:string}|null,
 *           ledgerOwed?: 'fix'|'review'|'human'|'prevention'|'none'|null }} o
 * @returns {{ phase: string, reason: string, display: string }} `display` is the printable phase cell.
 */
export function derivePhase({ labels = [], worker = null, pendingQuestion = null, ledgerOwed = null, ownerState = null } = {}) {
  const names = labelNames(labels);
  const has = (l) => names.includes(l);
  // Only absence-derived stalls accept the session-aware verdict. Human/prevention gates retain authority.
  const stuck = (reason) => {
    if (ownerState && [STUCK_REASONS.BOUNCED_NO_FIXER, STUCK_REASONS.NO_REVIEWER, STUCK_REASONS.NO_LABEL].includes(reason)) {
      return { phase: ownerState.phase, reason: ownerState.headline,
        display: `${ownerState.phase}: ${ownerState.headline}` };
    }
    return { phase: PHASES.STUCK, reason, display: `${PHASES.STUCK}: ${reason}` };
  };
  const settled = (phase) => ({ phase, reason: '', display: phase });

  // When no label says what is owed, ask the LEDGER — the authority the label is derived from — instead of
  // reporting "no label" over a jury that has already ruled on the diff. Computed FIRST because the READY test
  // just below needs it; nothing here depends on the worker or on the question.
  const owed = has(REVIEW_LABELS.changes) ? 'fix'
    : has(REVIEW_LABELS.pending) ? 'review'
      : has(REVIEW_LABELS.human) ? 'human'
        : ledgerOwed;

  // NOTHING IS OWED — the first rung of the precedence, by either route. The label route is a PR the drain may
  // take; the ledger route is the same PR before the label caught up (`review:ledger-check` is the tool that
  // adjudicates that disagreement, but for "what is happening right now" the honest answer is: nothing is owed).
  if (READY_LABELS.some(has) || owed === 'none') return settled(PHASES.READY);

  if (pendingQuestion && pendingQuestion.asked === true) return stuck(STUCK_REASONS.NEEDS_HUMAN);

  if (worker) {
    // A live process is PROVEN. `owed` only decides which of the two working phases to name it — it can never
    // conjure one, which is why every arm here sits behind `if (worker)`. `prevention` falls to FIXING: filing
    // the named guard is authoring work, not a review of this diff.
    return settled(owed === 'review' || owed === 'human' ? PHASES.REVIEWING : PHASES.FIXING);
  }

  switch (owed) {
    case 'fix': return stuck(STUCK_REASONS.BOUNCED_NO_FIXER);
    case 'review': return stuck(STUCK_REASONS.NO_REVIEWER);
    case 'human': return stuck(STUCK_REASONS.HUMAN_GATE);
    // The jury CONVERGED — every finding is resolved — and is held back only by a prevention guard nobody has
    // filed yet. "No review label" would read as never-reviewed, and `human gate` is rule 3's reserved name for
    // the `review:human` LABEL; this stall wants a guard FILED, which is neither of those interventions.
    case 'prevention': return stuck(STUCK_REASONS.PREVENTION_UNFILED);
    default: return stuck(STUCK_REASONS.NO_LABEL);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE — RENDERING
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Compact a `ps -o etime=` value to something that fits a column. `ps` emits `MM:SS`, `HH:MM:SS` or
 * `DD-HH:MM:SS`; this yields `47s`, `4m`, `1h02m`, `3d04h`. An unparseable value comes back trimmed rather than
 * dropped — a weird elapsed string is still better than a blank one. PURE.
 *
 * @param {string} etime - raw `ps` elapsed time.
 * @returns {string}
 */
export function compactElapsed(etime) {
  const raw = String(etime || '').trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw);
  if (!m) return raw;
  const [, d, h, mm, ss] = m;
  const days = Number(d || 0);
  const hours = Number(h || 0);
  const mins = Number(mm || 0);
  const secs = Number(ss || 0);
  if (days) return `${days}d${String(hours).padStart(2, '0')}h`;
  if (hours) return `${hours}h${String(mins).padStart(2, '0')}m`;
  if (mins) return `${mins}m`;
  return `${secs}s`;
}

/** Pad to `width`, never truncating — a long cell pushes the row rather than losing information. PURE. */
const pad = (s, width) => {
  const t = String(s ?? '');
  return t.length >= width ? `${t} ` : t + ' '.repeat(width - t.length);
};

/** The column widths, one place, shared by the header and every row. */
const COLS = Object.freeze({ pr: 6, phase: 26, rev: 5, fix: 5, worker: 22, title: 34 });

/**
 * @typedef {Object} StatusRow
 * @property {number|string} pr
 * @property {string} phaseDisplay - the printable phase cell (`FIXING`, `STUCK: no reviewer`, …).
 * @property {number} reviewRounds
 * @property {number} fixCommits
 * @property {{lane:string,pid:(number|string),elapsed:string}|null} worker - the LIVE worker, or null.
 * @property {string} title
 * @property {string} [activity] - the best-effort `now:` line; omitted or '' prints no second line.
 * @property {string} [question] - the pending question, printed instead of `activity` when one was detected.
 */

/**
 * Render the whole report. PURE — every row is already decided by the time it gets here, which is what lets the
 * table be snapshot-tested with no process, no gh and no git.
 *
 * @param {StatusRow[]} rows
 * @returns {string} the report, newline-terminated; a header-only table when there are no open PRs.
 */
export function renderReport(rows) {
  const out = [
    pad('PR', COLS.pr) + pad('PHASE', COLS.phase) + pad('REV', COLS.rev) + pad('FIX', COLS.fix)
    + pad('WORKER', COLS.worker) + 'TITLE',
  ];
  for (const r of Array.isArray(rows) ? rows : []) {
    const who = r.worker ? `● ${r.worker.lane} pid${r.worker.pid} ${r.worker.elapsed}` : '';
    out.push(
      pad(r.pr, COLS.pr) + pad(r.phaseDisplay, COLS.phase)
      + pad(`r${r.reviewRounds}`, COLS.rev) + pad(`c${r.fixCommits}`, COLS.fix)
      + pad(who, COLS.worker) + squeeze(r.title, COLS.title),
    );
    // The question, when there is one, REPLACES the activity line: the last thing the agent did IS the question,
    // and printing it as `asks:` says why the PR is stuck instead of leaving the reader to infer it.
    if (r.question) out.push(`      └─ asks: ${r.question}`);
    else if (r.activity) out.push(`      └─ now: ${r.activity}`);
  }
  return `${out.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// IMPURE SHELL — the four probes, each fail-soft
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Run a command and return trimmed stdout, or '' on any failure. Never throws — every probe here is optional. */
function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch { return ''; }
}

/**
 * Every lane under the pool root, each with the live `claude` processes sitting in it.
 *
 * TWO LEVELS, because that is where lanes actually are. `defaultPoolRoot` returns `<workspace>/.lanes`, and
 * `lane-pool.mjs` puts each POOL in a directory under it named for the checkout (`.lanes/web-everything/lane-30`).
 * Scanning one level finds nothing but pool names. Both depths are scanned so `--lanes-root` accepts either the
 * pool root or a single pool. EVERY pool is scanned, not just this repo's: a cross-locus couple lane is a real
 * worker, and the ancestry test in `selectOwningLane` already rejects any lane that does not carry the branch —
 * so widening the search cannot produce a false owner, only find a true one that a narrower search would miss.
 *
 * Lanes are listed from the FILESYSTEM, not from the process table, precisely so an IDLE lane is still visible
 * (see `selectOwningLane` — that is how a stopped-to-ask agent is found).
 *
 * Fail-soft: a host without `pgrep`/`lsof` reports lanes with no live processes, and every PR then reads as
 * STUCK — which is the honest answer when this command cannot PROVE anyone is working. It never invents one.
 *
 * @param {string} lanesRoot
 * @returns {Lane[]}
 */
function listLanes(lanesRoot) {
  const dirsIn = (d) => {
    try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return []; }
  };
  /** absolute lane dir → its basename. */
  const laneDirs = [];
  for (const name of dirsIn(lanesRoot)) {
    const abs = join(lanesRoot, name);
    if (name.startsWith('lane-')) laneDirs.push(abs);
    else for (const inner of dirsIn(abs)) if (inner.startsWith('lane-')) laneDirs.push(join(abs, inner));
  }
  if (!laneDirs.length) return [];

  /** lane dir → live processes whose cwd is inside it. */
  const liveByDir = new Map();
  for (const pid of sh('pgrep', ['-f', '^claude']).split(/\s+/).filter(Boolean)) {
    const cwdOut = sh('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']);
    const cwd = (cwdOut.split('\n').find((l) => l.startsWith('n')) || '').slice(1);
    if (!cwd) continue;
    // The process's cwd may be a SUBDIRECTORY of the lane (an agent that cd'd into `scripts/`), so match by
    // prefix rather than by equality — the longest matching lane wins.
    const owner = laneDirs.filter((d) => cwd === d || cwd.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
    if (!owner) continue;
    const rec = { pid: Number(pid) || pid, elapsed: compactElapsed(sh('ps', ['-o', 'etime=', '-p', pid])) };
    if (!liveByDir.has(owner)) liveByDir.set(owner, []);
    liveByDir.get(owner).push(rec);
  }

  return laneDirs.map((dir) => ({ lane: dir.slice(dir.lastIndexOf('/') + 1), dir, live: liveByDir.get(dir) || [] }));
}

/** `git rev-parse <ref>` in a directory, or null. */
function revParse(dir, ref) {
  return sh('git', ['-C', dir, 'rev-parse', ref]) || null;
}

/** The injected HEAD probe for `selectOwningLane`. */
function headOf(dir) {
  return revParse(dir, 'HEAD');
}

/** `git merge-base --is-ancestor` as a boolean — THE ownership probe (rule 1). Exit 0 means ancestor. */
function isAncestor(dir, ancestor, descendant) {
  const r = spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Read the newest transcript for a lane. Best-effort in every direction — rule 5: a missing directory, an empty
 * one, an unreadable file or a half-written line costs at most one decorative line, never the report.
 * @param {string} laneDir
 * @returns {{ activity: string, question: string, asked: boolean }}
 */
function readLaneTranscript(laneDir) {
  const empty = { activity: '', question: '', asked: false };
  try {
    const dir = join(homedir(), '.claude', 'projects', projectDirName(laneDir));
    if (!existsSync(dir)) return empty;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
    if (!files.length) return empty;
    const newest = files.map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
    const entries = parseTranscript(readFileSync(newest, 'utf8'));
    const q = detectPendingQuestion(entries);
    return { activity: lastActivity(entries), question: q.question, asked: q.asked };
  } catch { return empty; }
}

/** Open PRs from gh, lowest number first. `[]` when gh cannot answer (an uncredentialed host, no network). */
function listOpenPrs(repoRoot) {
  const raw = sh('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName,labels,title'], { cwd: repoRoot });
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? [...list].sort((a, b) => a.number - b.number) : [];
  } catch { return []; }
}

/** `--flag=value` / `--flag` parsing into a plain bag. */
function parseArgs(argv) {
  const flags = {};
  for (const a of Array.isArray(argv) ? argv : []) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  }
  return flags;
}

/**
 * Assemble one PR's row from the four probes. Every DECISION in here is a call into a pure exported function;
 * this only fetches the inputs and hands them over.
 */
function buildRow(pr, { gitRoot, juryRoot, lanes, verdictRecords, noSessions = false }) {
  let juryEvents = [];
  try { juryEvents = readJuryLog(`${SUBJECT_PREFIX}#${pr.number}`, { root: juryRoot }); } catch { juryEvents = []; }

  const branchHead = revParse(gitRoot, `origin/${pr.headRefName}`);
  const owner = selectOwningLane({ branchHead, lanes, headOf, isAncestor });
  // rule 1 — ONLY a live process becomes a `worker`. An owning-but-idle lane is still read for its transcript
  // (that is how a stopped-to-ask agent is found) but it never earns FIXING or REVIEWING.
  const worker = owner && owner.live ? { lane: owner.lane, pid: owner.live.pid, elapsed: owner.live.elapsed } : null;
  const transcript = owner ? readLaneTranscript(owner.dir) : { activity: '', question: '', asked: false };

  // Both ledgers get a say about what is owed; the VERDICT ledger is preferred because it is the one the label
  // writer keeps in step, and the jury panel answers for subjects the convergence loop ran.
  const ledgerOwed = owedFromLedgerVerdict(latestLedgerVerdict(verdictRecords, pr.number))
    ?? owedFromLedgerVerdict(ledgerPanelVerdict(juryEvents));

  let ownerState = null;
  if (!noSessions) {
    try { ownerState = derivePrState(readPrFacts(pr.number), settingsFromEnv(process.env)); }
    catch { /* a session probe cannot break the existing report */ }
  }
  const { display } = derivePhase({
    ownerState,
    labels: pr.labels,
    worker,
    pendingQuestion: { asked: transcript.asked, question: transcript.question },
    ledgerOwed,
  });

  const base = branchHead ? sh('git', ['-C', gitRoot, 'merge-base', 'origin/main', branchHead]) : '';
  const fixCommits = base ? Number(sh('git', ['-C', gitRoot, 'rev-list', '--count', `${base}..${branchHead}`])) || 0 : 0;

  return {
    pr: pr.number,
    phaseDisplay: display,
    reviewRounds: reviewRounds({ juryEvents, verdictRecords, pr: pr.number }),
    fixCommits,
    worker,
    title: pr.title || '',
    // The activity line belongs to a LIVE lane. Printing the last thing a dead lane did as "now:" would be the
    // same stale-claim lie the phase rule exists to refuse — so an idle owner prints no `now:` line at all.
    activity: worker ? transcript.activity : '',
    question: transcript.asked ? transcript.question : '',
  };
}

/**
 * The CLI. Flags:
 *   `--jury-root=<checkout>`  where to read `.conveyor/jury` from (default: this script's checkout). `.conveyor`
 *                             is gitignored per-checkout state, so running from a lane sees the LANE's ledgers —
 *                             point this at the primary when you want the ledgers the drain actually wrote.
 *   `--lanes-root=<dir>`      the pool ROOT (or a single pool dir) to scan for lanes and live workers
 *                             (default: derived from this checkout via `defaultPoolRoot`).
 *   `--no-sessions`           skip managed session/completion/hand-off probes.
 *   `--no-fetch`              skip the `git fetch`, for a fast offline read of whatever refs are already local.
 *   `--json`                  emit the rows as JSON instead of the table.
 */
function main(argv) {
  const flags = parseArgs(argv);
  const juryRoot = typeof flags['jury-root'] === 'string' ? resolve(flags['jury-root']) : REPO_ROOT;
  const lanesRoot = typeof flags['lanes-root'] === 'string' ? resolve(flags['lanes-root']) : defaultPoolRoot(REPO_ROOT);
  const gitRoot = REPO_ROOT;

  // Ancestry is only as truthful as the refs behind it: a stale `origin/<branch>` makes a lane that HAS the work
  // look like a stranger. Fetch first unless told not to.
  if (!flags['no-fetch']) sh('git', ['-C', gitRoot, 'fetch', '--quiet', 'origin']);

  const lanes = listLanes(lanesRoot);
  // One read of the whole repo ledger, shared by every row — it is a single append-only file.
  let verdictRecords = [];
  try { verdictRecords = readVerdictLedger(CONSTELLATION_REPOS[SUBJECT_PREFIX].slug); } catch { verdictRecords = []; }
  const rows = listOpenPrs(gitRoot).map((pr) => buildRow(pr, { gitRoot, juryRoot, lanes, verdictRecords, noSessions: flags['no-sessions'] }));

  writeAllSync(1, flags.json ? `${JSON.stringify(rows, null, 2)}\n` : renderReport(rows));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
