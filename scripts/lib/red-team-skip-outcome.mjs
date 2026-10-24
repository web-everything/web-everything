/** Settle skipped red teams: explicit policy produces a result; everything else needs an operator. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { redTeamForHead, redTeamMarker } from './red-team-gate.mjs';

/** PURE. A reason string is never evidence of a policy exemption. */
export function classifyRedTeamSkip(redTeam) {
  const valid = redTeam != null && typeof redTeam === 'object' && !Array.isArray(redTeam);
  const reason = valid && typeof redTeam.reason === 'string' && redTeam.reason.trim()
    ? redTeam.reason : 'unknown red-team outcome';
  return { kind: valid && redTeam.status === 'skipped' && redTeam.policy === 'card-only'
    ? 'policy' : 'non-policy', reason };
}

/** Synchronous IO, matching the review-job arc. Failures must never turn into a clear result. */
export function settleRedTeamSkip(input = {}) {
  let io;
  const note = error => {
    try { io?.log?.(`red-team skip settlement: ${String(error?.message ?? error).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 600)}`); }
    catch { /* diagnostics cannot abort settlement */ }
  };
  try {
    const { redTeam, pr, repo, comments } = input;
    const realHead = /^[a-f0-9]{40}$/i.test(input.head ?? '');
    const head = realHead ? input.head : 'unknown';
    io = input.io;
    const classified = classifyRedTeamSkip(redTeam);
    let { reason } = classified;
    if (classified.kind === 'policy') {
      try {
        if (!Number.isSafeInteger(Number(pr)) || Number(pr) <= 0 || typeof repo !== 'string' || !repo
          || !/^[a-f0-9]{40}$/i.test(head ?? '')) throw Error('missing or invalid PR/head');
        const thread = comments ?? io.readComments({ repo, pr });
        if (!Array.isArray(thread)) throw Error('PR comments unreadable');
        if (redTeamForHead(thread, pr, head)) return { outcome: 'already' };
        io.postComment({ repo, pr, body: `${redTeamMarker(pr, head)}\n\nRed team not required on this head: card-only diff (policy redTeam.skipCardOnly)` });
        return { outcome: 'policy-clear' };
      } catch (error) {
        reason = `policy-clear comment failed: ${error?.message ?? error}`;
      }
    }
    const identity = [repo, pr, head, reason];
    if (!realHead) identity.push(input.runId || randomUUID());
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const path = join(redTeamStatusDir(io?.env ?? process.env), 'skip-published', `${key}.json`);
    if (existsSync(path)) return { outcome: 'non-policy', reason };
    io.publishNeedsYou({ repo, pr, head, kind: `red-team-skip-${key.slice(0, 8)}`, reason: `red team skipped (${reason}); not cleared`, title: '' });
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, { repo, pr, head, reason });
    return { outcome: 'non-policy', reason };
  } catch (error) {
    note(error);
    return { outcome: 'non-policy' };
  }
}
