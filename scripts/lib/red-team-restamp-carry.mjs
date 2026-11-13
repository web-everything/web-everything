import { execFileSyncThrottled } from './gh-throttle.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { contributionPatchId, resolveCarryAcrossRebase, buildVerdictCarriedMarker, parseVerdictCarriedMarker } from './rebase-verdict-carry.mjs';
import { parseRedTeamComment, RED_TEAM_COMMENT_MARKER, liveResultGateState, redTeamResultId, redTeamGateMarker, redTeamMarker } from './red-team-gate.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
import { createActionStore } from '../operations/action-store.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { commentCreatedAt } from '../conveyor/round-extension-mark.mjs';

/** Best effort: a failed carry leaves the successful restamp intact and the normal red-team run owed.
 * IO is injectable; patchId defaults to the shared whitespace-sensitive contribution comparator.
 */
export function carryRedTeamAcrossRestamp({ pr, repo, fromSha, toSha, comments,
  exec = execFileSyncThrottled, patchId = contributionPatchId, provider = createGhProvider(),
  readComments = ({ repo, pr }) => provider.readComments(repo, pr),
  postComment = ({ repo, pr, body }) => provider.postComment(repo, pr, body), post = postComment,
  actions, coordinationRoot,
  env = process.env, log = line => process.stderr.write(`${line}\n`),
} = {}) {
  const note = message => {
    try { log(`red-team restamp carry: ${String(message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 500)}`); } catch { /* logging cannot cost the restamp */ }
  };
  let owned;
  const transition = (to, patch) => {
    const r = owned;
    const changed = actions.transition(r.resource, r.attempt, {
      token: r.ownerToken, rev: r.rev, from: r.state, to, patch,
    });
    if (!changed.ok) throw Error(`carry claim transition refused (${changed.reason}); inspect the shared coordination record`);
    owned = changed.record;
  };
  try {
    const setting = resolveCarryAcrossRebase({ env });
    note(`carryAcrossRebase=${setting.value} (${setting.source})`);
    if (setting.value !== 'on') return;
    const select = thread => {
      if (!Array.isArray(thread)) throw Error('comments unreadable');
      let ts = 0;
      const records = thread.filter(isTrustedMarkerAuthor).map((c, i) => {
        const created = Date.parse(commentCreatedAt(c));
        if (Number.isFinite(created)) ts = created;
        const carried = parseVerdictCarriedMarker(c.body);
        const body = String(c.body ?? '').replace(/\r\n/g, '\n').trimStart();
        const advisoryBody = carried && body.includes(RED_TEAM_COMMENT_MARKER)
          ? body.slice(body.indexOf(RED_TEAM_COMMENT_MARKER)) : body;
        const advisory = parseRedTeamComment(advisoryBody);
        return { carried, advisoryBody, advisory, ts, i };
      });
      const resultFor = (record, sha) => record.advisory?.pr === Number(pr)
        && record.advisory.rev === sha && (!record.carried || record.carried.toSha === sha);
      if (records.some(r => (r.carried?.toSha === toSha) || resultFor(r, toSha))) return;
      const source = records.filter(r => resultFor(r, fromSha))
        .sort((a, b) => a.ts - b.ts || a.i - b.i).at(-1);
      if (!source) return;
      const { advisory } = source;
      const decided = liveResultGateState(thread, pr, fromSha);
      if (decided.resultId !== redTeamResultId(advisory)) {
        note('result ID/gate mismatch — no carry; normal red-team review remains owed');
        return;
      }
      if ((advisory.findings.length || advisory.shapedLines?.length) && !decided.outcomes.size) {
        note('findings without gate markers — no carry; normal red-team review remains owed');
        return;
      }
      return { advisoryBody: source.advisoryBody, decided };
    };
    if (!select(comments ?? readComments({ repo, pr }))) return;
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
    actions ??= createActionStore({ root: coordinationRoot ?? resolveCoordinationRoot({ env }) });
    const claim = actions.claim({ resource: `${repo}#item:red-team-restamp-carry-${pr}-${toSha}`,
      kind: 'red-team-restamp-carry', owner: `red-team-restamp-carry:${process.pid}` });
    if (!claim.ok) {
      note(`destination claim held (${claim.reason ?? 'held'}) — no carry`);
      return;
    }
    owned = claim.record;
    // Patch comparison can take time. Never publish from the earlier thread snapshot.
    const fresh = select(readComments({ repo, pr }));
    if (!fresh) return;
    const { advisoryBody, decided } = fresh;
    const gate = [...decided.outcomes].map(outcome => redTeamGateMarker(pr, toSha, outcome, decided.resultId));
    const body = [...gate, buildVerdictCarriedMarker({ fromSha, toSha, patchId: newPatchId }),
      'Review verdict carried across an identical contribution.',
      advisoryBody.replace(redTeamMarker(pr, fromSha), redTeamMarker(pr, toSha))].join('\n');
    transition('dispatching', { dispatchingSince: Date.now() });
    post({ repo, pr, body });
    transition('observed', { handle: toSha });
    syncRedTeamStatusLabels({ repo, pr, head: toSha, env, log: note, provider });
  } catch (error) {
    note(`unavailable (${error?.message ?? error}) — restamp retained; normal red-team reconciliation remains owed`);
  } finally {
    if (owned) {
      try { transition('terminal', { outcome: owned.state === 'observed' ? 'settled' : 'not-started' }); }
      catch (error) { note(`claim cleanup unavailable (${error?.message ?? error}) — inspect the shared coordination record`); }
    }
  }
}
