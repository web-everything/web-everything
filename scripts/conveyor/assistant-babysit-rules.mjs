/** Pure PR classification: report-only, no actions, no GitHub writes. */
export const DEFAULTS = Object.freeze({ noWorkerMin: 20, staleClaimMin: 60, readyStalledMin: 90, readySettleMin: 15, humanWaitMin: 60, gateRedStalledMin: 30, stickyLabelMin: 60 });
export const OWNER_SUPPRESSED_RULES = Object.freeze(['no-worker', 'human-wait', 'gate-red-stalled', 'sticky-label']);
export const OWED_KINDS = Object.freeze(['review-changes', 'red-team-blocked', 'ci-red', 'conflicting', 'sent-back']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export const human = (labels) => labels.includes('review:human') || labels.some((l) => ['status:stood-down', 'review-status:stood-down'].includes(l));
export const live = (claim, now) => finite(claim.claimedAtMs) && finite(claim.heartbeatAtMs) && finite(claim.ttlMinutes)
  && claim.ttlMinutes > 0 && now - claim.heartbeatAtMs >= -120000 && now - claim.heartbeatAtMs <= claim.ttlMinutes * 60000;

export function nextActor(snapshot, why) {
  if (why?.owner) return why.owner;
  const labels = snapshot.labels ?? [];
  if (human(labels)) return 'operator';
  if (!snapshot.isDraft && (labels.some((l) => ['review:changes', 'red-team:blocked', 'merge-status:conflicting', 'status:conflict', 'status:sent-back-red-team', 'status:sent-back-review'].includes(l)) || snapshot.mergeable === 'CONFLICTING')) return 'fix daemon';
  if (!snapshot.isDraft && labels.includes('status:ci-red') && snapshot.ciFailing) return 'ci-heal';
  if (labels.includes('review:pending')) return 'review daemon';
  if (labels.includes('ready-to-merge')) return 'drain';
  return 'operator';
}

export function classifyPr(snapshot, opts = {}) {
  const settings = { ...DEFAULTS, ...opts };
  const { repo, number: pr, nowMs, claims = [], badClaims = [], labels = [] } = snapshot;
  const has = (label) => labels.includes(label);
  const times = [snapshot.headChangedAtMs, snapshot.labelChangedAtMs].filter(finite);
  const minutes = times.length ? (nowMs - Math.max(...times)) / 60000 : null;
  const owed = [];
  if (!snapshot.isDraft) {
    if (has('review:changes')) owed.push('review-changes');
    if (has('red-team:blocked')) owed.push('red-team-blocked');
    if (has('status:ci-red') && snapshot.ciFailing) owed.push('ci-red');
    if (snapshot.mergeable === 'CONFLICTING' || has('merge-status:conflicting') || has('status:conflict')) owed.push('conflicting');
    if (has('status:sent-back-red-team') || has('status:sent-back-review')) owed.push('sent-back');
  }
  const active = claims.filter((c) => live(c, nowMs));
  const fixer = active.some((c) => ['fix', 'fixing'].includes(c.kind));
  const worker = fixer || active.some((c) => c.kind === 'ci-heal');
  const owned = snapshot.owned ?? (worker ? { by: 'claim', detail: active.find((c) => ['fix', 'fixing', 'ci-heal'].includes(c.kind)) } : null);
  const reports = [];
  const add = (rule, reason, age = minutes, detail = {}) => reports.push({ rule, repo, pr, reason, minutes: age, owner: nextActor(snapshot, opts.why), detail });
  const old = (threshold) => minutes !== null && minutes >= threshold;
  if (badClaims.length) add('bad-claim', badClaims[0].problem, null, { badClaims });
  if (!snapshot.inMergeQueue && owed.length && !human(labels) && old(settings.noWorkerMin)) add('no-worker', 'owed work without a live worker', minutes, { owed });
  if (!snapshot.isDraft && human(labels) && (owed.length || labels.some((l) => ['status:stood-down', 'review-status:stood-down'].includes(l))) && old(settings.humanWaitMin)) add('human-wait', 'human-owned PR waiting on the operator');
  if (!snapshot.inMergeQueue && snapshot.ciFailing && old(settings.gateRedStalledMin) && !reports.some((r) => r.rule === 'no-worker')) add('gate-red-stalled', 'required check red without a live worker');
  if (!snapshot.isDraft && !snapshot.inMergeQueue && !human(labels) && snapshot.requiredGreen === true
    && labels.some((label) => ['status:ci-red', 'review-status:ci-heal-stalled', 'review-status:needs-human'].includes(label))
    && old(settings.stickyLabelMin)) add('sticky-label', 'stale ci-red/escalation label with green required checks');
  const stale = claims.find((c) => finite(c.claimedAtMs) && nowMs - c.claimedAtMs >= settings.staleClaimMin * 60000
    && ((finite(snapshot.headChangedAtMs) && snapshot.headChangedAtMs <= c.claimedAtMs)
      || (typeof snapshot.headSha === 'string' && snapshot.headSha === c.headShaAtClaim)));
  if (stale) add('stale-claim', 'claim aged without a head change', (nowMs - stale.claimedAtMs) / 60000, { claim: stale });
  const pair = (a, b) => add('contradiction', `${a} + ${b}`);
  // A ready PR younger than readySettleMin is still settling (labels sync one at a time); not a contradiction yet.
  if (has('ready-to-merge') && old(settings.readySettleMin)) {
    for (const label of ['review:changes', 'red-team:blocked', 'review:pending']) if (has(label)) pair('ready-to-merge', label);
    if (has('status:ci-red') && snapshot.ciFailing) pair('ready-to-merge', 'status:ci-red');
    if (snapshot.mergeable === 'CONFLICTING') pair('ready-to-merge', 'mergeable:CONFLICTING');
  }
  if (has('review:accepted') && has('review:changes')) pair('review:accepted', 'review:changes');
  // review:human with a live fix claim is a normal state (fix after human review), not a contradiction.
  for (const label of ['status:fixing', 'review-status:fixing']) if (has(label) && !worker && old(settings.noWorkerMin)) pair(label, 'no live claim');
  for (const label of ['status:stood-down', 'review-status:stood-down']) {
    if (!has(label)) continue;
    if (owed.length) pair(label, 'owed work');
    if (has('ready-to-merge')) pair(label, 'ready-to-merge');
  }
  if (!snapshot.inMergeQueue && has('ready-to-merge') && old(settings.readyStalledMin) && !reports.some((r) => r.rule === 'contradiction')) add('ready-stalled', 'ready-to-merge without recent change');
  const suppressed = owned ? reports.filter((r) => OWNER_SUPPRESSED_RULES.includes(r.rule)).map((r) => r.rule) : [];
  return { owed, owned, minutes, suppressed, reports: reports.filter((r) => !suppressed.includes(r.rule)) };
}
