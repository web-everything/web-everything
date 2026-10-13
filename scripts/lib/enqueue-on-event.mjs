#!/usr/bin/env node
/**
 * @file scripts/lib/enqueue-on-event.mjs
 * @description Card 257 "Enqueue as soon as checks finish" (coroner 2026-10-12; operator GO 2026-10-13).
 *
 * WHY. A PR that turned ready waited for the drain daemon's next FULL pass before it reached GitHub's merge queue.
 *   A full pass lists and classifies every queued PR first (1–7 min on 2026-10-13), and a failed pass (one PR's
 *   enqueue refused → exit 2) backs off 4–15 min with nudges ignored. Measured check-finish → enqueued on
 *   2026-10-13: median ~2 min, worst 25 min (#5175), 8 min (#5181).
 *
 * WHAT. When the drain's PR-events feed (`./pr-event-feed.mjs`, role `drain`) marks a PR with an event that can make
 *   it enqueue-eligible (a check suite finished green, or `review:accepted` / `ready-to-merge` was added), this runs
 *   the drain's EXISTING single-PR fast drain for that PR — `merge-ai-prs.mjs --only=<n> --label=ready-to-merge` —
 *   after a short debounce. That is the same per-PR path `/pr` and `/finish` use: every drain gate (AI authorship,
 *   required checks, review labels, blockedBy, couples, red-main holds, the enqueue clearance) runs on live state.
 *   Nothing here decides eligibility or enqueues; an event is only a wake for ONE PR (statute
 *   `#event-driven-land-is-wake-only`). A PR that is not ready is skipped by the drain exactly as a pass would.
 *
 * WHO CALLS IT. The resident drain daemon (plateau-app `tools/drain-daemon/daemon.mjs`) imports this from its WE
 *   clone, feeds it each feed poll (`notePoll`), and calls `tick()` ONLY while it sleeps between passes (never during
 *   a clone refresh or a pass: both use the same clone). Before its next pass it awaits `idle()`. So a fast drain and
 *   a full pass never run at the same time in one clone.
 *
 * SETTING `mergeQueue.enqueueOnEvent` — `{ enabled: boolean, debounceSeconds: number }`, resolved through the shared
 *   policy cascade (`./policy-cascade.mjs`): standard default `{enabled:false, debounceSeconds:15}` → platform
 *   preference `mergeQueue.enqueueOnEvent` → tool block `mergeQueue.enqueueOnEvent` in `we:scripts/settings/*.json`
 *   (this repo: `merge-queue.json`) → env `WE_ENQUEUE_ON_EVENT=on|off` (enabled only). Re-read on every tick; the
 *   source of each leaf is logged once per distinct value (`enqueue-on-event: setting …`).
 *   debounceSeconds: wait this long after the PR's LAST eligible event before running (check suites finish in a
 *   burst, and GitHub's mergeable state lags the last check by a few seconds).
 *
 * SCOPE. Only PRs of the local repo (the clone's origin): that is the repo whose ready PRs the drain enqueues on
 *   GitHub's merge queue. A mark with no PR number (`repo#?`) or a full-sweep mark (`*`) is left to the full pass.
 */
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';

export const ENQUEUE_ON_EVENT_POLICY = 'mergeQueue.enqueueOnEvent';
export const ENQUEUE_ON_EVENT_ENV = 'WE_ENQUEUE_ON_EVENT';
export const ENQUEUE_ON_EVENT_DEFAULTS = Object.freeze({ enabled: false, debounceSeconds: 15 });
/** A fast drain that runs longer than this is stopped (SIGTERM); the PR rides the next full pass. */
export const FAST_DRAIN_TIMEOUT_MS = 10 * 60_000;
const READY_LABEL = 'ready-to-merge';
const ELIGIBLE_LABELS = Object.freeze(['review:accepted', READY_LABEL]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const VALID = {
  enabled: (v) => typeof v === 'boolean',
  debounceSeconds: (v) => Number.isFinite(v) && v >= 0 && v <= 600,
};

/**
 * Resolve the setting. Never throws. `tool` defaults to the declared settings' `mergeQueue.enqueueOnEvent` block.
 * @returns {{enabled:boolean, debounceSeconds:number, sources:Record<string,string>, invalid:string[], line:string}}
 */
export function resolveEnqueueOnEventSetting({ env = process.env, tool, platform } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readDeclaredSettings().settings?.mergeQueue?.enqueueOnEvent; } catch { block = undefined; }
  }
  const raw = String(env?.[ENQUEUE_ON_EVENT_ENV] ?? '').trim().toLowerCase();
  const envEnabled = raw === 'on' || raw === '1' || raw === 'true' ? true : raw === 'off' || raw === '0' || raw === 'false' ? false : undefined;
  const c = cascadePolicy(ENQUEUE_ON_EVENT_POLICY, isObj(block) ? block : undefined, {
    env, standard: { ...ENQUEUE_ON_EVENT_DEFAULTS }, envValues: { enabled: envEnabled }, valid: VALID,
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const v = isObj(c.value) ? c.value : {};
  const out = {
    enabled: v.enabled === true,
    debounceSeconds: VALID.debounceSeconds(v.debounceSeconds) ? v.debounceSeconds : ENQUEUE_ON_EVENT_DEFAULTS.debounceSeconds,
    sources: c.sources || {},
    invalid: [...(c.invalid || []), ...(raw && envEnabled === undefined ? [`env ${ENQUEUE_ON_EVENT_ENV}=${JSON.stringify(raw)}`] : [])],
  };
  const src = (k) => out.sources[k] || 'standard';
  out.line = `enqueue-on-event: setting ${ENQUEUE_ON_EVENT_POLICY} enabled=${out.enabled} (${src('enabled')}), debounceSeconds=${out.debounceSeconds} (${src('debounceSeconds')})${out.invalid.length ? ` · ignored invalid: ${out.invalid.join('; ')}` : ''}`;
  return out;
}

/**
 * Parse a feed mark's cause (pr-event-feed `describeEvent`: `type.action(label)=conclusion@seq[ via head commit]`). PURE.
 * @returns {{type:string, action:string, label:(string|null), conclusion:(string|null)}|null}
 */
export function parseMarkCause(cause) {
  const m = /^([a-z_]+)\.([a-z_]*)(?:\(([^)]*)\))?(?:=([a-z_]+))?@\d+/i.exec(String(cause ?? ''));
  if (!m) return null;
  return { type: m[1], action: m[2], label: m[3] ?? null, conclusion: m[4] ?? null };
}

/** Can this event make a PR enqueue-eligible? PURE. A green check suite / check run, or an eligibility label added. */
export function isEligibleCause(cause) {
  const c = parseMarkCause(cause);
  if (!c) return false;
  if ((c.type === 'check_suite' || c.type === 'check_run') && c.action === 'completed') return c.conclusion === 'success';
  if (c.type === 'pull_request' && c.action === 'labeled') return ELIGIBLE_LABELS.includes(c.label);
  return false;
}

/** `owner/name#123` → `{repo, num}`; null for `owner/name#?` and `*`. PURE. */
export function parseMarkKey(key) {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(String(key ?? ''));
  return m ? { repo: m[1].toLowerCase(), num: Number(m[2]) } : null;
}

/**
 * Fold one feed poll's marks into the pending map (key → {repo, num, firstAt, lastAt, causes}). PURE: returns a new map.
 * Only eligible causes on a numbered PR of `localSlug` count.
 */
export function notePending(pending, marked, { localSlug, now }) {
  const next = new Map(pending);
  const local = String(localSlug ?? '').toLowerCase();
  for (const m of Array.isArray(marked) ? marked : []) {
    if (!isEligibleCause(m?.cause)) continue;
    const k = parseMarkKey(m?.key);
    if (!k || !local || k.repo !== local) continue;
    const key = `${k.repo}#${k.num}`;
    const prev = next.get(key);
    next.set(key, { ...k, firstAt: prev?.firstAt ?? now, lastAt: now, causes: [...new Set([...(prev?.causes || []), String(m.cause).replace(/@\d+.*$/, '')])].slice(-3) });
  }
  return next;
}

/** The pending PRs whose debounce has elapsed, oldest first. PURE. */
export function duePending(pending, { now, debounceSeconds }) {
  return [...pending.values()].filter((p) => now - p.lastAt >= debounceSeconds * 1000).sort((a, b) => a.firstAt - b.firstAt);
}

/** The fast-drain argv (node script + args). The drain's own single-PR path; `--this-repo` keeps the listing local. PURE. */
export function fastDrainArgs({ scriptRoot, num }) {
  return [join(scriptRoot, 'scripts', 'merge-ai-prs.mjs'), `--only=${num}`, `--label=${READY_LABEL}`, '--this-repo', '--json'];
}

/** What the fast drain's JSON said about the target PR, in a few words. PURE. */
export function summarizeFastDrain(json, num) {
  if (!isObj(json)) return 'no JSON result';
  if (json.skipped === 'drain-in-progress') return `no-op (${json.detail || 'lease held'})`;
  const hit = (list) => (Array.isArray(list) ? list.find((x) => Number(x?.num) === Number(num)) : null);
  const failed = hit(json.failed);
  if (failed) return `failed: ${String(failed.detail || failed.reason || failed.error || '').slice(0, 200)}`;
  const skip = hit(json.skipReasons) || hit(json.skipped);
  if (skip) return `skipped: ${String(skip.reason || skip.kind || '').slice(0, 200)}`;
  if (hit(json.merged) || hit(json.toMerge)) return 'passed every drain gate — enqueued';
  if (!json.considered) return 'not listed (not ready-to-merge, closed, or already queued)';
  return 'no verdict for the PR';
}

/**
 * Is the PR worth a fast drain right now? A WAKE filter, never the gate: it only skips a run the drain would certainly
 * no-op (a fast drain lists and classifies for ~1 min, and most green-check events are for PRs that are not queued yet
 * or still have checks running; a later event wakes them again). The drain still re-reads everything live and decides.
 * A PR that could not be read is woken (the drain decides). PURE.
 * @param {{state?:string, isDraft?:boolean, labels?:Array<{name:string}>, statusCheckRollup?:Array<object>}|null} pr
 * @returns {{wake:boolean, reason:string}}
 */
export function wakeWorthy(pr) {
  if (!isObj(pr)) return { wake: true, reason: 'PR unread — the drain decides' };
  if (pr.state && pr.state !== 'OPEN') return { wake: false, reason: `PR is ${String(pr.state).toLowerCase()}` };
  if (pr.isDraft) return { wake: false, reason: 'draft' };
  const labels = (Array.isArray(pr.labels) ? pr.labels : []).map((l) => l?.name);
  if (!labels.includes(READY_LABEL)) return { wake: false, reason: `no ${READY_LABEL} label yet` };
  const running = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [])
    .filter((c) => (c?.__typename === 'StatusContext' ? ['PENDING', 'EXPECTED'].includes(String(c.state).toUpperCase()) : c?.status && c.status !== 'COMPLETED'));
  if (running.length) return { wake: false, reason: `${running.length} check(s) still running (${running.slice(0, 3).map((c) => c.name || c.context).join(', ')})` };
  return { wake: true, reason: 'ready-to-merge, every check finished' };
}

/** Default PR read for {@link wakeWorthy}: one `gh pr view`. Resolves null on any failure. */
export function readPrForWake({ repo, num, env = process.env, execFileImpl = execFile }) {
  return new Promise((res) => {
    execFileImpl('gh', ['pr', 'view', String(num), '--repo', repo, '--json', 'state,isDraft,labels,statusCheckRollup'], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      if (err) { res(null); return; }
      try { res(JSON.parse(String(stdout || 'null'))); } catch { res(null); }
    });
  });
}

function runChild({ args, cwd, env, spawnImpl, timeoutMs, onChild = () => {} }) {
  return new Promise((resolveRun) => {
    let stdout = ''; let stderrTail = '';
    let child;
    try { child = spawnImpl(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolveRun({ code: null, stdout: '', error: String(e?.message || e) }); return; }
    onChild(child);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
    const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => { clearTimeout(killer); resolveRun({ code: null, stdout, stderrTail, error: String(e?.message || e) }); });
    child.on('close', (code) => { clearTimeout(killer); resolveRun({ code, stdout, stderrTail }); });
  });
}

const lastJsonLine = (s) => {
  const lines = String(s || '').trim().split('\n').reverse();
  for (const l of lines) { try { const j = JSON.parse(l); if (isObj(j)) return j; } catch { /* not JSON */ } }
  return null;
};

/**
 * The daemon-side handle.
 * @param {{cwd:string, localSlug:string, scriptRoot?:()=>string, allowed?:()=>boolean, log?:(m:string)=>void,
 *   env?:object, now?:()=>number, spawnImpl?:Function, resolveSetting?:Function, timeoutMs?:number, readPr?:Function}} o
 *   `cwd` the drain's data clone (the fast drain runs there, like a pass). `scriptRoot()` the pass code root (data
 *   clone, or the code clone carrying overlays). `allowed()` true only while the caller sleeps between passes.
 */
export function createEnqueueOnEvent({
  cwd, localSlug, scriptRoot = () => cwd, allowed = () => true, log = (m) => process.stderr.write(`${m}\n`),
  env = process.env, now = () => Date.now(), spawnImpl = spawn, resolveSetting = () => resolveEnqueueOnEventSetting({ env }),
  timeoutMs = FAST_DRAIN_TIMEOUT_MS, readPr = ({ repo, num }) => readPrForWake({ repo, num, env }),
} = {}) {
  let pending = new Map();
  let running = null; // the in-flight tick's promise
  let child = null;   // the in-flight fast drain (so the daemon can stop it when it exits)
  let lastLine = null;
  let setting = ENQUEUE_ON_EVENT_DEFAULTS;
  const readSetting = () => {
    try { setting = resolveSetting(); } catch (e) { setting = { ...ENQUEUE_ON_EVENT_DEFAULTS, line: `enqueue-on-event: setting unreadable (${String(e?.message || e).split('\n')[0]}) — off` }; }
    if (setting.line && setting.line !== lastLine) { log(setting.line); lastLine = setting.line; }
    return setting;
  };
  readSetting();

  async function runDue() {
    const s = readSetting();
    if (!s.enabled) { pending = new Map(); return []; }
    const ran = [];
    for (;;) {
      if (!allowed()) break;
      const [p] = duePending(pending, { now: now(), debounceSeconds: s.debounceSeconds });
      if (!p) break;
      const key = `${p.repo}#${p.num}`;
      const taken = pending.get(key);
      pending = new Map(pending); pending.delete(key);
      let pr = null;
      try { pr = await readPr({ repo: p.repo, num: p.num }); } catch { pr = null; }
      const w = wakeWorthy(pr);
      if (!w.wake) { log(`enqueue-on-event: #${p.num} ${taken.causes.join(', ')} — not woken: ${w.reason}`); ran.push({ num: p.num, code: null, what: `not woken: ${w.reason}` }); continue; }
      if (!allowed()) { pending = new Map(pending).set(key, taken); break; } // the window closed during the read
      const startedAt = now();
      const args = fastDrainArgs({ scriptRoot: scriptRoot(), num: p.num });
      log(`enqueue-on-event: #${p.num} ${taken.causes.join(', ')} — running the drain's single-PR fast drain ${Math.round((startedAt - taken.lastAt) / 1000)}s after the last event`);
      const r = await runChild({ args, cwd, env, spawnImpl, timeoutMs, onChild: (c) => { child = c; } });
      child = null;
      const what = r.error ? `could not run (${r.error})` : summarizeFastDrain(lastJsonLine(r.stdout), p.num);
      log(`enqueue-on-event: #${p.num} fast drain exit ${r.code ?? 'none'} in ${Math.round((now() - startedAt) / 1000)}s — ${what}`);
      ran.push({ num: p.num, code: r.code, what });
    }
    return ran;
  }

  return {
    /** Fold one `consumer.pollOnce()` result in. */
    notePoll(r) { if (r?.ok !== false && Array.isArray(r?.marked) && r.marked.length) pending = notePending(pending, r.marked, { localSlug, now: now() }); },
    /** Run every due PR now (one at a time) if enabled and allowed; a no-op while a tick is already running. */
    tick() { if (!running) running = runDue().finally(() => { running = null; }); return running; },
    /** Resolves when no fast drain is in flight (call before a full pass or a clone refresh). */
    idle() { return running ? running.then(() => undefined, () => undefined) : Promise.resolve(); },
    /** Stop the in-flight fast drain (the daemon calls this on its own exit, like it stops its pass child). */
    kill() { if (child) { try { child.kill('SIGTERM'); } catch { /* gone */ } } },
    pending: () => [...pending.values()],
    setting: () => setting,
  };
}

// ── CLI: a foreground watch over the live feed (operator check / live proof) ─────────────────────────────────────
// node scripts/lib/enqueue-on-event.mjs watch --minutes=N   (needs WE_PR_EVENTS_URL + WE_PR_EVENTS_TOKEN_FILE; runs
// the fast drain from the current checkout, which must be a clean WE clone on main). Its own feed role, so it never
// moves the drain daemon's cursor.
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'watch') { console.log('usage: node scripts/lib/enqueue-on-event.mjs watch [--minutes=N]'); process.exitCode = 2; return; }
  const minutes = Number((rest.find((a) => a.startsWith('--minutes=')) || '--minutes=10').slice(10)) || 10;
  const { createFeedConsumerFromEnv } = await import('./pr-event-feed.mjs');
  const { localRepoSlug } = await import('../readiness/drain-lock.mjs');
  const { consumer, reason } = createFeedConsumerFromEnv({ role: 'enqueue-on-event-watch', log: { error: (m) => console.error(m) } });
  if (!consumer) { console.error(`enqueue-on-event: ${reason}`); process.exitCode = 1; return; }
  const cwd = process.cwd();
  const end = Date.now() + minutes * 60_000;
  const h = createEnqueueOnEvent({ cwd, localSlug: localRepoSlug({ cwd }), allowed: () => Date.now() < end, log: (m) => console.error(`${new Date().toISOString()} ${m}`) });
  while (Date.now() < end) {
    const r = await consumer.pollOnce();
    const eligible = (r.marked || []).filter((m) => isEligibleCause(m.cause));
    if (eligible.length) console.error(`${new Date().toISOString()} enqueue-on-event: feed ${eligible.map((m) => `${m.key} ${m.cause}`).join('; ')}`);
    h.notePoll(r);
    await h.tick();
    await new Promise((res) => { setTimeout(res, 5_000); });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exitCode = 1; });
}
