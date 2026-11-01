/**
 * @file scripts/conveyor/delegated-clearance-sweep.mjs
 * @description R130 (2026-10-26, operator: "Ok"): delegated R11 clearance and named pre-approvals.
 * Platform preference `delegatedClearance`: {shadowUntil, preApprovalsFile, stateFile}; env overrides
 * WE_DELEGATED_CLEARANCE_SHADOW_UNTIL / WE_DELEGATED_CLEARANCE_PRE_APPROVALS_FILE / WE_DELEGATED_CLEARANCE_STATE_FILE.
 * Absent/invalid shadowUntil stays in shadow indefinitely: an operator sets an elapsed ISO time to go live.
 * External pre-approvals example (the orchestrator seeds the real R122, never this repository):
 * [{repo:"owner/repository",pr:5925,rulingId:"R122",operatorQuote:"<operator's exact words>",approvedHead:"<optional 40-hex SHA>",
 * conditions:{redTeamClear:true,accepted:true,allowedHeadMove:"card-only"},
 * voidIf:"new-confirmed-correctness-or-security-break"}]. JSON requires quoted keys.
 * Without approvedHead the first observed head is persisted, even while gates are pending. Replacing a rulingId
 * starts a new observation. Neither a failed read nor a non-card move can fall through to R11.
 * Every approval requires a repository slug; legacy unqualified records require operator correction.
 * At most eight candidates per tick; oversized/unreadable evidence requires operator review of the full diff.
 * Memo and observation state live beside the operations handoff, not in the checkout. CLI refusals are final
 * for that pr@head; the operator resolves them. The CLI remains the authority on posting identity and live head.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { handoffHome } from '../operations/handoff-home.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { latestAdvisory, trustedAdvisoryComments, advisoryCoversHead } from '../lib/advisory-labels.mjs';
import { DELEGATED_CLEARANCE_INELIGIBLE_LABELS } from '../lib/review-labels.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { isHumanOperatorComment } from '../lib/operator-identity.mjs';
import { redTeamForHead, parseRedTeamComment, parseRedTeamGateMarker, redTeamResultId } from '../lib/red-team-gate.mjs';
import { defaultCloneDirFor } from './accept-carry-sweep.mjs';
import { defaultReadPr } from './advisory-label-sweep.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const repoKey = v => typeof v === 'string' && /^[\w.-]+\/[\w.-]+$/.test(v) ? v.toLowerCase() : null;
const approvalFor = (approvals, repo, num) => {
  const key = repoKey(repo);
  return key === null ? undefined : approvals.find(a => repoKey(a?.repo) === key && a.pr === num);
};
const names = pr => (pr.labels ?? []).map(l => typeof l === 'string' ? l : l?.name);
const validApproval = a => repoKey(a?.repo) !== null && Number.isSafeInteger(a?.pr) && a.pr > 0 && typeof a.rulingId === 'string' && a.rulingId.trim()
  && typeof a.operatorQuote === 'string' && a.operatorQuote.trim() && (a.approvedHead === undefined || sha(a.approvedHead))
  && typeof a.conditions?.redTeamClear === 'boolean' && typeof a.conditions?.accepted === 'boolean'
  && ['card-only', 'none'].includes(a.conditions.allowedHeadMove) && a.voidIf === 'new-confirmed-correctness-or-security-break';
const readJson = (file, fallback) => {
  try {
    if (statSync(file).size > 1024 * 1024) throw new Error('oversized clearance data; operator human review required');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};
export function resolveDelegatedClearance({ env = process.env, platform, tool, log } = {}) {
  return cascadePolicy('delegatedClearance', tool, {
  standard: { shadowUntil: '', preApprovalsFile: join(handoffHome(), 'delegated-pre-approvals.json'),
    stateFile: join(handoffHome(), 'state', 'delegated-clearance.json') },
  envValues: { shadowUntil: env.WE_DELEGATED_CLEARANCE_SHADOW_UNTIL,
    preApprovalsFile: env.WE_DELEGATED_CLEARANCE_PRE_APPROVALS_FILE,
    stateFile: env.WE_DELEGATED_CLEARANCE_STATE_FILE }, valid: v => typeof v === 'string', env, platform, log,
  }).value;
}
function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.new`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }); renameSync(temporary, file);
}
function gitFiles({ repo, head, approvedHead }) {
  const cwd = defaultCloneDirFor(repo);
  if (cwd === null) throw new Error('no repository checkout; human review required');
  if (!sha(head) || (approvedHead !== undefined && !sha(approvedHead))) throw new Error('invalid head');
  const range = approvedHead ? `${approvedHead}..${head}` : `main...${head}`;
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'],
    { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}
function filesValid(files, empty = false) {
  if (!Array.isArray(files) || (!empty && !files.length) || files.length > 1000
    || files.some(f => typeof f !== 'string' || !f || /[\x00-\x1f]/.test(f))) {
    throw new Error('incomplete or oversized file evidence; operator human review of the full diff required');
  }
  return files;
}
function score(files) {
  const r = spawnSync(process.execPath, [new URL('../review-core-cli.mjs', import.meta.url).pathname, 'shape', '--json'],
    { input: JSON.stringify(files), encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) throw new Error('shape unreadable; human review required');
  return JSON.parse(r.stdout);
}
function runClearance({ repo, num, args, body }) {
  const cwd = defaultCloneDirFor(repo);
  if (cwd === null) return { ok: false, detail: 'no repository checkout; operator intervention required' };
  const temporary = mkdtempSync(join(tmpdir(), 'delegated-clearance-'));
  try {
    const file = join(temporary, 'body.md'); writeFileSync(file, body, { mode: 0o600 });
    const r = spawnSync(process.execPath, [new URL('../review-set-label.mjs', import.meta.url).pathname, String(num),
      ...(repo ? [`--repo=${repo}`] : []), ...args, `--body-file=${file}`],
    { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024 });
    return { ok: r.status === 0, detail: String(r.error?.message || r.stdout || r.stderr || `exit ${r.status}`)
      .replace(/[\x00-\x1f]/g, ' ').slice(-500) };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** A clean rerun or head move cannot erase a confirmed break. Only a later operator dismissal can. */
function unresolvedBreaks(comments, pr) {
  const records = comments.map((c, index) => ({ c, index, time: Date.parse(c?.createdAt ?? c?.created_at) || 0 }))
    .sort((a, b) => a.time - b.time || a.index - b.index);
  return records.flatMap(({ c }, at) => {
    const result = isTrustedMarkerAuthor(c) ? parseRedTeamComment(c?.body) : null;
    if (result?.pr !== pr) return [];
    const dismissed = new Set();
    for (const { c: later } of records.slice(at + 1)) {
      if (!isHumanOperatorComment(later)) continue;
      const gate = parseRedTeamGateMarker(later?.body);
      if (gate?.pr !== pr || gate.rev !== result.rev || gate.result !== redTeamResultId(result)
        || !['operator-not-real', 'operator-dismissed'].includes(gate.outcome)) continue;
      // Read only the producer's action block, never quoted findings or free-form prose below it.
      const lines = later.body.trimStart().split('\n');
      for (let i = lines[1]?.startsWith('**Red-team gate** ') ? 2 : 1; i < lines.length && lines[i].startsWith('- '); i++) {
        const m = /^- \d+ finding\(s\) left advisory \((#\d+(?:, #\d+)*)\)\.$/.exec(lines[i]);
        if (m) for (const index of m[1].split(', ')) dismissed.add(Number(index.slice(1)));
      }
    }
    return result.findings.filter(f => f.confirmed && f.impact !== 'cosmetic' && !dismissed.has(f.index));
  });
}

/** Pure head-pinned evidence filter; named pre-approvals may waive only their configured review conditions. */
export function planDelegatedClearance(prs, { repo = null, preApprovals = [] } = {}) {
  return (Array.isArray(prs) ? prs : []).flatMap(pr => {
    if (!Number.isSafeInteger(pr?.number) || !sha(pr.headRefOid) || !Array.isArray(pr.labels)
      || !names(pr).includes('review:human') || !Array.isArray(pr.comments)) return [];
    const approval = approvalFor(preApprovals, repo, pr.number);
    const redTeam = redTeamForHead(pr.comments, pr.number, pr.headRefOid);
    const broken = unresolvedBreaks(pr.comments, pr.number);
    const c = { num: pr.number, head: pr.headRefOid, approval, broken };
    if (approval && broken.length) return [c];
    const labels = names(pr), accepted = latestAdvisory(trustedAdvisoryComments(pr.comments));
    if (labels.some(l => DELEGATED_CLEARANCE_INELIGIBLE_LABELS.includes(l)) || pr.isDraft === true || pr.mergeable !== 'MERGEABLE'
      || !Array.isArray(pr.statusCheckRollup) || !pr.statusCheckRollup.length
      || !pr.statusCheckRollup.every(ch => ch?.conclusion === 'SUCCESS' && ch.status === 'COMPLETED'
        || ch?.state === 'SUCCESS') || broken.length) return [];
    if ((!approval || approval.conditions.accepted) && (!labels.includes('advisory:accepted') || accepted?.outcome !== 'accept' || !advisoryCoversHead(accepted, pr.headRefOid))) return [];
    if ((!approval || approval.conditions.redTeamClear) && (!labels.includes('red-team:clear') || !redTeam)) return [];
    return [c];
  });
}

/** IO shell: at most eight candidates, eight discovery and eight live complete-thread reads per tick, with deferred reads reported.
 * Complete-thread reads and candidates rotate using persisted per-repo cursors (older state starts at zero).
 * Pre-approval heads are observed before either bound. All evidence readers and effects are injectable. */
export function sweepDelegatedClearance({ prs, repo = null, dryRun = false, setting = resolveDelegatedClearance(),
  readNetFiles = gitFiles, readMovedFiles = gitFiles, shape = score,
  readPreApprovals = () => readJson(setting.preApprovalsFile, []),
  readState = () => readJson(setting.stateFile, { observed: {}, memo: {} }), writeState = s => saveState(setting.stateFile, s),
  readComments = readCompletePrComments, readPr = o => defaultReadPr({ ...o, fields: 'number,state,labels,headRefOid,mergeable,statusCheckRollup,isDraft' }), now = Date.now,
  emit = e => appendDaemonEvent({ ...e, detail: { head: e.head, basis: e.basis, rulingId: e.rulingId } }), runLabel = runClearance,
} = {}) {
  const results = [];
  try {
    const approvals = readPreApprovals();
    if (!Array.isArray(approvals) || approvals.length > 100 || approvals.some(a => !validApproval(a))
      || new Set(approvals.map(a => `${repoKey(a.repo)}#${a.pr}`)).size !== approvals.length) throw new Error('invalid pre-approvals; operator review required');
    let held = (Array.isArray(prs) ? prs : []).filter(p => Array.isArray(p?.labels) && names(p).includes('review:human')
      && (names(p).includes('advisory:accepted') || approvalFor(approvals, repo, p.number)));
    if (!held.length) return results;
    if (!planDelegatedClearance(held, { repo, preApprovals: approvals }).length
      && !held.some(p => approvalFor(approvals, repo, p.number) || p.comments?.length >= 100)) return results;
    const state = structuredClone(readState());
    if (!state || typeof state.observed !== 'object' || !state.observed || typeof state.memo !== 'object' || !state.memo
      || Array.isArray(state.memo) || Array.isArray(state.observed) || Object.keys(state.memo).length > 20000) {
      throw new Error('invalid or oversized clearance state; operator review required');
    }
    const observedKey = a => `${repoKey(a.repo)}#${a.pr}:${a.rulingId}`;
    const voidKey = a => `${observedKey(a)}:pre-approval-void`;
    // Legacy voids lacked a ruling identity. Fail closed against the current approval, then retire
    // the old key so a subsequent, explicitly new operator ruling can authorize clearance.
    for (const a of approvals) {
      const legacy = Object.keys(state.memo).filter(k => k.toLowerCase().startsWith(`${repoKey(a.repo)}#${a.pr}@`)
        && k.endsWith(':pre-approval-void') && state.memo[k]);
      if (legacy.length) {
        state.memo[voidKey(a)] = true;
        for (const k of legacy) delete state.memo[k];
        if (!dryRun) writeState(state);
      }
    }
    const shadow = !Number.isFinite(Date.parse(setting.shadowUntil)) || now() < Date.parse(setting.shadowUntil);
    held = held.filter(p => {
      const key = `${repo ?? ''}#${p.number}@${p.headRefOid}`;
      const a = approvalFor(approvals, repo, p.number);
      if (a && state.memo[voidKey(a)]) return false;
      if (a
        && (p.comments?.length >= 100 || Array.isArray(p.comments) && unresolvedBreaks(p.comments, p.number).length)) return true;
      return !state.memo[`${key}:attempt`] && !state.memo[`${key}:pre-approval-void`]
        && !(shadow && state.memo[`${key}:would-approve`]);
    });
    for (const p of held) {
      const a = approvalFor(approvals, repo, p.number);
      if (a && sha(p.headRefOid) && !state.observed[observedKey(a)]) {
        state.observed[observedKey(a)] = a.approvedHead ?? p.headRefOid;
        if (!dryRun) writeState(state);
      }
    }
    if (state.commentCursors !== undefined && (!state.commentCursors || typeof state.commentCursors !== 'object'
      || Array.isArray(state.commentCursors) || Object.values(state.commentCursors).some(n => !Number.isSafeInteger(n) || n < 0))) {
      throw new Error('invalid complete comment read cursor; operator review required');
    }
    if (state.candidateCursors !== undefined && (!state.candidateCursors || typeof state.candidateCursors !== 'object'
      || Array.isArray(state.candidateCursors) || Object.values(state.candidateCursors).some(n => !Number.isSafeInteger(n) || n < 0))) {
      throw new Error('invalid candidate cursor; operator review required');
    }
    state.candidateCursors ??= {};
    state.commentCursors ??= {};
    const cursorKey = `repo:${repo ?? ''}`;
    const pending = held.filter(p => Array.isArray(p.comments) && p.comments.length >= 100);
    const start = (state.commentCursors[cursorKey] ?? 0) % Math.max(1, pending.length);
    const selected = new Set([...pending.slice(start), ...pending.slice(0, start)].slice(0, 8));
    if (pending.length && !dryRun) {
      state.commentCursors[cursorKey] = (start + selected.size) % pending.length;
      writeState(state);
    }
    const complete = held.flatMap(p => {
      if (!Array.isArray(p.comments) || p.comments.length < 100) return [p];
      if (!selected.has(p)) {
        results.push({ num: p.number, delegated: 'deferred', detail: 'complete comment read budget exhausted; retry next tick or request operator review' });
        return [];
      }
      return [{ ...p, comments: readComments(p.number, { repo }) }];
    });
    const candidates = planDelegatedClearance(complete, { repo, preApprovals: approvals });
    const candidateStart = (state.candidateCursors[cursorKey] ?? 0) % Math.max(1, candidates.length);
    const batch = [...candidates.slice(candidateStart), ...candidates.slice(0, candidateStart)].slice(0, 8);
    // Advance before shape checks: rejected candidates must not consume every subsequent tick, even after restart.
    if (candidates.length && !dryRun) {
      state.candidateCursors[cursorKey] = (candidateStart + batch.length) % candidates.length;
      writeState(state);
    }
    for (const c of batch) {
      const key = `${repo ?? ''}#${c.num}@${c.head}`;
      const basis = c.approval ? `R130 / ${c.approval.rulingId}` : 'R130 / R11';
      const event = kind => ({ kind, repo, pr: c.num, head: c.head, basis, ...(c.approval ? { rulingId: c.approval.rulingId } : {}) });
      const publish = kind => {
        const memoKey = kind === 'pre-approval-void' ? voidKey(c.approval) : `${key}:${kind}`;
        if (dryRun || state.memo[memoKey]) return;
        state.memo[memoKey] = true; writeState(state); emit(event(kind));
      };
      if (c.approval && c.broken.length) { publish('pre-approval-void'); results.push({ num: c.num, delegated: 'pre-approval-void', detail: basis }); continue; }
      // A void belongs to the ruling and survives every subsequent head.
      if ((c.approval && state.memo[voidKey(c.approval)]) || state.memo[`${key}:attempt`]) continue;
      const files = filesValid(readNetFiles({ repo, ...c }));
      const scored = shape(files);
      if (typeof scored?.humanRequired !== 'boolean') throw new Error('shape incomplete; human review required');
      if (!c.approval && scored.humanRequired) continue;
      if (c.approval) {
        const approvedHead = c.approval.approvedHead ?? state.observed[observedKey(c.approval)];
        if (!sha(approvedHead)) throw new Error('approved head unknown; human review required');
        if (approvedHead !== c.head && (c.approval.conditions.allowedHeadMove !== 'card-only'
          || !filesValid(readMovedFiles({ repo, ...c, approvedHead }), true).every(f => /^backlog\/[^/]+\.md$/.test(f)))) continue;
      }
      if (dryRun) { results.push({ num: c.num, delegated: 'would-try', detail: basis }); continue; }
      if (shadow) { publish('would-approve'); results.push({ num: c.num, delegated: 'would-approve', detail: basis }); continue; }
      const reason = `${basis}: operator R130 "Ok"${c.approval ? `; ${c.approval.rulingId}: ${c.approval.operatorQuote}` : ''}`;
      const body = `${reason}\n\nNet files (git main three-dot head):\n${JSON.stringify(files)}\n\nShape: ${JSON.stringify(scored)}\n\nHead: ${c.head}`;
      const args = ['--to=clear-human', '--actor=daemon-delegate-R130', '--channel=daemon', `--expect-head=${c.head}`,
        `--reason=${reason}`, `--delegation-json=${JSON.stringify({ by: 'operator R130', scope: `${basis} PR ${c.num} head ${c.head}`, expires: new Date(now() + 300000).toISOString() })}`];
      const fresh = readPr({ repo, number: c.num, readComments });
      const replanned = planDelegatedClearance([fresh], { repo, preApprovals: approvals })[0];
      if (replanned?.broken.length && c.approval) publish('pre-approval-void');
      const before = complete.find(p => p.number === c.num);
      const gates = p => JSON.stringify([names(p).sort(), p.mergeable, p.isDraft === true,
        p.statusCheckRollup?.map(ch => JSON.stringify(ch)).sort()]);
      if (!replanned || replanned.broken.length || fresh.headRefOid !== c.head || gates(fresh) !== gates(before)) {
        results.push({ num: c.num, delegated: 'aborted', detail: 'live clearance evidence changed or incomplete; retry next tick or request operator review' });
        continue;
      }
      state.memo[`${key}:attempt`] = true; writeState(state);
      let r;
      try { r = runLabel({ repo, ...c, args, body }); } catch (e) { r = { ok: false, detail: String(e.message) }; }
      publish(r?.ok === true ? 'auto-approved' : 'approval-refused');
      results.push({ num: c.num, delegated: r?.ok === true ? 'auto-approved' : 'refused', detail: r?.detail ?? 'CLI refused; operator intervention required' });
    }
  } catch (e) { results.push({ num: 0, delegated: 'sweep-failed', detail: String(e?.message ?? e).replace(/[\x00-\x1f]/g, ' ').slice(0, 500) }); }
  return results;
}
