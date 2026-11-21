/** Pure, mandatory admission check shared by every round-grant writer. */
import { judgeRound, validateVerdict } from './round-judge.mjs';

export const validNonconvergenceDesignPath = (path) => typeof path === 'string'
  && /^designs\/[A-Za-z0-9._-]*nonconvergence[A-Za-z0-9._-]*\.md(?![\s\S])/.test(path)
  && !path.includes('..');

const STOP = 'non-converging round extension refused: route to redesign (R88/R115/D-R451)';

/** despiteDesign.exists is regular-file evidence supplied by the IO reader, never a caller flag. */
export function assertRoundGrantAllowed({ repo, pr, comments, commentsTotal, files, headRefOid, despite, despiteDesign }) {
  if (!Array.isArray(comments)) throw new Error('round extension refused: unreadable comments history');
  if (commentsTotal !== undefined && commentsTotal !== comments.length) {
    throw new Error('round extension refused: incomplete comments history; operator must inspect the full thread and retry');
  }
  if (files !== undefined && (!Array.isArray(files) || Array.from(files).some(file => typeof file !== 'string'))) {
    throw new Error(STOP);
  }
  let judgement;
  try {
    judgement = judgeRound({ pr, repo, head: headRefOid ?? '', trigger: 'review-cap',
      comments, files: files ?? [], nonConverging: { enabled: true } });
  } catch { throw new Error(STOP); }
  if (judgement?.evidence?.failClosed || !validateVerdict(judgement).ok) throw new Error(STOP);
  const validDespite = typeof despite === 'string' && /^R\d{1,6}(?![\s\S])/.test(despite)
    && despiteDesign?.exists === true && validNonconvergenceDesignPath(despiteDesign.path);
  if (despite !== undefined && !validDespite) {
    throw new Error('--despite requires a ruling id and an existing designs/*nonconvergence*.md design');
  }
  if (judgement.verdict === 'non-converging' && !validDespite) throw new Error(STOP);
  return judgement;
}
