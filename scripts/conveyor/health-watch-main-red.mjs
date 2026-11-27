/** Pure red-main attention planning and the health tick's bounded IO adapter. */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { diffFeed, parseFeedLine, publishAttention } from '../operations/needs-you-feed.mjs';
import { handoffHome } from '../lib/handoff-path.mjs';
import { mainRedState, latestCheckVerdicts, findOwnerPrs, mainCiRedSettings } from './main-ci-red-core.mjs';
import { DEFAULT_REPO_SLUG, readRunJobs, readFailingTests, readOpenPrsForOwner } from './main-ci-red-io.mjs';

export function mainRedAlertSettings(config = {}) {
  const value = config?.mainRedAlertAfterMin;
  return { mainRedAlertAfterMin: Number.isFinite(value) && value >= 0 ? value : 20 };
}

export function planMainRedAlert(input = {}) {
  const { runs, tip, readOk = true, stateUnreadable = false, now, prev = {},
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
    const head = `${item.head}:${next.seq}`;
    const eventId = `${item.kind}:${createHash('sha256')
      .update(JSON.stringify([base.repo, head, item.fullHead ?? null])).digest('hex')}`;
    items.push({ ...item, head, eventId });
  };
  const base = { repo: DEFAULT_REPO_SLUG, pr: 0 };
  let state = readOk ? mainRedState(runs, { tip }) : { status: 'unknown' };
  if (state.status === 'red' && !/^[a-f0-9]{40}$/i.test(state.latestRed?.sha ?? '')) state = { status: 'unknown' };
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
  // Healthy workflow runs commonly precede the new tip's checks. Only an
  // outstanding red alert needs unavailable recovery evidence surfaced here.
  if (state.status === 'green' && !provenGreen && !prev.fingerprint) return { items, next };
  if (!['red', 'green'].includes(state.status) || (state.status === 'green' && !provenGreen)) {
    if (!prev.unknownEmitted) emit({ ...base, kind: 'main-status-unknown',
      head: stateUnreadable ? 'main-state-unreadable' : 'main-status-unknown',
      reason: stateUnreadable
        ? 'Main-red state unreadable; repair main-red-alert.json and retry'
        : 'Main CI status is unavailable' });
    next.unknownEmitted = true;
    return { items, next };
  }
  next.unknownEmitted = false;
  if (state.status === 'green') {
    if (prev.fingerprint) emit({ ...base, kind: 'main-green',
      head: `${prev.fingerprint}:${prev.fingerprintParts?.since ?? 'unknown'}`,
      reason: 'Main CI is green again' });
    next.fingerprint = null;
    next.fingerprintParts = null;
    next.fullHead = null;
    return { items, next };
  }
  if (now - state.redSinceMs < settings.mainRedAlertAfterMin * 60_000) return { items, next };
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
  const fullHead = state.latestRed.sha;
  // Legacy state has no fullHead; migrate it quietly when the fingerprint matches.
  if (fingerprint !== prev.fingerprint || (prev.fullHead && prev.fullHead !== fullHead)) emit({ ...base, kind: 'main-red', head: fingerprint, fullHead,
    since, firstRedSha, failingJobs, firstFailingTest, fixPrs,
    blockedReadyPrs: details?.blockedReadyPrs ?? null,
    reason: `Main CI red since ${since}: ${firstFailingTest || failingJobs[0] || firstRedSha.slice(0, 7)}`.slice(0, 100),
  });
  next.fingerprint = fingerprint;
  next.fingerprintParts = fingerprintParts;
  next.fullHead = fullHead;
  return { items, next };
}

/** Read at most limit + 1 bytes, including files that grow while being read. */
function readBounded(path, limit, { open = openSync, read = readSync, close = closeSync } = {}) {
  let fd;
  try {
    fd = open(path, 'r');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = read(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error('Input exceeds read limit');
    return buffer.subarray(0, size).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) close(fd); }
}

function validAlertState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.seq !== undefined && (!Number.isSafeInteger(value.seq) || value.seq < 0)) return false;
  if (value.unknownEmitted !== undefined && typeof value.unknownEmitted !== 'boolean') return false;
  if (value.fingerprint != null && !/^[a-f0-9]{64}$/.test(value.fingerprint)) return false;
  if (value.fullHead != null && !/^[a-f0-9]{40}$/i.test(value.fullHead)) return false;
  const parts = value.fingerprintParts;
  return parts == null || (typeof parts === 'object' && !Array.isArray(parts)
    && typeof parts.firstRedSha === 'string' && Number.isFinite(Date.parse(parts.since))
    && Array.isArray(parts.failingJobs) && parts.failingJobs.every(job => typeof job === 'string')
    && Array.isArray(parts.fixPrs) && parts.fixPrs.every(pr => Number.isSafeInteger(pr) && pr > 0)
    && (parts.firstFailingTest === null || typeof parts.firstFailingTest === 'string'));
}

function readAlertState(dir, fileIo) {
  const text = readBounded(join(dir, 'main-red-alert.json'), 64 * 1024, fileIo);
  return text === null ? {} : JSON.parse(text);
}

/** The JSON alert is durable before the legacy feed and producer cursor advance.
 * Replay after either write fails deduplicates under the same alert-file lock.
 * Unknown/oversized history refuses publication: repair/archive it and retry.
 */
function appendMainRedAlert(item, path, now, fileIo) {
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(`${path}.lock`, () => {
    let events, text;
    try {
      text = readBounded(path, 8 * 1024 * 1024, fileIo) ?? '';
      events = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      if (events.some(event => !event || typeof event !== 'object' || Array.isArray(event)
        || typeof event.kind !== 'string')) throw new Error('Incomplete alert history');
    } catch {
      throw new Error('Main-red alert history unreadable/oversized; repair or archive alerts.jsonl and retry');
    }
    if (events.some(event => event.eventId === item.eventId)) return;
    // Reuse the feed's recursive sanitation and field bounds for untrusted evidence.
    const safe = parseFeedLine(diffFeed([], [item], now).lines[0]);
    const separator = text && !text.endsWith('\n') ? '\n' : '';
    appendFileSync(path, `${separator}${JSON.stringify({ ...safe, kind: 'MAIN-RED', feedHead: safe.head, head: item.fullHead })}\n`);
  });
}

function writeAlertState(dir, next) {
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, 'main-red-alert.json'), next);
}

function readAlertDetails({ state, config }) {
  const details = { failingJobs: null, firstFailingTest: undefined, fixPrs: null, blockedReadyPrs: null };
  if (state.status !== 'red') return details;
  try {
    const jobs = readRunJobs(state.latestRed.runId);
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
  publish, publishFeed = publishAttention, alertsPath,
  fileIo, readState = (dir) => readAlertState(dir, fileIo),
  writeState = writeAlertState, readDetails = readAlertDetails } = {}) {
  const send = publish ?? (async (item) => {
    if (item.kind === 'main-red') appendMainRedAlert(item,
      alertsPath ?? join(handoffHome(), 'state', 'alerts.jsonl'), now, fileIo);
    await publishFeed(item);
  });
  let prev;
  try {
    prev = await readState(dir);
    if (!validAlertState(prev)) throw new Error('Invalid main-red alert state');
  } catch {
    const result = planMainRedAlert({ readOk: false, stateUnreadable: true, now });
    for (const item of result.items) await send(item);
    // Never replace unreadable evidence or interpret its missing fingerprint as healthy.
    return { ...result, stateUnreadable: true };
  }
  const readOk = !!probe && !probe.error;
  const state = readOk ? mainRedState(probe.runs, { tip: probe.tip }) : { status: 'unknown' };
  let details = null;
  try { details = await readDetails({ state, probe, config }); } catch { /* alert with unknown details */ }
  const result = planMainRedAlert({ runs: probe?.runs, tip: probe?.tip, readOk, now,
    prev, settings: mainRedAlertSettings(config), details });
  for (const item of result.items) await send(item);
  await writeState(dir, result.next);
  return result;
}
