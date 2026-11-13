import { execFileSyncThrottled } from './gh-throttle.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { contributionPatchId, resolveCarryAcrossRebase, buildVerdictCarriedMarker } from './rebase-verdict-carry.mjs';
import { redTeamForHead, liveResultGateState, redTeamResultId, redTeamGateMarker, redTeamMarker } from './red-team-gate.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
import { commentCreatedAt } from '../conveyor/round-extension-mark.mjs';

/** Best effort: a failed carry leaves the successful restamp intact and the normal red-team run owed.
 * IO is injectable; patchId defaults to the shared whitespace-sensitive contribution comparator.
 */
export function carryRedTeamAcrossRestamp({ pr, repo, fromSha, toSha, comments,
  exec = execFileSyncThrottled, patchId = contributionPatchId, provider = createGhProvider(),
  readComments = ({ repo, pr }) => provider.readComments(repo, pr),
  postComment = ({ repo, pr, body }) => provider.postComment(repo, pr, body), post = postComment,
  env = process.env, log = line => process.stderr.write(`${line}\n`),
} = {}) {
  const note = message => {
    try { log(`red-team restamp carry: ${String(message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 500)}`); } catch { /* logging cannot cost the restamp */ }
  };
  try {
    const setting = resolveCarryAcrossRebase({ env });
    note(`carryAcrossRebase=${setting.value} (${setting.source})`);
    if (setting.value !== 'on') return;
    const thread = comments ?? readComments({ repo, pr });
    if (!Array.isArray(thread)) throw Error('comments unreadable');
    const advisory = redTeamForHead(thread, pr, fromSha);
    if (!advisory || redTeamForHead(thread, pr, toSha)) return;
    const oldPatchId = patchId({ exec, sha: fromSha });
    const newPatchId = patchId({ exec, sha: toSha });
    if (oldPatchId == null || newPatchId == null) {
      note('patch ID unreadable — no carry; normal red-team review remains owed');
      return;
    }
    if (oldPatchId !== newPatchId) {
      note('patch IDs differ — no carry; normal red-team review remains owed');
      return;
    }
    // Select the same newest trusted comment as redTeamForHead; retain its entire body, including break detail.
    const source = thread.map((c, i) => ({ c, i }))
      .filter(({ c }) => redTeamForHead([c], pr, fromSha))
      .sort((a, b) => (Date.parse(commentCreatedAt(a.c)) || 0) - (Date.parse(commentCreatedAt(b.c)) || 0) || a.i - b.i)
      .at(-1).c;
    const advisoryBody = String(typeof source === 'string' ? source : source.body).replace(/\r\n/g, '\n').trimStart();
    const decided = liveResultGateState(thread, pr, fromSha);
    const gate = decided.resultId === redTeamResultId(advisory)
      ? [...decided.outcomes].map(outcome => redTeamGateMarker(pr, toSha, outcome, decided.resultId)) : [];
    const body = [...gate, buildVerdictCarriedMarker({ fromSha, toSha, patchId: newPatchId }),
      'Review verdict carried across an identical contribution.',
      advisoryBody.replace(redTeamMarker(pr, fromSha), redTeamMarker(pr, toSha))].join('\n');
    post({ repo, pr, body });
    syncRedTeamStatusLabels({ repo, pr, head: toSha, env, log: note, provider });
  } catch (error) {
    note(`unavailable (${error?.message ?? error}) — restamp retained; normal red-team reconciliation remains owed`);
  }
}
