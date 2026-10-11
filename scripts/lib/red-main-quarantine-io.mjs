#!/usr/bin/env node
/**
 * @file scripts/lib/red-main-quarantine-io.mjs
 * @description IO + CLI for the red-main quarantine list on the `ops/quarantine` branch (pure rules:
 *   we:scripts/lib/red-main-quarantine.mjs). Reuses the #4451 push-ref guarded transport
 *   (we:scripts/lib/git-transport-branch.mjs): the ONLY ref this module may push is `refs/heads/ops/quarantine`,
 *   never forced, and only for the writers in QUARANTINE_WRITERS. Each change writes the list and appends its
 *   `quarantine-added` / `quarantine-removed` events to `events.jsonl` in the SAME commit (audit trail).
 *
 * CLI (repo root as cwd):
 *   node scripts/lib/red-main-quarantine-io.mjs skip [--pr=<n>] [--fix-prs=<n,..>] [--on-main] [--format=json|vitest]
 *       Fetch the CURRENT list and print the tests to skip. Mode-gated like CI's step (scripts/ci/quarantine-skip.mjs):
 *       only a list stamped `mode: quarantine` skips anything. Unreadable list / `stop` / no stamp ⇒ prints nothing to
 *       skip (CI runs everything — the safe direction). The main-fix PR / main always skip nothing.
 *   node scripts/lib/red-main-quarantine-io.mjs add --actor=<red-main-safety-net|operator> --broken-sha=<sha>
 *       --owner=<who> --reason=<why> --tests=<id,id> [--area=<dir/>] [--ttl-min=<n>]
 *   node scripts/lib/red-main-quarantine-io.mjs prune --actor=<..> --main-green=<true|false|unknown>
 *   node scripts/lib/red-main-quarantine-io.mjs show
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { writeAllSync } from './write-all-sync.mjs'; // a CLI's stdout must be drained before any process.exit
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFromTransportBranch, stageOnTransportBranch, assertPushRef } from './git-transport-branch.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { resolveRedMainMode, RED_MAIN_HOLD_SETTINGS_FILE } from './red-main-hold.mjs';
import { mainRedState } from '../conveyor/main-ci-red-core.mjs';
import {
  QUARANTINE_BRANCH, QUARANTINE_REF, QUARANTINE_LIST_PATH, QUARANTINE_EVENTS_PATH,
  validateQuarantineList, addEntries, pruneOnGreen, testsToSkip, canWriteQuarantine, vitestExcludeArgs,
  setFixPrs, setMode, activeEntries, parseVitestFailures, planSafetyNet, QUARANTINE_SAFETY_NET_DEFAULTS,
} from './red-main-quarantine.mjs';

const git = (args, opts) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, killSignal: 'SIGKILL', ...opts });
/** A READ of the ops ref (every CI job does one): bounded, so a hung fetch can never stall the step. */
const gitRead = (args, opts) => git(args, { timeout: 60_000, killSignal: 'SIGKILL', ...opts });

/**
 * Read the current list. `{ok:true, list}` (an absent branch/file = an empty list is NOT assumed: absent file on a
 * read tip ⇒ empty; unreachable branch ⇒ ok:false).
 */
export function readQuarantine({ board = process.cwd(), run = gitRead } = {}) {
  try {
    const got = readFromTransportBranch({ board, branch: QUARANTINE_BRANCH, paths: [QUARANTINE_LIST_PATH], run });
    const text = got[QUARANTINE_LIST_PATH];
    if (text == null) return { ok: true, list: { version: 1, entries: [] } };
    const list = JSON.parse(text);
    const v = validateQuarantineList(list);
    return v.ok ? { ok: true, list } : { ok: false, error: v.errors.join('; ') };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).split('\n')[0] };
  }
}

/** Apply one change (computed against the freshly fetched tip inside the transport) and push it. */
export function writeQuarantineChange({ board = process.cwd(), actor, change, message, run = git, ...seams }) {
  if (!canWriteQuarantine(actor)) throw new Error(`red-main-quarantine: writer "${actor}" refused`);
  assertPushRef(QUARANTINE_BRANCH, QUARANTINE_REF); // the ONE ref; nothing else is ever pushed
  let events = [];
  let refused = null;
  const listFile = {
    path: QUARANTINE_LIST_PATH,
    content: ({ existing }) => {
      const cur = existing ? JSON.parse(existing) : { version: 1, entries: [] };
      const r = change(cur);
      if (!r.ok && r.ok !== undefined) { refused = r.error; return existing ?? JSON.stringify(cur, null, 2) + '\n'; }
      events = r.events;
      return JSON.stringify(r.list, null, 2) + '\n';
    },
  };
  const eventsFile = {
    path: QUARANTINE_EVENTS_PATH,
    content: ({ existing }) => (existing ?? '') + events.map((e) => JSON.stringify(e) + '\n').join(''),
  };
  let createIfAbsent = false;
  try { git(['ls-remote', '--exit-code', 'origin', QUARANTINE_REF], { cwd: board }); } catch { createIfAbsent = true; }
  const out = stageOnTransportBranch({ board, branch: QUARANTINE_BRANCH, files: [listFile, eventsFile], message, run, allowRef: QUARANTINE_REF, createIfAbsent, ...seams });
  if (refused) throw new Error(`red-main-quarantine: change refused: ${refused}`);
  return { ...out, events };
}

/** The safety net's writer name (one of QUARANTINE_WRITERS). */
export const SAFETY_NET_ACTOR = 'red-main-safety-net';
/** Env overrides (the cascade's top layer) for the safety-net knobs. */
export const QUARANTINE_SETTINGS_ENV = Object.freeze({ ttlMin: 'WE_RED_MAIN_QUARANTINE_TTL_MIN', maxTests: 'WE_RED_MAIN_QUARANTINE_MAX_TESTS', unitJobPattern: 'WE_RED_MAIN_QUARANTINE_UNIT_JOB_PATTERN', derivedJobs: 'WE_RED_MAIN_QUARANTINE_DERIVED_JOBS' });
const posInt = (v) => Number.isInteger(v) && v > 0;
const QUARANTINE_SETTINGS_VALID = Object.freeze({
  ttlMin: posInt, maxTests: posInt,
  unitJobPattern: (v) => { try { return typeof v === 'string' && v !== '' && !!new RegExp(v); } catch { return false; } },
  derivedJobs: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== ''),
});

/**
 * The safety-net knobs through the policy cascade (card x5wnfcg): standard default ({@link QUARANTINE_SAFETY_NET_DEFAULTS})
 * → platform preference `redMainQuarantine` → tool override (`redMainQuarantine` block of
 * we:scripts/settings/red-main-hold.json) → env (`WE_RED_MAIN_QUARANTINE_*`). Returns `{value, sources}`; the
 * cascade logs the source line once per daemon process. Never throws.
 */
export function resolveQuarantineSettings({ env = process.env, file = RED_MAIN_HOLD_SETTINGS_FILE, platform } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(file, 'utf8'))?.redMainQuarantine; } catch { /* standard */ }
  const num = (k) => { const raw = env?.[QUARANTINE_SETTINGS_ENV[k]]; if (raw == null || String(raw).trim() === '') return undefined; const n = Number(raw); return Number.isFinite(n) ? n : raw; };
  const str = (k) => { const raw = env?.[QUARANTINE_SETTINGS_ENV[k]]; return raw == null || String(raw).trim() === '' ? undefined : String(raw); };
  const derivedRaw = str('derivedJobs');
  const c = cascadePolicy('redMainQuarantine', tool, {
    env, ...(platform !== undefined ? { platform } : {}),
    standard: { ...QUARANTINE_SAFETY_NET_DEFAULTS, derivedJobs: [...QUARANTINE_SAFETY_NET_DEFAULTS.derivedJobs] },
    envValues: { ttlMin: num('ttlMin'), maxTests: num('maxTests'), unitJobPattern: str('unitJobPattern'), derivedJobs: derivedRaw === undefined ? undefined : derivedRaw.split(',').map((s) => s.trim()).filter(Boolean) },
    valid: QUARANTINE_SETTINGS_VALID,
  });
  // `derivedJobs` is an array leaf; every other knob a scalar leaf — `sources` keys them by name.
  return { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS, ...c.value }, sources: c.sources, invalid: c.invalid };
}

/** Ledger + shadow log live in the health watch's own state dir (the caller passes it). */
export const SAFETY_NET_LEDGER = 'red-main-quarantine.json';
export const SAFETY_NET_SHADOW_LOG = 'red-main-quarantine-shadow.jsonl';

/** A failed CI-log read is retried after 1 min, then 2, 4 … up to 15 min between attempts. */
const JOB_READ_RETRY_BASE_MS = 60_000;
const JOB_READ_RETRY_MAX_MS = 15 * 60_000;
const LEDGER_RETENTION_MS = 48 * 60 * 60 * 1000;
/** Red commits a window record remembers (newest kept), so the ledger stays bounded on a long red. */
const RED_SHAS_KEPT = 200;

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** One CI run's failed jobs `{failed:[{id,name}]}` (`gh api …/runs/<id>/jobs`). Throws on an unreadable read. */
export function readFailedJobs(runId, { exec, repoSlug }) {
  const page = JSON.parse(String(exec('gh', ['api', `repos/${repoSlug}/actions/runs/${runId}/jobs?per_page=100`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' }) || 'null'));
  const jobs = Array.isArray(page?.jobs) ? page.jobs : [];
  return { failed: jobs.filter((j) => ['failure', 'timed_out'].includes(String(j.conclusion))).map((j) => ({ id: j.id, name: String(j.name) })) };
}

/** One failed job's vitest failures from its log (`gh api …/jobs/<id>/logs`). Throws on an unreadable log. */
export function readJobFailures(jobId, { exec, repoSlug }) {
  const text = exec('gh', ['api', `repos/${repoSlug}/actions/jobs/${jobId}/logs`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' });
  return parseVitestFailures(String(text ?? ''));
}

/**
 * The safety net's read: like {@link readQuarantine}, but a branch that provably does NOT exist yet on origin
 * (`git ls-remote --exit-code` exit 2) is an empty list — the first add creates it. Any other failure stays
 * unreadable (the safety net then does nothing).
 */
export function readListOrAbsent({ board = process.cwd(), run = gitRead } = {}) {
  const r = readQuarantine({ board, run });
  if (r.ok) return r;
  try { run(['ls-remote', '--exit-code', 'origin', QUARANTINE_REF], { cwd: board }); } catch (e) {
    if (e?.status === 2) return { ok: true, list: { version: 1, entries: [] }, absent: true };
  }
  return r;
}

/** Compose several pure list changes into one (applied against the freshly fetched tip inside the transport). */
const composeChanges = (steps) => (cur) => {
  let list = cur;
  const events = [];
  for (const step of steps) {
    const r = step(list);
    if (r.ok === false) return r;
    list = r.list;
    events.push(...(r.events ?? []));
  }
  return { ok: true, list, events };
};

/**
 * ONE safety-net pass (card xx7ckd6 N1), called by the `main-ci-red` health smell with that tick's `mainCiRuns`
 * probe. Main red on KNOWN failing test files (every failed job is a unit-test job whose log names them, or an
 * aggregator that failed because of it) ⇒ add them to `ops/quarantine` as writer `red-main-safety-net`; main green
 * or an entry expired ⇒ prune; the main-fix PR numbers (the probe's priority record) ride on the list so CI runs the
 * quarantined tests for them.
 *
 * LIVE only when `redMainMode` is `quarantine` AND `live` is true; otherwise SHADOW: the same plan is applied to a
 * simulated list kept in the ledger, and every would-be change is appended to the shadow log (and returned) — the
 * evidence the red-team review reads while the mode stays `stop`. Job logs are read until they succeed (failed reads
 * retry with a growing backoff, never cached), then once per red window (cached in the ledger by first red commit). A
 * live write also publishes the resolved mode on the list for CI ({@link setMode}). Never throws.
 * @returns {{mode:string, modeSource:string, shadow:boolean, plan:object, applied:boolean, error?:string}|null}
 */
export function runSafetyNet({
  mainCiRuns, now = Date.now(), dir, board = process.cwd(), live = true, repoSlug = CONSTELLATION_REPOS.we.slug,
  mode = resolveRedMainMode(), settings = resolveQuarantineSettings(),
  exec = execFileSyncThrottled, readJobs = (runId) => readFailedJobs(runId, { exec, repoSlug }),
  readLog = (jobId) => readJobFailures(jobId, { exec, repoSlug }),
  readList = () => readListOrAbsent({ board }), write = (o) => writeQuarantineChange({ board, ...o }), log = (l) => console.error(l),
} = {}) {
  if (!dir) return null;
  const ledgerPath = join(dir, SAFETY_NET_LEDGER);
  /** Write the ledger. Best effort for a bookkeeping write, but the caller learns whether it landed. */
  const persist = () => { try { mkdirSync(dirname(ledgerPath), { recursive: true }); writeJsonAtomic(ledgerPath, ledger); return true; } catch { return false; } };
  const shadowPath = join(dir, SAFETY_NET_SHADOW_LOG);
  const ledger = readJson(ledgerPath) ?? { version: 1, reds: {}, shadowList: { version: 1, entries: [] } };
  ledger.reds ??= {};
  const isLive = mode.value === 'quarantine' && live === true;
  const state = mainRedState(mainCiRuns?.runs);
  const out = { mode: mode.value, modeSource: mode.source, shadow: !isLive, settingsSources: settings.sources ?? {}, applied: false };
  let sha = null;
  let activeKey = null;
  try {
    // Flipped back to `stop` after this daemon published `quarantine` on the list: withdraw the stamp so CI (which
    // reads the mode from the list) stops skipping at once, not at entry expiry. Nothing is written by a daemon
    // that never published, and never by a replay tick.
    if (!isLive && live === true && ledger.publishedMode === 'quarantine') {
      try {
        const cur = readList();
        if (cur.ok && cur.list?.mode === 'quarantine') write({ actor: SAFETY_NET_ACTOR, message: `quarantine: mode → ${mode.value} (${mode.source})`, change: (list) => setMode(list, { mode: 'stop', actor: SAFETY_NET_ACTOR, now }) });
        if (cur.ok) ledger.publishedMode = 'stop';
      } catch (e) { out.demoteError = String(e?.message || e).split('\n')[0]; }
    }
    sha = state.status === 'red' ? String(state.firstRed?.sha ?? '') : null;
    // A truncated read (no green in the window) makes `firstRed` slide to a newer commit as the window moves: the
    // window's record is found by ANY red commit it has seen that is still in view (the record remembers them all, so
    // a window that slid past its key still overlaps the previous one), so it is neither forked nor orphaned.
    const windowShas = sha ? [sha, ...(state.redShas ?? [])].filter(Boolean) : [];
    activeKey = windowShas.find((k) => ledger.reds[k])
      ?? Object.keys(ledger.reds).find((k) => ledger.reds[k]?.shas?.some((s) => windowShas.includes(s)))
      ?? sha;
    const rec = sha ? (ledger.reds[activeKey] ??= { at: now, added: [] }) : null;
    if (rec) rec.shas = [...new Set([...(rec.shas ?? [activeKey]), ...windowShas])].slice(-RED_SHAS_KEPT);
    if (rec) rec.seenAt = now; // an active window is never evicted from the ledger, however long it runs
    let jobFailures = {};
    const failedJobs = state.status === 'red' ? (mainCiRuns?.failing?.jobs ?? null) : null;
    if (rec && Array.isArray(failedJobs) && failedJobs.length) {
      // Each failed unit job's log is read until it succeeds, then kept for the red window (re-read only if the
      // failing run changed). A failed read is NEVER cached as an answer: it is retried with a growing backoff.
      const runId = mainCiRuns?.failing?.runId ?? null;
      // A re-run of the same workflow run keeps its id but gets a new `updatedAt`: key the cache on both, so a shard
      // that fails differently on attempt 2 is read again.
      const runKey = `${runId}@${(mainCiRuns?.runs ?? []).find((r) => r?.databaseId === runId)?.updatedAt ?? ''}`;
      if (!rec.jobFailures || rec.runKey !== runKey) { rec.runId = runId; rec.runKey = runKey; rec.jobFailures = {}; rec.readAttempts = 0; rec.readRetryAt = 0; }
      const unitRe = new RegExp(settings.value.unitJobPattern);
      const wanted = failedJobs.filter((n) => unitRe.test(n));
      if (wanted.some((n) => rec.jobFailures[n] == null) && now >= (Number(rec.readRetryAt) || 0)) {
        let jobs = null;
        try { jobs = runId == null ? null : readJobs(runId); } catch { jobs = null; }
        const byName = new Map((jobs?.failed ?? []).map((j) => [j.name, j.id]));
        for (const name of wanted.filter((n) => rec.jobFailures[n] == null)) {
          const id = byName.get(name);
          // Only a COMPLETE parse is an answer; a cut-off / still-uploading log (`complete:false`) is retried like a failed read.
          try { const got = id == null ? null : readLog(id); if (got?.complete === true) rec.jobFailures[name] = got; } catch { /* retried next time */ }
        }
        if (wanted.some((n) => rec.jobFailures[n] == null)) {
          rec.readAttempts = (Number(rec.readAttempts) || 0) + 1;
          rec.readRetryAt = now + Math.min(JOB_READ_RETRY_BASE_MS * 2 ** (rec.readAttempts - 1), JOB_READ_RETRY_MAX_MS);
        } else { rec.readAttempts = 0; rec.readRetryAt = 0; }
      }
      jobFailures = rec.jobFailures;
    }
    let read = { ok: true, list: ledger.shadowList ?? { version: 1, entries: [] } };
    if (isLive) read = readList();
    if (!read.ok) { out.plan = { action: 'none', why: `quarantine list unreadable (${read.error})` }; return out; }
    // An entry on the shared list that was added for this red counts as "added for this red" whether or not this
    // ledger recorded it (a push that landed but threw, a lost ledger): it must not be re-added once it expires.
    if (isLive && rec) for (const e of read.list?.entries ?? []) if (rec.shas?.includes(e.brokenSha) && e.test) rec.added = [...new Set([...(rec.added ?? []), e.test])];
    const pri = mainCiRuns?.priority;
    const fixPrs = pri ? (Array.isArray(pri.prs) ? pri.prs : [pri.pr]) : null;
    const plan = planSafetyNet({
      status: state.status, firstRedSha: sha, failedJobs, jobFailures, list: read.list, fixPrs,
      addedForRed: (isLive ? rec?.added : rec?.shadowAdded) ?? [], now, settings: settings.value,
    });
    out.plan = plan;
    const steps = [];
    const ttlMs = settings.value.ttlMin * 60_000;
    if (plan.action === 'add') {
      steps.push((cur) => addEntries(cur, { tests: plan.tests, brokenSha: sha, owner: SAFETY_NET_ACTOR, reason: `main CI red since ${sha.slice(0, 9)}: ${plan.names.slice(0, 3).join(' | ')}`.slice(0, 400), actor: SAFETY_NET_ACTOR, now, ttlMs }));
    }
    if (plan.action === 'prune') steps.push((cur) => ({ ok: true, ...pruneOnGreen(cur, { mainGreen: plan.mainGreen, now, actor: SAFETY_NET_ACTOR }) }));
    if (plan.fixPrs) steps.push((cur) => setFixPrs(cur, { fixPrs: plan.fixPrs, actor: SAFETY_NET_ACTOR, now }));
    // Publish the mode this daemon resolved (env / preference / settings) so CI applies the SAME one: a CI job cannot
    // see the daemon's env. Stamped whenever entries are live or being added; withdrawn on a flip back to stop.
    let stamping = false;
    if (isLive && read.list?.mode !== 'quarantine' && !(plan.action === 'prune' && plan.mainGreen === true) && (plan.action === 'add' || activeEntries(read.list, { now }).length)) {
      stamping = true;
      steps.push((cur) => setMode(cur, { mode: 'quarantine', actor: SAFETY_NET_ACTOR, now }));
    }
    if (!steps.length) return out;
    const change = composeChanges(steps);
    const what = [plan.action !== 'none' ? `${plan.action}${plan.tests ? ` ${plan.tests.join(', ')}` : ''}` : null, plan.fixPrs ? `fix PRs → [${plan.fixPrs.join(', ')}]` : null].filter(Boolean).join('; ');
    if (isLive) {
      // Record the intent BEFORE the push: a push that lands but throws must still be withdrawable on a flip to stop.
      if (stamping || read.list?.mode === 'quarantine') ledger.publishedMode = 'quarantine';
      // Record "added for this red" BEFORE the push, on disk: a push that lands but throws (ack lost) or a crash
      // between the push and the ledger write must never let the entry be added again once it expires.
      const intended = plan.action === 'add' && rec ? plan.tests.filter((t) => !(rec.added ?? []).includes(t)) : [];
      if (intended.length) { rec.added = [...(rec.added ?? []), ...intended]; }
      // No durable intent, no push: a push that lands with nothing on disk could be added again after it expires.
      if (!persist() && intended.length) {
        rec.added = rec.added.filter((t) => !intended.includes(t));
        out.error = 'quarantine: ledger write failed — not adding (the "added for this red" record cannot be made durable)';
        return out;
      }
      let r;
      try {
        r = write({ actor: SAFETY_NET_ACTOR, message: `quarantine: ${what} (${plan.why})`, change });
      } catch (e) {
        // Roll the intent back only when the list is READABLE and holds none of these tests (the push really did not
        // land, so the next tick may retry). Landed, or unknown (unreadable): keep it — STOP holds rather than renew.
        if (intended.length) {
          let cur = null;
          try { cur = readList(); } catch { cur = null; }
          if (cur?.ok && !(cur.list?.entries ?? []).some((en) => intended.includes(en.test))) rec.added = rec.added.filter((t) => !intended.includes(t));
        }
        throw e;
      }
      out.applied = true;
      out.events = r?.events ?? [];
    } else {
      const r = change(ledger.shadowList ?? { version: 1, entries: [] });
      if (r.ok === false) { out.error = r.error; return out; }
      ledger.shadowList = r.list;
      out.events = r.events;
      const line = { at: new Date(now).toISOString(), mode: mode.value, modeSource: mode.source, wouldDo: plan.action, tests: plan.tests ?? [], names: plan.names ?? [], fixPrs: plan.fixPrs ?? null, firstRedSha: sha, why: plan.why, settingsSources: settings.sources ?? {} };
      mkdirSync(dirname(shadowPath), { recursive: true });
      appendFileSync(shadowPath, JSON.stringify(line) + '\n');
      log(`red-main-quarantine (shadow, redMainMode=${mode.value} from ${mode.source}): WOULD ${what} — ${plan.why}${plan.names?.length ? ` [${plan.names.slice(0, 3).join(' | ')}]` : ''}`);
    }
    // Live and shadow additions are tracked apart: a shadow "would add" must not block the first real add after a
    // stop → quarantine flip within the same red window.
    if (plan.action === 'add' && rec) {
      const key = isLive ? 'added' : 'shadowAdded';
      rec[key] = [...new Set([...(rec[key] ?? []), ...plan.tests])];
    }
    return out;
  } catch (e) {
    out.error = String(e?.message || e).split('\n')[0];
    return out;
  } finally {
    // Forget red windows long over (two days since they were last seen red), so the ledger stays small. The window
    // that is red right now is never forgotten: its record is what keeps an expired entry from being re-added.
    for (const [k, v] of Object.entries(ledger.reds)) if (k !== activeKey && now -(Number(v?.seenAt ?? v?.at) || 0) > LEDGER_RETENTION_MS) delete ledger.reds[k];
    persist();
  }
}

function flagsOf(argv) {
  const f = {};
  for (const a of argv) { if (!a.startsWith('--')) continue; const i = a.indexOf('='); if (i < 0) f[a.slice(2)] = true; else f[a.slice(2, i)] = a.slice(i + 1); }
  return f;
}

/**
 * The files the `skip` command prints for a read of the list. Mode-gated exactly like CI's step
 * (we:scripts/ci/quarantine-skip.mjs): only a list the safety net stamped `quarantine` skips anything; `stop`, no stamp
 * or an unreadable list skip nothing. PURE.
 */
export function skipForList(r, { now, prNumber = null, fixPrs = [], onMain = false }) {
  if (!r?.ok || r.list?.mode !== 'quarantine') return [];
  return testsToSkip({ list: r.list, now, prNumber, fixPrs, onMain });
}

function cli(argv) {
  const cmd = argv[0];
  const f = flagsOf(argv.slice(1));
  const now = Date.now();
  if (cmd === 'skip') {
    const r = readQuarantine();
    const fixPrs = String(f['fix-prs'] ?? '').split(',').filter(Boolean).map(Number);
    const tests = skipForList(r, { now, prNumber: f.pr ?? null, fixPrs, onMain: !!f['on-main'] });
    if (f.format === 'vitest') {
      const { args, unsupported } = vitestExcludeArgs(tests);
      if (unsupported.length) process.stderr.write(`red-main-quarantine: ${unsupported.length} name-qualified entr${unsupported.length === 1 ? 'y' : 'ies'} not skipped (vitest --exclude is per file; CI runs them): ${unsupported.slice(0, 3).join(' | ')}\n`);
      writeAllSync(1, args.join(' ') + '\n');
    }
    else writeAllSync(1, JSON.stringify({ ok: r.ok, ...(r.ok ? {} : { error: r.error }), skip: tests }) + '\n');
    return;
  }
  if (cmd === 'show') { writeAllSync(1, JSON.stringify(readQuarantine(), null, 2) + '\n'); return; }
  if (cmd === 'add') {
    const tests = String(f.tests ?? '').split(',').filter(Boolean);
    const ttlMs = f['ttl-min'] ? Number(f['ttl-min']) * 60_000 : undefined;
    const out = writeQuarantineChange({
      actor: f.actor, message: `quarantine: add ${tests.join(', ')} (broken ${String(f['broken-sha']).slice(0, 9)}, by ${f.actor})`,
      change: (cur) => addEntries(cur, { tests, brokenSha: f['broken-sha'], owner: f.owner, reason: f.reason, actor: f.actor, now, ...(ttlMs ? { ttlMs } : {}), area: f.area ?? null }),
    });
    writeAllSync(1, JSON.stringify(out) + '\n');
    return;
  }
  if (cmd === 'prune') {
    const mg = f['main-green'] === 'true' ? true : f['main-green'] === 'false' ? false : null;
    const out = writeQuarantineChange({ actor: f.actor, message: `quarantine: prune (main green: ${mg})`, change: (cur) => pruneOnGreen(cur, { mainGreen: mg, now, actor: f.actor }) });
    writeAllSync(1, JSON.stringify(out) + '\n');
    return;
  }
  process.stderr.write('usage: red-main-quarantine-io.mjs <skip|show|add|prune> [--flags]\n');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { cli(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
