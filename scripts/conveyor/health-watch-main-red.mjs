/** Pure red-main attention planning and the health tick's bounded IO adapter. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { mainRedState, findOwnerPrs, mainCiRedSettings } from './main-ci-red-core.mjs';
import { DEFAULT_REPO_SLUG, readRunJobs, readFailingTests, readOpenPrsForOwner } from './main-ci-red-io.mjs';

export function mainRedAlertSettings(config = {}) {
  const value = config?.mainRedAlertAfterMin;
  return { mainRedAlertAfterMin: Number.isFinite(value) && value >= 0 ? value : 20 };
}

export function planMainRedAlert({ runs, tip, readOk = true, now, prev = {},
  settings = mainRedAlertSettings(), details } = {}) {
  const next = { ...prev };
  const items = [];
  const base = { repo: DEFAULT_REPO_SLUG, pr: 0 };
  const state = readOk ? mainRedState(runs, { tip }) : { status: 'unknown' };
  if (!['red', 'green'].includes(state.status)) {
    if (!prev.unknownEmitted) items.push({ ...base, kind: 'main-status-unknown',
      head: 'main-status-unknown', reason: 'Main CI status is unavailable' });
    next.unknownEmitted = true;
    return { items, next };
  }
  next.unknownEmitted = false;
  if (state.status === 'green') {
    if (prev.fingerprint) items.push({ ...base, kind: 'main-green', head: prev.fingerprint,
      reason: 'Main CI is green again' });
    next.fingerprint = null;
    return { items, next };
  }
  if (now - state.redSinceMs < settings.mainRedAlertAfterMin * 60_000) return { items, next };
  const failingJobs = [...new Set(details?.failingJobs ?? [])].sort();
  const fixPrs = [...new Set(details?.fixPrs ?? [])].sort((a, b) => a - b);
  const firstFailingTest = details?.firstFailingTest ?? null;
  const firstRedSha = state.firstRed.sha;
  const since = new Date(state.redSinceMs).toISOString();
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ firstRedSha, since, failingJobs, firstFailingTest, fixPrs })).digest('hex');
  if (fingerprint !== prev.fingerprint) items.push({ ...base, kind: 'main-red', head: fingerprint,
    since, firstRedSha, failingJobs, firstFailingTest, fixPrs,
    blockedReadyPrs: details?.blockedReadyPrs ?? null,
    reason: `Main CI red since ${since}: ${firstFailingTest || failingJobs[0] || firstRedSha.slice(0, 7)}`.slice(0, 100),
  });
  next.fingerprint = fingerprint;
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
      '--state', 'open', '--label', 'ready-to-merge', '--json', 'number', '--limit', '100'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
      timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    if (!isGhDeferred(out)) {
      const prs = JSON.parse(String(out));
      // A full page cannot prove the count; retain null rather than undercounting.
      if (Array.isArray(prs) && prs.length < 100) details.blockedReadyPrs = prs.length;
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
