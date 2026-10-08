/**
 * @file scripts/operations/agent-activity.mjs
 * @description backlog #3932 (epic #3931, under #3383) — the CARD ↔ RUN JOIN. Pure core: given every agent
 * session/job/subagent already on the laptop (as plain rows the IO shell assembles — see
 * `./agent-activity-io.mjs`), decide which `/wip` card or PR each one belongs to, or that it is unmatched.
 * Design: plateau:docs/wip-live-agent.md §1.3 ("the card ↔ run join"). No model call, no fs, no clock.
 *
 * ORDERED RESOLVERS, FIRST MATCH WINS (design §1.3), extended for what is actually on this machine today
 * rather than the design doc's mid-2026-09-22 snapshot:
 *
 *   1. **name**   — the session/job slug via `parseSessionSlug` (`we:scripts/conveyor/session-slug.mjs`).
 *      An ITEM kind (`conveyor-N`, `prepare-N`, `prepare-decision-N`) names a card directly. A PR kind
 *      (`review-…-P`, `fix-…-P`, `ci-heal-…-P`, `inspect-…-P`) names a PR; the card comes from the caller's
 *      `prToCard` map, KEYED `${repo}:${pr}` — repo-tagged, since the same PR number can exist in more than
 *      one constellation repo. **A review JOB record already impersonates this shape** — PR #2674 made
 *      reviews detached node jobs, not `claude --bg` sessions, and `review-job-store.mjs#jobRecordToAgentRow`
 *      deliberately gives each live job record the same `name` a `claude --bg` review session would have had
 *      — so a job row needs no separate resolver, it rides this one for free.
 *   2. **codex-thread** — a Codex run's `we:.operations/codex-delivery-threads/<slug>.json` record names its
 *      OWN dispatch slug; that slug is parsed exactly like resolver 1.
 *   3. **parent**  — a subagent inherits its parent's own resolved card. A WORKFLOW-LANE child (run under
 *      `<session>/subagents/workflows/<runId>/`, one lane per card) instead takes the first `#NNN`/`#xNNNNNN`
 *      in ITS OWN first message (`workflowLane: true` + `firstMessageMention` on the row) — its parent is the
 *      orchestrator, which owns no single card of its own.
 *   4. **lane**    — a lane lease naming this session as `ownerSession`/`workerSession`. THE #3383 LANE-LEASE
 *      SHAPE HAS NO `branch` FIELD (checked live 2026-09-26 against `.git/.lane-lease` in an acquired lane —
 *      see this card's build notes): guard-lane's single-branch-workflow rule keeps every lane checkout on
 *      `main` locally, so the design doc's "branch `lane/<num>-…`" is dated. The card number lives in the
 *      lease's own `purpose`/`session` string instead (e.g. `build-3932`), pulled by {@link extractLaneHint}.
 *   5. **claim**   — the session's own net-claimed backlog items (claim-replay, incremental — IO's job, not
 *      this file's), most-recently-claimed wins.
 *   6. **mention** — a subagent with no resolved parent, first `#NNN` in its own prompt. Weak: tagged so a
 *      wrong guess is visible (design §1.3, §5.11).
 *
 * INTERACTIVE SESSIONS (`kind: 'interactive'`) only ever try 4 and 5 — never 1/2/3/6 — matching design §1.3:
 * *"The operator's own interactive session is never listed unless resolvers 4–5 tie it to a card."* An
 * unresolved interactive row is dropped entirely (never `runs`, never `unmatched`); an unresolved row of any
 * other kind lands in `unmatched`.
 *
 * A PR-kind match records `pr: {repo, number}` even when `prToCard` has no entry for it — the card mapping
 * is the CALLER's (Plateau's `/wip` snapshot already builds one; the follow-up `item-activity` operation,
 * backlog x0uad06, may call this before one exists at all) — so the run still says "reviewing PR 2267", card
 * `null`, rather than falling all the way to `unmatched` for a PR we can plainly name.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { parseSessionSlug } from '../conveyor/session-slug.mjs';

export const AGENT_ACTIVITY_OP = 'agent-activity';

/** Shared six-hour activity window for background, Codex and interactive readers. */
export const STALE_ROW_MS = 6 * 3600_000;

/** A completion only terminates the dispatch it postdates, never a newer re-dispatch. */
export function codexRowIsTerminal(row, completion) {
  return completion?.status === 'done' && Number.isFinite(row.startedAt)
    && Date.parse(completion.updatedAt) >= row.startedAt;
}

/** Unknown activity is not stale; pid-bearing rows belong to the process liveness probe. */
export function isAgedOut(row, { now, staleMs = STALE_ROW_MS }) {
  if (!['background', 'codex'].includes(row.kind) || Number.isInteger(row.pid)) return false;
  const times = [row.lastActivityMs, row.startedAt]
    .map(value => typeof value === 'string' ? Date.parse(value) : value)
    .filter(Number.isFinite);
  return times.length > 0 && now - Math.max(...times) > staleMs;
}


/** kind (from `parseSessionSlug`) → the design's role vocabulary (§1.2). */
export const ROLE_BY_KIND = Object.freeze({
  conveyor: 'build', prepare: 'prepare', 'prepare-decision': 'prepare', 'prepare-item': 'prepare',
  review: 'review', fix: 'fix', 'ci-heal': 'ci-heal', inspect: 'inspect',
});

/** Bounded so a caller can hand this a whole first-message body with no separate truncation step. */
const SCAN_LIMIT = 4000;

/** First `#NNN` or `#xNNNNNN` in `text` — the card-mention grammar `we:scripts/dev/active-progress-watch.mjs`
 *  (`agentItemNum`) already uses, hash-anchored so a date/slug never false-matches. Null when absent. PURE. */
export function extractMention(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.slice(0, SCAN_LIMIT).match(/#(\d{2,5}|x[0-9a-z]{6})\b/i);
  return m ? m[1].toLowerCase() : null;
}

/** First plausible card token (numeric or `xNNNNNN` hash) inside a lane lease's `purpose`/`session` string —
 *  no leading `#` required (`build-3932`, `3932-agent-activity-resolver`, a bare `lane4167`). Digit-bounded
 *  (never preceded/followed by another digit, so a longer number is never split) but NOT alnum-bounded —
 *  live-checked 2026-09-26, a real lease can carry `session: 'lane4167'` with the card digits running
 *  straight up against a letter, no separator. Null when absent. PURE. */
export function extractLaneHint(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.slice(0, SCAN_LIMIT).match(/(?<!\d)(\d{2,6}|x[0-9a-z]{6})(?!\d)/i);
  return m ? m[1].toLowerCase() : null;
}

/** PURE. `prToCard` is a plain object keyed `${repo}:${id}` (id = the pr number as a string). `undefined`
 *  when the caller's map doesn't cover this PR — distinct from `null`, which this module never returns here. */
function cardForPr(prToCard, repo, id) {
  const key = `${repo}:${id}`;
  return Object.prototype.hasOwnProperty.call(prToCard || {}, key) ? prToCard[key] : undefined;
}

/** Resolver 1 — session/job name. Returns `{ card, pr?, joinVia }` or null. */
function tryName(row, ctx) {
  if (!row.name) return null;
  const parsed = parseSessionSlug(row.name);
  if (!parsed) return null;
  if (parsed.itemKind) return { card: parsed.id, joinVia: 'name' };
  const card = cardForPr(ctx.prToCard, parsed.repo, parsed.id);
  return { card: card === undefined ? null : card, pr: { repo: parsed.repo, number: Number(parsed.id) }, joinVia: 'name' };
}

/** Resolver 2 — Codex thread record naming its own dispatch slug. Returns `{ card, pr?, joinVia }` or null. */
function tryCodex(row, ctx) {
  if (!row.codexSlug) return null;
  const parsed = parseSessionSlug(row.codexSlug);
  if (!parsed) return null;
  if (parsed.itemKind) return { card: parsed.id, joinVia: 'codex-thread' };
  const card = cardForPr(ctx.prToCard, parsed.repo, parsed.id);
  return { card: card === undefined ? null : card, pr: { repo: parsed.repo, number: Number(parsed.id) }, joinVia: 'codex-thread' };
}

/** Resolver 3 — parent inheritance / workflow-lane self-mention. Needs the PARENT already resolved (passed
 *  in `ctx.resolvedBySession`, a `Map<sessionId, {card, pr?}>` the caller builds bottom-up). Null when the
 *  row has no parent, or (workflow lane) no mention, or (plain subagent) the parent isn't resolved yet. */
function tryParent(row, ctx) {
  if (!row.parentSessionId) return null;
  if (row.workflowLane) {
    const mention = row.firstMessageMention ?? extractMention(row.firstMessageText);
    return mention ? { card: mention, joinVia: 'parent' } : null;
  }
  const parent = ctx.resolvedBySession?.get(row.parentSessionId);
  if (!parent) return null;
  return { card: parent.card, pr: parent.pr, joinVia: 'parent' };
}

/** Resolver 4 — lane lease. `row.lease` is `{ purpose, session, ownerSession, workerSession } | null`
 *  (today's real shape — see this file's header). Null when no lease, the row isn't its owner/worker, or
 *  neither string yields a card hint. */
function tryLane(row) {
  const lease = row.lease;
  if (!lease || !row.sessionId) return null;
  if (row.sessionId !== lease.ownerSession && row.sessionId !== lease.workerSession) return null;
  const hint = extractLaneHint(lease.purpose) ?? extractLaneHint(lease.session);
  return hint ? { card: hint, joinVia: 'lane' } : null;
}

/** Resolver 5 — claim replay. `row.claimedNums` is the session's net-claimed set in claim order (IO's job to
 *  compute incrementally); the most recently claimed item wins. Null when empty/absent. */
function tryClaim(row) {
  if (!Array.isArray(row.claimedNums) || row.claimedNums.length === 0) return null;
  return { card: row.claimedNums[row.claimedNums.length - 1], joinVia: 'claim' };
}

/** Resolver 6 — weak mention fallback (any row, but only reached once 1–5 have all failed). */
function tryMention(row) {
  const mention = row.firstMessageMention ?? extractMention(row.firstMessageText);
  return mention ? { card: mention, joinVia: 'mention', weak: true } : null;
}

const ALL_RESOLVERS = [tryName, tryCodex, tryParent, tryLane, tryClaim, tryMention];
const INTERACTIVE_RESOLVERS = [tryLane, tryClaim];

function resolversFor(row) {
  return row.kind === 'interactive' ? INTERACTIVE_RESOLVERS : ALL_RESOLVERS;
}

function role(row, joinResult) {
  if (row.role) return row.role;
  if (row.kind === 'subagent') return 'subagent';
  if (row.kind === 'interactive') return 'session';
  if (row.name) {
    const parsed = parseSessionSlug(row.name);
    if (parsed && ROLE_BY_KIND[parsed.kind]) return ROLE_BY_KIND[parsed.kind];
  }
  if (row.codexSlug) {
    const parsed = parseSessionSlug(row.codexSlug);
    if (parsed && ROLE_BY_KIND[parsed.kind]) return ROLE_BY_KIND[parsed.kind];
  }
  return joinResult?.joinVia === 'lane' || joinResult?.joinVia === 'claim' ? 'session' : 'unknown';
}

function toRun(row, result, runIdBySession) {
  // The parent's EMITTED runId (its row `id`), never its sessionId — the two differ, and a consumer links runs
  // by runId. Null when the parent isn't among `rows` at all: there is no emitted run to point at.
  const parentRunId = row.parentSessionId ? runIdBySession.get(row.parentSessionId) ?? null : null;
  const out = {
    runId: row.id, runtime: row.runtime || 'claude', role: role(row, result), name: row.name ?? null,
    parentRunId, card: result.card ?? null, joinVia: result.joinVia,
    state: row.state ?? null, startedAt: row.startedAt ?? null, lastEventAt: row.lastEventAt ?? null,
  };
  if (result.pr) out.pr = result.pr;
  if (result.weak) out.weak = true;
  return out;
}

/**
 * Resolve every row to a run tied to a card/PR, or unmatched. PURE — a deterministic function of `rows` and
 * `ctx.prToCard`; every filesystem/process read that produced `rows` already happened in the IO shell.
 *
 * Parents are resolved before their children regardless of input order (bounded fixed-point over `rows`), so
 * a subagent whose parent appears later in the array still inherits correctly.
 *
 * @param {Array<object>} rows — see this file's header for the row contract.
 * @param {{ prToCard?: Record<string, string|number> }} [ctx]
 * @returns {{ runs: object[], unmatched: object[] }}
 */
export function resolveAgentActivity(rows, { prToCard = {} } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('agent-activity: rows must be an array');
  const ctx = { prToCard, resolvedBySession: new Map() };
  const runIdBySession = new Map();
  for (const row of rows) if (row.sessionId && !runIdBySession.has(row.sessionId)) runIdBySession.set(row.sessionId, row.id);
  const pending = new Map(rows.map((row, i) => [i, row]));
  const runs = [];
  const unmatched = [];
  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const [i, row] of [...pending]) {
      if (row.kind === 'subagent' && row.parentSessionId && !row.workflowLane
        && !ctx.resolvedBySession.has(row.parentSessionId) && pending.has(indexOfSession(rows, row.parentSessionId))) {
        continue; // parent still pending — try again next pass
      }
      let result = null;
      for (const resolver of resolversFor(row)) { result = resolver(row, ctx); if (result) break; }
      if (result) {
        if (row.sessionId) ctx.resolvedBySession.set(row.sessionId, { card: result.card, pr: result.pr });
        runs.push(toRun(row, result, runIdBySession));
      } else if (row.kind !== 'interactive') {
        unmatched.push({ runId: row.id, runtime: row.runtime || 'claude', name: row.name ?? null, kind: row.kind, cwd: row.cwd ?? null });
      }
      pending.delete(i);
      progressed = true;
    }
  }
  // Anything left is a subagent cycle/parent-never-resolves case — fall through to unmatched rather than drop it.
  for (const row of pending.values()) {
    if (row.kind !== 'interactive') unmatched.push({ runId: row.id, runtime: row.runtime || 'claude', name: row.name ?? null, kind: row.kind, cwd: row.cwd ?? null });
  }
  return { runs, unmatched };
}

function indexOfSession(rows, sessionId) {
  return rows.findIndex((r) => r.sessionId === sessionId);
}

/**
 * The declared operation (#3032 shape) — one `compute` step reads what the IO shell assembled, one `compute`
 * step runs the pure resolver above. No `judge`/`confirm`/`effect`: this is read-only, same reasoning as
 * `runner-activity`/`pr-status` — no sink exists to apply, and the HTTP adapter gives it a GET-only surface.
 * @param {{ readActivity: (input: object) => { rows: object[], prToCard: Record<string, unknown> } }} io
 */
export function agentActivityOperation({ readActivity } = {}) {
  if (typeof readActivity !== 'function') throw new TypeError('agent-activity needs a readActivity(input) reader');
  return op(AGENT_ACTIVITY_OP, {
    // `prToCard` is the CALLER's map (§1.3: "through a PR→card map passed in" — epic #3931's addendum: "the
    // pr-ownership read needs the SAME PR→card map this card takes as input"). This operation never derives
    // it — a `/wip` snapshot or the follow-up `item-activity` operation (backlog x0uad06) owns that lookup.
    input: {
      all: { type: 'boolean', required: false, default: false },
      prToCard: { type: 'object', required: false, default: {} },
    },
    verdictFrom: 'resolve',
    read: compute({ reads: ['input.all', 'input.prToCard'], fn: ({ input }) => {
      const found = readActivity(input);
      if (!found || !Array.isArray(found.rows)) {
        throw new Error('agent-activity.read: reader must return { rows: [...] }');
      }
      return { rows: found.rows, prToCard: input.prToCard || {} };
    } }),
    resolve: compute({ reads: ['findings.read'], fn: ({ findings }) => resolveAgentActivity(findings.read.rows, { prToCard: findings.read.prToCard }) }),
  });
}
