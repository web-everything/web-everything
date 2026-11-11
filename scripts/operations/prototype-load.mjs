/**
 * @file Declared prototype admission and pure evidence decisions.
 * WHY (incident 2026-10-22): combined tops repeated tests, reverted main fixes three times,
 * and removed registrations before replacement admission. Keep comparisons explicit and swaps ordered.
 */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { QUESTION_HASH, findAudit, isAcceptedQuestionHash, resolvePriorQuestionHashes } from './codex-audit.mjs';
import { carriesAcross } from '../lib/net-diff-fingerprint.mjs';
export const PROTOTYPE_LOAD_OP = 'prototype-load';
export const PROTOTYPE_LOAD_EFFECT = 'prototype-load.apply';
export const safeRegistrationRef = (ref) => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
  && !/\.\.|\/\/|\/\.|@\{|\.$|\/$|\.lock(?:\/|$)/.test(ref);
export const safeRef = (ref) => safeRegistrationRef(ref) && ref.startsWith('lane/');
// Strings only (main #6353's alias rule): RegExp.test coerces, so an array ['<sha>'] would otherwise pass and alias a real sha.
export const validSha = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha);
// Coercion-safe text: RegExp.test / Date.parse coerce an object ({"toString":null}) and throw, so only strings pass.
const text = (v) => (typeof v === 'string' ? v : '');
const lowerSha = (sha) => (typeof sha === 'string' ? sha.toLowerCase() : sha);
export function jsonLines(text) {
  return String(text).split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
/** A bounded, complete check-run page; latest `test` run on this SHA decides. */
/** The `test` gate must come from the GitHub Actions app (id 15368), never a same-named check from another integration. */
export const TEST_CHECK_APP_ID = 15368;
export function testCheckEvidence(data, sha) {
  if (!Number.isInteger(data?.total_count) || data.total_count < 0 || data.total_count > 100
    || !Array.isArray(data.check_runs) || data.check_runs.length !== data.total_count) return null;
  const runs = data.check_runs.filter((r) => r?.name === 'test' && r.head_sha === sha && r.app?.id === TEST_CHECK_APP_ID);
  if (!runs.length || runs.some((r) => !Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.check_suite?.id))) return null;
  // Latest run per check suite (a rerun supersedes only its own suite); another workflow's success never hides a failure.
  const bySuite = new Map();
  for (const r of runs) if (!bySuite.has(r.check_suite.id) || r.id > bySuite.get(r.check_suite.id).id) bySuite.set(r.check_suite.id, r);
  const latests = [...bySuite.values()];
  const latest = latests.find((r) => r.status !== 'completed' || r.conclusion !== 'success') ?? latests.sort((x, y) => y.id - x.id)[0];
  return { sha: latest.head_sha, name: latest.name, status: latest.status, conclusion: latest.conclusion, id: latest.id, appId: latest.app.id, suiteIds: [...bySuite.keys()].sort((a, b) => a - b) };
}
/** Every suite behind the `test` evidence must belong to a workflow run of the expected workflow file on this exact sha.
 *  Unreadable, truncated or foreign evidence is false (fail closed). */
export const TEST_WORKFLOW_PATH = '.github/workflows/ci.yml';
export function testWorkflowBound(evidence, runsData, sha, path = TEST_WORKFLOW_PATH) {
  if (!evidence || !Array.isArray(evidence.suiteIds) || !evidence.suiteIds.length || typeof path !== 'string' || !path) return false;
  if (!Number.isInteger(runsData?.total_count) || !Array.isArray(runsData.workflow_runs) || runsData.workflow_runs.length !== runsData.total_count || runsData.total_count > 100) return false;
  return evidence.suiteIds.every((id) => runsData.workflow_runs.some((r) => r?.check_suite_id === id && r.head_sha === sha
    && typeof r.path === 'string' && r.path.split('@')[0] === path));
}
/** A WEAKENED fix-ready record loads ONLY as a ruled exception (operator R396): the record must carry
 *  `auditRuling` and a non-empty `auditDisclosed`, AND the settings allowlist `ruledWeakened` must hold an entry whose
 *  ref, full 40-hex sha and ruling match the record exactly. Anything else stays refused; a `--audit` argument can
 *  never claim it. Never a blanket bypass. */
const RULING = /^R\d+(?:\+R\d+)*$/;
/** Operator rulings may live in the platform prefs or the repo settings. The allowlist is the UNION of both layers,
 *  de-duplicated by ref+sha+ruling (the tool entry wins); each entry carries its source `layer`. Platform entries get
 *  the same shape checks as repo entries; a malformed one is ignored with a warning, never trusted. */
export function mergeRuledWeakened(platform, tool, warn = () => {}) {
  // Strings only: RegExp.test and template literals coerce, so a JSON object ({"toString":null}) throws and an array
  // (['R1']) would alias a real value. Settings JSON is untrusted, so a bad entry is ignored, never allowed to throw.
  const keyed = (e) => e && typeof e === 'object' && typeof e.ref === 'string' && e.ref && validSha(e.sha) && typeof e.ruling === 'string';
  // Same ruling syntax as readyEvidence (RULING): combined rulings such as R475+R485 are valid in every layer.
  const wellFormed = (e) => keyed(e) && RULING.test(e.ruling)
    && Array.isArray(e.findings) && e.findings.length > 0 && e.findings.every((f) => typeof f === 'string' && f.trim());
  const seen = new Set();
  const out = [];
  const add = (e, layer) => { const k = JSON.stringify([e.ref, lowerSha(e.sha), e.ruling]); if (!seen.has(k)) { seen.add(k); out.push({ ...e, layer }); } };
  (Array.isArray(tool) ? tool : []).forEach((e, i) => {
    if (keyed(e)) add(e, 'tool'); else if (e && typeof e === 'object') warn(`WARNING: ignoring malformed tool prototypeLoad ruledWeakened[${i}] (needs string ref, 40-hex sha, string ruling)`);
  });
  (Array.isArray(platform) ? platform : []).forEach((e, i) => {
    if (wellFormed(e)) add(e, 'platform'); else warn(`WARNING: ignoring malformed platform prototypeLoad.ruledWeakened[${i}] (needs ref, 40-hex sha, ruling like R12 or R12+R13, non-empty findings)`);
  });
  return out;
}
export function readyEvidence(records, input, ruledWeakened = [], liveFpSource = null) {
  // Arguments are labels only; readiness comes from persisted evidence.
  const liveFp = typeof liveFpSource === 'function' ? liveFpSource() : liveFpSource;
  // R503: a record speaks for the live sha when it names it exactly, or its stored net-diff fingerprint equals the live one.
  // A rebase or merge of main that leaves the code alone therefore keeps the evidence; any code change does not.
  // Shas compare case-insensitively (validSha accepts either case): an upper-case --sha must still find its own records.
  const live = lowerSha(input.sha);
  const list = (Array.isArray(records) ? records : []).map((r) => (r && typeof r === 'object' ? { ...r, sha: lowerSha(r.sha) } : r));
  const carries = (r) => validSha(r.sha) && carriesAcross(r.fingerprint, liveFp);
  // The allowlist entry binds to the record by its exact sha, or (carry) by holding the live fingerprint itself.
  const binds = (e, r) => lowerSha(e.sha) === r.sha && r.sha === live || validSha(e.sha) && validSha(r.sha) && carriesAcross(e.fingerprint, liveFp) && carriesAcross(r.fingerprint, liveFp);
  const judge = (r) => {
    if (r.tests === 'green' && /^NOT WEAKENED$/i.test(text(r.audit))) return { source: 'ready-record', record: r };
    const match = r.tests === 'green' && r.audit === 'WEAKENED'
      && validSha(r.sha) && RULING.test(text(r.auditRuling))
      && Array.isArray(r.auditDisclosed) && r.auditDisclosed.length > 0 && r.auditDisclosed.every((f) => typeof f === 'string' && f.trim())
      && Array.isArray(ruledWeakened) && ruledWeakened.find((e) => e && e.ref === r.ref && binds(e, r) && e.ruling === r.auditRuling
        && Array.isArray(e.findings) && e.findings.length > 0 && e.findings.every((f) => typeof f === 'string' && f.trim())
        && e.findings.length === r.auditDisclosed.length && e.findings.every((f, i) => f === r.auditDisclosed[i]));
    return match ? { source: 'ready-record', record: r, ruledWeakened: { ruling: r.auditRuling, findings: r.auditDisclosed, ...(match.layer ? { layer: match.layer } : {}) } } : null;
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
/** True when a stored ready record for this branch speaks about THIS head's code: it names the live sha (any case),
 * carries the live net-diff fingerprint, or is too malformed to classify (fail closed). A record for other code never
 * counts, so an iterated branch is not stranded by its own earlier load. Pair with readyEvidence: refuse only when
 * readyEvidence is null AND a record speaks for this head. */
export function readyRecordSpeaksFor(records, input, liveFp = null) {
  const live = lowerSha(input.sha);
  // An unreadable live fingerprint (failed fetch/read) cannot prove a record is about other code, so a record that
  // stores a readable fingerprint still speaks: a transient git failure must not clear negative evidence.
  const liveUnknown = !carriesAcross(liveFp, liveFp);
  return (Array.isArray(records) ? records : []).some((r) => r && typeof r === 'object' && r.ref === input.branch
    && (!validSha(r.sha) || lowerSha(r.sha) === live || carriesAcross(r.fingerprint, liveFp)
      || (liveUnknown && carriesAcross(r.fingerprint, r.fingerprint))));
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
  const ruled = (record) => {
    const gate = auditOptions.ruledWeakened;
    return gate?.ruledWeakened && record.questionHash === QUESTION_HASH
      // The ruled audit is the gate record's own (exact sha), or the carried audit of the same net diff: readiness
      // appended by an earlier carry names the NEW sha, and must keep binding to the audit it was carried from.
      && (record.head === lowerSha(gate.record.sha)
        || (carriesAcross(record.fingerprint, liveFp) && carriesAcross(gate.record.fingerprint, liveFp)))
      && Array.isArray(record.findings)
      && JSON.stringify(record.findings) === JSON.stringify(gate.ruledWeakened.findings)
      && covered(record.base);
  };
  // Unruled own WEAKENED stops before git; a matching ruling still needs canonical base coverage.
  if (own.some((d) => d.record.verdict === 'WEAKENED' && !ruled(d.record))) return { ok: false, reason: 'weakened' };
  // Round 3: a live-head WEAKENED that findAudit cannot use (contradictory findings, unparsable time) must not vanish
  // and leave the live head looking unaudited, which would let a carried pass decide. Only a foreign question is ignored.
  // The same holds for a PRIOR-question WEAKENED still inside its accepted window (round 5): it is a real negative
  // verdict on this head that findAudit may reject (contradictory findings), so the veto judges it by the same
  // acceptance rule, with the same defaults, and an expired or unknown hash stays ignored.
  const { priorQuestionHashes = resolvePriorQuestionHashes(), now = Date.now() } = auditOptions ?? {};
  // The veto holds per BASE, not only when the live head has no decision at all (a usable pass on base X must not hide
  // an unusable WEAKENED on base Y). A base with a usable decision is judged by findAudit alone, so a superseded record
  // never blocks forever. A CARRIED head is deliberately not widened: "carry veto follows findAudit" (round 4) pins that
  // an unusable record on a carried head never blocks the carry.
  if (list.some((r) => r?.head === sha && r.base !== sha && r.verdict === 'WEAKENED'
    // An unparsable time cannot place the record outside its window, so it is judged by the hash's own expiry alone
    // (fail closed, matching a current-question record, which blocks whatever its time).
    && isAcceptedQuestionHash(r.questionHash, { priorQuestionHashes, now, at: Number.isFinite(Date.parse(text(r.at))) ? r.at : undefined }) && !own.some((d) => d.base === r.base))) return { ok: false, reason: 'weakened' };
  // Round 6: a carried head's PRIOR-question WEAKENED that findAudit would accept on its own can be hidden by an unusable
  // current-question record for the same head+base (findAudit lets even an unusable current record block the prior
  // fallback, which is right for a PASS but fail-open for a NEGATIVE verdict). Such a record keeps vetoing, judged by
  // the same supersede rule as any carried WEAKENED; a base with a usable decision of its own is left to findAudit.
  // The latest PRIOR-question record for that head+base decides (a later prior NOT WEAKENED re-audit supersedes it), judged
  // with the same already-resolved hashes and clock as the veto above.
  const priorOnly = list.filter((r) => r?.questionHash !== QUESTION_HASH);
  const hiddenWeak = priorOnly.filter((r) => r?.verdict === 'WEAKENED' && typeof r.head === 'string' && carriedHeads.has(r.head) && r.base !== r.head
    && !carried.some((d) => d.record.head === r.head && d.base === r.base)
    && findAudit(priorOnly, { ...auditOptions, head: r.head, base: r.base, questionHash: QUESTION_HASH, priorQuestionHashes, now }) === r).map((record) => ({ base: record.base, record }));
  const carriedWeak = [...carried, ...hiddenWeak].filter((d) => d.record.verdict === 'WEAKENED' && !ruled(d.record));
  if (carriedWeak.length) {
    const ownAt = Math.max(-Infinity, ...own.filter((d) => covered(d.base)).map((d) => Date.parse(text(d.record.at))));
    if (carriedWeak.some((d) => !(Date.parse(text(d.record.at)) < ownAt))) return { ok: false, reason: 'weakened' };
  }
  // A pass counts only when covers(base) proves its base is in main; a carried pass must itself hold the fingerprint.
  const passes = own.length ? own : carried.filter((d) => carriesAcross(d.record.fingerprint, liveFp));
  let pass = null;
  for (const { base, record } of passes) {
    // A current-question record for this head+base (usable or not) blocks a PRIOR-question pass, even when carry
    // eligibility dropped it (no or differing fingerprint): judge against ALL records, fail closed.
    if (record.questionHash !== QUESTION_HASH
      && list.some((r) => r?.head === record.head && r.base === base && r.questionHash === QUESTION_HASH)) continue;
    if (covered(base) && (!pass || Date.parse(text(record.at)) >= Date.parse(text(pass.at)))) pass = record;
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
  return records.find((r) => r && Date.parse(text(r.at)) >= since && (r.ref === ref || (alerts && JSON.stringify(r).includes(ref)))
    && (alerts ? /reject|drop|refus|conflict/i.test(JSON.stringify(r)) : /removed|dropped/.test(text(r.kind) || text(r.event) || text(r.type))));
}
export function prototypeLoadOperation() {
  const input = Object.fromEntries(['branch', 'sha', 'daemon', 'why', 'tests-run', 'audit', 'replace', 'wait-adoption-ms', 'ruling', 'quote', 'remove', 'reason'].map((key) => [key, { type: 'string', required: false, default: '' }]));
  input['dry-run'] = { type: 'boolean', required: false, default: false };
  // R310: retire-only run — drop registrations proved merged, in main, or superseded, and load nothing.
  input.retire = { type: 'boolean', required: false, default: false };
  // R508: operator force-adopt of ONE build over a failed smoke; needs --ruling, a verbatim --quote and --sha (the full
  // sha of the build the rebuild holds: the `target` in the daemon's held state, not a branch tip when overlays apply).
  input['force-adopt'] = { type: 'boolean', required: false, default: false };
  return op(PROTOTYPE_LOAD_OP, {
    input, verdictFrom: 'assess',
    load: effect({ reads: Object.keys(input).map((key) => `input.${key}`),
      effects: ({ input: values }) => [{ type: PROTOTYPE_LOAD_EFFECT,
        payload: { ...values, testsRun: values['tests-run'], dryRun: values['dry-run'], forceAdopt: values['force-adopt'], waitAdoptionMs: values['wait-adoption-ms'] }, idempotent: false }] }),
    assess: compute({ reads: ['findings.load'], fn: ({ findings }) => {
      const entry = findings.load?.effects?.[0];
      if (entry?.status !== 'applied' || !entry.result) throw new Error('prototype-load: transaction did not complete');
      return entry.result;
    } }),
  });
}
