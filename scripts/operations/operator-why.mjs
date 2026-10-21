/** Operator decision 2026-10-13: manual intervention without a worker. Pure read-only explanation. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';
import { RED_TEAM_STATUS_LABELS } from '../lib/red-team-status-label-meta.mjs';

export const WHY_OP = 'why';
const compact = value => String(value ?? '').replace(/[\r\n]+/g, ' ');
// Remove terminal sequences before controls, normalize to one line, then apply the preview bound.
export function commentPreview(value) {
  return String(value ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\t\n\v\f\r\x85\u2028\u2029]/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/\s+/gu, ' ').trim().slice(0, 260);
}
const names = labels => (labels ?? []).map(l => l.name ?? l);
export function lastMentionLine(text, subject) {
  const id = String(subject.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = subject.kind === 'pr'
    ? new RegExp(`(?:#${id}\\b|\\bpr[= ]${id}\\b|"pr"\\s*:\\s*${id}\\b)`, 'i')
    : new RegExp(`(?:^|[^a-zA-Z0-9_])${id}(?=$|[^a-zA-Z0-9_])`);
  return String(text ?? '').split('\n').filter(line => { try { if (Object.hasOwn(JSON.parse(line), 'timings')) return false; } catch { /* decision prose */ } return pattern.test(line); }).at(-1) ?? null;
}

export function explainWhy(facts) {
  const f = facts, subject = f.subject, isPr = subject.kind === 'pr';
  const labels = names(f.pr?.labels), has = label => labels.includes(label);
  const log = name => f.logs?.find(l => l.name === name)?.line ?? '';
  const target = `--${subject.kind}=${subject.id} --repo=${f.repo ?? CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug}`;
  const audit = '--actor=<login> --channel=<where> --reason="<why>"';
  const command = (name, extra = '') => `node scripts/operations/run.mjs ${name} --preview ${target}${extra ? ` ${extra}` : ''} ${audit}`;
  const row = (owner, waitingFor, suggestedOp = null) => ({ owner, waitingFor, suggestedOp });
  const refusal = log(has('review:changes') ? 'fix' : 'review');
  const claim = f.claims?.find(c => c.live === true) ?? f.claims?.[0];
  const parked = f.buildHolds?.[0] ?? f.backoffs?.find(b => b.exhausted || b.reason === 'dispatch-backoff-exhausted');
  const linked = f.linkedPrs?.[0];
  const rules = [
    [isPr && /^(merged|closed)$/i.test(f.pr?.state ?? ''), () => row('nobody', 'nothing (closed)')],
    [isPr && f.standDown, () => row('operator', `stand-down answer (${f.standDown.reason ?? 'unknown'})`, `node scripts/conveyor/stand-down-answer.mjs ${subject.id} --preview --repo=${f.repo} ${audit}`)],
    [isPr && has('review:human'), () => row('operator', 'human review / park', /round[- ]?(?:cap|limit)|max.*round/i.test(log('fix')) ? command('grant-rounds', '--kind=fix --n=1') : command('unpark'))],
    [isPr && claim, () => claim.live === true ? row(`fix daemon (${claim.session ?? claim.owner ?? 'unknown'})`, 'fix round in progress')
      : claim.live === false ? row('nobody (stale fix claim)', 'stale fix claim', command('clear-claim', `--kind=${claim.kind ?? 'fix'}`)) : row('unknown', 'fix claim liveness unavailable')],
    [isPr && (has('review:changes') || has('review:pending')), () => row(has('review:changes') ? 'fix daemon' : 'review daemon', /refus|skip/i.test(refusal) ? refusal : has('review:changes') ? 'fix dispatch' : 'review', /refus|skip/i.test(refusal) ? command('rearm') : null)],
    [isPr && has('ready-to-merge'), () => {
      if (f.checksUnavailable) return row('drain', 'required checks unavailable');
      if ((f.checks ?? []).some(c => !/^(success|neutral|skipped)$/i.test(c.conclusion ?? c.state ?? ''))) return row('drain', 'CI');
      if (/behind|stale/i.test(log('drain'))) return row('drain', log('drain'), command('refresh'));
      return row('drain', `merge queue position ${f.mergePosition ?? 'unknown'}`);
    }],
    [!isPr && parked, () => row(`nobody (parked: ${parked.reason ?? parked.meta?.reason ?? 'build hold'})`, 'operator unpark', command(['prepare-unstamped', 'prepare-stamp-pending'].includes(parked.reason ?? parked.meta?.reason) ? 'retry-prepare' : 'unpark'))],
    [!isPr && f.prepareFailures?.some(p => p.held && !p.completed), () => row('nobody (parked: prepare failure)', 'prepare failure held', command('retry-prepare'))],
    [!isPr && f.card?.status === 'active' && linked, () => row(linked.explanation?.owner ?? 'unknown', `see why --pr=${linked.number}`)],
    [!isPr && f.card?.status === 'open' && f.card?.queued, () => row('builder', log('builder') || 'queued; builder log has no mention')],
  ];
  const redTeamWaitingFor = isPr && RED_TEAM_STATUS_LABELS.some(label => label !== 'red-team:clear' && has(label)) && !f.redTeam?.isLiveHead
    ? `red team (no result for live head ${String(f.pr?.headRefOid ?? 'unknown').slice(0, 9)})` : null;
  const matched = rules.find(([matches]) => matches);
  const result = matched ? matched[1]() : row('unknown', redTeamWaitingFor ?? 'no signal found');
  const section = (name, lines) => ({ name, lines: lines.length ? lines.map(compact) : ['—'] });
  const sections = [
    section('state', isPr ? [`${f.pr?.state ?? 'unknown'}; draft=${f.pr?.isDraft ?? 'unknown'}; mergeable=${f.pr?.mergeable ?? 'unknown'}`, `labels: ${labels.join(', ') || '—'}`]
      : [`${f.card?.status ?? 'unknown'}; type=${f.card?.type ?? 'unknown'}; linked PRs: ${(f.linkedPrs ?? []).map(p => `#${p.number}`).join(', ') || '—'}`]),
    section('checks', (f.checks ?? []).map(c => `${c.name}: ${c.conclusion ?? c.state ?? c.status ?? 'missing'} (head ${f.pr?.headRefOid ?? 'unknown'})`)),
    section('daemons', (f.logs ?? []).map(l => `${l.name}: ${l.line ? compact(l.line).slice(0, 160) : `no mention in last ${l.kb ?? 512} KB`}`)),
    section('holds', [
      ...(f.standDown ? [`stand-down: ${f.standDown.reason}`] : []),
      ...(f.claims ?? []).map(c => `${c.kind ?? 'fix'} claim: ${c.session ?? c.owner}; live=${c.live ?? 'unknown'}`),
      ...(f.buildHolds ?? []).map(h => `build hold: ${h.reason ?? h.meta?.reason ?? 'held'}`),
      ...(f.backoffs ?? []).map(b => `build backoff: ${b.reason}; attempts=${b.attempts ?? '?'}`),
      ...(f.prepareFailures ?? []).map(p => `prepare: ${p.cause ?? 'unknown'}; held=${p.held}; completed=${p.completed ?? false}`),
      ...(f.roundExtensions != null ? [`round extensions granted: ${f.roundExtensions}`] : []),
    ]),
    section('queue', isPr ? [f.queueSection ?? 'not in the queue', `merge queue: ${f.mergePosition ?? '—'}; ${f.mergeOrdering ?? 'ordering unavailable'}`] : [f.card?.queued == null ? '—' : `queued: ${f.card.queued}`]),
    section('owner', [`owner: ${result.owner}`, `waiting for: ${result.waitingFor}`]),
  ];
  // Preserve complete structured evidence; bound only the operator's screen, with explicit omitted counts.
  const screen = [`why ${subject.kind} ${subject.id}`, ...sections.flatMap(s => [s.name, ...s.lines.slice(0, s.name === 'daemons' ? 7 : 3).map(l => `  ${l}`), ...(s.lines.length > (s.name === 'daemons' ? 7 : 3) ? [`  … ${s.lines.length - (s.name === 'daemons' ? 7 : 3)} more (see --json)`] : [])]),
    ...(isPr ? [`red team: ${f.redTeam ? compact(`${f.redTeam.state}; verdict=${f.redTeam.verdict ?? '—'}; head=${f.redTeam.head}; live=${f.redTeam.isLiveHead}; updated=${f.redTeam.updatedAt}`) : 'unavailable (see gaps)'}`,
      ...(redTeamWaitingFor ? [`red team waiting for: ${redTeamWaitingFor}`] : []),
      'recent:', ...((f.recentComments ?? []).length ? f.recentComments.slice(-3).map(c => `  ${commentPreview(c.createdAt)} ${commentPreview(c.author ?? 'unknown')}: ${commentPreview(c.body)}`) : ['  —'])] : []),
    ...(result.suggestedOp ? [`suggested: ${result.suggestedOp}`] : []),
    ...((f.gaps ?? []).length ? ['gaps', ...f.gaps.slice(0, 5).map(g => `  ${compact(g.source)}: ${compact(g.error)}`), ...(f.gaps.length > 5 ? [`  … ${f.gaps.length - 5} more gaps (see --json)`] : [])] : [])].join('\n');
  return { subject, ...result, redTeam: f.redTeam ?? null, redTeamWaitingFor, sections, screen };
}

export function whyOperation({ readWhy } = {}) {
  if (typeof readWhy !== 'function') throw new TypeError('why: needs a readWhy reader');
  return op(WHY_OP, {
    input: { pr: { type: 'number', required: false, default: 0 }, item: { type: 'string', required: false, default: '' }, repo: { type: 'string', required: false, default: CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug } },
    verdictFrom: 'explain',
    read: compute({ reads: ['input.pr', 'input.item', 'input.repo'], fn: ({ input }) => {
      if ((input.pr > 0) === Boolean(input.item?.trim()) || !Number.isInteger(input.pr) || input.pr < 0) throw new Error('why: give exactly one of pr or item');
      return readWhy(input);
    } }),
    explain: compute({ reads: ['findings.read'], fn: ({ findings }) => explainWhy(findings.read) }),
  });
}
