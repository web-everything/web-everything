/** Observe-only contradictions. Missing evidence is unknown; no IO or mutation. */
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';

const clean = s => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const time = value => typeof value === 'number' ? value : Date.parse(value);
const et = value => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const normal = line => clean(line).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '')
  .replace(/\bseq(?:uence)?[=: ]+\d+(?:\s*[→-]\s*\d+)?/gi, '').replace(/\s+/g, ' ').trim();
const refusal = line => /(?:not enqueued|not woken):\s*(.+)/.exec(line)?.[1]
  ?? /(?:reconcile-refused|refused)\s+(.+)/.exec(line)?.[1]
  ?? /(?:skipped:|no review dispatched —)\s*(.+)/.exec(line)?.[1] ?? null;
const pending = line => /review:(?:human|pending)\b|review-status[:= ]+pending\b/.test(line);
const headBound = (line, head) => [...line.matchAll(/\b(?:head|sha)(?:[=: ]+)([a-f0-9]{7,40})\b/gi)]
  .some(m => head.startsWith(m[1]) && m[1].length >= 12);
const checksRunning = reason => {
  const check = reason.indexOf('check(s)');
  return check !== -1 && reason.includes('running', check + 'check(s)'.length);
};
const mentionsPr = (line, number) => {
  // Parse with fixed patterns; PR input is only compared as literal text.
  // Start only at a token boundary: retrying inside a long slashless token is quadratic.
  // Leave digits unconsumed: they may also begin a later repository qualifier.
  for (const match of line.matchAll(/(?<![\w.-])([\w.-]+\/[\w.-]+)(?: PR )?#(?=(\d+))/g)) {
    if (match[2] === number) return match[1] === CONSTELLATION_REPOS.we.slug;
  }
  for (const match of line.matchAll(/#(\d+)/g)) {
    if (match[1] === number) return true;
  }
  return false;
};

export function evaluateStuck({ now, prs, logs, claims } = {}) {
  const stamp = time(now), out = [];
  if (!Number.isFinite(stamp) || !Array.isArray(prs)) return out;
  for (const pr of prs) {
    if (!Number.isSafeInteger(pr?.number) || pr.number <= 0 || !/^[a-f0-9]{40}$/.test(pr.headSha ?? '')
      || !Array.isArray(pr.labels) || !pr.labels.every(l => typeof l === 'string')) continue;
    // All mentions count, including a wake/progress line that ends a refusal streak.
    const number = String(pr.number);
    const mentions = daemon => {
      const rows = logs?.[daemon];
      if (!Array.isArray(rows) || rows.some(r => !r || typeof r.line !== 'string' || !Number.isFinite(time(r.at)))) return [];
      return rows.filter(r => time(r.at) <= stamp && mentionsPr(r.line, number))
        .map(r => ({ at: time(r.at), line: clean(r.line) })).sort((a, b) => a.at - b.at);
    };
    const add = (rule, cause, rows, since = rows[0]?.at ?? stamp) => out.push({ pr: pr.number, rule,
      evidence: rows.map(r => r.line), sinceET: et(since), cause,
      link: `https://github.com/${CONSTELLATION_REPOS.we.slug}/pull/${pr.number}` });
    const drain = mentions('drain'), fix = mentions('fix'), review = mentions('review');
    const lastDrain = drain.at(-1), reason = lastDrain && /(?:not enqueued|not woken):/.test(lastDrain.line)
      ? refusal(normal(lastDrain.line)) : null;
    if (pr.labels.includes('review:accepted') && pr.labels.includes('red-team:clear')
      && pr.mergeStateStatus === 'CLEAN' && reason) {
      let start = drain.length - 1;
      while (start > 0 && refusal(normal(drain[start - 1].line)) === reason) start--;
      if (stamp - drain[start].at >= 30 * 60000) add('R-a', /head moved/.test(reason) ? 'A'
        : checksRunning(reason) || /red-team|re-stamp/.test(reason) ? 'B' : 'NEW', [drain[start], lastDrain]);
    }
    if (pr.labels.some(l => ['red-team:blocked', 'status:ci-red'].includes(l))
      && /reconcile-refused nothing-owed\b/.test(fix.at(-1)?.line ?? '')) add('R-b', 'C', [fix.at(-1)]);
    const dead = Array.isArray(claims) ? claims.filter(c => c?.pr === pr.number
      && ['fix', 'ci-heal'].includes(c.kind) && c.live === false && typeof c.holder === 'string' && c.holder) : [];
    if (dead.length) add('R-c', 'D', dead.map(c => ({ at: stamp,
      line: `${c.kind} claim holder ${clean(c.holder)} live=false` })));
    // Capacity chatter is not a review run state. Bind both sides to the live head.
    const states = review.filter(r => headBound(r.line, pr.headSha)
      && /review:(?:human|pending|accepted|changes)\b|review-status[:= ]+\w+/.test(r.line));
    const latest = states.at(-1);
    if (latest && pending(latest.line)
      && (pr.labels.includes('review:accepted') || review.some(r => headBound(r.line, pr.headSha)
        && /clear-human|review:accepted/.test(r.line)))) add('R-d', 'B', [latest]);
    for (const rows of [fix, drain, review]) {
      const last = rows.slice(-3), reasons = last.map(r => refusal(normal(r.line)));
      if (last.length === 3 && reasons[0] && reasons.every(r => r === reasons[0])) add('R-e', 'E', last);
    }
  }
  // A PR may repeat a refusal in several daemons; one record per PR/rule retains all evidence.
  return [...new Map(out.map(r => [`${r.pr}:${r.rule}`, r])).values()];
}
