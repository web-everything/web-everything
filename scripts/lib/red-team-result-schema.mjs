/** Pure, bounded evidence reader. Refusals require operator review, never infer zero breaks. */
import { sealedBreakKeys, postedBreakKeys, redTeamResultCommentForHead } from './red-team-gate.mjs';

export const SEAL_SCHEMA = 3;
// Above these caps, leave pending for operator review of the full evidence.
const MAX_FINDINGS = 1000, MAX_COMMENTS = 1000, MAX_BYTES = 2_000_000, MAX_LINES = 2000;
const object = v => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const refuse = reason => ({ ok: false, reason: `${reason}; operator review required` });
const identity = v => object(v) && typeof v.repo === 'string' && v.repo.length > 0
  && Number.isSafeInteger(v.pr) && v.pr > 0 && typeof v.head === 'string' && /^[a-f0-9]{40}$/i.test(v.head);
const same = (a, b) => a.repo === b.repo && a.pr === b.pr && a.head === b.head;
const verdict = (v, count) => ['accept', 'changes', 'needs-human'].includes(v)
  && Number.isSafeInteger(count) && count >= 0 && (count > 0 || v === 'accept');

export function validateStoredFindings(findings) {
  if (!Array.isArray(findings) || findings.length > MAX_FINDINGS) return refuse('findings missing or over cap');
  let bytes = 0;
  try {
    for (const f of findings) {
      if (!object(f)) return refuse('finding is not a plain object');
      const flags = ['confirmedByRecheck', 'confirmed'].filter(k => Object.hasOwn(f, k));
      if (!flags.length || flags.some(k => typeof f[k] !== 'boolean')
        || (flags.length === 2 && f.confirmedByRecheck !== f.confirmed)) return refuse('confirmation flags unreadable');
      bytes += JSON.stringify(f).length;
      if (bytes > MAX_BYTES) return refuse('findings over size cap');
    }
    return { ok: true, breaks: sealedBreakKeys(findings) };
  } catch { return refuse('findings unreadable'); }
}

export function buildSeal({ repo, pr, head, result, findings, now } = {}) {
  if (!identity({ repo, pr, head }) || !object(result)) return refuse('seal identity or result unreadable');
  const checked = validateStoredFindings(findings);
  if (!checked.ok) return checked;
  if (!verdict(result.foldedVerdict, result.confirmedMissCount)
    || result.confirmedMissCount !== checked.breaks.length) return refuse('verdict and confirmed count disagree');
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) return refuse('seal time unreadable');
  return { ok: true, seal: { schema: SEAL_SCHEMA, repo, pr, head, breaks: checked.breaks,
    foldedVerdict: result.foldedVerdict, confirmedMissCount: result.confirmedMissCount, sealedAt: now } };
}

export function strictPostedResult({ comments, pr, head } = {}) {
  if (!Array.isArray(comments) || comments.length > MAX_COMMENTS) return refuse('comments missing or over cap');
  let bytes = 0;
  for (const c of comments) {
    if (!object(c) || typeof c.body !== 'string') return refuse('comment unreadable');
    bytes += c.body.length;
    if (bytes > MAX_BYTES || c.body.split('\n').length > MAX_LINES) return refuse('comments over size cap');
  }
  const hit = redTeamResultCommentForHead(comments, pr, head);
  if (!hit) return { ok: true, posted: false, keys: [] };
  if (hit.parsed.shapedLines?.length || !hit.parsed.completedReview) return refuse('posted result incomplete or malformed');
  return { ok: true, posted: true, keys: postedBreakKeys(hit.parsed) };
}

export function readRedTeamResult({ status, comments, pr, head, repo, disposition } = {}) {
  const pending = (reason, breaks = []) => ({ outcome: 'pending', reason: `${reason}; operator review required`, breaks });
  const key = { repo, pr, head };
  if (!identity(key) || !identity(status) || !same(status, key) || status.status !== 'finished') return pending('status identity or completion unreadable');
  let evidence = status.seal;
  if (evidence !== undefined) {
    if (!identity(evidence) || !same(evidence, key) || evidence.schema !== SEAL_SCHEMA
      || !Array.isArray(evidence.breaks) || evidence.breaks.length > MAX_FINDINGS
      || !evidence.breaks.every(k => typeof k === 'string' && k.length <= MAX_BYTES)
      || !verdict(evidence.foldedVerdict, evidence.confirmedMissCount)
      || evidence.confirmedMissCount !== evidence.breaks.length
      || typeof evidence.sealedAt !== 'string' || !Number.isFinite(Date.parse(evidence.sealedAt))) return pending('seal unreadable');
    if (status.result !== 'ran' && (!object(status.result) || status.result.status !== 'ran')) return pending('result unreadable');
  } else {
    if (!object(status.result) || status.result.status !== 'ran' || !['posted', 'deduped'].includes(status.result.comment)) return pending('no validated posted evidence');
    const built = buildSeal({ ...key, result: status.result, findings: status.result.findings, now: '2000-01-01T00:00:00.000Z' });
    if (!built.ok) return pending(built.reason);
    evidence = built.seal;
  }
  if (status.sealedBreaks !== undefined && (!Array.isArray(status.sealedBreaks)
    || JSON.stringify(status.sealedBreaks) !== JSON.stringify(evidence.breaks))) return pending('legacy seal contradicts evidence');
  if (object(status.result)) {
    const checked = buildSeal({ ...key, result: status.result, findings: status.result.findings, now: evidence.sealedAt });
    if (!checked.ok || checked.seal.foldedVerdict !== evidence.foldedVerdict
      || JSON.stringify(checked.seal.breaks) !== JSON.stringify(evidence.breaks)) return pending('result contradicts seal');
  }
  const posted = strictPostedResult({ comments, pr, head });
  if (!posted.ok) return pending(posted.reason, evidence.breaks);
  const breaks = [...new Set([...evidence.breaks, ...posted.keys])].sort();
  if (!object(disposition) || !Array.isArray(disposition.sendBack) || !Array.isArray(disposition.held)) return pending('disposition unreadable', breaks);
  if (disposition.sendBack.length || disposition.held.length) return { outcome: 'blocked', reason: 'shared disposition holds breaks', breaks };
  // Clear needs the result PUBLISHED on this head too: a sealed but unposted result is still pending.
  if (!posted.posted) return pending('no posted result on this head', breaks);
  const shown = new Set(posted.keys);
  if (breaks.length && (!disposition.result || !posted.posted || evidence.breaks.some(k => !shown.has(k)))) return pending('stored breaks not accounted for', breaks);
  return { outcome: 'clear', reason: 'validated evidence and disposition agree', breaks };
}
