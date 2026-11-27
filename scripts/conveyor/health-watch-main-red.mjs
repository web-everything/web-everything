/** Pure red-main attention planning and the health tick's bounded IO adapter. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, opendirSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { mainRedState, latestCheckVerdicts, findOwnerPrs, mainCiRedSettings, measureMainQueue, mainFailureSignature,
  MAIN_RED_METRIC_LIMITS, validMainRedMetric, reportMainRedMetrics } from './main-ci-red-core.mjs';
import { DEFAULT_REPO_SLUG, readRunJobs, readFailingTests, readOpenPrsForOwner } from './main-ci-red-io.mjs';

export function mainRedAlertSettings(config = {}) {
  const value = config?.mainRedAlertAfterMin;
  return { mainRedAlertAfterMin: Number.isFinite(value) && value >= 0 ? value : 20 };
}

export function planMainRedAlert(input = {}) {
  const { runs, tip, readOk = true, now, prev = {},
    settings = mainRedAlertSettings(), details } = input;
  const next = { ...prev, seq: Number.isSafeInteger(prev.seq) && prev.seq >= 0 ? prev.seq : 0 };
  const items = [];
  // The fingerprint deduplicates unchanged observations; the sequence identifies
  // transitions even when an earlier fingerprint is already open in the feed.
  // Covered in __tests__/health-watch-main-red.test.mjs by:
  // "persists and increments seq per emitted red, unknown and green item, preserving it on quiet ticks"
  // (red -> proven green -> identical red, distinct heads, persisted seq and quiet-tick deduplication).
  const emit = (item) => {
    next.seq += 1;
    items.push({ ...item, head: `${item.head}:${next.seq}` });
  };
  const base = { repo: DEFAULT_REPO_SLUG, pr: 0 };
  const state = readOk ? mainRedState(runs, { tip }) : { status: 'unknown' };
  const tipVerdicts = Array.isArray(tip?.checkRuns)
    ? [...latestCheckVerdicts(tip.checkRuns).values()] : [];
  const tipReadable = !!tip?.sha && tipVerdicts.length > 0
    && tip.checkRuns.every((check) => check?.name && check.status === 'completed'
      && (['success', 'neutral'].includes(check.conclusion)
        || (check.conclusion === 'skipped' && Array.isArray(tip.requiredChecks)
          && !tip.requiredChecks.includes(check.name))));
  // A full check page may be truncated; retain unknown on either recovery path.
  const provenGreen = tipReadable && tip.checkRuns.length < 100
    && tip.checksTotal === tip.checkRuns.length
    && (state.via === 'tip-required-checks'
    || (state.latestGreen?.sha === tip.sha
      && Array.isArray(tip.requiredChecks) && tip.requiredChecks.length > 0
      && !tipVerdicts.includes('pending')));
  const finish = () => {
    const observed = state.status === 'red' ? 'red' : provenGreen ? 'green' : 'unknown';
    const measurement = planMainRedMetrics({ state, observed, runs, now, prev: prev.measurement, details });
    next.measurement = measurement.next;
    return { items, next, metrics: measurement.events };
  };
  // Healthy workflow runs commonly precede the new tip's checks. Only an
  // outstanding red alert needs unavailable recovery evidence surfaced here.
  if (state.status === 'green' && !provenGreen && !prev.fingerprint) return finish();
  if (!['red', 'green'].includes(state.status) || (state.status === 'green' && !provenGreen)) {
    if (!prev.unknownEmitted) emit({ ...base, kind: 'main-status-unknown',
      head: 'main-status-unknown', reason: 'Main CI status is unavailable' });
    next.unknownEmitted = true;
    return finish();
  }
  next.unknownEmitted = false;
  if (state.status === 'green') {
    if (prev.fingerprint) emit({ ...base, kind: 'main-green',
      head: `${prev.fingerprint}:${prev.fingerprintParts?.since ?? 'unknown'}`,
      reason: 'Main CI is green again' });
    next.fingerprint = null;
    next.fingerprintParts = null;
    return finish();
  }
  if (now - state.redSinceMs < settings.mainRedAlertAfterMin * 60_000) return finish();
  const firstRedSha = state.firstRed.sha;
  const since = new Date(state.redSinceMs).toISOString();
  // Carry unavailable reads only within the same red episode. Empty arrays are
  // observed changes, and old state without parts starts with unknown details.
  const previousParts = prev.fingerprintParts;
  const carried = previousParts?.firstRedSha === firstRedSha && previousParts?.since === since
    ? previousParts : {};
  const failingJobs = [...new Set(details?.failingJobs ?? carried.failingJobs ?? [])].sort();
  const fixPrs = [...new Set(details?.fixPrs ?? carried.fixPrs ?? [])].sort((a, b) => a - b);
  // Undefined means unreadable; null is a successful read with no failing test.
  const firstFailingTest = details?.firstFailingTest !== undefined
    ? details.firstFailingTest : carried.firstFailingTest ?? null;
  const fingerprintParts = { firstRedSha, since, failingJobs, firstFailingTest, fixPrs };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(fingerprintParts)).digest('hex');
  if (fingerprint !== prev.fingerprint) emit({ ...base, kind: 'main-red', head: fingerprint,
    since, firstRedSha, failingJobs, firstFailingTest, fixPrs,
    blockedReadyPrs: details?.blockedReadyPrs ?? null,
    reason: `Main CI red since ${since}: ${firstFailingTest || failingJobs[0] || firstRedSha.slice(0, 7)}`.slice(0, 100),
  });
  next.fingerprint = fingerprint;
  next.fingerprintParts = fingerprintParts;
  return finish();
}

function readAlertState(dir) {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'main-red-alert.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid main-red alert state');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function writeAlertState(dir, next) {
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'main-red-alert.json'), next);
}

function readAlertDetails({ state, config }) {
  const details = { failureIdentifiers: null, failingJobs: null, firstFailingTest: undefined, fixPrs: null, blockedReadyPrs: null };
  if (state.status !== 'red') return details;
  try {
    const jobs = readRunJobs(state.latestRed.runId);
    if (jobs.failed[0]?.name) details.failureIdentifiers = { job: jobs.failed[0].name };
    if (jobs.complete) details.failingJobs = jobs.failed.map((job) => job.name);
    if (jobs.failed[0]) {
      try { details.firstFailingTest = readFailingTests(jobs.failed[0].id)[0] ?? null; } catch { /* annotations unavailable */ }
    } else if (jobs.complete) details.firstFailingTest = null;
  } catch { /* jobs unavailable */ }
  try {
    const prs = readOpenPrsForOwner();
    if (prs !== null) details.fixPrs = findOwnerPrs({ firstRed: state.firstRed, prs,
      settings: mainCiRedSettings(config) }).map((pr) => pr.number);
  } catch { /* owners unavailable */ }
  try {
    const out = execFileSyncThrottled('gh', ['pr', 'list', '--repo', DEFAULT_REPO_SLUG,
      '--state', 'open', '--json', 'number,labels', '--limit', '200'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
      timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    if (!isGhDeferred(out)) {
      const prs = JSON.parse(String(out));
      // A full page cannot prove the count; retain null rather than undercounting.
      if (Array.isArray(prs) && prs.length < 200 && prs.every((pr) => Array.isArray(pr?.labels))) {
        details.blockedReadyPrs = prs.filter((pr) => (pr?.labels ?? []).some((l) => l?.name === 'ready-to-merge')).length;
      }
    }
  } catch { /* ready PRs unavailable */ }
  return details;
}

export async function runMainRedAlert({ probe, dir, now = Date.now(), config = {},
  publish = publishAttention, readState = readAlertState, writeState = writeAlertState,
  readDetails = readAlertDetails, writeMetrics = appendMainRedMetrics } = {}) {
  const prev = await readState(dir);
  const readOk = !!probe && !probe.error;
  const state = readOk ? mainRedState(probe.runs, { tip: probe.tip }) : { status: 'unknown' };
  let details = null;
  try { details = await readDetails({ state, probe, config }); } catch { /* alert with unknown details */ }
  const result = planMainRedAlert({ runs: probe?.runs, tip: probe?.tip, readOk, now,
    prev, settings: mainRedAlertSettings(config), details });
  for (const item of result.items) await publish(item);
  // Keep the original event/timestamp owed until the journal acknowledges it. Alert state can
  // advance independently: pending events survive restart and later red/green transitions.
  const pending = prev.pendingMetrics ?? [];
  let incomplete = prev.metricsIncomplete === true || !Array.isArray(pending)
    || pending.length > MAIN_RED_METRIC_LIMITS.events;
  const owed = [];
  // Prefer previously owed evidence. Never let malformed/overflow measurement data freeze
  // alert persistence; remember any loss until an operator recovers evidence and clears the flag.
  const retain = event => {
    if (!validMainRedMetric(event) || Buffer.byteLength(JSON.stringify(event)) > MAIN_RED_METRIC_LIMITS.bytes
      || owed.length >= MAIN_RED_METRIC_LIMITS.events) incomplete = true;
    else owed.push(event);
  };
  if (Array.isArray(pending)) {
    for (const event of pending.slice(0, MAIN_RED_METRIC_LIMITS.events)) retain(event);
  }
  for (const event of result.metrics) retain(event);
  let recorded;
  try { recorded = await writeMetrics(dir, owed); } catch { /* no acknowledgement; retain owed work */ }
  result.metricWarnings = Array.isArray(recorded?.warnings)
    && recorded.warnings.every(warning => typeof warning === 'string') ? [...recorded.warnings] : [metricRecovery];
  if (result.metricWarnings.length) result.next.pendingMetrics = owed;
  else delete result.next.pendingMetrics;
  if (incomplete) {
    result.next.metricsIncomplete = true;
    if (!result.metricWarnings.includes(metricRecovery)) result.metricWarnings.push(metricRecovery);
  }
  await writeState(dir, result.next);
  return result;
}


/** Measurement transitions are independent of the alert delay/fingerprint. Persisted episode sequence survives
 * restart and distinguishes the same failure recurring after green. Unknown never closes an episode.
 */
function planMainRedMetrics({ state, observed, runs, now, prev = {}, details }) {
  const next = { ...prev, seq: Number.isSafeInteger(prev.seq) ? prev.seq : 0 };
  const events = [];
  const red = observed === 'red';
  if (red && !prev.open) {
    next.seq++;
    next.open = true;
    next.head = state.firstRed.sha;
    const previousGreenAt = Number.isFinite(prev.previousGreenAt) && prev.previousGreenAt >= 0
      && prev.previousGreenAt <= now ? prev.previousGreenAt : null;
    // Fresh failure evidence dates the recurrence even when it precedes this polling tick.
    // Stale evidence predating proven green cannot date a new episode: retain the observed
    // interval and flag its origin as unknown. Legacy green state has the same uncertainty.
    next.originUnknown = previousGreenAt !== null ? state.redSinceMs < previousGreenAt : prev.status === 'green';
    next.since = next.originUnknown ? now : Math.max(state.redSinceMs, previousGreenAt ?? state.redSinceMs);
  }
  const run = red && Array.isArray(runs) ? runs.find(r => r.databaseId === state.latestRed.runId) : null;
  const runId = run?.databaseId ?? null;
  const queue = measureMainQueue({ enqueuedAt: run?.enqueuedAt ?? run?.createdAt, admittedAt: run?.admittedAt,
    startedAt: run?.startedAt, completedAt: run?.completedAt });
  const signature = mainFailureSignature(details?.failureIdentifiers);
  const sample = JSON.stringify([runId, queue, signature]);
  let kind = observed !== prev.status ? observed : null;
  if (red && !prev.open) kind = 'red';
  if (red && !kind && sample !== prev.sample) kind = 'queue';
  if (kind) {
    // Persist an observation ordinal: recurring samples are new evidence, while retries
    // from the same saved state retain their key even when the polling clock advances.
    next.eventSeq = (Number.isSafeInteger(prev.eventSeq) ? prev.eventSeq : 0) + 1;
    const event = { v: 1, repo: DEFAULT_REPO_SLUG, head: next.head ?? 'unknown', seq: next.seq,
      runId, kind, at: now, since: next.since ?? null, queue, signature,
      truncated: red && (state.windowTruncated === true || next.originUnknown === true) };
    event.key = createHash('sha256').update(JSON.stringify([event.repo, event.head, event.seq, kind,
      runId, kind === 'queue' ? sample : null, next.eventSeq])).digest('hex');
    events.push(event);
  }
  if (observed === 'green') { next.open = false; next.previousGreenAt = now; }
  next.status = observed;
  if (red) next.sample = sample;
  return { next, events };
}

const metricRecovery = 'Incomplete metric journal; archive journal and replay a smaller range or recover source evidence.';

/** Bounded directory iterator, including unknown entries in the scan budget. No unbounded readdir. */
function metricFiles(dir, { limit = MAIN_RED_METRIC_LIMITS.events, openDir = opendirSync } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAIN_RED_METRIC_LIMITS.events) throw new Error('invalid scan limit');
  const entries = []; const handle = openDir(join(dir, 'main-red-metrics'));
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (entries.length >= limit) throw new Error('scan limit');
      if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error('malformed entry');
      entries.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return entries;
}

// A pre-read stat cannot bound bytes if a competing writer grows the file. Read at most
// 8 KiB plus one overflow byte through the descriptor, including acknowledgement retries.
function readMetricFile(path, read = readSync) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAIN_RED_METRIC_LIMITS.bytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = read(fd, buffer, used, buffer.length - used, used);
      if (!count) break;
      used += count;
    }
    if (used > MAIN_RED_METRIC_LIMITS.bytes) throw new Error('oversized event');
    return JSON.parse(buffer.subarray(0, used).toString('utf8'));
  } finally { closeSync(fd); }
}

/** Append-only immutable events. O_EXCL makes retries idempotent, including journal-success/state-failure.
 * Refuse at 10,000 files rather than deleting history. Operator archives before collection resumes.
 * Measurement failure is diagnostic only: it never grants dispatch/merge or changes alert authority.
 */
export function appendMainRedMetrics(dir, events, { writeFile = writeFileSync,
  limit = MAIN_RED_METRIC_LIMITS.events, openDir = opendirSync } = {}) {
  const warnings = [];
  try {
    if (!Array.isArray(events) || events.length > MAIN_RED_METRIC_LIMITS.events) throw new Error('event limit');
    mkdirSync(join(dir, 'main-red-metrics'), { recursive: true });
    let count = metricFiles(dir, { limit, openDir }).length;
    for (const event of events) {
      if (!validMainRedMetric(event)) throw new Error('malformed event');
      const text = JSON.stringify(event);
      if (Buffer.byteLength(text) > MAIN_RED_METRIC_LIMITS.bytes) throw new Error('oversized event');
      const path = join(dir, 'main-red-metrics', `${event.key}.json`);
      const acknowledge = () => {
        const saved = readMetricFile(path);
        // Only the polling timestamp may advance on a state-write retry. Every
        // transition field, including origin and timing sample, must still agree.
        const fields = ['v', 'key', 'repo', 'head', 'seq', 'runId', 'kind', 'since', 'signature', 'truncated'];
        if (!validMainRedMetric(saved) || fields.some(key => saved[key] !== event[key])
          || ['waitMs', 'admissionWaitMs', 'serviceMs'].some(key => saved.queue[key] !== event.queue[key]))
          throw new Error('conflicting existing event');
      };
      try { acknowledge(); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (count >= limit) throw new Error('event limit');
      try { writeFile(path, text, { flag: 'wx', mode: 0o600 }); count++; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        acknowledge(); // The competing writer may have left partial or conflicting evidence.
      }
    }
  } catch { warnings.push(metricRecovery); }
  return { warnings };
}

/** Read-only journal evidence. Every skipped or unreadable byte leaves an operator-visible warning. */
export function readMainRedMetrics(dir, { limit = MAIN_RED_METRIC_LIMITS.events, openDir = opendirSync,
  read = readSync } = {}) {
  const events = []; const warnings = [];
  try {
    for (const name of metricFiles(dir, { limit, openDir })) {
      const path = join(dir, 'main-red-metrics', name);
      try {
        const event = readMetricFile(path, read);
        if (!validMainRedMetric(event)) throw new Error('malformed event');
        events.push(event);
      } catch (error) {
        warnings.push(error.message === 'oversized event'
          ? 'Incomplete oversized event; archive journal and recover source evidence.'
          : 'Incomplete malformed/unreadable event; archive journal and recover source evidence.');
      }
    }
  } catch { warnings.push(metricRecovery); }
  return { events, warnings: [...new Set(warnings)] };
}

/** Read-only reporting entry point: accepts explicit query time; never changes settings or alert state. */
export function readMainRedReport(dir, options) {
  const { events, warnings } = readMainRedMetrics(dir);
  return reportMainRedMetrics(events, { ...options, warnings });
}
