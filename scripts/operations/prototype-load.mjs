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
// Strings only (main #6353's alias rule): RegExp.test coerces, so an array ['<sha>'] would otherwise pass and alias a real sha.
export const validSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha);
const lowerSha = (sha) => (typeof sha === 'string' ? sha.toLowerCase() : sha);
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
  // Shas compare case-insensitively (validSha accepts either case): an upper-case --sha must still find its own records.
  const live = lowerSha(input.sha);
  const list = (Array.isArray(records) ? records : []).map((r) => (r && typeof r === 'object' ? { ...r, sha: lowerSha(r.sha) } : r));
  const carries = (r) => validSha(r.sha) && carriesAcross(r.fingerprint, liveFp);
  // The allowlist entry binds to the record by its exact sha, or (carry) by holding the live fingerprint itself.
  const binds = (e, r) => lowerSha(e.sha) === r.sha && r.sha === live || validSha(e.sha) && validSha(r.sha) && carriesAcross(e.fingerprint, liveFp) && carriesAcross(r.fingerprint, liveFp);
  const judge = (r) => {
    if (r.tests === 'green' && /^NOT WEAKENED$/i.test(r.audit || '')) return { source: 'ready-record', record: r };
    const ruled = r.tests === 'green' && r.audit === 'WEAKENED'
      && validSha(r.sha) && RULING.test(r.auditRuling || '')
      && Array.isArray(r.auditDisclosed) && r.auditDisclosed.length > 0 && r.auditDisclosed.every((f) => typeof f === 'string' && f.trim())
      && Array.isArray(ruledWeakened) && ruledWeakened.some((e) => e && e.ref === r.ref && binds(e, r) && e.ruling === r.auditRuling
        && Array.isArray(e.findings) && e.findings.length > 0 && e.findings.every((f) => typeof f === 'string' && f.trim())
        && e.findings.length === r.auditDisclosed.length && e.findings.every((f, i) => f === r.auditDisclosed[i]));
    return ruled ? { source: 'ready-record', record: r, ruledWeakened: { ruling: r.auditRuling, findings: r.auditDisclosed } } : null;
  };
  // Precedence (R503 red team rounds 1–2). The records file is append-only, so file order is time order:
  //  - per sha, only its LATEST record counts (a superseded WEAKENED or red record never blocks forever);
  //  - the live sha's own latest record decides whenever one exists, and a carried record can never outrank it;
  //  - a carried head whose latest record would not load (WEAKENED unruled, not green, unbound) blocks unless the
  //    live sha has a NEWER record of its own — newer negative evidence about the same code is never bypassed.
  const latest = new Map();
  list.forEach((r, i) => { if (r?.ref === input.branch && (r.sha === live || validSha(r.sha))) latest.set(r.sha, i); });
  const ownAt = latest.has(live) ? latest.get(live) : -1;
  const carried = [...latest].filter(([sha]) => sha !== live &&list.some((r) => r?.ref === input.branch && r.sha === sha && carries(r)))
    .map(([, i]) => i).sort((a, b) => a - b);
  if (carried.some((i) => i > ownAt && !judge(list[i]))) return null;
  if (ownAt >= 0) return judge(list[ownAt]);
  // No live-sha record: the newest carried head whose latest record itself holds the live fingerprint decides.
  const pick = carried.filter((i) => carries(list[i])).pop();
  if (pick === undefined) return null;
  // Round 3: a NEWER latest record of another head with no readable fingerprint may be the same code (a second rebase),
  // so when it would not load it blocks the carry. Only a readable, different fingerprint proves it is other code.
  const hasFp = (fp) => carriesAcross(fp, fp);
  if ([...latest].some(([sha, i]) => sha !== live && i > pick && !hasFp(list[i].fingerprint) && !judge(list[i]))) return null;
  return judge(list[pick]);
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
  // Precedence (R503 red team rounds 1–2):
  //  - per head and base, only the LATEST valid verdict counts (findAudit), over ALL that head's records — fingerprint
  //    or not — so a superseded WEAKENED never blocks forever, and an unsuperseded one is never hidden;
  //  - the live head's own verdicts decide whenever it has any, and a carried pass can never outrank them;
  //  - a carried head's latest WEAKENED blocks unless the live head has a NEWER verdict of its own (a fresh re-audit).
  // Shas compare case-insensitively (validSha accepts either case), so the live head always finds its own verdicts.
  sha = lowerSha(sha);
  // Copy a record only when lower-casing changes it, so the returned evidence keeps the caller's record identity.
  const original = new Map();
  const list = (Array.isArray(records) ? records : []).map((r) => {
    if (!r || typeof r !== 'object' || (lowerSha(r.head) === r.head && lowerSha(r.base) === r.base)) return r;
    const copy = { ...r, head: lowerSha(r.head), base: lowerSha(r.base) };
    original.set(copy, r);
    return copy;
  });
  const decisions = (head) => [...new Set(list.filter((r) => r?.head === head && r.base !== head).map((r) => r.base))]
    .map((base) => ({ base, record: findAudit(list, { head, base, questionHash: QUESTION_HASH, ...auditOptions }) })).filter((d) => d.record);
  const own = decisions(sha);
  // Only string heads carry (main #6353): a non-string head that stringifies to a sha never aliases a real one, and
  // findAudit refuses non-string head/base, so a non-string base never decides either.
  const carriedHeads = new Set(list.filter((r) => typeof r?.head === 'string' && r.head !== sha && validSha(r.head) && carriesAcross(r.fingerprint, liveFp)).map((r) => r.head));
  const carried = [...carriedHeads].flatMap(decisions);
  // Only an own verdict that could itself pass (its base is in main) is a re-audit that supersedes a carried WEAKENED:
  // a newer audit of a narrow, uncovered base never hides it behind an older covered pass.
  // Ask covers() once per base: a flaky second answer must never let the pass loop disagree with this check.
  const coverMemo = new Map();
  const covered = (base) => { if (!coverMemo.has(base)) coverMemo.set(base, !!covers(base)); return coverMemo.get(base); };
  // An own WEAKENED stops here, before covers() can touch git (refuse mode promises to stop before git).
  if (own.some((d) => d.record.verdict === 'WEAKENED')) return { ok: false, reason: 'weakened' };
  // Round 3: a live-head WEAKENED that findAudit cannot use (contradictory findings, unparsable time) must not vanish
  // and leave the live head looking unaudited, which would let a carried pass decide. Only a foreign question is ignored.
  if (!own.length && list.some((r) => r?.head === sha && r.base !== sha && r.verdict === 'WEAKENED' && r.questionHash === QUESTION_HASH)) return { ok: false, reason: 'weakened' };
  const carriedWeak = carried.filter((d) => d.record.verdict === 'WEAKENED');
  if (carriedWeak.length) {
    const ownAt = Math.max(-Infinity, ...own.filter((d) => covered(d.base)).map((d) => Date.parse(d.record.at)));
    if (carriedWeak.some((d) => !(Date.parse(d.record.at) < ownAt))) return { ok: false, reason: 'weakened' };
  }
  // A pass counts only when covers(base) proves its base is in main; a carried pass must itself hold the fingerprint.
  const passes = own.length ? own : carried.filter((d) => carriesAcross(d.record.fingerprint, liveFp));
  let pass = null;
  for (const { base, record } of passes) {
    // A current-question record for this head+base (usable or not) blocks a PRIOR-question pass, even when carry
    // eligibility dropped it (no or differing fingerprint): judge against ALL records, fail closed.
    if (record.questionHash !== QUESTION_HASH
      && list.some((r) => r?.head === record.head && r.base === base && r.questionHash === QUESTION_HASH)) continue;
    if (covered(base) && (!pass || Date.parse(record.at) >= Date.parse(pass.at))) pass = record;
  }
  return pass ? { ok: true, record: original.get(pass) ?? pass } : { ok: false, reason: 'no-record' };
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
