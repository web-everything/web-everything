#!/usr/bin/env node
/**
 * @file scripts/operations/start-build.mjs
 * @description `start-build` (item 104) — START A BUILD THAT OUTLIVES THE CHAT SESSION.
 *
 *   node scripts/operations/start-build.mjs start  --num=<card> [--provider=codex|claude-restricted] [--dry-run] [--json]
 *   node scripts/operations/start-build.mjs status [--num=<card>] [--json]
 *
 * WHY. Builds used to start only when a chat session dispatched an in-session Agent worker, so a chat that went
 * idle left free capacity unused (2026-10-07 ~05:00-10:30Z). This operation launches the SAME durable job the
 * conveyor's own build dispatch launches (`dispatch-providers/build.mjs`: `deliver-item-run.mjs`, spawned
 * detached with `setsid`, log to a file, `pid:<n>` handle) from a prepared card, with nothing about the chat
 * required afterwards. It invents no runner. `deliver-item-run` / `deliver-item-wrapper` already own:
 *   - the lane (acquired, and RELEASED on every exit path),
 *   - the item claim (taken, released on a non-PR outcome),
 *   - the build brief and the Codex-default / Claude-fallback executor (`resolveOperationRoute('build')`),
 *     which applies when this launcher passes no `--provider`.
 * What this launcher adds is only what a chat start needs and the tick otherwise supplies:
 *   1. card checks (exists, `status: open`, has a `scope:`),
 *   2. the Rule 26 scope check (`free-scope`: no open PR or live agent holds the card's files),
 *   3. the build-dispatch claim (so the conveyor tick cannot double-dispatch the same item),
 *   4. a free lane number,
 *   5. a durable job record the chat and `/state` read ({@link ./start-build-jobs.mjs}).
 * Any refusal happens BEFORE anything is claimed or spawned. A failure after the claim releases it again.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normNum } from '../conveyor/queue-store.mjs';
import { mintSessionSlug } from '../conveyor/session-slug.mjs';
import { acquireBuildDispatchClaim, releaseBuildDispatchClaim } from '../conveyor/build-dispatch-claim.mjs';
import { assessFreeScope } from './free-scope.mjs';
import { collectFreeScope, findCardFile, readCardScope } from './free-scope-io.mjs';
import { REPO_ROOT, defaultSpawnDetached, DETACHED_HANDLE_PREFIX } from './detached-dispatch.mjs';
import { DELIVERY_AGENT_PROVIDER_NAMES } from './deliver-item-wrapper.mjs';
import { describeJob, jobsDir, listJobs, readJob, renderJob, writeJob } from './start-build-jobs.mjs';

export const DELIVER_ITEM_RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'deliver-item-run.mjs');

/** PURE. Frontmatter `status:` of a card's text, or null. */
export function cardStatus(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))?.[1] ?? '';
  const m = /^status:\s*([A-Za-z-]+)/m.exec(fm);
  return m ? m[1] : null;
}

/**
 * PURE. First lane number that exists, is not leased, is clean, and passes `isSafe` (the io's proof that the
 * lane holds no unpushed commits: acquiring a lane resets it to origin/main, which would destroy them — the
 * first live launch of this operation hit exactly that on an unleased lane that was 3 commits ahead).
 */
export function pickFreeLane(statusDoc, { exclude = [], isSafe = () => true } = {}) {
  const lanes = Array.isArray(statusDoc?.lanes) ? statusDoc.lanes : [];
  const free = lanes.filter((l) => l?.exists !== false && !l?.leased && l?.clean !== false && !exclude.includes(l.lane) && isSafe(l));
  return free.length ? Number(free[0].lane) : null;
}

/**
 * PURE planner: every refusal in one place, in the order they are checked. Returns `{ok:true}` or
 * `{ok:false, refusal, detail}`; it never throws on bad state, so a refusal is a normal, testable result.
 */
export function planStartBuild({ num, card, scope, provider, free, lane, claim }) {
  if (!num) return { ok: false, refusal: 'no-item', detail: '--num=<card> is required' };
  if (!card?.found) return { ok: false, refusal: 'card-not-found', detail: `no backlog card for #${num}` };
  if (card.status !== 'open') return { ok: false, refusal: 'not-open', detail: `card #${num} is status:${card.status} (only open cards are built)` };
  if (!Array.isArray(scope) || !scope.length) return { ok: false, refusal: 'no-scope', detail: `card #${num} has no scope:` };
  if (provider && !DELIVERY_AGENT_PROVIDER_NAMES.includes(provider)) {
    return { ok: false, refusal: 'bad-provider', detail: `--provider must be one of ${DELIVERY_AGENT_PROVIDER_NAMES.join('|')}` };
  }
  if (free?.status !== 'free') {
    return { ok: false, refusal: free?.status === 'unknown' ? 'scope-unknown' : 'scope-occupied', detail: free?.headline ?? 'scope not proven free (Rule 26)' };
  }
  if (lane == null) return { ok: false, refusal: 'no-free-lane', detail: 'no unleased lane in the pool' };
  if (claim && claim.ok === false) return { ok: false, refusal: 'claim-held', detail: `build claim for #${num} is held${claim.heldBy ? ` by ${claim.heldBy}` : ''}` };
  return { ok: true };
}

const defaultIo = () => ({
  root: REPO_ROOT,
  now: () => new Date(),
  readCard(num, root) {
    const file = findCardFile(num, { root });
    if (!file) return { found: false };
    return { found: true, file, status: cardStatus(readFileSync(file, 'utf8')) };
  },
  readScope: (num, root) => { try { return readCardScope(num, { root }); } catch { return []; } },
  checkFree: (num, root) => { const snap = collectFreeScope({ card: String(num), root }); return assessFreeScope(snap); },
  freeLane() {
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'lane-pool.mjs'), 'status', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    const isSafe = (l) => {
      try { execFileSync('git', ['-C', l.path, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { stdio: 'ignore' }); return true; } catch { return false; }
    };
    return pickFreeLane(JSON.parse(out), { isSafe });
  },
  acquireClaim: (num, scope) => acquireBuildDispatchClaim({ num, scope }),
  releaseClaim: (num) => releaseBuildDispatchClaim({ num }),
  spawnDetached: defaultSpawnDetached,
  // Under the durable jobs dir, NOT the checkout's `.operations/`: the log must survive this checkout (a lane)
  // being released and reset while the build still runs.
  logPathFor: (slug) => join(jobsDir(), 'logs', `${slug}.log`),
  writeJob,
  readJob,
});

/**
 * A job whose process is gone WITHOUT a PR outcome (`failed` or `ended`) leaves the build-dispatch claim this
 * launcher took (the wrapper dies before it owns the claim when e.g. lane acquire is refused). Release it, once,
 * and record that, so a dead job never keeps the item locked for the claim's 4h lease. A `finished` job is left
 * alone: the wrapper itself released (non-PR) or deliberately kept (PR) the claim.
 */
export function settleDeadJob(described, io) {
  if (!described || !['failed', 'ended'].includes(described.status) || described.claimReleased) return false;
  try { io.releaseClaim(described.id); } catch { return false; }
  try { io.writeJob({ ...stripView(described), claimReleased: true }); } catch { /* record is advisory */ }
  return true;
}
const stripView = ({ status, detail, ...job }) => job;

/**
 * Start one durable build. `dryRun` runs every check and stops before the claim.
 * @returns {{ok:boolean, refusal?:string, detail?:string, job?:object, dryRun?:boolean}}
 */
export function startBuild({ num: rawNum, provider = '', dryRun = false } = {}, ioOverrides = {}) {
  const io = { ...defaultIo(), ...ioOverrides };
  const num = normNum(rawNum);
  const existing = num ? io.readJob(num) : null;
  if (existing && !dryRun) {
    const live = describeJob(existing, { isPidAlive: io.isPidAlive });
    if (live?.status === 'running') return { ok: false, refusal: 'already-running', detail: renderJob(live) };
    settleDeadJob(live, io);
  }
  const card = num ? io.readCard(num, io.root) : { found: false };
  const scope = card.found ? io.readScope(num, io.root) : [];
  let free = null; let lane = null;
  const pre = planStartBuild({ num, card, scope, provider, free: { status: 'free' }, lane: 0 });
  if (!pre.ok) return pre;
  try { free = io.checkFree(num, io.root); } catch (e) { free = { status: 'unknown', headline: `scope check failed: ${String(e?.message ?? e).split('\n')[0]}` }; }
  try { lane = io.freeLane(); } catch { lane = null; }
  const plan = planStartBuild({ num, card, scope, provider, free, lane });
  if (!plan.ok) return plan;
  if (dryRun) return { ok: true, dryRun: true, job: { id: num, lane, scope, provider: provider || null } };

  const claim = io.acquireClaim(num, scope);
  if (claim?.ok === false) return planStartBuild({ num, card, scope, provider, free, lane, claim });
  try {
    const sessionSlug = mintSessionSlug({ kind: 'conveyor', id: num });
    const argv = [DELIVER_ITEM_RUN_SCRIPT, `--num=${num}`, `--lane=${lane}`, `--session=${sessionSlug}`, `--scope=${scope.join(',')}`, '--attempt='];
    if (provider) argv.push(`--provider=${provider}`);
    const logPath = io.logPathFor(sessionSlug);
    const child = io.spawnDetached(argv, { cwd: io.root, logPath });
    const pid = Number(child?.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('node reported no pid for the build wrapper');
    const job = { id: num, kind: 'build', session: sessionSlug, lane, scope, provider: provider || null,
      handle: `${DETACHED_HANDLE_PREFIX}${pid}`, logPath, startedAt: io.now().toISOString() };
    io.writeJob(job);
    return { ok: true, job };
  } catch (e) {
    try { io.releaseClaim(num); } catch { /* best effort: the claim lease expires on its own */ }
    return { ok: false, refusal: 'spawn-failed', detail: String(e?.message ?? e) };
  }
}

function parse(argv) {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'start';
  const flags = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? 'true';
  }
  return { cmd, flags };
}

export function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), io = {} } = {}) {
  const { cmd, flags } = parse(argv);
  if (cmd === 'status') {
    const jobs = flags.num ? [readJob(normNum(flags.num))].filter(Boolean) : listJobs();
    const full = { ...defaultIo(), ...io };
    const described = jobs.map((j) => describeJob(j, { isPidAlive: full.isPidAlive }));
    for (const d of described) if (settleDeadJob(d, full)) d.claimReleased = true;
    out(flags.json ? JSON.stringify(described, null, 2) : (described.map(renderJob).join('\n') || 'no durable build jobs'));
    return 0;
  }
  if (cmd !== 'start') { err('Usage: start-build.mjs start --num=<card> [--provider=<name>] [--dry-run] [--json] | status [--num=<card>] [--json]'); return 2; }
  const result = startBuild({ num: flags.num, provider: flags.provider || '', dryRun: flags['dry-run'] === 'true' }, io);
  if (flags.json) out(JSON.stringify(result, null, 2));
  else if (result.ok) out(result.dryRun ? `start-build: #${result.job.id} would start in lane ${result.job.lane} (dry run, nothing claimed)` : `start-build: #${result.job.id} started — ${result.job.handle}, lane ${result.job.lane}, log ${result.job.logPath}`);
  else err(`start-build: refused (${result.refusal}) — ${result.detail}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
