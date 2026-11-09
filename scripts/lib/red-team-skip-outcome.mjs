/** Settle skipped red teams: explicit policy produces a result; everything else needs an operator. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitizeForFeed } from '../operations/needs-you-feed.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { readRecoveryWitness, redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { VERDICTS } from './jury-core.mjs';
import { ADVISORY_OUTCOMES } from './advisory-labels.mjs';
import { advisoryLabelOutcome } from './review-advisory-outcome.mjs';
import { redTeamOwedFor } from './review-red-team-policy.mjs';
import { redTeamForHead, redTeamMarker } from './red-team-gate.mjs';
import { resumeRedTeamCarry } from './red-team-carry-machine.mjs';

/** Thrown values can have unreadable messages or unstringifiable JSON shapes. */
export function safeErrorText(error) {
  try { return String(error?.message ?? error); }
  catch { return 'unprintable error'; }
}

/** A pinned Git head must be a full SHA, never a coercible value or sentinel. */
export function isRealHead(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

const reasonPrefix = 'red team skipped (', reasonSuffix = '); not cleared';
const embeddedReason = item => item.reason.slice(reasonPrefix.length, -reasonSuffix.length);
const boundReason = reason => sanitizeForFeed(reason, 80);
const normalizeItem = item => ({ ...item,
  reason: `${reasonPrefix}${boundReason(embeddedReason(item))}${reasonSuffix}`,
  title: sanitizeForFeed(item.title, 200),
});
function itemKey(item) {
  const identity = [item.repo, item.pr, item.head, embeddedReason(item)];
  if (!isRealHead(item.head)) {
    if (typeof item.attemptId !== 'string' || !item.attemptId) throw Error('missing pending attempt identity');
    identity.push(item.attemptId);
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** PURE. A reason string is never evidence of a policy exemption. */
export function classifyRedTeamSkip(redTeam) {
  const valid = redTeam != null && typeof redTeam === 'object' && !Array.isArray(redTeam);
  const deferred = valid && Boolean(redTeam.deferredByGuard || redTeam.deferredByCap);
  // Settlement is reached only for an accepted head: a terminal not-owed contradicts that admission.
  const reason = valid && redTeam.status === 'not-owed' && !deferred
    ? 'red team reported not-owed on an accepted head'
    : valid && typeof redTeam.reason === 'string' && redTeam.reason.trim()
      ? redTeam.reason : 'unknown red-team outcome';
  return { kind: valid && redTeam.status === 'skipped' && redTeam.policy === 'card-only'
    && !deferred
    ? 'policy' : 'non-policy', reason };
}

const STORED_NOT_OWED_RULE = 'stored-review-not-owed';
const STORED_NOT_OWED_REASON = 'stored review does not owe a red team';

/**
 * R730 rule. Only the two not-owed skip reasons may settle, and only when the stored review record for this
 * exact head (read here, never parsed from a message) has a verdict and states no red team is owed.
 * Anything unreadable, missing, older-head or owed fails closed to the operator.
 */
function storedReviewOwesNoRedTeam(io, { repo, pr, head, redTeam }) {
  const deferred = Boolean(redTeam?.deferredByGuard || redTeam?.deferredByCap);
  const candidate = redTeam != null && typeof redTeam === 'object' && !Array.isArray(redTeam) && !deferred
    && (redTeam.status === 'not-owed'
      || (redTeam.status === 'skipped' && !redTeam.policy && redTeam.reason === STORED_NOT_OWED_REASON));
  if (!candidate) return false;
  try {
    const stored = io.readStoredReview
      ? io.readStoredReview({ repo, pr, head })
      : readRecoveryWitness({ repo, pr, head, env: io.env ?? process.env });
    const payload = stored?.ok === false ? null : stored?.newest;
    const verdict = payload?.verdict;
    return Boolean(verdict) && typeof verdict === 'object' && Object.values(VERDICTS).includes(verdict.verdict) && payload?.findings?.read?.netBasis?.rev === head
      && !redTeamOwedFor(payload)
      // A human-required needs-human verdict is only positively not-owed when its advisory lens says changes.
      && (verdict.verdict !== VERDICTS.NEEDS_HUMAN || verdict.humanRequired !== true
        || advisoryLabelOutcome({ read: payload.findings.read, verdict }) === ADVISORY_OUTCOMES.CHANGES);
  } catch { return false; }
}

/** Retry notification IO only; old failures must not prevent this job's settlement. */
function flushPending(io, note) {
  try {
    const base = redTeamStatusDir(io?.env ?? process.env);
    const pendingDir = join(base, 'skip-pending');
    if (!existsSync(pendingDir)) return;
    const quarantine = (pending, name, error) => {
      try { renameSync(pending, `${pending}.bad`); }
      catch { unlinkSync(pending); }
      note(`quarantined ${name}.bad (or removed): ${error.message}`);
    };
    const records = [];
    for (const name of readdirSync(pendingDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const pending = join(pendingDir, name);
      try {
        // Metadata reads can fail too (for example a dangling symlink); isolate each record.
        try { records.push({ name, mtime: statSync(pending).mtimeMs }); }
        catch (error) { quarantine(pending, name, error); }
      } catch (error) { note(error); }
    }
    records.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    let newestMtime = records.reduce((latest, record) => Math.max(latest, record.mtime), Date.now());
    let attempted = 0, overflow = false;
    for (const { name } of records) {
      const pending = join(pendingDir, name), published = join(base, 'skip-published', name);
      try {
        let item;
        try {
          item = JSON.parse(readFileSync(pending, 'utf8'));
          if (!item || typeof item.repo !== 'string' || !item.repo
            || !Number.isSafeInteger(Number(item.pr)) || Number(item.pr) <= 0
            || !(isRealHead(item.head) || item.head === 'unknown')
            || item.kind !== `red-team-skip-${name.slice(0, 26)}`
            || typeof item.reason !== 'string' || !item.reason.startsWith(reasonPrefix)
            || !item.reason.endsWith(reasonSuffix) || typeof item.title !== 'string') {
            throw Error(`invalid pending red-team skip record ${name}`);
          }
          item = normalizeItem(item);
          if (`${itemKey(item)}.json` !== name) throw Error('pending content key mismatch');
        } catch (error) {
          // Poison evidence must never consume publication slots or be scanned again.
          quarantine(pending, name, error);
          continue;
        }
        if (existsSync(published)) { unlinkSync(pending); continue; }
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
    try { io?.log?.(`red-team skip settlement: ${safeErrorText(error).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 600)}`); }
    catch { /* diagnostics cannot abort settlement */ }
  };
  try {
    io = input.io;
    flushPending(io, note);
    const { redTeam, pr, repo, comments } = input;
    const realHead = isRealHead(input.head);
    const head = realHead ? input.head : 'unknown';
    // Only recovery's acceptance/hold-checked stored-review path may settle not-owed.
    // Ordinary job settlement retains its contradictory-not-owed refusal.
    const storedClear = input.storedReviewPolicyClear === true && input.accepted === true
      && redTeam?.status === 'not-owed' && !redTeam.deferredByGuard && !redTeam.deferredByCap;
    let classified = storedClear ? { kind: 'policy', reason: 'not owed (stored review)' }
      : classifyRedTeamSkip(redTeam);
    let rule;
    // The carry machine only models a card-only skip, so a carry settlement never takes this rule: it would be
    // recorded as card-only with the rule unnamed. It keeps its existing refusal instead (fail closed).
    if (classified.kind !== 'policy' && !input.carry && realHead && isRealHead(input.readHead)
      && input.readHead.toLowerCase() === head.toLowerCase()
      && storedReviewOwesNoRedTeam(io, { repo, pr, head, redTeam })) {
      classified = { kind: 'policy', reason: 'not owed (stored review)' };
      rule = STORED_NOT_OWED_RULE;
    }
    let { reason } = classified;
    const boundRead = isRealHead(input.readHead)
      && realHead && input.readHead.toLowerCase() === head.toLowerCase();
    if (classified.kind === 'policy' && !boundRead) {
      reason = 'policy skip head not bound to the reviewed read';
    } else if (classified.kind === 'policy') {
      try {
        if (!Number.isSafeInteger(Number(pr)) || Number(pr) <= 0 || typeof repo !== 'string' || !repo
          || !isRealHead(head)) throw Error('missing or invalid PR/head');
        if (input.carry) {
          if (!io.carry) throw Error('carry IO missing; inspect recovery configuration before retrying');
          return resumeRedTeamCarry({ repo, pr, head, kind: 'card-only', loopPayload: input.carry.loopPayload }, io.carry);
        }
        const thread = comments ?? io.readComments({ repo, pr });
        if (!Array.isArray(thread)) throw Error('PR comments unreadable');
        if (redTeamForHead(thread, pr, head)) return { outcome: 'already' };
        io.postComment({ repo, pr, body: `${redTeamMarker(pr, head)}\n\nRed team not required on this head: ${rule ? `not owed (stored review; rule ${rule})` : storedClear ? 'not owed (stored review)' : 'card-only diff (policy redTeam.skipCardOnly)'}` });
        return { outcome: 'policy-clear', ...(rule ? { rule } : {}) };
      } catch (error) {
        reason = `policy-clear comment failed: ${safeErrorText(error)}`;
      }
    }
    reason = boundReason(reason);
    const item = normalizeItem({ repo, pr, head, reason: `${reasonPrefix}${reason}${reasonSuffix}`, title: '',
      ...(!realHead ? { attemptId: input.runId || randomUUID() } : {}) });
    const key = itemKey(item);
    item.kind = `red-team-skip-${key.slice(0, 26)}`;
    const path = join(redTeamStatusDir(io?.env ?? process.env), 'skip-published', `${key}.json`);
    if (existsSync(path)) return { outcome: 'non-policy', reason };
    const pending = join(redTeamStatusDir(io?.env ?? process.env), 'skip-pending', `${key}.json`);
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
