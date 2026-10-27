/** Pure red-main attention planning and the health tick's bounded IO adapter. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { mainRedState, latestCheckVerdicts, findOwnerPrs, mainCiRedSettings } from './main-ci-red-core.mjs';
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
      && ['success', 'neutral'].includes(check.conclusion));
  // A full check page may be truncated; retain unknown on either recovery path.
  const provenGreen = tipReadable && tip.checkRuns.length < 100
    && tip.checksTotal === tip.checkRuns.length
    && (state.via === 'tip-required-checks'
    || (state.latestGreen?.sha === tip.sha
      && Array.isArray(tip.requiredChecks) && tip.requiredChecks.length > 0
      && !tipVerdicts.includes('pending')));
  if (!['red', 'green'].includes(state.status) || (state.status === 'green' && !provenGreen)) {
    if (!prev.unknownEmitted) emit({ ...base, kind: 'main-status-unknown',
      head: 'main-status-unknown', reason: 'Main CI status is unavailable' });
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
  const firstFailingTest = details?.firstFailingTest ?? carried.firstFailingTest ?? null;
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
  return { items, next };
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
  const details = { failingJobs: null, firstFailingTest: null, fixPrs: null, blockedReadyPrs: null };
  if (state.status !== 'red') return details;
  try {
    const jobs = readRunJobs(state.firstRed.runId);
    if (jobs.complete) details.failingJobs = jobs.failed.map((job) => job.name);
    if (jobs.failed[0]) {
      try { details.firstFailingTest = readFailingTests(jobs.failed[0].id)[0] ?? null; } catch { /* annotations unavailable */ }
    }
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
  readDetails = readAlertDetails } = {}) {
  const prev = await readState(dir);
  const readOk = !!probe && !probe.error;
  const state = readOk ? mainRedState(probe.runs, { tip: probe.tip }) : { status: 'unknown' };
  let details = null;
  try { details = await readDetails({ state, probe, config }); } catch { /* alert with unknown details */ }
  const result = planMainRedAlert({ runs: probe?.runs, tip: probe?.tip, readOk, now,
    prev, settings: mainRedAlertSettings(config), details });
  for (const item of result.items) await publish(item);
  await writeState(dir, result.next);
  return result;
}
