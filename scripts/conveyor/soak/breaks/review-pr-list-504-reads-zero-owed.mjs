/**
 * @file breaks/review-pr-list-504-reads-zero-owed.mjs — live incident, 2026-11-03.
 * The review/fix daemons' open-PR list kept failing with HTTP 504 (api.github.com/graphql), so the daemon
 * logged "0 owed, dispatched 0" all day and PRs piled up.
 *
 * MECHANISM. reconcile-pass asked for `author`, which is not a snapshot field, so every production read bypassed
 * the paged snapshot and ran a heavy 200-row `gh pr list` (statusCheckRollup, comments, body, files). GitHub timed
 * it out; the failure was not retried and was easy to read as "nothing owed".
 *
 * THE FIX (lane/cheap-pr-list-retry): the list is cheap (snapshot / small pages, author via the ETag-cached REST
 * reader), a transient 502/503/504 is retried with backoff, a persistent failure THROWS (never an empty list) and
 * raises a `gh-list-failed` event after several in a row.
 *
 * SCENARIO (no fleet, no world): drive the production `defaultReadPrs` with an injected page reader.
 *   - a 504 on the first two attempts must be retried and the rows returned;
 *   - a persistent 504 must throw after bounded attempts, never return a list, and raise `gh-list-failed`;
 *   - the heavy `gh pr list` must never be issued.
 *
 * RED (pre-fix): the persistent 504 is not retried and either throws at once or reads as empty, with no event.
 * GREEN: retried, surfaced, evented, cheap.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SPECIFIC = new Set([
  'transient-504-not-retried', 'persistent-504-read-as-list', 'persistent-504-no-event',
  'persistent-504-not-bounded', 'heavy-list-issued', 'declared-sample-read-as-truncated',
  'author-throttle-hard-failed',
]);

const e504 = () => Object.assign(new Error('gh failed'), { stderr: 'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)' });
const row = (number) => ({ number, labels: [], comments: [], statusCheckRollup: [], author: { login: 'x' } });

export async function replayPrList504(root) {
  const read = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
  const { execFileSyncThrottled } = await import(pathToFileURL(join(root, 'scripts/lib/gh-throttle.mjs')).href);
  const events = [];
  const retryOpts = (extra = {}) => ({ sleep: () => {}, persist: false, threshold: 3, onEvent: (ev) => events.push(ev), ...extra });
  // Identity matters: defaultReadPrs takes its production path only for the real throttled exec. The page reader
  // and snapshot reader are injected, so no `gh` process is ever started here.
  const base = { repo: 'o/r', exec: execFileSyncThrottled, readCommits: () => [], readShared: () => null, readRest: () => ({ json: {} }) };

  let transientCalls = 0, transientOk = true;
  try {
    const rows = read.defaultReadPrs({ ...base, retryOpts: retryOpts({ streaks: new Map() }),
      listPaged: () => { if (++transientCalls < 3) throw e504(); return { rows: [row(1)], cache: {}, totalCount: 1 }; } });
    transientOk = Array.isArray(rows) && rows.length === 1;
  } catch { transientOk = false; }

  let persistentCalls = 0, persistentReturned = false;
  const streaks = new Map();
  for (let i = 0; i < 3; i++) {
    try {
      read.defaultReadPrs({ ...base, retryOpts: retryOpts({ streaks }),
        listPaged: () => { persistentCalls++; throw e504(); } });
      persistentReturned = true;
    } catch { /* surfaced, as required */ }
  }
  // Follow-up regression (2026-11-03 16:23 ET): a DECLARED smoke sample (WE_PR_SNAPSHOT_SAMPLE) is not truncation.
  let sampleAccepted = true;
  const prev = process.env.WE_PR_SNAPSHOT_SAMPLE;
  process.env.WE_PR_SNAPSHOT_SAMPLE = '12';
  try {
    const sampled = [row(1)];
    Object.defineProperty(sampled, 'sampled', { value: true });
    sampleAccepted = read.defaultReadPrs({ ...base, readShared: () => sampled, retryOpts: retryOpts({ streaks: new Map() }) }).length === 1;
  } catch { sampleAccepted = false; } finally { if (prev === undefined) delete process.env.WE_PR_SNAPSHOT_SAMPLE; else process.env.WE_PR_SNAPSHOT_SAMPLE = prev; }
  // Follow-up (2026-11-03 17:19 ET): a gh SLOT throttle during the author lookup defers the read, it is no hard failure.
  let authorThrottleDeferred = false;
  try {
    const throttled = Object.assign(new Error('gh-throttle: throttled — no gh slot within 8s (class=background)'), { ghThrottled: { class: 'background' } });
    const out = read.defaultReadPrs({ ...base, readShared: () => [{ number: 987654, labels: [], comments: [], statusCheckRollup: [] }],
      readRest: () => { throw throttled; }, retryOpts: retryOpts({ streaks: new Map() }) });
    authorThrottleDeferred = !Array.isArray(out) && out?.deferred === true;
  } catch { authorThrottleDeferred = false; }
  return { transientOk, persistentReturned, persistentCalls, events, sampleAccepted, authorThrottleDeferred };
}

export default {
  id: 'review-pr-list-504-reads-zero-owed',
  title: 'a GitHub 504 on the open-PR list is retried, surfaced and evented — never read as "0 owed"',
  card: 'live incident 2026-11-03, review/fix/drain open-PR list 504',
  fixedBy: {
    sha: '393b3f4237',
    where: 'lane/cheap-pr-list-retry',
    paths: ['scripts/conveyor/reconcile-pass.mjs', 'scripts/lib/gh-list-retry.mjs', 'scripts/lib/pr-list-paged.mjs'],
  },
  fixPresent(root) {
    return existsSync(join(root, 'scripts/lib/gh-list-retry.mjs'));
  },
  async run() {
    const r = await replayPrList504(new URL('../../../../', import.meta.url).pathname);
    const violations = [];
    if (!r.transientOk) violations.push({ invariant: 'transient-504-not-retried', detail: 'two 504s then success did not return the rows' });
    if (r.persistentReturned) violations.push({ invariant: 'persistent-504-read-as-list', detail: 'a persistent 504 returned a list instead of failing' });
    if (r.persistentCalls !== 9) violations.push({ invariant: 'persistent-504-not-bounded', detail: `3 reads x 3 attempts expected 9 list calls, saw ${r.persistentCalls}` });
    if (!r.events.some((e) => e.kind === 'gh-list-failed')) violations.push({ invariant: 'persistent-504-no-event', detail: 'three failed reads in a row raised no gh-list-failed event' });
    if (!r.sampleAccepted) violations.push({ invariant: 'declared-sample-read-as-truncated', detail: 'a declared WE_PR_SNAPSHOT_SAMPLE sample was refused as a partial inventory' });
    if (!r.authorThrottleDeferred) violations.push({ invariant: 'author-throttle-hard-failed', detail: 'a gh slot throttle during the author lookup did not defer the read' });
    return { violations };
  },
  judge(report) {
    return report.violations
      .filter((v) => SPECIFIC.has(v.invariant))
      .map((v) => `-: [${v.invariant}] ${v.detail}`);
  },
};
