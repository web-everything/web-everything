/**
 * @file land-advance-io.mjs
 * Evidence ports are synchronous so the declared operation can remain compute-only.
 * Missing optional sidecars mean no records; unreadable or malformed sources are
 * errors, never empty success. Drain reads are bounded at bytes AND lines.
 * PLAN never fetches: fetch mutates git metadata. APPLY refreshes branch evidence
 * before replanning; a failed refresh is explicitly unknown. This preserves the
 * read-only operation contract even when invoked without a session.
 * Follow-ups use the existing run-store's in-flight DISPATCH_EFFECT + plain dispatch
 * metadata, one run per launch, with no changes to dispatch-lane semantics.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, loadavg, cpus } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePidAlive, scanPsOutput, defaultIsPidAlive } from '../conveyor/driver-watchdog.mjs';
import { planFixesFromReconcile, dispatchFix as realDispatchFix } from '../conveyor/reconcile-fix-dispatch.mjs';
import { CONFLICT_LABEL } from '../conveyor/parked-pr-conflict-watch.mjs';
import { countCiHealComments, countChargeableCiHealComments, resolveCiHealBudgetRestore } from '../conveyor/ci-heal-mark.mjs';
import { standDownComments } from '../conveyor/stand-down.mjs';
import { dispatchCiHeal as realDispatchCiHeal } from './ci-heal-pr-dispatch.mjs';
import { isConflicting, followUpKindFor } from './land-advance-repair.mjs';
import { defaultLoadItems, findItem } from './dispatch-lane-io.mjs';
import { dispatchReview as realDispatchReview } from './review-dispatch.mjs';
import { createFileRunStore, newRunId, newRunRecord } from './run-store.mjs';
import { completionPath } from './completion-store.mjs';
import { inFlight } from './effect-executor.mjs';
import { DISPATCH_EFFECT } from './dispatch-lane.mjs';
import { repoKeyFromSlug, capacityFor, drainWait } from './land-advance.mjs';
import { allowedToolsArg, ALLOWED_TOOLS_BY_KIND } from './land-advance-tools.mjs';
import { classifySession } from '../conveyor/session-verdicts.mjs';
import { makeEvidenceResolver } from '../conveyor/session-verdicts-io.mjs';
import { listEscalations, buildEscalationPacket, writeEscalationPacket } from './land-advance-escalations.mjs';
import { createItemReader, queueItemInto, reconcileHolds } from './land-advance-items-io.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runDefault = (program, args) => String(execFileSync(program, args, { cwd: ROOT, encoding: 'utf8', timeout: 30000, stdio: 'pipe' }));
const missing = (fn, fallback) => { try { return fn(); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
export function readJsonlTail(path, { fs: io = fs, maxBytes = 8 * 1024 * 1024, maxLines = 20000 } = {}) {
  return missing(() => {
    const size = io.statSync(path).size, start = Math.max(0, size - maxBytes), fd = io.openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    let count;
    try { count = io.readSync(fd, buffer, 0, buffer.length, start); } finally { io.closeSync(fd); }
    let text = buffer.subarray(0, count).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n').filter((s) => s.trim());
    return { entries: lines.slice(-maxLines).map((line) => JSON.parse(line)), capped: start > 0 || lines.length > maxLines };
  }, { entries: [], capped: false });
}
export function readFollowUps({ store = createFileRunStore() } = {}) {
  return store.list().flatMap((id) => (store.read(id)?.effects ?? [])
    .filter((e) => e.type === DISPATCH_EFFECT && e.dispatch?.followUp)
    .map((e) => e.dispatch.followUp));
}
export function writeFollowUp(entry, { store = createFileRunStore(), mintId = newRunId } = {}) {
  const run = newRunRecord({ id: mintId('land-advance'), op: 'land-advance-dispatch', input: { target: entry.target } });
  const metadata = { launchKind: entry.kind, followUp: entry };
  // #3856 graduation — `inFlight()` (`effect-executor.mjs`, main) only ever destructures `handle`/`expectedBy`
  // (it validates and trims the handle, and validates the deadline) and returns a branded marker with just
  // those two fields — it never passes an arbitrary `dispatch` payload through. `dispatch` is re-attached here,
  // after the call, so the follow-up ledger this module reads back (`readFollowUps` below) still round-trips it.
  const effect = entry.session ? { ...inFlight({ handle: entry.session, expectedBy: entry.deadline }), dispatch: metadata }
    : { handle: null, expectedBy: entry.deadline, dispatch: metadata };
  // inFlight is a sink result; the executor normally transfers these fields to its effect entry.
  run.effects.push({ key: `${entry.target}:${entry.kind}`, type: DISPATCH_EFFECT, stepIndex: 0, index: 0,
    status: 'in-flight', handle: effect.handle, expectedBy: effect.expectedBy, startedAt: entry.launchedAt, dispatch: effect.dispatch });
  store.write(run);
}
export function readLiveSessions({ run = runDefault, listAgents = () => run('claude', ['agents', '--json']),
  ps = () => scanPsOutput({ exec: (program, args) => run(program, args) }), isPidAlive = defaultIsPidAlive } = {}) {
  const raw = listAgents(), agents = Array.isArray(raw) ? raw : JSON.parse(raw);
  if (!Array.isArray(agents)) throw new Error('claude agents: expected array');
  const psOutput = ps();
  return agents.map((s) => {
    const alive = resolvePidAlive(s, { psOutput, isPidAlive });
    if (alive == null) throw new Error(`Unknown liveness for ${s.name ?? s.id}`);
    return { ...s, liveness: !alive ? 'dead-record' : (s.state ?? s.status) === 'done' ? 'done' : s.waitingFor ? 'waiting'
      : ['idle', 'blocked'].includes(s.state ?? s.status) ? 'live-idle' : 'live-active' };
  });
}
export function resultProvider(text) {
  const section = String(text).match(/(?:^|\n)[#*\s]*(?:provider used|authorship)[^\n]*\n?([\s\S]*?)(?=\n#{1,6}\s|$)/i)?.[0];
  const name = section?.match(/codex-direct-task|codex|gemini/i)?.[0];
  return name ? (/codex/i.test(name) ? 'Codex' : 'Gemini') : null;
}
export function createLandAdvanceReader(ports = {}) {
  const { fs: io = fs, run = runDefault, now = Date.now, home = homedir(), cap = 3, loadThreshold = 1.5,
    machineLoad = () => loadavg()[0] / cpus().length, store = createFileRunStore(),
    drainDir = join(home, 'workspace/plateau-app/.drain-daemon'), jobsDir = join(home, 'workspace/.operations/jobs'),
    trialLog = join(home, 'workspace/.operations/delegation-trials.jsonl'), escalationsDir = join(home, 'workspace/.operations/escalations'),
    sweptReposPath = join(ROOT, 'scripts/lib/swept-repos.json'),
    readSessions = () => readLiveSessions({ run }), findItemFn = findItem, loadItems = () => defaultLoadItems(ROOT),
    resolveFallbackScope = (pr) => run('gh', ['pr', 'diff', String(pr), '--repo', 'web-everything/web-everything', '--name-only']).trim().split('\n').filter(Boolean).map((p) => `we:${p}`),
    // #3856 graduation — `planFixesFromReconcile`'s itemless-PR branch moved to the shared `resolvePrWorkUnit`
    // (`we:scripts/conveyor/pr-work-unit.mjs`, landed on `main` after this module's own branch snapshot) between
    // when this file was written and when it graduated here. That resolver's `fetchDiffPaths` contract is
    // UN-prefixed (it adds the repo prefix itself) — unlike `resolveFallbackScope` above, which the item-carrying
    // no-scope fallback still consumes pre-prefixed. Same underlying `gh pr diff --name-only` read, no `we:` map.
    fetchItemlessDiffPaths = (pr) => run('gh', ['pr', 'diff', String(pr), '--repo', 'web-everything/web-everything', '--name-only']).trim().split('\n').filter(Boolean),
    followUpEvidence, refreshPrototype = false, readPrototype, isPidAlive = defaultIsPidAlive,
    readPrComments = (pr) => JSON.parse(run('gh', ['pr', 'view', String(pr.number), '--repo', pr.slug, '--json', 'comments'])).comments ?? [],
    sessionEvidence = (followUps) => makeEvidenceResolver({ followUps, jobsDir, home }),
    // #3720, both only when the caller names the canonical checkout (the CLI and run.mjs always do). Item-pull reads
    // the Priority order through dispatch-plan. reconcile-pass owns what a PR is owed and every refusal; its
    // `live-process` binding (cwd + HEAD sha) sees sessions a name match cannot, so it is read once for `we` (the only
    // repo it plans) and attached as refusals. A failed read is a source error, so apply refuses on half a picture.
    canonicalRoot = null, readItems = canonicalRoot ? createItemReader({ root: canonicalRoot }) : null,
    readReconcile = canonicalRoot ? () => JSON.parse(String(execFileSync('node', ['scripts/conveyor/reconcile-pass.mjs', '--json', '--repo=web-everything/web-everything'],
      { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' }))) : null } = ports;
  return function readInputs() {
    const errors = [], get = (source, fn, fallback) => { try { return fn(); } catch (e) { errors.push({ source, message: String(e.message ?? e) }); return fallback; } };
    const slugs = JSON.parse(io.readFileSync(sweptReposPath, 'utf8'));
    const prs = slugs.flatMap((slug) => {
      const repo = repoKeyFromSlug(slug);
      return get(`prs:${repo}`, () => JSON.parse(run('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '200', '--json', 'number,title,labels,baseRefName,headRefName,headRefOid,createdAt,updatedAt,mergeable,mergeStateStatus,isDraft,body'])).map((p) => ({ ...p, repo, slug })), []);
    });
    let sessions = get('sessions', readSessions, []);
    const capturedAt = now();
    const lanes = get('lanes', () => run('node', ['scripts/lane-pool.mjs', 'list', '--acquirable']).trim().split('\n').filter(Boolean), null);
    const history = get('drain-history', () => readJsonlTail(join(drainDir, 'history.jsonl'), { fs: io }), { entries: [], capped: false });
    const alerts = get('drain-alerts', () => readJsonlTail(join(drainDir, 'alerts.jsonl'), { fs: io }).entries, []);
    const trials = get('trials', () => missing(() => io.readFileSync(trialLog, 'utf8'), '').split('\n').filter(Boolean).map(JSON.parse), []);
    const results = get('results', () => missing(() => io.readdirSync(jobsDir), []).filter((n) => n.endsWith('.result.md')).map((n) => {
      const path = join(jobsDir, n); return { path, provider: resultProvider(io.readFileSync(path, 'utf8')), mtime: io.statSync(path).mtime.toISOString() };
    }), []);
    const prototype = get('prototype', readPrototype ?? (() => {
      if (refreshPrototype) run('git', ['fetch', 'origin']);
      const [behind, ahead] = run('git', ['rev-list', '--left-right', '--count', 'origin/main...origin/lane/mechanical-dispatcher']).trim().split(/\s+/).map(Number);
      if (![ahead, behind].every(Number.isFinite)) throw new Error('Invalid branch counts');
      return { ahead, behind, refreshed: refreshPrototype, reason: refreshPrototype ? 'fetched origin' : 'cached refs; plan does not fetch' };
    }), { status: 'unknown' });
    const fixPlans = {};
    // One planner for every repair row: a bounce (`review:changes`), a merge conflict (any review label) and a red `ci:failed` PR
    // all get their item-number-free plan (attribution `PR #<n>`, scope from the PR diff) from `planFixesFromReconcile`.
    const needsPlan = (p) => p.labels.some((l) => ['review:changes', 'ci:failed'].includes(l.name ?? l)) || isConflicting(p);
    for (const p of prs.filter(needsPlan)) {
      const target = `${p.repo}#${p.number}`;
      if (p.repo !== 'we') { fixPlans[target] = { refusal: { kind: 'unsupported-repo', why: 'fix planner supports we only' } }; continue; }
      fixPlans[target] = get(`fix:${target}`, () => {
        const names = p.labels.map((l) => l.name ?? l);
        const result = planFixesFromReconcile([{ ...p, kind: 'fix', prNumber: p.number, labels: isConflicting(p) && !names.includes(CONFLICT_LABEL) ? [...names, CONFLICT_LABEL] : names }], findItemFn, loadItems, resolveFallbackScope, 'we', fetchItemlessDiffPaths);
        return { planned: result.planned[0], refusal: result.refusals[0] };
      }, { refusal: { kind: 'source-failed', why: 'fix planner source failed' } });
    }
    // The durable repair evidence: the PR's own CI-heal and stand-down comments (only read for a PR that owes a repair).
    const repairEvidence = {};
    for (const p of prs.filter((p) => p.repo === 'we' && (isConflicting(p) || p.labels.some((l) => (l.name ?? l) === 'ci:failed')))) {
      repairEvidence[`${p.repo}#${p.number}`] = get(`repair-evidence:${p.repo}#${p.number}`, () => {
        const comments = readPrComments(p);
        const ciHealComments = countChargeableCiHealComments(comments, {
          restore: ports.ciHealBudgetRestore ?? resolveCiHealBudgetRestore(process.env),
        });
        const refunded = countCiHealComments(comments) - ciHealComments;
        return { ciHealComments, standDownComments: standDownComments(comments).length, ...(refunded > 0 ? { refunded } : {}) };
      }, {});
    }
    const ledger = get('follow-ups', () => readFollowUps({ store }), []);
    // A mechanical ci-heal runs as a detached wrapper (`pid:<n>` handle), invisible to `claude agents`: liveness is the kernel's.
    const pidOf = (entry) => /^pid:(\d+)$/.exec(entry.session ?? '')?.[1];
    const detachedAlive = (entry) => Boolean(pidOf(entry)) && Number(capturedAt) < Date.parse(entry.deadline) && isPidAlive(Number(pidOf(entry)));
    const detached = ledger.filter(detachedAlive).map((e) => e.target);
    // The mechanical session verdict (`conveyor/session-verdicts.mjs`), attached once so the pure planner stays pure.
    // No PR lookups here (plan never adds network); the reaper's own pass adds them when it applies.
    sessions = get('session-verdicts', () => {
      const evidenceFor = sessionEvidence(ledger);
      return sessions.map((s) => {
        const { verdict, action, why } = classifySession(s, { ...evidenceFor(s), pidAlive: s.liveness !== 'dead-record' }, { now: capturedAt });
        return { ...s, verdict, action, why };
      });
    }, sessions);
    const followUps = ledger.map((entry) => get(`follow-up:${entry.target}`, () => {
      const s = sessions.find((s) => [s.id, s.sessionId].includes(entry.session));
      const p = prs.find((p) => `${p.repo}#${p.number}` === entry.target);
      const ls = (p?.labels ?? []).map((l) => l.name ?? l);
      let observed = { ambiguous: !entry.session, targetMovedOn: Boolean(p && ((entry.kind === 'review' && !ls.includes('review:pending')) || (entry.kind === 'fix' && !ls.includes('review:changes'))
        || (entry.kind === 'ci-heal' && !ls.includes('ci:failed')) || (entry.kind === 'conflict-fix' && !isConflicting(p)))),
        drainWait: p ? drainWait(p, history.entries, history.capped) : null };
      if (followUpEvidence) observed = { ...observed, ...followUpEvidence(entry, { sessions, prs }) };
      else {
        if (!p) {
          const [key, pr] = entry.target.split('#'), slug = slugs.find((v) => repoKeyFromSlug(v) === key);
          if (slug) observed.targetState = JSON.parse(run('gh', ['pr', 'view', pr, '--repo', slug, '--json', 'state'])).state;
        }
        if (s?.sessionId && /^[\w-]+$/.test(s.sessionId)) {
          const path = join(home, '.claude/projects', String(s.cwd ?? '').replace(/[^A-Za-z0-9]/g, '-'), `${s.sessionId}.jsonl`);
          observed.lastActivityAt = missing(() => io.statSync(path).mtime.toISOString(), null);
        }
      }
      let resultPresent = results.some((r) => r.path === entry.expectedResultPath && Date.parse(r.mtime) >= Date.parse(entry.launchedAt));
      if (entry.expectedResultPath?.endsWith('.json')) {
        const record = missing(() => JSON.parse(io.readFileSync(entry.expectedResultPath, 'utf8')), null);
        const shared = ledger.some((other) => other !== entry && other.target !== entry.target && other.expectedResultPath === entry.expectedResultPath);
        resultPresent = !shared && record?.status === 'done' && Date.parse(record.startedAt) >= Date.parse(entry.launchedAt);
        if (shared) observed.ambiguous = true;
      }
      return { ...entry, evidence: { liveness: s?.liveness ?? (pidOf(entry) ? (detachedAlive(entry) ? 'live-active' : 'dead-record') : errors.some((e) => e.source === 'sessions') ? undefined : 'dead-record'), waitingFor: s?.waitingFor,
        resultPresent, targetState: p ? 'OPEN' : undefined,
        ...observed } };
    }, { ...entry, evidence: { ambiguous: true } }));
    const load = get('load', machineLoad, null);
    const items = readItems ? get('items', readItems, null) : undefined;
    const reconcileRefusals = readReconcile ? get('reconcile', () => reconcileHolds(readReconcile().refusals ?? []), {}) : {};
    return { now: capturedAt, prs, sessions, history: history.entries, historyCapped: history.capped, alerts, trials, results, prototype,
      fixPlans, repairEvidence, detached, followUps, escalationsDir, jobsDir, escalations: get('escalations', () => listEscalations({ dir: escalationsDir, fs: io }), []),
      freeLanes: errors.some((e) => e.source === 'sessions') ? 'unknown' : lanes?.length ?? 'unknown', cap, load, loadThreshold, errors, reconcileRefusals, ...(items ? { items } : {}) };
  };
}
export function createLandAdvanceApplier(ports = {}) {
  const { actions, run = runDefault, now = Date.now, home = homedir(), dispatchReview = realDispatchReview, dispatchFix = realDispatchFix, dispatchCiHeal = realDispatchCiHeal,
    readCapacity = () => ({ sessions: readLiveSessions({ run }), freeLanes: run('node', ['scripts/lane-pool.mjs', 'list', '--acquirable']).trim().split('\n').filter(Boolean).length,
      load: loadavg()[0] / cpus().length }),
    pickFixLane = () => { const path = run('node', ['scripts/lane-pool.mjs', 'list', '--acquirable']).trim().split('\n')[0]; const n = path?.match(/lane-(\d+)\/?$/)?.[1]; if (!n) throw new Error('No numbered fix lane'); return Number(n); },
    writeLedger = (e) => writeFollowUp(e), reap = () => run('node', ['scripts/conveyor/session-reaper.mjs']),
    escalationsDir = join(home, 'workspace/.operations/escalations'),
    expectedResultPathFor = (result) => result?.expectedResultPath ?? (result?.sessionSlug ? completionPath(result.sessionSlug) : null),
    writePacket = (packet) => writeEscalationPacket(packet, { dir: escalationsDir }),
    canonicalRoot = null, queueItem = (num) => { if (!canonicalRoot) throw new Error('no canonical checkout to queue items into'); queueItemInto(canonicalRoot, num, now); } } = ports;
  // `allow` is the operator opt-in's kinds (land-advance-gate.mjs). The default keeps the PR half's old behaviour.
  return async function apply(plan, allow = { prs: true, items: false }) {
    const dispatched = [], errors = [], deferred = [], queued = [];
    let target = null;
    if (plan.errors.length) return { dispatched, queued, errors: [{ message: 'Required evidence failed; refusing apply' }], deferred };
    try {
      for (const row of plan.rows.filter((r) => r.owedAction === 'escalate')) await writePacket(buildEscalationPacket(row, now(), plan.escalations.find((p) => p.id === row.packetId)));
      if (plan.rows.some((r) => r.owedAction === 'reap-owed')) await reap();
      let remaining = plan.capacity.budget;
      for (const row of allow.prs ? plan.proposed : []) {
        target = row.subject;
        const capacity = capacityFor({ ...plan.capacity, ...await readCapacity() });
        if (!remaining || !capacity.budget) { deferred.push({ target: row.subject, reason: 'capacity' }); break; }
        const kind = followUpKindFor(row.owedAction), extraArgs = [allowedToolsArg(kind)];
        const launchTime = now();
        // `fix` and `conflict-fix` share the reconcile fix dispatch; `ci-heal` goes through the tick's own sink (ci-heal-pr-dispatch.mjs).
        // #3856 graduation — `repo:` is the internal repo KEY (`row.repo`, e.g. `we`), not the gh slug
        // (`row.slug`, e.g. `web-everything/web-everything`): `dispatchCiHeal`/`dispatchFix` thread it straight into
        // `sessionSlugFor` → `repoSlugTag`, which (unlike `repoProfile`) accepts only a known internal key, never
        // a gh slug — see `we:scripts/lib/constellation-repos.mjs#repoSlugTag`. This module's own branch snapshot
        // predates that multi-repo tightening, which is why it originally read `row.slug` here.
        const result = kind === 'review' ? await dispatchReview({ pr: row.pr, repo: row.repo, extraArgs, actions })
          : kind === 'ci-heal' ? await dispatchCiHeal({ ...row.fixPlan, reason: 'red-ci', lane: await pickFixLane() }, { extraArgs, actions, repo: row.repo })
          : await dispatchFix({ ...row.fixPlan, lane: await pickFixLane() }, { extraArgs, actions, repo: row.repo });
        if (result?.held) { deferred.push({ target: row.subject, reason: result.reason === 'unavailable' ? 'coordination-unavailable' : 'held-by-action-record' }); continue; }
        if (result?.ok === false || result?.error) throw new Error(result.error ?? 'dispatch failed');
        // A review refused by the fresh CI gate never started: no ledger entry, no capacity spent.
        if (result?.skipped) { deferred.push({ target: row.subject, reason: String(result.skipped) }); continue; }
        const session = result?.agentId ?? null;
        const launchedAt = new Date(launchTime).toISOString();
        const entry = { session: session ?? null, kind, target: row.subject, launchedAt, deadline: new Date(now() + 7200000).toISOString(),
          expectedResultPath: expectedResultPathFor(result), permissionsGranted: [...ALLOWED_TOOLS_BY_KIND[kind]] };
        // Persist even an unidentifiable launch; never retry blindly after a spawn.
        await writeLedger(entry); dispatched.push({ ...entry, result }); remaining--;
        if (!session) throw new Error('Dispatch returned no addressable session');
      }
      // Items are queued, not spawned: the runner's tick launches them through dispatch-lane under its own guards.
      for (const item of allow.items ? plan.items?.proposed ?? [] : []) { target = `item:${item.num}`; await queueItem(item.num); queued.push(item.num); }
    } catch (e) { errors.push({ target, message: String(e.message ?? e) }); }
    return { dispatched, queued, errors, deferred };
  };
}
