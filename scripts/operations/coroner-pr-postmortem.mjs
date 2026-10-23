#!/usr/bin/env node
/** Read-only delivery analysis: writes only local reports/journal, never GitHub or a delivery ledger.
 * Method: open-pr-time-loss.md, fix-rounds-reduction.md, false-findings-analysis.md, ci-fix-sizes.md
 * (operator analyses, 2026-10-16). Label phases are exclusive priority intervals; checks are separate,
 * overlapping observations. Missing evidence is unknown, never an inferred causal diagnosis.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { defaultListPrComments } from '../conveyor/pr-comments-list.mjs';
import { readFixLoopRows, fixLoopLedgerPath } from '../conveyor/fix-loop-ledger.mjs';
import { buildPrRounds, normalizeComment, classifyEvent, headsOf, parseCard, cardIdOf } from './coroner-rounds.mjs';
import { falseFindingsForPr } from './coroner-false-findings.mjs';
import { parseLedgerEvents } from '../lib/verdict-ledger.mjs';
import { ledgerGitPath, LEDGER_TRANSPORT_BRANCH } from '../lib/verdict-ledger-io.mjs';
import { parseVerdictCarriedMarker } from '../lib/review-verdict-carried-marker.mjs';
import { coversFile } from '../readiness/scope-lease.mjs';
import { parseRedTeamGateMarker } from '../lib/red-team-gate.mjs';
import { repoKeyForSlug, CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { resolveCascade, readPlatformPreferences, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';

const SELF = fileURLToPath(import.meta.url);
const SETTINGS = JSON.parse(fs.readFileSync(join(dirname(SELF), '../settings/coroner-postmortem.json'), 'utf8'));
export const DEFAULTS = Object.freeze({ minLeadHours: 8, minFixRounds: 4, minLostApprovals: 2, onStandDown: true });
const time = v => Date.parse(v);
const minutes = (a, b) => Number.isFinite(time(b) - time(a)) ? Math.round(Math.max(0, time(b) - time(a)) / 6000) / 10 : null;
const sorted = xs => [...xs].sort((a,b) => String(a.at).localeCompare(String(b.at)));
const same = (a,b) => Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
export function validateSubject(repo, pr) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isSafeInteger(Number(pr)) || Number(pr) < 1) throw Error('expected --repo=owner/name --pr=positive-integer');
}
/** Encode the slash as well as owner/name punctuation without merging distinct repository slugs. */
export function repoFilenameKey(repo) { validateSubject(repo,1); return encodeURIComponent(repo); }
export function resolvePostmortemSettings({ tool = SETTINGS.coroner.postmortem, platform, env = process.env, log = console.error } = {}) {
  const envValues = {};
  for (const [k, suffix] of Object.entries({ minLeadHours: 'MIN_LEAD_HOURS', minFixRounds: 'MIN_FIX_ROUNDS', minLostApprovals: 'MIN_LOST_APPROVALS', onStandDown: 'ON_STAND_DOWN' })) {
    const raw = env[`WE_CORONER_POSTMORTEM_${suffix}`];
    if (raw !== undefined) envValues[k] = k === 'onStandDown' ? ({ true: true, false: false, '1': true, '0': false }[raw] ?? raw) : Number(raw);
  }
  const numeric = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const out = resolveCascade({ standard: DEFAULTS, platform: platform ?? readPlatformPreferences({ env }).prefs.coroner?.postmortem ?? {}, tool, envValues,
    valid: { minLeadHours: numeric, minFixRounds: v => numeric(v) && Number.isInteger(v), minLostApprovals: v => numeric(v) && Number.isInteger(v), onStandDown: v => typeof v === 'boolean' } });
  log(formatCascadeSourcesLine('coroner.postmortem', out));
  return out;
}
const PHASES = [
  ['operator-wait', ['status:needs-you', 'status:escalated']], ['fix-running', ['fix:running', 'conveyor:fixing', 'fix:claimed', 'review-status:fixing', 'review-status:fix-stalled', 'status:takeover-running', 'review-status:fixing-conflict']],
  ['conflict', ['status:conflict', 'merge:conflict', 'merge-status:conflicting', 'conflict']], ['ci-red-wait', ['ci:failed', 'status:ci-red']],
  ['ci-running', ['status:awaiting-ci']], ['ci-wait', ['checking', 'status:checking', 'review-status:awaiting-ci']],
  ['review-running', ['review:running', 'review:in-progress', 'review-status:reviewing', 'review-status:review-stalled']], ['redteam-sentback', ['red-team:changes', 'redteam:changes', 'status:sent-back-red-team']],
  ['fix-wait', ['review:changes', 'status:sent-back-review', 'status:answered-waiting-fixer']], ['queue-checks', ['merge-queue', 'status:enqueued', 'merge:queued']],
  ['ready-enqueued', ['ready-to-merge', 'status:ready-to-merge']], ['review-dispatch', ['review:queued', 'review:pending', 'review:needed', 'status:awaiting-review']],
];
function validateTimelineEvents(events) {
  for (const event of events) {
    const stamp = event.created_at ?? event.createdAt;
    if (typeof stamp !== 'string' || !Number.isFinite(time(stamp))) throw Error('invalid timeline event timestamp');
    if (['labeled','unlabeled'].includes(event.event) && (typeof event.label?.name !== 'string' || !event.label.name.trim())) throw Error('invalid timeline event label');
  }
}
export function buildPostmortem(input, { benchmarks = SETTINGS.handoffP90Minutes } = {}) {
  const { repo, pr, openedAt, mergedAt, verdicts = null, fixLoop = [], scope = null, prepares = [] } = input;
  const comments = (input.comments ?? []).filter(c => time(c.created_at ?? c.createdAt) <= time(mergedAt));
  const commits = (input.commits ?? []).filter(c => time(c.commit?.committer?.date ?? c.commit?.author?.date) <= time(mergedAt));
  const heads = headsOf(commits);
  const checks = [...new Map((input.checks ?? []).filter(c => time(c.created_at ?? c.started_at ?? c.completed_at) <= time(mergedAt)).map(c => [c.id ?? JSON.stringify(c), c])).values()].map(c => time(c.completed_at) > time(mergedAt) ? { ...c, completed_at: null, conclusion: null } : c);
  validateSubject(repo, pr);
  if (!Number.isFinite(time(openedAt)) || !Number.isFinite(time(mergedAt)) || time(mergedAt) < time(openedAt)) throw Error('postmortem requires a merged PR with valid timestamps');
  validateTimelineEvents(input.labels ?? []);
  const trusted = comments.map(c => ({ ...normalizeComment(c), ref: c.url ?? c.id ?? c.createdAt ?? c.created_at })).filter(c => c.trusted && time(c.at) >= time(openedAt) && time(c.at) <= time(mergedAt));
  const queueEvents = (input.labels ?? []).filter(e => ['added_to_merge_queue','removed_from_merge_queue'].includes(e.event)).map(e => ({ ...e, event: e.event === 'added_to_merge_queue' ? 'labeled' : 'unlabeled', label: { name: 'merge-queue' } }));
  const events = sorted([...(input.labels ?? []), ...queueEvents].filter(e => ['labeled', 'unlabeled'].includes(e.event)).map(e => ({ at: e.created_at ?? e.createdAt, name: e.label?.name, add: e.event === 'labeled', ref: e.url ?? e.id ?? e.created_at })));
  const live = new Set(), intervals = []; let start = openedAt;
  const phase = () => PHASES.find(([, names]) => names.some(n => live.has(n)))?.[0] ?? 'unknown';
  for (const e of [...events, { at: mergedAt, end: true }]) {
    if (time(e.at) < time(openedAt) || time(e.at) > time(mergedAt)) continue;
    if (time(e.at) > time(start)) intervals.push({ phase: phase(), from: start, to: e.at, minutes: minutes(start, e.at) });
    if (!e.end) { if (e.add) live.add(e.name); else live.delete(e.name); } start = e.at;
  }
  const phases = [...new Set(intervals.map(i => i.phase))].map(phase => ({ phase, minutes: Math.round(intervals.filter(i => i.phase === phase).reduce((s,i) => s+time(i.to)-time(i.from), 0)/6000)/10 }));
  const ciRuns = checks.map(c => ({ name: c.name, headSha: c.head_sha, createdAt: c.created_at ?? c.started_at, updatedAt: c.completed_at, conclusion: c.conclusion }));
  const extracted = buildPrRounds({ comments, commits, ciRuns, files: input.files, mergedAt });
  const rounds = extracted.rounds.map(r => ({ ...r, causes: r.triggers.flatMap(trigger => {
    if (trigger === 'ci-red') return r.findings.filter(f => f.lens === 'ci').map(f => ({ cause: 'ci-heal', check: f.category }));
    if (/operator|policy/.test(trigger)) return [{ cause: 'operator-send-back' }];
    return r.findings.filter(f => f.lens !== 'ci').map(f => ({ cause: 'review-finding', lens: f.lens, theme: f.category ?? f.hint ?? 'unclassified' }));
  }) }));
  for (const r of rounds) r.causes = [...new Map(r.causes.map(c => [JSON.stringify(c),c])).values()];
  // Supplement the shared extractor with explicit red-team / drain events and ledger-only attempts.
  for (const c of trusted) {
    const gate = parseRedTeamGateMarker(c.body);
    const first = c.body.split('\n')[0];
    const cause = gate?.outcome === 'sent-back' ? 'red-team-break' : /parked-pr-conflict-watch \(conflict resolved\)/.test(c.body) ? 'drain-mechanical' : /drain.mechanical|conflict-fix|rebase.*(?:complete|applied)/i.test(first) ? 'drain-mechanical' : null;
    if (!cause) continue;
    const head = gate?.rev ?? headsOf(commits).filter(h => time(h.at) <= time(c.at)).at(-1)?.sha;
    const r = rounds.find(r => same(r.head, head));
    if (r) r.causes.push({ cause, evidence: c.ref }); else rounds.push({ at: c.at, head, triggers: [cause], findings: [], causes: [{ cause, evidence: c.ref }], minutes: 0 });
  }
  const ledger = sorted(fixLoop.filter(r => r.pr === Number(pr) && [repo, repoKeyForSlug(repo)].includes(r.repo) && time(r.at) >= time(openedAt) && time(r.at) <= time(mergedAt)));
  for (const l of ledger.filter(l => ['fix', 'ci-heal'].includes(l.kind))) {
    const r = rounds.find(r => same(r.head, l.head));
    if (r) { (r.ledgerSessions ??= []).push(l); }
    else rounds.push({ at: l.at, head: l.head, triggers: ['fix-ledger'], findings: [], causes: [{ cause: l.kind === 'ci-heal' ? 'ci-heal' : 'unclassified-fix', check: l.check ?? null }], minutes: 0, ledgerSessions: [l] });
  }
  rounds.sort((a,b) => a.at.localeCompare(b.at)); rounds.forEach((r,i) => { r.round = i+1; });
  const marks = [];
  const mark = (kind, at, evidence, check) => { if (Number.isFinite(time(at)) && time(at) >= time(openedAt) && time(at) <= time(mergedAt)) marks.push({ kind, at, evidence, check }); };
  for (const e of events.filter(e => e.add)) {
    if (/^review-status:reviewing$|^review:(?:queued|running|in-progress)$/.test(e.name)) mark('review', e.at, e.ref);
    if (e.name === 'review:accepted') mark('accepted', e.at, e.ref);
    if (/^(?:status:)?ready-to-merge$/.test(e.name)) mark('ready', e.at, e.ref);
    if (['merge-queue', 'status:enqueued', 'merge:queued'].includes(e.name)) mark('enqueued', e.at, e.ref);
    if (['checking', 'status:awaiting-ci'].includes(e.name)) mark('ci', e.at, e.ref);
    if (e.name === 'ci:failed') mark('ci-red', e.at, e.ref);
  }
  for (const c of trusted) {
    const e = classifyEvent(c);
    if (e?.type === 'round') mark('changes', c.at, c.ref);
    if (e?.type === 'fix-begin') mark('fix', c.at, c.ref);
    if (e?.type === 'fix-end') mark('fix-end', c.at, c.ref);
    if (e?.type === 'ci-heal') mark('heal', c.at, c.ref);
    if (/^.*(?:review dispatched|review-begin)/i.test(c.body.split('\n')[0])) mark('review', c.at, c.ref);
    if (/clear-human|cleared-human/.test(c.body.split('\n')[0])) mark('clearance', c.at, c.ref);
  }
  // Attempts are historical boundaries, not a final status per head/name. Keep
  // each distinct check (deduplicated by ID above); gap pairing below supersedes
  // a boundary only when a newer one precedes its hand-off.
  for (const c of checks) {
    // A late old-head success must neither start a gap nor supersede a current-head success.
    const completedHead = heads.filter(h => time(h.at) <= time(c.completed_at)).at(-1)?.sha;
    if (c.name === 'test' && c.conclusion === 'success' && same(c.head_sha,completedHead)) mark('ci-green',c.completed_at,c.html_url ?? c.id,c);
    if (!/review.?gate/i.test(c.name) && ['failure','timed_out','startup_failure'].includes(c.conclusion)) mark('ci-red',c.completed_at,c.html_url ?? c.id,c);
  }
  mark('merged', mergedAt, input.url ?? `https://github.com/${repo}/pull/${pr}`);
  const gaps = [];
  const pairs = [['ci-green-review','ci-green','review'], ['accepted-ready','accepted','ready'], ['changes-fix','changes','fix'], ['fix-ci','fix-end','ci'], ['fix-review','fix-end','review'], ['ready-enqueued','ready','enqueued'], ['enqueued-merged','enqueued','merged'], ['clearance-ready','clearance','ready'], ['ci-red-heal','ci-red','heal']];
  for (const [kind, from, to] of pairs) for (const a of [...new Map(sorted(marks.filter(m => m.kind === from)).map(m => [m.at,m])).values()]) {
    const b = sorted(marks.filter(m => (m.kind === to || (kind === 'clearance-ready' && m.kind === 'enqueued') || (kind === 'ci-red-heal' && m.kind === 'fix')) && time(m.at) >= time(a.at)))[0];
    const superseded = marks.some(m => m.kind === from && time(m.at) > time(a.at) && time(m.at) <= time(b?.at));
    if (!b || superseded) continue;
    // A different result (or an unfinished rerun) of this check can invalidate
    // the boundary too, but only if observed before this particular hand-off.
    if (a.check && checks.some(c => {
      return c !== a.check && c.head_sha === a.check.head_sha && c.name === a.check.name
        && [c.started_at ?? c.created_at, c.completed_at].some(at => time(at) > time(a.at) && time(at) <= time(b.at));
    })) continue;
    // CI green is only a valid dispatch boundary if the head did not change in between.
    if (kind === 'ci-green-review' && heads.some(h => time(h.at) > time(a.at) && time(h.at) <= time(b.at))) continue;
    const duration = minutes(a.at,b.at), p90 = benchmarks[kind];
    gaps.push({ kind, from: a.at, to: b.at, minutes: duration, p90, minutesLost: Math.round(Math.max(0,duration-p90)*10)/10, evidence: [a.evidence,b.evidence].filter(v => v !== undefined) });
  }
  const approvals = sorted((verdicts ?? []).filter(v => ['accept','accepted','clear-human'].includes(v.verdict ?? v.action)).map(v => ({ at: v.at, head: v.coverage?.headSha ?? v.head, evidence: v.id ?? v.at })));
  for (const m of marks.filter(m => m.kind === 'accepted' || m.kind === 'clearance')) if (!approvals.some(a => Math.abs(time(a.at)-time(m.at)) < 60000)) approvals.push({ at: m.at, head: heads.filter(h => time(h.at) <= time(m.at)).at(-1)?.sha, evidence: m.evidence });
  // A carried approval now stands on the new head, so follow it: each later head change is
  // judged against the LATEST head the approval was carried to, until a change is not carried.
  const changes = approvals.flatMap(a => {
    const out = [];
    let head = a.head, since = a.at;
    while (head) {
      const cur = head, from = since;
      const next = heads.find(h => time(h.at) > time(from) && !same(cur,h.sha));
      if (!next) break;
      const carry = trusted.find(c => { const m = parseVerdictCarriedMarker(c.body); return m && same(m.fromSha,cur) && same(m.toSha,next.sha); });
      out.push({ ...a, head: cur, nextHead: next.sha, changedAt: next.at, carryApplied: carry ? true : null, carryEvidence: carry?.ref ?? null });
      if (!carry) break;
      head = next.sha; since = next.at;
    }
    return out;
  });
  const falseFindings = falseFindingsForPr({ repo, pr: Number(pr), comments, window: { since: openedAt, until: new Date(time(mergedAt)+1).toISOString() } });
  const standDowns = trusted.filter(c => /stood down|STAND-DOWN|not-a-ci-break/i.test(c.body.split('\n')[0])).map(c => ({ at: c.at, evidence: c.ref }));
  const drainSkips = trusted.filter(c => /drain.skip/i.test(c.body.split('\n')[0])).map(c => ({ at: c.at, reason: c.body.split('\n')[0].replace(/^.*drain.skip[: —-]*/i,''), evidence: c.ref }));
  const scopeKey = repoKeyForSlug(repo) ?? repo;
  const outside = scope?.length && input.completeness?.core !== 'incomplete' ? (input.files ?? []).map(f => f.filename).filter(f => !scope.some(g => coversFile(g.includes(':') ? g : `${scopeKey}:${g}`, `${scopeKey}:${f}`))) : null;
  const prepareHistory = prepares.map(p => ({ ...p, ageHours: minutes(p.at,openedAt) === null ? null : minutes(p.at,openedAt)/60, stale: time(openedAt)-time(p.at) > SETTINGS.prepareStaleHours*3600000 }));
  const causes = rounds.flatMap(r => r.causes.map(c => ({ ...c, phase: 'fix-rounds', minutesLost: null, evidence: [r.at, r.head, c.evidence].filter(Boolean) })));
  causes.push(...gaps.filter(g => g.minutesLost > 0).map(g => ({ cause: `handoff:${g.kind}`, phase: g.kind, minutesLost: g.minutesLost, evidence: g.evidence })), ...falseFindings.map(f => ({ cause: `false-finding:${f.cause}`, phase: 'review', minutesLost: null, evidence: [f.ref ?? f.at] })));
  causes.push(...drainSkips.map(c => ({ cause: `drain-skip:${c.reason}`, phase: 'drain', minutesLost: null, evidence: [c.evidence] })));
  if (standDowns.length) causes.push({ cause: 'stand-down', phase: 'fix-rounds', minutesLost: null, evidence: standDowns.map(s => s.evidence) });
  if (prepareHistory.some(p => p.stale)) causes.push({ cause: 'stale-prepare', phase: 'prepare', minutesLost: null, evidence: prepareHistory.filter(p => p.stale).map(p => p.ref ?? p.at) });
  if (changes.length) causes.push({ cause: 'approval-head-change', phase: 'review', minutesLost: null, evidence: changes.map(c => c.changedAt) });
  if (outside?.length) causes.push({ cause: 'scope-creep', phase: 'fix-rounds', minutesLost: null, evidence: outside });
  // Actor metadata is evidence only. Existing shared author authentication still controls marker parsing.
  const observations = (kind, rows, stamp, actor) => rows.map(e => ({kind,at:stamp(e),actor:actor(e) ?? null,evidence:e.html_url ?? e.url ?? e.id ?? e.sha ?? stamp(e)}));
  const sourceEvents = sorted([
    ...observations('comment',comments,c => c.created_at ?? c.createdAt,c => c.author?.login ?? c.user?.login),
    ...observations('timeline',input.labels ?? [],e => e.created_at ?? e.createdAt,e => e.actor?.login),
    ...observations('commit',commits,c => c.commit?.committer?.date ?? c.commit?.author?.date,c => c.committer?.login ?? c.author?.login),
    ...observations('check',checks,c => c.created_at ?? c.started_at,c => c.app?.slug),
    ...observations('verdict',verdicts ?? [],v => v.at,v => typeof v.actor === 'string' ? v.actor : v.actor?.login),
    ...observations('fix-ledger',ledger,l => l.at,l => typeof l.actor === 'string' ? l.actor : l.actor?.login),
    ...observations('prepare',prepares,p => p.at,p => p.actor),
  ].filter(e => time(e.at) >= time(openedAt) && time(e.at) <= time(mergedAt)));
  const observedLost = changes.filter(c => c.carryApplied !== true).length;
  return { repo, pr: Number(pr), openedAt, mergedAt, leadHours: minutes(openedAt,mergedAt)/60, phases, intervals, events:sourceEvents, completeness:input.completeness ?? null, checks: checks.map(c => ({ name: c.name, head: c.head_sha, waitMinutes: minutes(c.created_at,c.started_at), runMinutes: minutes(c.started_at,c.completed_at), conclusion: c.conclusion, evidence: c.html_url ?? c.id ?? null })), gaps, rounds, falseFindings, standDowns, approvals: { lost: verdicts === null ? null : observedLost, observedLost, status:verdicts === null ? 'unknown' : 'observed', headChanges: changes }, scope: { patterns: scope, outside, status: outside === null ? 'unknown' : 'observed' }, prepareHistory, drainSkips, conflicts: extracted.conflicts, rebases: trusted.filter(c => /rebas|re-stamp/i.test(c.body.split('\n')[0])).map(c => ({ at: c.at, evidence: c.ref })), mechanicalMerges: heads.filter(h => h.parents.length > 1), fixLoop: ledger, causes,
    warnings: [...(input.warnings ?? []), 'Commit dates are a head-change proxy; force-pushed heads may be absent.', 'Drain skips are a lower bound; unknown carry evidence counts conservatively.', 'Cause times may overlap; null means no attributable duration.', 'REST check runs lack creation timestamps; check wait is unknown unless a creation stamp is supplied. Label phases still record CI wait.', 'Prepare staleness uses a configurable 24-hour heuristic, not an analysis benchmark.'] };
}
export function shouldPostmortem(r, s = DEFAULTS) {
  return r.leadHours >= s.minLeadHours || r.rounds.length >= s.minFixRounds || (r.approvals.lost !== null && r.approvals.lost >= s.minLostApprovals) || (s.onStandDown && r.standDowns.length > 0);
}

export const coronerStateDir = (env = process.env) => env.WE_CORONER_STATE_DIR || dirname(env.WE_CORONER_STATE || join(homedir(), 'workspace/.operations/state/coroner-last.json'));
export function readOptionalJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path,'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function atomicJson(path, value) { atomicText(path, `${JSON.stringify(value, null, 2)}\n`); }
function atomicText(path, text) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,text); fs.renameSync(tmp,path);
}
export function renderPostmortem(r) {
  return [`# Delivery postmortem — ${r.repo} #${r.pr}`, '', `${r.openedAt} → ${r.mergedAt} (${r.leadHours.toFixed(1)} hours)`, '',
    `Fix rounds: ${r.rounds.length}. Approval head changes without observed carry: ${r.approvals.lost ?? 'unknown'}. Stand-downs: ${r.standDowns.length}.`, '',
    '| Phase | Minutes |', '| --- | ---: |', ...r.phases.map(p => `| ${p.phase} | ${p.minutes} |`), '',
    '| Hand-off | Minutes | Benchmark p90 | Excess |', '| --- | ---: | ---: | ---: |', ...r.gaps.map(g => `| ${g.kind} | ${g.minutes} | ${g.p90} | ${g.minutesLost} |`), '',
    '## Fix rounds', '', ...r.rounds.map(x => `- Round ${x.round}, ${x.at}, head ${x.head ?? 'unknown'}: ${x.causes.map(c => [c.cause,c.check,c.lens,c.theme].filter(Boolean).join(' / ')).join('; ') || 'unclassified'}`), '',
    '## Evidence and limitations', '', ...r.warnings.map(w => `- ${w}`), '',
    'Full structured evidence (false findings, carry observations, scope, prepares, checks and drain skips):', '', '```json', JSON.stringify(r,null,2), '```', ''].join('\n');
}
/** Read every receipt under the publication lock; only an unterminated final
 * fragment may be discarded. Keep byte offsets so UTF-8 and blank lines survive.
 */
function readPublicationJournal(path) {
  let fd;
  try { fd = fs.openSync(path,'r+'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Error('incidents journal unreadable');
    if (stat.size > 64*1024*1024) throw Error('incidents journal exceeds read cap; refusing incomplete deduplication');
    const data = Buffer.alloc(stat.size);
    for (let offset = 0; offset < data.length;) {
      const n = fs.readSync(fd,data,offset,Math.min(64*1024,data.length-offset),offset);
      if (!n) throw Error('incidents journal incomplete read; refusing recovery');
      offset += n;
    }
    const rows = [];
    let start = 0;
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10,start)) {
      if (end > start) rows.push(JSON.parse(data.toString('utf8',start,end)));
      start = end+1;
    }
    if (start < data.length) {
      let tail;
      try { tail = JSON.parse(data.toString('utf8',start)); }
      catch {
        // A failed append can leave complete receipts followed by a JSON prefix.
        // Truncation is repeatable after a crash and never rewrites valid receipts.
        fs.ftruncateSync(fd,start);
        return rows;
      }
      rows.push(tail);
      // A complete receipt may have landed without its newline. Retain it for
      // deduplication and finish the delimiter before appending another record.
      if (fs.writeSync(fd,'\n',data.length,'utf8') !== 1) throw Error('incidents journal delimiter write incomplete');
    }
    return rows;
  } finally { fs.closeSync(fd); }
}
/** Journal-first publication: event IDs deduplicate partial publication after process death.
 * The caller serializes publication with withCoronerLock. Direct CLI does the same.
 * `beat` is that lock's fence: it runs before every write, so an owner whose lease was
 * reclaimed while it was suspended stops instead of writing next to the new owner.
 */
export function publishPostmortem(r, { dir = coronerStateDir(), beat = () => {} } = {}) {
  fs.mkdirSync(dir,{recursive:true});
  const path = join(dir,'incidents.jsonl');
  const rows = readPublicationJournal(path);
  const key = `${r.repo}#${r.pr}`;
  const grouped = new Map();
  for (const c of r.causes) { const g = grouped.get(c.cause) ?? []; g.push(c); grouped.set(c.cause,g); }
  const pending = [];
  for (const [cause, observations] of grouped) {
    const id = `postmortem:${key}:${cause}`;
    if (!rows.some(row => row.id === id)) pending.push({ at: r.mergedAt, repo: r.repo, pr: r.pr, cause, phase: observations[0].phase,
      minutesLost: observations.some(c => c.minutesLost !== null) ? Math.round(observations.reduce((s,c) => s+(c.minutesLost ?? 0),0)*10)/10 : null,
      evidence: observations.flatMap(c => c.evidence), id });
  }
  const all = [...rows,...pending];
  for (const cause of grouped.keys()) {
    // A retried publication can precede incidents already journaled. Examine the
    // 24-hour windows containing this merge, anchored at each observed merge.
    const merged = time(r.mergedAt), day = 86400000;
    const incidents = all.filter(row => row.kind !== 'triage-candidate' && row.cause === cause && time(row.at) >= merged-day && time(row.at) <= merged+day)
      .sort((a,b) => time(a.at)-time(b.at));
    const candidates = all.filter(row => row.kind === 'triage-candidate' && row.cause === cause).map(row => time(row.at)).sort((a,b) => a-b);
    const counts = new Map();
    let start = 0, candidateIndex = 0, lastCandidate = -Infinity;
    for (let end = 0; end < incidents.length; end++) {
      const row = incidents[end], subject = `${row.repo}#${row.pr}`;
      counts.set(subject,(counts.get(subject) ?? 0)+1);
      while (time(incidents[start].at) < time(row.at)-day) {
        const old = incidents[start++], oldSubject = `${old.repo}#${old.pr}`;
        const count = counts.get(oldSubject)-1;
        if (count) counts.set(oldSubject,count); else counts.delete(oldSubject);
      }
      if (time(row.at) < merged || counts.size < 3 || (incidents[end+1] && time(incidents[end+1].at) === time(row.at))) continue;
      while (candidateIndex < candidates.length && candidates[candidateIndex] <= time(row.at)-day) candidateIndex++;
      if ((candidateIndex < candidates.length && candidates[candidateIndex] < time(row.at)+day) || time(row.at)-lastCandidate < day) continue;
      pending.push({ at: row.at, repo: row.repo, pr: row.pr, cause, phase: 'triage', minutesLost: null, evidence: [...counts.keys()].sort(), kind: 'triage-candidate', id: `triage-candidate:${cause}:${row.at}` });
      lastCandidate = time(row.at);
    }
  }
  if (pending.length) { beat(); fs.appendFileSync(path, pending.map(row => JSON.stringify(row)).join('\n')+'\n'); }
  const name = `postmortem-${repoFilenameKey(r.repo)}-${r.pr}`;
  beat(); atomicJson(join(dir,`${name}.json`),r);
  beat(); atomicText(join(dir,`${name}.md`),renderPostmortem(r));
  return { report: `${name}.md`, incidents: pending.length };
}
export const ghJson = args => JSON.parse(execFileSyncThrottled('gh',args,{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024}));
export function ghPages(path, gh = ghJson) {
  const pages = gh(['api','--paginate','--slurp',path]);
  if (!Array.isArray(pages) || !pages.length || pages.some(p => !Array.isArray(p) || p.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) throw Error('invalid paginated response');
  return pages.flat();
}
/** All remote operations are GETs; comments use the shared paginated, throttled leaf reader.
 * Optional ledger/card reads are explicitly marked incomplete on failure. Core timeline failures abort.
 */
export function collectPrTimeline(repo, pr, { gh = ghJson, comments = defaultListPrComments, env = process.env } = {}) {
  try { return collectCompletePrTimeline(repo,pr,{gh,comments,env}); }
  catch (cause) { const error = new Error(`incomplete PR timeline: ${cause?.message ?? cause}`,{cause}); error.incomplete = true; throw error; }
}
function collectCompletePrTimeline(repo, pr, { gh, comments, env }) {
  validateSubject(repo,pr);
  const root = `repos/${repo}`;
  const p = gh(['api',`${root}/pulls/${pr}`]);
  if (!p.merged_at) throw Error('PR has not merged');
  const completeness = {core:'complete',verdicts:'unknown',fixLoop:'unknown',card:'unknown'};
  const warnings = [], optional = (label, key, fn, fallback) => {
    try { const value = fn(); completeness[key] = 'complete'; return value; }
    catch { warnings.push(`${label} unavailable`); completeness[key] = 'incomplete'; return fallback; }
  };
  const commits = ghPages(`${root}/pulls/${pr}/commits?per_page=100`,gh);
  const labels = ghPages(`${root}/issues/${pr}/events?per_page=100`,gh);
  validateTimelineEvents(labels);
  const thread = comments({number:pr,repo});
  if (!Array.isArray(thread) || thread.some(c => !c || typeof c !== 'object' || Array.isArray(c))) throw Error('invalid comment pages');
  // Check every observed head, including force-push timeline heads. Caps fail instead of silently omitting history.
  const shas = [...new Set([...commits.map(c => c.sha), ...labels.filter(e => e.event === 'head_ref_force_pushed').map(e => e.commit_id)].filter(Boolean))];
  if (shas.length > 200) throw Error('PR exceeds 200 observed heads; refusing incomplete check history');
  const checks = shas.flatMap(sha => {
    const pages = gh(['api','--paginate','--slurp',`${root}/commits/${sha}/check-runs?filter=all&per_page=100`]);
    if (!Array.isArray(pages) || !pages.length || pages.some(p => !p || !Array.isArray(p.check_runs) || p.check_runs.some(c => !c || typeof c !== 'object' || Array.isArray(c)))) throw Error('invalid check-run pages');
    return pages.flatMap(p => p.check_runs);
  });
  const ledgerRepo = repo;
  const verdicts = optional('Verdict ledger', 'verdicts', () => {
    const data = gh(['api',`repos/${env.WE_CORONER_LEDGER_REPO || CONSTELLATION_REPOS.we.slug}/contents/${ledgerGitPath(ledgerRepo)}?ref=${LEDGER_TRANSPORT_BRANCH}`]);
    const text = data.content ? Buffer.from(data.content,'base64').toString('utf8') : gh === ghJson ? execFileSyncThrottled('gh', ['api','-H','Accept: application/vnd.github.raw+json', `repos/${env.WE_CORONER_LEDGER_REPO || CONSTELLATION_REPOS.we.slug}/contents/${ledgerGitPath(ledgerRepo)}?ref=${LEDGER_TRANSPORT_BRANCH}`], { encoding:'utf8', timeout:60000, maxBuffer:64*1024*1024 }) : '';
    if (!text) throw Error('missing ledger content');
    const events = parseLedgerEvents(text);
    if (events.length !== text.split('\n').filter(line => line.trim()).length) throw Error('invalid verdict ledger rows');
    return events.filter(v => v.pr === Number(pr) && v.repo === ledgerRepo);
  },null);
  const fixLoop = optional('Fix-loop ledger','fixLoop',() => {
    if (!fs.statSync(fixLoopLedgerPath(env)).isFile()) throw Error('fix-loop ledger is not a file');
    return readFixLoopRows({env});
  },[]);
  // The shared tolerant reader may omit old or malformed rows; never assert full coverage.
  if (completeness.fixLoop === 'complete') completeness.fixLoop = 'bounded';
  warnings.push('Fix-loop ledger reader retains only its newest 1 MiB; older sessions may be absent.');
  let scope = null; const prepares = [];
  const id = cardIdOf(p.head?.ref) ?? p.head?.ref?.match(/(?:^|\/)(\d{3,}|x[a-z0-9]{6})(?:-|$)/)?.[1];
  if (!id) warnings.push('No unambiguous card ID in branch; scope and prepare history are unknown.');
  if (id) optional('Card scope/prepare history', 'card', () => {
    const entries = gh(['api',`${root}/contents/backlog?ref=${p.base.sha}`]);
    const file = entries.find(e => e.name.startsWith(`${id}-`));
    if (!file) throw Error('card absent');
    const history = ghPages(`${root}/commits?path=${encodeURIComponent(file.path)}&per_page=100`,gh);
    // Inspect all card revisions up to merge; preparedDate transitions identify prepares without prose guessing.
    if (history.length > 100) throw Error('card history exceeds 100 revisions');
    let last = null;
    for (const c of [...history].reverse()) {
      if (time(c.commit.committer.date) > time(p.merged_at)) continue;
      const data = gh(['api',`${root}/contents/${file.path}?ref=${c.sha}`]);
      const card = parseCard(Buffer.from(data.content,'base64').toString('utf8'));
      if (!card) throw Error('invalid card revision');
      if (card.scope.length && (!scope || time(c.commit.committer.date) <= time(p.created_at))) scope = card.scope;
      if (card.preparedDate && card.preparedDate !== last) prepares.push({ at: `${card.preparedDate}T00:00:00Z`, recordedAt: c.commit.committer.date, ref: c.sha });
      last = card.preparedDate;
    }
  },null);
  if (completeness.card === 'incomplete') { scope = null; prepares.length = 0; }
  const files = ghPages(`${root}/pulls/${pr}/files?per_page=100`,gh);
  if (!Number.isSafeInteger(p.changed_files) || p.changed_files < 0) {
    completeness.core = 'incomplete';
    warnings.push('PR changed_files count unavailable or invalid; file list completeness and scope verdict are unknown.');
  } else if (files.length < p.changed_files) {
    completeness.core = 'incomplete';
    warnings.push(`PR file list incomplete: collected ${files.length} of ${p.changed_files} changed files; scope verdict is unknown.`);
  }
  return { repo, pr: Number(pr), openedAt:p.created_at, mergedAt:p.merged_at, url:p.html_url, labels, comments:thread, commits, checks, verdicts, fixLoop,
    files, scope, prepares, warnings, completeness };
}

// Shared local serialization, with dead-process recovery, using the existing lease primitive.
import { reserve, releaseLockDirIf, heartbeatOwn, DEFAULT_LEASE_MINUTES } from '../readiness/file-locks.mjs';
import { hostname } from 'node:os';
/** Heartbeat lease, not a fixed TTL: a live owner refreshes its heartbeat (timer plus `beat()`
 * between items) so it keeps the lock however long it runs; a dead local owner is reclaimed at
 * once; an owner whose heartbeat lapses (other host, reused pid, hung) is reclaimed after the lease.
 * `fn` receives `{ beat }`; `beat()` throws when the lock was reclaimed, so a deposed owner stops. */
export async function withCoronerLock(dir, fn, { clock = Date.now, leaseMinutes = DEFAULT_LEASE_MINUTES, beatMs = leaseMinutes*60000/5 } = {}) {
  fs.mkdirSync(dir,{recursive:true});
  const owner = `${hostname()}:${process.pid}:${randomUUID()}`, root = join(dir,'locks'), key = 'coroner-postmortem';
  const result = reserve(root,key,owner,clock(),new Date(clock()).toISOString(),process.pid, entry => {
    if (!entry.owner?.startsWith(`${hostname()}:`)) return 'unknown';
    try { process.kill(entry.pid,0); return 'alive'; } catch(e) { return e.code === 'ESRCH' ? 'dead' : 'unknown'; }
  }, leaseMinutes, null, true);
  if (!result.ok) throw Error('coroner postmortem is already running');
  let lost = false;
  const beat = () => {
    if (lost || !heartbeatOwn(root,key,owner,new Date(clock()).toISOString())) { lost = true; throw Error('coroner lock lost; heartbeat lease was reclaimed'); }
  };
  const timer = beatMs > 0 ? setInterval(() => { try { beat(); } catch { /* recorded in `lost`; the next beat() call stops the work */ } },beatMs) : null;
  timer?.unref();
  let value, failure, failed = false;
  try { value = await fn({ beat }); } catch (error) { failed = true; failure = error; }
  if (timer) clearInterval(timer);
  // Owner-only match: a beat moves heartbeatAt, so matching the pre-beat entry would never release.
  // A deposed owner leaves the new owner's lock standing and learns of it here, not as success.
  const released = releaseLockDirIf(root,key,{ owner });
  if (failed) throw failure;
  if (!released || lost) throw Error('coroner lock lost; heartbeat lease was reclaimed');
  return value;
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    const { values } = parseArgs({ options: { repo:{type:'string'}, pr:{type:'string'}, json:{type:'boolean'}, out:{type:'string'} } });
    validateSubject(values.repo,values.pr);
    const dir = values.out ?? coronerStateDir();
    await withCoronerLock(dir, ({ beat }) => {
      const settings = resolvePostmortemSettings();
      const report = { ...buildPostmortem(collectPrTimeline(values.repo,Number(values.pr))), settings };
      publishPostmortem(report,{dir,beat});
      console.log(values.json ? JSON.stringify(report) : renderPostmortem(report));
    });
  } catch(e) { console.error(`coroner-pr-postmortem: ${e.message}`); process.exitCode = 1; }
}
