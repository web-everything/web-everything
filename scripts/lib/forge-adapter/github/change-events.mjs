/**
 * @file GitHub adapter for forge.change-events. All GitHub event shapes stay here: delivery -> core change event
 * (via the receiver's parser) and the feed read. Events are wake-only; the tick re-reads live state.
 */
import { parseGithubEvent } from '../../../conveyor/pr-events-worker/core.mjs';
import { pollEvents } from '../../pr-events.mjs';
import { githubCapabilities } from './capabilities.mjs';

/** One webhook delivery -> compact change event, or null (unknown event types are dropped from the wake set, not "all clear"). */
export function mapDelivery(eventName, payload, opts = {}) {
  return parseGithubEvent(eventName, payload, opts);
}

/** Raw feed read; gap detection lives in the port so every adapter gets it. Never throws. */
export const readGithubChanges = (cursor, opts = {}) => pollEvents(cursor, opts);

export const githubChangeEvents = Object.freeze({ read: readGithubChanges, capabilities: githubCapabilities });
