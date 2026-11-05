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
export function readyEvidence(records, input, ruledWeakened = []) {
  if (input.testsRun?.trim() && /^NOT WEAKENED$/i.test(input.audit || '')) return { source: 'arguments', testsRun: input.testsRun };
  const record = records.find((r) => r?.ref === input.branch && r.sha === input.sha && r.tests === 'green' && /^NOT WEAKENED$/i.test(r.audit || ''));
  if (record) return { source: 'ready-record', record };
  const ruled = records.find((r) => r?.ref === input.branch && r.sha === input.sha && r.tests === 'green' && r.audit === 'WEAKENED'
    && validSha(r.sha) && RULING.test(r.auditRuling || '')
    && Array.isArray(r.auditDisclosed) && r.auditDisclosed.length > 0 && r.auditDisclosed.every((f) => typeof f === 'string' && f.trim())
    && Array.isArray(ruledWeakened) && ruledWeakened.some((e) => e && e.ref === r.ref && e.sha === r.sha && e.ruling === r.auditRuling
      && Array.isArray(e.findings) && e.findings.length > 0 && e.findings.every((f) => typeof f === 'string' && f.trim())
      && e.findings.length === r.auditDisclosed.length && e.findings.every((f, i) => f === r.auditDisclosed[i])));
  return ruled ? { source: 'ready-record', record: ruled, ruledWeakened: { ruling: ruled.auditRuling, findings: ruled.auditDisclosed } } : null;
}
/** Canonical audit for this head. Each non-empty base (base!==head) is judged by findAudit (latest wins within a
 * base, file order breaks ties, contradictory findings rejected). Fail closed: ANY base whose latest verdict is
 * WEAKENED blocks, and a pass only counts when covers(base) proves the base is already in main (the audit spans the
 * whole change, not just its last commit). */
export function canonicalAuditEvidence(records, sha, covers = () => true, liveFp = null, auditOptions = {}) {
  // R503: an audit of an older head also speaks for this head when its stored net-diff fingerprint equals the live one.
  // No stored or live fingerprint, or any difference, means no carry (a real code change always re-audits).
  // Eligibility is per RECORD: each carried record must itself hold the matching fingerprint, so one carried record
  // can never lend its head's other (unfingerprinted or foreign) records.
  const eligible = records.filter((r) => r?.head === sha || (r?.head && validSha(r.head) && carriesAcross(r.fingerprint, liveFp)));
  const heads = new Set(eligible.map((r) => r.head));
  // Fail closed the other way too: the latest VALID WEAKENED verdict for any base of a carried head blocks, fingerprint or not.
  // "Valid" is findAudit's own judgment (latest wins per base, contradictory-findings and malformed records rejected,
  // empty-diff base===head never consulted), so the veto can never honor a record the audit reader itself refuses.
  // Only string heads/bases are keyed: a non-string (an array that stringifies to a real sha) must never alias, and so
  // displace, the veto of the string base it imitates.
  const vetoBases = new Map();
  for (const r of records) if (typeof r?.head === 'string' && typeof r.base === 'string' && r.head !== sha && heads.has(r.head) && r.base !== r.head) vetoBases.set(JSON.stringify([r.head, r.base]), r);
  for (const { head, base } of vetoBases.values()) {
    if (findAudit(records, { head, base, questionHash: QUESTION_HASH })?.verdict === 'WEAKENED') return { ok: false, reason: 'weakened' };
  }
  let pass = null;
  for (const head of heads) {
    const bases = new Set(eligible.filter((r) => r.head === head && r.base !== head).map((r) => r.base));
    for (const base of bases) {
      const record = findAudit(eligible, { head, base, questionHash: QUESTION_HASH, ...auditOptions });
      if (record?.verdict === 'WEAKENED') return { ok: false, reason: 'weakened' };
      // A current-question record for this head+base (usable or not) blocks a PRIOR-question pass, even when carry
      // eligibility dropped it from `eligible` (no or differing fingerprint): judge against ALL records, fail closed.
      if (record && record.questionHash !== QUESTION_HASH
        && records.some(r => r?.head === head && r.base === base && r.questionHash === QUESTION_HASH)) continue;
      if (record && covers(base) && (!pass || Date.parse(record.at) >= Date.parse(pass.at))) pass = record;
    }
  }
  return pass ? { ok: true, record: pass } : { ok: false, reason: 'no-record' };
}
/** Include BOTH sides of renames/copies; NUL output preserves whitespace and quoted paths. */
/** Resolve a worker-supplied daemon name to its settings key (R502 item 1: workers guessed wrong 3 times).
 * Accepts: the key, its launchd label (exact, or with the com.we./com.plateau. prefix removed), and the explicit
 * `daemonAliases` table (clone dir names live there: a generic basename like `code` must never self-select). An exact key always wins. More than one candidate key is
 * `ambiguous` and refused, never guessed. Returns { key } or { reason: 'unknown'|'ambiguous', valid, candidates? }. */
export function resolveDaemonKey(daemons = {}, aliases = {}, name = '') {
  const valid = Object.keys(daemons || {});
  if (!name || typeof name !== 'string') return { reason: 'unknown', valid };
  if (Object.hasOwn(daemons, name)) return { key: name };
  const found = new Set();
  for (const [key, d] of Object.entries(daemons)) {
    const names = new Set();
    if (d?.label) { names.add(d.label); const bare = d.label.replace(/^com\.(?:we|plateau)\./, ''); names.add(bare); }
    if (names.has(name)) found.add(key);
  }
  const explicit = aliases && Object.hasOwn(aliases, name) ? aliases[name] : null;
  if (explicit && Object.hasOwn(daemons, explicit)) found.add(explicit);
  if (found.size === 1) return { key: [...found][0] };
  if (found.size > 1) return { reason: 'ambiguous', valid, candidates: [...found].sort() };
  return { reason: 'unknown', valid };
}
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
