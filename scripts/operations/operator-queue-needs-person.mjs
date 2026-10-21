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

export function needsPersonRow(repo, pr) {
  const note = latestUnresolvedPersonNote(pr.comments);
  // A different outstanding question (e.g. round-cap-exhausted) is never masked by the withdrawn-draft row: only the
  // withdrawn-draft notice may be suppressed for a collecting card batch (operator-queue main, PR #5800).
  const otherQuestion = note && note.kind !== 'draft-withdrawn';
  if (!otherQuestion && (pr.state ?? 'OPEN') === 'OPEN' && pr.isDraft === true
      && pr.labels?.some(l => (typeof l === 'string' ? l : l?.name) === WITHDRAWN_LABEL)) {
    const command = `gh pr edit ${pr.number} --repo=${repo} --remove-label ${WITHDRAWN_LABEL}`;
    return { repo, number: pr.number, title: pr.title, kind: 'draft-withdrawn',
      noteAt: pr.updatedAt ?? null, headline: 'Withdrawn draft — explicit operator release required',
      detail: 'Release the withdrawal only when this PR should return to the guarded promotion and review path.',
      command, commands: { releaseDraft: command } };
  }
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
