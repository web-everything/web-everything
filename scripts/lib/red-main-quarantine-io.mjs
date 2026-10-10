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
 *       CI job start: fetch the CURRENT list and print the tests to skip. Unreadable list ⇒ prints nothing to
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
import { resolveRedMainMode, RED_MAIN_HOLD_SETTINGS_FILE } from './red-main-hold.mjs';
import { mainRedState } from '../conveyor/main-ci-red-core.mjs';
import {
  QUARANTINE_BRANCH, QUARANTINE_REF, QUARANTINE_LIST_PATH, QUARANTINE_EVENTS_PATH,
  validateQuarantineList, addEntries, pruneOnGreen, testsToSkip, canWriteQuarantine, vitestExcludeArgs,
  setFixPrs, parseVitestFailures, planSafetyNet, QUARANTINE_SAFETY_NET_DEFAULTS,
} from './red-main-quarantine.mjs';

const git = (args, opts) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/**
 * Read the current list. `{ok:true, list}` (an absent branch/file = an empty list is NOT assumed: absent file on a
 * read tip ⇒ empty; unreachable branch ⇒ ok:false).
 */
export function readQuarantine({ board = process.cwd(), run = git } = {}) {
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
export function readListOrAbsent({ board = process.cwd(), run = git } = {}) {
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
 * evidence the red-team review reads while the mode stays `stop`. Job logs are read once per red window (cached in
 * the ledger by first red commit). Never throws.
 * @returns {{mode:string, modeSource:string, shadow:boolean, plan:object, applied:boolean, error?:string}|null}
 */
export function runSafetyNet({
  mainCiRuns, now = Date.now(), dir, board = process.cwd(), live = true, repoSlug = 'web-everything/web-everything',
  mode = resolveRedMainMode(), settings = resolveQuarantineSettings(),
  exec = execFileSyncThrottled, readJobs = (runId) => readFailedJobs(runId, { exec, repoSlug }),
  readLog = (jobId) => readJobFailures(jobId, { exec, repoSlug }),
  readList = () => readListOrAbsent({ board }), write = (o) => writeQuarantineChange({ board, ...o }), log = (l) => console.error(l),
} = {}) {
  if (!dir) return null;
  const ledgerPath = join(dir, SAFETY_NET_LEDGER);
  const shadowPath = join(dir, SAFETY_NET_SHADOW_LOG);
  const ledger = readJson(ledgerPath) ?? { version: 1, reds: {}, shadowList: { version: 1, entries: [] } };
  ledger.reds ??= {};
  const isLive = mode.value === 'quarantine' && live === true;
  const state = mainRedState(mainCiRuns?.runs);
  const out = { mode: mode.value, modeSource: mode.source, shadow: !isLive, settingsSources: settings.sources ?? {}, applied: false };
  try {
    const sha = state.status === 'red' ? String(state.firstRed?.sha ?? '') : null;
    const rec = sha ? (ledger.reds[sha] ??= { at: now, added: [] }) : null;
    let jobFailures = {};
    const failedJobs = state.status === 'red' ? (mainCiRuns?.failing?.jobs ?? null) : null;
    if (rec && Array.isArray(failedJobs) && failedJobs.length) {
      // Read each failed unit job's log ONCE per red window (and again only if the failing run changed).
      const runId = mainCiRuns?.failing?.runId ?? null;
      if (!rec.jobFailures || rec.runId !== runId) {
        const unitRe = new RegExp(settings.value.unitJobPattern);
        let jobs = null;
        try { jobs = runId == null ? null : readJobs(runId); } catch { jobs = null; }
        const byName = new Map((jobs?.failed ?? []).map((j) => [j.name, j.id]));
        const got = {};
        for (const name of failedJobs.filter((n) => unitRe.test(n))) {
          const id = byName.get(name);
          try { got[name] = id == null ? null : readLog(id); } catch { got[name] = null; }
        }
        rec.runId = runId;
        rec.jobFailures = got;
      }
      jobFailures = rec.jobFailures;
    }
    let read = { ok: true, list: ledger.shadowList ?? { version: 1, entries: [] } };
    if (isLive) read = readList();
    if (!read.ok) { out.plan = { action: 'none', why: `quarantine list unreadable (${read.error})` }; return out; }
    const pri = mainCiRuns?.priority;
    const fixPrs = pri ? (Array.isArray(pri.prs) ? pri.prs : [pri.pr]) : null;
    const plan = planSafetyNet({
      status: state.status, firstRedSha: sha, failedJobs, jobFailures, list: read.list, fixPrs,
      addedForRed: rec?.added ?? [], now, settings: settings.value,
    });
    out.plan = plan;
    const steps = [];
    const ttlMs = settings.value.ttlMin * 60_000;
    if (plan.action === 'add') {
      steps.push((cur) => addEntries(cur, { tests: plan.tests, brokenSha: sha, owner: SAFETY_NET_ACTOR, reason: `main CI red since ${sha.slice(0, 9)}: ${plan.names.slice(0, 3).join(' | ')}`.slice(0, 400), actor: SAFETY_NET_ACTOR, now, ttlMs }));
    }
    if (plan.action === 'prune') steps.push((cur) => ({ ok: true, ...pruneOnGreen(cur, { mainGreen: plan.mainGreen, now, actor: SAFETY_NET_ACTOR }) }));
    if (plan.fixPrs) steps.push((cur) => setFixPrs(cur, { fixPrs: plan.fixPrs, actor: SAFETY_NET_ACTOR, now }));
    if (!steps.length) return out;
    const change = composeChanges(steps);
    const what = [plan.action !== 'none' ? `${plan.action}${plan.tests ? ` ${plan.tests.join(', ')}` : ''}` : null, plan.fixPrs ? `fix PRs → [${plan.fixPrs.join(', ')}]` : null].filter(Boolean).join('; ');
    if (isLive) {
      const r = write({ actor: SAFETY_NET_ACTOR, message: `quarantine: ${what} (${plan.why})`, change });
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
    if (plan.action === 'add' && rec) rec.added = [...new Set([...(rec.added ?? []), ...plan.tests])];
    return out;
  } catch (e) {
    out.error = String(e?.message || e).split('\n')[0];
    return out;
  } finally {
    // Forget red windows that are long over (a day past their first sight), so the ledger stays small.
    for (const [k, v] of Object.entries(ledger.reds)) if (now - (Number(v?.at) || 0) > 48 * 60 * 60 * 1000) delete ledger.reds[k];
    try { mkdirSync(dirname(ledgerPath), { recursive: true }); writeJsonAtomic(ledgerPath, ledger); } catch { /* best effort */ }
  }
}

function flagsOf(argv) {
  const f = {};
  for (const a of argv) { if (!a.startsWith('--')) continue; const i = a.indexOf('='); if (i < 0) f[a.slice(2)] = true; else f[a.slice(2, i)] = a.slice(i + 1); }
  return f;
}

function cli(argv) {
  const cmd = argv[0];
  const f = flagsOf(argv.slice(1));
  const now = Date.now();
  if (cmd === 'skip') {
    const r = readQuarantine();
    const fixPrs = String(f['fix-prs'] ?? '').split(',').filter(Boolean).map(Number);
    const tests = r.ok ? testsToSkip({ list: r.list, now, prNumber: f.pr ?? null, fixPrs, onMain: !!f['on-main'] }) : [];
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
