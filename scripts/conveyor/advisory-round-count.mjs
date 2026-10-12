/**
 * @file scripts/conveyor/advisory-round-count.mjs
 * @description THE DURABLE, RESTART-SURVIVING ATTEMPT COUNT FOR A `review:human` PR'S ADVISORY ROUNDS (#3383).
 *   Mirrors `we:scripts/conveyor/rearm-review.mjs#countRearmComments`'s own shape and reason for existing, for
 *   a population that marker cannot see.
 *
 * THE GAP THIS CLOSES — confirmed LIVE on `web-everything/web-everything#2117`: 33 separate advisory-panel comments
 * posted against the SAME "Findings (7)" content between 2026-09-15T00:24Z and 2026-09-15T19:13Z (roughly every
 * 20-90 minutes, no end condition), and a further burst on `#2298` on 2026-09-18/19. Both PRs carry
 * `review:changes` + `review:human`, so `classifyPr` (`we:scripts/progress-board.mjs`) reads them as `bounced`
 * and `we:scripts/conveyor/reconcile-core.mjs#planReconcile` dispatches a `fix` round for each, capped by
 * `NEGOTIATION_ROUND_CAP` (5) — BUT the cap is fed by `attempts = countRearmComments(pr.comments)`, and
 * `countRearmComments` counts the marker `we:scripts/conveyor/rearm-review.mjs` posts ONLY when a bounced PR is
 * successfully repaired and re-armed `review:changes → review:pending`. A PR whose fix round never actually
 * completes a rearm (the repair keeps failing, stalling, or getting reassigned) never posts that marker — so
 * `attempts` stays 0 forever, no matter how many rounds actually ran, and `attempts >= roundCap` never fires.
 * What DOES post once per completed round for exactly this population is the automatic advisory-panel comment
 * `we:scripts/operations/review-pr.mjs`'s `advise` step posts on every run against a `review:human` PR
 * (#xlw02hw) — it runs unconditionally, independent of whether the round goes on to repair/rearm anything.
 * Counting THOSE recovers "how many times this PR has actually been run against" from the PR's own durable
 * thread — no parallel state store (#2612 invariant), same discipline `countRearmComments` already uses.
 *
 * BUILD AND COUNT SHARE ONE MARKER SO THEY CAN NEVER DRIFT (the same rule `REARM_COMMENT_MARKER` states for
 * itself). `renderAdvisoryNote` (`we:scripts/operations/review-pr.mjs`) imports {@link ADVISORY_NOTE_MARKER}
 * from HERE and opens its comment with it; changing the wording changes it in the one place both sides read.
 *
 * WHY A NEW LEAF FILE AND NOT A CONSTANT INSIDE `review-pr.mjs`. `review-pr.mjs` is the operation declaration —
 * heavy, with a wide import graph (codex/antigravity judge-spawn, model-probation, the whole jury core). Pulling
 * that into `we:scripts/conveyor/reconcile-core.mjs`, which is deliberately PURE and leaf-light (no fs, no
 * clock, no process, no network — see that file's own header), would be exactly the kind of drift risk this
 * repo's "widen the shared thing, don't grow a private copy" rule exists to prevent. This file stays a leaf —
 * either side can depend on it with no new edge to anything heavy. #3383 adds ONE import,
 * `we:scripts/lib/marker-authorship.mjs`, itself a true leaf (no imports of its own, reads only `process.env`).
 *
 * PURE. No fs, no clock, no network. Reads `process.env` (via the one leaf import) for the trusted-login
 * overrides.
 */
import { isTrustedMarkerAuthor, isOperatorAuthored, OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';

/**
 * we:scripts/conveyor/advisory-round-count.mjs#ADVISORY_NOTE_MARKER — the stable FIRST LINE of the automatic
 * advisory-panel comment `we:scripts/operations/review-pr.mjs#renderAdvisoryNote` renders. Single-sourced HERE,
 * exactly as `REARM_COMMENT_MARKER` is single-sourced in `rearm-review.mjs`: the renderer opens its comment with
 * this literal, and {@link countAdvisoryComments} matches it, so the two can never say two different things.
 * Treat this as fixed — changing it orphans the count on every open `review:human` PR's existing thread (an
 * already-run PR would read as zero advisory rounds again, reopening the exact unbounded-redispatch bug this
 * file exists to close).
 */
export const ADVISORY_NOTE_MARKER = '**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.**';

/** Pinned against jury-core's producer constant in tests; keep this module's imports leaf-light. */
export const OPERATOR_RULING_MARKER_TAG = 'mandatory-referral-operator-ruling-v1';

/** Read only the producer's fixed footer slot, never quoted or fenced examples. */
function judgedHead(body) {
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''));
  let separator = -1;
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (run && run[1][0] === fence.char && run[1].length >= fence.length && /^[ \t]*$/.test(run[2])) {
        // Discard separators inside this now-closed fence.
        separator = fence.separator;
        fence = null;
        continue;
      }
    } else if (run && (run[1][0] !== '`' || !run[2].includes('`'))) {
      fence = { char: run[1][0], length: run[1].length, separator };
    }
    if (/^---[ \t]*$/.test(line)) separator = index;
  }
  if (separator < 0 || lines[separator + 1] !== '') return null;
  const basis = /^Net basis: `[0-9a-fA-F]+\.\.([0-9a-fA-F]{7,40})`/.exec(lines[separator + 2] ?? '');
  return basis ? basis[1].toLowerCase() : null;
}

/** Both GitHub authorship and the encoded actor must identify an operator. */
function operatorRulingHead(comment, body) {
  if (!isOperatorAuthored(comment)) return null;
  const lastLine = body.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '').at(-1);
  const match = new RegExp(`^<!-- ${OPERATOR_RULING_MARKER_TAG}: ([A-Za-z0-9+/]+={0,2}) -->$`).exec(lastLine ?? '');
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64');
    // Buffer's decoder tolerates malformed encodings; do not grant exemptions for those.
    if (decoded.toString('base64') !== match[1]) return null;
    const record = JSON.parse(decoded.toString('utf8'));
    if (typeof record?.actor !== 'string' || !OPERATOR_LOGINS.includes(record.actor.toLowerCase())) return null;
    return typeof record.head === 'string' && /^[0-9a-f]{40}$/.test(record.head) ? record.head : null;
  } catch {
    return null;
  }
}

/**
 * Advisory rounds spent, in thread array order. Live #4715 (2026-10-11) exhausted its cap because an
 * operator-requested re-review of the same head spent a repair round. Exempt only that re-review:
 * each exempt note needs its own operator-authored ruling after the previous trusted note, so
 * automation alone cannot loop under the cap. Unreadable heads or rulings always spend the round.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {{counted:number, excluded:Array<{index:number, head:string, reason:'operator-ruling-rereview'}>}}
 */
export function advisoryRoundLedger(comments) {
  const ledger = { counted: 0, excluded: [] };
  if (!Array.isArray(comments)) return ledger;
  let previousHead = null;
  let rulingHeads = [];
  for (const [index, comment] of comments.entries()) {
    const body = typeof comment === 'string' ? comment : comment?.body;
    if (typeof body !== 'string') continue;
    if (body.trimStart().startsWith(ADVISORY_NOTE_MARKER) && isTrustedMarkerAuthor(comment)) {
      const head = judgedHead(body);
      const sameHead = head && previousHead && (head.startsWith(previousHead) || previousHead.startsWith(head));
      if (sameHead && rulingHeads.some((rulingHead) => rulingHead.startsWith(head))) {
        ledger.excluded.push({ index, head, reason: 'operator-ruling-rereview' });
      } else {
        ledger.counted += 1;
      }
      previousHead = head;
      rulingHeads = [];
    } else {
      const head = operatorRulingHead(comment, body);
      if (head) rulingHeads.push(head);
    }
  }
  return ledger;
}

/** Durable advisory rounds spent; non-array input and untrusted notes contribute zero. */
export function countAdvisoryComments(comments) {
  return advisoryRoundLedger(comments).counted;
}
