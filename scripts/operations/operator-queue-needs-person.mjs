/** Pure projection of outstanding trusted conveyor questions into operator queue rows. */
import { NOTE_COMMENT_MARKER } from '../conveyor/reconcile-note-comment.mjs';
import { isTrustedMarkerAuthor, isOperatorAuthored } from '../lib/marker-authorship.mjs';
import { isInfoNote } from '../lib/pr-comment-policy.mjs';

const noteKeyKind = (body) => String(body ?? '').match(/<!-- conveyor-note-key:\s*(.*?)\s*-->/)?.[1]?.split(':')[0] ?? null;

export function latestUnresolvedPersonNote(comments = []) {
  const ordered = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // An INFO-kind note (posted before INFO_NOTE_KINDS existed) asks nobody anything: it is never an open question,
  // and it never hides an earlier real one.
  const note = ordered.filter(c => isTrustedMarkerAuthor(c) && c.body?.startsWith(NOTE_COMMENT_MARKER) && !isInfoNote(noteKeyKind(c.body))).at(-1);
  if (!note || ordered.some(c => isOperatorAuthored(c) && Date.parse(c.createdAt) > Date.parse(note.createdAt))) return null;
  const lines = note.body.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean);
  const headline = lines.shift() ?? null;
  const detail = lines.find(line => !line.startsWith('<!--')) ?? null;
  const key = note.body.match(/<!-- conveyor-note-key:\s*(.*?)\s*-->/)?.[1] ?? null;
  return { createdAt: note.createdAt, headline, detail, key, kind: key?.split(':')[0] ?? null };
}

export function needsPersonRow(repo, pr) {
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
