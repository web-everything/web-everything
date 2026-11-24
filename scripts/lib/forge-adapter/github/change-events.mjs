/**
 * @file GitHub adapter for forge.change-events. All GitHub event shapes stay here: delivery -> core change event
 * (via the receiver's parser) and the feed read. Events are wake-only; the tick re-reads live state.
 */
import { parseGithubEvent } from '../../../conveyor/pr-events-worker/core.mjs';
import { pollEvents } from '../../pr-events.mjs';
import { detectSeqGap } from '../change-events.mjs';

/** One webhook delivery -> compact change event, or null (unknown event types are dropped from the wake set, not "all clear"). */
export function mapDelivery(eventName, payload, opts = {}) {
  return parseGithubEvent(eventName, payload, opts);
}

/** Read the feed after `cursor`; a skipped seq flags `gap` so the caller does a full reconcile. Never throws. */
export async function readGithubChanges(cursor, opts = {}) {
  const r = await pollEvents(cursor, opts);
  if (!r?.ok) return r;
  return { ...r, gap: r.gap || detectSeqGap(cursor, r.events) };
}

export const githubChangeEvents = Object.freeze({ read: readGithubChanges });
