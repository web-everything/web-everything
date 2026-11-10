/**
 * @file scripts/conveyor/pr-stall-sweep.mjs
 * @description THE AUTOMATIC PR STALL SWEEP. Rides the card-335 health PR
 *   job: every `intervalMinutes` it reads every open PR (read-only `pr-sweep` reader), judges round caps / referral holds,
 *   classifies each stalled row (`pr-stall-classify.mjs`). Only actionModes.restart-red-team=on executes, with proven
 *   dead ownership and locked execute-time budgets; every other action stays shadow, including global `on`.
 *   Settings: `prStallSweep` through the policy cascade (standard -> platform ->
 *   `we:scripts/settings/pr-stall-sweep.json` -> env `WE_PR_STALL_SWEEP_<KEY>`); any unusable mode or unreadable layer
 *   means off. Rate limits apply to "would do" too. Any incomplete read plans nothing. Audit log:
 *   `~/workspace/.operations/pr-stall-sweep/YYYY-MM.jsonl` (`WE_PR_STALL_SWEEP_DIR` only for a dir named `pr-stall-sweep`):
 *   `pass`, `would-do`, `would-skip`, `operator`, `intent`, `did`, `error`, and identity-bound `operator-reset`.
 */
import fs, { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { dispatchManualPass } from '../operations/manual-daemon-pass-io.mjs';
import { isUnderTest } from '../lib/under-test.mjs';
import { readRedTeamStatus as defaultReadRedTeamStatus, readRecoveryWitness, redTeamStatusDir } from '../lib/drain-red-team-evidence.mjs';
import { pidNamespace, pidStartTime } from '../lib/pid-alive.mjs';
import { foreignStaleOwnerDead } from '../lib/red-team-foreign-host-stale.mjs';
import { readConfirmedBreaks } from '../lib/red-team-gate.mjs';
import { detectRoundCap, judgeRound } from '../lib/round-judge.mjs';
import { assessPrSweep } from '../operations/pr-sweep-core.mjs';
import { createPrSweepReader, STALLED_AFTER_ENV, tailOf } from '../operations/pr-sweep-io.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { withFileLock } from '../lib/atomic-json-file.mjs';
import { resolveRoundJudgeMode } from './round-judge-shadow.mjs';
import { classifyStall, JUDGED_STATES, CLASSIFY_DEFAULTS, CLASSIFY_VALID } from './pr-stall-classify.mjs';
import { resolveStallSweepSettings, STALL_SWEEP_DIR_ENV } from './pr-stall-settings.mjs';
export { resolveStallSweepSettings, STALL_SWEEP_MODES, STALL_SWEEP_MODE_ENV, STALL_SWEEP_DIR_ENV, STALL_SWEEP_DEFAULTS } from './pr-stall-settings.mjs';
const STALE_RUN_MS = 120 * 60_000;
const msg = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

/** Only ESRCH proves absence; unexpected probe failures leave ownership unknown. */
export function pendingOwnerPidAlive(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { kill(pid, 0); return true; }
  catch (e) { return e?.code === 'ESRCH' ? false : e?.code === 'EPERM' ? true : null; }
}

/** Where `pr-sweep-io#resolveStalledAfter` took the threshold from (env > settings > standard), for the pass log. */
function stalledAfterSource(env) {
  const ok = (v) => v !== undefined && v !== null && v !== '' && Number(v) > 0;
  if (ok(env[STALLED_AFTER_ENV])) return 'env';
  try { if (ok(readSettings({})?.prSweep?.stalledAfterMinutes)) return 'settings'; } catch { return 'unknown'; }
  return 'standard';
}
/** The audit dir. The env override only counts for a directory named `pr-stall-sweep`. */
export function stallSweepDir(env = process.env) {
  const o = env?.[STALL_SWEEP_DIR_ENV]?.trim();
  if (o && basename(resolve(o)) === 'pr-stall-sweep') return resolve(o);
  return join(homedir(), 'workspace', '.operations', 'pr-stall-sweep');
}
const monthOf = (now) => new Date(now).toISOString().slice(0, 7);
const prHeadValid = (v) => typeof v === 'string' && /^[\w.-]+\/[\w.-]+#[1-9]\d*@[0-9a-f]{40}$/.test(v) && !v.includes('\n');
/** The operator rulings that authorize a restart-counter reset; any other ruling is not an authority. */
export const RESET_RULINGS = Object.freeze(['R804']);
const resetValid = (r) => prHeadValid(r.prHead) && r.prHead === `${r.repo}#${r.pr}@${r.head}`
  && Number.isSafeInteger(r.pr) && r.pr > 0
  && ['actor', 'reason', 'ruling'].every(k => typeof r[k] === 'string' && r[k].trim())
  && RESET_RULINGS.includes(r.ruling);
/** A reset clears restart count/spacing/idempotency only, never the hourly spend of other actions. */
function afterRestartResets(history) {
  const resets = new Map();
  for (const r of history) if (r.phase === 'operator-reset' && resetValid(r)) {
    resets.set(r.prHead, Math.max(resets.get(r.prHead) ?? -Infinity, Date.parse(r.ts)));
  }
  return history.filter(r => r.action !== 'restart-red-team' || Date.parse(r.ts) >= (resets.get(r.prHead) ?? -Infinity));
}
/** Intent spends the budget; its did receipt must not spend it again. Orphan did records still block repeats. */
function spending(history) {
  const intents = new Set(history.filter(r => r.phase === 'intent').map(r => `${r.prHead}|${r.key}|${r.action}`));
  return history.filter(r => ['would-do', 'intent'].includes(r.phase)
    || (r.phase === 'did' && !intents.has(`${r.prHead}|${r.key}|${r.action}`)));
}

/** An action record must carry everything the rate limits count by; a partial one makes the history incomplete. */
const wellFormed = (r) => !!r && typeof r === 'object' && !Array.isArray(r) && typeof r.phase === 'string' && Number.isFinite(Date.parse(r.ts))
  && (r.phase !== 'operator-reset' || resetValid(r))
  && (!['would-do', 'intent', 'did'].includes(r.phase) || (prHeadValid(r.prHead)
    && typeof r.key === 'string' && r.key.startsWith(`${r.prHead}:`) && typeof r.action === 'string' && r.action !== ''));
/** EVERY audit record (all months: the per-head cap and once-per-head asks are lifetime rules). `complete:false` when a
 *  file or line cannot be read: the caller then plans nothing. @returns {{records:object[], complete:boolean}} */
export function readAuditHistory(dir) {
  const records = []; let complete = true; let names = [];
  try { names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort(); } catch (e) { if (e?.code !== 'ENOENT') complete = false; }
  for (const n of names) {
    let text = '';
    try { text = readFileSync(join(dir, n), 'utf8'); } catch { complete = false; continue; }
    for (const l of text.split('\n').filter((x) => x.trim())) { try { const r = JSON.parse(l); if (wellFormed(r)) records.push(r); else complete = false; } catch { complete = false; } }
  }
  return { records, complete };
}
export function appendAudit(dir, now, records) {
  if (!records.length) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${monthOf(now)}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** Which automatic items to act on this pass, under the rate limits and the audit history. PURE. An item already done
 *  for this PR head (same state + action, or the same `onceKey`) is dropped silently. @returns {{act, held}} */
export function planStallActions(items, { history = [], now, limits }) {
  const done = spending(afterRestartResets(history));
  let hour = spending(history).filter((h) => Date.parse(h.ts) >= now - 3_600_000).length;
  const perHead = new Map();
  const livePerHead = new Map();
  const perAction = new Map();
  const bucket = it => `${it.prHead}|${it.action}`;
  for (const h of done) perAction.set(bucket(h), (perAction.get(bucket(h)) ?? 0) + 1);
  // Shadow restarts retain R452's separate allowance. Live restarts also obey the shared
  // ceiling, including historical shadow restarts and intent/did spend since the latest reset.
  for (const h of done) livePerHead.set(h.prHead, (livePerHead.get(h.prHead) ?? 0) + 1);
  for (const h of done) if (h.action !== 'restart-red-team') perHead.set(h.prHead, (perHead.get(h.prHead) ?? 0) + 1);
  const seen = new Set(done.map((h) => `${h.key}|${h.action}`));
  const once = new Set(done.map((h) => h.onceKey).filter(Boolean));
  const act = []; const held = [];
  for (const it of items) {
    if (it.lane === 'operator') continue;
    if (seen.has(`${it.key}|${it.action}`) || (it.onceKey && once.has(it.onceKey))) continue;
    const restart = it.action === 'restart-red-team';
    const restartCap = limits.maxRedTeamRestartsPerHead;
    const restartFull = restart
      && (!CLASSIFY_VALID.maxRedTeamRestartsPerHead(restartCap) || (perAction.get(bucket(it)) ?? 0) >= restartCap);
    const liveRestart = restart && limits.actionModes?.['restart-red-team'] === 'on';
    const headFull = (!restart || liveRestart)
      && ((liveRestart ? livePerHead : perHead).get(it.prHead) ?? 0) >= limits.maxActionsPerPrHead;
    const why = act.length >= limits.maxActionsPerSweep ? 'per-sweep cap' : hour >= limits.maxActionsPerHour ? 'per-hour cap'
      : restartFull ? 'red-team restart per-head cap; operator must inspect the pending head'
        : headFull ? 'per-PR-head cap' : null;
    if (why) { held.push({ ...it, held: why }); continue; }
    act.push(it); seen.add(`${it.key}|${it.action}`); if (it.onceKey) once.add(it.onceKey);
    perAction.set(bucket(it), (perAction.get(bucket(it)) ?? 0) + 1); hour += 1;
    livePerHead.set(it.prHead, (livePerHead.get(it.prHead) ?? 0) + 1);
    if (!restart) perHead.set(it.prHead, (perHead.get(it.prHead) ?? 0) + 1);
  }
  return { act, held };
}

/** The classifier's leaves of the resolved block (a group with no leaves, like an empty `stateLanes`, is left out). */
export const classifierSettings = (cfg) => Object.fromEntries(Object.keys(CLASSIFY_DEFAULTS).filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]]));
/**
 * The `gh` seam the sweep hands the shared reader: it checks each RAW response before the reader normalises it (the
 * reader turns a malformed event into nothing and a missing body into ''), and throws on a malformed one, so the reader
 * records the PR as unreadable and the pass plans nothing.
 */
export const strictGh = (gh) => (bin, args, opts) => {
  const out = gh(bin, args, opts);
  const path = String(args.at(-1) ?? ''); const json = () => JSON.parse(String(out));
  const time = (v) => Number.isFinite(Date.parse(v));
  const ok = args[0] === 'api' && /\/events\?/.test(path) ? json().flat().every((e) => typeof e?.event === 'string' && time(e.created_at) && (e.event !== 'labeled' || typeof e.label?.name === 'string'))
    : args[0] === 'api' && /\/comments\?/.test(path) ? json().flat().every((c) => typeof c?.user?.login === 'string' && typeof c.body === 'string' && time(c.created_at))
      : args[0] === 'pr' && args[1] === 'view' && args.includes('commits') ? Array.isArray(json()?.commits) && json().commits.every((c) => typeof c?.oid === 'string' && time(c.committedDate))
        : true;
  if (!ok) throw new Error(`malformed gh response: ${args.slice(0, 3).join(' ')}`);
  return out;
};
/** The drain-log seam: the reader drops a malformed skip row silently, so every row of the newest one is checked first. */
export const strictDrainText = (readText = tailOf) => (path) => {
  const text = readText(path);
  const line = String(text).split('\n').filter((l) => l.includes('merge-ai-prs · skip-reasons:')).pop();
  const rows = line ? JSON.parse(line.slice(line.indexOf('skip-reasons:') + 13)) : [];
  if (!Array.isArray(rows) || !rows.every((r) => Number.isSafeInteger(r?.num) && r.num > 0 && typeof r.kind === 'string')) throw new Error('malformed drain skip row');
  return text;
};
const ghFiles = (gh) => (repo, n) => {
  const view = JSON.parse(gh('gh', ['pr', 'view', String(n), '-R', repo, '--json', 'files,changedFiles'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }));
  // Every entry must name a path: a partial list is unreadable evidence, and the whole pass then plans nothing.
  // `gh` returns at most 100 files: a list shorter than `changedFiles` is truncated evidence, never "all the files".
  if (!Array.isArray(view?.files) || view.files.length !== view.changedFiles || !view.files.every((f) => typeof f?.path === 'string' && f.path)) throw new Error('unreadable or truncated file list');
  return view.files.map((f) => f.path);
};

/**
 * One pass. Only the restart opt-in can mutate, via the shared manual-pass dispatcher.
 * `gh` remains a read-only seam; `dispatchRestart` is the sole execution seam.
 */
export async function runStallSweep({ now = Date.now(), env = process.env, state = {}, settings, gh = (_f, a, o) => runGhSync(a, o),
  read, readFiles,
  readPrHead = ({ repo, pr }) => JSON.parse(gh('gh', ['pr', 'view', String(pr), '-R', repo, '--json', 'headRefOid'],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 })).headRefOid,
  readRedTeamStatus = defaultReadRedTeamStatus,
  readStatusAt = ({ repo, pr, head, env }) => statSync(join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`)).mtimeMs,
  probe, judge = judgeRound, dir, log = console.error, force = false, dispatchRestart = dispatchManualPass,
  // Loaded lazily so importers of the sweep keep a light module closure.
  abandonStaleRun = async key => (await import('../lib/review-red-team-on-skip.mjs')).abandonStaleRedTeamRun(key),
  // The same read-only re-plan the job's queued admission makes after abandonment (same witness, probe and deadline).
  planRestartRecovery = async key => {
    const { planRedTeamRecovery, recoveryProbe, staleRunDeadlineMs } = await import('../lib/review-red-team-on-skip.mjs');
    return planRedTeamRecovery(readRecoveryWitness(key), { now: Date.now(), probe: recoveryProbe(), deadlineMs: staleRunDeadlineMs(key.env), env: key.env });
  } } = {}) {
  const s = settings ?? resolveStallSweepSettings({ env, log });
  const cfg = s.value;
  // Disabled/not-due passes still carry the metadata needed to release a disabled digest's feed suppression.
  // Under test only an explicitly passed dir can reach a writer.
  const outDir = dir ?? (isUnderTest(env) ? null : stallSweepDir(env));
  const base = { mode: cfg.mode, digest: cfg.digest, dir: outDir, settingsUnreadable: !!s.settingsUnreadable,
    sources: s.sources, errors: [...(s.errors ?? [])], state: state ?? {} };
  if (cfg.mode === 'off') return { ...base, skipped: 'off' };
  const last = Number(state?.lastRunAt);
  if (!force && Number.isFinite(last) && last <= now && now - last < cfg.intervalMinutes * 60_000) return { ...base, skipped: 'not-due' };
  if (!outDir) return { ...base, skipped: 'under-test' };

  const items = [];
  const failed = (e, context = 'audit log') => {
    // Preflight failures must not write outside the lock or retry an unwritable audit.
    base.errors.push(`${context}: ${msg(e)}`);
    return { ...base, state: { lastRunAt: now }, items, act: [], held: [], incomplete: true, records: [] };
  };
  let raw;
  try { raw = await (read ?? createPrSweepReader({ run: strictGh(gh), readText: strictDrainText() }))({}); }
  catch (e) { return failed(e, 'sweep'); }
  const report = assessPrSweep(raw);
  const prs = new Map(raw.prs.map((p) => [`${p.repo}#${p.number}`, p]));
  const files = readFiles ?? ghFiles(gh);
  const breaks = readConfirmedBreaks({ env }); // {value, source}: the red-team break-class mapping the judge uses
  const judgeCfg = resolveRoundJudgeMode({ env, log: () => {} }); // `rounds.judge.maxGrants`, the judge's own ceiling
  // Every fetched PR, stalled or not, must carry the evidence the assessment reads: one that does not = incomplete read.
  const readable = (p) => !!p && typeof p.repo === 'string' && Number.isSafeInteger(p.number) && p.number > 0 && typeof p.headRefOid === 'string'
    && /^[0-9a-f]{40}$/i.test(p.headRefOid) && Number.isFinite(Date.parse(p.updatedAt)) && Number.isFinite(Date.parse(p.createdAt)) && Number.isFinite(Date.parse(p.headCommittedAt)) && typeof p.body === 'string' && typeof p.isDraft === 'boolean'
    // A check needs a name and a status or conclusion (CheckRun) / state (StatusContext), as pr-sweep-core reads them.
    && Array.isArray(p.statusCheckRollup) && p.statusCheckRollup.every((c) => typeof (c?.name ?? c?.context) === 'string' && [c?.status, c?.conclusion, c?.state].some((x) => typeof x === 'string' && x) && (String(c?.status).toUpperCase() !== 'COMPLETED' || typeof c.conclusion === 'string'))
    && Array.isArray(p.labels) && p.labels.every((l) => typeof (typeof l === 'string' ? l : l?.name) === 'string')
    && Array.isArray(p.labelEvents) && p.labelEvents.every((e) => typeof e?.label === 'string' && Number.isFinite(Date.parse(e.at)))
    // Each comment as the reader normalises it (a missing GitHub body becomes '' there, in pr-sweep-io).
    && Array.isArray(p.comments) && p.comments.every((c) => typeof c?.author?.login === 'string' && typeof c.body === 'string' && Number.isFinite(Date.parse(c.createdAt)));
  let readFailed = !Array.isArray(raw.prs) || !raw.prs.every(readable);
  const pending = [];
  async function pendingEvidence(row, head) {
    let status; let ownerAlive = null;
    try {
      status = await readRedTeamStatus({ repo: row.repo, pr: row.number, head, env });
      if (status !== null) {
        const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
        if (!object(status) || status.unreadable
          || !['queued', 'running', 'finished', 'failed', 'skipped'].includes(status.status)
          || !(status.result == null || typeof status.result === 'string' || object(status.result))) {
          throw new Error('unreadable red-team status content');
        }
        if (status.repo !== row.repo || Number(status.pr) !== row.number || status.head !== head) throw new Error('red-team status identity mismatch');
        if (['queued', 'running'].includes(status.status)) {
          // Missing timing uses the pending-age deadline; malformed owner fields cannot be evidence.
          const text = value => typeof value === 'string' && value.trim().length > 0;
          if (['host', 'pidNamespace', 'pidStart', 'startedAt', 'createdAt'].some(field => status[field] != null && !text(status[field]))
            || (status.pid != null && (!Number.isSafeInteger(status.pid) || status.pid <= 0))
            || !['host', 'pidNamespace', 'pidStart', 'startedAt', 'createdAt'].some(field => text(status[field]))) {
            throw new Error('unreadable active red-team status shape');
          }
        }
      }
    } catch (e) { status = { unreadable: true }; readFailed = true; base.errors.push(`red-team ${row.repo}#${row.number}: ${msg(e)}`); }
    try {
      if (['queued', 'running'].includes(status?.status)) {
        const local = probe ?? { host: hostname(), namespace: pidNamespace(), isAlive: pendingOwnerPidAlive, readPidStart: pidStartTime };
        if (status.host === local.host && status.pidNamespace === local.namespace && Number.isSafeInteger(status.pid) && status.pid > 0) {
          const alive = await local.isAlive(status.pid);
          if (alive === false) ownerAlive = false;
          else if (alive === true) {
            const start = status.pidStart ? await local.readPidStart(status.pid) : null;
            // A missing birth time cannot prove PID reuse; retain the live-owner hold.
            ownerAlive = !start || !status.pidStart || start === status.pidStart;
          }
        } else if (Number.isSafeInteger(status.pid) && status.pid > 0) {
          const statusAt = await readStatusAt({ repo: row.repo, pr: row.number, head, env });
          // Only a probe that answers exactly false counts as dead (null = unknown holds), and the record must
          // have been silent past the sweep's own stale-run window, not only the 30 minute foreign-host floor.
          const sameTable = status.pidNamespace == null || status.pidNamespace === local.namespace;
          const alive = sameTable && Number.isFinite(statusAt) && now - statusAt > STALE_RUN_MS ? await local.isAlive(status.pid) : null;
          if (alive !== null && alive !== undefined
            && foreignStaleOwnerDead(status, { host: local.host, namespace: local.namespace, statusAt, now, env,
              isAlive: () => alive, readPidStart: local.readPidStart })) ownerAlive = false;
        }
      }
    // Probe failure leaves ownership unknown; preserve classification and shadow records.
    } catch (e) { ownerAlive = null; base.errors.push(`red-team owner ${row.repo}#${row.number}: ${msg(e)}`); }
    return { status, ownerAlive };
  }
  // A live job proves ownership, so its pending row is not stalled; restarting it risks a duplicate run.
  for (const row of report.prs.filter((r) => r.stalled)) {
    const pr = prs.get(`${row.repo}#${row.number}`);
    const head = String(pr?.headRefOid ?? '');
    const trigger = JUDGED_STATES[row.waitingOn];
    let verdict = null; let list = [];
    if (trigger) {
      try {
        list = await files(row.repo, row.number);
        if (!Array.isArray(list) || !list.length || !list.every((x) => typeof x === 'string' && x)) throw new Error('unreadable or empty file list');
        const cap = detectRoundCap({ comments: pr.comments, pr: row.number, head, state: row.waitingOn === 'at-round-limit' ? 'at-round-limit' : null, repo: row.repo });
        verdict = cap?.trigger === trigger ? judge({ pr: row.number, repo: row.repo, head, trigger, comments: pr.comments, files: list, setting: breaks.value, maxGrants: judgeCfg.maxGrants }) : null;
      } catch (e) { base.errors.push(`judge ${row.repo}#${row.number}: ${msg(e)}`); verdict = null; readFailed = true; }
    }
    const context = { row, head, verdict, files: list, card: null, settings: classifierSettings(cfg) };
    const metadata = { repo: row.repo, pr: row.number, head, prHead: `${row.repo}#${row.number}@${head.toLowerCase()}`, state: row.waitingOn, title: String(row.title ?? '').slice(0, 120), verdict: verdict?.verdict ?? null };
    if (['red-team-pending', 'drain-skip:red-team-pending'].includes(row.waitingOn)) {
      const { status, ownerAlive } = await pendingEvidence(row, head);
      pending.push({ context, metadata, status, ownerAlive, statusSnapshot: JSON.stringify(status) });
      continue;
    }
    const c = classifyStall(context);
    // An unreadable row or unreadable evidence anywhere makes the whole pass incomplete (it still reaches the operator).
    if (c?.reason?.startsWith('fail-closed: classifier error') || c?.action === 'unreadable-evidence' || verdict?.evidence?.failClosed) readFailed = true;
    if (c) items.push({ ...c, ...metadata });
  }

  // Read the budget, plan and durably record under ONE lock on the audit dir, so two overlapping passes can never both
  // spend the same remaining budget. A lock or write failure plans nothing.
  // withFileLock is synchronous, so the lock is held by hand across the awaited dispatcher. A pass killed while
  // holding it leaves the file behind: first let withFileLock's shared stale takeover reclaim an aged lock whose
  // holder is dead. It never waits and never steals a live or fresh holder's lock; the wx open below then refuses.
  const lock = join(outDir, '.lock');
  const reclaimStaleLock = path => { try { withFileLock(path, () => {}, { timeoutMs: 0 }); } catch { /* held: refused below */ } };
  let locked = false;
  try {
    mkdirSync(outDir, { recursive: true });
    reclaimStaleLock(lock);
    const fd = fs.openSync(lock, 'wx'); locked = true;
    try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
    return await commit();
  } catch (e) { return failed(e); }
  finally { if (locked) { try { unlinkSync(lock); } catch (e) { failed(e); } } }
  async function commit() {
  // Fail closed: an unreadable PR, file list or audit history means NO action this pass.
  const { records: history, complete: historyOk } = readAuditHistory(outDir);
  for (const { context, metadata, status, ownerAlive } of pending) {
    const restarts = spending(afterRestartResets(history)).filter(h => h.prHead === metadata.prHead && h.action === 'restart-red-team');
    const latest = restarts.length ? restarts.reduce((latest, h) => Math.max(latest, Date.parse(h.ts)), -Infinity) : null;
    const c = classifyStall({ ...context, redTeam: { now, ageMinutes: context.row.ageMinutes, status, ownerAlive,
      restarts: restarts.length, minutesSinceLastRestart: latest === null ? null : (now - latest) / 60_000 } });
    if (c?.reason?.startsWith('fail-closed: classifier error')) readFailed = true;
    if (c) items.push({ ...c, ...metadata });
  }
  let incomplete = raw.unreadable.length > 0 || readFailed || !historyOk;
  const plan = incomplete ? { act: [], held: [] } : planStallActions(items, { history, now, limits: cfg });
  // Exhaustion is classified as an operator item; retain the refused live action in the execution audit too.
  if (!incomplete && cfg.actionModes?.['restart-red-team'] === 'on') {
    for (const i of items.filter(i => i.action === 'red-team-restart-exhausted')) {
      plan.held.push({ ...i, action: 'restart-red-team', held: 'red-team restart per-head cap exhausted; operator must inspect' });
    }
  }
  for (const held of plan.held.filter(i => i.action === 'restart-red-team' && i.held === 'per-PR-head cap')) {
    const entry = pending.find(p => p.metadata.prHead === held.prHead);
    const restarts = [...spending(afterRestartResets(history)), ...plan.act]
      .filter(h => h.prHead === held.prHead && h.action === 'restart-red-team').length;
    items.push({ ...held, lane: 'operator', action: 'red-team-restart-exhausted',
      key: `${held.prHead}:red-team-restart-exhausted`, held: undefined,
      command: entry?.context.row.next?.command ?? null,
      reason: `red-team restart held by the per-head ceiling (per-PR-head cap); ${restarts} restarts so far; pending age ${entry?.context.row.ageMinutes} minutes; operator must inspect the pending head (needs-you)` });
  }
  const ts = new Date(now).toISOString();
  const logged = new Set(history.map((h) => `${h.phase}|${h.key}|${h.action}|${h.held ?? ''}`));
  const fresh = (r) => !logged.has(`${r.phase}|${r.key}|${r.action}|${r.held ?? ''}`);
  const live = i => i.action === 'restart-red-team' && cfg.actionModes?.['restart-red-team'] === 'on';
  const note = cfg.mode === 'on' ? { modeNote: 'global on is not implemented; only the restart action opt-in executes' } : {};
  const records = [
    { ts, phase: 'pass', mode: cfg.mode, stalled: items.length, incomplete, historyOk, readFailed, settings: { value: cfg, sources: s.sources },
      // Policies owned by other features' readers, logged with value and source on every pass.
      inputs: { stalledAfterMinutes: { value: report.stalledAfterMinutes, source: raw.stalledAfterSource ?? stalledAfterSource(env) }, confirmedBreaks: breaks, judgeMaxGrants: { value: judgeCfg.maxGrants, line: judgeCfg.line } }, unreadable: raw.unreadable.slice(0, 5), errors: base.errors.slice(0, 5),
      lanes: Object.fromEntries(['system', 'policy', 'operator'].map((l) => [l, items.filter((i) => i.lane === l).length])) },
    ...plan.act.filter(i => !live(i)).map((i) => ({ ts, phase: 'would-do', mode: cfg.mode, ...note, ...i })),
    ...plan.held.map((i) => ({ ts, phase: 'would-skip', mode: cfg.mode, ...i })).filter(fresh),
    ...(incomplete ? [] : items.filter((i) => i.lane === 'operator').map((i) => ({ ts, phase: 'operator', mode: cfg.mode, ...i })).filter(fresh)),
  ];
  // An action that is not durably recorded would escape the rate limits next pass: an unwritten log plans nothing.
  try { appendAudit(outDir, now, records); } catch (e) { return failed(e); }
  const record = r => { appendAudit(outDir, now, [r]); records.push(r); };
  if (!incomplete && !base.errors.length) for (const i of plan.act.filter(live)) {
    try {
      // Re-read immediately before intent, still under the lock, including this pass's preceding spend.
      const current = readAuditHistory(outDir);
      if (!current.complete) throw new Error('execute-time audit history incomplete; operator must inspect');
      if (spending(current.records).filter(r => Date.parse(r.ts) === now).length >= cfg.maxActionsPerSweep) {
        record({ ...i, ts, phase: 'would-skip', held: 'per-sweep cap' });
        continue;
      }
      const check = planStallActions([i], { history: current.records, now, limits: cfg });
      if (!check.act.length) {
        record({ ...i, ts, phase: 'would-skip', held: check.held[0]?.held ?? 'already has durable intent/did' });
        continue;
      }
      const assessed = pending.find(p => p.metadata.prHead === i.prHead);
      const entry = assessed ? await pendingEvidence(assessed.context.row, i.head) : null;
      if (readFailed || base.errors.length) {
        incomplete = true;
        record({ ...i, ts, phase: 'would-skip', held: 'red-team status changed or liveness unreadable; operator must inspect' });
        record({ ...records[0], incomplete: true, readFailed: true, errors: base.errors.slice(0, 5) });
        break;
      }
      if (JSON.stringify(entry?.status) !== assessed?.statusSnapshot) {
        record({ ...i, ts, phase: 'would-skip', held: 'red-team status changed; operator must inspect' });
        continue;
      }
      if (entry?.ownerAlive !== false) {
        record({ ...i, ts, phase: 'would-skip', held: 'owner death not proven (R803); operator must inspect' });
        continue;
      }
      let head;
      try { head = await readPrHead({ repo: i.repo, pr: i.pr }); } catch (e) { head = null; base.errors.push(`head ${i.repo}#${i.pr}: ${msg(e)}`); }
      if (typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) {
        // An unreadable head is execute-time evidence failure: stop the whole pass, like status and liveness.
        incomplete = true;
        if (!base.errors.length) base.errors.push(`head ${i.repo}#${i.pr}: unreadable`);
        record({ ...i, ts, phase: 'would-skip', held: 'PR head unreadable; operator must inspect' });
        record({ ...records[0], incomplete: true, readFailed: true, errors: base.errors.slice(0, 5) });
        break; // An unreadable head stops the pass.
      }
      if (head !== i.head) {
        record({ ...i, ts, phase: 'would-skip', held: 'PR head changed or unreadable; operator must inspect' });
        continue;
      }
      i.expectedHead = i.head;
      record({ ...i, ts, phase: 'intent', mode: cfg.mode });
      // The job's queued admission refuses a dead owner's still-running status unless it was abandoned first, the same
      // abandon-then-dispatch order the shared stale recovery uses. A refusal spends nothing more and stops the pass.
      // A throw (for example a busy status claim) is the same refusal: name it as an abandonment refusal, not a bare cause.
      try {
      const abandoned = await abandonStaleRun({ repo: i.repo, pr: i.pr, head: i.head, env });
      if (abandoned?.ok !== true) throw new Error('stale red-team abandonment refused; operator must inspect');
      } catch (e) {
        throw new Error(/abandonment refused/.test(msg(e)) ? msg(e) : `stale red-team abandonment refused (${msg(e)}); operator must inspect`);
      }
      // Admission then re-plans the abandoned run and refuses any mode but its own (a completed seat resumes), so the
      // restart dispatches the mode that plan names. A plan admission would refuse stops the pass before any spawn.
      let redTeamMode;
      try {
        const recovery = await planRestartRecovery({ repo: i.repo, pr: i.pr, head: i.head, env });
        if (recovery?.abandon !== false || !['fresh', 'resume'].includes(recovery?.mode)) {
          throw new Error(typeof recovery?.why === 'string' && recovery.why ? recovery.why : `mode ${String(recovery?.mode)}`);
        }
        redTeamMode = recovery.mode;
      } catch (e) {
        throw new Error(`stale red-team recovery not admissible after abandonment (${msg(e)}); operator must inspect`);
      }
      const result = await dispatchRestart({ daemon: 'red-team', repo: i.repo, pr: i.pr, reason: i.reason, expectedHead: i.expectedHead, redTeamMode });
      if (result?.error || result?.skipped || result?.ok === false) throw new Error(`restart refused: ${msg(result.error ?? result.skipped ?? 'unsuccessful dispatch')}`);
      if (result?.jobPid === null || result?.launched === false || !(result?.launched === true
        || (Number.isSafeInteger(result?.jobPid) && result.jobPid > 0))) {
        throw new Error('restart launch unproven; operator must inspect before retrying');
      }
      record({ ...i, ts, phase: 'did', mode: cfg.mode });
    } catch (e) {
      incomplete = true;
      base.errors.push(`restart: ${msg(e)}`);
      record({ ...i, ts, phase: 'error', error: msg(e) });
      break; // No retry or subsequent dispatch after any error.
    }
  }
  for (const r of records.filter((x) => x.phase === 'would-do')) log(`pr-stall-sweep (${cfg.mode}) would ${r.action} ${r.prHead} [${r.lane}]: ${r.reason}`);
  return { ...base, state: { lastRunAt: now }, items, act: plan.act, held: plan.held, incomplete, records };
  }
}
