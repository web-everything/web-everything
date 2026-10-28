// One read, one consistent state; clearing authority is bound to the snapshot's evidence fence.
import { validateSnapshot, requireEvidence, requireInteger, labelsDigest, commentVersion } from './snapshot.mjs';

export function admitClearHuman(snapshot, { delegation, config } = {}) {
  validateSnapshot(snapshot);
  requireEvidence(delegation !== null && typeof delegation === 'object', 'delegation');
  const { pinnedHead, expiresAt } = delegation;
  requireEvidence(typeof pinnedHead === 'string' && /^[0-9a-f]{40}(?![\s\S])/.test(pinnedHead), 'delegation.pinnedHead');
  requireInteger(expiresAt, 'delegation.expiresAt');
  requireEvidence(config !== null && typeof config === 'object', 'config');
  const { ineligibleLabels, commitBudgetMs, decideSetLabel, scoreDiff } = config;
  requireEvidence(Array.isArray(ineligibleLabels), 'config.ineligibleLabels');
  for (const label of ineligibleLabels) requireEvidence(typeof label === 'string' && label.length > 0, 'config.ineligibleLabels entry');
  requireInteger(commitBudgetMs, 'config.commitBudgetMs');
  requireEvidence(Number.isSafeInteger(snapshot.now + commitBudgetMs), 'commit budget overflow');
  requireEvidence(typeof decideSetLabel === 'function', 'config.decideSetLabel');
  requireEvidence(typeof scoreDiff === 'function', 'config.scoreDiff');
  const fence = { headSha: snapshot.head, labelsDigest: labelsDigest(snapshot.labels),
    commentVersion: commentVersion(snapshot.comments) };
  const basis = [...snapshot.holdEventIds];
  const reasons = [];
  if (snapshot.head !== pinnedHead) reasons.push('head-moved');
  else requireEvidence(snapshot.netDiff.headSha === snapshot.head, 'netDiff head mismatch');
  for (const label of [...new Set(snapshot.labels)].sort()) {
    if (ineligibleLabels.includes(label)) reasons.push(`ineligible-label:${label}`);
  }
  for (const key of snapshot.openReferrals) reasons.push(`open-referral:${key}`);
  if (snapshot.redTeam.rulingNeeded) reasons.push('red-team-ruling-needed');
  const decision = decideSetLabel({ to: 'clear-human', currentLabels: [...snapshot.labels].sort(),
    humanOnlyHold: snapshot.humanOnlyHold, redTeamRulingHold: snapshot.redTeam.rulingNeeded });
  requireEvidence(typeof decision?.allowed === 'boolean', 'decideSetLabel.allowed');
  if (!decision.allowed) reasons.push('decide-refused');
  const score = scoreDiff(structuredClone(snapshot.netDiff));
  requireEvidence(typeof score?.escalate === 'boolean', 'scoreDiff.escalate');
  if (score.escalate) reasons.push('diff-escalates');
  if (expiresAt <= snapshot.now + commitBudgetMs) reasons.push('delegation-expired');
  return { admit: reasons.length === 0, reasons, basis, fence };
}
