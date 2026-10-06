/**
 * @file Bounded, read-only observations for /state. Runtime records can outlive a worker;
 * only `claude agents` busy/working is live evidence. Each failed probe remains visible.
 * No global skills or memory: transcript tail mechanics come from the tracked repo skill.
 */
import { execFileSync } from 'node:child_process';
import { opendirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tailLines, PROJECTS_DIR } from '../../skills-src/inspect-agent-health/agent-health.mjs';
import { reduceCheckState } from '../operations/pr-status.mjs';
import { FALLBACK_REQUIRED_STATUS_CHECKS } from './required-status-checks.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { readFixDispatchClaim, fixDispatchSessionName } from '../conveyor/fix-claim-store.mjs';
import { tryReadCompletion, resolveCompletionsDir } from '../operations/completion-store.mjs';
import { buildPrToCardMap } from '../operations/pr-ownership-io.mjs';
import { createClaimReader } from '../operations/claim-io.mjs';
import { readField } from '../backlog/frontmatter.mjs';
import { latestAdvisory, trustedAdvisoryComments } from './advisory-labels.mjs';
import { liveReferralState } from './referral-live-context.mjs';
import { countGrantedRoundExtensions } from '../conveyor/round-extension-mark.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { derivePrState, settingsFromEnv } from './pr-state-core.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = CONSTELLATION_REPOS.we.slug;
const LIMIT = 64 * 1024;
const clean = value => String(value ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/g, '[REDACTED]')
  .replace(/((?:token|password|authorization|api[_-]?key)\s*[:=]\s*)\S+/gi, '$1[REDACTED]').slice(0, 1200);
const soft = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
function entries(dir, cap = 500) {
  return soft(() => {
    const handle = opendirSync(dir), out = [];
    try { let entry; while (out.length < cap && (entry = handle.readSync())) out.push(entry.name); }
    finally { handle.closeSync(); }
    return out;
  }, []);
}
function smallJson(path) {
  return soft(() => statSync(path).size <= LIMIT ? JSON.parse(readFileSync(path, 'utf8')) : null);
}
function run(bin, args) {
  return execFileSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: 12_000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
const array = v => Array.isArray(v) ? v : [];
const iso = v => v == null ? null : soft(() => new Date(v).toISOString());
function agents(exec) {
  const raw = JSON.parse(exec('claude', ['agents', '--json']));
  if (!Array.isArray(raw) && !Array.isArray(raw?.agents)) throw new Error('unrecognized agents listing');
  return array(raw?.agents ?? raw).slice(0, 500);
}
/** io may inject run(bin,argv), now(), env, home, root, and agents (a shared listing). */
export function readPrFacts(pr, io = {}) {
  const exec = io.run ?? run, env = io.env ?? process.env, home = io.home ?? homedir();
  const root = io.root ?? ROOT;
  const daemon = env.WE_STATE_DAEMON_ROOT || '/Users/nicolasgilbert/workspace/wev-review-daemon';
  const errors = [];
  const probe = (name, fn, fallback) => { try { return fn(); } catch { errors.push(`${name} unavailable`); return fallback; } };
  const gh = args => JSON.parse(exec('gh', args));
  const p = probe('GitHub PR', () => gh(['pr', 'view', String(pr), '--repo', REPO, '--json',
    'number,state,isDraft,mergeStateStatus,labels,headRefOid,body,createdAt']), {});
  // GraphQL last:N bounds the SERVER response, unlike fetching an entire thread then slicing it.
  const [owner, name] = REPO.split('/');
  const query = `query { repository(owner:"${owner}",name:"${name}") { pullRequest(number:${Number(pr)}) {
    comments(last:100) { pageInfo { hasPreviousPage startCursor } nodes { body createdAt author { login } } }
    timelineItems(last:30,itemTypes:[LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt label { name } } } }
    commits(last:1) { nodes { commit { oid committedDate statusCheckRollup { contexts(first:100) { nodes {
      ... on CheckRun { name status conclusion startedAt completedAt }
      ... on StatusContext { context state createdAt }
    } pageInfo { hasNextPage } } } } } }
  } } }`;
  const tail = probe('GitHub head/comments', () => gh(['api', 'graphql', '-f', `query=${query}`]).data.repository.pullRequest, {});
  const commit = tail?.commits?.nodes?.[0]?.commit;
  if (commit?.oid && p.headRefOid && commit.oid !== p.headRefOid) errors.push('head changed during probes; rerun');
  const required = probe('required-check policy (using declared fallback)', () => {
    const value = gh(['api', `repos/${REPO}/branches/main/protection/required_status_checks`]);
    return [...new Set([...array(value.contexts), ...array(value.checks).map(c => c.context)])];
  }, [...FALLBACK_REQUIRED_STATUS_CHECKS]);
  if (!required.length) errors.push('required-check set empty; readiness unknown');
  if (commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage) errors.push('check rollup truncated at 100');
  const rollup = collapseRollupToLatestPerName(array(commit?.statusCheckRollup?.contexts?.nodes).map(c => c.context
    ? { name: c.context, status: c.state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: c.state === 'SUCCESS' ? 'SUCCESS' : c.state === 'PENDING' ? null : 'FAILURE', completedAt: c.createdAt } : c));
  const checks = required.map(name => {
    const runs = commit?.oid === p.headRefOid ? rollup.filter(c => c.name === name) : [];
    const reduced = reduceCheckState(runs, [name]).state;
    return { name, state: runs[0]?.conclusion === 'CANCELLED' ? 'cancelled' : reduced === 'unchecked' ? 'missing' : reduced };
  });
  // Busy PRs bury the advisory under later chatter (#4017: 212 comments): page back, bounded to 3 pages x 100.
  let comments = array(tail?.comments?.nodes), page = tail?.comments?.pageInfo;
  for (let i = 0; i < 2 && page?.hasPreviousPage && !comments.some(c => /Net basis:/.test(c.body || '') && /conveyor . needs your decision|Verdict:/.test(c.body || '')); i++) {
    const more = probe('older comments', () => gh(['api', 'graphql', '-f', `query=query { repository(owner:"${owner}",name:"${name}") { pullRequest(number:${Number(pr)}) {
      comments(last:100, before:${JSON.stringify(page.startCursor)}) { pageInfo { hasPreviousPage startCursor } nodes { body createdAt author { login } } } } } }`]).data.repository.pullRequest.comments, null);
    if (!more) break;
    comments = [...array(more.nodes), ...comments]; page = more.pageInfo;
  }
  const trusted = trustedAdvisoryComments(comments);
  // Conveyor notes describe the head they were posted against: a note older than the current head is history.
  const headAt = Date.parse(commit?.committedDate || '') || 0;
  const noteAfterHead = trusted.filter(c => (Date.parse(c.createdAt) || 0) >= headAt);
  const advisory = latestAdvisory(trusted);
  const referrals = probe('referrals', () => liveReferralState({ ...p, comments }, { repo: REPO, pr: Number(pr) }), {});
  const names = ['fix', 'ci-heal', 'review'].map(kind => fixDispatchSessionName({ repo: 'we', pr: Number(pr), kind }));
  const matches = a => !/^(?:fix|ci-heal|review)-(?:pa|fui)-/.test(a?.name || '') &&
    (names.includes(a?.name) || array(a?.children).some(c => new RegExp(`(?:github.com/${REPO}/|^/?)pull/${pr}(?:$|[/?#])`).test(c.href || '')));
  const listing = io.agents ?? probe('claude agents', () => agents(exec), []);
  const records = [];
  for (const base of [join(home, '.claude/jobs'), join(home, '.claude/jobs-archive')]) {
    const dirs = entries(base);
    if (dirs.length === 500) errors.push('jobs scan capped at 500');
    let budget = 1000;
    for (const dir of dirs) {
      const paths = base.endsWith('jobs-archive') ? entries(join(base, dir), 100).map(n => join(base, dir, n, 'state.json')) : [join(base, dir, 'state.json')];
      for (const path of paths) {
        if (--budget < 0) break;
        const record = smallJson(path);
        if (record && matches(record)) records.push(record);
      }
      if (budget < 0) { errors.push('archive scan capped at 1000'); break; }
    }
  }
  records.push(...array(listing).filter(matches));
  let sessions = records.map(a => ({ name: a.name, kind: /^review-/.test(a.name) ? 'review' : /^ci-heal-/.test(a.name) ? 'ci-heal' : 'fix',
    live: false, state: a.status ?? a.state, startedAt: iso(a.startedAt ?? a.createdAt), endedAt: iso(a.endedAt ?? a.completedAt ?? a.lastTerminalAt ?? a.firstTerminalAt),
    outcome: clean(a.outcome || String(a.detail || '').match(/blocked-on-[\w-]+|handed[ -]off/i)?.[0]), detail: clean(a.detail), sessionId: a.sessionId, cwd: a.cwd }));
  const completionNames = [...new Set([...names, ...sessions.map(s => s.name)])].filter(n => /^[a-zA-Z0-9_-]+$/.test(n)).slice(0, 50);
  for (const dir of [...new Set([resolveCompletionsDir(), join(root, '.operations/completions'), join(daemon, '.operations/completions')])]) {
    for (const name of completionNames) {
      const completion = soft(() => statSync(join(dir, `${name}.json`)).size <= LIMIT ? tryReadCompletion(name, dir) : null);
      if (!completion || Number(completion.pr) !== Number(pr)) continue;
      sessions.push({ name: completion.session, kind: /^review/.test(completion.kind) ? 'review' : /^ci-heal/.test(completion.kind) ? 'ci-heal' : 'fix',
        live: false, state: completion.status, startedAt: completion.startedAt,
        endedAt: completion.status === 'done' ? completion.updatedAt : null,
        outcome: clean(completion.outcome), detail: '', sessionId: completion.sessionId });
    }
  }
  // Join completion outcomes with the job of the SAME session, never a previous incarnation of its name.
  const joined = new Map();
  for (const s of sessions) {
    const key = s.sessionId || `${s.name}:${s.startedAt || ''}`;
    const prior = joined.get(key);
    joined.set(key, prior ? { ...prior, ...s, startedAt: s.startedAt || prior.startedAt,
      endedAt: s.endedAt || prior.endedAt, outcome: s.outcome || prior.outcome, detail: s.detail || prior.detail } : s);
  }
  sessions = [...joined.values()].sort((a,b) => (Date.parse(b.endedAt || b.startedAt)||0)-(Date.parse(a.endedAt || a.startedAt)||0));
  if (sessions.length > 50) errors.push('matching session scan capped at 50');
  sessions = sessions.slice(0, 50);
  for (const s of sessions) {
    const observed = array(listing).find(a => a.name === s.name && ['busy', 'working'].includes(a.status)
      && (!s.sessionId || !a.sessionId || s.sessionId === a.sessionId));
    s.live = !!observed;
    if (observed) { s.state = observed.status; s.startedAt = observed.startedAt || s.startedAt; }
    if (s.sessionId && /^[a-zA-Z0-9-]+$/.test(s.sessionId)) {
      // At most 100 project directories, one named transcript each; never search arbitrary paths from prose.
      for (const project of entries(PROJECTS_DIR, 100)) {
        const lines = soft(() => tailLines(join(PROJECTS_DIR, project, `${s.sessionId}.jsonl`), 40, LIMIT).lines, []);
        for (const line of lines) {
          const record = soft(() => JSON.parse(line));
          if (record?.type !== 'assistant' || record.isSidechain) continue;
          const text = array(record.message?.content).filter(c => c.type === 'text').map(c => c.text).join('\n');
          const outcome = text.match(/(?:outcome\s*[:=]\s*)(blocked-on-[\w-]+|handed[ -]off|[\w-]+)/i)?.[1];
          if (outcome && !s.outcome) { s.outcome = clean(outcome); s.detail = clean(text.split('\n').find(l => l.includes(outcome))); }
        }
        if (lines.length) break;
      }
    }
    delete s.cwd;
  }
  let claim = null;
  for (const kind of ['fix', 'ci-heal']) {
    const entry = probe(`${kind} claim`, () => readFixDispatchClaim({ repo: 'we', pr: Number(pr), kind }), null);
    if (entry) { claim = { held: true, owner: clean(entry.owner), kind, meta: { headSha: entry.meta?.headSha, sessionId: entry.meta?.sessionId, sessionName: fixDispatchSessionName({ repo: 'we', pr: Number(pr), kind }) } }; break; }
  }
  const mentions = new RegExp(`(?:^|[^0-9])${pr}(?:$|[^0-9])`);
  const log = file => soft(() => tailLines(join(daemon, '.conveyor', file), 400, LIMIT).lines, []).filter(l => mentions.test(l));
  const at = line => line.match(/\d{4}-\d\d-\d\dT[0-9:.]+Z/)?.[0] ?? null;
  const refusals = ['fix-dispatch-daemon.log', 'review-daemon.log'].flatMap(log)
    .filter(l => /refus|cap[- ]exhausted|needs.your.decision/i.test(l)).slice(-8).map(l => ({ at: at(l), text: clean(l) }));
  const handoffs = log('pass-daemon.load-flake-reverify.log').filter(l => /hand[ -]?off|handed[ -]off|blocked-on|queued|dispatch/i.test(l)).slice(-3).map(l => ({ kind: 'load-flake', at: at(l), detail: clean(l) }));
  for (const s of sessions) if (s.endedAt && /blocked-on-(load-flake|infra|permission)/.test(s.outcome))
    handoffs.push({ kind: s.outcome.slice('blocked-on-'.length), at: s.endedAt, detail: `${s.name}: ${s.outcome}` });
  const drainDeferral = log('drain-daemon.log').filter(l => /deferr/i.test(l)).at(-1);
  return { pr: Number(pr), now: io.now?.() ?? new Date().toISOString(), state: p.state ?? null,
    isDraft: p.isDraft, mergeState: p.mergeStateStatus, labels: array(p.labels).map(l => l.name),
    head: { sha: p.headRefOid, committedAt: commit?.committedDate }, requiredChecks: checks,
    labelChangedAt: array(tail?.timelineItems?.nodes).filter(n => ['review:changes', 'review:pending'].includes(n.label?.name)).at(-1)?.createdAt,
    advisory: advisory ? { coveredHead: advisory.head, text: clean(trusted[advisory.index]?.body) } : null,
    referrals: { pending: referrals.pending ?? [], ruled: referrals.operatorRulings ?? [] },
    roundCapNote: noteAfterHead.some(c => /round[- ]cap|cap[- ]exhausted/i.test(c.body)),
    needsDecisionNote: noteAfterHead.some(c => /needs[ -]your[ -]decision/i.test(c.body)),
    roundExtensions: countGrantedRoundExtensions(comments, { repo: REPO, pr: Number(pr) }),
    sessions, claim, refusals, handoffs, drainDeferral: drainDeferral ? clean(drainDeferral) : null, probeErrors: errors };
}
/** Resolve a local backlog claim and the bounded PR→card join; each PR uses the same reducer. */
export function readCardFacts(id, io = {}) {
  const exec = io.run ?? run, root = io.root ?? ROOT;
  const context = soft(() => createClaimReader({ root, exec, listFiles: dir => entries(dir, 20000), readText: path => {
    if (statSync(path).size > LIMIT) throw new Error('card too large');
    return readFileSync(path, 'utf8');
  } })({ ref: String(id).replace(/^card[-:]/, '') }), { found: false });
  const listing = soft(() => agents(exec), []);
  const prs = soft(() => JSON.parse(exec('gh', ['pr', 'list', '--repo', REPO, '--state', 'all', '--limit', '100',
    '--json', 'number,title,headRefName'])), []);
  const map = buildPrToCardMap([{ repo: 'we', prs }]);
  const linked = array(prs).filter(p => String(map[`we:${p.number}`]) === String(context.id ?? id)).slice(0, 10);
  return { id: context.id ?? id, found: context.found, status: context.status ?? 'unknown',
    claim: { held: context.held || ['active', 'preparing'].includes(context.status), owner: clean(context.heldBy || readField(context.content || '', 'claimedBy')) },
    activeSessions: listing.filter(a => ['busy', 'working'].includes(a.status)
      && (['conveyor', 'prepare', 'prepare-decision', 'prepare-item'].some(kind => a.name === `${kind}-${context.id ?? id}`) || array(a.children).some(c => String(c.href || '').endsWith(`/backlog/${context.id ?? id}/`))))
      .map(a => ({ name: clean(a.name), state: a.status, startedAt: a.startedAt })),
    prs: linked.map(p => { const facts = readPrFacts(p.number, { ...io, agents: listing });
      return { pr: p.number, ...derivePrState(facts, settingsFromEnv(io.env ?? process.env)) }; }),
    evidence: ['PR/card join bounded to the 100 most recent PRs and 10 linked PRs; no match does not prove no PR exists'] };
}
