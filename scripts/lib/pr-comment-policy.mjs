/**
 * @file scripts/lib/pr-comment-policy.mjs — when a daemon may post a PR comment (card xadixye).
 *
 * Operator, 2026-10-08: "some comments like the drain just saying it did not do anything are a bit pointless".
 * The rule: a daemon comments only when the PR's state changed or someone needs to act. On 2026-10-08 the
 * daemons posted ~890 PR comments; ~110 of them said only "still waiting" — a `review-label-missing` note on
 * nearly every new PR minutes after it opened, `stacked-awaiting-base`, and the drain's "skipped: check not
 * green / mergeable=UNKNOWN / base is not main" and "held: review:pending" notes. Those states resolve on their
 * own (CI finishes, the review daemon reviews, the base PR lands), so the comment is noise.
 *
 * KEPT (never suppressed here): send-backs, rulings needed, merges and merge traces, review-coverage records,
 * failures that need a person (CodeQL, exhausted caps, orphaned stacks, human holds), fix evidence, and every
 * MACHINE-READ marker (fix-claim locks, retry-cap counters such as missing-run-recovery) — those comments ARE the
 * state another pass reads, so dropping one would change behaviour, not just volume.
 *
 * SETTING: `prComments.mode` in `we:scripts/pr-comments-settings.json`, overridden by env `WE_PR_COMMENTS_MODE`.
 *   - `on-change-or-action` (default) — suppress the status-only notes above.
 *   - `all` — the old behaviour, every comment posts.
 * Read on every call, so flipping the file takes effect on the next daemon tick with no restart. A missing or
 * malformed file, or an unknown mode, falls back to the default. Comment-writing only: nothing here may feed a
 * merge, label or dispatch decision.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

export const PR_COMMENT_MODES = Object.freeze(['on-change-or-action', 'all']);
export const DEFAULT_PR_COMMENT_MODE = 'on-change-or-action';
const DEFAULT_SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'pr-comments-settings.json');

// Trim and lowercase first: `ALL`, ` all` or `all\r` (a CRLF `.env`) is plainly the operator asking for `all`.
const normalizeMode = (m) => (typeof m === 'string' ? m.trim().toLowerCase() : '');
const validMode = (m) => {
  const n = normalizeMode(m);
  return PR_COMMENT_MODES.includes(n) ? n : null;
};

/**
 * The live `prComments` setting. Env wins over the file; anything unreadable or unknown is the default.
 * @param {{path?:string, env?:object}} [o]
 * @returns {{mode:string}}
 */
export function loadPrCommentSettings({ path = DEFAULT_SETTINGS_PATH, env = globalThis.process?.env ?? {} } = {}) {
  // A SET env value is the operator's explicit choice: if it is not a known mode the answer is the default, never
  // the file (a typo must not silently resurrect the file's `all`). Only an unset or empty value defers to the file.
  const rawEnv = env?.WE_PR_COMMENTS_MODE;
  if (normalizeMode(rawEnv) !== '') return { mode: validMode(rawEnv) ?? DEFAULT_PR_COMMENT_MODE };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { mode: validMode(raw?.prComments?.mode) ?? DEFAULT_PR_COMMENT_MODE };
  } catch {
    return { mode: DEFAULT_PR_COMMENT_MODE };
  }
}

/**
 * Reconcile note kinds that only say "still waiting": nobody has to act, and the state clears on its own.
 *   - `review-label-missing` — fires minutes after a PR opens, before the review daemon labels it (62 of 62 new
 *     PRs on 2026-10-08). The label healer owns the fix; the health watch still tracks a stuck one.
 *   - `stacked-awaiting-base` — the base PR is open and will land; the drain retargets. (`stacked-base-orphaned`
 *     is NOT here: no PR owns that base, so a person must act.)
 */
export const STATUS_ONLY_NOTE_KINDS = Object.freeze(['review-label-missing', 'stacked-awaiting-base']);

/** @param {{kind?:string}} note @returns {boolean} */
export function isStatusOnlyNote(note) {
  return STATUS_ONLY_NOTE_KINDS.includes(note?.kind);
}

/**
 * Reconcile note kinds that MAY be dropped when a new episode reads exactly like the PR's latest note. An explicit
 * allowlist, deliberately empty: every note kind that exists today asks a person to act ("needs your decision"),
 * and an identical recurrence of one is a new problem that must still reach them (a permission wall that clears
 * and returns with the same denied command reads word for word the same). An unknown kind is never listed here —
 * adding a kind is a deliberate edit, so a new escalation cannot be silenced by default.
 */
export const REPEAT_SUPPRESSIBLE_NOTE_KINDS = Object.freeze([]);

/** @param {{kind?:string}} note @returns {boolean} */
export function isRepeatSuppressibleNote(note) {
  return REPEAT_SUPPRESSIBLE_NOTE_KINDS.includes(note?.kind);
}

/** Visible text only: hidden HTML-comment markers (episode keys, hashes) and whitespace runs never count. */
export function visibleCommentText(body) {
  let text = String(body ?? '');
  // Strip until stable: one pass can splice a new marker together (`<!<!-- -->--`).
  for (let prev = null; prev !== text; ) {
    prev = text;
    text = text.replace(/<!--[\s\S]*?-->/g, '');
  }
  // A marker that never closes is not visible text either.
  text = text.replace(/<!--[\s\S]*$/, '');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Would `body` say exactly what the LATEST trusted comment of the same kind on this PR already says? Only the
 * newest matching comment counts: if the PR moved on and back, saying it again is a real change. Pure.
 * @param {Array<object>|null|undefined} comments - the PR's comments as `gh` returns them.
 * @param {string} body - the comment about to be posted.
 * @param {(body:string) => boolean} isSameKind - picks out comments of the same kind.
 * @returns {boolean}
 */
export function repeatsLatestComment(comments, body, isSameKind) {
  let latest = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    const b = typeof c === 'string' ? c : c?.body;
    if (typeof b !== 'string' || !isSameKind(b) || !isTrustedMarkerAuthor(c)) continue;
    latest = b;
  }
  return latest !== null && visibleCommentText(latest) === visibleCommentText(body);
}

/**
 * Drain skip/park reasons that only say "waiting on something that resolves itself": GitHub still computing
 * mergeability, CI still running or being healed by ci-heal, branch protection owned by the ci-heal/review
 * daemons, a stacked PR waiting for its base, or a `review:pending` hold the review daemon will clear. A hold
 * that also carries `review:human` or `review:changes` is NOT here — that one needs a person or a fixer.
 */
const NO_ACTION_DRAIN_REASONS = [
  /^not mergeable \(mergeable=UNKNOWN\)/,
  /^required check "[^"]+" is not green$/,
  /^merge state BLOCKED \(.*\) — owned by the ci-heal \/ review daemons, nothing for the drain to rebase$/,
  /^base is not main\b/,
  /^held — a review hold \(review:pending\) stands\b/,
];

/** @param {string} reason @returns {boolean} */
export function isNoActionDrainReason(reason) {
  const r = String(reason ?? '').trim();
  return r !== '' && NO_ACTION_DRAIN_REASONS.some((re) => re.test(r));
}

/**
 * Should the drain skip posting this reason comment? Only its `skip`/`park` notes can be suppressed; merges,
 * merge traces, review-coverage records and stacked-close warnings always post. Pure given `mode`.
 * @param {string} kind - the drain reason kind (`skip`, `park`, `land`, ...).
 * @param {string} reasonText
 * @param {{mode?:string}} [o]
 * @returns {boolean}
 */
export function drainReasonCommentSuppressed(kind, reasonText, { mode = loadPrCommentSettings().mode } = {}) {
  if (mode === 'all') return false;
  return (kind === 'skip' || kind === 'park') && isNoActionDrainReason(reasonText);
}
