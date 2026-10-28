const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})(?![\s\S])/.test(value)
  && Number.isFinite(Date.parse(value));
const strings = value => Array.isArray(value) && value.every(text);
const sorted = values => [...new Set(values)].sort();
const policies = new Set(['send-back', 'hold', 'card', 'advisory']);
const reviewStates = new Set(['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function requireInput(condition, field) {
  if (!condition) throw new TypeError(`Invalid ${field}`);
}

function validate(snapshot, options) {
  const config = options?.config;
  requireInput(object(config), 'config');
  requireInput(typeof config.isLaterVerdictBody === 'function', 'config.isLaterVerdictBody');
  requireInput(typeof config.statusLabels === 'boolean', 'config.statusLabels');
  requireInput(object(config.confirmedBreaks), 'config.confirmedBreaks');
  for (const field of ['broken', 'degraded', 'unconfirmed']) {
    requireInput(policies.has(config.confirmedBreaks[field]), `config.confirmedBreaks.${field}`);
  }
  const ruling = options.standingRuling;
  requireInput(ruling === null || (object(ruling) && strings(ruling.resultIds)), 'standingRuling');
  requireInput(object(snapshot), 'snapshot');
  requireInput(sha(snapshot.head), 'snapshot.head');
  for (const field of ['labels', 'openReferrals', 'standingRulings', 'holdEventIds']) {
    requireInput(strings(snapshot[field]), `snapshot.${field}`);
  }
  requireInput(date(snapshot.labelsVersion), 'snapshot.labelsVersion');
  requireInput(typeof snapshot.humanOnlyHold === 'boolean', 'snapshot.humanOnlyHold');
  requireInput(time(snapshot.now), 'snapshot.now');
  const redTeam = snapshot.redTeam;
  requireInput(object(redTeam), 'snapshot.redTeam');
  requireInput(redTeam.resultId === null || text(redTeam.resultId), 'snapshot.redTeam.resultId');
  requireInput(typeof redTeam.rulingNeeded === 'boolean', 'snapshot.redTeam.rulingNeeded');
  for (const field of ['comments', 'reviews']) {
    requireInput(Array.isArray(snapshot[field]) && snapshot[field].every(object), `snapshot.${field}`);
  }
  for (const comment of snapshot.comments) {
    requireInput(typeof comment.body === 'string', 'snapshot.comments.body');
    requireInput(date(comment.createdAt), 'snapshot.comments.createdAt');
    requireInput(comment.lastEditedAt == null || date(comment.lastEditedAt), 'snapshot.comments.lastEditedAt');
  }
  for (const review of snapshot.reviews) {
    requireInput(reviewStates.has(review.state) && sha(review.commit?.oid), 'snapshot.reviews');
  }
  requireInput(snapshot.reviewRun == null || object(snapshot.reviewRun), 'snapshot.reviewRun');
}

/**
 * Pure label reconciliation over caller-supplied, complete evidence. The caller
 * owns evidence collection and applying the plan against the labelsVersion.
 * config.isLaterVerdictBody must supply the caller's pure verdict predicate.
 * Missing acceptance evidence preserves review holds; this never grants readiness.
 */
export function planLabelReconcile(snapshot, options) {
  validate(snapshot, options);
  const { config, standingRuling } = options;
  const { redTeam, reviewRun } = snapshot;
  const before = new Set(snapshot.labels);
  const after = new Set(before);
  const reasons = new Set();
  const evidenceIds = new Set(snapshot.holdEventIds);
  const record = id => { if (text(id)) evidenceIds.add(id); };
  record(redTeam.resultId);
  record(reviewRun?.id);

  if (!config.statusLabels) {
    reasons.add('status-labels-off');
  } else if (!redTeam.resultId) {
    // A pending/blocked result cannot be cleared by absence of evidence.
    reasons.add('red-team-kept-no-evidence');
  } else {
    const covered = snapshot.standingRulings.includes(redTeam.resultId)
      || standingRuling?.resultIds.includes(redTeam.resultId);
    const blocked = redTeam.rulingNeeded && !covered
      && ['send-back', 'hold'].includes(config.confirmedBreaks.broken);
    const target = blocked ? 'red-team:blocked' : 'red-team:clear';
    for (const label of after) {
      if (label.startsWith('red-team:')) after.delete(label);
    }
    after.add(target);
    reasons.add(blocked ? 'red-team-blocked' : 'red-team-clear');
  }

  const reviewHolds = [...after].filter(label => label === 'review:changes' || label.startsWith('fix-waiting:'));
  if (reviewHolds.length) {
    const holds = new Set();
    const accepted = reviewRun?.head === snapshot.head
      && time(reviewRun.startedAt) && time(reviewRun.completedAt)
      && reviewRun.completedAt >= reviewRun.startedAt
      && reviewRun.completedAt <= snapshot.now
      && reviewRun.parked === false && reviewRun.verdict === 'accept'
      && reviewRun.confirm === 'accept' && reviewRun.publishedAccept === true;
    if (!accepted) holds.add('acceptance-incomplete');
    if (snapshot.humanOnlyHold) holds.add('human-only');
    if (snapshot.openReferrals.length) {
      holds.add('open-referrals');
      snapshot.openReferrals.forEach(record);
    }
    if (after.has('red-team:blocked')) holds.add('red-team-blocked');
    for (const review of snapshot.reviews) {
      if (review.state === 'CHANGES_REQUESTED' && review.commit.oid === snapshot.head) {
        holds.add('changes-requested');
        record(review.id);
      }
    }
    for (const comment of snapshot.comments) {
      if (!config.isLaterVerdictBody(comment.body)) continue;
      const created = Date.parse(comment.createdAt);
      const edited = comment.lastEditedAt == null ? created : Date.parse(comment.lastEditedAt);
      if (!time(reviewRun?.startedAt) || Math.max(created, edited) >= reviewRun.startedAt) {
        holds.add('later-verdict');
        record(comment.id);
      }
    }
    if (holds.size) {
      for (const hold of holds) reasons.add(`review-hold-kept:${hold}`);
    } else {
      for (const label of reviewHolds) after.delete(label);
      reasons.add('review-hold-cleared');
    }
  }

  if ((after.has('red-team:blocked') || after.has('review:changes')) && after.delete('ready-to-merge')) {
    reasons.add('ready-to-merge-removed');
  }
  return {
    add: sorted([...after].filter(label => !before.has(label))),
    remove: sorted([...before].filter(label => !after.has(label))),
    reasons: sorted(reasons),
    evidenceIds: sorted(evidenceIds),
  };
}
