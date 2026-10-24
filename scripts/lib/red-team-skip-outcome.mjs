/** Settle skipped red teams: explicit policy produces a result; everything else needs an operator. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync } from 'node:fs';
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

/** Retry notification IO only; old failures must not prevent this job's settlement. */
function flushPending(io, note) {
  try {
    const base = redTeamStatusDir(io?.env ?? process.env);
    const pendingDir = join(base, 'skip-pending');
    if (!existsSync(pendingDir)) return;
    const records = readdirSync(pendingDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => ({ name, mtime: statSync(join(pendingDir, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    let newestMtime = records.reduce((latest, record) => Math.max(latest, record.mtime), Date.now());
    let attempted = 0, overflow = false;
    for (const { name } of records) {
      const pending = join(pendingDir, name), published = join(base, 'skip-published', name);
      try {
        if (existsSync(published)) { unlinkSync(pending); continue; }
        let item;
        try {
          item = JSON.parse(readFileSync(pending, 'utf8'));
          if (!item || typeof item.repo !== 'string' || !item.repo
            || !Number.isSafeInteger(Number(item.pr)) || Number(item.pr) <= 0
            || !/^(?:[a-f0-9]{40}|unknown)$/i.test(item.head ?? '')
            || item.kind !== `red-team-skip-${name.slice(0, 26)}`
            || typeof item.reason !== 'string' || !item.reason || typeof item.title !== 'string') {
            throw Error(`invalid pending red-team skip record ${name}`);
          }
        } catch (error) {
          // Poison evidence must never consume publication slots or be scanned again.
          renameSync(pending, `${pending}.bad`);
          note(`quarantined ${name}.bad: ${error.message}`);
          continue;
        }
        if (attempted >= 25) { overflow = true; continue; }
        attempted++;
        try {
          io.publishNeedsYou(item);
          mkdirSync(dirname(published), { recursive: true });
          writeJsonAtomic(published, item);
          unlinkSync(pending);
        } catch (error) {
          // A failed valid attempt uses its slot but goes behind untouched records.
          const retryAt = new Date(newestMtime = Math.max(Date.now(), newestMtime + 1));
          utimesSync(pending, retryAt, retryAt);
          throw error;
        }
      } catch (error) { note(error); }
    }
    if (overflow) {
      note('pending notification flush limit reached; remaining records retry on the next settlement');
    }
  } catch (error) { note(error); }
}

/** Synchronous IO, matching the review-job arc. Failures must never turn into a clear result. */
export function settleRedTeamSkip(input = {}) {
  let io;
  const note = error => {
    try { io?.log?.(`red-team skip settlement: ${String(error?.message ?? error).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 600)}`); }
    catch { /* diagnostics cannot abort settlement */ }
  };
  try {
    io = input.io;
    flushPending(io, note);
    const { redTeam, pr, repo, comments } = input;
    const realHead = /^[a-f0-9]{40}$/i.test(input.head ?? '');
    const head = realHead ? input.head : 'unknown';
    const classified = classifyRedTeamSkip(redTeam);
    let { reason } = classified;
    const boundRead = typeof input.readHead === 'string' && /^[a-f0-9]{40}$/i.test(input.readHead)
      && realHead && input.readHead.toLowerCase() === head.toLowerCase();
    if (classified.kind === 'policy' && !boundRead) {
      reason = 'policy skip head not bound to the reviewed read';
    } else if (classified.kind === 'policy') {
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
    const pending = join(redTeamStatusDir(io?.env ?? process.env), 'skip-pending', `${key}.json`);
    const item = { repo, pr, head, kind: `red-team-skip-${key.slice(0, 26)}`, reason: `red team skipped (${reason}); not cleared`, title: '' };
    mkdirSync(dirname(pending), { recursive: true });
    writeJsonAtomic(pending, item);
    io.publishNeedsYou(item);
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, item);
    unlinkSync(pending);
    return { outcome: 'non-policy', reason };
  } catch (error) {
    note(error);
    return { outcome: 'non-policy' };
  }
}
