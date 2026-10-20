/** Pure projection of outstanding trusted conveyor questions into operator queue rows. */
import { NOTE_COMMENT_MARKER } from '../conveyor/reconcile-note-comment.mjs';
import { isTrustedMarkerAuthor, isOperatorAuthored } from '../lib/marker-authorship.mjs';
import { WITHDRAWN_LABEL } from '../conveyor/draft-promotion-rule.mjs';

export function latestUnresolvedPersonNote(comments = []) {
  const ordered = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const note = ordered.filter(c => isTrustedMarkerAuthor(c) && c.body?.startsWith(NOTE_COMMENT_MARKER)).at(-1);
  if (!note || ordered.some(c => isOperatorAuthored(c) && Date.parse(c.createdAt) > Date.parse(note.createdAt))) return null;
  const lines = note.body.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean);
  const headline = lines.shift() ?? null;
  const detail = lines.find(line => !line.startsWith('<!--')) ?? null;
  const key = note.body.match(/<!-- conveyor-note-key:\s*(.*?)\s*-->/)?.[1] ?? null;
  return { createdAt: note.createdAt, headline, detail, key, kind: key?.split(':')[0] ?? null };
}

/**
 * @param {{cardBatchHold?: ((repo:string, number:number) => ReturnType<typeof import('./operator-queue-card-batch-holds.mjs').classifyCardBatchHold>|null)}} [opts]
 *   `cardBatchHold` looks up the card-batch seal job's hold on this PR (we:scripts/operations/operator-queue-card-batch-holds.mjs).
 *   `withdrawalEvidence(repo, pr)` returns why someone other than the seal job may have withdrawn the PR, or null.
 *   Only a hold the seal job owns AND a null evidence read returns a `parked: true` row (PARKED, never NEEDS YOU).
 */
export function needsPersonRow(repo, pr, { cardBatchHold, withdrawalEvidence } = {}) {
  if ((pr.state ?? 'OPEN') === 'OPEN' && pr.isDraft === true
      && pr.labels?.some(l => (typeof l === 'string' ? l : l?.name) === WITHDRAWN_LABEL)) {
    let hold = cardBatchHold?.(repo, pr.number) ?? null;
    // A head that moved off the batch head means someone other than the seal job is acting on this PR.
    if (hold?.status === 'owned' && pr.headRefOid && hold.headSha && pr.headRefOid !== hold.headSha) {
      hold = { ...hold, status: 'moved', reason: `the PR head ${pr.headRefOid.slice(0, 9)} is not the batch head ${hold.headSha.slice(0, 9)}` };
    }
    // Owned by the seal job is not enough: a fixer may have withdrawn the same PR. Park only when a clean read finds
    // no sign of that; no reader, a throwing reader, or any sign keeps the PR in NEEDS YOU.
    if (hold?.status === 'owned') {
      let evidence;
      try { evidence = withdrawalEvidence ? withdrawalEvidence(repo, pr) : 'no fixer-withdrawal check available'; }
      catch (error) { evidence = `fixer-withdrawal check failed: ${String(error?.message ?? error).split('\n')[0]}`; }
      if (evidence) hold = { ...hold, status: 'fixer-evidence', reason: evidence };
    }
    if (hold?.status === 'owned') {
      return { repo, number: pr.number, title: pr.title, kind: 'card-batch-held', parked: true,
        batchRef: hold.batchRef, members: hold.members, dueAt: hold.dueAt,
        headline: 'Card batch still collecting cards — the seal job releases this hold itself',
        detail: `${hold.members} card(s) in ${hold.batchRef ?? 'the batch'}; release expected by ${hold.dueAt}` };
    }
    const command = `gh pr edit ${pr.number} --repo=${repo} --remove-label ${WITHDRAWN_LABEL}`;
    return { repo, number: pr.number, title: pr.title, kind: 'draft-withdrawn',
      noteAt: pr.updatedAt ?? null, headline: hold ? `Card batch hold not released (${hold.status})`
        : 'Withdrawn draft — explicit operator release required',
      detail: hold ? `${hold.reason}. Fix the cause, then release the withdrawal only when this PR should return to the guarded promotion and review path.`
        : 'Release the withdrawal only when this PR should return to the guarded promotion and review path.',
      command, commands: { releaseDraft: command } };
  }
  const note = latestUnresolvedPersonNote(pr.comments);
  if (!note) return null;
  const { number, title } = pr;
  return {
    repo, number, title, noteAt: note.createdAt, headline: note.headline, detail: note.detail, kind: note.kind,
    commands: {
      extendRounds: `node scripts/operations/run.mjs extend-rounds --repo=${repo} --pr=${number} --by=1 --actor=<your login> --channel='<where you ruled>' --reason='<your words>'`,
      sendBack: `node scripts/review-set-label.mjs ${number} --repo=${repo} --to=changes --body-file=<fix-list.md> --actor=<your login> --channel='<where you ruled>'`,
      standDownAnswer: `node scripts/conveyor/stand-down-answer.mjs ${number} --repo=${repo} --actor=<your login> --channel='<where you ruled>' --reason='<your answer>'`,
      close: `gh pr close ${number} --repo=${repo} --comment='<why>'`,
    },
  };
}
