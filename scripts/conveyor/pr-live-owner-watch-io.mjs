/** @file R863 bounded readers, durable decision records, and adapters to existing dispatch entry points. */
import { appendFileSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DECISION_WINDOW_MS, LIVE_OWNER_DEFAULTS, MAX_HOOK_GAPS, NOTIFY_MAX_WINDOW_MS, processLive } from './pr-live-owner-watch.mjs';
import { handoffHome } from '../lib/handoff-path.mjs';
import { cascadePolicy, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY, repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { acquireLiveOwnerWatchLock } from './pr-live-owner-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BYTES = 2 * 1024 * 1024;
function optional(path, fallback) {
  try {
    if (statSync(path).size > MAX_BYTES) throw Error('oversized evidence; operator must inspect full input');
    return readFileSync(path, 'utf8');
  } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
/** Recent merged PRs read per tick; a PR created before this window but merged inside it is not seen (disclosed residual). */
const MERGED_LIST_LIMIT = 100;

/**
 * Actual byte tail of an append-only line log. When the file exceeds the window, the partial leading
 * record is dropped; a window holding no newline at all is one partial record and yields no lines.
 */
export function tailRecords(path, { read = readSync } = {}) {
  let fd;
  try {
    fd = openSync(path, 'r'); const size = statSync(path).size, start = Math.max(0, size - MAX_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
    const count = read(fd, buffer, 0, buffer.length, start);
    // A short read would silently drop the newest bytes, the ones dedup needs most.
    if (count !== buffer.length) throw Error('short tail read; operator must inspect full input');
    let text = buffer.subarray(0, count).toString('utf8');
    if (start) { const cut = text.indexOf('\n'); text = cut === -1 ? '' : text.slice(cut + 1); }
    return { lines: text.split('\n').filter(Boolean), truncated: start > 0 };
  } catch (e) { if (e.code === 'ENOENT') return { lines: [], truncated: false }; throw e; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Feed tail; feed files can be large. Never interpret human text as JSONL. */
export function feedTail(path, options) { return tailRecords(path, options).lines; }
export function resolveLiveOwnerSettings({ env = process.env, tool = {}, platform, log = console.error } = {}) {
  const settings = platform === undefined ? readPlatformPreferences({ env }) : { prefs: platform, errors: [] };
  const envValues = env.WE_LIVE_OWNER_WATCH_MODE === undefined ? {} : { mode: env.WE_LIVE_OWNER_WATCH_MODE };
  if (env.WE_LIVE_OWNER_WATCH_ACT !== undefined) envValues.actEnabled = env.WE_LIVE_OWNER_WATCH_ACT === '1';
  const valid = Object.fromEntries(Object.keys(LIVE_OWNER_DEFAULTS).map(k => [k, k === 'actEnabled' ? v => typeof v === 'boolean' : k === 'mode'
    ? v => ['shadow', 'on'].includes(v) : v => Number.isFinite(v) && v > 0 && v <= (k === 'maxPrs' ? 100 : k === 'tickBudgetMs' ? 60_000 : 1440)
      && (!['maxPrs', 'maxActions', 'tickBudgetMs'].includes(k) || Number.isSafeInteger(v))]));
  const resolved = cascadePolicy('liveOwnerWatch', tool, { standard: LIVE_OWNER_DEFAULTS,
    platform: settings.prefs.liveOwnerWatch ?? {}, envValues, valid, env, log });
  if (settings.errors.length || resolved.invalid.length || !['shadow', 'on'].includes(tool.mode ?? 'shadow')) {
    resolved.value.mode = 'shadow'; resolved.sources.mode = 'fail-closed (invalid policy)';
    resolved.value.actEnabled = false; resolved.sources.actEnabled = 'fail-closed (invalid policy)';
  }
  log(`liveOwnerWatch effective=${JSON.stringify(resolved.value)} sources=${JSON.stringify(resolved.sources)}`);
  return resolved.value;
}

export async function createLiveOwnerWatchIo({ env = process.env, now = Date.now(), home = homedir(), root = ROOT, adapters = {} } = {}) {
  // These roots share circular dispatch/overlay dependencies. Loading them concurrently
  // deadlocks vite-node's module evaluator; finish each root before starting the next.
  const sweep = await import('./pr-stall-sweep.mjs');
  const claim = await import('./fix-dispatch-claim.mjs');
  const pid = await import('../lib/pid-alive.mjs');
  const feed = await import('../operations/needs-you-feed.mjs');
  const gh = await import('../lib/gh-throttle.mjs');
  const ledger = await import('./review-hold-ledger-shadow.mjs');
  const heavy = await import('./heavy-run-ungated.mjs');
  const heavySmell = await import('./health-smells/heavy-run-ungated.mjs');
  const overlays = await import('../lib/daemon-overlays.mjs');
  const adoption = await import('../lib/overlay-adoption.mjs');
  const clones = await import('../lib/daemon-clone-registry.mjs');
  const repo = env.GH_REPO || CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug;
  const repoKey = repoKeyForSlug(repo);
  if (!repoKey) throw Error('unregistered repo; operator inspection required');
  const dir = env.WE_LIVE_OWNER_WATCH_DIR || join(home, 'workspace', '.operations', 'pr-live-owner-watch');
  const handoff = handoffHome({ home });
  const path = feed.feedPath({ env, home });
  const fileConfig = JSON.parse(optional(join(root, 'scripts/conveyor/pr-live-owner-watch.settings.json'), '{}'));
  const tool = { ...fileConfig.liveOwnerWatch, ...JSON.parse(env.WE_LIVE_OWNER_WATCH_CONFIG || '{}') };
  const config = resolveLiveOwnerSettings({ env, tool });
  const deadline = Date.now() + config.tickBudgetMs;
  let calls = 0;
  const readGhText = args => {
    if (++calls > 16 || deadline - Date.now() < 250) throw Error('GitHub/tick budget exhausted; operator inspection required');
    if (adapters.readGhText) return adapters.readGhText(args);
    return gh.execFileSyncThrottled('gh', args, { encoding: 'utf8', env,
      timeout: Math.min(5000, deadline - Date.now()), maxBuffer: MAX_BYTES });
  };
  const readGh = args => JSON.parse(readGhText(args));
  const probe = adapters.probePid ?? (row => {
    if (row?.host && row.host !== hostname()) return { alive: null };
    if (row?.pidNamespace && row.pidNamespace !== pid.pidNamespace()) return { alive: null };
    const id = row?.runnerPid ?? row?.pid;
    const alive = sweep.pendingOwnerPidAlive(id);
    if (alive !== true) return { alive };
    const identity = pid.pidIdentity(id, { expectStart: row.runnerStart, expectArgv: row.runnerArgv,
      startedBy: pid.holderStartedBy(row, value => typeof value === 'number' ? value : Date.parse(value)) });
    return identity;
  });
  const readAgents = adapters.readAgents ?? (async () => {
    const { defaultListAgents } = await import('../operations/dispatch-lane-io.mjs');
    const jobs = await import('../operations/review-job-store.mjs');
    const { listWrappedWorkerAgents } = await import('../operations/worker-wrapper-launch.mjs');
    const agents = defaultListAgents({ env, all: true });
    if (!Array.isArray(agents)) throw Error('agent listing unavailable');
    const dir = jobs.reviewJobsDir(env, root);
    let names;
    try { names = readdirSync(dir).filter(n => n.endsWith('.json')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; names = []; }
    if (names.length > 512) throw Error('review job inventory oversized; operator must inspect full inventory');
    const rows = names.map(name => {
      const rec = JSON.parse(optional(join(dir, name), 'null'));
      if (!rec || !Number.isSafeInteger(rec.pid) || !rec.slug) throw Error('review job record incomplete');
      return jobs.jobRecordToAgentRow(rec);
    });
    const wrapped = listWrappedWorkerAgents();
    if (wrapped.incomplete?.length) throw Error('wrapped worker inventory incomplete');
    if (agents.length + rows.length + wrapped.length > 1024) throw Error('agent inventory oversized; operator must inspect full inventory');
    return [...agents, ...rows, ...wrapped];
  });
  const strictClaim = async (pr, kind) => {
    const { lockDirFor } = await import('../readiness/file-locks.mjs');
    const lockRoot = claim.fixDispatchClaimRoot(resolveCoordinationRoot({ env, home }));
    const resource = claim.fixDispatchResource({ repo: repoKey, pr: pr.number, kind });
    const dir = lockDirFor(lockRoot, resource);
    try { statSync(dir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    // A directory with missing/partial metadata can be a launch in progress. It is never an empty claim.
    JSON.parse(optional(join(dir, 'lock.json'), 'null'));
    const entry = claim.readFixDispatchClaim({ repo: repoKey, pr: pr.number, kind, lockRoot });
    if (!entry) throw Error('claim metadata incomplete');
    return entry;
  };
  const activity = adapters.readActivity ?? (async row => {
    const transcript = claim.transcriptActivityMs(row);
    if (transcript !== null) return transcript;
    // Review jobs write a real log instead of a Claude transcript.
    const { jobLogPath, reviewJobsDir } = await import('../operations/review-job-store.mjs');
    const log = row.logPath ?? (row.kind === 'review-job' ? jobLogPath(row.name, reviewJobsDir(env, root)) : null);
    if (!log) return null;
    try { return statSync(log).mtimeMs; } catch { return null; }
  });
  let agents, requiredChecks;
  const readEvidence = async (pr, prs, fresh = false) => {
    if (fresh || !agents) agents = await readAgents();
    const claims = [];
    let liveClaim = false;
    for (const kind of ['fix', 'ci-heal', 'fixing']) {
      const entry = await strictClaim(pr, kind);
      if (!entry) continue;
      const name = kind === 'fixing' ? entry.meta?.who : claim.fixDispatchSessionName({ repo: repoKey, pr: pr.number, kind });
      const session = agents.find(a => a.name === name);
      const active = name && claim.isClaimSessionLive({ repo: repoKey, pr: pr.number, kind, name, agentsAll: agents });
      const owner = entry.meta?.runnerPid ? { ...entry.meta, pid: entry.meta.runnerPid } : session;
      const identity = owner ? probe(owner) : { alive: null };
      // Lease grace protects a just-launched session that is absent from the listing.
      const leaseAge = now - Date.parse(entry.heartbeatAt ?? entry.meta?.claimedAt ?? '');
      if (processLive(identity) !== false && (active || !Number.isFinite(leaseAge) || leaseAge < 10 * 60_000)) liveClaim = true;
      claims.push({ ...identity, kind, activityMs: session ? await activity(session) : null });
    }
    const { laneRefItemNum } = await import('./lease-reaper.mjs');
    const item = laneRefItemNum(pr.headRefName);
    if (item) {
      const { buildDispatchClaimRoot } = await import('./build-dispatch-claim.mjs');
      const { parseBuildSessionName } = await import('./build-supervision.mjs');
      const { parseLockEntry } = await import('../readiness/file-locks.mjs');
      const lockRoot = buildDispatchClaimRoot(resolveCoordinationRoot({ env, home }));
      let names;
      try { names = readdirSync(lockRoot); }
      catch (e) { if (e.code !== 'ENOENT') throw e; names = []; }
      if (names.length > 512) throw Error('build claim inventory oversized; operator must inspect full inventory');
      for (const name of names) {
        // Unknown metadata cannot prove a claim belongs to another scope. Include expired claims:
        // a clock proves neither that the build ended nor that its owner died.
        let entry;
        try { entry = parseLockEntry(optional(join(lockRoot, name, 'lock.json'), '')); }
        catch { throw Error('build claim unreadable; operator must inspect claim inventory'); }
        if (!entry?.meta?.repo || !entry.meta.num || entry.meta.kind !== 'build'
          || !Number.isFinite(Date.parse(entry.heartbeatAt)))
          throw Error('build claim metadata incomplete; operator must inspect claim inventory');
        if (entry.meta.repo !== repoKey || (String(entry.meta.num) !== String(item)
          && !entry.meta.scope?.map(String).includes(String(item)))) continue;
        const session = agents.find(a => parseBuildSessionName(a.name)?.num === String(item)
          && ([repoKey, pr.repo].includes(a.repo) || (a.repo == null && repoKey === 'we'))
          && !['done', 'stopped', 'failed'].includes(a.state));
        const identity = session ? probe(session) : { alive: null };
        claims.push({ ...identity, kind: 'build', activityMs: session ? await activity(session) : null });
        if (processLive(identity) !== false) liveClaim = true;
      }
    }
    // Build/review owners need not own a fix claim. Bind explicitly to this repo and PR.
    const boundAgents = agents.filter(a => [pr.repo, repoKey].includes(a.repo) && Number(a.pr) === pr.number);
    const queued = boundAgents.find(a => a.state === 'queued' || a.status === 'queued');
    for (const a of boundAgents.filter(a => !['done', 'stopped', 'failed', 'queued'].includes(a.state) && a.status !== 'queued')) {
      const identity = probe(a);
      claims.push({ ...identity, kind: a.kind ?? 'review', activityMs: await activity(a) });
      if (processLive(identity) !== false) liveClaim = true;
    }
    const rt = (adapters.readRedTeamStatus ?? (await import('../lib/drain-red-team-evidence.mjs')).readRedTeamStatus)({ repo: pr.repo, pr: pr.number, head: pr.headRefOid, env });
    const redTeam = rt ? { ...rt, ...probe(rt) } : null;
    const stacked = prs.find(p => p.number !== pr.number && p.headRefName === pr.baseRefName);
    // Await the store contract directly: the synchronous read-behind helper would be pending on
    // every short-lived CLI invocation when the configured shared store is asynchronous.
    await import('../lib/verdict-ledger-io.mjs');
    const { getLedgerStore } = await import('../lib/verdict-ledger-store.mjs');
    const { resolveLedgerStore, resolveLedgerBoard } = await import('../lib/verdict-ledger.mjs');
    const selected = resolveLedgerStore(undefined, env), name = selected === 'dual' ? 'git' : selected;
    const store = getLedgerStore(name);
    const snapshot = adapters.readLedgerSnapshot ? await adapters.readLedgerSnapshot(pr) : store ? await store.read({ repo: pr.repo,
      ...(name === 'git' ? { board: resolveLedgerBoard(pr.repo, {}, env) } : {}) }) : { status: 'unreadable' };
    const holds = snapshot.status === 'ok' ? ledger.ledgerDecisions(snapshot.rows, pr, { repo: pr.repo, now }) : null;
    const held = !holds || !!holds.unreadable || Object.values(holds.decisions).some(Boolean);
    const labels = pr.labels.map(l => typeof l === 'string' ? l : l.name);
    // Required check names are read by the existing helper, rather than assuming every check is required.
    const { getRequiredStatusChecks, readRequiredStatusChecksDetailed } = await import('../lib/required-status-checks.mjs');
    requiredChecks ??= new Map();
    if (!requiredChecks.has(pr.baseRefName)) requiredChecks.set(pr.baseRefName, adapters.readRequiredChecks ? adapters.readRequiredChecks(pr) : getRequiredStatusChecks({ repo: pr.repo, branch: pr.baseRefName,
      readChecks: options => readRequiredStatusChecksDetailed({ ...options, gh: readGhText }) }));
    const requiredResult = requiredChecks.get(pr.baseRefName), required = requiredResult.checks;
    if (!Array.isArray(required) || !['live', 'cache'].includes(requiredResult.source)) throw Error('required check inventory unavailable');
    const checks = pr.statusCheckRollup ?? [];
    const old = now - Date.parse(pr.updatedAt ?? '') > config.ciMinutes * 60_000;
    return { complete: true, claims, liveClaim, held, redTeam,
      reviewQueuedAt: queued?.queuedAt ?? queued?.startedAt,
      stackedOn: stacked?.number, stackSince: pr.createdAt,
      redTeamOwed: labels.includes('red-team:pending') && !rt,
      missingRequiredCheck: old && required.some(name => !checks.some(c => (c.name ?? c.context) === name)),
      stuckRequiredCheck: old && checks.some(c => required.includes(c.name ?? c.context) && ['QUEUED', 'IN_PROGRESS', 'PENDING'].includes(c.status ?? c.state)),
      validatorAvailable: typeof adapters.validateDataRefresh === 'function' };
  };
  const readLastMergeAt = () => {
    // No search-backed listing (#no-label-search): list recent merged PRs plainly and filter by mergedAt
    // client-side. List order is creation order, so take the newest mergedAt inside the window, not the first row.
    const mergeFloor = now - config.noMergeMinutes * 60_000;
    const mergedAll = readGh(['pr', 'list', '--repo', repo, '--state', 'merged', '--base', 'main',
      '--limit', String(MERGED_LIST_LIMIT), '--json', 'mergedAt']);
    if (!Array.isArray(mergedAll) || mergedAll.some(p => !Number.isFinite(Date.parse(p?.mergedAt)))) throw Error('merge evidence unavailable');
    const merged = mergedAll.filter(p => Date.parse(p.mergedAt) >= mergeFloor)
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    return merged[0]?.mergedAt ?? mergeFloor - 1;
  };
  return {
    repo, config,
    acquireRun: () => acquireLiveOwnerWatchLock(dir, adapters.lockOptions),
    readHistory() {
      // The month log is append-only and grows past any fixed read cap, but dedup only needs the last
      // DECISION_WINDOW_MS. Read a byte tail; a truncated tail must reach back past that window or fail closed.
      const floor = now - DECISION_WINDOW_MS;
      const months = [new Date(now).toISOString().slice(0, 7), new Date(floor).toISOString().slice(0, 7)];
      return [...new Set(months)].flatMap(month => {
        const { lines, truncated } = tailRecords(join(dir, `${month}.jsonl`));
        const records = lines.map(line => {
          const r = JSON.parse(line);
          if (!r.repo || !Number.isSafeInteger(r.pr) || !r.head || !['would-do', 'intent', 'did'].includes(r.phase)
            || !Number.isFinite(Date.parse(r.ts))) throw Error('decision audit incomplete');
          return r;
        });
        if (truncated && !(Date.parse(records[0]?.ts) <= floor))
          throw Error('oversized decision audit tail does not cover the dedup window; operator must inspect full input');
        return records;
      });
    },
    appendDecision(record) { appendFileSync(join(dir, `${record.ts.slice(0, 7)}.jsonl`), `${JSON.stringify(record)}\n`); },
    readSweepHistory: () => sweep.readAuditHistory(sweep.stallSweepDir(env)),
    listPRs() {
      const read = () => readGh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(config.maxPrs + 1), '--json',
        'number,headRefOid,headRefName,baseRefName,isDraft,labels,mergeable,mergeStateStatus,statusCheckRollup,createdAt,updatedAt,author,files']);
      let prs;
      try { prs = read(); }
      catch (e) {
        if (e.code !== 'ETIMEDOUT') throw e;
        try { prs = read(); }
        catch (retry) { throw Error(`PR list unavailable after one timeout retry (${retry.code ?? retry.message}); operator must inspect inventory before retrying`); }
      }
      if (!Array.isArray(prs) || prs.some(p => !Array.isArray(p.labels) || !Array.isArray(p.statusCheckRollup)
        || !/^[a-f0-9]{40}$/i.test(p.headRefOid ?? ''))) throw Error('PR facts incomplete');
      return prs.map(p => ({ ...p, repo }));
    },
    readEvidence,
    async checkAdmission(pr) {
      const current = readGh(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'headRefOid,labels,isDraft']);
      if (current.headRefOid !== pr.headRefOid || current.isDraft || !Array.isArray(current.labels)) return { ok: false, reason: 'head/draft/labels changed or unreadable' };
      const names = current.labels.map(l => l.name);
      if (names.some(l => ['review:human', 'needs-you', 'operator-approval'].includes(l))) return { ok: false, reason: 'operator approval required' };
      if (JSON.stringify([...names].sort()) !== JSON.stringify(pr.labels.map(l => l.name ?? l).sort())) return { ok: false, reason: 'labels changed; replan next pass' };
      const e = await readEvidence(pr, [], true);
      if (e.held || e.liveClaim || e.claims.some(c => processLive(c) !== false) || (e.redTeam && processLive(e.redTeam) !== false && e.redTeam.status === 'running'))
        return { ok: false, reason: 'live/unknown claim or review ledger hold; operator inspection required' };
      return { ok: true };
    },
    async execute(action) {
      // Single mutation choke point: refuse before reading or constructing any action adapter.
      if (config.actEnabled !== true) return { ok: false, reason: 'live-owner acting disabled; report-only' };
      if (!['clear-label', 'fix-dispatch', 'refresh-check', 'validate-data-refresh', 'review-dispatch', 'red-team-dispatch'].includes(action.action))
        throw Error('unknown live-owner action; operator inspection required');
      const pr = action.pr, input = { repo: pr.repo, pr: pr.number, head: pr.headRefOid, env };
      if (action.action === 'clear-label') {
        const { createGhProvider } = await import('../lib/review-label-provider.mjs');
        (adapters.labelProvider ?? createGhProvider()).setLabels(pr.repo, pr.number, { remove: ['status:fixing'] });
        return { ok: true };
      }
      if (action.action === 'validate-data-refresh') return adapters.validateDataRefresh({ ...input, expectedHead: pr.headRefOid });
      if (action.action === 'fix-dispatch') {
        const { runReconcileFixDispatch } = await import('./reconcile-fix-dispatch.mjs');
        let queueAdmission, dispatchThrottle, comments;
        try {
          const { createQueueBudget } = await import('../readiness/heavy-queue-projection.mjs');
          const resolveBaseline = adapters.resolveLiveQueueBaseline
            ?? (await import('../readiness/heavy-admission.mjs')).resolveLiveQueueBaseline;
          queueAdmission = createQueueBudget(await resolveBaseline({ checkoutRoot: root, env }));
          if (!queueAdmission.active) throw Error('heavy queue admission unavailable');
          const buildThrottle = adapters.buildFixThrottle
            ?? (await import('../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).buildFixThrottle;
          dispatchThrottle = await buildThrottle({ env });
          if (typeof dispatchThrottle?.tryAdmit !== 'function') throw Error('fix throttle unavailable');
        } catch {
          return { ok: false, reason: 'fix admission unavailable; operator must inspect queue and host admission before retrying' };
        }
        try {
          const { readCompletePrComments } = await import('./pr-comments-complete.mjs');
          // Pagination and the independent count proof share this tick's GitHub/time budget.
          comments = readCompletePrComments(pr.number, { repo: pr.repo, gh: readGh });
        } catch {
          return { ok: false, reason: 'complete PR comments unavailable; operator must inspect full thread before retrying' };
        }
        // Same planner, scope/capacity/claim gates and dispatcher as the daemon, restricted to ONE PR.
        const result = (adapters.reconcileFixDispatch ?? runReconcileFixDispatch)({ repo: repoKey, root,
          readPrs: () => [{ ...pr, comments }], queueAdmission, dispatchThrottle, dryRun: false });
        return { ok: result.dispatched?.some(d => Number(d.pr ?? d.prNumber) === pr.number) === true,
          reason: 'fix daemon planner refused or did not prove a dispatch' };
      }
      if (action.action === 'refresh-check') {
        const { createStaleBaseGate, readStaleBaseFacts } = await import('./stale-base-refresh.mjs');
        const { readCompletePrComments } = await import('./pr-comments-complete.mjs');
        let comments;
        try { comments = readCompletePrComments(pr.number, { repo: pr.repo, gh: readGh }); }
        catch { return { ok: false, reason: 'complete PR comments unavailable; operator must inspect full thread before refreshing base' }; }
        const result = await (adapters.staleBaseGate ?? createStaleBaseGate({ env,
          readFacts: options => readStaleBaseFacts({ ...options, readComments: () => comments,
            exec: (cmd, args, opts) => cmd === 'gh' ? readGhText(args) : execFileSync(cmd, args, opts) }),
        }))({ planned: { pr: pr.number }, repo: repoKey, root });
        return { ok: result?.held === true && result.reason === 'stale-base refresh first: refreshed onto main, CI re-runs before any fixer',
          reason: result?.reason ?? 'stale-base gate did not refresh; operator must inspect missing/stuck check' };
      }
      const { dispatchManualPass } = await import('../operations/manual-daemon-pass-io.mjs');
      const reviewJob = await (adapters.loadReviewJob ?? (() => import('../operations/review-job.mjs')))();
      // Resolve the dispatch mode from this IO's env (not process.env) and hand it to the dispatcher, so the
      // check below and the launch cannot disagree. Session mode has no job-side head pin: refuse it.
      const reviewMode = reviewJob.resolveReviewDispatchMode(env);
      if (action.action === 'review-dispatch' && reviewMode !== 'job')
        return { ok: false, reason: `review dispatch mode ${reviewMode} cannot pin the PR head at launch; operator must dispatch review by hand` };
      // The manual launcher drops expectedHead on the review path; pin it here so the job refuses a head that
      // moved after the precheck below (the red-team path already forwards it to dispatchReviewJob).
      const loadPinned = async () => ({ ...reviewJob,
        dispatchReviewByMode: opts => reviewJob.dispatchReviewByMode({ ...opts, mode: reviewMode, expectedHead: pr.headRefOid }) });
      if (action.action === 'review-dispatch') {
        try {
          const { readCompletePrComments } = await import('./pr-comments-complete.mjs');
          const { runReconcilePass } = await import('./reconcile-pass.mjs');
          const comments = readCompletePrComments(pr.number, { repo: pr.repo, gh: readGh });
          agents = await readAgents();
          if (!Array.isArray(agents)) throw Error('review ownership unavailable');
          const plan = await (adapters.reconcileReview ?? runReconcilePass)({ repo: pr.repo, env, now,
            readPrs: () => [{ ...pr, comments }], readAgents: () => agents,
          });
          if (!Array.isArray(plan?.dispatch) || !Array.isArray(plan?.refusals)
            || !plan.dispatch.some(d => d.kind === 'review' && Number(d.prNumber) === pr.number))
            return { ok: false, reason: `review reconcile held: ${plan?.refusals?.map(r => r.kind).join(', ') || 'no proven review admission'}; operator must inspect durable rounds and stand-downs` };
        } catch {
          return { ok: false, reason: 'review admission unavailable; operator must inspect complete thread, durable rounds and stand-downs before retrying' };
        }
      }
      let redTeamMode;
      if (action.action === 'red-team-dispatch') {
        const { readRedTeamStatus, readRecoveryWitness } = await import('../lib/drain-red-team-evidence.mjs');
        const recovery = await import('../lib/review-red-team-on-skip.mjs');
        const status = (adapters.readRedTeamStatus ?? readRedTeamStatus)(input);
        if (status?.status === 'running') {
          if (processLive((adapters.probePid ?? probe)(status)) !== false) throw Error('red-team owner live or unknown');
          const abandoned = await (adapters.abandonStaleRedTeamRun ?? recovery.abandonStaleRedTeamRun)(input);
          if (abandoned?.ok !== true) throw Error('red-team abandonment refused');
        }
        const plan = (adapters.planRedTeamRecovery ?? recovery.planRedTeamRecovery)((adapters.readRecoveryWitness ?? readRecoveryWitness)(input), { now: Date.now(), probe: recovery.recoveryProbe(),
          deadlineMs: recovery.staleRunDeadlineMs(env), env });
        if (plan.abandon !== false || !['fresh', 'resume'].includes(plan.mode)) throw Error('red-team recovery not admissible');
        redTeamMode = plan.mode;
      }
      const head = readGh(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'headRefOid'])?.headRefOid;
      if (typeof head !== 'string' || !/^[a-f0-9]{40}$/i.test(head)) throw Error('PR head unreadable; operator must inspect before retrying');
      if (head.toLowerCase() !== pr.headRefOid.toLowerCase()) throw Error('PR head changed; operator must inspect before retrying');
      const result = await (adapters.dispatchManualPass ?? dispatchManualPass)({ daemon: action.action === 'review-dispatch' ? 'review' : 'red-team',
        repo: pr.repo, pr: pr.number, expectedHead: pr.headRefOid, ...(redTeamMode ? { redTeamMode } : {}) }, { env, load: loadPinned,
        readHead: () => readGh(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'headRefOid']).headRefOid });
      return { ok: !result?.error && !result?.skipped && result?.ok !== false
        && (result?.launched === true || (Number.isSafeInteger(result?.jobPid) && result.jobPid > 0)
          || (action.action === 'review-dispatch' && typeof result?.agentId === 'string' && result.agentId.length > 0)),
        reason: 'manual dispatch launch unproven' };
    },
    readSmellState() {
      const state = JSON.parse(optional(join(dir, 'smell-state.json'), '{}'));
      if (!state || Array.isArray(state) || typeof state !== 'object'
        || Object.values(state).some(v => !Number.isFinite(Date.parse(v)))) throw Error('smell state unreadable');
      return state;
    },
    // One key per PR head would grow past the 2 MiB read cap; no notify window looks back further than this.
    writeSmellState: state => writeJsonAtomic(join(dir, 'smell-state.json'), Object.fromEntries(Object.entries(state)
      .filter(([, at]) => Date.parse(at) > now - NOTIFY_MAX_WINDOW_MS))),
    emit(event) {
      const { lines } = feed.diffFeed([], [event], now);
      feed.appendLines(path, lines);
    },
    // Other sessions append to this log and nothing prunes it, so a whole-file read would eventually exceed the
    // read cap and hold every pass. Read the newest records only, and flag that the audit is partial.
    readGaps() {
      const { lines, truncated } = tailRecords(join(handoff, 'hook-gaps.jsonl'));
      const newest = lines.slice(-MAX_HOOK_GAPS);
      return Object.assign(newest.map(line => JSON.parse(line)), { truncated: truncated || newest.length < lines.length });
    },
    readLastMergeAt,
    async readSystemEvidence(prs) {
      const lastMergeAt = readLastMergeAt();
      const pending = [];
      const roots = clones.daemonCloneRoots(join(home, 'workspace'), { env });
      if (roots.length > 64) throw Error('overlay clone inventory oversized; operator inspection required');
      for (const clone of roots) {
        const registry = overlays.readOverlayState(clone, { env });
        if (registry.corrupt) throw Error('overlay registry unreadable');
        const rawPending = JSON.parse(optional(adoption.pendingAdoptionPath(clone, env), '[]'));
        if (!Array.isArray(rawPending) || rawPending.length > adoption.OVERLAY_ADOPTION_MAX_PENDING
          || rawPending.some(r => !r.ref || !/^[a-f0-9]{40}$/i.test(r.sha ?? '') || !Number.isFinite(Date.parse(r.at))))
          throw Error('overlay adoption evidence incomplete or oversized; operator must inspect full input');
        for (const rec of adoption.readPendingAdoptions(clone, { env })) {
          if (!registry.overlays.some(o => o.ref === rec.ref)) continue;
          if (Date.now() >= deadline) throw Error('overlay probe budget exhausted; operator inspection required');
          let adopted;
          try { execFileSync('git', ['-C', clone, 'merge-base', '--is-ancestor', rec.sha, 'HEAD'], {
            timeout: Math.min(1000, deadline - Date.now()), maxBuffer: 64 * 1024, stdio: 'pipe' }); adopted = true; }
          catch (e) { if (e.status !== 1 || e.signal || e.code || String(e.stderr ?? '').trim()) throw Error('overlay ancestry unknown'); adopted = false; }
          pending.push({ ...rec, clone, adopted, registered: true });
        }
      }
      const { parsePsOutput } = await import('./health-watch-core.mjs');
      const processes = parsePsOutput(execFileSync('ps', ['-Ao', 'pid,ppid,pcpu,etime,command'], { encoding: 'utf8', timeout: 1000, maxBuffer: MAX_BYTES }));
      const { healthDir } = await import('./health-watch-section.mjs');
      const samples = heavy.readRecentSamples(join(healthDir(undefined, env), 'heavy-run-samples.jsonl'), {
        now, windowMs: config.heavyRunUngatedWindowMs ?? 10 * 60_000 });
      const breach = heavySmell.default.evaluate({ processes, heavyRunSamples: samples }, { now, config }).some(s => s.breach);
      const { probeForgeShareForWatch } = await import('./forge-share-probe.mjs');
      const forge = probeForgeShareForWatch({ repoRoot: root, env, now });
      const forgeSmell = (await import('./health-smells/forge-share-below-target.mjs')).default;
      const fallbackBreach = forge.current?.status === 'ok' && Object.values(forge.current.byReason ?? {}).some(n => n > 0)
        && forgeSmell.evaluate({ forgeShare: forge }).some(s => s.breach);
      const feedEvents = feedTail(path).map(feed.parseFeedLine).filter(Boolean);
      return { prs: prs.map(p => ({ ...p, ready: p.labels.some(l => ['ready-to-merge', 'review:accepted'].includes(l.name ?? l)) })),
        lastMergeAt, overlays: pending,
        heavyFallback: process.platform === 'darwin' && (breach || fallbackBreach), feedEvents };
    },
  };
}
