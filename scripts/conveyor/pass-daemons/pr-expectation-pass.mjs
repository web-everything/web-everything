#!/usr/bin/env node
/** Shadow expectation babysitter: GET/query evidence only; its sole output event is
 * expectation-missed. No repair, label, comment, dispatch or enqueue operation exists.
 * --once (default), --watch (60s), --pr=N, --as-of=ISO, --repo=owner/name.
 * Replay requires --events-file, --evidence-file AND --state-file together. The
 * events file is both replay input and scratch event sink; never points at live log.
 * Fixture shape is the core evidence contract in pr-expectations.mjs. reactions
 * include normalized timeline actions as well as reactions, all explicitly SHA-bound.
 * State holds one record per PR, observed eligibility timers and miss reservations.
 * Reserve before append for at-most-once delivery across restart; a failed append
 * requires operator inspection (automatic retry could duplicate a delivered event).
 */
import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync, rmSync, realpathSync,
  openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { handoffHome } from '../../operations/handoff-home.mjs';
import { ghRepoSlug, DEFAULT_REPO_KEY } from '../../lib/constellation-repos.mjs';
import { daemonEventsPath, appendDaemonEvent } from '../../lib/daemon-events.mjs';
import { readSettingsChecked } from '../../lib/settings-files.mjs';
import { readPlatformPreferences } from '../../lib/policy-cascade.mjs';
// Load shared readers at startup, outside the first pass's execution deadline.
import { ghJson } from '../../operations/coroner-pr-postmortem.mjs';
import { listOpenPrs } from './pr-postmortem-pass.mjs';
import { resolveExpectationSettings, deriveActions, evaluateExpectations, missKey,
  validSha, validObservation } from './pr-expectations.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fallback = 'expectation-babysitter: unknown/incomplete evidence; operator must inspect events, settings, PR evidence and state; no response executed';
const MAX_BYTES = 16 * 1024 * 1024;
function text(file) {
  if (statSync(file).size > MAX_BYTES) throw Error('input cap; operator inspection required');
  return readFileSync(file, 'utf8');
}
const json = file => JSON.parse(text(file));
/** Live logs are cumulative. Read a fixed byte window from one descriptor, discard
 * only its cut first record and an unfinished final append. Interior corruption is unknown.
 */
function liveEventsTail(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_BYTES);
    const bytes = Buffer.alloc(size - start);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, start + count);
      if (!n) throw Error('log changed during read');
      count += n;
    }
    let offset = 0;
    if (start > 0) {
      const previous = Buffer.alloc(1);
      if (readSync(fd, previous, 0, 1, start - 1) !== 1) throw Error('log changed during read');
      if (previous[0] !== 10) {
        offset = bytes.indexOf(10) + 1;
        if (!offset) throw Error('event line exceeds tail cap');
      }
    }
    const events = [];
    for (const line of bytes.subarray(offset).toString('utf8').split('\n')) {
      const position = start + offset;
      offset += Buffer.byteLength(line) + 1;
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch (error) { if (start + offset > size) break; throw error; }
      if (!object(event)) throw Error('unknown event');
      events.push({ ...event, source: event.source ?? `daemon-events:byte:${position}` });
    }
    return events;
  } finally { closeSync(fd); }
}
function canonical(file) {
  try { return realpathSync(file); }
  catch { const parent = dirname(resolve(file));
    return parent === resolve(file) ? parent : join(canonical(parent), resolve(file).slice(parent.length + 1)); }
}
function save(file, state) {
  const temp = `${file}.${process.pid}.new`;
  const contents = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(contents) > MAX_BYTES) throw Error('state cap; operator inspection required');
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, file);
}

export function readExpectationSettings({ env = process.env, settingsFiles, log = console.error } = {}) {
  const tool = readSettingsChecked(settingsFiles);
  const platform = readPlatformPreferences({ env });
  const settings = resolveExpectationSettings({ platform: platform.prefs.expectationBabysitter,
    tool: { mode: tool.value?.mode, expectations: tool.value?.expectations },
    envValues: { mode: env.WE_EXPECTATIONS_MODE },
    // Only taint on this feature's own file counts; an unrelated settings file's defect must not blind the babysitter.
    readable: !tool.taint.some(t => /(^|\/)expectations\.json$|dispatch-settings\.json$/.test(String(t?.source)))
      && !platform.errors.length });
  log(`policy-cascade · expectationBabysitter: ${JSON.stringify({ mode: settings.mode, expectations: settings.expectations, sources: settings.sources, valid: settings.valid })}`);
  return settings;
}

/** Reader uses one shared budget, explicit pagination and a final head recheck.
 * A cap/failed read leaves the PR unknown; caller logs the operator fallback.
 */
export function collectExpectationEvidence({ repo, pr, read, now }) {
  const [owner, name] = repo.split('/');
  const query = `query { repository(owner: "${owner}", name: "${name}") {
    pullRequest(number: ${pr}) { number state headRefOid mergedAt mergeStateStatus
      headRef { target { ... on Commit { committedDate } } }
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
      mergeQueueEntry { enqueuedAt } } } }`;
  const response = read(['api', 'graphql', '-f', `query=${query}`]);
  const pull = response?.data?.repository?.pullRequest;
  const terminal = ['MERGED', 'CLOSED'].includes(pull?.state);
  const headAt = pull?.headRef?.target?.committedDate;
  if (response?.errors || pull?.number !== pr || !validSha(pull.headRefOid)
    || !['OPEN', 'MERGED', 'CLOSED'].includes(pull.state)
    || (!terminal && !Number.isFinite(Date.parse(headAt))) || !Array.isArray(pull.labels?.nodes)
    || pull.labels.pageInfo?.hasNextPage !== false || pull.labels.nodes.some(l => typeof l?.name !== 'string')
    || !Object.hasOwn(pull, 'mergeQueueEntry') || !Object.hasOwn(pull, 'mergedAt')
    || typeof pull.mergeStateStatus !== 'string') throw Error('unknown PR evidence');
  const sha = pull.headRefOid;
  const reactions = [];
  const add = (action, at, source, headBound = false) => {
    const item = { pr, sha, action, at, source };
    if (!validObservation(item)) throw Error('unknown reaction');
    // Checks name the exact head. Timeline labels need the commit date to bind to that head.
    if ((headBound || Date.parse(at) >= Date.parse(headAt)) && Date.parse(at) <= Date.parse(now)) reactions.push(item);
  };
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const rows = read(['api', `repos/${repo}/issues/${pr}/timeline?per_page=100&page=${page}`]);
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(r => !object(r) || typeof r.event !== 'string')) throw Error('unknown timeline');
    for (const row of rows) {
      const label = row.label?.name;
      if (row.event === 'unlabeled' && label === 'review:human')
        add('clear-human', row.created_at, row.url ?? `timeline:${row.id}`);
      if (row.event === 'labeled' && ['ready-to-merge', 'red-team:pending'].includes(label))
        add(label, row.created_at, row.url ?? `timeline:${row.id}`);
      if (row.event === 'merged') add('merged', row.created_at, row.url ?? `timeline:${row.id}`, true);
    }
    if (rows.length < 100) { complete = true; break; }
  }
  if (!complete) throw Error('timeline cap; operator inspection required');
  const checks = { check_runs: [] };
  for (let page = 1; ; page++) {
    const part = read(['api', `repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`]);
    if (!Array.isArray(part?.check_runs) || !Number.isSafeInteger(part.total_count)) throw Error('unknown checks');
    checks.check_runs.push(...part.check_runs);
    if (checks.check_runs.length >= part.total_count) { if (checks.check_runs.length !== part.total_count) throw Error('unknown checks'); break; }
    if (page >= 10 || !part.check_runs.length) throw Error('check cap; operator inspection required');
  }
  for (const check of checks.check_runs) {
    if (check?.head_sha !== sha || typeof check.name !== 'string'
      || !['queued', 'in_progress', 'completed'].includes(check.status)) throw Error('unknown check');
    const gate = /merge[- ]gate/i.test(check.name);
    const redTeam = /(^|[^a-z0-9])red[- ]team([^a-z0-9]|$)/i.test(check.name);
    const review = !redTeam && /(^|[^a-z0-9])review([^a-z0-9]|$)/i.test(check.name);
    if (check.started_at) add(gate ? 'merge-gate-started' : redTeam ? 'red-team-started'
      : review ? 'review-started' : 'ci-started', check.started_at, check.html_url ?? `check:${check.id}`, true);
    if (check.status === 'completed' && !['success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required', 'stale'].includes(check.conclusion)) throw Error('unknown check conclusion');
    if (gate && check.conclusion === 'success') add('merge-gate-pass', check.completed_at, check.html_url ?? `check:${check.id}`, true);
    if (!gate && !review && !redTeam && ['failure', 'timed_out'].includes(check.conclusion))
      add('ci-red', check.completed_at, check.html_url ?? `check:${check.id}`, true);
  }
  if (pull.mergedAt !== null) add('merged', pull.mergedAt, 'github:mergedAt', true);
  if (pull.mergeQueueEntry !== null) add('merge-queue-enqueued', pull.mergeQueueEntry.enqueuedAt, 'github:mergeQueueEntry', true);
  const final = read(['api', `repos/${repo}/pulls/${pr}`]);
  if (final?.head?.sha !== sha) throw Error('head changed during collection');
  if (final.state !== (terminal ? 'closed' : 'open')) throw Error('PR state changed during collection');
  return { sha, complete: true, terminal, reactions,
    eligible: !terminal && pull.mergeQueueEntry === null && pull.mergeStateStatus === 'CLEAN'
      && pull.labels.nodes.some(l => l.name === 'ready-to-merge') };
}

export async function runExpectationPass({ repo = ghRepoSlug(DEFAULT_REPO_KEY), pr,
  now = new Date().toISOString(), eventsFile, stateFile, evidenceFile, settings,
  gh, emitEvent, saveState = save, env = process.env, home, log = console.error } = {}) {
  const config = settings ?? readExpectationSettings({ env, log });
  if (config.mode === 'off') return { results: [], delivered: 0, incomplete: false };
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo) || !Number.isFinite(Date.parse(now))
    || (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1))) throw Error('invalid subject/clock');
  const replay = Boolean(eventsFile || evidenceFile);
  if (replay && (!eventsFile || !evidenceFile || !stateFile)) throw Error('replay requires events, evidence and state scratch files');
  const liveEvents = daemonEventsPath({ env, home });
  const liveState = join(handoffHome({ home }), 'state', 'expectation-babysitter', `${repo.replace('/', '--')}.json`);
  if (replay) {
    const protectedPaths = new Set([liveEvents, liveState].map(canonical));
    const replayPaths = [eventsFile, evidenceFile, stateFile].map(canonical);
    if (replayPaths.some(path => protectedPaths.has(path)) || new Set(replayPaths).size !== 3)
      throw Error('replay paths must be distinct scratch paths');
  }
  eventsFile ??= liveEvents;
  stateFile ??= liveState;
  const result = { results: [], delivered: 0, incomplete: false };
  const fail = () => { result.incomplete = true; log(fallback); };
  mkdirSync(dirname(stateFile), { recursive: true });
  const lock = `${stateFile}.lock`;
  try { mkdirSync(lock); } catch { fail(); return result; }
  try {
    let state;
    try { state = json(stateFile); }
    catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: 1, prs: {}, cursor: 0 }; }
    if (state?.version !== 1 || !object(state.prs) || !Number.isSafeInteger(state.cursor)
      || Object.values(state.prs).some(p => !object(p) || !object(p.emitted)
        || Object.values(p.emitted).some(v => v !== true) || !Array.isArray(p.observations)
        || !p.observations.every(validObservation))) throw Error('unknown state');
    let events = null;
    try {
      events = replay ? text(eventsFile).split('\n').filter(s => s.trim()).map(s => JSON.parse(s)) : liveEventsTail(eventsFile);
      events = events.filter(e => !e.repo || [repo, repo.split('/')[1]].includes(e.repo));
    } catch { fail(); }
    let evidence = { prs: {} };
    let subjects;
    let read;
    if (evidenceFile) {
      try { evidence = json(evidenceFile); if (!object(evidence?.prs)) throw Error('unknown fixture'); }
      catch { fail(); evidence = { prs: {} }; }
    } else {
      gh ??= ghJson;
      let calls = 0;
      read = args => { if (++calls > 128) throw Error('tick budget; operator inspection required'); return gh(args); };
      const listed = pr ? [{ number: pr }] : listOpenPrs(repo, { gh: read });
      const numbers = [...new Set([...listed.map(p => p.number), ...Object.keys(state.prs).map(Number)])]
        .filter(n => !pr || n === pr).sort((a, b) => a - b);
      subjects = new Set(numbers);
      // Include unread/budget-deferred subjects as unknown, even without a trigger in this window.
      for (const n of numbers) evidence.prs[n] = { sha: state.prs[n]?.observations.at(-1)?.sha, complete: false };
      const start = Math.max(0, numbers.findIndex(n => n >= state.cursor));
      for (const n of [...numbers.slice(start), ...numbers.slice(0, start)]) {
        state.cursor = n;
        try {
          evidence.prs[n] = collectExpectationEvidence({ repo, pr: n, read, now });
          // Once retired, an explicit --pr or a racing open list must not replay its historical misses.
          if (evidence.prs[n].terminal && !state.prs[n]) { delete evidence.prs[n]; subjects.delete(n); }
        }
        catch { fail(); }
        if (calls >= 128) break;
        state.cursor = n + 1;
      }
    }
    const allDerived = deriveActions(events);
    const derived = allDerived?.filter(a => (!subjects || subjects.has(a.pr)) && (!pr || a.pr === pr)) ?? null;
    evidence.eventsReadable = derived !== null;
    // Retain identities even when the PR reader fails, so unavailable evidence is visible as unknown.
    for (const a of derived ?? []) if (!evidence.prs[a.pr]?.sha) evidence.prs[a.pr] = { sha: a.sha, complete: false };
    for (const [n, p] of Object.entries(evidence.prs)) {
      if (pr && Number(n) !== pr) { delete evidence.prs[n]; continue; }
      if (!validSha(p?.sha)) { fail(); continue; }
      const old = state.prs[n];
      const tracked = old ?? { emitted: {}, observations: [] };
      tracked.observations = tracked.observations.filter(a => a.sha === p.sha);
      if (!replay) {
        const known = new Set(tracked.observations.map(a => JSON.stringify([a.action, a.at])));
        const observed = [...(derived ?? []), ...(Array.isArray(p.reactions) ? p.reactions : [])];
        for (const a of observed) if (a.pr === Number(n) && a.sha === p.sha
          && Date.parse(a.at) <= Date.parse(now) && !known.has(JSON.stringify([a.action, a.at]))) {
          tracked.observations.push(a); known.add(JSON.stringify([a.action, a.at]));
        }
      }
      if (p.complete === true && p.eligible === true && !tracked.observations.some(a => a.action === 'enqueue-eligible'))
        tracked.observations.push({ pr: Number(n), sha: p.sha, action: 'enqueue-eligible', at: now, source: 'github:CLEAN+ready' });
      if (p.complete === true && p.eligible === false)
        tracked.observations = tracked.observations.filter(a => a.action !== 'enqueue-eligible');
      state.prs[n] = tracked;
      if (Array.isArray(p.reactions) && derived) p.reactions = [...p.reactions,
        ...derived.filter(a => a.pr === Number(n) && a.sha === p.sha), ...tracked.observations];
    }
    const timeline = Object.values(evidence.prs).flatMap(p => Array.isArray(p.reactions) ? p.reactions : []);
    const actions = derived === null ? null : deriveActions(derived, [...timeline,
      ...Object.entries(state.prs).filter(([n]) => (!subjects || subjects.has(Number(n))) && (!pr || Number(n) === pr))
        .flatMap(([, p]) => p.observations)]);
    result.results = evaluateExpectations({ settings: config, actions, evidence, now });
    if (result.results.some(r => r.status === 'unknown')) fail();
    const failedDeliveries = new Set();
    for (const row of result.results.filter(r => r.status === 'missed')) {
      const tracked = state.prs[row.pr];
      const key = missKey(row);
      if (tracked.emitted[key]) continue;
      const { status, ...facts } = row;
      const event = { kind: 'expectation-missed', repo, pr: row.pr,
        daemon: 'expectation-babysitter', detail: { ...facts, mode: 'observe' } };
      const send = emitEvent ?? (e => appendDaemonEvent(e, {
        env: { ...env, WE_DAEMON_EVENTS: eventsFile }, now: () => new Date(now) }));
      // Persist the reservation BEFORE any append: even ambiguous delivery cannot be retried on restart.
      tracked.emitted[key] = true;
      saveState(stateFile, state);
      let sent = false;
      try { sent = (await send(event)) !== false; } catch { sent = false; }
      if (!sent) { failedDeliveries.add(row.pr); fail(); continue; }
      result.delivered++;
    }
    // Retire each fully evaluated terminal PR even when another PR exhausts the shared budget.
    // Otherwise a large historical tracked set could never shrink below that budget.
    if (config.valid && derived !== null) for (const [n, p] of Object.entries(evidence.prs)) {
      if (p.terminal && p.complete === true && !failedDeliveries.has(Number(n))
        && !result.results.some(r => r.pr === Number(n) && r.status === 'unknown')) delete state.prs[n];
    }
    saveState(stateFile, state);
  } catch { fail(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
  return result;
}

export async function runExpectationCli(values, { runPass = runExpectationPass, wait = sleep,
  signal, log = console.log } = {}) {
  if (values['as-of'] && !(values['events-file'] && values['evidence-file'] && values['state-file']))
    throw Error('--as-of requires scratch replay paths');
  do {
    const result = await runPass({ repo: values.repo, pr: values.pr ? Number(values.pr) : undefined,
      now: values['as-of'], eventsFile: values['events-file'], evidenceFile: values['evidence-file'],
      stateFile: values['state-file'] });
    // No untrusted event facts or free-form settings text in terminal output.
    log(JSON.stringify({ delivered: result.delivered, incomplete: result.incomplete,
      statuses: result.results.map(r => r.status) }));
    if (!values.watch || values.once) break;
    await wait(60_000, undefined, { signal }).catch(() => {});
  } while (!signal?.aborted);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries([
    ...['repo', 'pr', 'as-of', 'events-file', 'state-file', 'evidence-file'].map(k => [k, { type: 'string' }]),
    ...['once', 'watch'].map(k => [k, { type: 'boolean' }]),
  ]) });
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort()); process.once('SIGINT', () => abort.abort());
  await runExpectationCli(values, { signal: abort.signal });
}
