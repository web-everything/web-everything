/** @file R1047: raw-byte, sequence-ordered, one-sided audit evidence. */
import * as realFs from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Line } from './audit-ledger-chain.mjs';
import { carriesAcross } from './net-diff-fingerprint.mjs';
import { QUESTION_HASH, legacyFindAudit, isAcceptedQuestionHash, resolvePriorQuestionHashes } from '../operations/codex-audit.mjs';
import { legacyCanonicalAuditEvidence } from '../operations/prototype-load.mjs';
const lower = v => typeof v === 'string' ? v.toLowerCase() : v;
const validSha = v => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
const chained = r => Number.isSafeInteger(r?.seq) && typeof r.id === 'string' && (typeof r.prev === 'string' || r.kind === 'genesis');
const fail = reason => ({ ok: false, reason });

/** Arrays are compatibility inputs only; file readers MUST supply raw bytes. */
export function evaluateAudit(ledgerText, options = {}) {
  const { head, base, liveFp: suppliedFp, covers = () => true, hwm, hwmPresent = hwm !== undefined,
    now = Date.now(), priorQuestionHashes = resolvePriorQuestionHashes(), questionHash = QUESTION_HASH, lookup = false } = options;
  const raw = Buffer.from(Array.isArray(ledgerText) ? ledgerText.map(r => JSON.stringify(r)).join('\n') : ledgerText);
  const lines = [];
  for (let start = 0, end = 0; end <= raw.length; end++) {
    if (end !== raw.length && raw[end] !== 10) continue;
    const bytes = raw.subarray(start, end);
    if (bytes.toString().trim()) {
      let record; try { record = JSON.parse(bytes.toString('utf8')); } catch { record = null; }
      lines.push({ record, bytes, start, index: lines.length });
    }
    start = end + 1;
  }
  const liveFp = suppliedFp;
  const genesis = lines.findLastIndex(e => e.record?.kind === 'genesis');
  if (genesis < 0 && !hwmPresent) {
    const records = Array.isArray(ledgerText) ? ledgerText : lines.map(e => e.record).filter(Boolean);
    return lookup ? { record: legacyFindAudit(records, { ...options, priorQuestionHashes, now }) }
      : legacyCanonicalAuditEvidence(records, head, covers, liveFp, Object.fromEntries(['ruledWeakened', 'now', 'priorQuestionHashes'].filter(k => k in options).map(k => [k, options[k]])));
  }
  if (genesis < 0) return fail('chain-break');
  const g = lines[genesis];
  let broken = !chained(g.record) || g.record.seq !== 0 || sha256Line(raw.subarray(0, g.start)) !== g.record.legacyDigest;
  let last = g;
  const ids = new Set([g.record.id]);
  g.trusted = !broken;
  for (const e of lines.slice(genesis + 1)) {
    const r = e.record;
    if (!chained(r)) continue;
    const replay = ids.has(r.id); ids.add(r.id);
    if (replay || r.seq !== last.record.seq + 1 || r.prev !== sha256Line(last.bytes)) broken = true;
    e.trusted = !broken;
    if (e.trusted) last = e;
  }
  if (broken || !g.trusted || !hwmPresent || hwmPresent && (!Number.isSafeInteger(hwm?.seq) || hwm.seq > last.record.seq
    || !lines.some(e => e.trusted && e.record.seq === hwm.seq && sha256Line(e.bytes) === hwm.lineHash))) return fail('chain-break');
  if (lines.some(e => !e.record || typeof e.record !== 'object')) return fail('weakened');
  const coverMemo = new Map();
  const covered = b => {
    if (!coverMemo.has(b)) { try { coverMemo.set(b, !!covers(b)); } catch { coverMemo.set(b, false); } }
    return coverMemo.get(b);
  };
  const entries = lines.filter(e => e.record.kind !== 'genesis').map(e => {
    const r = e.record, legacy = e.index < genesis;
    let fp = r.fingerprint;
    if (!carriesAcross(fp, fp)) { try { fp = options.resolveFingerprint?.(r.base, r.head); } catch { fp = null; } }
    const accepted = r.verdict === 'WEAKENED' && r.questionHash == null || r.questionHash === questionHash || isAcceptedQuestionHash(r.questionHash, {
      priorQuestionHashes, now, at: typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r.at : undefined });
    return { ...e, r, legacy, fp, accepted, order: legacy ? e.index - genesis : r.seq,
      trusted: legacy || !!e.trusted };
  });
  const related = e => lower(e.r.head) === lower(head) || carriesAcross(e.fp, liveFp);
  const passes = entries.filter(e => e.accepted && e.trusted && validSha(e.r.head) && validSha(e.r.base)
    && e.r.base !== e.r.head && e.r.verdict === 'NOT WEAKENED' && carriesAcross(e.fp, e.fp)
    && typeof e.r.at === 'string' && Number.isFinite(Date.parse(e.r.at)) && Date.parse(e.r.at) <= now + 300000
    && legacyFindAudit([e.r], { head: e.r.head, base: e.r.base, questionHash: QUESTION_HASH, priorQuestionHashes, now }) === e.r);
  const gate = options.ruledWeakened;
  const waivers = options.waivers ?? (gate?.ruledWeakened ? [{ ...gate.ruledWeakened, sha: gate.record.sha, fingerprint: gate.record.fingerprint }] : []);
  const waived = e => e.trusted && waivers.some(w => (e.legacy ? !w.auditId || w.auditId === e.r.id : w.auditId === e.r.id)
    && validSha(w.sha) && (lower(w.sha) === lower(head) && related(e) || lower(w.sha) === lower(e.r.head) && related(e)
      || carriesAcross(w.fingerprint, liveFp) && carriesAcross(e.fp, liveFp))
    && Array.isArray(e.r.findings) && JSON.stringify(w.findings) === JSON.stringify(e.r.findings) && covered(e.r.base));
  for (const e of entries.filter(e => e.accepted && e.r.verdict === 'WEAKENED')) {
    const own = lower(e.r.head) === lower(head);
    const unknown = !e.legacy && !carriesAcross(e.fp, e.fp) || !carriesAcross(liveFp, liveFp) && (!e.legacy || carriesAcross(e.fp, e.fp));
    if (!own && !related(e) && !unknown) continue;
    const cleared = e.trusted && passes.some(p => p.order > e.order && (p.legacy && e.legacy || p.r.id !== e.r.id)
      && (p.r.questionHash === e.r.questionHash || p.r.questionHash === questionHash)
      && (own ? lower(p.r.head) === lower(head) && lower(p.r.base) === lower(e.r.base) : related(p) && covered(p.r.base)));
    if (!cleared && !waived(e)) return { ...fail('weakened'), ...(lookup ? { record: e.r } : {}) };
  }
  const authorized = entries.filter(e => e.r.verdict === 'WEAKENED' && validSha(e.r.head) && validSha(e.r.base)
    && e.r.base !== e.r.head && carriesAcross(e.fp, e.fp) && waived(e));
  const pass = [...passes, ...authorized].filter(e => related(e) && e.r.questionHash === questionHash
    && (base === undefined || lower(e.r.base) === lower(base)) && covered(e.r.base)).sort((a, b) => b.order - a.order)[0];
  return pass ? { ok: true, record: pass.r } : fail(broken ? 'chain-break' : 'no-record');
}

/** Single raw-file adapter; unreadable ledger/sidecar is never positive evidence. */
export function evaluateAuditFile({ ledgerPath, fs = realFs, ...options }) {
  try {
    const raw = fs.readFileSync(ledgerPath);
    let hwm, hwmPresent = true;
    try {
      const text = String(fs.readFileSync(join(dirname(ledgerPath), 'audits.hwm.json'), 'utf8'));
      if (text.trim()) hwm = JSON.parse(text); else hwmPresent = false;
    } catch (error) { if (error.code !== 'ENOENT') return fail('chain-break'); hwmPresent = false; }
    return evaluateAudit(raw, { ...options, hwm, hwmPresent });
  } catch { return fail('no-record'); }
}
