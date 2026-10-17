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
import { readFixLoopRows } from '../conveyor/fix-loop-ledger.mjs';
import { buildPrRounds, normalizeComment, classifyEvent, headsOf, parseCard, cardIdOf } from './coroner-rounds.mjs';
import { falseFindingsForPr } from './coroner-false-findings.mjs';
import { readBounded } from './coroner-extract.mjs';
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
export function buildPostmortem(input, { benchmarks = SETTINGS.handoffP90Minutes } = {}) {
  const { repo, pr, openedAt, mergedAt, verdicts = [], fixLoop = [], scope = null, prepares = [] } = input;
  const comments = (input.comments ?? []).filter(c => time(c.created_at ?? c.createdAt) <= time(mergedAt));
  const commits = (input.commits ?? []).filter(c => time(c.commit?.committer?.date ?? c.commit?.author?.date) <= time(mergedAt));
  const checks = [...new Map((input.checks ?? []).filter(c => time(c.created_at ?? c.started_at ?? c.completed_at) <= time(mergedAt)).map(c => [c.id ?? JSON.stringify(c), c])).values()].map(c => time(c.completed_at) > time(mergedAt) ? { ...c, completed_at: null, conclusion: null } : c);
  validateSubject(repo, pr);
  if (!Number.isFinite(time(openedAt)) || !Number.isFinite(time(mergedAt)) || time(mergedAt) < time(openedAt)) throw Error('postmortem requires a merged PR with valid timestamps');
  const trusted = comments.map(c => ({ ...normalizeComment(c), ref: c.url ?? c.id ?? c.createdAt ?? c.created_at })).filter(c => c.trusted && time(c.at) >= time(openedAt) && time(c.at) <= time(mergedAt));
  const queueEvents = (input.labels ?? []).filter(e => ['added_to_merge_queue','removed_from_merge_queue'].includes(e.event)).map(e => ({ ...e, event: e.event === 'added_to_merge_queue' ? 'labeled' : 'unlabeled', label: { name: 'merge-queue' } }));
  const events = sorted([...(input.labels ?? []), ...queueEvents].filter(e => ['labeled', 'unlabeled'].includes(e.event)).map(e => ({ at: e.created_at ?? e.createdAt, name: e.label?.name, add: e.event === 'labeled', ref: e.url ?? e.id ?? e.created_at })));
  const live = new Set(), intervals = []; let start = openedAt;
  const phase = () => PHASES.find(([, names]) => names.some(n => live.has(n)))?.[0] ?? 'other';
  for (const e of [...events, { at: mergedAt, end: true }]) {
    if (time(e.at) < time(openedAt) || time(e.at) > time(mergedAt)) continue;
    if (time(e.at) > time(start)) intervals.push({ phase: phase(), from: start, to: e.at, minutes: minutes(start, e.at) });
    if (!e.end) { if (e.add) live.add(e.name); else live.delete(e.name); } start = e.at;
  }
  const phases = [...new Set(intervals.map(i => i.phase))].map(phase => ({ phase, minutes: Math.round(intervals.filter(i => i.phase === phase).reduce((s,i) => s+i.minutes, 0)*10)/10 }));
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
  const mark = (kind, at, evidence) => { if (Number.isFinite(time(at)) && time(at) >= time(openedAt) && time(at) <= time(mergedAt)) marks.push({ kind, at, evidence }); };
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
  const finalChecks = new Map();
  for (const c of [...checks].sort((a,b) => String(a.completed_at).localeCompare(String(b.completed_at)))) finalChecks.set(`${c.head_sha}|${c.name}`,c);
  for (const c of finalChecks.values()) {
    if (c.name === 'test' && c.conclusion === 'success') mark('ci-green',c.completed_at,c.html_url ?? c.id);
    if (!/review.?gate/i.test(c.name) && ['failure','timed_out','startup_failure'].includes(c.conclusion)) mark('ci-red',c.completed_at,c.html_url ?? c.id);
  }
  mark('merged', mergedAt, input.url ?? `https://github.com/${repo}/pull/${pr}`);
  const gaps = [];
  const pairs = [['ci-green-review','ci-green','review'], ['accepted-ready','accepted','ready'], ['changes-fix','changes','fix'], ['fix-ci','fix-end','ci'], ['fix-review','fix-end','review'], ['ready-enqueued','ready','enqueued'], ['enqueued-merged','enqueued','merged'], ['clearance-ready','clearance','ready'], ['ci-red-heal','ci-red','heal']];
  for (const [kind, from, to] of pairs) for (const a of [...new Map(sorted(marks.filter(m => m.kind === from)).map(m => [m.at,m])).values()]) {
    const b = sorted(marks.filter(m => (m.kind === to || (kind === 'clearance-ready' && m.kind === 'enqueued') || (kind === 'ci-red-heal' && m.kind === 'fix')) && time(m.at) >= time(a.at)))[0];
    const superseded = marks.some(m => m.kind === from && time(m.at) > time(a.at) && time(m.at) <= time(b?.at));
    if (!b || superseded) continue;
    // CI green is only a valid dispatch boundary if the head did not change in between.
    if (kind === 'ci-green-review' && headsOf(commits).some(h => time(h.at) > time(a.at) && time(h.at) <= time(b.at))) continue;
    const duration = minutes(a.at,b.at), p90 = benchmarks[kind];
    gaps.push({ kind, from: a.at, to: b.at, minutes: duration, p90, minutesLost: Math.round(Math.max(0,duration-p90)*10)/10, evidence: [a.evidence,b.evidence].filter(v => v !== undefined) });
  }
  const heads = headsOf(commits);
  const approvals = sorted(verdicts.filter(v => ['accept','accepted','clear-human'].includes(v.verdict ?? v.action)).map(v => ({ at: v.at, head: v.coverage?.headSha ?? v.head, evidence: v.id ?? v.at })));
  for (const m of marks.filter(m => m.kind === 'accepted' || m.kind === 'clearance')) if (!approvals.some(a => Math.abs(time(a.at)-time(m.at)) < 60000)) approvals.push({ at: m.at, head: heads.filter(h => time(h.at) <= time(m.at)).at(-1)?.sha, evidence: m.evidence });
  const changes = approvals.flatMap(a => {
    const next = heads.find(h => time(h.at) > time(a.at) && !same(a.head,h.sha));
    if (!next || !a.head) return [];
    const carry = trusted.find(c => { const m = parseVerdictCarriedMarker(c.body); return m && same(m.fromSha,a.head) && same(m.toSha,next.sha); });
    return [{ ...a, nextHead: next.sha, changedAt: next.at, carryApplied: carry ? true : null, carryEvidence: carry?.ref ?? null }];
  });
  const falseFindings = falseFindingsForPr({ repo, pr: Number(pr), comments, window: { since: openedAt, until: new Date(time(mergedAt)+1).toISOString() } });
  const standDowns = trusted.filter(c => /stood down|STAND-DOWN|not-a-ci-break/i.test(c.body.split('\n')[0])).map(c => ({ at: c.at, evidence: c.ref }));
  const drainSkips = trusted.filter(c => /drain.skip/i.test(c.body.split('\n')[0])).map(c => ({ at: c.at, reason: c.body.split('\n')[0].replace(/^.*drain.skip[: —-]*/i,''), evidence: c.ref }));
  const scopeKey = repoKeyForSlug(repo) ?? repo;
  const outside = scope?.length ? (input.files ?? []).map(f => f.filename).filter(f => !scope.some(g => coversFile(g.includes(':') ? g : `${scopeKey}:${g}`, `${scopeKey}:${f}`))) : null;
  const prepareHistory = prepares.map(p => ({ ...p, ageHours: minutes(p.at,openedAt) === null ? null : minutes(p.at,openedAt)/60, stale: time(openedAt)-time(p.at) > SETTINGS.prepareStaleHours*3600000 }));
  const causes = rounds.flatMap(r => r.causes.map(c => ({ ...c, phase: 'fix-rounds', minutesLost: null, evidence: [r.at, r.head, c.evidence].filter(Boolean) })));
  causes.push(...gaps.filter(g => g.minutesLost > 0).map(g => ({ cause: `handoff:${g.kind}`, phase: g.kind, minutesLost: g.minutesLost, evidence: g.evidence })), ...falseFindings.map(f => ({ cause: `false-finding:${f.cause}`, phase: 'review', minutesLost: null, evidence: [f.ref ?? f.at] })));
  causes.push(...drainSkips.map(c => ({ cause: `drain-skip:${c.reason}`, phase: 'drain', minutesLost: null, evidence: [c.evidence] })));
  if (standDowns.length) causes.push({ cause: 'stand-down', phase: 'fix-rounds', minutesLost: null, evidence: standDowns.map(s => s.evidence) });
  if (prepareHistory.some(p => p.stale)) causes.push({ cause: 'stale-prepare', phase: 'prepare', minutesLost: null, evidence: prepareHistory.filter(p => p.stale).map(p => p.ref ?? p.at) });
  if (changes.length) causes.push({ cause: 'approval-head-change', phase: 'review', minutesLost: null, evidence: changes.map(c => c.changedAt) });
  if (outside?.length) causes.push({ cause: 'scope-creep', phase: 'fix-rounds', minutesLost: null, evidence: outside });
  return { repo, pr: Number(pr), openedAt, mergedAt, leadHours: minutes(openedAt,mergedAt)/60, phases, intervals, checks: checks.map(c => ({ name: c.name, head: c.head_sha, waitMinutes: minutes(c.created_at,c.started_at), runMinutes: minutes(c.started_at,c.completed_at), conclusion: c.conclusion, evidence: c.html_url ?? c.id ?? null })), gaps, rounds, falseFindings, standDowns, approvals: { lost: changes.filter(c => c.carryApplied !== true).length, headChanges: changes }, scope: { patterns: scope, outside, status: outside === null ? 'unknown' : 'observed' }, prepareHistory, drainSkips, conflicts: extracted.conflicts, rebases: trusted.filter(c => /rebas|re-stamp/i.test(c.body.split('\n')[0])).map(c => ({ at: c.at, evidence: c.ref })), mechanicalMerges: heads.filter(h => h.parents.length > 1), fixLoop: ledger, causes,
    warnings: [...(input.warnings ?? []), 'Commit dates are a head-change proxy; force-pushed heads may be absent.', 'Drain skips are a lower bound; unknown carry evidence counts conservatively.', 'Cause times may overlap; null means no attributable duration.', 'REST check runs lack creation timestamps; check wait is unknown unless a creation stamp is supplied. Label phases still record CI wait.', 'Prepare staleness uses a configurable 24-hour heuristic, not an analysis benchmark.'] };
}
export function shouldPostmortem(r, s = DEFAULTS) {
  return r.leadHours >= s.minLeadHours || r.rounds.length >= s.minFixRounds || r.approvals.lost >= s.minLostApprovals || (s.onStandDown && r.standDowns.length > 0);
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
    `Fix rounds: ${r.rounds.length}. Approval head changes without observed carry: ${r.approvals.lost}. Stand-downs: ${r.standDowns.length}.`, '',
    '| Phase | Minutes |', '| --- | ---: |', ...r.phases.map(p => `| ${p.phase} | ${p.minutes} |`), '',
    '| Hand-off | Minutes | Benchmark p90 | Excess |', '| --- | ---: | ---: | ---: |', ...r.gaps.map(g => `| ${g.kind} | ${g.minutes} | ${g.p90} | ${g.minutesLost} |`), '',
    '## Fix rounds', '', ...r.rounds.map(x => `- Round ${x.round}, ${x.at}, head ${x.head ?? 'unknown'}: ${x.causes.map(c => [c.cause,c.check,c.lens,c.theme].filter(Boolean).join(' / ')).join('; ') || 'unclassified'}`), '',
    '## Evidence and limitations', '', ...r.warnings.map(w => `- ${w}`), '',
    'Full structured evidence (false findings, carry observations, scope, prepares, checks and drain skips):', '', '```json', JSON.stringify(r,null,2), '```', ''].join('\n');
}
/** Journal-first publication: event IDs deduplicate partial publication after process death.
 * The caller serializes publication with withCoronerLock. Direct CLI does the same.
 */
export function publishPostmortem(r, { dir = coronerStateDir() } = {}) {
  fs.mkdirSync(dir,{recursive:true});
  const path = join(dir,'incidents.jsonl');
  const read = readBounded(path, { cap: 64*1024*1024 });
  if (!read.found && fs.existsSync(path)) throw Error('incidents journal unreadable');
  if (read.truncated) throw Error('incidents journal exceeds read cap; refusing incomplete deduplication');
  const rows = read.lines.filter(Boolean).map(line => JSON.parse(line));
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
    const recent = all.filter(row => row.kind !== 'triage-candidate' && row.cause === cause && time(row.at) <= time(r.mergedAt) && time(row.at) >= time(r.mergedAt)-86400000);
    const prs = [...new Set(recent.map(row => `${row.repo}#${row.pr}`))].sort();
    const candidate = all.some(row => row.kind === 'triage-candidate' && row.cause === cause && Math.abs(time(r.mergedAt)-time(row.at)) < 86400000);
    if (prs.length >= 3 && !candidate) pending.push({ at: r.mergedAt, repo: r.repo, pr: r.pr, cause, phase: 'triage', minutesLost: null, evidence: prs, kind: 'triage-candidate', id: `triage-candidate:${cause}:${r.mergedAt}` });
  }
  if (pending.length) fs.appendFileSync(path, pending.map(row => JSON.stringify(row)).join('\n')+'\n');
  const name = `postmortem-${r.repo.replace('/','-')}-${r.pr}`;
  atomicJson(join(dir,`${name}.json`),r); atomicText(join(dir,`${name}.md`),renderPostmortem(r));
  return { report: `${name}.md`, incidents: pending.length };
}
export const ghJson = args => JSON.parse(execFileSyncThrottled('gh',args,{encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024}));
export function ghPages(path, gh = ghJson) { const pages = gh(['api','--paginate','--slurp',path]); if (!Array.isArray(pages)) throw Error('invalid paginated response'); return pages.flat(); }
/** All remote operations are GETs; comments use the shared paginated, throttled leaf reader.
 * Optional ledger/card reads are explicitly marked incomplete on failure. Core timeline failures abort.
 */
export function collectPrTimeline(repo, pr, { gh = ghJson, comments = defaultListPrComments, env = process.env } = {}) {
  validateSubject(repo,pr);
  const root = `repos/${repo}`;
  const p = gh(['api',`${root}/pulls/${pr}`]);
  if (!p.merged_at) throw Error('PR has not merged');
  const warnings = [], optional = (label, fn, fallback) => { try { return fn(); } catch { warnings.push(`${label} unavailable`); return fallback; } };
  const commits = ghPages(`${root}/pulls/${pr}/commits?per_page=100`,gh);
  const labels = ghPages(`${root}/issues/${pr}/events?per_page=100`,gh);
  const thread = comments({number:pr,repo});
  // Check every observed head, including force-push timeline heads. Caps fail instead of silently omitting history.
  const shas = [...new Set([...commits.map(c => c.sha), ...labels.filter(e => e.event === 'head_ref_force_pushed').map(e => e.commit_id)].filter(Boolean))];
  if (shas.length > 200) throw Error('PR exceeds 200 observed heads; refusing incomplete check history');
  const checks = shas.flatMap(sha => {
    const pages = gh(['api','--paginate','--slurp',`${root}/commits/${sha}/check-runs?filter=all&per_page=100`]);
    if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p.check_runs))) throw Error('invalid check-run pages');
    return pages.flatMap(p => p.check_runs);
  });
  const ledgerRepo = repo;
  const verdicts = optional('Verdict ledger', () => {
    const data = gh(['api',`repos/${env.WE_CORONER_LEDGER_REPO || CONSTELLATION_REPOS.we.slug}/contents/${ledgerGitPath(ledgerRepo)}?ref=${LEDGER_TRANSPORT_BRANCH}`]);
    const text = data.content ? Buffer.from(data.content,'base64').toString('utf8') : gh === ghJson ? execFileSyncThrottled('gh', ['api','-H','Accept: application/vnd.github.raw+json', `repos/${env.WE_CORONER_LEDGER_REPO || CONSTELLATION_REPOS.we.slug}/contents/${ledgerGitPath(ledgerRepo)}?ref=${LEDGER_TRANSPORT_BRANCH}`], { encoding:'utf8', timeout:60000, maxBuffer:64*1024*1024 }) : '';
    if (!text) throw Error('missing ledger content');
    return parseLedgerEvents(text).filter(v => v.pr === Number(pr) && v.repo === ledgerRepo);
  },[]);
  const fixLoop = optional('Fix-loop ledger',() => readFixLoopRows({env}),[]);
  warnings.push('Fix-loop ledger reader retains only its newest 1 MiB; older sessions may be absent.');
  let scope = null; const prepares = [];
  const id = cardIdOf(p.head?.ref) ?? p.head?.ref?.match(/(?:^|\/)(\d{3,}|x[a-z0-9]{6})(?:-|$)/)?.[1];
  if (!id) warnings.push('No unambiguous card ID in branch; scope and prepare history are unknown.');
  if (id) optional('Card scope/prepare history', () => {
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
      if (!card) continue;
      if (card.scope.length && (!scope || time(c.commit.committer.date) <= time(p.created_at))) scope = card.scope;
      if (card.preparedDate && card.preparedDate !== last) prepares.push({ at: `${card.preparedDate}T00:00:00Z`, recordedAt: c.commit.committer.date, ref: c.sha });
      last = card.preparedDate;
    }
  },null);
  return { repo, pr: Number(pr), openedAt:p.created_at, mergedAt:p.merged_at, url:p.html_url, labels, comments:thread, commits, checks, verdicts, fixLoop,
    files: ghPages(`${root}/pulls/${pr}/files?per_page=100`,gh), scope, prepares, warnings };
}

// Shared local serialization, with dead-process recovery, using the existing lease primitive.
import { reserve, readLockEntry, releaseLockDirIf } from '../readiness/file-locks.mjs';
import { hostname } from 'node:os';
export async function withCoronerLock(dir, fn) {
  fs.mkdirSync(dir,{recursive:true});
  const owner = `${hostname()}:${process.pid}:${randomUUID()}`, root = join(dir,'locks'), key = 'coroner-postmortem';
  const result = reserve(root,key,owner,Date.now(),new Date().toISOString(),process.pid, entry => {
    if (!entry.owner?.startsWith(`${hostname()}:`)) return 'unknown';
    try { process.kill(entry.pid,0); return 'alive'; } catch(e) { return e.code === 'ESRCH' ? 'dead' : 'unknown'; }
  }, 120, null, true);
  if (!result.ok) throw Error('coroner postmortem is already running');
  const entry = readLockEntry(root,key);
  try { return await fn(); } finally { releaseLockDirIf(root,key,entry); }
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    const { values } = parseArgs({ options: { repo:{type:'string'}, pr:{type:'string'}, json:{type:'boolean'}, out:{type:'string'} } });
    validateSubject(values.repo,values.pr);
    const dir = values.out ?? coronerStateDir();
    await withCoronerLock(dir, () => {
      const settings = resolvePostmortemSettings();
      const report = { ...buildPostmortem(collectPrTimeline(values.repo,Number(values.pr))), settings };
      publishPostmortem(report,{dir});
      console.log(values.json ? JSON.stringify(report) : renderPostmortem(report));
    });
  } catch(e) { console.error(`coroner-pr-postmortem: ${e.message}`); process.exitCode = 1; }
}
