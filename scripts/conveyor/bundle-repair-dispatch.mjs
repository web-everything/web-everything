#!/usr/bin/env node
/**
 * @file scripts/conveyor/bundle-repair-dispatch.mjs
 * @description PROTOTYPE (operator OK 2026-10-21 ~17:15 ET) — the IO SHELL of the supervised "bundle repair" job.
 *   The decisions are pure and live in we:scripts/conveyor/bundle-repair-core.mjs; this file reads the clone hold
 *   state, the ledger, the kill switch and the settings, then launches / stops / records / alerts.
 *
 * CALLED ONCE PER HEALTH TICK ({@link runBundleRepairs}, from `health-watch.mjs#tick`), with the tick's own
 * `selfSync` probe (every daemon clone's `rebuild.json#held`). Health-watch already supervises jobs and owns the
 * `daemon-held-on-last-good` sign, so the repair lives next to the sign that sees the hold.
 *
 * LAUNCHED AS A KIND ON THE DECLARED `dispatch-lane` OPERATION (kind `bundle-repair`), the same composition the
 * health investigation and the main-red owner use: the brief is filled by `dispatch-lane.mjs#fillBrief` against
 * `BRIEF_REQUIRED_BY_KIND['bundle-repair']`, named by `sessionSlugFor`, and started by the operation's one sink
 * (`dispatch-lane-io.mjs#createDispatchSinks`) with the WORKER App role on every identity channel (`spawnEnv`) —
 * never the operator credential. The finished-session path is the reaper's own `claude stop`
 * (`session-reaper.mjs#stopSessionWithRetry`).
 *
 * SETTINGS: the `bundleRepair` policy through the cascade (standard → platform → tool
 * `we:scripts/settings/bundle-repair.json` → env `WE_BUNDLE_REPAIR_ENABLED` / `WE_BUNDLE_REPAIR_MODE`), each
 * leaf's source logged (`policy-cascade · bundleRepair: …`). Default `enabled: false`, `mode: shadow`.
 * KILL SWITCH: the file `~/.claude/conveyor/bundle-repair.kill` (env `WE_BUNDLE_REPAIR_KILL_FILE`) — present means
 * nothing new is launched or posted; running repairs are still reconciled and stopped at their wall time.
 *
 * SHADOW MODE writes the exact filled brief it WOULD launch to `<healthDir>/bundle-repair/shadow/<holdId>.md` and
 * posts it to the needs-you feed (kind `bundle-repair-shadow`) — once per hold — and launches nothing.
 *
 * ESCALATION: every bad ending (two WEAKENED audits, an unresolvable conflict, a regression, a conflict override
 * seen on the overlay audit trail, the wall time, a "repaired" that did not clear the hold) posts ONE needs-you
 * item (kind `bundle-repair`) and is never retried for the same hold.
 *
 * Files (under `health-watch-section.mjs#healthDir`):
 *   bundle-repair/ledger.json            every repair and its status (written only by the tick, under a lock)
 *   bundle-repair/outcomes/<holdId>.json the session's one outcome (written only by `record`, once)
 *   bundle-repair/shadow/<holdId>.md     the brief a shadow tick would have launched
 *
 * Usage:
 *   node scripts/conveyor/bundle-repair-dispatch.mjs plan                                 (read-only: what a tick would do now)
 *   node scripts/conveyor/bundle-repair-dispatch.mjs show   --hold=<id>
 *   node scripts/conveyor/bundle-repair-dispatch.mjs record --hold=<id> --session=<slug> < outcome.json   (the session's one write)
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE_REPAIR_BOT, BUNDLE_REPAIR_KIND, BUNDLE_REPAIR_STANDARD, BUNDLE_REPAIR_VALID, assertBriefSafe, escalationItem,
  isOverlayHold, planBundleRepairs, planReconcile, pruneLedger, validateOutcome, holdIdFor,
} from './bundle-repair-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WE_ROOT = resolve(HERE, '..', '..');

export const KILL_FILE_ENV = 'WE_BUNDLE_REPAIR_KILL_FILE';
export const TOKEN_ENV = 'WE_BUNDLE_REPAIR_TOKEN';
export const killFilePath = (env = process.env) => env[KILL_FILE_ENV] || join(homedir(), '.claude', 'conveyor', 'bundle-repair.kill');
export const briefPath = (root = WE_ROOT) => join(root, 'skills-src', 'conveyor', 'bundle-repair-brief.md');

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const repairDir = (dir) => join(dir, 'bundle-repair');
export const ledgerPath = (dir) => join(repairDir(dir), 'ledger.json');
const HOLD_ID_RE = /^[A-Za-z0-9_.-]{1,160}$/;
export function outcomePath(dir, holdId) {
  if (!HOLD_ID_RE.test(String(holdId ?? ''))) throw new Error(`bundle-repair: not a hold id: ${JSON.stringify(holdId)}`);
  return join(repairDir(dir), 'outcomes', `${holdId}.json`);
}
const shadowPath = (dir, holdId) => join(repairDir(dir), 'shadow', `${holdId}.md`);
function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
/** The ledger. Missing = empty; unreadable, malformed or not a list THROWS — an unknown ledger never reads as "no
 *  repair ever ran" (that would re-launch a running clone's repair and overwrite its supervision). */
export function readLedger(dir) {
  let text;
  try { text = readFileSync(ledgerPath(dir), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw new Error(`bundle-repair: the ledger is unreadable (${e?.code ?? e?.message}) — refusing to act on an unknown ledger`);
  }
  let v;
  try { v = JSON.parse(text); } catch { throw new Error(`bundle-repair: the ledger ${ledgerPath(dir)} is not JSON — refusing to act on an unknown ledger`); }
  if (!Array.isArray(v) || v.some((x) => !x || typeof x !== 'object' || typeof x.holdId !== 'string')) {
    throw new Error(`bundle-repair: the ledger ${ledgerPath(dir)} is not a list of entries — refusing to act on an unknown ledger`);
  }
  return v;
}

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────

const parseBool = (v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase()) ? true
  : ['0', 'false', 'off', 'no'].includes(String(v).toLowerCase()) ? false : String(v));

/**
 * IO: the `bundleRepair` policy through the cascade, sources logged once per distinct set. Never throws: an
 * unreadable tool file is "layer not set", an invalid leaf is ignored (named in `invalid`).
 * @returns {{settings:object, sources:Record<string,string>, invalid:string[]}}
 */
export async function resolveBundleRepairSettings({ env = process.env, tool, platform, log } = {}) {
  const { cascadePolicy } = await import('../lib/policy-cascade.mjs');
  let toolBlock = tool;
  if (toolBlock === undefined) {
    try { toolBlock = (await import('../lib/settings-files.mjs')).readSettings()?.bundleRepair; } catch { toolBlock = undefined; }
  }
  const envValues = { enabled: parseBool(env.WE_BUNDLE_REPAIR_ENABLED), mode: env.WE_BUNDLE_REPAIR_MODE || undefined };
  const r = cascadePolicy('bundleRepair', toolBlock, {
    standard: { ...BUNDLE_REPAIR_STANDARD, clones: [...BUNDLE_REPAIR_STANDARD.clones] }, envValues, valid: BUNDLE_REPAIR_VALID, env,
    ...(platform !== undefined ? { platform } : {}), ...(log ? { log } : {}),
  });
  return { settings: { ...BUNDLE_REPAIR_STANDARD, ...(r.value || {}) }, sources: r.sources, invalid: r.invalid };
}

// ── host reads ───────────────────────────────────────────────────────────────────────────────────────────────

/** IO: every known daemon clone root, by clone key (the key `selfSync` reports). */
export async function cloneRootsByKey({ root = WE_ROOT, env = process.env } = {}) {
  const { daemonCloneRoots } = await import('../lib/daemon-clone-registry.mjs');
  const { cloneKeyOf } = await import('../lib/daemon-last-good.mjs');
  const map = new Map();
  for (const r of daemonCloneRoots(resolve(root, '..'), { env })) { try { map.set(cloneKeyOf(r), r); } catch { /* skip */ } }
  return map;
}

/** IO (sync): the first registration by the bot since the repair started that carried a conflict override, or null.
 *  `eventsFilePath` is `daemon-overlays.mjs#eventsFilePath` (preloaded by the pass). */
export function readConflictOverride(entry, { env = process.env, readFile = readFileSync, eventsFilePath }) {
  let text = '';
  try { text = String(readFile(eventsFilePath(entry.root, env), 'utf8')); } catch (e) {
    if (e?.code === 'ENOENT') return null; // no overlay was ever registered on this clone
    throw e; // unreadable → UNKNOWN: the caller keeps the audit check pending
  }
  for (const line of text.split('\n').slice(-2000)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.kind === 'added' && ev.by === BUNDLE_REPAIR_BOT && ev.conflictOverride && Date.parse(ev.at) >= entry.startedAt) return ev;
  }
  return null;
}

// ── launch ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The filled brief for one target (throws on a forbidden command or a placeholder hole). `lane` is the preloaded
 *  `dispatch-lane.mjs` module. */
export function fillRepairBriefWith(lane, target, { root = WE_ROOT, readBrief = (r) => readFileSync(briefPath(r), 'utf8') } = {}) {
  const session = lane.sessionSlugFor(target.holdId, BUNDLE_REPAIR_KIND);
  const { prompt, unknownTokens } = lane.fillBrief(readBrief(root), {
    CLONE_ROOT: target.root, CLONE_NAME: target.name, HOLD_ID: target.holdId, HELD_REFS: target.refs.join(',') || 'none',
    SESSION_SLUG: session, BOT: BUNDLE_REPAIR_BOT, WE_ROOT: root,
  }, lane.BRIEF_REQUIRED_BY_KIND[BUNDLE_REPAIR_KIND], []);
  assertBriefSafe(prompt);
  return { prompt, session, unknownTokens };
}
export async function fillRepairBrief(target, o) {
  return fillRepairBriefWith(await import('../operations/dispatch-lane.mjs'), target, o);
}

/** The repair role's route, kept to Claude only (a non-Claude adapter has no `bundle-repair` row). Never throws. */
export async function routeRepair() {
  try {
    const { resolveDispatchRoute } = await import('../lib/dispatch-routing-policy-io.mjs');
    const r = resolveDispatchRoute({ kind: 'fix', cause: 'conflict', scopePaths: [] }, { scorecards: [] });
    if (!r) return null;
    const pr = r.policyRoute;
    const claude = pr?.provider === 'claude' ? { ...pr, fallback: (pr.fallback || []).filter((x) => x.provider === 'claude') } : null;
    return { ...r, policyRoute: claude, probationWorker: null };
  } catch { return null; }
}

/** The session's identity: the WORKER App role on the spawn env — never the operator's credential. */
export const workerSpawnEnv = (env = process.env) => ({ ...env, WE_GITHUB_APP_ROLE: 'worker' });

/** The session's `--settings` env: the sink's base env resolved WITH the sink's own options (which carry the worker
 *  `spawnEnv`, so the gh-shim settings take the worker role, not this process's), plus the state root and token. */
export function repairSettingsEnv(base, { stateRoot, token, stateRootEnv }) {
  return (cwd, opts) => ({ ...(base(cwd, opts) || {}), ...(stateRoot ? { [stateRootEnv]: stateRoot } : {}), [TOKEN_ENV]: token });
}

/** IO: launch one repair session through the dispatch-lane sink, as the worker App role. */
export async function dispatchRepair(target, { prompt, session, token, stateRoot, wallTimeMinutes, root = WE_ROOT, env = process.env, sinkOptions = {} }) {
  const io = await import('../operations/dispatch-lane-io.mjs');
  const { DISPATCH_EFFECT } = await import('../operations/dispatch-lane.mjs');
  const { CONVEYOR_STATE_ROOT_ENV } = await import('../lib/daemon-last-good.mjs');
  const sinks = io.createDispatchSinks({
    root, extraArgs: io.agentArgsFromEnv(env), spawnEnv: workerSpawnEnv(env), ...sinkOptions,
    resolveSettingsEnv: repairSettingsEnv(sinkOptions.resolveSettingsEnv ?? io.resolveDispatchSettingsEnv, { stateRoot, token, stateRootEnv: CONVEYOR_STATE_ROOT_ENV }),
  });
  const out = await sinks[DISPATCH_EFFECT]({
    launchKind: BUNDLE_REPAIR_KIND, prompt, sessionSlug: session, lane: null, scope: [], routing: await routeRepair(),
    expectedWithinMinutes: wallTimeMinutes,
  });
  return { handle: out?.handle ?? null };
}

const FINISHED = new Set(['done', 'failed', 'stopped', 'completed', 'killed']);
/** The real host seams, loaded once per pass (only the ones the caller did not supply) so every step inside the
 *  ledger lock is synchronous. */
async function loadHostDeps({ needStop, needPublish, needEvents }) {
  const [reaper, salvage, feed, overlays, lane] = await Promise.all([
    needStop ? import('./session-reaper.mjs') : null, needStop ? import('../lib/lane-salvage.mjs') : null,
    needPublish ? import('../operations/needs-you-feed.mjs') : null, needEvents ? import('../lib/daemon-overlays.mjs') : null,
    import('../operations/dispatch-lane.mjs'),
  ]);
  const stop = needStop ? (entry) => {
    let handle = entry.handle;
    if (!handle && entry.session) {
      const agents = salvage.readAgentsStrict();
      // An unreadable listing is UNKNOWN: throw so the stop stays pending, never "nothing to stop".
      if (!Array.isArray(agents)) throw new Error('bundle-repair: could not list claude agents to resolve the session by name');
      const row = agents.find((a) => a?.name === entry.session && !FINISHED.has(a.state));
      handle = row?.id ?? row?.sessionId ?? null;
      if (row && !handle) throw new Error('bundle-repair: the session is listed but exposes no id to stop');
    }
    if (handle) reaper.stopSessionWithRetry({ handle });
  } : null;
  return { stop, publish: needPublish ? (item, { now }) => feed.publishAttention(item, { now }) : null, eventsFilePath: overlays?.eventsFilePath, lane };
}

const pidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // unknown → assume alive (fail closed)
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; }
};

/**
 * The ledger lock, around a SYNCHRONOUS critical section only — the awaited launch happens outside it, after its
 * reservation is on disk. Exclusive create; NO time-based takeover. A lock whose holder is a DEAD process on this
 * host is taken over only under a second exclusive `takeover` lock, re-reading the lock's exact bytes first, so two
 * takers can never both win (the second re-reads the first's live lock and backs off). Anything unverifiable —
 * a garbled lock, another host's lock, a takeover lock left by a crash — fails CLOSED with a message naming the file.
 */
export function defaultLock(dir, fn, { isAlive = pidAlive, host = hostname() } = {}) {
  const path = `${ledgerPath(dir)}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, host, at: new Date().toISOString(), nonce: randomBytes(8).toString('hex') });
  const create = (p, text) => { try { writeFileSync(p, text, { flag: 'wx' }); return true; } catch (e) { if (e?.code === 'EEXIST') return false; throw e; } };
  if (!create(path, mine)) {
    let raw = null; let holder = null;
    try { raw = readFileSync(path, 'utf8'); holder = JSON.parse(raw); } catch { holder = null; }
    if (!holder || holder.host !== host || isAlive(holder.pid)) {
      throw new Error(`bundle-repair: the ledger lock is held (${holder ? `pid ${holder.pid} on ${holder.host}` : 'unreadable holder'}) — skipped this pass; lock file ${path}`);
    }
    const takeover = `${path}.takeover`;
    if (!create(takeover, mine)) throw new Error(`bundle-repair: a lock takeover is in progress or was left by a crash — ${takeover}`);
    try {
      let again = null;
      try { again = readFileSync(path, 'utf8'); } catch { again = null; }
      if (again === raw) unlinkSync(path); // still exactly the dead holder's bytes
      if (!create(path, mine)) throw new Error(`bundle-repair: the ledger lock was taken by another pass — skipped this pass; lock file ${path}`);
    } finally { try { unlinkSync(takeover); } catch { /* best effort */ } }
  }
  try { return fn(); } finally {
    try { if (readFileSync(path, 'utf8') === mine) unlinkSync(path); } catch { /* best effort */ }
  }
}

function writeJsonAtomicSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// ── the tick's pass ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * ONE PASS per health tick: reconcile running repairs (stop / clear / escalate), then plan and reserve (or, in
 * shadow, post) new ones — all inside ONE synchronous ledger-locked section — then launch the reserved ones outside
 * the lock and patch their handles in under the lock again. `dryRun` decides everything and performs nothing.
 * Seams `stop`, `publish`, `overrideFor` and `lock` are SYNCHRONOUS; `dispatch` is async.
 * @returns {Promise<object>} the summary the tick reports
 */
export async function runBundleRepairs({
  dir, selfSync = [], now = Date.now(), dryRun = false, env = process.env, root = WE_ROOT,
  settingsResolved = null,
  rootsByKey = () => cloneRootsByKey({ root, env }),
  killed = () => existsSync(killFilePath(env)),
  overrideFor, dispatch = (target, o) => dispatchRepair(target, { ...o, root, env }),
  stop, publish, lock, readBrief,
  writeShadow = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
  log = (line) => process.stderr.write(`${line}\n`),
  host = hostname(),
} = {}) {
  const { settings, sources, invalid } = settingsResolved ?? await resolveBundleRepairSettings({ env });
  const summary = { settings, sources, invalid, killed: false, off: false, dispatched: [], shadow: [], held: [], reconciled: [], escalated: [], failed: [] };
  // Off with nothing ever recorded: no lock, no files — the feature leaves no footprint until it is turned on.
  if (settings.enabled !== true && !existsSync(ledgerPath(dir))) { summary.off = 'disabled'; return summary; }
  const deps = await loadHostDeps({ needStop: !stop, needPublish: !publish, needEvents: !overrideFor });
  stop ??= deps.stop;
  publish ??= deps.publish;
  overrideFor ??= (entry) => readConflictOverride(entry, { env, eventsFilePath: deps.eventsFilePath });
  lock ??= (d, fn) => defaultLock(d, fn);
  const keyToRoot = await rootsByKey();
  // `held: undefined` = UNKNOWN (no rebuild state could be read) — never read as "not held".
  const clones = (selfSync || []).map((c) => ({ cloneKey: c.cloneKey, root: keyToRoot.get(c.cloneKey) ?? null, held: c.rebuild ? (c.rebuild.held ?? null) : undefined }));
  const isKilled = (() => { try { return !!killed(); } catch { return false; } })();
  summary.killed = isKilled;
  const firstLine = (e) => String(e?.message || e).split('\n')[0];
  const liveHolds = () => new Set(clones.filter((c) => c.root && isOverlayHold(c.held)).map((c) => holdIdFor(c, c.held)));
  const persist = (ledger) => { if (!dryRun && (ledger.length || existsSync(ledgerPath(dir)))) writeJsonAtomicSync(ledgerPath(dir), pruneLedger(ledger, { now, liveHoldIds: liveHolds() })); };

  const tryStop = (entry) => {
    try {
      stop(entry);
      if (entry.stopPending) entry.stopSettledAt = now;
      delete entry.stopPending; delete entry.lastStopError;
      return true;
    } catch (e) { entry.stopPending = true; entry.lastStopError = firstLine(e); return false; }
  };
  // An escalation is PENDING until the feed accepted it: a failed post is retried every tick, never lost.
  const flush = (entry) => {
    const rest = [];
    for (const p of entry.escalationPending || []) {
      try { publish(escalationItem(entry, { reason: p.reason, detail: p.detail, host, weRoot: root }), { now }); entry.escalatedAt = now; }
      catch (e) { rest.push(p); entry.escalateError = firstLine(e); }
    }
    if (rest.length) entry.escalationPending = rest; else { delete entry.escalationPending; delete entry.escalateError; }
  };
  const escalate = (entry, reason, detail) => {
    entry.escalations = [...new Set([...(entry.escalations || []), reason])];
    entry.escalationPending = [...(entry.escalationPending || []), { reason, detail }];
    flush(entry);
    summary.escalated.push({ holdId: entry.holdId, reason });
    log(`bundle-repair: ESCALATED ${entry.name} (${reason}) — ${detail}`);
  };

  const reserved = [];
  const phase1 = () => {
    const ledger = readLedger(dir);
    const stoppedNow = new Set();
    // 0. retry what an earlier tick could not finish: a failed stop, an unposted escalation.
    if (!dryRun) {
      for (const e of ledger.filter((x) => x.stopPending)) if (tryStop(e)) stoppedNow.add(e.holdId);
      for (const e of ledger.filter((x) => x.escalationPending?.length)) flush(e);
    }
    // 1. reconcile
    const watch = (x) => x.status === 'running' || x.status === 'repaired' || x.stopPending || x.auditCheckPending || x.stopSettledAt === now;
    const outcomes = new Map();
    const overrides = new Map();
    const auditRead = new Set();
    for (const e of ledger.filter(watch)) {
      outcomes.set(e.holdId, readJson(outcomePath(dir, e.holdId), null));
      try { overrides.set(e.holdId, overrideFor(e)); auditRead.add(e.holdId); }
      catch { overrides.set(e.holdId, null); if (!dryRun) e.auditCheckPending = true; }
    }
    const actions = planReconcile(ledger, { clones, now, outcomeFor: (id) => outcomes.get(id), overrideFor: (e) => overrides.get(e.holdId) });
    for (const a of actions) {
      const entry = ledger.find((x) => x.holdId === a.holdId);
      summary.reconciled.push({ ...a, dryRun });
      if (dryRun) continue;
      if (a.stop && tryStop(entry)) stoppedNow.add(entry.holdId);
      entry.status = a.status;
      entry.endedAt ??= now;
      entry.endReason = a.escalate ?? a.detail;
      if (a.escalate) escalate(entry, a.escalate, a.detail);
    }
    // The trail was read this tick and planReconcile has acted on it: the pending audit check is done.
    if (!dryRun) for (const id of auditRead) { const x = ledger.find((y) => y.holdId === id); if (x) delete x.auditCheckPending; }
    // 1b. AFTER a session is stopped, re-read both things it could have written in the meantime: the overlay audit
    //     trail (a registration with a conflict override) and its outcome file (an escalation). Raised once each.
    //     An unreadable trail keeps the audit check PENDING, so a later tick still reads it.
    if (!dryRun) {
      for (const id of stoppedNow) {
        const entry = ledger.find((x) => x.holdId === id);
        if (!entry) continue;
        const raised = new Set(entry.escalations || []);
        let ov = null;
        try { ov = overrideFor(entry); delete entry.auditCheckPending; } catch { entry.auditCheckPending = true; }
        if (ov && !raised.has('conflict-override-used')) {
          entry.status = 'escalated'; entry.endReason = 'conflict-override-used';
          escalate(entry, 'conflict-override-used', `a registration by ${BUNDLE_REPAIR_BOT} carried a conflict override (${ov.ref ?? '?'})`);
        }
        const outcome = readJson(outcomePath(dir, entry.holdId), null);
        if (outcome?.outcome === 'escalate' && !raised.has(outcome.reason) && outcomes.get(id)?.outcome !== 'escalate') {
          entry.status = 'escalated'; entry.endReason = outcome.reason;
          escalate(entry, outcome.reason, outcome.detail);
        }
      }
    }
    // 2. plan + reserve
    const planned = planBundleRepairs({ clones, ledger, settings, killed: isKilled, now });
    summary.off = planned.off;
    summary.held = planned.held;
    for (const t of planned.dispatch) {
      let filled;
      try { filled = fillRepairBriefWith(deps.lane, t, { root, ...(readBrief ? { readBrief } : {}) }); } catch (e) {
        summary.failed.push({ holdId: t.holdId, error: firstLine(e) });
        continue;
      }
      const base = { holdId: t.holdId, cloneKey: t.cloneKey, root: t.root, name: t.name, holdSince: t.holdSince, startedAt: now, session: filled.session };
      if (settings.mode !== 'live') {
        summary.shadow.push({ ...base, dryRun });
        if (dryRun) continue;
        const path = shadowPath(dir, t.holdId);
        writeShadow(path, filled.prompt);
        ledger.push({ ...base, status: 'shadow', briefPath: path });
        log(`bundle-repair[shadow]: would launch ${filled.session} for clone ${t.name} (held since ${new Date(t.holdSince).toISOString()}) — brief ${path}`);
        try {
          publish({ repo: `host/${host}`, pr: 0, head: `bundle-repair-shadow:${t.holdId}`.slice(0, 128), kind: 'bundle-repair-shadow',
            reason: `${t.name}: shadow — would launch a bundle repair`.slice(0, 100), episode: t.holdId, pick: `cat ${path}` }, { now });
        } catch { /* the file + log line are the record */ }
        continue;
      }
      if (dryRun) { summary.dispatched.push({ ...base, dryRun }); continue; }
      // RESERVE BEFORE LAUNCH: on disk (inside this lock) as an indeterminate running repair before anything spawns.
      const token = randomBytes(24).toString('hex');
      const deadlineAt = now + settings.wallTimeMinutes * 60_000;
      ledger.push({ ...base, handle: null, deadlineAt, status: 'running', indeterminate: true, launching: true, tokenHash: sha256(token) });
      reserved.push({ t, filled, token, base });
    }
    persist(ledger);
  };
  if (dryRun) phase1(); else lock(dir, phase1);

  // 3. launch outside the lock; patch each result in under the lock.
  for (const { t, filled, token, base } of reserved) {
    let patch;
    try {
      const r = await dispatch(t, { prompt: filled.prompt, session: filled.session, token, stateRoot: resolve(dir, '..', '..'), wallTimeMinutes: settings.wallTimeMinutes });
      patch = { handle: r.handle };
      summary.dispatched.push({ ...base, handle: r.handle });
      log(`bundle-repair: launched ${filled.session} for clone ${t.name}`);
    } catch (e) {
      const error = firstLine(e);
      summary.failed.push({ holdId: t.holdId, error });
      // Provably not started → settled + escalated. Otherwise keep the slot; the wall time stops it by name.
      patch = e?.notApplied === true ? { failedNotApplied: error } : { endReason: error };
    }
    lock(dir, () => {
      const ledger = readLedger(dir);
      const entry = ledger.find((x) => x.holdId === t.holdId);
      if (!entry) return;
      delete entry.launching;
      if (patch.handle !== undefined) { entry.handle = patch.handle; delete entry.indeterminate; }
      // Another pass settled this reservation while the launch was in flight (handle known OR indeterminate): the
      // session may be live but is no longer supervised as running. Mark its stop PENDING — that keeps the clone
      // blocked, and the next pass stops it (by handle or by name) and re-reads the audit trail after the stop,
      // exactly like any other stop.
      if (entry.status !== 'running' && !patch.failedNotApplied) {
        entry.stopPending = true;
        log(`bundle-repair: late-launched ${entry.session} on a settled entry (${entry.status}) — stop pending`);
      }
      else if (patch.failedNotApplied) {
        Object.assign(entry, { status: 'dispatch-failed', endedAt: now, endReason: patch.failedNotApplied });
        delete entry.indeterminate;
        escalate(entry, 'dispatch-failed', patch.failedNotApplied);
      } else entry.endReason = patch.endReason;
      persist(ledger);
    });
  }
  return summary;
}

// ── the session's verb + operator reads ──────────────────────────────────────────────────────────────────────

/** `record`: the session's ONE write — only its own running hold, with its capability token, once. Taken under the
 *  ledger lock, so a record can never land between a pass's last read and its settling of the entry: either the
 *  pass sees it, or the record sees the settled status and is refused. A held lock is retried for up to ~60 s. */
export function recordOutcome({ dir, holdId, session, input, token, now = Date.now(), scrub, lock = defaultLock, attempts = 60, waitMs = 1000 }) {
  const path = outcomePath(dir, holdId);
  const write = () => {
    const entry = readLedger(dir).find((x) => x.holdId === holdId);
    if (!entry) throw new Error(`bundle-repair: no repair is on the ledger for hold ${holdId}`);
    const given = Buffer.from(sha256(token ?? ''), 'hex');
    const want = Buffer.from(String(entry.tokenHash ?? ''), 'hex');
    if (!token || given.length !== want.length || !timingSafeEqual(given, want)) throw new Error(`bundle-repair: record for ${holdId} refused — missing or wrong session capability`);
    if (entry.session !== session) throw new Error(`bundle-repair: hold ${holdId} belongs to session ${entry.session}, not ${session}`);
    if (entry.status !== 'running') throw new Error(`bundle-repair: the repair of ${holdId} is ${entry.status} — nothing more can be recorded`);
    const outcome = { ...validateOutcome(input, scrub ? { scrub } : {}), recordedAt: new Date(now).toISOString(), session };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(outcome, null, 2)}\n`, { flag: 'wx' }); // once: a second record fails EEXIST
    return { path, outcome };
  };
  for (let i = 1; ; i++) {
    try { return lock(dir, write); } catch (e) {
      if (!/ledger lock (is held|was taken)/.test(String(e?.message)) || i >= attempts) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

function parseFlags(argv) {
  const flags = {}; const pos = [];
  for (const a of argv) {
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    flags[eq === -1 ? a.slice(2) : a.slice(2, eq)] = eq === -1 ? true : a.slice(eq + 1);
  }
  return { flags, pos };
}

export async function main(argv, { env = process.env, readStdin = () => readFileSync(0, 'utf8'), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const { flags, pos } = parseFlags(argv);
  const { healthDir } = await import('./health-watch-section.mjs');
  const { CONVEYOR_STATE_ROOT_ENV } = await import('../lib/daemon-last-good.mjs');
  const pinned = !!String(env[CONVEYOR_STATE_ROOT_ENV] ?? '').trim();
  const dir = healthDir(!pinned && typeof flags['state-root'] === 'string' ? flags['state-root'] : undefined, env);
  try {
    if (pos[0] === 'record') {
      let input;
      try { input = JSON.parse(readStdin()); } catch (e) { throw new Error(`bundle-repair: outcome on stdin is not JSON — ${e.message}`); }
      const { scrubInvestigationText } = await import('./health-investigate-plan.mjs');
      const { path } = recordOutcome({ dir, holdId: flags.hold, session: flags.session, input, token: env[TOKEN_ENV], scrub: (s) => scrubInvestigationText(s, { home: homedir() }) });
      out(`bundle-repair: outcome recorded → ${path}\n`);
      return 0;
    }
    if (pos[0] === 'show') {
      const entry = readLedger(dir).find((x) => x.holdId === flags.hold) ?? null;
      out(`${JSON.stringify({ entry, outcome: readJson(outcomePath(dir, flags.hold), null) }, null, 2)}\n`);
      return 0;
    }
    if (pos[0] === 'plan') {
      const { probeSelfSync } = await import('./health-watch.mjs');
      const { daemonStateDir } = await import('../lib/daemon-last-good.mjs');
      const selfSync = probeSelfSync(daemonStateDir(env));
      const s = await runBundleRepairs({ dir, selfSync, dryRun: true, env });
      out(`${JSON.stringify(s, null, 2)}\n`);
      return 0;
    }
    err('bundle-repair: usage — plan | show --hold=<id> | record --hold=<id> --session=<slug> < outcome.json\n');
    return 1;
  } catch (e) {
    err(`${String(e?.message || e)}\n`);
    return 1;
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
