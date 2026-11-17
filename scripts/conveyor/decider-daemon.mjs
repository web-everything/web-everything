/** Shadow only: node scripts/conveyor/decider-daemon.mjs --dry-run --once */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, appendFile, writeFile, rename } from 'node:fs/promises';
import { decide, DECIDE_VERSION, ACTION_PRIORITY } from './decide.mjs';
import { resolveDispatchSetting } from '../lib/dispatch-throttle.mjs';
import { resolvePrEventsConfig, pollEvents } from '../lib/pr-events.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** Fold without mutating the caller's state or event envelopes. */
export function foldProjection(state, events) {
  const next = Object.fromEntries(Object.entries(state).map(([key, row]) => [key, { ...row, labels: [...(row.labels ?? [])] }]));
  const dirty = new Set();
  const runtime = [];
  let cursor = Math.max(0, ...Object.values(next).map(row => Number.isFinite(row.seq) ? row.seq : 0));
  for (const event of Array.isArray(events) ? events : []) {
    if (!object(event)) continue;
    const seq = Number.isInteger(event.seq) && event.seq >= 0 ? event.seq : cursor + 1;
    cursor = Math.max(cursor, seq);
    if (event.class === 'runtime') { runtime.push(event); continue; }
    if (typeof event.repo !== 'string' || !event.repo || !Array.isArray(event.prs)) continue;
    if (!['pull_request', 'check_suite', 'check_run', 'pull_request_review', 'issue_comment'].includes(event.type)) continue;
    if (event.type === 'pull_request' && !['opened', 'synchronize', 'labeled', 'unlabeled', 'closed', 'ready_for_review', 'reopened', 'converted_to_draft'].includes(event.action)) continue;
    for (const number of event.prs) {
      if (!Number.isInteger(number) || number <= 0) continue;
      const key = `${event.repo}#${number}`;
      const row = next[key] ?? { repo: event.repo, number, head: null, labels: [], draft: false, state: 'OPEN' };
      if (seq < (row.seq ?? 0)) continue;
      if (typeof event.sha === 'string' && event.sha) row.head = event.sha;
      if (event.type === 'pull_request') {
        if (event.action === 'closed') row.state = 'CLOSED';
        if (['opened', 'reopened'].includes(event.action)) row.state = 'OPEN';
        if (event.action === 'ready_for_review') row.draft = false;
        if (event.action === 'converted_to_draft') row.draft = true;
        if (typeof event.label === 'string' && event.label) {
          if (event.action === 'labeled') row.labels = [...new Set([...row.labels, event.label])];
          if (event.action === 'unlabeled') row.labels = row.labels.filter(label => label !== event.label);
        }
      }
      Object.assign(row, { seq, lastEventAt: timestamp(event.at), dirty: true });
      next[key] = row;
      dirty.add(key);
    }
  }
  return { state: next, dirty: [...dirty], runtime, cursor };
}

/** Pure slot allocation. Missing host/load evidence refuses admission. */
export function admit(requests, { caps, live, hostGate } = {}) {
  caps ??= { fix: resolveDispatchSetting('fixDispatchMaxConcurrent'), ciHealReserve: 1,
    heavy: resolveDispatchSetting('heavyAdmissionCap') };
  const used = { ...live };
  const admitted = [], deferred = [];
  const valid = value => Number.isInteger(value) && value >= 0;
  for (const request of requests) {
    const kind = request.action?.kind;
    let reason;
    if (hostGate?.allow !== true) reason = hostGate?.reason || 'host-evidence-missing: retry after host probe';
    else if (![caps.fix, caps.ciHealReserve, caps.heavy, used.fix, used.ciHeal, used.heavy].every(valid)) reason = 'capacity-evidence-missing: retry after live capacity read';
    else if (!ACTION_PRIORITY.includes(kind)) reason = 'unknown-action: operator review required';
    else if (used.heavy >= caps.heavy) reason = 'heavy-cap: wait for capacity';
    else if (kind === 'fix' && (used.fix >= caps.fix || used.fix + used.ciHeal >= caps.fix + caps.ciHealReserve)) reason = 'fix-cap: wait for capacity';
    else if (kind === 'ci-heal' && used.fix + used.ciHeal >= caps.fix + caps.ciHealReserve) reason = 'ci-heal-reserve: wait for capacity';
    if (reason) deferred.push({ request, reason });
    else {
      admitted.push(request);
      used.heavy++;
      if (kind === 'fix') used.fix++;
      if (kind === 'ci-heal') used.ciHeal++;
    }
  }
  return { admitted, deferred };
}

/** All effects are supplied by the shell; overlapping ticks share a single flight. */
export function createDecider({ io, now = Date.now, process: identity, repoSlug, caps, initialState = {},
  // Returns a planner repo key, undefined (planner default) or null (unknown repo: fail closed). Production passes the strict one.
  plannerRepoFor = slug => repoKeyForSlug(slug) ?? undefined }) {
  // Restore all projected fields, including closed/draft, and rehydrate each row on restart.
  let state = Object.fromEntries(Object.entries(foldProjection(initialState, []).state)
    .map(([key, row]) => [key, { ...row, dirty: true }])), flight = null;
  const timers = new Map();
  function ingest(events) { state = foldProjection(state, events).state; }
  async function run() {
    const requests = new Map();
    const processed = new Set();
    let agents;
    try { agents = io.readAgents ? await io.readAgents() : null; } catch { agents = null; }
    for (;;) {
      const entry = Object.entries(state).find(([key, row]) => (!repoSlug || row.repo === repoSlug)
        && (row.dirty || (!processed.has(key) && timers.has(key)
          && timers.get(key) <= now())));
      if (!entry) break;
      const [key, current] = entry;
      // Freshness measures this hydration; event age remains separate lag evidence.
      // Start before the read so an excessively slow hydration still fails closed.
      const projection = { ...current, observedAt: now() };
      current.dirty = false;
      processed.add(key);
      timers.delete(key);
      let pr;
      try { pr = await io.hydrate(current.repo, current.number); } catch { pr = null; }
      const hydrated = pr && Object.hasOwn(pr, 'pr') ? pr : null;
      const agentList = hydrated ? hydrated.agents : agents;
      const agentsIncomplete = hydrated ? hydrated.agentsIncomplete === true || !Array.isArray(agentList)
        || Object.hasOwn(agentList, 'incomplete') : !Array.isArray(agentList) || Object.hasOwn(agentList, 'incomplete');
      if (hydrated) pr = hydrated.pr;
      // Legacy bare snapshots retain their historical missing-list refusal.
      if (!hydrated && !Array.isArray(agents)) pr = null;
      const decidedAt = now();
      // The planner binds sessions and policy per constellation repo; an unknown repo has no safe binding.
      const plannerRepo = plannerRepoFor(current.repo);
      const result = decide({ pr: plannerRepo === null ? null : pr, agents: agentList, agentsIncomplete: hydrated ? agentsIncomplete : Array.isArray(agents) && agentsIncomplete,
        plannerOptions: hydrated?.plannerOptions, now: decidedAt, projection, repoSlug: current.repo,
        ...(plannerRepo ? { plannerRepo } : {}) });
      const record = { ...result, number: current.number, shadow: true, kind: 'decision',
        incomplete: result.incomplete === true, version: DECIDE_VERSION, process: { ...identity, role: 'decider' },
        eventAt: projection.lastEventAt, decidedAt,
        lagMs: Number.isFinite(projection.lastEventAt) ? Math.max(0, decidedAt - projection.lastEventAt) : null };
      await io.appendShadow(record);
      if (Number.isFinite(result.recheckAt)) timers.set(key, result.recheckAt);
      requests.delete(key);
      if (result.action) requests.set(key, record);
      // Timer retries wait for the next tick. Only a new event can re-mark
      // this PR for another decision during the current flight.
    }
    let live, hostGate;
    try { live = await io.readLive(); } catch { live = null; }
    try { hostGate = await io.hostGate(); } catch { hostGate = { allow: false, reason: 'host-read-failed: retry host probe' }; }
    const admission = admit([...requests.values()], { caps, live, hostGate });
    await io.appendShadow({ shadow: true, kind: 'admission', process: { ...identity, role: 'decider' },
      decidedAt: now(), ...admission });
    return admission;
  }
  function tick() {
    if (!flight) flight = run().finally(() => { flight = null; });
    return flight;
  }
  return { ingest, tick };
}

/** Compare every per-head shadow decision with deduplicated live action facts. */
export function diffReport({ decisions = [], actual = [], now }) {
  const keyOf = row => `${row.repo}#${row.number}@${row.head}`;
  const byHead = new Map(), facts = new Map();
  const allDecisions = decisions.filter(row => row?.kind === 'decision');
  for (const row of allDecisions) {
    const key = keyOf(row);
    if (!byHead.has(key)) byHead.set(key, []);
    byHead.get(key).push(row);
  }
  for (const row of actual) {
    if (row?.class !== 'runtime' || !['action-requested', 'worker-started'].includes(row.type)
      || !ACTION_PRIORITY.includes(row.action)) continue;
    const key = keyOf(row);
    if (!facts.has(key)) facts.set(key, new Set());
    facts.get(key).add(row.action);
  }
  const counts = { agree: 0, disagreeKind: 0, wouldDoOnly: 0, actualOnly: 0, conflicting: 0 }, rows = [];
  for (const key of [...new Set([...byHead.keys(), ...facts.keys()])].sort()) {
    const decisionsForHead = byHead.get(key) ?? [];
    const conflicting = new Set(decisionsForHead.map(row => row.action?.kind ?? null)).size > 1;
    for (const decision of decisionsForHead.length ? decisionsForHead : [null]) {
      const actions = [...(facts.get(key) ?? [])].sort();
      const wanted = decision?.action?.kind ?? null;
      if (!wanted && !actions.length) {
        counts.conflicting += Number(conflicting);
        rows.push({ repo: decision.repo, number: decision.number, head: decision.head, wanted, actual: actions, classification: 'both-idle', conflicting });
        continue;
      }
      const classification = !wanted ? 'actual-only' : !actions.length ? 'would-do-only'
        : actions.length === 1 && actions[0] === wanted ? 'agree' : 'disagree-kind';
      counts[{ 'actual-only': 'actualOnly', 'would-do-only': 'wouldDoOnly', 'disagree-kind': 'disagreeKind', agree: 'agree' }[classification]]++;
      const identity = decision ?? actual.find(row => keyOf(row) === key);
      rows.push({ repo: identity.repo, number: identity.number, head: identity.head, wanted, actual: actions, classification, conflicting });
      counts.conflicting += Number(conflicting);
    }
  }
  const lags = allDecisions.map(row => row.lagMs).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return { counts, rows, lag: { p50Ms: lags.length ? lags[Math.ceil(lags.length / 2) - 1] : null, n: lags.length }, generatedFrom: { now, decisions: allDecisions.length, actual: facts.size } };
}

/** Stable, terminal-safe Markdown for operator inspection. */
export function formatReport(report) {
  return ['| Repository | PR | Head | Shadow | Actual | Classification |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.rows.map(row => `| ${[row.repo, row.number, row.head, row.wanted ?? 'idle', row.actual.join(', '), row.classification].map(clean).join(' | ')} |`),
    `\nLag p50: ${report.lag.p50Ms ?? 'absent'} ms (n=${report.lag.n})`].join('\n');
}

/** Read-only CLI shell. Unknown flags are rejected; shadow is the only mode. */
export async function main(argv = process.argv.slice(2)) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--(dry-run|once|daemon|json|shadow-dir|repo|interval-ms)(?:=(.*))?$/.exec(arg);
    if (!match) { console.error('Unknown shadow option'); return 2; }
    flags[match[1]] = match[2] ?? true;
  }
  const config = resolvePrEventsConfig();
  if (!config.enabled) { console.error(`Event feed not configured: WE_PR_EVENTS and missing ${config.missing.join(', ')}`); return 1; }
  const interval = flags['interval-ms'] === undefined ? 5000 : Number(flags['interval-ms']);
  if (!Number.isFinite(interval) || interval < 1 || interval > 60000) { console.error('interval-ms must be between 1 and 60000'); return 2; }
  if (typeof flags.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(flags.repo)) { console.error('--repo=owner/name is required'); return 2; }
  const dir = typeof flags['shadow-dir'] === 'string' ? flags['shadow-dir'] : join(homedir(), '.claude', 'decider-shadow');
  await mkdir(dir, { recursive: true });
  const cursorPath = join(dir, 'cursor.json');
  let saved = { cursor: null, state: {}, actual: [], decisions: [] };
  try { saved = JSON.parse(await readFile(cursorPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Loading the production readers only here keeps import and injected ticks inert.
  const { defaultReadPrs, runReconcilePass } = await import('./reconcile-pass.mjs');
  const decisions = saved.decisions ?? [], actual = saved.actual ?? [];
  let projection = saved.state ?? {};
  const decider = createDecider({ initialState: projection, repoSlug: flags.repo, plannerRepoFor: slug => repoKeyForSlug(slug), process: { id: `shadow-${process.pid}`, pid: process.pid }, io: {
    hydrate: (repo, number) => {
      const key = repoKeyForSlug(repo);
      if (!key) return null;
      const result = runReconcilePass({ readOnly: true, repo: key, readPrs: options => {
        const rows = defaultReadPrs({ ...options, repo, readOnly: true });
        if (!Array.isArray(rows) || rows.discoveryIncomplete || rows.deferred) throw new Error('PR discovery incomplete');
        return rows.filter(row => row.number === number);
      } });
      return { pr: result.enrichedPrs?.[0], agents: result.agentList,
        agentsIncomplete: result.agentsIncomplete, plannerOptions: result.plannerOptions };
    },
    // No authoritative shared heavy-slot inventory is available here yet. Keep
    // admission closed and tell operators what evidence is needed for cut-over.
    readLive: () => null,
    hostGate: () => ({ allow: false, reason: 'shadow capacity unavailable: supply authoritative live slots and host probe before cut-over' }),
    appendShadow: async record => {
      await appendFile(join(dir, 'decisions.jsonl'), `${JSON.stringify(record)}\n`);
      if (record.kind === 'decision') decisions.push(record);
    },
  } });
  do {
    const batch = await pollEvents(saved.cursor, config);
    // First run (no saved cursor): a feed baseline is the only honest start. Seed the dirty set from the open PRs
    // (read-only listing); every later reset or gap still fails closed.
    const baseline = saved.cursor == null && batch.ok && batch.reset && !batch.gap;
    if (baseline) {
      const rows = defaultReadPrs({ repo: flags.repo, readOnly: true });
      if (!Array.isArray(rows) || rows.discoveryIncomplete || rows.deferred) { console.error('Open-PR seed incomplete: retry later'); return 1; }
      batch.events = rows.filter(row => typeof row.headRefOid === 'string' && row.headRefOid)
        .map((row, i) => ({ type: 'pull_request', action: 'synchronize', repo: flags.repo, prs: [row.number], sha: row.headRefOid,
          seq: i + 1, at: new Date().toISOString() }));
    }
    if (!batch.ok || batch.gap || (batch.reset && !baseline)) { console.error('Event evidence incomplete: restore/replay the feed before retrying'); return 1; }
    const folded = foldProjection(projection, batch.events);
    projection = folded.state;
    actual.push(...folded.runtime);
    decider.ingest(batch.events);
    await decider.tick();
    saved = { cursor: batch.cursor, state: projection, actual, decisions };
    await writeFile(`${cursorPath}.new`, JSON.stringify(saved));
    await rename(`${cursorPath}.new`, cursorPath);
    const report = diffReport({ decisions, actual, now: Date.now() });
    if (flags.once || !flags.daemon) { console.log(flags.json ? JSON.stringify(report) : formatReport(report)); return 0; }
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (flags.daemon);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(clean(error.message)); process.exitCode = 1;
  });
}
