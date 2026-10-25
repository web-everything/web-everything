/** Conservative open-PR observations. Prose is never evidence of a causal trigger. */
import { normalizeComment, classifyEvent } from './coroner-rounds.mjs';

const TRIGGERS = ['open-age', 'fix-rounds', 'recurrence', 'fix-causation', 'daemon-idle', 'dependency-or-cap'];

/** Evaluate against an injected observation time; unknown evidence never fires. */
export function evaluateStuckTriggers(input, { now = new Date().toISOString() } = {}) {
  const results = TRIGGERS.map(trigger => ({ trigger, status: 'unknown' }));
  const end = Date.parse(now), start = Date.parse(input?.openedAt);
  if (!input || input.state !== 'open' || input.mergedAt != null
    || !Number.isFinite(end) || !Number.isFinite(start) || start > end
    || (input.completeness && input.completeness.core !== 'complete')) return results;
  const ageHours = (end-start)/3600000;
  results[0] = { trigger: 'open-age', status: ageHours > 48 ? 'fired' : 'clear', ageHours, thresholdHours: 48 };
  if (Array.isArray(input.comments)) {
    const heads = new Set(input.comments.map(normalizeComment)
      .filter(c => Date.parse(c.at) >= start && Date.parse(c.at) <= end)
      .map(classifyEvent).filter(e => e?.type === 'round' && e.head).map(e => e.head));
    // A partial history can prove a lower bound, never prove absence of rounds.
    if (heads.size >= 8) results[1] = { trigger: 'fix-rounds', status: 'fired', observedRounds: heads.size, thresholdRounds: 8 };
  }
  return results;
}

/** Render only structured observations, never untrusted titles, comments or paths. */
export function buildStuckPostmortem(input, { now = new Date().toISOString() } = {}) {
  const triggers = evaluateStuckTriggers(input, { now });
  const prevention = [];
  if (triggers[0].status === 'fired') prevention.push('Escalate an open PR at 48 hours for an operator to inspect its blocking evidence. Age alone does not establish a cause.');
  if (triggers[1].status === 'fired') prevention.push('Escalate at eight distinct observed review rounds for operator inspection of the findings before another repair.');
  if (!prevention.length) prevention.push('Collect complete structured evidence before proposing a preventive change; operator investigation is required.');
  const markdown = ['# Stuck PR postmortem', '', `Observed at: ${new Date(now).toISOString()}`, '',
    ...triggers.map(t => `- ${t.trigger}: ${t.status}`), '',
    'Unknown triggers require structured evidence; prose and temporal proximity do not establish causation.', '',
    '## What would have prevented this', ...prevention, ''].join('\n');
  return { repo: input.repo, pr: input.pr, observedAt: now, triggers, markdown };
}
