/** Relay a clearing operator referral ruling into the existing stand-down answer ceremony. */
import { latestUnresolvedStandDown, buildOperatorAnswer } from './stand-down-answer-core.mjs';
import { standDownTrailerReason } from './stand-down.mjs';
import { readOperatorRulings, operatorRulingId, AUTO_POLICY_ACTOR } from '../lib/jury-core.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { openReferralFindings } from '../operations/record-referral-ruling.mjs';
import { decideSetLabel, presentRemoveLabels } from '../review-set-label.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const labelNames = labels => (labels ?? []).map(l => typeof l === 'string' ? l : l.name);

/** Pure; comments are oldest first. Only a later, subject-bound operator ruling can answer this hold. */
export function planRulingResolvedStandDown(pr, { repo }) {
  const { comments, headRefOid: head, number, body, createdAt } = pr;
  const sd = latestUnresolvedStandDown(comments);
  if (!sd || standDownTrailerReason(sd.body) !== 'needs-judgment') return null;
  const rulings = comments.slice(comments.indexOf(sd) + 1)
    .filter(c => !(c.createdAt && sd.createdAt) || Date.parse(c.createdAt) >= Date.parse(sd.createdAt))
    .flatMap(c => readOperatorRulings([c], { head }).rulings)
    .filter(r => r.head === head && r.repo === repo && r.pr === Number(number)
      && r.actor?.toLowerCase() !== AUTO_POLICY_ACTOR && OPERATOR_LOGINS.includes(r.actor?.toLowerCase()));
  if (!rulings.length) return null;
  const findings = openReferralFindings({ comments, repo, pr: number, head, body, createdAt });
  const remaining = [...findings.open, ...findings.disputed]
    .map(({ file, line, summary, state }) => ({ file: file ?? '', line, summary, state }));
  // Malformed records can hold the gate without a location-bearing finding.
  for (const key of findings.pending) {
    if (['malformed-referral-record', 'malformed-operator-ruling', 'unavailable-reviewed-head'].includes(key)) {
      remaining.push({ file: '', line: null, summary: key, state: 'pending' });
    }
  }
  if (remaining.length) return { action: 'held', standDownId: sd.id, remaining };
  const currentLabels = pr.labels ?? [];
  const decision = labelNames(currentLabels).includes('review:changes') ? decideSetLabel({ to: 'rearm', currentLabels }) : null;
  const removeLabels = decision ? presentRemoveLabels(decision.removeLabels, currentLabels) : [];
  const addLabels = decision?.addLabel ? [decision.addLabel] : [];
  const rulingIds = [...new Set(rulings.map(operatorRulingId))];
  const actor = rulings.at(-1).actor;
  const reason = `The operator ruling(s) ${rulingIds.join(', ')} on head ${head} cover every finding this stand-down was waiting on; no finding is pending, blocked or disputed on this head; no fix is owed for them; review is re-armed on this head (review:changes removed, review:human kept).`;
  return { action: 'resolve', standDownId: sd.id, head, rulingIds, actor, removeLabels, addLabels,
    body: buildOperatorAnswer({ standDownId: String(sd.id), actor,
      channel: 'record-referral-ruling (relayed by the conveyor ruling-resolves-stand-down pass)', reason }) };
}

/** IO shell. A failed comment post leaves a retryable label-only re-arm. */
export async function runRulingResolvesStandDownPass({
  repo = CONSTELLATION_REPOS.we.slug, setting, settingSource,
  listPrs, readPr, editLabels, postComment, log = console.error,
} = {}) {
  const rows = [];
  const result = () => ({ rows, setting, settingSource });
  if (setting !== 'on') return result();
  const gh = args => execFileSyncThrottled('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  listPrs ??= () => JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,labels,headRefOid']));
  readPr ??= n => {
    const pr = JSON.parse(gh(['pr', 'view', String(n), '--repo', repo, '--json', 'number,headRefOid,labels,body,createdAt']));
    // The complete, paged thread: a truncated one could hide a later stand-down or ruling.
    return { ...pr, comments: readCompletePrComments(n, { repo, exec: execFileSyncThrottled }) };
  };
  editLabels ??= (n, { removeLabels, addLabels }) => {
    if (!removeLabels.length && !addLabels.length) return;
    gh(['pr', 'edit', String(n), '--repo', repo,
      ...removeLabels.flatMap(l => ['--remove-label', l]), ...addLabels.flatMap(l => ['--add-label', l])]);
  };
  postComment ??= (n, body) => execFileSyncThrottled('gh',
    ['pr', 'comment', String(n), '--repo', repo, '--body-file', '-'], { encoding: 'utf8', input: body });
  let prs;
  try { prs = await listPrs(); }
  catch (e) { rows.push({ repo, pr: null, action: 'error', why: String(e?.message ?? e) }); return result(); }
  for (const candidate of prs) {
    if (!labelNames(candidate.labels).some(l => ['review:changes', 'status:stood-down', 'review-status:stood-down'].includes(l))) continue;
    const pr = candidate.number;
    let standDownId = null;
    try {
      const plan = planRulingResolvedStandDown(await readPr(pr), { repo });
      if (!plan) continue;
      standDownId = plan.standDownId;
      if (plan.action === 'resolve') {
        const fresh = await readPr(pr);
        if (fresh.headRefOid !== plan.head) {
          rows.push({ repo, pr, action: 'head-moved', standDownId: plan.standDownId });
          continue;
        }
        await editLabels(pr, plan);
        await postComment(pr, plan.body);
      }
      rows.push({ repo, pr, ...plan });
      log(`ruling-resolves-stand-down: ${repo}#${pr} ${plan.action} stand-down=${plan.standDownId}`);
    } catch (e) {
      rows.push({ repo, pr, action: 'error', standDownId, why: String(e?.message ?? e) });
    }
  }
  return result();
}
