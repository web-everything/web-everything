/** Archive-only host maintenance, separate from health-watch's lane probes. */
import { archiveRetention } from '../lib/archive-retention.mjs';
import { scrubText } from './health-watch-core.mjs';

/** Host retention is excluded from fixture and redirected maintenance ticks. */
export function archiveRetentionTickAllowed(flags = {}) {
  return !Object.keys(flags).some(key => key.endsWith('-fixture'))
    && !['state-root', 'dry-run', 'logs-dir', 'lock-root', 'tmp-sweep-root', 'claude-jobs-root', 'no-gh'].some(key => flags[key]);
}

/** Each kind owns a 24h stamp. This hook never trims or mutates lanes. */
export async function runArchiveRetentionTick({ flags = {}, now, archive = archiveRetention, log = console.error } = {}) {
  if (!archiveRetentionTickAllowed(flags)) return { results: [], error: null };
  const results = [];
  for (const kind of ['runs', 'sessions']) results.push(await archive({ kind, now, log }));
  const errors = results.flatMap(result => result.errors);
  return { results, error: errors.length ? scrubText(errors.join('; ')) : null };
}
