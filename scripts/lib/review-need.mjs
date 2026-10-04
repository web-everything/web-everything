/** Pure review routing (#4874). Reuses the subject, escalation and critical-work contracts. */
import { isAiCommit, isMechanicalMergeCommit, isDrainBookkeepingCommit } from './ai-pr-authorship.mjs';
import { scoreEscalation } from './review-escalation.mjs';
import { routeReviewShape } from './decision-routing.mjs';
import { criticalWorkVerdict } from './critical-work.mjs';
import { MANDATORY_LENSES } from './review-core.mjs';

export const REVIEW_TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);
export const AUTHOR_PROVIDERS = Object.freeze(['claude', 'codex', 'unknown']);

export function authorProvidersOfCommit(commit) {
  const authors = Array.isArray(commit?.authors) ? commit.authors : [];
  const message = `${commit?.messageHeadline ?? ''}\n${commit?.messageBody ?? commit?.body ?? ''}`;
  const codex = authors.some((a) => /\bcodex\b/i.test(a?.name ?? '') || /noreply@openai\.com/i.test(a?.email ?? ''))
    || /co-authored-by:\s*codex\b|noreply@openai\.com/i.test(message)
    || /^written by codex\b/im.test(message);
  const providers = [];
  if (isAiCommit(commit)) providers.push('claude');
  if (codex) providers.push('codex');
  return providers.length ? providers : ['unknown'];
}

export function authorProvidersOfPr(commits) {
  if (!Array.isArray(commits)) return [];
  return [...new Set(commits
    .filter((c) => !isMechanicalMergeCommit(c) && !isDrainBookkeepingCommit(c))
    .flatMap(authorProvidersOfCommit))].sort();
}

export function deriveReviewNeed({ shapePlan, critical, commits } = {}) {
  const tierReasons = [];
  if (critical?.critical !== false) {
    tierReasons.push(...(critical?.reasons?.length
      ? critical.reasons.map((r) => `critical:${r.proxy}: ${r.detail}`) : ['critical:unknown-scope']));
  }
  if (shapePlan?.humanRequired) tierReasons.push('human-required');
  tierReasons.push(...(shapePlan?.reasons ?? []).filter((r) => r.startsWith('gate-derivation')));
  const tier = tierReasons.length ? 'opus'
    : shapePlan?.subject === 'prose' && shapePlan?.careLevel === 'none' ? 'haiku' : 'sonnet';
  if (!tierReasons.length) tierReasons.push(tier === 'haiku' ? 'inert-prose' : 'standard-review');
  const authors = authorProvidersOfPr(commits);
  const authorsKnown = authors.length > 0 && !authors.includes('unknown');
  const codexOnly = authorsKnown && authors.every((p) => p === 'codex');
  return {
    tier, tierReasons,
    needsTools: Object.fromEntries(MANDATORY_LENSES.map((lens) => [lens, shapePlan?.subject !== 'prose'])),
    authors, authorsKnown,
    crossProvider: {
      required: codexOnly ? null : 'codex',
      satisfiedBy: codexOnly ? 'claude-mandatory-seats' : null,
      reason: codexOnly ? 'Codex-only authors: Claude mandatory seats cross providers'
        : 'Claude or unknown authors: require a Codex seat',
    },
  };
}

export function reviewNeedFor({ changedFiles, commits, careLevel, tags, risk } = {}) {
  // Do not discard a malformed entry and thereby certify only the readable subset.
  const readable = Array.isArray(changedFiles) && changedFiles.length > 0
    && changedFiles.every((f) => typeof f === 'string' && f.trim().length > 0);
  const files = readable ? changedFiles.map((f) => f.trim().replace(/^we:/, '')) : [];
  const escalation = scoreEscalation({ changedFiles: files });
  const plan = routeReviewShape({ changedFiles: files, escalation, careLevel });
  const critical = criticalWorkVerdict({ filesTouched: files, humanRequired: escalation.humanRequired, tags, risk });
  return deriveReviewNeed({
    shapePlan: { ...plan, humanRequired: escalation.humanRequired, reasons: escalation.reasons },
    critical, commits: readable ? commits : null,
  });
}
