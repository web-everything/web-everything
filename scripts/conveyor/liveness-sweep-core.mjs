/**
 * Pure liveness detection and recovery planning; callers supply snapshots and time.
 * Kinds: idle/red/capped PRs, refused daemon updates, held verify lanes, dead holders.
 * Ladder: refused update → retry → refresh → notify; held lane → release → notify;
 * dead holder → release → notify; PR stalls → notify only. Never loosen a gate or review.
 * Settings cascade: standard → platform livenessSweep → tool → env. Disabled rungs
 * report dry-run plans with notify fallbacks; execution and proof belong to the IO side.
 */
import { resolveCascade } from '../lib/policy-cascade.mjs';
import { countGrantedRoundExtensions } from './round-extension-mark.mjs';

export const LIVENESS_SWEEP_POLICY = 'livenessSweep';
export const LIVENESS_SWEEP_STANDARD = Object.freeze({
  prNoMovementMinutes: 120, prRedUnownedMinutes: 60, selfUpdateRefusedMinutes: 30,
  laneHeldMinutes: 30, claimHolderGoneMinutes: 60, reviewRoundCap: 5, maxRungAttempts: 2,
  rungs: Object.freeze({ 'retry-self-update': true, 'release-dead-lane': true,
    'refresh-stale-base': false, 'release-dead-claim': false }),
});
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const positiveInt = v => Number.isInteger(v) && v > 0;
export const LIVENESS_SWEEP_VALID = Object.freeze({
  prNoMovementMinutes: positiveInt, prRedUnownedMinutes: positiveInt,
  selfUpdateRefusedMinutes: positiveInt, laneHeldMinutes: positiveInt,
  claimHolderGoneMinutes: positiveInt, reviewRoundCap: positiveInt, maxRungAttempts: positiveInt,
  rungs: v => object(v) && Object.values(v).every(x => typeof x === 'boolean'),
});

function validatedLayer(value, name, invalid) {
  if (!object(value) || !Object.hasOwn(value, 'rungs')) return value;
  const copy = { ...value };
  if (!object(copy.rungs)) {
    if (copy.rungs !== undefined) invalid.push(`${name}.rungs=${JSON.stringify(copy.rungs)}`);
    delete copy.rungs;
  } else {
    copy.rungs = Object.fromEntries(Object.entries(copy.rungs).filter(([key, v]) => {
      if (typeof v === 'boolean') return true;
      invalid.push(`${name}.rungs.${key}=${JSON.stringify(v)}`); return false;
    }));
  }
  return copy;
}
export function resolveLivenessSettings({ standard = LIVENESS_SWEEP_STANDARD, platform, tool, envValues } = {}) {
  const invalid = [];
  const plat = validatedLayer(platform, 'platform', invalid);
  const local = validatedLayer(tool, 'tool', invalid);
  const withoutRungs = value => object(value) ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'rungs')) : value;
  const result = resolveCascade({ standard: withoutRungs(standard), platform: withoutRungs(plat),
    tool: withoutRungs(local), envValues: withoutRungs(envValues), valid: LIVENESS_SWEEP_VALID });
  // resolveCascade applies top-level predicates to nested leaves. Rungs need
  // boolean leaf validation, while their public validator validates whole objects.
  const rungs = resolveCascade({ standard: standard.rungs, platform: plat?.rungs,
    tool: local?.rungs, valid: v => typeof v === 'boolean' });
  result.value.rungs = rungs.value;
  for (const [key, source] of Object.entries(rungs.sources)) result.sources[`rungs.${key}`] = source;
  if (envValues?.rungs !== undefined) {
    if (LIVENESS_SWEEP_VALID.rungs(envValues.rungs)) {
      result.value.rungs = { ...envValues.rungs };
      for (const key of Object.keys(result.sources)) if (key.startsWith('rungs.')) delete result.sources[key];
      result.sources.rungs = 'env';
    } else invalid.push(`env.rungs=${JSON.stringify(envValues.rungs)}`);
  }
  return { settings: result.value, sources: result.sources, invalid: [...invalid, ...result.invalid] };
}

const time = v => v == null ? NaN : new Date(v).getTime();
const iso = v => new Date(v).toISOString();
const sorted = rows => [...(rows ?? [])].filter(r => Number.isFinite(time(r.at))).sort((a, b) => time(a.at) - time(b.at));
const latestTime = values => { const times = values.map(time).filter(Number.isFinite); return times.length ? Math.max(...times) : NaN; };

export function parseRebuildLogLines(text, { cloneKey } = {}) {
  return String(text ?? '').split(/\r?\n/).flatMap(line => {
    const m = line.match(/(\d{4}-\d\d-\d\dT\S+) daemon-rebuild: ([\w-]+) (\{.*\})/);
    if (!m || !['clone-held-stale', 'pinned-overlay-conflict', 'overlay-conflict-unresolved', 'ready-candidate-adopted'].includes(m[2])) return [];
    try { return [{ cloneKey, at: m[1], kind: m[2], detail: JSON.parse(m[3]) }]; } catch { return []; }
  });
}
export function parseRebuildAlertsJsonl(text, { cloneKey } = {}) {
  return String(text ?? '').split(/\r?\n/).flatMap(line => {
    try { const row = JSON.parse(line); return object(row) && Number.isFinite(time(row.at)) && typeof row.kind === 'string'
      ? [{ cloneKey, at: row.at, kind: row.kind, detail: row.detail ?? {} }] : []; } catch { return []; }
  });
}
export function parseVerifyHoldLines(text) {
  return String(text ?? '').split(/\r?\n/).flatMap(line => {
    const m = line.match(/^(\S+) verify-daemon: .*HEALTH gate job (\S+) for ([^\s/]+)\/(lane-\d+) .*gate pid (\d+).*gone \(([^)]+)\).*lane held/);
    const dir = line.match(/release-lane --dir=(?:"([^"]+)"|'([^']+)'|(\S+))/);
    return m && dir && Number.isFinite(time(m[1])) ? [{ at: m[1], jobId: m[2], pool: m[3], lane: m[4],
      pid: Number(m[5]), state: m[6], finished: /is finished/.test(line), dir: dir[1] ?? dir[2] ?? dir[3] }] : [];
  });
}

export function findLiveOwner(agents, prNumber) {
  if (!/^\d+$/.test(String(prNumber))) return undefined;
  const pattern = new RegExp(`^(fix|ci-heal|heal|conflict|review|takeover|rebase|refresh)-.*\\b${prNumber}\\b`);
  return (agents ?? []).find(a => !['done', 'stopped', 'failed'].includes(a.state) && pattern.test(a.name));
}
const labelsOf = pr => (pr.labels ?? []).map(l => l.name);
function movementTime(pr) {
  if (pr.movementSince != null) return time(pr.movementSince);
  const seen = new Set();
  const comments = [...(pr.comments ?? [])].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  const firsts = comments.filter(c => { const first = String(c.body ?? '').split(/\r?\n/)[0];
    if (seen.has(first)) return false; seen.add(first); return true; });
  return latestTime([...(pr.statusCheckRollup ?? []).map(c => c.completedAt), ...firsts.map(c => c.createdAt)]);
}
function latestChecks(pr) {
  const checks = new Map();
  for (const check of pr.statusCheckRollup ?? []) {
    const prev = checks.get(check.name);
    if (!prev || (time(check.completedAt) || 0) >= (time(prev.completedAt) || 0)) checks.set(check.name, check);
  }
  return [...checks.values()];
}
function lastReview(pr) {
  let last;
  for (const c of [...(pr.comments ?? [])].sort((a, b) => time(a.createdAt) - time(b.createdAt))) {
    for (const m of String(c.body ?? '').matchAll(/<!--\s*reviewed-sha:\s*([a-f\d]+)\s*-->|<!--\s*we:red-team-gate\s+pr=(\d+)\s+rev=([a-f\d]+)\b[^>]*-->/gi)) {
      if (m[2] && Number(m[2]) !== Number(pr.number)) continue;
      last = { sha: m[1] ?? m[3], at: c.createdAt };
    }
  }
  return last;
}
function detectPrs(snapshot, settings, add, named) {
  for (const pr of snapshot.prs ?? []) {
    if ((pr.state ?? 'OPEN') !== 'OPEN') continue;
    const owner = findLiveOwner(snapshot.agents, pr.number);
    const reviewOrFixOwner = findLiveOwner((snapshot.agents ?? []).filter(a => /^(review|fix)-/.test(a.name)), pr.number);
    const labels = labelsOf(pr);
    const subject = `${pr.repo ?? 'unknown'}#${pr.number}`;
    const evidence = { repo: pr.repo, number: pr.number, title: pr.title, labels };
    const red = labels.includes('status:ci-red') || latestChecks(pr).some(c => ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(c.conclusion));
    if (!owner && red && !labels.some(l => l.startsWith('review:'))) add('pr-red-unowned', subject,
      latestTime((pr.statusCheckRollup ?? []).map(c => c.completedAt)), settings.prRedUnownedMinutes, 'Red PR has no review label or live owner (card 278)', evidence);
    const round = Math.max(0, ...labels.map(l => Number(l.match(/^review-round:(\d+)$/)?.[1]) || 0));
    const cap = settings.reviewRoundCap + countGrantedRoundExtensions(pr.comments, { repo: pr.repo, pr: pr.number });
    const reviewed = lastReview(pr);
    const head = pr.headRefOid;
    if (!reviewOrFixOwner && round >= cap && reviewed && head && !head.startsWith(reviewed.sha) && !reviewed.sha.startsWith(head)) add('pr-past-cap-fix-waiting', subject, time(reviewed.at), 0,
      'Changed head awaits review beyond the granted round cap', { ...evidence, round, cap, reviewedSha: reviewed.sha, headRefOid: head });
    // The generic guard: only when no more specific PR kind already named this PR (one finding per stall).
    if (!owner && !pr.isDraft && !labels.includes('review:human') && !named(subject)) add('pr-no-movement', subject, movementTime(pr), settings.prNoMovementMinutes, 'PR has no movement or live owner', evidence);
  }
}
const refusalKinds = new Set(['pinned-overlay-conflict', 'overlay-conflict-unresolved', 'clone-held-stale']);
function detectRebuilds(snapshot, settings, add) {
  const keys = new Set([...(snapshot.rebuildAlerts ?? []).map(a => a.cloneKey), ...(snapshot.rebuildStates ?? []).map(s => s.cloneKey)]);
  for (const cloneKey of keys) {
    const alerts = sorted((snapshot.rebuildAlerts ?? []).filter(a => a.cloneKey === cloneKey));
    const state = (snapshot.rebuildStates ?? []).find(s => s.cloneKey === cloneKey);
    const last = alerts.at(-1);
    let start;
    let detail;
    if (last?.kind === 'clone-held-stale' && last.detail?.reason === 'still-rejected' && last.detail.retryAt == null) {
      start = time(last.at); detail = last.detail;
      for (let i = alerts.length - 1; i >= 0 && refusalKinds.has(alerts[i].kind); i--) start = time(alerts[i].at);
    }
    const rejected = state?.rejected;
    const adoption = latestTime([state?.adopted?.at, ...alerts.filter(a => a.kind === 'ready-candidate-adopted').map(a => a.at)]);
    // Any non-refusal rebuild activity after the rejection (a queued/started job, a new attempt) means it is moving.
    const movedSince = rejected && alerts.some(a => !refusalKinds.has(a.kind) && time(a.at) > time(rejected.at));
    if (rejected && rejected.retryAt == null && state.inProgress == null && !movedSince
      && (!Number.isFinite(adoption) || adoption < time(rejected.at))) {
      start = Number.isFinite(start) ? Math.min(start, time(rejected.at)) : time(rejected.at);
      detail ??= { reason: rejected.reason };
    }
    if (!Number.isFinite(start) || (Number.isFinite(adoption) && adoption >= start)) continue;
    // A retry already scheduled (by the daemon or by this sweep) or a rebuild in flight is not stuck.
    if (state?.rejected?.retryAt != null || state?.inProgress != null) continue;
    const lastAt = iso(latestTime([last?.at, rejected?.at]));
    const failed = detail?.broken?.failed ?? rejected?.reason;
    const overlayPr = String(failed ?? '').match(/\(PR #(\d+)\)/)?.[1];
    add('daemon-update-refused', `clone:${cloneKey}`, start, settings.selfUpdateRefusedMinutes, 'Self-update refused with no scheduled retry',
      { cloneKey, clone: last?.clone ?? state?.clone, reason: detail?.reason, failed, retryAt: null, lastAt,
        ...(overlayPr ? { overlayPr: Number(overlayPr) } : {}), ref: detail?.ref ?? String(failed ?? '').match(/^(\S+) \(PR #/)?.[1] });
  }
}
function detectHolds(snapshot, settings, now, add) {
  const groups = new Map();
  for (const hold of snapshot.verifyHolds ?? []) {
    const key = `${hold.pool}/${hold.lane}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(hold);
  }
  for (const [key, rows] of groups) {
    const ordered = sorted(rows), first = ordered[0], last = ordered.at(-1);
    if (!last?.finished || now - time(last.at) > settings.laneHeldMinutes * 2 * 60000 || time(last.at) > now) continue;
    add('verify-lane-held', key, time(first.at), settings.laneHeldMinutes, 'Finished verify job still holds its lane',
      { pool: last.pool, lane: last.lane, dir: last.dir, jobId: last.jobId, pid: last.pid, state: last.state, firstAt: first.at, lastAt: last.at, lines: ordered.length });
  }
}
export function detectStuck(snapshot = {}, settings = LIVENESS_SWEEP_STANDARD, { now } = {}) {
  const at = time(now), findings = [];
  if (!Number.isFinite(at)) throw new TypeError('detectStuck requires a valid now');
  const add = (kind, subject, start, threshold, summary, evidence) => {
    const ageMinutes = (at - start) / 60000;
    if (Number.isFinite(ageMinutes) && ageMinutes >= 0 && (threshold === 0 || ageMinutes > threshold)) findings.push({ kind, subject, since: iso(start), ageMinutes, summary, evidence });
  };
  detectPrs(snapshot, settings, add, subject => findings.some(f => f.subject === subject));
  detectRebuilds(snapshot, settings, add);
  detectHolds(snapshot, settings, at, add);
  for (const record of snapshot.staleRecords ?? []) {
    if (record.verdict !== 'dead' || !['claim', 'lane-lease'].includes(record.kind)) continue;
    add('claim-holder-gone', `${record.kind === 'claim' ? 'claim' : 'lane'}:${record.id}`, at - record.ageMs,
      settings.claimHolderGoneMinutes, 'Record holder is proven dead', { ...record });
  }
  return findings;
}

const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
function notifyOp(finding) {
  const e = finding.evidence ?? {};
  switch (finding.kind) {
    case 'daemon-update-refused': return e.clone && e.ref
      ? `node scripts/daemon-overlay.mjs remove --clone=${quote(e.clone)} --ref=${quote(e.ref)}`
      : e.overlayPr ? `rebase PR #${e.overlayPr}` : `inspect refused self-update for clone ${e.cloneKey ?? finding.subject}`;
    case 'verify-lane-held': return `node scripts/conveyor/verify-gate-job.mjs release-lane --dir=${quote(e.dir)}`;
    case 'pr-past-cap-fix-waiting': return `node scripts/operations/run.mjs extend-rounds --repo=${e.repo} --pr=${e.number} --by=1 --actor=<operator> --channel=<channel> --reason="<words>"`;
    case 'pr-no-movement': return `node scripts/operations/run.mjs stale-state — https://github.com/${e.repo}/pull/${e.number}`;
    case 'pr-red-unowned': return `notify operator: unowned red PR https://github.com/${e.repo}/pull/${e.number} (detect-only; card 278)`;
    default: return `inspect and release ${finding.subject} only after holder and unsafe work checks`;
  }
}
function ladder(finding, attempts) {
  const e = finding.evidence ?? {};
  switch (finding.kind) {
    case 'daemon-update-refused': return [
      { rung: 'retry-self-update', safe: true, op: `schedule refused self-update retryAt to now for ${e.cloneKey ?? finding.subject} under the clone write lock; adoption requires passing smoke` },
      ...(e.overlayPr && attempts.some(a => a.rung === 'retry-self-update') ? [{ rung: 'refresh-stale-base', safe: false,
        op: `node scripts/operations/run.mjs refresh --pr=${e.overlayPr}`, requires: 'PR #5169 operator ops' }] : []),
    ];
    case 'verify-lane-held': return [{ rung: 'release-dead-lane', safe: true, op: notifyOp(finding),
      reason: 'Requires proof: job finished and no process carries this lane’s gate argv' }];
    case 'claim-holder-gone': return [{ rung: 'release-dead-claim', safe: false, op: `release dead holder record ${finding.subject} after checking unsafe work` }];
    default: return [];
  }
}
export function planRecovery(finding, { settings = LIVENESS_SWEEP_STANDARD, attempts = [] } = {}) {
  const realAttempts = attempts.filter(a => ['succeeded', 'failed', 'refused'].includes(a.outcome));
  const spent = [];
  const notify = reason => ({ rung: 'notify-operator', enabled: true, op: notifyOp(finding), safe: false,
    reason, escalated: spent.length > 0 });
  for (const step of ladder(finding, realAttempts)) {
    const count = realAttempts.filter(a => a.rung === step.rung).length;
    if (count >= settings.maxRungAttempts) { spent.push(`${step.rung} attempted ${count}× without clearing`); continue; }
    // A rung whose op is not on main yet (`requires`) is never executed, whatever its setting says.
    const enabled = settings.rungs?.[step.rung] === true && !step.requires;
    const reason = [...spent, step.reason ?? 'Cheapest remaining recovery rung', ...(!enabled ? [`${step.rung} disabled (dry-run)`] : [])].join('; ');
    const plan = { ...step, enabled, reason, escalated: spent.length > 0 };
    if (!enabled) plan.fallback = { ...notify(reason), escalated: true };
    return plan;
  }
  return notify(spent.join('; ') || 'Operator action required; gates and human review remain enforced');
}
const outcomes = new Set(['dry-run', 'succeeded', 'failed', 'refused', 'escalated']);
export function recoveryRecord({ finding, plan, outcome, detail, at }) {
  if (!outcomes.has(outcome)) throw new TypeError(`Invalid recovery outcome: ${outcome}`);
  return { at, actor: 'system', kind: finding.kind, subject: finding.subject, rung: plan.rung,
    enabled: plan.enabled, reason: plan.reason, outcome, detail };
}
export function attemptsFor(ledgerRows, finding) {
  return (ledgerRows ?? []).filter(r => r.kind === finding.kind && r.subject === finding.subject
    && time(r.at) >= time(finding.since) && ['succeeded', 'failed', 'refused'].includes(r.outcome));
}
/** A recovery that SUCCEEDED after the finding's latest evidence (`evidence.lastAt`) is still taking effect (a
 *  released lane keeps its old HEALTH lines in the log window; a scheduled retry waits for the daemon's next tick):
 *  not re-planned, so a pending effect is never counted as a failed attempt. New evidence re-opens it. */
export function isRecovering(finding, attempts) {
  const lastAt = time(finding.evidence?.lastAt);
  return Number.isFinite(lastAt) && attempts.some(a => a.outcome === 'succeeded' && time(a.at) > lastAt);
}
export function sweep(snapshot, { settings = LIVENESS_SWEEP_STANDARD, now, ledger = [] }) {
  return detectStuck(snapshot, settings, { now }).flatMap((finding) => {
    const attempts = attemptsFor(ledger, finding);
    return isRecovering(finding, attempts) ? [] : [{ finding, plan: planRecovery(finding, { settings, attempts }) }];
  });
}
