/** Conservative open-PR observations. Prose is never evidence of a causal trigger. */
import { normalizeComment, classifyEvent } from './coroner-rounds.mjs';

const TRIGGERS = ['open-age', 'fix-rounds', 'recurrence', 'fix-causation', 'daemon-idle', 'dependency-or-cap'];
const PREVENTION = {
  'open-age': 'Escalate an open PR at 48 hours for an operator to inspect its blocking evidence. Age alone does not establish a cause.',
  'fix-rounds': 'Escalate at eight distinct observed review rounds for operator inspection of the findings before another repair.',
  recurrence: 'Escalate when the identical blocked finding returns after two completed repairs; require operator inspection and a regression case before another repair.',
  'fix-causation': 'Escalate after three consecutive review rounds with explicit breaks-change findings; inspect repair scope and require regression coverage before another repair.',
  'daemon-idle': 'Escalate repeated structured daemon idle reasons for operator inspection of the blocking condition.',
  'dependency-or-cap': 'Escalate a structured dependency wait or cap hit for operator resolution before resuming repairs.',
};

/** Preserve the complete finding identity: the display parser clips claims. */
function blockedKeys(body) {
  try {
    const entries = JSON.parse(body.match(/^Attempt recorded: true\.[^\n]*Rulings: (\[.*\])\s*$/m)?.[1]);
    if (!Array.isArray(entries) || !entries.length) return null;
    const keys = [];
    for (const entry of entries) {
      const key = JSON.parse(entry.key);
      if (!Array.isArray(key) || key.length !== 4
        || typeof key[0] !== 'string' || !key[0].trim()
        || typeof key[1] !== 'string' || !key[1].trim()
        || !(key[2] === null || (Number.isSafeInteger(key[2]) && key[2] > 0))
        || typeof key[3] !== 'string' || !key[3].trim()
        || !['block', 'card', 'not-real'].includes(entry.result)) return null;
      if (entry.result === 'block') keys.push(JSON.stringify(key));
    }
    return keys;
  } catch { return null; }
}

function evaluateTimeline(comments, start, end, results) {
  const events = comments.map(normalizeComment).flatMap(comment => {
    const event = classifyEvent(comment);
    return event ? [{ ...event, body: comment.body, time: Date.parse(event.at) }] : [];
  });
  const timeline = events.filter(e => e.time >= start && e.time <= end).sort((a, b) => a.time - b.time);
  // Valid heads prove this lower bound even when other events are unreadable.
  const heads = new Set(timeline.filter(e => e.type === 'round' && e.head).map(e => e.head));
  // Fix helpers print abbreviated SHAs. Resolve only an unambiguous observed
  // round head so a shared prefix cannot establish a completed repair.
  const repairHead = head => {
    if (!head) return null;
    const matches = [...heads].filter(candidate => typeof candidate === 'string'
      && /^[0-9a-f]{7,40}$/.test(candidate)
      && (candidate.startsWith(head) || head.startsWith(candidate)));
    return matches.length === 1 ? matches[0] : null;
  };
  if (heads.size >= 8) results[1] = { trigger: 'fix-rounds', status: 'fired', observedRounds: heads.size, thresholdRounds: 8 };
  // An unreadable event might interrupt a streak or supply an unobserved repair.
  if (events.some(e => !Number.isFinite(e.time))) return;
  const rounds = new Map(), pending = new Map(), repairs = [];
  for (const event of timeline) {
    if (event.type === 'fix-begin') pending.set(event.who, event);
    if (event.type === 'fix-end' && pending.has(event.who)) {
      const begin = pending.get(event.who);
      if (begin.time < event.time) repairs.push({ head: repairHead(begin.head), from: begin.time, to: event.time });
      pending.delete(event.who);
    }
    if (event.type !== 'round' || !event.head) continue;
    const round = rounds.get(event.head) ?? { head: event.head, time: event.time, events: [] };
    round.events.push(event);
    rounds.set(event.head, round);
  }
  let recurrenceKnown = false, recurrenceInvalid = false, recurrence = false;
  let causationKnown = false, causationInvalid = false, streak = 0, causation = false;
  const appearances = new Map();
  for (const round of rounds.values()) {
    const keys = new Map();
    for (const event of round.events.filter(e => e.trigger === 'referral-block')) {
      const parsed = blockedKeys(event.body);
      if (!parsed) recurrenceInvalid = true;
      else { recurrenceKnown = true; parsed.forEach(key => keys.set(key, event.time)); }
    }
    for (const [key, time] of keys) {
      const prior = appearances.get(key);
      const repaired = prior && repairs.some(r => r.head === prior.head && r.from > prior.time && r.to < time);
      const count = repaired ? prior.count + 1 : 1;
      appearances.set(key, { head: round.head, time, count });
      if (count >= 3) recurrence = true;
    }
    const findings = round.events.flatMap(e => e.findings ?? []).filter(f => f.category && f.lens !== 'operator');
    if (round.events.some(e => ['review-changes', 'advisory-changes'].includes(e.trigger)
      && !e.findings?.some(f => f.category && f.lens !== 'operator'))) causationInvalid = true;
    if (findings.length) causationKnown = true;
    streak = findings.some(f => f.category === 'breaks-change') ? streak + 1 : 0;
    if (streak >= 3) causation = true;
  }
  if (recurrenceKnown && !recurrenceInvalid) results[2] = { trigger: 'recurrence', status: recurrence ? 'fired' : 'clear' };
  if (causationKnown && !causationInvalid) results[3] = { trigger: 'fix-causation', status: causation ? 'fired' : 'clear' };
}

/** Evaluate against an injected observation time; unknown evidence never fires. */
export function evaluateStuckTriggers(input, { now = new Date().toISOString() } = {}) {
  const results = TRIGGERS.map(trigger => ({ trigger, status: 'unknown' }));
  const end = Date.parse(now), start = Date.parse(input?.openedAt);
  if (!input || input.state !== 'open' || input.mergedAt != null
    || !Number.isFinite(end) || !Number.isFinite(start) || start > end
    || input.completeness?.core !== 'complete') return results;
  const ageHours = (end-start)/3600000;
  results[0] = { trigger: 'open-age', status: ageHours > 48 ? 'fired' : 'clear', ageHours, thresholdHours: 48 };
  if (Array.isArray(input.comments)) {
    evaluateTimeline(input.comments, start, end, results);
  }
  return results;
}

/** Render only structured observations, never untrusted titles, comments or paths. */
export function buildStuckPostmortem(input, { now = new Date().toISOString() } = {}) {
  const triggers = evaluateStuckTriggers(input, { now });
  const prevention = triggers.filter(t => t.status === 'fired').map(t => PREVENTION[t.trigger]);
  if (!prevention.length) prevention.push('Collect complete structured evidence before proposing a preventive change; operator investigation is required.');
  const markdown = ['# Stuck PR postmortem', '', `Observed at: ${new Date(now).toISOString()}`, '',
    ...triggers.map(t => `- ${t.trigger}: ${t.status}`), '',
    'Unknown triggers require structured evidence; prose and temporal proximity do not establish causation.', '',
    '## What would have prevented this', ...prevention, ''].join('\n');
  return { repo: input.repo, pr: input.pr, observedAt: now, triggers, markdown };
}
