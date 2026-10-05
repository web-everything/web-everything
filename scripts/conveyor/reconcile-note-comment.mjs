/**
 * @file scripts/conveyor/reconcile-note-comment.mjs
 * @description #4191 (epic #4075/#3383) — the durable PR-comment half of "surface reconcile/tick notes to the
 *   operator". `we:scripts/conveyor/reconcile-core.mjs#planReconcile` already emits `notes` (`ci-heal-exhausted`,
 *   `awaiting-permission`) with a human-readable `text`, but nothing ever turned one into a PR comment — see
 *   `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`'s own header for the daemon-side half of this fix.
 *
 * ONE COMMENT PER NOTE EPISODE, never one per tick. A note that stays true for days (an exhausted PR nobody has
 * looked at yet, or a permission block nobody has cleared) would otherwise get a fresh comment every single tick
 * this daemon runs (every {@link ../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs#DEFAULT_INTERVAL_MS}
 * — 2 minutes) — the exact "durable marker, not a re-post" discipline every sibling comment in this directory
 * already follows (`we:scripts/conveyor/ci-heal-mark.mjs`, `we:scripts/conveyor/advisory-fix-mark.mjs`,
 * `we:scripts/conveyor/stand-down.mjs`). Those siblings dedupe on a FIXED leading-line marker because their
 * event (one completed heal, one completed fix round) is naturally singular. A `notes` episode is not: the
 * SAME PR can go through `ci-heal-exhausted` more than once (a human lets it try again, it burns through the cap
 * a second time), and an `awaiting-permission` block can clear and recur on a LATER session. So the leading line
 * here ({@link NOTE_COMMENT_MARKER}) stays fixed for every note comment (so a reader/grep finds them all), and a
 * second, machine-read HTML-comment line carries the EPISODE's own identity ({@link noteEpisodeKey}) — present
 * in the rendered comment (GitHub keeps HTML comments in a PR comment's raw body, just hidden from the rendered
 * view) so {@link hasPostedNoteComment} can match the exact episode without re-parsing free text.
 *
 * AUTHOR-CHECKED, never a bare body-substring match — the marker's whole POINT (surfacing an escalation to a
 * human) is exactly the kind of thing a forged comment from any other GitHub login could spoof to suppress (post
 * a fake "already handled" episode key so this module never re-flags a live exhausted PR). Every dedup check
 * below runs through `we:scripts/lib/marker-authorship.mjs#isTrustedMarkerAuthor` — the SAME gate the ci-heal/
 * advisory-fix/stand-down markers already run their own counts through — never re-derived here.
 *
 * SAFE BY DEFAULT: {@link planNoteComment} decides WHAT to post and is pure (no network). Actually posting is
 * {@link postNoteComment}, a thin `gh pr comment` IO shell the daemon calls only when NOT in dry-run — see that
 * daemon's own `runReconcileNotesAllRepos` for why dry-run is this repo's own DEFAULT for a brand-new write
 * action (mirrors this epic's already-ratified "supervision enforcement lands OFF until real miss data" rule):
 * this card's own Done-when accepts a QUEUED comment payload as sufficient (we:backlog/4191-*.md, item 1's own
 * parenthetical), so landing the write path behind an explicit opt-in loses nothing the card asks for while
 * never letting a background daemon's very first tick after this lands post an unreviewed comment to a real PR.
 */
import { execFileSync } from 'node:child_process';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

/**
 * we:scripts/conveyor/reconcile-note-comment.mjs#NOTE_COMMENT_MARKER — the stable FIRST LINE of every durable
 * reconcile-note comment. Single-sourced (build + dedup both read it), distinct from every other comment marker
 * in this directory so a note-comment count/match can never cross with a ci-heal/advisory-fix/stand-down one.
 */
export const NOTE_COMMENT_MARKER = '🔔 conveyor — needs your decision';

/**
 * we:scripts/conveyor/reconcile-note-comment.mjs#noteEpisodeKey — the stable identity of ONE escalation episode
 * for a note, so a note that stays true across many ticks posts exactly once, while a LATER, genuinely new
 * episode (the cap burned again after a human let it retry; a new session hitting the same permission wall)
 * gets its own comment. Pure.
 *   - `ci-heal-exhausted`: keyed on the attempt/cap pair — that pair can only advance forward (a durable, PR-
 *     comment-backed count, `we:scripts/conveyor/ci-heal-mark.mjs#countCiHealComments`), so the SAME pair means
 *     the SAME exhaustion, and a new one (after a reset/retry) is a different key.
 *   - `awaiting-permission`: keyed on the session that is actually stuck (`sessionId`, falling back to `pid`) —
 *     the session identity IS the episode; a different session hitting the same wall later is a new episode.
 *   - `round-cap-exhausted` (xilx617 / #xu38vlf, epic #4075/#3383): keyed on the population (`capKind`) AND the
 *     attempt/cap pair, same reasoning as `ci-heal-exhausted` — that pair only advances forward (a durable,
 *     comment-backed count), so the SAME pair means the SAME exhaustion and a later one (after a human lets it
 *     retry and it burns through the cap again) is a genuinely new episode.
 *   - `infra-retry-exhausted` (xilx617): keyed on the PR and the streak's own first timestamp (`since`) — the
 *     streak can keep growing past the cap (an outage that never recovers) without minting a new episode; only
 *     a FRESH streak (a new `since`, meaning the old one was reset by a non-infra outcome first) is new.
 *   - `session-overrun` (xilx617): keyed on the session that is actually overrunning (`sessionId`, falling back
 *     to `pid`) — same shape as `awaiting-permission`, a different session overrunning later is a new episode.
 *   - `liveness-wait-exhausted` (#xu38vlf): keyed on the PR and the wait's own first-observed timestamp
 *     (`since`) — the wait can keep growing past its bound (a liveness signal that never clears) without
 *     minting a new episode; only a FRESH wait (a new `since`, meaning the old one was resolved first) is new.
 *   - anything else: keyed on the note's own `text`, the only stable field a shape this module does not know
 *     about is guaranteed to carry — never silently drops an unrecognised note kind.
 * @param {{kind?:string, prNumber?:(number|null), attempts?:number, cap?:number, capKind?:string,
 *   sessionId?:string, pid?:number, since?:string, startedAt?:string, text?:string}} note
 * @returns {string}
 */
export function noteEpisodeKey(note) {
  const pr = note?.prNumber ?? 'unknown';
  if (note?.kind === 'ci-heal-exhausted') return `ci-heal-exhausted:${pr}:${note.attempts}/${note.cap}`;
  if (note?.kind === 'awaiting-permission') {
    return `awaiting-permission:${pr}:${note.sessionId ?? note.pid ?? 'unknown-session'}`;
  }
  if (note?.kind === 'round-cap-exhausted') {
    return `round-cap-exhausted:${pr}:${note.capKind ?? 'unknown-population'}:${note.attempts}/${note.cap}`;
  }
  if (note?.kind === 'permission-blocked') return `permission-blocked:${pr}:${note.since ?? 'unknown-since'}`;
  if (note?.kind === 'infra-retry-exhausted') {
    return `infra-retry-exhausted:${pr}:${note.since ?? 'unknown-since'}`;
  }
  if (note?.kind === 'session-overrun') {
    return `session-overrun:${pr}:${note.sessionId ?? note.pid ?? 'unknown-session'}`;
  }
  if (note?.kind === 'liveness-wait-exhausted') {
    return `liveness-wait-exhausted:${pr}:${note.since ?? 'unknown-since'}`;
  }
  // One dispute per head: the same head can keep waiting for days without minting a second comment.
  if (note?.kind === 'ruling-dispute') return `ruling-dispute:${pr}:${note.head ?? 'unknown-head'}`;
  return `${note?.kind ?? 'note'}:${pr}:${note?.text ?? ''}`;
}

/**
 * we:scripts/conveyor/reconcile-note-comment.mjs#noteHeadline — the operator's own rule (this card's brief):
 * "an exhausted PR should read as 'needs your decision: fix attempts exhausted'". Pure, one line per known kind,
 * a generic fallback for any note kind this module does not yet special-case (never silently dropped).
 * @param {{kind?:string}} note
 * @returns {string}
 */
export function noteHeadline(note) {
  if (note?.kind === 'ci-heal-exhausted') return 'needs your decision: fix attempts exhausted';
  if (note?.kind === 'awaiting-permission') return 'needs your decision: a session is blocked on a permission prompt';
  if (note?.kind === 'round-cap-exhausted') return 'needs your decision: auto-repair rounds exhausted';
  if (note?.kind === 'permission-blocked') return 'needs your decision: fixer blocked by a permission denial';
  if (note?.kind === 'infra-retry-exhausted') return 'needs your decision: blocked-on-infra retry streak capped';
  if (note?.kind === 'session-overrun') return 'needs your decision: a session has run past its bound';
  if (note?.kind === 'liveness-wait-exhausted') return 'needs your decision: a liveness wait ran past its bound';
  if (note?.kind === 'ruling-dispute') return 'needs your decision: the fixer and the reviewer disagree about a ruling';
  return `needs your decision: ${note?.kind ?? 'an unrecognised escalation'}`;
}

/**
 * we:scripts/conveyor/reconcile-note-comment.mjs#buildNoteComment — the durable comment body one note episode
 * posts. FIRST line is {@link NOTE_COMMENT_MARKER} (single-sourced); LAST line is the machine-read episode key,
 * as an HTML comment (invisible in GitHub's rendered view, present in the raw body every `gh --json comments`
 * read returns). Pure.
 * @param {object} note - a `planReconcile` note (`{kind, prNumber, text, ...}`).
 * @returns {string}
 */
export function buildNoteComment(note) {
  const key = noteEpisodeKey(note);
  // The text can carry agent-supplied strings (e.g. a fixer's `--denied` command). Break any HTML-comment
  // delimiter so it can never forge the machine-read episode key below (which `hasPostedNoteComment` matches).
  const text = String(note?.text ?? '(no detail recorded)').replace(/<!--/g, '<!- -').replace(/-->/g, '- ->');
  const lines = [
    NOTE_COMMENT_MARKER,
    '',
    noteHeadline(note),
    '',
    text,
  ];
  if (note?.kind === 'ci-heal-exhausted' && note?.lastFailureReason) {
    lines.push('', `Last failure: ${note.lastFailureReason}`);
  }
  lines.push('', `<!-- conveyor-note-key: ${key} -->`);
  return lines.join('\n');
}

/**
 * we:scripts/conveyor/reconcile-note-comment.mjs#hasPostedNoteComment — has a TRUSTED principal already posted
 * this exact note episode's comment? Matches the episode-key HTML comment line, not free text, and — mirroring
 * every sibling marker counter in this repo — runs every candidate through
 * {@link isTrustedMarkerAuthor} first: an untrusted login pasting the marker text (or forging the key) must
 * never suppress a real escalation. Pure.
 * @param {Array<{body?:string, viewerDidAuthor?:boolean, author?:{login?:string}}|string>|null|undefined} comments
 * @param {object} note
 * @returns {boolean}
 */
export function hasPostedNoteComment(comments, note) {
  if (!Array.isArray(comments)) return false;
  const marker = `<!-- conveyor-note-key: ${noteEpisodeKey(note)} -->`;
  return comments.some((c) => {
    const body = typeof c === 'string' ? c : c?.body;
    return typeof body === 'string' && body.includes(marker) && isTrustedMarkerAuthor(c);
  });
}

/**
 * we:scripts/conveyor/reconcile-note-comment.mjs#planNoteComment — the WHOLE pure decision: has this episode
 * already been posted, and if not, what body would post it. No network, no fs — every field a caller (the
 * daemon, a test, the live proof) needs to either skip, post for real, or print a dry-run line. Pure.
 * @param {object} note
 * @param {Array<object>|null|undefined} comments - the SAME PR's own `comments`, exactly as `gh` returns them.
 * @returns {{key:string, body:string, alreadyPosted:boolean}}
 */
export function planNoteComment(note, comments) {
  return {
    key: noteEpisodeKey(note),
    body: buildNoteComment(note),
    alreadyPosted: hasPostedNoteComment(comments, note),
  };
}

/**
 * we:scripts/conveyor/reconcile-note-comment.mjs#postNoteComment — the ONE IO shell that actually posts, via
 * `gh pr comment`. Mirrors `we:scripts/conveyor/ci-heal-mark.mjs`'s own CLI post exactly (bounded timeout, a
 * `--repo` flag only when the caller has one). Never called for a `dryRun` tick — see this file's own header.
 * @param {{repo?:string|null, pr:number, body:string, exec?:Function}} o
 * @returns {{ok:boolean, error?:string}}
 */
export function postNoteComment({
  repo = null, pr, body, exec = execFileSync,
} = {}) {
  const args = ['pr', 'comment', String(pr), '--body', body];
  if (repo) args.push('--repo', repo);
  try {
    exec('gh', args, {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).split('\n')[0] };
  }
}
