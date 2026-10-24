#!/usr/bin/env node
/**
 * @file scripts/conveyor/pr-sweep.mjs
 * @description Card 335 — bounded IO shell for the health-watch PR movement job. CLI: run [--dry-run] [--json].
 */
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, appendFileSync, readdirSync, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cascadePolicy, formatCascadeSourcesLine, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug, ghRepoSlug } from '../lib/constellation-repos.mjs';
import { daemonCloneRoots } from '../lib/daemon-clone-registry.mjs';
import { workspaceOf } from '../lib/automation-home.mjs';
import { healthDir } from './health-watch-section.mjs';
import { handoffHome } from '../operations/handoff-home.mjs';
import { notifyDesktopChecked } from './branch-sync.mjs';
import { flushDigest } from '../lib/quiet-hours-io.mjs';
import { classifyIdlePrs, resolveOwner, planSweep, prKey, isRunningSession } from './pr-sweep-core.mjs';
import { runStallSweep } from './pr-stall-sweep.mjs';
import { publishStalledDigest } from './pr-stall-digest.mjs';
import { runDetector } from './pr-stall-detector.mjs';
const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '../..');
const exec = promisify(execFile);
const command = async (bin, args, env) => (await exec(bin, args, { env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })).stdout;
const DEFAULTS = { enabled: true, intervalMinutes: 30, idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, sessionActiveWithinMinutes: 30, dispatchDiagnosis: false, repos: [CONSTELLATION_REPOS.we.slug, CONSTELLATION_REPOS['plateau-app'].slug] };
export function resolvePrSweepSettings({ config = {}, env = process.env, read = readFileSync, log = console.error } = {}) {
  const errors = []; let tool = {};
  try { tool = JSON.parse(read(join(ROOT, 'scripts/settings/pr-sweep.json'), 'utf8')).prSweep; } catch (e) { errors.push(`settings: ${e.message}`); }
  const envValues = {};
  for (const k of Object.keys(DEFAULTS)) {
    const raw = env[`WE_PR_SWEEP_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`];
    if (raw === undefined) continue;
    envValues[k] = typeof DEFAULTS[k] === 'boolean' ? (['1', 'true'].includes(raw) ? true : ['0', 'false'].includes(raw) ? false : raw)
      : k === 'repos' ? raw.split(',').map((v) => v.trim()) : Number(raw);
  }
  const valid = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, (v) => typeof DEFAULTS[k] === 'boolean' ? typeof v === 'boolean'
    : k === 'repos' ? Array.isArray(v) && v.length > 0 && v.every((r) => repoKeyForSlug(r) !== null) : Number.isFinite(v) && v > 0]));
  const platform = readPlatformPreferences({ env, readFile: read }); errors.push(...platform.errors);
  const out = cascadePolicy('prSweep', { ...tool, ...config.prSweep }, { standard: DEFAULTS, envValues, valid, platform: platform.prefs.prSweep ?? {}, env });
  log(formatCascadeSourcesLine('prSweep', out));
  out.value.repos = out.value.repos.map(ghRepoSlug);
  return { ...out, errors: [...errors, ...out.invalid] };
}
/** Read at most the last 2 MB; never load whole daemon logs. */
export function readLogTail(path) {
  const fd = openSync(path, 'r');
  try { const size = fstatSync(fd).size; const start = Math.max(0, size - 2 * 1024 * 1024); const buf = Buffer.alloc(size - start); const n = readSync(fd, buf, 0, buf.length, start); const text = buf.subarray(0, n).toString('utf8'); return start ? text.slice(text.indexOf('\n') + 1) : text; } finally { closeSync(fd); }
}
const mentions = (text, pr, defaultRepo = 'we') => {
  const key = repoKeyForSlug(pr.repo);
  // Qualified references take precedence, so identical PR numbers in different repos do not cross-bind.
  const refs = [...String(text).matchAll(/(?<![\w./-])(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+|we|plateau-app|frontierui)(?:[ \t]*(?:PR[ \t]*)?#|\/pull\/)(\d+)(?!\d)/gi)];
  if (refs.length) return refs.some(([, repo, n]) => repoKeyForSlug(repo.toLowerCase()) === key && Number(n) === Number(pr.number));
  return key === defaultRepo && new RegExp(`(?:fix(?:ing)?-|#)${pr.number}(?!\\d)`).test(text);
};
// Both dispatchers log failed attempts every tick; none proves that work began.
const isDispatchRefusal = (line) => /\b(?:refus(?:ed|al|ing)|not dispatched|no review dispatched|failed)\b/i.test(line);
// A reference alone may be a ranking, held item or repeated note. Require an
// actual work event so new diagnostic wording cannot silently renew ownership.
const isDaemonProgress = (line) => !isDispatchRefusal(line)
  && !/\b(?:scope-rank|note(?:-comment)?|dry-run|would|skipp(?:ed|ing)|held|waiting)\b/i.test(line)
  && /\b(?:start(?:ed|ing)|dispatched|promoted|merged|landed|applied|pushed|resumed|rebased|tagged)\b/i.test(line);
/** The reconcile agent listing, carrying the wrapped store's unreadable records as `incomplete`. */
export async function readSweepAgents({ env, listWrapped, readRows } = {}) {
  listWrapped ??= (await import('../operations/worker-wrapper-launch.mjs')).listWrappedWorkerAgents;
  readRows ??= async () => {
    const { defaultReadAgents, enrichAgents } = await import('./reconcile-pass.mjs');
    return enrichAgents(defaultReadAgents({ env }));
  };
  // The merged listing drops `incomplete` while mapping, so ask the wrapped store
  // after the rows: a record unreadable there, or listed there but missing from
  // the rows (torn during the row read), is a gap scoped to its session.
  const rows = await readRows();
  if (!Array.isArray(rows)) return rows;
  const wrapped = listWrapped() ?? [];
  const names = new Set(rows.map((a) => a?.name));
  const gaps = [...(wrapped.incomplete ?? []), ...wrapped.filter((w) => w?.name && !names.has(w.name))
    .map((w) => ({ reason: `wrapped session ${w.name} missing from the agent listing`, session: w.name }))];
  return gaps.length ? Object.defineProperty(rows, 'incomplete', { value: gaps }) : rows;
}
export async function collectOwnerSignals({ prs, dir, env, errors, sourceRoot = ROOT,
  readAgents = () => readSweepAgents({ env }), readActivity = async (agent) => {
    const { readTranscriptTailActivity } = await import('./hung-session.mjs');
    return readTranscriptTailActivity(agent, { tailLines: 15, maxBytes: 400_000, fieldMax: 200 })?.lastActivityMs ?? null;
  }, readHealth = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')),
  cloneRoots = () => daemonCloneRoots(workspaceOf(sourceRoot)), listLogs = readdirSync, readTail = readLogTail,
}) {
  let sessions = []; let health = {}; const logs = []; let unreadSessions = [];
  const guarded = async (name, fn, fallback) => { try { return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return fallback; } };
  sessions = await guarded('agents', async () => {
    const rows = await readAgents(); if (!Array.isArray(rows)) throw new Error('expected agent array');
    // A session missing from a partial listing is unknown, not gone. A gap naming a
    // session affects only the PR that name binds to (if any); a gap with no name
    // fails the whole read.
    const gaps = rows.incomplete ?? [];
    const unscoped = gaps.filter((g) => typeof g?.session !== 'string' || !g.session);
    if (unscoped.length) throw new Error(`agent listing incomplete: ${unscoped.map((g) => g?.reason ?? g).join('; ')}`);
    unreadSessions = gaps.map((g) => g.session);
    // A transcript that cannot be read leaves activity unknown, not stale.
    return Promise.all(rows.map(async (a) => {
      if (!isRunningSession(a)) return a;
      let at = null; try { at = await readActivity(a); } catch { at = null; }
      return Number.isFinite(at) ? { ...a, lastActivityAt: at } : { ...a, lastActivityAt: null, activityUnknown: true };
    }));
  }, []);
  health = await guarded('health state', async () => { const state = await readHealth(); if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('expected health object'); return state; }, {});
  const roots = await guarded('daemon roots', cloneRoots, []);
  const dirs = [...new Set([...roots.map((r) => join(r, '.conveyor')), ...(env.HEALTH_WATCH_LOGS_DIR ? [env.HEALTH_WATCH_LOGS_DIR] : [])])];
  for (const d of dirs) {
    // Absent clones have no signals; an existing but unreadable directory is a failed owner read.
    let files;
    try { files = listLogs(d); } catch (e) { if (e.code !== 'ENOENT') errors.push(`logs ${d}: ${e.message}`); continue; }
    for (const name of files.filter((n) => /^(fix-dispatch-daemon|review-daemon)\.log$|drain.*\.log$|^pass-daemon\.merge-orphan-sweep\.log$/.test(n))) {
      const text = await guarded(`log ${name}`, () => readTail(join(d, name)), '');
      logs.push({ name: basename(name, '.log'), text, repo: /plateau/.test(d) ? 'plateau-app' : 'we' });
    }
  }
  return Object.fromEntries(prs.map((pr) => {
    const daemons = [];
    for (const log of logs) for (const line of log.text.split('\n')) {
      if (!mentions(line, pr, log.repo)) continue;
      const stamp = line.match(/^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))/)?.[1];
      if (stamp && Number.isFinite(Date.parse(stamp))) daemons.push({ name: log.name, at: stamp,
        ...(isDaemonProgress(line) ? { kind: 'progress' } : { kind: isDispatchRefusal(line) ? 'refusal' : 'diagnostic', reason: line }) });
    }
    for (const [name, data] of Object.entries(health.daemons ?? {})) for (const [ref, refusal] of Object.entries(data.prRefusals ?? {})) {
      if (mentions(ref, pr)) daemons.push({ name, at: refusal.at, kind: 'refusal', reason: refusal.reason });
    }
    const episode = Object.values(health.episodes ?? {}).find((e) => ['open', 'flapping'].includes(e.status)
      && ['fixer-stuck', 'fix-claim-held-no-progress', 'ruling-needed-waiting'].includes(e.smell) && mentions(`${e.subject} ${JSON.stringify(e.measure)}`, pr));
    return [prKey(pr), { sessions, daemons, smell: episode?.smell, unreadSessions }];
  }));
}
export async function runPrSweep({ now = Date.now(), dryRun = false, env = process.env, dir = healthDir(undefined, env), config,
  settings, sourceRoot = ROOT, readPrs, readQueue, readSignals = collectOwnerSignals, readPrevious,
  notify = notifyDesktopChecked, diagnose, persist, append, flush = flushDigest, stallSweep = runStallSweep, stallDigest = publishStalledDigest } = {}) {
  const errors = [];
  const safe = async (name, fn, fallback) => { try { return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return fallback; } };
  if (!config && !settings) config = await safe('health config', () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')), {});
  const resolved = settings ?? resolvePrSweepSettings({ config, env }); errors.push(...(resolved.errors ?? []));
  const value = resolved.value;
  if (settings) console.error(formatCascadeSourcesLine('prSweep', resolved));
  const previous = await safe('previous sweep', () => readPrevious ? readPrevious() : (existsSync(join(dir, 'pr-sweep.json')) ? JSON.parse(readFileSync(join(dir, 'pr-sweep.json'), 'utf8')).nextState : {}), {});
  const prs = []; let prsReadOk = true;
  for (const repo of value.repos) {
    const rows = await safe(`prs ${repo}`, async () => readPrs ? readPrs(repo) : JSON.parse(await command('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number,title,labels,isDraft,updatedAt,headRefOid'], env)), null);
    if (!Array.isArray(rows) || rows.some((p) => !p || !Number.isInteger(Number(p.number)) || Number(p.number) <= 0 || !Number.isFinite(Date.parse(p.updatedAt)) || typeof p.headRefOid !== 'string')) {
      if (rows !== null) errors.push(`prs ${repo}: invalid PR listing`);
      prsReadOk = false; continue;
    }
    prs.push(...rows.map((p) => ({ ...p, repo })));
  }
  const queue = await safe('operator queue', async () => readQueue ? readQueue() : JSON.parse(await command(process.execPath, [join(ROOT, 'scripts/operations/operator-queue.mjs'), '--json'], env)), null);
  const queueOk = queue && !queue.incomplete && !(queue.errors?.length) && Array.isArray(queue.ready) && Array.isArray(queue.rulingNeeded)
    && [...queue.ready, ...queue.rulingNeeded].every((p) => p && repoKeyForSlug(p.repo) !== null && Number.isInteger(Number(p.number)) && Number(p.number) > 0);
  if (queue && !queueOk) errors.push(`operator queue incomplete: ${JSON.stringify(queue.errors ?? [])}`);
  const needsYou = queueOk ? [...queue.ready, ...queue.rulingNeeded].map((p) => ({ ...p, repo: CONSTELLATION_REPOS[repoKeyForSlug(p.repo)]?.slug ?? p.repo })) : null;
  const idle = classifyIdlePrs({ prs, now, idleMinutes: value.idleMinutes });
  const before = errors.length;
  const signals = await safe('owner signals', () => readSignals({ prs: idle, now, dir, env, errors, sourceRoot }), {});
  const ownerReadsOk = errors.length === before && queueOk;
  const owners = Object.fromEntries(idle.map((p) => [prKey(p), resolveOwner(p, { ...value, now, ...(signals ?? {})[prKey(p)], operator: needsYou?.some((n) => prKey(n) === prKey(p)) })]));
  const planned = planSweep({ idle, owners, prevState: previous ?? {}, needsYou, now, settings: value, ownerReadsOk, prsReadOk });
  const report = { at: new Date(now).toISOString(), settings: value, sources: resolved.sources, ...planned.report, alerts: planned.alerts, diagnose: planned.diagnose, nextState: planned.nextState, errors };
  const detect = async () => {
    const out = await runDetector({ prs, seen: previous?.stallDetector ?? {}, now, env,
      readSignals: ({ prs }) => readSignals({ prs, now, dir, env, errors: detectorErrors, sourceRoot }) });
    detectorErrors.push(...out.errors);
    errors.push(...detectorErrors.map(e => `stall detector: ${e}`));
    report.stallDetector = { enabled: out.enabled, stalled: out.items.length, ...(dryRun ? { items: out.items } : {}) };
    // A PR the detector could not read keeps its saved clock, so recovery does not restart its age.
    const keptOld = Object.fromEntries(Object.entries(previous?.stallDetector ?? {}).filter(([k]) => out.errors.some(e => k.includes(`#${String(e).split(':')[0]}@`))));
    report.nextState.stallDetector = prsReadOk ? { ...keptOld, ...out.nextSeen } : previous?.stallDetector ?? {};
    return out;
  };
  const detectorErrors = [];
  report.nextState.stallDetector = previous?.stallDetector ?? {}; // the first save must not drop saved clocks
  if (!dryRun) {
    await safe('quiet digest', () => flush({ send: (n) => notify(n, { quietGate: null }) }));
    let needsYouSendFailed = false;
    for (const alert of report.alerts) {
      const sent = await safe('notification', async () => { const out = await notify(alert); if (!out?.ok) throw new Error(out?.error ?? out?.reason ?? 'notification failed'); return true; });
      if (!sent && alert.kind === 'pr-stuck') report.nextState.episodes[alert.key].alerted = false;
      if (!sent && alert.kind === 'needs-you') needsYouSendFailed = true;
    }
    if (needsYouSendFailed) report.nextState.needsYou = previous.needsYou;

    report.nextState.stallSweep = previous?.stallSweep ?? {};
    for (const repo of report.diagnose) await safe(`diagnose ${repo}`, () => diagnose ? diagnose(repo) : command(process.execPath, [join(ROOT, 'scripts/conveyor/stuck-pr-watch.mjs'), 'sweep', `--repo=${repo}`], env));
    await safe('handoff log', () => {
      const at = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'medium' }).format(now);
      const line = `${at} ET idle=${idle.length} needsYou=${needsYou?.length ?? '?'} alerts=${report.alerts.length} errors=${errors.length} ${report.idle.map((p) => `${prKey(p)}=${p.owner ?? 'none'}(${p.state})`).join(' ')}\n`;
      if (append) return append(line); const home = handoffHome(); mkdirSync(home, { recursive: true }); appendFileSync(join(home, 'pr-sweep.log'), `${line.trimEnd().replace(/[\r\n]/g, ' ')}\n`);
    });
    const write = () => safe('report write', () => {
      if (persist) return persist(report); mkdirSync(dir, { recursive: true }); const dest = join(dir, 'pr-sweep.json'); const tmp = `${dest}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`); renameSync(tmp, dest);
    });
    await write();
    // The automatic stall sweep (shadow until slice 5) runs AFTER this sweep's own state is saved, so a slow or failing
    // stall pass can never cost the card-335 sweep its state. It keeps its own `prStallSweep.intervalMinutes`.
    const stalled = await safe('stall sweep', async () => {
      const out = await safe('stall sweep', () => stallSweep({ now, env, state: previous?.stallSweep ?? {} }),
        { mode: 'off', incomplete: true });
      const detector = await detect();
      report.nextState.stallSweep = out.state ?? report.nextState.stallSweep;
      report.stallSweep = { mode: out.mode, skipped: out.skipped ?? null, wouldDo: out.act?.length ?? 0, incomplete: out.incomplete ?? null,
        lanes: Object.fromEntries(['system', 'policy', 'operator'].map((l) => [l, (out.items ?? []).filter((i) => i.lane === l).length])) };
      errors.push(...(out.errors ?? []).map((e) => `stall sweep: ${e}`));
      // Operator items go to the needs-you feed (kind `stalled`) and one quiet-hours-gated alert per pass.
      const sweepDigestEnabled = out.mode !== 'off' && out.digest !== false;
      // A skipped (not-due) sweep has no items, so publishing would clear its open ones: wait for a pass that ran.
      if (out.dir && (out.items || out.mode === 'off' || out.digest === false)) {
        const d = stallDigest({ ...out, items: [...(sweepDigestEnabled ? out.items ?? [] : []), ...detector.items.filter(d => !(out.items ?? []).some(i => i.lane === 'operator' && i.repo === d.repo && i.pr === d.pr && String(i.head).toLowerCase() === d.head))],
          incomplete: out.incomplete || !prsReadOk || detectorErrors.length > 0 },
        { now, env, stateDir: out.dir, notify,
          enabled: sweepDigestEnabled || detector.items.length > 0 || detector.enabled });
        report.stallSweep.digest = { published: d.lines?.length ?? 0, alerted: d.fresh?.length ?? 0, notified: !!d.notified };
        errors.push(...(d.errors ?? []).map((e) => `stall digest: ${e}`));
      }
      return true;
    }, false);
    if (stalled || errors.some((e) => e.startsWith('stall sweep'))) await write();
  }
  else await detect();
  return report;
}
// Match the detached job's entry check, including snapshots reached through /var symlinks.
function isEntry(argv1) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(SELF); } catch { return resolve(argv1) === SELF; }
}
if (isEntry(process.argv[1])) {
  if (process.argv[2] !== 'run') { console.error('usage: pr-sweep.mjs run [--dry-run] [--json]'); process.exitCode = 2; }
  else runPrSweep({ dryRun: process.argv.includes('--dry-run') }).then((r) => console.log(process.argv.includes('--json') ? JSON.stringify(r) : `${r.at}: ${r.idle.length} idle PRs, ${r.alerts.length} alerts, ${r.errors.length} errors`)).catch((e) => { console.error(e); process.exitCode = 1; });
}
