/** Shared re-arm classification for the ordinary counter, enrichment threshold and real-fix windows. */
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

// Durable protocol strings: preserve existing PR comment history when changing their readers.
export const REARM_COMMENT_MARKER = '🔧 conveyor fix — re-armed for re-review';
export const SAME_HEAD_WAKE_TRAILER = '<!-- same-head-pause-wake -->';

/** A trusted re-arm closes a fix round; a same-head wake only requests another review. */
export function isFixRoundRearmComment(comment) {
  if (!isTrustedMarkerAuthor(comment)) return false;
  const body = typeof comment === 'string' ? comment : comment?.body;
  return typeof body === 'string' && body.trimStart().startsWith(REARM_COMMENT_MARKER)
    && !body.trimEnd().endsWith(SAME_HEAD_WAKE_TRAILER);
}
