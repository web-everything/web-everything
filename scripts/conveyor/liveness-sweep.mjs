/**
 * Gather optional snapshots → core sweep() → print recovery plans. DRY-RUN by default.
 * --apply executes ENABLED rungs and writes the recovery ledger; only retry-self-update
 * and release-dead-lane are executable. A rung with requires is never executed. Nothing
 * loosens a gate or human-review requirement; maxRungAttempts escalates to the operator.
 * Flags: --apply, --json, --with-stale-state, --no-movement-store, --movement-store=,
 * --ledger=, --self-sync-dir=, --verify-log=. Reads shared PRs/gh, Claude agents,
 * daemon rebuild state/alerts, verify log, optional stale-state, settings and ledger.
 * Writes ~/.claude/liveness-sweep/pr-movement.json even in dry-run (unless disabled),
 * and recoveries.jsonl only in apply. Paths may be overridden by flags or WE_LIVENESS_SWEEP_*
 * environment variables. All IO is injectable; importing this module runs no sweep.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, realpathSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readSettings } from '../lib/settings-files.mjs';
import { platformPreference, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { cachedClaudeAgents } from '../lib/claude-agents-cache.mjs';
import { daemonCloneRoots } from '../lib/daemon-clone-registry.mjs';
import { cloneKey } from '../lib/daemon-overlays.mjs';
import { daemonStateDir } from '../lib/daemon-last-good.mjs';
import { withWriteLock } from '../lib/daemon-clone-lock.mjs';
import { readRebuildState, writeRebuildState } from '../lib/daemon-rebuild/state.mjs';
import { findLaneGatePidsDefault, releaseLaneByOperator, verifyJobsDir } from './verify-gate-job.mjs';
import { notifyDesktopChecked } from '../operations/operator-notify-io.mjs';
import { resolveLivenessSettings, LIVENESS_SWEEP_STANDARD, sweep, recoveryRecord, parseRebuildAlertsJsonl, parseVerifyHoldLines } from './liveness-sweep-core.mjs';

const message = e => String(e?.message ?? e);
const executable = new Set(['retry-self-update', 'release-dead-lane']);
export function loadSettings({ readTool = readSettings, readPlatform = platformPreference, env = process.env } = {}) {
  const envValues = {};
  for (const key of Object.keys(LIVENESS_SWEEP_STANDARD)) {
    const name = `WE_LIVENESS_SWEEP_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
    if (env[name] === undefined) continue;
    try { envValues[key] = key === 'rungs' ? JSON.parse(env[name]) : Number(env[name]); }
    catch { envValues[key] = env[name]; }
  }
  return resolveLivenessSettings({ tool: readTool()?.livenessSweep, platform: readPlatform('livenessSweep', { env }), envValues });
}
export function normalizePr(pr, repo = pr.repo) {
  return { ...pr, repo, labels: (pr.labels ?? []).map(l => ({ name: typeof l === 'string' ? l : l.name })),
    statusCheckRollup: (pr.statusCheckRollup ?? []).map(c => ({ name: c.name || c.context, conclusion: c.conclusion,
      status: c.status, completedAt: c.completedAt })),
    comments: (pr.comments ?? []).map(c => ({ createdAt: c.createdAt, author: { login: c.author?.login }, body: c.body })) };
}
export function prFingerprint(pr) {
  const latest = new Map();
  for (const c of pr.statusCheckRollup ?? []) {
    const name = c.name || c.context, prev = latest.get(name);
    if (!prev || (Date.parse(c.completedAt) || 0) >= (Date.parse(prev.completedAt) || 0)) latest.set(name, c);
  }
  return createHash('sha1').update(JSON.stringify([pr.headRefOid ?? '', (pr.labels ?? []).map(l => typeof l === 'string' ? l : l.name).sort(),
    [...latest].map(([name, c]) => `${name}=${c.conclusion ?? ''}`).sort()])).digest('hex');
}
export function stepMovement(store, prs, nowIso) {
  const next = {};
  const withMovement = prs.filter(p => (p.state ?? 'OPEN') === 'OPEN').map(p => {
    const key = `${p.repo}#${p.number}`, fp = prFingerprint(p), previous = store?.[key];
    const since = previous?.fp === fp ? previous.since : nowIso;
    next[key] = { fp, since };
    const { movementSince: ignored, ...pr } = p;
    return previous ? { ...pr, movementSince: since } : pr;
  });
  return { store: next, prs: withMovement };
}
export async function runSweep({ snapshot, settings, now, ledger = [], apply = false, executors = {}, notify, appendLedger }) {
  const results = [], rows = [...ledger];
  for (const { finding, plan } of sweep(snapshot, { settings, now, ledger: rows })) {
    let outcome = 'dry-run', detail;
    let recordPlan = plan;
    if (apply) {
      const escalation = plan.rung === 'notify-operator' ? plan : !plan.enabled ? plan.fallback : null;
      if (escalation) {
        recordPlan = escalation;
        if (rows.some(r => r.kind === finding.kind && r.subject === finding.subject && r.outcome === 'escalated' && Date.parse(r.at) >= Date.parse(finding.since))) {
          outcome = 'refused'; detail = { op: escalation.op, reason: 'already escalated this episode' };
        } else {
          detail = { op: escalation.op };
          try {
            const delivery = await notify(`${finding.kind}: ${finding.subject}`, `${finding.summary}\n${escalation.op}`);
            if (delivery?.ok === false) detail.error = delivery.error ?? 'notification failed';
          } catch (e) { detail.error = message(e); }
          outcome = 'escalated';
          const row = recoveryRecord({ finding, plan: recordPlan, outcome, detail, at: now });
          await appendLedger(row); rows.push(row);
        }
      } else if (plan.enabled && !plan.requires && executable.has(plan.rung) && executors[plan.rung]) {
        try { ({ outcome, detail } = await executors[plan.rung](finding)); }
        catch (e) { outcome = 'failed'; detail = message(e); }
        const row = recoveryRecord({ finding, plan, outcome, detail, at: now });
        await appendLedger(row); rows.push(row);
      } else { outcome = 'refused'; detail = 'rung is not executable'; }
    }
    results.push({ finding, plan, outcome, detail });
  }
  return { results };
}
export function createExecutors(deps = {}) {
  const lock = deps.withWriteLock ?? withWriteLock;
  const env = deps.env ?? process.env;
  const read = deps.readRebuildState ?? (clone => readRebuildState(clone, env));
  const write = deps.writeRebuildState ?? ((clone, state) => writeRebuildState(clone, state, env));
  const now = () => typeof deps.now === 'function' ? deps.now() : deps.now ?? new Date().toISOString();
  const refused = detail => ({ outcome: 'refused', detail });
  return {
    async 'retry-self-update'(finding) {
      const clone = finding.evidence?.clone;
      if (!clone) return refused('clone root unknown');
      const result = await lock(clone, async () => {
        const st = await read(clone);
        if (!st?.rejected) return refused('no rejection recorded any more');
        if (st.rejected.retryAt) return refused('a retry is already scheduled');
        st.rejected.retryAt = now(); st.rejected.retryScheduledBy = 'system:liveness-sweep';
        await write(clone, st);
        return { outcome: 'succeeded', detail: 'retry scheduled: the next rebuild tick re-smokes these inputs; adoption still requires a passing smoke' };
      }, { waitMs: 60_000 });
      return result.ok ? result.value : refused(result.reason);
    },
    async 'release-dead-lane'(finding) {
      const e = finding.evidence ?? {};
      if (!e.dir || e.finished === false) return refused('lane directory unknown or job unfinished');
      let pids;
      try { pids = await (deps.findLaneGatePidsDefault ?? findLaneGatePidsDefault)(e.dir); }
      catch { return refused('ps unreadable — cannot prove'); }
      if (!Array.isArray(pids)) return refused('ps unreadable — cannot prove');
      if (pids.length) return refused(`a gate process for this lane is running: ${pids.join(', ')}`);
      const result = await (deps.releaseLaneByOperator ?? releaseLaneByOperator)({ jobsDir: (deps.verifyJobsDir ?? (() => verifyJobsDir(env)))(), dir: e.dir, who: 'system:liveness-sweep' });
      if (result.refused) return refused(result.refused);
      if (result.claim == null && result.setAside.length === 0) return refused('nothing held');
      return { outcome: 'succeeded', detail: { claim: result.claim, setAside: result.setAside, stillHeld: result.stillHeld } };
    },
  };
}

/** Bounded tail reads, including a possibly partial first line (parsers skip it). */
export function readTail(path, bytes) {
  const fd = openSync(path, 'r');
  try { const size = fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, bytes));
    const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - bytes)); return buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
export const parseLedger = text => String(text).split(/\r?\n/).flatMap(line => {
  try { const row = JSON.parse(line); return row && typeof row === 'object' && !Array.isArray(row) ? [row] : []; } catch { return []; }
});
export async function gatherSnapshot(options = {}, deps = {}) {
  const home = (deps.homedir ?? homedir)(), env = deps.env ?? process.env;
  const read = deps.readFile ?? readFileSync, tail = deps.readTail ?? readTail, exec = deps.execFileSync ?? execFileSync;
  const errors = [], snapshot = { prs: [], agents: [], rebuildAlerts: [], rebuildStates: [], verifyHolds: [], staleRecords: [] };
  const optional = async (source, fn) => { try { return await fn(); } catch (e) { if (e?.code !== 'ENOENT') errors.push({ source, error: message(e) }); } };
  const fields = 'number,title,headRefOid,labels,statusCheckRollup,updatedAt,isDraft,comments';
  const completeRepos = new Set();
  for (const { slug: repo } of Object.values(deps.repos ?? CONSTELLATION_REPOS)) {
    let prs = await optional(`prs:${repo}:shared`, () => (deps.readSharedOpenPrs ?? readSharedOpenPrs)({ repo, fields: fields.split(','), env }));
    if (prs == null) prs = await optional(`prs:${repo}:gh`, () => JSON.parse(exec('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', fields], { encoding: 'utf8', timeout: 60_000 })));
    if (Array.isArray(prs)) { snapshot.prs.push(...prs.map(p => normalizePr(p, repo))); completeRepos.add(repo); }
    else errors.push({ source: `prs:${repo}`, error: 'non-array PR result; repo skipped' });
  }
  await optional('agents', () => {
    const agents = JSON.parse((deps.cachedClaudeAgents ?? cachedClaudeAgents)({ env, fetch: () => exec('claude', ['agents', '--json'], { cwd: home, encoding: 'utf8', timeout: 60_000 }) }));
    snapshot.agents = agents.map(({ name, state }) => ({ name, state }));
  });
  const roots = await optional('clone-roots', () => (deps.daemonCloneRoots ?? daemonCloneRoots)(join(home, 'workspace'), { env })) ?? [];
  for (const entry of roots) {
    await optional('clone', async () => {
      const root = typeof entry === 'string' ? entry : entry.root, key = (deps.cloneKey ?? cloneKey)(root);
      const stateDir = options.selfSyncDir ?? (deps.daemonStateDir ?? daemonStateDir)(env);
      await optional(`rebuild:${key}`, () => { snapshot.rebuildStates.push({ ...JSON.parse(read(join(stateDir, `${key}.rebuild.json`), 'utf8')), cloneKey: key, clone: root }); });
      await optional(`alerts:${key}`, () => { snapshot.rebuildAlerts.push(...parseRebuildAlertsJsonl(tail(join(stateDir, `${key}.alerts.jsonl`), 256 * 1024), { cloneKey: key }).map(a => ({ ...a, clone: root }))); });
    });
  }
  await optional('verify-log', () => { snapshot.verifyHolds = parseVerifyHoldLines(tail(options.verifyLog ?? join(home, 'workspace/.operations/coordination/verify-daemon.log'), 512 * 1024)).map(h => ({ ...h, dir: h.dir.startsWith('~/') ? join(home, h.dir.slice(2)) : h.dir })); });
  if (options.withStaleState) await optional('stale-state', () => {
    const runner = fileURLToPath(new URL('../operations/run.mjs', import.meta.url));
    const records = JSON.parse(exec(process.execPath, [runner, 'stale-state', '--json'], { encoding: 'utf8', timeout: 240_000 })).verdict?.records;
    if (!Array.isArray(records)) throw new Error('non-array stale-state records');
    snapshot.staleRecords = records;
  });
  const ledger = await optional('ledger', () => parseLedger(read(options.ledger, 'utf8'))) ?? [];
  if (!options.noMovementStore) {
    const store = await optional('movement-store:read', () => JSON.parse(read(options.movementStore, 'utf8'))) ?? {};
    const stepped = stepMovement(store, snapshot.prs, options.now);
    snapshot.prs = stepped.prs;
    // A failed PR source is unknown, not proof that its PRs closed.
    for (const [key, value] of Object.entries(store)) if (!completeRepos.has(key.slice(0, key.lastIndexOf('#')))) stepped.store[key] = value;
    await optional('movement-store:write', () => (deps.writeMovementStore ?? writeJson)(options.movementStore, stepped.store));
  }
  return { snapshot, ledger, errors };
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`); renameSync(temp, path);
}
function appendRecovery(path, row) { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(row)}\n`); }
export function formatEt(at) {
  return `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(at))} ET`;
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? console.log, stderr = deps.stderr ?? console.error;
  try {
    const env = deps.env ?? process.env, home = (deps.homedir ?? homedir)();
    const options = { ledger: env.WE_LIVENESS_SWEEP_LEDGER ?? join(home, '.claude/liveness-sweep/recoveries.jsonl'), movementStore: env.WE_LIVENESS_SWEEP_MOVEMENT_STORE ?? join(home, '.claude/liveness-sweep/pr-movement.json') };
    const flags = { '--apply': 'apply', '--json': 'json', '--with-stale-state': 'withStaleState', '--no-movement-store': 'noMovementStore' };
    const paths = { '--ledger': 'ledger', '--movement-store': 'movementStore', '--self-sync-dir': 'selfSyncDir', '--verify-log': 'verifyLog' };
    for (const arg of argv) {
      if (flags[arg]) options[flags[arg]] = true;
      else { const i = arg.indexOf('='), key = paths[arg.slice(0, i)];
        if (i < 0 || !key || !arg.slice(i + 1)) throw new Error(`Unknown argument: ${arg}`);
        options[key] = arg.slice(i + 1);
      }
    }
    for (const key of Object.values(paths)) if (options[key]?.startsWith('~/')) options[key] = join(home, options[key].slice(2));
    options.now = typeof deps.now === 'function' ? deps.now() : deps.now ?? new Date().toISOString();
    const resolved = loadSettings(deps);
    const { snapshot, ledger, errors } = await (deps.gatherSnapshot ?? gatherSnapshot)(options, deps);
    const { results } = await runSweep({ snapshot, ledger, settings: resolved.settings, now: options.now, apply: options.apply,
      executors: deps.executors ?? createExecutors({ ...deps, now: options.now, env: options.selfSyncDir ? { ...env, WE_DAEMON_STATE_DIR: options.selfSyncDir } : env }),
      notify: deps.notify ?? ((title, body) => notifyDesktopChecked({ title, body })),
      appendLedger: deps.appendLedger ?? (row => appendRecovery(options.ledger, row)) });
    const mode = options.apply ? 'APPLY' : 'DRY RUN';
    if (options.json) stdout(JSON.stringify({ mode, now: options.now, ...resolved, findings: results, errors }));
    else {
      stdout(`liveness-sweep · ${mode} · ${formatEt(options.now)}`);
      stdout(formatCascadeSourcesLine('livenessSweep', { value: resolved.settings, sources: resolved.sources, invalid: resolved.invalid }));
      for (const { finding: f, plan: p, outcome } of results) {
        stdout(`${f.kind}  ${f.subject}  stuck since ${formatEt(f.since)} (${Math.round(f.ageMinutes)}m)`);
        stdout(`  → ${p.rung} [${p.requires ? `requires ${p.requires}` : p.enabled ? 'enabled' : 'off'}] ${p.op}`);
        stdout(`  outcome: ${outcome}`);
      }
      stdout(`${results.length} finding(s)`);
      for (const e of errors) stdout(`error: ${e.source}: ${e.error}`);
    }
    return 0;
  } catch (e) { stderr(message(e)); return 1; }
}
export function isCliEntry(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  let resolved = resolve(argv1);
  try { resolved = realpathSync(argv1); } catch { /* compare resolved spelling */ }
  return moduleUrl === pathToFileURL(resolved).href;
}
if (isCliEntry()) process.exitCode = await main();
