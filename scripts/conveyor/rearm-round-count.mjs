/** Shared re-arm classification for the ordinary counter, enrichment threshold and real-fix windows. */
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

// Durable protocol strings: preserve existing PR comment history when changing their readers.
export const REARM_COMMENT_MARKER = '🔧 conveyor fix — re-armed for re-review';
/** Stable first line of the "empty fix round" comment. Deliberately NOT {@link REARM_COMMENT_MARKER}: it must never be counted as a round. */
export const NO_CHANGE_COMMENT_MARKER = '⚠️ conveyor fix — no change made — fix still owed';
export const SAME_HEAD_WAKE_TRAILER = '<!-- same-head-pause-wake -->';
/** An honoured no-code ruling requests review without completing another repair round. */
export const NO_CODE_REARM_TRAILER = '<!-- no-code-rearm-handoff -->';

/** A trusted repair closes a fix round; same-head wakes and no-code handoffs only request review. */
export function isFixRoundRearmComment(comment) {
  if (!isTrustedMarkerAuthor(comment)) return false;
  const body = typeof comment === 'string' ? comment : comment?.body;
  return typeof body === 'string' && body.trimStart().startsWith(REARM_COMMENT_MARKER)
    && !body.trimEnd().endsWith(SAME_HEAD_WAKE_TRAILER)
    // The shared writer appends its verdict binding after our body. Match the producer's whole line,
    // so that binding (or a referral carry record) cannot turn a no-code handoff into a repair round.
    && !body.split('\n').includes(NO_CODE_REARM_TRAILER);
}
