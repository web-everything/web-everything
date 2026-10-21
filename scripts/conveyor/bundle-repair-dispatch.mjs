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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
export function readLedger(dir) { const v = readJson(ledgerPath(dir), []); return Array.isArray(v) ? v : []; }

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

/** IO: the first registration by the bot since the repair started that carried a conflict override, or null. */
export async function readConflictOverride(entry, { env = process.env, readFile = readFileSync } = {}) {
  const { eventsFilePath } = await import('../lib/daemon-overlays.mjs');
  let text = '';
  try { text = String(readFile(eventsFilePath(entry.root, env), 'utf8')); } catch { return null; }
  for (const line of text.split('\n').slice(-2000)) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.kind === 'added' && ev.by === BUNDLE_REPAIR_BOT && ev.conflictOverride && Date.parse(ev.at) >= entry.startedAt) return ev;
  }
  return null;
}

// ── launch ───────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE-ish: the filled brief for one target (throws on a forbidden command or a placeholder hole). */
export async function fillRepairBrief(target, { root = WE_ROOT, readBrief = (r) => readFileSync(briefPath(r), 'utf8') } = {}) {
  const { BRIEF_REQUIRED_BY_KIND, fillBrief, sessionSlugFor } = await import('../operations/dispatch-lane.mjs');
  const session = sessionSlugFor(target.holdId, BUNDLE_REPAIR_KIND);
  const { prompt, unknownTokens } = fillBrief(readBrief(root), {
    CLONE_ROOT: target.root, CLONE_NAME: target.name, HOLD_ID: target.holdId, HELD_REFS: target.refs.join(',') || 'none',
    SESSION_SLUG: session, BOT: BUNDLE_REPAIR_BOT, WE_ROOT: root,
  }, BRIEF_REQUIRED_BY_KIND[BUNDLE_REPAIR_KIND], []);
  assertBriefSafe(prompt);
  return { prompt, session, unknownTokens };
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
async function defaultStop(entry) {
  const { stopSessionWithRetry } = await import('./session-reaper.mjs');
  let handle = entry.handle;
  if (!handle && entry.session) {
    const { readAgentsStrict } = await import('../lib/lane-salvage.mjs');
    const row = (readAgentsStrict() || []).find((a) => a?.name === entry.session && !FINISHED.has(a.state));
    handle = row?.id ?? row?.sessionId ?? null;
  }
  if (handle) stopSessionWithRetry({ handle });
}

async function defaultPublish(item, { now }) {
  const { publishAttention } = await import('../operations/needs-you-feed.mjs');
  return publishAttention(item, { now });
}

/** An ASYNC-safe exclusive lock around one pass (`withFileLock` releases as soon as a sync fn returns, so it cannot
 *  span the awaited launch). A lock older than 15 min is a crashed pass and is taken over. Another live pass holds
 *  it → this pass skips (the next tick runs). */
export async function defaultLock(dir, fn, { staleMs = 15 * 60_000 } = {}) {
  const path = `${ledgerPath(dir)}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, `${process.pid}\n`, { flag: 'wx' }); } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    let age = 0;
    try { age = Date.now() - statSync(path).mtimeMs; } catch { /* vanished */ }
    if (age < staleMs) throw new Error('bundle-repair: another pass holds the ledger lock — skipped this tick');
    writeFileSync(path, `${process.pid}\n`);
  }
  try { return await fn(); } finally { try { unlinkSync(path); } catch { /* best effort */ } }
}

function writeJsonAtomicSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// ── the tick's pass ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * ONE PASS per health tick: reconcile running repairs (stop / clear / escalate), then plan and launch (or, in
 * shadow, post) new ones. `dryRun` decides everything and performs nothing. Never throws for one repair's failure.
 * @returns {Promise<object>} the summary the tick reports
 */
export async function runBundleRepairs({
  dir, selfSync = [], now = Date.now(), dryRun = false, env = process.env, root = WE_ROOT,
  settingsResolved = null,
  rootsByKey = () => cloneRootsByKey({ root, env }),
  killed = () => existsSync(killFilePath(env)),
  overrideFor = (entry) => readConflictOverride(entry, { env }),
  dispatch = (target, o) => dispatchRepair(target, { ...o, root, env }),
  stop = defaultStop,
  publish = defaultPublish,
  lock = defaultLock,
  writeShadow = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
  log = (line) => process.stderr.write(`${line}\n`),
  host = hostname(),
} = {}) {
  const { settings, sources, invalid } = settingsResolved ?? await resolveBundleRepairSettings({ env });
  const keyToRoot = await rootsByKey();
  const clones = (selfSync || []).map((c) => ({ cloneKey: c.cloneKey, root: keyToRoot.get(c.cloneKey) ?? null, held: c.rebuild?.held ?? null }));
  const isKilled = (() => { try { return !!killed(); } catch { return false; } })();
  const summary = { settings, sources, invalid, killed: isKilled, off: false, dispatched: [], shadow: [], held: [], reconciled: [], escalated: [], failed: [] };

  const body = async () => {
    const ledger = readLedger(dir);
    const live = () => new Set(clones.filter((c) => c.root && isOverlayHold(c.held)).map((c) => holdIdFor(c, c.held)));
    const persist = () => { if (!dryRun && (ledger.length || existsSync(ledgerPath(dir)))) writeJsonAtomicSync(ledgerPath(dir), pruneLedger(ledger, { now, liveHoldIds: live() })); };
    const firstLine = (e) => String(e?.message || e).split('\n')[0];
    const tryStop = async (entry) => {
      try { await stop(entry); delete entry.stopPending; delete entry.lastStopError; }
      catch (e) { entry.stopPending = true; entry.lastStopError = firstLine(e); }
    };
    // An escalation is PENDING until the feed accepted it: a failed post is retried every tick, never lost.
    const tryEscalate = async (entry) => {
      const { reason, detail } = entry.escalationPending;
      try {
        await publish(escalationItem(entry, { reason, detail, host, weRoot: root }), { now });
        delete entry.escalationPending; delete entry.escalateError; entry.escalatedAt = now;
      } catch (e) { entry.escalateError = firstLine(e); }
    };

    // 0. retry what an earlier tick could not finish: a failed stop, an unposted escalation.
    if (!dryRun) {
      for (const e of ledger.filter((x) => x.stopPending)) await tryStop(e);
      for (const e of ledger.filter((x) => x.escalationPending)) await tryEscalate(e);
    }
    // 1. reconcile
    const outcomes = new Map();
    const overrides = new Map();
    for (const e of ledger.filter((x) => x.status === 'running' || x.status === 'repaired')) {
      outcomes.set(e.holdId, readJson(outcomePath(dir, e.holdId), null));
      try { overrides.set(e.holdId, await overrideFor(e)); } catch { overrides.set(e.holdId, null); }
    }
    const actions = planReconcile(ledger, { clones, now, outcomeFor: (id) => outcomes.get(id), overrideFor: (e) => overrides.get(e.holdId) });
    for (const a of actions) {
      const entry = ledger.find((x) => x.holdId === a.holdId);
      summary.reconciled.push({ ...a, dryRun });
      if (dryRun) continue;
      if (a.stop) await tryStop(entry);
      entry.status = a.status;
      entry.endedAt = now;
      entry.endReason = a.escalate ?? a.detail;
      if (a.escalate) {
        entry.escalationPending = { reason: a.escalate, detail: a.detail };
        await tryEscalate(entry);
        summary.escalated.push({ holdId: a.holdId, reason: a.escalate });
        log(`bundle-repair: ESCALATED ${entry.name} (${a.escalate}) — ${a.detail}`);
      }
    }
    persist();
    // 2. plan + launch
    const planned = planBundleRepairs({ clones, ledger, settings, killed: isKilled, now });
    summary.off = planned.off;
    summary.held = planned.held;
    for (const t of planned.dispatch) {
      let filled;
      try { filled = await fillRepairBrief(t, { root }); } catch (e) {
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
        persist();
        log(`bundle-repair[shadow]: would launch ${filled.session} for clone ${t.name} (held since ${new Date(t.holdSince).toISOString()}) — brief ${path}`);
        try {
          await publish({ repo: `host/${host}`, pr: 0, head: `bundle-repair-shadow:${t.holdId}`.slice(0, 128), kind: 'bundle-repair-shadow',
            reason: `${t.name}: shadow — would launch a bundle repair`.slice(0, 100), episode: t.holdId, pick: `cat ${path}` }, { now });
        } catch { /* the file + log line are the record */ }
        continue;
      }
      if (dryRun) { summary.dispatched.push({ ...base, dryRun }); continue; }
      const token = randomBytes(24).toString('hex');
      const deadlineAt = now + settings.wallTimeMinutes * 60_000;
      // RESERVE BEFORE LAUNCH: the entry is on disk as an indeterminate running repair before anything spawns, so a
      // crash mid-launch can never let a later tick launch a second session for this clone/hold.
      const entry = { ...base, handle: null, deadlineAt, status: 'running', indeterminate: true, tokenHash: sha256(token) };
      ledger.push(entry);
      persist();
      try {
        const r = await dispatch(t, { prompt: filled.prompt, session: filled.session, token, stateRoot: resolve(dir, '..', '..'), wallTimeMinutes: settings.wallTimeMinutes });
        entry.handle = r.handle;
        delete entry.indeterminate;
        summary.dispatched.push({ ...base, handle: r.handle });
        log(`bundle-repair: launched ${filled.session} for clone ${t.name}`);
      } catch (e) {
        const error = firstLine(e);
        summary.failed.push({ holdId: t.holdId, error });
        entry.endReason = error;
        // Provably not started → settled + escalated. Otherwise keep the slot; the wall time stops it by name.
        if (e?.notApplied === true) {
          Object.assign(entry, { status: 'dispatch-failed', endedAt: now, escalationPending: { reason: 'dispatch-failed', detail: error } });
          delete entry.indeterminate;
          await tryEscalate(entry);
          log(`bundle-repair: ESCALATED ${t.name} (dispatch-failed) — ${error}`);
        }
      }
      persist();
    }
  };
  // Off with nothing ever recorded: no lock, no files — the feature leaves no footprint until it is turned on.
  if (settings.enabled !== true && !existsSync(ledgerPath(dir))) { summary.off = 'disabled'; return summary; }
  if (dryRun) await body(); else await lock(dir, body);
  return summary;
}

// ── the session's verb + operator reads ──────────────────────────────────────────────────────────────────────

/** `record`: the session's ONE write — only its own running hold, with its capability token, once. */
export function recordOutcome({ dir, holdId, session, input, token, now = Date.now(), scrub }) {
  const path = outcomePath(dir, holdId);
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
