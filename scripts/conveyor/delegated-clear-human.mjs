#!/usr/bin/env node
/**
 * @file delegated-clear-human.mjs — R130 delegated clear-human pass.
 *
 * Standing delegation R11 lets the agent clear `review:human` on a PR that meets the operator's criteria. This
 * pass finds those PRs and records the clearance through the sanctioned CLI (`review-set-label.mjs
 * --to=clear-human`), never by editing a label. Mode `delegatedClearHuman.mode` = off | shadow | on, default
 * shadow: shadow appends a `would-approve` daemon event and changes nothing.
 *
 * Eligible = review:human held, advisory:accepted or review:accepted present, red-team:clear on the CURRENT head,
 * the NET diff scores humanRequired=false, every check passes apart from the review hold (`merge-gate`), and the
 * live head still equals the evaluated head at write time. Every unreadable input fails closed.
 *
 * WIRING (not done here, outside this file's scope): register in skills-src/conveyor/runner.mjs beside
 * `advisory-label-sweep` (pass-name list, skip list and `runRepo` call), as `conveyor/delegated-clear-human.mjs sweep`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PLATFORM_PREFERENCES_PATH } from '../lib/merge-delivery-policy.mjs';
import { readDeclaredSettings } from '../lib/settings-files.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { hasReviewLabel, REVIEW_LABELS, scoreEscalation } from '../lib/review-escalation.mjs';

export const R11_REASON = 'Standing delegation R11 (operator chalbert, Claude Code chat 2026-10-21 21:50 ET): "Ok, I allow you to approve any of those until this is changed"';
export const MODES = Object.freeze(['off', 'shadow', 'on']);
const ACTOR = 'chalbert';
const OK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
/** The review hold itself: the one failing check this pass is allowed to look past. */
const REVIEW_HOLD_CHECK = /^(merge-gate|review-gate)$/i;

/** standard (shadow) < platform < repo < env; invalid layers are ignored and reported. */
export function resolveDelegatedClearHumanMode({ env = {}, platform = {}, repo = {} } = {}) {
  let result = { value: 'shadow', source: 'standard' };
  const ignored = [];
  for (const [source, raw] of [['platform', platform?.delegatedClearHuman?.mode], ['repo', repo?.delegatedClearHuman?.mode],
    ['env', env?.WE_DELEGATED_CLEAR_HUMAN_MODE]]) {
    if (raw === undefined) continue;
    if (!MODES.includes(raw)) { ignored.push({ source, reason: `invalid delegatedClearHuman.mode: expected ${MODES.join('|')}` }); continue; }
    result = { value: raw, source };
  }
  return ignored.length ? { ...result, ignored } : result;
}

const names = (labels) => (labels || []).map((l) => (typeof l === 'string' ? l : l?.name));

function checksPass(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return { ok: false, why: 'no check rollup' };
  for (const c of rollup) {
    const name = c?.name || c?.context || '';
    if (REVIEW_HOLD_CHECK.test(name)) continue;
    const verdict = String(c?.conclusion || c?.state || '').toUpperCase();
    if (!OK_CONCLUSIONS.has(verdict) && verdict !== 'SUCCESS') return { ok: false, why: `check ${name || '?'} is ${verdict || 'pending'}` };
  }
  return { ok: true };
}

/** Pure given its injected readers. Returns `{eligible, failed, evidence}`; any throw or unknown input is a refusal. */
export function evaluateEligibility(pr, { scoreNet, redTeamClearAtHead } = {}) {
  const failed = [];
  const labels = pr?.labels || [];
  const head = typeof pr?.headRefOid === 'string' && /^[0-9a-f]{40}$/i.test(pr.headRefOid) ? pr.headRefOid : null;
  if (!head) failed.push('head not pinned');
  if (!hasReviewLabel(labels, REVIEW_LABELS.human)) failed.push('not review:human');
  const accepted = hasReviewLabel(labels, REVIEW_LABELS.accepted) ? REVIEW_LABELS.accepted
    : names(labels).includes('advisory:accepted') ? 'advisory:accepted' : null;
  if (!accepted) failed.push('no review:accepted / advisory:accepted');
  const checks = checksPass(pr?.statusCheckRollup);
  if (!checks.ok) failed.push(checks.why);
  let shape = null;
  if (head) {
    try { shape = scoreNet(pr); } catch { shape = null; }
    if (!shape || shape.scored !== true) failed.push('net diff unscored');
    else if (shape.humanRequired !== false) failed.push('net diff still humanRequired');
    let rt = false;
    try { rt = names(labels).includes('red-team:clear') && !!redTeamClearAtHead(pr, head); } catch { rt = false; }
    if (!rt) failed.push('red-team:clear not proven on the current head');
  }
  return { eligible: failed.length === 0, failed,
    evidence: { head, accepted, redTeam: 'clear', shape: { humanRequired: false, files: shape?.files ?? null }, checks: 'pass apart from the review hold' } };
}

/**
 * Record the clearance through the sanctioned CLI (argv array, no shell). FAILS CLOSED: `review-set-label.mjs`
 * cannot yet pin `--expect-head` for `--to=clear-human`, so a push between this pass's head read and the CLI's own
 * read could clear a head this pass never evaluated. Until the CLI gains a head pin (follow-up), the live `on`
 * mode refuses here; shadow mode never reaches this writer. Tests inject a pinned writer.
 */
export async function clearHumanViaCli({ pr, head, reason, actor, repo = null, exec = execFileSync, headPinSupported = false }) {
  if (!headPinSupported) throw new Error('review-set-label cannot pin the head for clear-human yet; refusing to clear an unpinned head');
  exec(process.execPath, ['scripts/review-set-label.mjs', String(pr), '--to=clear-human', `--actor=${actor}`, `--reason=${reason}`,
    `--expect-head=${head}`, ...(repo ? [`--repo=${repo}`] : [])], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 });
}

/** Reads platform preferences + declared settings + env; an unreadable layer is skipped (default stays shadow). */
export function loadDelegatedClearHumanMode({ env = process.env, readFile = readFileSync, readDeclared = readDeclaredSettings } = {}) {
  let platform = {};
  try { platform = JSON.parse(readFile(PLATFORM_PREFERENCES_PATH, 'utf8')); } catch { platform = {}; }
  let repo = {};
  try { repo = readDeclared().settings || {}; } catch { repo = {}; }
  return resolveDelegatedClearHumanMode({ env, platform, repo });
}

export async function runDelegatedClearHuman({ prs = [], mode = 'shadow', scoreNet, redTeamClearAtHead, readLiveHead,
  emit = (e) => appendDaemonEvent({ kind: e.kind, pr: e.pr, daemon: 'delegated-clear-human', detail: { head: e.head, evidence: e.evidence } }),
  clearHuman = clearHumanViaCli } = {}) {
  const out = { mode, wouldApprove: [], cleared: [], headMovedAfterClear: [], refused: [] };
  // Fail closed: only the three known modes act; anything else (typo, undefined) does nothing.
  if (mode !== 'shadow' && mode !== 'on') return out;
  for (const pr of prs) {
    if (!hasReviewLabel(pr?.labels || [], REVIEW_LABELS.human)) continue;
    const r = evaluateEligibility(pr, { scoreNet, redTeamClearAtHead });
    if (!r.eligible) { out.refused.push({ pr: pr.number, failed: r.failed }); continue; }
    if (mode === 'shadow') {
      await emit({ kind: 'would-approve', pr: pr.number, head: r.evidence.head, evidence: r.evidence });
      out.wouldApprove.push(pr.number);
      continue;
    }
    let live = null;
    try { live = readLiveHead(pr); } catch { live = null; }
    if (live !== r.evidence.head) { out.refused.push({ pr: pr.number, failed: ['live head moved since evaluation'] }); continue; }
    try { await clearHuman({ pr: pr.number, head: r.evidence.head, reason: R11_REASON, actor: ACTOR }); out.cleared.push(pr.number);
      // The CLI cannot pin a head for clear-human, so re-read after the write and flag a push that raced it.
      let after = null;
      try { after = readLiveHead(pr); } catch { after = null; }
      if (after !== r.evidence.head) out.headMovedAfterClear.push(pr.number); }
    catch (e) { out.refused.push({ pr: pr.number, failed: [`clear-human refused: ${String(e?.message || e).split('\n')[0]}`] }); }
  }
  return out;
}

/** Live readers (impure). The net score mirrors the drain: computeNetDiffSignals -> scoreEscalation. */
export async function liveReaders({ cwd = process.cwd(), repo = ghRepoSlug('we') } = {}) {
  const { computeNetDiffSignals } = await import('../merge-ai-prs.mjs');
  const exec = (cmd, args, opts) => execFileSync(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, ...opts });
  return {
    scoreNet: (pr) => {
      const sig = computeNetDiffSignals({ exec, rev: pr.headRefName, baseRev: pr.baseRefName, fetchExtraRefs: [pr.headRefName] });
      if (!sig.scored) return { scored: false };
      const s = scoreEscalation({ changedFiles: sig.changedFiles, diffLines: sig.diffLines, humanBasisFiles: sig.humanBasisFiles,
        cumulativeDiffLines: sig.cumulativeDiffLines, diffHunks: sig.diffHunks, basisNarrowed: sig.basisNarrowed !== false });
      return { scored: true, humanRequired: s.humanRequired === true, files: sig.humanBasisFiles.length };
    },
    redTeamClearAtHead: async () => false, // replaced below (needs repo); see liveRedTeam
    readLiveHead: (pr) => JSON.parse(execFileSync('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'headRefOid'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })).headRefOid,
  };
}

export async function liveRedTeam({ repo }) {
  const { readDrainRedTeamEvidence } = await import('../lib/drain-red-team-evidence.mjs');
  const { planRedTeamStatusLabels } = await import('../lib/red-team-status-labels.mjs');
  return (pr, head) => {
    const evidence = readDrainRedTeamEvidence({ repo, pr: pr.number, head });
    const plan = planRedTeamStatusLabels({ labels: pr.labels, comments: pr.comments, repo, pr: pr.number, head, evidence });
    const has = names(pr.labels).includes('red-team:clear');
    return plan.add === 'red-team:clear' || (has && !plan.remove.includes('red-team:clear') && !plan.add);
  };
}

async function main(argv) {
  const prsFile = argv.find((a) => a.startsWith('--prs-file='))?.slice('--prs-file='.length);
  const repo = argv.find((a) => a.startsWith('--repo='))?.slice('--repo='.length) || ghRepoSlug('we');
  const modeArg = argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length);
  const prs = prsFile ? JSON.parse(readFileSync(prsFile, 'utf8'))
    : JSON.parse(execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json',
      'number,headRefName,baseRefName,labels,headRefOid,statusCheckRollup,comments'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const resolved = loadDelegatedClearHumanMode();
  const mode = modeArg || resolved.value;
  process.stderr.write(`delegatedClearHuman.mode=${mode} (${modeArg ? 'flag' : resolved.source})\n`);
  const readers = await liveReaders({ repo });
  readers.redTeamClearAtHead = await liveRedTeam({ repo });
  const out = await runDelegatedClearHuman({ prs, mode, ...readers });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e?.message || e}\n`); process.exit(1); });
