/** Relay a clearing operator referral ruling into the existing stand-down answer ceremony. */
import { latestUnresolvedStandDown, latestOperatorAnswer, parseOperatorAnswer, buildOperatorAnswer } from './stand-down-answer-core.mjs';
import { standDownTrailerReason, standDownFindingRefs, standDownHead } from './stand-down.mjs';
import { sameRepo, readOperatorRulings, operatorRulingId, AUTO_POLICY_ACTOR } from '../lib/jury-core.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { openReferralFindings } from '../operations/record-referral-ruling.mjs';
import { decideSetLabel, presentRemoveLabels } from '../review-set-label.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

const labelNames = labels => (labels ?? []).map(l => typeof l === 'string' ? l : l.name);
const RELAY_CHANNEL = 'record-referral-ruling (relayed by the conveyor ruling-resolves-stand-down pass)';
const subjectKey = ({ runId, key }) => JSON.stringify([runId, key]);
// A missing history is unknown, never proof that review:changes was not re-added.
const changesLabelEvents = pr => Array.isArray(pr.labelEvents)
  ? pr.labelEvents.filter(e => ['labeled', 'unlabeled'].includes(e?.event) && e?.label?.name === 'review:changes') : null;

/** Queue and resolver share the gate's outstanding findings, even before any operator ruling. */
export function remainingStandDownFindings(pr, { repo }) {
  const findings = openReferralFindings({ comments: pr.comments, repo, pr: pr.number,
    head: pr.headRefOid, body: pr.body, createdAt: pr.createdAt });
  const listed = [...findings.open, ...findings.disputed];
  const remaining = listed.map(({ file, line, summary, state }) => ({ file: file ?? '', line, summary, state }));
  const listedKeys = new Set(listed.map(f => f.key));
  // Gate tokens without a location (malformed records, missing author, wrong subject, etc.) also hold.
  for (const [state, keys] of [['pending', findings.pending], ['blocked', findings.blocked]]) {
    for (const key of keys) if (!listedKeys.has(key)) remaining.push({ file: '', line: null, summary: key, state });
  }
  return remaining;
}

/** Pure; comments are oldest first. Only a later, subject-bound operator ruling can answer this hold. */
export function planRulingResolvedStandDown(pr, { repo }) {
  const { comments, headRefOid: head, number } = pr;
  const sd = latestUnresolvedStandDown(comments);
  if (!sd || standDownTrailerReason(sd.body) !== 'needs-judgment') return null;
  // The shared answer ceremony supersedes older holds too (newest wins). A ruling for this
  // question cannot authorize answering another unresolved question as a side effect.
  if (latestUnresolvedStandDown(comments.filter(c => c !== sd))) return null;
  const heldHead = standDownHead(sd.body);
  if (heldHead && !head?.toLowerCase().startsWith(heldHead.toLowerCase())) return null;
  const refs = standDownFindingRefs(sd.body);
  if (!refs) return null;
  const subjects = new Set(refs.map(subjectKey));
  const rulings = comments.slice(comments.indexOf(sd) + 1)
    .filter(c => !(c.createdAt && sd.createdAt) || Date.parse(c.createdAt) >= Date.parse(sd.createdAt))
    .flatMap(c => readOperatorRulings([c], { head }).rulings)
    .filter(r => r.head === head && sameRepo(r.repo, repo) && r.pr === Number(number)
      && r.actor?.toLowerCase() !== AUTO_POLICY_ACTOR && OPERATOR_LOGINS.includes(r.actor?.toLowerCase())
      && subjects.has(subjectKey(r)));
  const covered = new Set(rulings.map(subjectKey));
  if (!refs.every(ref => covered.has(subjectKey(ref)))) return null;
  const remaining = remainingStandDownFindings(pr, { repo });
  if (remaining.length) return { action: 'held', standDownId: sd.id, remaining };
  const currentLabels = pr.labels ?? [];
  const decision = labelNames(currentLabels).includes('review:changes') ? decideSetLabel({ to: 'rearm', currentLabels }) : null;
  const removeLabels = decision ? presentRemoveLabels(decision.removeLabels, currentLabels) : [];
  const addLabels = decision?.addLabel ? [decision.addLabel] : [];
  const rulingIds = [...new Set(rulings.map(operatorRulingId))];
  const actor = rulings.at(-1).actor;
  const reason = `The operator ruling(s) ${rulingIds.join(', ')} on head ${head} cover every finding this stand-down was waiting on; no finding is pending, blocked or disputed on this head; no fix is owed for them. The conveyor will re-arm review on this head by removing review:changes while keeping review:human.`;
  return { action: 'resolve', standDownId: sd.id, head, rulingIds, actor, removeLabels, addLabels,
    body: buildOperatorAnswer({ standDownId: String(sd.id), actor,
      channel: RELAY_CHANNEL, reason }) };
}

/** Recover only this pass's byte-exact answer when the subsequent label write failed. */
function planPendingRulingLabels(pr, { repo }) {
  if (!labelNames(pr.labels).includes('review:changes') || latestUnresolvedStandDown(pr.comments)) return null;
  const answer = latestOperatorAnswer(pr.comments);
  if (answer?.channel !== RELAY_CHANNEL) return null;
  const index = pr.comments.findLastIndex(c => {
    const parsed = parseOperatorAnswer(c);
    return parsed && JSON.stringify(parsed) === JSON.stringify(answer);
  });
  // Retry the interrupted write only, never undo a later review/comment on the same head.
  if (index !== pr.comments.length - 1) return null;
  const events = changesLabelEvents(pr), answerAt = Date.parse(pr.comments[index]?.createdAt);
  // GitHub timestamps have second precision; equality cannot establish safe ordering.
  if (!events || !Number.isFinite(answerAt) || events.some(e => {
    const at = Date.parse(e.created_at);
    return !Number.isFinite(at) || at >= answerAt;
  })) return null;
  const comments = pr.comments.slice(0, index);
  const plan = planRulingResolvedStandDown({ ...pr, comments }, { repo });
  return plan?.action === 'resolve' && plan.body === pr.comments[index]?.body ? { ...plan, answerPosted: true } : null;
}

const planPass = (pr, options) => planRulingResolvedStandDown(pr, options) ?? planPendingRulingLabels(pr, options);

/** IO shell. Post failures retain candidate labels; label failures recover from the durable answer. */
export async function runRulingResolvesStandDownPass({
  repo = CONSTELLATION_REPOS.we.slug, setting, settingSource,
  listPrs, readPr, editLabels, postComment, exec = execFileSyncThrottled, log = console.error,
} = {}) {
  const rows = [];
  const result = () => ({ rows, setting, settingSource });
  if (setting !== 'on') return result();
  const gh = args => exec('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  listPrs ??= () => JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,labels,headRefOid']));
  readPr ??= n => {
    // The complete, paged thread: a truncated one could hide a later stand-down or ruling.
    const comments = readCompletePrComments(n, { repo, exec });
    const pages = JSON.parse(gh(['api', `repos/${repo}/issues/${n}/events?per_page=100`, '--paginate', '--slurp']));
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('label event history was not returned');
    // Read the head last, including after posting an answer, immediately before the label write.
    const pr = JSON.parse(gh(['pr', 'view', String(n), '--repo', repo, '--json', 'number,headRefOid,labels,body,createdAt']));
    return { ...pr, comments, labelEvents: pages.flat() };
  };
  editLabels ??= (n, { removeLabels, addLabels }) => {
    if (!removeLabels.length && !addLabels.length) return;
    gh(['pr', 'edit', String(n), '--repo', repo,
      ...removeLabels.flatMap(l => ['--remove-label', l]), ...addLabels.flatMap(l => ['--add-label', l])]);
  };
  postComment ??= (n, body) => exec('gh',
    ['pr', 'comment', String(n), '--repo', repo, '--body-file', '-'], { encoding: 'utf8', input: body });
  let prs;
  try { prs = await listPrs(); }
  catch (e) { rows.push({ repo, pr: null, action: 'error', why: String(e?.message ?? e) }); return result(); }
  for (const candidate of prs) {
    if (!labelNames(candidate.labels).some(l => ['review:changes', 'status:stood-down', 'review-status:stood-down'].includes(l))) continue;
    const pr = candidate.number;
    let standDownId = null;
    try {
      let plan = planPass(await readPr(pr), { repo });
      if (!plan) continue;
      standDownId = plan.standDownId;
      if (plan.action === 'resolve') {
        const fresh = await readPr(pr);
        if (fresh.headRefOid !== plan.head) {
          rows.push({ repo, pr, action: 'head-moved', standDownId: plan.standDownId });
          continue;
        }
        const updated = planPass(fresh, { repo });
        if (!updated || updated.standDownId !== plan.standDownId) {
          rows.push({ repo, pr, action: 'state-changed', standDownId });
          continue;
        }
        plan = updated;
        if (plan.action === 'resolve') {
          const beforeEvents = changesLabelEvents(fresh);
          if (!beforeEvents) {
            rows.push({ repo, pr, action: 'state-changed', standDownId });
            continue;
          }
          const labelHistory = JSON.stringify(beforeEvents);
          if (!plan.answerPosted) await postComment(pr, plan.body);
          const beforeWrite = await readPr(pr);
          if (beforeWrite.headRefOid !== plan.head) {
            rows.push({ repo, pr, action: 'head-moved', standDownId });
            continue;
          }
          const writePlan = planPass(beforeWrite, { repo });
          if (!writePlan || writePlan.action !== 'resolve' || writePlan.standDownId !== standDownId
            || writePlan.body !== plan.body || JSON.stringify(changesLabelEvents(beforeWrite)) !== labelHistory) {
            rows.push({ repo, pr, action: 'state-changed', standDownId });
            continue;
          }
          plan = writePlan;
          await editLabels(pr, plan);
        }
      }
      rows.push({ repo, pr, ...plan });
      log(`ruling-resolves-stand-down: ${repo}#${pr} ${plan.action} stand-down=${plan.standDownId}`);
    } catch (e) {
      rows.push({ repo, pr, action: 'error', standDownId, why: String(e?.message ?? e) });
    }
  }
  return result();
}
