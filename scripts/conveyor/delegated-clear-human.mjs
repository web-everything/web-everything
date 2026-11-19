#!/usr/bin/env node
/**
 * Auto clear-human: fresh, head-pinned seven-clause evaluation. Ships off.
 * The conveyor runner supplies --prs-file; the snapshot only nominates candidates.
 * Shadow reports exclusions and approvals plus one tick; on clears at most one PR
 * through the sanctioned pinned writer. Replay substitutes review:human and never writes.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDeclaredSettings } from '../lib/settings-files.mjs';
import { cascadePolicy, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { handoffHome } from '../lib/handoff-path.mjs';
import { writeJsonAtomic, withFileLock } from '../lib/atomic-json-file.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { scoreEscalation } from '../lib/review-escalation.mjs';
import { latestAdvisory, trustedAdvisoryComments, advisoryCoversHead } from '../lib/advisory-labels.mjs';
import { readDrainRedTeamEvidence, settleUnknownEvidenceByComment, readRedTeamPublicationHold } from '../lib/drain-red-team-evidence.mjs';
import { planRedTeamStatusLabels } from '../lib/red-team-status-labels.mjs';
import { isSecurityClassFinding } from '../lib/jury-core.mjs';
import { getRequiredStatusChecks, readRequiredStatusChecksDetailed } from '../lib/required-status-checks.mjs';
import { resolveRequiredChecks } from '../lib/check-state-predicate.mjs';
import { workflowEditHold } from '../lib/merge-queue-enqueue.mjs';
import { refreshMergeGateAfterRestamp } from '../lib/merge-gate-refresh.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

export const MODES = Object.freeze(['off', 'shadow', 'on']);
export const BLOCKERS = Object.freeze(['red-team:blocked', 'size:over-cap', 'status:at-round-limit', 'review:changes',
  'status:sent-back-red-team', 'advisory:changes', 'advisory:ruling-needed']);
const SHA = /^[a-f0-9]{40}$/i;
const names = labels => labels.map(l => typeof l === 'string' ? l : l?.name);
const ignoredCheck = name => ['merge-gate', 'review-gate'].includes(name);

/** New key wins over the legacy alias across all layers. Invalid explicitly disables. */
export function resolveDelegatedClearHumanMode({ env = {}, platform = {}, repo = {}, log = () => {} } = {}) {
  const hasNew = platform?.orchestrator?.autoClearHuman !== undefined || repo?.orchestrator?.autoClearHuman !== undefined
    || env.WE_AUTO_CLEAR_HUMAN !== undefined;
  const leaf = layer => hasNew ? layer?.orchestrator?.autoClearHuman : layer?.delegatedClearHuman?.mode;
  const safe = value => value === undefined ? undefined : MODES.includes(value) ? value : 'off';
  const resolved = cascadePolicy('orchestrator', { autoClearHuman: safe(leaf(repo)) }, {
    standard: { autoClearHuman: 'off' }, platform: { autoClearHuman: safe(leaf(platform)) },
    envValues: { autoClearHuman: safe(hasNew ? env.WE_AUTO_CLEAR_HUMAN : env.WE_DELEGATED_CLEAR_HUMAN_MODE) },
    operatorOverride: {}, env, log,
  });
  return { value: resolved.value.autoClearHuman, source: resolved.sources.autoClearHuman };
}

export function loadDelegatedClearHumanMode({ env = process.env, readDeclared = readDeclaredSettings,
  readPlatform = readPlatformPreferences, log = console.error } = {}) {
  try {
    const declared = readDeclared();
    const platform = readPlatform({ env });
    if (declared.errors?.length || platform.errors?.length) return { value: 'off', source: 'unreadable' };
    return resolveDelegatedClearHumanMode({ env, platform: platform.prefs, repo: declared.settings, log });
  } catch { return { value: 'off', source: 'unreadable' }; }
}

/** Latest timestamp per producer identity; ambiguous duplicates are unreadable. */
export function latestCheckRows(rows) {
  if (!Array.isArray(rows)) throw Error('checks unreadable');
  const byIdentity = new Map(), identitiesByName = new Map();
  for (const row of rows) {
    const name = row?.name ?? row?.context;
    if (typeof name !== 'string' || !name) throw Error('check name unreadable');
    const producer = [row.app?.id, row.app?.slug, row.app_id, row.app_slug,
      row.workflow_id, row.workflow?.id, row.workflow?.path, row.workflow?.name,
      row.workflowName, row.workflow_name, row.workflowId,
      typeof row.workflow === 'string' ? row.workflow : null];
    if (producer.some(value => value != null && (typeof value !== 'string' && typeof value !== 'number'
      || String(value).trim() === ''))) throw Error('check identity unreadable');
    // A classic commit status (`context`, no `name`) is its own producer bucket; a check run with no producer
    // fields at all cannot be told apart from another same-name run, so it stays ambiguous (refuse).
    const known = producer.some(value => value != null) || row?.name == null;
    if (identitiesByName.has(name) && (!known || !identitiesByName.get(name))) throw Error('check identity ambiguous');
    identitiesByName.set(name, known);
    const key = JSON.stringify([name, producer, row.head_sha ?? null]);
    const old = byIdentity.get(key);
    if (!old) { byIdentity.set(key, row); continue; }
    const time = r => Date.parse(r.startedAt ?? r.started_at ?? r.createdAt ?? r.created_at ?? r.completedAt ?? r.completed_at);
    const a = time(old), b = time(row);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) throw Error('check order unreadable');
    if (b > a) byIdentity.set(key, row);
  }
  return [...byIdentity.values()];
}

/** All IO is injected. No mutation; each missing/throwing reader is a refusal. */
export function evaluateEligibility(candidate, readers = {}) {
  const failed = [], evidence = { head: candidate?.headRefOid ?? null, replay: candidate?.replay === true };
  const reject = reason => { if (!failed.includes(reason)) failed.push(reason); };
  const read = (name, fn) => { try { const value = fn(); if (value === undefined) throw Error('missing'); return value; }
    catch { reject(`unreadable-${name}`); return null; } };
  const head = evidence.head;
  if (!SHA.test(head ?? '')) reject('head-unpinned');
  const pr = read('pr', () => readers.readPr(candidate, head));
  if (!evidence.replay && pr?.headRefOid !== head) reject('head-moved');
  let labels = Array.isArray(pr?.labels) ? names(pr.labels) : null;
  if (!labels || labels.some(l => typeof l !== 'string')) { reject('unreadable-labels'); labels = []; }
  evidence.originalLabels = [...labels];
  if (evidence.replay) {
    labels = labels.map(l => l === 'review:accepted' ? 'review:human' : l);
    if (!labels.includes('review:human')) labels.push('review:human');
    // A clear strips these two labels, so a replay at the clear head models them as present; the advisory ruling,
    // head coverage and red-team evidence clauses below are still decided from the comments and run records.
    evidence.replaySynthesizedLabels = [];
    for (const l of ['advisory:accepted', 'red-team:clear']) if (!labels.includes(l)) { labels.push(l); evidence.replaySynthesizedLabels.push(l); }
  }
  evidence.labels = labels;
  if (!labels.includes('review:human')) reject('review-human');
  for (const label of BLOCKERS) if (labels.includes(label)) reject(label);
  const comments = read('comments', () => readers.readComments(candidate, head));
  if (!Array.isArray(comments)) reject('unreadable-comments');
  const trusted = trustedAdvisoryComments(comments);
  const advisory = latestAdvisory(trusted);
  const basis = trusted[advisory?.index]?.body?.match(/^Net basis: `([a-f0-9]+\.\.[a-f0-9]+)`/im)?.[1];
  evidence.advisory = advisory ? { ...advisory, basis: basis ?? null } : null;
  if (!labels.includes('advisory:accepted')) reject('advisory-label');
  if (advisory?.outcome !== 'accept') reject('advisory-ruling');
  if (!advisoryCoversHead(advisory, head)) reject('advisory-head');
  const redTeam = read('red-team', () => readers.readRedTeam({ ...pr, number: candidate.number, labels, comments }, head));
  evidence.redTeam = redTeam ? { clear: redTeam.clear, evidence: {
    ok: redTeam.evidence?.ok, reason: redTeam.evidence?.reason, settledByComment: redTeam.evidence?.settledByComment,
    inFlight: redTeam.evidence?.inFlight, scheduled: redTeam.evidence?.scheduled, queued: redTeam.evidence?.queued,
    recorded: redTeam.evidence?.recorded, status: redTeam.evidence?.status?.status, result: redTeam.evidence?.status?.result,
  } } : null;
  if (!labels.includes('red-team:clear') || redTeam?.clear !== true || redTeam?.evidence?.ok !== true) reject('red-team');
  evidence.publicationHold = read('publication-hold', () => readers.readPublicationHold(candidate, head));
  if (evidence.publicationHold !== null) reject('red-team-publication');
  const review = read('review', () => readers.readReview(candidate, head));
  evidence.review = review;
  if (review?.head !== head || !Array.isArray(review?.findings)) reject('unreadable-review');
  evidence.securityFindings = Array.isArray(review?.findings) ? review.findings.filter(isSecurityClassFinding) : null;
  if (evidence.securityFindings?.length) reject('security-finding');
  const roster = read('required-checks', () => readers.readRequiredChecks(candidate, head));
  evidence.requiredChecks = roster;
  const rows = read('checks', () => {
    const raw = readers.readChecks(candidate, head);
    if (!Array.isArray(raw)) throw Error('checks unreadable');
    return raw;
  });
  evidence.checkRows = rows;
  const required = Array.isArray(roster?.checks) ? roster.checks.filter(n => !ignoredCheck(n)) : null;
  const checks = resolveRequiredChecks({ rows: rows?.filter(r => !ignoredCheck(r?.name ?? r?.context)),
    rowsHead: head, rowsComplete: Array.isArray(rows), requiredNames: required, rosterSource: roster?.source, head });
  evidence.checkResolution = checks;
  if (checks.state !== 'pass') reject('required-checks');
  const latestRows = read('check-identities', () => latestCheckRows(rows?.filter(r => !ignoredCheck(r?.name ?? r?.context))));
  if (latestRows?.some(r => !ignoredCheck(r.name ?? r.context)
    && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(r.conclusion ?? r.state ?? '').toUpperCase()))) reject('other-check');
  evidence.score = read('score', () => readers.scoreNet(candidate, head));
  if (evidence.score?.scored !== true) reject('unreadable-score');
  if (!evidence.score?.signals || typeof evidence.score.signals !== 'object') reject('unreadable-score');
  if (evidence.score?.humanRequired !== false) reject('human-required');
  if (evidence.score?.signals?.gateSelf?.length) reject('gate-self');
  const files = read('files', () => readers.readFiles(candidate, head));
  evidence.files = files;
  evidence.workflowEdit = workflowEditHold({ files, expectedCount: files?.length });
  if (evidence.workflowEdit.hold) reject(evidence.workflowEdit.humanOnly ? 'workflow-edit' : 'unreadable-files');
  evidence.liveHead = read('head', () => readers.readLiveHead(candidate));
  if (!evidence.replay && evidence.liveHead !== head) reject('head-moved');
  return { eligible: failed.length === 0, failed, evidence };
}

/** S0b: settle local unknowns using the complete PR thread before planning clear. */
export function redTeamAtHead(pr, head, { repo, readEvidence = readDrainRedTeamEvidence,
  settle = settleUnknownEvidenceByComment, plan = planRedTeamStatusLabels } = {}) {
  const raw = readEvidence({ repo, pr: pr.number, head });
  const settled = settle(raw, pr.comments, pr.number, head, pr.reviews);
  const evidence = { ...settled, ok: !!settled && settled.ok !== false
    && (typeof settled.recorded === 'boolean' || settled.ok === true) };
  const result = plan({ labels: pr.labels, comments: pr.comments, repo, pr: pr.number, head, evidence });
  return { clear: evidence?.ok === true && (result.add === 'red-team:clear'
    || (names(pr.labels).includes('red-team:clear') && !result.remove.includes('red-team:clear') && !result.add)),
    evidence, coveringReview: raw?.loopPayload ?? raw?.settleBounds?.unfinishedHit?.run ?? null };
}

export async function clearHumanViaCli({ pr, head, reason, actor = 'orchestrator', repo, exec = execFileSyncThrottled }) {
  if (!SHA.test(head ?? '')) throw Error('head must be pinned');
  exec(process.execPath, ['scripts/review-set-label.mjs', String(pr), '--to=clear-human', `--actor=${actor}`,
    '--channel=daemon', `--expect-head=${head}`, `--reason=${reason}`, ...(repo ? [`--repo=${repo}`] : [])],
  { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 120_000 });
}

/** Persistent bounded per-(repo, PR, head, verdict) event deduplication. Replay bypasses this store. */
export function createEventEmitter({ repo, home, append = appendDaemonEvent } = {}) {
  const dir = handoffHome({ home }), path = join(dir, 'delegated-clear-human-events.json');
  return async event => {
    if (event.kind === 'delegated-clear-human-tick') return append({ ...event, repo, daemon: 'delegated-clear-human' });
    mkdirSync(dir, { recursive: true });
    return withFileLock(`${path}.lock`, () => {
      let state = {};
      try { state = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const key = JSON.stringify([repo, event.pr, event.detail.head, event.kind]);
      if (state[key]) return false;
      // appendDaemonEvent is async: reserve before append so concurrent sweeps cannot duplicate.
      state[key] = Date.now();
      state = Object.fromEntries(Object.entries(state).slice(-2000));
      writeJsonAtomic(path, state);
      return append({ ...event, repo, daemon: 'delegated-clear-human' });
    });
  };
}

export async function runDelegatedClearHuman({ prs = [], mode = 'off', replay = false, emitReplay = false,
  emit = e => appendDaemonEvent({ ...e, daemon: 'delegated-clear-human' }), clearHuman = clearHumanViaCli,
  refreshGate = refreshMergeGateAfterRestamp, repo, ...readers } = {}) {
  const out = { mode: MODES.includes(mode) ? mode : 'off', seen: 0, wouldApprove: [], cleared: [], refused: [], results: [] };
  if (out.mode === 'off' && !replay) return out;
  const publish = async (kind, pr, evidence) => { if (!replay || emitReplay) await emit({ kind, pr, detail: evidence }); };
  let attemptedClear = false;
  for (const candidate of prs) {
    if (!replay && !names(candidate.labels ?? []).includes('review:human')) continue;
    out.seen++;
    const r = evaluateEligibility({ ...candidate, replay }, readers);
    out.results.push({ pr: candidate.number, ...r });
    if (!r.eligible) {
      out.refused.push({ pr: candidate.number, failed: r.failed });
      for (const reason of r.failed) await publish(`excluded:${reason}`, candidate.number, { ...r.evidence, failed: r.failed });
      if (r.failed.some(f => ['size:over-cap', 'workflow-edit'].includes(f)))
        await publish('orchestrator-decision-owed', candidate.number, { ...r.evidence, failed: r.failed });
      continue;
    }
    out.wouldApprove.push(candidate.number);
    await publish('would-approve', candidate.number, r.evidence);
    if (out.mode !== 'on' || replay || attemptedClear) continue;
    try {
      // Re-read again at the actual write boundary, after event IO.
      if (readers.readLiveHead(candidate) !== r.evidence.head) throw Error('head-moved');
      attemptedClear = true;
      await clearHuman({ pr: candidate.number, head: r.evidence.head, actor: 'orchestrator', repo,
        reason: `Auto clear-human predicate: ${JSON.stringify(r.evidence)}` });
      out.cleared.push(candidate.number);
      await refreshGate({ repo, pr: candidate.number, head: r.evidence.head, restampedAtMs: Date.now() });
    } catch (e) {
      const reason = e.message === 'head-moved' ? 'head-moved' : 'writer-refused';
      out.refused.push({ pr: candidate.number, failed: [reason] });
      await publish(`excluded:${reason}`, candidate.number, { ...r.evidence, failed: [reason], error: String(e.message) });
    }
  }
  if (out.mode === 'shadow' && !replay) await publish('delegated-clear-human-tick', undefined,
    { reviewHumanSeen: out.seen, wouldApprove: out.wouldApprove.length, excluded: out.refused.length });
  return out;
}

/** Bounded live readers. Head and base objects must be locally readable; no branch substitution. */
export function liveReaders({ cwd = process.cwd(), repo = ghRepoSlug('we'), maxCalls = 128,
  exec = execFileSyncThrottled } = {}) {
  let calls = 0;
  const run = (cmd, args, opts = {}) => {
    if (cmd === 'gh' && ++calls > maxCalls) throw Error('tick read budget exhausted; operator may replay the PR');
    return exec(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...opts });
  };
  const json = args => JSON.parse(run('gh', args));
  const states = new Map(), redTeams = new Map(), files = new Map(), scores = new Map();
  const key = pr => `${pr.number}@${pr.headRefOid}`;
  const diff = (pr, head) => {
    const k = key(pr);
    if (files.has(k)) return;
    const state = states.get(pr.number);
    if (!SHA.test(head) || !SHA.test(state?.baseRefOid ?? '')) throw Error('diff basis unreadable');
    const base = String(run('git', ['merge-base', state.baseRefOid, head])).trim();
    if (!SHA.test(base)) throw Error('merge base unreadable');
    const paths = String(run('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'])).split('\0').filter(Boolean);
    const numstat = String(run('git', ['diff', '--no-renames', '--numstat', '-z', base, head, '--']));
    let diffLines = 0;
    for (const row of numstat.split('\0').filter(Boolean)) {
      const match = row.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!match) throw Error('numstat unreadable');
      diffLines += (match[1] === '-' ? 0 : Number(match[1])) + (match[2] === '-' ? 0 : Number(match[2]));
    }
    const diffHunks = String(run('git', ['diff', '--no-renames', '--no-ext-diff', base, head, '--']));
    const score = scoreEscalation({ changedFiles: paths, humanBasisFiles: paths, diffLines, cumulativeDiffLines: diffLines, diffHunks });
    files.set(k, paths); scores.set(k, { ...score, scored: true, files: paths.length, diffLines, base, head });
  };
  return {
    readPr: pr => { const state = json(['pr', 'view', String(pr.number), '--repo', repo, '--json',
      'number,labels,headRefOid,baseRefOid,reviews']); states.set(pr.number, state); return state; },
    readComments: pr => readCompletePrComments(pr.number, { repo, exec: run }),
    readLiveHead: pr => json(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'headRefOid']).headRefOid,
    readRedTeam: (pr, head) => { const rt = redTeamAtHead(pr, head, { repo }); redTeams.set(pr.number, rt); return rt; },
    readPublicationHold: (pr, head) => readRedTeamPublicationHold({ repo, pr: pr.number, head }),
    readReview: (pr, head) => {
      const payload = redTeams.get(pr.number)?.coveringReview;
      if (payload?.findings?.read?.netBasis?.rev !== head) throw Error('covering review unreadable');
      // Finding-bearing seats only: judgeReferralVerifier carries `results`, not `findings`. The two blocking
      // seats must be present; an absent advisory seat is simply not a source of findings.
      const seats = ['judge', 'judgeSecurity', 'judgeAdvisory', 'judgeCorrectnessAdvisory']
        .filter(name => payload.findings[name] !== undefined).map(name => [name, payload.findings[name]]);
      if (!payload.findings.judge || !payload.findings.judgeSecurity
        || seats.some(([, seat]) => !Array.isArray(seat?.findings))) throw Error('review findings unreadable');
      return { head, findings: seats.flatMap(([, seat]) => seat.findings) };
    },
    readRequiredChecks: () => getRequiredStatusChecks({ repo, readOnly: true,
      readChecks: options => readRequiredStatusChecksDetailed({ ...options,
        restGet: path => ({ json: json(['api', path]) }),
      }),
    }),
    readChecks: (_pr, head) => {
      const readPages = (kind, field) => {
        const rows = [];
        for (let page = 1; page <= 10; page++) {
          const response = json(['api', `repos/${repo}/commits/${head}/${kind}?per_page=100&page=${page}`]);
          const batch = field ? response?.[field] : response;
          if (!Array.isArray(batch)) throw Error('check pages unreadable');
          rows.push(...batch);
          if (batch.length < 100) {
            if (field && response.total_count !== rows.length) throw Error('check count incomplete');
            return rows;
          }
        }
        throw Error('check page cap exceeded; operator must inspect/replay');
      };
      return [...readPages('check-runs', 'check_runs'), ...readPages('statuses')];
    },
    readFiles: (pr, head) => { diff(pr, head); return files.get(key(pr)); },
    scoreNet: (pr, head) => { diff(pr, head); return scores.get(key(pr)); },
  };
}

export async function main(argv) {
  const repo = argv.find(a => a.startsWith('--repo='))?.slice(7) || ghRepoSlug('we');
  const replayArgs = argv.filter(a => a.startsWith('--replay=')).map(a => a.slice(9));
  const replay = replayArgs.length > 0;
  const prsFile = argv.find(a => a.startsWith('--prs-file='))?.slice(11);
  const prs = replay ? replayArgs.map(value => {
    const match = value.match(/^(\d+)@([a-f0-9]{40})$/i);
    if (!match || Number(match[1]) < 1) throw Error('replay requires <pr>@<40-hex head>');
    return { number: Number(match[1]), headRefOid: match[2].toLowerCase() };
  }) : prsFile ? JSON.parse(readFileSync(prsFile, 'utf8')) : [];
  if (!replay && !prsFile) throw Error('--prs-file is required for a sweep');
  const resolved = loadDelegatedClearHumanMode();
  const requested = argv.find(a => a.startsWith('--mode='))?.slice(7);
  const mode = requested === undefined ? resolved.value : MODES.includes(requested) ? requested : 'off';
  process.stderr.write(`orchestrator.autoClearHuman=${mode} (${requested === undefined ? resolved.source : 'flag'})\n`);
  const emit = replay ? e => appendDaemonEvent({ ...e, repo, daemon: 'delegated-clear-human' }) : createEventEmitter({ repo });
  const out = await runDelegatedClearHuman({ prs, mode, repo, replay, emitReplay: argv.includes('--emit'), emit, ...liveReaders({ repo }) });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => { process.stderr.write(`${String(e.message).replace(/[\p{Cc}\p{Cf}]/gu, ' ')}\n`); process.exitCode = 1; });
