/** Read-only PR diagnosis: pure parsing, ranking and rendering. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY, repoKeyForSlug } from '../lib/constellation-repos.mjs';
export const PR_TRACE_OP = 'pr-trace';
const clean = value => String(value ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 2000);
const et = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', {
  timeZone: 'America/New_York', timeZoneName: 'short' }) : 'time unavailable';
const stamp = line => line.match(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)/)?.[0];
/** JSONL and daemon prose retain append order. No substring PR matching. */
export function parseTraceSource(text, { pr, repo }) {
  const rows = [], errors = [];
  const matches = row => Number(row.pr ?? row.num ?? row.prNumber ?? row.input?.pr ?? /(?:refs\/pull\/|#)([0-9]+)(?:\/head|$)/.exec(row.effectiveRef ?? row.branch ?? '')?.[1]) === pr
    && (!row.repo || [repo, repoKeyForSlug(repo)].includes(row.repo));
  for (const line of String(text).split('\n').filter(Boolean).slice(-2000)) {
    const marker = line.indexOf('skip-reasons: ');
    if (line.trimStart().startsWith('{') || marker >= 0) {
      try {
        const parsed = JSON.parse(marker >= 0 ? line.slice(marker + 14) : line);
        for (const row of (Array.isArray(parsed) ? parsed : [parsed])) if (matches(row)) {
          rows.push({ ...row, reason: clean(row.reason ?? (typeof row.detail === 'object' ? JSON.stringify(row.detail) : row.detail) ?? row.stopReason ?? row.why ?? row.status ?? row.kind ?? 'record'), at: row.at ?? stamp(line) });
        }
      } catch { errors.push('malformed JSON; inspect full source'); }
    } else if (new RegExp(`(?:#|PR[ =]+|--pr[= ])${pr}(?![0-9])`, 'i').test(line)) {
      const slug = line.match(/[\w.-]+\/[\w.-]+(?=#|\s+PR\b)/)?.[0];
      if (!slug || slug === repo || slug === repoKeyForSlug(repo)) rows.push({ reason: clean(line.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, '')), at: stamp(line) });
    }
  }
  return { rows, errors };
}
export function buildPrTrace({ pr, repo, now, live, sources = {}, unavailable = [], incomplete = [], loopThreshold = 10 }) {
  const latest = {}, latestAtET = {}, looping = [], records = {}, gaps = [...unavailable], bounds = [...incomplete];
  for (const [name, text] of Object.entries(sources)) {
    if (text == null) { gaps.push(name); continue; }
    const parsed = parseTraceSource(text, { pr, repo });
    records[name] = parsed.rows;
    bounds.push(...parsed.errors.map(e => `${name}: ${e}`));
    if (parsed.rows.length) { latest[name] = parsed.rows.at(-1).reason; latestAtET[name] = et(parsed.rows.at(-1).at); }
    const counts = new Map();
    for (const row of parsed.rows) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
    for (const [reason, count] of counts) if (count >= loopThreshold) looping.push({ source: name, reason, count });
  }
  const labels = (live?.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
  const conflicts = [['review:accepted', 'review:pending'], ['review:accepted', 'review:changes'],
    ['red-team:clear', 'red-team:blocked'], ['red-team:clear', 'red-team:pending']]
    .filter(pair => pair.every(l => labels.includes(l))).map(pair => pair.join(' + '));
  const mismatches = [];
  const stored = { review: records['review-ledger']?.filter(r => r.coverage?.headSha).at(-1)?.coverage.headSha,
    'red-team': records['red-team-status']?.at(-1)?.head };
  for (const [kind, head] of Object.entries(stored)) if (head && live?.headRefOid && head !== live.headRefOid)
    mismatches.push({ kind, storedHead: head, liveHead: live.headRefOid, reason: `stored ${kind} head != live head` });
  const ci = (live?.statusCheckRollup ?? []).filter(c => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'].includes(c.status ?? c.state))
    .map(c => ({ name: clean(c.name ?? c.context), startedAt: c.startedAt ?? null, startedAtET: et(c.startedAt),
      ageMinutes: Number.isFinite(Date.parse(c.startedAt)) ? Math.max(0, Math.floor((now - Date.parse(c.startedAt)) / 60000)) : null }));
  const stuck = /(?:pid.*alive|alive.*pid|live pid|live-process)/i.test(latest.fix ?? '') && /stuck|stalled|no.progress/i.test(latest.fix ?? '');
  const holder = [latest.drain, latest.fix].filter(Boolean).join(' ').match(/(?:landing[ -]holder|behind)[^#\n]*#\d+/i)?.[0];
  const queue = live?.mergeQueueEntry || holder ? { ...live?.mergeQueueEntry, landingHolder: holder?.match(/#(\d+)/)?.[1] ?? null } : null;
  const renumber = records.drain?.filter(r => /renumber/i.test(r.reason)).at(-1);
  const reasons = mismatches.length ? [labels.includes('red-team:pending') ? 'waits on red-team publish' : null,
    ...mismatches.map(m => m.reason), renumber ? `drain renumber at ${et(renumber.at)}` : null].filter(Boolean)
    : stuck ? ['live pid on stuck session', latest.fix]
    : ci.length ? [`waiting on CI shard ${ci.map(c => c.name).join(', ')}`]
    : holder ? [`waiting ${/^behind\b/i.test(holder) ? '' : 'behind '}${holder}`]
    : conflicts.length ? [`label conflict: ${conflicts.join('; ')}`]
    : looping.length ? [`looping: ${looping[0].source}: ${looping[0].reason} (${looping[0].count} times)`]
    : [latest.drain ?? latest.fix ?? latest.review ?? 'no blocker established from bounded evidence'];
  if (gaps.length || bounds.length) reasons.push('inspect unavailable evidence or full source and rerun');
  return { pr, repo, head: live?.headRefOid ?? null, labels, reviews: live?.reviews ?? null, latest, latestAtET, looping,
    mismatches, conflicts, ci, queue, unavailable: [...new Set(gaps)], incomplete: bounds,
    likelyBlocker: `#${pr} ${reasons.join(' <- ')}` };
}
export function prTraceOperation({ readFacts } = {}) {
  return op(PR_TRACE_OP, { input: { pr: { type: 'number', required: true },
    repo: { type: 'string', required: false, default: CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug },
    'loop-threshold': { type: 'number', required: false, default: 10 } }, verdictFrom: 'trace',
    read: compute({ reads: ['input.pr', 'input.repo', 'input.loop-threshold'], fn: ({ input }) => readFacts({ ...input, loopThreshold: input['loop-threshold'] }) }),
    trace: compute({ reads: ['findings.read'], fn: ({ findings }) => buildPrTrace(findings.read) }) });
}
export function finishPrTrace({ run, code, lines, json }) {
  if (code !== 0 || !run?.verdict) return { code, lines };
  const f = run.verdict;
  if (json) return { code, lines: [JSON.stringify(f).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)] };
  const output = [
    `#${f.pr} ${f.repo}, head: ${f.head ?? 'unavailable'}`, `labels: ${f.labels.join(', ')}`,
    `reviews: ${JSON.stringify(f.reviews)}`,
    ...Object.entries(f.latest).map(([name, reason]) => `${name}: ${reason} (${f.latestAtET[name]})`),
    ...f.looping.map(r => `looping: ${r.source}: ${r.reason} (${r.count})`),
    ...f.mismatches.map(m => `${m.reason}: ${m.storedHead} / ${m.liveHead}`),
    ...f.conflicts.map(c => `label conflict: ${c}`),
    ...f.ci.map(c => `CI: ${c.name}, age ${c.ageMinutes ?? 'unknown'} min, started ${c.startedAtET}`),
    `merge queue: ${JSON.stringify(f.queue)}`, ...f.unavailable.map(s => `${s}: unavailable`),
    ...f.incomplete, `likely blocker: ${f.likelyBlocker}` ];
  return { code, lines: output.map(clean) };
}
