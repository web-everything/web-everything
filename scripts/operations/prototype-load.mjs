/**
 * @file Declared prototype admission and pure evidence decisions.
 * WHY (incident 2026-10-22): combined tops repeated tests, reverted main fixes three times,
 * and removed registrations before replacement admission. Keep comparisons explicit and swaps ordered.
 */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { QUESTION_HASH, findAudit } from './codex-audit.mjs';
import { carriesAcross } from '../lib/net-diff-fingerprint.mjs';
export const PROTOTYPE_LOAD_OP = 'prototype-load';
export const PROTOTYPE_LOAD_EFFECT = 'prototype-load.apply';
export const safeRegistrationRef = (ref) => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
  && !/\.\.|\/\/|\/\.|@\{|\.$|\/$|\.lock(?:\/|$)/.test(ref);
export const safeRef = (ref) => safeRegistrationRef(ref) && ref.startsWith('lane/');
export const validSha = (sha) => /^[a-f0-9]{40}$/i.test(sha || '');
export function jsonLines(text) {
  return String(text).split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
/** A WEAKENED fix-ready record loads ONLY as a ruled exception (operator R396): the record must carry
 *  `auditRuling` and a non-empty `auditDisclosed`, AND the settings allowlist `ruledWeakened` must hold an entry whose
 *  ref, full 40-hex sha and ruling match the record exactly. Anything else stays refused; a `--audit` argument can
 *  never claim it. Never a blanket bypass. */
const RULING = /^R\d+(?:\+R\d+)*$/;
export function readyEvidence(records, input, ruledWeakened = [], liveFp = null) {
  if (input.testsRun?.trim() && /^NOT WEAKENED$/i.test(input.audit || '')) return { source: 'arguments', testsRun: input.testsRun };
  // R503: a record speaks for the live sha when it names it exactly, or its stored net-diff fingerprint equals the live one.
  // A rebase or merge of main that leaves the code alone therefore keeps the evidence; any code change does not.
  const covers = (r) => r?.ref === input.branch && (r.sha === input.sha || carriesAcross(r.fingerprint, liveFp));
  const record = records.find((r) => covers(r) && r.tests === 'green' && /^NOT WEAKENED$/i.test(r.audit || ''));
  if (record) return { source: 'ready-record', record };
  // The allowlist entry binds to the record by its exact sha, or (carry) by holding the live fingerprint itself.
  const binds = (e, r) => e.sha === r.sha && r.sha === input.sha || carriesAcross(e.fingerprint, liveFp) && carriesAcross(r.fingerprint, liveFp);
  const ruled = records.find((r) => covers(r) && r.tests === 'green' && r.audit === 'WEAKENED'
    && validSha(r.sha) && RULING.test(r.auditRuling || '')
    && Array.isArray(r.auditDisclosed) && r.auditDisclosed.length > 0 && r.auditDisclosed.every((f) => typeof f === 'string' && f.trim())
    && Array.isArray(ruledWeakened) && ruledWeakened.some((e) => e && e.ref === r.ref && binds(e, r) && e.ruling === r.auditRuling
      && Array.isArray(e.findings) && e.findings.length > 0 && e.findings.every((f) => typeof f === 'string' && f.trim())
      && e.findings.length === r.auditDisclosed.length && e.findings.every((f, i) => f === r.auditDisclosed[i])));
  return ruled ? { source: 'ready-record', record: ruled, ruledWeakened: { ruling: ruled.auditRuling, findings: ruled.auditDisclosed } } : null;
}
/** Canonical audit for this head. Each non-empty base (base!==head) is judged by findAudit (latest wins within a
 * base, file order breaks ties, contradictory findings rejected). Fail closed: ANY base whose latest verdict is
 * WEAKENED blocks, and a pass only counts when covers(base) proves the base is already in main (the audit spans the
 * whole change, not just its last commit). */
export function canonicalAuditEvidence(records, sha, covers = () => true, liveFp = null) {
  // R503: an audit of an older head also speaks for this head when its stored net-diff fingerprint equals the live one.
  // No stored or live fingerprint, or any difference, means no carry (a real code change always re-audits).
  // Eligibility is per RECORD: each carried record must itself hold the matching fingerprint, so one carried record
  // can never lend its head's other (unfingerprinted or foreign) records.
  const eligible = records.filter((r) => r?.head === sha || (r?.head && validSha(r.head) && carriesAcross(r.fingerprint, liveFp)));
  const heads = new Set(eligible.map((r) => r.head));
  // Fail closed the other way too: a valid WEAKENED verdict anywhere on a carried head blocks, fingerprint or not.
  for (const r of records) if (r?.head && r.head !== sha && heads.has(r.head) && r.verdict === 'WEAKENED'
    && r.questionHash === QUESTION_HASH && Number.isFinite(Date.parse(r.at))) return { ok: false, reason: 'weakened' };
  let pass = null;
  for (const head of heads) {
    const bases = new Set(eligible.filter((r) => r.head === head && r.base !== head).map((r) => r.base));
    for (const base of bases) {
      const record = findAudit(eligible, { head, base, questionHash: QUESTION_HASH });
      if (record?.verdict === 'WEAKENED') return { ok: false, reason: 'weakened' };
      if (record && covers(base) && (!pass || Date.parse(record.at) >= Date.parse(pass.at))) pass = record;
    }
  }
  return pass ? { ok: true, record: pass } : { ok: false, reason: 'no-record' };
}
/** Include BOTH sides of renames/copies; NUL output preserves whitespace and quoted paths. */
export function changedPaths(text) {
  const fields = String(text).split('\0');
  const paths = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++];
    if (!/^[ACDMRTUXB][0-9]*$/.test(status) || !fields[i]) throw new Error('unreadable name-status diff');
    paths.push(fields[i++]);
    if (/^[RC]/.test(status)) { if (!fields[i]) throw new Error('incomplete rename'); paths.push(fields[i++]); }
  }
  return [...new Set(paths)].sort();
}
export function comparePaths(own, effective) {
  return { outside: effective.filter((p) => !own.includes(p)), missing: own.filter((p) => !effective.includes(p)) };
}
export function nextMergeRef(branch, remote) {
  const prefix = `refs/heads/${branch}-m`;
  const numbers = String(remote).split(/\r?\n/).map((line) => line.split(/\s+/)[1])
    .filter((ref) => ref?.startsWith(prefix)).map((ref) => ref.slice(prefix.length)).filter((s) => /^\d+$/.test(s)).map(BigInt);
  return `${branch}-m${numbers.reduce((max, n) => n > max ? n : max, 0n) + 1n}`;
}
export function refusal(records, ref, since, alerts = false) {
  return records.find((r) => r && Date.parse(r.at) >= since && (r.ref === ref || (alerts && JSON.stringify(r).includes(ref)))
    && (alerts ? /reject|drop|refus|conflict/i.test(JSON.stringify(r)) : /removed|dropped/.test(r.kind || r.event || r.type || '')));
}
export function prototypeLoadOperation() {
  const input = Object.fromEntries(['branch', 'sha', 'daemon', 'why', 'tests-run', 'audit', 'replace', 'wait-adoption-ms'].map((key) => [key, { type: 'string', required: false, default: '' }]));
  input['dry-run'] = { type: 'boolean', required: false, default: false };
  // R310: retire-only run — drop registrations proved merged, in main, or superseded, and load nothing.
  input.retire = { type: 'boolean', required: false, default: false };
  return op(PROTOTYPE_LOAD_OP, {
    input, verdictFrom: 'assess',
    load: effect({ reads: Object.keys(input).map((key) => `input.${key}`),
      effects: ({ input: values }) => [{ type: PROTOTYPE_LOAD_EFFECT,
        payload: { ...values, testsRun: values['tests-run'], dryRun: values['dry-run'], waitAdoptionMs: values['wait-adoption-ms'] }, idempotent: false }] }),
    assess: compute({ reads: ['findings.load'], fn: ({ findings }) => {
      const entry = findings.load?.effects?.[0];
      if (entry?.status !== 'applied' || !entry.result) throw new Error('prototype-load: transaction did not complete');
      return entry.result;
    } }),
  });
}
