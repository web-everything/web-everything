/**
 * @file land-advance.mjs
 * What is owed is independent of what can launch. Capacity is computed first;
 * oldest waits consume it first, with refusals retained as visible rows.
 * Precedence: fold > operator > conflict-fix > ci-heal > drain/escalate > fix > review > stale > none.
 * The two repair rows (land-advance-repair.mjs) are PR-closing work: capped retries, a spent cap or a hard refusal is an
 * `escalate` packet (never an operator row), and neither ever touches a `review:*` label.
 * Session rows use the mechanical verdict of conveyor/session-verdicts.mjs when the reader attached one.
 * Follow-up verdict rules (first match): explicit closed/moved target => moved-on;
 * result/done => finished; uncertain identity => ambiguous; absent process => dead;
 * permission wait => waiting-permission; observed activity before deadline =>
 * progressing; expired deadline with no recent activity => stalled. Missing process
 * evidence is ambiguous, never proof of death. All dates and evidence are supplied.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { capToConcurrency } from '../lib/lane-concurrency.mjs';
import { extractManifestFromBody } from '../readiness/lane-manifest.mjs';
import { repairOwed, queueFirstHold, orderForHold, deferralReason, REPAIR_RETRY_CAP } from './land-advance-repair.mjs';
import { planItems, DEFAULT_MAX_ITEMS_PER_CALL } from './land-advance-items.mjs';
export const LAND_ADVANCE_OP = 'land-advance';
export const OWED_ACTIONS = Object.freeze(['dispatch-review', 'dispatch-fix', 'dispatch-ci-heal', 'dispatch-conflict-fix', 'fold-into-prototype', 'wait-on-drain', 'stale-label', 'needs-operator', 'escalate', 'none', 'graduation-owed', 'reap-owed', 'delegation-trial-owed']);
export const FOLLOW_UP_VERDICTS = Object.freeze(['progressing', 'finished', 'stalled', 'dead', 'waiting-permission', 'target-moved-on', 'ambiguous']);
export const STALE_LABEL_RULES = Object.freeze([Object.freeze({ label: 'checking', thresholdMs: 3600000, mergeStateStatus: 'CLEAN' })]);
export function repoKeyFromSlug(value) {
  for (const [key, meta] of Object.entries(CONSTELLATION_REPOS)) {
    if ([key, meta.slug, meta.slug.split('/').at(-1), `chalbert/${meta.slug}`].includes(value)) return key;
  }
  throw new TypeError(`Unknown constellation repo: ${value}`);
}
export const isLive = (s) => ['live-active', 'live-idle', 'waiting'].includes(s.liveness);
const labels = (p) => (p.labels ?? []).map((v) => typeof v === 'string' ? v : v.name);
/**
 * Verdicts that hold a worker slot: a live process doing (or stuck in) its work. `finished-unreaped` and
 * `target-moved-on` are finished sessions whose process merely lingers, and `dead-record` has no process, so none of them
 * consumes capacity. A session with NO verdict (an older reader, a bare fixture) keeps the liveness-only rule.
 */
export const SLOT_VERDICTS = Object.freeze(['progressing', 'stalled', 'waiting-permission']);
const holdsSlot = (s) => isLive(s) && (s.verdict === undefined || SLOT_VERDICTS.includes(s.verdict));
// TODO(#3807): replace this load gate (`os.loadavg()` over the cores, against 1.5) with the tracked `dispatch-budget`
// config's weighted budget and its emergency floor once #3807 lands; the statute says "No load-average gate".
export function capacityFor({ sessions = [], freeLanes = 'unknown', cap = 3, load = 0, loadThreshold = 1.5 }) {
  const live = sessions.filter((s) => s.kind === 'background' && holdsSlot(s) && /^(review-|fix-|ci-heal-|conveyor-|prepare)/.test(s.name ?? '')).length;
  const known = Number.isInteger(freeLanes) && freeLanes >= 0 && Number.isFinite(load);
  const budget = known && load <= loadThreshold ? capToConcurrency(Array.from({ length: freeLanes }), { activeCount: live, cap }).admitted.length : 0;
  return { budget, live, freeLanes, cap, load, loadThreshold };
}
export function followUpVerdict(entry, e = {}, now) {
  if (e.targetMovedOn || ['CLOSED', 'MERGED'].includes(e.targetState)) return 'target-moved-on';
  if (e.resultPresent || e.liveness === 'done') return 'finished';
  if (e.ambiguous) return 'ambiguous';
  if (e.liveness === 'dead-record') return 'dead';
  if (e.waitingFor) return 'waiting-permission';
  if (e.drainWait) return 'progressing';
  if (!isLive(e)) return 'ambiguous';
  if (Number(now) > Date.parse(entry.deadline) && !(e.lastActivityAt && Number(now) - Date.parse(e.lastActivityAt) >= 0 && Number(now) - Date.parse(e.lastActivityAt) < 1800000)) return 'stalled';
  return 'progressing';
}
export function sessionMatch(session, p, prs, followUps = []) {
  if (!new RegExp(`^(?:review|fix|ci-heal)-${p.number}[a-z]?$`, 'i').test(session.name ?? '')) return 'none';
  const entries = followUps.filter((e) => [session.id, session.sessionId].includes(e.session));
  if (entries.length) return entries.some((e) => e.target === `${p.repo}#${p.number}`) ? 'matched' : 'none';
  return prs.filter((x) => x.number === p.number).length > 1 ? 'ambiguous' : 'matched';
}
export function drainWait(p, history = [], capped = false) {
  let reasons, since, count = 0;
  for (const pass of [...history].reverse()) {
    const matches = (x) => Number(x.num) === p.number && repoKeyFromSlug(x.repo ?? 'we') === p.repo;
    const detail = (pass.deferredDetail ?? []).find(matches);
    const skip = (pass.skippedPrs ?? []).find(matches);
    const next = detail?.waitOn?.length ? [...detail.waitOn].sort() : skip ? [skip.reason] : null;
    if (!next || (reasons && JSON.stringify(reasons) !== JSON.stringify(next))) break;
    reasons = next; since = pass.at; count++;
  }
  return count ? { reasons, since, count, passes: `${capped && count === history.length ? '>=' : ''}${count}` } : null;
}
export function planLandAdvance(inputs) {
  const { now, prs = [], sessions = [], followUps = [], history = [], results = [], trials = [], fixPlans = {}, errors = [] } = inputs;
  const capacity = capacityFor(inputs), rows = [], hold = queueFirstHold(prs, now), prsByKey = new Map(prs.map((p) => [`${p.repo}#${p.number}`, p]));
  const add = (subject, owedAction, evidence, since, extra = {}) => {
    const age = typeof since === 'number' ? since : Date.parse(since);
    rows.push({ repo: null, pr: null, subject, owedAction, evidence, waitingSince: Number.isFinite(age) ? new Date(age).toISOString() : null,
      ageMs: Number.isFinite(age) ? Math.max(0, Number(now) - age) : null, ...extra });
  };
  for (const p of prs) {
    const subject = `${p.repo}#${p.number}`, ls = labels(p), wait = drainWait(p, history, inputs.historyCapped);
    let action = 'none', evidence = [ls.includes('review:accepted') ? 'review:accepted, ready-to-merge — drain owns landing' : 'nothing owed'], since = p.updatedAt, extra = {};
    const worker = (kind) => sessions.filter((s) => isLive(s) && s.name?.startsWith(`${kind}-`)).map((s) => sessionMatch(s, p, prs, followUps));
    // A finished session whose process lingers holds no slot: it must not hide a repair the PR still owes.
    const repairWorkers = sessions.filter((s) => holdsSlot(s) && /^(?:fix|ci-heal)-/.test(s.name ?? '')).map((s) => sessionMatch(s, p, prs, followUps));
    const repair = repairOwed(p, ls, { liveWorker: repairWorkers.includes('matched') || (inputs.detached ?? []).includes(subject), subject, followUps, repairEvidence: inputs.repairEvidence, retryCap: inputs.repairRetryCap ?? REPAIR_RETRY_CAP });
    if (ls.includes('review:accepted') && p.baseRefName === 'lane/mechanical-dispatcher') {
      action = 'fold-into-prototype'; evidence = ['base lane/mechanical-dispatcher; operator/fold worker'];
    } else if (ls.includes('review:human') && ls.includes('advisory:accepted')) {
      action = 'needs-operator'; evidence = ['review:human + advisory:accepted'];
    } else if (repair) {
      const fix = fixPlans[subject], what = repair.kind === 'conflict-fix' ? `merge conflict (${p.mergeStateStatus ?? p.mergeable}); ${ls.filter((l) => l.startsWith('review:')).join(', ') || 'no review label'}` : 'ci:failed';
      if (repair.exhausted) {
        action = 'escalate'; evidence = [`${what}; ${repair.exhausted.why}`]; extra = { kind: `${repair.kind}-exhausted`, verdict: 'repair not re-dispatched' };
      } else {
        action = repair.owedAction; evidence = [`${what}; no live fixer`];
        extra = { fixPlan: fix?.planned, refusal: fix?.refusal ?? (!fix?.planned ? { kind: 'missing-fix-plan', why: 'fix planner evidence unavailable' } : undefined) };
        if (repairWorkers.includes('ambiguous')) extra.refusal = { kind: 'ambiguous', why: 'name-only session matches multiple repositories' };
        // A hard refusal (no scope, unsupported repo, no plan) will not clear by waiting: hand it to triage as a packet.
        if (extra.refusal && extra.refusal.kind !== 'ambiguous') { evidence.push(extra.refusal.why); action = 'escalate'; extra = { kind: `${repair.kind}-refused`, verdict: 'repair dispatch refused', refusal: undefined }; }
      }
    } else if (wait) {
      since = wait.since; action = Number(now) - Date.parse(since) >= (inputs.drainThresholdMs ?? 7200000) && wait.count >= (inputs.drainThresholdPasses ?? 90) ? 'escalate' : 'wait-on-drain';
      evidence = [...wait.reasons, `${wait.passes} consecutive passes since ${since}`];
      if (action === 'escalate') extra.kind = 'stuck-in-drain';
      if (wait.reasons.some((r) => r.startsWith('couple-carrier:'))) {
        const manifest = extractManifestFromBody(p.body);
        if (!manifest) evidence.push('couple manifest missing or unparsable');
        for (const half of manifest?.repos ?? []) {
          if (half.carriesResolve) continue;
          const impl = prs.find((x) => x.repo === repoKeyFromSlug(half.repo) && x.headRefName === half.ref);
          if (impl) { extra.blockedBy = `${impl.repo}#${impl.number}`; evidence.push(`impl half ${extra.blockedBy} is ${labels(impl).join(',')}, ${impl.mergeStateStatus}; waiting since ${impl.updatedAt}`); }
          else evidence.push(`impl half ${half.repo} ${half.ref}: no matching open PR`);
        }
      }
    } else if (ls.includes('review:changes') && !worker('fix').includes('matched')) {
      action = 'dispatch-fix'; const fix = fixPlans[subject];
      extra = { fixPlan: fix?.planned, refusal: fix?.refusal ?? (!fix?.planned ? { kind: 'missing-fix-plan', why: 'fix planner evidence unavailable' } : undefined) };
      evidence = ['review:changes; no matched live fixer'];
    } else if (ls.includes('review:pending') && !worker('review').includes('matched')) {
      action = 'dispatch-review'; since = p.createdAt; evidence = ['review:pending; no matched live reviewer'];
    } else if (STALE_LABEL_RULES.some((r) => ls.includes(r.label) && p.mergeStateStatus === r.mergeStateStatus && Number(now) - Date.parse(p.updatedAt) > r.thresholdMs)) {
      action = 'stale-label'; evidence = ['checking on CLEAN PR for over one hour'];
    }
    if (action.startsWith('dispatch-') && worker(action === 'dispatch-review' ? 'review' : 'fix').includes('ambiguous')) extra.refusal = { kind: 'ambiguous', why: 'name-only session matches multiple repositories' };
    if (action.startsWith('dispatch-') && followUps.some((e) => e.target === subject && followUpVerdict(e, e.evidence, now) === 'ambiguous')) extra.refusal = { kind: 'ambiguous', why: 'prior dispatch identity or outcome is unresolved' };
    // #3720: reconcile-pass's refusals (`reconcileHolds` in land-advance-items-io.mjs) hold a review or fix row.
    const rc = inputs.reconcileRefusals?.[subject];
    if (rc?.holds?.includes({ 'dispatch-review': 'review', 'dispatch-fix': 'fix' }[action])) extra.refusal = { kind: rc.kind, why: `reconcile-pass refuses: ${rc.why}` };
    if (extra.refusal) evidence.push(extra.refusal.why);
    add(subject, action, evidence, since, { repo: p.repo, pr: p.number, slug: p.slug, dispatchable: action.startsWith('dispatch-') && !extra.refusal && !p.isDraft, ...extra });
  }
  if (inputs.prototype?.ahead > 0 && !prs.some((p) => p.repo === 'we' && /^lane\/graduate-3443-/.test(p.headRefName)) && !sessions.some((s) => isLive(s) && /^(graduate-3443|conveyor-3443$)/.test(s.name ?? ''))) add('we:graduation-3443', 'graduation-owed', [`ahead ${inputs.prototype.ahead}, behind ${inputs.prototype.behind}`, inputs.prototype.reason ?? 'branch state supplied']);
  const dead = sessions.filter((s) => s.liveness === 'dead-record');
  if (dead.length) add('sessions:dead-records', 'reap-owed', [`${dead.length} dead records: ${dead.slice(0, 10).map((s) => s.name).join(', ')}`], null, { count: dead.length });
  // Reap owed comes from the mechanical session verdict (`conveyor/session-verdicts.mjs`) when the reader attached one:
  // finished-unreaped (a `blocked`/idle session with a fresh result) and target-moved-on, not just registry `done`.
  // A session with no verdict (an older reader, a bare fixture) keeps the registry-`done` rule.
  for (const s of sessions) {
    const reap = s.verdict ? ['finished-unreaped', 'target-moved-on'].includes(s.verdict) && s.liveness !== 'dead-record' : s.liveness === 'done';
    if (reap) add(`session:${s.id ?? s.sessionId}`, 'reap-owed', [s.why ?? 'done; collect result and reap'], s.startedAt);
    // The ladder's second rung: a live session that is stalled / waiting on a permission prompt AFTER its one redispatch
    // is an escalation packet (agent triage), never an operator row. The first rung (redispatch-once) is not a row yet.
    if (s.verdict && s.action === 'escalate') add(`session:${s.name ?? s.id ?? s.sessionId}`, 'escalate', [s.why], s.startedAt, { kind: `session-${s.verdict}`, verdict: s.verdict });
  }
  for (const r of results) if (r.provider && !trials.some((t) => t.result === r.path && String(t.provider).toLowerCase() === r.provider.toLowerCase())) add(r.path, 'delegation-trial-owed', [`${r.provider} authorship; missing trial record`], r.mtime);
  for (const e of followUps) {
    const verdict = followUpVerdict(e, e.evidence, now);
    if (['finished', 'stalled', 'ambiguous'].includes(verdict)) add(e.target, verdict === 'finished' ? 'reap-owed' : 'escalate', [`follow-up ${e.session}: ${verdict}${verdict === 'finished' ? '; collect result' : ''}`], e.launchedAt, { kind: `follow-up-${verdict}`, verdict });
  }
  rows.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  const proposed = [], deferred = [];
  for (const row of orderForHold(rows.filter((r) => r.owedAction.startsWith('dispatch-')), { hold, now, prsByKey })) {
    if (row.dispatchable && proposed.length < capacity.budget) proposed.push(row);
    else deferred.push({ ...row, reason: deferralReason(row, { hold, proposed, now, prsByKey }) });
  }
  for (const r of rows.filter((r) => r.owedAction === 'escalate')) {
    r.packetId = `${r.kind}-${r.subject}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    r.packet = `would-write ${inputs.escalationsDir ?? '~/.operations/escalations'}/${r.packetId}.json`;
  }
  // Item-pull (#3720): owed PR work is finishing work already in flight, so it takes the budget first; new items
  // get what is left, capped per call. `inputs.items` is the item reader's output, absent when it did not run.
  const items = inputs.items ? planItems({ ...inputs.items, budget: capacity.budget - proposed.length, maxItems: inputs.maxItemsPerCall ?? DEFAULT_MAX_ITEMS_PER_CALL }) : null;
  return { generatedAt: new Date(now).toISOString(), capacity, queueFirst: hold, rows, proposed, deferred, items, errors, prototype: inputs.prototype ?? null, escalations: inputs.escalations ?? [], alerts: inputs.alerts ?? [] };
}
export function renderTable(plan) {
  const safe = (x) => String(x).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  const age = (ms) => ms == null ? '—' : ms >= 86400000 ? `${Math.floor(ms / 86400000)}d ${Math.floor(ms / 3600000) % 24}h` : ms >= 3600000 ? `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m` : `${Math.floor(ms / 60000)}m`;
  const proto = plan.prototype?.ahead == null ? 'unknown' : `ahead ${plan.prototype.ahead}, behind ${plan.prototype.behind} (${plan.prototype.reason ?? 'supplied'})`;
  return [`Capacity: ${JSON.stringify(plan.capacity)}`, `Prototype branch vs main: ${proto}`,
    `Proposed: ${plan.proposed.map((r) => r.subject).join(', ') || 'none'}`,
    ...plan.errors.map((e) => `Source error: ${e.source}: ${e.message}`),
    '| Subject | Owed | Waiting | Evidence |', '| --- | --- | --- | --- |',
    ...plan.rows.map((r) => `| ${safe(r.subject)} | ${r.owedAction} | ${age(r.ageMs)} | ${safe([...r.evidence, r.packet].filter(Boolean).join('; '))} |`),
    ...plan.deferred.map((r) => `Deferred ${r.subject}: ${r.reason}`),
    ...(plan.items ? [`Items proposed: ${plan.items.proposed.map((i) => `#${i.num} (line ${i.rank}) → lane-${i.lane}`).join(', ') || 'none'}`,
      ...plan.items.deferred.map((i) => `Item held #${i.num} (line ${i.rank ?? '—'}): ${i.reason}`),
      ...plan.items.skipped.map((i) => `Item skipped #${i.num} (line ${i.rank ?? 'claimed'}): ${i.reason}`)] : []),
    ...(plan.mode ? [`Mode: ${plan.mode.mode} (${plan.mode.why})`] : []),
    ...(plan.escalations?.filter((e) => e.status === 'open').map((e) => `Open escalation ${e.id}: ${e.question}`) ?? [])].join('\n');
}
/**
 * Plan or dispatch (#3720). Dispatch needs BOTH the operator's durable opt-in file and no pause marker, both read
 * from the canonical checkout (`land-advance-gate.mjs`); `--apply`/`--mode=dispatch` alone only asks. Any pause
 * (even a kind-scoped one) and an unreadable gate both mean plan. The opt-in has separate `prs` and `items` kinds.
 */
export function decideMode({ requested = 'plan', gate = {} } = {}) {
  const plan = (why) => ({ mode: 'plan', prs: false, items: false, why });
  if (requested !== 'dispatch') return plan('plan requested (the default)');
  if (gate.error) return plan(`gate unreadable, so plan only: ${gate.error}`);
  if (gate.ambiguous?.length) return plan(`canonical checkout is ambiguous (${gate.ambiguous.join(', ')}), so plan only`);
  if (gate.paused) return plan(`dispatch-pause marker is set${gate.pausePath ? ` at ${gate.pausePath}` : ''}`);
  const optIn = gate.optIn ?? {};
  if (optIn.prs !== true && optIn.items !== true) return plan(`no operator opt-in${gate.optInPath ? ` at ${gate.optInPath}` : ''}`);
  return { mode: 'dispatch', prs: optIn.prs === true, items: optIn.items === true, why: 'operator opt-in set and no pause marker' };
}
export function landAdvanceOperation({ readInputs } = {}) {
  if (typeof readInputs !== 'function') throw new TypeError('land-advance needs readInputs()');
  return op(LAND_ADVANCE_OP, { input: {}, verdictFrom: 'assess', read: compute({ reads: [], fn: () => readInputs() }),
    assess: compute({ reads: ['findings.read'], fn: (v) => planLandAdvance(v.findings.read) }) });
}
