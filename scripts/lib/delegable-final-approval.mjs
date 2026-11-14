import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveCascade, PLATFORM_PREFERENCES_PATH } from './policy-cascade.mjs';
import { latestAdvisory, trustedAdvisoryComments } from './advisory-labels.mjs';
import { hasReviewLabel, headEverHumanCleared, parseDeviationDisclosure, scoreEscalation } from './review-escalation.mjs';
import { currentActorId, parseAuthorActorId } from './review-independence.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, readRedTeamDisposition, redTeamForHead, isPublishableRedTeamResult } from './red-team-gate.mjs';
import { reduceCheckState } from '../operations/pr-status.mjs';
import { readRequiredStatusChecksDetailed } from './required-status-checks.mjs';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { repoProfile } from './repo-profile.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';

// Lazy: some suites load this module under a non-file import.meta.url.
const repoRoot = () => fileURLToPath(new URL('../../', import.meta.url));
const SHA = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 8 * 1024 * 1024;
const refusal = reason => ({ clear: false, reason, instruction: null });

/** IO: standard off, platform preference, then the explicit environment override. Invalid means off. */
export function resolveDelegableFinalApproval({ env = process.env, readFile = readFileSync } = {}) {
  let raw;
  try { raw = JSON.parse(readFile(PLATFORM_PREFERENCES_PATH, 'utf8'))?.review?.delegableFinalApproval; } catch { /* off */ }
  const override = env?.WE_REVIEW_DELEGABLE_FINAL_APPROVAL;
  const resolved = resolveCascade({
    standard: { enabled: false },
    platform: raw === undefined ? undefined : { enabled: raw === true },
    envValues: override === undefined ? {} : { enabled: ['on', 'true', '1'].includes(String(override).trim().toLowerCase()) },
  });
  return { enabled: resolved.value.enabled, source: resolved.sources.enabled };
}

/** PURE: an exact-head advisory and complete successful required checks delegate only non-human shapes. */
export function decideDelegableFinalApproval({ enabled, pr, shape, clearerId } = {}) {
  if (enabled !== true) return refusal('disabled');
  if (pr?.state !== 'OPEN') return refusal('not-open');
  if (!Array.isArray(pr.labels) || !hasReviewLabel(pr.labels, 'review:human')) return refusal('not-review-human');
  const head = pr.headRefOid;
  if (!SHA.test(head ?? '')) return refusal('unknown-head');
  if (typeof clearerId !== 'string' || !clearerId.trim()) return refusal('missing-clearer');
  const author = parseAuthorActorId(pr.body);
  if (!author) return refusal('missing-author');
  if (author === clearerId.trim()) return refusal('self-clear');
  if (!Array.isArray(pr.comments)) return refusal('unknown-comments');
  // Supply the setting explicitly so this pure decision never reads local settings.
  if (headEverHumanCleared(pr.comments, head, { mechanicalCarry: false })) return refusal('already-human-cleared');
  const advisory = latestAdvisory(trustedAdvisoryComments(pr.comments));
  if (advisory?.outcome !== 'accept' || advisory.head !== head) return refusal('acceptance-not-current');
  const labels = pr.labels.map(l => l?.name ?? l);
  if (!labels.includes('red-team:clear') || labels.some(l => ['red-team:pending', 'red-team:blocked'].includes(l))) return refusal('red-team-not-clear');
  const result = redTeamForHead(pr.comments, pr.number, head);
  if (!result || !isPublishableRedTeamResult(result)) return refusal('red-team-not-current');
  // Conservative built-in classes; recorded releases still apply. Every IO-bearing option is explicit.
  const red = readRedTeamDisposition({ comments: pr.comments, pr: pr.number, head, env: {},
    setting: { ...CONFIRMED_BREAKS_DEFAULTS, findingClasses: {} }, operatorRulings: { anyState: false }, sealed: null });
  if (red.sendBack.length || red.held.length) return refusal('red-team-unresolved');
  if (!Array.isArray(pr.requiredChecks) || !pr.requiredChecks.length
    || pr.requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return refusal('unknown-required-checks');
  if (!Array.isArray(pr.statusCheckRollup) || reduceCheckState(pr.statusCheckRollup, pr.requiredChecks).state !== 'green') return refusal('ci-not-green');
  if (shape?.humanRequired !== false) return refusal('human-required');
  return { clear: true, reason: 'eligible',
    instruction: `R612 standing delegation (operator 'Approved' 2026-11-05): head ${head} review-accepted, red-team clear, CI green, humanRequired=false` };
}

/** IO: score the real merge-base-to-head net diff, never the PR's summary file list. */
export function readDelegableApprovalShape({ repo, pr, exec = execFileSyncThrottled, score = scoreEscalation } = {}) {
  const cwd = repoProfile(repo)?.checkoutPath;
  if (!cwd || !SHA.test(pr?.headRefOid ?? '') || typeof pr?.baseRefName !== 'string' || !pr.baseRefName.trim()) throw Error('unknown diff basis; operator must review full diff');
  const git = args => {
    const output = exec('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 30_000 });
    if (typeof output !== 'string' || Buffer.byteLength(output) >= MAX_BUFFER) throw Error('diff bound exceeded; operator must review full diff');
    return output;
  };
  const base = git(['merge-base', `origin/${pr.baseRefName}`, pr.headRefOid]).trim();
  if (!SHA.test(base)) throw Error('unknown merge base; operator must review full diff');
  const changedFiles = git(['diff', '--name-only', '-z', '--no-renames', base, pr.headRefOid]).split('\0').filter(Boolean);
  if (!changedFiles.length || changedFiles.length > 1024) throw Error('file bound exceeded; operator must review full diff');
  const diffHunks = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, pr.headRefOid]);
  if (!diffHunks.trim()) throw Error('empty diff; operator must review full diff');
  return score({ changedFiles, diffHunks, deviation: parseDeviationDisclosure(pr.body) });
}

/** IO: serial, bounded, best effort. Inject readers and the writer for hermetic tests. */
export async function runDelegableFinalApprovalPass({ repos = [], readPrs,
  setting = resolveDelegableFinalApproval(), clearerId = currentActorId() || `review-daemon:${process.pid}`,
  readShape = readDelegableApprovalShape, exec = execFileSyncThrottled,
  readRequiredChecks = ({ repo, branch, exec: run }) => readRequiredStatusChecksDetailed({ repo, branch, gh: args => run('gh', args) }),
  readComments = ({ repo, pr, exec: run, fresh = false }) => !fresh && pr.commentsComplete === true ? pr.comments
    : readCompletePrComments(pr.number, { repo, gh: args => JSON.parse(run('gh', args)), maxPages: 3 }),
  readLiveHead = ({ repo, pr, exec: run }) => JSON.parse(run('gh', ['pr', 'view', String(pr.number), `--repo=${repo}`, '--json', 'headRefOid,baseRefName,state,labels,body,statusCheckRollup'])),
  readRedTeamHold = ({ repo, pr }) => {
    const red = readRedTeamDisposition({ repo, pr: pr.number, head: pr.headRefOid, comments: pr.comments });
    return Boolean(red.sendBack.length || red.held.length);
  },
  clear = ({ repo, pr, instruction, delegation, exec: run }) => run(process.execPath, [
    'scripts/review-set-label.mjs', String(pr.number), `--repo=${repo}`, '--to=clear-human', '--actor=review-daemon',
    `--reason=${instruction}`, `--expect-head=${pr.headRefOid}`, '--approval-kind=judge', `--delegation-json=${JSON.stringify(delegation)}`,
  ], { cwd: repoRoot(), env: { ...process.env, CLAUDE_CODE_SESSION_ID: clearerId } }),
  log = line => console.error(line), now = Date.now, maxCandidates = 20, maxGhCalls = 128,
} = {}) {
  log(`review-daemon: delegable-final-approval enabled=${setting.enabled} (${setting.source})`);
  if (setting.enabled !== true) return;
  let candidates = 0, ghCalls = 0;
  const run = (file, args, options = {}) => {
    if (file === 'gh' && ++ghCalls > maxGhCalls) throw Error('GitHub budget exceeded; operator must review remaining PRs');
    return exec(file, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 60_000, ...options });
  };
  const safe = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 400);
  const report = (number, status) => log(`review-daemon: delegable-final-approval PR#${safe(number)} ${safe(status)}`);
  for (const repo of repos) {
    let prs;
    try {
      prs = await readPrs({ repo, exec: run,
        readComments: number => readCompletePrComments(number, { repo, gh: args => JSON.parse(run('gh', args)), maxPages: 3 }),
      });
      if (!Array.isArray(prs)) throw Error('unreadable PRs; operator must inspect repository');
    } catch (e) { report('?', `skipped(${repo}: ${e?.message ?? e})`); continue; }
    const requiredByBranch = new Map();
    for (const row of prs) {
      if (!hasReviewLabel(row?.labels, 'review:human')) continue;
      try {
        if (++candidates > maxCandidates) { report(row.number, 'skipped(candidate-budget; operator must review remaining PRs)'); continue; }
        let pr = { ...row };
        if (!Number.isInteger(pr.number) || pr.number <= 0 || !SHA.test(pr.headRefOid ?? '')) { report(pr.number, 'skipped(unknown-pr-head)'); continue; }
        if (typeof pr.baseRefName !== 'string' || !pr.baseRefName.trim()) { report(pr.number, 'skipped(unknown-target)'); continue; }
        // Shared discovery lists OPEN PRs but may omit state. Prove it rather than assuming it.
        if (pr.state === undefined) {
          const live = await readLiveHead({ repo, pr, exec: run });
          if (live?.headRefOid !== pr.headRefOid) { report(pr.number, 'skipped(head-moved)'); continue; }
          if (typeof live.baseRefName !== 'string' || !live.baseRefName.trim()) { report(pr.number, 'skipped(unknown-target)'); continue; }
          if (live.baseRefName !== pr.baseRefName) { report(pr.number, 'skipped(target-moved)'); continue; }
          pr = { ...pr, state: live.state, labels: live.labels };
        }
        pr.comments = await readComments({ repo, pr, exec: run });
        const branch = pr.baseRefName;
        if (!requiredByBranch.has(branch)) {
          try { requiredByBranch.set(branch, await readRequiredChecks({ repo, branch, exec: run })); }
          catch { requiredByBranch.set(branch, null); }
        }
        pr.requiredChecks = requiredByBranch.get(branch)?.checks;
        const shape = await readShape({ repo, pr, exec: run });
        const decision = decideDelegableFinalApproval({ enabled: true, pr, shape, clearerId });
        if (!decision.clear) { report(pr.number, `skipped(${decision.reason})`); continue; }
        if (await readRedTeamHold({ repo, pr })) { report(pr.number, 'skipped(red-team-held)'); continue; }
        const delegation = { by: 'operator R612 (Approved 2026-11-05)', scope: `R612 ${repo}#${pr.number} head ${pr.headRefOid}; no new scope`,
          expires: new Date(now() + 60_000).toISOString() };
        // Rebuild EVERY eligibility input from fresh evidence; the writer pins the head across the remaining gap.
        const live = await readLiveHead({ repo, pr, exec: run });
        if (live?.headRefOid !== pr.headRefOid) { report(pr.number, 'skipped(head-moved)'); continue; }
        if (typeof live.baseRefName !== 'string' || !live.baseRefName.trim()) { report(pr.number, 'skipped(unknown-target)'); continue; }
        if (live.baseRefName !== pr.baseRefName) { report(pr.number, 'skipped(target-moved)'); continue; }
        const freshPr = { ...live, number: pr.number, comments: undefined, commentsComplete: false, requiredChecks: undefined };
        freshPr.comments = await readComments({ repo, pr: freshPr, exec: run, fresh: true });
        freshPr.requiredChecks = (await readRequiredChecks({ repo, branch: freshPr.baseRefName, exec: run }))?.checks;
        const freshShape = await readShape({ repo, pr: freshPr, exec: run });
        const final = decideDelegableFinalApproval({ enabled: true, pr: freshPr, shape: freshShape, clearerId });
        if (!final.clear) { report(pr.number, `skipped(${final.reason})`); continue; }
        if (await readRedTeamHold({ repo, pr: freshPr })) { report(pr.number, 'skipped(red-team-held)'); continue; }
        await clear({ repo, pr: freshPr, instruction: final.instruction, delegation, exec: run });
        report(pr.number, 'cleared');
      } catch (e) { report(row.number, `skipped(${e?.message ?? e}; operator must review full diff)`); }
    }
  }
}
